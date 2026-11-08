(function () {
  if (window.__DSH_WS_SHIM__) return;
  window.__DSH_WS_SHIM__ = true;

  var seq = 0;

  function report(kind, data) {
    try { if (window.__e2eReport) window.__e2eReport(kind, data); } catch (error) {}
  }

  function TunnelWebSocket(url, protocols) {
    var self = this;
    this.url = String(url);
    this.readyState = 0;
    this.binaryType = 'blob';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.protocol = '';
    this._id = 'ws' + (++seq) + '-' + Math.random().toString(36).slice(2);
    this._listeners = { open: [], message: [], close: [], error: [] };

    var controller = navigator.serviceWorker && navigator.serviceWorker.controller;
    report('ws', { p: 'new', u: String(url).slice(-70), ctrl: !!controller, sw: !!navigator.serviceWorker, state: self.readyState });
    if (!controller) {
      setTimeout(function () { self._fail(new Error('no service worker controller')); }, 0);
      return;
    }

    var onMessage = function (event) {
      var data = event.data;
      if (!data || data.t !== 'ws-event' || data.id !== self._id) return;
      if (data.kind === 'open') {
        report('ws', { p: 'open', id: self._id });
        self.readyState = 1;
        self._emit('open', {});
      } else if (data.kind === 'message') {
        self._emit('message', { data: data.data });
      } else if (data.kind === 'close') {
        report('ws', { p: 'close', id: self._id, code: data.code, reason: String(data.reason || '').slice(0, 100) });
        self.readyState = 3;
        self._emit('close', { code: data.code || 1000, reason: data.reason || '' });
        navigator.serviceWorker.removeEventListener('message', onMessage);
      } else if (data.kind === 'error') {
        self._fail(new Error(data.message || 'websocket error'));
      }
    };

    navigator.serviceWorker.addEventListener('message', onMessage);
    var target = new URL(this.url, location.href);
    controller.postMessage({
      t: 'ws-open',
      id: this._id,
      path: target.pathname + target.search,
      protocols: Array.isArray(protocols) ? protocols : [],
    });
  }

  TunnelWebSocket.prototype._emit = function (type, props) {
    var event = new Event(type);
    Object.keys(props || {}).forEach(function (key) { event[key] = props[key]; });
    var handler = this['on' + type];
    if (typeof handler === 'function') handler.call(this, event);
    var listeners = this._listeners[type] || [];
    for (var i = 0; i < listeners.length; i += 1) {
      try { listeners[i].call(this, event); } catch (error) { setTimeout(function () { throw error; }, 0); }
    }
  };

  TunnelWebSocket.prototype._fail = function (error) {
    report('ws', { p: 'fail', id: this._id, m: String(error && error.message || error).slice(0, 160) });
    this.readyState = 3;
    this._emit('error', { error: error, message: error.message });
    this._emit('close', { code: 1006, reason: 'error' });
  };

  TunnelWebSocket.prototype.addEventListener = function (type, listener) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(listener);
  };

  TunnelWebSocket.prototype.removeEventListener = function (type, listener) {
    var list = this._listeners[type] || [];
    var index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  };

  TunnelWebSocket.prototype.send = function (data) {
    if (this.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError');
    navigator.serviceWorker.controller.postMessage({ t: 'ws-send', id: this._id, data: String(data) });
  };

  TunnelWebSocket.prototype.close = function (code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    navigator.serviceWorker.controller.postMessage({ t: 'ws-close', id: this._id, code: code || 1000, reason: reason || '' });
    this.readyState = 3;
    this._emit('close', { code: code || 1000, reason: reason || '' });
  };

  TunnelWebSocket.CONNECTING = 0;
  TunnelWebSocket.OPEN = 1;
  TunnelWebSocket.CLOSING = 2;
  TunnelWebSocket.CLOSED = 3;

  window.WebSocket = TunnelWebSocket;
})();