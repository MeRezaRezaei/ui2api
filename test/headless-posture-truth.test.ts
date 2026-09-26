import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolvedHeadless, resolvedHeaded, headlessDegradedReason } from "../src/runtime/browser.js";
import { daemonPosture } from "../src/prompt/posture.js";

/**
 * GOAL 126: "am I a real user?" was decided in ~17 places by the ENV-ONLY
 * predicate `UI2API_HEADED !== "1"`, while the launch seam resolved the ACTUAL
 * mode as `!(wantHeadful && displayAvailable())`. The two truths disagreed, and
 * MEASURED with `UI2API_HEADED=1` and no DISPLAY:
 *
 *   {runnerSaysHeaded: false, runnerTreatsAsRealUser: true, spawnActualHeadless: true}
 *
 * That is the worst of both worlds — the real-user branch fires (viewport
 * inheritance, light-mode asset aborting SKIPPED, GPU/software-rasterizer
 * hardening flags DROPPED) on a page that is actually headless, with no
 * extensions and no window chrome. A contradictory forgery is a WORSE
 * fingerprint than an honest headless default, and nothing reported the
 * mismatch. This is the project's core promise: never look synthetic.
 */

const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = `${dir}/${e}`;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

d("GOAL 126: one resolved headless truth, and the degraded case is never silent", () => {
  t("the four HEADED x DISPLAY combinations resolve correctly", () => {
    //                 HEADED DISPLAY -> headless? degraded?
    const truth: [string | undefined, string | undefined, boolean, boolean][] = [
      [undefined, undefined, true, false], // default: headless, nothing degraded
      [undefined, ":0", true, false], //     a display alone does not force headful
      ["1", ":0", false, false], //         asked + display available -> genuinely headful
      ["1", undefined, true, true], //       asked, NO display -> DEGRADED (the old lie)
    ];
    for (const [headed, display, wantHeadless, wantDegraded] of truth) {
      withEnv({ UI2API_HEADED: headed, DISPLAY: display, WAYLAND_DISPLAY: undefined }, () => {
        const label = `HEADED=${headed} DISPLAY=${display}`;
        assert.equal(resolvedHeadless(), wantHeadless, `${label}: resolvedHeadless`);
        assert.equal(resolvedHeaded(), !wantHeadless, `${label}: resolvedHeaded`);
        const reason = headlessDegradedReason();
        assert.equal(reason !== null, wantDegraded, `${label}: degraded?`);
        if (wantDegraded) assert.match(reason!, /headless-degraded/, `${label}: named verdict`);
      });
    }
  });

  t("WAYLAND_DISPLAY counts as a display too", () => {
    withEnv({ UI2API_HEADED: "1", DISPLAY: undefined, WAYLAND_DISPLAY: "wayland-0" }, () => {
      assert.equal(resolvedHeadless(), false, "a wayland session is a display");
      assert.equal(headlessDegradedReason(), null, "so nothing is degraded");
    });
  });

  t("the POSTURE report states the resolved mode and names the degradation", () => {
    // degraded
    const deg = daemonPosture({ UI2API_HEADED: "1", DISPLAY: "", WAYLAND_DISPLAY: "" } as any, "127.0.0.1");
    assert.equal(deg.headless, true, "posture must report the RESOLVED mode");
    assert.equal(deg.headful, false);
    assert.equal(deg.headlessDegraded, true, "and flag the mismatch");
    assert.ok(
      deg.warnings.some((w) => /headless-degraded/.test(w)),
      "and warn by name — a posture report that cannot say 'you asked for X, you got Y' is not a report",
    );
    // honest default
    const normal = daemonPosture({ UI2API_HEADED: "", DISPLAY: ":0" } as any, "127.0.0.1");
    assert.equal(normal.headless, true);
    assert.equal(normal.headlessDegraded, false, "nothing is degraded when headless was never requested");
    // genuine headful
    const real = daemonPosture({ UI2API_HEADED: "1", DISPLAY: ":0" } as any, "127.0.0.1");
    assert.equal(real.headless, false);
    assert.equal(real.headlessDegraded, false);
  });

  t("the env-only predicate survives ONLY inside the single resolver", () => {
    // the grep gate: a new site/runner deciding posture from the env alone is the
    // exact defect, so it must be impossible to reintroduce quietly
    const offenders: string[] = [];
    for (const f of walk("src")) {
      if (f === "src/runtime/browser.ts") continue; // it OWNS the env read
      const s = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      if (/UI2API_HEADED\s*!==\s*"1"/.test(s)) offenders.push(f);
    }
    assert.deepEqual(offenders, [], `these sites/runners still decide posture from the env alone: ${offenders.join(", ")}`);
  });

  t("the launch seam reads the SAME resolver (no second truth)", () => {
    const s = readFileSync("src/runtime/browser.ts", "utf8");
    assert.match(s, /const headless = resolvedHeadless\(overrides\)/, "the spawn must use the one resolver");
    assert.ok(
      !/const headless = !\(wantHeadful && displayAvailable\(\)\)/.test(s),
      "the old inline computation must be gone, or the two truths can diverge again",
    );
  });

  t("negative: the OLD env-only rule is required to be the failure (mutation proof)", () => {
    const oldRule = (headed?: string) => headed !== "1";
    // precondition: the old rule calls the degraded state a real user
    assert.equal(oldRule("1"), false, "precondition: old rule => NOT headless (a 'real user')");
    assert.equal(resolvedHeadless(), true, "but with no DISPLAY we are ACTUALLY headless");
    withEnv({ UI2API_HEADED: "1", DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, () => {
      assert.equal(oldRule(process.env.UI2API_HEADED), false, "precondition: the old rule still says real user");
      assert.equal(resolvedHeadless(), true, "the new rule tells the truth");
      assert.match(headlessDegradedReason()!, /headless-degraded/, "and says so by name");
    });
  });
});
