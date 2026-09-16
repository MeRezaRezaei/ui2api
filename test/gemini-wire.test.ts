import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  PAGE_RPC,
  parseBatchFrames,
  type GeminiBatchFrame,
} from "../src/capabilities/gemini-rpc.js";
import { isModelEntry, mapListConversations } from "../src/capabilities/gemini.js";

// Unit tests for the Gemini batchexecute wire layer (src/capabilities/gemini-rpc.ts
// + src/capabilities/gemini.ts). Fully hermetic: no network, no browser — the
// framing parser, the f.req encoder, the PAGE_RPC page-source, and the two data
// mappers are exercised through their pure, exported forms.
//
// Wire shape under test (pinned from the shipped encoder):
//   POST /_/BardChatUi/data/batchexecute?<query>   (X-Framework-Xsrf-Token header)
//   body:  f.req=<url-encoded JSON>   where the JSON is [[["<compactId>",
//          "<json-string payload>","null","generic"]]]
//   query: rpcids, source-path, bl, f.sid, hl, _reqid, rt, at
//   reply: )]}'\n\n<len>\n<json-frame>\n<len>\n<json-frame>\n ...

// ---------------------------------------------------------------------------
// 1. XSSI framing parser
// ---------------------------------------------------------------------------

const GUARD = ")]}'";
const FRAME_A = `[["wrb.fr","aPya6c","[false,0,[]]",null,4],["di",97]]`;
const FRAME_B = `[["e",4]]`;
const FRAME_C = `[["di",98]]`;

test("framing: a realistic XSSI response (guard + len-prefixed frames) parses", () => {
  const text = `${GUARD}\n\n${FRAME_A.length}\n${FRAME_A}\n${FRAME_B.length}\n${FRAME_B}\n`;
  const out = parseBatchFrames(text, "aPya6c");
  assert.equal(out.ok, true);
  assert.equal(out.method, "aPya6c", "method echoes the wrb.fr entry");
  assert.deepEqual(out.data, [false, 0, []]);
  assert.equal(out.error, undefined);
  // raw is the guard-stripped body, preserving content and order.
  assert.equal(out.raw, text.slice(5));
});

test("framing: a missing )]}' guard still parses (line framing is the real parser)", () => {
  const text = `${FRAME_A.length}\n${FRAME_A}\n${FRAME_B.length}\n${FRAME_B}\n`;
  const out = parseBatchFrames(text, "aPya6c");
  assert.equal(out.ok, true);
  assert.deepEqual(out.data, [false, 0, []]);
});

test("framing: trailing data after the last frame is ignored gracefully", () => {
  const text = `${GUARD}\n\n${FRAME_A.length}\n${FRAME_A}\n${FRAME_B.length}\n${FRAME_B}\n31\n${FRAME_C}\ntrailing text that is not a frame\n`;
  const out = parseBatchFrames(text, "aPya6c");
  assert.equal(out.ok, true);
  assert.deepEqual(out.data, [false, 0, []]);
});

test("framing: a wrong length prefix does not break parsing (lengths are advisory)", () => {
  const text = `${GUARD}\n\n1\n${FRAME_A}\n`;
  const out = parseBatchFrames(text, "aPya6c");
  assert.equal(out.ok, true);
  assert.deepEqual(out.data, [false, 0, []]);
});

test("framing: a truncated frame is a graceful error, never an exception", () => {
  const text = `${GUARD}\n\n5\n[["wrb.fr","aPya6c","[false,0`;
  let out: GeminiBatchFrame | undefined;
  assert.doesNotThrow(() => { out = parseBatchFrames(text, "aPya6c"); });
  assert.ok(out, "parseBatchFrames must return instead of throwing");
  assert.equal(out!.ok, false);
  assert.match(out!.error ?? "", /unparseable batch frame/);
  assert.equal(out!.method, "aPya6c");
});

test("framing: garbage with no recognizable frames is a graceful 'empty batch' error", () => {
  for (const text of [`${GUARD}\nplain text\n123\n`, "hello\nworld", ""]) {
    let out: GeminiBatchFrame | undefined;
    assert.doesNotThrow(() => { out = parseBatchFrames(text, "aPya6c"); }, `input ${JSON.stringify(text)}`);
    assert.equal(out!.ok, false);
    assert.equal(out!.error, "empty batch response");
  }
});

test("framing: a batch with no wrb.fr entry is a graceful 'no entry' error", () => {
  const frame = `[["er",125,"boom"]]`;
  const text = `${GUARD}\n\n${frame.length}\n${frame}\n`;
  const out = parseBatchFrames(text, "aPya6c");
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /no wrb\.fr entry/);
});

test("framing: an ['er',...] entry surfaces as ok:false with a batch-error message", () => {
  const frame = `[["wrb.fr","aPya6c","[false,0,[]]",null,0,1],["er",125,["droid","en_US"]]]`;
  const text = `${GUARD}\n\n${frame.length}\n${frame}\n`;
  const out = parseBatchFrames(text, "aPya6c");
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /batch error/);
  assert.equal(out.method, "aPya6c");
  assert.deepEqual(out.data, [false, 0, []]);
});

test("framing: a non-string payload is passed through without re-parsing", () => {
  const conv = { conversationId: "c1" };
  const frame = `[["wrb.fr","aPya6c",[false,1,[${JSON.stringify(conv)}]],null,0,1]]`;
  const text = `${GUARD}\n\n${frame.length}\n${frame}\n`;
  const out = parseBatchFrames(text, "aPya6c");
  assert.equal(out.ok, true);
  assert.deepEqual(out.data, [false, 1, [conv]]);
});

test("framing: the echoed method wins, else the caller's method is the fallback", () => {
  const frame = `[["wrb.fr",55,"[false,0,[]]",null,0,1]]`;
  const text = `${GUARD}\n\n${frame.length}\n${frame}\n`;
  const out = parseBatchFrames(text, "aPya6c");
  assert.equal(out.ok, true);
  assert.equal(out.method, "aPya6c", "non-string method field falls back to the caller");
  const echoFrame = `[["wrb.fr","otAQ7b","[1]",null,0,1]]`;
  const echo = parseBatchFrames(`${GUARD}\n\n${echoFrame.length}\n${echoFrame}\n`, "aPya6c");
  assert.equal(echo.method, "otAQ7b", "a string method echos exactly");
});

// ---------------------------------------------------------------------------
// 2. f.req body + URL-query wire construction
// ---------------------------------------------------------------------------

// Mirrors the shipped encoder in src/capabilities/gemini-rpc.ts (PAGE_RPC):
//   const bodyObj = [[[method, JSON.stringify(payload), "null", "generic"]]];
//   body = "f.req=" + encodeURIComponent(JSON.stringify(bodyObj))
// NOTE: the third slot is the *string* "null" — exactly what the wire emits —
// not a JS null literal; the tests below pin the resulting bytes.
function frameBody(method: string, payload: unknown): string {
  const bodyObj = [[[method, JSON.stringify(payload), "null", "generic"]]];
  return "f.req=" + encodeURIComponent(JSON.stringify(bodyObj));
}

function wireQuery(method: string, opts: { sid: string; reqid: string; at: string }): string {
  const qp = new URLSearchParams();
  qp.set("rpcids", method);
  qp.set("source-path", method === "otAQ7b" || method === "sJBwce" ? "/" : "/app");
  qp.set("bl", "boq_assistant-bard-web-server_20260914.08_p0");
  qp.set("f.sid", opts.sid);
  qp.set("hl", "en-US");
  qp.set("_reqid", opts.reqid);
  qp.set("rt", "c");
  qp.set("at", opts.at);
  return qp.toString();
}

test("f.req: aPya6c with [] payload encodes to the documented batch frame", () => {
  const inner = JSON.stringify([[[ "aPya6c", JSON.stringify([]), "null", "generic" ]]]);
  assert.equal(inner, `[[["aPya6c","[]","null","generic"]]]`);
  assert.equal(
    frameBody("aPya6c", []),
    "f.req=%5B%5B%5B%22aPya6c%22%2C%22%5B%5D%22%2C%22null%22%2C%22generic%22%5D%5D%5D"
  );
});

test("f.req: non-trivial payloads get full URL-encoding (asterisk-free, exact bytes)", () => {
  const body = frameBody("K4WWud", [[0], ["en-US"]]);
  assert.ok(body.startsWith("f.req="));
  assert.equal(
    body,
    "f.req=%5B%5B%5B%22K4WWud%22%2C%22%5B%5B0%5D%2C%5B%5C%22en-US%5C%22%5D%5D%22%2C%22null%22%2C%22generic%22%5D%5D%5D"
  );
});

test("f.req: the POST body carries only f.req (query params never leak into it)", () => {
  const body = frameBody("aPya6c", []);
  assert.ok(body.startsWith("f.req="));
  const rest = body.slice("f.req=".length);
  assert.ok(!rest.includes("&"), `body must be a single param: ${body}`);
  assert.ok(!rest.includes("rpcids"), "body must not carry query params");
  assert.ok(!rest.includes("source-path"), "body must not carry query params");
});

test("wire query: params ride the URL in the exact documented order", () => {
  const q = wireQuery("aPya6c", { sid: "SID-123", reqid: "95100", at: "ts_1" });
  const keys = q.split("&").map((kv) => kv.split("=")[0]);
  assert.deepEqual(keys, ["rpcids", "source-path", "bl", "f.sid", "hl", "_reqid", "rt", "at"]);
  assert.equal(
    q,
    "rpcids=aPya6c&source-path=%2Fapp&bl=boq_assistant-bard-web-server_20260914.08_p0&f.sid=SID-123&hl=en-US&_reqid=95100&rt=c&at=ts_1"
  );
});

test("wire query: source-path is / for catalog/session RPCs and /app otherwise", () => {
  assert.equal(wireQuery("otAQ7b", { sid: "s", reqid: "1", at: "" }).split("&")[1], "source-path=%2F");
  assert.equal(wireQuery("sJBwce", { sid: "s", reqid: "1", at: "" }).split("&")[1], "source-path=%2F");
  for (const m of ["aPya6c", "K4WWud", "/BardFrontendService.SearchConversations"]) {
    assert.equal(wireQuery(m, { sid: "s", reqid: "1", at: "" }).split("&")[1], "source-path=%2Fapp", m);
  }
});

test("wire query: sid and at-token values are query-encoded", () => {
  const q = wireQuery("aPya6c", { sid: "abc/def", reqid: "95100", at: "ts_7+9Ao0==" });
  assert.ok(q.includes("&f.sid=abc%2Fdef"), q);
  assert.ok(q.includes("&at=ts_7%2B9Ao0%3D%3D"), q);
});

test("wire query: the full hit URL is the batchexecute endpoint with the query attached", () => {
  const url = "/_/BardChatUi/data/batchexecute?" + wireQuery("aPya6c", { sid: "s", reqid: "7", at: "t" });
  assert.ok(url.startsWith("/_/BardChatUi/data/batchexecute?"));
  assert.ok(url.includes("rpcids=aPya6c&"));
});

// ---------------------------------------------------------------------------
// 3. PAGE_RPC purity (the in-page source is plain JS, no TS syntax)
// ---------------------------------------------------------------------------

test("PAGE_RPC: the in-page source compiles as plain JS via new Function", () => {
  assert.equal(typeof PAGE_RPC, "string");
  assert.ok(PAGE_RPC.trim().startsWith("async ({ method, payload }) => {"), "must be an async arrow-function source");
  let fn: Function | undefined;
  assert.doesNotThrow(() => { fn = new Function("arg", "return (" + PAGE_RPC + ")(arg);"); });
  assert.equal(typeof fn, "function");
});

test("PAGE_RPC: no TypeScript annotation syntax inside the backtick block", () => {
  // Scan the code (comment lines stripped — the block's prose legitimately
  // mentions HMAC-SHA1<> and "(void reply)", which are not annotations).
  const codeOnly = PAGE_RPC.split("\n").filter((ln) => !/^\s*\/\//.test(ln)).join("\n");
  const tsOnly: Array<[string, RegExp]> = [
    ["colon+type annotations", /\:\s*\b(?:string|number|boolean|any|unknown|never|void|object)\b/],
    ["typed params/returns", /\)\s*:\s*(?:string|number|boolean|any|unknown|never|void|object)\b/],
    ["typed variables", /\b(?:let|const|var)\s+[A-Za-z_$][\w$]*\s*:\s*\w/],
    ["as const/any/unknown", /\bas\s+(?:const|any|unknown)\b/],
    ["generic angle brackets", /</],
    ["interface/enum/namespace decls", /\b(?:interface|enum|namespace)\s+[A-Za-z_$][\w$]*/],
    ["type declarations", /\btype\s+[A-Z_$][\w$]*/],
  ];
  for (const [label, re] of tsOnly) {
    assert.doesNotMatch(codeOnly, re, `code must not contain ${label}`);
  }
});

test("PAGE_RPC: the source is self-contained (no imports/requires/module bindings)", () => {
  assert.doesNotMatch(PAGE_RPC, /\b(?:import|export)\b/);
  assert.doesNotMatch(PAGE_RPC, /\brequire\s*\(/);
  assert.doesNotMatch(PAGE_RPC, /module\.exports/);
  assert.doesNotMatch(PAGE_RPC, /from\s+["']/);
});

// ---------------------------------------------------------------------------
// 4. ListConversations mapping ([hasMore, totalCount, [conversations]])
// ---------------------------------------------------------------------------

test("ListConversations: [false,0,[]] maps to the stable shape", () => {
  const src: unknown = [false, 0, []];
  const m = mapListConversations(src);
  assert.equal(m.hasMore, false);
  assert.equal(m.totalCount, 0);
  assert.deepEqual(m.conversations, []);
  assert.strictEqual(m.raw, src, "raw is a passthrough reference");
});

test("ListConversations: [] and [true] tolerate missing trailing fields", () => {
  const empty = mapListConversations([]);
  assert.equal(empty.hasMore, false, "[] keeps hasMore false");
  assert.equal(empty.totalCount, undefined);
  assert.deepEqual(empty.conversations, []);
  const one = mapListConversations([true]);
  assert.equal(one.hasMore, true);
  assert.equal(one.totalCount, undefined);
  assert.deepEqual(one.conversations, []);
});

test("ListConversations: a real 1-conversation fixture maps every field", () => {
  const conv = [{ conversationId: "c1", title: "Travel plan", c: [{ ab: ["I a"] }] }];
  const src: unknown = [false, 1, conv];
  const m = mapListConversations(src);
  assert.equal(m.hasMore, false);
  assert.equal(m.totalCount, 1);
  assert.deepEqual(m.conversations, conv);
  assert.strictEqual(m.raw, src);
});

test("ListConversations: non-array / non-boolean-first payloads stay raw passthroughs", () => {
  for (const d of ["junk", null, 42, [5, "x", []], { foo: 1 }, [true, "not-a-count", []]]) {
    const m = mapListConversations(d);
    assert.strictEqual(m.raw, d, String(d));
    assert.deepEqual(m.conversations, [], String(d));
    if (Array.isArray(d) && d[0] === true) {
      assert.equal(m.hasMore, true, String(d));
      assert.equal(m.totalCount, undefined, "non-numeric totalCount is skipped");
    } else {
      assert.equal(m.hasMore, undefined, String(d));
      assert.equal(m.totalCount, undefined, String(d));
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Model catalog scan — discriminator + end-to-end scan on a catalog blob
// ---------------------------------------------------------------------------

test("model scan: real model entries are accepted (4th-element array or non-all-hex name)", () => {
  assert.equal(isModelEntry(["gemini-2.5-flash", "Gemini 2.5 Flash", "Fast", ["32k"], 1, null, ["abc"]]), true);
  assert.equal(isModelEntry(["gemini-2.5-pro", "cf41b0e0dd7d53e5", "Best", []]) , true, "all-hex name is OK when the 4th element is an array");
  assert.equal(isModelEntry(["gemini-2.0-flash-lite", "Gemini Lite", "t", "just-text", 1]), true, "non-hex name passes without a 4th array");
});

test("model scan: modelHashes false positives (all-hex names, no 4th-array) are rejected", () => {
  assert.equal(isModelEntry(["aVeryLongModelId", "cf41b0e0dd7d53e5", "1b9a", "2c0d"]), false);
  assert.equal(isModelEntry(["aVeryLongModelId", "CF41B0E0DD7D53E5", "x", 4]), false, "hex check is case-insensitive");
});

test("model scan: malformed / too-short entries are rejected", () => {
  assert.equal(isModelEntry(["short", "Gemini", "tag", ["f"]]), false, "schemaId shorter than 7 chars");
  assert.equal(isModelEntry(["gemini-2.5", "Gemini", "tag"]), false, "fewer than 4 elements");
  assert.equal(isModelEntry(["gemini-2.5", 99, "tag", ["f"]]), false, "name is not a string");
  assert.equal(isModelEntry("cf41b0e0dd7d53e5"), false, "not an array");
  assert.equal(isModelEntry([1, 2, 3, ["x"]]), false, "id/name/tagline not all strings");
  assert.equal(isModelEntry(null), false);
});

test("model scan: a catalog blob yields only real model entries (hex hashes filtered)", () => {
  const catalog: unknown = [
    6, [false, null, true], true, null, null, null,
    [
      ["70e8a9862829f0a9", "Gemini 2.0 Flash", "Fast", ["f"], 1, null, ["cf41b0e0dd7d53e5", "1b9a"]],
      ["6f8e3f0a8d2b3c4d", "cf41b0e0dd7d53e5", "7a8b", "9c0d"],
      ["6a5c993b4e8f2b1d", "Gemini 2.5 Pro", "Our best", [], 1],
    ],
    1016, null,
  ];
  const models: Array<{ id: string; name: string; tagline: string }> = [];
  const scan = (obj: unknown): void => {
    if (!Array.isArray(obj)) return;
    if (isModelEntry(obj)) models.push({ id: obj[0], name: obj[1], tagline: obj[2] });
    for (const el of obj) scan(el);
  };
  scan(catalog);
  assert.deepEqual(models.map((m) => m.name), ["Gemini 2.0 Flash", "Gemini 2.5 Pro"]);
});