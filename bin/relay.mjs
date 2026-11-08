#!/usr/bin/env node
import { createRelay } from '../lib/relay.mjs';

const relay = createRelay({
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8787),
  baseDomain: process.env.BASE_DOMAIN || '',
  publicScheme: process.env.PUBLIC_SCHEME || 'https',
  publicPort: process.env.PUBLIC_PORT || '',
  singleTenant: process.env.SINGLE_TENANT === '1' || process.env.SINGLE_TENANT === 'true',
  publicHost: process.env.PUBLIC_HOST || '',
  defaultDeviceId: process.env.DEFAULT_DEVICE || '',
  dataFile: process.env.DATA_FILE || './data/devices.json',
  signupToken: process.env.SIGNUP_TOKEN || '',
  devDomains: (process.env.DEV_DOMAINS || 'localhost,lvh.me').split(',').map((value) => value.trim()).filter(Boolean),
  maxDevices: Number(process.env.MAX_DEVICES || 5000),
});

relay.start().catch((error) => {
  console.error('relay: failed to start:', error);
  process.exit(1);
});

async function shutdown() {
  try {
    await relay.stop();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
