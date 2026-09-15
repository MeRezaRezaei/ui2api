// Gemini batchexecute RPC client — the layer between "the page's own JS" and a
// callable capability API. Everything Gemini does on the wire goes through ONE
// endpoint: POST /_/BardChatUi/data/batchexecute (params f.req/f.sid/_reqid,
// header X-Framework-Xsrf-Token), declared RPC descriptors distinguished by
// method id like "/BardFrontendService.StreamGenerate".
//
// This module runs the call INSIDE the logged-in page (page.evaluate + fetch),
// so the request carries the user's real session cookies, the page's own XSRF
// token and the site's own XSSI guard handling — nothing synthetic, nothing a
// server could tell apart from the site's own XHRs. Responses come back as
// google's proto-json batch format and are unwrapped here.
//
// NOTE: the exact proto payloads (field layout per RPC) are version-fragile;
// the bundle analysis pinned the wire mechanics + descriptor ids, but individual
// RPC bodies must be verified against a live capture (or tuned from the
// response error) before they are trusted in production. Capabilities that the
// ChatDriver already implements (chat stream) keep using the proven UI path.

export interface GeminiRpcResult {
  ok: boolean;
  method: string;
  /** The unwrapped JSON payload of the first response entry (arbitrary shape). */
  data: unknown;
  /** Raw response text after XSSI-guard strip (for debugging/fingerprinting). */
  raw: string;
  latencyMs: number;
  /** Set when Gemini answered with an error envelope instead of data. */
  error?: string;
}

// The page-side implementation — a single evaluate body so esbuild's __name
// helpers never leak into the page. Stays anonymous, closes over nothing.
const PAGE_RPC = String.raw`
async ({ method, payload }) => {
  // 1. XSRF token — the same source the site's own XHRs use (WIZ_global_data's
  //    SNlM0e field; falls back to the __Secure-1PSIDTS cookie, and finally to
  //    an APISID-hash the way google's own code does).
  let token = "";
  try {
    const wiz = window.WIZ_global_data;
    if (wiz && wiz.SNlM0e) token = wiz.SNlM0e;
  } catch {}
  if (!token) {
    const m = document.cookie.match(/(?:^|;\s*)__Secure-1PSIDTS=([^;]+)/);
    if (m) token = decodeURIComponent(m[1]);
  }
  if (!token) {
    // SAPISIDHASH fallback (public google convention): ts_<HMAC-SHA1(SAPISID, ts + " " + SAPISID)>.
    try {
      const sapisid = document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1] ?? "";
      const ts = Math.floor(Date.now() / 1000);
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sapisid), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ts + " " + sapisid));
      const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
      token = ts + "_" + hex;
    } catch {}
  }

  // 2. The request-id scheme Gemini uses: hh*3600+mm*60+ss + counter*1E5.
  const now = new Date();
  const int = (window.__ui2api_reqid ?? 0) + 1;
  try { window.__ui2api_reqid = int; } catch {}
  const base = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const reqid = (base + int * 1e5) + "";

  // 3. f.sid — the session id the page keeps (from the app bootstrap; commonly
  //    in WIZ_global_data.zChJod or the BrowserChannel gsession id). The batch
  //    frontend tolerates 1 (unset) for most reads; StreamGenerate needs the
  //    real one, which the page's own RPC layer normally supplies.
  let sid = "";
  try {
    const wiz = window.WIZ_global_data;
    if (wiz && wiz.zChJod) sid = wiz.zChJod;
  } catch {}
  if (!sid) {
    const m = document.cookie.match(/(?:^|;\s*)SID=([^;]+)/);
    if (m) sid = m[1];
  }

  // 4. Wire the call EXACTLY like the site's own transport (matched against a
  //    live capture of the UI's bootstrap RPCs): the descriptor id goes inside
  //    the f.req body AND echoed as the rpcids query param on the batch URL;
  //    f.sid/bl/hl/source-path/_reqid/rt ride the URL; the body carries only
  //    f.req. The descriptor is either a full path ("/BardFrontendService.X")
  //    or a compact short id the UI itself uses (e.g. "sJBwce" =
  //    ListConversations, per live capture).
  const bodyObj = [[[method, JSON.stringify(payload), "null", "generic"]]];
  const qp = new URLSearchParams();
  qp.set("rpcids", method);
  qp.set("source-path", method === "otAQ7b" || method === "sJBwce" ? "/" : "/app");
  qp.set("bl", "boq_assistant-bard-web-server_20260914.08_p0");
  qp.set("f.sid", sid);
  qp.set("hl", "en-US");
  qp.set("_reqid", reqid);
  qp.set("rt", "c");
  // The auth params ride the query string exactly as the UI sends them.
  qp.set("at", token);

  const t0 = performance.now();
  const res = await fetch("/_/BardChatUi/data/batchexecute?" + qp.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-framework-xsrf-token": token,
    },
    credentials: "include",
    body: "f.req=" + encodeURIComponent(JSON.stringify(bodyObj)),
  });
  const latencyMs = Math.round(performance.now() - t0);
  const text = await res.text();
  if (!res.ok) return { ok: false, http: res.status, raw: text.slice(0, 4000), latencyMs };

  // 5. XSSI guard + length-prefixed framing. Response shape (byte-confirmed):
  //      )]}'\n\n<len>\n<json-line>\n<len>\n<json-line>\n ...
  //    len = json bytes + 2 (counts the surrounding newlines). JSON chunks are
  //    one line each (JSON escapes its own newlines), so line-splitting after
  //    the guard is the robust parse; len lines are pure digits, payload lines
  //    start with a bracket.
  let body;
  if (text.startsWith(")]}'")) body = text.slice(5); // 4 guard chars + \n
  else body = text;
  const frames = [];
  for (const line of body.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    if (/^\d+$/.test(l)) continue; // length prefix line
    if (!l.startsWith("[")) continue; // not a JSON frame (be safe)
    try {
      frames.push(JSON.parse(l));
    } catch (e) {
      return { ok: false, raw: text.slice(0, 4000), latencyMs, error: "unparseable batch frame: " + String(e) };
    }
  }
  if (frames.length === 0) return { ok: false, raw: text.slice(0, 4000), latencyMs, error: "empty batch response" };
  const parsed = frames[0];
  // Batch shape: [["wrb.fr", "<method>", <payload-json>, null, ...], ...]
  const entry = Array.isArray(parsed) ? parsed.find((r) => Array.isArray(r) && r[0] === "wrb.fr") : null;
  if (!entry) return { ok: false, raw: body.slice(0, 4000), latencyMs, error: "no wrb.fr entry in batch" };
  const methodEcho = typeof entry[1] === "string" ? entry[1] : method;
  // Gemini encodes errors as ["er",<code>,<msg>,...] entries — surface them.
  const er = Array.isArray(parsed) && parsed.find((r) => Array.isArray(r) && r[0] === "er");
  const payloadJson = entry[2];
  const data = typeof payloadJson === "string" ? (() => { try { return JSON.parse(payloadJson); } catch { return payloadJson; } })() : payloadJson;
  return {
    ok: !er,
    method: methodEcho,
    data,
    raw: body.slice(0, 20000),
    latencyMs,
    ...(er ? { error: "batch error " + JSON.stringify(er).slice(0, 400) } : {}),
  };
}
`;

export interface GeminiRpcCall {
  method: string;
  /** proto-json payload for the RPC body (array/object — google's field encoding). */
  payload: unknown;
  timeoutMs?: number;
}

export async function callGeminiRpc(page: {
  evaluate: <T>(fn: (arg: any) => T, arg?: unknown) => Promise<T>;
}, call: GeminiRpcCall): Promise<GeminiRpcResult> {
  // PAGE_RPC is a module constant — it cannot be referenced as a closure var
  // inside evaluate (Playwright re-creates the callback in the page; only
  // function args cross the bridge). Pass the source string as an argument.
  const out = await page.evaluate(async ({ fnSrc, call: c }: { fnSrc: string; call: GeminiRpcCall }) => {
    // PAGE_RPC is an async arrow-function SOURCE: build a function that both
    // instantiates it AND invokes it with the arg, otherwise we'd return the
    // function object instead of its result.
    const fn = new Function("arg", "return (" + fnSrc + ")(arg);");
    return fn(c);
  }, { fnSrc: PAGE_RPC, call });
  return {
    ok: Boolean(out?.ok),
    method: out?.method ?? call.method,
    data: out?.data,
    raw: out?.raw ?? "",
    latencyMs: out?.latencyMs ?? 0,
    error: out?.error ?? (out?.ok ? undefined : "rpc failed (http " + (out?.http ?? "?") + ")"),
  };
}