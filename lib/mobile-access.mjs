/**
 * Thin client for DSH Mobile's loopback admin API.
 *
 * The plugin does not reimplement mobile access: DSH Mobile already owns the
 * device registry, the pairing window and the 127.0.0.1:3444 gateway. All we do
 * is point its "self-hosted reverse proxy" backend at the public origin the
 * relay gave us, so the user never types a URL or a CIDR by hand.
 *
 * The admin routes are loopback only and guarded by an Origin check rather than
 * the browser session cookie, so a plain fetch from inside the DSH process is
 * enough. No dependencies.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
  }

  async request(method, pathname, body) {
    const url = new URL(ADMIN_PREFIX + pathname, this.baseUrl);
    const init = {
      method,
      headers: { origin: this.baseUrl, accept: 'application/json' },
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
