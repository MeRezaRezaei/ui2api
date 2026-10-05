import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CHALLENGE_MARKERS,
  CLASS_PRECONDITIONS,
  NON_ANSWER_TEXT_PATTERNS,
  NO_ANSWER_REFUSAL_PATTERNS,
  UNMATCHED_SELECTOR_PATTERNS,
  VERIFICATION_CLASSES,
  capabilityDataEvidence,
  challengeMarkerIn,
  classifyOutcome,
  classPrecondition,
  emptyCapabilityResult,
  loginMarkerIn,
  noAnswerRefusalIn,
  nonAnswerTextIn,
  unmatchedSelectorIn,
  unmeasuredAfterMeasuredResponse,
} from "../src/prompt/verification-class.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NO_ANSWER_REFUSAL_RE, renderNoAnswerRefusal, RETRY } from "../src/prompt/error-redaction.js";

// The classifier is pure, so every pin below is hermetic: no browser, no
// network, no clock. The inputs are the values the DEPLOYED service actually
// reported in the 2026-09-30 sweep (capabilities/model-verification.json), not
// invented ones.

const IDLE = { busy: 0, total: 4, queued: 0 };
const BUSY = { busy: 3, total: 4, queued: 2 };

const NO_COMPOSER = (site: string) => `no composer found on ${site} - the site UI may have changed. Tune ${site} in src/profile/profile.ts or ship a JSON override (--profile FILE).`;

// ── the three anti-bot rows ──────────────────────────────────────────────────

test("WALL-CHALLENGE: a Cloudflare interstitial the server reported is a wall, never a login", () => {
  const c = classifyOutcome({
    httpStatus: 502,
    message: NO_COMPOSER("grok"),
    page: { title: "Attention Required! | Cloudflare", url: "https://grok.com/" },
    poolAtRequest: IDLE,
  });
  assert.equal(c.cls, "WALL-CHALLENGE");
  assert.match(c.reason, /attention required/);
});

test("WALL-CHALLENGE: the Cloudflare 'Just a moment...' interstitial is the same class", () => {
  const c = classifyOutcome({
    httpStatus: 502,
    message: NO_COMPOSER("perplexity"),
    page: { title: "Just a moment...", url: "https://www.perplexity.ai/" },
    poolAtRequest: IDLE,
  });
  assert.equal(c.cls, "WALL-CHALLENGE");
  assert.match(c.reason, /just a moment/);
});

test("WALL-CHALLENGE: a Vercel Security Checkpoint is the same class", () => {
  const c = classifyOutcome({
    httpStatus: 502,
    message: NO_COMPOSER("t3chat"),
    page: { title: "Vercel Security Checkpoint", url: "https://t3.chat/" },
    poolAtRequest: IDLE,
  });
  assert.equal(c.cls, "WALL-CHALLENGE");
  assert.match(c.reason, /security checkpoint/);
});

// ── the four loaded-but-no-composer rows ────────────────────────────────────

for (const [model, title, url] of [
  ["blackbox", "Blackbox: The high-trust platform for frontier inference", "https://www.blackbox.ai/"],
  ["codex", "Codex in ChatGPT | AI Coding Agents for Software Engineering", "https://chatgpt.com/codex/"],
  ["copilot", "Microsoft Copilot", "https://copilot.microsoft.com/"],
  ["notion", "The AI workspace that works for you. | Notion", "https://www.notion.com/"],
] as const) {
  test(`COMPOSER-DRIFT: ${model} loaded a real product page with no composer and no login wall`, () => {
    const c = classifyOutcome({
      httpStatus: 502,
      message: NO_COMPOSER(model),
      page: { title, url },
      poolAtRequest: IDLE,
    });
    assert.equal(c.cls, "COMPOSER-DRIFT", `${model} expected COMPOSER-DRIFT, got ${c.cls}: ${c.reason}`);
  });
}

// ── the classes that already existed must still classify the same ───────────

test("SIGN-OUT: the server's own 'requires sign-in' message stays SIGN-OUT", () => {
  const c = classifyOutcome({
    httpStatus: 502,
    message: "no answer appeared on kimi within 60000ms. This site requires sign-in. sign in once via `ui2api analyse https://www.kimi.ai --login`",
    poolAtRequest: IDLE,
  });
  assert.equal(c.cls, "SIGN-OUT");
});

test("SIGN-OUT: a reported /sign_in page is a sign-out, NOT composer drift", () => {
  const c = classifyOutcome({
    httpStatus: 502,
    message: NO_COMPOSER("deepseek"),
    page: { title: "DeepSeek - Into the Unknown", url: "https://chat.deepseek.com/sign_in" },
    poolAtRequest: IDLE,
  });
  assert.equal(c.cls, "SIGN-OUT");
  assert.match(c.reason, /sign-in surface/);
});

test("SIGN-OUT: a reported /login redirect is a sign-out, NOT composer drift", () => {
  for (const [title, url] of [
    ["Sign in - Claude", "https://claude.ai/login?from=logout&reauth=1"],
    ["Hugging Face - The AI community building the future.", "https://huggingface.co/login?next=https%3A%2F%2Fh"],
    ["Poe - Fast, Helpful AI Chat", "https://poe.com/login?redirect_url=%2F"],
  ] as const) {
    const c = classifyOutcome({ httpStatus: 502, message: NO_COMPOSER("x"), page: { title, url }, poolAtRequest: IDLE });
    assert.equal(c.cls, "SIGN-OUT", `${url} expected SIGN-OUT, got ${c.cls}`);
  }
});

test("ANSWERS: HTTP 200 with real model output is ANSWERS", () => {
  const c = classifyOutcome({ httpStatus: 200, answerText: "Duck.ai said GPT-5.6 Luna PONG 2nd opinion", message: "", poolAtRequest: IDLE });
  assert.equal(c.cls, "ANSWERS");
});

test("CONTENDED-TIMEOUT: no response at a BUSY pool is contention, and only there", () => {
  const c = classifyOutcome({ httpStatus: 0, noResponse: true, message: "no response within 150000ms (client abort)", poolAtRequest: BUSY });
  assert.equal(c.cls, "CONTENDED-TIMEOUT");
});

// ── the two actions must NOT share one class (criterion 1) ─────────────────

test("the wall and the drift are DISTINCT classes — a page cannot be both", () => {
  const wall = VERIFICATION_CLASSES.indexOf("WALL-CHALLENGE");
  const drift = VERIFICATION_CLASSES.indexOf("COMPOSER-DRIFT");
  assert.notEqual(wall, drift);
  assert.notEqual(wall, -1);
  assert.notEqual(drift, -1);

  // Same status, same idle pool, same "no composer" message — the ONLY thing
  // that differs is the reported page, and the class follows the page.
  const base = { httpStatus: 502, message: NO_COMPOSER("grok"), poolAtRequest: IDLE };
  const asWall = classifyOutcome({ ...base, page: { title: "Attention Required! | Cloudflare", url: "https://grok.com/" } });
  const asDrift = classifyOutcome({ ...base, page: { title: "Grok", url: "https://grok.com/" } });
  assert.equal(asWall.cls, "WALL-CHALLENGE");
  assert.equal(asDrift.cls, "COMPOSER-DRIFT");
});

// ── precedence: a challenge interstitials a login page too ──────────────────

test("a challenge beats a login on the same page — 'capture a session' is the wrong action for a bot wall", () => {
  const c = classifyOutcome({
    httpStatus: 502,
    message: NO_COMPOSER("x"),
    page: { title: "Just a moment... | Cloudflare", url: "https://example.com/login" },
    poolAtRequest: IDLE,
  });
  assert.equal(c.cls, "WALL-CHALLENGE");
});

// ── no class may be a free-text escape hatch (criterion 2) ──────────────────

test("every class in the closed set declares a machine-checkable precondition", () => {
  for (const c of VERIFICATION_CLASSES) {
    const p = classPrecondition(c);
    assert.ok(p, `${c} has no precondition`);
    assert.ok(Array.isArray(p.requiredFields), `${c}.requiredFields is not an array`);
    assert.equal(typeof p.requiresPoolState, "boolean", `${c}.requiresPoolState is not boolean`);
    assert.equal(typeof p.requiresIdlePool, "boolean", `${c}.requiresIdlePool is not boolean`);
  }
});

test("the two new classes require a measured page and an idle pool; UNMEASURED requires nothing", () => {
  for (const c of ["WALL-CHALLENGE", "COMPOSER-DRIFT"] as const) {
    const p = classPrecondition(c);
    assert.ok(p.requiredFields.includes("observedPage"), `${c} must require observedPage`);
    assert.ok(p.requiredFields.includes("evidence"), `${c} must require evidence`);
    assert.ok(p.requiresPoolState, `${c} must require pool state`);
    assert.ok(p.requiresIdlePool, `${c} must require an idle pool`);
  }
  assert.deepEqual(classPrecondition("UNMEASURED").requiredFields, []);
});

test("a measured response the rule cannot honestly file is UNCLASSIFIED, never a class", () => {
  // An unknown 503 with no page and no recognisable message. Parking it in
  // UNMEASURED says "never reached" when a 503 WAS reached; parking it in
  // SIGN-OUT asserts a credential problem nobody observed.
  const c = classifyOutcome({ httpStatus: 503, message: "upstream unavailable", poolAtRequest: IDLE });
  assert.equal(c.cls, "UNCLASSIFIED");
  assert.notEqual(c.cls, "UNMEASURED");
});

test("'no composer found' with NO reported page is UNCLASSIFIED — the condition cannot be told from a sign-out", () => {
  const c = classifyOutcome({ httpStatus: 502, message: NO_COMPOSER("mystery"), poolAtRequest: IDLE });
  assert.equal(c.cls, "UNCLASSIFIED");
});

test("no response at an IDLE pool is UNCLASSIFIED, not contention and not a class", () => {
  const c = classifyOutcome({ httpStatus: 0, noResponse: true, message: "client abort", poolAtRequest: IDLE });
  assert.equal(c.cls, "UNCLASSIFIED");
});

test("the marker tables are finite and reviewable, and empty-ish input matches nothing", () => {
  assert.ok(CHALLENGE_MARKERS.length > 0);
  assert.equal(challengeMarkerIn({ title: "Some Product Page", url: "https://example.com/" }), null);
  assert.equal(loginMarkerIn({ title: "Some Product Page", url: "https://example.com/" }), null);
  // A query string mentioning login is not a login page — only the PATH counts.
  assert.equal(loginMarkerIn({ title: "Docs", url: "https://example.com/docs?next=/login" }), null);
  assert.ok(loginMarkerIn({ title: "Docs", url: "https://example.com/login" }));
});

// ── RULE 9 predicate: UNMEASURED after a measured response (criterion 5) ────

test("unmeasuredAfterMeasuredResponse: the exact 7-row shape this goal fixes IS reported", () => {
  const legacy = [
    { model: "grok", class: "UNMEASURED", evidence: "POST /v1/chat/completions {model:grok} -> HTTP 502 in 80087ms at pool 0/3 idle" },
    { model: "notion", class: "UNMEASURED", evidence: "POST -> HTTP 502 in 30533ms at pool 0/4 idle" },
  ];
  const bad = unmeasuredAfterMeasuredResponse(legacy);
  assert.equal(bad.length, 2, `expected both legacy rows reported, got ${JSON.stringify(bad)}`);
  assert.ok(bad.some((s) => s.includes("grok")));
  assert.ok(bad.some((s) => s.includes("HTTP 502")));
});

test("unmeasuredAfterMeasuredResponse: a genuinely-never-reached row is NOT reported", () => {
  const good = [{ model: "brand-new", class: "UNMEASURED", evidence: "not probed in this sweep" }];
  assert.deepEqual(unmeasuredAfterMeasuredResponse(good), []);
});

test("unmeasuredAfterMeasuredResponse: a non-UNMEASURED row quoting a status is NOT its business", () => {
  const rows = [{ model: "gemini", class: "ANSWERS", evidence: "HTTP 200 in 24204ms" }];
  assert.deepEqual(unmeasuredAfterMeasuredResponse(rows), []);
});

test("unmeasuredAfterMeasuredResponse: a bare UNMEASURED row with no evidence is not flagged", () => {
  assert.deepEqual(unmeasuredAfterMeasuredResponse([{ model: "x", class: "UNMEASURED" }]), []);
});

test("CLASS_PRECONDITIONS covers exactly the closed set — no orphan, no gap", () => {
  assert.deepEqual(Object.keys(CLASS_PRECONDITIONS).sort(), [...VERIFICATION_CLASSES].sort());
});

// ── the two conditions GOAL 164 added a class for ───────────────────────────
//
// v0 returned HTTP 200 at an idle pool carrying 'Exploring ideas...' — a status
// string from the site's own agent-activity region, not the answer. venice
// never returned 200 at all: its answer selectors matched ZERO nodes while the
// page held the answer. Neither row could be filed honestly under any existing
// member, so the set was widened ON PURPOSE, and every pin below holds the
// widening to the same standard the six original classes were held to.

const V0_EVIDENCE =
  "POST /v1/chat/completions {model:v0, prompt 'Reply with exactly: PONG'} -> HTTP 200 in 13543ms at pool 0/3 IDLE, queued 0, and the body carried the answer text 'Exploring ideas...'. A real 200, real content, from v0's own site, that is NOT the requested token.";

const VENICE_EVIDENCE =
  "POST /v1/chat/completions {model:venice} -> HTTP 502 in 109302ms at pool 0/4 IDLE, queued 0, message 'page.evaluate: Execution context was destroyed'. VENICE ACTUALLY ANSWERED 'PONG' — the GOAL-160 answer selectors match ZERO nodes in venice's real DOM, so no ANCESTOR of the answer matches either and the selectors could never match.";

test("NON-ANSWER-READ: a 2xx at an idle pool carrying text that is not the answer", () => {
  const c = classifyOutcome({ httpStatus: 200, message: V0_EVIDENCE, poolAtRequest: IDLE });
  assert.equal(c.cls, "NON-ANSWER-READ", `expected NON-ANSWER-READ, got ${c.cls}: ${c.reason}`);
  assert.match(c.reason, /never ANSWERS/);
  assert.notEqual(c.cls, "ANSWERS", "a 2xx carrying a non-answer must never be filed as ANSWERS");
});

// GOAL 167: the pin above passed while the branch was DEAD. It omitted
// answerText, and the ANSWERS branch is gated on a non-empty answerText — so
// with no answerText present that input could not reach the ANSWERS branch even
// when it sat in front of it, and the green test proved nothing about the
// ordering. The shape the class actually exists for is a 2xx that DID return
// text (the service served it, so the driver has it) which the service itself
// says is not the answer; that is what the next pin feeds, and it is the input
// that returned ANSWERS before the branch was moved ahead of it.

test("REACHABILITY: a 2xx that DID return text the service names as a non-answer is NON-ANSWER-READ, not ANSWERS", () => {
  const served = "Exploring ideas...";
  const c = classifyOutcome({
    httpStatus: 200,
    answerText: served,
    message: V0_EVIDENCE,
    poolAtRequest: IDLE,
  });
  assert.equal(c.cls, "NON-ANSWER-READ", `the branch is still unreachable for the shape it names — got ${c.cls}: ${c.reason}`);
  assert.notEqual(c.cls, "ANSWERS", "a read that returned a node the service itself names as a non-answer is not ANSWERS");
});

test("ANTI-VACUITY: the reordering must not steal a real answer — a 2xx carrying ordinary output is still ANSWERS", () => {
  const real = classifyOutcome({
    httpStatus: 200,
    answerText: "PONG",
    message: "HTTP 200 in 24204ms at pool 0/4 idle; body carried answer text 'PONG'",
    poolAtRequest: IDLE,
  });
  assert.equal(real.cls, "ANSWERS", `a genuine answer was stolen by the non-answer rule — got ${real.cls}: ${real.reason}`);

  // …and at a BUSY pool the marker-bearing 2xx is still refused rather than
  // answered in either direction, because under contention it is a measurement
  // of the queue.
  const contended = classifyOutcome({
    httpStatus: 200,
    answerText: "Exploring ideas...",
    message: V0_EVIDENCE,
    poolAtRequest: BUSY,
  });
  assert.equal(contended.cls, "UNCLASSIFIED", "a non-answer 2xx under contention must be refused, not filed in either direction");
});

test("ANSWER-UNREADABLE: an answer selector that matched nothing, at an idle pool", () => {
  const c = classifyOutcome({ httpStatus: 502, message: VENICE_EVIDENCE, poolAtRequest: IDLE });
  assert.equal(c.cls, "ANSWER-UNREADABLE", `expected ANSWER-UNREADABLE, got ${c.cls}: ${c.reason}`);
  assert.match(c.reason, /DRIVER cannot read this model/);
  assert.match(c.reason, /does NOT mean the model failed to answer/);
});

test("the two new classes are DISTINCT — a read that returned the wrong node is not a read that returned nothing", () => {
  const unread = classifyOutcome({ httpStatus: 502, message: VENICE_EVIDENCE, poolAtRequest: IDLE });
  const nonAnswer = classifyOutcome({ httpStatus: 200, message: V0_EVIDENCE, poolAtRequest: IDLE });
  assert.notEqual(unread.cls, nonAnswer.cls);
  // The separating observation: v0's body carried text and the service named it
  // as not-the-answer; venice's carried no answer text at all and the service
  // named a zero-node selector match. Neither marker appears in the other row.
  assert.equal(nonAnswerTextIn(VENICE_EVIDENCE), null, "venice's evidence must not claim a non-answer 2xx");
  assert.equal(unmatchedSelectorIn(V0_EVIDENCE), null, "v0's evidence must not claim a zero-node match");
  // …and venice really did answer, so a consumer must not read this as a model
  // that cannot answer. The class says the DRIVER could not read it.
  assert.notEqual(unread.cls, "ANSWERS");
  assert.notEqual(unread.cls, "SIGN-OUT");
  assert.notEqual(unread.cls, "WALL-CHALLENGE");
});

test("both new classes are distinct from COMPOSER-DRIFT — a composer that found nothing is a third condition", () => {
  const drift = classifyOutcome({
    httpStatus: 502,
    message: NO_COMPOSER("blackbox"),
    page: { title: "Blackbox: The high-trust platform for frontier inference", url: "https://www.blackbox.ai/" },
    poolAtRequest: IDLE,
  });
  assert.equal(drift.cls, "COMPOSER-DRIFT");
  assert.notEqual(drift.cls, "NON-ANSWER-READ", "a missing composer is not a read that served a non-answer");
  assert.notEqual(drift.cls, "ANSWER-UNREADABLE", "a missing composer is not a zero-node answer-selector match");
  // The separating observation: COMPOSER-DRIFT requires the server to have
  // REPORTED a page and named a missing composer; the new two do not, and
  // v0's status is a 2xx where every COMPOSER-DRIFT row is a 502.
  assert.equal(classifyOutcome({ httpStatus: 502, message: NO_COMPOSER("x"), poolAtRequest: IDLE }).cls, "UNCLASSIFIED");
});

// ── the anti-vacuity half: the widening must not become an escape hatch ──────

test("ANTI-VACUITY: an observation matching NEITHER new condition is still UNCLASSIFIED, never a class", () => {
  // A 200 that carried a real answer, and a 502 that named neither condition.
  // Before the widening this was the only possible outcome for a row the rules
  // cannot explain; it must remain possible afterwards, or the two new classes
  // have become a place to hide anything unclassifiable.
  const unknown200 = classifyOutcome({ httpStatus: 200, message: "HTTP 200 in 9000ms, body carried some text", poolAtRequest: IDLE });
  assert.equal(unknown200.cls, "UNCLASSIFIED", "a 2xx with no non-answer claim must not become NON-ANSWER-READ");

  const unknown502 = classifyOutcome({ httpStatus: 502, message: "something went wrong", poolAtRequest: IDLE });
  assert.equal(unknown502.cls, "UNCLASSIFIED", "a 502 with no zero-match claim must not become ANSWER-UNREADABLE");

  // And the two markers are not free-text: they are finite, reviewable lists,
  // and text that merely resembles them is not a match.
  assert.equal(nonAnswerTextIn("the answer was fine and complete"), null);
  assert.equal(unmatchedSelectorIn("the selector matched three nodes"), null);
  assert.ok(NON_ANSWER_TEXT_PATTERNS.length > 0 && UNMATCHED_SELECTOR_PATTERNS.length > 0);
});

test("ANTI-VACUITY: neither new class may be filed at a BUSY pool — that is contention, not a model property", () => {
  assert.equal(
    classifyOutcome({ httpStatus: 200, message: V0_EVIDENCE, poolAtRequest: BUSY }).cls,
    "UNCLASSIFIED",
    "a non-answer 2xx measured under contention is a measurement of the queue",
  );
  assert.equal(
    classifyOutcome({ httpStatus: 502, message: VENICE_EVIDENCE, poolAtRequest: BUSY }).cls,
    "UNCLASSIFIED",
    "a zero-node selector match measured under contention is a measurement of the queue",
  );
});

test("both new classes declare a machine-checkable precondition and it is stricter than UNMEASURED's", () => {
  for (const c of ["NON-ANSWER-READ", "ANSWER-UNREADABLE"] as const) {
    const p = classPrecondition(c);
    for (const f of ["measuredAt", "method", "evidence"] as const) {
      assert.ok(p.requiredFields.includes(f), `${c} must require ${f}`);
    }
    assert.ok(p.requiresPoolState, `${c} must require pool state`);
    assert.ok(p.requiresIdlePool, `${c} must require an idle pool`);
  }
  assert.deepEqual(classPrecondition("UNMEASURED").requiredFields, []);
});

// ── the SHIPPED record: the two re-filed rows derive, and their measured
//    values are the ones the measurement produced ────────────────────────────

interface ShippedRow {
  model?: string;
  measuredAt?: unknown;
  class?: unknown;
  httpStatus?: unknown;
  evidence?: unknown;
  poolAtRequest?: unknown;
}

const SHIPPED = (JSON.parse(
  readFileSync(resolve(process.cwd(), "capabilities/model-verification.json"), "utf8"),
) as { records: ShippedRow[] }).records;

const rowFor = (model: string): ShippedRow => {
  const r = SHIPPED.find((x) => x.model === model);
  assert.ok(r, `the record must carry a ${model} row`);
  return r as ShippedRow;
};

/** The refusal the DEPLOYED service emitted, COMPOSED FROM ITS OWNER rather than
 *  re-typed. `src/prompt/error-redaction.ts` owns the clause, the template, the
 *  render and the retry tail; `src/prompt/verification-class.ts` owns only the
 *  matcher. This file used to carry the whole sentence as a literal — which made
 *  it a third owner of a sentence the service emits, and the copy that would have
 *  survived a reword of the emitter while the row it feeds kept claiming the
 *  class. Deriving it here means a reword of the emitter moves THIS fixture too,
 *  and `test/error-redaction.test.ts`'s exclusivity gate is then the only place
 *  that can decide whether the new words are still the shipped contract. */
const SHIPPED_REFUSAL = `${renderNoAnswerRefusal("v0", "90000")} ${RETRY}`;

test("UNATTRIBUTED-NO-ANSWER: the service's own named refusal, at an idle pool, with no page", () => {
  const c = classifyOutcome({ httpStatus: 502, message: SHIPPED_REFUSAL, poolAtRequest: IDLE });
  assert.equal(c.cls, "UNATTRIBUTED-NO-ANSWER", `expected UNATTRIBUTED-NO-ANSWER, got ${c.cls}: ${c.reason}`);
  // The reason must say the cause is UNKNOWN, and must deny each candidate by
  // name — a class whose wording let a reader conclude which cause is real
  // would be the defect this row exists to prevent.
  assert.match(c.reason, /NO CAUSE IS ESTABLISHED/);
  assert.match(c.reason, /not "the site is rate-limited", not "log in", and not contention/);
  assert.match(c.reason, /re-measure with a discriminator/);
});

test("the shipped v0 row re-derives UNATTRIBUTED-NO-ANSWER from its OWN evidence, and the row carries it", () => {
  const r = rowFor("v0");
  const derived = classifyOutcome({
    httpStatus: r.httpStatus as number,
    message: r.evidence as string,
    poolAtRequest: r.poolAtRequest as { busy?: unknown; total?: unknown; queued?: unknown },
  });
  // The measured values are the ones the 2026-09-30 GOAL-165 sweep printed: four
  // serial attempts at an idle pool, every one the SAME named 502 refusal.
  assert.equal(r.httpStatus, 502);
  assert.deepEqual(r.poolAtRequest, { busy: 0, total: 3, queued: 0 });
  assert.equal(derived.cls, "UNATTRIBUTED-NO-ANSWER", `the shipped evidence must derive the class the row carries, got ${derived.cls}: ${derived.reason}`);
  assert.equal(r.class, derived.cls, "the row must carry what the classifier derives — RULE 11 re-derives every measured row, so a hand-filed class is caught");
  assert.notEqual(r.class, "ANSWERS", "v0 never returned an answer; upgrading it would be a fabrication");
  assert.notEqual(r.class, "CONTENDED-TIMEOUT", "the pool was IDLE, so this is not a measurement of the queue");
  assert.notEqual(r.class, "SIGN-OUT", "the refusal LISTS a possible sign-in wall among its candidates and asserts none of them");
  // The refusal sentence the class keys on really is in the row's evidence —
  // otherwise the row would be asserting a refusal the record does not carry.
  assert.ok(noAnswerRefusalIn(r.evidence as string), "the v0 row's evidence must carry the service's own refusal sentence");
});

test("the class cannot be read as a diagnosis: it is NOT any one of the causes the service named", () => {
  // The refusal names three candidates. This class must hold none of them as
  // its own claim, and each of the three named conditions must keep its own
  // row when the evidence actually supports it.
  assert.equal(NO_ANSWER_REFUSAL_PATTERNS.length, 1);
  assert.ok(noAnswerRefusalIn(SHIPPED_REFUSAL), "the refusal marker must match the service's own sentence");
  // A sentence that merely mentions timeouts is not a match, so the marker
  // cannot be widened into prose-shaped free text.
  assert.equal(noAnswerRefusalIn("the request timed out after a while"), null);
  assert.equal(noAnswerRefusalIn("the site returned no content"), null);
  // The matched pattern is the OWNER'S, compared by source — this file used to
  // assert against a hand-typed `"did not return an answer(?: within \d+\s*ms)?"`,
  // which is the exact copy this change removed: it would have kept passing
  // against a matcher that no longer matched anything, because the expectation
  // was the same words twice rather than the shipped pattern. Asserting against
  // `NO_ANSWER_REFUSAL_RE.source` asks the question that matters — is the
  // classifier running the derived matcher, or one of its own?
  assert.equal(
    noAnswerRefusalIn(SHIPPED_REFUSAL),
    NO_ANSWER_REFUSAL_RE.source,
    "the classifier must run the owner's derived matcher, not a pattern of its own",
  );
  assert.ok(
    new RegExp(NO_ANSWER_REFUSAL_RE.source, "i").test(SHIPPED_REFUSAL),
    "the derived matcher must actually match the sentence the emitter renders — a source-equality " +
      "assertion on its own would pass for a matcher that matches nothing",
  );
});

test("MUTUAL EXCLUSION: the new class cannot swallow a class that was already derivable", () => {
  // (1) a 502 whose message NAMES a credential requirement is still SIGN-OUT,
  // even though it also carries the refusal sentence.
  const signOut = classifyOutcome({
    httpStatus: 502,
    message: `${SHIPPED_REFUSAL} v0 requires sign-in before any answer can be produced.`,
    poolAtRequest: IDLE,
  });
  assert.equal(signOut.cls, "SIGN-OUT", `a named credential requirement was swallowed: ${signOut.cls}: ${signOut.reason}`);

  // (2) a 502 whose REPORTED PAGE is an anti-bot surface is still WALL-CHALLENGE.
  const wall = classifyOutcome({
    httpStatus: 502,
    message: SHIPPED_REFUSAL,
    page: { title: "Just a moment...", url: "https://v0.dev/" },
    poolAtRequest: IDLE,
  });
  assert.equal(wall.cls, "WALL-CHALLENGE", `a challenge page was swallowed: ${wall.cls}: ${wall.reason}`);

  // (3) a 502 whose page LOADED and reported no composer is still COMPOSER-DRIFT —
  // both on its own and when the refusal sentence rides along with it.
  const driftAlone = classifyOutcome({
    httpStatus: 502,
    message: NO_COMPOSER("v0"),
    page: { title: "v0", url: "https://v0.dev/chat" },
    poolAtRequest: IDLE,
  });
  assert.equal(driftAlone.cls, "COMPOSER-DRIFT", `a missing composer was swallowed: ${driftAlone.cls}: ${driftAlone.reason}`);
  const driftWithRefusal = classifyOutcome({
    httpStatus: 502,
    message: `${SHIPPED_REFUSAL} ${NO_COMPOSER("v0")}`,
    page: { title: "v0", url: "https://v0.dev/chat" },
    poolAtRequest: IDLE,
  });
  assert.equal(driftWithRefusal.cls, "COMPOSER-DRIFT", `a missing composer was swallowed by the new branch: ${driftWithRefusal.cls}: ${driftWithRefusal.reason}`);

  // (4) the SAME refusal at a BUSY pool is still UNCLASSIFIED — a queue
  // measurement, never a model property, in either direction.
  const busy = classifyOutcome({ httpStatus: 502, message: SHIPPED_REFUSAL, poolAtRequest: BUSY });
  assert.equal(busy.cls, "UNCLASSIFIED", `the refusal at a busy pool was filed as a model property: ${busy.cls}: ${busy.reason}`);
  assert.match(busy.reason, /measurement of the queue/);

  // (5) a CONTENDED-TIMEOUT is untouched: no response at all, at a busy pool,
  // with the same refusal sentence in the message the record carries.
  const contended = classifyOutcome({ httpStatus: 0, noResponse: true, message: SHIPPED_REFUSAL, poolAtRequest: BUSY });
  assert.equal(contended.cls, "CONTENDED-TIMEOUT", `a contention row was re-filed: ${contended.cls}: ${contended.reason}`);
  const contendedAtIdle = classifyOutcome({ httpStatus: 0, noResponse: true, message: SHIPPED_REFUSAL, poolAtRequest: IDLE });
  assert.equal(contendedAtIdle.cls, "UNCLASSIFIED", "no response at an IDLE pool is not contention and not an unattributed refusal — the response was never reached");
});

test("ANTI-VACUITY: the refusal marker is not a free-text escape hatch for any other 502", () => {
  const other = classifyOutcome({ httpStatus: 502, message: "something went wrong", poolAtRequest: IDLE });
  assert.equal(other.cls, "UNCLASSIFIED", "a 502 naming no condition must stay the classifier's refusal");
  // …and the class requires the refusal sentence, so it cannot be reached by
  // dropping an observedPage onto a row that reports nothing else.
  const noSentence = classifyOutcome({ httpStatus: 502, message: "no answer", page: { title: "v0", url: "https://v0.dev/" }, poolAtRequest: IDLE });
  assert.equal(noSentence.cls, "UNCLASSIFIED", "a 502 without the service's own refusal sentence is not an unattributed refusal");
});

test("the new class declares a machine-checkable precondition, enforced by RULE 10", () => {
  const p = classPrecondition("UNATTRIBUTED-NO-ANSWER");
  for (const f of ["measuredAt", "method", "evidence"] as const) {
    assert.ok(p.requiredFields.includes(f), `UNATTRIBUTED-NO-ANSWER must require ${f}`);
  }
  assert.ok(p.requiresPoolState, "UNATTRIBUTED-NO-ANSWER must require poolAtRequest {busy,total}");
  assert.ok(p.requiresIdlePool, "UNATTRIBUTED-NO-ANSWER must require an IDLE pool — at a busy pool the same refusal is a measurement of the queue");
  // observedPage is deliberately NOT required: the service reported no page on
  // this path, and demanding one would make the class unreachable, not stricter.
  assert.ok(!p.requiredFields.includes("observedPage"), "requiring observedPage would make the class unreachable — the refusal path reports no page");
  assert.ok(CLASS_PRECONDITIONS["UNATTRIBUTED-NO-ANSWER"].requiredFields.length > 0, "a class that requires nothing is a free-text escape hatch");
});

test("the shipped venice row re-derives NON-ANSWER-READ, and the classifier AGREES from the record's own evidence", () => {
  const r = rowFor("venice");
  const derived = classifyOutcome({
    httpStatus: r.httpStatus as number,
    message: r.evidence as string,
    poolAtRequest: r.poolAtRequest as { busy?: unknown; total?: unknown; queued?: unknown },
  });
  assert.equal(derived.cls, "NON-ANSWER-READ", `expected NON-ANSWER-READ from the shipped venice evidence, got ${derived.cls}: ${derived.reason}`);
  assert.equal(r.class, derived.cls, "the row must carry the derived class — RULE 11 re-derives every measured row");
  assert.equal(r.measuredAt, "2026-09-30T16:33:30Z");
  assert.equal(r.httpStatus, 200);
  assert.deepEqual(r.poolAtRequest, { busy: 0, total: 3, queued: 0 });
  assert.match(r.evidence as string, /41793ms/);
  assert.match(r.evidence as string, /NOT the requested token/);
  assert.notEqual(r.class, "ANSWERS", "the 200 served the model's intermediate reasoning, not the requested token");
});

test("the ANSWERS set did not grow — re-filing is not promoting", () => {
  const answering = SHIPPED.filter((r) => r.class === "ANSWERS").map((r) => r.model).sort();
  assert.deepEqual(answering, ["duckduckgo", "gemini"], `the ANSWERS set changed: ${answering.join(", ")} — v0 must not be promoted to ANSWERS by a widened vocabulary`);
  // Every row is now filed in a member of the closed set, which is what lets
  // RULE 4 stand down — and the class v0 carries is the refusal itself, never a
  // cause the refusal only listed as a candidate.
  const unclassified = SHIPPED.filter((r) => r.class === "UNCLASSIFIED").map((r) => r.model).sort();
  assert.deepEqual(unclassified, [], `no row may be parked on the classifier's refusal token, got ${unclassified.join(", ")}`);
  const unattributed = SHIPPED.filter((r) => r.class === "UNATTRIBUTED-NO-ANSWER").map((r) => r.model).sort();
  assert.deepEqual(unattributed, ["v0"], `only v0 may carry the unattributed refusal, got ${unattributed.join(", ")}`);
});


// ─────────────────────────────────────────────────────────────────────────────
// RETURNS-DATA — the class that makes a CAPABILITY surface measurable
//
// THE DEFECT. Every member above keys on a CHAT ANSWER: ANSWERS needs a
// matched per-measurement nonce plus `answerChars>0` plus `doneReason:"stable"`,
// and the six failure members key on a page marker or a message the driver
// emitted. MEASURED against the live daemon on 127.0.0.1:9797, `araprat_search`
// answers HTTP 200 with `ok:true` and 29 real rows at `data.results` — and the
// pre-widening vocabulary derived UNCLASSIFIED for it, which is not a class, so
// `scripts/audit/record-roundtrip.mjs` refused to write the row at all. No
// capability surface could ever be recorded as MEASURED: a checker whose
// vocabulary cannot express the thing it is asked to check.
//
// WHAT THE INPUTS BELOW ARE. The 200/ok:true/29-row shape is the real measured
// `POST /capability/araprat` response (the row it produced is in
// capabilities/roundtrip.json); the empty one is the real measured
// `duckduckgo_chat_history` response; the refusal is the real shape
// `src/capabilities/gated.ts:38 loginGatedResult` emits.
// ─────────────────────────────────────────────────────────────────────────────

const ARAPRAT_ROWS = { topLevelKeys: ["capability", "data", "latencyMs", "method", "ok"], rowsPath: "data.results", count: 29, rows: 29 };

test("RETURNS-DATA: a capability surface that returned real rows is a MEASURABLE outcome, not UNCLASSIFIED forever", () => {
  const c = classifyOutcome({ httpStatus: 200, message: "", capabilityOk: true, resultShape: ARAPRAT_ROWS, poolAtRequest: IDLE });
  assert.equal(c.cls, "RETURNS-DATA", `expected RETURNS-DATA, got ${c.cls}: ${c.reason}`);
  assert.match(c.reason, /29 record\(s\)/);
  assert.match(c.reason, /data\.results/);
  // The class says ONE thing, and the reason must not let a reader read more
  // into it: it is about the output SHAPE, not the content, and it borrows
  // nothing from the chat rules.
  assert.match(c.reason, /not its content and not a chat answer/);
});

test("RETURNS-DATA: the empty result set is a MEASUREMENT OF NOTHING and stays on the classifier's refusal", () => {
  const c = classifyOutcome({
    httpStatus: 200,
    message: "",
    capabilityOk: true,
    resultShape: { topLevelKeys: ["capability", "data", "ok"], rowsPath: "data.chats", count: 0, rows: 0 },
    poolAtRequest: IDLE,
  });
  assert.notEqual(c.cls, "RETURNS-DATA", "an empty result set must not be filed as data returned");
  assert.equal(c.cls, "UNCLASSIFIED", `the empty case must be the classifier's refusal, got ${c.cls}: ${c.reason}`);
  // The reason must NAME the decision, because this is the line: the read
  // reached the site and the site returned no records, which is not evidence
  // that the surface produces results.
  assert.match(c.reason, /SUCCESSFUL MEASUREMENT OF NOTHING/);
  assert.match(c.reason, /needs its OWN class member on purpose/);
  assert.equal(emptyCapabilityResult({ capabilityOk: true, resultShape: { count: 0, rows: 0, rowsPath: "data.chats" } }), true);
});

test("RETURNS-DATA: a refusal that reached the wire (ok:false, login-gated) must NEVER derive the data class", () => {
  const c = classifyOutcome({
    httpStatus: 502,
    // The real `loginGatedResult` error string (src/capabilities/gated.ts:38).
    message: "login-required: araprat_comment needs an authorized captured araprat session (ui2api profile capture <url> --login first); recipe shipped, not yet executable",
    capabilityOk: false,
    resultShape: { topLevelKeys: ["capability", "ok", "error", "loginGated"], rowsPath: null, count: null, rows: null },
    poolAtRequest: IDLE,
  });
  assert.notEqual(c.cls, "RETURNS-DATA", "a named refusal was filed as data returned — the single worst outcome of this widening");
  assert.notEqual(c.cls, "ANSWERS", "a refusal is not an answer");
  assert.notEqual(c.cls, "UNMEASURED", "UNMEASURED means never reached; this response WAS reached and must be named, not parked");
});

test("RETURNS-DATA: the DECLARED count alone, or the two halves disagreeing, derives nothing", () => {
  const declaredOnly = classifyOutcome({
    httpStatus: 200,
    message: "",
    capabilityOk: true,
    resultShape: { topLevelKeys: ["capability", "data", "ok"], rowsPath: "data.results", count: 29, rows: null },
    poolAtRequest: IDLE,
  });
  assert.notEqual(declaredOnly.cls, "RETURNS-DATA", `a runner's declared count alone bought the class (${declaredOnly.cls})`);

  const disagreeing = classifyOutcome({
    httpStatus: 200,
    message: "",
    capabilityOk: true,
    resultShape: { topLevelKeys: ["capability", "data", "ok"], rowsPath: "data.results", count: 29, rows: 0 },
    poolAtRequest: IDLE,
  });
  assert.notEqual(disagreeing.cls, "RETURNS-DATA", `a self-contradicting result (count 29 over 0 rows) bought the class (${disagreeing.cls})`);
  assert.equal(capabilityDataEvidence({ httpStatus: 200, capabilityOk: true, resultShape: { topLevelKeys: ["a"], rowsPath: "data.results", count: 29, rows: 0 } }), null);

  // A payload with no keys at all is not a result, it is a refusal that forgot
  // to say ok:false.
  const keyless = classifyOutcome({
    httpStatus: 200,
    message: "",
    capabilityOk: true,
    resultShape: { topLevelKeys: [], rowsPath: "data.results", count: 3, rows: 3 },
    poolAtRequest: IDLE,
  });
  assert.notEqual(keyless.cls, "RETURNS-DATA", `a keyless payload bought the class (${keyless.cls})`);
});

test("RETURNS-DATA: a non-2xx capability response is not this class however good its shape", () => {
  const c = classifyOutcome({ httpStatus: 502, message: "", capabilityOk: true, resultShape: ARAPRAT_ROWS, poolAtRequest: IDLE });
  assert.notEqual(c.cls, "RETURNS-DATA", `a 502 with a good shape bought the class (${c.cls})`);
});

test("RETURNS-DATA: under contention it is a measurement of the QUEUE, in both directions", () => {
  // A capability runner drives a SHARED browser out of the warm pool, so at a
  // busy pool the page the rows were read from may not be this request's own
  // result — the capability form of the stale-echo hazard a nonce kills on chat.
  const c = classifyOutcome({ httpStatus: 200, message: "", capabilityOk: true, resultShape: ARAPRAT_ROWS, poolAtRequest: BUSY });
  assert.equal(c.cls, "UNCLASSIFIED", `rows read under contention were filed as a surface property (${c.cls})`);
  assert.match(c.reason, /measurement of the queue/);
});

test("MUTUAL EXCLUSION: the widening stole nothing that was already derivable", () => {
  // (1) a chat answer with a matched nonce is still ANSWERS, even when the row
  // also carries a capability shape (a harness that recorded both).
  const both = classifyOutcome({
    httpStatus: 200,
    answerText: "PONG-abc",
    message: "",
    capabilityOk: true,
    resultShape: ARAPRAT_ROWS,
    poolAtRequest: IDLE,
  });
  assert.equal(both.cls, "ANSWERS", `the capability branch swallowed a real answer (${both.cls}): ${both.reason}`);

  // (2) every pre-existing failure class still derives from its own evidence,
  // with no capability fields anywhere in the input.
  assert.equal(classifyOutcome({ httpStatus: 502, message: NO_COMPOSER("grok"), page: { title: "Attention Required! | Cloudflare", url: "https://grok.com/" }, poolAtRequest: IDLE }).cls, "WALL-CHALLENGE");
  assert.equal(classifyOutcome({ httpStatus: 200, message: V0_EVIDENCE, poolAtRequest: IDLE }).cls, "NON-ANSWER-READ");
  assert.equal(classifyOutcome({ httpStatus: 502, message: VENICE_EVIDENCE, poolAtRequest: IDLE }).cls, "ANSWER-UNREADABLE");
  assert.equal(classifyOutcome({ httpStatus: 502, message: `${SHIPPED_REFUSAL} v0 requires sign-in before any answer can be produced.`, poolAtRequest: IDLE }).cls, "SIGN-OUT");

  // (3) a plain 200 with neither chat nor capability evidence is STILL the
  // classifier's refusal — the widening did not become an escape hatch.
  const plain = classifyOutcome({ httpStatus: 200, message: "HTTP 200 in 9000ms", poolAtRequest: IDLE });
  assert.equal(plain.cls, "UNCLASSIFIED", `a 200 with no evidence of anything became a class (${plain.cls})`);
});

test("RETURNS-DATA declares a machine-checkable precondition, stricter than ANSWERS's", () => {
  const p = classPrecondition("RETURNS-DATA");
  for (const f of ["measuredAt", "method", "evidence", "capabilityOk", "resultShape"] as const) {
    assert.ok(p.requiredFields.includes(f), `RETURNS-DATA must require ${f} — the gate enforces requiredFields, so an unnamed field is an ungoverned one`);
  }
  assert.ok(p.requiresPoolState, "RETURNS-DATA must require poolAtRequest {busy,total}");
  assert.ok(p.requiresIdlePool, "RETURNS-DATA must require an IDLE pool — a capability reads a SHARED browser, so a busy pool is a measurement of the queue");
  // observedPage is deliberately NOT required: `/capability` answers the runner's
  // result, not the driver's page observation, so demanding one would make the
  // class unreachable rather than stricter.
  assert.ok(!p.requiredFields.includes("observedPage"), "requiring observedPage would make RETURNS-DATA unreachable on /capability");
  // It is derived from the same fields the classifier reads, which is what makes
  // the re-derivation check (not a name check) the thing that catches a lie.
  assert.deepEqual(
    [...p.requiredFields].sort(),
    ["capabilityOk", "evidence", "measuredAt", "method", "resultShape"].sort(),
  );
});

test("the vocabulary grew by exactly ONE member, and no existing class changed meaning", () => {
  // ANSWERS is still the ONLY class a chat answer can derive, and it is still
  // gated on the same three things.
  const answers = classifyOutcome({ httpStatus: 200, answerText: "PONG", message: "", poolAtRequest: IDLE });
  assert.equal(answers.cls, "ANSWERS");
  assert.equal(classifyOutcome({ httpStatus: 200, answerText: "   ", message: "", poolAtRequest: IDLE }).cls, "UNCLASSIFIED", "whitespace is not an answer");
  assert.equal(classifyOutcome({ httpStatus: 500, answerText: "PONG", message: "", poolAtRequest: IDLE }).cls, "UNCLASSIFIED", "a 5xx is never ANSWERS");
  assert.equal(VERIFICATION_CLASSES.length, 10, `the closed set is ${VERIFICATION_CLASSES.length}: ${VERIFICATION_CLASSES.join(", ")}`);
  assert.ok(VERIFICATION_CLASSES.includes("RETURNS-DATA"));
  assert.deepEqual(Object.keys(CLASS_PRECONDITIONS).sort(), [...VERIFICATION_CLASSES].sort());
});

test("RETURNS-DATA arm 2: a SINGLE-RECORD result is measurable — it is a record, not a collection", () => {
  // MEASURED against the live daemon: `araprat_video_detail` answers
  // `{ok:true, data:{id, url, title, description, related:[…], relatedCount:n}}`
  // — one record beside a count that describes a SECONDARY collection, so the
  // list arm cannot fire. Under arm 1 alone this real, populated, live result
  // derived UNCLASSIFIED, which is the defect this class exists to kill, one
  // surface down.
  const c = classifyOutcome({
    httpStatus: 200,
    message: "",
    capabilityOk: true,
    resultShape: {
      topLevelKeys: ["capability", "data", "latencyMs", "method", "ok"],
      rowsPath: null,
      count: null,
      rows: null,
      recordPath: "data",
      recordKeys: ["description", "id", "related", "relatedCount", "title", "url"],
      nonEmptyValues: 5,
      declaredZeroCount: false,
    },
    poolAtRequest: IDLE,
  });
  assert.equal(c.cls, "RETURNS-DATA", `a populated single record did not derive the class, got ${c.cls}: ${c.reason}`);
  assert.match(c.reason, /POPULATED RECORD at data/);
  assert.match(c.reason, /WEAKER of this class's two evidence arms/);
});

test("RETURNS-DATA arm 2 is GUARDED: an empty shell, an empty sibling, or a declared zero count is not data", () => {
  const base = {
    topLevelKeys: ["capability", "data", "ok"],
    rowsPath: null,
    count: null,
    rows: null,
    recordPath: "data",
    recordKeys: ["id", "title"],
    nonEmptyValues: 2,
    declaredZeroCount: false,
  };
  // (1) a record with no populated values is a shell, not a result.
  const shell = classifyOutcome({
    httpStatus: 200,
    message: "",
    capabilityOk: true,
    resultShape: { ...base, nonEmptyValues: 0 },
    poolAtRequest: IDLE,
  });
  assert.notEqual(shell.cls, "RETURNS-DATA", `an empty result object bought the class (${shell.cls})`);

  // (2) a record with no keys at all is not a record.
  const keyless = classifyOutcome({
    httpStatus: 200,
    message: "",
    capabilityOk: true,
    resultShape: { ...base, recordKeys: [] },
    poolAtRequest: IDLE,
  });
  assert.notEqual(keyless.cls, "RETURNS-DATA", `a keyless record bought the class (${keyless.cls})`);

  // (3) THE LOAD-BEARING ONE. MEASURED: `duckduckgo_chat_history` answers
  // `{ok:true, data:{count: 0, chats: [], stores:[…5…], sidebar:{…}}}` — a
  // populated `stores` array sits right beside the empty result, so without the
  // `declaredZeroCount` anchor the record arm would have filed a genuinely EMPTY
  // result as data returned. That is the exact failure the empty decision exists
  // to prevent, reached through the arm added afterwards.
  const emptyWithPopulatedSibling = classifyOutcome({
    httpStatus: 200,
    message: "",
    capabilityOk: true,
    resultShape: {
      topLevelKeys: ["capability", "data", "ok"],
      rowsPath: "data.chats",
      count: 0,
      rows: 0,
      recordPath: "data",
      recordKeys: ["chats", "count", "sidebar", "stores"],
      nonEmptyValues: 3,
      declaredZeroCount: true,
    },
    poolAtRequest: IDLE,
  });
  assert.notEqual(emptyWithPopulatedSibling.cls, "RETURNS-DATA", `a populated sibling talked an EMPTY result into the class (${emptyWithPopulatedSibling.cls})`);
  assert.equal(emptyWithPopulatedSibling.cls, "UNCLASSIFIED");
  assert.match(emptyWithPopulatedSibling.reason, /SUCCESSFUL MEASUREMENT OF NOTHING/);
});
