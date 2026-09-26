import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * GOAL 117: all 32 `/capability/<site>` handlers answered
 * `500 {ok:false, error: e.message}` — echoing internal exception text (an
 * absolute path, a hostname, a library internal, a selector string) straight to
 * any caller. The SAME class GOAL 104 fixed on the request-level net, which is
 * precisely why it survived: the criterion recorded as passing was scoped to
 * the region GOAL 104 had touched, and the readiness gate caught it by
 * re-deriving from the WHOLE file.
 *
 * The pin counts ALL sites rather than sampling, because the original defect was
 * a per-site copy-paste — a sample would have hidden it.
 */

const HTTP = readFileSync("src/prompt/http.ts", "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The exact leaking shape, verbatim from the pre-fix source. */
const LEAK = /ok: false, error: e instanceof Error \? e\.message : String\(e\)/g;

d("GOAL 117: no route echoes internal exception text to a client", () => {
  t("ZERO capability handlers echo a raw e.message (the ONE handler covers every site)", () => {
    // GOAL 140 collapsed 33 per-site routes into ONE table-driven handler, so
    // "all 32 covered, not sampled" is now STRUCTURAL rather than counted: there
    // is a single handler, so there is nothing to sample and nothing to miss.
    const handlers = (code(HTTP).match(/req\.url\?\.startsWith\("\/capability\/"\)/g) ?? []).length;
    assert.equal(handlers, 1, `expected exactly ONE capability handler, found ${handlers}`);
    const hits = [...code(HTTP).matchAll(LEAK)];
    assert.deepEqual(
      hits.map((h) => h.index),
      [],
      `found ${hits.length} handler(s) still echoing internal text — every one must use capabilityFailure()`,
    );
  });

  t("the fix is applied to EVERY site, not a subset", () => {
    // Every site now flows through the single handler, so the guard existing
    // there IS the guarantee that no site can bypass it. We also assert no
    // per-site route survives that could be added without the guard.
    const used = (code(HTTP).match(/capabilityFailure\(capability, e\)/g) ?? []).length;
    assert.ok(used >= 1, "the capability handler must route failures through capabilityFailure()");
    const perSite = code(HTTP).match(/req\.url === "\/capability\/[a-z0-9-]+"/g) ?? [];
    assert.deepEqual(
      perSite,
      [],
      "a per-site capability route exists again — it could serve a site without the guard"
    );
  });

  t("the failure stays a real 500 with a NAMED reason and the capability id", () => {
    assert.match(code(HTTP), /reason_code:\s*"runner_error"/, "a stable reason code must survive");
    const fn = code(HTTP).slice(code(HTTP).indexOf("function capabilityFailure"));
    assert.match(fn, /capability "\$\{capability\}" failed inside the runner/, "the message must name the capability");
    assert.match(fn, /UI2API_DEBUG/, "the full error must still reach the operator's log");
  });

  t("an internal fault is no longer echoed by the request-level fallback", () => {
    const seg = code(HTTP).slice(code(HTTP).lastIndexOf("const isRequestShape"));
    assert.match(seg, /isRequestShape \? 400 : 500/, "a request-shape error is 400, anything else 500");
    assert.match(seg, /internal_error/, "the non-request-shape branch must use the generic code");
    // GOAL 143: the named 400 now travels as {code, message} like every other
    // refusal, so a client reads the CODE instead of regex-matching our prose.
    // The security property is unchanged and is what this test exists for: the
    // non-shape branch must still emit the GENERIC message, never e.message.
    assert.match(
      seg,
      /code: "internal_error", message: "internal error"/,
      "a non-request-shape fault must NOT echo the internal message"
    );
    assert.doesNotMatch(
      seg,
      /\{ code: "internal_error", message: e instanceof Error \? e\.message/,
      "the internal_error branch must never carry the real exception text"
    );
    // the NAMED 400 keeps its message, because the caller can act on it
    assert.match(seg, /message: e instanceof Error \? e\.message : String\(e\)/, "a request-shape 400 must keep its named message");
  });

  t("the two remaining e.message uses are NAMED contracts, not leaks", () => {
    // 1) a pool refusal: its message is a NAMED, actionable reason (the documented
    //    pool_saturated / pool_queue_timeout / pool_closed contract)
    assert.match(code(HTTP), /poolRefusal\(msg\)/, "the pool refusal message is a documented contract");
    assert.match(code(HTTP), /code:\s*refusal\.code, message: msg/, "and it is emitted under its stable code");
    // 2) the request-shape 400 above
    assert.match(
      code(HTTP),
      /message: e instanceof Error \? e\.message : String\(e\)/,
      "the request-shape 400 keeps its named message",
    );
  });

  t("negative: the OLD leaking shape is required to be caught (mutation proof)", () => {
    const oldHandler = `return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });`;
    const oldFound = [...oldHandler.matchAll(LEAK)];
    assert.equal(oldFound.length, 1, "precondition: the old handler shape DOES match the leak pattern");
    const newHandler = `return send(res, 500, { capability, ok: false, error: capabilityFailure(capability, e), reason_code: "runner_error" });`;
    assert.equal([...newHandler.matchAll(LEAK)].length, 0, "the new shape must NOT match — that is the fix");
  });
});
