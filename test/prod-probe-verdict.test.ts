import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test, describe } from "node:test";

// GOAL 156, CAUSE D — the hermetic half of the live-probe fix.
//
// WHY A PURE FUNCTION. The bug was not in a line of the probe; it was in what
// the probe ASSERTED. `test/prod-live-chat-surface-probe.test.ts` measured
// columns (accepted? JSON? named error?) and therefore passed a run in which
// every one of 22 advertised models returned `pool_queue_timeout`. The proof is
// `scripts/audit/model-answers-audit.md`: 1 real answer, 2 named sign-out
// refusals, 11 no-response aborts including the known-good control `duckduckgo` —
// a total outage that stayed green.
//
// You cannot demonstrate that a live gate discriminates using the live gate: a
// dead service is indistinguishable from an unrunnable environment, so the only
// honest way to show RED-vs-GREEN is to factor the decision into a PURE function
// and drive it with synthetic outcomes. This file does that. It NEVER touches a
// daemon, a browser, or the network — it must stay runnable on a cold box.
//
// ANTI-VACUITY, twice over. The verdict function FAILS an empty id list (a probe
// that measured nothing must never pass), and this file asserts that property
// directly. Every other case asserts the OPPOSITE of what a vacuous assertion
// would accept: a test that only checked "no crash" would pass against a
// function that always returned ok:true, and the all-timeouts case below is
// exactly the pin that kills that.

// The live half must not register its own live tests when imported here.
process.env.UI2API_PROBE_NO_LIVE = "1";
// `.js` specifier, the repo's ESM/NodeNext idiom (tsx resolves it to the .ts
// source) — a literal `.ts` specifier fails `tsc -p tsconfig.test.json`.
const { isRealAnswer, probeVerdict } = await import("./prod-live-chat-surface-probe.test.js");
// Derived from the function's own signature, so this can never drift from the
// shape the live probe actually produces.
type ProbeOutcome = Parameters<typeof isRealAnswer>[0];

const json = (v: unknown) => JSON.stringify(v);
const CT = "application/json";

/** A 200 carrying a real, non-empty assistant message read off the page. */
function answered(id: string, content = "PRODCHECK"): ProbeOutcome {
  return {
    id,
    status: 200,
    body: { id: `chatcmpl-${id}`, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] },
    text: json({ choices: [{ message: { content } }] }),
    contentType: CT,
  };
}

/** A NAMED per-model failure — the operator's rule: honest failure is legitimate. */
function named(id: string, code: string, status = 503, msg = "named reason"): ProbeOutcome {
  return {
    id,
    status,
    body: { error: { code, message: msg } },
    text: json({ error: { code, message: msg } }),
    contentType: CT,
  };
}

/** The exact shape of the outage rows: no response came back at all. */
function noResponse(id: string): ProbeOutcome {
  return { id, status: 0, body: { error: { code: "no_response", message: "client abort" } }, text: "", contentType: "" };
}

describe("GOAL 156 cause D: the live chat probe's verdict — nothing answered is RED", () => {
  test("REGRESSION PIN: every id answering pool_queue_timeout is FAIL, not PASS", () => {
    // The exact outage shape from the audit, at the audit's scale. Before the
    // fix this shape PASSED the probe; that is the whole defect.
    const outcomes: ProbeOutcome[] = [
      named("gemini", "pool_queue_timeout"),
      named("kimi", "pool_queue_timeout"),
      named("claude", "pool_queue_timeout"),
      named("chatgpt", "pool_queue_timeout"),
      named("duckduckgo", "pool_queue_timeout"), // the known-good control
    ];
    const v = probeVerdict(outcomes);
    assert.equal(v.answered.length, 0, "precondition: no id produced a real answer");
    assert.equal(v.namedFailures.length, outcomes.length, "precondition: every failure is NAMED (honest)");
    assert.equal(v.ok, false, "a run in which NOTHING answered must be FAIL, not an accepted honest-failure run");
    assert.match(String(v.reason), /advertised-but-dead/i, "the message must name the class, not just say 'failed'");
    assert.match(String(v.reason), /0 of 5 advertised ids answered/, "the message must state the count");
  });

  test("the mixed outage from the audit: 1 real answer + 2 refusals + 11 voids is PASS (one answer is enough)", () => {
    const outcomes: ProbeOutcome[] = [
      answered("gemini", "Gemini said PRODCHECK"),
      named("kimi", "refusal", 502, "no answer appeared on kimi within 60000ms. This site requires sign-in."),
      named("copilot-m365", "refusal", 502, "no answer appeared on copilot-m365 within 60000ms. sign-in only"),
      ...Array.from({ length: 11 }, (_, i) => noResponse(`void-${i}`)),
    ];
    const v = probeVerdict(outcomes);
    assert.equal(v.ok, true, "one real answer keeps the run green — honest per-model failure is legitimate");
    assert.deepEqual(v.answered, ["gemini"]);
    assert.equal(v.namedFailures.length, 2);
    assert.equal(v.unclassified.length, 11, "a no-response row is neither an answer nor a named failure");
  });

  test("one real answer among otherwise-named refusals is PASS", () => {
    const v = probeVerdict([
      answered("duckduckgo"),
      named("kimi", "pool_saturated", 503),
      named("deepseek", "ui2api_driver_error", 500, "no answer appeared on deepseek within 60000ms"),
      named("poe", "refusal", 502, "login required"),
    ]);
    assert.equal(v.ok, true);
    assert.deepEqual(v.answered, ["duckduckgo"]);
    assert.equal(v.namedFailures.length, 3);
  });

  test("anti-vacuity: an EMPTY id list is FAIL — a probe that measured nothing must never pass", () => {
    const v = probeVerdict([]);
    assert.equal(v.ok, false, "zero measurements is not a green surface");
    assert.equal(v.total, 0);
    assert.match(String(v.reason), /measured nothing|0 of 0/i);
  });

  test("anti-vacuity: an all-no-response run (client aborts, no named code) is FAIL", () => {
    const v = probeVerdict([noResponse("a"), noResponse("b")]);
    assert.equal(v.ok, false);
    assert.match(String(v.reason), /no-response/i, "the message must name the observed class");
  });

  test("a bare, UNNAMED 500 is not a real answer and does not rescue a dead run", () => {
    const v = probeVerdict([
      { id: "x", status: 500, body: { detail: "internal" }, text: "{}", contentType: CT },
      noResponse("y"),
    ]);
    assert.equal(v.ok, false, "a body with no assistant message is not an answer, whatever its status");
    assert.equal(v.answered.length, 0);
    assert.deepEqual(v.unclassified, ["x", "y"]);
  });
});

describe("GOAL 156 cause D: isRealAnswer is conservative by construction", () => {
  test("a 200 with a non-empty assistant message IS an answer", () => {
    assert.equal(isRealAnswer(answered("gemini", "PRODCHECK")), true);
  });

  test("a 200 with EMPTY content is NOT an answer", () => {
    assert.equal(isRealAnswer(answered("empty", "")), false, "empty content is a silent failure, not an answer");
    assert.equal(isRealAnswer(answered("blank", "   \n  ")), false, "whitespace-only content is not an answer");
  });

  test("a 200 whose body has NO choices is NOT an answer", () => {
    assert.equal(isRealAnswer({ id: "n", status: 200, body: { object: "chat.completion", choices: [] }, text: "{}", contentType: CT }), false);
  });

  test("an HTML body is NOT an answer, whatever the status", () => {
    assert.equal(isRealAnswer({ id: "h", status: 200, body: { choices: [{ message: { content: "hi" } }] }, text: "<!DOCTYPE html><html>502 Bad Gateway</html>", contentType: "text/html" }), false);
  });

  test("a non-200 is NOT an answer even with a perfect assistant message", () => {
    assert.equal(isRealAnswer({ ...answered("e"), status: 502 }), false, "a 5xx is a failure with a body, not a success");
  });

  test("a 200 carrying an error envelope is NOT an answer (a refusal dressed as 200)", () => {
    assert.equal(
      isRealAnswer({ id: "r", status: 200, body: { error: { code: "refusal", message: "sign in once" } }, text: "{}", contentType: CT }),
      false,
    );
  });

  test("a named refusal is a legitimate OUTCOME but never an ANSWER", () => {
    for (const code of ["pool_queue_timeout", "pool_saturated", "ui2api_driver_error", "refusal"]) {
      assert.equal(isRealAnswer(named("m", code)), false, `${code} must never count as an answer`);
    }
  });
});

describe("GOAL 156 cause D: the gate is wired to the verdict, not to a column", () => {
  test("NEGATIVE / MUTATION PROOF: the OLD behaviour (any named failure is accepted) is what the pin must reject", () => {
    // Reconstruct the pre-fix acceptance branch: "a named failure is a legitimate
    // outcome, therefore pass". Every row in the outage is named, so it passes.
    const outage: ProbeOutcome[] = [
      named("gemini", "pool_queue_timeout"),
      named("kimi", "pool_queue_timeout"),
      named("duckduckgo", "pool_queue_timeout"),
    ];
    const oldBehaviourPasses = outage.every((r) => isRealAnswer(r) === false && r.status >= 400);
    assert.equal(oldBehaviourPasses, true, "precondition: the old rule accepted this run");

    // The new rule reds on the identical input.
    assert.equal(probeVerdict(outage).ok, false, "the new rule must RED on the input the old rule accepted");
  });

  test("the live probe file really imports and calls the verdict function", () => {
    // Guards against the classic half-fix: a pure function that exists and is
    // correct while the LIVE probe never consults it.
    const src = readFileSync("test/prod-live-chat-surface-probe.test.ts", "utf8");
    assert.match(src, /probeVerdict\(results\)/, "the live sweep must be classified by probeVerdict");
    assert.match(src, /verdict\.ok,/, "the live test must assert on the verdict, not on a column");
  });
});
