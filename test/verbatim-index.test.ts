// GOAL 78: the verbatim-completeness gate is MECHANICAL, not prose — until this
// file, AGENTS.md's "Verification before claiming done" named
// `npm run check:verbatim` (+ :goals) as a standing gate but the only
// human-free automatic gates (CI + the unit suite) never executed the P1..P5
// verifier: grep-measured `grep -c check:verbatim .github/workflows/ci.yml` = 0
// and `grep -rln 'verify-verbatim-index\|check:verbatim' test/ src/` = 0.
// This file spawns the real committed verifier (`scripts/verify-verbatim-index.mjs`)
// so every `npm run test:unit` run answers "did we extract+index ALL verbatims?"
// with a measured verdict. The negative case drives the verifier binary against a
// scratch drifted corpus to prove the gate FAILS LOUD — never a gate nobody has
// seen fail.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFIER = join("scripts", "verify-verbatim-index.mjs");

function runVerifier(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [VERIFIER, ...args], { cwd: ROOT, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("GOAL 78: the standing verifier runs green on the live corpus (P1..P4)", () => {
  const { status, stdout } = runVerifier([]);
  assert.equal(status, 0, `check:verbatim exited ${status}:\n${stdout}`);
  assert.match(stdout, /OK — all checks pass \(P1\.\.P4\)/);
  const counts = stdout.match(/user blocks = (\d+)  \|  index rows = (\d+)/);
  assert.ok(counts, "report carries the global block-vs-row counts");
  assert.equal(counts![1], counts![2], "P1: every user block has exactly its index row (global equality)");
});

test("GOAL 78: the goals-index cross-check runs green (P5, --goals)", () => {
  const { status, stdout } = runVerifier(["--goals"]);
  assert.equal(status, 0, `check:verbatim:goals exited ${status}:\n${stdout}`);
  assert.match(stdout, /OK — all checks pass \(P1\.\.P5\)/);
});

test("GOAL 78: the gate FAILS LOUD on a drifted corpus — the real verifier binary, scratch fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "verbatim-gate-"));
  try {
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, ".brain"));
    copyFileSync(join(ROOT, VERIFIER), join(dir, VERIFIER));
    // One user block, ZERO index rows: the exact failure class GOAL 73 the
    // gate exists to catch (a block silently missing its row).
    writeFileSync(
      join(dir, ".brain", "verbatim.md"),
      "# scratch corpus\n\n## Index (all verbatim blocks — date · who · one line)\n\n## 2026-08-29\n<!-- 2026-09-25T10:00 -->\n[user] this block has no index row\n",
    );
    const r = spawnSync(process.execPath, [join(dir, VERIFIER)], { encoding: "utf8" });
    assert.notEqual(r.status, 0, "a corpus with an unindexed block MUST fail the gate");
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    assert.match(out, /FAIL — \d+ problem/);
    assert.match(out, /P1 GLOBAL count mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});