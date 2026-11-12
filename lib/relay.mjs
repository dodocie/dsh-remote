/**
 * dsh-remote-relay — a small, self-hostable relay for DSH Mobile.
 *
 * The relay terminates public HTTPS (normally behind Caddy) and exposes one
 * stable subdomain per desktop device. The desktop agent keeps an outbound
 * WebSocket to the relay; the relay multiplexes HTTP and WebSocket streams
 * over that connection. No inbound port is required on the desktop.
 */

import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WebSocketServer } from 'ws';
import { FRAME, encodeFrame, decodeFrame, encodeJson, decodeJson, isOpen } from './protocol.mjs';

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
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
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;
const MAX_JSON_BODY = 16 * 1024;
const MAX_WS_ERROR_BODY = 1024 * 1024;
// Phone shells are Service Workers: routinely frozen while the tab is alive, so
// a single unanswered protocol ping says nothing. ~1 minute of silence does.
const E2E_SHELL_MISSED_PINGS = 4;

function randomId(length = 10) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

function randomToken() {
  return randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function stripPort(hostHeader) {
  if (!hostHeader) return '';
  const value = String(hostHeader).trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(value.slice(colon + 1))) return value.slice(0, colon);
  return value;
}

function deviceIdFromHost(hostHeader, baseDomain, devDomains) {
  const host = stripPort(hostHeader);
  if (!host || host === baseDomain) return null;
  const domains = [baseDomain, ...(devDomains || [])];
  for (const domain of domains) {
    if (!domain) continue;
    if (host.endsWith('.' + domain)) {
      const label = host.slice(0, -(domain.length + 1));
      if (label && !label.includes('.') && /^[a-z0-9]+$/.test(label)) return label;
    }
  }
  return null;
}

function filterRequestHeaders(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function filterResponseHeaders(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function filterWebSocketHeaders(input) {
  const out = filterRequestHeaders(input);
  delete out['sec-websocket-key'];
  delete out['sec-websocket-version'];
  delete out['sec-websocket-extensions'];
  delete out['sec-websocket-accept'];
  return out;
}

function writeJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function writeText(res, status, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function writeRawResponse(socket, status, statusText, headers, body) {
  if (!socket || socket.destroyed) return;
  const lines = [`HTTP/1.1 ${status} ${statusText || ''}`];
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === 'connection') continue;
    if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
    else lines.push(`${key}: ${value}`);
  }
  lines.push('Connection: close');
  lines.push('');
  lines.push('');
  try {
    socket.write(lines.join('\r\n'));
    if (body && body.length) socket.write(body);
    socket.end();
  } catch {
    socket.destroy();
  }
}

async function readJsonBody(req, limit = MAX_JSON_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('payload_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

class DeviceStore {
  constructor(file, logger) {
    this.file = file;
    this.logger = logger;
    this.devices = new Map();
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      for (const device of parsed.devices || []) {
        if (device && typeof device.id === 'string' && typeof device.tokenHash === 'string') {
          this.devices.set(device.id, device);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  get size() {
    return this.devices.size;
  }

  get(id) {
    return this.devices.get(id);
  }

  has(id) {
    return this.devices.has(id);
  }

  verify(id, token) {
    const device = this.devices.get(id);
    if (!device || typeof token !== 'string' || token.length === 0) return false;
    return safeEqual(device.tokenHash, hashToken(token));
  }

  create(name) {
    let id = randomId();
    while (this.devices.has(id)) id = randomId();
    const token = randomToken();
    const now = Date.now();
    const device = {
      id,
      name: String(name || '').slice(0, 80) || 'DSH Desktop',
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: 0,
    };
    this.devices.set(id, device);
    this.persist();
    return { device, token };
  }

  touch(id, at = Date.now()) {
    const device = this.devices.get(id);
    if (!device) return;
    device.lastSeenAt = at;
  }

  remove(id) {
    const deleted = this.devices.delete(id);
    if (deleted) this.persist();
    return deleted;
  }

  persist() {
    const snapshot = JSON.stringify({
      version: 1,
      devices: [...this.devices.values()],
    }, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    }).catch((error) => {
      this.logger.error?.('relay: could not persist device store:', error);
    });
    return this.writeChain;
  }
}

class AgentConnection {
  constructor(ws, device, relay) {
    this.ws = ws;
    this.device = device;
    this.relay = relay;
    this.streams = new Map();
    this.nextId = 1;
    this.alive = true;
    this.closed = false;
    ws.on('pong', () => { this.alive = true; });
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', () => this.dispose('agent_disconnected'));
    ws.on('error', (error) => {
      this.relay.logger.warn?.(`relay: agent ${device.id} socket error: ${error.message}`);
    });
  }

  allocStreamId() {
    for (let attempt = 0; attempt < 0xffffffff; attempt += 1) {
      const id = this.nextId;
      this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
      if (!this.streams.has(id)) return id;
    }
    throw new Error('stream id space exhausted');
  }

  send(type, streamId, payload) {
    if (!isOpen(this.ws)) return false;
    try {
      this.ws.send(encodeFrame(type, streamId, payload), { binary: true });
      return true;
    } catch (error) {
      this.relay.logger.warn?.(`relay: agent ${this.device.id} send failed: ${error.message}`);
      return false;
    }
  }

  sendJson(type, streamId, value) {
    return this.send(type, streamId, encodeJson(value));
  }

  onMessage(raw, isBinary) {
    if (!isBinary) return;
    const frame = decodeFrame(raw);
    if (!frame) return;
    if (process.env.DEBUG_RELAY) this.relay.logger.info?.(`relay[dbg]: frame type=${frame.type} id=${frame.streamId} len=${frame.payload.length}`);
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    switch (frame.type) {
      case FRAME.RESPONSE:
        this.onResponse(stream, frame.streamId, decodeJson(frame.payload));
        break;
      case FRAME.DATA:
        this.onData(stream, frame.payload);
        break;
      case FRAME.RES_END:
        this.onResponseEnd(stream, frame.streamId);
        break;
      case FRAME.ERROR:
        this.onError(stream, frame.streamId, decodeJson(frame.payload).message || 'backend_error');
        break;
      case FRAME.CLOSE:
        this.onRemoteClose(stream, frame.streamId, decodeJson(frame.payload));
        break;
      case FRAME.WS_DATA:
        this.onWebSocketData(stream, frame.payload);
        break;
      default:
        break;
    }
  }

  onResponse(stream, streamId, response) {
    if (stream.kind === 'http') {
      if (stream.headersSent || stream.done) return;
      stream.headersSent = true;
      try {
        stream.res.writeHead(response.status || 502, response.statusText || '', filterResponseHeaders(response.headers));
      } catch (error) {
        this.onError(stream, streamId, error.message);
      }
      return;
    }

    if (stream.kind === 'ws') {
      stream.status = response.status || 502;
      stream.statusText = response.statusText || '';
      stream.responseHeaders = filterResponseHeaders(response.headers);
      if (stream.status !== 101) {
        stream.rawStatus = stream.status;
        stream.rawStatusText = stream.statusText;
        stream.rawHeaders = stream.responseHeaders;
        stream.rawBody = [];
        stream.rawBodySize = 0;
        return;
      }
      if (stream.client || stream.socket.destroyed) return;
      this.relay.clientWss.handleUpgrade(stream.req, stream.socket, stream.head, (client) => {
        stream.client = client;
        client.on('message', (data, binary) => {
          const flag = binary ? 2 : 1;
          this.send(FRAME.WS_DATA, streamId, Buffer.concat([Buffer.from([flag]), Buffer.from(data)]));
        });
        client.on('close', (code, reason) => {
          this.sendJson(FRAME.CLOSE, streamId, { code, reason: reason.toString() });
          this.finishStream(streamId);
        });
        client.on('error', () => {
          this.sendJson(FRAME.CLOSE, streamId, { code: 1006, reason: 'client_error' });
          this.finishStream(streamId);
        });
        const queued = stream.queue.splice(0);
        for (const message of queued) {
          if (client.readyState === 1) client.send(message.data, { binary: message.binary });
        }
      });
    }
  }

  onData(stream, payload) {
    if (stream.kind === 'http') {
      if (stream.done || !stream.res) return;
      if (!stream.res.write(payload)) {
        stream.res.once('drain', () => {});
      }
      return;
    }
    if (stream.kind === 'ws') {
      if (process.env.DEBUG_RELAY) this.relay.logger.info?.(`relay[dbg]: ws data flag=${payload[0]} len=${payload.length - 1}`);
      if (stream.rawBody) {
        if (stream.rawBodySize + payload.length > MAX_WS_ERROR_BODY) return;
        stream.rawBody.push(Buffer.from(payload));
        stream.rawBodySize += payload.length;
        return;
      }
      const flag = payload.length > 0 ? payload[0] : 1;
      const data = payload.subarray(1);
      if (stream.client && stream.client.readyState === 1) {
        stream.client.send(data, { binary: flag === 2 });
      } else if (stream.queue.length < 256) {
        stream.queue.push({ data: Buffer.from(data), binary: flag === 2 });
      } else {
        this.sendJson(FRAME.CLOSE, stream.streamId, { code: 1013, reason: 'relay_queue_full' });
        this.finishStream(stream.streamId);
      }
    }
  }

  onResponseEnd(stream, streamId) {
    if (stream.kind === 'http') {
      if (stream.done) return;
      stream.done = true;
      try { stream.res.end(); } catch {}
      this.finishStream(streamId);
      return;
    }
    if (stream.kind === 'ws' && stream.rawBody) {
      const body = Buffer.concat(stream.rawBody);
      writeRawResponse(stream.socket, stream.rawStatus, stream.rawStatusText, stream.rawHeaders, body);
      this.finishStream(streamId);
    }
  }

  onError(stream, streamId, message) {
    if (stream.kind === 'http') {
      if (!stream.headersSent && !stream.done) {
        stream.headersSent = true;
        writeText(stream.res, 502, `relay: desktop backend error: ${message}\n`);
      } else {
        try { stream.res.destroy(); } catch {}
      }
      this.finishStream(streamId);
      return;
    }
    if (stream.kind === 'ws') {
      if (stream.rawBody) {
        writeRawResponse(stream.socket, 502, 'Bad Gateway', { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from(`relay: ${message}\n`));
      } else {
        try { stream.socket.destroy(); } catch {}
      }
      this.finishStream(streamId);
    }
  }

  onRemoteClose(stream, streamId) {
    if (stream.kind === 'http') {
      try { stream.res.destroy(); } catch {}
    } else if (stream.kind === 'ws') {
      try { stream.client?.close(1000, 'backend_closed'); } catch {}
      try { stream.socket.destroy(); } catch {}
    }
    this.finishStream(streamId);
  }

  onWebSocketData(stream, payload) {
    if (stream.kind !== 'ws' || !stream.client || stream.client.readyState !== 1) return;
    const flag = payload.length > 0 ? payload[0] : 1;
    if (process.env.DEBUG_RELAY) this.relay.logger.info?.(`relay[dbg]: send to client flag=${flag} len=${payload.length - 1}`);
    stream.client.send(payload.subarray(1), { binary: flag === 2 });
  }

  finishStream(streamId) {
    this.streams.delete(streamId);
  }

  dispose(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const [streamId, stream] of this.streams) {
      if (stream.kind === 'http') {
        try {
          if (!stream.headersSent) writeText(stream.res, 502, `relay: desktop went offline (${reason})\n`);
          else stream.res.destroy();
        } catch {}
      } else {
        try { stream.socket?.destroy(); } catch {}
        try { stream.client?.terminate(); } catch {}
      }
      this.streams.delete(streamId);
    }
  }
}

export class Relay {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 8787;
    // Required: the relay is self-hosted, so it has no meaningful default.
    const baseDomain = String(options.baseDomain || '').trim().toLowerCase();
    if (!baseDomain) throw new Error('relay: baseDomain is required (e.g. relay.example.com)');
    this.baseDomain = baseDomain;
    this.devDomains = options.devDomains || ['localhost', 'lvh.me'];
    this.publicScheme = options.publicScheme || 'https';
    this.publicPort = options.publicPort ? String(options.publicPort) : '';
    this.singleTenant = options.singleTenant === true;
    this.publicHost = String(options.publicHost || this.baseDomain).toLowerCase();
    this.defaultDeviceId = options.defaultDeviceId || '';
    this.signupToken = options.signupToken || '';
    this.maxDevices = options.maxDevices || 5000;
    this.store = new DeviceStore(options.dataFile || './data/devices.json', this.logger);
    this.agents = new Map();
    this.e2eAgents = new Map();
    this.e2eShells = new Map();
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.agentWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
    this.clientWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
    this.e2eWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
    this.server.on('checkContinue', (req, res) => {
      try { res.writeContinue(); } catch {}
      this.handleRequest(req, res);
    });
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
    this.server.keepAliveTimeout = 65_000;
    this.server.timeout = 0;
    this.keepAlive = setInterval(() => this.pingAgents(), 30_000);
    this.keepAlive.unref?.();
    // E2E legs are the ones a backgrounded phone leaves half-open. Probe them
    // more often than the plaintext agent so the page's event stream recovers
    // within tens of seconds even before the desktop runs the new agent.
    this.e2eKeepAlive = setInterval(() => this.pingE2ESockets(), 15_000);
    this.e2eKeepAlive.unref?.();
    this.signupBuckets = new Map();
  }

  async start() {
    await this.store.load();
    const host = this.host || '127.0.0.1';
    const port = this.port || 8787;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.logger.info?.(`relay: listening on http://${host}:${port} (base domain ${this.baseDomain})`);
    return this;
  }

  async stop() {
    clearInterval(this.keepAlive);
    clearInterval(this.e2eKeepAlive);
    for (const [id, agent] of this.agents) {
      try { agent.ws.close(1001, 'relay_shutdown'); } catch {}
      this.agents.delete(id);
    }
    for (const [id, ws] of this.e2eAgents) {
      try { ws.close(1001, 'relay_shutdown'); } catch {}
      this.e2eAgents.delete(id);
    }
    for (const [id, ws] of this.e2eShells) {
      try { ws.close(1001, 'relay_shutdown'); } catch {}
      this.e2eShells.delete(id);
    }
    this.e2eWss.close();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  isApiHost(hostHeader) {
    const host = stripPort(hostHeader);
    return host === this.baseDomain
      || host === this.publicHost
      || host === 'relay'
      || host === 'dsh_relay'
      || host === 'localhost'
      || host === '127.0.0.1'
      || host === `relay.${this.devDomains[0] || 'localhost'}`;
  }

  publicUrl(id) {
    const port = this.publicPort ? `:${this.publicPort}` : '';
    if (this.singleTenant) return `${this.publicScheme}://${this.publicHost}${port}`;
    return `${this.publicScheme}://${id}.${this.baseDomain}${port}`;
  }

  resolveDeviceId(hostHeader) {
    const host = stripPort(hostHeader);
    if (this.singleTenant && host === this.publicHost) {
      if (this.defaultDeviceId && this.store.has(this.defaultDeviceId)) return this.defaultDeviceId;
      if (this.store.size === 1) return [...this.store.devices.keys()][0];
      const online = [...this.agents.keys()]
        .map((onlineId) => this.store.get(onlineId))
        .filter(Boolean)
        .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
      if (online.length > 0) return online[0].id;
      return null;
    }
    return deviceIdFromHost(hostHeader, this.baseDomain, this.devDomains);
  }

  rateLimitSignup(ip) {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const max = 20;
    let bucket = this.signupBuckets.get(ip);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      this.signupBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    return bucket.count <= max;
  }

  async handleRequest(req, res) {
    const host = stripPort(req.headers.host);
    let url;
    try {
      url = new URL(req.url || '/', `http://${host || 'relay'}`);
    } catch {
      writeText(res, 400, 'bad request\n');
      return;
    }

    const singlePublicHost = this.singleTenant && host === this.publicHost;
    if (singlePublicHost) {
      if (url.pathname === '/health' || url.pathname.startsWith('/api/v1/')) {
        await this.handleApi(req, res, url);
        return;
      }
    } else if (this.isApiHost(req.headers.host)) {
      await this.handleApi(req, res, url);
      return;
    }

    const id = this.resolveDeviceId(req.headers.host);
    if (!id) {
      writeText(res, 404, 'relay: unknown host\n');
      return;
    }
    const device = this.store.get(id);
    if (!device) {
      writeText(res, 404, 'relay: unknown device\n');
      return;
    }
    const agent = this.agents.get(id);
    if (!agent || !isOpen(agent.ws)) {
      writeText(res, 502, 'relay: desktop is offline. Open DSH on the desktop and make sure the relay plugin is enabled.\n');
      return;
    }
    this.proxyHttp(req, res, agent);
  }

  async handleApi(req, res, url) {
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        writeJson(res, 200, {
          ok: true,
          devices: this.store.size,
          online: this.agents.size,
          baseDomain: this.baseDomain,
          uptime: process.uptime(),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/devices') {
        const ip = req.socket.remoteAddress || 'unknown';
        if (!this.rateLimitSignup(ip)) {
          writeJson(res, 429, { error: 'rate_limited' });
          return;
        }
        if (this.signupToken) {
          const provided = req.headers['x-signup-token'];
          if (provided !== this.signupToken) {
            writeJson(res, 403, { error: 'signup_token_required' });
            return;
          }
        }
        if (this.store.size >= this.maxDevices) {
          writeJson(res, 507, { error: 'device_limit_reached' });
          return;
        }
        const body = await readJsonBody(req);
        const { device, token } = this.store.create(body.name);
        this.logger.info?.(`relay: registered device ${device.id} (${device.name})`);
        writeJson(res, 201, {
          id: device.id,
          token,
          host: this.singleTenant ? this.publicHost : `${device.id}.${this.baseDomain}`,
          url: this.publicUrl(device.id),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/tls-ask') {
        const domain = stripPort(url.searchParams.get('domain') || '');
        if (domain === this.baseDomain || domain === this.publicHost) {
          writeText(res, 200, 'ok');
          return;
        }
        const id = deviceIdFromHost(domain, this.baseDomain, []);
        if (id && this.store.has(id)) {
          writeText(res, 200, 'ok');
        } else {
          writeText(res, 404, 'unknown device');
        }
        return;
      }

      const deviceMatch = url.pathname.match(/^\/api\/v1\/devices\/([a-z0-9]+)$/);
      if (deviceMatch) {
        const id = deviceMatch[1];
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!this.store.verify(id, token)) {
          writeJson(res, 401, { error: 'unauthorized' });
          return;
        }
        if (req.method === 'GET') {
          const device = this.store.get(id);
          writeJson(res, 200, {
            id: device.id,
            name: device.name,
            createdAt: device.createdAt,
            lastSeenAt: device.lastSeenAt,
            online: this.agents.has(id),
            url: this.publicUrl(id),
          });
          return;
        }
        if (req.method === 'DELETE') {
          this.store.remove(id);
          const agent = this.agents.get(id);
          if (agent) {
            try { agent.ws.close(1008, 'device_revoked'); } catch {}
            this.agents.delete(id);
          }
          writeJson(res, 200, { deleted: true });
          return;
        }
      }

      if (req.method === 'GET' && url.pathname === '/') {
        writeText(res, 200, [
          'dsh-remote-relay',
          '',
          `base domain: ${this.baseDomain}`,
          `devices: ${this.store.size}`,
          `online: ${this.agents.size}`,
          '',
          'POST /api/v1/devices  -> register a desktop',
          'GET  /health         -> relay status',
          '',
        ].join('\n'));
        return;
      }

      writeJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const status = error.status || 500;
      if (!res.headersSent) writeJson(res, status, { error: error.message || 'internal_error' });
      else res.destroy();
    }
  }

  handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://relay');
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname === '/e2e/agent' || url.pathname === '/e2e/shell') {
      this.handleE2EUpgrade(req, socket, head, url);
      return;
    }

    const singlePublicHost = this.singleTenant && stripPort(req.headers.host) === this.publicHost;
    if (url.pathname === '/agent' && (singlePublicHost || this.isApiHost(req.headers.host))) {
      this.handleAgentUpgrade(req, socket, head, url);
      return;
    }

    const id = this.resolveDeviceId(req.headers.host);
    if (!id || !this.store.has(id)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const agent = this.agents.get(id);
    if (!agent || !isOpen(agent.ws)) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.proxyUpgrade(req, socket, head, agent);
  }

  handleE2EUpgrade(req, socket, head, url) {
    const id = String(url.searchParams.get('device') || '');
    const device = this.store.get(id);
    if (!device) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const isAgent = url.pathname === '/e2e/agent';
    if (isAgent) {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!this.store.verify(id, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 12\r\n\r\nunauthorized');
        socket.destroy();
        return;
      }
    }

    this.e2eWss.handleUpgrade(req, socket, head, (ws) => this.attachE2ESocket(ws, id, isAgent));
  }

  attachE2ESocket(ws, id, isAgent) {
    const map = isAgent ? this.e2eAgents : this.e2eShells;
    const peerMap = isAgent ? this.e2eShells : this.e2eAgents;
    const previous = map.get(id);
    map.set(id, ws);
    // Nagle on either leg turns every forwarded frame into a delayed-ACK stall
    // (~40 ms). A boot moves a couple of hundred frames, so this alone costs
    // whole seconds.
    try {
      ws._socket?.setNoDelay?.(true);
      ws._socket?.setKeepAlive?.(true, 15000);
    } catch {}
    if (previous && previous !== ws) {
      try { previous.close(4001, 'replaced_by_new_connection'); } catch {}
    }

    // A phone that backgrounds Safari freezes the Service Worker, which stops
    // answering WebSocket pings while the TCP socket can stay half-open. Ping
    // these legs like the plaintext agent leg so a dead shell is reaped instead
    // of leaving the desktop's mux socket (and its stream ids) alive forever.
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });

    ws.on('message', (data, isBinary) => {
      const peer = peerMap.get(id);
      if (peer && peer.readyState === 1) {
        peer.send(data, { binary: isBinary });
      } else {
        // A peer can disappear between a request and its response (page
        // redirects/cancels, tunnel replacement). Dropping one message is
        // recoverable; closing the whole socket aborts every in-flight
        // navigation, which shows up in the browser as ERR_FAILED.
        this.logger.warn?.('relay: e2e ' + (isAgent ? 'agent' : 'shell') + ' ' + id + ' peer offline; dropped message');
      }
    });

    ws.on('close', (code, reason) => {
      this.logger.warn?.('relay: e2e ' + (isAgent ? 'agent' : 'shell') + ' ' + id + ' closed code=' + code + (reason?.length ? ' reason=' + reason.toString() : ''));
      if (map.get(id) === ws) map.delete(id);
      // Keep the shell socket alive across an agent reconnect. The next
      // request can use the new agent; tearing the shell down here aborts
      // page navigations with ERR_FAILED during ordinary reconnects.
      if (!isAgent && this.e2eShells.get(id) === undefined) {
        // The phone is gone, not replacing its shell. The desktop agent cannot
        // see this socket, so tell it to tear down every backend HTTP/WS stream
        // opened for the departed shell. Otherwise a half-open phone tunnel
        // leaves the real mux socket alive with a page that will never read it.
        const agentSocket = this.e2eAgents.get(id);
        if (agentSocket && agentSocket.readyState === 1) {
          try { agentSocket.send(JSON.stringify({ t: 'reset', reason: 'shell_closed' })); } catch {}
        }
      }
    });

    ws.on('error', (error) => {
      this.logger.warn?.('relay: e2e ' + (isAgent ? 'agent' : 'shell') + ' ' + id + ' socket error: ' + error.message);
    });

    this.logger.info?.('relay: e2e ' + (isAgent ? 'agent' : 'shell') + ' online device=' + id);
  }

  handleAgentUpgrade(req, socket, head, url) {
    const id = url.searchParams.get('device') || String(req.headers['x-device-id'] || '');
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const device = this.store.get(id);
    if (!device || !this.store.verify(id, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 12\r\n\r\nunauthorized');
      socket.destroy();
      return;
    }
    this.agentWss.handleUpgrade(req, socket, head, (ws) => {
      const previous = this.agents.get(id);
      const connection = new AgentConnection(ws, device, this);
      this.agents.set(id, connection);
      this.store.touch(id);
      this.store.persist();
      if (previous && previous !== connection) {
        try { previous.ws.close(4001, 'replaced_by_new_connection'); } catch {}
      }
      ws.on('close', () => {
        if (this.agents.get(id) === connection) this.agents.delete(id);
      });
      this.logger.info?.(`relay: agent online device=${id} name=${device.name}`);
    });
  }

  proxyHttp(req, res, agent) {
    const streamId = agent.allocStreamId();
    const stream = { kind: 'http', req, res, headersSent: false, done: false };
    agent.streams.set(streamId, stream);

    const headers = filterRequestHeaders(req.headers);
    agent.sendJson(FRAME.OPEN, streamId, {
      kind: 'http',
      method: req.method,
      url: req.url,
      headers,
    });

    let paused = false;
    const maybePause = () => {
      if (paused) return;
      if (agent.ws.bufferedAmount > HIGH_WATER) {
        paused = true;
        try { req.pause(); } catch {}
        const timer = setInterval(() => {
          if (!isOpen(agent.ws) || agent.ws.bufferedAmount < LOW_WATER) {
            clearInterval(timer);
            paused = false;
            try { req.resume(); } catch {}
          }
        }, 25);
        timer.unref?.();
      }
    };

    req.on('data', (chunk) => {
      if (stream.done) return;
      agent.send(FRAME.DATA, streamId, chunk);
      maybePause();
    });
    req.on('end', () => {
      if (stream.done) return;
      agent.send(FRAME.REQ_END, streamId, null);
    });
    req.on('error', () => {
      agent.sendJson(FRAME.CLOSE, streamId, { code: 1006, reason: 'client_request_error' });
      this.finishHttp(agent, streamId, stream);
    });
    res.on('close', () => {
      if (stream.done) return;
      if (!res.writableEnded) {
        agent.sendJson(FRAME.CLOSE, streamId, { code: 1006, reason: 'client_closed' });
      }
      this.finishHttp(agent, streamId, stream);
    });
  }

  finishHttp(agent, streamId, stream) {
    stream.done = true;
    agent.streams.delete(streamId);
  }

  proxyUpgrade(req, socket, head, agent) {
    const streamId = agent.allocStreamId();
    const stream = {
      kind: 'ws',
      req,
      socket,
      head,
      client: null,
      queue: [],
      status: 0,
      statusText: '',
      responseHeaders: {},
      rawBody: null,
      rawBodySize: 0,
      done: false,
    };
    stream.streamId = streamId;
    agent.streams.set(streamId, stream);

    socket.on('error', () => {
      agent.sendJson(FRAME.CLOSE, streamId, { code: 1006, reason: 'client_socket_error' });
      this.finishWs(agent, streamId, stream);
    });
    socket.on('close', () => {
      if (!stream.client) {
        agent.sendJson(FRAME.CLOSE, streamId, { code: 1006, reason: 'client_socket_closed' });
        this.finishWs(agent, streamId, stream);
      }
    });

    agent.sendJson(FRAME.OPEN, streamId, {
      kind: 'ws',
      url: req.url,
      headers: filterWebSocketHeaders(req.headers),
    });
  }

  finishWs(agent, streamId, stream) {
    stream.done = true;
    agent.streams.delete(streamId);
  }

  pingAgents() {
    for (const [id, agent] of this.agents) {
      if (!agent.alive) {
        this.logger.warn?.(`relay: agent ${id} missed heartbeat; terminating`);
        try { agent.ws.terminate(); } catch {}
        this.agents.delete(id);
        continue;
      }
      agent.alive = false;
      try { agent.ws.ping(); } catch {}
    }
  }

  /**
   * Reap frozen E2E legs. A backgrounded iOS WebView keeps the TCP socket but
   * stops running the Service Worker, so only a ping reveals it.
   *
   * The two legs need different thresholds. The desktop agent is a normal Node
   * ws client and answers a protocol ping immediately, so one missed round is
   * already suspicious. The phone leg is a Service Worker: iOS and Android
   * throttle or freeze it routinely while the tab is still alive, and it does
   * not answer protocol pings while frozen. Terminating it on the first miss
   * tears down a shell that the user is about to resume, which then looks like
   * a reconnect loop on every foreground. Give it several rounds before giving
   * up; a genuinely dead shell is reaped within about a minute.
   */
  pingE2ESockets() {
    for (const [id, ws] of this.e2eAgents) {
      if (this.e2eAgents.get(id) !== ws) continue;
      if (ws.alive === false) {
        this.logger.warn?.('relay: e2e agent ' + id + ' missed heartbeat; terminating');
        try { ws.terminate(); } catch {}
        if (this.e2eAgents.get(id) === ws) this.e2eAgents.delete(id);
        continue;
      }
      ws.alive = false;
      try { ws.ping(); } catch {}
    }

    for (const [id, ws] of this.e2eShells) {
      if (this.e2eShells.get(id) !== ws) continue;
      ws.missedPings = ws.alive === false ? (ws.missedPings || 0) + 1 : 0;
      // A frozen worker answers nothing, including the page's own keepalive,
      // so this only ages out the shell — the page reconnects on resume.
      if (ws.missedPings >= E2E_SHELL_MISSED_PINGS) {
        this.logger.warn?.('relay: e2e shell ' + id + ' missed ' + ws.missedPings + ' heartbeats; terminating');
        try { ws.terminate(); } catch {}
        if (this.e2eShells.get(id) === ws) this.e2eShells.delete(id);
        continue;
      }
      ws.alive = false;
      try { ws.ping(); } catch {}
    }
  }
}

export function createRelay(options) {
  return new Relay(options);
}