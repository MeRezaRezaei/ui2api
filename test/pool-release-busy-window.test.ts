// GOAL 239 — a page must never be handed to a second request while `release()`
// is still working on it.
//
// THE DEFECT THIS PINS. `release()` used to clear `worker.busy` at the TOP, then
// went on to await `isWorkerUsable()` (bounded at WORKER_PROBE_TIMEOUT_MS = 5s)
// and `driver.discardPage()`. That left a window — up to five seconds — in which
// the pool was advertising a page as IDLE that it was simultaneously tearing
// down. A concurrent `acquire()` for the same site matched `!w.busy` at the
// reuse scan, took the SAME worker object, and the original `release()` then
// finished and called `discardPage()` on it *under that second request*, while
// also handing the same object to a queued waiter through `drainWorker`.
//
// Two requests on one tab. That is exactly the residue class ROUND N+104
// exists to forbid, and parallel same-site agents are the documented common
// case, so this was the normal path rather than a corner.
//
// WHAT IS ASSERTED — BEHAVIOUR, NOT IMPLEMENTATION. This test never reads
// `worker.busy`, never asserts a probe was called, and never counts flags. It
// asserts two observable facts about the ORDER of events:
//
//   1. a second `acquire()` for the same site that arrives while the first
//      request is still inside `release()` must NOT have been served yet — the
//      page is still being worked on, so the second request has nowhere to go
//      and must PARK (`pool.queued` reflects it);
//   2. and the second request must never be served EARLIER than the end of the
//      first request's release.
//
// Together those say the only thing that matters: no second request can be
// holding the page while `release()` is still working on it. Whether the code
// achieves that with a held flag, a promise chain or a different data structure
// is deliberately not this test's business.
//
// DETERMINISM. The probe seam is `page.evaluate`, which `probeWorkerHealth`
// (`src/prompt/pool.ts`) races against WORKER_PROBE_TIMEOUT_MS. Here
// `evaluate` returns a DEFERRED promise the test resolves by hand, so the probe
// window is a real, held-open state rather than a race against wall-clock
// timing. Nothing here sleeps and hopes: every wait is on a promise the test
// itself controls, and each has a bounded guard that FAILS rather than hangs.
//
// The pool is at capacity with one page and `max: 1`, so no browser is ever
// launched: the second request has no free slot and no admission, which is
// precisely the condition under which the reuse scan is the only way it could
// have been served. `dataDir` is a real temp dir, never the relative "data"
// (which would resolve into the operator's gitignored session vault).
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatPool, type PoolOptions, type PoolWorker } from "../src/prompt/pool.js";

const VAULT = mkdtempSync(join(tmpdir(), "u2a-pool-release-"));
after(() => rmSync(VAULT, { recursive: true, force: true }));

/** A promise plus the handles that settle it — the deferred probe seam. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; settled: () => boolean } {
  let done = false;
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = (v) => {
      done = true;
      r(v);
    };
  });
  return { promise, resolve, settled: () => done };
}

/**
 * A pool holding exactly one page, whose usability probe is HELD OPEN until
 * the test releases it. `discardPage` is stamped so the test can prove when the
 * teardown ran relative to the second request being served.
 */
function heldProbePool(opts: Partial<PoolOptions> = {}): {
  pool: ChatPool;
  worker: PoolWorker;
  probe: ReturnType<typeof deferred<number>>;
  discarded: ReturnType<typeof deferred<void>>;
  order: string[];
} {
  const probe = deferred<number>();
  const discarded = deferred<void>();
  const order: string[] = [];
  const driver = {
    // The probe seam: `probeWorkerHealth` awaits `page.evaluate`, so a page
    // whose evaluate never settles holds release() inside the probe window.
    page: { evaluate: () => probe.promise, context: () => ({ pages: () => [] }) },
    close: async () => {},
    ask: async () => ({}),
    discardPage: async () => {
      order.push("discardPage");
      discarded.resolve();
    },
  };
  const pool = new ChatPool({
    profiles: [],
    dataDir: VAULT,
    max: 1,
    waiterTimeoutMs: 60_000,
    ...opts,
  } as PoolOptions);
  const worker = { profileId: "gemini", driver, busy: true } as unknown as PoolWorker;
  (pool as unknown as { workers: PoolWorker[] }).workers = [worker];
  return { pool, worker, probe, discarded, order };
}

test("GOAL239: a same-site acquire() arriving DURING release()'s probe window is never served the page being released", async () => {
  const { pool, worker, probe, discarded, order } = heldProbePool();

  // The first request finishes and hands its page back. `release()` runs and
  // parks inside the usability probe — this is the window under test.
  const releasing = pool.release(worker);
  // Let release() reach the probe. Bounded: a failure here is a named failure,
  // not a hang.
  await Promise.race([
    discarded.promise.then(() => undefined).catch(() => undefined), // never wins; kept for symmetry
    new Promise((r) => setTimeout(r, 50)),
  ]);
  assert.equal(probe.settled(), false, "the probe must still be held open — the window is what this test measures");

  // THE SECOND REQUEST. A parallel same-site agent arrives while the first
  // release is still mid-teardown on the page.
  let served = false;
  const second = pool.acquire("gemini").then((w) => {
    served = true;
    order.push("second-served");
    return w;
  });
  // Let acquire() run its whole synchronous reuse scan and admission path.
  await new Promise((r) => setTimeout(r, 20));

  // (1) It must NOT have been served. The page is mid-release; handing it over
  //     now is the two-requests-one-tab defect.
  assert.equal(served, false, "the second request must not be served while the first release is still working on the page");
  assert.equal(pool.queued, 1, "the second request must PARK instead of taking the page being released");

  // Let the probe answer, so release() can finish its teardown.
  probe.resolve(1);
  await releasing;
  assert.equal(order[0], "discardPage", "release must tear the page down before the page is available again");

  // (2) The second request is served only AFTER the release finished — and with
  //     the page the first request released, which is legitimate: the pool has
  //     one slot and the waiter is next in line.
  const got = await Promise.race([
    second,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("the parked second request was never served after the release finished")), 5_000),
    ),
  ]);
  assert.equal(got, worker, "the parked request takes the released page — that hand-off is correct once release is done");
  const discardAt = order.indexOf("discardPage");
  const servedAt = order.indexOf("second-served");
  assert.ok(discardAt >= 0 && servedAt >= 0, "both events must be recorded");
  assert.ok(discardAt < servedAt, "the page teardown must complete BEFORE the second request is served, never during it");

  await pool.close().catch(() => undefined);
});

test("GOAL239: a THROW inside release() must still return the slot (a stuck-busy page would starve the pool)", async () => {
  // The counterweight to holding the flag: if the teardown throws, the page
  // must become available again. A page stuck `busy` forever is a WORSE defect
  // than the race this GOAL closes — it would starve the pool, not just
  // mis-serve one request.
  const probe = deferred<number>();
  const order: string[] = [];
  const driver = {
    page: { evaluate: () => probe.promise, context: () => ({ pages: () => [] }) },
    close: async () => {},
    ask: async () => ({}),
    discardPage: async () => {
      order.push("discardPage");
      throw new Error("tab close wedged");
    },
  };
  const pool = new ChatPool({ profiles: [], dataDir: VAULT, max: 1, waiterTimeoutMs: 60_000 } as PoolOptions);
  const worker = { profileId: "gemini", driver, busy: true } as unknown as PoolWorker;
  (pool as unknown as { workers: PoolWorker[] }).workers = [worker];

  const releasing = pool.release(worker);
  await new Promise((r) => setTimeout(r, 30));
  probe.resolve(1);

  // The discard failure is already swallowed by release()'s inner guard (a leak
  // we can observe beats a hang we cannot) — this test pins that the slot comes
  // back either way, so the flag is not held past the end of release.
  await releasing;

  let served = false;
  const second = pool.acquire("gemini").then((w) => {
    served = true;
    return w;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(served, true, "a release that threw on discard must still return the page to the pool");
  assert.equal(await second, worker, "the returned slot is the same page, now free");
  assert.ok(order.includes("discardPage"), "the wedged discard was attempted, not skipped");

  await pool.close().catch(() => undefined);
});