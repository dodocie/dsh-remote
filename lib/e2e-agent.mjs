/**
 * Desktop side of the E2E tunnel.
 *
 * The relay pairs this socket with the shell socket for the same device. The
 * agent holds the host static key (pinned by the shell link), performs the
 * handshake, and only then forwards decrypted HTTP/WS traffic to dsh-mobile.
 *
 * The relay sees hello / hello-ack / encrypted records only.
 */

import http from 'node:http';
import { appendFileSync } from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import {
  generateHostIdentity,
  generateEphemeral,
  transcript,
  signTranscript,
  deriveKeys,
  makeNonce,
  encryptGcm,
  decryptGcm,
  base64url,
  fromBase64url,
} from './e2e-protocol.mjs';

const DEBUG_LOG = process.env.DSH_E2E_LOG || '/tmp/dsh-e2e-agent.log';
// Each tunnel frame costs a round trip that is dominated by pacing, not by
// bandwidth (~250 KB/s per stream at 64 KB frames). Coalescing the response
// body into ~half-megabyte frames cuts the frame count of a boot batch by an
// order of magnitude; event streams must never wait for a flush.
const FLUSH_BYTES = Math.max(64 * 1024, Number(process.env.DSH_E2E_FLUSH_BYTES || 512 * 1024));
const FLUSH_MS = Math.max(0, Number(process.env.DSH_E2E_FLUSH_MS || 40));
function debugLog(event, fields = {}) {
  try {
    appendFileSync(DEBUG_LOG, JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n');
  } catch {}
}

function publicJwkOf(privateKey) {
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

function hostIdentityFromJwk(jwk) {
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  return { privateKey, jwk: publicJwkOf(privateKey) };
}

export class E2EAgent {
  constructor(options = {}) {
    this.relayUrl = options.relayUrl;
    this.token = options.token;
    this.pairingToken = options.pairingToken;
    this.backendUrl = new URL(options.backendUrl || 'http://127.0.0.1:3444');
    this.shellOrigin = String(options.shellOrigin || '');
    this.logger = options.logger || console;
    this.insecure = options.insecure === true;
    this.host = options.hostKey ? hostIdentityFromJwk(options.hostKey) : generateHostIdentity();

    this.ws = null;
    this.keys = null;
    this.sendCounter = 0;
    this.recvCounter = 0;
    this.httpRequests = new Map();
    this.wsStreams = new Map();
    this.stopped = false;
    this.retryMs = 500;
    this.retryTimer = null;
    this.startedAt = 0;
    this.lastError = null;

    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  get publicJwk() {
    return this.host.jwk;
  }

  get connected() {
    return Boolean(this.ws && this.ws.readyState === 1);
  }

  get streams() {
    return this.httpRequests;
  }

  start() {
    this.stopped = false;
    this.connect();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.closeStreams();
    if (this.ws) {
      try { this.ws.close(1000, 'agent_stopped'); } catch {}
      this.ws = null;
    }
    this.keys = null;
  }

  status() {
    return {
      connected: Boolean(this.ws && this.ws.readyState === 1),
      hostKey: this.host.jwk,
      lastError: this.lastError,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  connect() {
    if (this.stopped) return;
    const url = new URL(this.relayUrl);
    // Keep an explicit ws:/wss: URL as-is; map http(s): for convenience.
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';

    const headers = { Authorization: 'Bearer ' + this.token };
    const ws = new WebSocket(url, {
      headers,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
      followRedirects: false,
      rejectUnauthorized: !this.insecure,
    });
    this.ws = ws;

    ws.on('open', () => {
      // Nagle + a 150ms RTT turns one frame per chunk into 150ms per chunk.
      try { ws._socket?.setNoDelay(true); } catch {}
      this.startedAt = Date.now();
      this.lastError = null;
      this.retryMs = 500;
      this.logger.info?.('e2e-agent: connected to relay');
      debugLog('agent-open');
      this.resolveReady();
    });

    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        this.onMessage(message);
      } catch (error) {
        this.lastError = error.message;
        this.logger.warn?.('e2e-agent: message failed: ' + error.message);
        try { ws.close(4002, 'message_failed'); } catch {}
      }
    });

    ws.on('close', (code, reason) => {
      debugLog('agent-close', { code, reason: reason?.toString() || '' });
      if (this.ws === ws) this.ws = null;
      this.keys = null;
      this.closeStreams();
      if (!this.stopped) {
        this.lastError = 'relay closed (' + code + (reason?.length ? ': ' + reason.toString() : '') + ')';
        this.scheduleReconnect();
      }
    });

    ws.on('error', (error) => {
      debugLog('agent-error', { message: error.message });
      this.lastError = error.message;
      this.logger.warn?.('e2e-agent: socket error: ' + error.message);
      if (this.ws === ws && ws.readyState !== 1) this.rejectReady(error);
    });

    ws.on('unexpected-response', (request, response) => {
      this.lastError = 'relay rejected agent handshake: HTTP ' + response.statusCode;
      this.logger.error?.('e2e-agent: ' + this.lastError);
      response.resume();
      try { ws.terminate(); } catch {}
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    if (this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  closeStreams() {
    for (const request of this.httpRequests.values()) {
      try { request.destroy(); } catch {}
    }
    this.httpRequests.clear();
    for (const target of this.wsStreams.values()) {
      try { target.terminate(); } catch {}
    }
    this.wsStreams.clear();
  }

  onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.t === 'hello') {
      this.onHello(message);
      return;
    }
    if (message.t === 'enc') {
      this.onEncrypted(message);
      return;
    }
    if (message.t === 'ping') {
      // Liveness probe from the page's Service Worker. The relay only routes
      // this frame; the desktop never touches backend state for it.
      this.sendPlain({ t: 'pong', at: message.at ?? null });
      return;
    }
    if (message.t === 'reset') {
      // The relay only sends this when the phone's shell leg has closed and no
      // replacement is connected. The shell is gone, so every backend request
      // and WebSocket it opened must be torn down; otherwise the DSH mux socket
      // survives with no reader and the next foreground page looks connected
      // while it is not.
      debugLog('agent-reset', { reason: message.reason || '' });
      this.closeStreams();
    }
  }

  onHello(message) {
    if (!message || message.v !== 1 || message.token !== this.pairingToken) {
      try { this.ws?.close(4001, 'bad_token'); } catch {}
      return;
    }
    if (!message.clientEph || typeof message.clientNonce !== 'string') {
      try { this.ws?.close(4002, 'bad_hello'); } catch {}
      return;
    }

    this.closeStreams();
    this.keys = null;
    this.sendCounter = 0;
    this.recvCounter = 0;

    const ephemeral = generateEphemeral();
    const hostNonce = base64url(crypto.randomBytes(16));
    const text = transcript(message.clientEph, ephemeral.jwk, this.pairingToken, message.clientNonce, hostNonce);

    let shared;
    try {
      const clientPublic = crypto.createPublicKey({ key: message.clientEph, format: 'jwk' });
      shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: clientPublic });
    } catch {
      try { this.ws?.close(4003, 'bad_client_key'); } catch {}
      return;
    }

    this.keys = deriveKeys(shared, text);
    const signature = signTranscript(this.host.privateKey, text);
    this.sendPlain({
      t: 'hello-ack',
      v: 1,
      hostEph: ephemeral.jwk,
      hostStatic: this.host.jwk,
      hostNonce,
      sig: base64url(signature),
      // Advertise the application-level ping/pong used by the Service Worker
      // to tell a live tunnel from a half-open one after a phone suspend.
      heartbeat: 1,
    });
  }

  onEncrypted(message) {
    if (!this.keys) throw new Error('no session keys');
    if (message.n !== this.recvCounter) throw new Error('unexpected e2e counter');
    const nonce = makeNonce(this.keys.c2sPrefix, message.n);
    const aad = Buffer.from('e2e|c2s|' + message.n);
    const plaintext = decryptGcm(this.keys.c2sKey, nonce, aad, fromBase64url(message.d));
    this.recvCounter += 1;
    this.onInner(JSON.parse(plaintext.toString('utf8')));
  }

  sendPlain(value) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(value));
    } else {
      this.lastError = 'relay socket is not open';
    }
  }

  sendInner(value) {
    if (!this.keys || !this.ws || this.ws.readyState !== 1) return;
    const n = this.sendCounter;
    this.sendCounter += 1;
    const nonce = makeNonce(this.keys.s2cPrefix, n);
    const aad = Buffer.from('e2e|s2c|' + n);
    const ciphertext = encryptGcm(this.keys.s2cKey, nonce, aad, Buffer.from(JSON.stringify(value)));
    this.sendPlain({ t: 'enc', n, d: base64url(ciphertext) });
  }

  onInner(message) {
    if (message.t === 'http-open') {
      this.onHttpOpen(message);
      return;
    }
    if (message.t === 'http-cancel') {
      const request = this.httpRequests.get(message.id);
      if (request) request.destroy();
      this.httpRequests.delete(message.id);
      return;
    }
    if (message.t === 'ws-open') {
      this.onWsOpen(message);
      return;
    }
    if (message.t === 'ws-data') {
      const target = this.wsStreams.get(message.id);
      if (target && target.readyState === 1) target.send(message.data);
      return;
    }
    if (message.t === 'ws-close') {
      const target = this.wsStreams.get(message.id);
      if (target) target.close();
      this.wsStreams.delete(message.id);
    }
  }

  onHttpOpen(message) {
    const headers = { ...(message.headers || {}) };
    delete headers.host;
    delete headers.origin;
    headers.host = new URL(this.shellOrigin).host;
    headers.origin = this.shellOrigin;
    headers['x-dsh-remote-e2e'] = 'agent';
    if (headers['x-e2e-no-compress']) delete headers['accept-encoding'];
    else headers['accept-encoding'] = 'gzip, br';
    delete headers['x-e2e-no-compress'];

    const body = message.body ? Buffer.from(message.body, 'base64') : null;
    debugLog('http-open', {
      id: message.id,
      method: message.method,
      url: message.url,
      cookieLength: headers.cookie ? String(headers.cookie).length : 0,
      origin: headers.origin,
      host: headers.host,
      bodyLength: body ? body.length : 0,
    });
    const transport = this.backendUrl.protocol === 'https:' ? https : http;
    const request = transport.request({
      host: this.backendUrl.hostname,
      port: this.backendUrl.port || (this.backendUrl.protocol === 'https:' ? 443 : 80),
      method: message.method,
      path: message.url,
      headers,
    }, (response) => {
      const startedAt = Date.now();
      let firstChunkAt = 0;
      const watchBody = String(message.url).includes('/auth/pair');
      let watchedBody = '';
      debugLog('http-head', { id: message.id, url: message.url, status: response.statusCode });
      const outHeaders = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (key === 'set-cookie') continue;
        outHeaders[key] = value;
      }
      if (response.headers['set-cookie']) outHeaders['set-cookie'] = response.headers['set-cookie'];

      this.sendInner({
        t: 'http-head',
        id: message.id,
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: outHeaders,
      });
      const streamResponse = /text\/event-stream/i.test(String(response.headers['content-type'] || ''));
      let pending = [];
      let pendingBytes = 0;
      let flushTimer = null;
      const flush = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (!pendingBytes) return;
        const merged = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        this.sendInner({ t: 'http-chunk', id: message.id, data: merged.toString('base64') });
      };
      response.on('data', (chunk) => {
        if (!firstChunkAt) firstChunkAt = Date.now();
        if (watchBody && watchedBody.length < 2000) watchedBody += chunk.toString('utf8');
        if (streamResponse) {
          this.sendInner({ t: 'http-chunk', id: message.id, data: chunk.toString('base64') });
          return;
        }
        pending.push(chunk);
        pendingBytes += chunk.length;
        if (pendingBytes >= FLUSH_BYTES) {
          flush();
        } else {
          // Debounce, not a fixed deadline: a fast-gushing body keeps
          // resetting the timer and coalesces to FLUSH_BYTES, while a
          // trickling stream (the mux, long polls) still leaves within
          // FLUSH_MS of silence. A fixed deadline flushed ~27 KB frames
          // mid-stream, and every frame costs about one round trip.
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = setTimeout(flush, FLUSH_MS);
        }
      });
      response.on('end', () => {
        flush();
        if (Date.now() - startedAt > 1200) {
          debugLog('http-pace', {
            id: message.id,
            url: String(message.url).slice(0, 60),
            enc: response.headers['content-encoding'] || '',
            first: firstChunkAt ? firstChunkAt - startedAt : -1,
            total: Date.now() - startedAt,
            bytes: Number(response.headers['content-length'] || 0),
          });
        }
        if (watchBody) debugLog('http-pair', { id: message.id, status: response.statusCode, body: watchedBody.slice(0, 1500) });
        this.sendInner({ t: 'http-end', id: message.id });
      });
      response.on('error', (error) => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        debugLog('http-error', { id: message.id, url: message.url, message: error.message });
        this.sendInner({ t: 'http-error', id: message.id, message: error.message });
      });
    });

    this.httpRequests.set(message.id, request);
    request.on('error', (error) => {
      debugLog('http-request-error', { id: message.id, url: message.url, message: error.message });
      this.httpRequests.delete(message.id);
      this.sendInner({ t: 'http-error', id: message.id, message: error.message });
    });
    request.on('close', () => this.httpRequests.delete(message.id));
    if (body && body.length) request.write(body);
    request.end();
  }

  onWsOpen(message) {
    const wsProtocol = this.backendUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const targetUrl = wsProtocol + '//' + this.backendUrl.host + message.path;
    const headers = {
      host: new URL(this.shellOrigin).host,
      origin: this.shellOrigin,
    };
    for (const [key, value] of Object.entries(message.headers || {})) {
      const lower = String(key).toLowerCase();
      if (lower === 'host' || lower === 'origin') continue;
      headers[lower] = value;
    }
    const options = { headers };
    debugLog('ws-open', {
      id: message.id,
      path: message.path,
      cookieLength: headers.cookie ? String(headers.cookie).length : 0,
      headers: Object.keys(headers),
    });
    const target = Array.isArray(message.protocols) && message.protocols.length > 0
      ? new WebSocket(targetUrl, message.protocols, options)
      : new WebSocket(targetUrl, options);

    this.wsStreams.set(message.id, target);
    target.on('open', () => {
      debugLog('ws-connected', { id: message.id, path: message.path });
      this.sendInner({ t: 'ws-open', id: message.id, ok: true, protocol: target.protocol });
    });
    target.on('message', (data) => this.sendInner({ t: 'ws-data', id: message.id, data: data.toString() }));
    target.on('close', (code, reason) => {
      debugLog('ws-closed', { id: message.id, path: message.path, code, reason: reason.toString() });
      this.wsStreams.delete(message.id);
      this.sendInner({ t: 'ws-close', id: message.id, code, reason: reason.toString() });
    });
    target.on('error', (error) => {
      debugLog('ws-error', { id: message.id, path: message.path, message: error.message });
      this.sendInner({ t: 'ws-error', id: message.id, message: error.message });
    });
  }
}

export function createE2EAgent(options) {
  return new E2EAgent(options);
}