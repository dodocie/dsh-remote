import crypto from 'node:crypto';

export const E2E_VERSION = 'v1';
export const HKDF_INFO = 'dsh-remote/e2e/v1|keys';

export function generateHostIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    publicKey,
    privateKey,
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  };
}

export function generateEphemeral() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    publicKey,
    privateKey,
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  };
}

export function transcript(clientEph, hostEph, token, clientNonce, hostNonce) {
  return [
    E2E_VERSION,
    clientEph.x,
    clientEph.y,
    hostEph.x,
    hostEph.y,
    token,
    clientNonce,
    hostNonce,
  ].join('|');
}

export function signTranscript(hostStaticPrivateKey, text) {
  return crypto.sign('sha256', Buffer.from(text, 'utf8'), {
    key: hostStaticPrivateKey,
    dsaEncoding: 'ieee-p1363',
  });
}

export function verifyTranscript(hostStaticJwk, text, signature) {
  const key = crypto.createPublicKey({ key: hostStaticJwk, format: 'jwk' });
  return crypto.verify('sha256', Buffer.from(text, 'utf8'), {
    key,
    dsaEncoding: 'ieee-p1363',
  }, signature);
}

export function deriveKeys(sharedSecret, transcriptText) {
  const salt = crypto.createHash('sha256').update(transcriptText, 'utf8').digest();
  const okm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from(HKDF_INFO), 88));
  return {
    c2sKey: okm.subarray(0, 32),
    s2cKey: okm.subarray(32, 64),
    c2sPrefix: okm.subarray(64, 76),
    s2cPrefix: okm.subarray(76, 88),
  };
}

export function makeNonce(prefix, counter) {
  const nonce = Buffer.alloc(12);
  Buffer.from(prefix).copy(nonce, 0, 0, 4);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
}

export function encryptGcm(key, nonce, aad, plaintext) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

export function decryptGcm(key, nonce, aad, data) {
  if (data.length < 16) throw new Error('e2e: ciphertext too short');
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(0, data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function fromBase64url(value) {
  return Buffer.from(value, 'base64url');
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}