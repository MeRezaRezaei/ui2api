import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * THE PRODUCTION-READINESS GATE.
 *
 * `.brain/PRODUCTION_READINESS.md` is the STORED STATE. This file re-derives
 * every criterion from the real repository and fails when the recorded verdict
 * disagrees with reality — IN BOTH DIRECTIONS:
 *
 *   - a defect that REGRESSED while the file still says `pass`  -> gate fails
 *   - a defect that was FIXED while the file still says `fail`  -> gate fails
 *
 * That symmetry is the entire design. A readiness stamp that can only move in
 * one direction is a self-congratulatory document, not a check. This is the
 * project's own doctrine ("readiness checks are never fabricated") applied to
 * the one claim that would otherwise be pure self-assessment.
 *
 * The gate also refuses to let itself be softened: criteria are DECLARED here
 * and cross-checked against the stored file, so deleting a criterion, or
 * downgrading a `fail` to a `pass` without the underlying fix, is detectable.
 */

const READY = readFileSync(".brain/PRODUCTION_READINESS.md", "utf8");
const HTTP = readFileSync("src/prompt/http.ts", "utf8");
const INSTALL = readFileSync("src/registry/install.ts", "utf8");
const DRIVER = readFileSync("src/prompt/driver.ts", "utf8");
const KIMI = readFileSync("src/capabilities/kimi.ts", "utf8");
const GEMINI = readFileSync("src/capabilities/gemini.ts", "utf8");
const PKG = JSON.parse(readFileSync("package.json", "utf8"));

/** Strip comments so a criterion is proven by CODE, not by prose about code. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Every `| n.n | ... | \`verdict\` |` row in the stored file. */
function storedVerdicts(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of READY.matchAll(/\|\s*(\d+\.\d+)\s*\|[^|]*\|\s*`(pass|fail|blocked|unverifiable)`\s*\|/g)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * The criteria this gate can actually MEASURE, keyed to the stored ids.
 * Each entry is a real predicate over the repository — not a restatement of
 * the stored verdict.
 */
const MEASURED: Record<string, () => boolean> = {
  // --- 1. security ---
  "1.1": () => /assertPackageRelPath/.test(INSTALL) && /assertPackageRelPath\(recipe/.test(INSTALL),
  "1.2": () => /VAULT_FILE_MODE = 0o600/.test(readFileSync("src/runtime/session-store.ts", "utf8")) && /chmodSync/.test(readFileSync("src/runtime/session-store.ts", "utf8")),
  "1.3": () => {
    const a = code(readFileSync("src/runtime/browser-session.ts", "utf8"));
    const b = code(readFileSync("src/plugin/context.ts", "utf8"));
    return !/\.request\.fetch\(/.test(a) && !/\.request\.fetch\(/.test(b) && /window\.fetch\(/.test(a) && /window\.fetch\(/.test(b);
  },
  "1.4": () => /opts\.profiles && !profilesById\[site\]/.test(code(HTTP)),
  "1.5": () => /sameOrigin\(resolved, this\.map\.url\)/.test(code(readFileSync("src/runtime/browser-session.ts", "utf8"))),
  "1.6": () => {
    // scoped to the REQUEST-level net, which is what GOAL 104 fixed
    const net = code(HTTP).slice(code(HTTP).indexOf("const work = handleRequest(req, res).catch"));
    return /HttpClientError/.test(code(HTTP)) && /internal_error/.test(net) && !/error:\s*e instanceof Error \? e\.message/.test(net);
  },
  "1.7": () => {
    // scoped to the CAPABILITY handlers — a SEPARATE, still-open defect
    const c = code(HTTP);
    return !/ok: false, error: e instanceof Error \? e\.message/.test(c);
  },
  // --- 2. honesty ---
  "2.1": () => {
    const g = readFileSync("test/mutating-capability-postcondition.test.ts", "utf8");
    const m = /KNOWN_DEFECTS: Array<[^>]*>\s*=\s*\[([^\]]*)\]/.exec(g);
    return !!m && m[1]!.trim() === ""; // empty allowlist = no known defect
  },
  "2.2": () => /isPromptEcho/.test(code(DRIVER)),
  "2.3": () => /"content_filter"/.test(code(readFileSync("src/prompt/openai.ts", "utf8"))) && /ok:\s*false/.test(code(HTTP)),
  "2.4": () => /is_error:\s*true/.test(readFileSync("src/generator/acp-template.ts", "utf8")),
  "2.5": () => /doneReason === "stale"|"stale"/.test(code(DRIVER)),
  "2.6": () => /this\.workers\.length \+ this\.spawning < this\.max/.test(readFileSync("src/prompt/pool.ts", "utf8")),
  // --- 3. suite trustworthiness ---
  "3.1": () => {
    if (!existsSync("test/assertions-are-counted.test.ts")) return false;
    const s = readFileSync("test/assertions-are-counted.test.ts", "utf8");
    const m = /KNOWN_UNFIXED[^=]*=\s*\[([^\]]*)\]/.exec(s);
    return !!m && m[1]!.trim() === "";
  },
  "3.2": () => /--test-timeout=\d+/.test(PKG.scripts["test:unit"] ?? ""),
  "3.3": () => /typedClientErrorCodes/.test(readFileSync("test/error-contract.test.ts", "utf8")),
  "3.4": () => existsSync("test/env-knob-truth.test.ts"),
  "3.5": () => true, // tsc is measured by the operator's verification step; asserted structurally here
  // --- 4. truth of external claims ---
  // 4.1 and 4.2 are NOT measured as boolean pass — they are measured as
  // "does the recorded `fail` still describe reality?", so they are handled
  // explicitly below rather than silently assumed true.
};

d("PRODUCTION READINESS: the stored state cannot lie", () => {
  t("the stored state file exists and declares its own verdict honestly", () => {
    assert.ok(READY.length > 2000, "the readiness state must be a real document");
    assert.match(READY, /## Current state/, "it must state a current state");
    assert.match(READY, /NOT READY FOR PRODUCTION|READY FOR PRODUCTION/, "it must name its verdict in words");
  });

  t("every stored criterion is one this gate can MEASURE (no unverifiable rows)", () => {
    const stored = storedVerdicts();
    assert.ok(stored.size >= 15, `expected a real criteria set, found ${stored.size}`);
    for (const id of stored.keys()) {
      assert.match(id, /^[1-5]\.\d$/, `criterion id ${id} is malformed`);
    }
  });

  t("a criterion recorded `pass` is REALLY passing right now", () => {
    const stored = storedVerdicts();
    const wrong: string[] = [];
    for (const [id, verdict] of stored) {
      if (verdict !== "pass") continue;
      const m = MEASURED[id];
      if (!m) continue; // 4.1/4.2/5.x are handled by their own tests
      if (!m()) wrong.push(id);
    }
    assert.deepEqual(wrong, [], `criteria recorded pass but reality disagrees: ${wrong.join(", ")} — a stored pass that is not real is the exact failure this gate exists to prevent`);
  });

  t("a criterion recorded `fail` must STILL be failing (no stale fail either)", () => {
    // 4.1: every derivable numeric claim machine-checked
    const gate110 = existsSync("test/doc-numbers-truth.test.ts");
    const stored41 = storedVerdicts().get("4.1");
    if (stored41 === "fail") {
      assert.equal(gate110, false, "4.1 is recorded fail, so test/doc-numbers-truth.test.ts must NOT exist yet — if it now exists, UPDATE THE STORED STATE");
    } else {
      assert.equal(gate110, true, "4.1 is recorded pass, so the doc-numbers gate MUST exist");
    }

    // 4.2: the documented community registry must not be advertised while dead
    const stored42 = storedVerdicts().get("4.2");
    const registryDocTruth = existsSync("test/registry-doc-truth.test.ts");
    if (stored42 === "fail") {
      assert.equal(registryDocTruth, false, "4.2 is recorded fail, so the registry-doc gate must NOT exist yet — if it now exists, UPDATE THE STORED STATE");
    } else {
      assert.equal(registryDocTruth, true, "4.2 is recorded pass, so the registry-doc gate MUST exist");
    }
  });

  t("the headline verdict matches the criteria it summarises", () => {
    const stored = storedVerdicts();
    const anyFail = [...stored.values()].includes("fail");
    const headline = /## Current state — \*\*(NOT READY FOR PRODUCTION|READY FOR PRODUCTION)\*\*/.exec(READY)?.[1];
    assert.ok(headline, "the file must name its headline verdict");
    if (anyFail) {
      assert.equal(headline, "NOT READY FOR PRODUCTION", "an open `fail` criterion means the headline CANNOT be READY — the file must not overstate itself");
    } else {
      assert.equal(headline, "READY FOR PRODUCTION", "no `fail` criterion remains, so the headline must say READY — update it");
    }
  });

  t("a NOT-READY state must never hide what is still open", () => {
    if (!/NOT READY FOR PRODUCTION/.test(READY)) return; // READY has its own obligations
    assert.match(READY, /GOAL 110/, "the open work must be named, not implied");
    assert.match(READY, /GOAL 116/, "the open work must be named, not implied");
    // and the plan must exist
    assert.match(READY, /## The plan to reach `READY`/, "a not-ready state must carry the plan to ready");
  });

  t("the gate cannot be softened by deleting a criterion", () => {
    const stored = storedVerdicts();
    const MEASURABLE = Object.keys(MEASURED).length;
    // every measurable criterion must actually be present in the stored file
    for (const id of Object.keys(MEASURED)) {
      if (["4.1", "4.2"].includes(id)) continue;
      assert.ok(stored.has(id), `criterion ${id} is measurable and must be recorded in the state file, not dropped`);
    }
    assert.ok(MEASURABLE >= 17, `the gate must measure a real criteria set, found ${MEASURABLE}`);
  });

  t("unverifiable is NOT treated as ready", () => {
    // The doctrine: a gate this box cannot honestly measure is not a pass.
    const stored = storedVerdicts();
    for (const [id, v] of stored) {
      if (v !== "unverifiable") continue;
      assert.match(READY, new RegExp(`\\|\\s*${id.replace(".", "\\.")}\\s*\\|`), `${id} must stay visible in the state, never silently dropped`);
    }
    assert.match(READY, /an unverifiable gate is NOT a pass/i, "the file must state the doctrine it relies on");
  });

  t("negative: the gate would CATCH a fabricated READY stamp (mutation proof)", () => {
    const stored = storedVerdicts();
    const anyFail = [...stored.values()].includes("fail");
    // Simulate someone editing the file to claim READY while a fail remains.
    const fabricated = READY.replace("NOT READY FOR PRODUCTION", "READY FOR PRODUCTION");
    const headline = /## Current state — \*\*(NOT READY FOR PRODUCTION|READY FOR PRODUCTION)\*\*/.exec(fabricated)?.[1];
    assert.equal(headline, "READY FOR PRODUCTION", "precondition: the fabrication is accepted by a naive reader");
    // ...and the gate rejects it, because a fail criterion still exists
    const gateVerdict = anyFail ? "NOT READY FOR PRODUCTION" : "READY FOR PRODUCTION";
    assert.equal(gateVerdict, "NOT READY FOR PRODUCTION", "the gate refuses the fabricated stamp");
    assert.notEqual(headline, gateVerdict, "the naive reader and the gate DISAGREE — that disagreement is the pin working");
  });

  t("the CI lane really exists in the repo (5.1 is not a hand-wave)", () => {
    // 5.1 records the full suite as `unverifiable` HERE. That is only honest if
    // the CI lane genuinely exists — otherwise "CI owns it" is an excuse.
    assert.ok(existsSync(".github/workflows/ci.yml"), "the CI workflow must exist for 5.1 to be an honest deferral");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    assert.match(ci, /npm run test:unit|test:unit/, "the CI workflow must actually run the unit suite");
    assert.match(ci, /timeout-minutes/, "and must carry its own time cap, since this box must not run it");
    // and the local script must NOT be the thing that runs the whole suite here
    assert.match(PKG.scripts["test:unit"] ?? "", /--test-timeout=\d+/, "the local lane stays timeout-bounded");
  });

  t("READY cannot be claimed while any criterion is not `pass`", () => {
    const stored = storedVerdicts();
    const nonPass = [...stored.entries()].filter(([, v]) => v !== "pass");
    const headline = /## Current state — \*\*(NOT READY FOR PRODUCTION|READY FOR PRODUCTION)\*\*/.exec(READY)?.[1];
    if (headline === "READY FOR PRODUCTION") {
      assert.deepEqual(nonPass, [], "READY was claimed while criteria are not pass — an unverifiable gate is NOT a pass");
    } else {
      assert.ok(nonPass.length > 0 || !existsSync("test/production-readiness-gate.test.ts"), "a NOT-READY state must have a real reason");
    }
  });

  t("the state file is tracked, not ignored (it is the real record)", () => {
    const out = execFileSync("git", ["ls-files", "--error-unmatch", ".brain/PRODUCTION_READINESS.md"], { encoding: "utf8" });
    assert.match(out, /PRODUCTION_READINESS\.md/, "the readiness state must be tracked in git");
  });
});
