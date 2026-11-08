/**
 * dsh-remote-agent — the desktop side of the relay.
 *
 * Holds an outbound WebSocket to the relay and replays incoming HTTP /
 * WebSocket traffic to the local DSH Mobile origin (default 127.0.0.1:3444).
 * No public inbound port, DNS record, or TLS certificate is needed on the
 * desktop.
 */

import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { FRAME, encodeFrame, decodeFrame, encodeJson, decodeJson, isOpen } from './protocol.mjs';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function filterResponseHeaders(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function normalizeRequestPath(url) {
  if (!url) return '/';
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  }
  return url;
}

export class RelayAgent extends EventEmitter {
  constructor(options) {
    super();
    this.relayUrl = options.relayUrl;
    this.deviceId = options.deviceId;
    this.token = options.token;
    this.backendUrl = options.backendUrl || 'http://127.0.0.1:3444';
    this.logger = options.logger || console;
    this.backend = new URL(this.backendUrl);
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
    this.streams = new Map();
    this.ws = null;
    this.stopped = false;
    this.connected = false;
    this.lastError = null;
    this.lastErrorHint = null;
    this.retryMs = 1000;
    this.retryTimer = null;
    this.startedAt = 0;
  }

  get publicUrl() {
    return this.relayUrl.replace(/\/$/, '');
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
    for (const id of [...this.streams.keys()]) this.closeStream(id);
    if (this.ws) {
      try { this.ws.close(1000, 'agent_stopped'); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  status() {
    return {
      connected: this.connected,
      deviceId: this.deviceId,
      backendUrl: this.backendUrl,
      relayUrl: this.relayUrl,
      lastError: this.lastError,
      lastErrorHint: this.lastErrorHint,
      streams: this.streams.size,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  connect() {
    if (this.stopped) return;
    let url;
    try {
      url = new URL(this.relayUrl);
    } catch (error) {
      this.lastError = `invalid relay URL: ${error.message}`;
      this.scheduleReconnect();
      return;
    }
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/agent';
    url.search = `?device=${encodeURIComponent(this.deviceId)}`;

    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
      followRedirects: false,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.lastError = null;
      this.lastErrorHint = null;
      this.retryMs = 1000;
      this.startedAt = Date.now();
      this.logger.info?.(`relay-agent: online as ${this.deviceId}`);
      this.emit('online');
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const frame = decodeFrame(data);
      if (frame) this.onFrame(frame);
    });

    ws.on('close', (code, reason) => {
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      if (!this.stopped) {
        this.lastError = `relay connection closed (${code}${reason?.length ? ': ' + reason.toString() : ''})`;
        this.lastErrorHint = networkHint(this.relayUrl, this.lastError);
        this.logger.warn?.(`relay-agent: ${this.lastError}`);
        this.rejectAllStreams('relay_disconnected');
        this.scheduleReconnect();
      }
      if (wasConnected) this.emit('offline', code);
    });

    ws.on('error', (error) => {
      this.lastError = error.message;
      this.lastErrorHint = networkHint(this.relayUrl, error.message);
      this.logger.warn?.(`relay-agent: socket error: ${error.message}`);
    });

    ws.on('unexpected-response', (request, response) => {
      this.lastError = `relay rejected agent handshake: HTTP ${response.statusCode}`;
      this.logger.error?.(`relay-agent: ${this.lastError}`);
      response.resume();
      try { ws.terminate(); } catch {}
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(this.retryMs, 30_000) + Math.floor(Math.random() * 500);
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  send(type, streamId, payload) {
    if (!isOpen(this.ws)) return false;
    try {
      this.ws.send(encodeFrame(type, streamId, payload), { binary: true });
      return true;
    } catch (error) {
      this.logger.warn?.(`relay-agent: send failed: ${error.message}`);
      return false;
    }
  }

  sendJson(type, streamId, value) {
    return this.send(type, streamId, encodeJson(value));
  }

  onFrame(frame) {
    if (process.env.DEBUG_RELAY) this.logger.info?.(`agent[dbg]: frame type=${frame.type} id=${frame.streamId} len=${frame.payload.length}`);
    switch (frame.type) {
      case FRAME.OPEN:
        this.openStream(frame.streamId, decodeJson(frame.payload));
        break;
      case FRAME.DATA:
        this.onRequestBody(frame.streamId, frame.payload);
        break;
      case FRAME.REQ_END:
        this.onRequestEnd(frame.streamId);
        break;
      case FRAME.CLOSE:
        this.closeStream(frame.streamId);
        break;
      case FRAME.WS_DATA:
        this.onWebSocketData(frame.streamId, frame.payload);
        break;
      default:
        break;
    }
  }

  openStream(streamId, open) {
    if (open.kind === 'http') {
      this.openHttpStream(streamId, open);
    } else if (open.kind === 'ws') {
      this.openWebSocketStream(streamId, open);
    } else {
      this.sendJson(FRAME.ERROR, streamId, { message: 'unsupported_stream_kind' });
    }
  }

  openHttpStream(streamId, open) {
    const headers = { ...open.headers };
    delete headers.expect;
    delete headers['proxy-connection'];
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];

    const transport = this.backend.protocol === 'https:' ? https : http;
    let request;
    try {
      request = transport.request({
        host: this.backend.hostname,
        port: this.backend.port || (this.backend.protocol === 'https:' ? 443 : 80),
        method: open.method,
        path: normalizeRequestPath(open.url),
        headers,
        agent: this.backend.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
      }, (response) => {
        const stream = this.streams.get(streamId);
        if (!stream) {
          response.resume();
          return;
        }
        this.sendJson(FRAME.RESPONSE, streamId, {
          status: response.statusCode,
          statusText: response.statusMessage,
          headers: filterResponseHeaders(response.headers),
        });
        response.on('data', (chunk) => {
          if (!this.streams.has(streamId)) return;
          this.send(FRAME.DATA, streamId, chunk);
        });
        response.on('end', () => {
          this.send(FRAME.RES_END, streamId, null);
          this.streams.delete(streamId);
        });
        response.on('error', (error) => {
          this.send(FRAME.ERROR, streamId, encodeJson({ message: error.message }));
          this.streams.delete(streamId);
        });
      });
    } catch (error) {
      this.sendJson(FRAME.ERROR, streamId, { message: error.message });
      return;
    }

    const stream = { kind: 'http', request, response: null, closed: false };
    this.streams.set(streamId, stream);

    request.on('error', (error) => {
      if (!this.streams.has(streamId)) return;
      this.sendJson(FRAME.ERROR, streamId, { message: error.message });
      this.streams.delete(streamId);
    });
  }

  onRequestBody(streamId, payload) {
    const stream = this.streams.get(streamId);
    if (!stream || stream.kind !== 'http' || stream.closed) return;
    try {
      stream.request.write(payload);
    } catch (error) {
      this.sendJson(FRAME.ERROR, streamId, { message: error.message });
      this.closeStream(streamId);
    }
  }

  onRequestEnd(streamId) {
    const stream = this.streams.get(streamId);
    if (!stream || stream.kind !== 'http' || stream.closed) return;
    try {
      stream.request.end();
    } catch (error) {
      this.sendJson(FRAME.ERROR, streamId, { message: error.message });
      this.closeStream(streamId);
    }
  }

  openWebSocketStream(streamId, open) {
    const base = new URL(this.backendUrl);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    let target;
    try {
      target = new URL(open.url, base);
    } catch (error) {
      this.sendJson(FRAME.ERROR, streamId, { message: error.message });
      return;
    }

    const headers = { ...open.headers };
    delete headers.connection;
    delete headers.upgrade;
    delete headers['sec-websocket-key'];
    delete headers['sec-websocket-version'];
    delete headers['sec-websocket-extensions'];
    delete headers['sec-websocket-accept'];
    delete headers['proxy-connection'];

    let client;
    try {
      client = new WebSocket(target, {
        headers,
        perMessageDeflate: false,
        handshakeTimeout: 15_000,
        followRedirects: false,
      });
    } catch (error) {
      this.sendJson(FRAME.ERROR, streamId, { message: error.message });
      return;
    }

    const stream = {
      kind: 'ws',
      client,
      upgraded: false,
      open: false,
      queue: [],
      queueBytes: 0,
      closed: false,
    };
    this.streams.set(streamId, stream);

    client.on('upgrade', (response) => {
      stream.upgraded = true;
      this.sendJson(FRAME.RESPONSE, streamId, {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: filterResponseHeaders(response.headers),
      });
    });

    client.on('open', () => {
      stream.open = true;
      for (const message of stream.queue.splice(0)) {
        this.sendFrameToClient(streamId, message.data, message.binary);
      }
      stream.queueBytes = 0;
    });

    client.on('message', (data, isBinary) => {
      if (!this.streams.has(streamId)) return;
      if (process.env.DEBUG_RELAY) this.logger.info?.(`agent[dbg]: backend ws message isBinary=${isBinary} len=${data.length}`);
      const flag = isBinary ? 2 : 1;
      this.send(FRAME.WS_DATA, streamId, Buffer.concat([Buffer.from([flag]), Buffer.from(data)]));
    });

    client.on('close', (code, reason) => {
      if (!this.streams.has(streamId)) return;
      this.sendJson(FRAME.CLOSE, streamId, { code, reason: reason?.toString() || '' });
      this.streams.delete(streamId);
    });

    client.on('error', (error) => {
      if (!stream.upgraded) {
        this.sendJson(FRAME.ERROR, streamId, { message: error.message });
        this.streams.delete(streamId);
      }
    });

    client.on('unexpected-response', (request, response) => {
      stream.upgraded = true;
      this.sendJson(FRAME.RESPONSE, streamId, {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: filterResponseHeaders(response.headers),
      });
      response.on('data', (chunk) => {
        if (!this.streams.has(streamId)) return;
        this.send(FRAME.DATA, streamId, chunk);
      });
      response.on('end', () => {
        this.send(FRAME.RES_END, streamId, null);
        this.streams.delete(streamId);
      });
    });
  }

  onWebSocketData(streamId, payload) {
    const stream = this.streams.get(streamId);
    if (!stream || stream.kind !== 'ws' || stream.closed) return;
    const flag = payload.length > 0 ? payload[0] : 1;
    const data = payload.subarray(1);
    if (process.env.DEBUG_RELAY) this.logger.info?.(`agent[dbg]: relay ws data flag=${flag} len=${data.length} open=${stream.open}`);
    if (stream.open && clientOpen(stream.client)) {
      this.sendFrameToClient(streamId, data, flag === 2);
      return;
    }
    if (stream.queueBytes + data.length > 1024 * 1024) {
      this.sendJson(FRAME.CLOSE, streamId, { code: 1013, reason: 'agent_queue_full' });
      this.closeStream(streamId);
      return;
    }
    stream.queue.push({ data: Buffer.from(data), binary: flag === 2 });
    stream.queueBytes += data.length;
  }

  sendFrameToClient(streamId, data, binary) {
    const stream = this.streams.get(streamId);
    if (!stream || stream.kind !== 'ws' || !clientOpen(stream.client)) return;
    try {
      stream.client.send(data, { binary });
    } catch (error) {
      this.sendJson(FRAME.ERROR, streamId, { message: error.message });
      this.closeStream(streamId);
    }
  }

  closeStream(streamId) {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    stream.closed = true;
    this.streams.delete(streamId);
    if (stream.kind === 'http') {
      try { stream.request.destroy(); } catch {}
    } else if (stream.kind === 'ws') {
      try { stream.client.terminate(); } catch {}
    }
  }

  rejectAllStreams(reason) {
    for (const [streamId, stream] of [...this.streams.entries()]) {
      if (stream.kind === 'http') {
        try { stream.request.destroy(new Error(reason)); } catch {}
      } else {
        try { stream.client.terminate(); } catch {}
      }
      this.streams.delete(streamId);
    }
  }
}

function clientOpen(client) {
  return client != null && client.readyState === 1;
}

function networkHint(relayUrl, message) {
  if (!/TLS|socket disconnected|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message || '')) return null;
  let host = 'relay host';
  try { host = new URL(relayUrl).hostname; } catch {}
  return `本机若开着 Clash/FlClash/Surge 等代理，请把 ${host} 加入 DIRECT 规则，或暂时关闭 TUN 模式。`;
}

export function createAgent(options) {
  return new RelayAgent(options);
}
