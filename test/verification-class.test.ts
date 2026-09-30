import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CHALLENGE_MARKERS,
  CLASS_PRECONDITIONS,
  VERIFICATION_CLASSES,
  challengeMarkerIn,
  classifyOutcome,
  classPrecondition,
  loginMarkerIn,
  unmeasuredAfterMeasuredResponse,
} from "../src/prompt/verification-class.js";

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
