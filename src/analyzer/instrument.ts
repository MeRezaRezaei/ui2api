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
})();
`;
