module("luci.client_monitor_pkg.collector", package.seeall)

local ubus = require "ubus"
local nixio = require "nixio"
local uci = require "uci".cursor()
local jsonc = require "luci.jsonc"
local util = require "luci.client_monitor_pkg.util"

local _S = {
  fmt = string.format, match = string.match, gmatch = string.gmatch,
  lower = string.lower, find = string.find, sub = string.sub,
  byte = string.byte,
  tonumber = tonumber, tostring = tostring, type = type,
  ipairs = ipairs, pairs = pairs, next = next,
  os_time = os.time, os_clock = os.clock, os_rename = os.rename,
  t_insert = table.insert, t_concat = table.concat, t_sort = table.sort,
  m_max = math.max, m_min = math.min, m_floor = math.floor, m_ceil = math.ceil
}

local exists   = util.exists
local readfile = util.readfile
local listdir  = util.listdir
local globlist  = util.globlist
local mkdir_p  = util.mkdir_p
local bins = util.resolve_bins()

local CACHE_DIR = "/tmp/client_monitor"
local NFT_TABLE  = "bridge"
local NFT_TNAME  = "cm_monitor"
local CHAIN_FWD  = "cm_fwd"
local CHAIN_IN   = "cm_in"
local CHAIN_OUT  = "cm_out"

local BRIDGE_ACTIVE_BYTES = 1024
local BRIDGE_IDLE_SECS    = 180
local REDISCOVER_INTERVAL = 60
local LOCAL_MACS_TTL    = 30
local GW_TTL            = 10
local IFACE_CACHE_TTL   = 45
local ARP_CACHE_TTL     = 15
local HOSTAPD_CACHE_TTL = 0
local FDB_CACHE_TTL     = 1
local REGISTRY_TTL      = 86400
local DHCP_CACHE_TTL    = 10
local BRPORT_CACHE_TTL  = 30
-- Save identity changes right away, but batch last_seen updates.
-- last_seen is only used to expire registry entries after 24 hours.
local REGISTRY_TOUCH_TTL = 60

local prev_file          = CACHE_DIR .. "/client_monitor_prev.json"
local prev_ts_file       = CACHE_DIR .. "/client_monitor_prev_ts"
local registry_file      = CACHE_DIR .. "/client_monitor_registry.json"
local nft_prev_file      = CACHE_DIR .. "/client_monitor_nft_prev.json"
local bridge_state_file  = CACHE_DIR .. "/client_monitor_bridge_state.json"
local iface_cache_file   = CACHE_DIR .. "/client_monitor_iface_cache.json"
local iface_cache_ts     = CACHE_DIR .. "/client_monitor_iface_cache.ts"
local arp_cache_file     = CACHE_DIR .. "/client_monitor_arp_cache.json"
local arp_cache_ts       = CACHE_DIR .. "/client_monitor_arp_cache.ts"
local hostapd_cache_file = CACHE_DIR .. "/client_monitor_hostapd_cache.json"
local hostapd_cache_ts   = CACHE_DIR .. "/client_monitor_hostapd_cache.ts"
local nft_list_cache_file = CACHE_DIR .. "/client_monitor_nft_list_cache.json"
local nft_list_cache_ts   = CACHE_DIR .. "/client_monitor_nft_list_cache.ts"
local dhcp_leases_cache_file = CACHE_DIR .. "/client_monitor_dhcp_leases_cache.json"
local dhcp_leases_cache_ts   = CACHE_DIR .. "/client_monitor_dhcp_leases_cache.ts"
local fdb_cache_file = CACHE_DIR .. "/client_monitor_fdb_cache.json"
local fdb_cache_ts   = CACHE_DIR .. "/client_monitor_fdb_cache.ts"
-- Disk cache for kernels without brforward.
local fdb_all_cache_file = CACHE_DIR .. "/client_monitor_fdb_all.cache"
local fdb_all_cache_ts   = CACHE_DIR .. "/client_monitor_fdb_all.ts"

local conn = nil
local _nft_setup_done = false
local _local_macs_cache = nil
local _local_macs_ts    = 0
local _gw_cache         = nil
local _gw_ts            = 0
local _leases_cache = nil
local _leases_ts    = 0
local _force_refresh = false
local _last_lan_json_clients = nil

-- rpcd's flock gives us one collector. Reuse these between passes;
-- clear_cache() drops them when a full rediscovery is requested.
local _nft_listing_cache = nil   -- raw nft table listing
local _nft_listing_ts    = 0
local _nft_counters_cache = nil  -- counters from that listing
local _brport_cache = {}         -- port-number maps indexed by bridge
local _brforward_ok = nil        -- false disables the sysfs path
local _lanjson_cache = nil       -- LAN status for this pass
local _prev_written  = nil       -- last successfully written prev.json
local _nft_prev_written = nil
local _bridge_state_written = nil
local _reg_saved_ts = 0          -- last registry write

local function log_error(msg)
  pcall(nixio.syslog, "err", "client_monitor: " .. _S.tostring(msg))
end

local function atomic_write_tmp(path, data)
  if not path then return false end
  local tmp = path .. ".tmp"
  local f = io.open(tmp, "w+")
  if not f then
    local dir = path:match("^(.*)/[^/]*$")
    if dir and dir ~= "" then
      mkdir_p(dir)
      f = io.open(tmp, "w+")
    end
    if not f then return false end
  end
  f:write(data); f:close()
  return _S.os_rename(tmp, path)
end

local function run(cmd)
  local fp = io.popen(cmd, "r")
  if not fp then return "" end
  local out = fp:read("*a") or ""; fp:close(); return out
end

local function run_e(cmd)
  local fp = io.popen(cmd .. " 2>&1", "r"); if not fp then return "" end
  local o = fp:read("*a") or ""; fp:close(); return o
end

local function split_lines(s)
  local t = {}
  for line in (s or ""):gmatch("[^\r\n]+") do t[#t+1] = line end
  return t
end

local function read_proc_net_dev()
  local f = io.open("/proc/net/dev", "r")
  if not f then return {} end
  f:read("*l"); f:read("*l")
  local stats = {}
  for line in f:lines() do
    local iface, rx, tx = _S.match(line, "^%s*([^:%s]+):%s*(%d+)%s+%d+%s+%d+%s+%d+%s+%d+%s+%d+%s+%d+%s+%d+%s+(%d+)")
    if iface and iface ~= "lo" then
      stats[iface] = { rx_bytes = _S.tonumber(rx) or 0, tx_bytes = _S.tonumber(tx) or 0 }
    end
  end
  f:close()
  return stats
end

local function get_iface_mac(iface)
  local f = io.open("/sys/class/net/" .. iface .. "/address", "r")
  if f then
    local mac = f:read("*l"); f:close()
    if mac then
      mac = _S.match(mac, "^%s*(%x%x:%x%x:%x%x:%x%x:%x%x:%x%x)%s*$")
      if mac then return _S.lower(mac) end
    end
  end
  return nil
end

local function get_all_local_macs(now)
  now = now or _S.os_time()
  if _local_macs_cache and (now - _local_macs_ts) < LOCAL_MACS_TTL then
    return _local_macs_cache
  end
  local macs = {}
  local f = io.open("/proc/net/dev", "r")
  if f then
    f:read("*l"); f:read("*l")
    for line in f:lines() do
      local iface = _S.match(line, "^%s*([^:%s]+):")
      if iface and iface ~= "lo" then
        local m = get_iface_mac(iface)
        if m then macs[m] = true end
      end
    end
    f:close()
  end
  _local_macs_cache = macs
  _local_macs_ts    = now
  return macs
end

local function _rm_cache_files()
  local names = listdir(CACHE_DIR)
  if not names then return end
  for _, name in _S.ipairs(names) do
    -- Keep the last complete snapshot available during refresh.
    -- The daemon replaces it only when new data is ready.
    if name ~= "data.json"
       and (name:match("%.ts$") or name:match("%.json$") or name:match("%.cache$")) then
      os.remove(CACHE_DIR .. "/" .. name)
    end
  end
end

local function clear_all_caches()
  _rm_cache_files()
end

local function discover_bridges()
  local bridges = {}
  local content = readfile("/proc/net/dev") or ""
  for iface in content:gmatch("\n%s*([^:%s]+):") do
    if iface ~= "lo" and exists("/sys/class/net/"..iface.."/bridge") then
      bridges[#bridges+1] = iface
    end
  end
  if #bridges == 0 then bridges = { "br-lan" } end
  return bridges
end

local pat_fdb = "^(%x%x:%x%x:%x%x:%x%x:%x%x:%x%x)%s+dev%s+(%S+)%s+.*master%s+(%S+)"

-- Read the FDB from brforward to avoid a bridge subprocess on each pass.
-- Entries are 16-byte struct __fdb_entry records:
--   u8 mac[6], port_no, is_local; u32 ageing_timer;
--   u8 port_hi, pad; u16 unused.
-- is_local marks bridge-owned MACs. Fall back to bridge fdb show if
-- the kernel doesn't expose this file.
local function brport_map(br, now, force)
  local e = _brport_cache[br]
  if e and not force and (now - e.ts) < BRPORT_CACHE_TTL then return e.map end
  local map = {}
  local devs = listdir("/sys/class/net/" .. br .. "/brif")
  if devs then
    for _, dev in _S.ipairs(devs) do
      local raw = readfile("/sys/class/net/" .. dev .. "/brport/port_no")
      if raw then
        -- port_no is usually hexadecimal; accept decimal too.
        local hex = raw:match("0x(%x+)")
        local n = hex and _S.tonumber(hex, 16) or _S.tonumber(raw:match("%d+") or "")
        if n then map[n] = dev end
      end
    end
  end
  _brport_cache[br] = { ts = now, map = map }
  return map
end

local function fdb_from_brforward(bridges, now)
  local entries, n, any = {}, 0, false
  local byte = _S.byte
  for _, br in _S.ipairs(bridges) do
    local f = io.open("/sys/class/net/" .. br .. "/brforward", "rb")
    if f then
      local d = f:read("*a") or ""
      f:close()
      any = true
      if #d >= 16 then
        local pmap = brport_map(br, now)
        local rebuilt = false
        for o = 0, #d - 16, 16 do
          local b1, b2, b3, b4, b5, b6, pno, is_local = byte(d, o + 1, o + 8)
          if is_local == 0 then
            local key = pno + (byte(d, o + 13) or 0) * 256
            local dev = pmap[key]
            -- A newly joined port won't be in the cached map. Refresh once and retry.
            if not dev and not rebuilt then
              rebuilt = true
              pmap = brport_map(br, now, true)
              dev = pmap[key]
            end
            if dev then
              n = n + 1
              entries[n] = {
                mac = _S.fmt("%02x:%02x:%02x:%02x:%02x:%02x", b1, b2, b3, b4, b5, b6),
                dev = dev,
              }
            end
          end
        end
      end
    end
  end
  if not any then return nil end
  return entries
end

local function fdb_from_bridge_cmd(bridges, now)
  local raw = nil
  local cache_ts = _S.tonumber((readfile(fdb_all_cache_ts) or ""):match("^%s*(%d+)")) or 0
  if (now - cache_ts) < FDB_CACHE_TTL then
    raw = readfile(fdb_all_cache_file)
    if raw == "" then raw = nil end
  end
  if not raw then
    raw = run(bins.bridge .. " fdb show 2>/dev/null") or ""
    atomic_write_tmp(fdb_all_cache_file, raw)
    atomic_write_tmp(fdb_all_cache_ts, _S.tostring(now))
  end
  local bridge_set = {}
  for _, br in _S.ipairs(bridges) do bridge_set[br] = true end
  local entries, n = {}, 0
  for line in raw:gmatch("[^\r\n]+") do
    if not line:find("permanent", 1, true) and not line:find("self", 1, true) then
      local mac, dev, master = line:match(pat_fdb)
      if mac and dev and master and bridge_set[master] then
        n = n + 1
        entries[n] = { mac = _S.lower(mac), dev = dev }
      end
    end
  end
  return entries
end

local function read_fdb(bridges, now)
  if _brforward_ok ~= false then
    local entries = fdb_from_brforward(bridges, now)
    if entries then
      _brforward_ok = true
      return entries
    end
    _brforward_ok = false
    log_error("brforward unavailable, falling back to `bridge fdb show`")
  end
  return fdb_from_bridge_cmd(bridges, now)
end

local function _is_keyword_in(h, word)
  local s, e = h:find(word, 1, true)
  if not s then return false end
  local before = s == 1   or not h:sub(s-1, s-1):match("%a")
  local after  = e == #h  or not h:sub(e+1, e+1):match("%a")
  return before and after
end

local function is_router_hostname(hostname)
  if not hostname or hostname == "" then return false end
  local h = hostname:lower()
  local unambiguous = {
    "tenda", "tp%-link", "tplink", "d%-link", "dlink",
    "netgear", "asus", "linksys", "mikrotik", "ubiquiti",
    "zte", "gl%.inet", "glinet", "archer",
    "miwifi", "mi%-router", "aiot%-router",
  }
  for _, pattern in _S.ipairs(unambiguous) do
    if h:match(pattern) then return true end
  end
  if _is_keyword_in(h, "router") or _is_keyword_in(h, "bridge") then return true end
  if h:match("%-ap%-") or h:match("%-ap$") or h:match("^ap%-") or h == "ap" then return true end
  local ambiguous = { "xiaomi", "redmi", "huawei" }
  local router_qualifiers = { "router", "bridge", "miwifi", "ap", "ax%d%d", "be%d%d" }
  for _, brand in _S.ipairs(ambiguous) do
    if h:match(brand) then
      for _, q in _S.ipairs(router_qualifiers) do
        if h:match(q) then return true end
      end
    end
  end
  return false
end

local function nft_file(lines)
  local path = CACHE_DIR .. "/.brcct_crt.nft"
  local f = io.open(path, "w")
  if not f then log_error("Failed to open nft temp file: " .. path); return end
  for _, l in _S.ipairs(lines) do f:write(l .. "\n") end
  f:close()
  local output = run_e("nft -f " .. path)
  if output and (output:find("Error:") or output:find("error:")) then
    log_error("nft command failed: " .. output:sub(1, 200))
  end
end

-- Rule changes invalidate this snapshot; using it again can add duplicates.
local function nft_invalidate_listing_cache()
  _nft_listing_cache  = nil
  _nft_listing_ts     = 0
  _nft_counters_cache = nil
  os.remove(nft_list_cache_file)
  os.remove(nft_list_cache_ts)
end

-- Reuse the caller's listing to avoid another nft process.
-- A true result tells the caller to fetch a new listing after setup.
local function nft_ensure_setup(listing)
  if _nft_setup_done then return false end
  local out = listing or run_e(_S.fmt("nft list table %s %s 2>&1", NFT_TABLE, NFT_TNAME))
  if out == "" or out:find("[Ee]rror") or out:find("No such") or out:find("does not exist") then
    nft_file({
      _S.fmt("add table %s %s", NFT_TABLE, NFT_TNAME),
      _S.fmt("add chain %s %s %s { type filter hook forward priority -200; policy accept; }", NFT_TABLE, NFT_TNAME, CHAIN_FWD),
      _S.fmt("add chain %s %s %s { type filter hook input   priority -200; policy accept; }", NFT_TABLE, NFT_TNAME, CHAIN_IN),
      _S.fmt("add chain %s %s %s { type filter hook output  priority -200; policy accept; }", NFT_TABLE, NFT_TNAME, CHAIN_OUT),
    })
    nft_invalidate_listing_cache()
    _nft_setup_done = true
    return true
  end
  _nft_setup_done = true
  return false
end

local function nft_list_all()
  return run_e(_S.fmt("nft -a list table %s %s", NFT_TABLE, NFT_TNAME))
end

local function nft_ensure_mac(mac, listing)
  if not mac or _S.type(mac) ~= "string" or mac == "" then return end
  local tag   = mac:gsub(":", "_")
  local lines = {}
  local rules = {
    { chain=CHAIN_FWD, field="ether saddr", comment="fwd_tx:"..tag },
    { chain=CHAIN_FWD, field="ether daddr", comment="fwd_rx:"..tag },
    { chain=CHAIN_IN,  field="ether saddr", comment="in_tx:"..tag  },
    { chain=CHAIN_OUT, field="ether daddr", comment="out_rx:"..tag },
  }
  for _, r in _S.ipairs(rules) do
    if not listing:find(r.comment, 1, true) then
      lines[#lines+1] = _S.fmt('add rule %s %s %s %s %s counter comment "%s"',
                            NFT_TABLE, NFT_TNAME, r.chain, r.field, mac, r.comment)
    end
  end
  if #lines > 0 then
    nft_file(lines)
    nft_invalidate_listing_cache()
  end
end

local function nft_remove_stale(all_macs, listing)
  local out = listing or run_e(_S.fmt("nft -a list table %s %s", NFT_TABLE, NFT_TNAME))
  local current_chain = nil
  local del_lines = {}
  local seen_rule = {}
  for line in out:gmatch("[^\r\n]+") do
    for _, ch in _S.ipairs({ CHAIN_FWD, CHAIN_IN, CHAIN_OUT }) do
      if line:find('chain ' .. ch, 1, true) then current_chain = ch; break end
    end
    local comment = line:match('comment "([^"]+)"')
    if comment and current_chain then
      local _, tag = comment:match("^(%w+_[tr][x]):(.+)$")
      if tag then
        local mac = tag:gsub("_", ":")
        local rule_key = current_chain .. " " .. comment
        -- Remove untracked MACs and extra copies of each chain/comment pair.
        local is_dup = seen_rule[rule_key] == true
        seen_rule[rule_key] = true
        if is_dup or (mac and not all_macs[mac]) then
          local h = line:match("# handle (%d+)")
          if h then
            del_lines[#del_lines+1] = _S.fmt("delete rule %s %s %s handle %s",
                                          NFT_TABLE, NFT_TNAME, current_chain, h)
          end
        end
      end
    end
  end
  if #del_lines > 0 then
    nft_file(del_lines)
    nft_invalidate_listing_cache()
  end
end

local function nft_read_counters(listing)
  -- Reuse parsed counters while the nft listing is unchanged.
  if listing and listing == _nft_listing_cache and _nft_counters_cache then
    return _nft_counters_cache
  end
  local counters = {}
  local out = listing or run_e(_S.fmt("nft -a list table %s %s", NFT_TABLE, NFT_TNAME))
  -- Routed LAN traffic uses the bridge input/output hooks; the forward hook
  -- only sees traffic switched through the bridge (and DSA may offload that).
  -- Count all four directions, but ignore duplicate rule comments.
  local seen = {}
  for line in out:gmatch("[^\r\n]+") do
    local bytes   = line:match("bytes (%d+)")
    local comment = line:match('comment "([^"]+)"')
    if bytes and comment then
      local dir, tag = comment:match("^(%w+_[tr][x]):(.+)$")
      if dir and tag and not seen[comment] then
        seen[comment] = true
        local mac = tag:gsub("_", ":")
        if not counters[mac] then counters[mac] = { tx=0, rx=0 } end
        local b = _S.tonumber(bytes) or 0
        if dir:find("tx") then counters[mac].tx = counters[mac].tx + b
        else counters[mac].rx = counters[mac].rx + b end
      end
    end
  end
  if listing and listing == _nft_listing_cache then _nft_counters_cache = counters end
  return counters
end

local function load_nft_prev()
  local raw = readfile(nft_prev_file)
  if not raw or raw == "" then return { _ts=0, macs={} } end
  local ok, t = pcall(jsonc.parse, raw)
  if not ok or _S.type(t) ~= "table" then return { _ts=0, macs={} } end
  t.macs = t.macs or {}; t._ts = t._ts or 0; return t
end

-- Only this daemon writes these snapshots. Skip writes when nothing changed.
local function save_nft_prev(tbl)
  local ok, s = pcall(jsonc.stringify, tbl)
  if not ok then return end
  if s == _nft_prev_written then return end
  if atomic_write_tmp(nft_prev_file, s) then _nft_prev_written = s end
end

local function load_bridge_state()
  local raw = readfile(bridge_state_file)
  if not raw or raw == "" then return {} end
  local ok, t = pcall(jsonc.parse, raw)
  return (ok and _S.type(t) == "table") and t or {}
end

local function save_bridge_state(tbl)
  local ok, s = pcall(jsonc.stringify, tbl)
  if not ok then return end
  if s == _bridge_state_written then return end
  if atomic_write_tmp(bridge_state_file, s) then _bridge_state_written = s end
end

local function signal_to_percentage(sig)
  if not sig then return 0 end
  local normalized = _S.m_max(-100, _S.m_min(-40, sig))
  local pct = _S.m_floor(((normalized + 100) / 60) * 100 + 0.5)
  return _S.m_max(0, _S.m_min(100, pct))
end

local function is_link_local_ipv6(ip)
  if not ip or not ip:find(":", 1, true) then return false end
  return ip:sub(1, 4):lower():match("^fe[89ab]") ~= nil
end

local function get_arp_table()
  local t = {}
  local f = io.open("/proc/net/arp", "r")
  if f then
    f:read("*l")
    for line in f:lines() do
      local ip, flhex, mac = line:match("^(%S+)%s+%S+%s+0x(%x+)%s+(%x%x:%x%x:%x%x:%x%x:%x%x:%x%x)")
      if ip and mac then
        local fl = _S.tonumber(flhex, 16) or 0
        if fl >= 2 and _S.m_floor(fl / 2) % 2 == 1 then
          local mac_lower = mac:lower()
          t[ip]        = mac_lower
          t[mac_lower] = ip
        end
      end
    end
    f:close()
    if _S.next(t) ~= nil then return t end
  end
  local out = run(bins.ip .. " neigh show 2>/dev/null")
  for _, line in _S.ipairs(split_lines(out)) do
    local ip  = line:match("^(%S+)%s+")
    local mac = line:match("lladdr%s+(%x%x:%x%x:%x%x:%x%x:%x%x:%x%x)")
    if ip and mac and _S.type(mac) == "string" then
      if not is_link_local_ipv6(ip) then
        local state = line:match("%s(%u+)%s*$") or ""
        if state ~= "FAILED" and state ~= "INCOMPLETE" and state ~= "PROBE" then
          local mac_lower = mac:lower()
          if mac_lower:match("^%x%x:%x%x:%x%x:%x%x:%x%x:%x%x$") then
            t[ip]  = mac_lower
            t[mac_lower] = ip
          end
        end
      end
    end
  end
  return t
end

local function get_gateway_ips(now)
  now = now or _S.os_time()
  if _gw_cache and (now - _gw_ts) < GW_TTL then return _gw_cache end
  local gws = {}
  local content = readfile("/proc/net/route") or ""
  for line in content:gmatch("[^\n]+") do
    local dest, gw = line:match("^%S+\t(%x+)\t(%x+)\t")
    if dest and gw and gw ~= "00000000" then
      local b1 = _S.tonumber(gw:sub(7,8), 16)
      local b2 = _S.tonumber(gw:sub(5,6), 16)
      local b3 = _S.tonumber(gw:sub(3,4), 16)
      local b4 = _S.tonumber(gw:sub(1,2), 16)
      if b1 and b2 and b3 and b4 then
        gws[_S.fmt("%d.%d.%d.%d", b1, b2, b3, b4)] = true
      end
    end
  end
  _gw_cache = gws
  _gw_ts    = now
  return gws
end

local function get_cached_interfaces(now, force)
  now = now or _S.os_time()
  if not force then
    local ts_content = readfile(iface_cache_ts) or ""
    local cache_ts = _S.tonumber(ts_content:match("^%s*(%d+)")) or 0
    if (now - cache_ts) < IFACE_CACHE_TTL then
      local cache_content = readfile(iface_cache_file)
      if cache_content and cache_content ~= "" then
        local ok, data = pcall(jsonc.parse, cache_content)
        if ok and _S.type(data) == "table" then return data end
      end
    end
  end
  local raw = {}
  local content = readfile("/proc/net/dev") or ""
  for iface in content:gmatch("\n%s*([^:%s]+):") do
    if iface ~= "lo" then raw[iface] = true end
  end
  local ok, json_str = pcall(jsonc.stringify, raw)
  if ok then
    atomic_write_tmp(iface_cache_file, json_str)
    atomic_write_tmp(iface_cache_ts, _S.tostring(now))
  end
  return raw
end

local function get_cached_arp_table(now)
  now = now or _S.os_time()
  local ts_content = readfile(arp_cache_ts) or ""
  local cache_ts = _S.tonumber(ts_content:match("^%s*(%d+)")) or 0
  if (now - cache_ts) < ARP_CACHE_TTL then
    local cache_content = readfile(arp_cache_file)
    if cache_content and cache_content ~= "" then
      local ok, data = pcall(jsonc.parse, cache_content)
      if ok and _S.type(data) == "table" then return data end
    end
  end
  local arp_table = get_arp_table()
  local ok, json_str = pcall(jsonc.stringify, arp_table)
  if ok then
    atomic_write_tmp(arp_cache_file, json_str)
    atomic_write_tmp(arp_cache_ts, _S.tostring(now))
  end
  return arp_table
end

local function get_cached_hostapd_interfaces(c, now)
  now = now or _S.os_time()
  local hl_cache_file = CACHE_DIR .. "/client_monitor_hostapd_list.cache"
  local hl_cache_ts = CACHE_DIR .. "/client_monitor_hostapd_list.ts"
  local list_ts_content = readfile(hl_cache_ts) or ""
  local list_cache_ts = _S.tonumber(list_ts_content:match("^%s*(%d+)")) or 0
  if (now - list_cache_ts) < 30 then
    local cache_content = readfile(hl_cache_file)
    if cache_content and cache_content ~= "" then
      local hostapd_ifaces = {}
      for iface in cache_content:gmatch("[^\n]+") do
        if iface ~= "" then hostapd_ifaces[#hostapd_ifaces + 1] = iface end
      end
      return hostapd_ifaces
    end
  end
  local hostapd_ifaces = {}
  if c then
    local ok, obj_list = pcall(function() return c:objects() end)
    if ok and obj_list then
      for _, name in _S.ipairs(obj_list) do
        local ap_iface = _S.type(name) == "string" and name:match("^hostapd%.(.+)$")
        if ap_iface and ap_iface ~= "" then hostapd_ifaces[#hostapd_ifaces + 1] = ap_iface end
      end
    end
  else
    local f = io.popen("ubus list 2>/dev/null")
    if f then
      for line in f:lines() do
        local ap_iface = line:match("^hostapd%.(.+)$")
        if ap_iface and ap_iface ~= "" then hostapd_ifaces[#hostapd_ifaces + 1] = ap_iface end
      end
      f:close()
    end
  end
  local list_content = _S.t_concat(hostapd_ifaces, "\n")
  atomic_write_tmp(hl_cache_file, list_content)
  atomic_write_tmp(hl_cache_ts, _S.tostring(now))
  return hostapd_ifaces
end

local function get_cached_hostapd_metrics(iface, c, now)
  -- Cache timestamps use wall time, not os.clock() CPU time.
  now = now or _S.os_time()
  -- A zero TTL disables file reads and writes, not just cache hits.
  if HOSTAPD_CACHE_TTL > 0 then
    local ts_content = readfile(hostapd_cache_ts) or ""
    local cache_ts = _S.tonumber(ts_content:match("^%s*(%d+%.?%d*)")) or 0
    if (now - cache_ts) < HOSTAPD_CACHE_TTL then
      local cache_content = readfile(hostapd_cache_file)
      if cache_content and cache_content ~= "" then
        local ok, data = pcall(jsonc.parse, cache_content)
        if ok and _S.type(data) == "table" and data[iface] then return data[iface] end
      end
    end
  end
  local hostapd_ifaces = {}
  local json_file = CACHE_DIR .. "/current-aps.json"
  local json_content = readfile(json_file)
  if json_content and json_content ~= "" then
    local ok, data = pcall(jsonc.parse, json_content)
    if ok and data and data.aps and _S.type(data.aps) == "table" then
      for _, ap in _S.ipairs(data.aps) do
        if ap.iface and ap.iface ~= "" then hostapd_ifaces[#hostapd_ifaces + 1] = ap.iface end
      end
    end
  end
  if #hostapd_ifaces == 0 then hostapd_ifaces = get_cached_hostapd_interfaces(c, now) end
  local all_metrics = {}
  for _, ap_iface in _S.ipairs(hostapd_ifaces) do
    local ok, res = pcall(function() return c:call("hostapd." .. ap_iface, "get_clients", {}) end)
    if ok and res and res.clients then
      local metrics = {}
      for mac, cl in _S.pairs(res.clients) do
        if mac and _S.type(mac) == "string" then
          metrics[mac:lower()] = {
            signal_pct = signal_to_percentage(_S.tonumber(cl.signal) or -100),
            raw_rx = _S.tonumber(cl.bytes and cl.bytes.tx or 0) or 0,
            raw_tx = _S.tonumber(cl.bytes and cl.bytes.rx or 0) or 0
          }
        end
      end
      all_metrics[ap_iface] = metrics
    end
  end
  if HOSTAPD_CACHE_TTL > 0 then
    local ok, json_str = pcall(jsonc.stringify, all_metrics)
    if ok then
      atomic_write_tmp(hostapd_cache_file, json_str)
      atomic_write_tmp(hostapd_cache_ts, _S.tostring(now))
    end
  end
  return all_metrics[iface]
end

local function get_cached_nft_listing(ttl_seconds)
  ttl_seconds = ttl_seconds or 5
  local now = _S.os_time()
  -- The disk copy has the same contents until the TTL expires.
  if _nft_listing_cache and (now - _nft_listing_ts) <= ttl_seconds
     and (now - _nft_listing_ts) >= 0 then
    return _nft_listing_cache
  end
  local ts_raw = readfile(nft_list_cache_ts)
  local ts = ts_raw and _S.tonumber(ts_raw) or 0
  if (now - ts) <= ttl_seconds then
    local raw = readfile(nft_list_cache_file)
    if raw and raw ~= "" then
      _nft_listing_cache, _nft_listing_ts, _nft_counters_cache = raw, ts, nil
      return raw
    end
  end
  local listing = nft_list_all()
  atomic_write_tmp(nft_list_cache_file, listing)
  atomic_write_tmp(nft_list_cache_ts, _S.tostring(now))
  _nft_listing_cache, _nft_listing_ts, _nft_counters_cache = listing, now, nil
  return listing
end

local function load_registry()
  local raw = readfile(registry_file)
  if not raw or raw == "" then
    return { bridges={}, wifi_clients={}, lan_clients={}, aps={}, lan_ports={}, lan_alias={}, bridge_ap_macs={} }
  end
  local ok, t = pcall(jsonc.parse, raw)
  if not ok or _S.type(t) ~= "table" then
    return { bridges={}, wifi_clients={}, lan_clients={}, aps={}, lan_ports={}, lan_alias={}, bridge_ap_macs={} }
  end
  t.bridges        = t.bridges        or {}
  t.wifi_clients   = t.wifi_clients   or {}
  t.lan_clients    = t.lan_clients    or {}
  t.aps            = t.aps            or {}
  t.lan_ports      = t.lan_ports      or {}
  t.lan_alias      = t.lan_alias      or {}
  t.bridge_ap_macs = t.bridge_ap_macs or {}
  return t
end

local function save_registry(reg)
  local ok, s = pcall(jsonc.stringify, reg)
  if ok then atomic_write_tmp(registry_file, s) end
end

local function ensure_leases()
  local now = _S.os_time()
  -- Reuse lease maps until the 10-second TTL expires or clear_cache() runs.
  if _leases_cache and (now - _leases_ts) < DHCP_CACHE_TTL and (now - _leases_ts) >= 0 then
    return _leases_cache
  end
  local ts_raw = readfile(dhcp_leases_cache_ts)
  local ts = ts_raw and _S.tonumber(ts_raw) or 0
  local age = now - ts
  if age <= DHCP_CACHE_TTL and age >= 0 then
    local raw = readfile(dhcp_leases_cache_file)
    if raw and raw ~= "" then
      local ok, data = pcall(jsonc.parse, raw)
      -- Older caches lack ip2name; rebuild them from the lease files.
      if ok and _S.type(data) == "table" and data.mac2name and data.mac2ip and data.ip2name then
        _leases_cache = data
        _leases_ts    = ts
        return _leases_cache
      end
    end
  end
  local mac2name, mac2ip, ip2name = {}, {}, {}
  local lease_files = globlist("/tmp/*.leases")
  for _, lease_file in _S.ipairs(lease_files) do
    local data = readfile(lease_file) or ""
    for line in data:gmatch("[^\r\n]+") do
      -- odhcpd lease headers start with '#'.
      if not line:match("^%s*#") then
        local parts = {}
        for p in line:gmatch("%S+") do parts[#parts+1] = p end
        -- dnsmasq uses <expiry> <MAC> <IP> <hostname>. odhcpd uses a DUID
        -- instead of a MAC, so its records don't belong in these maps.
        if #parts >= 4 and parts[1]:match("^%d+$")
          and parts[2]:match("^%x%x:%x%x:%x%x:%x%x:%x%x:%x%x$") then
          local mac  = parts[2]:lower()
          local ip   = parts[3]
          local host = parts[4]
          if mac and ip then mac2ip[mac] = ip end
          if mac and host and host ~= "*" then
            mac2name[mac] = host
            if ip and ip ~= "" then ip2name[ip] = host end
          end
        end
      end
    end
  end
  uci:foreach("dhcp", "host", function(s)
    if _S.type(s.mac) == "string" and s.name then
      for m in s.mac:gmatch("%S+") do
        local lm = m:lower()
        if not mac2name[lm] or mac2name[lm] == "" then mac2name[lm] = s.name end
        if s.ip and (not mac2ip[lm] or mac2ip[lm] == "") then mac2ip[lm] = s.ip end
      end
      if s.ip and (not ip2name[s.ip] or ip2name[s.ip] == "") then ip2name[s.ip] = s.name end
    end
  end)
  local hosts_data = readfile("/etc/hosts") or ""
  local ip2mac = {}
  for m, i in _S.pairs(mac2ip) do ip2mac[i] = m end
  for line in hosts_data:gmatch("[^\r\n]+") do
    if not line:match("^%s*#") then
      local ip, name = line:match("^%s*(%S+)%s+(%S+)")
      if ip and name and name ~= "localhost" then
        if not ip2name[ip] or ip2name[ip] == "" then ip2name[ip] = name end
        local m = ip2mac[ip]
        if m and (not mac2name[m] or mac2name[m] == "") then mac2name[m] = name end
      end
    end
  end
  _leases_cache = { mac2name=mac2name, mac2ip=mac2ip, ip2name=ip2name }
  _leases_ts    = now
  local ok, json_str = pcall(jsonc.stringify, _leases_cache)
  if ok then
    atomic_write_tmp(dhcp_leases_cache_file, json_str)
    atomic_write_tmp(dhcp_leases_cache_ts, _S.tostring(now))
  end
  return _leases_cache
end

-- A randomized MAC can miss the lease map. Try the IP's hostname next.
local function lease_hostname(leases, mac, ip)
  if not leases then return nil end
  local n = mac and leases.mac2name and leases.mac2name[mac]
  if n and n ~= "" then return n end
  if ip and ip ~= "" and leases.ip2name then
    n = leases.ip2name[ip]
    if n and n ~= "" then return n end
  end
  return nil
end

local function load_prev()
  local content = readfile(prev_file)
  if not content or content == "" then return {} end
  local ok, p = pcall(jsonc.parse, content)
  return (ok and _S.type(p) == "table") and p or {}
end

-- Pass the caller's timestamp to avoid a second read of prev_ts.
local function guarded_atomic_write_prev(prev_tbl, known_ts)
  local ok, s = pcall(jsonc.stringify, prev_tbl)
  if not ok then return false end
  local now_g   = _S.os_time()
  local last_ts = known_ts
      or _S.tonumber((readfile(prev_ts_file) or ""):match("^%s*(%d+%.?%d*)")) or 0
  if now_g > 0 and now_g <= last_ts then return false end
  -- With one writer, the last saved payload is still the on-disk value.
  local existing = _prev_written or readfile(prev_file) or ""
  if existing == s then
    atomic_write_tmp(prev_ts_file, _S.tostring(now_g)); return true
  end
  local wrote = atomic_write_tmp(prev_file, s)
  if wrote then
    _prev_written = s
    atomic_write_tmp(prev_ts_file, _S.tostring(now_g))
  end
  return wrote
end

local function SysfsCache()
  local C = {}
  local function read_once(path)
    if C[path] ~= nil then return C[path] end
    local v = readfile(path)
    if v and v:sub(-1) == "\n" then v = v:sub(1,-2) end
    C[path] = v; return v
  end
  -- Share one /proc/net/dev parse across the whole pass.
  local proc_stats = nil
  local function net_dev()
    if not proc_stats then proc_stats = read_proc_net_dev() end
    return proc_stats
  end
  -- /proc/net/dev has the same byte counters as sysfs and needs only one read.
  -- Use sysfs for interfaces missing from that snapshot.
  local function iface_bytes(iface)
    local s = net_dev()[iface]
    if s then return s.rx_bytes or 0, s.tx_bytes or 0 end
    local base = "/sys/class/net/" .. iface
    return _S.tonumber(read_once(base .. "/statistics/rx_bytes") or "") or 0,
           _S.tonumber(read_once(base .. "/statistics/tx_bytes") or "") or 0
  end
  local function batch_read_iface_stats(ifaces)
    local results = {}
    local stats = net_dev()
    for _, iface in _S.ipairs(ifaces) do
      if iface ~= "lo" then
        local base = "/sys/class/net/" .. iface
        local oper = read_once(base .. "/operstate") or ""
        oper = oper:gsub("%s+", "")
        if oper == "unknown" then
          local flags_hex = read_once(base .. "/flags") or "0x0"
          local flags = _S.tonumber(flags_hex) or 0
          local is_up = _S.m_floor(flags / 0x1) % 2 == 1
          if is_up and not iface:find("^ifb") then oper = "up" else oper = "down" end
        end
        local rx_b, tx_b = 0, 0
        if stats[iface] then
          rx_b = stats[iface].rx_bytes or 0
          tx_b = stats[iface].tx_bytes or 0
        else
          rx_b = _S.tonumber(read_once(base .. "/statistics/rx_bytes") or "") or 0
          tx_b = _S.tonumber(read_once(base .. "/statistics/tx_bytes") or "") or 0
        end
        results[iface] = { oper=oper, rx_b=rx_b, tx_b=tx_b }
      end
    end
    return results
  end
  return { read_once = read_once, batch_read_iface_stats = batch_read_iface_stats,
           iface_bytes = iface_bytes }
end

local function discover_aps(c)
  local aps = {}
  local json_file = CACHE_DIR .. "/current-aps.json"
  local json_content = readfile(json_file)
  if json_content and json_content ~= "" then
    local ok, data = pcall(jsonc.parse, json_content)
    if ok and data and data.aps and _S.type(data.aps) == "table" then
      for _, ap in _S.ipairs(data.aps) do
        if ap.iface and ap.ssid and ap.freq then
          local fmhz = _S.tonumber(ap.freq) or 0
          local band = "unknown"
          if     fmhz >= 2400 and fmhz < 2500 then band = "2.4_Ghz"
          elseif fmhz >= 5000 and fmhz < 6000 then band = "5_Ghz"
          elseif fmhz >= 6000               then band = "6_Ghz" end
          aps[#aps+1] = {
            key=_S.fmt("(%s, %s)", ap.ssid, band), iface=ap.iface,
            essid=ap.ssid, freq=fmhz, band=band
          }
        end
      end
      if #aps > 0 then return aps end
    end
  end
  local hostapd_ifaces = get_cached_hostapd_interfaces(c)
  for _, iface in _S.ipairs(hostapd_ifaces) do
    -- A disappearing hostapd object must not abort the rest of collection.
    local ok, status = pcall(function() return c:call("hostapd." .. iface, "get_status", {}) end)
    if not ok then status = nil end
    if status and status.ssid and status.freq then
      local fmhz = _S.tonumber(status.freq) or 0
      local band = "unknown"
      if     fmhz >= 2400 and fmhz < 2500 then band = "2.4_Ghz"
      elseif fmhz >= 5000 and fmhz < 6000 then band = "5_Ghz"
      elseif fmhz >= 6000               then band = "6_Ghz" end
      aps[#aps+1] = {
        key=_S.fmt("(%s, %s)", status.ssid, band), iface=iface,
        essid=status.ssid, freq=fmhz, band=band
      }
    end
  end
  return aps
end

-- Cache interface type by name until the next rediscovery.
local _wireless_iface_cache = {}

local function is_wireless_iface(name)
  if not name then return false end
  local cached = _wireless_iface_cache[name]
  if cached ~= nil then return cached end
  local result = name:match("^phy%d+%-ap%d") or name:match("^phy%d+%-sta")
      or name:match("^phy%d+%-p2p") or name:match("^wlan%d")
      or name:match("^ra%d") or name:match("^wl%d") or name:match("^wlo%d")
      or name:match("^ath%d") or name:match("^wifi%d") or name:match("^mon%d")
      or name:match("_2g$") or name:match("_5g$") or name:match("_6g$")
      or name:match("guest") or name:match("wifi")
      or exists("/sys/class/net/"..name.."/wireless")
  result = result and true or false
  _wireless_iface_cache[name] = result
  return result
end

-- Port discovery and sub-client lookup share this parsed file for one pass.
local function get_lan_status_from_json()
  if _lanjson_cache then
    local c = _lanjson_cache
    if c.miss then return nil, nil, nil end
    return c[1], c[2], c[3]
  end
  local json_file = "/tmp/test/current-lan-status.json"
  local json_content = readfile(json_file)
  if json_content and json_content ~= "" then
    local ok, data = pcall(jsonc.parse, json_content)
    if ok and data and data.active_lans and _S.type(data.active_lans) == "table" then
      local ports = {}
      local aliases = {}
      local clients_by_port = data.clients_by_port or {}
      for _, port in _S.ipairs(data.active_lans) do
        if port and port ~= "" then
          ports[#ports + 1] = port
          aliases[port] = port:match("^lan(%d+)$") and ("LAN "..port:match("^lan(%d+)$")) or port
        end
      end
      for _, port in _S.ipairs(ports) do
        if not clients_by_port[port] then clients_by_port[port] = {} end
      end
      _lanjson_cache = { ports, aliases, clients_by_port }
      return ports, aliases, clients_by_port
    end
  end
  _lanjson_cache = { miss = true }
  return nil, nil, nil
end

local function build_fdb_from_json_clients(clients_by_port)
  local fdb_map = {}
  local port_macs_list = {}
  local port_mac_count = {}
  for port, clients in _S.pairs(clients_by_port) do
    if _S.type(clients) == "table" then
      local macs = {}
      for _, client in _S.ipairs(clients) do
        if client.mac and client.mac ~= "" then
          local mac = client.mac:lower()
          fdb_map[mac] = port
          macs[#macs + 1] = mac
        end
      end
      port_macs_list[port] = macs
      port_mac_count[port] = #macs
    end
  end
  return fdb_map, port_macs_list, port_mac_count
end

local function discover_lan_ports(bridges)
  local json_ports, json_aliases, json_clients = get_lan_status_from_json()
  if json_ports and json_aliases then
    _last_lan_json_clients = json_clients
    return json_ports, json_aliases
  end
  local ports, aliases, seen = {}, {}, {}
  local function add_port(dev)
    dev = (dev or ""):match("^%s*(.-)%s*$")
    if dev == "" then return end
    if seen[dev] then return end
    if is_wireless_iface(dev) then return end
    seen[dev] = true
    ports[#ports+1] = dev
    aliases[dev] = dev:match("^lan(%d+)$") and ("LAN "..dev:match("^lan(%d+)$")) or dev
  end
  for _, br in _S.ipairs(bridges) do
    local devs = listdir("/sys/class/net/" .. br .. "/brif")
    if devs then
      for _, dev in _S.ipairs(devs) do add_port(dev) end
    end
  end
  local bridge_set = {}
  for _, b in _S.ipairs(bridges) do bridge_set[b] = true end
  if #ports == 0 then
    local devs = listdir("/sys/class/net")
    if devs then
      for _, dev in _S.ipairs(devs) do
        if not bridge_set[dev] then
          local link = util.readlink("/sys/class/net/" .. dev .. "/master")
          local master = link and link:match("([^/]+)$")
          if master and bridge_set[master] then add_port(dev) end
        end
      end
    end
  end
  if #ports == 0 then
    local lan_devs = uci:get("network", "lan", "device") or uci:get("network", "lan", "ifname") or ""
    for dev in lan_devs:gmatch("[^%s,]+") do
      if dev ~= "lo" and not bridge_set[dev] then add_port(dev) end
    end
  end
  if #ports == 0 then
    ports   = {"lan1","lan2","lan3","lan4"}
    aliases = {lan1="LAN 1",lan2="LAN 2",lan3="LAN 3",lan4="LAN 4"}
  end
  return ports, aliases
end

function init()
  if conn then return true end
  conn = ubus.connect()
  if not conn then return false end
  if not util.isdir(CACHE_DIR) then
    mkdir_p(CACHE_DIR)
    pcall(nixio.fs.chmod, CACHE_DIR, 1777)
  end
  return true
end

function close()
  if conn then pcall(function() conn:close() end); conn = nil end
end

-- Shared helpers stay outside collect() to avoid allocating closures each pass.

local function has_hint(hints, h)
  if not hints then return false end
  for _, v in _S.ipairs(hints) do if v == h then return true end end
  return false
end

local _type_rank = { wan=0, ap=1, ap_clients=1, smart=2, wifi_combined=3,
                     bridge=4, lan_port=5, other=6 }

local function _if_type(x)  return x.type or x.ty end
local function _if_name(x)  return x.name or x.n end
local function _if_label(x) return x.label or x.l end
local function _if_rank(x)  return _type_rank[_if_type(x)] or 7 end

local function _iface_rate_lt(a, b)
  local ra, rb = _if_rank(a), _if_rank(b)
  if (ra == 2 and rb == 3) or (ra == 3 and rb == 2) then
    local a_type = _if_type(a); local b_type = _if_type(b)
    if a_type == "smart" and b_type == "wifi_combined" then return true end
    if a_type == "wifi_combined" and b_type == "smart" then return false end
    local a_name = _if_name(a); local b_name = _if_name(b)
    if a_name == nil and b_name == nil then return false end
    if a_name == nil then return true end
    if b_name == nil then return false end
    return a_name < b_name
  end
  if ra ~= rb then return ra < rb end
  local a_type = _if_type(a); local b_type = _if_type(b)
  local a_essid = (a_type == "smart") and a.is_smart_essid or _if_label(a)
  local b_essid = (b_type == "smart") and b.is_smart_essid or _if_label(b)
  if a_essid ~= b_essid then
    if a_essid == nil and b_essid == nil then return false end
    if a_essid == nil then return true end
    if b_essid == nil then return false end
    return a_essid < b_essid
  end
  if (a_type == "smart") ~= (b_type == "smart") then return b_type == "smart" end
  local a_name = _if_name(a); local b_name = _if_name(b)
  if a_name == nil and b_name == nil then return false end
  if a_name == nil then return true end
  if b_name == nil then return false end
  return a_name < b_name
end

-- Wire keys for protocol v3.0; keep these in sync with the frontend.
local _key_map = {
  operstate = "os", type = "ty", name = "n", label = "l",
  tx_rate = "txr", tx_bytes = "txb", rx_rate = "rxr", rx_bytes = "rxb",
  mac = "m", hostname = "hn", ip = "ip", port = "p", port_label = "pl",
  mac_count = "mc", device_hints = "dh", bridge_ap_mac = "bam",
  raw_rx = "rrx", raw_tx = "rtx", signal_pct = "sp", ctr_src = "cs",
  total_rx = "trx", total_tx = "ttx", total_rx_rate = "trxr", total_tx_rate = "ttxr",
  interfaces = "ifs", ports = "pts", sub_clients = "sc", access_points = "ap",
  clients = "c", totals = "tot", essid = "e", key = "k"
}

local function apply_key_shortening(obj)
  if _S.type(obj) ~= "table" then return obj end
  local result = {}
  for k, v in _S.pairs(obj) do
    local short_key = _key_map[k] or k
    if _S.type(v) == "table" then result[short_key] = apply_key_shortening(v)
    else result[short_key] = v end
  end
  return result
end

-- Keep cache resets in one helper: Lua 5.1 limits each function to 60 upvalues.
local function drop_memory_caches()
  _local_macs_cache = nil
  _gw_cache = nil
  _leases_cache = nil
  _nft_listing_cache = nil
  _nft_counters_cache = nil
  _brport_cache = {}
  _lanjson_cache = nil
  _prev_written = nil
  _nft_prev_written = nil
  _bridge_state_written = nil
  _wireless_iface_cache = {}
  _reg_saved_ts = 0
end

-- Rediscovery may change which interface names are wireless.
local function drop_wireless_cache()
  _wireless_iface_cache = {}
end

-- This cache is only valid for one collection pass.
local function reset_pass_caches()
  _lanjson_cache = nil
end

function clear_cache()
  _force_refresh = true
  drop_memory_caches()
  _rm_cache_files()
end

function collect(fast)
  -- Open ubus if we don't have a connection yet.
  if not conn then init() end
  local now       = _S.os_time()
  local t0        = _S.os_clock()
  local sc        = SysfsCache()
  reset_pass_caches()
  -- reg_dirty saves identity changes now; reg_touched batches last_seen updates.
  local prev, reg, reg_dirty
  local reg_touched = false

  if _force_refresh then
    clear_all_caches()
    drop_memory_caches()
    prev = {}
    reg = { bridges={}, wifi_clients={}, lan_clients={}, aps={}, lan_ports={}, lan_alias={}, bridge_ap_macs={} }
    reg_dirty = true
    _force_refresh = false
  else
    prev = load_prev()
    reg = load_registry()
    reg_dirty = false
  end

  local last_disc  = _S.tonumber(reg._last_discover) or 0
  local need_disc  = (#reg.bridges == 0) or (#reg.lan_ports == 0) or (#reg.aps == 0)
                  or ((now - last_disc) >= REDISCOVER_INTERVAL)

  if need_disc then
    drop_wireless_cache()
    reg.bridges              = discover_bridges()
    reg.aps                  = discover_aps(conn)
    reg.lan_ports, reg.lan_alias = discover_lan_ports(reg.bridges)
    reg._last_discover       = now
    reg_dirty                = true
  end

  local bridges   = reg.bridges   or {}
  local lan_ports = reg.lan_ports or {}
  local lan_alias = reg.lan_alias or {}

  local ap_iface_map = {}
  for _, ap in _S.ipairs(reg.aps) do ap_iface_map[ap.iface] = ap end

  local lan_iface_set = {}
  for _, p in _S.ipairs(lan_ports) do lan_iface_set[p] = true end
  for _, b in _S.ipairs(bridges) do lan_iface_set[b] = true end

  local all_interfaces = get_cached_interfaces(now, _force_refresh and true or false)

  local clients          = { lan = {} }
  local initial_prev_ts  = _S.tonumber((readfile(prev_ts_file) or ""):match("^%s*(%d+%.?%d*)")) or 0

  local arp_table   = get_cached_arp_table(now)
  local gateway_ips  = get_gateway_ips(now)
  local local_macs  = get_all_local_macs(now)

  local json_clients = _last_lan_json_clients

  local function find_client_in_json(mac, port)
    if not json_clients or not json_clients[port] then return nil, nil end
    for _, client in _S.ipairs(json_clients[port]) do
      if client.mac and client.mac:lower() == mac:lower() then
        return client.ip or "", client.hostname or ""
      end
    end
    return nil, nil
  end

  for _, ap in _S.ipairs(reg.aps) do
    local ap_oper = sc.read_once("/sys/class/net/"..ap.iface.."/operstate")
    if not ap_oper or not ap_oper:match("^up") then
      for mac, entry in _S.pairs(reg.wifi_clients) do
        if entry.iface == ap.iface then
          reg.wifi_clients[mac] = nil
          reg_dirty = true
        end
      end
    else
      local ap_key = ap.key
      clients[ap_key] = { clients={}, totals={ raw_rx=0, raw_tx=0 } }
      local metrics   = get_cached_hostapd_metrics(ap.iface, conn, now)
      if metrics then
        local seen_wifi = {}
        for mac, m in _S.pairs(metrics) do
          seen_wifi[mac] = true
          local id = reg.wifi_clients[mac]
          if not id then
            local leases = ensure_leases()
            local lip = leases.mac2ip[mac] or ""
            id = {
              ip       = lip,
              hostname = lease_hostname(leases, mac, lip) or "",
              iface    = ap.iface,
              ap_key   = ap_key
            }
            reg.wifi_clients[mac] = id
            reg_dirty = true
          end
          if id.ip == "" then
            local arp_ip = arp_table[mac]
            if arp_ip and not is_link_local_ipv6(arp_ip) then
              id.ip     = arp_ip
              reg_dirty = true
            else
              local leases2  = ensure_leases()
              local lease_ip = leases2.mac2ip[mac]
              if lease_ip and lease_ip ~= "" then
                id.ip     = lease_ip
                reg_dirty = true
              end
            end
          end
          if id.hostname == "" then
            local leases2 = ensure_leases()
            local lease_name = lease_hostname(leases2, mac, id.ip)
            if lease_name and lease_name ~= "" then
              id.hostname = lease_name
              reg_dirty   = true
            end
          end
          local bucket = clients[ap_key].clients
          bucket[#bucket+1] = {
            mac        = mac,
            ip         = (id.ip ~= "" and id.ip or nil),
            hostname   = (id.hostname ~= "" and id.hostname or nil),
            signal_pct = m.signal_pct,
            raw_rx     = m.raw_rx,
            raw_tx     = m.raw_tx
          }
          local tot = clients[ap_key].totals
          tot.raw_rx = tot.raw_rx + m.raw_rx
          tot.raw_tx = tot.raw_tx + m.raw_tx
        end
        for mac, entry in _S.pairs(reg.wifi_clients) do
          if entry.iface == ap.iface and not seen_wifi[mac] then
            reg.wifi_clients[mac] = nil
            reg_dirty = true
          end
        end
      end
    end
  end

  local allowed_ports = {}
  for _, p in _S.ipairs(lan_ports) do allowed_ports[p] = true end

  local _, _, json_clients2 = get_lan_status_from_json()
  if json_clients2 then json_clients = json_clients2 end

  local now_fdb = _S.os_time()
  local fdb_map, port_mac_count, port_macs_list = {}, {}, {}
  local json_port_mac_count = {}

  if json_clients then
    fdb_map, port_macs_list, port_mac_count = build_fdb_from_json_clients(json_clients)
    local filtered_fdb_map = {}
    local filtered_port_macs_list = {}
    local filtered_port_mac_count = {}
    for mac, port in _S.pairs(fdb_map) do
      if allowed_ports[port] then
        filtered_fdb_map[mac] = port
        if not filtered_port_macs_list[port] then filtered_port_macs_list[port] = {} end
        local found = false
        for _, m in _S.ipairs(filtered_port_macs_list[port]) do
          if m == mac then found = true; break end
        end
        if not found then filtered_port_macs_list[port][#filtered_port_macs_list[port] + 1] = mac end
      end
    end
    for port, macs in _S.pairs(filtered_port_macs_list) do
      filtered_port_mac_count[port] = #macs
      json_port_mac_count[port] = #macs
    end
    fdb_map = filtered_fdb_map
    port_macs_list = filtered_port_macs_list
    port_mac_count = filtered_port_mac_count
  end

  do
    -- Prefer brforward; read_fdb handles the bridge command fallback.
    local fdb_entries = read_fdb(bridges, now_fdb)
    local port_macs    = {}   -- MACs found in the FDB
    local seen_in_list = {}   -- MACs from both FDB and JSON
    for _, e in _S.ipairs(fdb_entries) do
      local dev, mac = e.dev, e.mac
      if not allowed_ports or allowed_ports[dev] then
        if not fdb_map[mac] then fdb_map[mac] = dev end
        local pm = port_macs[dev]
        if not pm then
          pm = {}
          port_macs[dev] = pm
          local list = port_macs_list[dev]
          if not list then list = {}; port_macs_list[dev] = list end
          -- Seed from JSON clients so each FDB MAC needs only one membership check.
          local seen = {}
          for _, m in _S.ipairs(list) do seen[m] = true end
          seen_in_list[dev] = seen
        end
        if not pm[mac] then
          pm[mac] = true
          local seen = seen_in_list[dev]
          if not seen[mac] then
            seen[mac] = true
            local list = port_macs_list[dev]
            list[#list+1] = mac
          end
        end
      end
    end
    for port, macs in _S.pairs(port_macs) do
      local n = 0
      for _ in _S.pairs(macs) do n = n + 1 end
      port_mac_count[port] = n
    end
  end

  local br_state = load_bridge_state()
  for mac, st in _S.pairs(br_state) do
    local port = st.port
    if port and allowed_ports[port] and (now - (st.last_active_ts or 0)) < BRIDGE_IDLE_SECS then
      if not fdb_map[mac] then
        fdb_map[mac] = port
        if not port_macs_list[port] then port_macs_list[port] = {}; port_mac_count[port] = 0 end
        local already = false
        for _, m in _S.ipairs(port_macs_list[port]) do
          if m == mac then already = true; break end
        end
        if not already then
          port_macs_list[port][#port_macs_list[port]+1] = mac
          port_mac_count[port] = (port_mac_count[port] or 0) + 1
        end
        if not reg.lan_clients[mac] then
          local json_ip, json_hostname = find_client_in_json(mac, port)
          reg.lan_clients[mac] = {
            ip       = json_ip or st.ip       or "",
            hostname = json_hostname or st.hostname or "",
            port     = port,
            first_seen = now_fdb,
            last_seen = now_fdb
          }
          reg_dirty = true
        else
          reg.lan_clients[mac].last_seen = now_fdb
          reg_touched = true
          local id = reg.lan_clients[mac]
          if (id.ip == "" or id.hostname == "") then
            local json_ip, json_hostname = find_client_in_json(mac, port)
            if id.ip == "" and json_ip and json_ip ~= "" then id.ip = json_ip; reg_dirty = true end
            if id.hostname == "" and json_hostname and json_hostname ~= "" then id.hostname = json_hostname; reg_dirty = true end
          end
        end
      end
    end
  end

  for mac, port in _S.pairs(fdb_map) do
    local id = reg.lan_clients[mac]
    if not id then
      local json_ip, json_hostname = find_client_in_json(mac, port)
      local leases = ensure_leases()
      local lip = json_ip or leases.mac2ip[mac] or ""
      reg.lan_clients[mac] = {
        ip       = lip,
        hostname = json_hostname or lease_hostname(leases, mac, lip) or "",
        port     = port,
        first_seen = now_fdb,
        last_seen = now_fdb
      }
      reg_dirty = true
    else
      id.last_seen = now_fdb
      reg_touched = true
      if id.ip == "" or id.hostname == "" then
        local json_ip, json_hostname = find_client_in_json(mac, port)
        local leases = ensure_leases()
        if id.ip == "" then
          if json_ip and json_ip ~= "" then id.ip = json_ip; reg_dirty = true
          else
            local arp_ip = arp_table[mac]
            if arp_ip and not is_link_local_ipv6(arp_ip) then id.ip = arp_ip; reg_dirty = true
            elseif leases.mac2ip[mac] and leases.mac2ip[mac] ~= "" then id.ip = leases.mac2ip[mac]; reg_dirty = true end
          end
        end
        if id.hostname == "" then
          if json_hostname and json_hostname ~= "" then id.hostname = json_hostname; reg_dirty = true
          else
            local lease_name = lease_hostname(leases, mac, id.ip)
            if lease_name and lease_name ~= "" then id.hostname = lease_name; reg_dirty = true end
          end
        end
      end
      if id.port ~= port then id.port = port; reg_dirty = true end
    end
  end

  for mac, entry in _S.pairs(reg.lan_clients) do
    if not fdb_map[mac] then
      local last_seen = entry.last_seen or 0
      if (now_fdb - last_seen) > REGISTRY_TTL then
        reg.lan_clients[mac] = nil
        reg_dirty = true
      end
    end
  end

  local port2mac = {}
  for mac, entry in _S.pairs(reg.lan_clients) do
    port2mac[entry.port] = mac
  end

  local nft_listing = get_cached_nft_listing(5)
  -- Reuse the listing for the table check.
  if nft_ensure_setup(nft_listing) then
    nft_listing = get_cached_nft_listing(5)
  end
  local nft_prev     = load_nft_prev()
  local nft_now      = _S.os_time()
  local new_nft_prev = { _ts=nft_now, macs={} }
  local cur_nft = nft_read_counters(nft_listing)

  local lan_sum_rx, lan_sum_tx = 0, 0
  -- Track each port's counter source so combined rates can reset their baseline.
  local lan_src_sig = {}
  for _, p in _S.ipairs(lan_ports) do
    if not ap_iface_map[p] then
      local oper    = sc.read_once("/sys/class/net/"..p.."/operstate")
      local carrier = sc.read_once("/sys/class/net/"..p.."/carrier")
      local is_up   = (oper and oper:match("^up")) or (carrier == "1")
      local rx = 0
      local tx = 0
      if is_up then
        rx, tx = sc.iface_bytes(p)
      end
      local all_macs = port_macs_list[p] or {}
      local mcount   = port_mac_count[p] or 0
      local json_mcount = json_port_mac_count and json_port_mac_count[p] or 0

      -- Keep a port if it has carrier or any discovered clients.
      if is_up or mcount > 0 or json_mcount > 0 then
        local bridge_ap_mac = (function()
        if json_mcount == 0 then return nil end
        if mcount <= 1 then return nil end
        local earliest_mac = nil
        local earliest_time = nil
        for _, m in _S.ipairs(all_macs) do
          local entry = reg.lan_clients[m]
          if entry and entry.first_seen then
            if not earliest_time or entry.first_seen < earliest_time then
              earliest_time = entry.first_seen
              earliest_mac = m
            end
          end
        end
        if not earliest_mac then
          local leases = ensure_leases()
          local function mac_score(m)
            local s      = 0
            local arp_ip   = arp_table[m]
            local reg_e    = reg.lan_clients[m]
            local reg_ip   = (reg_e and reg_e.ip ~= "") and reg_e.ip or nil
            local lease_ip = (leases.mac2ip[m] and leases.mac2ip[m] ~= "") and leases.mac2ip[m] or nil
            local hostname = leases.mac2name[m] or (reg_e and reg_e.hostname ~= "" and reg_e.hostname) or ""
            if arp_ip and is_link_local_ipv6(arp_ip) then arp_ip = nil end
            local any_ip = arp_ip or reg_ip or lease_ip
            if _S.type(any_ip) == "string" and gateway_ips[any_ip] then s = s + 10 end
            if is_router_hostname(hostname) then s = s + 5 end
            if any_ip and not lease_ip then s = s + 3 end
            if not any_ip and hostname == "" then s = s + 2 end
            if any_ip then s = s + 1 end
            if lease_ip and not is_router_hostname(hostname) and not (_S.type(any_ip) == "string" and gateway_ips[any_ip]) then s = s - 4 end
            if hostname ~= "" and not is_router_hostname(hostname) then s = s - 1 end
            return s
          end
          local cached_ap  = reg.bridge_ap_macs[p]
          local best_mac   = nil
          local best_eff   = -999
          local best_raw   = -999
          for _, m in _S.ipairs(all_macs) do
            local raw = mac_score(m)
            local eff = raw + (m == cached_ap and 1 or 0)
            if eff > best_eff then best_eff = eff; best_raw = raw; best_mac = m end
          end
          if best_raw > 0 then return best_mac end
          if cached_ap then
            for _, m in _S.ipairs(all_macs) do if m == cached_ap then return m end end
          end
          return nil
        end
        return earliest_mac
      end)()

      if bridge_ap_mac then
        if reg.bridge_ap_macs[p] ~= bridge_ap_mac then reg.bridge_ap_macs[p] = bridge_ap_mac; reg_dirty = true end
      elseif reg.bridge_ap_macs[p] then
        reg.bridge_ap_macs[p] = nil
        reg_dirty = true
      end

      local bridge_ap_ip = ""
      if bridge_ap_mac then
        local entry = reg.lan_clients[bridge_ap_mac]
        if entry and entry.ip ~= "" and not is_link_local_ipv6(entry.ip) then
          bridge_ap_ip = entry.ip
        else
          local leases = ensure_leases()
          local lease_ip = leases.mac2ip[bridge_ap_mac]
          if lease_ip and lease_ip ~= "" then bridge_ap_ip = lease_ip
          else
            local arp_ip = arp_table[bridge_ap_mac]
            if arp_ip and not is_link_local_ipv6(arp_ip) then bridge_ap_ip = arp_ip end
          end
        end
      end

      local mac = ""
      local hostname = ""
      local ip_addr = ""
      local id = nil
      if json_mcount > 0 or mcount > 0 then
        local is_ap_active = false
        if bridge_ap_mac then
          for _, m in _S.ipairs(all_macs) do
            if m == bridge_ap_mac then is_ap_active = true; break end
          end
        end
        if is_ap_active then mac = bridge_ap_mac
        elseif mcount == 1 then mac = all_macs[1]
        elseif mcount > 1 then
          local cached_mac = port2mac[p]
          if cached_mac then
            for _, m in _S.ipairs(all_macs) do
              if m == cached_mac then mac = cached_mac; break end
            end
          end
          if mac == "" then mac = all_macs[1] end
        end
        id = mac ~= "" and reg.lan_clients[mac] or nil
        hostname = (id and id.hostname ~= "") and id.hostname or (lan_alias[p] or p)
        ip_addr = id and id.ip or ""
      else
        hostname = lan_alias[p] or p
      end

      if bridge_ap_ip ~= "" and ip_addr == "" then
        ip_addr = bridge_ap_ip
        if id then id.ip = ip_addr; reg_dirty = true end
      end

      local hints     = {}
      if json_mcount > 0 and (mcount > 1 or bridge_ap_mac) then hints[#hints+1] = "bridge" end
      if ip_addr ~= "" and gateway_ips[ip_addr] then hints[#hints+1] = "gateway" end

      -- No IP in the registry yet; try the DHCP lease.
      if json_mcount > 0 and mac ~= "" and ip_addr == "" and mcount <= 1 then
        local leases = ensure_leases()
        local lease_ip = leases.mac2ip[mac]
        if lease_ip and lease_ip ~= "" then
          ip_addr = lease_ip
          if id then id.ip = ip_addr end
          reg_dirty = true
        end
        if ip_addr == "" then
          local already_bridge = false
          for _, h in _S.ipairs(hints) do if h == "bridge" then already_bridge = true; break end end
          if not already_bridge then
            if json_mcount > 0 then
              if mcount == 1 then hints[#hints+1] = "subap"
              else hints[#hints+1] = "bridge" end
            end
          end
        end
      end

      if json_mcount > 0 and mcount > 1 then
        local has_mac_only = false
        local leases = ensure_leases()
        for _, other_mac in _S.ipairs(all_macs) do
          if other_mac ~= mac then
            local entry = reg.lan_clients[other_mac]
            local lease_ip = leases.mac2ip[other_mac] or ""
            local has_ip = (entry and entry.ip ~= "" and not is_link_local_ipv6(entry.ip)) or
                           (lease_ip and lease_ip ~= "" and not is_link_local_ipv6(lease_ip))
            if not has_ip then has_mac_only = true; break end
          end
        end
        if has_mac_only then
          local already_subap = false
          for _, h in _S.ipairs(hints) do if h == "subap" then already_subap = true; break end end
          if not already_subap then hints[#hints+1] = "subap" end
        end
      end

      if mac == "" and ip_addr == "" then
        local speed_raw = sc.read_once("/sys/class/net/"..p.."/speed") or ""
        local speed_num = _S.tonumber(speed_raw:match("^%s*(%d+)")) or 0
        if speed_num > 0 and speed_num <= 10 then hints[#hints+1] = "eth_issue" end
      end

      -- Use tracked MAC counters for bridge/AP totals. Physical port counters
      -- include management, broadcast and offloaded traffic that nft may not see.
      local sub_list = nil
      local nft_sum_rx, nft_sum_tx = 0, 0
      local mac_digest = 0
      if mcount > 1 then
        local leases = ensure_leases()
        sub_list = {}
        for _, m in _S.ipairs(all_macs) do
          local nft_data = cur_nft and cur_nft[m]
          local m_rx = nft_data and nft_data.rx or 0
          local m_tx = nft_data and nft_data.tx or 0
          nft_sum_rx = nft_sum_rx + m_rx
          nft_sum_tx = nft_sum_tx + m_tx
          -- Order-independent tag for the MACs contributing to the total.
          local hex = (m:gsub("[^%x]", ""))
          mac_digest = mac_digest + (_S.tonumber(hex:sub(1, 6), 16) or 0)
                                  + (_S.tonumber(hex:sub(7, 12), 16) or 0)
          if m ~= mac then
            local entry  = reg.lan_clients[m]
            local lease_ip = leases.mac2ip[m]
            local use_ip = (entry and entry.ip ~= "" and not is_link_local_ipv6(entry.ip)) and entry.ip
              or (lease_ip and lease_ip ~= "" and not is_link_local_ipv6(lease_ip) and lease_ip)
              or ""
            local is_dup = use_ip ~= "" and (use_ip == ip_addr or gateway_ips[use_ip])
            local sub_host = (entry and entry.hostname ~= "") and entry.hostname or (lease_hostname(leases, m, use_ip) or "")
            if not is_dup then
              sub_list[#sub_list+1] = { mac=m, ip=use_ip, hostname=sub_host, rrx=m_rx, rtx=m_tx }
            end
          end
        end
        if #sub_list == 0 then sub_list = nil end
      end

      -- Use physical counters without sub-clients, flipped to the client's view.
      local port_raw_rx, port_raw_tx
      if sub_list then
        port_raw_rx = nft_sum_rx
        port_raw_tx = nft_sum_tx
      else
        port_raw_rx = tx
        port_raw_tx = rx
      end

      -- nft sums, physical counters and link-down zeroes aren't comparable.
      -- Tell consumers when the source or MAC set changes so they reset the
      -- rate baseline instead of showing a counter-switch spike.
      local ctr_src
      if sub_list then
        ctr_src = "nft:" .. mcount .. ":" .. mac_digest
      elseif is_up then
        ctr_src = "phys"
      else
        ctr_src = "down"
      end
      lan_src_sig[#lan_src_sig+1] = p .. "=" .. ctr_src

      clients.lan[#clients.lan+1] = {
        port        = p,
        port_label  = lan_alias[p] or p,
        hostname    = (hostname ~= "" and hostname) or "",
        mac         = (mac ~= "" and mac) or "",
        ip          = (ip_addr ~= "" and ip_addr) or "",
        raw_rx      = port_raw_rx,
        raw_tx      = port_raw_tx,
        ctr_src     = ctr_src,
        mac_count   = mcount,
        device_hints = hints,
        sub_clients  = sub_list,
        bridge_ap_mac = bridge_ap_mac,
        bridge_ap_ip  = (bridge_ap_ip ~= "" and bridge_ap_ip or nil)
      }
      prev["lan_"..p] = { rx=port_raw_rx, tx=port_raw_tx, ts=now, src=ctr_src }
      lan_sum_rx = lan_sum_rx + port_raw_rx
      lan_sum_tx = lan_sum_tx + port_raw_tx
      end
    end
  end

  clients.lan_totals = { raw_rx = lan_sum_rx, raw_tx = lan_sum_tx }

  local refresh = 2

  do
    local wireless_to_ap = {}
    for k, v in _S.pairs(ap_iface_map) do wireless_to_ap[k] = v end
    local uci_wan_dev  = uci:get("network", "wan", "device") or ""
    local uci_wan_dev2 = uci:get("network", "wan", "ifname") or ""
    local uci_wan_phys = (uci_wan_dev ~= "" and uci_wan_dev) or (uci_wan_dev2 ~= "" and uci_wan_dev2) or nil
    local route_iface = ""
    do
      local _rc = readfile("/proc/net/route") or ""
      for _line in _rc:gmatch("[^\n]+") do
        local _iface, _dest = _line:match("^(%S+)\t(%x+)\t")
        if _iface and _dest == "00000000" then route_iface = _iface; break end
      end
    end
    local mapped_aps = {}
    for iface_name, ap in _S.pairs(wireless_to_ap) do
      if all_interfaces[iface_name] then mapped_aps[ap] = true end
    end
    for iface_name in _S.pairs(all_interfaces) do
      if is_wireless_iface(iface_name) and not wireless_to_ap[iface_name] then
        local ap = ap_iface_map[iface_name]
        if ap then
          wireless_to_ap[iface_name] = ap
          mapped_aps[ap] = true
        else
          for _, candidate in _S.ipairs(reg.aps) do
            if not mapped_aps[candidate] then
              wireless_to_ap[iface_name] = candidate
              mapped_aps[candidate] = true
              break
            end
          end
        end
      end
    end
    local iface_array = {}
    for iface in _S.pairs(all_interfaces) do
      if iface ~= "lo" then _S.t_insert(iface_array, iface) end
    end
    local raw_stats
    if #iface_array > 0 then raw_stats = sc.batch_read_iface_stats(iface_array) else raw_stats = {} end

    local wan_logical  = nil
    local wan_physical = nil
    local candidates = {}
    for iface in _S.pairs(all_interfaces) do
      if iface:find("pppoe") then _S.t_insert(candidates, { name=iface, pri=0 })
      elseif iface:find("^wan") then _S.t_insert(candidates, { name=iface, pri=1 }) end
    end
    _S.t_sort(candidates, function(a,b) return a.pri < b.pri end)
    for i=1, #candidates do
      local c = candidates[i]
      local oper = raw_stats[c.name] and raw_stats[c.name].oper or (sc.read_once("/sys/class/net/"..c.name.."/operstate") or ""):gsub("%s+", "")
      if oper == "up" then wan_logical = c.name; break end
    end
    if not wan_logical and #candidates > 0 then wan_logical = candidates[1].name end
    if uci_wan_phys and uci_wan_phys ~= "" and uci_wan_phys ~= wan_logical then
      wan_physical = uci_wan_phys
    elseif route_iface ~= "" and route_iface ~= wan_logical then
      if route_iface:find("^eth") or route_iface:find("^eno") or route_iface:find("^enp") then
        wan_physical = route_iface
      end
    end
    local wan_allowed = {}
    if wan_logical  then wan_allowed[wan_logical]  = true end
    if wan_physical then wan_allowed[wan_physical] = true end

    local lan_acc  = { rx_b=0, tx_b=0, rx_rate=0, tx_rate=0, active=false }

    local has_lan_clients = _S.next(reg.lan_clients) ~= nil

    local iface_list = {}
    local added_ifaces = {}
    for iface in _S.pairs(all_interfaces) do
      if not added_ifaces[iface] then
        local d = raw_stats[iface]
        local oper        = d and d.oper or "unknown"
        local rx_b        = d and d.rx_b or 0
        local tx_b        = d and d.tx_b or 0
        local ap_info     = wireless_to_ap[iface] or ap_iface_map[iface]
        local is_lan_port = lan_iface_set[iface] == true
        local is_wan      = wan_allowed[iface] == true
        local is_other    = not is_wan and not is_lan_port and not ap_info
        local _noise = iface:find("^dummy") or iface:find("^veth")
                    or iface:find("^docker") or iface:find("^virbr")
                    or iface:find("^ifb")    or iface:find("^teql")
                    or iface:find("^sit%d")  or iface:find("^gre%d")
                    or iface:find("^ip6tnl") or iface:find("^br")
        local _skip = (_noise ~= nil) or oper ~= "up"
        if ap_info then _skip = true end
        if not _skip then
          local rx_rate, tx_rate = 0, 0
          if d then
            local prev_k  = "ifr_" .. iface
            local prev_e  = prev[prev_k]
            local dt      = prev_e and (now - (prev_e.ts or 0)) or 0
            local effective_dt = dt > 0 and dt or 1
            local max_dt = refresh * 2.5
            if prev_e and dt > 0 and dt <= max_dt then
              rx_rate = _S.m_max(0, rx_b - (prev_e.rx or 0)) / effective_dt
              tx_rate = _S.m_max(0, tx_b - (prev_e.tx or 0)) / effective_dt
              if rx_b ~= prev_e.rx or tx_b ~= prev_e.tx then
                prev[prev_k]  = { rx=rx_b, tx=tx_b, ts=now }
              end
            else
              prev[prev_k]  = { rx=rx_b, tx=tx_b, ts=now }
            end
          end
          local show_rx_rate, show_tx_rate, show_rx_b, show_tx_b
          if is_lan_port then
            show_rx_rate = tx_rate; show_tx_rate = rx_rate
            show_rx_b    = tx_b;    show_tx_b    = rx_b
          else
            show_rx_rate = rx_rate; show_tx_rate = tx_rate
            show_rx_b    = rx_b;    show_tx_b    = tx_b
          end
          if is_lan_port then
            lan_acc.rx_b    = lan_acc.rx_b    + show_rx_b
            lan_acc.tx_b    = lan_acc.tx_b    + show_tx_b
            lan_acc.rx_rate = lan_acc.rx_rate + show_rx_rate
            lan_acc.tx_rate = lan_acc.tx_rate + show_tx_rate
            lan_acc.active  = true
          else
            local label
            if is_wan then
              local wtype = iface:find("pppoe") and "PPPoE"
                         or (iface == uci_wan_phys or iface == wan_physical) and "Wan Port"
                         or "WAN"
              label = _S.fmt("%s (%s)", wtype, iface)
            elseif is_other then
              local vtype = (iface:find("^wg") or iface:find("^nordlynx") or iface:find("^mullvad") or iface:find("^proton")) and "WireGuard"
                         or (iface:find("^tun") or iface:find("^tap") or iface:find("^ovpn")) and "OpenVPN"
                         or (iface:find("^ipsec") or iface:find("^l2tp") or iface:find("^pptp")) and "VPN"
                         or nil
              label = vtype and _S.fmt("%s (%s)", vtype, iface) or iface
            else
              label = iface
            end
            local iface_type
            if is_wan then iface_type = "wan"
            elseif is_lan_port then iface_type = "lan_port"
            elseif is_other then iface_type = "other"
            else iface_type = "unknown" end
            iface_list[#iface_list+1] = {
              n   = iface, l   = label, os  = oper,
              rxb = _S.m_floor(show_rx_b), txb = _S.m_floor(show_tx_b),
              rxr = _S.m_floor(show_rx_rate), txr = _S.m_floor(show_tx_rate),
              ty  = iface_type,
            }
            added_ifaces[iface] = true
          end
        end
      end
    end

    if has_lan_clients and clients.lan_totals then
      local lan_totals = clients.lan_totals
      local prev_k = "lan_totals"
      local prev_e = prev[prev_k]
      local dt = prev_e and (now - (prev_e.ts or 0)) or 0
      local effective_dt = dt > 0 and dt or 1
      local max_dt = refresh * 2.5
      -- Reset combined rates if any port changed counter source.
      -- Sort the signature so rediscovery order alone doesn't reset the baseline.
      _S.t_sort(lan_src_sig)
      local src_sig = _S.t_concat(lan_src_sig, ",")
      local rx_rate, tx_rate
      if prev_e and dt > 0 and dt <= max_dt and prev_e.src == src_sig then
        rx_rate = _S.m_max(0, lan_totals.raw_rx - (prev_e.rx or 0)) / effective_dt
        tx_rate = _S.m_max(0, lan_totals.raw_tx - (prev_e.tx or 0)) / effective_dt
        if lan_totals.raw_rx ~= prev_e.rx or lan_totals.raw_tx ~= prev_e.tx then
          prev[prev_k] = { rx=lan_totals.raw_rx, tx=lan_totals.raw_tx, ts=now, src=src_sig }
        end
      else
        rx_rate = 0; tx_rate = 0
        prev[prev_k] = { rx=lan_totals.raw_rx, tx=lan_totals.raw_tx, ts=now, src=src_sig }
      end
      iface_list[#iface_list+1] = {
        name="__lan_combined__", label="LAN Ports (combined)", operstate="up",
        rx_bytes=_S.m_floor(lan_totals.raw_rx), tx_bytes=_S.m_floor(lan_totals.raw_tx),
        rx_rate=_S.m_floor(rx_rate), tx_rate=_S.m_floor(tx_rate), type="lan_port",
      }
    elseif lan_acc.active and has_lan_clients then
      iface_list[#iface_list+1] = {
        name="__lan_combined__", label="LAN Ports (combined)", operstate="up",
        rx_bytes=_S.m_floor(lan_acc.rx_b), tx_bytes=_S.m_floor(lan_acc.tx_b),
        rx_rate=_S.m_floor(lan_acc.rx_rate), tx_rate=_S.m_floor(lan_acc.tx_rate), type="lan_port",
      }
    end

    local essid_ap_count = {}
    local essid_has_clients = {}
    for _, ap in _S.ipairs(reg.aps) do
      local essid = ap.essid or ap.iface
      essid_ap_count[essid] = (essid_ap_count[essid] or 0) + 1
      local ap_key = ap.key
      local ap_clients = clients[ap_key]
      if ap_clients and ap_clients.clients and #ap_clients.clients > 0 then
        essid_has_clients[essid] = (essid_has_clients[essid] or 0) + 1
      else
        essid_has_clients[essid] = (essid_has_clients[essid] or 0) + 0
      end
    end

    local essid_totals = {}
    local wireless_rx  = 0
    local wireless_tx  = 0
    for _, ap in _S.ipairs(reg.aps) do
      local ap_key    = ap.key
      local essid     = ap.essid or ap.iface
      local ap_totals = clients[ap_key] and clients[ap_key].totals
      local ap_clients = clients[ap_key]
      local has_clients = ap_clients and ap_clients.clients and #ap_clients.clients > 0
      local rx_rate, tx_rate, rx_bytes, tx_bytes = 0, 0, 0, 0
      if ap_totals then
        local prev_k  = "ap_totals_" .. ap_key
        local prev_e  = prev[prev_k]
        local dt      = prev_e and (now - (prev_e.ts or 0)) or 0
        local eff_dt  = dt > 0 and dt or 1
        local max_dt = refresh * 2.5
        if prev_e and dt > 0 and dt <= max_dt then
          rx_rate = _S.m_max(0, ap_totals.raw_rx - (prev_e.rx or 0)) / eff_dt
          tx_rate = _S.m_max(0, ap_totals.raw_tx - (prev_e.tx or 0)) / eff_dt
          if ap_totals.raw_rx ~= prev_e.rx or ap_totals.raw_tx ~= prev_e.tx then
            prev[prev_k]  = { rx=ap_totals.raw_rx, tx=ap_totals.raw_tx, ts=now }
          end
        else
          rx_rate = 0; tx_rate = 0
          prev[prev_k]  = { rx=ap_totals.raw_rx, tx=ap_totals.raw_tx, ts=now }
        end
        rx_bytes, tx_bytes = ap_totals.raw_rx, ap_totals.raw_tx
      else
        local phys_rx, phys_tx = sc.iface_bytes(ap.iface)
        local cur_rx, cur_tx = phys_tx, phys_rx
        local prev_k = "ifr_" .. ap.iface
        local prev_e = prev[prev_k]
        local dt = prev_e and (now - (prev_e.ts or 0)) or 0
        local eff_dt = dt > 0 and dt or 1
        if prev_e and dt > 0 and dt <= refresh * 2.5 then
          rx_rate = _S.m_max(0, cur_rx - (prev_e.rx or 0)) / eff_dt
          tx_rate = _S.m_max(0, cur_tx - (prev_e.tx or 0)) / eff_dt
          if cur_rx ~= prev_e.rx or cur_tx ~= prev_e.tx then
            prev[prev_k] = { rx=cur_rx, tx=cur_tx, ts=now }
          end
        else
          prev[prev_k] = { rx=cur_rx, tx=cur_tx, ts=now }
        end
        rx_bytes, tx_bytes = cur_rx, cur_tx
      end
      if has_clients then
        local sum_rx, sum_tx = 0, 0
        for _, client in _S.ipairs(ap_clients.clients) do
          sum_rx = sum_rx + (client.raw_rx or client.rrx or 0)
          sum_tx = sum_tx + (client.raw_tx or client.rtx or 0)
        end
        if sum_rx > 0 or sum_tx > 0 then
          rx_bytes, tx_bytes = sum_rx, sum_tx
          if ap_totals then ap_totals.raw_rx = sum_rx; ap_totals.raw_tx = sum_tx end
        end
      end
      local et = essid_totals[essid]
      if not et then et = { rx_b=0, tx_b=0, rx_rate=0, tx_rate=0, count=0 }; essid_totals[essid] = et end
      et.rx_b    = et.rx_b    + rx_bytes
      et.tx_b    = et.tx_b    + tx_bytes
      et.rx_rate = et.rx_rate + rx_rate
      et.tx_rate = et.tx_rate + tx_rate
      et.count   = et.count   + 1
      wireless_rx = wireless_rx + rx_bytes
      wireless_tx = wireless_tx + tx_bytes
    end

    local emitted_smart = {}
    for essid, et in _S.pairs(essid_totals) do
      local smart_name = "__smart_" .. essid .. "__"
      local need_smart = et.count > 1
      local has_clients_count = essid_has_clients[essid] or 0
      local ap_count = essid_ap_count[essid] or et.count
      local enough_clients = ap_count > 0 and has_clients_count >= _S.m_ceil(ap_count * 2 / 3)
      if need_smart and enough_clients then
        emitted_smart[essid] = true
        iface_list[#iface_list+1] = {
          name=smart_name, label=_S.fmt("%s (smart)", essid), operstate="up",
          rx_bytes=_S.m_floor(et.rx_b), tx_bytes=_S.m_floor(et.tx_b),
          rx_rate=_S.m_floor(et.rx_rate), tx_rate=_S.m_floor(et.tx_rate),
          is_smart_essid=essid, type="smart",
        }
      end
    end

    -- These totals already use physical AP counters when hostapd data is missing.
    -- Reuse them for the combined wireless card.
    local wifi_combined_rx_b = wireless_rx
    local wifi_combined_tx_b = wireless_tx
    local wifi_combined_rx_rate, wifi_combined_tx_rate
    if wireless_rx > 0 or wireless_tx > 0 then
      local prev_k = "wireless_clients_combined"
      local prev_e = prev[prev_k]
      local dt     = prev_e and (now - (prev_e.ts or 0)) or 0
      local eff_dt = dt > 0 and dt or 1
      local max_dt = refresh * 2.5
      if prev_e and dt > 0 and dt <= max_dt then
        wifi_combined_rx_rate = _S.m_max(0, wireless_rx - (prev_e.rx or 0)) / eff_dt
        wifi_combined_tx_rate = _S.m_max(0, wireless_tx - (prev_e.tx or 0)) / eff_dt
        if wireless_rx ~= prev_e.rx or wireless_tx ~= prev_e.tx then
          prev[prev_k] = { rx=wireless_rx, tx=wireless_tx, ts=now }
        end
      else
        wifi_combined_rx_rate = 0; wifi_combined_tx_rate = 0
        prev[prev_k] = { rx=wireless_rx, tx=wireless_tx, ts=now }
      end
    else
      wifi_combined_rx_rate = 0; wifi_combined_tx_rate = 0
    end
    if wifi_combined_rx_b > 0 or wifi_combined_tx_b > 0 then
      iface_list[#iface_list+1] = {
        name="__wifi_combined__", label="Wireless (combined)", operstate="up",
        rx_bytes=_S.m_floor(wifi_combined_rx_b), tx_bytes=_S.m_floor(wifi_combined_tx_b),
        rx_rate=_S.m_floor(wifi_combined_rx_rate or 0), tx_rate=_S.m_floor(wifi_combined_tx_rate or 0),
        type="wifi_combined",
      }
    end

    for _, entry in _S.ipairs(iface_list) do
        if entry.n and not entry.name then entry.name = entry.n end
        if entry.l and not entry.label then entry.label = entry.l end
        if entry.ty and not entry.type then entry.type = entry.ty end
        if entry.os and not entry.operstate then entry.operstate = entry.os end
        if entry.rxb and not entry.rx_bytes then entry.rx_bytes = entry.rxb end
        if entry.txb and not entry.tx_bytes then entry.tx_bytes = entry.txb end
        if entry.rxr and not entry.rx_rate then entry.rx_rate = entry.rxr end
        if entry.txr and not entry.tx_rate then entry.tx_rate = entry.txr end
    end

    _S.t_sort(iface_list, _iface_rate_lt)

    clients.iface_rates = iface_list
  end

  if reg_dirty then
    save_registry(reg); reg_dirty = false; _reg_saved_ts = now
  elseif reg_touched and (now - _reg_saved_ts) >= REGISTRY_TOUCH_TTL then
    save_registry(reg); _reg_saved_ts = now
  end

  local latest_prev_ts = _S.tonumber((readfile(prev_ts_file) or ""):match("^%s*(%d+%.?%d*)")) or 0
  if latest_prev_ts == initial_prev_ts then
    guarded_atomic_write_prev(prev, latest_prev_ts)
  else
    atomic_write_tmp(prev_ts_file, _S.tostring(now))
  end

  local t1 = _S.os_clock()

  local bridge_mac_set = {}
  local bridge_by_port = {}
  local seen_macs      = {}

  for _, lc in _S.ipairs(clients.lan) do
    if (lc.mac_count or 0) > 1 and lc.sub_clients and #lc.sub_clients > 0 then
      for _, subc in _S.ipairs(lc.sub_clients) do
        local mac = subc.mac
        seen_macs[mac] = true
        local st = br_state[mac]
        if not st then
          st = { last_active_ts=now, ip=subc.ip or "", port=lc.port, port_label=lc.port_label, hostname=subc.hostname or "" }
          br_state[mac] = st
        end
        if subc.ip and subc.ip ~= "" then st.ip = subc.ip end
        st.hostname   = subc.hostname or st.hostname or ""
        st.port       = lc.port
        st.port_label = lc.port_label
        local cur_c     = cur_nft[mac]
        local prv_c     = (nft_prev.macs or {})[mac]
        local cur_total = cur_c and ((cur_c.rx or 0) + (cur_c.tx or 0)) or 0
        local prv_total = prv_c and ((prv_c.rx or 0) + (prv_c.tx or 0)) or 0
        if (cur_total - prv_total) >= BRIDGE_ACTIVE_BYTES then
          st.last_active_ts = now
        end
        if cur_c then
          new_nft_prev.macs[mac] = { rx=cur_c.rx or 0, tx=cur_c.tx or 0 }
        end
        local use_ip = (subc.ip and subc.ip ~= "") and subc.ip or (st.ip ~= "" and st.ip) or ""
        bridge_mac_set[mac] = true
        if not bridge_by_port[lc.port] then
          bridge_by_port[lc.port] = { port_label=lc.port_label or lc.port, clients={} }
        end
        local bp = bridge_by_port[lc.port].clients
        bp[#bp+1] = { mac=mac, ip=(use_ip ~= "" and use_ip or nil), hostname=(subc.hostname ~= "" and subc.hostname or nil) }
      end
    end
  end

  for mac, st in _S.pairs(br_state) do
    if not seen_macs[mac] then br_state[mac] = nil end
  end

  clients.bridge_clients = {}
  for port, pe in _S.pairs(bridge_by_port) do
    local band_clients = {}
    local sum_rx, sum_tx = 0, 0
    for _, subc in _S.ipairs(pe.clients) do
      local mac   = subc.mac
      local cur_c = cur_nft[mac]
      local raw_rx = cur_c and cur_c.rx or 0
      local raw_tx = cur_c and cur_c.tx or 0
      sum_rx = sum_rx + raw_rx
      sum_tx = sum_tx + raw_tx
      band_clients[#band_clients+1] = {
        mac=mac, ip=(subc.ip ~= "" and subc.ip or nil), hostname=(subc.hostname ~= "" and subc.hostname or nil),
        raw_rx=raw_rx, raw_tx=raw_tx,
      }
    end
    clients.bridge_clients[#clients.bridge_clients+1] = {
      key=_S.fmt("Bridge AP (%s)", pe.port_label),
      port=port, clients=band_clients,
      totals={ raw_rx=sum_rx, raw_tx=sum_tx },
    }
  end

  if _S.next(bridge_mac_set) then
    for mac in _S.pairs(bridge_mac_set) do nft_ensure_mac(mac, nft_listing) end
    nft_remove_stale(bridge_mac_set, nft_listing)
  end

  for _, lc in _S.ipairs(clients.lan) do
    if (lc.mac_count or 0) > 1 or has_hint(lc.device_hints, "bridge") then
      local port_label = lc.port_label or lc.port
      local key        = _S.fmt("Bridge AP (%s)", port_label)
      local already    = false
      for _, bc in _S.ipairs(clients.bridge_clients) do
        if bc.key == key then already = true; break end
      end
      if not already then
        clients.bridge_clients[#clients.bridge_clients+1] = {
          key=key, port=lc.port, clients={}, totals={ raw_rx=0, raw_tx=0 },
        }
      end
    end
  end

  save_nft_prev(new_nft_prev)
  save_bridge_state(br_state)

  clients._runtime_s = _S.tonumber(_S.fmt("%.3f", t1 - t0))
  clients._ts = now

  local function transform_to_grouped_structure(clients_table)
    local grouped = {
      _version = "3.0", _format = "short_keys",
      _runtime_s = clients_table._runtime_s, _ts = clients_table._ts,
      groups = {
        wan = { label = "WAN Interfaces", interfaces = {}, total_rx = 0, total_tx = 0, total_rx_rate = 0, total_tx_rate = 0 },
        lan = { label = "LAN", ports = apply_key_shortening(clients_table.lan or {}), interfaces = {}, total_rx = 0, total_tx = 0, total_rx_rate = 0, total_tx_rate = 0 },
        wireless = { label = "Wireless", access_points = {}, interfaces = {}, total_rx = 0, total_tx = 0, total_rx_rate = 0, total_tx_rate = 0 },
        bridge = { label = "Bridge APs", clients = apply_key_shortening(clients_table.bridge_clients or {}), total_rx = 0, total_tx = 0, total_rx_rate = 0, total_tx_rate = 0 },
        other = { label = "Other Interfaces", interfaces = {}, total_rx = 0, total_tx = 0, total_rx_rate = 0, total_tx_rate = 0 },
      },
      totals = {
        lan = apply_key_shortening(clients_table.lan_totals or { raw_rx = 0, raw_tx = 0 }),
        wireless = { raw_rx = 0, raw_tx = 0 }
      }
    }
    for key, value in _S.pairs(clients_table) do
      if _S.type(key) == "string" and key:match("^%(") and key:match("%)$") then
        if _S.type(value) == "table" and value.clients then
          local ap_obj = {
            k = key, e = key:match("%((.-)%)") or key,
            c = value.clients, tot = value.totals or { raw_rx = 0, raw_tx = 0 }
          }
          _S.t_insert(grouped.groups.wireless.access_points, ap_obj)
        end
      end
    end
    if clients_table.iface_rates then
      for _, iface in _S.ipairs(clients_table.iface_rates) do
        local iface_type = iface.ty or iface.type or "unknown"
        local simple_iface = {
          n   = iface.name, l   = iface.label, os  = iface.operstate,
          rxb = iface.rx_bytes, txb = iface.tx_bytes,
          rxr = iface.rx_rate, txr = iface.tx_rate, ty  = iface_type
        }
        if iface_type == "wan" then
          _S.t_insert(grouped.groups.wan.interfaces, simple_iface)
          grouped.groups.wan.total_rx = grouped.groups.wan.total_rx + (iface.rx_bytes or 0)
          grouped.groups.wan.total_tx = grouped.groups.wan.total_tx + (iface.tx_bytes or 0)
          grouped.groups.wan.total_rx_rate = grouped.groups.wan.total_rx_rate + (iface.rx_rate or 0)
          grouped.groups.wan.total_tx_rate = grouped.groups.wan.total_tx_rate + (iface.tx_rate or 0)
        elseif iface_type == "lan_port" then
          _S.t_insert(grouped.groups.lan.interfaces, simple_iface)
          grouped.groups.lan.total_rx = grouped.groups.lan.total_rx + (iface.rx_bytes or 0)
          grouped.groups.lan.total_tx = grouped.groups.lan.total_tx + (iface.tx_bytes or 0)
          grouped.groups.lan.total_rx_rate = grouped.groups.lan.total_rx_rate + (iface.rx_rate or 0)
          grouped.groups.lan.total_tx_rate = grouped.groups.lan.total_tx_rate + (iface.tx_rate or 0)
        elseif iface_type == "ap_clients" or iface_type == "ap" or iface_type == "wifi_combined" or iface_type == "smart" then
          _S.t_insert(grouped.groups.wireless.interfaces, simple_iface)
          grouped.groups.wireless.total_rx = grouped.groups.wireless.total_rx + (iface.rx_bytes or 0)
          grouped.groups.wireless.total_tx = grouped.groups.wireless.total_tx + (iface.tx_bytes or 0)
          grouped.groups.wireless.total_rx_rate = grouped.groups.wireless.total_rx_rate + (iface.rx_rate or 0)
          grouped.groups.wireless.total_tx_rate = grouped.groups.wireless.total_tx_rate + (iface.tx_rate or 0)
        else
          _S.t_insert(grouped.groups.other.interfaces, simple_iface)
          grouped.groups.other.total_rx = grouped.groups.other.total_rx + (iface.rx_bytes or 0)
          grouped.groups.other.total_tx = grouped.groups.other.total_tx + (iface.tx_bytes or 0)
          grouped.groups.other.total_rx_rate = grouped.groups.other.total_rx_rate + (iface.rx_rate or 0)
          grouped.groups.other.total_tx_rate = grouped.groups.other.total_tx_rate + (iface.tx_rate or 0)
        end
      end
    end
    for _, ap in _S.ipairs(grouped.groups.wireless.access_points) do
      if ap.tot then
        grouped.totals.wireless.raw_rx = (grouped.totals.wireless.raw_rx or 0) + (ap.tot.raw_rx or 0)
        grouped.totals.wireless.raw_tx = (grouped.totals.wireless.raw_tx or 0) + (ap.tot.raw_tx or 0)
      end
    end
    for _, bc in _S.ipairs(grouped.groups.bridge.clients) do
      if bc.tot then
        grouped.groups.bridge.total_rx = grouped.groups.bridge.total_rx + (bc.tot.raw_rx or 0)
        grouped.groups.bridge.total_tx = grouped.groups.bridge.total_tx + (bc.tot.raw_tx or 0)
      end
    end
    local final_grouped = {
      _version = grouped._version, _format = grouped._format,
      _runtime_s = grouped._runtime_s, _ts = grouped._ts,
      groups = {}, totals = apply_key_shortening(grouped.totals)
    }
    for group_name, group_data in _S.pairs(grouped.groups) do
      final_grouped.groups[group_name] = apply_key_shortening(group_data)
    end
    return final_grouped
  end

  return transform_to_grouped_structure(clients)
end
