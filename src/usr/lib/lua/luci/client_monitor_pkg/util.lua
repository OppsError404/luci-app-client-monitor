module("luci.client_monitor_pkg.util", package.seeall)

-- Use nixio for filesystem work so collection doesn't spawn shell processes.
local nixio = require "nixio"
local nfs   = nixio.fs

local io_open = io.open
local pcall = pcall
local tostring = tostring
local tonumber = tonumber

function exists(path)
  if not path then return false end
  return nfs.access(path) and true or false
end

function isdir(path)
  if not path then return false end
  local st = nfs.stat(path)
  return (st and st.type == "dir") and true or false
end

-- Return names without "." or "..", or nil if the directory can't be read.
function listdir(path)
  if not path then return nil end
  local ok, iter = pcall(nfs.dir, path)
  if not ok or not iter then return nil end
  local out, n = {}, 0
  local ok2 = pcall(function()
    for name in iter do
      if name ~= "." and name ~= ".." then n = n + 1; out[n] = name end
    end
  end)
  if not ok2 then return nil end
  return out
end

-- Expand the glob through nixio and return the matching paths.
function globlist(pattern)
  if not pattern then return {} end
  local ok, iter = pcall(nfs.glob, pattern)
  if not ok or not iter then return {} end
  local out, n = {}, 0
  pcall(function()
    for path in iter do n = n + 1; out[n] = path end
  end)
  return out
end

function mkdir_p(path, mode)
  if not path or path == "" then return false end
  if isdir(path) then return true end
  local acc = path:sub(1, 1) == "/" and "/" or ""
  for part in path:gmatch("[^/]+") do
    acc = (acc == "" or acc == "/") and (acc .. part) or (acc .. "/" .. part)
    if not isdir(acc) then nfs.mkdir(acc, mode) end
  end
  return isdir(path)
end

function readlink(path)
  if not path then return nil end
  local ok, target = pcall(nfs.readlink, path)
  if ok then return target end
  return nil
end

-- Return mtime, or nil for a missing path; callers use it to skip unchanged JSON.
function mtime(path)
  if not path then return nil end
  local st = nfs.stat(path)
  return st and st.mtime or nil
end

function unlink(path)
  if not path then return false end
  return pcall(nfs.unlink, path) and true or false
end

function resolve_bins()
  local b = {}
  b.bridge = exists("/usr/sbin/bridge") and "/usr/sbin/bridge"
          or (exists("/sbin/bridge")    and "/sbin/bridge"
          or (exists("/bin/bridge")     and "/bin/bridge" or "bridge"))
  b.ip = exists("/sbin/ip") and "/sbin/ip" or (exists("/bin/ip") and "/bin/ip" or "ip")
  b.ping = exists("/bin/ping") and "/bin/ping"
        or (exists("/usr/bin/ping") and "/usr/bin/ping" or "ping")
  return b
end

function readfile(path)
  if not path then return nil end
  local f = io_open(path, "r")
  if not f then return nil end
  local d = f:read("*a"); f:close(); return d
end

function sysfs_read(path)
  local v = readfile(path)
  if v and v:sub(-1) == "\n" then v = v:sub(1, -2) end
  return v
end

function sysfs_num(path)
  local v = sysfs_read(path)
  return v and tonumber(v) or nil
end

function atomic_write(path, content)
  if not path then return false end
  local tmp = path .. ".tmp." .. tostring(os.time()) .. "." .. tostring(math.random(100000, 999999))
  local f = io_open(tmp, "w+")
  if not f then return false end
  f:write(content)
  f:close()
  local ok = os.rename(tmp, path)
  if not ok then os.remove(tmp); return false end
  return true
end
