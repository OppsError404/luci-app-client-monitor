(() => {
'use strict';

// Settings and polling
const GRAPH_DURATION_SEC = 300;
const MOBILE_GRAPH_H     = 172;
const MOBILE_EXP_KEY     = 'client_monitor_mobile_expanded';
const PC_EXP_KEY         = 'client_monitor_pc_expanded';
const LS_INTERVAL_KEY    = 'client_monitor_auto_interval';
const LS_UNIT_KEY        = 'client_monitor_unit';
// Use one ID per tab. Its server-side interval request expires when polling stops.
const CM_CLIENT_ID = 'cm_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

// Wire keys, matching _key_map in collector.lua
const KEY_MAP = {
  os: 'operstate',
  ty: 'type',
  n: 'name',
  l: 'label',
  txr: 'tx_rate',
  txb: 'tx_bytes',
  rxr: 'rx_rate',
  rxb: 'rx_bytes',
  m: 'mac',
  hn: 'hostname',
  ip: 'ip',
  p: 'port',
  pl: 'port_label',
  mc: 'mac_count',
  dh: 'device_hints',
  bam: 'bridge_ap_mac',
  rrx: 'raw_rx',
  rtx: 'raw_tx',
  sp: 'signal_pct',
  cs: 'ctr_src',
  sc: 'sub_clients',
  trx: 'total_rx',
  ttx: 'total_tx',
  trxr: 'total_rx_rate',
  ttxr: 'total_tx_rate',
  ifs: 'interfaces',
  pts: 'ports',
  ap: 'access_points',
  c: 'clients',
  tot: 'totals',
  e: 'essid',
  k: 'key'
};

// Add long-key aliases without dropping the original short keys.
function normalizeKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => normalizeKeys(item));
  }
  
  const result = { ...obj };
  
  for (const key in result) {
    if (result[key] && typeof result[key] === 'object') {
      result[key] = normalizeKeys(result[key]);
    }
  }
  
  // Don't overwrite an explicit long-key value.
  for (const [shortKey, longKey] of Object.entries(KEY_MAP)) {
    if (shortKey in result && !(longKey in result)) {
      result[longKey] = normalizeKeys(result[shortKey]);
    }
  }
  
  // Keep aliases still used by older rendering paths.
  if ('pts' in result && !('ports' in result)) result.ports = result.pts;
  if ('ifs' in result && !('interfaces' in result)) result.interfaces = result.ifs;
  if ('tot' in result && !('totals' in result)) result.totals = result.tot;
  if ('ty' in result && !('type' in result)) result.type = result.ty;
  if ('ip' in result && !('i' in result)) result.i = result.ip;
  if ('p' in result && !('port' in result)) result.port = result.p;
  
  return result;
}

// Accept either key format while callers still use both.
function getKey(obj, key) {
  if (!obj) return undefined;
  
  if (key in obj) return obj[key];
  
  const longKey = KEY_MAP[key];
  if (longKey && longKey in obj) return obj[longKey];
  
  // Long-key callers may receive an unnormalized payload.
  for (const [short, long] of Object.entries(KEY_MAP)) {
    if (long === key && short in obj) return obj[short];
  }
  
  return undefined;
}

// MAC-only devices are treated as sub-APs rather than addressable clients.
function isMacOnlyClient(client) {
  if (!client) return false;
  const mac = getKey(client, 'mac') || getKey(client, 'm');
  const ip = getKey(client, 'ip');
  // Empty and unspecified addresses don't count as an IP.
  const ipStr = (ip || '').toString().trim();
  return !!mac && (!ipStr || ipStr === '*' || ipStr === '0.0.0.0' || ipStr === '::');
}

// Storage and event helpers
// Run now if possible; otherwise keep at most one delayed call.
function throttle(fn, limitMs) {
  let lastCall = 0;
  let timeoutId = null;
  
  return function(...args) {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    
    if (timeSinceLastCall >= limitMs) {
      lastCall = now;
      fn.apply(this, args);
    } else if (!timeoutId) {
      // Keep the first deferred call instead of adding another timer.
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        timeoutId = null;
        fn.apply(this, args);
      }, limitMs - timeSinceLastCall);
    }
  };
}

// Storage may be blocked or full; a failed save shouldn't break the UI.
function saveSetting(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (error) {
    console.warn('Failed to save setting to localStorage:', error);
  }
}

// Use the fallback if storage throws; a missing key still returns null.
function getSetting(key, defaultValue = null) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn('Failed to read setting from localStorage:', error);
    return defaultValue;
  }
}

// Shared view state
const allRenderers   = new Set();       // live graph renderers
const macIpToggle    = {};              // identity key -> 'ip' or 'mac'
let   prevSnapshot   = {};             // per-client rate baselines
let   lastSeenTs     = null;           // last server timestamp
let   ifaceRatesData = [];             // most recent interface data
let   selectedIface  = null;           // selected interface name
let   collectingRetryPending = false;  // only one warm-up retry timer
let   collectingRetryCount = 0;        // consecutive warm-up retries
const COLLECTING_MAX_RETRIES = 60;     // allow about 30 seconds for startup
let   dataRequestInFlight = null;       // share overlapping get_data calls
let   fetchInFlight = null;             // share overlapping render requests
const LS_IFACE_KEY   = 'crm_iface';   // remembered interface choice
const IFACE_BAND_KEY = '__iface__';    // key for the interface panel

// Refresh controls shared with the polling handler.
// Expanded cards are restored separately for each layout.
const NetworkMonitor = {};
window.NetworkMonitor = NetworkMonitor;
const mobileExpanded = (() => {
  try {
    const stored = getSetting(MOBILE_EXP_KEY);
    if (stored) {
      const arr = JSON.parse(stored);
      return new Set(Array.isArray(arr) ? arr : []);
    }
  } catch (error) {
    console.warn('Failed to parse mobile expanded state:', error);
  }
  return new Set();
})();

function saveMobileExpanded() {
  saveSetting(MOBILE_EXP_KEY, JSON.stringify([...mobileExpanded]));
}

const pcExpanded = (() => {
  try {
    const stored = getSetting(PC_EXP_KEY);
    if (stored) {
      const arr = JSON.parse(stored);
      return new Set(Array.isArray(arr) ? arr : []);
    }
  } catch (error) {
    console.warn('Failed to parse PC expanded state:', error);
  }
  return new Set();
})();

function savePcExpanded() {
  saveSetting(PC_EXP_KEY, JSON.stringify([...pcExpanded]));
}

// Client identity and formatting
const qs       = id  => document.getElementById(id);

// Labels come from clients and APs; escape them before using innerHTML.
const escapeHtml = s => String(s).replace(/[&<>"']/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// Match the CSS breakpoint, but always use the desktop layout in landscape.
const isMobile = () => {
  if (window.matchMedia('(orientation: landscape)').matches) {
    return false;
  }
  return window.innerWidth < 980;
};

function clientStableId(c, idx) {
  if (c.port && !c.is_bridge_client) {
    // Recreate a port card when its bridge status changes.
    const isBridge = c.device_hints?.includes('bridge');
    return 'lan:' + String(c.port).toLowerCase() + (isBridge ? ':bridge' : '');
  }
  if (c.is_bridge_client) {
    return 'brc:' + String((c.mac || c.ip || `idx_${idx}`).toLowerCase());
  }
  return String((c.mac || c.hostname || `idx_${idx}`).toLowerCase());
}

function mobileClientKey(c, idx) {
  return clientStableId(c, idx);
}

function isLanConnected(c) {
  // Physical ports remain visible even when they have no client identity.
  if (c.port && !c.is_bridge_client) return true;

  return !!(
    c.hostname?.trim() || c.ip?.trim() ||
    (c.rx_bytes && c.rx_bytes > 0) || (c.tx_bytes && c.tx_bytes > 0)
  );
}

function normalizeLanLabel(label, fallback = '') {
  const raw = label || fallback;
  const m = raw.match(/(\d+)$/);
  return m ? 'Port ' + m[1] : 'Port ' + raw;
}

function compareLanPorts(a, b) {
  const portNumber = c => {
    for (const value of [c.port_label, c.port]) {
      const match = String(value || '').match(/(\d+)(?!.*\d)/);
      if (match) return Number(match[1]);
    }
    return Number.MAX_SAFE_INTEGER;
  };

  const numberDiff = portNumber(a) - portNumber(b);
  if (numberDiff) return numberDiff;

  const aLabel = String(a.port_label || a.port || '').toLowerCase();
  const bLabel = String(b.port_label || b.port || '').toLowerCase();
  if (aLabel < bLabel) return -1;
  if (aLabel > bLabel) return 1;
  return String(a.port || '').localeCompare(String(b.port || ''));
}

function formatBytesShort(bytes) {
  if (bytes == null || bytes === '-') return '-';
  const b = Number(bytes) || 0;
  const a = Math.abs(b);
  if (a >= 1_073_741_824) return (b / 1_073_741_824).toFixed(2).replace(/\.00$/, '') + ' GB';
  if (a >= 1_048_576)     return (b / 1_048_576).toFixed(2).replace(/\.00$/, '') + ' MB';
  if (a >= 1_024)         return Math.round(b / 1_024) + ' KB';
  return b + ' B';
}

function fmtRate(v) {
  if (window._cm_unit === 'Mbps') {
    const mbps = v * 8 / 1e6;
    return mbps >= 1
      ? mbps.toFixed(2) + ' Mbps'
      : (v * 8 / 1000).toFixed(1) + ' Kbps';
  }
  return v >= 1_048_576
    ? (v / 1_048_576).toFixed(2) + ' MB/s'
    : (v / 1024).toFixed(1) + ' KB/s';
}

// Client traffic rates
// Reject counter jumps above 10 Gbit/s instead of adding spikes to the graph.
const MAX_PLAUSIBLE_RATE = 1.25e9;

function computeRate(c, key, nowTs, isDuplicate = false) {
  const prev = prevSnapshot[key];
  // A port can switch between physical and per-MAC nft counters.
  // Never calculate a delta across those unrelated totals.
  const src = c.ctr_src ?? null;
  if (!prev) {
    prevSnapshot[key] = { raw_rx: c.raw_rx, raw_tx: c.raw_tx, ts: nowTs, src };
    return { rxRateStr: fmtRate(0), txRateStr: fmtRate(0), rxRateNum: 0, txRateNum: 0 };
  }

  if (isDuplicate) {
    return {
      rxRateStr: prev._lastRxStr ?? fmtRate(0),
      txRateStr: prev._lastTxStr ?? fmtRate(0),
      rxRateNum: prev._lastRxNum ?? 0,
      txRateNum: prev._lastTxNum ?? 0,
    };
  }

  const dt = (nowTs - prev.ts) / 1000;
  if (dt <= 0) return { rxRateStr: fmtRate(0), txRateStr: fmtRate(0), rxRateNum: 0, txRateNum: 0 };

  // A new counter source needs a new baseline.
  if (prev.src !== src) {
    prevSnapshot[key] = {
      raw_rx: c.raw_rx, raw_tx: c.raw_tx, ts: nowTs, src,
      _lastRxStr: fmtRate(0), _lastTxStr: fmtRate(0), _lastRxNum: 0, _lastTxNum: 0,
    };
    return { rxRateStr: fmtRate(0), txRateStr: fmtRate(0), rxRateNum: 0, txRateNum: 0 };
  }

  let rxRateNum = Math.max(0, c.raw_rx - prev.raw_rx) / dt;
  let txRateNum = Math.max(0, c.raw_tx - prev.raw_tx) / dt;
  // Ignore invalid rates and large jumps caused by counter resets.
  if (!(rxRateNum >= 0) || rxRateNum > MAX_PLAUSIBLE_RATE) rxRateNum = 0;
  if (!(txRateNum >= 0) || txRateNum > MAX_PLAUSIBLE_RATE) txRateNum = 0;

  prevSnapshot[key] = {
    raw_rx: c.raw_rx, raw_tx: c.raw_tx, ts: nowTs, src,
    _lastRxStr: fmtRate(rxRateNum), _lastTxStr: fmtRate(txRateNum),
    _lastRxNum: rxRateNum,          _lastTxNum: txRateNum,
  };
  return { rxRateStr: fmtRate(rxRateNum), txRateStr: fmtRate(txRateNum), rxRateNum, txRateNum };
}

// Signal and rate icons
function renderWifiIcon(pct) {
  const dim = '#9aa4b2';
  let dotColor = dim, arc1Color = dim, arc2Color = dim;
  if (pct == null || pct < 1) {
    // No signal: leave the icon dimmed.
  } else if (pct < 33) {
    dotColor = '#e53935';
    arc1Color = dim;
    arc2Color = dim;
  } else if (pct < 66) {
    dotColor = '#fb8c00';
    arc1Color = '#fb8c00';
    arc2Color = dim;
  } else {
    dotColor = '#43a047';
    arc1Color = '#43a047';
    arc2Color = '#43a047';
  }
  return `<svg viewBox="0 0 16 16" width="14" height="14" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="13" r="1.2" fill="${dotColor}" stroke="none"/>
    <path d="M4 10 Q8 6.5 12 10" stroke="${arc1Color}" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path d="M1 7 Q8 2.0 15 7" stroke="${arc2Color}" stroke-width="1.3" stroke-linecap="round" fill="none"/>
  </svg>`;
}

const RX_ICON = `<span class="label-icon-left icon-small" aria-hidden="true">
  <svg viewBox="-2 -1 11 11" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 2v6M3.5 6.5 6 9l2.5-2.5" stroke="#1f8ef1" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg></span>`;

const TX_ICON = `<span class="label-icon-right icon-small" aria-hidden="true">
  <svg viewBox="2 0 11 11" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 10V4M8.5 5.5 6 3 3.5 5.5" stroke="#28a745" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg></span>`;


// Traffic graph renderer
function createGraphRenderer({ graphEl, canvas, thresholdBytes = 1024 }) {
  let samples = Math.round(GRAPH_DURATION_SEC / (window._cm_interval_sec || 2));
  let rxHist  = new Array(samples).fill(0);
  let txHist  = new Array(samples).fill(0);

  // Pointer interaction state
  let hoverIdx       = null;
  let pinnedVal      = null;  // selected sample follows the scrolling history
  let touchHideTimer = null;
  let lastTouchEnd   = 0;

  // Statistics since the last reset
  let atMaxRx = 0, atMaxTx = 0;
  let atSumRx = 0, atSumTx = 0, atCount = 0;

  function fmtTip(bytes) {
    if (window._cm_unit === 'Mbps') {
      const mbps = bytes * 8 / 1e6;
      if (mbps >= 1)  return mbps.toFixed(2) + ' Mbps';
      const kbps = bytes * 8 / 1000;
      return kbps >= 1 ? kbps.toFixed(1) + ' Kbps' : '0 Kbps';
    }
    const kb = bytes / 1024;
    if (kb >= 1024) return (kb / 1024).toFixed(2) + ' MB/s';
    if (kb >= 1)    return kb.toFixed(1) + ' KB/s';
    return '0 KB/s';
  }

  function getIdxFromX(clientX) {
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(frac * (rxHist.length - 1));
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);  ctx.arcTo(x + w, y,     x + w, y + r,     r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);  ctx.arcTo(x, y + h,     x, y + h - r,     r);
    ctx.lineTo(x, y + r);      ctx.arcTo(x, y,          x + r, y,         r);
    ctx.closePath();
  }

  // Pointer and touch handlers
  let _lastHoverT = 0;
  canvas.addEventListener('mousemove', e => {
    if (pinnedVal !== null) return;
    const now = performance.now();
    if (now - _lastHoverT < 33) return; // cap hover redraws at roughly 30 fps
    _lastHoverT = now;
    hoverIdx = getIdxFromX(e.clientX);
    markDirty();
  });
  canvas.addEventListener('mouseleave', () => { if (pinnedVal === null) { hoverIdx = null; markDirty(); } });

  canvas.addEventListener('click', e => {
    e.stopPropagation();
    if (Date.now() - lastTouchEnd < 500) return; // ignore the click synthesized after a touch
    if (pinnedVal !== null) {
      pinnedVal = null;
      hoverIdx  = getIdxFromX(e.clientX);
    } else {
      const i   = Math.max(0, Math.min(rxHist.length - 1, getIdxFromX(e.clientX)));
      pinnedVal = { rx: rxHist[i] || 0, tx: txHist[i] || 0, idx: i };
      hoverIdx  = null;
    }
    markDirty();
  });

  canvas.addEventListener('touchstart', e => {
    e.stopPropagation();
    clearTimeout(touchHideTimer);
    if (pinnedVal === null) { hoverIdx = getIdxFromX(e.touches[0].clientX); markDirty(); }
  }, { passive: true });

  canvas.addEventListener('touchmove', e => {
    e.stopPropagation();
    clearTimeout(touchHideTimer);
    if (pinnedVal === null) { hoverIdx = getIdxFromX(e.touches[0].clientX); markDirty(); }
  }, { passive: true });

  canvas.addEventListener('touchend', e => {
    e.stopPropagation();
    lastTouchEnd = Date.now();
    clearTimeout(touchHideTimer);
    if (pinnedVal !== null) {
      pinnedVal = null;
      touchHideTimer = setTimeout(() => { hoverIdx = null; markDirty(); }, 1200);
    } else if (hoverIdx !== null) {
      const i   = Math.max(0, Math.min(rxHist.length - 1, hoverIdx));
      pinnedVal = { rx: rxHist[i] || 0, tx: txHist[i] || 0, idx: i };
      hoverIdx  = null;
    }
    markDirty();
  });

  canvas.addEventListener('touchcancel', () => { hoverIdx = null; markDirty(); });

  // Keep the context and dimensions until the next resize.
  const _ctx = canvas.getContext('2d');
  let _dims = { innerW: 0, innerH: 0, topInset: 4, bottomInset: 4 };
  let _cachedPeak = 1;
  let _peakDirty = true;
  let _fadeAlpha = 1;
  let _fadeRaf   = null;

  function resizeCanvas() {
    const dpr   = window.devicePixelRatio || 1;
    const outer = graphEl.getBoundingClientRect();
    const cs    = getComputedStyle(graphEl);
    const padH  = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padV  = (parseFloat(cs.paddingTop)  || 0) + (parseFloat(cs.paddingBottom) || 0);
    const brdH  = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    const innerW = Math.max(60, Math.round(outer.width  - brdH - padH));
    const innerH = Math.max(90, Math.round(outer.height - padV));
    const needW  = Math.round(innerW * dpr);
    const needH  = Math.round(innerH * dpr);
    canvas.style.width  = innerW + 'px';
    canvas.style.height = innerH + 'px';
    if (canvas.width !== needW || canvas.height !== needH) {
      canvas.width  = needW;
      canvas.height = needH;
    }
    _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _dims = { innerW, innerH, topInset: 4, bottomInset: 4 };
    return _dims;
  }

  // Paint the graph.
  function draw() {
    if (!_ctx) return;
    _ctx.globalAlpha = _fadeAlpha;
    const { innerW, innerH, topInset, bottomInset } = _dims.innerW ? _dims : resizeCanvas();
    if (innerW <= 0 || innerH <= 0) return;
    _ctx.clearRect(0, 0, innerW, innerH);

    const usableH = Math.max(6, innerH - topInset - bottomInset);
    const len     = Math.max(1, rxHist.length);
    const step    = innerW / (len - 1);
    // Only rescan the histories after their data changes.
    if (_peakDirty) {
      let mx = 1;
      for (let i = 0; i < rxHist.length; i++) { if (rxHist[i] > mx) mx = rxHist[i]; if (txHist[i] > mx) mx = txHist[i]; }
      _cachedPeak = mx;
      _peakDirty = false;
    }
    const peak    = _cachedPeak;
    const v2y     = v => topInset + (1 - Math.min(1, Math.max(0, v / peak))) * usableH;
    const suppress = peak < 3072;
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const gridOpacity = isDark ? 0.20 : 0.07;

    // Rx/Tx legend
    _ctx.save();
    _ctx.font = 'bold 10px sans-serif';
    const rxW = _ctx.measureText('Rx').width;
    const txW = _ctx.measureText('Tx').width;
    _ctx.fillStyle = 'rgba(31,142,241,0.65)'; _ctx.fillText('Rx', innerW - txW - rxW - 10, topInset + 10);
    _ctx.fillStyle = 'rgba(40,167,69,0.65)';  _ctx.fillText('Tx', innerW - txW - 4,        topInset + 10);
    _ctx.restore();

    // Rate grid and labels
    _ctx.save();
    _ctx.strokeStyle = `rgba(0,0,0,${gridOpacity})`;
    _ctx.lineWidth   = 1;
    _ctx.font        = innerH > 48 ? '9px sans-serif' : '8px sans-serif';
    _ctx.fillStyle   = '#6b7280';
    _ctx.textAlign   = 'left';
    const seen = new Set();
    [peak, Math.round(peak * 2/3), Math.round(peak / 3)].forEach(tb => {
      const y  = v2y(tb);
      _ctx.beginPath(); _ctx.moveTo(0, y); _ctx.lineTo(innerW, y); _ctx.stroke();
      const lbl = window._cm_unit === 'Mbps'
        ? (() => { const mbps = tb * 8 / 1e6; return mbps >= 1 ? mbps.toFixed(2) + ' Mbps' : (tb * 8 / 1000).toFixed(1) + ' Kbps'; })()
        : (() => { const kb = Math.round(tb / 1024); return kb >= 1024 ? (kb/1024).toFixed(2) + ' MB/s' : kb + ' KB/s'; })();
      if (!seen.has(lbl)) {
        _ctx.fillText(lbl, 8, Math.min(innerH - 4, Math.max(topInset + 10, y + 12)));
        seen.add(lbl);
      }
    });
    _ctx.restore();

    // Time markers
    _ctx.save();
    _ctx.strokeStyle = `rgba(0,0,0,${gridOpacity})`;
    _ctx.lineWidth   = 1;
    _ctx.font        = '10px monospace';
    _ctx.fillStyle   = '#6b7280';
    _ctx.textAlign   = 'center';
    [300, 180, 60].forEach(sec => {
      const x   = sec === 300
        ? Math.max(6, innerW - (sec / GRAPH_DURATION_SEC) * innerW)
        : innerW - (sec / GRAPH_DURATION_SEC) * innerW;
      const top = topInset + usableH * 0.10;
      const bot = topInset + usableH * 0.80;
      _ctx.beginPath(); _ctx.moveTo(x, top); _ctx.lineTo(x, bot); _ctx.stroke();
      _ctx.fillText((sec / 60) + 'm', x, innerH - bottomInset - 3);
    });
    _ctx.restore();

    // Draw each series with a shaded area below it.
    function drawArea(data, stroke, fillRgb, fillAlpha) {
      _ctx.save();
      _ctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = i === len - 1 ? innerW : i * step;
        i === 0 ? _ctx.moveTo(x, v2y(data[i] || 0)) : _ctx.lineTo(x, v2y(data[i] || 0));
      }
      _ctx.strokeStyle = stroke;
      _ctx.lineWidth   = suppress ? 1 : 2;
      _ctx.stroke();
      _ctx.lineTo(innerW, topInset + usableH);
      _ctx.lineTo(0,      topInset + usableH);
      _ctx.closePath();
      _ctx.fillStyle = `rgba(${fillRgb},${suppress ? fillAlpha * 0.5 : fillAlpha})`;
      _ctx.fill();
      _ctx.restore();
    }

    drawArea(rxHist, 'rgba(31,142,241,1)', '31,142,241', 0.12);
    drawArea(txHist, 'rgba(40,167,69,1)',  '40,167,69',  0.10);

    function drawTooltip(px, rxV, txV, pinned) {
      const rxLbl = '↓ Rx: ' + fmtTip(rxV);
      const txLbl = '↑ Tx: ' + fmtTip(txV);
      _ctx.save();
      _ctx.font = '11px monospace';
      const tw  = Math.max(_ctx.measureText(rxLbl).width, _ctx.measureText(txLbl).width);
      const pH = 6, pV = 4, lH = 12;
      const bW = tw + pH * 2, bH = lH * 2 + pV * 2;
      let   bx = px + 10;
      if (bx + bW > innerW - 2) bx = px - bW - 10;
      bx = Math.max(2, bx);
      const by = topInset + 4;
      _ctx.beginPath();
      roundRect(_ctx, bx, by, bW, bH, 5);
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (isDark) {
        _ctx.fillStyle   = 'rgba(10,18,36,0.88)';
        _ctx.strokeStyle = pinned ? 'rgba(31,142,241,0.85)' : 'rgba(31,142,241,0.45)';
      } else {
        _ctx.fillStyle   = 'rgba(255,255,255,0.95)';
        _ctx.strokeStyle = pinned ? 'rgba(31,142,241,0.7)' : 'rgba(31,142,241,0.4)';
      }
      _ctx.fill();
      _ctx.lineWidth = pinned ? 1.5 : 1;
      _ctx.stroke();
      _ctx.textBaseline = 'middle';
      if (isDark) {
        _ctx.fillStyle = 'rgba(31,142,241,1)';
        _ctx.fillText(rxLbl, bx + pH, by + pV + lH / 2);
        _ctx.fillStyle = 'rgba(40,167,69,1)';
        _ctx.fillText(txLbl, bx + pH, by + pV + lH + lH / 2);
      } else {
        _ctx.fillStyle = 'rgba(26,115,232,1)';
        _ctx.fillText(rxLbl, bx + pH, by + pV + lH / 2);
        _ctx.fillStyle = 'rgba(30,135,60,1)';
        _ctx.fillText(txLbl, bx + pH, by + pV + lH + lH / 2);
      }
      _ctx.restore();
    }

    // Pinned sample
    if (pinnedVal !== null) {
      const pi  = Math.max(0, Math.min(len - 1, pinnedVal.idx));
      const px  = pi === len - 1 ? innerW : pi * step;
      const rxV = pinnedVal.rx;
      const txV = pinnedVal.tx;
      _ctx.save();
      _ctx.strokeStyle = 'rgba(200,200,220,0.5)';
      _ctx.lineWidth   = 1;
      _ctx.setLineDash([3, 2]);
      _ctx.beginPath(); _ctx.moveTo(px, topInset); _ctx.lineTo(px, topInset + usableH); _ctx.stroke();
      _ctx.restore();
      [[v2y(rxV), 'rgba(31,142,241,1)'], [v2y(txV), 'rgba(40,167,69,1)']].forEach(([y, col]) => {
        _ctx.save();
        _ctx.beginPath(); _ctx.arc(px, y, 5, 0, Math.PI * 2);
        _ctx.strokeStyle = col; _ctx.lineWidth = 1.5; _ctx.stroke();
        _ctx.beginPath(); _ctx.arc(px, y, 2.5, 0, Math.PI * 2);
        _ctx.fillStyle = col; _ctx.fill();
        _ctx.restore();
      });
      drawTooltip(px, rxV, txV, true);
    }

    // Hover marker
    if (hoverIdx !== null) {
      const i   = Math.max(0, Math.min(len - 1, hoverIdx));
      const hx  = i === len - 1 ? innerW : i * step;
      const rxV = rxHist[i] || 0;
      const txV = txHist[i] || 0;
      _ctx.save();
      _ctx.strokeStyle = 'rgba(180,180,180,0.40)';
      _ctx.lineWidth   = 1;
      _ctx.setLineDash([2, 2]);
      _ctx.beginPath(); _ctx.moveTo(hx, topInset); _ctx.lineTo(hx, topInset + usableH); _ctx.stroke();
      _ctx.restore();
      [[v2y(rxV), 'rgba(31,142,241,1)'], [v2y(txV), 'rgba(40,167,69,1)']].forEach(([y, col]) => {
        _ctx.save();
        _ctx.beginPath(); _ctx.arc(hx, y, 3, 0, Math.PI * 2);
        _ctx.fillStyle = col; _ctx.fill();
        _ctx.strokeStyle = 'rgba(255,255,255,0.7)'; _ctx.lineWidth = 1; _ctx.stroke();
        _ctx.restore();
      });
      drawTooltip(hx, rxV, txV, false);
    }
  }

  // Renderer lifecycle
  let rafId = null, ro = null, io = null, roRafId = null;
  let _dirty = false, _visible = true, _active = false;

  function markDirty() {
    if (_fadeRaf) return;  // the fade loop handles drawing
    if (!_dirty && _active && _visible && !document.hidden) {
      _dirty = true;
      rafId = requestAnimationFrame(() => { _dirty = false; draw(); rafId = null; });
    }
  }

  function start() {
    _active = true;
    if (!ro) {
      ro = new ResizeObserver(() => {
        // Resize on the next frame to avoid a ResizeObserver feedback loop.
        if (roRafId) return;
        roRafId = requestAnimationFrame(() => {
          roRafId = null;
          resizeCanvas();
          // A running fade draws directly; otherwise queue a redraw.
          if (_fadeRaf) draw(); else markDirty();
        });
      });
      ro.observe(graphEl);
    }
    if (!io) {
      io = new IntersectionObserver(entries => {
        _visible = entries[0].isIntersecting;
        if (_visible) markDirty();
      }, { threshold: 0.01 });
      io.observe(graphEl);
    }
    markDirty();
  }

  function stop() {
    _active = false;
    if (rafId)   { cancelAnimationFrame(rafId); rafId = null; }
    if (roRafId) { cancelAnimationFrame(roRafId); roRafId = null; }
    if (ro)    { try { ro.disconnect(); } catch { } ro = null; }
    if (io)    { try { io.disconnect(); } catch { } io = null; }
    clearTimeout(touchHideTimer);
    pinnedVal = null;
    hoverIdx  = null;
  }

  function pushSample(rxBytes, txBytes) {
    const sRx = Math.max(0, Math.round(rxBytes || 0));
    const sTx = Math.max(0, Math.round(txBytes || 0));
    _peakDirty = true;
    rxHist = rxHist.slice(1).concat(thresholdBytes > 0 && sRx < thresholdBytes ? 0 : sRx);
    txHist = txHist.slice(1).concat(thresholdBytes > 0 && sTx < thresholdBytes ? 0 : sTx);
    if (sRx > 0 || sTx > 0) {
      if (sRx > atMaxRx) atMaxRx = sRx;
      if (sTx > atMaxTx) atMaxTx = sTx;
      atSumRx += sRx; atSumTx += sTx; atCount++;
    }
    if (pinnedVal !== null) {
      pinnedVal.idx -= 1;
      if (pinnedVal.idx < 0) pinnedVal = null;
    }
    markDirty();
  }

  function resample(hist, oldLen, newLen) {
    if (oldLen === newLen) return hist.slice();
    if (oldLen === 0)      return new Array(newLen).fill(0);
    return Array.from({ length: newLen }, (_, ni) => {
      const t  = newLen === 1 ? 0 : ni / (newLen - 1);
      const oi = t * (oldLen - 1);
      const lo = Math.floor(oi);
      const hi = Math.min(oldLen - 1, lo + 1);
      return Math.round(hist[lo] * (1 - (oi - lo)) + hist[hi] * (oi - lo));
    });
  }

  function reconfigure() {
    const n = Math.round(GRAPH_DURATION_SEC / (window._cm_interval_sec || 2));
    if (n === samples) return;
    rxHist  = resample(rxHist, samples, n);
    txHist  = resample(txHist, samples, n);
    samples = n;
  }

  function getStats() {
    const rxAvg = atCount > 0 ? atSumRx / atCount : 0;
    const txAvg = atCount > 0 ? atSumTx / atCount : 0;
    return { rxMax: atMaxRx, txMax: atMaxTx, rxAvg, txAvg };
  }

  function reset() {
    rxHist  = new Array(samples).fill(0);
    txHist  = new Array(samples).fill(0);
    atMaxRx = 0; atMaxTx = 0;
    atSumRx = 0; atSumTx = 0; atCount = 0;
    _cachedPeak = 1; _peakDirty = false;
    pinnedVal = null; hoverIdx = null;
    markDirty();
  }

  function pause()  { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } _dirty = false; }
  function resume() { if (_active) markDirty(); }

  let _fadeGen = 0; // invalidates callbacks from earlier fades

  function fadeIn(dur = 320) {
    const gen = ++_fadeGen;
    if (_fadeRaf && _fadeRaf !== 1) cancelAnimationFrame(_fadeRaf);
    _fadeAlpha = 0;
    _fadeRaf = 1;    // block normal redraws before scheduling the fade
    resizeCanvas();  // size the canvas before the first frame
    draw();          // start transparent
    const t0 = performance.now();
    _fadeRaf = requestAnimationFrame(function tick() {
      if (gen !== _fadeGen) return; // a newer fade took over
      const p = Math.min(1, (performance.now() - t0) / dur);
      _fadeAlpha = p * p * (3 - 2 * p);
      draw();
      _fadeRaf = p < 1 ? requestAnimationFrame(tick) : null;
      // Normal redraws resume when the fade finishes.
    });
  }

  function fadeOut(dur = 200, onDone) {
    const gen = ++_fadeGen;
    if (_fadeRaf && _fadeRaf !== 1) cancelAnimationFrame(_fadeRaf);
    _fadeRaf = 1;
    const startAlpha = _fadeAlpha;
    const t0 = performance.now();
    _fadeRaf = requestAnimationFrame(function tick() {
      if (gen !== _fadeGen) return;
      const p = Math.min(1, (performance.now() - t0) / dur);
      _fadeAlpha = startAlpha * (1 - p * p * (3 - 2 * p));
      draw();
      if (p < 1) {
        _fadeRaf = requestAnimationFrame(tick);
      } else {
        _fadeAlpha = 0;
        draw();
        // Keep later resize redraws transparent while the card collapses.
        // fadeIn restores visibility when the card opens again.
        _fadeRaf = null;
        if (onDone) onDone();
      }
    });
  }

  return { pushSample, start, stop, pause, resume, draw, reconfigure, getStats, reset,
           fadeIn, fadeOut,
           getSeries: () => ({ rx: rxHist.slice(), tx: txHist.slice() }) };
}

// Devices behind a bridge
function buildSubClients(sub_clients, excludeMac) {
  if (!sub_clients || !sub_clients.length) return null;
  const own = (excludeMac || '').toLowerCase();

  // Exclude the bridge itself, duplicate MACs and MAC-only sub-APs.
  const seen = new Set();
  const list = [];
  sub_clients.forEach(sc => {
    const mac = getKey(sc, 'mac') || getKey(sc, 'm');
    const m = (mac || '').toLowerCase();
    const ip = getKey(sc, 'ip');
    
    // Require a usable IP before showing the device in this list.
    const hasValidIp = ip !== undefined && ip !== null && ip.toString().trim() !== '';
    if (m && m !== own && !seen.has(m) && !isMacOnlyClient(sc) && hasValidIp) {
      seen.add(m);
      list.push(sc);
    }
  });

  if (!list.length) return null;
  const wrap = document.createElement('div'); wrap.className = 'sub-clients';
  const hdr  = document.createElement('div'); hdr.className  = 'sub-clients-header';
  hdr.textContent = `${list.length} device${list.length !== 1 ? 's' : ''} behind bridge`;
  wrap.appendChild(hdr);
  list.forEach(sc => {
    const row  = document.createElement('div'); row.className = 'sub-client-row';
    const dot  = document.createElement('div'); dot.className  = 'sub-client-dot';
    const host = document.createElement('div'); host.className = 'sub-client-host';
    
    const hostname = getKey(sc, 'hostname') || getKey(sc, 'hn');
    const ip = getKey(sc, 'ip');
    const mac = getKey(sc, 'mac') || getKey(sc, 'm');
    
    host.textContent = hostname || ip || mac;
    host.title = hostname || '';
    
    // Share the IP/MAC choice across rows for this device.
    const ipmac = document.createElement('div');
    ipmac.className = 'sub-client-ipmac';
    const toggleKey = (mac || ip || '').toLowerCase();
    ipmac.textContent = (macIpToggle[toggleKey] || 'ip') === 'ip' ? (ip || '—') : (mac || '').toLowerCase();
    ipmac.addEventListener('click', e => {
      e.stopPropagation();
      macIpToggle[toggleKey] = (macIpToggle[toggleKey] || 'ip') === 'ip' ? 'mac' : 'ip';
      ipmac.textContent = macIpToggle[toggleKey] === 'ip' ? (ip || '—') : (mac || '').toLowerCase();
    });
    row.appendChild(dot); row.appendChild(host);
    row.appendChild(ipmac);
    wrap.appendChild(row);
  });
  return wrap.children.length > 1 ? wrap : null;
}

// Device hints
const HINT_META = {
  bridge:     { label: '⇄ Bridge / AP',     cls: 'hint-badge-bridge',     title: 'Multiple devices detected on this port — bridge, AP, or switch' },
  subap:      { label: '⎇ Sub‑AP',          cls: 'hint-badge-subap',      title: 'Sub‑access point detected (MAC‑only client without IP)' },
  router_oui: { label: '⊕ Router (vendor)', cls: 'hint-badge-router_oui', title: 'MAC address belongs to a known router/AP manufacturer' },
  gateway:    { label: '⊕ NAT Router',      cls: 'hint-badge-gateway',    title: 'This device is an active gateway in the routing table — likely running NAT' },
  eth_issue:  { label: '⚠ Ethernet Issue',  cls: 'hint-badge-eth_issue',  title: 'No MAC or IP detected and link speed ≤ 10 Mbps — cable fault, port disabled, or 10Base-T negotiation failure' },
};
function buildHintBadges(hints) {
  if (!hints || !hints.length) return null;
  const show = hints.includes('gateway') ? hints.filter(h => h !== 'router_oui') : hints;
  const wrap = document.createElement('div'); wrap.className = 'hint-badges';
  show.forEach(h => {
    const m = HINT_META[h]; if (!m) return;
    const b = document.createElement('span');
    b.className = 'hint-badge ' + m.cls;
    b.textContent = m.label;
    b.title = m.title;
    wrap.appendChild(b);
  });
  return wrap.children.length ? wrap : null;
}

// Desktop client cards
function createDesktopClient(c, isLan, clientId, cardCls) {
  const wrapper    = document.createElement('div');
  wrapper.className    = 'client-wrapper';
  wrapper.dataset.clientId = clientId;

  const row = document.createElement('div');
  row.className = 'client' + (cardCls ? ' ' + cardCls : '');
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-expanded', 'false');

  // Identity and link details
  const left    = document.createElement('div'); left.className = 'left-stack';
  const hostTop = document.createElement('div'); hostTop.className = 'host-top';
  const isBridge = c.device_hints?.includes('bridge');

  if (isBridge) {
    const hintBadgesEl = buildHintBadges(c.device_hints);
    
    if (hintBadgesEl) {
      hostTop.appendChild(hintBadgesEl);
    }

    const hostname = document.createElement('div'); hostname.className = 'hostname';
    const hnRaw = c.hostname?.trim() || "";
    const isRedundant = (hnRaw === "" || hnRaw === c.port || hnRaw === c.port_label);
    const hn = isRedundant ? "" : hnRaw;
    hostname.textContent = hn;
    if (hn === 'N/A') hostname.title = 'Hostname not available';

    const identityWrap = document.createElement('div'); identityWrap.className = 'bridge-identity-wrap';
    // Use the bridge/AP address here, not a sub-client's identity.
    const mac = document.createElement('div'); mac.className = 'mac';
    const toggleKey = (c.bridge_ap_mac || c.mac || '').toLowerCase() || (c.port || clientId);
    const displayIp = c.bridge_ap_ip || c.ip;
    mac.textContent = (macIpToggle[toggleKey] || 'ip') === 'ip' ? (displayIp || 'No IP') : (c.bridge_ap_mac || c.mac || '').toLowerCase();
    mac.addEventListener('click', e => {
      e.stopPropagation();
      macIpToggle[toggleKey] = (macIpToggle[toggleKey] || 'ip') === 'ip' ? 'mac' : 'ip';
      const newDisplayIp = c.bridge_ap_ip || c.ip;
      mac.textContent = macIpToggle[toggleKey] === 'ip' ? (newDisplayIp || 'No IP') : (c.bridge_ap_mac || c.mac || '').toLowerCase();
    });
    identityWrap.appendChild(mac);

    hostTop.appendChild(hostname); hostTop.appendChild(identityWrap);
    left.appendChild(hostTop);

    const lbl = document.createElement('div'); lbl.className = 'lan-port-label-pc';
    lbl.textContent = normalizeLanLabel(c.port_label || c.port || clientId);
    left.appendChild(lbl);
  } else {
    const isEthIssue = c.device_hints?.includes('eth_issue');
    const hostname = document.createElement('div'); hostname.className = 'hostname';
    if (isEthIssue) {
      hostname.textContent = '';
    } else {
      const hn = c.hostname?.trim() || (isLan ? (c.port || 'LAN') : 'N/A');
      hostname.textContent = hn;
      if (hn === 'N/A') hostname.title = 'Hostname not available';
    }
    const mac = document.createElement('div'); mac.className = 'mac';
    if (isEthIssue) {
      mac.innerHTML = '<span style="display:inline-block;padding:2px 8px;border-radius:4px;border:1px solid rgba(239,68,68,0.35);background:rgba(239,68,68,0.07);color:rgba(239,68,68,0.70);font-weight:700;font-size: 11px;letter-spacing:0.01em;">⚠ Issue</span>';
      mac.style.cssText = 'pointer-events:none;';
      const desc = document.createElement('div');
      desc.dataset.role = 'eth-desc';
      desc.textContent = 'RJ45 Failure / Client Port Disabled';
      desc.style.cssText = 'color:rgba(239,68,68,0.50);font-size: 10px;margin-top:3px;';
      hostTop.appendChild(hostname); hostTop.appendChild(mac); hostTop.appendChild(desc);
    } else {
      const toggleKey = (c.mac?.toLowerCase()) || (c.port || clientId);
      mac.textContent = (macIpToggle[toggleKey] || 'ip') === 'ip' ? (c.ip || 'No IP') : (c.mac || '').toLowerCase();
      mac.addEventListener('click', e => {
        e.stopPropagation();
        macIpToggle[toggleKey] = (macIpToggle[toggleKey] || 'ip') === 'ip' ? 'mac' : 'ip';
        mac.textContent = macIpToggle[toggleKey] === 'ip' ? (c.ip || 'No IP') : (c.mac || '').toLowerCase();
      });
      hostTop.appendChild(hostname); hostTop.appendChild(mac);
      const hintBadgesEl = buildHintBadges(c.device_hints);
      if (hintBadgesEl) hostTop.appendChild(hintBadgesEl);
    }
    left.appendChild(hostTop);
    if (isLan || c.is_bridge_client) {
      if (!c.is_bridge_client) {
        const lbl = document.createElement('div'); lbl.className = 'lan-port-label-pc';
        lbl.textContent = normalizeLanLabel(c.port_label || c.port || clientId);
        left.appendChild(lbl);
      }
    } else {
      const sigBottom = document.createElement('div'); sigBottom.className = 'signal-bottom';
      const pct       = c.signal_pct || c.signal || 0;
      const wifiIcon  = document.createElement('span'); wifiIcon.className = 'wifi-icon-pc cl_signal'; wifiIcon.innerHTML = renderWifiIcon(pct);
      const sigText   = document.createElement('span'); sigText.className  = 'signal-text-pc'; sigText.textContent = pct ? pct + '%' : '';
      sigBottom.appendChild(wifiIcon); sigBottom.appendChild(sigText);
      left.appendChild(sigBottom);
    }
  }
  row.appendChild(left);
  const hn = isBridge ? 'Bridge / AP' : (c.hostname?.trim() || (isLan ? (c.port || 'LAN') : 'N/A'));

  // Live rates and session stats
  const ratesWrap = document.createElement('div'); ratesWrap.className = 'rates-wrapper';
  const ratesDiv  = document.createElement('div'); ratesDiv.className  = 'rates';
  const nowTs     = Date.now();
  const rateVals  = computeRate(c, clientId, nowTs, false);

  const initRxStr = rateVals.rxRateStr;
  const initTxStr = rateVals.txRateStr;

  const rxCell  = document.createElement('div'); rxCell.className = 'rx';
  const rxNum   = document.createElement('div'); rxNum.className = 'rate-number'; rxNum.textContent = initRxStr;
  const rxLabel = document.createElement('div'); rxLabel.className = 'rate-label'; rxLabel.innerHTML = `${RX_ICON}<span>Rx</span>`;
  rxCell.appendChild(rxNum); rxCell.appendChild(rxLabel);

  const txCell  = document.createElement('div'); txCell.className = 'tx';
  const txNum   = document.createElement('div'); txNum.className = 'rate-number'; txNum.textContent = initTxStr;
  const txLabel = document.createElement('div'); txLabel.className = 'rate-label'; txLabel.innerHTML = `<span>Tx</span>${TX_ICON}`;
  txCell.appendChild(txNum); txCell.appendChild(txLabel);

  ratesDiv.appendChild(rxCell); ratesDiv.appendChild(txCell);

  const statsRow = document.createElement('div'); statsRow.className = 'rate-stats-row';
  const rxStats  = document.createElement('span'); rxStats.className = 'rx-stats rate-stats';
  rxStats.textContent = `Avg: ${fmtRate(0)}\nMax: ${fmtRate(0)}`;
  const txStats  = document.createElement('span'); txStats.className = 'tx-stats rate-stats';
  txStats.textContent = `Avg: ${fmtRate(0)}\nMax: ${fmtRate(0)}`;
  statsRow.appendChild(rxStats); statsRow.appendChild(txStats);

  ratesWrap.appendChild(ratesDiv); ratesWrap.appendChild(statsRow);
  row.appendChild(ratesWrap);

  // Traffic history
  const graphWrap = document.createElement('div'); graphWrap.className = 'graph';
  graphWrap.setAttribute('role', 'img'); graphWrap.setAttribute('aria-label', `${hn} traffic graph`);
  const canvas = document.createElement('canvas'); canvas.className = 'graph-canvas';
  graphWrap.appendChild(canvas);
  row.appendChild(graphWrap);

  // Totals and bridge devices, shown when expanded
  const totals      = document.createElement('div'); totals.className = 'pc-totals';
  const totalsInner = document.createElement('div'); totalsInner.className = 'inner';
  const totalsRow   = document.createElement('div'); totalsRow.dataset.role = 'totals-row';
  totalsRow.innerHTML = `Rx Total: ${escapeHtml(c.rx_str || formatBytesShort(c.raw_rx || c.rx_bytes || c.rx || 0))} &nbsp;&nbsp; Tx Total: ${escapeHtml(c.tx_str || formatBytesShort(c.raw_tx || c.tx_bytes || c.tx || 0))}`;
  totalsInner.appendChild(totalsRow);
  if (isBridge) {
    const apMac = (c.bridge_ap_mac || c.mac || '').toLowerCase();
    const subEl = buildSubClients(c.sub_clients, apMac);
    if (subEl) {
      subEl.dataset.role = 'sub-clients';
      totalsInner.appendChild(subEl);
      totalsInner.dataset.hasSubClients = 'true';
    }
  }
  totals.appendChild(totalsInner);

  row.appendChild(totals); wrapper.appendChild(row);

  // Repaint text after hover transforms to avoid lingering blur.
  (function fixBlurryText() {
    const originalTransform = row.style.transform;
    
    row.addEventListener('mouseleave', function handleMouseLeave() {
      // Nudge the compositing layer, then restore its usual hint.
      const originalWillChange = row.style.willChange;
      row.style.willChange = 'opacity';
      
      requestAnimationFrame(() => {
        // Flush layout before restoring will-change.
        void row.offsetHeight;
        
        row.style.willChange = originalWillChange;
        
        // Flush once more after the original hint is restored.
        requestAnimationFrame(() => {
          void row.offsetHeight;
        });
      });
    });
    
    // Touch interactions need the same repaint workaround.
    row.addEventListener('touchstart', function handleTouchStart() {
      row.style.webkitFontSmoothing = 'subpixel-antialiased';
      row.style.mozOsxFontSmoothing = 'auto';
    });
    
    row.addEventListener('touchend', function handleTouchEnd() {
      // Leave the smoothing override in place until the next frame.
      requestAnimationFrame(() => {
        row.style.webkitFontSmoothing = '';
        row.style.mozOsxFontSmoothing = '';
        void row.offsetHeight;
      });
    });
  })();

  // Graph lifecycle
  const renderer = createGraphRenderer({ graphEl: graphWrap, canvas, thresholdBytes: isLan ? 3072 : 1024 });
  renderer.start();
  wrapper._renderer = renderer;
  allRenderers.add(renderer);

  // Card expansion
  function setOpen(open) {
    if (open) {
      const totalsH = totalsInner.scrollHeight;
      void row.offsetHeight;
      totals.classList.add('open');
      row.classList.add('graph-open');
      totals.style.height = totalsH + 'px';
      pcExpanded.add(clientId);
      row.setAttribute('aria-expanded', 'true');
      totals.addEventListener('transitionend', (e) => {
        if (e.propertyName === 'height' && totals.classList.contains('open')) {
          totals.style.height = 'auto';
        }
      }, { once: true });
    } else {
      totals.style.height = totals.offsetHeight + 'px';
      void row.offsetHeight;
      totals.style.height = '0px';
      totals.classList.remove('open');
      row.classList.remove('graph-open');
      pcExpanded.delete(clientId);
      row.setAttribute('aria-expanded', 'false');
    }
    savePcExpanded();
  }

  row.addEventListener('click', () => setOpen(!totals.classList.contains('open')));
  row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!totals.classList.contains('open')); } });

  const wasOpen = pcExpanded.has(clientId);
  totals.style.transition = 'none';
  if (wasOpen) {
    totals.classList.add('open');
    totals.style.height = 'auto';
    row.classList.add('graph-open');
    row.setAttribute('aria-expanded', 'true');
  } else {
    totals.style.height = '0px';
  }
  void row.offsetHeight;
  requestAnimationFrame(() => { totals.style.transition = ''; });

  wrapper._parts = { totals, totalsInner };

  wrapper._cleanup = () => {
    try { renderer.stop(); allRenderers.delete(renderer); } catch { }
  };

  return wrapper;
}

// Refresh desktop cards in place.
function updateDesktopCard(wrapper, c, isLan, id, isDuplicate) {
  const hostnameEl = wrapper.querySelector('.hostname');
  if (hostnameEl) {
    const isBridgeU   = c.device_hints?.includes('bridge');
    const isEthIssueU = c.device_hints?.includes('eth_issue');
    if (isEthIssueU) {
      hostnameEl.textContent = '';
      hostnameEl.style.cssText = '';
      const hostTopEl2 = wrapper.querySelector('.host-top');
      if (hostTopEl2) {
        const macEl2 = hostTopEl2.querySelector('.mac');
        if (macEl2 && !macEl2.querySelector('span')) {
          macEl2.innerHTML = '<span style="display:inline-block;padding:2px 8px;border-radius:4px;border:1px solid rgba(239,68,68,0.35);background:rgba(239,68,68,0.07);color:rgba(239,68,68,0.70);font-weight:700;font-size: 11px;letter-spacing:0.01em;">⚠ Issue</span>';
          macEl2.style.cssText = 'pointer-events:none;';
        }
        if (!hostTopEl2.querySelector('[data-role="eth-desc"]')) {
          const desc = document.createElement('div');
          desc.dataset.role = 'eth-desc';
          desc.textContent = 'RJ45 Failure / Client Port Disabled';
          desc.style.cssText = 'color:rgba(239,68,68,0.50);font-size: 10px;margin-top:3px;';
          hostTopEl2.appendChild(desc);
        }
      }
    } else {
      const hnRaw = c.hostname?.trim() || "";
      const isRedundant = (hnRaw === "" || hnRaw === c.port || hnRaw === c.port_label);
      const hn = (isBridgeU && isRedundant) ? "" : (hnRaw || (isLan ? (c.port_label || c.port || 'LAN') : 'N/A'));
      hostnameEl.textContent = hn;
      hostnameEl.style.cssText = '';
      hostnameEl.title = hostnameEl.textContent === 'N/A' ? 'Hostname not available' : '';
    }
  }
  const hostTopEl = wrapper.querySelector('.host-top');
  if (hostTopEl && !c.device_hints?.includes('eth_issue')) {
    hostTopEl.querySelector('.hint-badges')?.remove();
    const nb = buildHintBadges(c.device_hints);
    
    if (nb) {
      hostTopEl.prepend(nb);
    }
  }
  // Bridge status is part of the card ID. Update its identity and devices
  // in place; non-bridge totals are handled below.
  const totalsInnerEl = wrapper.querySelector('.pc-totals .inner');
  if (totalsInnerEl && c.device_hints?.includes('bridge')) {
    const rxT = c.rx_str || formatBytesShort(c.raw_rx || c.rx_bytes || c.rx || 0);
    const txT = c.tx_str || formatBytesShort(c.raw_tx || c.tx_bytes || c.tx || 0);
    // Replace the totals row instead of appending a second one.
    totalsInnerEl.querySelectorAll('[data-role="totals-row"]').forEach(el => el.remove());
    const totalsDiv = document.createElement('div');
    totalsDiv.dataset.role = 'totals-row';
    totalsDiv.innerHTML = `Rx Total: ${escapeHtml(rxT)} &nbsp;&nbsp; Tx Total: ${escapeHtml(txT)}`;
    totalsInnerEl.prepend(totalsDiv);
    const iw = wrapper.querySelector('.bridge-identity-wrap');
    if (iw) {
      iw.innerHTML = '';
      const mac = document.createElement('div'); mac.className = 'mac';
      const toggleKey = (c.bridge_ap_mac || c.mac || '').toLowerCase() || (c.port || id);
      const displayIp = c.bridge_ap_ip || c.ip;
      mac.textContent = (macIpToggle[toggleKey] || 'ip') === 'ip' ? (displayIp || 'No IP') : (c.bridge_ap_mac || c.mac || '').toLowerCase();
      mac.addEventListener('click', e => {
        e.stopPropagation();
        macIpToggle[toggleKey] = (macIpToggle[toggleKey] || 'ip') === 'ip' ? 'mac' : 'ip';
        const newDisplayIp = c.bridge_ap_ip || c.ip;
        mac.textContent = macIpToggle[toggleKey] === 'ip' ? (newDisplayIp || 'No IP') : (c.bridge_ap_mac || c.mac || '').toLowerCase();
      });
      iw.appendChild(mac);
    }
    totalsInnerEl.querySelector('[data-role="sub-clients"]')?.remove();
    const apMac2 = (c.bridge_ap_mac || c.mac || '').toLowerCase();
    const subEl = buildSubClients(c.sub_clients, apMac2);
    if (subEl) { subEl.dataset.role = 'sub-clients'; totalsInnerEl.appendChild(subEl); }
  }
  if (!c.device_hints?.includes('eth_issue')) {
    const isBridgeUpd = c.device_hints?.includes('bridge');
    if (!isBridgeUpd) {
      const macEl = wrapper.querySelector('.mac');
      if (macEl) {
        const tk = c.mac?.toLowerCase() || (c.port || id);
        macEl.textContent = (macIpToggle[tk] || 'ip') === 'ip' ? (c.ip || 'No IP') : (c.mac || '').toLowerCase();
      }
    }
  }

  const nowTs = Date.now();
  const rates = computeRate(c, id, nowTs, isDuplicate);
  const rxStr = rates.rxRateStr;
  const txStr = rates.txRateStr;
  const rxNum = rates.rxRateNum;
  const txNum = rates.txRateNum;

  if (!isDuplicate) {
    const rxNumEl = wrapper.querySelector('.rx .rate-number');
    const txNumEl = wrapper.querySelector('.tx .rate-number');
    if (rxNumEl) rxNumEl.textContent = rxStr;
    if (txNumEl) txNumEl.textContent = txStr;

    const renderer = wrapper._renderer;
    if (renderer) {
      renderer.pushSample(rxNum, txNum);
      renderer.draw();
      const st = renderer.getStats();
      const rxStEl = wrapper.querySelector('.rate-stats-row .rx-stats');
      const txStEl = wrapper.querySelector('.rate-stats-row .tx-stats');
      if (rxStEl) rxStEl.textContent = `Avg: ${fmtRate(st.rxAvg)}\nMax: ${fmtRate(st.rxMax)}`;
      if (txStEl) txStEl.textContent = `Avg: ${fmtRate(st.txAvg)}\nMax: ${fmtRate(st.txMax)}`;
    }
  }

  if (!c.is_bridge_client) {
    const pct      = c.signal_pct || c.signal || 0;
    const wifiIcon = wrapper.querySelector('.wifi-icon-pc');
    const sigText  = wrapper.querySelector('.signal-text-pc');
    if (wifiIcon) wifiIcon.innerHTML = renderWifiIcon(pct);
    if (sigText)  sigText.textContent = pct ? pct + '%' : '';
  }

  const rxT = c.rx_str || formatBytesShort(c.raw_rx || c.rx_bytes || c.rx || 0);
  const txT = c.tx_str || formatBytesShort(c.raw_tx || c.tx_bytes || c.tx || 0);
  if (!c.device_hints?.includes('bridge')) {
    const totalsInnerUpd = wrapper.querySelector('.pc-totals .inner');
    if (totalsInnerUpd) totalsInnerUpd.innerHTML = `<div data-role="totals-row">Rx Total: ${escapeHtml(rxT)} &nbsp;&nbsp; Tx Total: ${escapeHtml(txT)}</div>`;
  }
  const totalsEl = wrapper.querySelector('.pc-totals');
  if (totalsEl?.classList.contains('open')) totalsEl.style.height = 'auto';

  const graphEl = wrapper.querySelector('.graph');
  if (graphEl && hostnameEl) graphEl.setAttribute('aria-label', `${hostnameEl.textContent} traffic graph`);
}

// Reconcile desktop band cards without rebuilding their graphs.
function renderDesktopBand(containerEl, clients, isLan, isDuplicate, cardCls) {
  containerEl.querySelector('.empty')?.remove();

  const newOrder  = [];
  const clientMap = new Map();
  (clients || []).forEach((c, i) => {
    const id = clientStableId(c, i);
    newOrder.push(id);
    clientMap.set(id, c);
  });

  const existing = new Map();
  Array.from(containerEl.children).forEach(node => {
    if (node.classList.contains('client-wrapper') && node.dataset.clientId) {
      existing.set(node.dataset.clientId, node);
    }
  });

  existing.forEach((node, id) => {
    if (!clientMap.has(id)) {
      try {
        node._cleanup?.();
      } catch (error) {
        console.error('Cleanup failed for node:', error);
      }
      try {
        node.remove();
      } catch (error) {
        console.error('Failed to remove node:', error);
      }
      existing.delete(id);
    }
  });

  newOrder.forEach((id, idx) => {
    const c = clientMap.get(id);
    let node = existing.get(id);
    if (!node) {
      node = createDesktopClient(c, isLan, id, cardCls);
      existing.set(id, node);
      containerEl.appendChild(node);
    } else {
      try { updateDesktopCard(node, c, isLan, id, isDuplicate); } catch (e) { console.error(e); }
    }
    const desired = containerEl.children[idx];
    // Moving a correctly placed card would restart its CSS transitions.
    if (node !== desired) containerEl.insertBefore(node, desired || null);
  });

  if (!clients?.length) {
    containerEl.innerHTML = '';
    containerEl.appendChild(makeEmpty(isLan));
  }
}

// Mobile client cards
function createMobileCard(c, isLan, idx, cardCls) {
  const key  = mobileClientKey(c, idx);
  const card = document.createElement('div');
  card.className = 'client' + (cardCls ? ' ' + cardCls : '');
  card.dataset.key = key;
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-expanded', 'false');

  const topDot   = document.createElement('div'); topDot.className = 'top-dot';
  const wifiIcon = document.createElement('div'); wifiIcon.className = 'wifi-icon-mobile cl_signal';
  const pct      = c.signal_pct || c.signal || 0;
  if (!isLan && !c.is_bridge_client) wifiIcon.innerHTML = renderWifiIcon(pct);
  const sigText  = document.createElement('div'); sigText.className = 'signal-text';
  sigText.textContent = (isLan || c.is_bridge_client) ? '' : (pct ? pct + '%' : '');
  topDot.appendChild(wifiIcon); topDot.appendChild(sigText);
  if (!c.is_bridge_client) card.appendChild(topDot);

  const top  = document.createElement('div'); top.className = 'client-top';
  const isBridgeM = c.device_hints?.includes('bridge');

  if (isBridgeM) {
    const mobileHintBadges = buildHintBadges(c.device_hints);
    
    if (mobileHintBadges) {
      top.appendChild(mobileHintBadges);
    }
    const host = document.createElement('div'); host.className = 'host-name-mobile';
    const hnRaw = c.hostname?.trim() || "";
    const isRedundant = (hnRaw === "" || hnRaw === c.port || hnRaw === c.port_label);
    const hn = isRedundant ? "" : hnRaw;
    host.textContent = hn;
    if (hn === 'N/A') host.title = 'Hostname not available';

    const identityWrap = document.createElement('div'); identityWrap.className = 'bridge-identity-wrap-mobile';
    const mac = document.createElement('div'); mac.className = 'host-mac-mobile';
    const toggleKey = (c.bridge_ap_mac || c.mac || '').toLowerCase() || (c.port || key);
    const displayIp = c.bridge_ap_ip || c.ip;
    mac.textContent = (macIpToggle[toggleKey] || 'ip') === 'ip' ? (displayIp || 'No IP') : (c.bridge_ap_mac || c.mac || '').toLowerCase();
    mac.addEventListener('click', e => {
      e.stopPropagation();
      macIpToggle[toggleKey] = (macIpToggle[toggleKey] || 'ip') === 'ip' ? 'mac' : 'ip';
      const newDisplayIp = c.bridge_ap_ip || c.ip;
      mac.textContent = macIpToggle[toggleKey] === 'ip' ? (newDisplayIp || 'No IP') : (c.bridge_ap_mac || c.mac || '').toLowerCase();
    });
    identityWrap.appendChild(mac);

    top.appendChild(host); top.appendChild(identityWrap);
    card.appendChild(top);
    card._bridgeHost = host;

    const bridgePortLbl = document.createElement('div'); bridgePortLbl.className = 'lan-port-label';
    bridgePortLbl.textContent = normalizeLanLabel(c.port || String(idx));
    card.appendChild(bridgePortLbl);
  } else {
    const isEthIssueM = c.device_hints?.includes('eth_issue');
    const host = document.createElement('div'); host.className = 'host-name-mobile';
    if (isEthIssueM) {
      host.textContent = '';
    } else {
      host.textContent = c.hostname?.trim() || (isLan ? (c.port || 'LAN') : 'N/A');
      if (host.textContent === 'N/A') host.title = 'Hostname not available';
    }
    const toggleKey = c.mac?.toLowerCase() || (c.port || key);
    const mac = document.createElement('div'); mac.className = 'host-mac-mobile';
    if (isEthIssueM) {
      mac.innerHTML = '<span style="display:inline-block;padding:2px 8px;border-radius:4px;border:1px solid rgba(239,68,68,0.35);background:rgba(239,68,68,0.07);color:rgba(239,68,68,0.70);font-weight:700;font-size: 11px;letter-spacing:0.01em;">⚠ Issue</span>';
      mac.style.cssText = 'pointer-events:none;';
      const desc = document.createElement('div');
      desc.dataset.role = 'eth-desc';
      desc.textContent = 'RJ45 Failure / Client Port Disabled';
      desc.style.cssText = 'color:rgba(239,68,68,0.50);font-size: 10px;margin-top:3px;';
      top.appendChild(host); top.appendChild(mac); top.appendChild(desc);
    } else {
      mac.textContent = (macIpToggle[toggleKey] || 'ip') === 'ip' ? (c.ip || 'No IP') : (c.mac || '').toLowerCase();
      mac.addEventListener('click', e => {
        e.stopPropagation();
        macIpToggle[toggleKey] = (macIpToggle[toggleKey] || 'ip') === 'ip' ? 'mac' : 'ip';
        mac.textContent = macIpToggle[toggleKey] === 'ip' ? (c.ip || 'No IP') : (c.mac || '').toLowerCase();
      });
      top.appendChild(host); top.appendChild(mac);
      const mobileHintBadges = buildHintBadges(c.device_hints);
      if (mobileHintBadges) top.appendChild(mobileHintBadges);
    }
    card.appendChild(top);
  }

  if (isLan && !isBridgeM) {
    const lbl = document.createElement('div'); lbl.className = 'lan-port-label';
    lbl.textContent = normalizeLanLabel(c.port || String(idx));
    card.appendChild(lbl);
  }

  const bottom   = document.createElement('div'); bottom.className = 'client-bottom';
  const ratesDiv = document.createElement('div'); ratesDiv.className = 'rates';
  const rateVals = computeRate(c, key, Date.now(), false);
  const initRxStr = rateVals.rxRateStr;
  const initTxStr = rateVals.txRateStr;

  const rx     = document.createElement('div');    rx.className = 'rate rx-rate-mobile';
  const rxNum  = document.createElement('strong'); rxNum.textContent = initRxStr;
  const rxLbl  = document.createElement('small');  rxLbl.innerHTML = `${RX_ICON.replace('viewBox="-2 -1 11 11"', 'viewBox="0 0 12 12"')}<span>Rx</span>`;
  rx.appendChild(rxNum); rx.appendChild(rxLbl);

  const tx     = document.createElement('div');    tx.className = 'rate tx-rate-mobile';
  const txNum  = document.createElement('strong'); txNum.textContent = initTxStr;
  const txLbl  = document.createElement('small');  txLbl.innerHTML = `<span>Tx</span>${TX_ICON.replace('viewBox="2 0 11 11"', 'viewBox="0 0 12 12"')}`;
  tx.appendChild(txNum); tx.appendChild(txLbl);

  ratesDiv.appendChild(rx); ratesDiv.appendChild(tx);

  const statsRow = document.createElement('div'); statsRow.className = 'rate-stats-row';
  const rxStats  = document.createElement('span'); rxStats.className = 'rx-stats rate-stats';
  rxStats.textContent = `Avg: ${fmtRate(0)}\nMax: ${fmtRate(0)}`;
  const txStats  = document.createElement('span'); txStats.className = 'tx-stats rate-stats';
  txStats.textContent = `Avg: ${fmtRate(0)}\nMax: ${fmtRate(0)}`;
  statsRow.appendChild(rxStats); statsRow.appendChild(txStats);

  bottom.appendChild(ratesDiv); bottom.appendChild(statsRow); card.appendChild(bottom);

  const graphWrap = document.createElement('div'); graphWrap.className = 'graph-mobile';
  const canvas    = document.createElement('canvas'); canvas.className = 'graph-canvas-mobile';
  graphWrap.appendChild(canvas);
  card.appendChild(graphWrap);

  const totals      = document.createElement('div'); totals.className = 'totals';
  const totalsInner = document.createElement('div'); totalsInner.className = 'totals-inner';
  if (isBridgeM) {
    const own = (c.bridge_ap_mac || c.mac || '').toLowerCase();
    const totalsRow = document.createElement('div');
    totalsRow.dataset.role = 'totals-row';
    totalsRow.textContent = `Rx: ${c.rx_str || formatBytesShort(c.raw_rx || c.rx_bytes || c.rx || 0)} / Tx: ${c.tx_str || formatBytesShort(c.raw_tx || c.tx_bytes || c.tx || 0)}`;
    totalsInner.appendChild(totalsRow);
    const subEl = buildSubClients(c.sub_clients, own);
    if (subEl) {
      subEl.dataset.role = 'sub-clients';
      totalsInner.appendChild(subEl);
      totalsInner.dataset.hasSubClients = 'true';
    } else {
      const none = document.createElement('div');
      none.className = 'sub-clients-header';
      none.textContent = 'No devices detected behind bridge';
      none.dataset.role = 'sub-clients';
      totalsInner.appendChild(none);
      totalsInner.dataset.hasSubClients = 'true';
    }
  } else {
    totalsInner.textContent = `Rx: ${c.rx_str || formatBytesShort(c.raw_rx || c.rx_bytes || c.rx || 0)} / Tx: ${c.tx_str || formatBytesShort(c.raw_tx || c.tx_bytes || c.tx || 0)}`;
  }
  totals.appendChild(totalsInner); card.appendChild(totals);

  const renderer = createGraphRenderer({ graphEl: graphWrap, canvas, thresholdBytes: isLan ? 3072 : 1024 });
  renderer.start();
  card._renderer = renderer;
  allRenderers.add(renderer);
  card._cleanup = () => {
    try { renderer.stop(); allRenderers.delete(renderer); } catch { }
  };

  function setOpen(open) {
    if (open) {
      const totalsH = totalsInner.scrollHeight;
      void card.offsetHeight;
      totals.classList.add('open');
      graphWrap.classList.add('open');
      card.classList.add('graph-open');
      totals.style.height    = totalsH + 'px';
      graphWrap.style.height = MOBILE_GRAPH_H + 'px';
      renderer.fadeIn(320);
      mobileExpanded.add(key);
      card.setAttribute('aria-expanded', 'true');
      totals.addEventListener('transitionend', (e) => {
        if (e.propertyName === 'height' && totals.classList.contains('open'))
          totals.style.height = 'auto';
      }, { once: true });
    } else {
      mobileExpanded.delete(key);
      totals.style.height = totals.offsetHeight + 'px';
      void card.offsetHeight;
      totals.style.height    = '0px';
      graphWrap.style.height = '0px';
      totals.classList.remove('open');
      graphWrap.classList.remove('open');
      card.classList.remove('graph-open');
      card.setAttribute('aria-expanded', 'false');
      renderer.fadeOut(200);
    }
    saveMobileExpanded();
  }

  card.addEventListener('click', () => setOpen(!totals.classList.contains('open')));
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!totals.classList.contains('open')); }
  });

  const wasOpen = mobileExpanded.has(key);
  totals.style.transition    = 'none';
  graphWrap.style.transition = 'none';
  if (wasOpen) {
    totals.classList.add('open');    totals.style.height    = 'auto';
    graphWrap.classList.add('open'); graphWrap.style.height = MOBILE_GRAPH_H + 'px';
    card.classList.add('graph-open');
    card.setAttribute('aria-expanded', 'true');
    renderer.draw();
  } else {
    totals.style.height    = '0px';
    graphWrap.style.height = '0px';
  }
  void card.offsetHeight;
  requestAnimationFrame(() => {
    totals.style.transition    = '';
    graphWrap.style.transition = '';
  });

  const rxStatEl = statsRow.querySelector('.rx-stats');
  const txStatEl = statsRow.querySelector('.tx-stats');
  card._parts = isBridgeM
    ? { host: card._bridgeHost, mac: null, rxNum, txNum, rxStat: rxStatEl, txStat: txStatEl, totals, totalsInner, wifiIcon, sigText, graphWrap }
    : { host: card.querySelector('.host-name-mobile'), mac: card.querySelector('.host-mac-mobile'), rxNum, txNum, rxStat: rxStatEl, txStat: txStatEl, totals, totalsInner, wifiIcon, sigText, graphWrap };

  // Apply the same post-hover repaint workaround to mobile cards.
  (function fixMobileBlurryText() {
    card.addEventListener('mouseleave', function handleMouseLeave() {
      // Reset the compositing hint before repainting the resting card.
      const originalWillChange = card.style.willChange;
      card.style.willChange = 'opacity';
      
      requestAnimationFrame(() => {
        void card.offsetHeight;
        card.style.willChange = originalWillChange;
        
        requestAnimationFrame(() => {
          void card.offsetHeight;
        });
      });
    });
    
    // Temporarily adjust smoothing while the card is touched.
    card.addEventListener('touchstart', function handleTouchStart() {
      card.style.webkitFontSmoothing = 'subpixel-antialiased';
      card.style.mozOsxFontSmoothing = 'auto';
    });
    
    card.addEventListener('touchend', function handleTouchEnd() {
      requestAnimationFrame(() => {
        card.style.webkitFontSmoothing = '';
        card.style.mozOsxFontSmoothing = '';
        void card.offsetHeight;
      });
    });
  })();

  return card;
}

// Reconcile mobile cards while keeping their graph history.
function renderMobileList(containerEl, clients, isLan, isDuplicate, cardCls) {
  containerEl.querySelector('.empty')?.remove();

  const existing = new Map();
  Array.from(containerEl.children).forEach(node => {
    if (node.classList.contains('client') && node.dataset.key) existing.set(node.dataset.key, node);
  });

  const order      = [];
  const dataByKey  = new Map();
  (clients || []).forEach((c, i) => {
    const k = mobileClientKey(c, i);
    order.push(k);
    dataByKey.set(k, { c, idx: i });
  });

  existing.forEach((node, k) => {
    if (!dataByKey.has(k)) {
      try { node._cleanup?.(); } catch (e) { console.error('Cleanup failed for mobile card:', e); }
      node.remove();
      existing.delete(k);
    }
  });

  let cursor = containerEl.firstChild;
  order.forEach(key => {
    const { c, idx } = dataByKey.get(key);
    const isLanEntry = !c.is_bridge_client && !!(c.port || c.interface?.toLowerCase().includes('lan'));
    let card = existing.get(key);

    if (!card) {
      card = createMobileCard(c, isLanEntry, idx, cardCls);
      existing.set(key, card);
      containerEl.insertBefore(card, cursor || null);
    } else {
      const p = card._parts;
      if (p) {
        if (c.device_hints?.includes('bridge')) {
          const iw = card.querySelector('.bridge-identity-wrap-mobile');
          if (iw) {
            iw.innerHTML = '';
            const mac = document.createElement('div'); mac.className = 'host-mac-mobile';
            const toggleKey = (c.bridge_ap_mac || c.mac || '').toLowerCase() || (c.port || key);
            const displayIp = c.bridge_ap_ip || c.ip;
            mac.textContent = (macIpToggle[toggleKey] || 'ip') === 'ip' ? (displayIp || 'No IP') : (c.bridge_ap_mac || c.mac || '').toLowerCase();
            mac.addEventListener('click', e => {
              e.stopPropagation();
              macIpToggle[toggleKey] = (macIpToggle[toggleKey] || 'ip') === 'ip' ? 'mac' : 'ip';
              const newDisplayIp = c.bridge_ap_ip || c.ip;
              mac.textContent = macIpToggle[toggleKey] === 'ip' ? (newDisplayIp || 'No IP') : (c.bridge_ap_mac || c.mac || '').toLowerCase();
            });
            iw.appendChild(mac);
          }
          const mTotalsInner = card.querySelector('.totals-inner');
          if (mTotalsInner) {
            // Replace totals before rebuilding the device list.
            mTotalsInner.querySelectorAll('[data-role="totals-row"]').forEach(el => el.remove());
            const totalsRow = document.createElement('div');
            totalsRow.dataset.role = 'totals-row';
            totalsRow.textContent = `Rx: ${c.rx_str || formatBytesShort(c.raw_rx || c.rx_bytes || c.rx || 0)} / Tx: ${c.tx_str || formatBytesShort(c.raw_tx || c.tx_bytes || c.tx || 0)}`;
            mTotalsInner.prepend(totalsRow);
            mTotalsInner.querySelector('[data-role="sub-clients"]')?.remove();
            const own2 = (c.bridge_ap_mac || c.mac || '').toLowerCase();
            const subEl = buildSubClients(c.sub_clients, own2);
            if (subEl) {
              subEl.dataset.role = 'sub-clients';
              mTotalsInner.appendChild(subEl);
            } else {
              const none = document.createElement('div');
              none.className = 'sub-clients-header';
              none.textContent = 'No devices detected behind bridge';
              none.dataset.role = 'sub-clients';
              mTotalsInner.appendChild(none);
            }
          }
        } else {
          const isEthIssueUpd = c.device_hints?.includes('eth_issue');
          if (isEthIssueUpd) {
            p.host.textContent = '';
            p.host.style.cssText = '';
            if (p.mac && !p.mac.querySelector('span')) {
              p.mac.innerHTML = '<span style="display:inline-block;padding:2px 8px;border-radius:4px;border:1px solid rgba(239,68,68,0.35);background:rgba(239,68,68,0.07);color:rgba(239,68,68,0.70);font-weight:700;font-size: 11px;letter-spacing:0.01em;">⚠ Issue</span>';
              p.mac.style.cssText = 'pointer-events:none;';
            }
            const mTop2 = card.querySelector('.client-top');
            if (mTop2 && !mTop2.querySelector('[data-role="eth-desc"]')) {
              const desc = document.createElement('div');
              desc.dataset.role = 'eth-desc';
              desc.textContent = 'RJ45 Failure / Client Port Disabled';
              desc.style.cssText = 'color:rgba(239,68,68,0.50);font-size: 10px;margin-top:3px;';
              mTop2.appendChild(desc);
            }
          } else {
            p.host.textContent = c.hostname?.trim() || (isLanEntry ? (c.port || 'LAN') : 'N/A');
            p.host.style.cssText = '';
            p.host.title = p.host.textContent === 'N/A' ? 'Hostname not available' : '';
          }
        }

        const mTop = card.querySelector('.client-top');
        if (mTop && !c.device_hints?.includes('eth_issue')) {
          mTop.querySelector('.hint-badges')?.remove();
          const nb = buildHintBadges(c.device_hints);
          
          if (nb) {
            if (c.device_hints?.includes('bridge')) mTop.prepend(nb);
            else mTop.appendChild(nb);
          }
        }

        if (p.mac && !c.device_hints?.includes('eth_issue')) {
          const tk = c.mac?.toLowerCase() || (c.port || key);
          p.mac.textContent = (macIpToggle[tk] || 'ip') === 'ip' ? (c.ip || 'No IP') : (c.mac || '').toLowerCase();
        }

        const rates  = computeRate(c, key, Date.now(), isDuplicate);
        const rxStr  = rates.rxRateStr;
        const txStr  = rates.txRateStr;
        const rxBytN = rates.rxRateNum;
        const txBytN = rates.txRateNum;

        if (!isDuplicate) {
          p.rxNum.textContent = rxStr;
          p.txNum.textContent = txStr;
          const renderer = card._renderer;
          if (renderer) {
            renderer.pushSample(rxBytN, txBytN);
            renderer.draw();
            const st = renderer.getStats();
            if (p.rxStat) p.rxStat.textContent = `Avg: ${fmtRate(st.rxAvg)}\nMax: ${fmtRate(st.rxMax)}`;
            if (p.txStat) p.txStat.textContent = `Avg: ${fmtRate(st.txAvg)}\nMax: ${fmtRate(st.txMax)}`;
          }
        }
        if (!c.device_hints?.includes('bridge')) p.totalsInner.textContent = `Rx: ${c.rx_str || formatBytesShort(c.raw_rx || c.rx_bytes || c.rx || 0)} / Tx: ${c.tx_str || formatBytesShort(c.raw_tx || c.tx_bytes || c.tx || 0)}`;

        const pct = c.signal_pct || c.signal || 0;
        if (isLanEntry || c.is_bridge_client) {
          if (p.wifiIcon) p.wifiIcon.style.display = 'none';
          p.sigText.textContent = '';
        } else {
          if (p.wifiIcon) { p.wifiIcon.style.display = ''; p.wifiIcon.innerHTML = renderWifiIcon(pct); }
          p.sigText.textContent = pct ? pct + '%' : '';
        }

        if (p.totals.classList.contains('open')) p.totals.style.height = 'auto';
      }
      // Leave correctly placed cards alone; moving them would restart
      // hover transitions on every poll.
      if (card !== cursor && card.nextSibling !== cursor) containerEl.insertBefore(card, cursor || null);
    }
    cursor = card.nextSibling;
  });

  if (!clients?.length) {
    containerEl.innerHTML = '';
    containerEl.appendChild(makeEmpty(isLan));
  }
}

// Band titles
function buildBandTitle(key, isLan) {
  if (isLan) return `<span class="band-title-wrap"><span class="lan-title-badge">LAN Ports</span></span>`;
  if (key === '__iface__') return `<span class="band-title-wrap"><span class="iface-title-badge">Interface Rates</span></span>`;

  const bm = key.match(/^Bridge AP \((.+)\)$/);
  if (bm) {
    const portLabel = bm[1].replace(/^LAN\s+(\d+)$/i, 'Port $1');
    return `<span class="band-title-wrap">
      <span class="hint-badge hint-badge-bridge" style="font-size: 16px;padding:2px 8px;background: transparent;">⇄ Bridge / AP</span>
      <span class="port-badge">${escapeHtml(portLabel)}</span>
    </span>`;
  }

  const m = key.match(/^\((.+),\s*(.+)\)$/);
  if (!m) return `<span class="band-title-wrap"><span class="ssid-badge ssid-badge-5">${escapeHtml(key)}</span></span>`;

  const ssid = m[1].trim();
  const band = m[2].trim();
  const freqMap = { '2.4_Ghz': ['2.4 GHz', 'freq-badge-24', 'ssid-badge-24'], '5_Ghz': ['5 GHz', 'freq-badge-5', 'ssid-badge-5'], '6_Ghz': ['6 GHz', 'freq-badge-6', 'ssid-badge-6'] };
  const [label, freqCls, ssidCls] = freqMap[band] || [band, 'freq-badge-24', 'ssid-badge-24'];

  return `<span class="band-title-wrap">
    <span class="ap-name-group">
      <span class="ssid-badge ${ssidCls}">${escapeHtml(ssid)}</span>
    </span>
    <span class="freq-group">
      <span class="freq-badge ${freqCls}">${escapeHtml(label)}</span>
    </span>
  </span>`;
}

// Empty panels and totals
function makeEmpty(isLan) {
  const el    = document.createElement('div');
  el.className = 'empty';
  const wrap  = document.createElement('div'); wrap.className = 'empty-pulse';
  const ring  = document.createElement('div'); ring.className = 'empty-pulse-ring';
  const dot   = document.createElement('div'); dot.className  = 'empty-pulse-dot';
  ring.appendChild(dot);
  const texts = document.createElement('div'); texts.className = 'empty-pulse-texts';
  const title = document.createElement('div'); title.className = 'empty-pulse-title';
  const sub   = document.createElement('div'); sub.className   = 'empty-pulse-sub';
  title.textContent = isLan ? 'No active ports'       : 'Waiting for clients…';
  sub.textContent   = isLan ? 'No wired devices detected on LAN ports' : 'No devices are currently connected to this band';
  texts.appendChild(title); texts.appendChild(sub);
  wrap.appendChild(ring); wrap.appendChild(texts);
  el.appendChild(wrap);
  return el;
}

function setPanelTotalText(safeKey, totalsObj) {
  const rx = totalsObj?.rx_str  || formatBytesShort(totalsObj?.raw_rx  || totalsObj?.rx_bytes  || totalsObj?.rx_total  || totalsObj?.rx  || 0);
  const tx = totalsObj?.tx_str  || formatBytesShort(totalsObj?.raw_tx  || totalsObj?.tx_bytes  || totalsObj?.tx_total  || totalsObj?.tx  || 0);
  const mob = qs('foot_' + safeKey + '_total');
  const pc  = qs('pc_total_' + safeKey);
  if (mob) mob.textContent = `Total Rx/Tx: ${rx} / ${tx}`;
  if (pc)  pc.textContent  = `Total: ${rx} / ${tx}`;
}

function moveEmptyPanelsToBottom() {
  function reorder(containerEl, order) {
    if (!containerEl || !order) return;
    const active = [], empty = [];
    order.forEach(id => {
      const el = qs(id); if (!el) return;
      const n  = parseInt(el.querySelector('.panel-count span')?.textContent || '0', 10) || 0;
      if (n > 0) { el.classList.remove('empty-panel'); active.push(el); }
      else        { el.classList.add('empty-panel');   empty.push(el);  }
    });
    [...active, ...empty].forEach((el, i) => {
      const cur = containerEl.children[i];
      if (el !== cur) containerEl.insertBefore(el, cur || null);
    });
  }
  reorder(qs('mobile_grid'), window._cm_panel_order);
  reorder(qs('pc_bands'),    window._cm_band_order);
}

// Band and panel rendering
function bandKeyToCls(key, isLan) {
  if (isLan) return 'band-lan';
  if (key === '__iface__') return 'band-iface';
  if (/^Bridge AP \(/.test(key)) return 'bridge-ap-band';
  const m = key.match(/^\((.+),\s*(.+)\)$/);
  if (!m) return 'band-5';
  const band = m[2].trim();
  if (band === '2.4_Ghz') return 'band-24';
  if (band === '6_Ghz')   return 'band-6';
  return 'band-5';
}

function bandToCardCls(bandCls) {
  const map = { 'band-lan': 'card-lan', 'band-24': 'card-24', 'band-5': 'card-5', 'band-6': 'card-6', 'bridge-ap-band': 'card-bridge', 'band-iface': 'card-iface' };
  return map[bandCls] || '';
}

function efficientRender(key, clients, isLan, totals, isDuplicate) {
  const safeKey  = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  const mobile   = isMobile();

  if (isLan) clients = (clients || []).filter(isLanConnected).sort(compareLanPorts);

  const panelId  = `panel_${safeKey}`;
  const listId   = `list_${safeKey}`;
  const countId  = `count_${safeKey}`;
  const pcBandId = `pc_band_${safeKey}`;
  const pcCntId  = `pc_count_${safeKey}`;
  const pcTotId  = `pc_total_${safeKey}`;
  const footId   = `foot_${safeKey}_total`;
  const bandCls  = bandKeyToCls(key, isLan);

  if (mobile) {
    if (!qs(panelId)) {
      const section = document.createElement('section');
      section.className = 'mobile-panel' + (bandCls ? ' ' + bandCls : ''); section.id = panelId; section.dataset.panel = key;
      section.innerHTML = `
        <div class="panel-head">
          <div class="panel-title">${buildBandTitle(key, isLan)}</div>
          <div class="panel-count"><span id="${countId}">0</span></div>
        </div>
        <div class="list" id="${listId}" aria-hidden="false"></div>
        <div class="panel-foot">
          <div class="total-text" id="${footId}">Total Rx/Tx: — / —</div>
        </div>`;
      qs('mobile_grid').appendChild(section);
      (window._cm_panel_order = window._cm_panel_order || []).push(panelId);
    }
  } else {
    if (!qs(pcBandId)) {
      const band = document.createElement('div');
      band.className = 'band' + (bandCls ? ' ' + bandCls : ''); band.id = pcBandId; band.dataset.band = key;
      band.innerHTML = `
        <div class="band-head">
          <h3 class="band-title">${buildBandTitle(key, isLan)}</h3>
          <div class="panel-count"><span id="${pcCntId}">0</span></div>
        </div>
        <div class="band-inner" id="${pcBandId}_inner"></div>
        <div class="panel-foot">
          <div class="total-text" id="${pcTotId}">Total Rx/Tx: — / —</div>
        </div>`;
      qs('pc_bands').appendChild(band);
      (window._cm_band_order = window._cm_band_order || []).push(pcBandId);
    }
  }

  const listEl  = qs(listId);
  const pcInner = qs(pcBandId + '_inner');
  const cardCls = bandToCardCls(bandCls);
  if (mobile  && listEl)  renderMobileList(listEl,   clients || [], isLan, isDuplicate, cardCls);
  if (!mobile && pcInner) renderDesktopBand(pcInner, clients || [], isLan, isDuplicate, cardCls);

  if (qs(countId)) qs(countId).textContent = Array.isArray(clients) ? clients.length : 0;
  if (qs(pcCntId)) qs(pcCntId).textContent = Array.isArray(clients) ? clients.length : 0;

  setPanelTotalText(safeKey, totals || {});
}

// Interface rate cards
function fmtIfaceRate(bps) {
  if (window._cm_unit === 'Mbps') {
    const mbps = bps * 8 / 1e6;
    return mbps >= 1 ? mbps.toFixed(2) + ' Mbps' : (bps * 8 / 1000).toFixed(1) + ' Kbps';
  }
  if (bps >= 1048576) return (bps / 1048576).toFixed(2) + ' MB/s';
  if (bps >= 1024)    return (bps / 1024).toFixed(1)    + ' KB/s';
  return Math.round(bps) + ' B/s';
}

function formatIfaceLabel(label) {
  // Style the trailing parenthesized suffix, except for smart totals.
  const match = label.match(/^(.+?)\s*(\([^)]+\))$/);
  if (match) {
    const [_, namePart, parenPart] = match;
    if (parenPart.toLowerCase().includes('smart')) {
      return document.createTextNode(label);
    }
    // Build with text nodes because interface labels are untrusted.
    const span = document.createElement('span');
    span.appendChild(document.createTextNode(namePart + ' '));
    const freq = document.createElement('span');
    freq.className = 'freq-part';
    freq.textContent = parenPart;
    span.appendChild(freq);
    return span;
  }
  return document.createTextNode(label);
}

function populateIfacePanel(panel, ifaces) {
  const desired = ifaces.map(i => i.name + '|' + i.operstate + '|' + (i.label || '') + '|' + (i.is_smart ? '1' : '0')).join(',');
  if (panel.dataset.ifaceKey === desired) {
    panel.querySelectorAll('.opt').forEach(b =>
      b.classList.toggle('selected', b.dataset.iface === selectedIface));
    return;
  }
  panel.dataset.ifaceKey = desired;
  panel.innerHTML = '';
  ifaces.forEach(iface => {
    // Older payloads use flags instead of a type field.
    const type = iface.type ||
                 (iface.is_wan ? 'wan' :
                  iface.is_ap ? 'ap' :
                  iface.is_lan_port ? 'lan_port' :
                  iface.is_other ? 'other' :
                  iface.is_wifi_combined ? 'wifi_combined' :
                  iface.is_smart ? 'smart' :
                  iface.is_ap_clients ? 'ap_clients' :
                  iface.is_bridge ? 'bridge' : 'unknown');
    
    // AP traffic is already shown in the wireless cards.
    if (type === 'ap' || type === 'ap_clients') {
      return;
    }
    
    const isCombined = type === 'wifi_combined' || type === 'lan_port' || type === 'smart' || iface.is_wifi_clients_combined;
    const isSmart    = type === 'smart';
    
    const btn = document.createElement('button');
    btn.className = 'opt'
      + (isCombined ? ' opt-combined' : '')
      + (isSmart    ? ' opt-smart'    : '')
      + (iface.name === selectedIface ? ' selected' : '');
    btn.type = 'button';
    btn.setAttribute('role', 'option');
    btn.dataset.iface = iface.name;
    btn.dataset.ifaceType = type;
    
    const labelContent = formatIfaceLabel(iface.label || iface.name);
    if (labelContent.nodeType === Node.TEXT_NODE) {
      btn.appendChild(labelContent);
    } else {
      btn.appendChild(labelContent);
    }
    
    panel.appendChild(btn);
  });
}

const _ifaceWired = {};
const _ifaceRetryCount = {};
function wireIfaceMiniOnce(suffix, retryCount = 0) {
  if (_ifaceWired[suffix]) return;
  _ifaceWired[suffix] = true;
  const mini    = document.getElementById('ifaceMini_'    + suffix);
  const trigger = document.getElementById('ifaceTrigger_' + suffix);
  const panel   = document.getElementById('ifacePanel_'   + suffix);
  if (!mini || !trigger || !panel) {
    _ifaceWired[suffix] = false;
    // Retry briefly if the card hasn't been attached yet.
    if (retryCount < 5) {
      _ifaceRetryCount[suffix] = (retryCount || 0) + 1;
      setTimeout(() => wireIfaceMiniOnce(suffix, retryCount + 1), 100);
    } else {
      console.warn('wireIfaceMiniOnce: elements not found after 5 retries for suffix', suffix);
    }
    return;
  }
  _ifaceRetryCount[suffix] = 0;

  function closePanel() {
    mini.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    // Move focus out before the panel becomes aria-hidden.
    if (panel.contains(document.activeElement)) {
      trigger.focus();
    }
    panel.setAttribute('aria-hidden', 'true');
    trigger.classList.remove('glow');
    panel.style.maxHeight = '';
  }

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const open = mini.classList.toggle('open');
    trigger.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
    trigger.classList.toggle('glow', open);
    if (open) {
      const band = trigger.closest('.band') || trigger.closest('.mobile-panel');
      const card = trigger.closest('.client');
      // Account for the current hover offset so the list stays inside the band.
      let translateY = 0;
      if (card) {
        const m = new DOMMatrix(window.getComputedStyle(card).transform);
        translateY = Math.abs(m.m42);
      }
      const available = band
        ? band.getBoundingClientRect().bottom - trigger.getBoundingClientRect().bottom - 8 - translateY
        : 200;
      panel.style.maxHeight = Math.max(available, 48) + 'px';
    } else {
      // Return focus to the trigger when the list closes.
      if (panel.contains(document.activeElement)) {
        trigger.focus();
      }
      panel.style.maxHeight = '';
    }
  });

  panel.addEventListener('click', e => {
    const btn = e.target.closest('button.opt');
    if (!btn) return;
    e.stopPropagation();
    selectIface(btn.dataset.iface);
    closePanel();
  });

  document.addEventListener('click', e => {
    if (!mini.contains(e.target) && !panel.contains(e.target)) closePanel();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && mini.classList.contains('open')) closePanel();
  });
}

function syncIfaceSelect(suffix, iface) {
  const lbl = document.getElementById('ifaceLabel_' + suffix);
  if (lbl && iface) {
    lbl.innerHTML = '';
    const labelContent = formatIfaceLabel(iface.label || iface.name);
    lbl.appendChild(labelContent);
  }
  const panel = document.getElementById('ifacePanel_' + suffix);
  if (panel) panel.querySelectorAll('.opt').forEach(b =>
    b.classList.toggle('selected', b.dataset.iface === (iface?.name)));
}

function pushIfaceSample(iface, suffix) {
  if (!iface) return;
  const rxNum  = document.getElementById('iface_rxnum_'  + suffix);
  const txNum  = document.getElementById('iface_txnum_'  + suffix);
  const rxStat = document.getElementById('iface_rxstat_' + suffix);
  const txStat = document.getElementById('iface_txstat_' + suffix);
  const totRow = document.getElementById('iface_tot_'    + suffix);

  // One bogus sample would stick in Max and flatten the graph for this session.
  const rxRate = (iface.rx_rate >= 0 && iface.rx_rate <= MAX_PLAUSIBLE_RATE) ? iface.rx_rate : 0;
  const txRate = (iface.tx_rate >= 0 && iface.tx_rate <= MAX_PLAUSIBLE_RATE) ? iface.tx_rate : 0;

  if (rxNum)  rxNum.textContent  = fmtIfaceRate(rxRate);
  if (txNum)  txNum.textContent  = fmtIfaceRate(txRate);

  // Recover the shared renderer reference from the card if it was lost.
  let renderer = window['_ifaceRenderer_' + suffix];
  if (!renderer) {
    renderer = qs('iface_wrapper_' + suffix)?._renderer
            || qs('iface_mcard_' + suffix)?._renderer
            || null;
    if (renderer) window['_ifaceRenderer_' + suffix] = renderer;
  }
  if (renderer) {
    renderer.pushSample(rxRate, txRate);
    const st = renderer.getStats();
    if (rxStat) rxStat.textContent = 'Avg: ' + fmtIfaceRate(st.rxAvg) + '\nMax: ' + fmtIfaceRate(st.rxMax);
    if (txStat) txStat.textContent = 'Avg: ' + fmtIfaceRate(st.txAvg) + '\nMax: ' + fmtIfaceRate(st.txMax);
  }
  if (totRow) totRow.innerHTML = 'Rx Total: ' + escapeHtml(iface.rx_str || formatBytesShort(iface.rx_bytes || iface.rx || 0)) + ' &nbsp;&nbsp; Tx Total: ' + escapeHtml(iface.tx_str || formatBytesShort(iface.tx_bytes || iface.tx || 0));
}

function selectIface(name) {
  selectedIface = name;
  saveSetting(LS_IFACE_KEY, name);
  const iface = ifaceRatesData.find(i => i.name === name);
  ['pc', 'mob'].forEach(sfx => {
    const renderer = window['_ifaceRenderer_' + sfx];
    if (renderer) renderer.reset();
    const zero   = fmtIfaceRate(0);
    const rxStat = document.getElementById('iface_rxstat_' + sfx);
    const txStat = document.getElementById('iface_txstat_' + sfx);
    if (rxStat) rxStat.textContent = 'Avg: ' + zero + '\nMax: ' + zero;
    if (txStat) txStat.textContent = 'Avg: ' + zero + '\nMax: ' + zero;
    syncIfaceSelect(sfx, iface);
    pushIfaceSample(iface, sfx);
  });
}

function createIfaceClientCard(suffix, isDesktop, ifaces) {
  const iface   = ifaceRatesData.find(i => i.name === selectedIface) || ifaces[0];
  const initRx  = fmtIfaceRate(iface ? iface.rx_rate : 0);
  const initTx  = fmtIfaceRate(iface ? iface.tx_rate : 0);
  const initSt  = 'Avg: ' + fmtIfaceRate(0) + '\nMax: ' + fmtIfaceRate(0);

  const mini    = document.createElement('div');
  mini.className = 'select-mini';
  mini.id = 'ifaceMini_' + suffix;
  mini.setAttribute('aria-haspopup', 'listbox');

  const trigger = document.createElement('button');
  trigger.className = 'trigger';
  trigger.id = 'ifaceTrigger_' + suffix;
  trigger.type = 'button';
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'ifacePanel_' + suffix);

  const lbl   = document.createElement('span');
  lbl.className = 'label';
  lbl.id = 'ifaceLabel_' + suffix;
  if (iface) {
    const labelContent = formatIfaceLabel(iface.label || iface.name);
    lbl.appendChild(labelContent);
  } else {
    lbl.textContent = '—';
  }

  const caret = document.createElement('span');
  caret.className = 'trigger-caret';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 10 6');
  svg.setAttribute('width', '7');
  svg.setAttribute('height', '7');
  svg.setAttribute('fill', 'none');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M1 1l4 4 4-4');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  caret.appendChild(svg);

  trigger.appendChild(lbl);
  trigger.appendChild(caret);

  const panel = document.createElement('div');
  panel.className = 'dd-panel';
  panel.id = 'ifacePanel_' + suffix;
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-hidden', 'true');
  panel.setAttribute('tabindex', '-1');

  populateIfacePanel(panel, ifaces);
  mini.appendChild(trigger);
  mini.appendChild(panel);

  setTimeout(() => wireIfaceMiniOnce(suffix), 0);

  if (isDesktop) {
    const wrapper = document.createElement('div');
    wrapper.className = 'client-wrapper';
    wrapper.id = 'iface_wrapper_' + suffix;

    const row = document.createElement('div');
    row.className = 'client card-iface';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', 'false');

    const left    = document.createElement('div'); left.className = 'left-stack';
    const hostTop = document.createElement('div'); hostTop.className = 'host-top';
    hostTop.appendChild(mini);
    left.appendChild(hostTop);
    row.appendChild(left);

    const ratesWrap = document.createElement('div'); ratesWrap.className = 'rates-wrapper';
    const ratesDiv  = document.createElement('div'); ratesDiv.className  = 'rates';

    const rxCell  = document.createElement('div'); rxCell.className = 'rx';
    const rxNum   = document.createElement('div'); rxNum.className = 'rate-number'; rxNum.id = 'iface_rxnum_' + suffix; rxNum.textContent = initRx;
    const rxLabel = document.createElement('div'); rxLabel.className = 'rate-label'; rxLabel.innerHTML = RX_ICON + '<span>Rx</span>';
    rxCell.appendChild(rxNum); rxCell.appendChild(rxLabel);

    const txCell  = document.createElement('div'); txCell.className = 'tx';
    const txNum   = document.createElement('div'); txNum.className = 'rate-number'; txNum.id = 'iface_txnum_' + suffix; txNum.textContent = initTx;
    const txLabel = document.createElement('div'); txLabel.className = 'rate-label'; txLabel.innerHTML = '<span>Tx</span>' + TX_ICON;
    txCell.appendChild(txNum); txCell.appendChild(txLabel);

    ratesDiv.appendChild(rxCell); ratesDiv.appendChild(txCell);

    const ifaceStatsRow = document.createElement('div'); ifaceStatsRow.className = 'rate-stats-row';
    const rxStat = document.createElement('span'); rxStat.className = 'rx-stats rate-stats'; rxStat.id = 'iface_rxstat_' + suffix; rxStat.textContent = initSt;
    const txStat = document.createElement('span'); txStat.className = 'tx-stats rate-stats'; txStat.id = 'iface_txstat_' + suffix; txStat.textContent = initSt;
    ifaceStatsRow.appendChild(rxStat); ifaceStatsRow.appendChild(txStat);

    ratesWrap.appendChild(ratesDiv); ratesWrap.appendChild(ifaceStatsRow);
    row.appendChild(ratesWrap);

    const graphWrap = document.createElement('div'); graphWrap.className = 'graph';
    const canvas    = document.createElement('canvas'); canvas.className = 'graph-canvas';
    graphWrap.appendChild(canvas);
    row.appendChild(graphWrap);

    const totals      = document.createElement('div'); totals.className = 'pc-totals';
    const totalsInner = document.createElement('div'); totalsInner.className = 'inner';
    const totalsRow   = document.createElement('div'); totalsRow.id = 'iface_tot_' + suffix;
    totalsRow.innerHTML = 'Rx Total: 0 B &nbsp;&nbsp; Tx Total: 0 B';
    totalsInner.appendChild(totalsRow);
    totals.appendChild(totalsInner);
    row.appendChild(totals);
    wrapper.appendChild(row);

    const renderer = createGraphRenderer({ graphEl: graphWrap, canvas, thresholdBytes: 1024 });
    renderer.start();
    allRenderers.add(renderer);
    window['_ifaceRenderer_' + suffix] = renderer;
    wrapper._renderer = renderer;

    function setOpen(open) {
      if (open) {
        const h = totalsInner.scrollHeight; void row.offsetHeight;
        totals.classList.add('open'); row.classList.add('graph-open');
        totals.style.height = h + 'px'; row.setAttribute('aria-expanded', 'true');
        totals.addEventListener('transitionend', e => {
          if (e.propertyName === 'height' && totals.classList.contains('open'))
            totals.style.height = 'auto';
        }, { once: true });
      } else {
        totals.style.height = totals.offsetHeight + 'px'; void row.offsetHeight;
        totals.style.height = '0px';
        totals.classList.remove('open'); row.classList.remove('graph-open');
        row.setAttribute('aria-expanded', 'false');
      }
    }
    row.addEventListener('click', e => {
      if (e.target.closest('.select-mini')) return;
      setOpen(!totals.classList.contains('open'));
    });
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!totals.classList.contains('open')); }
    });

    return wrapper;

  } else {
    const card = document.createElement('div');
    card.className = 'client card-iface';
    card.id = 'iface_mcard_' + suffix;

    const top = document.createElement('div'); top.className = 'client-top';
    top.appendChild(mini);
    card.appendChild(top);

    const bottom   = document.createElement('div'); bottom.className = 'client-bottom';
    const ratesDiv = document.createElement('div'); ratesDiv.className = 'rates';

    const rx     = document.createElement('div');    rx.className = 'rate rx-rate-mobile';
    const rxNum  = document.createElement('strong'); rxNum.id = 'iface_rxnum_' + suffix; rxNum.textContent = initRx;
    const rxLbl  = document.createElement('small');  rxLbl.innerHTML = RX_ICON.replace('viewBox="-2 -1 11 11"','viewBox="0 0 12 12"') + '<span>Rx</span>';
    rx.appendChild(rxNum); rx.appendChild(rxLbl);

    const tx     = document.createElement('div');    tx.className = 'rate tx-rate-mobile';
    const txNum  = document.createElement('strong'); txNum.id = 'iface_txnum_' + suffix; txNum.textContent = initTx;
    const txLbl  = document.createElement('small');  txLbl.innerHTML = '<span>Tx</span>' + TX_ICON.replace('viewBox="2 0 11 11"','viewBox="0 0 12 12"');
    tx.appendChild(txNum); tx.appendChild(txLbl);

    ratesDiv.appendChild(rx); ratesDiv.appendChild(tx);

    const ifaceStatsRow = document.createElement('div'); ifaceStatsRow.className = 'rate-stats-row';
    const rxStat = document.createElement('span'); rxStat.className = 'rx-stats rate-stats'; rxStat.id = 'iface_rxstat_' + suffix; rxStat.textContent = initSt;
    const txStat = document.createElement('span'); txStat.className = 'tx-stats rate-stats'; txStat.id = 'iface_txstat_' + suffix; txStat.textContent = initSt;
    ifaceStatsRow.appendChild(rxStat); ifaceStatsRow.appendChild(txStat);

    bottom.appendChild(ratesDiv); bottom.appendChild(ifaceStatsRow);
    card.appendChild(bottom);

    const graphWrap = document.createElement('div'); graphWrap.className = 'graph-mobile';
    const canvas    = document.createElement('canvas'); canvas.className = 'graph-canvas-mobile';
    graphWrap.appendChild(canvas);
    card.appendChild(graphWrap);

    const totals      = document.createElement('div'); totals.className = 'totals';
    const totalsInner = document.createElement('div'); totalsInner.className = 'totals-inner';
    const totRow      = document.createElement('div'); totRow.id = 'iface_tot_' + suffix;
    totRow.textContent = 'Rx: 0 B / Tx: 0 B';
    totalsInner.appendChild(totRow);
    totals.appendChild(totalsInner);
    totals.style.height = '0px'; graphWrap.style.height = '0px';
    card.appendChild(totals);

    const renderer = createGraphRenderer({ graphEl: graphWrap, canvas, thresholdBytes: 1024 });
    renderer.start();
    allRenderers.add(renderer);
    window['_ifaceRenderer_' + suffix] = renderer;
    card._renderer = renderer;

    function setOpen(open) {
      if (open) {
        const tH = totalsInner.scrollHeight; void card.offsetHeight;
        totals.classList.add('open'); graphWrap.classList.add('open'); card.classList.add('graph-open');
        totals.style.height = tH + 'px'; graphWrap.style.height = MOBILE_GRAPH_H + 'px';
        renderer.fadeIn(320);
        totals.addEventListener('transitionend', e => {
          if (e.propertyName === 'height' && totals.classList.contains('open'))
            totals.style.height = 'auto';
        }, { once: true });
      } else {
        totals.style.height = totals.offsetHeight + 'px';
        void card.offsetHeight;
        totals.style.height    = '0px';
        graphWrap.style.height = '0px';
        totals.classList.remove('open');
        graphWrap.classList.remove('open');
        card.classList.remove('graph-open');
        renderer.fadeOut(200);
      }
    }
    card.addEventListener('click', e => {
      if (e.target.closest('.select-mini')) return;
      setOpen(!totals.classList.contains('open'));
    });

    return card;
  }
}

function pickDefaultIface(ifaces) {
  const stored = getSetting(LS_IFACE_KEY);
  // Prefer a single interface by default, not an AP or combined total.
  const nonCombined = ifaces.filter(i => {
    const type = i.type ||
                 (i.is_wifi_combined ? 'wifi_combined' :
                   i.is_lan_port ? 'lan_port' :
                   i.is_smart ? 'smart' :
                   i.is_wan ? 'wan' :
                   i.is_ap ? 'ap' :
                   i.is_bridge ? 'bridge' :
                   i.is_other ? 'other' : 'unknown');
    return !(type === 'wifi_combined' || type === 'lan_port' || type === 'smart' || type === 'ap' || type === 'ap_clients' ||
             i.is_wifi_combined || i.is_lan_port || i.is_smart || i.is_ap || i.is_ap_clients);
  });
  return (stored && ifaces.find(i => i.name === stored))
    || nonCombined.find(i => (i.type === 'wan' || i.is_wan) && i.operstate === 'up')
    || nonCombined.find(i => i.type === 'wan' || i.is_wan)
    || nonCombined.find(i => i.operstate === 'up')
    || nonCombined[0]
    || ifaces[0];
}

function renderIfaceCard(ifaces, isDuplicate) {
  if (!ifaces || !ifaces.length) return;
  ifaceRatesData = ifaces;

  // Pick again if the selected interface disappeared, rather than showing stale data.
  if (!selectedIface || !ifaces.some(i => i.name === selectedIface)) {
    const pick = pickDefaultIface(ifaces);
    if (pick) selectedIface = pick.name;
  }

  const wrap    = qs('iface_rates_wrap');
  const safeKey = IFACE_BAND_KEY.replace(/[^a-zA-Z0-9_]/g, '_');

  const panelId = 'panel_' + safeKey;
  if (!qs(panelId)) {
    const section = document.createElement('section');
    section.className = 'mobile-panel band-iface';
    section.id = panelId; section.dataset.panel = IFACE_BAND_KEY;
    section.innerHTML =
      '<div class="panel-head">' +
        '<div class="panel-title">' + buildBandTitle(IFACE_BAND_KEY, false) + '</div>' +
      '</div>' +
      '<div class="list" id="list_' + safeKey + '"></div>';
    if (wrap) wrap.appendChild(section);
  }
  const listEl = qs('list_' + safeKey);
  if (listEl && !listEl.querySelector('.client')) {
    listEl.appendChild(createIfaceClientCard('mob', false, ifaces));
  } else {
    const panel = document.getElementById('ifacePanel_mob');
    if (panel) populateIfacePanel(panel, ifaces);
  }

  const pcBandId  = 'pc_band_' + safeKey;
  const pcInnerId = pcBandId + '_inner';
  if (!qs(pcBandId)) {
    const band = document.createElement('div');
    band.className = 'band band-iface'; band.id = pcBandId; band.dataset.band = IFACE_BAND_KEY;
    band.innerHTML =
      '<div class="band-head">' +
        '<h3 class="band-title">' + buildBandTitle(IFACE_BAND_KEY, false) + '</h3>' +
      '</div>' +
      '<div class="band-inner" id="' + pcInnerId + '"></div>';
    if (wrap) wrap.appendChild(band);
  }
  const inner = qs(pcInnerId);
  if (inner && !inner.querySelector('.client-wrapper')) {
    inner.appendChild(createIfaceClientCard('pc', true, ifaces));
  } else {
    const panel = document.getElementById('ifacePanel_pc');
    if (panel) populateIfacePanel(panel, ifaces);
  }

  const iface  = ifaces.find(i => i.name === selectedIface);
  ['pc','mob'].forEach(sfx => syncIfaceSelect(sfx, iface));
  const suffix = isMobile() ? 'mob' : 'pc';
  // Scroll the interface graph even when the server returns the same snapshot.
  pushIfaceSample(iface, suffix);

}

// Snapshot rendering and polling

// Stop renderers before removing their cards, or observers and rAFs can leak.
function cleanupBandCards(bandEl) {
  bandEl.querySelectorAll('.client-wrapper, .client').forEach(node => {
    try { node._cleanup?.(); } catch { }
  });
}

// Remove vanished bands; the interface card has its own container.
function pruneStaleBands(activeKeys) {
  const prune = (containerId, orderKey) => {
    const container = qs(containerId);
    if (!container) return;
    Array.from(container.children).forEach(el => {
      const key = el.dataset?.panel || el.dataset?.band;
      if (!key || activeKeys.has(key)) return;
      cleanupBandCards(el);
      el.remove();
      if (Array.isArray(window[orderKey])) {
        window[orderKey] = window[orderKey].filter(id => id !== el.id);
      }
    });
  };
  prune('mobile_grid', '_cm_panel_order');
  prune('pc_bands',    '_cm_band_order');
}

// Bridge clients inherit the upstream port, but aren't physical port cards.
function bridgeClientsWithPort(bp) {
  return (bp.clients || [])
    .filter(c => !isMacOnlyClient(c))
    .map(c => (!c.port && bp.port)
      ? { ...c, port: bp.port, port_label: normalizeLanLabel(bp.port), is_bridge_client: true }
      : { ...c, is_bridge_client: true });
}

// Render a snapshot and return whether it was treated as a duplicate.
// Polling and force refresh both use this path.
function processData(data, forceFresh = false) {
  if (!data || typeof data !== 'object') data = {};

  const hasShortKeys = data._version === "3.0" && data._format === "short_keys";

  // v2/v3 group payloads by network role; older versions are flat.
  const isNewStructure = (data._version === "2.0" || data._version === "3.0") && data.groups;

  if (hasShortKeys) {
    data = normalizeKeys(data);
  }

  // Some older responses wrap the flat payload in _legacy.
  const legacyData = data._legacy || data;

  // Ignore cached, older and invalid timestamps when computing rate deltas.
  let isDuplicate = true;
  if (data._ts != null) {
    const ts = Number(data._ts);
    if (!isNaN(ts) && ts > 0) {
      if (forceFresh || lastSeenTs === null || ts > lastSeenTs) {
        lastSeenTs = ts;
        isDuplicate = false;
      }
    }
  } else if (forceFresh) {
    isDuplicate = false;
  }

  // Only bands present in this snapshot survive pruning.
  const activeBandKeys = new Set();

  if (isNewStructure) {
    const { groups } = data;

    // Wi-Fi client bands
    if (groups.wireless && groups.wireless.access_points) {
      for (const ap of groups.wireless.access_points) {
        if (ap.key && ap.clients && ap.totals) {
          activeBandKeys.add(ap.key);
          efficientRender(ap.key, ap.clients, false, ap.totals, isDuplicate);
        }
      }
    }

    // Physical LAN ports
    activeBandKeys.add('LAN ports');
    efficientRender('LAN ports', groups.lan?.ports || [], true, data.totals?.lan || {}, isDuplicate);

    // Gather interface rates into the selector card.
    const allInterfaces = [];
    if (groups.wan?.interfaces)      allInterfaces.push(...groups.wan.interfaces);
    if (groups.lan?.interfaces)      allInterfaces.push(...groups.lan.interfaces);
    if (groups.wireless?.interfaces) allInterfaces.push(...groups.wireless.interfaces);
    if (groups.other?.interfaces)    allInterfaces.push(...groups.other.interfaces);

    if (allInterfaces.length > 0) {
      renderIfaceCard(allInterfaces, isDuplicate);
    }

    // Clients behind bridges and APs
    if (groups.bridge?.clients) {
      for (const bp of groups.bridge.clients) {
        if (bp.key && bp.totals) {
          activeBandKeys.add(bp.key);
          efficientRender(bp.key, bridgeClientsWithPort(bp), false, bp.totals, isDuplicate);
        }
      }
    }
  } else {
    // Flat payloads still use the same renderers.
    for (const [key, val] of Object.entries(legacyData)) {
      const lk = key.toLowerCase();
      if (lk === 'lan' || lk === 'lan_totals' || lk === '_runtime_s' || lk === '_ts' || lk === 'bridge_clients') continue;
      if (val?.clients && val?.totals) {
        activeBandKeys.add(key);
        efficientRender(key, val.clients, false, val.totals, isDuplicate);
      }
    }

    activeBandKeys.add('LAN ports');
    efficientRender('LAN ports', legacyData.lan || [], true, legacyData.lan_totals || {}, isDuplicate);

    if (legacyData.iface_rates && legacyData.iface_rates.length) {
      renderIfaceCard(legacyData.iface_rates, isDuplicate);
    }

    for (const bp of (legacyData.bridge_clients || [])) {
      if (bp.key && bp.totals) {
        activeBandKeys.add(bp.key);
        efficientRender(bp.key, bridgeClientsWithPort(bp), false, bp.totals, isDuplicate);
      }
    }
  }

  pruneStaleBands(activeBandKeys);

  // Forget old baselines so long-lived tabs don't retain every client ever seen.
  const nowSweep = Date.now();
  for (const k in prevSnapshot) {
    if (nowSweep - (prevSnapshot[k].ts || 0) > 600000) delete prevSnapshot[k];
  }

  return isDuplicate;
}

// Share one pending RPC across polling and force refresh.
function requestData() {
  if (dataRequestInFlight) return dataRequestInFlight;

  const request = ubusCall("client_monitor", "get_data",
    { client: CM_CLIENT_ID, interval: window._cm_interval_sec || 2 });
  dataRequestInFlight = request;
  request.then(
    () => { if (dataRequestInFlight === request) dataRequestInFlight = null; },
    () => { if (dataRequestInFlight === request) dataRequestInFlight = null; }
  );
  return request;
}

async function fetchDataOnce() {
  let data;
  try {
    data = await requestData();
  } catch (error) {
    console.warn('client_monitor: get_data failed:', error);
    // Leave the last good cards visible on transient errors.
    // Only show the placeholder before any bands have been rendered.
    const el = qs('pc_bands');
    if (el && !el.querySelector('.band')) {
      Object.assign(el.style, { color: 'var(--muted)', fontSize: '13px', padding: '6px' });
      el.textContent = 'Data unavailable';
      el.dataset.errPlaceholder = '1';
    }
    const lastEl = qs('last');
    if (lastEl) lastEl.textContent = 'Last_Poll: error';
    hideLoading();
    return;
  }

  // The daemon is warming up; retry without clearing the existing view.
  if (data && data.error === "collecting") {
    if (collectingRetryPending) return;
    collectingRetryCount++;
    if (collectingRetryCount > COLLECTING_MAX_RETRIES) {
      collectingRetryCount = 0;
      const lastEl = qs('last');
      if (lastEl) lastEl.textContent = 'Last_Poll: daemon not responding';
      hideLoading();
      return;
    }
    collectingRetryPending = true;
    const delay = data.retry_ms || 500;
    setTimeout(() => {
      collectingRetryPending = false;
      fetchData().catch(() => {});
    }, delay);
    return;
  }

  // Reset the retry budget once the daemon is no longer collecting.
  collectingRetryCount = 0;

  // Replace the initial error placeholder now that data is available.
  const pb = qs('pc_bands');
  if (pb?.dataset.errPlaceholder) {
    pb.textContent = '';
    pb.removeAttribute('style');
    delete pb.dataset.errPlaceholder;
  }

  const isDuplicate = processData(data, false);

  if (!isDuplicate) {
    const lastEl = qs('last');
    if (lastEl) lastEl.textContent = 'Last_Poll: ' + new Date().toLocaleTimeString();
  }

  moveEmptyPanelsToBottom();
  hideLoading();
}

function fetchData() {
  if (fetchInFlight) return fetchInFlight;
  const request = fetchDataOnce();
  fetchInFlight = request;
  request.then(
    () => { if (fetchInFlight === request) fetchInFlight = null; },
    () => { if (fetchInFlight === request) fetchInFlight = null; }
  );
  return request;
}

// Loading and dropdown controls
function showLoading() { qs('loading-overlay')?.classList.remove('hidden'); }
function hideLoading() { qs('loading-overlay')?.classList.add('hidden');    }

function initDropdown(miniId, triggerId, panelId, onSelect) {
  const mini    = qs(miniId);
  const trigger = qs(triggerId);
  const panel   = qs(panelId);
  if (!mini || !trigger || !panel) return;

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const open = mini.classList.toggle('open');
    trigger.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
    trigger.classList.toggle('glow', open);
    // Return focus to the trigger when the list closes.
    if (!open && panel.contains(document.activeElement)) {
      trigger.focus();
    }
  });

  const opts = Array.from(panel.querySelectorAll('.opt'));
  opts.forEach((btn, i) => {
    btn.setAttribute('tabindex', '0');
    btn.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); opts[(i + 1) % opts.length].focus(); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); opts[(i - 1 + opts.length) % opts.length].focus(); }
    });
    btn.addEventListener('click', e => {
      e.stopPropagation();
      onSelect(btn);
      mini.classList.remove('open');
      panel.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      // Keep focus out of the hidden list.
      if (panel.contains(document.activeElement)) {
        trigger.focus();
      }
      panel.setAttribute('aria-hidden', 'true');
      trigger.classList.remove('glow');
    });
  });

  document.addEventListener('click', e => {
    if (!mini.contains(e.target) && !panel.contains(e.target)) {
      mini.classList.remove('open');
      panel.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      // Keep focus out of the hidden list.
      if (panel.contains(document.activeElement)) {
        trigger.focus();
      }
      panel.setAttribute('aria-hidden', 'true');
      trigger.classList.remove('glow');
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      mini.classList.remove('open');
      panel.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      // Keep focus out of the hidden list.
      if (panel.contains(document.activeElement)) {
        trigger.focus();
      }
      panel.setAttribute('aria-hidden', 'true');
      trigger.classList.remove('glow');
    }
  });
}

// Poll interval and refresh controls
let toastTimer = null;
function showToast() {
  const t = qs('poll-warn-toast');
  if (!t) return;
  clearTimeout(toastTimer);
  t.classList.add('show');
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function setAuto(sec) {
  if (window._cm_timer) clearInterval(window._cm_timer);
  window._cm_timer = null;

  prevSnapshot = {};
  lastSeenTs   = null;

  // Hidden tabs don't need polls. visibilitychange fetches when the tab returns.
  if (sec > 0) window._cm_timer = setInterval(() => {
    if (!document.hidden) fetchData().catch(() => {});
  }, sec * 1000);
  window._cm_interval_sec = sec > 0 ? sec : 2;

  const labelEl = qs('autoLabel');
  if (labelEl) labelEl.textContent = sec === 0 ? 'Off' : sec + 's';

  const warnEl = qs('triggerWarn');
  if (warnEl) warnEl.style.display = sec === 1 ? 'inline' : 'none';

  saveSetting(LS_INTERVAL_KEY, String(sec));

  qs('autoPanel')?.querySelectorAll('.opt').forEach(btn => {
    const active = (parseInt(btn.dataset.val, 10) || 0) === sec;
    btn.classList.toggle('selected', active);
    btn.setAttribute('aria-selected', String(active));
  });

  allRenderers.forEach(r => { try { r.reconfigure(); } catch { } });
  if (sec === 1) showToast();
  if (NetworkMonitor.stopCountdown) NetworkMonitor.stopCountdown();
}

initDropdown('autoMini', 'autoTrigger', 'autoPanel', btn => setAuto(parseInt(btn.dataset.val, 10) || 0));

// Manual refresh
(function() {
  const btn = qs('forceRefreshBtn');
  if (!btn) return;

  let cooldownTimer = null;
  let spinAnimationId = null;
  let spinTimeoutId = null;

  function startCooldown() {
    clearTimeout(cooldownTimer);
    const sec = window._cm_interval_sec || 2;
    if (sec <= 0) return;
    btn.disabled = true;
    btn.style.opacity = '0.4';
    btn.style.cursor  = 'not-allowed';
    cooldownTimer = setTimeout(() => {
      btn.disabled = false;
      btn.style.opacity = '';
      btn.style.cursor  = '';
    }, sec * 1000);
  }

  function stopCooldown() {
    clearTimeout(cooldownTimer);
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor  = '';
  }

  function startSpinner() {
    if (spinAnimationId) return;
    
    const icon = btn.querySelector('.refresh-icon');
    let angle = 0;
    const spin = () => {
      angle = (angle + 6) % 360;
      if (icon) icon.style.transform = 'rotate(' + angle + 'deg)';
      spinAnimationId = requestAnimationFrame(spin);
    };
    spinAnimationId = requestAnimationFrame(spin);
    
    // Don't leave the spinner running if the request hangs.
    spinTimeoutId = setTimeout(() => {
      if (spinAnimationId) {
        cancelAnimationFrame(spinAnimationId);
        spinAnimationId = null;
        if (icon) icon.style.transform = '';
      }
    }, 30000);
  }

  function stopSpinner() {
    if (spinAnimationId) {
      cancelAnimationFrame(spinAnimationId);
      spinAnimationId = null;
    }
    if (spinTimeoutId) {
      clearTimeout(spinTimeoutId);
      spinTimeoutId = null;
    }
    const icon = btn.querySelector('.refresh-icon');
    if (icon) icon.style.transform = '';
  }

  let isRefreshing = false;
  btn.addEventListener('click', async () => {
    if (isRefreshing) return;
    isRefreshing = true;
    stopCooldown();
    startSpinner();
    try {
      const refreshResponse = await ubusCall("client_monitor", "force_refresh", {});
      const requestedRefreshId = Number(refreshResponse?.refresh_id);
      if (!Number.isFinite(requestedRefreshId)) throw new Error('Invalid refresh generation');

      // Keep the current view until our refresh ID, or a newer one, is published.
      // Multiple viewers may have requested a refresh while we were waiting.
      let data = null;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        data = await requestData();
        const refreshId = Number(data?._refresh_id);
        if (!data?.error && Number.isFinite(refreshId) && refreshId >= requestedRefreshId) break;
        data = null;
      }

      if (!data || typeof data !== 'object') throw new Error('Timed out waiting for refreshed data');

      lastSeenTs = null;
      prevSnapshot = {};
      ifaceRatesData = [];
      selectedIface = null;
      Object.keys(macIpToggle).forEach(key => delete macIpToggle[key]);
      allRenderers.forEach(r => { try { r.reset(); } catch { } });
      try { localStorage.removeItem(LS_IFACE_KEY); } catch { }
      window._cm_panel_order = [];
      window._cm_band_order = [];

      // Render the completed refresh through the normal snapshot path.
      processData(data, true);
      const lastEl = qs('last');
      if (lastEl) lastEl.textContent = 'Last_Poll: ' + new Date().toLocaleTimeString() + ' (forced)';
      moveEmptyPanelsToBottom();
    } catch (e) { console.error('Force refresh failed', e); }
    finally {
      stopSpinner();
      isRefreshing = false;
      startCooldown();
    }
  });

  // Let poll-interval changes clear the refresh cooldown.
  NetworkMonitor.startCountdown = startCooldown;
  NetworkMonitor.stopCountdown  = stopCooldown;
})();

const trigWarn = qs('triggerWarn');
const btn1s    = qs('autoPanel')?.querySelector('.opt[data-val="1"]');
[trigWarn, btn1s].forEach(el => {
  if (!el) return;
  el.addEventListener('mouseenter', () => { clearTimeout(toastTimer); qs('poll-warn-toast')?.classList.add('show'); });
  el.addEventListener('mouseleave', () => { toastTimer = setTimeout(() => qs('poll-warn-toast')?.classList.remove('show'), 200); });
});

const storedInterval = parseInt(getSetting(LS_INTERVAL_KEY), 10);
setAuto(Number.isFinite(storedInterval) && storedInterval >= 0 ? storedInterval : 2);

// Display units
const VALID_UNITS = new Set(['Mbps', 'MB/s']);

function setUnit(unit) {
  if (!VALID_UNITS.has(unit)) {
    console.warn('Invalid unit:', unit, 'falling back to default (MB/s)');
    unit = 'MB/s';
  }
  
  window._cm_unit = unit;
  const lbl = qs('unitLabel');
  if (lbl) lbl.textContent = unit === 'Mbps' ? 'Mbps' : 'MB/s';

  qs('unitPanel')?.querySelectorAll('.opt').forEach(btn => {
    const active = btn.dataset.unit === unit;
    btn.classList.toggle('selected', active);
    btn.setAttribute('aria-selected', String(active));
  });

  saveSetting(LS_UNIT_KEY, unit);

  Object.values(prevSnapshot).forEach(s => { delete s._lastRxStr; delete s._lastTxStr; });
  allRenderers.forEach(r => { try { r.draw(); } catch { } });
}

initDropdown('unitMini', 'unitTrigger', 'unitPanel', btn => setUnit(btn.dataset.unit));
setUnit(getSetting(LS_UNIT_KEY) === 'Mbps' ? 'Mbps' : 'MB/s');

// Layout, visibility and display changes
function clearOppositeLayout(mobileMode) {
  const el  = qs(mobileMode ? 'pc_bands'   : 'mobile_grid');
  const cls = mobileMode    ? '.client-wrapper, .band' : '.client, .mobile-panel';
  if (!el) return;
  el.querySelectorAll(cls).forEach(node => {
    try {
      node._cleanup?.();
    } catch (error) {
      console.error('Cleanup failed for node:', error);
    }
    try {
      node.remove();
    } catch (error) {
      console.error('Failed to remove node:', error);
    }
  });
}

function refreshAll(showOverlay) {
  if (showOverlay) showLoading();
  clearOppositeLayout(isMobile());
  allRenderers.forEach(r => {
    try { r.reconfigure(); r.draw(); } catch { }
  });
  // Give the new layout a moment to settle before fetching.
  if (showOverlay) {
    setTimeout(() => fetchData().catch(() => {}), 300);
  }
}

let lastWidth = window.innerWidth, lastMobile = isMobile();

window.addEventListener('orientationchange', () => {
  refreshAll(true);
  // Rebuild bands for the new orientation.
  setTimeout(() => fetchData().catch(() => {}), 300);
});

const handleResize = () => {
  const w        = window.innerWidth;
  const mobile   = isMobile();
  const modeFlip = mobile !== lastMobile;   // desktop/mobile boundary changed
  if (w !== lastWidth) {
    lastWidth  = w;
    lastMobile = mobile;
    refreshAll(modeFlip);                   // show loading only when the layout changes
  } else {
    allRenderers.forEach(r => { try { r.draw(); } catch { } });
  }
};

// Keep resizing responsive without redrawing on every resize event.
window.addEventListener('resize', throttle(handleResize, 250));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    allRenderers.forEach(r => { try { r.pause(); } catch { } });
  } else {
    allRenderers.forEach(r => { try { r.resume(); } catch { } });
    // Fetch now to catch up with the time spent hidden.
    fetchData().catch(() => {});
  }
});

window.addEventListener('beforeunload', () => {
  allRenderers.forEach(r => {
    if (typeof r.stop === 'function') {
      try {
        r.stop();
      } catch (error) {
        console.error('Renderer cleanup failed:', error);
      }
    }
  });
});

(function watchDPR() {
  const dpr = window.devicePixelRatio || 1;
  const mq  = window.matchMedia(`(resolution: ${dpr}dppx)`);
  const cb  = () => {
    mq.removeEventListener('change', cb);
    allRenderers.forEach(r => { try { r.draw(); } catch { } });
    watchDPR();
  };
  mq.addEventListener('change', cb);
})();

// Initial snapshot
showLoading();
setTimeout(() => { fetchData().catch(console.error); }, 10);

})();
