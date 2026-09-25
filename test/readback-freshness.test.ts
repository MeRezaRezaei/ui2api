import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  awaitAnswerFromReads,
  freshRegion,
  snapshotBaseline,
  type AnswerRegionRead,
} from "../src/runtime/dom-primitives.js";
import { newChatResetVerified } from "../src/prompt/driver.js";

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