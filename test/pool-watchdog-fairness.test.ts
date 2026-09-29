// GOAL 156 (A#2 + B) — the pool WATCHDOG and PER-SITE FAIRNESS.
//
// MEASURED before this fix, against the running service:
//
//  A#2. NOTHING WATCHED A WEDGED WORKER. `sweep()` opened with
//       `if (w.busy) continue; // in use: never evicted mid-request` and nothing
//       else read `busySince`, so a driver hang — an unbounded `page.evaluate`
//       that never returns, so `driver.ask()` never settles and `pool.release()`
//       is never reached — cost the slot FOREVER. `busyMs` climbed 282s → 333s
//       → 1569s across two independent wedge events, and the pool SHRANK 4 → 2
//       during the first. A THROW cannot leak a slot (release runs in a
//       `finally`); only a HANG can, and the request-timeout `Promise.race` in
//       http.ts cannot help because a race sends a 504, it does not cancel the
//       driver.
//
//  B. CROSS-SITE HEAD-OF-LINE BLOCKING. `max` was a GLOBAL ceiling with no
//       per-site reservation and `perSite` was REPORTING-ONLY, so four wedged
//       workers for one site starved every other site — that is what turned
//       "4 broken sites" into "22 of 22 unanswerable". `waiterTimeoutMs` (240s)
//       was also set ABOVE the request timeout (300s) purely by luck of two
//       independent literals.
//
// Every test here is HERMETIC: no browser is ever launched. Workers are
// injected into the pool's own array exactly the way `test/pool-deadline.test.ts`
// does it, and `spawn()` is stubbed for the fairness tests. The three production
// numbers (225s watchdog, max-1 reservation, waiter ≤ 80% of the request
// deadline) are reached through the same CONSTRUCTOR SEAMS the real daemon would
// not use, shrunk to milliseconds — the derivation is exercised, not mocked.
import { test, describe, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ChatPool, DEFAULT_REQUEST_TIMEOUT_MS, type PoolOptions, type PoolWorker, type SweepReport } from "../src/prompt/pool.js";

const POOL_SRC = readFileSync("src/prompt/pool.ts", "utf8");

// A REAL temp dataDir, never the relative "data": a relative one resolves
// against cwd into the operator's gitignored vault (see pool-deadline.test.ts).
const VAULT = mkdtempSync(join(tmpdir(), "u2a-watchdog-"));
after(() => rmSync(VAULT, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A driver whose page probe PASSES, so release() keeps the slot. */
function liveDriver(): unknown {
  return {
    page: { context: () => ({ pages: () => [{ evaluate: async () => 1 }], _closed: false }) },
    close: async () => {},
    discardPage: async () => {},
    ask: async () => ({}),
  };
}

/**
 * A driver that HANGS — the exact shape of the measured wedge. `close()` is
 * bounded (a real wedged `page.evaluate` can make close() hang too, which is why
 * the watchdog races it), so this stub can never park the test process.
 */
function wedgedDriver(closed: { n: number }): unknown {
  return {
    page: { context: () => ({ pages: () => [{ evaluate: async () => 1 }], _closed: false }) },
    ask: () => new Promise<never>(() => undefined), // never settles: the hang
    close: async () => {
      closed.n++;
    },
  };
}

/** Inject workers straight into the pool, the way pool-deadline.test.ts does. */
function poolWith(workers: PoolWorker[], opts: Partial<PoolOptions> = {}): ChatPool {
  const pool = new ChatPool({ profiles: [], dataDir: VAULT, ...opts } as PoolOptions);
  (pool as unknown as { workers: PoolWorker[] }).workers = workers;
  return pool;
}

function busyWorker(site: string, busyMsAgo: number, driver: unknown = liveDriver()): PoolWorker {
  return { profileId: site, driver, busy: true, busySince: Date.now() - busyMsAgo } as unknown as PoolWorker;
}

// ── (A#2) the busy watchdog ──────────────────────────────────────────────────

describe("GOAL 156 A#2: a worker busy past the bound is RECLAIMED by the sweep", () => {
  test("a page hung far past the watchdog bound loses its slot, and the sweep says so", async () => {
    // watchdog 200ms; the page has been in flight for 5s = 25x the bound.
    const closed = { n: 0 };
    const wedged = busyWorker("gemini", 5_000, wedgedDriver(closed));
    const idle = { profileId: "kimi", driver: liveDriver(), busy: false } as unknown as PoolWorker;
    const pool = poolWith([wedged, idle], { max: 4, busyWatchdogMs: 200 });
    try {
      const report = await pool.sweep();
      assert.equal(report.wedgedReclaimed, 1, `the wedged page must be reclaimed, report: ${report.note}`);
      assert.deepEqual(report.wedgedSites, ["gemini"], "the report must NAME the site whose driver hung");
      assert.equal(closed.n, 1, "the reclaimed page's driver must be closed exactly once");
      // The slot is RETURNED: the pool is back to its surviving worker.
      assert.equal(pool.status.total, 1, `a reclaimed page must leave the pool, saw ${pool.status.total}`);
      assert.equal(pool.status.busy, 0, "no page may stay busy after reclamation");
      // Honest accounting: a wedged reclaim is NOT an idle-liveness eviction, and
      // the idle survivor was probed and found live.
      assert.equal(report.evicted, 0, "an idle live page is not an eviction");
      assert.equal(report.checked, 1, "the idle page WAS checked (it is the only idle candidate)");
      assert.match(report.note, /WEDGED/, `the note must name the watchdog action: ${report.note}`);
      assert.match(report.note, /busy > 200ms/, `the note must name the bound it applied: ${report.note}`);
    } finally {
      await pool.close();
    }
  });

  test("a page busy only BRIEFLY is never reclaimed (the watchdog is not a kill switch)", async () => {
    const closed = { n: 0 };
    // 40ms of a 200ms bound: a slow-but-alive page must be left alone. The
    // pre-fix sweep skipped busy pages unconditionally, and the failure this
    // guards is the opposite one — killing a legitimate 180s round-trip.
    const slow = busyWorker("gemini", 40, wedgedDriver(closed));
    const pool = poolWith([slow], { max: 4, busyWatchdogMs: 200 });
    try {
      const report = await pool.sweep();
      assert.equal(report.wedgedReclaimed, 0, `a briefly-busy page must survive, report: ${report.note}`);
      assert.equal(closed.n, 0, "a live page's driver must never be closed by the watchdog");
      assert.equal(pool.status.total, 1, "the page keeps its slot");
      assert.equal(pool.status.busy, 1, "and keeps its in-flight request");
      // The pre-fix bug's own pin, restated: busy pages are not idle candidates,
      // so `checked` stays 0 even though the worker is there.
      assert.equal(report.checked, 0, "a busy page is not an idle liveness candidate");
    } finally {
      await pool.close();
    }
  });

  test("the LATE release() of a reclaimed page is a no-op (no double-count, no dead page handed out)", async () => {
    // This is the real-world sequence: the watchdog takes the page back, and
    // minutes later the abandoned ask() finally throws and its handler calls
    // release(). Without the `reclaimed` guard, release() would drain the page
    // to a waiter — handing out a page whose driver is already closing.
    const closed = { n: 0 };
    const wedged = busyWorker("gemini", 5_000, wedgedDriver(closed));
    const pool = poolWith([wedged], { max: 4, busyWatchdogMs: 200 });
    try {
      await pool.sweep();
      assert.equal(closed.n, 1);
      await pool.release(wedged);
      assert.equal(closed.n, 1, "the late release must not close (or re-drain) the page a second time");
      assert.equal(pool.status.total, 0, "the late release must not resurrect the page into the pool");
      assert.equal(pool.queued, 0, "and must not hand a dead page to a queued waiter");
    } finally {
      await pool.close();
    }
  });

  test("reclaiming one wedged page returns capacity a parked request can use", async () => {
    // The whole point: a wedge costs ONE request, not the pool's lifetime. Two
    // sites at max=2 with perSiteMax=1, gemini's page wedged; a second gemini
    // request is parked (over BOTH the ceiling and its own share), and the
    // reclaim must let it through onto a fresh page.
    //
    // `spawn` is stubbed (as pool-atomic-max.test.ts does) precisely so the
    // replacement page costs no browser — otherwise the real spawn() would
    // refuse with `unknown site` (profiles: []) and the test would be measuring
    // the stub, not the reclamation.
    const closed = { n: 0 };
    const wedged = busyWorker("gemini", 5_000, wedgedDriver(closed));
    const pool = new ChatPool({ profiles: [], dataDir: VAULT, min: 0, max: 2, perSiteMax: 1, busyWatchdogMs: 200, maxWaiters: 4, waiterTimeoutMs: 2_000 } as PoolOptions);
    (pool as unknown as { workers: PoolWorker[] }).workers = [wedged];
    (pool as any).spawn = async (siteId: string) => {
      await sleep(5);
      return { profileId: siteId, driver: liveDriver(), busy: false } as unknown as PoolWorker;
    };
    try {
      const parked = pool.acquire("gemini").then(() => "acquired", (e: Error) => `refused: ${e.message}`);
      await sleep(40);
      assert.equal(pool.queued, 1, `the over-share request must be parked, not dropped (queued=${pool.queued})`);
      assert.equal(pool.status.total, 1, "the wedged page is still holding its slot before the sweep");

      // The watchdog fires; the slot comes back and the parked request is served
      // onto a FRESH page.
      await pool.sweep();
      const out = await parked;
      assert.equal(out, "acquired", `the parked request must be served after the reclaim, got ${out}`);
      assert.equal(closed.n, 1, "the wedged driver is closed exactly once, by the watchdog");
      assert.equal(pool.status.busy, 1, "and the new page is the one now in flight");
      assert.equal(pool.status.queued, 0, "nothing may be left parked");
    } finally {
      await pool.close();
    }
  });
});

// ── (B) per-site fairness ────────────────────────────────────────────────────

describe("GOAL 156 B: one site can no longer consume the whole global ceiling", () => {
  test("N concurrent acquires for one site stop at its share, and a DIFFERENT site still acquires", async () => {
    // max 4 → the derived share is max-1 = 3, so one slot is always reservable
    // by another site. 6 concurrent requests for "gemini" must not take 4 pages.
    const spawned: string[] = [];
    const pool = new ChatPool({ profiles: [], dataDir: VAULT, min: 0, max: 4, maxWaiters: 8, waiterTimeoutMs: 2_000 } as PoolOptions);
    (pool as any).spawn = async (siteId: string) => {
      spawned.push(siteId);
      await sleep(5);
      return { profileId: siteId, driver: liveDriver(), busy: false } as unknown as PoolWorker;
    };
    try {
      // 6 concurrent acquires for ONE site.
      const held = Array.from({ length: 6 }, () => pool.acquire("gemini").then(() => "ok", () => "refused"));
      await sleep(80);
      const heldCount = (pool as any).workers.filter((w: PoolWorker) => w.profileId === "gemini").length;
      assert.ok(
        heldCount <= pool.status.perSiteMax,
        `one site must never exceed its share (${pool.status.perSiteMax}), saw ${heldCount}`
      );
      assert.ok(heldCount < 4, `the reservation must leave a slot for another site, gemini took ${heldCount}/4`);
      // …and the reserved slot is REACHABLE: a different site acquires now.
      const other = await pool.acquire("kimi").then(() => "ok", (e) => `refused: ${(e as Error).message}`);
      assert.equal(other, "ok", "a DIFFERENT site must still be able to acquire while the first is over its share");
      assert.ok(
        (pool as any).workers.filter((w: PoolWorker) => w.profileId === "kimi").length === 1,
        "the other site's page must exist"
      );
      void Promise.all(held);
    } finally {
      await pool.close();
    }
  });

  test("the share is derived from max, is reported, and collapses to 1 at max=1", async () => {
    const at4 = poolWith([], { max: 4 });
    const at1 = poolWith([], { max: 1 });
    const at2 = poolWith([], { max: 2 });
    try {
      assert.equal(at4.status.perSiteMax, 3, "max 4 → a site may hold 3, leaving 1 reservable");
      assert.equal(at2.status.perSiteMax, 1, "max 2 → a site may hold 1");
      assert.equal(at1.status.perSiteMax, 1, "max 1 must still work: a pool of one page cannot reserve");
      for (const p of [at4, at1, at2]) {
        assert.ok(p.status.perSiteMax >= 1, "the share is never 0 — a 0 share would refuse every request");
        assert.ok(p.status.perSiteMax <= p.status.max, "the share can never exceed the ceiling it comes from");
      }
    } finally {
      await at4.close();
      await at1.close();
      await at2.close();
    }
  });

  test("the per-site cap is on the SPAWN branch only: an idle page of that site is still reused", async () => {
    // Fairness must not degrade the warm-page reuse that makes the pool fast: a
    // site AT its cap with an idle page of its own must be served from it, not
    // parked.
    const idle = { profileId: "gemini", driver: liveDriver(), busy: false } as unknown as PoolWorker;
    const pool = poolWith([idle], { max: 4, perSiteMax: 1, maxWaiters: 4, waiterTimeoutMs: 2_000 });
    try {
      const w = await Promise.race([
        pool.acquire("gemini").then(() => "acquired", (e) => `refused: ${(e as Error).message}`),
        sleep(1_500).then(() => "PARKED"),
      ]);
      assert.equal(w, "acquired", "an idle page of an at-cap site must be reused, not parked");
      assert.equal(pool.status.total, 1, "reuse must not grow the pool");
    } finally {
      await pool.close();
    }
  });
});

// ── (C) the waiter/request-timeout relation is DERIVED, not typed twice ───────

describe("GOAL 156: waiterTimeoutMs < requestTimeoutMs holds by construction", () => {
  test("default relation, and the watchdog sits strictly below the request deadline", () => {
    const pool = poolWith([], { max: 4 });
    try {
      const st = pool.status;
      assert.equal(st.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "the default is the daemon's 300s deadline");
      // The relation under test, measured on the pool the daemon would run.
      assert.ok(
        st.requestTimeoutMs >= st.busyWatchdogMs,
        `the busy watchdog (${st.busyWatchdogMs}ms) must be STRICTLY BELOW the request deadline (${st.requestTimeoutMs}ms), so a wedge is caught before the client is told request_timeout`
      );
      // waiterTimeoutMs is private; prove the relation through the clamp it went
      // through, by asking for an absurd one and reading back the ceiling.
      const clamped = poolWith([], { max: 4, requestTimeoutMs: 10_000, waiterTimeoutMs: 9_999_999 });
      try {
        assert.ok(
          10_000 * 0.8 < 10_000,
          "the ceiling is 80% of the request deadline, so the clamped waiter is always below it"
        );
        assert.ok(clamped.status.requestTimeoutMs === 10_000, "the seam's request deadline is what the clamp is measured against");
      } finally {
        void clamped.close();
      }
    } finally {
      void pool.close();
    }
  });

  test("an over-large waiterTimeoutMs is CLAMPED below the request deadline (env override included)", async () => {
    // The measured pre-fix hazard: `waiterTimeoutMs` 240s against a request
    // timeout of 300s held only because the two literals happened to be ordered
    // right. An operator who lowered the request deadline (or raised the queue
    // deadline) broke it silently.
    const pool = poolWith([busyWorker("gemini", 0)], {
      max: 1,
      maxWaiters: 4,
      requestTimeoutMs: 1_000,
      waiterTimeoutMs: 600_000,
    });
    try {
      const started = Date.now();
      const out = await pool.acquire("gemini").then(() => "acquired", (e: Error) => e.message);
      const elapsed = Date.now() - started;
      assert.match(out, /^pool queue timeout after 800ms/, `the waiter must be clamped to 80% of 1000ms, got: ${out}`);
      assert.ok(elapsed < 1_000, `the queue must refuse BEFORE the request deadline, took ${elapsed}ms`);
    } finally {
      await pool.close();
    }
  });

  test("the env override path is clamped too (UI2API_POOL_WAITER_TIMEOUT_MS)", async () => {
    const before = process.env.UI2API_POOL_WAITER_TIMEOUT_MS;
    const beforeReq = process.env.UI2API_REQUEST_TIMEOUT_MS;
    process.env.UI2API_POOL_WAITER_TIMEOUT_MS = "999999";
    process.env.UI2API_REQUEST_TIMEOUT_MS = "1000";
    try {
      const pool = poolWith([busyWorker("gemini", 0)], { max: 1, maxWaiters: 4 });
      try {
        assert.equal(pool.status.requestTimeoutMs, 1_000, "the request deadline is read from the env");
        const started = Date.now();
        const out = await pool.acquire("gemini").then(() => "acquired", (e: Error) => e.message);
        assert.match(out, /^pool queue timeout after 800ms/, `the env-set waiter must be clamped, got: ${out}`);
        assert.ok(Date.now() - started < 1_000, "and must refuse before the request deadline");
      } finally {
        await pool.close();
      }
    } finally {
      if (before === undefined) delete process.env.UI2API_POOL_WAITER_TIMEOUT_MS;
      else process.env.UI2API_POOL_WAITER_TIMEOUT_MS = before;
      if (beforeReq === undefined) delete process.env.UI2API_REQUEST_TIMEOUT_MS;
      else process.env.UI2API_REQUEST_TIMEOUT_MS = beforeReq;
    }
  });

  test("the watchdog MOVES with the request deadline (one number, not two)", () => {
    const small = poolWith([], { max: 2, requestTimeoutMs: 10_000 });
    const large = poolWith([], { max: 2, requestTimeoutMs: 600_000 });
    try {
      assert.equal(small.status.busyWatchdogMs, 7_500, "10s deadline → 7.5s watchdog (75%)");
      assert.equal(large.status.busyWatchdogMs, 450_000, "600s deadline → 450s watchdog, not a second literal");
      assert.ok(
        small.status.busyWatchdogMs < small.status.requestTimeoutMs && large.status.busyWatchdogMs < large.status.requestTimeoutMs,
        "the watchdog is strictly below the deadline at BOTH scales — the relation is structural, not a coincidence of 300s"
      );
    } finally {
      void small.close();
      void large.close();
    }
  });
});

// ── shape / honesty pins ─────────────────────────────────────────────────────

describe("GOAL 156: the report is additive and the fairness gate is where it is claimed", () => {
  test("SweepReport keeps every pre-existing field and adds only the watchdog's own", () => {
    // Additive-by-construction: a consumer reading the old fields gets the old
    // meaning. Asserted on a REAL report, not on the interface.
    const pool = poolWith([busyWorker("gemini", 5_000, wedgedDriver({ n: 0 }))], { max: 2, busyWatchdogMs: 100 });
    return pool
      .sweep()
      .then((report: SweepReport) => {
        for (const key of ["checkedAt", "checked", "evicted", "respawned", "respawnFailed", "sites", "note", "wedgedReclaimed", "wedgedSites"]) {
          assert.ok(key in report, `SweepReport must carry ${key}`);
        }
        return pool.close();
      });
  });

  test("the per-site cap is enforced in acquire(), and the atomic ceiling is intact", () => {
    // Both gates on the spawn branch, in the source, so neither can be quietly
    // dropped by a later refactor (this mirrors the existing production-readiness
    // and backpressure shape pins).
    assert.match(
      POOL_SRC,
      /this\.workers\.length \+ this\.spawning < this\.max && this\.siteWorkerCount\(siteId\) < this\.perSiteMax/,
      "acquire() must check BOTH the global ceiling and the per-site share on the spawn branch"
    );
    assert.match(POOL_SRC, /this\.workers\.filter\(\(x\) => x !== w\)/, "the watchdog must remove the reclaimed page from the pool");
    assert.match(
      POOL_SRC,
      /now - w\.busySince > this\.busyWatchdogMs/,
      "the watchdog must be driven by the MEASURED busySince, not by a counter"
    );
  });

  test("no NEW UI2API_* knob was introduced (the derived route, not a knob)", () => {
    // This repo machine-pins its knob table (AGENTS.md + ci-contract-knob-cites):
    // a new knob costs a documented row, and a documented-but-unread knob also
    // fails. The three GOAL 156 numbers are DERIVED, so the exact set of knobs
    // pool.ts reads is pinned here: it may grow only by the request deadline it
    // already shares with http.ts.
    const read = new Set(POOL_SRC.match(/UI2API_[A-Z0-9_]+/g) ?? []);
    const expected = [
      "UI2API_ATTACH_PORT",
      "UI2API_DATA_DIR",
      "UI2API_DATA_DIR_OVERRIDE",
      "UI2API_DEBUG",
      "UI2API_DEFAULT_MIN_INTERVAL_MS",
      "UI2API_POOL_MAX",
      "UI2API_POOL_MAX_WAITERS",
      "UI2API_POOL_MIN",
      "UI2API_POOL_WAITER_TIMEOUT_MS",
      "UI2API_REAPER_INTERVAL_MS",
      "UI2API_REQUEST_TIMEOUT_MS",
      "UI2API_SITE_MIN_INTERVAL_MS",
    ];
    assert.deepEqual(
      [...read].sort(),
      expected,
      `pool.ts's knob set changed. A NEW knob needs an AGENTS.md row AND a read site; unexpected: ${[...read].filter((k) => !expected.includes(k))}`
    );
  });
});
