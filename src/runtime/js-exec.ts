// JS-function-indexed execution seam (verbatim 2026-09-20T10:01).
//
// The verbatim's "full chain" wants a SECOND way to drive a site, beyond
// mouse/keyboard: when the analyzer captures a js-function
//   window.<root>.<method>(...args) -> {jsFunctionCapture, networkCapture},
// that capture is an index of the site's real JS entry points. This module
// turns that index into a runtime call: evaluate the SAME function with the
// SAME argument shape inside the live page, and correlate the result with the
// network traffic the call produces. The page answers with its own JS and its
// own session (cookies/localStorage/origin) — nothing synthesized.
//
// The verbatim also demands: "after each success action the only thing we need
// to do is to refresh the page so anything the server knows about us will be
// there again". `reloadAfterSuccess` implements exactly that.
//
// Contract (single evaluate body so esbuild __name helpers never leak into the
// page; stays anonymous, closes over nothing):
//   input:  { root, method, args, captureNetworkHits }
//   output: { ok, value, error, networkHits }

export interface JsFunctionIndex {
  /** window.<root> — the root object the captured function lives on. */
  root: string;
  /** The property name on the root, a real function at capture time. */
  method: string;
  /** The declared parameter names, in order (from the analyzer's parseParams). */
  params: string[];
  /** Captured sample arguments (one per param) — the shape the site expects. */
  sampleArgs: unknown[];
}

export interface JsCallResult {
  ok: boolean;
  root: string;
  method: string;
  /** The function's return value as evaluated in the page (JSON-safe). */
  value: unknown;
  /** Set when the page call threw; value is then undefined. */
  error?: string;
  /** The fetch/XHR the call produced (url + method), captured in-page. */
  networkHits: Array<{ url: string; method: string }>;
}

export interface JsCallOptions {
  /** args to pass; defaults to the capture's sampleArgs. */
  args?: unknown[];
  /** After a SUCCESSFUL call, await page.reload() (verbatim: "refresh the page ... so anything the server knows about us will be there again"). */
  reloadAfterSuccess?: boolean;
  /** Reload waitUntil / timeout; defaults to domcontentloaded / 60000. */
  reloadTimeoutMs?: number;
}

// The page-side recipe. Runs entirely inside the live page via evaluate; the
// capture-network-hits hoist is kept inside so the page's own fetch/XHR still
// round-trip through the site's own code path.
export const PAGE_JS_CALL = String.raw`
async ({ root, method, args, captureNetworkHits }) => {
  const holder = window;
  const fn = (holder[root] || {})[method];
  if (typeof fn !== "function") {
    return { ok: false, value: undefined, error: "not-a-function: " + root + "." + method, networkHits: [] };
  }
  const hits = [];
  const restore = [];
  if (captureNetworkHits) {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, init) {
        try {
          const url = typeof input === "string" ? input : input && input.url;
          hits.push({ url: String(url), method: ((init && init.method) || "GET") });
        } catch {}
        return origFetch.apply(this, arguments);
      };
      restore.push(() => { window.fetch = origFetch; });
    }
    const XHRp = window.XMLHttpRequest;
    if (typeof XHRp !== "undefined") {
      const open = XHRp.prototype.open;
      XHRp.prototype.open = function (m, u) {
        try { hits.push({ url: String(u), method: m }); } catch {}
        return open.apply(this, arguments);
      };
      restore.push(() => { XHRp.prototype.open = open; });
    }
  }
  try {
    const value = await fn.apply(holder[root], args || []);
    return { ok: true, value: value === undefined ? null : value, error: undefined, networkHits: hits };
  } catch (e) {
    return { ok: false, value: undefined, error: String(e), networkHits: hits };
  } finally {
    restore.forEach(function (r) { try { r(); } catch {} });
  }
}
`;

/**
 * Execute a captured js-function index inside the live page. `getPage` mirrors
 * the DI used by makeDomPrimitives — an async accessor for the current page —
 * so the same seam backs the ChatDriver, generated servers and the hub.
 */
export async function execJsFunction(
  getPage: () => Promise<any>,
  index: JsFunctionIndex,
  opts: JsCallOptions = {}
): Promise<JsCallResult> {
  const page = await getPage();
  const args = opts.args !== undefined ? opts.args : index.sampleArgs;
  const result = (await page.evaluate(
    PAGE_JS_CALL,
    { root: index.root, method: index.method, args, captureNetworkHits: true }
  )) as JsCallResult;
  if (result.ok && opts.reloadAfterSuccess) {
    const waitUntil = "domcontentloaded";
    await page.reload({ waitUntil, timeout: opts.reloadTimeoutMs ?? 60000 }).catch(() => {});
  }
  return result;
}