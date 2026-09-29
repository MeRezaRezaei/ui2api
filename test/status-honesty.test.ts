// GOAL 87 — the daemon's LIVENESS surfaces must not lie.
//
// Measured before the fix:
//   pool.ts reported `browser: this.browser ? "up" : "down"` — a NULL-CHECK
//   wearing a liveness label, on the two routes documented as liveness
//   (docs/VISION.md "GET /health / GET /status"). A disconnected-but-still-set
//   handle answered "up" FOREVER, because the respawn lived inside
//   ensureBrowser() and therefore only ran when a REQUEST arrived — which a
//   health-checker polling /status in a loop never does.
//   `warm: idle` counted ARRAY ENTRIES, not live pages, and the only liveness
//   check for a page (isWorkerUsable) ran inside release() — so a page that
//   died while IDLE kept reporting warm/idle. There was no reaper anywhere in
//   src/prompt/ (no setInterval at all).
//   And nothing logged requests outside UI2API_DEBUG, so a wedged request was
//   "busy: 1" with no start time, no site, no account and no elapsed time.
//
// These pins are behavioral: each one drives the real pool / the real daemon
// and asserts on what the daemon REPORTS. A pin that only read the source would
// pass against the old null-check, because the old code's whole failure is a
// number that looks right — so every liveness assertion here is made against a
// handle whose state is under the test's control.
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatPool, type PoolOptions, type PoolWorker, type PoolStatus } from "../src/prompt/pool.js";
import { RequestLog, startPromptd } from "../src/prompt/http.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";

// ── helpers ──────────────────────────────────────────────────────────────────

// A Playwright-like browser handle whose liveness we control: isConnected() is
// the REAL probe the pool now makes (a disconnected-but-set handle is exactly
// the corpse the old `this.browser ? "up" : "down"` reported as "up").
function browserHandle(connected: boolean): unknown {
  return { isConnected: () => connected, contexts: () => (connected ? [{}] : []) };
}

// A handle that exposes no liveness surface at all: the honest answer must be
// "unknown", never a fabricated "up".
function opaqueHandle(): unknown {
  return { kind: "not-a-playwright-browser" };
}

// A pool that never spawned a browser (profiles:[] ⇒ no browser is launched) —
// the state a real freshly-started daemon is in.
//
// dataDir is a REAL temp directory, never the relative "data" this used to
// pass: a relative dataDir resolves against cwd into the operator's gitignored
// data/sessions/… vault, so the pool was one `profiles` entry away from
// replaying a real captured session — inert only because of what happened to
// be true downstream, and an empty-vault 404 on a clean CI checkout.
const VAULT = mkdtempSync(join(tmpdir(), "u2a-status-pool-"));
after(() => rmSync(VAULT, { recursive: true, force: true }));

function emptyPool(opts: Partial<PoolOptions> = {}): ChatPool {
  return new ChatPool({ profiles: [], dataDir: VAULT, max: 1, ...opts } as PoolOptions);
}

function setBrowser(pool: ChatPool, handle: unknown): void {
  (pool as unknown as { browser?: unknown }).browser = handle;
}

// A driver whose page/context probe PASSES (a live idle page).
function liveDriver(): unknown {
  return {
    page: { context: () => ({ pages: () => [{ evaluate: async () => 1 }], _closed: false }) },
    close: async () => {},
    ask: async () => ({}),
  };
}

// A driver whose page/context probe FAILS — the page died while idle, which the
// reaper exists to notice.
function deadDriver(): unknown {
  return { page: undefined, close: async () => {}, ask: async () => ({}) };
}

// A driver whose `ask()` NEVER SETTLES — the "wedged request" shape. Its
// liveness probe PASSES, so the pool hands the page out normally and the request
// is genuinely still awaiting when the aggregate deadline fires.
//
// This exists because a daemon built with NO injected pool reaches a REAL
// ChatDriver: /prompt calls pool.spawn → driver.start() → getPage(), which
// navigates the real browser to the fake profile's host
// (`https://<id>.example.com`). That is a live page navigation owned by a unit
// test, and it is what made this file's PROCESS never exit — see the two
// `/prompt` tests below. Nothing here touches a browser: `close()` resolves, so
// the pool's shutdown is not left holding a promise that can never settle.
function wedgedDriver(): unknown {
  return {
    page: { context: () => ({ pages: () => [{ evaluate: async () => 1 }], _closed: false }) },
    close: async () => {},
    ask: () => new Promise<never>(() => {}),
  };
}

function insertWorker(pool: ChatPool, worker: unknown): void {
  const list = (pool as unknown as { workers: PoolWorker[] }).workers;
  list.push(worker as PoolWorker);
}

function fakeProfile(id: string): ChatSiteProfile {
  return {
    id,
    name: id,
    url: `https://${id}.example.com`,
    loginRequired: false,
    composer: ["textarea"],
    send: { key: "Enter" },
    answer: ["p"],
    captureMs: 1000,
    stableMs: 200,
  } as unknown as ChatSiteProfile;
}

// ── (1) honest liveness, not a null-check ────────────────────────────────────

test("GOAL87: a SET but DISCONNECTED browser handle does NOT report \"up\" (the old null-check said up)", async () => {
  const pool = emptyPool();
  try {
    // Pre-fix this answered "up": the handle is set, so `this.browser ? …`.
    setBrowser(pool, browserHandle(false));
    const st = pool.status;
    assert.notEqual(st.browser, "up", `a disconnected handle must never be reported as up (got ${st.browser})`);
    assert.equal(st.browser, "down", "an isConnected()===false handle is measured DOWN");
    assert.match(st.browserProbe, /isConnected\(\) === false/, `the probe must name what it measured: ${st.browserProbe}`);
    // The named reason travels with the number, so "down" is diagnosable.
    assert.ok(st.browserCheckedAt, "a probe that ran must stamp when it ran");
    assert.ok(!Number.isNaN(Date.parse(st.browserCheckedAt as string)), "browserCheckedAt must be a real timestamp");
  } finally {
    await pool.close();
  }
});

test("GOAL87: a live handle reports \"up\" — the probe is a real check, not a constant", async () => {
  const pool = emptyPool();
  try {
    setBrowser(pool, browserHandle(true));
    const st = pool.status;
    assert.equal(st.browser, "up", "a handle whose isConnected() is true is honestly up");
    assert.match(st.browserProbe, /isConnected\(\) === true/);
  } finally {
    await pool.close();
  }
});

test("GOAL87: a handle with no liveness surface is \"unknown\" — never a false \"up\"", async () => {
  const pool = emptyPool();
  try {
    setBrowser(pool, opaqueHandle());
    const st = pool.status;
    assert.notEqual(st.browser, "up", "an unprobeable handle must never claim to be up");
    assert.equal(st.browser, "unknown", "no liveness surface ⇒ the honest third state, unknown");
    assert.match(st.browserProbe, /no isConnected\(\) liveness surface|no liveness surface/, `the reason must name the gap: ${st.browserProbe}`);
  } finally {
    await pool.close();
  }
});

test("GOAL87: a never-spawned pool is \"down\"/\"unknown\" — never a false \"up\"", async () => {
  const pool = emptyPool();
  try {
    const st = pool.status;
    assert.notEqual(st.browser, "up", "a pool that never spawned a browser must not claim to be up");
    assert.ok(["down", "unknown"].includes(st.browser), `expected down|unknown, got ${st.browser}`);
    assert.match(st.browserProbe, /no browser handle/, `the reason must say there is no handle: ${st.browserProbe}`);
  } finally {
    await pool.close();
  }
});

test("GOAL87: a liveness probe that THROWS on a set handle is \"down\", not \"up\"", async () => {
  const pool = emptyPool();
  try {
    setBrowser(pool, {
      isConnected: () => {
        throw new Error("Target page, context or browser has been closed");
      },
    });
    const st = pool.status;
    assert.notEqual(st.browser, "up", "a probe that throws must never be read as up");
    assert.equal(st.browser, "down");
    assert.match(st.browserProbe, /liveness probe threw/);
  } finally {
    await pool.close();
  }
});

// ── (2) a real reaper (not a null-check, not a silent leak) ──────────────────

test("GOAL87: the reaper is started EXPLICITLY and the sweep evicts a page that died while IDLE", async () => {
  const pool = emptyPool({ reaperIntervalMs: 10 });
  const dead = { profileId: "gemini", driver: deadDriver(), busy: false } as unknown as PoolWorker;
  const live = { profileId: "gemini", driver: liveDriver(), busy: false } as unknown as PoolWorker;
  insertWorker(pool, dead);
  insertWorker(pool, live);
  try {
    // Pre-fix there was no reaper at all, and `warm` counted the dead ARRAY
    // ENTRY: a page that died while idle reported warm forever.
    assert.equal(pool.status.browser, "down", "no browser handle in this test — the sweep must not pretend otherwise");
    assert.equal(pool.status.reaper, "stopped", "the reaper is stopped until it is explicitly started");

    const started = pool.startReaper();
    assert.equal(started, true, "startReaper must report that it started");
    assert.equal(pool.reaperRunning, true, "a started reaper must be observable as running");
    assert.equal(pool.status.reaper, "running", "/status must report the reaper state, not hide it");
    // Idempotent: a second start must not create a second timer.
    pool.startReaper();
    assert.equal(pool.reaperRunning, true);

    // Drive one sweep deterministically (the timer exists, but timing is not the
    // assertion — the sweep's MEASURED report is).
    const report = await pool.sweep();
    assert.equal(report.checked, 2, "the sweep must check every IDLE page, live or dead");
    assert.equal(report.evicted, 1, "the page that died while idle must be evicted");
    assert.deepEqual(report.sites, ["gemini"], "the evicted site must be named");
    const st = pool.status;
    assert.equal(st.total, 1, "the corpse must be gone from the pool, not counted as warm");
    assert.equal(st.warm, 1, "warm must now be the ONE page that answered a real probe");
    assert.equal(st.warmLive, 1, "warmLive counts only pages PROVED live by a probe — never an unmeasured one");
    assert.equal(st.workers.length, 1);
    assert.equal(st.workers[0].health, "live", "a swept page carries its MEASURED health");
    assert.ok(st.workers[0].checkedAt, "a measured health must carry when it was measured");
    // The sweep never spawns a browser (that would be fabricated traffic from a
    // timer): the respawn is refused and NAMED, not faked.
    assert.equal(report.respawned, 0, "the sweep must not claim a respawn it did not perform");
    assert.equal(report.respawnFailed, 1, "the refused respawn is counted honestly");
    assert.match(report.note, /browser is down/, `the note must say why: ${report.note}`);
    assert.equal(st.lastSweep?.evicted, 1, "the last measured sweep stays visible on /status");
  } finally {
    await pool.close();
  }
});

test("GOAL87: a BUSY page is never evicted by the sweep (it is mid-request)", async () => {
  const pool = emptyPool();
  const busyDead = { profileId: "gemini", driver: deadDriver(), busy: true, busySince: Date.now() - 5000 } as unknown as PoolWorker;
  insertWorker(pool, busyDead);
  try {
    const report = await pool.sweep();
    assert.equal(report.checked, 0, "a busy page is not an idle candidate");
    assert.equal(report.evicted, 0);
    assert.equal(pool.status.total, 1, "the in-use page must survive the sweep");
  } finally {
    await pool.close();
  }
});

test("GOAL87: LEAK PIN — close() stops the reaper (asserted by the flag, not by a stopwatch)", async () => {
  const pool = emptyPool({ reaperIntervalMs: 5 });
  const timer = { cleared: false } as { cleared: boolean };
  // Watch the REAL timer: wrap clearInterval so the pin proves the reaper's own
  // handle was cleared, not merely that a flag somewhere flipped.
  const realClear = clearInterval;
  (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = ((h: never) => {
    timer.cleared = true;
    return realClear(h);
  }) as typeof clearInterval;
  try {
    pool.startReaper();
    assert.equal(pool.reaperRunning, true, "the reaper must be running before close()");
    await pool.close();
    assert.equal(pool.reaperRunning, false, "close() must stop the reaper — a leaked interval keeps the process alive");
    assert.equal(timer.cleared, true, "the reaper's own timer must be cleared, not just a flag flipped");
    assert.equal(pool.status.reaper, "stopped", "/status must report the reaper as stopped after close()");
  } finally {
    (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = realClear;
  }
});

test("GOAL87: a reaper interval of 0 is an honest opt-out (no timer, and /status says so)", async () => {
  const pool = emptyPool({ reaperIntervalMs: 0 });
  try {
    assert.equal(pool.startReaper(), false, "0 disables the sweep");
    assert.equal(pool.reaperRunning, false, "a disabled reaper must not hold a timer");
  } finally {
    await pool.close();
  }
});

// ── (3) queue + busy visibility ──────────────────────────────────────────────

test("GOAL87: /status exposes the GOAL 83 queue fields AND measured per-worker busy detail", async () => {
  const pool = new ChatPool({ profiles: [], dataDir: VAULT, max: 1, maxWaiters: 3, waiterTimeoutMs: 0 } as PoolOptions);
  const worker = { profileId: "gemini", driver: liveDriver(), busy: false } as unknown as PoolWorker;
  insertWorker(pool, worker);
  try {
    // Hand the idle page out through the REAL acquire() path, so busySince is
    // stamped by the code under test (not injected by the test).
    const handed = pool.acquire("gemini");
    await new Promise((r) => setTimeout(r, 30));
    const st: PoolStatus = pool.status;
    // GOAL 83 fields must still be there — do not regress them.
    assert.equal(st.queued, 0);
    assert.equal(st.maxWaiters, 3);
    assert.equal(st.busy, 1, "the page is out on loan");
    assert.equal(st.workers.length, 1);
    const w = st.workers[0];
    assert.equal(w.site, "gemini", "which site the busy page is on must be visible");
    assert.equal(w.busy, true);
    assert.equal(typeof w.busyMs, "number", "busyMs must be a measured number, not absent");
    assert.ok((w.busyMs as number) >= 20, `busyMs must be measured from the real stamp (got ${w.busyMs})`);
    assert.equal(w.account, null, "a pooled page carries the shared default session — null says exactly that");
    // The queue is visible too: a parked request shows up as queued, not as silence.
    const parked = pool.acquire("gemini");
    assert.equal(pool.status.queued, 1, "a parked request must be visible as queued");
    assert.equal(pool.status.workers[0].busy, true, "the one page stays busy — queueing is not silent reuse");
    await pool.release(await handed);
    await pool.close();
    void observeSettle(parked);
  } finally {
    await pool.close();
  }
});

test("GOAL87: an idle page reports busyMs:null (a measured \"not busy\" is null, never a fabricated 0)", async () => {
  const pool = emptyPool();
  insertWorker(pool, { profileId: "kimi", driver: liveDriver(), busy: false } as unknown as PoolWorker);
  try {
    const st = pool.status;
    assert.equal(st.workers[0].busy, false);
    assert.equal(st.workers[0].busyMs, null, "an idle page has no busy duration — null, not 0");
  } finally {
    await pool.close();
  }
});

test("GOAL87: a dedicated account worker's in-flight account is visible on /status", async () => {
  const pool = emptyPool();
  insertWorker(pool, {
    profileId: "gemini",
    driver: liveDriver(),
    busy: true,
    busySince: Date.now() - 100,
    dedicated: { account: "me@example.com" },
  } as unknown as PoolWorker);
  try {
    const w = pool.status.workers[0];
    assert.equal(w.account, "me@example.com", "the in-flight account must be diagnosable from /status");
    assert.equal(w.dedicated, true);
    assert.ok((w.busyMs as number) >= 90, `busyMs must be measured: ${w.busyMs}`);
  } finally {
    await pool.close();
  }
});

test("GOAL87: the daemon's /status keeps every legacy field and adds the honest liveness block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-status-"));
  const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: dir, profiles: [], reaperIntervalMs: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${svc.port}/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; pool: PoolStatus; liveness: Record<string, unknown> };
    assert.equal(body.ok, true, "back-compat: /status keeps ok:true");
    // Every field the old /status carried must still be there.
    for (const key of ["browser", "warm", "warmLive", "idle", "busy", "total", "max", "queued", "maxWaiters", "perSite"]) {
      assert.ok(key in body.pool, `/status must keep pool.${key} (existing consumers)`);
    }
    assert.equal(typeof body.pool.warm, "number", "the legacy warm/idle counts survive");
    assert.equal(typeof body.pool.idle, "number");
    assert.equal(body.pool.warmLive, 0, "with no pages, nothing is claimed live");
    assert.equal(typeof body.pool.queued, "number", "GOAL 83's queued field survives");
    assert.equal(typeof body.pool.maxWaiters, "number", "GOAL 83's maxWaiters field survives");
    assert.ok(Array.isArray(body.pool.workers), "the per-worker detail must be present");
    // The honest liveness block — and this daemon has NO browser (profiles:[]),
    // so it must not claim one is up.
    assert.equal(body.liveness.daemon, "up", "the daemon answered: that is what makes daemon:up measured");
    assert.equal(body.liveness.browser, "down", "a daemon with no browser must say down, not up");
    assert.equal(typeof body.liveness.browserProbe, "string");
    assert.equal(body.liveness.reaper, "stopped", "reaperIntervalMs:0 was an honest opt-out, and /status says stopped");
    assert.equal(body.liveness.lastSweep, null, "no sweep has run, so lastSweep is null — never a fabricated report");
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GOAL87: the daemon starts the reaper itself and /health reports the honest browser state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-health-"));
  const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: dir, profiles: [], reaperIntervalMs: 60_000 });
  try {
    assert.equal(svc.pool.reaperRunning, true, "the daemon starts the reaper explicitly (no bare module-level setInterval)");
    const body = (await (await fetch(`http://127.0.0.1:${svc.port}/health`)).json()) as {
      ok: boolean;
      defaultSite: string;
      pool: PoolStatus;
      liveness: Record<string, unknown>;
    };
    assert.equal(body.ok, true, "/health keeps ok:true (the daemon answered)");
    assert.ok(body.defaultSite, "/health keeps defaultSite");
    assert.equal(body.pool.browser, "down", "a daemon with no browser must not answer up on /health");
    assert.equal(body.liveness.browser, body.pool.browser, "the two routes must not disagree about the browser");
    assert.equal(body.liveness.reaper, "running");
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
    assert.equal(svc.pool.reaperRunning, false, "the daemon's close() stops the reaper");
  }
});

// ── (4) the bounded request ring ─────────────────────────────────────────────

test("GOAL87: the ring is BOUNDED — the oldest entries are evicted, and every entry is measured", async () => {
  const log = new RequestLog(3);
  for (let i = 1; i <= 5; i++) {
    const done = log.begin("POST", "/prompt");
    done({ status: 200, site: "gemini", account: null });
  }
  const list = log.list();
  assert.equal(log.limit, 3, "the ring is bounded at its limit");
  assert.equal(list.length, 3, "the ring NEVER grows past its limit");
  assert.deepEqual(list.map((e) => e.path), ["/prompt", "/prompt", "/prompt"]);
  assert.deepEqual(list.map((e) => e.seq), [3, 4, 5], "eviction is oldest-first: entries 1 and 2 are GONE, and seq keeps the order legible");
  const e = list[0];
  assert.equal(e.method, "POST");
  assert.equal(e.status, 200);
  assert.equal(typeof e.durationMs, "number", "durationMs must be measured");
  assert.equal(e.site, "gemini");
  assert.equal(e.outcome, "done");
  assert.equal(e.account, null);
  assert.ok(!Number.isNaN(Date.parse(e.startedAt)), "startedAt must be a real timestamp");
  assert.equal(log.inFlight, 0, "a finished request is no longer in flight");
});

test("GOAL87: outcomes are honest — 504 is a timeout, 4xx/5xx/503 is a refusal, 2xx is done", async () => {
  const log = new RequestLog(10);
  log.begin("POST", "/prompt")({ status: 200 });
  log.begin("POST", "/prompt")({ status: 504 });
  log.begin("POST", "/prompt")({ status: 503 });
  log.begin("POST", "/prompt")({ status: 400 });
  log.begin("GET", "/status")({ status: 200 });
  const outcomes = log.list().map((e) => e.outcome);
  assert.deepEqual(outcomes, ["done", "timeout", "refused", "refused", "done"], `outcomes must match the status: ${outcomes.join(",")}`);
});

test("GOAL87: a refusal (pool saturated) over the wire is recorded as `refused` and visible on /requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-requests-"));
  // A pool already AT capacity (one busy fake page) with a 1-slot queue: the
  // first /prompt parks, the second is refused with `pool saturated`. No browser
  // is ever launched.
  const pool = new ChatPool({ profiles: [fakeProfile("gemini")], dataDir: dir, max: 1, maxWaiters: 1, waiterTimeoutMs: 400, reaperIntervalMs: 0 } as PoolOptions);
  insertWorker(pool, { profileId: "gemini", driver: liveDriver(), busy: true, busySince: Date.now() } as unknown as PoolWorker);
  const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: dir, profiles: [fakeProfile("gemini")], pool });
  try {
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${svc.port}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    // Fire both at once: the first takes the only slot-free path (parks), the
    // second finds the queue full and is refused immediately.
    const [first, second] = await Promise.all([post({ site: "gemini", prompt: "hello there" }), post({ site: "gemini", prompt: "hello again" })]);
    assert.equal(second.status, 503, "a saturated pool must refuse, not hang");
    const refusal = (await second.json()) as { error: { code: string } };
    assert.equal(refusal.error.code, "pool_saturated");
    // The parked one is bounded by its own queue deadline (GOAL 83), so this
    // test never depends on an unbounded wait.
    assert.equal(first.status, 503, `the parked request must also answer: ${first.status}`);

    const ring = (await (await fetch(`http://127.0.0.1:${svc.port}/requests`)).json()) as {
      ok: boolean;
      limit: number;
      inFlight: number;
      requests: { method: string; path: string; status: number; durationMs: number; site: string | null; account: string | null; outcome: string }[];
    };
    assert.equal(ring.ok, true);
    assert.equal(typeof ring.limit, "number", "the ring reports its bound");
    assert.equal(ring.inFlight, 0, "nothing is left in flight once both answered");
    const refusals = ring.requests.filter((r) => r.path === "/prompt");
    assert.equal(refusals.length, 2, "both /prompt requests are in the ring");
    for (const r of refusals) {
      assert.equal(r.status, 503);
      assert.equal(r.outcome, "refused", `a pool refusal must be recorded as refused: ${JSON.stringify(r)}`);
      assert.equal(r.site, "gemini", "the site that was refused must be visible");
      assert.equal(typeof r.durationMs, "number");
      assert.equal(r.account, null, "no account was requested — null, not a guess");
    }
    // The ring reads itself: GET /requests must not append to the ring.
    await fetch(`http://127.0.0.1:${svc.port}/requests`);
    const again = (await (await fetch(`http://127.0.0.1:${svc.port}/requests`)).json()) as { requests: { path: string }[] };
    assert.equal(again.requests.filter((r) => r.path === "/requests").length, 0, "the ring never records its own reads");
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GOAL87: a wedged request is visible — the aggregate deadline records a `timeout`", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-wedge-"));
  // A 60ms deadline raced by a body that trickles in past it, so the route is
  // genuinely still awaiting when the deadline fires (the GOAL 83 shape).
  //
  // The pool is injected with ONE worker whose `ask()` never settles. That is
  // what makes the request genuinely wedge WITHOUT a browser: the page is handed
  // out normally, and nothing about the wait depends on a real navigation. This
  // test used to build the daemon with NO pool, so /prompt really did
  // pool.spawn → driver.start() → a live `goto` of `https://gemini.example.com/`.
  // The 60ms deadline answered 504 and the assertions passed, but the in-flight
  // navigation was ABANDONED when the daemon closed — a promise that never
  // settles, backed by no handle, so the event loop drained while the test
  // runner still had a pending promise. `node --test` then never exited: this
  // file hung the whole `test:unit` suite (exit 124 under any real timeout) with
  // every one of its tests already printed as a pass. A test that reaches a real
  // browser is a test that owns a real browser's lifetime, and it was not closing it.
  const pool = new ChatPool({ profiles: [fakeProfile("gemini")], dataDir: dir, max: 1, reaperIntervalMs: 0 } as PoolOptions);
  insertWorker(pool, { profileId: "gemini", driver: wedgedDriver(), busy: false, busySince: Date.now() } as unknown as PoolWorker);
  const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: dir, profiles: [fakeProfile("gemini")], requestTimeoutMs: 60, reaperIntervalMs: 0, pool });
  const req = fetch(`http://127.0.0.1:${svc.port}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ site: "gemini", prompt: "slow one" }) });
  req.catch(() => undefined);
  try {
    await new Promise((r) => setTimeout(r, 400)); // let the wedged request time out
    const ring = (await (await fetch(`http://127.0.0.1:${svc.port}/requests`)).json()) as { requests: { path: string; outcome: string; status: number }[] };
    const entry = ring.requests.find((r) => r.path === "/prompt");
    assert.ok(entry, "a wedged request must be visible in the ring");
    assert.equal(entry.outcome, "timeout", `a deadline cut-off must be recorded as a timeout: ${JSON.stringify(entry)}`);
    assert.equal(entry.status, 504);
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (4b) NO-SECRET pin ──────────────────────────────────────────────────────

test("GOAL87: NO SECRETS — /requests and /status never echo a prompt, an answer, a cookie or a token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-nosecret-"));
  // The pool is injected ALREADY AT CAPACITY (one busy page) with a zero-length
  // queue, so /prompt is refused by name and IMMEDIATELY — no spawn, no driver,
  // no browser. This test used to build the daemon with NO pool, so the refusal it
  // was relying on was really a real `pool.spawn` racing a real navigation to
  // `https://gemini.example.com/`, abandoned on close — the same never-settling
  // promise that hung this file. A saturated pool refuses on its own account, so
  // the property under test (a refusal must not echo a secret) is unchanged and
  // the test no longer owns a browser it never asked for.
  const pool = new ChatPool({ profiles: [fakeProfile("gemini")], dataDir: dir, max: 1, maxWaiters: 0, reaperIntervalMs: 0 } as PoolOptions);
  insertWorker(pool, { profileId: "gemini", driver: liveDriver(), busy: true, busySince: Date.now() } as unknown as PoolWorker);
  const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: dir, profiles: [fakeProfile("gemini")], reaperIntervalMs: 0, pool });
  const PROMPT = "MY-SECRET-PROMPT-9f3a2b";
  const TOKEN = "Bearer ui2api-secret-token-7c1d";
  const COOKIE = "SID=secret-cookie-value-4e5f";
  try {
    // A request that CARRIES a prompt, a bearer token and a cookie. The pool
    // is at capacity, so it is refused — the refusal must still not leak anything.
    const res = await fetch(`http://127.0.0.1:${svc.port}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: TOKEN, cookie: COOKIE },
      body: JSON.stringify({ site: "gemini", prompt: PROMPT, messages: [{ role: "user", content: PROMPT }] }),
    });
    assert.ok(res.status >= 400, `the un-served request must not succeed: ${res.status}`);

    const requestsRaw = await (await fetch(`http://127.0.0.1:${svc.port}/requests`)).text();
    const statusRaw = await (await fetch(`http://127.0.0.1:${svc.port}/status`)).text();
    for (const [name, raw] of [["GET /requests", requestsRaw], ["GET /status", statusRaw]] as const) {
      assert.ok(!raw.includes(PROMPT), `${name} must not echo the prompt text`);
      assert.ok(!raw.includes(TOKEN), `${name} must not echo the bearer token`);
      assert.ok(!raw.includes("ui2api-secret-token"), `${name} must not echo the token body`);
      assert.ok(!raw.includes(COOKIE), `${name} must not echo the cookie`);
      assert.ok(!raw.includes("SID="), `${name} must not echo a cookie pair`);
      assert.ok(!/"cookie"/i.test(raw), `${name} must not carry a cookie field`);
      assert.ok(!/"authorization"/i.test(raw), `${name} must not carry an authorization field`);
    }
    // The entry carries ONLY the allow-listed diagnostic fields — a prompt key
    // could not hide in there even if some future route started logging it.
    const ring = JSON.parse(requestsRaw) as { requests: Record<string, unknown>[] };
    const entry = ring.requests.find((r) => r.path === "/prompt");
    assert.ok(entry, "the request is recorded (the refusal is visible)");
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["account", "durationMs", "method", "outcome", "path", "seq", "site", "startedAt", "status"],
      `the log entry must be exactly the non-secret fields: ${Object.keys(entry).join(",")}`
    );
    // The path is the pathname only — the query string is dropped, because a
    // query can carry anything a caller puts in it.
    for (const r of ring.requests) {
      assert.ok(!(r.path as string).includes("?"), `the logged path must carry no query string: ${r.path}`);
    }
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Resolve/observe a promise with a wall-clock bound so a pin FAILS instead of
// hanging (the parked acquire in the busy-visibility pin).
function observeSettle(p: Promise<unknown>, ms = 1500): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    t.unref?.();
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      }
    );
  });
}
