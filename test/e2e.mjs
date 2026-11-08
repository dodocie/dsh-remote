import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createRelay } from '../lib/relay.mjs';
import { createAgent } from '../lib/agent.mjs';
import { startMockBackend } from './mock-backend.mjs';

const quiet = process.env.DEBUG_RELAY
  ? { info: console.error, warn: console.error, error: console.error }
  : { info() {}, warn: console.warn, error: console.error };

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

async function waitFor(check, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for condition');
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT || 3444);
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT || 8787);

const backend = await startMockBackend(BACKEND_PORT);
const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-e2e-'));
const relay = createRelay({
  host: '127.0.0.1',
  port: RELAY_PORT,
  baseDomain: 'lvh.me',
  publicScheme: 'http',
  publicPort: '8787',
  dataFile: join(dir, 'devices.json'),
  devDomains: ['localhost', 'lvh.me'],
  logger: quiet,
});
await relay.start();

let agent;
try {
  const registration = await request({
    host: '127.0.0.1',
    port: RELAY_PORT,
    method: 'POST',
    path: '/api/v1/devices',
    headers: { 'content-type': 'application/json' },
  }, JSON.stringify({ name: 'e2e' }));
  assert(registration.status === 201, `registration status ${registration.status}`);
  const device = JSON.parse(registration.body.toString());
  assert(device.id && device.token && device.url, 'registration payload');
  const host = `${device.id}.lvh.me:${RELAY_PORT}`;

  agent = createAgent({
    relayUrl: `http://127.0.0.1:${RELAY_PORT}`,
    deviceId: device.id,
    token: device.token,
    backendUrl: `http://127.0.0.1:${BACKEND_PORT}`,
    logger: quiet,
  });
  agent.start();
  await waitFor(() => agent.connected, 5000);

  const hello = await request({
    host: '127.0.0.1',
    port: RELAY_PORT,
    method: 'GET',
    path: '/hello',
    headers: { host, origin: 'https://example.test', cookie: 'session=abc' },
  });
  assert(hello.status === 200, `hello status ${hello.status}`);
  assert(hello.headers['x-mock'] === 'hello', 'hello x-mock header');
  const helloBody = JSON.parse(hello.body.toString());
  assert(helloBody.headers.host === host, `backend saw Host ${helloBody.headers.host}, expected ${host}`);
  assert(helloBody.headers.origin === 'https://example.test', `backend saw Origin ${helloBody.headers.origin}`);
  assert(helloBody.headers.cookie === 'session=abc', `backend saw Cookie ${helloBody.headers.cookie}`);

  const payload = Buffer.alloc(200 * 1024, 42);
  const echo = await request({
    host: '127.0.0.1',
    port: RELAY_PORT,
    method: 'POST',
    path: '/echo',
    headers: { host, 'content-length': payload.length, 'content-type': 'application/octet-stream' },
  }, payload);
  assert(echo.status === 200, `echo status ${echo.status}`);
  assert(echo.body.length === payload.length && echo.body.equals(payload), 'echo body mismatch');

  const cookies = await request({ host: '127.0.0.1', port: RELAY_PORT, method: 'GET', path: '/cookies', headers: { host } });
  assert(cookies.status === 200, `cookies status ${cookies.status}`);
  const setCookie = cookies.headers['set-cookie'];
  assert(Array.isArray(setCookie) && setCookie.length === 2, `set-cookie count ${setCookie?.length}`);
  assert(setCookie[0].includes('a=1') && setCookie[1].includes('b=2'), 'set-cookie values');

  const big = await request({ host: '127.0.0.1', port: RELAY_PORT, method: 'GET', path: '/big', headers: { host } });
  assert(big.status === 200, `big status ${big.status}`);
  assert(big.body.length === 1024 * 1024, `big body length ${big.body.length}`);

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws`, { headers: { host, origin: `http://${host}` } });
    const timer = setTimeout(() => reject(new Error('websocket timeout')), 5000);
    let stage = 0;
    ws.on('open', () => ws.send('hello-ws'));
    ws.on('message', (data, isBinary) => {
      if (stage === 0) {
        assert(!isBinary, 'text reply');
        assert(data.toString() === 'hello-ws', `ws echo ${data}`);
        stage = 1;
        ws.send(Buffer.from([1, 2, 3, 4]));
        return;
      }
      assert(isBinary, 'binary reply');
      assert(data.equals(Buffer.from([1, 2, 3, 4])), 'binary ws echo');
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.on('error', reject);
  });

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws-headers`, { headers: { host, origin: `http://${host}` } });
    const timer = setTimeout(() => reject(new Error('ws-headers timeout')), 5000);
    ws.on('message', (data) => {
      clearTimeout(timer);
      const headers = JSON.parse(data.toString());
      assert(headers.host === host, `ws backend host ${headers.host}`);
      assert(headers.origin === `http://${host}`, `ws backend origin ${headers.origin}`);
      ws.close();
      resolve();
    });
    ws.on('error', reject);
  });

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws-reject`, { headers: { host } });
    ws.on('unexpected-response', (req, res) => {
      assert(res.statusCode === 403, `ws reject status ${res.statusCode}`);
      res.resume();
      resolve();
    });
    ws.on('error', (error) => {
      if (String(error.message).includes('403')) resolve();
      else reject(error);
    });
    ws.on('open', () => reject(new Error('ws-reject unexpectedly opened')));
  });

  agent.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const offline = await request({ host: '127.0.0.1', port: RELAY_PORT, method: 'GET', path: '/hello', headers: { host } });
  assert(offline.status === 502, `offline status ${offline.status}`);

  console.log('e2e: PASS');
} finally {
  agent?.stop();
  await relay.stop();
  await backend.close();
  await rm(dir, { recursive: true, force: true });
}
