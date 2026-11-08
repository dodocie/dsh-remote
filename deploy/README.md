# Deploying the relay

The relay is one Node process. It is designed to sit behind Caddy (or any
HTTPS reverse proxy that preserves the external `Host` header and forwards
WebSocket upgrades).

## 1. DNS

Single-tenant (one desktop, simplest):

- `api.example.com` A/AAAA -> relay server

Multi-tenant (one subdomain per desktop):

- `relay.example.com` A/AAAA -> relay server
- `*.relay.example.com` A/AAAA -> relay server

## 2. Relay

```bash
cd dsh-remote
BASE_DOMAIN=api.example.com PUBLIC_HOST=api.example.com SINGLE_TENANT=1 \
  DATA_FILE=/var/lib/dsh-remote/devices.json \
  node bin/relay.mjs
```

Docker:

```bash
docker compose -f deploy/docker-compose.relay.yml up -d --build
```

The compose file expects an external Docker network named `deploy_default`
and joins the relay to it so Caddy can resolve `relay:8787`. Change the network
name in the compose file if your Caddy stack uses another project name.

## 3. Caddy

Use `deploy/Caddyfile.example` as a starting point. The two important details:

1. Preserve the external `Host` (Caddy does this by default; do not add
   `header_up Host`).
2. Do not buffer the response; `flush_interval -1` keeps streaming and
   WebSocket traffic responsive.

For multi-tenant on-demand TLS, Caddy calls:

```
GET http://relay:8787/api/v1/tls-ask?domain=<device>.relay.example.com
```

The relay returns 200 only for registered devices and for the base host.

## 4. Verify

```bash
curl https://api.example.com/health
# {"ok":true,"devices":0,"online":0,...}

curl -X POST https://api.example.com/api/v1/devices \
  -H 'content-type: application/json' -d '{"name":"my-mac"}'
# {"id":"...","token":"...","host":"api.example.com","url":"https://api.example.com"}
```

Start a desktop agent with that token and backend `http://127.0.0.1:3444`:

```bash
node bin/agent.mjs --relay https://api.example.com \
  --device <id> --token <token> --backend http://127.0.0.1:3444
```

Then `curl https://api.example.com/health` should show `online: 1`, and a
request to `https://api.example.com/` should reach the desktop (dsh-mobile's
backend must be configured and running).

## 5. Public beta hardening

- Set `SIGNUP_TOKEN` and put the same value in the desktop plugin config.
- Rate-limit `POST /api/v1/devices` at the reverse proxy or firewall.
- Keep `MAX_DEVICES` small during beta.
- Monitor outbound bandwidth; a 5 Mbps VPS is fine for text chat but not for
  large attachments.
- The relay sees plaintext between itself and the desktop. Add an end-to-end
  layer before making privacy claims.

## 6. E2E shell (D path, experimental)

The relay can pair a static shell with the desktop agent and forward only
ciphertext. The default path stays the plaintext relay until `DSH_RELAY_E2E=1`
is set on the desktop.

DNS and TLS:

- `*.app.example.com` A/AAAA -> the same relay server.
- a wildcard certificate covering `*.app.example.com` (acme.sh DNS-01 is the
  simplest; Caddy on-demand TLS needs a separate `ask` endpoint because the
  relay's `tls-ask` only knows `*.relay.example.com` device hosts).

Caddy (static shell; the relay process does not serve these files):

```caddy
*.app.example.com:8443 {
    root * /srv/dsh-remote/shell
    file_server
    header Service-Worker-Allowed "/"
}
```

Copy the shell assets from the package:

```bash
install -d /srv/dsh-remote/shell
cp lib/shell/index.html lib/shell/sw.js lib/shell/cookie-shim.js lib/shell/ws-shim.js /srv/dsh-remote/shell/
```

Desktop plugin config (or environment):

```bash
DSH_RELAY_E2E=1
DSH_RELAY_E2E_INSECURE=0   # only for local self-signed tests
```

Optional plugin config fields: `e2e: true`, `shellOrigin`,
`shellScheme`, `shellBaseDomain` (default `app.example.com`), `shellPort`
(default `8443`). With the default derivation the phone URL is
`https://<device>.app.example.com:8443/`.

The phone flow is unchanged to the user: `/relay pair` shows a QR. The QR now
contains the shell URL with `#e2e=` (host public key + shell token + relay WSS)
and `#app=` (the dsh-mobile pairing path). The relay sees `hello`, `hello-ack`
and AES-GCM records only.

Limitations: the shell token is still sent in the E2E `hello` (so the relay
sees it), there is no persistent client credential or rekey yet, and the shell
token lives in the static shell host's logs through the SW script URL. Treat
this as a beta of the E2E transport, not a finished privacy claim.

## 实例部署记录

一次可复现的部署长这样（路径按你的机器替换）：

- 通配符证书 `*.<shell-base-domain>` 用 `acme.sh` 的 `dns_tencent` 插件签发，
  装到 `<cert-dir>/app.<shell-base-domain>.crt` 与 `.key`；
- Caddy 用这份证书把 `https://<device>.<shell-base-domain>:8443/` 指到静态壳目录
  （本仓库 `lib/shell/` 里的四个文件）；
- 中继容器用 `deploy/Dockerfile.relay` 构建，端点为 `/e2e/shell` 与 `/e2e/agent`；
- `https://<relay-host>:8443/health` 应当返回健康状态。

升级前先备份上一版镜像和 Caddyfile，回滚就是把它们换回来。

### Activating E2E on the phone

The desktop plugin still defaults to the plaintext path. To switch:

1. Set `DSH_RELAY_E2E=1` for DSH Desktop and restart DSH (the plugin then sets
   dsh-mobile's public origin to the `*.app.example.com` shell and starts the E2E
   agent).
2. Run `/relay pair`; the QR now opens the shell URL.
3. Pair the phone again: the public origin changed, so the old pairing points at
   the old relay origin and will not carry the E2E shell.

Keep the old relay container image and Caddyfile backups; rolling back is
retagging the previous image and restoring the Caddyfile.
