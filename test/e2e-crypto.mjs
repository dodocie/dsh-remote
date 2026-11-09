import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createRelay } from '../lib/relay.mjs';
import { createE2EAgent } from '../lib/e2e-agent.mjs';
import {
  generateEphemeral,
  transcript,
  verifyTranscript,
  deriveKeys,
  makeNonce,
  encryptGcm,
  decryptGcm,
  base64url,
  fromBase64url,
  randomToken,
} from '../lib/e2e-protocol.mjs';
import { startMockBackend } from './mock-backend.mjs';

const BACKEND_PORT = Number(process.env.E2E_CRYPTO_BACKEND_PORT || 13446);
const RELAY_PORT = Number(process.env.E2E_CRYPTO_RELAY_PORT || 18788);

const quiet = process.env.DEBUG_RELAY
  ? { info: console.error, warn: console.error, error: console.error }
  : { info() {}, warn: console.warn, error: console.error };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error('assertion failed: ' + message);
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sameJwk(a, b) {
  return Boolean(a && b && a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y);
}

class ShellClient {
  constructor({ url, token, hostJwk, logger }) {
    this.url = url;
    this.token = token;
    this.hostJwk = hostJwk;
    this.logger = logger || console;
    this.pending = new Map();
    this.nextId = 0;
    this.sendCounter = 0;
    this.recvCounter = 0;
    this.keys = null;
    this.ready = null;
  }

  async connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const ephemeral = generateEphemeral();
    this.ephemeral = ephemeral;
    this.clientNonce = base64url(crypto.randomBytes(16));
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onMessage(message);
    });
    ws.on('close', () => {
      for (const entry of this.pending.values()) entry.reject(new Error('shell connection closed'));
      this.pending.clear();
    });
    ws.on('error', (error) => this.logger.warn?.('shell: socket error: ' + error.message));

    ws.send(JSON.stringify({
      t: 'hello',
      v: 1,
      clientEph: ephemeral.jwk,
      clientNonce: this.clientNonce,
      token: this.token,
    }));

    await this.ready;
  }

  onMessage(message) {
    if (message.t === 'hello-ack') {
      this.onHelloAck(message);
      return;
    }
    if (message.t === 'enc') {
      this.onEncrypted(message);
      return;
    }
    if (message.t === 'pong') {
      this.onPong?.(message);
    }
  }

  ping() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.onPong = undefined;
        resolve(null);
      }, 2000);
      this.onPong = (message) => {
        clearTimeout(timer);
        this.onPong = undefined;
        resolve(message);
      };
      this.ws.send(JSON.stringify({ t: 'ping', at: 12345 }));
    });
  }

  onHelloAck(message) {
    try {
      assert(message.v === 1, 'hello-ack version');
      assert(sameJwk(message.hostStatic, this.hostJwk), 'host static key must match the pinned key');
      const text = transcript(this.ephemeral.jwk, message.hostEph, this.token, this.clientNonce, message.hostNonce);
      assert(verifyTranscript(message.hostStatic, text, fromBase64url(message.sig)), 'host signature');
      const shared = crypto.diffieHellman({
        privateKey: this.ephemeral.privateKey,
        publicKey: crypto.createPublicKey({ key: message.hostEph, format: 'jwk' }),
      });
      this.keys = deriveKeys(shared, text);
      this.resolveReady();
    } catch (error) {
      this.rejectReady(error);
    }
  }

  sendInner(value) {
    const n = this.sendCounter;
    this.sendCounter += 1;
    const nonce = makeNonce(this.keys.c2sPrefix, n);
    const aad = Buffer.from('e2e|c2s|' + n);
    const ciphertext = encryptGcm(this.keys.c2sKey, nonce, aad, Buffer.from(JSON.stringify(value)));
    this.ws.send(JSON.stringify({ t: 'enc', n, d: base64url(ciphertext) }));
  }

  onEncrypted(message) {
    try {
      assert(message.n === this.recvCounter, 'unexpected receive counter');
      const nonce = makeNonce(this.keys.s2cPrefix, message.n);
      const aad = Buffer.from('e2e|s2c|' + message.n);
      const plaintext = decryptGcm(this.keys.s2cKey, nonce, aad, fromBase64url(message.d));
      this.recvCounter += 1;
      this.onInner(JSON.parse(plaintext.toString('utf8')));
    } catch (error) {
      this.rejectReady?.(error);
      this.logger.warn?.('shell: decrypt failed: ' + error.message);
      try { this.ws.close(4002, 'decrypt_failed'); } catch {}
    }
  }

  onInner(message) {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    if (message.t === 'http-head') {
      entry.status = message.status;
      entry.headers = message.headers || {};
      return;
    }
    if (message.t === 'http-chunk') {
      entry.chunks.push(fromBase64url(message.data));
      return;
    }
    if (message.t === 'http-end') {
      this.pending.delete(message.id);
      entry.resolve({
        status: entry.status,
        headers: entry.headers,
        body: Buffer.concat(entry.chunks),
      });
      return;
    }
    if (message.t === 'http-error') {
      this.pending.delete(message.id);
      entry.reject(new Error(message.message || 'http-error'));
      return;
    }
    if (message.t === 'ws-open') {
      entry.open = true;
      entry.onOpen?.();
      return;
    }
    if (message.t === 'ws-data') {
      entry.onMessage?.(message.data);
      return;
    }
    if (message.t === 'ws-close') {
      entry.onClose?.(message.code, message.reason);
      return;
    }
    if (message.t === 'ws-error') {
      entry.reject?.(new Error(message.message || 'ws-error'));
    }
  }

  async request({ method = 'GET', path, headers = {}, body = null }) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { status: null, headers: null, chunks: [], resolve, reject });
      this.sendInner({
        t: 'http-open',
        id,
        method,
        url: path,
        headers,
        body: body ? body.toString('base64') : null,
      });
    });
  }

  async websocketHold() {
    const id = 'ws-' + (++this.nextId);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.pending.set(id, entry);
      entry.onOpen = () => resolve(id);
      entry.onClose = (code, reason) => reject(new Error('ws closed ' + code + ' ' + reason));
      this.sendInner({ t: 'ws-open', id, path: '/ws', protocols: [] });
    });
  }

  async websocketEcho() {
    const id = 'ws-' + (++this.nextId);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, open: false };
      this.pending.set(id, entry);
      entry.onOpen = () => this.sendInner({ t: 'ws-data', id, data: 'hello-ws' });
      entry.onMessage = (data) => {
        this.pending.delete(id);
        this.sendInner({ t: 'ws-close', id });
        resolve(data);
      };
      entry.onClose = (code, reason) => reject(new Error('ws closed ' + code + ' ' + reason));
      this.sendInner({ t: 'ws-open', id, path: '/ws', protocols: [] });
    });
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

const backend = await startMockBackend(BACKEND_PORT);
const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-e2e-crypto-'));
const relay = createRelay({
  host: '127.0.0.1',
  port: RELAY_PORT,
  baseDomain: 'lvh.me',
  publicScheme: 'http',
  publicPort: String(RELAY_PORT),
  dataFile: join(dir, 'devices.json'),
  devDomains: ['localhost', 'lvh.me'],
  logger: quiet,
});
await relay.start();

let agent;
let shell;
try {
  const registration = await request({
    host: '127.0.0.1',
    port: RELAY_PORT,
    method: 'POST',
    path: '/api/v1/devices',
    headers: { 'content-type': 'application/json' },
  }, JSON.stringify({ name: 'e2e-crypto' }));
  assert(registration.status === 201, 'registration status ' + registration.status);
  const device = JSON.parse(registration.body.toString());
  assert(device.id && device.token, 'registration payload');

  const pairingToken = randomToken(24);
  const shellOrigin = 'https://' + device.id + '.app.lvh.me';
  agent = createE2EAgent({
    relayUrl: 'ws://127.0.0.1:' + RELAY_PORT + '/e2e/agent?device=' + device.id,
    token: device.token,
    pairingToken,
    backendUrl: 'http://127.0.0.1:' + BACKEND_PORT,
    shellOrigin,
    logger: quiet,
  });
  agent.start();
  await agent.readyPromise;

  shell = new ShellClient({
    url: 'ws://127.0.0.1:' + RELAY_PORT + '/e2e/shell?device=' + device.id,
    token: pairingToken,
    hostJwk: agent.publicJwk,
    logger: quiet,
  });
  await shell.connect();

  const hello = await shell.request({
    path: '/hello',
    headers: { host: 'ignored', origin: 'https://ignored.test' },
  });
  assert(hello.status === 200, 'hello status ' + hello.status);
  assert(hello.headers['x-mock'] === 'hello', 'hello x-mock header');
  const helloBody = JSON.parse(hello.body.toString());
  assert(helloBody.headers.host === new URL(shellOrigin).host, 'backend Host ' + helloBody.headers.host);
  assert(helloBody.headers.origin === shellOrigin, 'backend Origin ' + helloBody.headers.origin);

  const payload = Buffer.alloc(200 * 1024, 42);
  const echo = await shell.request({
    method: 'POST',
    path: '/echo',
    headers: { 'content-type': 'application/octet-stream' },
    body: payload,
  });
  assert(echo.status === 200, 'echo status ' + echo.status);
  assert(echo.body.length === payload.length && echo.body.equals(payload), 'echo body mismatch');

  const slow = await shell.request({ path: '/slow' });
  assert(slow.status === 200, 'slow status ' + slow.status);
  assert(slow.body.toString() === 'onetwothree', 'slow body ' + slow.body.toString());

  const cookies = await shell.request({ path: '/cookies' });
  assert(Array.isArray(cookies.headers['set-cookie']) && cookies.headers['set-cookie'].length === 2, 'set-cookie count');

  const pong = await shell.ping();
  assert(pong && pong.at === 12345, 'tunnel ping echo');

  const wsReply = await shell.websocketEcho();
  assert(wsReply === 'hello-ws', 'ws echo ' + wsReply);

  // A closed phone shell must tear down the backend sockets it opened. Without
  // this reset the desktop keeps the mux WebSocket alive after the phone is
  // frozen/backgrounded, so a resumed page believes its event stream is live.
  const held = await shell.websocketHold();
  assert(held, 'held websocket opened');
  await sleep(100);
  assert(backend.wsClients.size === 1, 'backend holds one websocket, got ' + backend.wsClients.size);
  shell.close();
  const closeDeadline = Date.now() + 5000;
  while (backend.wsClients.size > 0 && Date.now() < closeDeadline) await sleep(50);
  assert(backend.wsClients.size === 0, 'backend websocket closed after shell disconnect');

  console.log('e2e-crypto: PASS');
} finally {
  shell?.close();
  agent?.stop();
  await relay.stop();
  await backend.close();
  await rm(dir, { recursive: true, force: true });
}
