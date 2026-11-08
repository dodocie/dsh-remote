#!/usr/bin/env node
import { createAgent } from '../lib/agent.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[name] = value;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const relayUrl = args.relay || process.env.RELAY_URL || 'http://127.0.0.1:8787';
  const backendUrl = args.backend || process.env.BACKEND_URL || 'http://127.0.0.1:3444';
  let deviceId = args.device || process.env.DEVICE_ID || '';
  let token = args.token || process.env.DEVICE_TOKEN || '';

  if (!deviceId || !token) {
    const endpoint = new URL('/api/v1/devices', relayUrl);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: args.name || process.env.NAME || 'dsh-remote-agent' }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`registration failed: HTTP ${response.status} ${text}`);
    const data = JSON.parse(text);
    deviceId = data.id;
    token = data.token;
    console.log(`registered device: ${deviceId}`);
    console.log(`public url:      ${data.url}`);
    console.log(`device token:    ${token}`);
  }

  const agent = createAgent({ relayUrl, deviceId, token, backendUrl });
  agent.on('online', () => console.log(`agent online: ${deviceId}`));
  agent.on('offline', (code) => console.log(`agent offline: ${code}`));
  agent.start();
  console.log(`agent: ${deviceId} -> ${backendUrl} (relay ${relayUrl})`);
  // Keep the process alive across reconnect backoff even when the first TLS
  // attempt fails (the retry timer itself is unref'd).
  const keepAlive = setInterval(() => {}, 60_000);

  const shutdown = () => {
    agent.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('agent: fatal:', error);
  process.exit(1);
});
