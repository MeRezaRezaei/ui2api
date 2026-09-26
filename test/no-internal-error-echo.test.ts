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
  t("ZERO capability handlers echo a raw e.message (all 32 covered, not sampled)", () => {
    const hits = [...code(HTTP).matchAll(LEAK)];
    assert.deepEqual(
      hits.map((h) => h.index),
      [],
      `found ${hits.length} handler(s) still echoing internal text — every one must use capabilityFailure()`,
    );
  });

  t("the fix is applied to EVERY site, not a subset", () => {
    const used = (code(HTTP).match(/capabilityFailure\(capability, e\)/g) ?? []).length;
    assert.ok(used >= 32, `expected the guard on all 32 capability routes, found ${used}`);
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
    // the NAMED 400 keeps its message, because the caller can act on it
    assert.match(seg, /\? e instanceof Error \? e\.message : String\(e\)/, "a request-shape 400 must keep its named message");
  });

  t("the two remaining e.message uses are NAMED contracts, not leaks", () => {
    // 1) a pool refusal: its message is a NAMED, actionable reason (the documented
    //    pool_saturated / pool_queue_timeout / pool_closed contract)
    assert.match(code(HTTP), /poolRefusal\(msg\)/, "the pool refusal message is a documented contract");
    assert.match(code(HTTP), /code:\s*refusal\.code, message: msg/, "and it is emitted under its stable code");
    // 2) the request-shape 400 above
    assert.match(
      code(HTTP),
      /error: isRequestShape\s*\?\s*e instanceof Error \? e\.message : String\(e\)/,
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
