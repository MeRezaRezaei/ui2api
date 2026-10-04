// The BACKPRESSURE + AUTH-TRUTH contract: the pool's queue bounds and the
// daemon's auth gate, both of which had never been exercised under load, and
// neither of which any existing gate covered.
//
// WHY THIS FILE EXISTS. Five knobs are documented as the pool's backpressure
// controls (AGENTS.md, the `UI2API_*` table). A knob nothing reads cannot be
// reasoned about, and a knob read once in a constructor is not a control — it
// is a constant. Before this file, nothing asserted that any of the five is
// read AT ALL: `test/env-knob-truth.test.ts` only requires a knob NAME to
// appear in a doc file, and `test/ci-contract-knob-cites.test.ts` reads the
// doc TABLE's `read at` column, not the code. A knob deleted from the code but
// left in the table passed both. So this file resolves every documented pool
// knob to a REAL read site in `src/` and fails on a knob with no read site.
//
// WHAT IS DELIBERATELY NOT ASSERTED — and this is the point of the file:
//   * No concurrency number. "Handles 50", "max is 4", "16 waiters" are
//     MEASUREMENTS OF ONE BOX, not properties. `max` is derived from
//     `freemem()` at construction time and `min`/`maxWaiters` are operator
//     inputs; pinning their values would rot the instant the box changes or
//     anyone sets the knob. What is asserted is the SHAPE of the bound — that
//     each is finite, that the cap is consulted before a spawn, and that the
//     queue is bounded — which is what makes backpressure a guarantee rather
//     than an observation.
//   * No live-service assertion. Nothing here curls the running daemon. The
//     gate is a statement about the CODE, and stays green whether or not a
//     daemon is up, which is the only way it can be a gate at all.
//
// TWO TRUTHS PINNED THAT THE DOCS GET LOOSY ON:
//   1. The reaper is a DEAD-PAGE health sweep, not an idle-page reaper. It
//      evicts only pages `isWorkerUsable()` reports dead; a healthy idle page
//      is `continue`d past. There is no idle-age field on a worker, so idle
//      age is not even observable. AGENTS.md's "idle-page reaper" wording is
//      the loose part; the sweep's own `note` field ("swept N idle page(s),
//      none dead") describes it accurately. This test pins the real behaviour
//      so the doc cannot be read as promising eviction-by-age.
//   2. The auth gate is FAIL-OPEN by design when no token is set: the check
//      is `if (token && ...)`, so an unset `UI2API_PROMPTD_TOKEN` skips the
//      gate entirely and loopback is enforced ONLY by the bind address. That
//      is a legitimate design, but it is a property a reader must not have to
//      reverse-engineer, so the shape is asserted here.
//
// ALREADY COVERED ELSEWHERE (not duplicated): test/env-knob-truth.test.ts
// (knob name present in docs); test/ci-contract-knob-cites.test.ts (the doc
// table's `read at` cites point at real files); test/posture-*.test.ts
// (posture REPORT contents). This file covers the missing third question —
// does the CODE actually read the knob.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";

import { startPromptd, CAPABILITY_MAX_INFLIGHT, admitCapability } from "../src/prompt/http.js";
import { consumerPoolRefusal } from "../src/prompt/consumer-surface.js";
import { ChatPool } from "../src/prompt/pool.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOL = readFileSync(join(ROOT, "src/prompt/pool.ts"), "utf8");
const HTTP = readFileSync(join(ROOT, "src/prompt/http.ts"), "utf8");
const CLI = readFileSync(join(ROOT, "src/cli.ts"), "utf8");

/** 1-based line number of the first line matching `re`, or -1. */
function lineOf(haystack: string, re: RegExp): number {
  const lines = haystack.split("\n");
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return -1;
}

/** Every 1-based line number matching `re`. */
function linesOf(haystack: string, re: RegExp): number[] {
  const out: number[] = [];
  haystack.split("\n").forEach((l, i) => {
    if (re.test(l)) out.push(i + 1);
  });
  return out;
}

// ---------------------------------------------------------------------------
// The five documented backpressure knobs -> the read site that backs each.
// The FILE is the pin; the LINE is resolved at run time, because a strict
// `line ===` pin over a constructor that every unrelated edit re-flows trains
// the next maintainer to ignore the gate.
// ---------------------------------------------------------------------------
const POOL_KNOBS = [
  { knob: "UI2API_POOL_MAX", file: "src/prompt/pool.ts", read: /process\.env\.UI2API_POOL_MAX\b/ },
  { knob: "UI2API_POOL_MIN", file: "src/prompt/pool.ts", read: /process\.env\.UI2API_POOL_MIN\b/ },
  { knob: "UI2API_POOL_MAX_WAITERS", file: "src/prompt/pool.ts", read: /envCount\(\s*"UI2API_POOL_MAX_WAITERS"/ },
  { knob: "UI2API_POOL_WAITER_TIMEOUT_MS", file: "src/prompt/pool.ts", read: /envCount\(\s*"UI2API_POOL_WAITER_TIMEOUT_MS"/ },
  { knob: "UI2API_REAPER_INTERVAL_MS", file: "src/prompt/pool.ts", read: /envCount\(\s*"UI2API_REAPER_INTERVAL_MS"/ },
] as const;

test("every documented pool knob is READ by the code, not merely documented", () => {
  // ANTI-VACUITY. A knob table that silently emptied would make the loop below
  // vacuously true, so the list is asserted non-empty AND each entry is
  // asserted to have actually resolved a line.
  assert.ok(POOL_KNOBS.length > 0, "the pool-knob table is empty — this gate is vacuous");

  const dead: string[] = [];
  const resolved: string[] = [];
  for (const { knob, read } of POOL_KNOBS) {
    const line = lineOf(POOL, read);
    if (line < 0) {
      dead.push(`${knob} (read site ${read} not found in pool.ts)`);
      continue;
    }
    resolved.push(`${knob} -> src/prompt/pool.ts:${line}`);
  }
  assert.deepEqual(dead, [], `documented pool knobs nothing reads: ${dead.join(", ")}`);
  // Every knob resolved to a real line — this is what makes the loop above
  // non-vacuous, and the list is printed so a reader can jump straight to it.
  console.log(`pool knob read sites (${resolved.length}):\n  ${resolved.join("\n  ")}`);
});

test("the pool's queue bounds are consulted as BOUNDS, not left unbounded", () => {
  // The refusal must be a comparison against the configured bound, evaluated
  // BEFORE a page is spawned, or a burst spawns a page per request and the
  // bound is decorative. Assert the SHAPE (bounded, pre-spawn) — never the
  // number, which is a property of this box and this operator.
  const capLine = lineOf(POOL, /this\.workers\.length \+ this\.spawning < this\.max\b/);
  const refuseLine = lineOf(POOL, /this\.waiters\.length >= this\.maxWaiters\b/);
  assert.ok(capLine > 0, "the pre-spawn capacity check is gone: the max cap no longer bounds anything");
  assert.ok(refuseLine > 0, "the queue-full refusal is gone: over-capacity requests no longer fail fast");
  assert.ok(
    refuseLine > capLine,
    `the queue-full refusal (pool.ts:${refuseLine}) now sits BEFORE the capacity check ` +
      `(pool.ts:${capLine}); past capacity a request must park in a BOUNDED queue, not spawn`
  );
  // The refusal is a named, machine-readable class, not a bare throw.
  assert.match(POOL, /POOL_REFUSAL_CODES\.pool_saturated/, "pool_saturated refusal code is gone");
  assert.match(POOL, /POOL_REFUSAL_CODES\.pool_queue_timeout/, "pool_queue_timeout refusal code is gone");
  // The waiter deadline is real: a parked request is bounded in TIME too, and
  // the timer is unref'd so it can never hold the daemon open.
  assert.match(POOL, /this\.waiterTimeoutMs > 0/, "parked waiters are no longer time-bounded");
  assert.match(POOL, /waiter\.timer\.unref\?\.\(\)/, "the waiter deadline timer is not unref'd");
});

test("the reaper is a DEAD-PAGE health sweep, not an idle-page reaper", () => {
  // The honest shape: a page is only evicted when `isWorkerUsable` says it is
  // NOT usable; a healthy idle page is skipped. This test exists so the
  // "idle-page reaper" wording in AGENTS.md can never again be read as
  // promising eviction-by-idle-age.
  const usableLine = lineOf(POOL, /const usable = await isWorkerUsable\(/);
  const skipLine = lineOf(POOL, /if \(usable\) continue;/);
  assert.ok(usableLine > 0, "the sweep no longer probes worker usability");
  assert.ok(
    skipLine > 0 && skipLine > usableLine,
    "a healthy page is no longer skipped by the sweep — idle-age eviction is absent, and this pins that"
  );

  // No idle-age field exists on a worker, so idle age is not even observable
  // to the sweep. If one is ever added, this fails and the doc must be updated
  // to match the new behaviour rather than the other way round.
  const idleAge = /idleSince|idleFor|idleAge|lastIdleAt/;
  assert.equal(lineOf(POOL, idleAge), -1, "pool.ts gained an idle-age field; the reaper's behaviour must be re-audited");
});

test("the reaper timer is explicit, bounded, unref'd and cleared on close", () => {
  // A bare module-level setInterval would outlive the daemon and hold the
  // process open — the reason the timer is pool-owned.
  assert.match(HTTP, /startReaper\(/, "the daemon no longer starts the reaper explicitly");
  assert.match(POOL, /this\.reaperTimer\.unref\?\.\(\)/, "the reaper timer is not unref'd");
  assert.match(POOL, /stopReaper\(\)/, "the reaper is never stopped");
  // `0` is an honest opt-out and the interval is a finite default, so the
  // sweep can neither spin unbounded nor be disabled silently.
  const defLine = lineOf(POOL, /const DEFAULT_REAPER_INTERVAL_MS = \d[\d_]*;/);
  assert.ok(defLine > 0, "the reaper has no finite default interval");
  assert.match(POOL, /if \(this\.reaperMs <= 0\) return false;/, "`reaper interval 0` no longer disables the sweep");
});

test("the daemon binds loopback and offers no CLI route to widen it", () => {
  // The bind is the ONLY thing holding the unauthenticated daemon off the
  // network when no token is set, so the default and its reachability matter.
  const bindLine = lineOf(HTTP, /const bindAddr = opts\.host \?\? "127\.0\.0\.1"/);
  assert.ok(bindLine > 0, `startPromptd no longer defaults its bind to 127.0.0.1 (checked src/prompt/http.ts)`);
  // `cmdPromptd` is the only supported way to run the daemon; if it never
  // forwards a `host`, the loopback default cannot be widened from the CLI.
  assert.equal(
    lineOf(CLI, /--host/),
    -1,
    "the CLI now parses a --host flag; the loopback bind is no longer the only reachable posture"
  );
  assert.match(CLI, /UI2API_HUB_BIND|UI2API_PROMPTD_PORT/, "expected the daemon port/hub bind knobs to still be declared");
});

test("the auth gate fails CLOSED when a token is set and is applied before every handler", () => {
  // Applied before the routing branches, or an unauthenticated caller reaches
  // a handler body that has already done work.
  const gateLine = lineOf(HTTP, /if \(token && req\.headers\.authorization !== `Bearer \$\{token\}`\)/);
  assert.ok(gateLine > 0, "the bearer gate is gone from the request handler");
  // Anchored to the real dispatch form (`req.url === "/x"`), NOT a bare string
  // match: a bare `/\/sites/` also hits an import or a comment, and a gate that
  // fires on legitimate content is worse than no gate.
  for (const route of [
    /req\.url === "\/sites"/,
    /req\.url === "\/registry"/,
    /req\.url === "\/status"/,
    /req\.url === "\/health"/,
    /req\.url === "\/requests"/,
    /req\.url === "\/requirements"/,
  ]) {
    const routeLine = lineOf(HTTP, route);
    assert.ok(routeLine > 0, `expected route ${route} to exist in http.ts`);
    assert.ok(
      routeLine > gateLine,
      `route ${route} (http.ts:${routeLine}) is registered BEFORE the auth gate (http.ts:${gateLine}) — ` +
        `an unauthenticated caller would reach its handler body`
    );
  }
  // The token is read from the documented knob and defaults to EMPTY, which is
  // the fail-open posture: with no token the gate is skipped entirely and only
  // the bind protects the daemon. That is a design choice, so it is pinned
  // here rather than left for a reader to infer from `if (token && ...)`.
  assert.match(HTTP, /process\.env\[TOKEN_ENV\] \?\? ""/, "the token default changed; re-audit the no-token posture");
  // A 401 is the refusal, and it is emitted before any browser or vault work.
  assert.match(HTTP, /return send\(res, 401, \{ error: "unauthorized" \}\)/, "an unauthenticated request no longer 401s");
});

// ===========================================================================
// GOAL 231 — THE CAPABILITY ROUTE'S ADMISSION CONTROL.
//
// `/prompt` was bounded (`pool.acquire` -> park, or `pool_saturated`); the
// capability route was not. `pool.sharedBrowser()` is a bare `ensureBrowser()`
// with no queue and no cap, and the 20 `shared: false` dispatch rows construct
// their runner with `browser: undefined`, so the runner launches its OWN Chrome
// — N concurrent requests meant N browsers, and the aggregate 504 cannot cancel
// browser work (it only SENDS the 504). What makes that more than a generic DoS
// is AGENTS.md's own record that an abuse challenge against a REAL logged-in
// account is unrecoverable, so exhausting the box burns the operator's account.
//
// The gate below is over the WIRE (a real daemon, a real socket), because the
// claim being made is about a leaked counter, and no source-shape assertion can
// demonstrate that a slot comes back. Two facts are pinned: the honest 503 at
// the ceiling, and — the one that matters — that the route is NOT permanently
// wedged afterwards.
//
// NO BROWSER IS LAUNCHED anywhere here. The daemon is handed a pre-built pool
// through the GOAL-87 `pool` seam (never acquired, so never opened), and the
// site driven is `google-ai-search`, whose runner is a `loginGatedResult`
// short-circuit that answers WITHOUT a browser. Slots are held by stalling a
// request's own body upload — a real way a local caller occupies the route, and
// the reason admission is taken before the body is read.

type Wire = { status: number; body: Record<string, unknown> | null; dead?: string };

/** One complete request, answered off the wire. A hang is a NAMED failure. */
function call(port: number, path: string, body: unknown): Promise<Wire> {
  return new Promise((resolve) => {
    const raw = Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json", "content-length": String(raw.length) } },
      (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => {
          let parsed: unknown = null;
          try { parsed = d ? JSON.parse(d) : null; } catch { /* keep null */ }
          resolve({ status: r.statusCode ?? 0, body: parsed as Record<string, unknown> | null });
        });
      },
    );
    req.setTimeout(30_000, () => { req.destroy(); resolve({ status: 0, body: null, dead: "probe-timeout" }); });
    req.on("error", (e: Error & { code?: string }) => resolve({ status: 0, body: null, dead: e.code ?? e.message }));
    req.end(raw);
  });
}

/** A request whose body STALLS: headers + a partial body flushed, content-length
 *  promising more. The server holds it inside `readJson`, and — since admission
 *  is taken first — it holds a capability slot for as long as the test keeps it. */
function stall(port: number, path: string, full: unknown) {
  const raw = Buffer.from(JSON.stringify(full));
  let resolveStatus: (w: Wire) => void = () => {};
  const done = new Promise<Wire>((resolve) => { resolveStatus = resolve; });
  const req = httpRequest(
    { host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json", "content-length": String(raw.length) } },
    (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => {
        let parsed: unknown = null;
        try { parsed = d ? JSON.parse(d) : null; } catch { /* keep null */ }
        resolveStatus({ status: r.statusCode ?? 0, body: parsed as Record<string, unknown> | null });
      });
    },
  );
  req.setTimeout(30_000, () => { req.destroy(); resolveStatus({ status: 0, body: null, dead: "stalled-probe-timeout" }); });
  req.on("error", (e: Error & { code?: string }) => resolveStatus({ status: 0, body: null, dead: e.code ?? e.message }));
  // The first byte flushes the headers; the server then waits for `raw.length`
  // bytes that never arrive until `finish()` below.
  req.write(raw.subarray(0, Math.max(1, Math.floor(raw.length / 2))));
  return { finish: () => { req.end(raw.subarray(Math.max(1, Math.floor(raw.length / 2)))); }, done };
}

const CAP_PATH = "/capability/google-ai-search";
const CAP_BODY = { capability: "google_ai_mode_search" };

test("the capability route refuses at its ceiling with the honest pool_saturated 503, then gives every slot back", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-admission-"));
  // A pre-built pool that is NEVER acquired: no warm at boot, no browser, ever.
  const pool = new ChatPool({ profiles: [], min: 1, max: 1, defaultProfile: "deepseek", dataDir });
  const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir, pool });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const held = Array.from({ length: CAPABILITY_MAX_INFLIGHT }, () => stall(svc.port, CAP_PATH, CAP_BODY));

    // PROBE until the route reports saturation. Polled rather than slept-on, so
    // the assertion cannot race the daemon's own admission: the gate is "a
    // probe is eventually refused", not "a probe after N ms is refused".
    let over: Wire | null = null;
    for (let i = 0; i < 60 && !over; i++) {
      const probe = await call(svc.port, CAP_PATH, CAP_BODY);
      if (probe.status === 503) over = probe;
      else await sleep(25);
    }
    assert.ok(over, `the capability route never refused: ${CAPABILITY_MAX_INFLIGHT} concurrent requests were all admitted`);
    assert.equal(over!.status, 503, `saturation must be a 503, got ${over!.status}`);
    // The EXISTING shape: the same `{error:{code,message}}` a pool refusal
    // produces through poolRefusal + consumerPoolRefusal. Compared against the
    // owner, not a literal, so a reword cannot make this gate pass or fail on
    // wording alone.
    assert.deepEqual(over!.body, { error: { code: "pool_saturated", message: consumerPoolRefusal("pool_saturated") } });
    // Every held request is still genuinely in flight, not silently refused.
    assert.ok(held.every((h) => h.done instanceof Promise), "the stalled requests lost their answers");

    // THE IMPORTANT HALF: settle the in-flight requests and prove the counter
    // came back. A leaked slot is worse than no cap — it wedges the route for
    // every later caller — so this is asserted over the wire, not by reading the
    // counter.
    for (const h of held) h.finish();
    const settled = await Promise.all(held.map((h) => h.done));
    settled.forEach((w, i) => {
      assert.ok(!w.dead, `held request ${i} died instead of settling: ${w.dead}`);
      assert.notEqual(w.status, 503, `held request ${i} was refused instead of served: ${w.status}`);
    });

    const after = await call(svc.port, CAP_PATH, CAP_BODY);
    assert.notEqual(after.status, 503, "the route stayed wedged after its in-flight requests settled — the counter leaked");
    assert.ok(!after.dead, `the post-settle probe died: ${after.dead}`);
    // The answer is the runner's honest login-gated refusal (502 ok:false), which
    // is what this browser-free site really does — NOT a fabricated ok:true.
    assert.equal(after.status, 502);
    assert.equal(after.body?.ok, false);
    assert.equal(after.body?.loginGated, true);
  } finally {
    await svc.close();
    await pool.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("`/prompt` is untouched by the capability admission control", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-admission-prompt-"));
  const pool = new ChatPool({ profiles: [], min: 1, max: 1, defaultProfile: "deepseek", dataDir });
  const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir, pool });
  try {
    // The /prompt branch answers BEFORE any pool work for both of these, so
    // they need no browser and they are the route's own refusals, unchanged.
    const empty = await call(svc.port, "/prompt", { site: "deepseek" });
    assert.equal(empty.status, 400);
    assert.equal(empty.body?.error, "prompt is required");

    const unknown = await call(svc.port, "/prompt", { site: "no-such-site", prompt: "hi" });
    assert.equal(unknown.status, 400, "/prompt must still answer its own site guard, not the capability cap");

    // And the pool seam that already bounded it is still in place — the cap was
    // added to the OTHER route rather than by weakening this one.
    assert.match(HTTP, /const worker = await pool\.acquire\(profile\.id, account\);/, "/prompt no longer takes its page from the bounded pool");
  } finally {
    await svc.close();
    await pool.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the admission helper cannot leak a slot, and a double release cannot un-bound the cap", () => {
  const state = { inFlight: 0 };
  const taken = Array.from({ length: CAPABILITY_MAX_INFLIGHT }, () => admitCapability(state));
  assert.ok(taken.every((t) => typeof t === "function"), "the ceiling refused below its own value");
  assert.equal(admitCapability(state), null, "the ceiling did not refuse AT its own value");
  assert.ok(CAPABILITY_MAX_INFLIGHT >= 8, "the ceiling must sit above the pool's own page ceiling (max <= 4) so /prompt concurrency is never refused here");

  // Release twice: the counter must land on 0, never below it. A negative
  // counter admits without bound — the failure this cap exists to prevent,
  // reached through its own release path.
  for (const release of taken) release!();
  for (const release of taken) release!();
  assert.equal(state.inFlight, 0, `a double release drove the counter off zero: ${state.inFlight}`);
  assert.ok(admitCapability(state) !== null, "the counter never came back after every slot was released");
});
