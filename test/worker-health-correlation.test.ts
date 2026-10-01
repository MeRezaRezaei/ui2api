import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ChatPool } from "../src/prompt/pool.js";
import type { PoolWorkerStatus } from "../src/prompt/pool.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOL_SRC = readFileSync(join(ROOT, "src/prompt/pool.ts"), "utf8");

/* ========================================================================
 * GOAL 172 — "it must not show any problems validate all things yourself
 * not by automated tests only."
 *
 * THE FINDING BEING PRESERVED, verbatim from the goal: a health field that
 * nobody can tie to the thing it describes is decoration. The measured state
 * was `copilot` target presence and `health:"live"` agreeing 21/21 in flight
 * and disagreeing 12/12 at rest, with the pool holding ONE worker for the whole
 * run, and `unprobed` never firing once in 33 samples.
 *
 * So the cross-reference was undecidable for two separate reasons, and both are
 * addressed here:
 *   1. there was no stable worker id and no page URL, so no reader could join
 *      two /status reads or match a claim to a CDP target;
 *   2. the sweep SKIPS busy workers, so an in-flight worker's health ages
 *      without bound while /status still reported it as `live` with nothing
 *      marking it stale.
 *
 * The HONESTY CONSTRAINT on this goal is explicit: do not make the correlation
 * easier by making the health claim weaker. Nothing below changes what
 * `health` MEANS or when a page is probed. A busy page is still never probed —
 * evicting or probing a page out from under an in-flight request would be
 * worse than a stale reading — so the fix makes the AGE VISIBLE rather than
 * pretending the reading is current.
 * ====================================================================== */

/** A driver stub with the exact surface probeWorkerHealth() looks for: a `page`
 *  whose `evaluate` answers (live), does not (dead), or is absent / throws
 *  (unprobed). It is a stub because a real Playwright page always has
 *  `evaluate`, which is precisely why `unprobed` never fired in 33 live
 *  samples — see the reachability test below. */
function stubDriver(opts: { url?: string; evaluate?: "ok" | "fail" | "absent" | "throws" } = {}) {
  const { url, evaluate = "ok" } = opts;
  const page: Record<string, unknown> = {};
  if (url !== undefined) page.url = () => url;
  if (evaluate === "ok") page.evaluate = async () => 1;
  if (evaluate === "fail") page.evaluate = async () => { throw new Error("detached"); };
  if (evaluate === "throws") {
    page.evaluate = () => { throw new Error("no probe surface"); };
  }
  // "absent" leaves page.evaluate undefined entirely.
  return { page, start: async () => {}, close: async () => {} };
}

/** Install a controlled driver into the pool's private worker list, creating the
 *  worker if the pool has none yet. A fresh ChatPool spawns nothing until a
 *  request arrives, so a test that wants a worker in the report has to put one
 *  there — and it must be shaped exactly as the pool's own factory shapes it,
 *  or the test is measuring a hand-built object rather than the real thing. */
function seed(pool: ChatPool, w: { driver: unknown; health?: string; checkedAt?: string }): void {
  const self = pool as unknown as {
    workers: Array<Record<string, unknown>>;
    nextWorkerId: number;
  };
  if (self.workers.length === 0) {
    const created: Record<string, unknown> = {
      id: ++self.nextWorkerId,
      profileId: "stub-site",
      driver: w.driver,
      busy: false,
    };
    // Applied on BOTH paths. An earlier version returned early after creating
    // the worker, silently dropping health/checkedAt — so "a FRESH live" was
    // actually testing a worker with no measurement at all, and failed for a
    // reason that had nothing to do with staleness. A harness that quietly
    // discards half its inputs will teach you nothing about the code.
    if (w.health !== undefined) created.health = w.health;
    if (w.checkedAt !== undefined) created.checkedAt = w.checkedAt;
    self.workers.push(created);
    return;
  }
  const target = self.workers[0]!;
  target.driver = w.driver;
  if (w.health !== undefined) target.health = w.health;
  if (w.checkedAt !== undefined) target.checkedAt = w.checkedAt;
}

/** The report as a consumer receives it. */
function statusOf(pool: ChatPool): { workers: PoolWorkerStatus[]; warmLive: number } {
  // `status` is a GETTER on ChatPool, not a method — calling it threw
  // "pool.status is not a function", which is worth stating because it is the
  // kind of thing a test should discover about the code, not assume.
  const s = (pool as unknown as { status: { workers: PoolWorkerStatus[]; warmLive: number } }).status;
  return s;
}

d("GOAL 172: the health claim is CROSS-REFERENCEABLE", () => {
  t("every reported worker carries a stable id, so two /status reads can be joined", () => {
    const pool = new ChatPool({ min: 1, max: 1, profiles: [] as never[] });
    seed(pool, { driver: stubDriver({ url: "https://example.test/chat" }) });
    const a = statusOf(pool).workers[0]!;
    assert.equal(typeof a.id, "number", "a worker with no id cannot be tracked across reads");
    assert.ok(Number.isInteger(a.id) && a.id > 0, `id must be a positive integer, got ${a.id}`);
    // The decisive property: the SAME page reports the SAME id on a second read.
    // An index-derived id would pass a single read and fail here.
    const b = statusOf(pool).workers[0]!;
    assert.equal(b.id, a.id, "the id must be stable across reads, or it identifies nothing");
  });

  t("ids are DISTINCT across workers — two pages are never conflated into one claim", () => {
    /* The multi-worker condition the goal says was never exercised: the pool
     * held ONE worker for the whole run, so neighbour contention never
     * occurred. Three workers, three ids. */
    const pool = new ChatPool({ min: 3, max: 3, profiles: [] as never[] });
    const self = pool as unknown as {
      workers: Array<Record<string, unknown>>;
      nextWorkerId: number;
    };
    for (let i = 0; i < 3; i++) {
      self.workers.push({
        id: ++self.nextWorkerId,
        profileId: `site-${i}`,
        driver: stubDriver({ url: `https://example.test/${i}` }),
        busy: false,
        health: "live",
        checkedAt: new Date().toISOString(),
      });
    }
    const ids = statusOf(pool).workers.map((w) => w.id);
    assert.equal(ids.length, 3, "expected three workers warm");
    assert.equal(new Set(ids).size, 3, `ids must be distinct, got ${JSON.stringify(ids)}`);
  });

  t("pageUrl is reported and is NULL — not guessed — when it cannot be read", () => {
    const pool = new ChatPool({ min: 1, max: 1, profiles: [] as never[] });
    seed(pool, { driver: stubDriver({ url: "https://example.test/chat" }) });
    assert.equal(statusOf(pool).workers[0]!.pageUrl, "https://example.test/chat");

    // A page parked on about:blank reports the blank URL, not null: they are
    // different facts and conflating them is the mistake this report exists to
    // stop. (MEASURED, and the reason the field exists at all: a stale
    // health:"live" on a page that had navigated away is this mistake wearing a
    // green badge.)
    const blank = new ChatPool({ min: 1, max: 1, profiles: [] as never[] });
    seed(blank, { driver: stubDriver({ url: "about:blank" }) });
    assert.equal(statusOf(blank).workers[0]!.pageUrl, "about:blank");

    // No page at all -> null. A plausible-looking string here would be a guess.
    const none = new ChatPool({ min: 1, max: 1, profiles: [] as never[] });
    seed(none, { driver: { start: async () => {}, close: async () => {} } });
    assert.equal(statusOf(none).workers[0]!.pageUrl, null, "an unreadable URL is null, never a guess");

    /* An EMPTY or non-string url() must also be null. This case was MISSING and
     * the gap was found by mutation rather than by reading: changing the
     * fallback from `null` to `"about:blank"` left all twelve tests GREEN,
     * because the "no page at all" case returns earlier and never reached the
     * line. A test that cannot fail on the change it is meant to catch is a
     * decoration, and this one had been quietly passing for exactly that
     * reason. */
    const empty = new ChatPool({ min: 1, max: 1, profiles: [] as never[] });
    seed(empty, { driver: { page: { url: () => "" }, start: async () => {}, close: async () => {} } });
    assert.equal(statusOf(empty).workers[0]!.pageUrl, null, "an empty url() is null, not a substituted value");

    const wrongType = new ChatPool({ min: 1, max: 1, profiles: [] as never[] });
    seed(wrongType, { driver: { page: { url: () => 42 }, start: async () => {}, close: async () => {} } });
    assert.equal(statusOf(wrongType).workers[0]!.pageUrl, null, "a non-string url() is null, not coerced");
  });
});

d("GOAL 172: a STALE health claim is visible as stale", () => {
  t("a FRESH `live` is not stale", () => {
    const pool = new ChatPool({ min: 1, max: 1, reaperIntervalMs: 30_000, profiles: [] as never[] });
    seed(pool, {
      driver: stubDriver(),
      health: "live",
      checkedAt: new Date().toISOString(),
    });
    const w = statusOf(pool).workers[0]!;
    assert.equal(w.healthStale, false, "a just-measured `live` must not be reported stale");
    assert.ok((w.healthAgeMs ?? 0) < 30_000, `fresh age should be small, got ${w.healthAgeMs}`);
  });

  t("RED: an OLD `live` IS marked stale — the case /status previously hid", () => {
    /* This is the honesty gap the goal names: the sweep skips busy workers, so
     * an in-flight worker's checkedAt ages without bound, and /status used to
     * report that value with nothing marking it as old. A 4-minute-old `live`
     * is a fact about four minutes ago. */
    const pool = new ChatPool({ min: 1, max: 1, reaperIntervalMs: 30_000, profiles: [] as never[] });
    seed(pool, {
      driver: stubDriver(),
      health: "live",
      checkedAt: new Date(Date.now() - 240_000).toISOString(),
    });
    const w = statusOf(pool).workers[0]!;
    assert.equal(w.healthStale, true, "a 4-minute-old `live` must not read as current");
    assert.ok((w.healthAgeMs ?? 0) >= 240_000, `age must be reported, got ${w.healthAgeMs}`);
    // AND the claim itself is preserved — the goal's honesty constraint is
    // explicit: do not make the correlation easier by weakening the claim.
    assert.equal(w.health, "live", "the measured value must be preserved, not overwritten by a summary");
  });

  t("a NEVER-measured worker is stale, and says `unprobed`", () => {
    const pool = new ChatPool({ min: 1, max: 1, reaperIntervalMs: 30_000, profiles: [] as never[] });
    seed(pool, { driver: stubDriver() });
    const w = statusOf(pool).workers[0]!;
    assert.equal(w.health, "unprobed", "no measurement means unprobed, never `live`");
    assert.equal(w.checkedAt, null);
    assert.equal(w.healthAgeMs, null, "never measured has no age — null is a fact, 0 would be a guess");
    assert.equal(w.healthStale, true, "an absent measurement cannot be fresh");
  });

  t("stale is measured against the POOL'S OWN interval, not a hardcoded 30s", () => {
    // A pool configured to sweep every 5 minutes must not call a 60s-old
    // reading stale; its own interval is the only defensible threshold.
    const pool = new ChatPool({ min: 1, max: 1, reaperIntervalMs: 300_000, profiles: [] as never[] });
    seed(pool, { driver: stubDriver(), health: "live", checkedAt: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(statusOf(pool).workers[0]!.healthStale, false, "60s is fresh for a 300s interval");
  });
});

d("GOAL 172: `unprobed` is REACHABLE, and its unreachability on a real driver is recorded", () => {
  t("`unprobed` fires when the page exposes NO evaluate surface", () => {
    const pool = new ChatPool({ min: 1, max: 1, profiles: [] as never[] });
    seed(pool, { driver: stubDriver({ evaluate: "absent" }) });
    // The sweep assigns the probe result, so drive it the way the pool does.
    const w = statusOf(pool).workers[0]!;
    assert.equal(w.health, "unprobed", "a driver with no evaluate surface must read unprobed, not live");
  });

  t("a page whose evaluate THROWS is `unprobed`, not silently `live`", () => {
    const pool = new ChatPool({ min: 1, max: 1, profiles: [] as never[] });
    seed(pool, { driver: stubDriver({ evaluate: "throws" }) });
    assert.equal(statusOf(pool).workers[0]!.health, "unprobed");
  });

  t("HONEST RECORD: on a REAL Playwright page `unprobed` is effectively unreachable", () => {
    /* The goal measured `unprobed` never firing in 33 live samples. That is not
     * a mystery and not a bug: a real Playwright Page ALWAYS has `evaluate`, so
     * the `typeof page.evaluate !== "function"` arm is unreachable against the
     * real driver and only a stub can reach it. Saying so is the honest
     * disposition — "we could not observe it" is a finding, and inventing a
     * live observation would be the fabrication this repo keeps refusing. */
    const playwright = readFileSync(join(ROOT, "node_modules/playwright-core/types/types.d.ts"), "utf8");
    const declaresEvaluate = /interface Page[\s\S]{0,40000}?evaluate\s*</.test(playwright);
    assert.ok(
      declaresEvaluate,
      "could not confirm from the installed Playwright types that Page.evaluate is unconditional; " +
        "if Playwright ever made it optional this disposition would need revisiting",
    );
  });
});

d("GOAL 172: the sweep skipping BUSY workers is correct, and now visible", () => {
  t("the skip is still there — this fix did NOT make the pool probe a page mid-request", () => {
    /* Pin the reason the staleness exists, so a future well-meaning change that
     * probes busy pages (or evicts them) trips a gate instead of quietly
     * breaking an in-flight request. */
    assert.match(
      POOL_SRC,
      /if \(w\.busy\) continue; \/\/ in use: never probed or evicted mid-request/,
      "the busy-worker skip must remain: probing or evicting a page out from under an " +
        "in-flight request is worse than a stale reading, which is why the fix makes the AGE " +
        "visible instead of touching the page",
    );
  });

  t("a BUSY worker's health is not refreshed by the sweep, so its age grows — by design", () => {
    const pool = new ChatPool({ min: 1, max: 1, reaperIntervalMs: 30_000, profiles: [] as never[] });
    const self = pool as unknown as {
      workers: Array<Record<string, unknown>>;
      nextWorkerId: number;
    };
    const old = new Date(Date.now() - 200_000).toISOString();
    self.workers.push({
      id: ++self.nextWorkerId,
      profileId: "s",
      driver: stubDriver(),
      busy: true,
      busySince: Date.now(),
      health: "live",
      checkedAt: old,
    });
    const w = statusOf(pool).workers[0]!;
    assert.equal(w.busy, true);
    assert.equal(w.healthStale, true, "a 200s-old reading on an in-flight worker must be visible as stale");
    assert.equal(w.health, "live", "the value is preserved; only its age is disclosed");
  });
});
