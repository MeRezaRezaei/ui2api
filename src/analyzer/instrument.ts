// Page-side instrumentation injected into every analyzed site.
// Wraps fetch/XHR and any wrapped root object's methods, recording each call
// with a correlation id so network calls can be tied to the action that fired them.
export const INSTRUMENT_SRC = `
(function () {
  if (window.__ui2api) return;
  var buf = { captures: [], current: null, seq: 0 };
  window.__ui2api = buf;
  function rec(c) { c.seq = ++buf.seq; c.t = Date.now(); buf.captures.push(c); }
  function safe(x) {
    try { return typeof x === "object" ? JSON.parse(JSON.stringify(x)) : x; }
    catch (e) { return String(x); }
  }
  var _fetch = window.fetch ? window.fetch.bind(window) : null;
  if (_fetch) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url);
      var method = (init && init.method) || (input && input.method) || "GET";
      var body; try { body = init && init.body ? init.body : (input && input.body); } catch (e) {}
      var callId = buf.current;
      return _fetch(input, init).then(function (resp) {
        var rb; try { rb = resp.clone().text(); } catch (e) {}
        Promise.resolve(rb).then(function (txt) {
          rec({ kind: "network", method: method, url: url, requestBody: body, responsePreview: txt && txt.slice(0, 2000), callId: callId });
        });
        return resp;
      }).catch(function (e) {
        rec({ kind: "network", method: method, url: url, requestBody: body, error: String(e), callId: callId });
        throw e;
      });
    };
  }
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u2u = { m: m, u: u }; return _open.apply(this, arguments); };
  var _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (b) {
    var callId = buf.current;
    rec({ kind: "network", method: this.__u2u && this.__u2u.m, url: this.__u2u && this.__u2u.u, requestBody: b, callId: callId });
    return _send.apply(this, arguments);
  };
  window.__ui2api_wrapRoot = function (obj, rootName) {
    Object.getOwnPropertyNames(obj).forEach(function (k) {
      var v = obj[k];
      if (typeof v === "function") {
        var orig = v;
        obj[k] = function () {
          var args = Array.prototype.slice.call(arguments);
          var callId = ++buf.seq; buf.current = callId;
          rec({ kind: "js-function", function: rootName + "." + k, args: args.map(safe), callId: callId });
          var r;
          try { r = orig.apply(this, args); } finally { buf.current = null; }
          if (r && typeof r.then === "function") {
            return r.then(function (rr) {
              rec({ kind: "js-return", function: rootName + "." + k, returnPreview: safe(rr), callId: callId });
              return rr;
            }).catch(function (e) {
              rec({ kind: "js-return", function: rootName + "." + k, error: String(e), callId: callId });
              throw e;
            });
          }
          rec({ kind: "js-return", function: rootName + "." + k, returnPreview: safe(r), callId: callId });
          return r;
        };
      }
    });
  };

  // --- DOM-interaction capture (works on sites with NO window.<root>) ---
  function selectorFor(el) {
    if (!el || !el.tagName) return null;
    var parts = [];
    var e = el;
    for (var i = 0; i < 5 && e && e.nodeType === 1; i++) {
      var s = e.tagName.toLowerCase();
      if (e.id) s += "#" + e.id;
      else if (e.className && typeof e.className === "string" && e.className.trim())
        s += "." + e.className.trim().split(/\s+/)[0];
      parts.unshift(s);
      e = e.parentElement;
    }
    return parts.join(">");
  }
  var _clearTimer = null;
  function markDom(kind, el, extra) {
    var callId = ++buf.seq; buf.current = callId;
    var label = "";
    try {
      label = (el && (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "")).slice(0, 80);
    } catch (e) {}
    rec(Object.assign({ kind: "dom-event", domKind: kind, selector: selectorFor(el), label: label, callId: callId }, extra || {}));
    if (_clearTimer) clearTimeout(_clearTimer);
    // Keep the call id "open" briefly so network calls fired by the interaction
    // are correlated to it even if they happen a few ticks later.
    _clearTimer = setTimeout(function () { buf.current = null; }, 200);
  }
  document.addEventListener("click", function (e) { markDom("click", e.target); }, true);
  document.addEventListener("submit", function (e) {
    var form = e.target;
    var fields = [];
    try {
      var nodes = form.querySelectorAll("input[name],select[name],textarea[name]");
      for (var i = 0; i < nodes.length; i++) if (nodes[i].name) fields.push(nodes[i].name);
    } catch (err) {}
    markDom("submit", form, { fields: fields });
  }, true);
  document.addEventListener("input", function (e) {
    var v = e.target && e.target.value ? String(e.target.value).slice(0, 80) : "";
    markDom("input", e.target, { value: v });
  }, true);
})();
`;
