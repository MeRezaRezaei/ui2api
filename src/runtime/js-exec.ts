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
  /**
   * True when the site's function returned an observable and the seam
   * subscribed to it — mirroring the site's own dispatch pattern (gemini
   * senders return RxJS observables; the site's app subscribes to fire the
   * network). The subscription is what makes the captured sender's traffic
   * happen; it is the site's own JS, nothing synthesized.
   */
  subscribed?: boolean;
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
    return { ok: false, value: undefined, error: "not-a-function: " + root + "." + method, networkHits: [], subscribed: false };
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
  let subscribed = false;
  try {
    let value = await fn.apply(holder[root], args || []);
    // Site-own dispatch pattern (gemini et al.): the captured sender returns an
    // RxJS observable; the site's own app subscribes to fire the network. The
    // seam mirrors that — subscribe for a bounded window so the traffic the
    // function produces actually happens, exactly as the site would.
    if (value && typeof value.subscribe === "function") {
      subscribed = true;
      await new Promise((resolve) => {
        const sub = value.subscribe({
          next: function () {},
          error: function () { resolve(undefined); },
          complete: function () { resolve(undefined); },
        });
        setTimeout(function () { try { sub.unsubscribe(); } catch {} resolve(undefined); }, 1500);
      });
    }
    return { ok: true, value: value === undefined ? null : value, error: undefined, networkHits: hits, subscribed };
  } catch (e) {
    return { ok: false, value: undefined, error: String(e), networkHits: hits, subscribed };
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
  // PAGE_JS_CALL is an async arrow-function SOURCE, not a callable — passing it
  // to evaluate as a string makes Playwright treat it as an expression and
  // return undefined (verified live on playwright 1.62.1). Mirror the proven
  // gemini-rpc invocation: pass the source through as an arg and have evaluate's
  // OWN function build + invoke the recipe (same new Function pattern as
  // callGeminiRpc), so the input object is actually bound.
  const result = (await page.evaluate(
    async ({ fnSrc, input }: { fnSrc: string; input: unknown }) => {
      const fn = new Function("arg", "return (" + fnSrc + ")(arg);");
      return fn(input);
    },
    {
      fnSrc: PAGE_JS_CALL,
      input: { root: index.root, method: index.method, args, captureNetworkHits: true },
    }
  )) as JsCallResult;
  if (result.ok && opts.reloadAfterSuccess) {
    const waitUntil = "domcontentloaded";
    await page.reload({ waitUntil, timeout: opts.reloadTimeoutMs ?? 60000 }).catch(() => {});
  }
  return result;
}