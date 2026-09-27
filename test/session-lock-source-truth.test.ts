// The session-lock SOURCE-TRUTH gate: untrusted lock DATA may not name a
// location outside the tree being validated.
//
// The problem this file exists for, stated as it was MEASURED rather than as it
// was assumed. `capabilities/<id>/session.lock.json` is committed data that
// declares where its snapshot lives, and `verifyCapabilitySessionLocks()` (which
// runs with no options, so `root` defaults to the REPO ROOT) resolves that
// declared path and then READS it — `statSync`, `readFileSync` for the cookie
// array, and `readFileSync` again for the sha256. So a lock file is a pointer
// the reader follows, and anything that pointer reaches gets hashed and
// reported as if it were the site's own vault.
//
// The pre-existing guard (src/runtime/session-lock.ts, the `relative()` check)
// is real and was measured working before anything here was written: `../`, an
// absolute `/etc/passwd`, and an escape-and-come-back path were each REFUSED
// with a named reason. It was blind to exactly one shape, and that shape was a
// working read of a file outside the tree:
//
//   a symlink. A symlink's own path is legitimately inside the tree while its
//   TARGET is not, so a purely textual containment check cannot see it. Driven
//   through the real `verifySessionLock`, a lock declaring
//   `data/probe.test/link.json` — that file being a symlink to JSON outside the
//   root — came back `ok:false` with BOTH claims MEASURED ("sha256 123d… does
//   NOT match declared prefix dead", "cookie count 3 matches the declared
//   count"), and `strace -e trace=openat` showed the
//   `openat(..., O_RDONLY)` that read it. Two read-opens before the fix; zero
//   after.
//
// So the confinement now also decides on the path's REAL location
// (`realLocationOf`, resolved from the DEEPEST EXISTING ANCESTOR so a hop
// through a symlinked DIRECTORY is caught even when the leaf is absent).
//
// WHAT IS PINNED HERE, and what is deliberately NOT:
//   - every escape shape is refused BY NAME — the named reason quotes the
//     declared path AND the real location it resolved to, and a refusal is a
//     named SKIP (never a bare pass, never a silent drop). A refusal is not a
//     FAILURE: a lock naming a path we refuse to read has not made a false
//     claim, it has made an unreadable one, and test/session-lock-honesty.test.ts
//     pins that same distinction (`assert.deepEqual(escapeReport.failures, [])`).
//   - the target of every fixture is built so that reading it WOULD SUCCEED —
//     its cookie count matches the lock's declared count and its sha256 matches
//     the declared prefix. That is what makes "refused" discriminating rather
//     than trivially true: the fixture is the world where the escape works, and
//     the pin requires the world where it does not.
//   - the reverse direction: a path that is merely SPELLED like an escape but
//     really is inside is NOT refused, and neither is a legitimate file under a
//     root that is ITSELF reached through a symlink. Without this the
//     confinement would be satisfiable by refusing everything, which is not a
//     confinement.
//   - the REAL corpus is examined and is non-empty, and no committed lock is
//     refused as an escape. A check that validated nothing must not report
//     success, so the lock set is asserted BEFORE the cleanliness claim and
//     every real lock is asserted to land in exactly one bucket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** Bytes that are a valid, CHECKABLE snapshot: 3 cookies and a stable hash, so
 *  a lock that declares exactly these values PASSES if — and only if — the file
 *  is really read. This is the fixture's whole job: it makes "the read did not
 *  happen" an observable fact rather than an assumption. */
function snapshotBytes(): string {
  return JSON.stringify({ version: 1, host: "escape.test", cookies: [{}, {}, {}] });
}

/** A temp root that OWNS its tree, plus a sibling directory OUTSIDE it that
 *  holds the target an escaping lock would try to reach. Nothing here is
 *  anchored by a repo-relative literal, so the vault-path independence gate
 *  sees no dependency on this machine's `data/`. */
function fixture(): { root: string; outside: string; outsideFile: string } {
  const base = mkdtempSync(join(tmpdir(), "ui2api-lock-source-truth-"));
  const root = join(base, "tree");
  const outside = join(base, "outside");
  mkdirSync(join(root, "capabilities"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const outsideFile = join(outside, "not-ours.json");
  writeFileSync(outsideFile, snapshotBytes());
  return { root, outside, outsideFile };
}

/** Write a `capabilities/<name>/session.lock.json` whose declared path is
 *  `declared`, and whose declared claims MATCH `outsideFile` — so the report
 *  would be a clean pass if the file behind the path were read. */
function lockDeclaring(root: string, name: string, declared: unknown, targetForHash: string): string {
  const pkg = join(root, "capabilities", name);
  mkdirSync(pkg, { recursive: true });
  const lockPath = join(pkg, "session.lock.json");
  writeFileSync(
    lockPath,
    JSON.stringify({
      site: "escape.test",
      locked: true,
      snapshot: { path: declared, sha256Prefix: sha256File(targetForHash).slice(0, 16), cookies: 3 },
    })
  );
  return lockPath;
}

/** Assert a report is a REFUSAL: named skip carrying the cause, nothing
 *  checked, no failure, and the doctor's verdict is `skip` — never `pass`. */
function assertRefusedByName(report: SessionLockReport, site: string, mustMention: string[], label: string): void {
  assert.deepEqual(report.checked, [], `${label}: a refused path must never be counted as checked`);
  assert.deepEqual(report.failures, [], `${label}: a refusal is not a false claim — it is an unreadable one`);
  assert.equal(report.skipped.length, 1, `${label}: expected exactly one refusal, got ${JSON.stringify(report.skipped)}`);
  const reason = report.skipped[0]!.reason;
  assert.match(reason, /REFUSED/, `${label}: the refusal must say REFUSED, got: ${reason}`);
  for (const needle of mustMention) {
    assert.ok(reason.includes(needle), `${label}: the refusal must name "${needle}" so a reader can act on it; got: ${reason}`);
  }
  const verdict = sessionLockResultFor(site, report);
  assert.equal(verdict.status, "skip", `${label}: an unverified claim must read as skip, never pass`);
  assert.ok((verdict.reason ?? "").length > 20, `${label}: the verdict must carry the named reason`);
}

test("session-lock source truth: EVERY escape shape a lock can declare is REFUSED by name, never read", () => {
  const { root, outside, outsideFile } = fixture();
  try {
    // Fixture sanity, asserted BEFORE any cleanliness claim below — a fixture
    // that silently failed to build would make every refusal trivially true.
    assert.ok(existsSync(outsideFile), "fixture sanity: the outside target must exist");
    const realSha = sha256File(outsideFile);
    assert.ok(!realSha.startsWith("0"), "fixture sanity: sha256 of the outside target");

    // A file INSIDE the tree, reaching outside only through a symlink. This is
    // the shape the pre-existing textual guard could not see.
    const innerDir = join(root, "data", "escape.test");
    mkdirSync(innerDir, { recursive: true });
    symlinkSync(outsideFile, join(innerDir, "link.json"), "file");
    // A symlinked DIRECTORY reaching outside, with a leaf that EXISTS and with
    // one that does NOT — the second is the case a bare `realpathSync(abs)`
    // would drop, mis-attributing an ESCAPE as a MISSING FILE.
    symlinkSync(outside, join(innerDir, "portal"), "dir");

    const cases: Array<{ label: string; name: string; declared: unknown; mustMention: string[] }> = [
      {
        label: "a symlink to a file outside the tree (the MEASURED hole)",
        name: "symlink-file",
        declared: "data/escape.test/link.json",
        mustMention: ["data/escape.test/link.json", outsideFile, "symlink"],
      },
      {
        label: "a symlinked directory whose leaf EXISTS",
        name: "symlink-dir-leaf",
        declared: "data/escape.test/portal/not-ours.json",
        mustMention: ["data/escape.test/portal/not-ours.json", outsideFile, "symlink"],
      },
      {
        label: "a symlinked directory whose leaf is ABSENT (must not be mis-reported as merely missing)",
        name: "symlink-dir-no-leaf",
        declared: "data/escape.test/portal/absent.json",
        mustMention: ["data/escape.test/portal/absent.json", "symlink"],
      },
      {
        label: "a dotdot escape (the pre-existing textual guard)",
        name: "dotdot",
        declared: "../../../../../../etc/passwd",
        mustMention: ["../../../../../../etc/passwd"],
      },
      {
        label: "an absolute path outside the tree",
        name: "absolute",
        declared: outsideFile,
        mustMention: [outsideFile],
      },
      {
        label: "an escape that comes back out again",
        name: "come-and-go",
        declared: "data/escape.test/../../../outside/not-ours.json",
        mustMention: ["data/escape.test/../../../outside/not-ours.json"],
      },
    ];

    for (const c of cases) {
      const lockPath = lockDeclaring(root, c.name, c.declared, outsideFile);
      // Precondition, per case: this lock really does declare a TRUTHFUL claim
      // about the outside file. So "refused" cannot be an accident of a
      // mismatched fixture — it can only mean the path was not followed.
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { snapshot: { sha256Prefix: string; cookies: number } };
      assert.equal(lock.snapshot.cookies, 3, `${c.label}: fixture sanity — the lock must declare the target's real cookie count`);
      assert.ok(realSha.startsWith(lock.snapshot.sha256Prefix), `${c.label}: fixture sanity — the lock must declare the target's real hash prefix`);

      const report = verifySessionLock(lockPath, { root });
      assertRefusedByName(report, c.name, c.mustMention, c.label);
      // The refusal must not read as success at the aggregate level either.
      assert.equal(report.ok, true, `${c.label}: an unreadable claim is not a failure`);
    }

    // The pin must not be satisfiable by an EMPTY corpus: the cases above ran,
    // and each one was individually asserted, so a silently empty list cannot
    // pass. Asserted explicitly as well, because this is the failure mode the
    // repo forbids — a gate that examined nothing and reported success.
    assert.equal(cases.length, 6, "the escape table itself must not be empty — a shrinking table is a shrinking gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(root), { recursive: true, force: true });
  }
});

test("session-lock source truth: a target that would PASS if read proves the read never happened", () => {
  // The same non-vacuity claim as a standalone, stated in the one direction
  // that matters: the outside file is a snapshot this lock would verify
  // SUCCESSFULLY. So a report of `checked:[site]` with zero failures would be
  // the unmistakable signature of the escape having worked. Requiring the
  // refusal is therefore requiring the absence of a read, not merely the
  // presence of a string.
  const { root, outside, outsideFile } = fixture();
  try {
    const innerDir = join(root, "data", "escape.test");
    mkdirSync(innerDir, { recursive: true });
    symlinkSync(outsideFile, join(innerDir, "link.json"), "file");

    const lockPath = lockDeclaring(root, "would-have-passed", "data/escape.test/link.json", outsideFile);

    // The control, MEASURED: point the very same lock at the same bytes through
    // a path that IS legitimately inside the tree, and it verifies. Without
    // this, "refused" could just mean the fixture was broken.
    mkdirSync(join(root, "data", "escape.test", "real"), { recursive: true });
    writeFileSync(join(root, "data", "escape.test", "real", "state.json"), snapshotBytes());
    const controlPath = lockDeclaring(root, "control-inside", "data/escape.test/real/state.json", outsideFile);
    const control = verifySessionLock(controlPath, { root });
    assert.deepEqual(control.failures, [], `the control must verify: ${JSON.stringify(control.failures)}`);
    assert.deepEqual(control.checked, ["control-inside"], "the control must be CHECKED — the fixture is real and checkable");

    // The escape: identical bytes, identical declared claims, reached only
    // through a symlink.
    const escapeReport = verifySessionLock(lockPath, { root });
    assert.deepEqual(escapeReport.checked, [], "the symlinked path must NOT be checked — that is the read");
    assertRefusedByName(escapeReport, "would-have-passed", ["data/escape.test/link.json", outsideFile], "symlink escape");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(root), { recursive: true, force: true });
  }
});

test("session-lock source truth: the confinement is not satisfiable by refusing everything", () => {
  // The reverse direction, and the reason a gate that only ever refuses is not
  // a gate. Two shapes that LOOK escape-ish and must keep working:
  const { root, outside, outsideFile } = fixture();
  try {
    // (1) a file legitimately inside the tree, with a real snapshot and a
    //     truthful lock, is CHECKED.
    mkdirSync(join(root, "data", "escape.test"), { recursive: true });
    writeFileSync(join(root, "data", "escape.test", "state.json"), snapshotBytes());
    const inside = verifySessionLock(lockDeclaring(root, "inside", "data/escape.test/state.json", outsideFile), { root });
    assert.deepEqual(inside.failures, [], `a legitimate in-tree snapshot must verify: ${JSON.stringify(inside.failures)}`);
    assert.deepEqual(inside.checked, ["inside"], "an in-tree snapshot must still be checked");

    // (2) a root that is ITSELF reached through a symlink must not make every
    //     file under it look like an escape. This is the case a naive
    //     `realpath(abs)` vs `root` comparison breaks on — and it is not
    //     hypothetical: every macOS `/tmp` is a symlink, and many CI workdirs
    //     are too, so a confinement that got this wrong would refuse the whole
    //     suite on those machines while passing here.
    const aliasRoot = join(root, "alias");
    symlinkSync(root, aliasRoot, "dir");
    const viaAlias = verifySessionLock(lockDeclaring(aliasRoot, "via-alias", "data/escape.test/state.json", outsideFile), {
      root: aliasRoot,
    });
    assert.deepEqual(viaAlias.failures, [], `a symlinked ROOT must not refuse its own contents: ${JSON.stringify(viaAlias.skipped)}`);
    assert.deepEqual(viaAlias.checked, ["via-alias"], "a file under a symlinked root must still be checked");

    // (3) a sibling file whose NAME begins with two dots is inside the tree and
    //     must be checked by the real-location layer (it is reached with no
    //     symlink at all, so only the exact containment predicate is in play).
    writeFileSync(join(root, "data", "escape.test", "..weird.json"), snapshotBytes());
    const dotted = verifySessionLock(lockDeclaring(root, "dotted", "data/escape.test/..weird.json", outsideFile), { root });
    assert.deepEqual(dotted.checked, ["dotted"], `a file named "..weird.json" inside the tree is inside it: ${JSON.stringify(dotted.skipped)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(root), { recursive: true, force: true });
  }
});

test("session-lock source truth: the REAL corpus is examined, is non-empty, and no committed lock is refused as an escape", () => {
  // The corpus this gate exists to protect, checked against itself. Two jobs:
  //
  //  1. NON-VACUITY. `verifyCapabilitySessionLocks()` walks the committed
  //     `capabilities/*/session.lock.json` set. If that set came back empty —
  //     a moved directory, a renamed folder, a wrong capabilities path — then
  //     every "nothing was refused" claim below would be true of NOTHING. So
  //     the set is asserted non-empty, and specifically that the locks which
  //     actually carry a snapshot declaration were found, BEFORE the
  //     cleanliness claim. A check that validated nothing must not report
  //     success.
  //
  //  2. NO REAL VERDICT MOVED. The confinement must be invisible to committed
  //     data. A refusal here would mean the gate had begun rejecting the
  //     repository's own packages, so it is asserted to be empty and named if
  //     it ever is not.
  const lockFiles = listSessionLockPaths();
  assert.ok(lockFiles.length > 0, "no capabilities/*/session.lock.json found — every claim below would be vacuous");
  assert.ok(
    lockFiles.every((p) => existsSync(p)),
    "every path listSessionLockPaths() returns must exist — a path it invents is a path nobody validated",
  );

  const report = verifyCapabilitySessionLocks();
  assert.equal(report.details.length, lockFiles.length, "every lock file on disk must produce a detail — never silently ignored");

  // The locks that DO declare a snapshot path: derived from the committed
  // files, never hand-typed, so a future package is covered the day it lands.
  const declaringLocks = lockFiles.filter((p) => {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { snapshot?: { path?: unknown } };
    return typeof parsed.snapshot?.path === "string" && parsed.snapshot.path.trim().length > 0;
  });
  assert.ok(declaringLocks.length > 0, "expected the committed corpus to carry at least one lock that declares a snapshot path");

  // Non-vacuity, the measured way: the locks that declare a path are actually
  // being resolved. Each one must carry a NAMED reason in the report — either
  // the named "not on disk" skip a bare CI runner produces, or a measured pass
  // on a box that holds the capture. What must never appear is the escape
  // refusal, and what must never happen is silence.
  const declaringSites = declaringLocks.map((p) => p.split(/[\\/]/).slice(-2)[0]!);
  for (const site of declaringSites) {
    const detail = report.details.find((d) => d.site === site);
    assert.ok(detail, `${site} declares a snapshot path but produced no detail — the gate is ignoring a lock`);
    const refusal = report.skipped.find((s) => s.site === site && /REFUSED/.test(s.reason));
    assert.equal(
      refusal,
      undefined,
      `a COMMITTED lock was refused as an escape: ${refusal?.reason ?? ""} — the confinement must be invisible to the repository's own packages`,
    );
    // checked XOR skipped, and BOTH halves count as accounted-for. The previous
    // form only recognised the skipped bucket, so a lock the gate actually
    // VERIFIED here (deepseek, on a box that holds the capture) landed in neither
    // and the accounting failed on the strongest possible result.
    if (detail.checked) continue; // verified: the strongest outcome, nothing to account for
    const accounted = report.skipped.find((s) => s.site === site);
    assert.ok(accounted, `${site} is neither checked nor skipped — every lock must be verified or named`);
    if (!detail.checked) {
      assert.ok((accounted!.reason ?? "").length > 20, `${site} is unchecked and must therefore carry a NAMED reason`);
    }
  }

  // The cleanliness claim last, and only after the corpus is known non-empty:
  // no committed lock is refused as an escape anywhere in the report.
  const refusals = report.skipped.filter((s) => /REFUSED/.test(s.reason));
  assert.deepEqual(
    refusals.map((s) => `${s.site}::${s.reason}`),
    [],
    `committed locks must never be refused as escapes:\n${refusals.map((s) => `${s.site}::${s.reason}`).join("\n")}`,
  );
  assert.equal(report.failures.length, 0, `the confinement must not change any measured verdict: ${JSON.stringify(report.failures)}`);
  assert.equal(report.ok, true, "verifyCapabilitySessionLocks() must still be ok after the confinement");

  // And the report is stable within a run — a verdict that depends on which
  // call went first is not a verdict.
  const again = verifyCapabilitySessionLocks();
  assert.deepEqual(
    again.details.map((d) => `${d.site}:${d.checked}:${d.snapshotPath}`).sort(),
    report.details.map((d) => `${d.site}:${d.checked}:${d.snapshotPath}`).sort(),
    "the same corpus must produce the same per-lock verdicts on every call",
  );
});
