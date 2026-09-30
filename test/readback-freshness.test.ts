import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  awaitAnswerFromReads,
  freshRegion,
  snapshotBaseline,
  type AnswerRegionRead,
} from "../src/runtime/dom-primitives.js";
import { newChatResetVerified } from "../src/prompt/driver.js";
import { judgeAnswerShape } from "../src/runtime/dom-primitives.js";
import { readFileSync } from "node:fs";

// GOAL 46 — answer-readback freshness (stale-echo guard): the daemon pool
// reuses warm pages, so without a per-ask baseline the answer reader would go
// "stable" on the PREVIOUS prompt's still-mounted answer and echo it as the
// fresh reply. These tests are pure (no browser): they inject fixture region
// reads into awaitAnswerFromReads, the exact loop the browser path runs, and
// assert the verdict logic verbatim — never the baseline's text.

const OLD = "OLD ANSWER FROM PROMPT A";

test("stale-echo: a growing new bubble after the old answer yields the NEW text, never the old echo", async () => {
  // Scripted reads: pre-ask unchanged (old answer alone), the site mounts an
  // empty answer bubble, it streams the new answer, then holds.
  const reads: AnswerRegionRead[] = [
    { text: OLD, elementTexts: [OLD] },
    { text: OLD, elementTexts: [OLD, ""] },
    { text: "NEW", elementTexts: [OLD, "NEW"] },
    { text: "NEW ANSWER", elementTexts: [OLD, "NEW ANSWER"] },
    { text: "NEW ANSWER FOR PROMPT B", elementTexts: [OLD, "NEW ANSWER FOR PROMPT B"] },
  ];
  let step = 0;
  const read = async (): Promise<AnswerRegionRead> =>
    reads[Math.min(step++, reads.length - 1)];

  const out = await awaitAnswerFromReads(read, { timeoutMs: 2000, stableMs: 40, pollMs: 5 }, reads[0]);

  assert.equal(out.doneReason, "stable");
  assert.equal(out.text, "NEW ANSWER FOR PROMPT B");
  assert.ok(!out.text.includes("OLD ANSWER FROM PROMPT A"), "must never echo the pre-ask answer");
  assert.ok(out.chunkCount >= 5, "polled several times before stabilizing");
});

test("no-growth: only the old answer present forever reports stale (never echoes it); empty baseline reports empty", async () => {
  // Stale: the pre-ask answer is mounted the whole time and nothing changes.
  const staleRead = async (): Promise<AnswerRegionRead> => ({ text: OLD, elementTexts: [OLD] });
  const staleOut = await awaitAnswerFromReads(
    staleRead,
    { timeoutMs: 80, stableMs: 50, pollMs: 10 },
    { text: OLD, elementTexts: [OLD] }
  );
  assert.equal(staleOut.doneReason, "stale");
  assert.equal(staleOut.text, "", "no fresh text ever appeared — empty, never the old echo");

  // Empty: the region was empty before the ask and stays empty — a plain
  // "no answer", NOT "stale" (nothing was ever mounted to be stale).
  const emptyRead = async (): Promise<AnswerRegionRead> => ({ text: "", elementTexts: [] });
  const emptyOut = await awaitAnswerFromReads(emptyRead, { timeoutMs: 80, stableMs: 50, pollMs: 10 }, { text: "", elementTexts: [] });
  assert.equal(emptyOut.doneReason, "empty");
  assert.equal(emptyOut.text, "");

  // freshRegion is the exact seam behind both verdicts: appended bubbles (new
  // by position), in-place container reuse (new by content), and the identical
  // region (the stale-echo shape: no fresh text, no change).
  const baseline = snapshotBaseline({ text: OLD, elementTexts: [OLD] });
  const appended = freshRegion({ text: "NEW ANSWER FOR PROMPT B", elementTexts: [OLD, "NEW ANSWER FOR PROMPT B"] }, baseline);
  assert.equal(appended.fresh, "NEW ANSWER FOR PROMPT B");
  assert.equal(appended.changed, true);
  const reused = freshRegion({ text: "NEW ANSWER FOR PROMPT B", elementTexts: ["NEW ANSWER FOR PROMPT B"] }, baseline);
  assert.equal(reused.fresh, "NEW ANSWER FOR PROMPT B");
  assert.equal(reused.changed, true);
  const same = freshRegion({ text: OLD, elementTexts: [OLD] }, baseline);
  assert.equal(same.fresh, "");
  assert.equal(same.changed, false);
});

test("newChat reset verification refuses to compose until either reset signal is observable", () => {
  assert.equal(newChatResetVerified({ answerRegionEmpty: true, composerEmpty: false }), true);
  assert.equal(newChatResetVerified({ answerRegionEmpty: false, composerEmpty: true }), true);
  assert.equal(newChatResetVerified({ answerRegionEmpty: true, composerEmpty: null }), true);
  assert.equal(newChatResetVerified({ answerRegionEmpty: null, composerEmpty: true }), true);
  assert.equal(newChatResetVerified({ answerRegionEmpty: false, composerEmpty: false }), false);
  assert.equal(newChatResetVerified({ answerRegionEmpty: null, composerEmpty: null }), false);
  assert.equal(newChatResetVerified({ answerRegionEmpty: false, composerEmpty: null }), false);
});
// --- GOAL 160: the ANSWER-SHAPE gate ---------------------------------------
// The two strings below are the ones MEASURED on the wire through the deployed
// service (scripts/audit/model-answers-audit-2026-09-30.md §3): both were served
// as HTTP 200 `stable` answers, and neither is the answer. Before the gate they
// round-trip through awaitAnswerFromReads untouched — this is the RED the goal
// required, reproduced above the assertions below and re-asserted here as the
// shape the gate must now refuse.
//
// RED, re-asserted hermetically: with NO declared non-answer signals (which is
// exactly the state both sites were in), the seam has nothing to judge against
// and returns the status text as a `stable` answer. That is the defect, kept as
// a test so the gate can never be mistaken for something that was always here.
test("GOAL 160 RED (pinned): an undeclared status region is served as a stable answer", async () => {
  const V0_STATUS = "Cooking…";
  const base = { text: "", elementTexts: [] };
  const reads = [base, { text: V0_STATUS, elementTexts: [V0_STATUS] }, { text: V0_STATUS, elementTexts: [V0_STATUS] }];
  let i = 0;
  const out = await awaitAnswerFromReads(async () => reads[Math.min(i++, 2)], { timeoutMs: 1000, stableMs: 40, pollMs: 5 }, base);
  assert.equal(out.doneReason, "stable");
  assert.equal(out.text, V0_STATUS, "pre-gate behaviour: the status region WAS the answer");
});

test("GOAL 160: a declared status region is refused with doneReason non-answer, never served", async () => {
  const V0_STATUS = "Cooking…";
  const base: AnswerRegionRead = { text: "", elementTexts: [] };
  // With the profile's declared non-answer selector, the page read excludes the
  // status node from the candidate set and returns its text as EVIDENCE.
  const reads: AnswerRegionRead[] = [
    base,
    { text: "", elementTexts: [""], nonAnswerMatches: [{ selector: '[class*="status"]', texts: [V0_STATUS] }] },
    { text: "", elementTexts: [""], nonAnswerMatches: [{ selector: '[class*="status"]', texts: [V0_STATUS] }] },
    { text: "", elementTexts: [""], nonAnswerMatches: [{ selector: '[class*="status"]', texts: [V0_STATUS] }] },
  ];
  let i = 0;
  const out = await awaitAnswerFromReads(async () => reads[Math.min(i++, 3)], { timeoutMs: 900, stableMs: 40, pollMs: 5 }, base);
  assert.equal(out.doneReason, "non-answer");
  assert.equal(out.text, "", "the status text is NEVER returned as the answer");
  assert.equal(out.nonAnswer?.selector, '[class*="status"]', "the refusal names the declared selector");
  assert.equal(out.nonAnswer?.text, V0_STATUS, "and carries the refused text as evidence");
});

test("GOAL 160: the venice reasoning preamble is refused, and a real answer beside it is not", async () => {
  const REASONING = 'The user wants me to reply with exactly "PONG". This';
  const base: AnswerRegionRead = { text: "", elementTexts: [] };
  // Case 1: the reasoning container is the ONLY thing that grew.
  const reasoningOnly: AnswerRegionRead[] = [base, base, base, { text: "", elementTexts: [""], nonAnswerMatches: [{ selector: '[class*="reasoning"]', texts: [REASONING] }] }];
  let i = 0;
  const refused = await awaitAnswerFromReads(async () => reasoningOnly[Math.min(i++, 3)], { timeoutMs: 900, stableMs: 40, pollMs: 5 }, base);
  assert.equal(refused.doneReason, "non-answer");
  assert.equal(refused.text, "");

  // Case 2: the site's own JS puts the reasoning INSIDE the answer container.
  // The answer region then genuinely carries text — and that text is the
  // reasoning. judgeAnswerShape is what catches this shape, because the
  // reasoning sub-node is one the profile declared non-answer.
  const verdict = judgeAnswerShape(REASONING, [{ selector: '[class*="reasoning"]', texts: [REASONING] }]);
  assert.equal(verdict.answerShaped, false);
  assert.equal(verdict.reason, "non-answer-region");
  assert.equal(verdict.matchedSelector, '[class*="reasoning"]');

  // A real answer that happens to sit in the same region is NOT refused.
  const real = judgeAnswerShape("PONG", [{ selector: '[class*="reasoning"]', texts: [REASONING] }]);
  assert.equal(real.answerShaped, true);
  // And a profile that declares nothing is never refused — the gate invents no
  // signal of its own, so it cannot produce a false refusal.
  assert.equal(judgeAnswerShape("Cooking…", []).answerShaped, true);
  assert.equal(judgeAnswerShape("PONG", []).answerShaped, true);
});

test("GOAL 160: the two measured sites declare non-answer signals, and v0's answer selector stays scoped", () => {
  // Selector-precision pin. v0's bare `[data-message-content]` matched any node
  // carrying that attribute anywhere on the page, which is how a status region
  // won the longest-element read; the recipe-scoped selector is the real answer
  // container. This fails LOUD if a future edit widens it back.
  const v0 = JSON.parse(readFileSync(new URL("../capabilities/v0/profile.json", import.meta.url), "utf8"));
  assert.deepEqual(v0.answer, ['[data-testid="message"][role="listitem"] [data-message-content]']);
  assert.ok(v0.capability?.nonAnswerSelectors?.length, "v0 must declare its status/thinking regions");
  const venice = JSON.parse(readFileSync(new URL("../capabilities/venice/profile.json", import.meta.url), "utf8"));
  assert.ok(venice.capability?.nonAnswerSelectors?.length, "venice must declare its reasoning regions");
  assert.ok(
    !venice.answer.includes('[class*="message"]'),
    "venice's answer selector must stay scoped to the answer sub-node, not the message container"
  );
  for (const p of [v0, venice]) {
    for (const sel of p.capability.nonAnswerSelectors) {
      assert.doesNotThrow(() => new Function(`return document.querySelectorAll(${JSON.stringify(sel)})`) === null);
    }
    for (const sel of p.answer) {
      assert.doesNotThrow(() => new Function(`return document.querySelectorAll(${JSON.stringify(sel)})`) === null);
    }
  }
});
