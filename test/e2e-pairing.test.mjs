import test from 'node:test';
import assert from 'node:assert/strict';
import { generateHostKey, publicHostKey, shellOriginFor, buildShellUrl } from '../lib/e2e-pairing.mjs';

test('builds a fragment-only shell URL', () => {
  const privateJwk = generateHostKey();
  const hostKey = publicHostKey(privateJwk);
  const shellOrigin = shellOriginFor({
    deviceId: 'abc123',
    shellScheme: 'https',
    shellBaseDomain: 'app.example.com',
    shellPort: '8443',
  });
  assert.equal(shellOrigin, 'https://abc123.app.example.com:8443');

  const url = new URL(buildShellUrl({
    shellOrigin,
    shellWs: 'wss://relay.example.com/e2e/shell?device=abc123',
    hostKey,
    token: 'secret-token',
    appPath: '/mobile-access/pair#pair-token',
  }));

  assert.equal(url.origin, 'https://abc123.app.example.com:8443');
  assert.equal(url.pathname, '/index.html');
  assert.equal(url.search, '', 'secrets must not be in the query');

  const params = new URLSearchParams(url.hash.slice(1));
  const config = JSON.parse(Buffer.from(params.get('e2e'), 'base64url').toString('utf8'));
  assert.equal(config.ws, 'wss://relay.example.com/e2e/shell?device=abc123');
  assert.deepEqual(config.hostKey, hostKey);
  assert.equal(config.token, 'secret-token');
  assert.equal(params.get('app'), '/mobile-access/pair#pair-token');
});

test('null shell port omits the colon', () => {
  assert.equal(shellOriginFor({ deviceId: 'abc123', shellScheme: 'https', shellBaseDomain: 'app.example.com', shellPort: '' }), 'https://abc123.app.example.com');
});