/**
 * D spike service worker.
 *
 * Plaintext mode:  page <-> SW <-> tunnel <-> gateway.
 * E2E mode:        page <-> SW <-> relay <-> agent <-> gateway, where the relay
 *                  only sees handshake public keys and AES-GCM ciphertext.
 *
 * The page-facing behavior is unchanged: fetch/EventSource proxying, streamed
 * responses, a cookie jar exposed through a Document.cookie shim, and a
 * WebSocket constructor shim.
 */

const params = new URL(self.location.href).searchParams;
const E2E_RAW = params.get('e2e');
// Test knobs so one deployment can bisect what breaks the mobile client boot.
const INJECT_MODE = params.get('inject') || 'full';   // full | cookie | none
const KEEP_CSP = params.get('csp') === 'keep';
// Static files on the shell origin. Anything else same-origin is tunneled; an
// intercepted /go.html would be answered by the gateway (404) and the
// navigation would die as ERR_FAILED before its redirect ever runs.
const PASSTHROUGH = new Set([
  '/sw.js', '/index.html', '/go.html', '/cookie-shim.js', '/ws-shim.js',
  '/icon-180.png', '/manifest.webmanifest',
]);

// dsh-mobile 0.8.4 only insets the header for the 56 px rail; the workspace-
// picker hero keeps a full-width composer, so on a phone the rail covers the
// left edge of the input box. Clear the rail for the hero only and leave the
// conversation view exactly as the app lays it out.
const LAYOUT_CSS = `@media (max-width:720px){
  .dshm-shell:not([data-dshm-wide="1"]) .dshm-drawer[data-open="false"]{width:0!important;opacity:0;overflow:hidden;pointer-events:none}
  .dshm-shell:not([data-dshm-wide="1"]) .dshm-drawer[data-open="false"]>*{width:0!important}
  .dshm-shell:not([data-dshm-wide="1"]) .dshm-main{padding-left:0!important}
  .dshm-shell [style*="260px"]>svg{width:100%!important;height:100%!important;display:block}
  .e2e-drawer-btn{position:fixed;left:12px;top:calc(12px + env(safe-area-inset-top,0px));width:36px;height:36px;border-radius:10px;display:grid;place-items:center;padding:0;background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l4,#e3e6ea);z-index:60;box-shadow:0 1px 3px rgb(0 0 0 / 8%);color:var(--dsw-alias-label-primary,#171a21);font:16px/1 -apple-system,sans-serif;cursor:pointer}
  body:has(.dshm-drawer[data-open="true"]) .e2e-drawer-btn{display:none}
}`;

// The mini rail is dsh-mobile's only drawer handle. Replace it with a single
// floating button on phones: the rail goes invisible, the button clicks the
// app's own toggle so the drawer keeps its React state and animation.
// The gateway says "this device is no longer paired" when the browser has no
// session, which reads like the device was kicked. Tell the user what to do.
const PAIR_HINT_JS = String.raw`<script>(function(){
  var shown = false;
  function show(){
    if (shown || !document.body) return;
    var text = document.body.innerText || "";
    if (!/no longer paired|\u4e0d\u518d\u914d\u5bf9|\u91cd\u65b0\u8fde\u63a5\u6b64\u8bbe\u5907/.test(text)) return;
    shown = true;
    var box = document.createElement("div");
    box.textContent = "\u8fd9\u4e2a\u6d4f\u89c8\u5668\u8fd8\u6ca1\u6709\u914d\u5bf9\uff1a\u8bf7\u5728\u7535\u8111\u4e0a\u6253\u5f00 /relay pair \u751f\u6210\u4e8c\u7ef4\u7801\uff0c\u5e76\u7528\u540c\u4e00\u4e2a\u6d4f\u89c8\u5668\u626b\u7801\u3002";
    box.setAttribute("style", "position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;padding:12px 14px;border-radius:12px;background:#111a;color:#fff;font:13px/1.55 -apple-system,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3);backdrop-filter:blur(6px)");
    document.body.appendChild(box);
  }
  setTimeout(show, 1500);
  setTimeout(show, 4000);
})();</script>`;

const DRAWER_JS = String.raw`<script>(function(){
  var timer = setInterval(function(){
    if (!document.querySelector(".dshm-shell")) return;
    if (!document.querySelector(".e2e-drawer-btn")) {
      var b = document.createElement("button");
      b.className = "e2e-drawer-btn";
      b.setAttribute("aria-label", "打开侧边栏");
      b.textContent = "\u2630";
      b.addEventListener("click", function(ev){
        ev.preventDefault(); ev.stopPropagation();
        var t = document.querySelector(".dshm-drawer button[aria-label=\"打开侧边栏\"]") || document.querySelector("button[aria-label=\"打开侧边栏\"]");
        if (t) t.click();
      });
      document.body.appendChild(b);
    }
    clearInterval(timer);
  }, 400);
})();</script>`;


const DIAG_SCRIPT = `<script>(function(){
  function b64(text){
    try {
      var bytes = new TextEncoder().encode(text);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      var out = btoa(bin).split('+').join('-').split('/').join('_');
      while (out.charAt(out.length - 1) === '=') out = out.slice(0, -1);
      return out;
    } catch (e) { return ''; }
  }
  function report(kind, data){
    try {
      var payload = b64(JSON.stringify(data || {}));
      if (!payload) return;
      if (payload.length > 2600) payload = payload.slice(0, 2600);
      var img = new Image();
      img.onload = img.onerror = function(){ try { img.remove(); } catch (e) {} };
      img.src = '/__e2e_diag?k=' + kind + '&d=' + payload + '&n=' + Math.random().toString(36).slice(2, 8);
      (document.head || document.documentElement).appendChild(img);
    } catch (e) {}
  }
  window.__e2eReport = report;
  function res(){
    try {
      var out = [];
      var entries = performance.getEntriesByType('resource') || [];
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i].name || '';
        out.push(name.length > 80 ? name.slice(-80) : name);
      }
      return out;
    } catch (e) { return []; }
  }
  function snap(extra){
    var list = res();
    var out = { r: document.readyState, n: document.scripts.length, c: list.length, last: list.slice(-5).join(' ') };
    if (extra) for (var k in extra) out[k] = extra[k];
    return out;
  }
  report('boot', snap({ href: location.href.slice(0, 140), ua: navigator.userAgent, sw: !!navigator.serviceWorker, ctrl: !!(navigator.serviceWorker && navigator.serviceWorker.controller) }));
  window.addEventListener('error', function(e){
    var t = e && e.target;
    var target = String((t && (t.src || t.currentSrc || t.href)) || '');
    if (target.indexOf('/__e2e_diag') >= 0) return;
    report('err', { m: String(e && e.message || '').slice(0, 300), src: String(e && e.filename || target).slice(-120), line: e && e.lineno, col: e && e.colno, stack: String(e && e.error && e.error.stack || '').slice(0, 700) });
  }, true);
  window.addEventListener('unhandledrejection', function(e){
    var r = e && e.reason;
    report('rej', { m: String(r && r.message || r || '').slice(0, 300), stack: String(r && r.stack || '').slice(0, 800) });
  });
  var nativeError = console.error;
  console.error = function(){
    try {
      var args = [];
      for (var i = 0; i < arguments.length && i < 4; i += 1) {
        var a = arguments[i];
        args.push(String(a && a.stack || a).slice(0, 260));
      }
      report('log', { a: args.join(' | ') });
    } catch (e) {}
    return nativeError.apply(console, arguments);
  };
  var marks = [0, 1500, 4000, 8000, 14000, 22000, 34000];
  for (var m = 0; m < marks.length; m += 1) {
    (function(delay){ setTimeout(function(){ report('hb', snap({ t: delay })); }, delay); })(marks[m]);
  }
})();</script>`;

let E2E_CONFIG = null;
if (E2E_RAW) {
  try {
    E2E_CONFIG = JSON.parse(b64urlDecode(E2E_RAW));
  } catch {
    E2E_CONFIG = null;
  }
}

function deriveTunnelUrl() {
  const parts = self.location.hostname.split('.');
  if (parts.length < 3) return null;
  const device = parts[0];
  const base = parts.slice(2).join('.');
  const port = self.location.port ? ':' + self.location.port : '';
  return 'wss://api.' + base + port + '/e2e/shell?device=' + encodeURIComponent(device);
}

const TUNNEL_URL = (E2E_CONFIG && E2E_CONFIG.ws) || params.get('tunnel') || deriveTunnelUrl() || 'ws://localhost:8789/tunnel';

let tunnel = null;
let tunnelReady = null;
let recvChain = Promise.resolve();
let nextHttpId = 1;
let e2e = null;
let helloAck = null;
const pendingHead = new Map();
const httpStreams = new Map();
const wsStreams = new Map();
const cookieJar = new Map();

// --- diagnostics -----------------------------------------------------------
// Each entry travels through the tunnel as a GET to /__e2e_diag?... so the
// desktop agent's request log records it verbatim.
let diagSeq = 0;
let e2eRecvCount = 0;
let framesSeen = 0;
let rxBytes = 0;
let tpFrames = 0;
let tpBytes = 0;
let tpCpu = 0;
let tpWall = 0;
let framesStart = 0;
const SW_ID = Math.random().toString(36).slice(2, 8);
let swSeq = 0;
const requestPaths = new Map();
const diagIds = new Set();
const queuedDiags = [];
// Bumped whenever the cache's contents could mix versions of the app: an old
// entry replayed under a newer boot document is what stalls a cold start.
const ASSET_CACHE = 'e2e-assets-v2';
const NO_CACHE = (() => {
  try { return new URL(self.location.href).searchParams.get('nocache') === '1'; } catch { return false; }
})();
// Diags are a development tap: each one is a real request through the tunnel.
// Off by default so a normal boot makes no /__e2e_diag traffic at all.
const DIAG_ON = (() => {
  try { return new URL(self.location.href).searchParams.get('diag') === '1'; } catch { return false; }
})();
function diag(kind, data) {
  if (!DIAG_ON) return;
  if (!tunnel || tunnel.readyState !== 1 || !e2e) {
    if (queuedDiags.length < 40) queuedDiags.push([kind, data]);
    return;
  }
  try {
    const payload = { sw: SW_ID, q: ++swSeq };
    for (const key of Object.keys(data || {})) payload[key] = data[key];
    const text = JSON.stringify(payload);
    const diagId = 900000 + (diagSeq++);
    diagIds.add(diagId);
    sendInner({
      t: 'http-open',
      id: diagId,
      method: 'GET',
      url: '/__e2e_diag?k=' + kind + '&d=' + toBase64url(new TextEncoder().encode(text)),
      headers: {},
      body: null,
    });
  } catch {}
}

function flushDiags() {
  while (queuedDiags.length) {
    const [kind, data] = queuedDiags.shift();
    diag(kind, data);
  }
}

// Set-Cookie on a service-worker Response is dropped by the browser, so this
// jar is the only cookie store. iOS suspends service workers aggressively, so
// an in-memory jar loses the session between the pair POST and the app load.
let jarReady = null;
let lastTunnelClose = null;
let saveTimer = null;

function openJarDb() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open('dsh-e2e-shell', 1);
      request.onupgradeneeded = () => {
        try { request.result.createObjectStore('kv'); } catch {}
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}


/** Browser cookies first, jar entries win on a name clash. */
function mergeCookies(browserCookie, jarCookie) {
  const merged = new Map();
  for (const part of String(browserCookie || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;
    merged.set(trimmed.slice(0, equals), trimmed.slice(equals + 1));
  }
  for (const part of String(jarCookie || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;
    merged.set(trimmed.slice(0, equals), trimmed.slice(equals + 1));
  }
  return [...merged].map(([name, value]) => name + '=' + value).join('; ');
}

function loadJar() {
  if (!jarReady) {
    jarReady = (async () => {
      const db = await openJarDb();
      if (!db) return;
      try {
        const stored = await new Promise((resolve) => {
          const tx = db.transaction('kv', 'readonly');
          const request = tx.objectStore('kv').get('cookies');
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => resolve(null);
          tx.onerror = () => resolve(null);
        });
        if (stored && typeof stored === 'object') {
          for (const [name, value] of Object.entries(stored)) {
            if (!cookieJar.has(name)) cookieJar.set(name, value);
          }
        }
      } catch {}
      try { db.close(); } catch {}
    })();
  }
  return jarReady;
}

function saveJarSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveJar(); }, 0);
}

function saveJar() {
  const snapshot = Object.fromEntries(cookieJar);
  void (async () => {
    const db = await openJarDb();
    if (!db) return;
    try {
      await new Promise((resolve) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(snapshot, 'cookies');
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {}
    try { db.close(); } catch {}
  })();
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Open the tunnel lazily on the first fetch. Eagerly connecting here races
  // with the page's first request and creates a second tunnel for the same
  // device; the relay can only serve one, so one of them is killed mid-load.
  event.waitUntil(self.clients.claim());
});

function connectTunnel() {
  if (tunnel && (tunnel.readyState === 0 || tunnel.readyState === 1)) return tunnelReady;

  tunnelReady = new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(TUNNEL_URL);
    tunnel = ws;

    ws.onopen = () => {
      settled = true;
      resolve();
      diag('tunnel-open', { close: lastTunnelClose });
      lastTunnelClose = null;
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error('tunnel websocket error'));
      }
    };

    ws.onclose = (event) => {
      tunnel = null;
      e2e = null;
      helloAck = null;
      const detail = 'tunnel closed (' + (event?.code ?? '?') + (event?.reason ? ': ' + event.reason : '') + ')';
      lastTunnelClose = { code: event?.code ?? null, reason: String(event?.reason || '').slice(0, 120), at: Date.now() };
      if (!settled) {
        settled = true;
        reject(new Error(detail));
      }
      for (const [id, entry] of pendingHead) {
        entry.reject(new Error(detail));
        pendingHead.delete(id);
      }
      for (const [id, entry] of httpStreams) {
        entry.error = detail;
        if (entry.controller) {
          try { entry.controller.error(new Error('tunnel closed')); } catch {}
        }
        if (entry.onEnd) entry.onEnd();
        httpStreams.delete(id);
      }
      setTimeout(() => connectTunnel().catch(() => {}), 500);
    };

    // WebCrypto decryption is async. Without serialization, two frames can
    // resolve out of order and trip the monotonic counter check, which Safari
    // hits much more often than Chrome. Keep receive order identical to wire
    // order.
    ws.onmessage = (event) => {
      framesSeen += 1;
      if (!framesStart) framesStart = Date.now();
      rxBytes += event.data.length;
      tpFrames += 1;
      tpBytes += event.data.length;
      const tpStarted = Date.now();
      recvChain = recvChain
        .then(() => {
          // Messages from a replaced socket must never be decrypted with the
          // new tunnel's keys; that is a guaranteed 4002 decrypt failure.
          if (tunnel !== ws) return undefined;
          return onTunnelMessage(event.data);
        })
        .then(() => {
          tpCpu += Date.now() - tpStarted;
          if (tpFrames % 10 === 0) diag('tp', { n: tpFrames, wall: Date.now() - (tpWall || (tpWall = Date.now())), cpu: tpCpu, b: tpBytes });
        }, () => {})
        .catch((error) => console.warn?.('e2e receive failed: ' + error.message));
    };
  }).then(async () => {
    if (E2E_CONFIG) {
      try {
        await doHandshake();
      } catch (error) {
        diag('handshake-fail', { m: String(error && error.message) });
        throw error;
      }
    }
    diag('handshake-ok', {});
    flushDiags();
  });

  return tunnelReady;
}

function sendTunnel(value) {
  if (!tunnel || tunnel.readyState !== 1) return false;
  try {
    tunnel.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function sendInner(value) {
  if (!e2e) {
    sendTunnel(value);
    return Promise.resolve();
  }

  e2e.sendChain = e2e.sendChain.then(async () => {
    const n = e2e.sendCounter;
    e2e.sendCounter += 1;
    const nonce = makeNonceBytes(e2e.c2sPrefix, n);
    const aad = new TextEncoder().encode('e2e|c2s|' + n);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad },
      e2e.c2sKey,
      new TextEncoder().encode(JSON.stringify(value)),
    ));
    sendTunnel({ t: 'enc', n, d: toBase64url(ciphertext) });
  }).catch((error) => {
    console.warn?.('e2e send failed: ' + error.message);
  });

  return e2e.sendChain;
}

async function doHandshake() {
  const clientEph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const clientEphJwk = await crypto.subtle.exportKey('jwk', clientEph.publicKey);
  const clientNonce = toBase64url(crypto.getRandomValues(new Uint8Array(16)));

  const ack = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (helloAck) {
        helloAck = null;
        reject(new Error('e2e handshake timeout'));
      }
    }, 45000);
    helloAck = { resolve, reject, timer };

    if (!sendTunnel({
      t: 'hello',
      v: 1,
      clientEph: clientEphJwk,
      clientNonce,
      token: E2E_CONFIG.token,
    })) {
      clearTimeout(timer);
      helloAck = null;
      reject(new Error('tunnel is not connected'));
    }
  });

  if (!ack || ack.v !== 1) throw new Error('bad hello-ack');
  if (!sameJwk(ack.hostStatic, E2E_CONFIG.hostKey)) throw new Error('host key mismatch');

  const transcript = transcriptString(clientEphJwk, ack.hostEph, E2E_CONFIG.token, clientNonce, ack.hostNonce);
  const hostStaticKey = await crypto.subtle.importKey(
    'jwk',
    ack.hostStatic,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    hostStaticKey,
    fromBase64url(ack.sig),
    new TextEncoder().encode(transcript),
  );
  if (!verified) throw new Error('bad host signature');

  const hostEphKey = await crypto.subtle.importKey(
    'jwk',
    ack.hostEph,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: hostEphKey },
    clientEph.privateKey,
    256,
  );
  const salt = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(transcript));
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const okm = new Uint8Array(await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode('dsh-remote/e2e/v1|keys'),
    },
    hkdfKey,
    88 * 8,
  ));

  e2e = {
    c2sKey: await crypto.subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt']),
    s2cKey: await crypto.subtle.importKey('raw', okm.slice(32, 64), 'AES-GCM', false, ['decrypt']),
    c2sPrefix: okm.slice(64, 76),
    s2cPrefix: okm.slice(76, 88),
    sendCounter: 0,
    recvCounter: 0,
    sendChain: Promise.resolve(),
  };
}

async function onTunnelMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }

  if (msg.t === 'hello-ack') {
    if (helloAck) {
      clearTimeout(helloAck.timer);
      const entry = helloAck;
      helloAck = null;
      entry.resolve(msg);
    }
    return;
  }

  if (msg.t === 'enc') {
    e2eRecvCount += 1;
    if (e2eRecvCount % 200 === 0) diag('recv', { n: e2eRecvCount });
    if (!e2e) return;
    try {
      const inner = await decryptInner(msg);
      onInnerMessage(inner);
    } catch (error) {
      console.warn?.('e2e decrypt failed: ' + error.message);
      diag('decrypt-fail', { m: String(error && error.message) });
      try { tunnel?.close(4002, 'decrypt_failed: ' + String(error.message || '').slice(0, 100)); } catch {}
    }
    return;
  }

  onInnerMessage(msg);
}

async function decryptInner(msg) {
  if (msg.n !== e2e.recvCounter) {
    diag('counter-gap', { got: msg.n, want: e2e.recvCounter });
    throw new Error('unexpected e2e counter');
  }
  const nonce = makeNonceBytes(e2e.s2cPrefix, msg.n);
  const aad = new TextEncoder().encode('e2e|s2c|' + msg.n);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad },
    e2e.s2cKey,
    fromBase64url(msg.d),
  );
  e2e.recvCounter += 1;
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function onInnerMessage(msg) {
  if (msg.t === 'http-head') {
    const entry = pendingHead.get(msg.id);
    if (entry) {
      pendingHead.delete(msg.id);
      entry.resolve(msg);
    }
    return;
  }

  if (msg.t === 'http-chunk') {
    const entry = httpStreams.get(msg.id);
    if (!entry) return;
    const bytes = fromBase64(msg.data);
    entry.bytes = (entry.bytes || 0) + bytes.length;
    entry.chunksSeen = (entry.chunksSeen || 0) + 1;
    if (entry.controller) {
      try { entry.controller.enqueue(bytes); } catch {}
    } else {
      entry.chunks.push(bytes);
    }
    return;
  }

  if (msg.t === 'http-end') {
    pluginFinish(msg.id);
    const entry = httpStreams.get(msg.id);
    if (!entry) return;
    entry.ended = true;
    if (!diagIds.has(msg.id)) {
      diag('end', { id: msg.id, p: requestPaths.get(msg.id), ms: Date.now() - (entry.startedAt || Date.now()), b: entry.bytes || 0, c: entry.chunksSeen || 0 });
    }
    if (entry.controller) {
      try { entry.controller.close(); } catch {}
    }
    if (entry.onEnd) entry.onEnd();
    else httpStreams.delete(msg.id);
    return;
  }

  if (msg.t === 'http-error') {
    pluginFinish(msg.id);
    const pending = pendingHead.get(msg.id);
    if (pending) {
      pendingHead.delete(msg.id);
      pending.reject(new Error(msg.message || 'tunnel error'));
      return;
    }
    const entry = httpStreams.get(msg.id);
    if (!entry) return;
    entry.error = msg.message || 'tunnel error';
    if (entry.controller) {
      try { entry.controller.error(new Error(entry.error)); } catch {}
    }
    if (entry.onEnd) entry.onEnd();
    else httpStreams.delete(msg.id);
    return;
  }

  const stream = wsStreams.get(msg.id);
  if (!stream) return;

  if (msg.t === 'ws-open') {
    stream.open = true;
    postToWsClient(stream, { t: 'ws-event', id: msg.id, kind: 'open', protocol: msg.protocol || '' });
    return;
  }

  if (msg.t === 'ws-data') {
    postToWsClient(stream, { t: 'ws-event', id: msg.id, kind: 'message', data: msg.data });
    return;
  }

  if (msg.t === 'ws-close') {
    postToWsClient(stream, { t: 'ws-event', id: msg.id, kind: 'close', code: msg.code, reason: msg.reason });
    wsStreams.delete(msg.id);
    return;
  }

  if (msg.t === 'ws-error') {
    postToWsClient(stream, { t: 'ws-event', id: msg.id, kind: 'error', message: msg.message });
    wsStreams.delete(msg.id);
  }
}

function postToWsClient(stream, value) {
  try {
    stream.client?.postMessage(value);
  } catch {
    // The page may have navigated; nothing useful to do.
  }
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.t === 'cookie-set') {
    absorbCookie(msg.cookie);
    void broadcastCookies();
    return;
  }

  if (msg.t === 'ws-open') {
    wsStreams.set(msg.id, { client: event.source, open: false });
    connectTunnel().then(() => {
      const headers = {};
      const cookie = mergeCookies('', cookieHeader());
      if (cookie) headers.cookie = cookie;
      sendInner({ t: 'ws-open', id: msg.id, path: msg.path, protocols: msg.protocols || [], headers }).catch((error) => {
        postToWsClient(wsStreams.get(msg.id), { t: 'ws-event', id: msg.id, kind: 'error', message: error.message });
        wsStreams.delete(msg.id);
      });
    }).catch((error) => {
      postToWsClient(wsStreams.get(msg.id), { t: 'ws-event', id: msg.id, kind: 'error', message: error.message });
      wsStreams.delete(msg.id);
    });
    return;
  }

  if (msg.t === 'ws-send') {
    void sendInner({ t: 'ws-data', id: msg.id, data: msg.data });
    return;
  }

  if (msg.t === 'ws-close') {
    void sendInner({ t: 'ws-close', id: msg.id });
    wsStreams.delete(msg.id);
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (PASSTHROUGH.has(url.pathname)) return;
  event.respondWith(proxyWithRetry(event.request, event));
});

// The tunnel is one websocket over a phone network: when it drops, every
// in-flight request dies at once. A dead boot script leaves the document's
// __ModuleLoader__ queue without @deepseek-ai/dsh-client-modules, and the app
// then reports "HTML did not preload .../client.js" for a reason that has
// nothing to do with the HTML. Retry idempotent GETs once on a fresh tunnel.
const retriedRequests = new WeakSet();
async function proxyWithRetry(request, event) {
  try {
    return await proxyRequest(request, event);
  } catch (error) {
    if (request.method !== 'GET' || retriedRequests.has(request)) throw error;
    retriedRequests.add(request);
    diag('retry', { p: new URL(request.url).pathname, m: String(error && error.message).slice(0, 100) });
    return await proxyRequest(request, event);
  }
}

function isHtmlDocument(request, url) {
  if (request.mode === 'navigate' || request.destination === 'document') return true;
  // Event streams must stay uncompressed: a gzip stream is buffered until a
  // block fills, so the client sees no events and plugin activation stalls.
  if (url.pathname === '/plugins/events') return true;
  if (/\.html?$/i.test(url.pathname)) return true;
  const accept = String(request.headers.get('accept') || '');
  if (accept.includes('text/html') || accept.includes('text/event-stream')) return true;
  return request.headers.has('range');
}

let pluginsSettled = false;
let pluginsResolve = null;
const pluginsReady = new Promise((resolve) => { pluginsResolve = resolve; });
const pluginInFlight = new Set();
let pluginDone = 0;
function pluginTrack(id, path) {
  if (path.startsWith('/plugins/')) pluginInFlight.add(id);
}
function pluginFinish(id) {
  if (!pluginInFlight.delete(id)) return;
  pluginDone += 1;
  if (pluginInFlight.size === 0 && pluginDone > 0 && !pluginsSettled) {
    pluginsSettled = true;
    pluginsResolve();
  }
}

async function proxyRequest(request, event) {
  await loadJar();

  const requestUrl = new URL(request.url);
  // Documents are never served from the asset cache: one stale boot document
  // (older preload rows, older bundle ids) makes the app fail its own module
  // checks, and the cache has no way to know the host restarted since.
  if (request.method === 'GET' && requestUrl.pathname !== '/__e2e_diag' && !isHtmlDocument(request, requestUrl)) {
    try {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(new Request(requestUrl.origin + requestUrl.pathname + requestUrl.search));
      if (hit) return hit;
    } catch {}
  }

  await connectTunnel();

  const url = new URL(request.url);
  const id = nextHttpId++;
  if (url.pathname === '/__e2e_diag') diagIds.add(id);
  requestPaths.set(id, url.pathname + url.search);
  pluginTrack(id, url.pathname);

  let body = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > 0) body = toBase64(buffer);
  }

  const headers = {};
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'connection' || lower === 'content-length') continue;
    if (lower === 'accept-encoding') continue;
    headers[lower] = value;
  }
  // Prefer the browser's own cookie store when it has anything: it survives a
  // worker restart even when the IndexedDB jar came up empty.
  const cookie = mergeCookies(headers.cookie, cookieHeader());
  if (cookie) headers.cookie = cookie;
  // Browsers never expose accept-encoding to a fetch handler, so without this
  // the gateway serves every bundle raw and the tunnel carries ~3x the bytes it
  // needs to. Ask for gzip and inflate here (Chrome hands a service worker's
  // response to the page without decoding it). Documents are excluded because
  // the HTML is rewritten below, and the event stream because a gzip stream
  // buffers until a block fills instead of delivering events.
  if (isHtmlDocument(request, url)) headers['x-e2e-no-compress'] = '1';
  else headers['accept-encoding'] = 'gzip';

  const entry = { chunks: [], controller: null, ended: false, error: null, onEnd: null, startedAt: Date.now() };
  httpStreams.set(id, entry);

  const head = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHead.delete(id);
      httpStreams.delete(id);
      if (!diagIds.has(id)) diag('http-timeout', { p: url.pathname, ms: 15000 });
      reject(new Error('tunnel response timed out'));
    }, 15000);

    pendingHead.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); httpStreams.delete(id); reject(error); },
    });

    sendInner({
      t: 'http-open',
      id,
      method: request.method,
      url: url.pathname + url.search,
      headers,
      body,
    }).catch((error) => {
      pendingHead.delete(id);
      httpStreams.delete(id);
      clearTimeout(timer);
      reject(error);
    });
  });

  if (!pluginsSettled && /^\/assets\/index-[^/]+\.js$/.test(url.pathname)) {
    await new Promise((r) => setTimeout(r, 400));
    await Promise.race([pluginsReady, new Promise((r) => setTimeout(r, 10000))]);
  }

  const setCookies = normalizeSetCookie(head.headers?.['set-cookie']);
  for (const value of setCookies) absorbCookie(value);
  if (setCookies.length) void broadcastCookies();

  const out = new Headers();
  for (const [key, value] of Object.entries(head.headers || {})) {
    const lower = key.toLowerCase();
    if (lower === 'set-cookie'
      || lower === 'content-length'
      || lower === 'transfer-encoding'
      || lower === 'connection'
      || (!KEEP_CSP && (lower === 'content-security-policy' || lower === 'content-security-policy-report-only'))) continue;
    try {
      out.set(key, Array.isArray(value) ? value.join(', ') : String(value));
    } catch {}
  }

  const contentType = String(head.headers?.['content-type'] || '');
  if (/text\/html/i.test(contentType)) {
    let bytes;
    try {
      bytes = await collectHtml(id, entry);
    } catch (error) {
      diag('html-timeout', { p: url.pathname, m: String(error && error.message).slice(0, 100) });
      if (!retriedRequests.has(request)) throw error;
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>DSH</title><p style="font:15px/1.6 -apple-system,system-ui;padding:24px">' +
        '连接中断，<a href="/go.html">重新进入</a></p>',
        { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
      );
    }
    let html = new TextDecoder().decode(bytes);
    if (!KEEP_CSP) html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
    if (INJECT_MODE !== 'none' && !html.includes('/cookie-shim.js')) {
      const jarJson = JSON.stringify(Object.fromEntries(cookieJar)).replace(/</g, '\\u003c');
      let inject = '<script>window.__DSH_COOKIE_JAR__=' + jarJson + ';</script>'
        + '<script src="/cookie-shim.js"></script>';
      if (INJECT_MODE === 'full') {
        // The diag tap is opt-in: it fires a request per event through the very
        // tunnel that is booting, which measurably slows the boot down.
        if (DIAG_ON) inject = DIAG_SCRIPT + inject;
        inject += '<script src="/ws-shim.js"></script>';
      }
      inject += '<style>' + LAYOUT_CSS + '</style>';
      inject += DRAWER_JS;
      inject += PAIR_HINT_JS;
      if (html.includes('</head>')) html = html.replace('</head>', inject + '</head>');
      else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (tag) => tag + inject);
      else html = inject + html;
    }
    return new Response(new TextEncoder().encode(html), {
      status: head.status || 200,
      statusText: head.statusText || '',
      headers: out,
    });
  }

  let stream = new ReadableStream({
    start(controller) {
      entry.controller = controller;
      for (const chunk of entry.chunks) {
        try { controller.enqueue(chunk); } catch {}
      }
      entry.chunks = [];
      if (entry.ended) {
        try { controller.close(); } catch {}
        httpStreams.delete(id);
      } else if (entry.error) {
        try { controller.error(new Error(entry.error)); } catch {}
        httpStreams.delete(id);
      }
    },
    cancel() {
      void sendInner({ t: 'http-cancel', id });
      httpStreams.delete(id);
    },
  });

  const contentTypeHeader = String(head.headers?.['content-type'] || '');
  const cacheable = !NO_CACHE
    && request.method === 'GET'
    && !url.pathname.startsWith('/__e2e_diag')
    && !/text\/html/i.test(contentTypeHeader)
    && !/text\/event-stream/i.test(contentTypeHeader)
    && !/no-store/i.test(String(head.headers?.['cache-control'] || ''));

  // Chrome hands service-worker responses to the page without decoding
  // content-encoding, so a gzip body would reach <script> as raw bytes.
  const encoding = String(out.get('content-encoding') || '').toLowerCase();
  if (encoding === 'gzip' || encoding === 'deflate') {
    try {
      stream = stream.pipeThrough(new DecompressionStream(encoding));
      out.delete('content-encoding');
      out.delete('content-length');
    } catch (error) {
      diag('decode-fail', { p: url.pathname, m: String(error && error.message).slice(0, 120) });
    }
  }

  if (url.pathname === '/plugins/events') {
    try {
      stream = stream.pipeThrough(createSseGraphFilter());
    } catch (error) {
      diag('graph-filter-fail', { m: String(error && error.message).slice(0, 120) });
    }
  }

  // A boot script has to arrive whole: a partial one is dropped by the browser,
  // its registration never reaches __ModuleLoader__, and the app then reports
  // "HTML did not preload .../client.js" for a reason that has nothing to do
  // with the HTML. Documents keep streaming: the gateway can hold a body open
  // long past its last byte, and buffering a navigation would turn that into a
  // page that never paints.
  if (request.destination === 'script') {
    try {
      const body = await Promise.race([
        new Response(stream).arrayBuffer(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('body timeout')), 20000)),
      ]);
      const whole = new Response(body, {
        status: head.status || 200,
        statusText: head.statusText || '',
        headers: out,
      });
      // Buffering must not cost the asset cache its entries: a script that is
      // fetched whole is exactly what a warm boot wants to replay.
      if (cacheable && whole.ok) {
        let copy = null;
        try { copy = whole.clone(); } catch {}
        if (copy) {
          const write = (async () => {
            try {
              const cache = await caches.open(ASSET_CACHE);
              await cache.put(new Request(url.origin + url.pathname + url.search), copy);
            } catch {}
          })();
          try { event?.waitUntil(write); } catch {}
        }
      }
      return whole;
    } catch (error) {
      diag('script-truncated', { p: url.pathname, m: String(error && error.message).slice(0, 120) });
      // Let proxyWithRetry take one more pass on a fresh tunnel before the page
      // is left with a hole in its module list.
      throw error;
    }
  }

  const response = new Response(stream, {
    status: head.status || 200,
    statusText: head.statusText || '',
    headers: out,
  });

  if (cacheable && response.ok) {
    // The clone must happen synchronously: once this response is returned the
    // page starts reading and a late clone() throws "body is already used".
    let copy = null;
    try { copy = response.clone(); } catch {}
    if (copy) {
      const write = (async () => {
        try {
          const cache = await caches.open(ASSET_CACHE);
          await cache.put(new Request(url.origin + url.pathname + url.search), copy);
        } catch {}
      })();
      try { event?.waitUntil(write); } catch {}
    }
  }

  return response;
}

// The gateway's /plugins/events stream carries the *stock desktop* plugin
// graph (rev e1934a37b70b), while the mobile document boots from a projected
// graph (rev e3e7036bbb49a5d7). The client treats the revision change as a
// replacement tree: it disposes every plugin entry (tearing down the 'root'
// slot the mobile layout registered) and re-applies the desktop set. The shell
// renders inside that window, so RootOutlet sees an empty registry and throws
// SlotAssemblyError -> blank page. Dropping the graph frames keeps the boot
// tree authoritative; every other event (heartbeats, job/session updates)
// passes through untouched.
const graphDrops = { n: 0 };

function isGraphFrame(frame) {
  const match = /(?:^|\n)data:[ \t]*(.*)$/m.exec(frame);
  if (!match) return false;
  const payload = match[1].trim();
  if (!payload.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(payload);
    if (parsed && parsed.type === 'graph') {
      graphDrops.n += 1;
      if (graphDrops.n === 1) diag('graph-drop', { rev: parsed.graph && parsed.graph.rev, n: payload.length });
      return true;
    }
  } catch {}
  return false;
}

function createSseGraphFilter() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (!isGraphFrame(frame)) controller.enqueue(encoder.encode(frame + '\n\n'));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0 && !isGraphFrame(buffer)) controller.enqueue(encoder.encode(buffer));
    },
  });
}

function collectHtml(id, entry) {
  return new Promise((resolve, reject) => {
    // The head can arrive and the body never follow: a half-open tunnel leaves
    // the navigation loading forever with nothing the user can act on. Fail the
    // document instead, so proxyWithRetry can take another pass on a fresh one.
    const timer = setTimeout(() => {
      if (entry.onEnd === finish) entry.onEnd = null;
      httpStreams.delete(id);
      reject(new Error('html body timed out'));
    }, 15000);
    const finish = () => {
      clearTimeout(timer);
      httpStreams.delete(id);
      if (entry.error) reject(new Error(entry.error));
      else resolve(concatBytes(entry.chunks));
    };
    if (entry.ended || entry.error) {
      finish();
      return;
    }
    entry.onEnd = finish;
  });
}

function concatBytes(chunks) {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function normalizeSetCookie(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value) return [value];
  return [];
}

function absorbCookie(value) {
  if (typeof value !== 'string') return;
  const first = value.split(';')[0];
  const equals = first.indexOf('=');
  if (equals <= 0) return;
  const name = first.slice(0, equals).trim();
  const cookieValue = first.slice(equals + 1).trim();
  if (!name) return;
  if (/max-age=0/i.test(value) || /expires=thu, 01 jan 1970/i.test(value)) cookieJar.delete(name);
  else cookieJar.set(name, cookieValue);
  saveJarSoon();
}

function cookieHeader() {
  return [...cookieJar].map(([name, value]) => name + '=' + value).join('; ');
}

async function broadcastCookies() {
  const jar = Object.fromEntries(cookieJar);
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) {
    try { client.postMessage({ t: 'cookie-jar', jar }); } catch {}
  }
}

function sameJwk(a, b) {
  return Boolean(a && b && a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y);
}

function transcriptString(clientEph, hostEph, token, clientNonce, hostNonce) {
  return [
    'v1',
    clientEph.x,
    clientEph.y,
    hostEph.x,
    hostEph.y,
    token,
    clientNonce,
    hostNonce,
  ].join('|');
}

function makeNonceBytes(prefix, counter) {
  const nonce = new Uint8Array(12);
  nonce.set(prefix.slice(0, 4));
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter));
  return nonce;
}

function b64urlDecode(value) {
  return new TextDecoder().decode(fromBase64url(value));
}

function toBase64url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value) {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// A device pairs once; afterwards the shell must not walk the one-time pairing
// link again. Asking the gateway to renew the session is both the check and the
// refresh: 200 means this device still holds a live device cookie.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.t !== 'e2e-session') return;
  const port = event.ports && event.ports[0];
  const reply = (ok) => {
    try { if (port) port.postMessage({ t: 'e2e-session', ok }); } catch {}
  };
  (async () => {
    try {
      await connectTunnel();
      const request = new Request(self.location.origin + '/mobile-access/auth/renew', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const response = await proxyRequest(request, null);
      reply(response.ok);
    } catch {
      reply(false);
    }
  })();
});
