import crypto from 'node:crypto';

/** Generate the persistent P-256 host identity. Store the private JWK. */
export function generateHostKey() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ format: 'jwk' });
}

/** Derive the public JWK the shell pins. */
export function publicHostKey(privateJwk) {
  const privateKey = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

export function shellOriginFor(options) {
  if (options.shellOrigin) return String(options.shellOrigin).replace(/\/$/, '');
  const scheme = options.shellScheme || 'https';
  const base = options.shellBaseDomain;
  if (!base) throw new Error('shellBaseDomain is required (e.g. app.example.com)');
  const port = options.shellPort ? ':' + options.shellPort : '';
  return scheme + '://' + options.deviceId + '.' + base + port;
}

/**
 * Build the URL the phone opens. Secrets live only in the fragment: the e2e
 * config (host key + shell token + relay WS) and the dsh-mobile pairing path
 * (which itself carries a one-time token). The query stays empty.
 */
export function buildShellUrl(options) {
  const config = {
    ws: options.shellWs,
    hostKey: options.hostKey,
    token: options.token,
  };
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');
  const origin = String(options.shellOrigin).replace(/\/$/, '');
  const appPath = options.appPath || '/';
  // /index.html is the one path every deployed Worker already passes through.
  // If the shell lived at '/', an active Worker would proxy a reopened link
  // straight to the DSH app and the new pairing payload would never load.
  return origin + '/index.html#e2e=' + encoded + '&app=' + encodeURIComponent(appPath);
}