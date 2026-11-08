import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobileAccessClient } from '../lib/mobile-access.mjs';

const HOME_ORIGIN = 'https://abc123.relay.example:8443';

async function fakeAdmin(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const call = {
        method: req.method,
        path: new URL(req.url, 'http://localhost').pathname,
        origin: req.headers.origin,
        body: body ? JSON.parse(body) : undefined,
      };
      calls.push(call);
      const result = handler(call);
      if (result === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { baseUrl: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

async function tempConfig(settings) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-ma-'));
  const file = join(dir, 'settings.json');
  await writeFile(file, JSON.stringify(settings));
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('syncs a stale origin and keeps the configured listen port', async () => {
  const config = await tempConfig({ version: 1, publicOrigin: 'https://old.example:8443', listenHost: '127.0.0.1', listenPort: 4555, allowedCidrs: ['127.0.0.0/8'] });
  const admin = await fakeAdmin((call) => {
    if (call.path.endsWith('/status')) return { status: 200, body: { gateway: { host: '127.0.0.1', port: 4555, origin: 'https://old.example:8443' } } };
    if (call.path.endsWith('/origin/configure')) return { status: 200, body: { running: true } };
    return undefined;
  });
  try {
    const client = new MobileAccessClient({ baseUrl: admin.baseUrl, configFile: config.file, logger: { info() {} } });
    const result = await client.syncOrigin(HOME_ORIGIN);
    assert.equal(result.changed, true);
    const configure = admin.calls.find((c) => c.path.endsWith('/origin/configure'));
    assert.equal(configure.body.publicOrigin, HOME_ORIGIN);
    assert.equal(configure.body.listenPort, 4555);
    assert.equal(configure.origin, admin.baseUrl, 'sends the loopback origin header the admin route requires');
    assert.ok(!admin.calls.some((c) => c.path.endsWith('/control')), 'a live gateway is not restarted twice');
  } finally {
    await admin.close();
    await config.cleanup();
  }
});

test('leaves a matching live origin untouched', async () => {
  const config = await tempConfig({ publicOrigin: HOME_ORIGIN });
  const admin = await fakeAdmin((call) => {
    if (call.path.endsWith('/status')) return { status: 200, body: { gateway: { host: '127.0.0.1', port: 3444, origin: HOME_ORIGIN } } };
    return undefined;
  });
  try {
    const client = new MobileAccessClient({ baseUrl: admin.baseUrl, configFile: config.file, logger: { info() {} } });
    const result = await client.syncOrigin(HOME_ORIGIN);
    assert.equal(result.changed, false);
    assert.equal(admin.calls.length, 1, 'only the status probe');
  } finally {
    await admin.close();
    await config.cleanup();
  }
});

test('starts a stopped backend when the origin already matches', async () => {
  const config = await tempConfig({ publicOrigin: HOME_ORIGIN });
  const admin = await fakeAdmin((call) => {
    if (call.path.endsWith('/status')) return { status: 409, body: { error: 'gateway_stopped' } };
    if (call.path.endsWith('/control')) return { status: 200, body: { running: true } };
    return undefined;
  });
  try {
    const client = new MobileAccessClient({ baseUrl: admin.baseUrl, configFile: config.file, logger: { info() {} } });
    const result = await client.syncOrigin(HOME_ORIGIN);
    assert.equal(result.started, true);
    const control = admin.calls.find((c) => c.path.endsWith('/control'));
    assert.deepEqual(control.body, { running: true, provider: 'origin' });
  } finally {
    await admin.close();
    await config.cleanup();
  }
});

test('reports a missing DSH Mobile install as not_installed', async () => {
  const admin = await fakeAdmin(() => undefined);
  try {
    const client = new MobileAccessClient({ baseUrl: admin.baseUrl, logger: { info() {} } });
    await assert.rejects(() => client.syncOrigin(HOME_ORIGIN), (error) => error.code === 'not_installed');
  } finally {
    await admin.close();
  }
});

test('returns the pairing payload from DSH Mobile', async () => {
  const admin = await fakeAdmin((call) => {
    if (call.path.endsWith('/status')) return { status: 200, body: { gateway: { host: '127.0.0.1', port: 3444, origin: HOME_ORIGIN } } };
    if (call.path.endsWith('/pairing/open')) {
      return { status: 201, body: { token: 't', pairUrl: 'https://abc123.relay.example:8443/mobile-access/pair#key=1', qrSvg: '<svg/>', expiresAt: Date.now() + 120000 } };
    }
    return undefined;
  });
  try {
    const client = new MobileAccessClient({ baseUrl: admin.baseUrl, logger: { info() {} } });
    const payload = await client.openPairing(120000);
    assert.match(payload.pairUrl, /mobile-access\/pair#key=/);
    assert.equal(payload.qrSvg, '<svg/>');
    assert.deepEqual(admin.calls.at(-1).body, { ttlMs: 120000 });
  } finally {
    await admin.close();
  }
});
