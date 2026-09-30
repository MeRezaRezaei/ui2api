// GOAL 83 — the daemon must always be stoppable, and every refusal must name
// its cause.
//
// Measured before the fix: ChatPool.acquire() pushed over-capacity requests
// into an UNBOUNDED `waiters` array whose entries carried a resolve but NO
// reject, close() did `this.waiters = []` (dropping every one of them), and the
// daemon had no request deadline at all. A single parked request therefore kept
// its HTTP handler — and its socket — alive forever, `server.close()` never
// finished, and SIGINT/SIGTERM could not stop promptd.
//
// These pins are behavioral, not source-shape: each one drives the real pool
// (or a real daemon) and asserts a promise SETTLES with a NAMED cause. A pin
// that only read the source would pass against the old `this.waiters = []`
// drop, because that drop is precisely a promise that never settles — so every
// wait here is raced against a short wall-clock guard and FAILS (rather than
// hanging) when the promise stays pending.
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatPool, siteRateLimitMs, type PoolOptions, type PoolWorker } from "../src/prompt/pool.js";
import { startPromptd } from "../src/prompt/http.js";

// Resolve/observe a promise with a wall-clock bound. `settled:false` is the
// failure signal: the old drop behaviour left these promises pending forever.
function observe<T>(p: Promise<T>, ms = 1500): Promise<{ settled: boolean; value?: T; error?: unknown }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ settled: false }), ms);
    p.then(
      (value) => {
        clearTimeout(t);
        resolve({ settled: true, value });
      },
      (error) => {
        clearTimeout(t);
        resolve({ settled: true, error });
      }
    );
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// A driver with no page — `isWorkerUsable` finds no context, so release()
// discards the worker (the real "the page died" path that calls drain()).
function deadDriver(): unknown {
  return { page: undefined, close: async () => {}, ask: async () => ({}) };
}

// A driver whose page/context probe passes — release() keeps the page and
// hands it to the next queued request (drainWorker reuse).
function liveDriver(): unknown {
  return {
    page: { context: () => ({ pages: () => [{ evaluate: async () => 1 }], _closed: false }) },
    close: async () => {},
    ask: async () => ({}),
  };
}

// A pool that is already AT capacity with one busy page, so acquire() parks
// instead of spawning — no browser is ever launched in these tests.
//
// dataDir is a REAL temp directory, never the relative "data" this used to
// pass: a relative dataDir resolves against cwd into the operator's gitignored
// data/sessions/… vault, so the pool was one `profiles` entry away from
// replaying a real captured session — inert only because of what happened to
// be true downstream, and a hard 404 (empty vault) on a clean CI checkout.
const VAULT = mkdtempSync(join(tmpdir(), "u2a-pool-"));
after(() => rmSync(VAULT, { recursive: true, force: true }));

function saturatedPool(opts: Partial<PoolOptions>, driver: unknown = deadDriver()): { pool: ChatPool; worker: PoolWorker } {
  const pool = new ChatPool({ profiles: [], dataDir: VAULT, ...opts } as PoolOptions);
  const worker = { profileId: "gemini", driver, busy: true } as unknown as PoolWorker;
  (pool as unknown as { workers: PoolWorker[] }).workers = [worker];
  return { pool, worker };
}

// ── (1) bounded queue: capacity ──────────────────────────────────────────────

// GOAL 162 — WHY THE NUMBERS ARE STILL PINNED HERE, AND WHY THEY ARE NOT ON
// THE WIRE. This file's pins state that "saturation must name the numbers", and
// GOAL 162 removed those numbers from the 503 body. Those two things are NOT in
// conflict once you say out loud WHERE the numbers are allowed to live, which is
// what this comment is for:
//
//   * IN THE POOL'S OWN MESSAGE (`src/prompt/pool.ts`) — yes, deliberately. That
//     message is the operator's: it is what the daemon logs, and the numbers it
//     carries are the reason the pool is saturated. The pins below stay.
//   * IN THE 503 BODY ON THE WIRE — no. The decision (written out in full in
//     `src/prompt/consumer-surface.ts`, beside `consumerPoolRefusal`) is that
//     the CODE is the client contract and the counters are OPERATOR TELEMETRY.
//     The telemetry is not discarded: `GET /status` publishes the queue depth and
//     its bound, which is the test at the bottom of this same file. What is
//     refused is only the ECHO — repeating our queue's internals to any consumer
//     that trips a 503.
//
// So a future reader who finds these numbers pinned here should read this comment
// and not "restore" them onto the wire, and a reader who finds them gone from
// the wire should read it and not go hunting for the counters to re-add.
test("GOAL83: acquire() past maxWaiters rejects with the NAMED saturation error (numbers included — operator-side, GOAL 162)", async () => {
  const { pool } = saturatedPool({ max: 1, maxWaiters: 1, waiterTimeoutMs: 60_000 });
  try {
    // First request parks (the single page is busy) — the queue is now full.
    const parked = pool.acquire("gemini");
    assert.equal(pool.queued, 1, "the over-capacity request must be parked, not dropped");

    // Second request: the queue is full → a named refusal, never a silent park.
    const refused = await observe(pool.acquire("gemini"), 1000);
    assert.equal(refused.settled, true, "a full queue must REFUSE, not park forever");
    assert.ok(refused.error instanceof Error, "the refusal must be an Error with a named cause");
    const msg = errorMessage(refused.error);
    assert.match(msg, /^pool saturated \(1 waiting, limit 1\)/, `saturation must name the numbers: ${msg}`);
    assert.ok(msg.includes("gemini") || msg.includes("no page is free"), `saturation must name the cause: ${msg}`);

    // The refusal must not have grown the queue.
    assert.equal(pool.queued, 1, "a refused request must never be parked");

    // The parked one is still bounded: the shutdown settles it with the named
    // close cause (its own 60s deadline would too — it never waits forever).
    await pool.close();
    const first = await observe(parked, 1000);
    assert.equal(first.settled, true, "the parked waiter must settle at the latest at shutdown");
    assert.match(errorMessage(first.error), /^pool closed \(daemon shutdown\)/, errorMessage(first.error));
    assert.equal(pool.queued, 0, "nothing may be left parked after close()");
  } finally {
    await pool.close();
  }
});

test("GOAL83: maxWaiters:0 refuses immediately — the queue is opt-in", async () => {
  const { pool } = saturatedPool({ max: 1, maxWaiters: 0, waiterTimeoutMs: 60_000 });
  try {
    const refused = await observe(pool.acquire("gemini"), 1000);
    assert.equal(refused.settled, true, "maxWaiters:0 must refuse at once, never park");
    assert.match(errorMessage(refused.error), /^pool saturated \(0 waiting, limit 0\)/, errorMessage(refused.error));
    assert.equal(pool.queued, 0, "nothing may be parked when the queue is disabled");
  } finally {
    await pool.close();
  }
});

// ── (1) bounded queue: waiter deadline ───────────────────────────────────────

test("GOAL83: a waiter past its deadline rejects with the NAMED queue timeout (fast, 60ms)", async () => {
  const { pool } = saturatedPool({ max: 1, maxWaiters: 4, waiterTimeoutMs: 60 });
  const started = Date.now();
  try {
    const out = await observe(pool.acquire("gemini"), 3000);
    assert.equal(out.settled, true, "the parked acquire must settle on its own deadline");
    assert.ok(out.error instanceof Error);
    const msg = errorMessage(out.error);
    assert.match(msg, /^pool queue timeout after 60ms/, `the timeout must be named with its number: ${msg}`);
    assert.ok(msg.includes('"gemini"'), `the timeout must name the site it waited for: ${msg}`);
    assert.ok(msg.includes("limit 4"), `the timeout must name the queue bound: ${msg}`);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `the deadline must actually fire (took ${elapsed}ms)`);
    assert.equal(pool.queued, 0, "a timed-out waiter is out of the queue");
  } finally {
    await pool.close();
  }
});

// ── (2) shutdown settles waiters ────────────────────────────────────────────

test("GOAL83: close() SETTLES every queued waiter (the old `this.waiters = []` drop left them pending forever)", async () => {
  const { pool } = saturatedPool({ max: 1, maxWaiters: 4, waiterTimeoutMs: 0 });
  // Two requests parked behind the busy page. waiterTimeoutMs:0 disables the
  // per-waiter deadline so ONLY close() can settle them — which is exactly the
  // case the old drop lost.
  const a = pool.acquire("gemini");
  const b = pool.acquire("gemini");
  assert.equal(pool.queued, 2, "both requests must be parked before the close");

  await pool.close();

  const [outA, outB] = await Promise.all([observe(a), observe(b)]);
  assert.equal(outA.settled, true, "close() must settle the first waiter — never leave it pending");
  assert.equal(outB.settled, true, "close() must settle the second waiter — never leave it pending");
  for (const out of [outA, outB]) {
    assert.ok(out.error instanceof Error, "a dropped-on-shutdown waiter is refused with a named cause");
    assert.match(errorMessage(out.error), /^pool closed \(daemon shutdown\)/, `close must name the cause: ${errorMessage(out.error)}`);
    assert.match(errorMessage(out.error), /2 queued request\(s\) rejected/, "close must name how many requests it refused");
  }
  assert.equal(pool.queued, 0, "no waiter may survive close()");
});

test("GOAL83: a waiter already handed a page is never rejected afterwards", async () => {
  const { pool, worker } = saturatedPool({ max: 1, maxWaiters: 4, waiterTimeoutMs: 50 }, liveDriver());
  try {
    const parked = pool.acquire("gemini");
    // release() -> drainWorker(): the freed page goes to the parked request, and
    // the waiter must be settled by delivery, NOT by its (now cancelled)
    // deadline.
    await pool.release(worker);
    const out = await observe(parked, 1000);
    assert.equal(out.settled, true);
    assert.equal(out.error, undefined, `a served waiter must resolve, not reject: ${errorMessage(out.error)}`);
    assert.equal(out.value?.profileId, "gemini", "the freed page must be reused (drainWorker semantics intact)");
    assert.equal(pool.queued, 0, "a delivered waiter leaves the queue");
    // Past its 50ms deadline nothing may fire against the served request.
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(pool.queued, 0);
  } finally {
    await pool.close();
  }
});

// ── (2) drain settles waiters ────────────────────────────────────────────────

test("GOAL83: drain() settles a queued waiter with a NAMED cause when no page can be acquired (never pending)", async () => {
  // profiles:[] makes the fresh-page acquisition fail immediately and honestly
  // (`unknown site: gemini`, before any browser work) — no browser is launched.
  const { pool, worker } = saturatedPool({ max: 1, maxWaiters: 4, waiterTimeoutMs: 0 });
  const a = pool.acquire("gemini");
  const b = pool.acquire("gemini");
  assert.equal(pool.queued, 2, "both requests must be parked before the discard");

  // The real discard path: release() finds the page unusable, drops it, and
  // calls drain() to serve the head waiter with a fresh page.
  await pool.release(worker);
  const outA = await observe(a, 1000);
  assert.equal(outA.settled, true, "drain must settle the head waiter — the old `() => undefined` left it pending forever");
  assert.ok(outA.error instanceof Error, "a waiter drain cannot serve is refused with a named cause");
  assert.match(errorMessage(outA.error), /unknown site: gemini/, `drain must name the cause: ${errorMessage(outA.error)}`);

  // The second waiter settles the same way — nothing is dropped in the queue.
  await pool.release(worker);
  const outB = await observe(b, 1000);
  assert.equal(outB.settled, true, "drain must settle every waiter it serves-or-refuses, never drop one");
  assert.match(errorMessage(outB.error), /unknown site: gemini/, errorMessage(outB.error));

  assert.equal(pool.queued, 0, "the queue is empty after both drains — nothing left pending");
  await pool.close();
  assert.equal(pool.queued, 0);
});

test("GOAL83: pool status exposes the queue depth and its bound (saturation is visible, not invisible)", async () => {
  const { pool } = saturatedPool({ max: 1, maxWaiters: 3, waiterTimeoutMs: 0 });
  try {
    const parked = pool.acquire("gemini");
    const st = pool.status;
    assert.equal(st.queued, 1, "status must report the parked request");
    assert.equal(st.maxWaiters, 3, "status must report the bound it is held to");
    await pool.close();
    await observe(parked);
  } finally {
    await pool.close();
  }
});

// ── (3) request deadline over the wire ──────────────────────────────────────

test("GOAL83: a work route past the aggregate deadline answers a NAMED 504 exactly once, and the daemon lives", async () => {
  // profiles:[] → the pool warms nothing and no browser is ever launched. The
  // deadline is raced by a request body that trickles in past it, so the route
  // is genuinely still awaiting when the deadline elapses.
  const dir = mkdtempSync(join(tmpdir(), "u2a-deadline-"));
  const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: dir, profiles: [], requestTimeoutMs: 60 });
  try {
    const body = JSON.stringify({ model: "deepseek", messages: [{ role: "user", content: "hi" }] });
    const head = body.slice(0, 20);
    const tail = body.slice(20);
    const response = await new Promise<{ status: number; payload: string }>((resolve, reject) => {
      const hangup = setTimeout(() => reject(new Error("no response at all — the socket hung instead of answering the deadline")), 5000);
      hangup.unref?.();
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: svc.port,
          method: "POST",
          path: "/v1/chat/completions",
          headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
        },
        (res) => {
          clearTimeout(hangup);
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (c) => {
            raw += c;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, payload: raw }));
        }
      );
      req.on("error", () => undefined); // the server may hang up on the still-uploading body
      req.write(head);
      setTimeout(() => req.end(tail), 400); // the body outlives the 60ms deadline
    });

    assert.equal(response.status, 504, `an over-deadline request must answer 504, not hang: ${response.payload}`);
    const out = JSON.parse(response.payload) as { error?: { code?: string; message?: string } };
    assert.equal(out.error?.code, "request_timeout", `the refusal must be named: ${response.payload}`);
    assert.match(out.error?.message ?? "", /request timeout after 60ms/, "the message must name the limit");
    assert.match(out.error?.message ?? "", /UI2API_REQUEST_TIMEOUT_MS/, "the message must name the knob");

    // The late handler (its body finally arrived) must not double-write and must
    // not take the daemon down: the next request is served normally.
    const health = await fetch(`http://127.0.0.1:${svc.port}/health`);
    assert.equal(health.status, 200, "the daemon survives a deadline that races an in-flight request");
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GOAL83: the real /v1 surface is byte-compatible on the happy path (models list + both 404 layers)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2api-v1-"));
  const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: dir, profiles: [] });
  try {
    const models = await fetch(`http://127.0.0.1:${svc.port}/v1/models`);
    assert.equal(models.status, 200);
    const listed = (await models.json()) as { object: string; data: unknown[] };
    assert.equal(listed.object, "list", "GET /v1/models keeps its OpenAI shape");
    assert.ok(Array.isArray(listed.data), "GET /v1/models keeps its data[] array");

    // GOAL 81 terminal fallback inside /v1 — still a named 404, never a hang.
    const embeddings = await fetch(`http://127.0.0.1:${svc.port}/v1/embeddings`, { method: "POST", body: "{}" });
    assert.equal(embeddings.status, 404);
    const emb = (await embeddings.json()) as { error: { code: string } };
    assert.equal(emb.error.code, "not_found", "the /v1 terminal 404 fallback still answers");

    // GOAL 81 native fallback for everything outside /v1.
    const native = await fetch(`http://127.0.0.1:${svc.port}/nope`);
    assert.equal(native.status, 404);
    assert.deepEqual(await native.json(), { error: "not found" }, "the native 404 body is unchanged");
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (6) the pacing/queue boundary — the anti-vacuity pin ─────────────────────
//
// WHY THIS EXISTS. `acquire()` used to open with `await this.paceSite(siteId)`.
// That put an async boundary ABOVE every capacity and queue decision, and it
// silently broke four GOAL 83 pins here plus two GOAL 87 pins in
// test/status-honesty.test.ts — all at the DEFAULT 1500ms site floor, all while
// the pool was doing nothing wrong. The visible symptom was always a NUMBER
// (`queued` 0 !== 1, or `pool_queue_timeout` where `pool_saturated` was
// promised), which is why it read as a flaky test rather than a broken contract.
//
// The property under test is BEHAVIOUR: a request that must park is PARKED IN
// THE SAME TURN the caller asked for it, and a full queue refuses with
// `pool_saturated` rather than waiting out the site floor first. Both are
// asserted here against a pool whose pacing floor is deliberately the DEFAULT
// (no env override, no `paced:false` escape hatch) — so if the floor is ever
// hoisted back above the queue registration, this goes RED instead of rotting.
test("the pacing floor must not sit above queue registration (saturation stays visible)", async () => {
  // No env override and no opt-out: this must hold at whatever the operator's
  // real floor is, which is exactly the condition the GOAL 83 pins broke under.
  assert.ok(
    siteRateLimitMs("gemini") > 0,
    "this pin is only meaningful with a NON-ZERO site floor — if the floor is 0 the bug cannot reproduce"
  );
  const { pool } = saturatedPool({ max: 1, maxWaiters: 1, waiterTimeoutMs: 60_000 });
  try {
    // (a) The parked request is visible SYNCHRONOUSLY — no tick, no await.
    // `observe` (not a bare call) so the eventual close-rejection of this
    // promise is CONSUMED rather than surfacing as an unhandledRejection that
    // node escalates to a file-level failure after the test body has ended.
    const parked = observe(pool.acquire("gemini"));
    assert.equal(pool.queued, 1, "a parked request must be registered in the SAME TURN acquire() was called");

    // (b) A full queue refuses with the saturation code IMMEDIATELY. If the
    // floor were above this check, the first waiter's deadline would vacate the
    // queue before this ran and the answer would be a queue-timeout instead.
    const refused = await Promise.race([
      observe(pool.acquire("gemini"), 1000),
      // Hard backstop: even if the floor is hours, this test must not hang.
      new Promise<{ settled: boolean }>((r) => setTimeout(() => r({ settled: false }), 1200)),
    ]);
    assert.equal(refused.settled, true, "a full queue must refuse without waiting out the pacing floor");
    assert.match(
      errorMessage((refused as { error?: unknown }).error),
      /^pool saturated \(1 waiting, limit 1\)/,
      "a full queue must answer pool_saturated, never a pacing-delayed queue timeout"
    );

    // The parked request is settled by close() with the named shutdown cause.
    await pool.close();
    const settledParked = await parked;
    assert.equal(settledParked.settled, true, "close() must settle the parked request, never leave it pending");
    assert.match(errorMessage(settledParked.error), /^pool closed \(daemon shutdown\)/, errorMessage(settledParked.error));
  } finally {
    await pool.close();
  }
});
