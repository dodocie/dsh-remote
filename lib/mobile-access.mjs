/**
 * Thin client for DSH Mobile's loopback admin API.
 *
 * The plugin does not reimplement mobile access: DSH Mobile already owns the
 * device registry, the pairing window and the 127.0.0.1:3444 gateway. All we do
 * is point its "self-hosted reverse proxy" backend at the public origin the
 * relay gave us, so the user never types a URL or a CIDR by hand.
 *
 * The admin routes are loopback only, but loopback alone is not enough: DSH
 * authenticates the request through its `connection` service, which rejects
 * anything without a signed browser cookie (401 admin_authentication_required).
 * A plain fetch from inside the DSH process therefore has to carry that cookie
 * itself, which we read from the desktop app's own cookie store.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Cookie name DSH mints per listener authority: `dsh-auth-<hash>` under the
 * `127.0.0.1` host. The payload is bound to `host:port`, so a cookie from an
 * older DSH launch carries a different authority and must not be replayed.
 */
const COOKIE_PREFIX = 'dsh-auth-';

/** Desktop app stores that may hold the cookie. The first that answers wins. */
function cookieDbCandidates() {
  const home = homedir();
  const support = join(home, 'Library/Application Support');
  return [
    process.env.DSH_COOKIE_DB,
    join(support, '@deepseek-ai/dsh-desktop/Cookies'),
    join(support, 'DeepSeek Harness/Cookies'),
    join(home, '.config/@deepseek-ai/dsh-desktop/Cookies'),
    join(home, '.config/DeepSeek Harness/Cookies'),
  ].filter(Boolean);
}

function payloadAuthority(cookieValue) {
  try {
    const payload = String(cookieValue).split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof json.authority === 'string' ? json.authority : null;
  } catch {
    return null;
  }
}

/**
 * Read the live DSH browser cookie for `authority` out of the desktop app's
 * Chromium cookie store. Values are stored in plaintext on macOS, so no
 * Keychain access is involved. Returns '' when nothing usable is found.
 */
export async function readDesktopCookie(authority, options = {}) {
  if (!authority) return '';
  const dbs = options.cookieDb ? [options.cookieDb] : cookieDbCandidates();
  for (const db of dbs) {
    try {
      const { stdout } = await execFileAsync('sqlite3', [
        db,
        `SELECT name || char(9) || value FROM cookies WHERE host_key IN ('127.0.0.1','localhost') AND name LIKE '${COOKIE_PREFIX}%';`,
      ], { timeout: 4000, maxBuffer: 1 << 20 });
      for (const line of stdout.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab <= 0) continue;
        const name = line.slice(0, tab);
        const value = line.slice(tab + 1).trim();
        if (!value) continue;
        const boundTo = payloadAuthority(value);
        // Only a cookie minted for this exact listener authority is accepted.
        if (boundTo && boundTo !== authority) continue;
        return `${name}=${value}`;
      }
    } catch {
      // No sqlite3, no store, or a locked database: try the next candidate.
    }
  }
  return '';
}

export const ORIGIN_DEFAULTS = Object.freeze({
  listenHost: '127.0.0.1',
  listenPort: 3444,
  allowedCidrs: Object.freeze(['127.0.0.0/8']),
});

const ADMIN_PREFIX = '/api/mobile-access/remote';

export class MobileAccessError extends Error {
  constructor(message, code = 'mobile_access_error') {
    super(message);
    this.name = 'MobileAccessError';
    this.code = code;
  }
}

export function originSettingsFile(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  return join(home, 'mobile-access', 'remote', 'origin', 'config', 'settings.json');
}

export class MobileAccessClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl loopback origin of the DSH web server, e.g. http://127.0.0.1:50779
   * @param {object} [options.logger]
   * @param {string} [options.configFile]
   * @param {number} [options.timeoutMs]
   */
  constructor(options = {}) {
    if (!options.baseUrl) throw new MobileAccessError('baseUrl is required', 'bad_config');
    this.baseUrl = String(options.baseUrl).replace(/\/$/, '');
    this.logger = options.logger || console;
    this.configFile = options.configFile || originSettingsFile();
    this.timeoutMs = options.timeoutMs || 8000;
    // The admin surface sits behind DSH's own browser authentication: a
    // loopback call with no cookie is rejected by `connection.requestRejection`
    // (401 admin_authentication_required). The plugin's own routes are already
    // reached by an authenticated browser, so hand that request's cookie to the
    // admin call instead of inventing a credential.
    this.cookieProvider = typeof options.cookieProvider === 'function' ? options.cookieProvider : null;
  }

  async request(method, pathname, body) {
    const url = new URL(ADMIN_PREFIX + pathname, this.baseUrl);
    const headers = { origin: this.baseUrl, accept: 'application/json' };
    if (this.cookieProvider) {
      let cookie = '';
      try {
        cookie = String((await this.cookieProvider()) || '');
      } catch {
        cookie = '';
      }
      if (cookie) headers.cookie = cookie;
    }
    const init = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new MobileAccessError(
        `DSH Mobile is not reachable at ${this.baseUrl}: ${error.message}`,
        'unreachable',
      );
    }
    if (response.status === 404) throw new MobileAccessError('DSH Mobile is not installed', 'not_installed');
    const text = await response.text();
    if (!response.ok) {
      const error = new MobileAccessError(
        `DSH Mobile returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        response.status === 409 ? 'gateway_stopped' : 'request_failed',
      );
      error.status = response.status;
      throw error;
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new MobileAccessError('DSH Mobile returned invalid JSON', 'bad_response');
    }
  }

  /** Paired devices, newest first. */
  async listDevices() {
    const payload = await this.request('GET', '/devices');
    const list = payload && Array.isArray(payload.devices) ? payload.devices : [];
    return list.map((device) => ({
      id: String(device.id || ''),
      label: String(device.label || ''),
      createdAt: Number(device.createdAt || 0),
      expiresAt: Number(device.expiresAt || 0),
      lastSeenAt: Number(device.lastSeenAt || 0),
    })).filter((device) => device.id);
  }

  /** Drop one device; it has to pair again afterwards. */
  async revokeDevice(deviceId) {
    if (!deviceId) throw new MobileAccessError('deviceId is required', 'bad_request');
    const payload = await this.request('POST', '/devices/revoke', { deviceId });
    return Boolean(payload && payload.ok !== false);
  }

  /** Gateway snapshot, or null when the backend is not running. */
  async status() {
    try {
      return await this.request('GET', '/status');
    } catch (error) {
      if (error.code === 'gateway_stopped') return null;
      throw error;
    }
  }

  /** Origin settings on disk, or defaults when the backend was never configured. */
  async readSettings() {
    try {
      const parsed = JSON.parse(await readFile(this.configFile, 'utf8'));
      return {
        publicOrigin: typeof parsed.publicOrigin === 'string' ? parsed.publicOrigin : '',
        listenHost: typeof parsed.listenHost === 'string' ? parsed.listenHost : ORIGIN_DEFAULTS.listenHost,
        listenPort: Number.isInteger(parsed.listenPort) ? parsed.listenPort : ORIGIN_DEFAULTS.listenPort,
        allowedCidrs: Array.isArray(parsed.allowedCidrs) && parsed.allowedCidrs.length > 0
          ? parsed.allowedCidrs
          : [...ORIGIN_DEFAULTS.allowedCidrs],
      };
    } catch {
      return {
        publicOrigin: '',
        listenHost: ORIGIN_DEFAULTS.listenHost,
        listenPort: ORIGIN_DEFAULTS.listenPort,
        allowedCidrs: [...ORIGIN_DEFAULTS.allowedCidrs],
      };
    }
  }

  async configureOrigin(settings) {
    return this.request('POST', '/origin/configure', {
      publicOrigin: settings.publicOrigin,
      listenHost: settings.listenHost,
      listenPort: settings.listenPort,
      allowedCidrs: settings.allowedCidrs,
    });
  }

  async setRunning(running, provider = 'origin') {
    return this.request('POST', '/control', { running, provider });
  }

  /**
   * Point the phone-facing origin at the relay URL we registered, starting the
   * backend when it is down. Idempotent: a desktop that already matches is left
   * untouched, because reconfiguring a live gateway forces a reconnect.
   */
  async syncOrigin(publicUrl) {
    if (!publicUrl) return { running: false, changed: false, skipped: 'no_public_url' };
    const snapshot = await this.status();
    const running = Boolean(snapshot?.gateway);
    const currentOrigin = snapshot?.gateway?.origin || (await this.readSettings()).publicOrigin;

    if (currentOrigin !== publicUrl) {
      const current = await this.readSettings();
      const desired = {
        publicOrigin: publicUrl,
        listenHost: current.listenHost || ORIGIN_DEFAULTS.listenHost,
        listenPort: current.listenPort || ORIGIN_DEFAULTS.listenPort,
        allowedCidrs: current.allowedCidrs.length > 0 ? current.allowedCidrs : [...ORIGIN_DEFAULTS.allowedCidrs],
      };
      await this.configureOrigin(desired);
      this.logger.info?.(`remote-relay: mobile access origin set to ${publicUrl}`);
      return { running: true, changed: true, settings: desired };
    }
    if (!running) {
      await this.setRunning(true, 'origin');
      this.logger.info?.('remote-relay: mobile access backend started');
      return { running: true, changed: false, started: true };
    }
    return { running: true, changed: false };
  }

  /** Open a pairing window and return the QR payload DSH Mobile rendered for us. */
  async openPairing(ttlMs = 120_000) {
    const payload = await this.request('POST', '/pairing/open', { ttlMs });
    if (!payload || typeof payload.pairUrl !== 'string') {
      throw new MobileAccessError('DSH Mobile did not return a pairing URL', 'bad_response');
    }
    return payload;
  }
}
