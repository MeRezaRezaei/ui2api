import { test as t } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const git = (...args: string[]): string =>
  execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    killSignal: "SIGKILL",
  });

/** True when this checkout's history is truncated. `git rev-parse --is-shallow-repository`
 *  is the authoritative answer; it was added in git 2.15 and this box is far past that. */
function isShallow(): boolean {
  try {
    return git("rev-parse", "--is-shallow-repository").trim() === "true";
  } catch {
    return false;
  }
}

function commitCount(): number {
  return Number(git("rev-list", "--count", "HEAD").trim());
}

function graftShallowFiles(): string {
  try {
    return git("rev-parse", "--git-path", "shallow").trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// WHY THIS GATE EXISTS
//
// Measured 2026-10-01 on pipeline 1028. The credential-leak gate asserts that
// corpus containment is measured over EVERY commit, and it carries a floor of
// 49 corpus paths measured on a full clone. In CI it reported 37 and the test
// failed — which was the gate working. But the CAUSE was not a collapsed
// corpus: `verify` had no GIT_DEPTH, so GitLab checked out its default depth of
// 20 commits out of 631. The gate was measuring 20 commits while its own name,
// its assertion messages and its failure text all claimed totality.
//
// That is the dangerous shape, and it is worth being precise about why. A
// shallow clone does not merely make this one number wrong. It makes the
// history-dirty case STRUCTURALLY UNREACHABLE: the whole point of the
// every-commit rule is to catch a destination that is clean at the tip and
// dirty 200 commits back, and on a shallow clone those 200 commits are not in
// the repository at all. The gate would keep reporting CLEAN, and it would be
// right about what it could see and silent about what it could not. That is
// worse than a red test, because a red test gets fixed and a green test gets
// trusted.
//
// So the precondition is asserted directly rather than left implicit in a
// floor. A truncated history must FAIL LOUDLY here, at a gate that says only
// one thing, instead of quietly weakening a dozen history-spanning assertions
// scattered across the suite.
// ---------------------------------------------------------------------------

t("the checkout carries FULL history — a shallow clone makes every history-spanning gate a fiction", () => {
  const shallow = isShallow();
  const graft = graftShallowFiles();
  const commits = commitCount();

  if (shallow) {
    assert.fail(
      `this checkout is SHALLOW (graft point: ${graft || "unknown"}), so every gate in this suite ` +
        `that walks history is walking ${commits} commits instead of the real total and asserting ` +
        `totality over a subset. Set GIT_DEPTH: "0" on the job. A shallow clone cannot observe the ` +
        `history-dirty case that test/credential-leak-gate.test.ts exists to catch, because those ` +
        `commits are not in the repository.`,
    );
  }

  assert.ok(
    commits > 100,
    `history looks truncated even though --is-shallow-repository says false: only ${commits} commits reachable from HEAD.`,
  );
});

t("a truncated history is DETECTABLE, not merely assumed absent", () => {
  // The anti-vacuity half. If `--is-shallow-repository` were ever unavailable or
  // lying, this gate would silently pass on a truncated clone. So the DETECTION
  // itself is tested, against a real shallow clone built here, rather than
  // trusted because the command exists.
  // Everything happens inside ONE mktemp dir, and the clone target is a fresh
  // name inside it. The first version cloned into tmpdir() itself under a fixed
  // name, so two runs — or a leftover from a killed run — collided with
  // "destination path already exists" and the probe failed for a reason that had
  // nothing to do with what it was probing.
  const probe = [
    "set -e",
    'd=$(mktemp -d)',
    'mkdir -p "$d/src"',
    'cd "$d/src"',
    "git init -q .",
    "git config user.email t@t",
    "git config user.name t",
    'for i in 1 2 3 4 5; do echo $i > f; git add f; git commit -qm "c$i"; done',
    'cd "$d"',
    'git clone -q --depth 1 "file://$d/src" "$d/shallow"',
    'cd "$d/shallow"',
    "git rev-parse --is-shallow-repository",
  ].join("; ");

  const out = execFileSync("bash", ["-c", probe], {
    encoding: "utf8",
    // Bounded, because the suite has a gate that requires every subprocess and
    // network call in test/ to carry a timeout or a kill — and that gate caught
    // this file when it was first written without one. A probe that builds a git
    // repository will hang if git ever waits on a credential or a lock, and a
    // hanging probe takes the whole suite with it.
    timeout: 30_000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(
    out.trim(),
    "true",
    "a --depth 1 clone must report itself shallow; if this assertion fails the detection this gate " +
      "depends on is not available, and every other test here would pass on a truncated history.",
  );
});
