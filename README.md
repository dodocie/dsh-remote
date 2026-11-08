# dsh-remote-relay

Zero-config remote access for [DSH Mobile](https://github.com/saya-ch/dsh-mobile).

DSH Mobile already gives you the phone UI, pairing, and a private HTTP backend.
What it does not give you is a public HTTPS entry point. This project adds that
missing piece: a small relay, a desktop agent, and a DSH plugin. The desktop
keeps an **outbound** WebSocket to the relay, so you do not need a public IP,
port forwarding, Cloudflare, Tailscale, or a tunnel account.

```
phone ──HTTPS/WSS──> relay ──outbound WSS──> desktop agent ──HTTP/WS──> dsh-mobile (127.0.0.1:3444)
```

## Status

This is a working beta. **No public relay ships with this repository**: you
deploy your own (see [INSTALL.md](INSTALL.md)) and point the plugin at it.

The relay runs **multi-tenant** by default: every desktop registers once and
receives its own origin, `https://<id>.relay.example.com:8443`, served by a
wildcard certificate on your server. Adding a user is a registration, not a
deployment. A single-tenant mode is also supported (`SINGLE_TENANT=1`); it maps
one desktop onto one fixed public host.

> Port: 8443 is the default because it survives networks that reset 443 on
> unfiled domains. If 443 is free on your server, set `shellPort` /
> `PUBLIC_PORT` accordingly — dsh-mobile accepts a non-443 origin.

## Install (DSH Desktop)

1. Install **this package** from the 插件 page, or from a local checkout.
   Since 0.3.0 it carries `dsh-mobile` as a dependency and mounts that gateway
   itself, through `lib/mobile-host.mjs`, so the sidebar shows a single **远程**
   entry instead of a second **移动访问** one. Do not install `dsh-mobile` as a
   separate bundle alongside it: that registers a second gateway and a second
   sidebar entry.

   ```bash
   # from the checkout, for a local test profile:
   dsh plugin --profile <profile> add file:/absolute/path/to/dsh-remote
   ```

   In DSH Desktop the supported path is the 插件 page. A local directory or a
   packed tarball both work.
2. Configure the plugin — `relayUrl` is **required**, and pairing also needs
   `shellBaseDomain`. Add both to your profile patch:

   ```yaml
   - id: remote-relay
     name: dsh-remote-relay
     config:
       relayUrl: https://relay.example.com:8443
       shellBaseDomain: app.example.com
       shellPort: 8443
   ```

   Without `relayUrl` the plugin refuses to start and prints this snippet.
3. Fully quit and reopen DSH. The plugin registers this desktop with the relay
   and writes its identity to `$DSH_HOME/remote-relay/config.json`.
4. Run `/relay pair` in a DSH conversation.

The plugin does the rest on its own:

- it writes the public origin into dsh-mobile's **移动访问 → 自有反向代理**
  settings (`127.0.0.1:3444`, CIDR `127.0.0.0/8`) and starts the backend if it
  is stopped — you never type a URL or a CIDR;
- it opens a two-minute pairing window and prints the address of a QR page;
- open `/remote-relay/pair` on the desktop and scan the code with the phone.

Re-running `/relay pair` mints a fresh code. If you re-register with
`/relay reset`, the plugin rewrites the origin for you and only the phone
pairing has to be repeated.

## Commands

```
/relay          show status and the public URL
/relay pair     open a pairing window and print the QR page address
/relay sync     rewrite the public origin into dsh-mobile
/relay url      print only the public URL
/relay reset    re-register (the public URL changes; re-pair the phone)
```

HTTP endpoints for the desktop UI:

```
GET  /remote-relay          -> JSON status
GET  /remote-relay/pair     -> QR pairing page (opens a window on load)
POST /remote-relay/pair.json -> { pairUrl, qrSvg, ttlMs }
```

## Network and proxies

If the desktop agent logs TLS/socket errors or keeps reconnecting, check for a
local transparent proxy before debugging the server. Clash, FlClash, Surge and
sing-box in **TUN + fake-IP** mode resolve every domain to `198.18.x.x` and
route the connection through a proxy node. Add a direct rule for the relay
domain at the top of the rules:

```yaml
rules:
  - "DOMAIN-SUFFIX,example.com,DIRECT"
```

and/or exclude it from fake-IP:

```yaml
dns:
  fake-ip-filter:
    - "+.example.com"
```

Or temporarily disable TUN. `dig <relay-host>` should return the real public
IP, not `198.18.x.x`.

## Self-host the relay

The relay is a single Node process with one dependency (`ws`). It is normally
behind Caddy, which terminates TLS and preserves the external Host header.

```bash
# relay only, local test
BASE_DOMAIN=lvh.me PUBLIC_SCHEME=http PUBLIC_PORT=8787 \
  DATA_FILE=./data/devices.json node bin/relay.mjs

# register a desktop and run the agent manually
node bin/agent.mjs --relay http://127.0.0.1:8787 --backend http://127.0.0.1:3444
```

Docker:

```bash
docker compose -f deploy/docker-compose.relay.yml up -d --build
```

### Multi-tenant DNS and TLS

For `<id>.relay.example.com` you need:

- `relay.example.com` A/AAAA -> relay
- `*.relay.example.com` A/AAAA -> relay
- a wildcard TLS certificate, or Caddy on-demand TLS with an `ask` endpoint
  (the relay exposes `GET /api/v1/tls-ask?domain=...`).

The included `deploy/Caddyfile.example` shows both the single-tenant
`api.example.com` fallback and the multi-tenant wildcard site.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | relay listen address |
| `PORT` | `8787` | relay listen port |
| `BASE_DOMAIN` | *required* | tenant subdomain suffix, e.g. `relay.example.com` |
| `PUBLIC_HOST` | `BASE_DOMAIN` | host used in single-tenant mode |
| `SINGLE_TENANT` | `0` | one desktop per public host |
| `DEFAULT_DEVICE` | empty | device to use when single-tenant has several |
| `PUBLIC_SCHEME` | `https` | scheme in returned URLs |
| `PUBLIC_PORT` | empty | port in returned URLs |
| `DATA_FILE` | `./data/devices.json` | device registry |
| `SIGNUP_TOKEN` | empty | require `X-Signup-Token` on registration |
| `MAX_DEVICES` | `5000` | registry cap |

## E2E mode (experimental, D path)

The default path is still the plaintext relay described above. Setting
`DSH_RELAY_E2E=1` switches the desktop to an application-layer E2E transport:

- the phone opens a static shell at `https://<device>.app.example.com:8443/`;
- the shell runs a Service Worker that serves the DSH UI through an encrypted
  tunnel and exposes the CSRF cookie to `document.cookie`;
- the relay sees `hello` / `hello-ack` / AES-256-GCM records only;
- `/relay pair` returns a shell URL (and QR) with the host public key, shell
  token and dsh-mobile pairing path in the fragment.

The shell assets are in `lib/shell`; see `deploy/README.md` for DNS, the
wildcard certificate, the Caddy static block and the config fields. The relay
gains `/e2e/shell` (public shell socket) and `/e2e/agent` (device-token
authenticated agent socket).

The E2E transport is a beta: the shell token is visible to the relay in
`hello`, there is no persistent client credential or rekey yet, and the static
shell host remains a trust root.

## Security and privacy

- The relay sees plaintext HTTP between the relay and the desktop agent because
  TLS terminates at Caddy. It is a trusted hop in this beta. Do not describe it
  as end-to-end encrypted.
- Device registration returns a one-time token; only its SHA-256 digest is
  stored. The agent authenticates every WSS connection with the token.
- The public host only reaches dsh-mobile's paired backend, never the raw DSH
  web server. dsh-mobile still enforces pairing, Host/Origin checks, CSRF, and
  WebSocket path policy.
- Use `SIGNUP_TOKEN` for a private deployment, and put a reverse-proxy rate
  limit in front of `/api/v1/devices` before opening a public beta.

## License

MIT. DSH Mobile itself is Apache-2.0 and remains a separate project; this
package does not modify it.