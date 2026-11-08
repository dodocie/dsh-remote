/**
 * Browser half of the plugin.
 *
 * DSH exposes UI slots to client modules; "conversation.chat.commandview" is a
 * keyed slot where a command row can replace the generic card. We take the
 * "relay" key so /relay renders a real card with the pairing QR inside the
 * conversation, instead of relying on chat text output.
 */

window.__ModuleLoader__.load({
  id: 'dsh-remote-relay',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const styles = {
      root: {
        border: '1px solid rgba(127,127,127,0.22)',
        borderRadius: '12px',
        padding: '14px 16px',
        margin: '8px 0',
        maxWidth: '360px',
        font: '13px/1.5 -apple-system, "PingFang SC", system-ui, sans-serif',
      },
      title: { fontWeight: 600, marginBottom: '2px' },
      sub: { opacity: 0.65, fontSize: '12px', wordBreak: 'break-all' },
      text: { whiteSpace: 'pre-wrap', fontSize: '12.5px', marginTop: '6px' },
      qr: { width: '240px', height: '240px', margin: '12px auto 8px', display: 'block' },
      button: {
        marginTop: '10px',
        width: '100%',
        padding: '8px 12px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.3)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      error: { color: '#d92d20', fontSize: '12px', marginTop: '8px' },
      page: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '10px',
        padding: '32px',
        font: '13px/1.5 -apple-system, "PingFang SC", system-ui, sans-serif',
      },
      pageHead: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textAlign: 'center' },
      pageTitle: { fontSize: '16px', fontWeight: 600, marginBottom: '4px' },
      // The QR arrives as an SVG with width/height attributes; without a rule
      // for the child it keeps its intrinsic height and paints over the link
      // box below (the parent's max-width only squashed it horizontally).
      pageQr: { width: 'min(260px, 72vw)', height: 'min(260px, 72vw)' },
      devicesHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '4px' },
      addButton: { marginTop: 0, width: 'auto', padding: '6px 12px', fontSize: '12px' },
      pairBox: { width: '100%', maxWidth: '420px', marginTop: '16px', paddingTop: '14px', borderTop: '1px solid rgba(127,127,127,0.18)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' },
      deviceLinkBox: { width: '100%', marginTop: '6px', paddingTop: '10px', borderTop: '1px dashed rgba(127,127,127,0.2)' },
      devices: { width: '100%', maxWidth: '420px', marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '6px' },
      devicesTitle: { fontSize: '12px', fontWeight: 600, opacity: 0.8, marginBottom: '2px' },
      deviceRow: {
        display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px',
        border: '1px solid rgba(127,127,127,0.18)', borderRadius: '8px',
      },
      deviceMain: { flex: '1 1 auto', minWidth: 0 },
      deviceLabel: { fontSize: '12.5px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      deviceMeta: { fontSize: '11px', opacity: 0.6, marginTop: '2px' },
      deviceRemove: {
        flex: '0 0 auto', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.28)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '11.5px',
      },
      link: {
        maxWidth: '420px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11.5px',
        lineHeight: 1.5,
        wordBreak: 'break-all',
        textAlign: 'center',
        opacity: 0.75,
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px dashed rgba(127,127,127,0.35)',
        cursor: 'pointer',
        userSelect: 'all',
      },
    };

    function RelayCard(props) {
      const node = props && props.node ? props.node : {};
      const outcome = node.outcome || null;
      const args = String(node.args || '').trim();
      const wantsPair = args === 'pair' || args.startsWith('pair ');
      const [pairing, setPairing] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const generate = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const response = await fetch('/remote-relay/pair.json', { method: 'POST' });
          const data = await response.json();
          if (!response.ok) throw new Error(data.hint || data.error || `HTTP ${response.status}`);
          setPairing(data);
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      }, []);

      React.useEffect(() => {
        if (wantsPair) generate();
      }, [generate, wantsPair]);

      const text = outcome && outcome.text ? String(outcome.text) : '';
      const summary = text ? text.split('\n')[0] : null;

      const body = wantsPair
        ? [
          error ? h('div', { key: 'error', style: styles.error }, '生成配对码失败：' + error) : null,
          pairing
            ? h('div', {
              key: 'qr',
              style: styles.qr,
              dangerouslySetInnerHTML: { __html: pairing.qrSvg },
            })
            : null,
          pairing ? h('div', { key: 'url', style: styles.sub }, pairing.pairUrl) : null,
          h('button', { key: 'again', type: 'button', style: styles.button, disabled: busy, onClick: generate },
            busy ? '生成中…' : pairing ? '换一个二维码' : '生成配对二维码'),
        ]
        : [h('div', { key: 'text', style: styles.text }, text)];

      return h('div', { style: styles.root }, [
        h('div', { key: 'title', style: styles.title }, wantsPair ? '远程' : '远程中继状态'),
        !wantsPair && summary ? null : null,
        ...body,
      ]);
    }

    /** Sidebar/header mark: a terminal screen and a phone joined by a light path. */
    const MARK_FROM = '#8b5cf6';
    const MARK_TO = '#22d3ee';

    function RelayMark(props) {
      const size = props && props.size ? props.size : 16;
      // Under 22px the prompt, stand and orbit all fall below a device pixel, so
      // the small variant keeps just the two device outlines.
      const full = size >= 22;
      const w = full ? 0.9 : 0.8;
      const violet = 'url(#relay-mark-a)';
      const cyan = 'url(#relay-mark-b)';
      return h('svg', {
        width: size,
        height: size,
        // Cropped to the drawing itself; the square padding of the 24x24 grid
        // would otherwise shrink the mark inside its 16px slot.
        viewBox: full ? '1.85 2.15 21.25 21.25' : '1.85 3.55 18.6 18.6',
        fill: 'none',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, [
        h('defs', { key: 'defs' }, [
          h('linearGradient', { key: 'a', id: 'relay-mark-a', x1: '0', y1: '1', x2: '1', y2: '0' }, [
            h('stop', { key: 's1', offset: '0', stopColor: MARK_FROM }),
            h('stop', { key: 's2', offset: '1', stopColor: MARK_TO }),
          ]),
          h('linearGradient', { key: 'b', id: 'relay-mark-b', x1: '0', y1: '0', x2: '0', y2: '1' }, [
            h('stop', { key: 's1', offset: '0', stopColor: MARK_TO }),
            h('stop', { key: 's2', offset: '1', stopColor: '#5b5bd6' }),
          ]),
        ]),
        // Screen
        h('rect', {
          key: 'screen', x: 2.3, y: 6.0, width: 12.8, height: 8.2, rx: 1.7,
          stroke: violet, strokeWidth: w,
        }),
        h('path', { key: 'stand', d: 'M8.7 14.2v1.4M6.6 15.7h4.2', stroke: violet, strokeWidth: w * 0.9 }),
        full ? h('path', { key: 'prompt', d: 'M5.9 9.0l1.7 1.5-1.7 1.5', stroke: violet, strokeWidth: w * 0.85 }) : null,
        full ? h('path', { key: 'cursor', d: 'M9.2 12.0h2.1', stroke: violet, strokeWidth: w * 0.85 }) : null,
        // Light path leaving the screen and landing on a node, as in the artwork.
        full ? h('path', {
          key: 'path',
          d: 'M15.4 7.2C17.8 5.8 20.6 6.5 21.35 8.3',
          stroke: violet, strokeWidth: w * 0.8, opacity: 0.9,
        }) : null,
        // Phone, in front
        h('rect', {
          key: 'phone', x: 14.2, y: 10.3, width: 5.8, height: 9.4, rx: 1.6,
          stroke: cyan, strokeWidth: w,
        }),
        full ? h('circle', { key: 'node', cx: 21.6, cy: 8.9, r: 1.05, fill: MARK_TO, stroke: 'none' }) : null,
      ]);
    }

    function timeAgo(value) {
      if (!value) return '未知';
      const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
      if (seconds < 60) return '刚刚';
      if (seconds < 3600) return Math.round(seconds / 60) + ' 分钟前';
      if (seconds < 86400) return Math.round(seconds / 3600) + ' 小时前';
      return Math.round(seconds / 86400) + ' 天前';
    }

    function expiresIn(value) {
      if (!value) return '长期有效';
      const days = Math.round((value - Date.now()) / 86400000);
      if (days < 0) return '已过期';
      if (days === 0) return '今天到期';
      return days + ' 天后到期';
    }

    /** Full page behind the sidebar entry: paired devices first, QR on demand. */
    function RelayPanel() {
      const [status, setStatus] = React.useState(null);
      const [pairing, setPairing] = React.useState(null);
      const [devices, setDevices] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [adding, setAdding] = React.useState(false);

      const loadDevices = React.useCallback(async () => {
        try {
          const response = await fetch('/remote-relay/devices.json');
          const data = await response.json();
          setDevices(Array.isArray(data.devices) ? data.devices : []);
        } catch {
          setDevices([]);
        }
      }, []);

      const revoke = React.useCallback(async (deviceId) => {
        if (!window.confirm('移除这台设备？它需要重新扫码配对。')) return;
        try {
          await fetch('/remote-relay/devices/revoke', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceId }),
          });
        } catch {}
        await loadDevices();
      }, [loadDevices]);

      const loadStatus = React.useCallback(async () => {
        try {
          const response = await fetch('/remote-relay/status.json');
          setStatus(await response.json());
        } catch {}
      }, []);

      // Only mint a pairing token when the user asks for one: every visit used to
      // burn one and drop a QR on screen that nobody asked for.
      const startPairing = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const response = await fetch('/remote-relay/pair.json', { method: 'POST' });
          const data = await response.json();
          if (!response.ok) throw new Error(data.hint || data.error || ('HTTP ' + response.status));
          setPairing(data);
          setAdding(true);
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      }, []);

      React.useEffect(() => { loadStatus(); loadDevices(); }, [loadStatus, loadDevices]);

      const connected = status && status.connected;
      const address = status && status.publicUrl ? status.publicUrl : '尚未注册';
      const count = devices ? devices.length : 0;

      return h('div', { style: styles.page }, [
        h('div', { key: 'head', style: styles.pageHead },
          h(RelayMark, { key: 'mark', size: 34 }),
          h('div', { key: 'title', style: styles.pageTitle }, '远程'),
          h('div', { key: 'sub', style: styles.sub },
            (connected ? '中继已连接' : '中继未连接') + ' · ' + address)),

        h('div', { key: 'devices', style: styles.devices },
          h('div', { key: 'head', style: styles.devicesHead },
            h('div', { key: 'title', style: styles.devicesTitle },
              '已配对设备' + (devices === null ? '' : '（' + count + '）')),
            h('button', {
              key: 'add',
              type: 'button',
              style: { ...styles.button, ...styles.addButton },
              disabled: busy,
              onClick: () => { if (adding) { setAdding(false); } else { startPairing(); } },
            }, adding ? '收起' : '+ 添加设备')),
          devices === null
            ? h('div', { key: 'loading', style: styles.sub }, '读取中…')
            : count === 0
              ? h('div', { key: 'empty', style: styles.sub }, '还没有设备配对。点上面的「添加设备」生成二维码。')
              : devices.map((device) => h('div', { key: device.id, style: styles.deviceRow }, [
                h('div', { key: 'main', style: styles.deviceMain },
                  h('div', { key: 'label', style: styles.deviceLabel }, device.label || '未命名设备'),
                  h('div', { key: 'meta', style: styles.deviceMeta },
                    device.id.slice(0, 8) + ' · 最近 ' + timeAgo(device.lastSeenAt) + ' · ' + expiresIn(device.expiresAt))),
                h('button', {
                  key: 'revoke',
                  type: 'button',
                  style: styles.deviceRemove,
                  onClick: () => revoke(device.id),
                }, '移除'),
              ]))),

        error ? h('div', { key: 'err', style: styles.error }, '生成配对码失败：' + error) : null,

        adding
          ? h('div', { key: 'pair', style: styles.pairBox }, [
            h('style', { key: 'qrstyle' }, '#remote-relay-qr svg{width:100%!important;height:100%!important;display:block}'),
            h('div', { key: 'hint', style: styles.sub }, '用手机相机扫描（2 分钟内有效）'),
            pairing
              ? h('div', {
                key: 'qr',
                id: 'remote-relay-qr',
                style: styles.pageQr,
                dangerouslySetInnerHTML: { __html: pairing.qrSvg },
              })
              : h('div', { key: 'busy', style: styles.pageQr }, busy ? '生成中…' : ''),
            pairing
              ? h('div', {
                key: 'link',
                style: styles.link,
                onClick: () => {
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(pairing.pairUrl).catch(() => {});
                  }
                },
                title: '点击复制',
              }, pairing.pairUrl)
              : null,
            h('button', {
              key: 'again',
              type: 'button',
              style: { ...styles.button, maxWidth: '260px' },
              disabled: busy,
              onClick: startPairing,
            }, busy ? '生成中…' : '换一个二维码'),
          ])
          : null,
      ]);
    }

    exports.name = 'remote-relay-client';
    exports.inject = ['slots'];
    exports.apply = (ctx) => {
      // The injection callback must hand the registration back: the slot keeps
      // the entry only as long as that disposer is owned by the injection.
      const disposers = [];
      disposers.push(ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register(
        { name: 'conversation.chat.commandview', key: 'relay' },
        RelayCard,
      )));
      disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: 'remote-relay', label: '远程', order: 0 },
        RelayMark,
      )));
      disposers.push(ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: 'remote-relay' },
        RelayPanel,
      )));
      return () => {
        for (const dispose of disposers) {
          if (typeof dispose === 'function') dispose();
        }
      };
    };
    return module.exports;
  },
});
