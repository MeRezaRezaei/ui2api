// GOAL 86 (2026-09-25): the session-lock HONESTY gate — the vault's own
// readiness claim, made falsifiable.
//
// `capabilities/<site>/session.lock.json` is committed metadata: it declares a
// snapshot path, a sha256 prefix, a cookie count and a NAMED localStorage
// sample. Before this gate NOTHING verified a lock against its snapshot, so the
// claim was unfalsifiable — and MEASURED, gemini's was false on BOTH checkable
// fields (declared sha256 2d2095c4b6369d9f / 23 cookies described the LEGACY
// flat snapshot while the declared path pointed at the 2-cookie vault account)
// while every other lock passed.
//
// What this gate pins:
//   1. every lock WITH a checkable snapshot passes hash + cookie count;
//   2. every lock file on disk lands in exactly one bucket (checked / skipped /
//      failed) with a NAMED skip reason — a gate that silently ignores packages
//      is the failure mode the repo forbids, so the accounting is asserted;
//   3. `localStorageKeys` is a deliberate SAMPLE (4-7 named keys out of 18-36
//      real ones) and is NEVER gated as a count — gating it would
//      false-positive on every site;
//   4. the gate has been SEEN TO FAIL: a scratch fixture in a temp dir with a
//      deliberately wrong hash + wrong cookie count is driven through the SAME
//      exported logic and must fail with the named reasons. No real package's
//      lock is ever mutated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  listSessionLockPaths,
  sessionLockResultFor,
  sha256File,
  verifyCapabilitySessionLocks,
  verifySessionLock,
  type SessionLockReport,
} from "../src/runtime/session-lock.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Human-readable census, printed by the positive test so every site the gate
 *  touched is named in the output — checked AND skipped-with-reason. */
function census(report: SessionLockReport): string {
  const lines: string[] = [];
  lines.push(`session-lock census: ${report.details.length} lock file(s) — ${report.checked.length} CHECKED, ${report.skipped.length} SKIPPED (named), ${report.failures.length} FAILURE(S)`);
  for (const d of report.details) {
    if (d.checked) {
      lines.push(`  CHECKED ${d.site} (${d.declaredHost ?? "no host"}) <- ${d.snapshotPath}`);
      for (const c of d.claims) lines.push(`      ${c.status === "pass" ? "ok  " : "skip"} ${c.field}: ${c.detail}`);
    } else {
      const why = report.skipped.find((s) => s.site === d.site)?.reason ?? "(no named reason — BUG)";
      lines.push(`  SKIPPED ${d.site} (${d.declaredHost ?? "no host"}) :: ${why}`);
    }
  }
  for (const f of report.failures) lines.push(`  FAILED  ${f.site} :: ${f.reason}`);
  return lines.join("\n");
}

test("session locks: every lock with a checkable snapshot passes hash + cookie count, and every lock is accounted for with a named reason", () => {
  const report = verifyCapabilitySessionLocks();
  console.log(census(report));

  // The positive claim, stated as an assertion and not as a comment: no committed
  // lock may carry a claim that was measured and found false.
  assert.deepEqual(report.failures, [], `session-lock claims measured false:\n${report.failures.map((f) => f.reason).join("\n")}`);
  assert.equal(report.ok, true);

  // Non-vacuity: the gate is not passing because it looked at nothing. On a box
  // that holds the captures, the locks that declare a snapshot ARE checked; on a
  // box that does not, they are all NAMED skips. Both are accounted for here, so
  // this holds on every machine.
  const lockFiles = listSessionLockPaths();
  assert.ok(lockFiles.length > 0, "no session.lock.json files found — the gate would be vacuous");
  assert.equal(report.details.length, lockFiles.length, "every lock file must produce a detail (never silently ignored)");
  const seen = [...report.checked, ...report.skipped.map((s) => s.site)];
  assert.equal(seen.length, report.details.length, "every lock must land in exactly ONE bucket (checked XOR skipped)");
  assert.equal(new Set(seen).size, seen.length, "no lock may be double-counted across buckets");

  // Every skip carries a NAMED reason (never a bare "skipped"), and the reason
  // is specific enough to act on.
  for (const s of report.skipped) {
    assert.ok(s.reason.length > 20, `skip for ${s.site} has no named reason: "${s.reason}"`);
    assert.match(s.reason, /session\.lock\.json|declared|claim|available/, `skip reason for ${s.site} is not specific: "${s.reason}"`);
  }

  // The SKIP-with-reason proof: the 29 claim-free locks (a lock that declares no
  // snapshot path makes no snapshot claim) must be REPORTED, never silently
  // dropped. Pinned by shape, not by a hardcoded count, so a future package
  // cannot quietly join the skipped set unnoticed.
  const claimFree = report.skipped.filter((s) => /no snapshot path declared/.test(s.reason));
  assert.ok(claimFree.length > 0, "expected the claim-free locks to report a named skip reason");
  for (const s of claimFree) assert.match(s.reason, /nothing to verify, not a pass/);

  // Every measured claim really was measured: a checked site has at least one
  // pass claim naming the snapshot it read.
  for (const d of report.details.filter((x) => x.checked)) {
    assert.ok(d.claims.some((c) => c.status === "pass"), `${d.site} was counted as checked with no measured claim`);
  }
});

test("session locks: the doctor's per-package verdict is pass on a verified lock, and a skip (never a pass) when uncheckable", () => {
  const report = verifyCapabilitySessionLocks();

  // A lock that was measured carries a pass verdict with the measured evidence.
  //
  // GOAL 146: this USED to assert `report.checked[0]` exists, which made the test
  // depend on the OPERATOR'S CAPTURED VAULT — `data/` is gitignored, so a clean CI
  // checkout has none and the test failed there on every run. Proven by hiding the
  // vault locally, which reproduced CI's exact `expected at least one measured
  // lock` failure. A test may not require machine state that the repository
  // deliberately does not carry.
  //
  // What is asserted instead is the property that is ALWAYS true — a measured
  // lock reads `pass` with its evidence, and a lock with no vault reads `skip`
  // with a NAMED reason (never a silent default). On a box WITH sessions the
  // first branch runs for real; on a bare runner it is vacuously satisfied and
  // the skip branch is what carries the weight.
  for (const checked of report.checked) {
    const okResult = sessionLockResultFor(checked, report);
    assert.equal(okResult.status, "pass", `expected pass for ${checked}, got ${okResult.status}: ${okResult.reason ?? ""}`);
    assert.match(okResult.detail ?? "", /session lock verified against/);
  }
  // Non-vacuity that does not need a vault: every declared package is accounted
  // for as either measured or skipped — never silently dropped.
  assert.equal(
    report.checked.length + report.skipped.length,
    report.details.length,
    "every capability package must appear as checked or skipped, never dropped"
  );

  // A site with no lock at all and an uncheckable lock both SKIP with a named
  // reason — never "pass", never a silent default.
  const skipped = report.skipped[0];
  assert.ok(skipped, "expected at least one skipped lock");
  const skippedResult = sessionLockResultFor(skipped.site, report);
  assert.equal(skippedResult.status, "skip");
  assert.ok((skippedResult.reason ?? "").length > 20, "a skip must carry a named reason");

  const unknown = sessionLockResultFor("no-such-site-in-this-repo", report);
  assert.equal(unknown.status, "skip");
  assert.match(unknown.reason ?? "", /no capabilities\/no-such-site-in-this-repo\/session\.lock\.json/);
});

test("session locks: a false claim is reported with the measured values, never repaired", () => {
  // Drive the REAL logic with an injected report: a hand-built failure must
  // surface as a `fail` verdict carrying the measured numbers verbatim, and it
  // must never be softened into a pass or a skip.
  const fake: SessionLockReport = {
    ok: false,
    checked: ["ghost"],
    skipped: [],
    failures: [
      { site: "ghost", reason: "sha256 mismatch for ghost (ghost.test): declared deadbeef, actual 01234567… (data/ghost.test/state.json)" },
    ],
    details: [
      {
        site: "ghost",
        declaredHost: "ghost.test",
        lockPath: "capabilities/ghost/session.lock.json",
        snapshotPath: "data/ghost.test/state.json",
        checked: true,
        claims: [{ field: "sha256Prefix", status: "pass", detail: "sha256 01234567… does NOT match declared prefix deadbeef" }],
      },
    ],
  };
  const r = sessionLockResultFor("ghost", fake);
  assert.equal(r.status, "fail");
  assert.match(r.reason ?? "", /sha256 mismatch for ghost/);
  assert.match(r.reason ?? "", /declared deadbeef, actual 01234567/);
});

// --- the negative: the gate has been SEEN to fail -------------------------
//
// A scratch package in a TEMP dir: real snapshot bytes, a deliberately wrong
// sha256Prefix and a deliberately wrong cookie count. The SAME exported
// `verifySessionLock` runs against it — no copy of the logic — and must report
// BOTH measured mismatches by name. Temp dir removed in `finally`; no committed
// package lock is read-modified-written at any point.

function scratchPackage(dir: string, name: string, snapshotRelative: string): string {
  const pkgDir = join(dir, "capabilities", name);
  mkdirSync(pkgDir, { recursive: true });
  const snapDir = join(dir, snapshotRelative);
  mkdirSync(dirname(snapDir), { recursive: true });
  writeFileSync(
    snapDir,
    JSON.stringify({
      version: 1,
      host: "scratch.test",
      origin: "https://scratch.test",
      capturedAt: "2026-09-25T00:00:00.000Z",
      cookies: [
        { name: "a", value: "1", domain: ".scratch.test", path: "/", secure: true, httpOnly: true, expires: 1, sameSite: "Lax" },
        { name: "b", value: "2", domain: ".scratch.test", path: "/", secure: true, httpOnly: true, expires: 1, sameSite: "Lax" },
        { name: "c", value: "3", domain: ".scratch.test", path: "/", secure: true, httpOnly: true, expires: 1, sameSite: "Lax" },
      ],
      localStorage: [["k", "v"]],
    })
  );
  const lockPath = join(pkgDir, "session.lock.json");
  writeFileSync(
    lockPath,
    JSON.stringify(
      {
        site: "scratch.test",
        locked: true,
        status: "locked",
        snapshot: {
          path: snapshotRelative,
          // deliberately wrong: neither the real prefix nor the real count (3)
          sha256Prefix: "deadbeefdeadbeef",
          cookies: 99,
        },
      },
      null,
      2
    )
  );
  return lockPath;
}

test("session locks: NEGATIVE — a wrong hash + wrong cookie count FAILS with the named reasons (the gate is falsifiable)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui2api-lock-"));
  try {
    const rel = "data/scratch.test/.session/state.json";
    const lockPath = scratchPackage(dir, "scratch-false-claim", rel);
    const realSha = sha256File(join(dir, rel));
    assert.ok(!realSha.startsWith("deadbeef"), "fixture sanity: the declared prefix really is wrong");

    const report = verifySessionLock(lockPath, { root: dir });

    assert.equal(report.ok, false, "a false claim must never report ok");
    assert.equal(report.failures.length, 2, `expected both mismatches, got ${JSON.stringify(report.failures)}`);
    const hashFailure = report.failures.find((f) => /sha256 mismatch/.test(f.reason));
    assert.ok(hashFailure, `expected a "sha256 mismatch" failure, got ${report.failures.map((f) => f.reason).join(" | ")}`);
    assert.equal(hashFailure!.site, "scratch-false-claim");
    assert.match(hashFailure!.reason, /sha256 mismatch for scratch-false-claim/);
    assert.match(hashFailure!.reason, /declared deadbeefdeadbeef, actual /);
    assert.ok(hashFailure!.reason.includes(realSha.slice(0, 16)), "the failure must quote the MEASURED hash, not a guess");

    const countFailure = report.failures.find((f) => /cookie count mismatch/.test(f.reason));
    assert.ok(countFailure, `expected a "cookie count mismatch" failure, got ${report.failures.map((f) => f.reason).join(" | ")}`);
    assert.match(countFailure!.reason, /cookie count mismatch for scratch-false-claim/);
    assert.match(countFailure!.reason, /declared 99, actual 3/);

    // The site is reported as CHECKED (its claims really were measured) and the
    // failure reaches the doctor verdict as a `fail`, not a skip or a pass.
    assert.deepEqual(report.checked, ["scratch-false-claim"]);
    assert.equal(sessionLockResultFor("scratch-false-claim", report).status, "fail");

    // A CORRECTED lock in the same temp dir passes — the gate is discriminating,
    // not merely always-failing. (Same scratch dir, real lock never touched.)
    const fixedPath = scratchPackage(dir, "scratch-true-claim", "data/scratch.test/.session/state2.json");
    const fixed = JSON.parse(readFileSync(fixedPath, "utf8")) as {
      snapshot: { sha256Prefix: string; cookies: number };
    };
    fixed.snapshot.sha256Prefix = sha256File(join(dir, "data/scratch.test/.session/state2.json")).slice(0, 16);
    fixed.snapshot.cookies = 3;
    writeFileSync(fixedPath, JSON.stringify(fixed, null, 2));
    const fixedReport = verifySessionLock(fixedPath, { root: dir });
    assert.deepEqual(fixedReport.failures, [], `a truthful scratch lock must pass: ${JSON.stringify(fixedReport.failures)}`);
    assert.equal(fixedReport.ok, true);
    assert.deepEqual(fixedReport.checked, ["scratch-true-claim"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session locks: an unverifiable claim is a NAMED skip, never a silent pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui2api-lock-skip-"));
  try {
    // (1) declared snapshot absent (the gitignored-vault case).
    const missing = scratchPackage(dir, "scratch-missing", "data/gone.test/state.json");
    rmSync(join(dir, "data/gone.test"), { recursive: true, force: true });
    const missingReport = verifySessionLock(missing, { root: dir });
    assert.equal(missingReport.ok, true, "an unverifiable claim is not a failure");
    assert.deepEqual(missingReport.checked, [], "a missing snapshot must not be counted as checked");
    assert.equal(missingReport.skipped.length, 1);
    assert.match(missingReport.skipped[0].reason, /declared snapshot not on disk: data\/gone\.test\/state\.json/);
    assert.equal(sessionLockResultFor("scratch-missing", missingReport).status, "skip");

    // (2) a lock that declares no snapshot path at all makes no claim.
    const noClaimDir = join(dir, "capabilities", "scratch-noclaim");
    mkdirSync(noClaimDir, { recursive: true });
    const noClaim = join(noClaimDir, "session.lock.json");
    writeFileSync(noClaim, JSON.stringify({ site: "scratch.test", locked: false, status: "awaiting-capture" }));
    const noClaimReport = verifySessionLock(noClaim, { root: dir });
    assert.deepEqual(noClaimReport.failures, []);
    assert.deepEqual(noClaimReport.checked, []);
    assert.match(noClaimReport.skipped[0].reason, /no snapshot path declared/);

    // (3) the honest downgrade: the lock itself says the snapshot is unavailable.
    const unavailableDir = join(dir, "capabilities", "scratch-unavailable");
    mkdirSync(unavailableDir, { recursive: true });
    const unavailable = join(unavailableDir, "session.lock.json");
    writeFileSync(
      unavailable,
      JSON.stringify({
        site: "scratch.test",
        snapshot: { snapshotAvailable: false, note: "vault gitignored; re-capture on this box to check" },
      })
    );
    const unavailableReport = verifySessionLock(unavailable, { root: dir });
    assert.deepEqual(unavailableReport.failures, []);
    assert.match(unavailableReport.skipped[0].reason, /snapshotAvailable:false declared/);
    assert.match(unavailableReport.skipped[0].reason, /vault gitignored; re-capture on this box to check/);

    // (4) a declared path that escapes the repo root is REFUSED, not hashed.
    const escapeDir = join(dir, "capabilities", "scratch-escape");
    mkdirSync(escapeDir, { recursive: true });
    const escapeLock = join(escapeDir, "session.lock.json");
    writeFileSync(
      escapeLock,
      JSON.stringify({ site: "scratch.test", snapshot: { path: "../../../../etc/passwd", sha256Prefix: "dead", cookies: 1 } })
    );
    const escapeReport = verifySessionLock(escapeLock, { root: dir });
    assert.deepEqual(escapeReport.failures, [], "a refused path is not a false claim");
    assert.match(escapeReport.skipped[0].reason, /escapes the repo root and was REFUSED/);

    // (5) a lock with no verifiable claim at all is a named skip, NOT a pass.
    const vacuousDir = join(dir, "capabilities", "scratch-vacuous");
    mkdirSync(vacuousDir, { recursive: true });
    const vacuous = join(vacuousDir, "session.lock.json");
    const vacuousSnap = join(dir, "data/vacuous.test/state.json");
    mkdirSync(dirname(vacuousSnap), { recursive: true });
    writeFileSync(vacuousSnap, JSON.stringify({ host: "vacuous.test", cookies: [] }));
    writeFileSync(vacuous, JSON.stringify({ site: "vacuous.test", snapshot: { path: "data/vacuous.test/state.json" } }));
    const vacuousReport = verifySessionLock(vacuous, { root: dir });
    assert.deepEqual(vacuousReport.checked, [], "a lock with no declared claim must never be counted as checked");
    assert.match(vacuousReport.skipped[0].reason, /no verifiable claim/);
    assert.equal(sessionLockResultFor("scratch-vacuous", vacuousReport).status, "skip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
