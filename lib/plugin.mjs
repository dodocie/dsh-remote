/**
 * DSH plugin entry point.
 *
 * Responsibilities are intentionally small:
 *   1. register this desktop with the relay (once, then reuse the token);
 *   2. keep the outbound agent connection alive;
 *   3. point DSH Mobile's self-hosted backend at the public origin we own, so
 *      the user never fills in a URL, a port or a CIDR by hand;
 *   4. expose /relay, GET /remote-relay and a QR pairing page.
 */

import { readFile, writeFile, rm, mkdir, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import QRCode from 'qrcode';
import { RelayAgent } from './agent.mjs';
import { E2EAgent } from './e2e-agent.mjs';
import { generateHostKey, publicHostKey, shellOriginFor, buildShellUrl } from './e2e-pairing.mjs';
import { MobileAccessClient, MobileAccessError } from './mobile-access.mjs';

export const name = 'dsh-remote-relay';
export const inject = ['webServer'];

const DEFAULT_BACKEND = 'http://127.0.0.1:3444';
const PAIRING_TTL_MS = 120_000;

/** Open a URL in the user's default browser; the relay is useless until they pair. */
function openInBrowser(url) {
  if (process.env.DSH_REMOTE_NO_OPEN) return false;
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function defaultConfigFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'remote-relay', 'config.json');
}

function normalizeConfig(raw) {
  const config = raw || {};
  return {
    // Required: this plugin is self-hostable, so it must not ship someone
    // else's relay as a silent default.
    relayUrl: String(config.relayUrl || '').replace(/\/$/, ''),
    backendUrl: String(config.backendUrl || DEFAULT_BACKEND),
    configFile: String(config.configFile || defaultConfigFile()),
    autoStart: config.autoStart !== false,
    autoConfigure: config.autoConfigure !== false,
    signupToken: String(config.signupToken || ''),
    e2e: config.e2e === true || process.env.DSH_RELAY_E2E === '1',
    shellOrigin: String(config.shellOrigin || ''),
    shellScheme: String(config.shellScheme || 'https'),
    // Required for pairing: the shell origin is <device>.<shellBaseDomain>.
    shellBaseDomain: String(config.shellBaseDomain || ''),
    shellPort: config.shellPort === undefined ? '' : String(config.shellPort),
    insecure: config.insecure === true || process.env.DSH_RELAY_E2E_INSECURE === '1',
  };
}

function ensureHostIdentity(identity, logger) {
  let changed = false;
  if (!identity.hostKey) {
    identity.hostKey = generateHostKey();
    changed = true;
  }
  if (!identity.shellToken) {
    identity.shellToken = crypto.randomBytes(24).toString('base64url');
    changed = true;
  }
  if (changed) logger.info?.('remote-relay: generated the E2E host identity');
  return changed;
}

async function readIdentity(file, logger) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.deviceId === 'string' && typeof parsed.token === 'string') return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn?.(`remote-relay: could not read ${file}: ${error.message}`);
  }
  return null;
}

async function writeIdentity(file, identity) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
}

async function registerDevice(config) {
  const endpoint = new URL('/api/v1/devices', config.relayUrl);
  const headers = { 'content-type': 'application/json' };
  if (config.signupToken) headers['x-signup-token'] = config.signupToken;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: hostname() }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`relay registration failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('relay registration returned invalid JSON');
  }
  if (!data.id || !data.token) throw new Error('relay registration response is missing id/token');
  return {
    deviceId: data.id,
    token: data.token,
    host: data.host,
    url: data.url,
    relayUrl: config.relayUrl,
    createdAt: Date.now(),
  };
}

const PAIR_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>连接手机</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.5 -apple-system, "SF Pro Text", "PingFang SC", system-ui, sans-serif;
         background: #f6f7f9; color: #1b1f24; }
  main { background: #fff; border-radius: 16px; padding: 28px 28px 22px; width: min(420px, 86vw);
         box-shadow: 0 10px 40px rgba(16, 24, 40, .08); text-align: center; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  p.sub { margin: 0 0 18px; color: #667085; font-size: 13px; }
  #qr svg { width: 100%; height: auto; display: block; border-radius: 8px; }
  p.state { margin: 14px 0 0; font-size: 13px; color: #667085; min-height: 20px; }
  button { margin-top: 14px; width: 100%; padding: 10px 14px; border-radius: 10px; border: 1px solid #d0d5dd;
           background: #fff; font: inherit; color: #1b1f24; cursor: pointer; }
  button:hover { background: #f9fafb; }
  a { color: #344054; font-size: 12px; word-break: break-all; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e6e8ec; }
    main { background: #171a21; box-shadow: none; }
    button { background: #1f232b; border-color: #2c313b; color: #e6e8ec; }
    p.sub, p.state { color: #98a2b3; }
    a { color: #98a2b3; }
  }
</style>
</head>
<body>
<main>
  <h1>扫码连接手机</h1>
  <p class="sub" id="remote">正在读取中继状态…</p>
  <p class="sub">用手机相机扫描，按提示配对。<span id="ttl"></span></p>
  <div id="qr"></div>
  <p class="state" id="state">正在生成二维码…</p>
  <button id="again" type="button">换一个二维码</button>
</main>
<script>
  const qr = document.getElementById('qr');
  const state = document.getElementById('state');
  const ttl = document.getElementById('ttl');
  let timer = null;

  async function open() {
    clearInterval(timer);
    state.textContent = '正在生成二维码…';
    ttl.textContent = '';
    try {
      const response = await fetch('./pair.json', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.hint || data.error || ('HTTP ' + response.status));
      qr.innerHTML = data.qrSvg;
      state.textContent = '二维码 ' + Math.round(data.ttlMs / 1000) + ' 秒内有效';
      let left = Math.round(data.ttlMs / 1000);
      timer = setInterval(() => {
        left -= 1;
        ttl.textContent = left > 0 ? '（' + left + 's）' : '';
        if (left <= 0) {
          clearInterval(timer);
          open();
        }
      }, 1000);
    } catch (error) {
      state.textContent = '生成失败：' + error.message;
    }
  }

  async function loadStatus() {
    const el = document.getElementById('remote');
    try {
      const response = await fetch('./status.json');
      const data = await response.json();
      el.textContent = (data.connected ? '中继已连接' : '中继未连接') + ' · ' + (data.publicUrl || '未注册');
    } catch (error) {
      el.textContent = '读取中继状态失败';
    }
  }

  document.getElementById('again').addEventListener('click', open);
  loadStatus();
  open();
</script>
</body>
</html>`;

export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.relayUrl) {
    throw new Error(
      'dsh-remote-relay: config.relayUrl is required. Point it at your own relay, e.g.\n'
      + '  - id: remote-relay\n'
      + '    name: dsh-remote-relay\n'
      + '    config:\n'
      + '      relayUrl: https://relay.example.com:8443\n'
      + '      shellBaseDomain: app.example.com\n'
      + '      shellPort: 8443',
    );
  }
  const logger = ctx.logger('remote-relay');

  const webPort = ctx.webServer?.port;
  const mobileAccess = webPort
    ? new MobileAccessClient({
      baseUrl: `http://127.0.0.1:${webPort}`,
      logger,
      configFile: join(
        process.env.DSH_HOME || join(homedir(), '.dsh'),
        'mobile-access/remote/origin/config/settings.json',
      ),
    })
    : null;

  let identity = null;
  let agent = null;
  let startPromise = null;
  let retryTimer = null;
  let lastStartError = null;
  let mobileError = null;
  let mobileSynced = false;

  function currentShellOrigin() {
    try {
      return shellOriginFor({
        shellOrigin: config.shellOrigin,
        shellScheme: config.shellScheme,
        shellBaseDomain: config.shellBaseDomain,
        shellPort: config.shellPort,
        deviceId: identity?.deviceId,
      });
    } catch {
      // Pairing needs shellBaseDomain; everything else (status, the running
      // tunnel) keeps working without it, so a misconfigured pairing surface
      // must not take the plugin down.
      return '';
    }
  }

  function relayWsBase() {
    return config.relayUrl.replace(/^http/i, 'ws');
  }

  function e2eAgentUrl() {
    return relayWsBase() + '/e2e/agent?device=' + encodeURIComponent(identity.deviceId);
  }

  function e2eShellUrl() {
    return relayWsBase() + '/e2e/shell?device=' + encodeURIComponent(identity.deviceId);
  }

  /** Keep DSH Mobile pointed at whatever public origin the relay handed us. */
  async function syncMobileAccess() {
    if (!mobileAccess || !config.autoConfigure) return;
    if (config.e2e && !identity?.deviceId) return;
    const url = config.e2e ? currentShellOrigin() : identity?.url;
    if (!url) return;
    try {
      const result = await mobileAccess.syncOrigin(url);
      mobileSynced = Boolean(result.running);
      mobileError = null;
      if (result.changed) logger.info?.('remote-relay: public origin applied to DSH Mobile');
    } catch (error) {
      mobileSynced = false;
      mobileError = error instanceof MobileAccessError ? error.code : 'error';
      if (error.code === 'not_installed') logger.info?.('remote-relay: DSH Mobile is not installed, skipping auto-config');
      else logger.warn?.(`remote-relay: could not configure DSH Mobile: ${error.message}`);
    }
  }

  /**
   * Ask the relay for this device's canonical origin. A stored identity can go
   * stale when the relay moves between single-tenant and per-device hosts, and
   * a stale URL silently points the phone at a host that no longer answers.
   */
  async function refreshIdentity() {
    if (!identity?.deviceId || !identity?.token) return false;
    try {
      const endpoint = new URL(`/api/v1/devices/${identity.deviceId}`, config.relayUrl);
      const response = await fetch(endpoint, {
        headers: { authorization: `Bearer ${identity.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return false;
      const data = await response.json();
      if (typeof data.url !== 'string' || data.url === identity.url) return false;
      const host = (() => {
        try { return new URL(data.url).host; } catch { return identity.host; }
      })();
      identity = { ...identity, url: data.url, host };
      await writeIdentity(config.configFile, identity);
      logger.info?.(`remote-relay: relay moved this device to ${data.url}`);
      return true;
    } catch (error) {
      logger.warn?.(`remote-relay: could not refresh device URL: ${error.message}`);
      return false;
    }
  }

  /** Open the pairing page once for a desktop that has never paired a phone. */
  async function maybeOpenPairingPage() {
    if (!mobileAccess || !config.autoConfigure) return;
    const marker = join(dirname(config.configFile), 'pair-page-opened');
    if (await exists(marker)) return;
    try {
      const snapshot = await mobileAccess.status();
      if ((snapshot?.deviceCount ?? 0) > 0) return;
    } catch {
      return;
    }
    if (openInBrowser(pairPageUrl())) {
      await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
      await writeFile(marker, new Date().toISOString() + '\n', { mode: 0o600 });
      logger.info?.('remote-relay: opened the pairing page, no phone paired yet');
    }
  }

  async function ensureStarted() {
    if (agent) return agent;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      identity = identity || (await readIdentity(config.configFile, logger));
      if (!identity || identity.relayUrl !== config.relayUrl) {
        logger.info?.(`remote-relay: registering this desktop with ${config.relayUrl}`);
        identity = await registerDevice(config);
        await writeIdentity(config.configFile, identity);
        logger.info?.(`remote-relay: registered device ${identity.deviceId} (${identity.url})`);
      }
      await refreshIdentity();

      if (config.e2e) {
        if (!identity?.deviceId) throw new Error('E2E mode requires a registered device');
        if (ensureHostIdentity(identity, logger)) await writeIdentity(config.configFile, identity);
        await syncMobileAccess();
        agent = new E2EAgent({
          relayUrl: e2eAgentUrl(),
          token: identity.token,
          pairingToken: identity.shellToken,
          backendUrl: config.backendUrl,
          shellOrigin: currentShellOrigin(),
          hostKey: identity.hostKey,
          logger,
          insecure: config.insecure,
        });
        agent.readyPromise.catch((error) => {
          lastStartError = error.message;
          logger.warn?.('remote-relay: E2E agent connect failed: ' + error.message);
        });
        agent.start();
      } else {
        await syncMobileAccess();
        agent = new RelayAgent({
          relayUrl: config.relayUrl,
          deviceId: identity.deviceId,
          token: identity.token,
          backendUrl: config.backendUrl,
          logger,
        });
        agent.on('online', () => logger.info?.('remote-relay: agent online'));
        agent.on('offline', (code) => logger.warn?.('remote-relay: agent offline (' + code + ')'));
        agent.start();
      }
      lastStartError = null;
      return agent;
    })().catch((error) => {
      lastStartError = error.message;
      logger.error?.(`remote-relay: start failed: ${error.message}`);
      scheduleRetry();
      throw error;
    }).finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  function scheduleRetry() {
    if (retryTimer || !config.autoStart) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      ensureStarted().catch(() => {});
    }, 30_000);
    retryTimer.unref?.();
  }

  async function stop() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (agent) {
      agent.stop();
      agent = null;
    }
  }

  function publicUrl() {
    if (!identity) return null;
    if (config.e2e) return currentShellOrigin();
    if (identity.url) return identity.url;
    if (identity.host) {
      const scheme = config.relayUrl.startsWith('https:') ? 'https' : 'http';
      return `${scheme}://${identity.host}`;
    }
    return null;
  }

  function pairPageUrl() {
    return webPort ? `http://127.0.0.1:${webPort}/remote-relay/pair` : '/remote-relay/pair';
  }

  function statusPayload() {
    return {
      ok: Boolean(agent?.connected),
      deviceId: identity?.deviceId ?? null,
      publicUrl: publicUrl(),
      backendUrl: config.backendUrl,
      relayUrl: config.relayUrl,
      connected: Boolean(agent?.connected),
      lastError: agent?.lastError ?? lastStartError,
      lastErrorHint: agent?.lastErrorHint ?? null,
      streams: agent?.streams?.size ?? 0,
      e2e: config.e2e,
      mobileAccess: mobileAccess
        ? { available: true, synced: mobileSynced, error: mobileError, pairUrl: pairPageUrl() }
        : { available: false, synced: false, error: 'no_web_port' },
    };
  }

  function statusText() {
    const status = statusPayload();
    if (!status.deviceId) {
      return [
        '远程中继尚未注册。',
        status.lastError ? `原因：${status.lastError}` : '正在尝试连接中继…',
        status.lastErrorHint ? `提示：${status.lastErrorHint}` : '',
        '',
        '稍后再试 /relay，或运行 /relay reset 重新注册。',
      ].join('\n');
    }
    const lines = [
      `远程中继：${status.connected ? '已连接' : '未连接'}（device ${status.deviceId}）`,
      `公网地址：${status.publicUrl}`,
      `本地后端：${status.backendUrl}`,
    ];
    if (status.mobileAccess.synced) {
      lines.push('', 'DSH Mobile 已自动指向该地址。配对页面：', `  ${pairPageUrl()}`);
    } else if (status.mobileAccess.available) {
      lines.push('', `DSH Mobile 未就绪（${status.mobileAccess.error || 'unknown'}），可运行 /relay sync 重试。`);
    } else {
      lines.push('', '未检测到 DSH Mobile，配对需先安装 dsh-mobile。');
    }
    if (status.lastError) lines.push('', `最近错误：${status.lastError}`);
    if (status.lastErrorHint) lines.push(`提示：${status.lastErrorHint}`);
    return lines.join('\n');
  }

  async function pairingPayload() {
    if (!mobileAccess) throw new MobileAccessError('DSH Mobile is not installed', 'not_installed');
    if (!mobileSynced) await syncMobileAccess();
    const pairing = await mobileAccess.openPairing(PAIRING_TTL_MS);
    if (!config.e2e) return pairing;

    if (!identity?.hostKey || !identity?.shellToken) {
      throw new Error('E2E host identity is not ready; wait for /relay to reconnect and try again');
    }
    const shellOrigin = currentShellOrigin();
    if (!shellOrigin) {
      throw new Error('config.shellBaseDomain is required to pair (e.g. app.example.com)');
    }
    const pairTarget = new URL(pairing.pairUrl);
    const appPath = pairTarget.pathname + pairTarget.search + pairTarget.hash;
    const shellUrl = buildShellUrl({
      shellOrigin,
      hostKey: publicHostKey(identity.hostKey),
      token: identity.shellToken,
      appPath,
    });
    const qrSvg = await QRCode.toString(shellUrl, {
      type: 'svg',
      margin: 1,
      width: 420,
      errorCorrectionLevel: 'M',
    });
    return { pairUrl: shellUrl, qrSvg, expiresAt: pairing.expiresAt };
  }

  await ctx.effect(async () => {
    const unregisterRoute = ctx.webServer.register({
      kind: 'prefix',
      path: '/remote-relay',
      handler: async (request, response) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;

        if (pathname === '/remote-relay/pair') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          response.end(PAIR_PAGE);
          return;
        }

        if (pathname === '/remote-relay/devices.json') {
          try {
            const list = mobileAccess && typeof mobileAccess.listDevices === 'function' ? await mobileAccess.listDevices() : [];
            const devices = (list || []).map((device) => ({
              id: device.id,
              label: device.label || '',
              createdAt: device.createdAt || null,
              expiresAt: device.expiresAt || null,
              lastSeenAt: device.lastSeenAt || null,
            }));
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ ok: true, devices }));
          } catch (error) {
            response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: 'devices_failed', hint: error.message }));
          }
          return;
        }

        if (pathname === '/remote-relay/devices/revoke') {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' });
            response.end();
            return;
          }
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          let deviceId = '';
          try {
            deviceId = String(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').deviceId || '');
          } catch {}
          if (!deviceId) {
            response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: 'missing_device' }));
            return;
          }
          try {
            const ok = mobileAccess && typeof mobileAccess.revokeDevice === 'function'
              ? await mobileAccess.revokeDevice(deviceId)
              : false;
            response.writeHead(ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ ok }));
          } catch (error) {
            response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: 'revoke_failed', hint: error.message }));
          }
          return;
        }

        if (pathname === '/remote-relay/status.json') {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(JSON.stringify(statusPayload()));
          return;
        }

        if (pathname === '/remote-relay/pair.json') {
          if (request.method !== 'GET' && request.method !== 'POST') {
            response.writeHead(405, { allow: 'GET, POST' });
            response.end();
            return;
          }
          try {
            const payload = await pairingPayload();
            const body = JSON.stringify({
              pairUrl: payload.pairUrl,
              qrSvg: payload.qrSvg,
              expiresAt: payload.expiresAt,
              ttlMs: Math.max(0, payload.expiresAt - Date.now()),
            });
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            response.end(body);
          } catch (error) {
            const status = error.code === 'not_installed' ? 501 : error.code === 'gateway_stopped' ? 503 : 500;
            response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: error.code || 'error', hint: error.message }));
          }
          return;
        }

        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' });
          response.end();
          return;
        }
        const body = JSON.stringify(statusPayload());
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(body);
      },
    });

    const commands = ctx.get('commands');
    const disposeCommand = commands?.register ? commands.register({
      name: 'relay',
      description: '查看或重置手机远程中继',
      input: { hint: '[status|pair|sync|url|reset]' },
      handler: async ({ rawInput }) => {
        const argument = String(rawInput || '').trim().split(/\s+/)[0] || 'status';
        if (argument === 'url') {
          const status = statusPayload();
          if (!status.publicUrl) return { kind: 'error', text: '远程中继尚未注册，请先运行 /relay status。' };
          return { kind: 'success', text: status.publicUrl };
        }
        if (argument === 'pair') {
          try {
            const payload = await pairingPayload();
            const seconds = Math.max(0, Math.round((payload.expiresAt - Date.now()) / 1000));
            return {
              kind: 'success',
              text: [
                `配对二维码已生成，${seconds} 秒内有效。`,
                '',
                '在电脑上打开下面这个页面扫码（推荐，全屏显示）：',
                `  ${pairPageUrl()}`,
                '',
                '或直接用手机访问：',
                `  ${payload.pairUrl}`,
              ].join('\n'),
            };
          } catch (error) {
            return { kind: 'error', text: `生成配对码失败：${error.message}` };
          }
        }
        if (argument === 'sync') {
          await refreshIdentity();
          await syncMobileAccess();
          return { kind: mobileSynced ? 'success' : 'error', text: statusText() };
        }
        if (argument === 'reset') {
          try {
            await stop();
            await rm(config.configFile, { force: true });
            identity = null;
            await ensureStarted();
            const url = publicUrl();
            return {
              kind: 'success',
              text: [
                `已重新注册中继，公网地址：${url}`,
                '',
                'DSH Mobile 已自动更新到新地址，请运行 /relay pair 重新配对。',
              ].join('\n'),
            };
          } catch (error) {
            return { kind: 'error', text: `重新注册失败：${error.message}` };
          }
        }
        if (argument === 'help') {
          return {
            kind: 'success',
            text: [
              '/relay         查看中继状态和公网地址',
              '/relay pair    生成配对二维码（自动配置 DSH Mobile）',
              '/relay sync    把公网地址重新写入 DSH Mobile',
              '/relay url     只显示公网地址',
              '/relay reset   重新注册（多用户模式下地址会变化）',
            ].join('\n'),
          };
        }
        return { kind: statusPayload().connected ? 'success' : 'error', text: statusText() };
      },
    }) : () => {};

    if (config.autoStart) {
      ensureStarted().catch(() => {});
    }

    return async () => {
      if (typeof disposeCommand === 'function') disposeCommand();
      unregisterRoute();
      await stop();
    };
  });
}