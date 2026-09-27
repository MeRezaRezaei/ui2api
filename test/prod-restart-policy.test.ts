// The recovery policy that has never been exercised.
//
// MEASURED FRICTION this file gates:
//   Across five restarts of ui2api-api, `systemctl show ui2api-api -p NRestarts`
//   printed 0. Every restart was deliberate (mine, or deploy.sh's), so
//   `Restart=always` / `RestartSec=5` — the policy that is supposed to rescue a
//   crashed service — has never actually fired once, and nobody knew it works.
//
//   And the failure it would need to catch is SILENT. With the vault owned by
//   the wrong user, GET /health answered ok:true and /v1/models served 22 models
//   for 23 minutes while every chat site failed with "requires sign-in". Four
//   failures in the journal, zero alarms. A process that is running and
//   answering is NOT a process that is working, and nothing told the difference.
//
// So the supervisor check (scripts/ops/restart-policy.sh) has to probe the
// MEANINGFUL state — /health AND /registry AND /v1/models AND the VAULT — and
// it has to distinguish healthy / degraded-but-serving / dead, and report
// NRestarts so a crash-loop is not confused with a merely-wrong service.
//
// WHY THIS FILE IS STATIC/TEXT-BASED: the gate runs on CI with no root, no
// systemd, and no ui2api service. It reads the script and asserts the seams are
// PRESENT and correctly ORDERED. It does not pretend to run the probes.
//
// ANTI-VACUITY: every predicate below is a function of the script TEXT, and the
// last two tests run those SAME predicates against deliberately mutated copies
// (vault probe deleted; dry-run default removed) and require them to FAIL. A
// pin that cannot fail is not a pin — see the mutation-red section.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/ops/restart-policy.sh");
const SRC = readFileSync(SCRIPT, "utf8");

// ------------------------------------------------------------- the seams

/** Every stateful probe the policy must make. The vault one is the measured
 *  incident: /health alone did not catch it. */
function probePaths(src: string): string[] {
  return [...src.matchAll(/^\s*(?:if\s+)?probe\s+(\w+)\s+"?([^"\s;]+)"?/gm)].map((m) => m[2]);
}

/** A probe is bounded only if the curl invocation carries --max-time. */
function probesAreBounded(src: string): boolean {
  // Only the real probe invocations (curl -sS), not the "command -v curl"
  // guard or a message that merely names curl.
  const curls = [...src.matchAll(/curl -s\S[^\n]*/g)].map((m) => m[0]);
  return curls.length > 0 && curls.every((c) => /--max-time\s+"?\$\{?[A-Za-z_]/.test(c));
}

/** The whole run is bounded: an outer `timeout` wraps the script body. */
function runIsBounded(src: string): boolean {
  return /timeout\s+-k\s+\d+\s+"?\$\{?RUN_TIMEOUT/.test(src);
}

function checksNRestarts(src: string): boolean {
  return (
    /systemctl\s+show\s+"?\$\{?SERVICE/.test(src) &&
    /NRestarts/.test(src) &&
    /CRASH-LOOP/.test(src) &&
    /MAX_RESTARTS/.test(src)
  );
}

function dryRunIsDefault(src: string): boolean {
  // APPLY must start (and stay) at 0 everywhere OUTSIDE the --apply case arm;
  // --apply is the only thing allowed to set it to 1.
  const outsideCaseArm = src.replace(/^\s*--apply\).*$/m, "");
  return (
    /\bAPPLY=0\b/.test(outsideCaseArm) &&
    !/\bAPPLY=1\b/.test(outsideCaseArm) &&
    /--apply\)\s*APPLY=1/.test(src)
  );
}

/** The restart must sit behind an `if [ "$APPLY" = 1 ]` guard, and must never
 *  appear before it. */
function restartRequiresApply(src: string): boolean {
  const guard = src.indexOf('if [ "$APPLY" = 1 ]');
  const restart = src.search(/systemctl restart/);
  return guard !== -1 && restart !== -1 && guard < restart;
}

function distinguishesThreeStates(src: string): boolean {
  return ["healthy", "degraded-but-serving", "dead", "crash-looping"].every((s) =>
    src.includes(s),
  );
}

function exitsNonzeroWhenUnhealthy(src: string): boolean {
  // A real exit code per non-healthy verdict, not a single "1".
  return /\bRC=3\b/.test(src) && /\bRC=4\b/.test(src) && /\bRC=5\b/.test(src) && /exit "\$RC"/.test(src);
}

function probesTheVault(src: string): boolean {
  const paths = probePaths(src);
  return (
    paths.some((p) => p.startsWith("/accounts")) &&
    paths.includes("/health") &&
    paths.includes("/registry") &&
    paths.includes("/v1/models")
  );
}

const PREDICATES: Array<[string, (s: string) => boolean]> = [
  ["script exists", () => existsSync(SCRIPT)],
  ["probes are timeout-bounded", probesAreBounded],
  ["the whole run is timeout-bounded", runIsBounded],
  ["reads NRestarts and reports a crash-loop", checksNRestarts],
  ["dry run is the default", dryRunIsDefault],
  ["restart requires an explicit --apply", restartRequiresApply],
  ["distinguishes healthy / degraded-but-serving / dead / crash-looping", distinguishesThreeStates],
  ["exits nonzero per non-healthy verdict", exitsNonzeroWhenUnhealthy],
  ["probes the VAULT, not just health", probesTheVault],
];

// ------------------------------------------------------------------ tests

test("restart-policy.sh exists and is bash -n clean", () => {
  assert.ok(existsSync(SCRIPT), "scripts/ops/restart-policy.sh must exist");
  execFileSync("bash", ["-n", SCRIPT], { stdio: "pipe" });
  assert.ok(existsSync(`${SCRIPT}`), "script is syntactically valid bash");
});

for (const [name, predicate] of PREDICATES) {
  test(`restart policy: ${name}`, () => {
    assert.equal(
      predicate(SRC),
      true,
      `restart-policy.sh must satisfy: ${name}`,
    );
  });
}

test("restart policy: --apply is the only mutating path (dry run mutates nothing)", () => {
  // The DRY RUN branch must say so explicitly; a supervisor that mutates on
  // inspection is not a supervisor.
  assert.match(SRC, /DRY RUN — nothing was restarted/);
  const afterGuard = SRC.slice(SRC.indexOf('if [ "$APPLY" = 1 ]'));
  assert.match(afterGuard, /systemctl restart/);
});

// ---------------------------------------------------------- mutation reds
// The proof the pin is not vacuous. Each mutation must break a predicate.

test("MUTATION RED: deleting the vault probe fails the vault predicate", () => {
  const mutated = SRC.replace(/^.*probe vault ".*$/m, "");
  assert.notEqual(probePaths(mutated).length, probePaths(SRC).length, "mutation removed the vault probe");
  assert.equal(
    probesTheVault(mutated),
    false,
    "a script with no /accounts probe must NOT satisfy the vault predicate — that is the measured 23-minute silent failure",
  );
  // And the health-only check must be visibly insufficient.
  const healthOnly = SRC.replace(/^.*probe vault ".*$/m, "").replace(/^.*probe registry ".*$/m, "");
  assert.equal(probePaths(healthOnly).includes("/health"), true);
  assert.equal(probePaths(healthOnly).some((p) => p.startsWith("/accounts")), false);
});

test("MUTATION RED: removing the dry-run default fails the dry-run predicate", () => {
  const mutated = SRC.replace(/^APPLY=0$/m, "APPLY=1");
  assert.equal(
    dryRunIsDefault(mutated),
    false,
    "a script that starts APPLY=1 is a supervisor that restarts on inspection — must fail",
  );
  // ...and the un-guarded restart must fail its own predicate too.
  const unguarded = SRC.replace(/if \[ "\$APPLY" = 1 \]/, "if [ 1 = 1 ]");
  assert.equal(restartRequiresApply(unguarded), false, "an ungated restart must fail");
});

test("MUTATION RED: removing the NRestarts read fails the crash-loop predicate", () => {
  const mutated = SRC.replace(/systemctl show[^\n]*NRestarts[^\n]*/, "# removed");
  assert.equal(checksNRestarts(mutated), false, "a script that never reads NRestarts must fail");
});

test("MUTATION RED: removing the per-probe --max-time fails the bounded-probe predicate", () => {
  const mutated = SRC.replace(/--max-time\s+"?\$\{?PROBE_TIMEOUT"?\s*/, "");
  assert.equal(probesAreBounded(mutated), false, "an unbounded probe must fail");
});
