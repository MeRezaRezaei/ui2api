/**
 * GOAL 176 — a boot-warm failure is RECORDED with its named cause, and the
 * daemon still starts.
 *
 * THE DEFECT this pins: boot warm ran as
 *   `if (!opts.pool) await pool.warm().catch(() => undefined);`
 * which discarded every outcome identically, so a daemon that had opened NO
 * page at all still answered /status and /health as a healthy service. Green
 * gate, service that cannot serve — the GOAL-156/157 property inverted.
 *
 * WHAT IS DELIBERATELY NOT PINNED: a refusal. One unreachable site must never
 * keep the daemon down (a request opens its own page on demand), so the gate
 * asserts the daemon still SERVES while the failure is visible. Turning the
 * swallow into a hard refusal is a regression, and these tests red on it.
 *
 * NO BROWSER IS LAUNCHED here, and that is enforced rather than asserted in a
 * comment: every daemon below either runs with `UI2API_ATTACH_PORT=1` (nothing
 * listens — the attach is refused before any page is opened) or is handed a
 * pre-built pool through the `pool` seam, which is never warmed. If a future
 * edit made one of these daemons construct its own pool WITHOUT the attach env,
 * these tests would try to spawn a real Chrome and time out loudly rather than
 * pass quietly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startPromptd, bootWarmBlock, type BootWarmStatus } from "../src/prompt/http.js";
import { ChatPool, type PoolStatus } from "../src/prompt/pool.js";
import { BUILTIN_PROFILES } from "../src/profile/profile.js";

const PROFILES = [BUILTIN_PROFILES.deepseek].filter(Boolean);

type Wire = { ok?: boolean; bootWarm?: BootWarmStatus; sites?: unknown[]; models?: unknown[]; data?: unknown[] };

async function get(port: number, path: string): Promise<{ status: number; body: Wire }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as Wire };
}

/** A pool with one IDLE page already in it — no browser, no warm, no acquire. */
function preBuiltPool(dataDir: string): ChatPool {
  const pool = new ChatPool({ profiles: PROFILES, dataDir, min: 1, max: 1 });
  (pool as unknown as { workers: unknown[] }).workers = [{ profileId: "deepseek", busy: false, health: "unprobed" }];
  return pool;
}

test("GOAL176: a boot warm that opened NO page is recorded with a named cause on /status AND /health — while the daemon still serves", async () => {
  const prevAttach = process.env.UI2API_ATTACH_PORT;
  // Nothing listens on port 1: the attach is refused immediately, so the warm
  // attempt fails FAST and no browser is ever spawned.
  process.env.UI2API_ATTACH_PORT = "1";
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-bootwarm-"));
  try {
    // Deliberately NO `pool` seam — this daemon owns its pool, so it really does
    // run boot warm. That is the exact condition the old swallow erased.
    const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir, profiles: PROFILES });
    try {
      const status = await get(svc.port, "/status");
      assert.equal(status.status, 200, "/status must answer — a failed warm is a RECORD, never a refusal");
      const bw = status.body.bootWarm;
      assert.ok(bw, "/status must carry a bootWarm block (the goal: the reason is visible on the surface that already reports pool state)");
      assert.equal(bw.attempted, true, "this daemon owns its pool, so a boot warm WAS attempted");
      assert.equal(bw.ok, false, "a warm that left no idle page must NOT read ok");
      assert.equal(bw.idlePages, 0, "the measurement is the pool's own idle count, not an assumption");
      assert.ok(bw.reason && bw.reason.length > 20, `bootWarm.reason must NAME the failure, got ${JSON.stringify(bw.reason)}`);
      assert.match(bw.reason, /NO idle page/, "the reason must name the observed outcome");
      assert.match(bw.reason, /ATTACH mode/, "the reason must name the measured cause it can see (attach refused), not a guess");
      assert.ok(bw.measuredAt, "a measured verdict carries its measurement stamp");
      assert.equal(bw.browser, "down", "the pool's own honest liveness probe is reported, never re-asserted");

      // The SAME block on /health — the surface a health-checker actually polls.
      const health = await get(svc.port, "/health");
      assert.equal(health.status, 200);
      assert.deepEqual(health.body.bootWarm, bw, "/health must carry the SAME bootWarm block as /status (one measurement, two readers)");

      // AND THE SERVICE IS STILL UP: the daemon refused nothing.
      const sites = await get(svc.port, "/sites");
      assert.equal(sites.status, 200, "the daemon still serves after a failed boot warm");
      const ids = ((sites.body.sites ?? []) as Array<{ id: string }>).map((s) => s.id);
      assert.ok(ids.includes("deepseek"), "the chat surface is still advertised after a failed boot warm");
    } finally {
      await svc.close();
    }
  } finally {
    if (prevAttach === undefined) delete process.env.UI2API_ATTACH_PORT;
    else process.env.UI2API_ATTACH_PORT = prevAttach;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("GOAL176: a pre-built pool seam reports NO boot-warm verdict instead of a fake failure", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-bootwarm-seam-"));
  const pool = preBuiltPool(dataDir);
  try {
    const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir, profiles: PROFILES, pool });
    try {
      const status = await get(svc.port, "/status");
      const bw = status.body.bootWarm;
      assert.ok(bw, "/status carries a bootWarm block for a seam daemon too — the field is never absent");
      assert.equal(bw.attempted, false, "a pre-built pool is never warmed by startPromptd");
      assert.equal(bw.ok, true, "an unattempted warm claims no failure");
      assert.equal(bw.measuredAt, null, "nothing was measured, so nothing is stamped");
      assert.match(bw.reason, /no boot warm was attempted/, "the reason says WHY there is no verdict — never an empty string");
    } finally {
      await svc.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* The reason composition, pinned directly so no daemon and no browser is needed
 * to cover the branches the wire cannot reach (a throwing warm, a warm that
 * worked, a non-attach pool with no page). */
function fakeStatus(over: Partial<PoolStatus>): PoolStatus {
  return {
    browser: "down",
    browserCheckedAt: null,
    browserProbe: "no browser handle: the pool has not spawned one (it spawns on the first request)",
    warm: 0,
    warmLive: 0,
    idle: 0,
    busy: 0,
    total: 0,
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
    ...over,
  } as PoolStatus;
}

test("GOAL176: bootWarmBlock names every branch — a throwing warm, a failed warm, a good warm, an unattempted one", () => {
  const threw = bootWarmBlock({ st: fakeStatus({}), attempted: true, attached: false, thrown: new Error("chrome binary not found") });
  assert.equal(threw.ok, false);
  assert.match(threw.reason, /THREW \(chrome binary not found\)/, "a thrown warm forwards the message it used to discard");

  const failed = bootWarmBlock({ st: fakeStatus({}), attempted: true, attached: false });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /NO idle page/);
  assert.match(failed.reason, /browser=down/);
  assert.match(failed.reason, /a request still opens its own page on demand/, "the record states the service is not down — it must not read as an outage");

  const good = bootWarmBlock({ st: fakeStatus({ idle: 1, warm: 1, browser: "up", browserProbe: "browser.isConnected() === true" }), attempted: true, attached: false });
  assert.equal(good.ok, true);
  assert.equal(good.idlePages, 1);
  assert.match(good.reason, /left 1 idle page\(s\)/);

  const unattempted = bootWarmBlock({ st: fakeStatus({}), attempted: false, attached: false });
  assert.equal(unattempted.ok, true);
  assert.equal(unattempted.measuredAt, null);
  assert.match(unattempted.reason, /no boot warm was attempted/);

  for (const b of [threw, failed, good, unattempted]) {
    assert.ok(b.reason.trim().length > 10, "a boot-warm verdict with no named reason is the defect itself");
  }
});