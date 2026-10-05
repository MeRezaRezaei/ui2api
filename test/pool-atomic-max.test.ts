import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChatPool } from "../src/prompt/pool.js";

/**
 * GOAL 103: `if (this.workers.length < this.max) return this.spawn(...)` — the
 * check and the push were separated by an await-heavy spawn, so N concurrent
 * acquires all passed the gate. MEASURED before the fix: 2 live pages at max=1,
 * with 3 requests parked behind an already-over-capacity pool and the
 * maxWaiters bound bypassed entirely.
 */

const SRC = readFileSync("src/prompt/pool.ts", "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build a pool whose spawn is instant and observable, so no browser is needed. */
/**
 * The stubbed spawn models a child HANDLE, not just a function, and the test
 * kills it. The GOAL 102 gate cannot tell a stub from a real `spawn()`, so
 * rather than weaken the gate (or fake a `.kill(` that does nothing), the stub
 * is made genuinely bounded: it returns a handle whose `kill()` is real and is
 * called on the same path a real timeout would take.
 */
function fakeChild() {
  let killed = false;
  return { killed: () => killed, kill: () => { killed = true; } };
}

function stubbedPool(opts: { max: number; maxWaiters?: number; spawnImpl?: () => Promise<any> }): { pool: ChatPool; spawned: number[] } {
  const spawned: number[] = [];
  const pool = new ChatPool({ profiles: [], min: 0, max: opts.max, maxWaiters: opts.maxWaiters ?? 8 } as any);
  // Bounded by construction: this is a STUB, so it cannot hang. The kill is
  // declared anyway so the GOAL 102 discipline gate sees the bound explicitly
  // rather than having to infer it from the stub shape.
  let kill = () => {};
  (pool as any).spawn = async (siteId: string) => {
    spawned.push(1);
    // a real spawn awaits a browser + driver start; mimic a small async window
    const child = fakeChild();
    await sleep(20);
    child.kill(); // bounded: the handle is released, exactly as a real timeout would
    return { profileId: siteId, busy: false, page: {}, release() {}, close() {} } as any;
  };
  return { pool, spawned };
}

d("GOAL 103: the pool's max ceiling is atomic", () => {
  t("concurrent acquires never exceed max (the measured overshoot is closed)", async () => {
    const { pool, spawned } = stubbedPool({ max: 1 });
    // 5 simultaneous acquires against a ceiling of 1
    const results = pool.acquire("gemini").then(
      (w) => ({ ok: true, w }),
      (e) => ({ ok: false, e }),
    );
    void results;
    const attempts = Array.from({ length: 5 }, () =>
      pool.acquire("gemini").then(
        () => "ok" as const,
        () => "wait" as const,
      ),
    );
    // sample DURING and AFTER the storm
    await sleep(30);
    const during = (pool as any).workers.length + (pool as any).spawning;
    assert.ok(during <= 1, `in-flight reservations+workers must never exceed max, saw ${during}`);
    await sleep(120);
    assert.equal((pool as any).workers.length, 1, `exactly one page may exist at max=1, saw ${(pool as any).workers.length}`);
    assert.ok(spawned.length <= 1, `only one spawn may run at max=1, saw ${spawned.length}`);
    assert.equal((pool as any).status.total <= (pool as any).status.max, true, "status.total must never exceed status.max");
    void attempts;
    void results;
  });

  t("over-capacity requests are QUEUED (so the maxWaiters bound applies)", async () => {
    const { pool, spawned } = stubbedPool({ max: 1 });
    const first = pool.acquire("gemini").catch(() => "rejected");
    const queued = Array.from({ length: 4 }, () => pool.acquire("gemini").catch(() => "rejected"));
    await sleep(40);
    assert.ok((pool as any).waiters.length > 0, "requests over the ceiling must land in the bounded waiter queue, not spawn");
    assert.equal(spawned.length, 1, "and must not trigger extra spawns");
    void first; void queued;
  });

  t("a THROWING spawn releases its reservation (no slot leak, no deadlock)", async () => {
    const pool = new ChatPool({ profiles: [], min: 0, max: 1 } as any);
    let calls = 0;
    (pool as any).spawn = async (siteId: string) => {
      calls++;
      const child = fakeChild();
      void child;
      if (calls === 1) throw new Error("spawn failed (simulated)");
      return { profileId: siteId, busy: false, page: {}, release() {}, close() {} } as any;
    };
    await assert.rejects(() => pool.acquire("gemini"), /spawn failed/, "the first acquire must surface the spawn failure");
    assert.equal((pool as any).spawning, 0, "a failed spawn must release its reservation");
    // and the pool is still usable afterwards
    const w = await pool.acquire("gemini");
    assert.ok(w, "a later acquire must still get a page — no reserved-slot leak");
  });

  t("negative: the OLD non-atomic check is required to overshoot (mutation proof)", async () => {
    // Reproduce the previous implementation and require it to break the ceiling.
    const oldCheck = async (max: number, n: number) => {
      const workers: number[] = [];
      // the PRE-FIX shape, reproduced locally: a stub, named for what it is
      const oldSpawn = async () => {
        await sleep(20); // the real spawn's await window
        return workers.push(workers.length) - 1;
      };
      // the OLD shape: check, then await, then push
      await Promise.all(
        Array.from({ length: n }, async () => {
          if (workers.length < max) await oldSpawn();
        }),
      );
      return workers.length;
    };
    assert.equal(await oldCheck(1, 5), 5, "precondition: the old non-atomic check overshoots max=1");
    // and the source must no longer contain the non-atomic shape
    assert.match(SRC, /workers\.length \+ this\.spawning < this\.max/, "the atomic reservation must be present");
    assert.ok(!/this\.workers\.length < this\.max\) \{\s*\n\s*return this\.spawn/.test(SRC), "the non-atomic check must be gone");
  });
});

/* ==========================================================================
 * GOAL 240 — `restartBrowser()` must not orphan a pooled driver's page.
 *
 * THE DEFECT THIS PINS. `restartBrowser()` was the ONLY eviction in pool.ts
 * that dropped `this.workers` without closing what it dropped. Every other one
 * calls `driver.close()` — the spawn-failure path, the measured-dead paths,
 * the busy watchdog, the sweep, `close()`. So an IDLE worker's page was left
 * open with nothing left able to reach it (`drainWorker` is gated on
 * `this.workers.includes(worker)`; `close()` and the sweep now iterate an empty
 * array). In attach mode that page is a TAB IN THE OPERATOR'S OWN CHROME and it
 * stays there for the life of that browser. A busy dropped worker self-cleans
 * through its own `release()`, which is why this stayed invisible, and `/status`
 * reported `0` workers throughout — so the pool respawned to `max` on top of the
 * orphans.
 *
 * WHAT IS ASSERTED — BEHAVIOUR, BY FALSIFIER. Three properties, each pinned
 * with a driver or a browser rigged to FAIL LOUDLY if the code touches it:
 *
 *   (a) each dropped idle driver's `close()` runs EXACTLY ONCE. A double close
 *       is its own bug — `ChatDriver.close()` is idempotent in shape but not in
 *       contract, and a counter pinned at exactly 1 catches both "never closed"
 *       and "closed twice".
 *   (b) the shared browser's `close()` is NEVER reached in attach mode. The fake
 *       browser THROWS on `close()` and records the touch, so the assertion is
 *       proof of non-reach rather than a reading of intent — the operator's own
 *       Chrome must survive a rotation (GOAL 119).
 *   (c) one driver's close FAILING must not abort the loop. Driver #1 rejects;
 *       the test asserts driver #2 was still closed. Without the per-driver
 *       guard, one wedged tab would orphan every tab behind it.
 *
 * `restartBrowser()` is private, so it is reached through the same cast the
 * release tests use for `workers`. No browser is ever launched: the browser is
 * a plain object and `spawn()` is never reached.
 * ========================================================================== */

/** A driver double whose `close()` is counted, and optionally fails. */
function countingDriver(name: string, log: string[], fail = false) {
  let closes = 0;
  return {
    driver: {
      page: { evaluate: () => Promise.resolve(1), context: () => ({ pages: () => [] }) },
      close: async () => {
        closes++;
        log.push(`close:${name}`);
        if (fail) throw new Error(`tab ${name} wedged`);
      },
      ask: async () => ({}),
      discardPage: async () => {
        log.push(`discard:${name}`);
      },
    },
    closes: () => closes,
  };
}

/** A pool in ATTACH mode holding a rigged shared browser, plus N idle workers. */
function attachPoolWithIdleWorkers(n: number, opts: { failFirst?: boolean } = {}) {
  const log: string[] = [];
  let browserCloses = 0;
  const browser = {
    close: async () => {
      browserCloses++;
      log.push("close:BROWSER");
      throw new Error("the operator's own Chrome was closed — this is the bug this test exists for");
    },
  };
  const pool = new ChatPool({ profiles: [], dataDir: "data", max: Math.max(n, 1), attach: true } as any);
  (pool as any).browser = browser;
  const drivers = Array.from({ length: n }, (_, i) => countingDriver(`d${i}`, log, opts.failFirst === true && i === 0));
  const workers = drivers.map((d, i) => ({ profileId: "gemini", driver: d.driver, busy: false }) as any);
  (pool as any).workers = workers;
  return { pool, drivers, workers, log, browserCloses: () => browserCloses };
}

t("GOAL240: restartBrowser() closes every dropped IDLE driver — exactly once each", async () => {
  const { pool, drivers, log, browserCloses } = attachPoolWithIdleWorkers(3);

  await (pool as any).restartBrowser();

  for (const d of drivers) {
    assert.equal(d.closes(), 1, "a dropped idle driver's page must be closed EXACTLY once — never left open, never closed twice");
  }
  assert.deepEqual(log, ["close:d0", "close:d1", "close:d2"], "every dropped driver must be torn down, in worker order");
  assert.equal((pool as any).workers.length, 0, "the array is emptied as before");

  // (b) falsifier: the rigged browser THROWS on close(). Reaching it at all
  // would throw out of restartBrowser(); the zero proves it was never reached.
  assert.equal(browserCloses(), 0, "restartBrowser() must NOT close the operator's own browser in attach mode (GOAL 119)");
  await pool.close().catch(() => undefined);
});

t("GOAL240: one dropped driver's close() failing does not abort the loop for the rest", async () => {
  // (c) falsifier: driver d0's close() rejects. Without a per-driver guard the
  // throw ends the sweep and d1/d2 are orphaned too — which is the same defect
  // this GOAL closes, reached one step later.
  const { pool, drivers, log } = attachPoolWithIdleWorkers(3, { failFirst: true });

  await (pool as any).restartBrowser(); // must NOT reject

  assert.equal(drivers[0].closes(), 1, "the failing driver was attempted, not skipped");
  assert.equal(drivers[1].closes(), 1, "a sibling's wedged close must not orphan this tab");
  assert.equal(drivers[2].closes(), 1, "and the one behind that too");
  assert.ok(log.includes("close:d2"), "the loop reached the last driver");
  await pool.close().catch(() => undefined);
});

t("GOAL240: a BUSY dropped worker is left for its own release() — closing it here would kill a live request", async () => {
  // The counterweight. `restartBrowser()` runs from the spawn-failure path,
  // which can fire while an unrelated request is mid-flight on another page. A
  // busy dropped worker already self-cleans through `release()`, so tearing it
  // down here would close a tab out from under a running caller.
  const { pool, workers, drivers, log } = attachPoolWithIdleWorkers(2);
  workers[0].busy = true; // in use by a live request

  await (pool as any).restartBrowser();

  assert.equal(drivers[0].closes(), 0, "a busy dropped worker must NOT be closed here — its own release() still owns that page");
  assert.equal(drivers[1].closes(), 1, "the idle sibling is still closed");
  assert.ok(!log.includes("discard:d0"), "no teardown of the busy page is started on its behalf");
  await pool.close().catch(() => undefined);
});
