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
