// GOAL 156 (Cause A): the answer READ was unbounded, only the poll loop was
// bounded. A `page.evaluate` that never returns parked `awaitAnswerFromReads`
// forever, so `driver.ask()` never settled, `pool.release()` was never reached
// and the pool slot was lost PERMANENTLY. These tests are hermetic: the browser
// is injected as a `read` fixture that can hang, resolve slowly, or resolve
// normally, so the production loop is exercised verbatim with no browser.
//
// RED against the unfixed code: the "read never resolves" cases hang until the
// test deadline. GREEN after the fix: they return inside the budget.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitAnswerFromReads, type AnswerRegionRead } from "../src/runtime/dom-primitives.js";

/** A read that never settles and never rejects — the CDP-hang fixture. */
const neverResolves = (): Promise<AnswerRegionRead> => new Promise<AnswerRegionRead>(() => {});

/** A read that resolves after `ms`. */
function slowRead(ms: number, region: AnswerRegionRead): () => Promise<AnswerRegionRead> {
  return () => new Promise<AnswerRegionRead>((r) => setTimeout(() => r(region), ms));
}

const region = (...elementTexts: string[]): AnswerRegionRead => {
  let best = "";
  for (const t of elementTexts) if (t.length > best.length) best = t;
  return { text: best, elementTexts };
};

test("a read that NEVER resolves ends the ask inside the budget with no fabricated text", async () => {
  // The baseline IS supplied, so the hang happens on a POLL read inside the
  // loop — this is the shape the live 1569s hang had: the loop's clock was
  // long gone, the read was not.
  const baseline = region("");
  const t0 = Date.now();
  const res = await awaitAnswerFromReads(neverResolves, { timeoutMs: 400, stableMs: 50, pollMs: 20 }, baseline);
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 5000, `must return bounded, took ${elapsed}ms`);
  // "empty", not "timeout": nothing was ever read, so the existing tail remap
  // ("no fresh text + empty baseline -> empty") is the honest verdict — the
  // caller sees "no answer appeared", never a hang and never an invented text.
  assert.equal(res.doneReason, "empty", "a hung read is an honest no-answer verdict, never a hang");
  assert.equal(res.text, "", "no text was ever read — returning any would be fabrication");
  assert.equal(res.chunkCount, 0, "no read completed, so no poll was counted");
});

test("a hung read after real progress returns the LAST text actually read", async () => {
  // Two good reads (a streaming answer), then a read that never comes back.
  let n = 0;
  const read = (): Promise<AnswerRegionRead> => {
    n += 1;
    if (n === 1) return Promise.resolve(region(""));
    if (n === 2) return Promise.resolve(region("partial ans"));
    return neverResolves();
  };
  const t0 = Date.now();
  const res = await awaitAnswerFromReads(read, { timeoutMs: 400, stableMs: 5000, pollMs: 20 }, region(""));
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 5000, `must return bounded, took ${elapsed}ms`);
  assert.equal(res.text, "partial ans", "returns only what it really read");
  assert.equal(res.doneReason, "timeout");
});

test("a hung BASELINE read refuses loudly instead of inventing an empty baseline", async () => {
  // Without a baseline, an empty one would make the previous answer's elements
  // look "fresh" and get served as this prompt's answer — the stale-echo
  // fabrication the baseline exists to prevent. So it must be a named refusal.
  await assert.rejects(
    () => awaitAnswerFromReads(neverResolves, { timeoutMs: 400, stableMs: 50, pollMs: 20 }),
    /answer-read-timeout/
  );
});

test("a read that resolves slowly but within budget still works (no happy-path regression)", async () => {
  const baseline = region("");
  const t0 = Date.now();
  const res = await awaitAnswerFromReads(
    slowRead(150, region("slow answer")),
    { timeoutMs: 5000, stableMs: 50, pollMs: 20 },
    baseline
  );
  assert.ok(Date.now() - t0 >= 150, "the read was genuinely awaited");
  assert.equal(res.doneReason, "stable");
  assert.equal(res.text, "slow answer");
});

test("a normal streaming sequence still returns doneReason:stable with the right text", async () => {
  const seq = ["H", "He", "Hel", "Hell", "Hello"];
  let i = 0;
  const step = (): Promise<AnswerRegionRead> => Promise.resolve(region("", seq[Math.min(i++, seq.length - 1)]));
  const res = await awaitAnswerFromReads(step, { timeoutMs: 5000, stableMs: 60, pollMs: 20 }, region(""));
  assert.equal(res.doneReason, "stable");
  assert.equal(res.text, "Hello");
  assert.ok(res.chunkCount >= 3, `expected several polls, got ${res.chunkCount}`);
});

test("the stale-echo guard still holds on the bounded path", async () => {
  // The old answer stays mounted and never changes: the bounded loop must still
  // report "stale" (never the old text) when it runs out of budget.
  const res = await awaitAnswerFromReads(
    () => Promise.resolve(region("previous answer")),
    { timeoutMs: 300, stableMs: 50, pollMs: 20 },
    region("previous answer")
  );
  assert.equal(res.doneReason, "stale");
  assert.equal(res.text, "", "never echo the pre-existing answer");
});

test("a rejected read still propagates (an error is never laundered into a timeout)", async () => {
  await assert.rejects(
    () =>
      awaitAnswerFromReads(
        () => Promise.reject(new Error("page.evaluate: target closed")),
        { timeoutMs: 400, stableMs: 50, pollMs: 20 },
        region("")
      ),
    /target closed/
  );
});
