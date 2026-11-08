/**
 * The browser filters Set-Cookie on a Response constructed by a Service
 * Worker (the spike confirmed document.cookie stays empty). dsh-mobile's
 * client reads the CSRF cookie from document.cookie, so the shell keeps its
 * own jar and exposes it through a Document.cookie accessor.
 */
(function () {
  if (window.__DSH_COOKIE_SHIM__) return;
  window.__DSH_COOKIE_SHIM__ = true;

  var jar = new Map(Object.entries(window.__DSH_COOKIE_JAR__ || {}));
  var original = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');


  // The service worker's jar lives in IndexedDB, which iOS can evict while the
  // worker is suspended. Mirror every jar entry into the browser's own cookie
  // store (bypassing this accessor) so a request still carries the session if
  // the jar ever comes up empty.
  function mirror(name, value) {
    try {
      if (!original || !original.set) return;
      if (!name || value === undefined || value === null) return;
      var attributes = '; path=/; Secure; SameSite=Lax';
      original.set.call(document, name + '=' + value + attributes);
    } catch (error) {}
  }

  function mirrorAll() {
    jar.forEach(function (value, name) { mirror(name, value); });
  }

  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    get: function () {
      var text = Array.from(jar.entries())
        .map(function (entry) { return entry[0] + '=' + entry[1]; })
        .join('; ');
      if (text) return text;
      try { return original && original.get ? original.get.call(this) : ''; } catch (error) { return ''; }
    },
    set: function (value) {
      var text = String(value);
      var first = text.split(';')[0];
      var equals = first.indexOf('=');
      if (equals <= 0) return;

      var name = first.slice(0, equals).trim();
      var cookieValue = first.slice(equals + 1).trim();
      if (!name) return;

      if (cookieValue === '' || /max-age=0/i.test(text)) jar.delete(name);
      else jar.set(name, cookieValue);

      mirror(name, cookieValue === '' ? '' : cookieValue);
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ t: 'cookie-set', cookie: text });
      }
    },
  });

  // Seed the browser store with whatever the worker already had.
  setTimeout(mirrorAll, 0);
  window.addEventListener('load', mirrorAll);

  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      var data = event.data;
      if (!data || data.t !== 'cookie-jar') return;
      jar.clear();
      Object.keys(data.jar || {}).forEach(function (key) { jar.set(key, data.jar[key]); });
      mirrorAll();
    });
  }
})();