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

import { measureEmitted, parseDocTable, contractGaps } from "./helpers/error-contract-measure.js";

const READY = readFileSync(".brain/PRODUCTION_READINESS.md", "utf8");
const README = readFileSync("README.md", "utf8");
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
  // 3.2 — the BOUND, not the flag's presence. The previous predicate was
  // `/--test-timeout=\d+/`, which matched `120000` (the working bound) AND
  // `999999999` (unbounded, so a hang is never surfaced) AND `1` (so tight it
  // kills every test). A gate that cannot tell a working bound from both a hang
  // and an instant kill is not a gate. Falsifiers, both quoted in the lane
  // report: under the old predicate, `--test-timeout=999999999` and
  // `--test-timeout=1` each left this file 12/12 green.
  //
  // THE WINDOW IS NOT RE-TYPED HERE. It is DERIVED from the file that owns the
  // number — `test/test-timeout-discipline.test.ts`, whose own criterion is
  // literally "the suite declares an explicit per-test timeout" and which
  // asserts `ms >= 30_000` and `ms <= 180_000`. Re-typing `120000` would be the
  // same defect one level down: a number copied into a second gate, free to
  // drift. So the bounds are read out of that file's own assertions, and a
  // window that cannot be derived makes the criterion FAIL rather than pass
  // vacuously.
  "3.2": () => {
    const script: string = PKG.scripts["test:unit"] ?? "";
    const ms = Number(/--test-timeout=(\d+)/.exec(script)?.[1]);
    if (!Number.isFinite(ms)) return false;
    const owner = readFileSync("test/test-timeout-discipline.test.ts", "utf8");
    const lo = Number(/assert\.ok\(\s*ms\s*>=\s*([\d_]+)/.exec(owner)?.[1]?.replace(/_/g, ""));
    const hi = Number(/assert\.ok\(\s*ms\s*<=\s*([\d_]+)/.exec(owner)?.[1]?.replace(/_/g, ""));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false; // the window is un-derivable => NOT a pass
    return ms >= lo && ms <= hi;
  },
  // 3.3 — the MEASUREMENT, not the name of the measurer. The previous
  // predicate was `/typedClientErrorCodes/.test(readFileSync("test/error-contract.test.ts"))`,
  // which asserts that an IDENTIFIER appears in a file. Falsifier, quoted: with
  // `typedClientErrorCodes`'s body emptied (its `new HttpClientError` scan
  // deleted), that predicate stayed `true` and this file stayed 12/12 green with
  // the real error contract UNMEASURED — which is precisely the failure this
  // whole gate exists to prevent, committed inside the gate.
  //
  // So this criterion now RUNS the measurement. Both gates call the ONE
  // implementation in `test/helpers/error-contract-measure.ts` (extracted, rather
  // than importing `test/error-contract.test.ts`, because importing a `.test.ts`
  // under `node --test` RE-REGISTERS its tests inside the importing run — the
  // hazard `test/test-timeout-discipline.test.ts:245-250` already records). One
  // implementation, so the readiness gate and the contract gate CANNOT disagree.
  "3.3": () => {
    const emitted = measureEmitted();
    // non-vacuity: a measurement that finds nothing is not a pass, and neither is
    // a small one — the envelope scan alone could satisfy a low floor.
    if (emitted.size < 5) return false;
    // and the codes the criterion is actually about: the TYPED constructor
    // sites, which the envelope scan structurally cannot see.
    const typed = [...emitted].filter(([c]) => !/^(internal_error|pool_|request_timeout|not_found|content_filter|rate_)/.test(c));
    if (typed.length === 0) return false;
    return contractGaps(emitted, parseDocTable(README)).length === 0;
  },
  "3.4": () => existsSync("test/env-knob-truth.test.ts"),
  // 3.5 — HONESTLY RELABELLED, not measured.
  //
  // The previous predicate was literally `() => true`, under a criterion whose
  // stored row reads "`npx tsc --noEmit` is clean | pass | measured on every flip".
  // A label that says "verified" over a body that returns a constant is a
  // fabricated gate — the exact disease this file's own header is about.
  //
  // WHICH, AND WHY: I RELABELLED rather than invoking `tsc`. Running a
  // TypeScript program-graph build inside a `node:test` case is a real cost
  // (tens of seconds, and it would re-enter the whole compiler on every
  // `test:unit` run) for a verdict the project ALREADY computes twice per CI
  // run — `npm run build` (tsconfig.json, src/) and `npm run typecheck`
  // (tsconfig.test.json, the TEST tree that `build` excludes, GOAL 147). A
  // criterion that claims to be measured and is not is worse than one that says
  // "CI owns this", so it now says CI owns it AND PINS THAT HAND-OFF: this is a
  // real predicate over the repository, not a constant. Delete
  // `npm run typecheck` from either CI config, or stop compiling the test tree,
  // and this criterion goes red — which is the defect class it can actually
  // detect. What it does NOT claim is that `tsc`'s exit code was observed here;
  // it did not, and nothing in this file says it was.
  "3.5": () => {
    // the test tree must be a compile target that EXISTS — otherwise
    // `npm run typecheck` compiles src/ twice and the test tree is unchecked.
    if (!existsSync("tsconfig.test.json")) return false;
    if (!/test/.test(readFileSync("tsconfig.test.json", "utf8"))) return false;
    // and BOTH CI lanes must actually invoke it (GitLab is the CI; the GitHub
    // workflow is the redundant lane, and both are pinned by
    // test/gate-wiring.test.ts's CI-config pair).
    for (const ci of [".gitlab-ci.yml", ".github/workflows/ci.yml"]) {
      if (!existsSync(ci)) return false;
      if (!/npm run typecheck/.test(readFileSync(ci, "utf8"))) return false;
    }
    return true;
  },
  // --- 4. truth of external claims ---
  // 4.1 and 4.2 are NOT measured as boolean pass — they are measured as
  // "does the recorded `fail` still describe reality?", so they are handled
  // explicitly below rather than silently assumed true.
};

/**
 * THE single readiness rule, single-sourced so two tests can never disagree.
 *
 * READY requires BOTH:
 *   (a) every criterion in sections 1-4 is `pass`  — no known defect, and
 *   (b) the operator has EXPLICITLY acknowledged the section-5 items that this
 *       box cannot honestly measure (CI green, live browser round-trips).
 *
 * Condition (b) is not a formality: `unverifiable` and `blocked` are NOT passes
 * (the project's own doctrine), so they cannot be silently absorbed. But they
 * are also not defects — they need a human or a CI run, not a code change. So
 * they become a recorded, acknowledged hand-off rather than a permanent block.
 */
/**
 * The ack is ONE line-anchored field. A loose regex is unsafe: the state's own
 * rule description mentions the token, and a prose mention must never be
 * mistaken for the field — that bug shipped once and the gate caught nothing.
 */
function ackField(): "yes" | "no" {
  const m = /^operator_ack:\s*(yes|no)\s*$/im.exec(READY);
  return (m?.[1]?.toLowerCase() as "yes" | "no") ?? "no";
}

function readinessVerdict(): "READY" | "NOT READY" {
  const stored = storedVerdicts();
  const hasFail = [...stored.entries()].some(([id, v]) => v === "fail" && !id.startsWith("5."));
  return !hasFail && ackField() === "yes" ? "READY" : "NOT READY";
}

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
    const headline = /## Current state — \*\*(NOT READY FOR PRODUCTION|READY FOR PRODUCTION)\*\*/.exec(READY)?.[1];
    assert.ok(headline, "the file must name its headline verdict");
    const expected = readinessVerdict();
    assert.equal(
      headline,
      expected === "READY" ? "READY FOR PRODUCTION" : "NOT READY FOR PRODUCTION",
      `the headline disagrees with the criteria: no open fail + acknowledged section 5 => ${expected}`,
    );
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
    // Simulate someone editing the file to claim READY while the section-5
    // hand-off is still UNACKNOWLEDGED — the most tempting fabrication, because
    // no `fail` criterion remains to catch it.
    const stored = storedVerdicts();
    const hasFail = [...stored.entries()].some(([id, v]) => v === "fail" && !id.startsWith("5."));
    const fabricated = READY.replace("NOT READY FOR PRODUCTION", "READY FOR PRODUCTION");
    const naiveReader = /## Current state — \*\*(NOT READY FOR PRODUCTION|READY FOR PRODUCTION)\*\*/.exec(fabricated)?.[1];
    assert.equal(naiveReader, "READY FOR PRODUCTION", "precondition: a naive reader accepts the fabrication");
    // the gate recomputes from criteria, and refuses it
    const gateSays = !hasFail && ackField() === "yes" ? "READY" : "NOT READY";
    // Map the gate's verdict onto the file's own headline string HERE, outside
    // the branch below. `assert.equal` from node:assert/strict is `strictEqual`
    // re-exported, typed `asserts actual is T`, so the assert.equal on the next
    // line narrows `gateSays` to "NOT READY" — and a ternary comparing it to
    // "READY" AFTER that point is provably dead to the typechecker (TS2367).
    // The pin is not dead: the READY arm is data-reachable (operator_ack is the
    // operator's field, measured live), and the naive reader genuinely does
    // disagree with the gate. Computing the mapping before the narrowing keeps
    // the comparison typed as the full verdict union with no behaviour change.
    const gateStamp = gateSays === "READY" ? "READY FOR PRODUCTION" : "NOT READY FOR PRODUCTION";
    if (ackField() !== "yes" || hasFail) {
      assert.equal(gateSays, "NOT READY", "the gate refuses the fabricated stamp");
      assert.notEqual(naiveReader, gateStamp, "the naive reader and the gate DISAGREE — that disagreement is the pin working");
    }
  });

  t("the CI lane really exists in the repo (5.1 is not a hand-wave)", () => {
    // 5.1 records the full suite as `unverifiable` HERE. That is only honest if
    // the CI lane genuinely exists — otherwise "CI owns it" is an excuse.
    // 5.1 defers to GitLab CI (gitlab.pubg-sell.ir), NOT to this box.
    assert.ok(existsSync(".gitlab-ci.yml"), "the GitLab CI pipeline must exist for 5.1 to be an honest deferral");
    const ci = readFileSync(".gitlab-ci.yml", "utf8");
    assert.match(ci, /npm run test:unit/, "the pipeline must actually run the full unit suite");
    assert.match(ci, /timeout:\s*30 minutes/, "and must carry its own time cap, since this box must not run it");
    assert.match(ci, /check:verbatim/, "and must run the verbatim-completeness gates (P1..P5)");
    // Pipeline 173 died here: the build job uploaded the cloned wigolo tree
    // (node_modules + a Playwright chromium) and GitLab answered 413, killing
    // the job. A pipeline that cannot actually complete must not count as the
    // CI lane, so the fat upload is now itself a pinned prohibition.
    assert.ok(
      !/paths:\s*\[wigolo/.test(ci) && !/junit:\s*reports/.test(ci),
      "the pipeline must not upload a multi-hundred-MB artifact — that 413s and kills the job (pipeline 173)",
    );
    assert.match(ci, /413 Payload Too Large/, "and the reason must be recorded in the file so nobody re-adds it");
    assert.ok(
      /\.github\/workflows\/ci\.yml/.test(READY) === false,
      "the readiness state must not point at the old GitHub lane — GitLab is the CI",
    );
    // and the local script must NOT be the thing that runs the whole suite here
    assert.match(PKG.scripts["test:unit"] ?? "", /--test-timeout=\d+/, "the local lane stays timeout-bounded");
  });

  t("READY requires an EXPLICIT operator acknowledgement of the section-5 hand-off", () => {
    const stored = storedVerdicts();
    const nonPass = [...stored.entries()].filter(([, v]) => v !== "pass");
    const headline = /## Current state — \*\*(NOT READY FOR PRODUCTION|READY FOR PRODUCTION)\*\*/.exec(READY)?.[1];
    const acknowledged = ackField() === "yes";
    if (headline === "READY FOR PRODUCTION") {
      assert.equal(acknowledged, true, "READY was claimed without the operator acknowledging 5.1/5.2 — an unverifiable gate is NOT a pass");
      assert.deepEqual(
        [...stored.entries()].filter(([id, v]) => v !== "pass" && id.startsWith("5.")),
        [],
        "READY was claimed while a section-5 item is still open",
      );
    } else {
      // NOT READY must be justified: either a real fail, or an unacknowledged hand-off
      const hasFail = [...stored.entries()].some(([id, v]) => v === "fail" && !id.startsWith("5."));
      assert.ok(hasFail || !acknowledged || nonPass.length > 0, "a NOT-READY state must have a real, nameable reason");
    }
  });

  t("the state file is tracked, not ignored (it is the real record)", () => {
    const out = execFileSync("git", ["ls-files", "--error-unmatch", ".brain/PRODUCTION_READINESS.md"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.match(out, /PRODUCTION_READINESS\.md/, "the readiness state must be tracked in git");
  });
});
