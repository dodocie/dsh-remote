(function () {
  if (window.__DSH_WS_SHIM__) return;
  window.__DSH_WS_SHIM__ = true;

  var seq = 0;
  var instances = new Set();
  var bootId = null;
  var probing = false;
  var probeTimer = null;

  function report(kind, data) {
    try { if (window.__e2eReport) window.__e2eReport(kind, data); } catch (error) {}
  }

  /** The worker that serves this page, or null when it is gone. */
  function controller() {
    return navigator.serviceWorker && navigator.serviceWorker.controller;
  }

  function failInstance(instance, reason, code) {
    if (!instance || instance.readyState === 3) return;
    instance.readyState = 3;
    instance._detach();
    report('ws', { p: 'fail', id: instance._id, m: String(reason || 'tunnel lost').slice(0, 160) });
    instance._emit('error', { error: new Error(reason || 'tunnel lost'), message: reason || 'tunnel lost' });
    instance._emit('close', { code: code || 1006, reason: reason || 'tunnel lost' });
  }

  function failAll(reason, code) {
    for (var instance of Array.from(instances)) failInstance(instance, reason, code);
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
    this._createdAt = Date.now();
    instances.add(this);

    var ctrl = controller();
    report('ws', { p: 'new', u: String(url).slice(-70), ctrl: !!ctrl, sw: !!navigator.serviceWorker, state: self.readyState });
    if (!ctrl) {
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
        self._detach();
        self._emit('close', { code: data.code || 1000, reason: data.reason || '' });
      } else if (data.kind === 'error') {
        self._fail(new Error(data.message || 'websocket error'));
      }
    };
    this._onMessage = onMessage;

    this._onMessage = onMessage;
    navigator.serviceWorker.addEventListener('message', onMessage);
    var target = new URL(this.url, location.href);
    ctrl.postMessage({
      t: 'ws-open',
      id: this._id,
      path: target.pathname + target.search,
      protocols: Array.isArray(protocols) ? protocols : [],
    });
  }

  TunnelWebSocket.prototype._detach = function () {
    instances.delete(this);
    if (this._onMessage && navigator.serviceWorker) {
      try { navigator.serviceWorker.removeEventListener('message', this._onMessage); } catch (error) {}
    }
    this._onMessage = null;
  };

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
    failInstance(this, String((error && error.message) || error || 'websocket error'));
  };

  /**
   * The worker no longer serves this socket (it restarted, was replaced, or the
   * page lost its controller). Emit a real close so the app reconnects instead
   * of waiting forever for events that can never arrive.
   */
  TunnelWebSocket.prototype._lost = function (code, reason) {
    if (this.readyState === 3) return;
    report('ws', { p: 'lost', id: this._id, code: code, reason: reason });
    this.readyState = 3;
    this._detach();
    this._emit('close', { code: code || 1006, reason: reason || 'service_worker_restarted' });
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
    var controller = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!controller) {
      this._fail(new Error('service worker controller is gone'));
      return;
    }
    controller.postMessage({ t: 'ws-send', id: this._id, data: String(data) });
  };

  TunnelWebSocket.prototype.close = function (code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    var controller = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (controller) {
      try { controller.postMessage({ t: 'ws-close', id: this._id, code: code || 1000, reason: reason || '' }); } catch (error) {}
    }
    this.readyState = 3;
    this._detach();
    this._emit('close', { code: code || 1000, reason: reason || '' });
  };

  TunnelWebSocket.CONNECTING = 0;
  TunnelWebSocket.OPEN = 1;
  TunnelWebSocket.CLOSING = 2;
  TunnelWebSocket.CLOSED = 3;

  window.WebSocket = TunnelWebSocket;

  // --- liveness across backgrounding and worker restarts -------------------
  // iOS freezes both the page and its Service Worker when the phone switches
  // away. On return the worker may be a fresh instance with none of the virtual
  // socket table; the page's WebSocket objects still say OPEN, so the DSH client
  // never reconnects and its event stream silently stops updating. Ask the
  // worker which of our ids it still owns and fail the rest.
  function probe() {
    if (probing || instances.size === 0) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    var controller = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!controller) {
      failAll('service worker unavailable');
      return;
    }
    probing = true;
    var done = false;
    var channel = new MessageChannel();
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      probing = false;
      failAll('service worker did not answer');
    }, 6000);
    channel.port1.onmessage = function (event) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      probing = false;
      var data = event.data || {};
      if (data.t !== 'ws-probe-result') return;
      if (data.boot && bootId && data.boot !== bootId) {
        failAll('service worker restarted');
        bootId = data.boot;
        return;
      }
      bootId = data.boot || bootId;
      var owned = new Set(Array.isArray(data.owned) ? data.owned : []);
      var now = Date.now();
      for (var instance of Array.from(instances)) {
        // A socket opened moments ago may still have its ws-open queued behind
        // this probe; only judge sockets that had time to reach the worker.
        if (now - instance._createdAt < 2500) continue;
        if (data.tunnel !== 'open') failInstance(instance, 'tunnel not open');
        else if (!owned.has(instance._id)) failInstance(instance, 'websocket stream lost');
      }
      report('ws', { p: 'probe', boot: data.boot || '', tunnel: data.tunnel || '', owned: owned.size, sockets: instances.size });
    };
    try {
      controller.postMessage({ t: 'ws-probe', ids: Array.from(instances).map(function (instance) { return instance._id; }) }, [channel.port2]);
    } catch (error) {
      done = true;
      clearTimeout(timer);
      probing = false;
      failAll('service worker unavailable');
    }
  }

  function scheduleProbe() {
    if (probeTimer !== null) return;
    probeTimer = setInterval(probe, 5000);
  }

  function probeSoon() {
    setTimeout(probe, 150);
  }

  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      var data = event.data;
      if (!data || data.t !== 'e2e-tunnel') return;
      report('ws', { p: 'tunnel', state: data.state || '', detail: String(data.detail || '').slice(0, 120) });
      if (data.state !== 'open') failAll('tunnel ' + (data.state || 'closed'));
    });
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      failAll('service worker changed');
      probeSoon();
    });
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') probeSoon();
    });
    window.addEventListener('pageshow', probeSoon);
    window.addEventListener('focus', probeSoon);
  }
  window.addEventListener('online', probeSoon);

  // A unary API call that was in flight when the worker died can stay pending
  // forever, leaving the composer in its sending state with no way back. Keep a
  // generous deadline on JSON POSTs so a lost RPC settles as an error instead.
  // EventSource and streaming reads are not fetch() bodies and stay untouched.
  var API_TIMEOUT_MS = 60000;
  if (typeof window.fetch === 'function') {
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var path = url;
      try { path = new URL(url, location.href).pathname; } catch (error) {}
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var isJson = false;
      var headers = init && init.headers;
      try {
        if (headers && typeof headers.forEach === 'function') {
          headers.forEach(function (value, key) {
            if (String(key).toLowerCase() === 'content-type' && /json/i.test(String(value))) isJson = true;
          });
        } else if (headers) {
          for (var name in headers) {
            if (String(name).toLowerCase() === 'content-type' && /json/i.test(String(headers[name]))) isJson = true;
          }
        }
      } catch (error) {}
      var body = init && init.body;
      // Large JSON bodies are image/attachment uploads; a slow phone link may
      // legitimately need minutes for them, so only guard small RPC calls.
      if (method !== 'POST' || path.indexOf('/api/') !== 0 || !isJson
        || typeof body !== 'string' || body.length > 262144) {
        return nativeFetch.apply(this, arguments);
      }
      var outer = init && init.signal;
      if (outer && outer.aborted) return nativeFetch.apply(this, arguments);
      var controller = new AbortController();
      var onAbort = function () {
        try { controller.abort(outer.reason); } catch (error) { controller.abort(); }
      };
      if (outer) outer.addEventListener('abort', onAbort, { once: true });
      var timer = setTimeout(function () {
        try { controller.abort(new DOMException('request timed out; retry', 'TimeoutError')); }
        catch (error) { controller.abort(); }
      }, API_TIMEOUT_MS);
      var nextInit = {};
      for (var key in init) nextInit[key] = init[key];
      nextInit.signal = controller.signal;
      return nativeFetch.call(this, input, nextInit).finally(function () {
        clearTimeout(timer);
        if (outer) outer.removeEventListener('abort', onAbort);
      });
    };
  }

  scheduleProbe();
})();
