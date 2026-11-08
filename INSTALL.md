# 安装

这个仓库**不自带公共中继**：中继和静态壳都由你自己部署。装插件之前先准备好：

- 一台有公网 IP、能跑 Docker 的服务器；
- 一个域名（下文用 `example.com` 占位），并且配好两组通配符 DNS：
  - `relay.example.com` 和 `*.relay.example.com` → 你的服务器
  - `app.example.com` 和 `*.app.example.com` → 你的服务器
- 这两组子域的通配符证书，装到服务器上给 Caddy 用。

> 端口：默认走 8443（443 被占用或被网络干扰时更稳）。443 可用的话，把
> `shellPort` 和 `PUBLIC_PORT` 改成 443 即可。

## 1. 起中继

```bash
BASE_DOMAIN=relay.example.com PUBLIC_HOST=api.example.com \
  docker compose -f deploy/docker-compose.relay.yml up -d --build
```

- `BASE_DOMAIN`（必填）：租户子域的父域，每台电脑注册后拿到 `<id>.relay.example.com`；
- `PUBLIC_HOST`：这台电脑连中继时用的入口；留空则等于 `BASE_DOMAIN`；
- 健康检查：`curl https://<你的入口>:8443/health`。

## 2. 放静态壳

把 `lib/shell/` 下的 `index.html`、`sw.js`、`cookie-shim.js`、`ws-shim.js`
放到服务器某个目录（例如 `/srv/dsh-shell`），让 Caddy 把
`https://<device>.app.example.com:8443/` 指向它，并加上
`Service-Worker-Allowed: /`。可以照 `deploy/Caddyfile.example` 改。

## 3. 安装本插件并配置（必填）

本插件自带 `dsh-mobile` 依赖并自行挂载那个网关，**不要再单独装 dsh-mobile**，
否则会多出一个“移动访问”入口。

DSH Desktop → **插件** → 安装，填本仓库目录或打包好的 tgz，然后在 profile 的
patch 里给这个插件填上你自己的地址：

```yaml
- id: remote-relay
  name: dsh-remote-relay
  config:
    relayUrl: https://relay.example.com:8443
    shellBaseDomain: app.example.com
    shellPort: 8443
    backendUrl: http://127.0.0.1:3444
    autoStart: true
```

`relayUrl` 没配时插件会直接报错，并在错误里给出这段配置示例；
`shellBaseDomain` 只在配对时用到，没配的话配对会提示缺失。

改完 **完全退出 DSH 再打开**。

## 4. 配对

新会话里输入：

```
/relay pair
```

插件会：向中继注册这台电脑 → 把公网地址写进 dsh-mobile 的**自有反向代理**
（`127.0.0.1`、`3444`、`127.0.0.0/8`）→ 开一个 2 分钟有效的配对窗口。

然后在电脑浏览器打开 `http://127.0.0.1:<DSH端口>/remote-relay/pair`，用手机
相机扫二维码，确认设备名即可。

## 常用命令

```
/relay          查看状态和公网地址
/relay pair     重新生成配对二维码
/relay sync     把公网地址重新写进 dsh-mobile
/relay url      只显示公网地址
/relay reset    重新注册（地址会变，需要重新配对）
```

## 常见问题

- **`/relay` 显示未连接**：确认 DSH 已完全重启、插件已启用；
  再等 30 秒。仍然不行看 DSH 日志里的 `remote-relay`。
- **TLS 报错 / 连接反复断**：先看本机是不是开着 FlClash / Clash / Surge /
  sing-box 一类代理。它们默认的 **TUN + fake-IP** 会把域名解析成
  `198.18.x.x` 塞进代理节点，导致 TLS 间歇性失败。
  验证：`dig <设备ID>.relay.example.com` 应返回你的服务器 IP。
  解决（任选其一）：
  1. 规则里加 `DOMAIN-SUFFIX,example.com,DIRECT` 并放最前；
  2. `fake-ip-filter` 里加 `+.example.com`；
  3. 临时退出代理或关掉 TUN。
- **手机打开 502**：dsh-mobile 的 3444 后端没起来。跑 `/relay sync`，
  或者去面板点“保存并启动后端”。
- **配对失败**：二维码只有 2 分钟；`/relay pair` 重开一张。手机和电脑时间
  差太多也会失败。
- **手机能打开页面但实时输出不动**：`/relay` 应显示“已连接”；否则看中继日志。

## 运维备注

- DNS：`relay.example.com` 与 `*.relay.example.com` 指向中继服务器；
  `*.app.example.com` 指向提供静态壳的那台（可以是同一台）。
- 证书：DNS-01 签通配符，续期后重载 Caddy。
- 中继容器：`dsh_relay`，关键环境变量 `BASE_DOMAIN`、`PUBLIC_HOST`、
  `SINGLE_TENANT`（0 = 多租户）。
