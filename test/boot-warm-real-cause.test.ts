/**
 * GOAL 178 — a failed boot warm carries its REAL cause, and the wedge catch that
 * keeps one dead site from wedging the whole service SURVIVES.
 *
 * THE RESIDUE GOAL 178 CLOSES, measured: `ChatPool.warm()` absorbed a per-page
 * failure with `try { … } catch { break }`. That is why `warm()` never rejected,
 * which is why the `.catch(() => undefined)` at `http.ts` was VACUOUS — three
 * lanes had been pointed at a swallow that could not swallow. GOAL 176 then made
 * the outcome visible on /status + /health, but composed `bootWarm.reason` from
 * the pool's state read AFTER the attempt (idle pages + the pool's own liveness
 * probe + attach mode). That is a measurement of the CONSEQUENCE and an
 * INFERENCE about the cause: a refused attach port, an EACCES on the Chrome
 * profile and a missing Chrome binary all produced the same sentence.
 *
 * THE TARGET STATE: `warm()` returns a `WarmOutcome` carrying the thrown
 * message verbatim, and `bootWarmBlock` reports THAT. The consequence
 * measurement is kept — it is still true — but it is no longer the only thing
 * being said.
 *
 * THE HAZARD, pinned here rather than argued about in a comment: that catch is
 * almost certainly load-bearing. Without it a boot warm marches on past one dead
 * site, and a single unbounded page open holding a pool slot is the GOAL-156
 * wedge class (measured: 4.77 hours, one wedged site, whole-service outage).
 * GOAL 178 changed only the DISCARD — the cause is captured, then the loop
 * breaks EXACTLY as before. `test("THE CATCH SURVIVES …")` is that pin, and the
 * mutation it was proved with is recorded in `.brain/verbatim-goals.md` GOAL 178.
 *
 * EVERYTHING HERE IS HERMETIC. The pool-level tests stub `spawn`, so no Chrome
 * is ever launched. The one daemon-level test uses `UI2API_ATTACH_PORT=1`
 * (nothing listens — the attach is refused before a page is opened, which is
 * also why it produces a REAL, non-generic cause to assert on).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatPool, type PoolOptions, type PoolWorker, type WarmOutcome } from "../src/prompt/pool.js";
import { startPromptd, bootWarmBlock, type BootWarmStatus } from "../src/prompt/http.js";
import { BUILTIN_PROFILES, type ChatSiteProfile } from "../src/profile/profile.js";

const PROFILES = [BUILTIN_PROFILES.deepseek].filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The one profile these pool-level tests warm. Real shape, real type. */
const GEMINI: ChatSiteProfile = { ...BUILTIN_PROFILES.gemini, id: "gemini" };

/** A driver whose page probe passes, so release() keeps the slot. */
function liveDriver(): unknown {
  return {
    page: { context: () => ({ pages: () => [{ evaluate: async () => 1 }], _closed: false }) },
    close: async () => {},
    discardPage: async () => {},
    ask: async () => ({}),
  };
}

/**
 * A pool over ONE configured site whose `spawn` is stubbed to reject with
 * `cause`. `warm()` therefore takes its REAL failure path with no browser: the
 * exact path whose discard this goal removes.
 */
function poolWhoseSpawnFails(cause: string, opts: Partial<PoolOptions> = {}): { pool: ChatPool; attempts: () => number } {
  let attempts = 0;
  const pool = new ChatPool({
    profiles: [GEMINI],
    dataDir: mkdtempSync(join(tmpdir(), "u2a-warmcause-")),
    min: 1,
    max: 4,
    ...opts,
  } as PoolOptions);
  (pool as unknown as { spawn: (s: string) => Promise<PoolWorker> }).spawn = async () => {
    attempts++;
    throw new Error(cause);
  };
  return { pool, attempts: () => attempts };
}

test("GOAL178: warm() returns the page-open cause as a NAMED code — not discarded, not verbatim", async () => {
  // A cause that no generic string would ever produce, so the assertion cannot
  // be satisfied by a paraphrase. EACCES on a 0700 profile is the measured class
  // this goal names.
  //
  // GOAL 240 changed the SHAPE, not the intent. GOAL 178's complaint was that the
  // pool DISCARDED the cause and reported a generic phrase; the cause is still
  // captured and still reaches the operator. What it is no longer is VERBATIM:
  // this outcome is served on /status + /health as `bootWarm.outcome.reason`,
  // and the message of a real page-open failure is an absolute path
  // (`EACCES: permission denied, open '/home/<user>/.config/ui2api-chrome/…'`).
  // The errno IS the diagnosis; the path never was.
  const { pool } = poolWhoseSpawnFails("EACCES: permission denied, open '/home/ui2api/.config/ui2api-chrome/Default'");
  try {
    const out: WarmOutcome = await pool.warm();
    assert.equal(out.site, "gemini", "the outcome names the site it actually targeted");
    assert.equal(out.failed, 1, "the one attempt that threw is counted as failed");
    assert.equal(out.opened, 0, "nothing opened, so nothing is claimed as opened");
    assert.ok(out.attempts >= 1, "an attempt was really made — this is not the no-target shortcut");
    assert.equal(
      out.reason,
      "(errno:EACCES)",
      "the cause is the errno the throw itself carried — the diagnosis, not a summary, not a guess",
    );
    assert.doesNotMatch(out.reason ?? "", /\/home\/ui2api/, "the absolute path the throw carried must not reach /status or /health");
    assert.doesNotMatch(out.reason ?? "", /permission denied/, "nor the sentence around it");
  } finally {
    await pool.close();
  }
});

test("GOAL178: THE CATCH SURVIVES — warm() still breaks on the first failure, and still never rejects", async () => {
  // THE HAZARD, as an executable pin. If the `break` were removed (or the catch
  // deleted outright), the loop would re-attempt the same dead site up to
  // `perSiteMax` times — re-issuing the identical failing page open, which is
  // the GOAL-156 wedge class this catch was left in place to prevent.
  //
  // max 4 → the derived per-site share is 3, so an un-broken loop would make
  // THREE spawn attempts. Exactly ONE is the assertion.
  const { pool, attempts } = poolWhoseSpawnFails("spawn refused: not the chrome owner", { min: 3, max: 4 });
  try {
    assert.equal(pool.status.perSiteMax, 3, "the ceiling a broken loop would have marched to is 3 here");
    // `warm()` must not reject even though every attempt throws: the daemon has
    // to start. This is the GOAL-176 best-effort property, unchanged.
    const out = await pool.warm().then(
      (o) => ({ ok: true as const, o }),
      (e) => ({ ok: false as const, e })
    );
    assert.equal(out.ok, true, `warm() must NEVER reject — it broke the chain of a dead site, got: ${String((out as { e?: unknown }).e)}`);
    assert.equal(attempts(), 1, `the catch must BREAK on the first failure — a loop without the break retries a dead site (saw ${attempts()} attempts)`);
    assert.equal((out as { o: WarmOutcome }).o.failed, 1);
    assert.equal((out as { o: WarmOutcome }).o.attempts, 1, "the outcome counts what was really attempted, not what the loop was allowed to try");
  } finally {
    await pool.close();
  }
});

test("GOAL178: a healthy warm reports opened pages and claims NO failure — the new field is not a failure-shaped constant", async () => {
  const pool = new ChatPool({
    profiles: [GEMINI],
    dataDir: mkdtempSync(join(tmpdir(), "u2a-warmok-")),
    min: 1,
    max: 4,
  } as PoolOptions);
  (pool as unknown as { spawn: (s: string) => Promise<PoolWorker> }).spawn = async (siteId: string) => {
    await sleep(1);
    return { profileId: siteId, driver: liveDriver(), busy: false } as unknown as PoolWorker;
  };
  try {
    const out = await pool.warm();
    assert.equal(out.opened, 1, "the page opened and released cleanly");
    assert.equal(out.failed, 0);
    assert.equal(out.reason, null, "no failure means NO cause is invented — null, never a generic string");
  } finally {
    await pool.close();
  }
});

test("GOAL178: a pool with NO configured profile measures nothing (site \"\", reason null) — not a fake failure", async () => {
  const pool = new ChatPool({ profiles: [], dataDir: mkdtempSync(join(tmpdir(), "u2a-warmempty-")), min: 1, max: 1 } as PoolOptions);
  try {
    const out = await pool.warm();
    assert.equal(out.site, "", "no target means no site, not the first profile invented");
    assert.equal(out.attempts, 0);
    assert.equal(out.reason, null, "nothing failed because nothing was tried");
  } finally {
    await pool.close();
  }
});

/* ---- the composition: bootWarmBlock must REPORT the cause, not infer one ---- */

type Wire = { ok?: boolean; bootWarm?: BootWarmStatus };

async function get(port: number, path: string): Promise<{ status: number; body: Wire }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as Wire };
}

test("GOAL178: a forced failure names its REAL cause on /status AND /health — a connection error, not 'cold pool'", async () => {
  const prevAttach = process.env.UI2API_ATTACH_PORT;
  // Nothing listens on port 1: the attach is refused immediately, so the warm
  // fails FAST with a REAL cause (ECONNREFUSED 127.0.0.1:1) and no browser is
  // ever spawned.
  process.env.UI2API_ATTACH_PORT = "1";
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-warmcause-wire-"));
  let svc: Awaited<ReturnType<typeof startPromptd>> | undefined;
  try {
    svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir, profiles: PROFILES });
    const status = await get(svc.port, "/status");
    assert.equal(status.status, 200, "a failed warm is a RECORD, never a refusal — the daemon still starts");
    const bw = status.body.bootWarm;
    assert.ok(bw, "/status carries a bootWarm block");
    assert.equal(bw.attempted, true);
    assert.equal(bw.ok, false);

    // THE GOAL: the pool's own outcome is on the wire, carrying the throw.
    assert.ok(bw.outcome, "bootWarm must carry the pool's WarmOutcome — the measurement, not a prose summary");
    assert.equal(bw.outcome.site, "deepseek");
    assert.equal(bw.outcome.failed, 1, "the refused attach is counted as the one failed page open");
    assert.ok(bw.outcome.attempts >= 1, "a real attempt was made");
    assert.match(
      bw.outcome.reason ?? "",
      /ECONNREFUSED|connect/i,
      `the REAL cause is the thrown connect error, got ${JSON.stringify(bw.outcome.reason)}`
    );

    // …and it is in the prose too, because that is what an operator reads.
    assert.match(bw.reason, /The pool reported the page open itself failed/, "the report names the measured cause");
    assert.match(bw.reason, /ECONNREFUSED|connect/i, "the real cause reaches the sentence, not only the machine field");
    // The GOAL-176 consequence measurement is KEPT — it is still true.
    assert.match(bw.reason, /NO idle page/, "the consequence measurement survives the cause arriving");
    assert.ok(bw.measuredAt, "a measured verdict carries its stamp");

    // THE SAME BLOCK on /health, the surface a health-checker actually polls.
    const health = await get(svc.port, "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.body.bootWarm, bw, "one measurement, two readers");
    assert.equal(health.body.bootWarm?.outcome?.reason, bw.outcome?.reason, "/health carries the same real cause");
  } finally {
    if (svc) await svc.close();
    if (prevAttach === undefined) delete process.env.UI2API_ATTACH_PORT;
    else process.env.UI2API_ATTACH_PORT = prevAttach;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function fakeStatus(idle: number, browserProbe: string): import("../src/prompt/pool.js").PoolStatus {
  return {
    browser: "down",
    browserCheckedAt: null,
    browserProbe,
    warm: idle,
    warmLive: 0,
    idle,
    busy: 0,
    total: idle,
    max: 1,
    queued: 0,
    maxWaiters: 4,
    perSite: {},
    busyWatchdogMs: 1000,
    perSiteMax: 1,
    requestTimeoutMs: 300000,
    workers: [],
    lastSweep: null,
    reaper: "running",
  } as import("../src/prompt/pool.js").PoolStatus;
}

test("GOAL178: bootWarmBlock reports the outcome's cause and never substitutes a generic string for it", () => {
  const out: WarmOutcome = {
    site: "kimi",
    attempts: 1,
    opened: 0,
    failed: 1,
    reason: "EACCES: permission denied, open '/home/ui2api/.config/ui2api-chrome'",
  };
  const b = bootWarmBlock({ st: fakeStatus(0, "no browser handle"), attempted: true, attached: false, outcome: out });
  assert.equal(b.ok, false);
  assert.deepEqual(b.outcome, out, "the outcome is passed through, not rebuilt");
  assert.match(b.reason, /EACCES/, "the real cause is in the report");
  assert.ok(
    !/page open failed\b/.test(b.reason),
    `a GENERIC phrase must never stand in for the real cause: ${b.reason}`
  );
  assert.match(b.reason, /a request still opens its own page on demand/, "the record must not read as an outage");

  // A successful warm with an outcome: the outcome rides along, no cause invented.
  const good = bootWarmBlock({
    st: fakeStatus(1, "browser.isConnected() === true"),
    attempted: true,
    attached: false,
    outcome: { site: "kimi", attempts: 1, opened: 1, failed: 0, reason: null },
  });
  assert.equal(good.ok, true);
  assert.equal(good.outcome?.opened, 1);
  assert.equal(good.outcome?.reason, null);

  // Unattempted (the pre-built pool seam): no outcome, no cause claimed.
  const seam = bootWarmBlock({ st: fakeStatus(0, "no browser handle"), attempted: false, attached: false });
  assert.equal(seam.outcome, null, "an unattempted warm carries no outcome — null, never a fabricated one");
  assert.match(seam.reason, /no boot warm was attempted/);

  // A THROWN warm (the belt-and-braces path) still forwards its cause — as a
  // NAMED code, not the message. GOAL 240: this reason is served on /status and
  // /health, so the sentence (which here would be a path on a real throw) is
  // gone and the classification is what remains. `(unknown)` is the honest
  // answer for a bare `Error` with neither an errno nor a known class: the
  // point of the pin is that it does NOT become a generic phrase masquerading
  // as a cause.
  const threw = bootWarmBlock({ st: fakeStatus(0, "no browser handle"), attempted: true, attached: false, thrown: new Error("no Chrome executable found for managed spawn") });
  assert.match(threw.reason, /THREW \(unknown\)/, "a bare throw with no errno and no known class is named (unknown) — never a generic phrase standing in for a cause");
  assert.doesNotMatch(threw.reason, /no Chrome executable found/, "the thrown sentence must not reach /status or /health");
  // …but a throw that DOES carry an errno keeps it: that is the diagnosis an
  // operator triages on, and losing it would be "no raw internals" quietly
  // becoming "no detail".
  const threwErrno = bootWarmBlock({
    st: fakeStatus(0, "no browser handle"),
    attempted: true,
    attached: false,
    thrown: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9222"), { code: "ECONNREFUSED" }),
  });
  assert.match(threwErrno.reason, /THREW \(errno:ECONNREFUSED\)/, "an errno survives as the named code");
  assert.doesNotMatch(threwErrno.reason, /127\.0\.0\.1/, "the address is internal detail and must not be published");
});
