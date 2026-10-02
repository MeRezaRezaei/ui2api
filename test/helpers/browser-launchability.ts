/**
 * THE BROWSER-LAUNCH SEAM'S OWN VERDICT — and the guard that reads it.
 *
 * GOAL 151. THE DEFECT THIS FILE EXISTS TO KILL, measured on this box.
 *
 * `test/wigolo-engine.test.ts` guarded its browser work with `maybe()`, which was
 * `if (!env) { t.skip(...) }`. `env` was set by a top-level `await` that
 * health-polls the daemon and resolves on `{status:"healthy"}`. So the guard
 * asked the WRONG QUESTION. It asked "is the daemon PROCESS alive?" and used the
 * answer to decide whether to run work that requires "can the daemon's BROWSER
 * TIER launch a page?". Those are different questions with different answers, and
 * this box answers them differently at the same instant:
 *
 *     daemon liveness      -> `{status:"healthy"}`        (the process answers)
 *     browser launchability-> `Executable doesn't exist at
 *                              .../chromium_headless_shell-1228/...`
 *
 * So: daemon up + browser dead => `maybe()` returns `fn()`, the browser work
 * happens INSIDE the test body, there is no `catch` anywhere in those bodies, and
 * the test goes red. THREE tests red, from a guard that was present precisely to
 * prevent red.
 *
 * THE SAME DEFECT, INDEPENDENTLY, IN A SECOND PLACE. `../wigolo`'s own
 * `detectPlaywrightInstall()` (`src/fetch/playwright-tier.ts:15`) is the daemon's
 * version of this mistake and it is worth naming because it is the strongest
 * possible evidence that fs-probing a path is NOT launchability. It answers with
 * `existsSync(chromium.executablePath())` — the FULL chromium, `chromium-1228` —
 * while the headless launch that actually runs resolves to a DIFFERENT artifact,
 * the headless shell, `chromium_headless_shell-1228`. MEASURED on this box with
 * the shell absent: `detectPlaywrightInstall()` reported `installed: true` and
 * `chromium.launch({headless:true})` failed on the very next line. A path that
 * exists is not a browser that launches. Only the launch decides.
 *
 * WHY SKIP-OR-FAIL IS DECIDED HERE RATHER THAN PER CALL SITE, and why the answer
 * is neither of the two obvious ones.
 *
 * The obvious answer for a missing binary is SKIP: it is an environment fault, not
 * a property of this code. That answer is exactly the failure this repository
 * keeps fighting, and it fails in a specific, measurable way. These tests are
 * `describe`-scoped and the browser work is inside each `it`. If the guard skips,
 * `npm run test:unit` prints `pass 0 fail 0 skipped 4` for the file and the box
 * is GREEN — with the entire browser half of the engine untested and nothing in
 * the exit code, the summary, or any artifact saying so. That is GOAL 150's exact
 * defect ("the browser half did not run") re-introduced through a different door,
 * and this time not even a log line: a skip is not even a log line.
 *
 * So this guard does NOT skip on a missing binary. It FAILS, with a name.
 *
 * The cost of failing is named here rather than discovered later, because it is
 * real: on a box where nobody ever ran `npx playwright install`, this suite is
 * red, and it stays red until someone runs it. That is deliberate, for a reason
 * the repo already wrote down about a neighbouring gate: a gate that cannot go
 * red is not a gate. `npx playwright install chromium-headless-shell` is a bounded,
 * one-command, no-network-auth fix; "the suite is red and the message says
 * exactly which artifact is missing and how to get it" is the outcome that teaches
 * the truth. The opposite shape — green, with the browser half silently absent —
 * is what lets a real browser regression reach production behind a green box.
 *
 * THE HONEST COST, stated rather than hidden. Between "green but lying" and "red
 * but honest", this picks red. Where the cost is real is the artifact-uploader
 * mistake: a CI lane that fails on a MISSING BINARY rather than a defect is a
 * lane that can be red for a reason no code change fixes. The distinction this
 * guard draws is the one that keeps that mistake out: it separates a fault in
 * THIS REPOSITORY from a fault in the PROVISIONING, and it fails on both with
 * DIFFERENT, NAMED reasons, because "your cached browser is absent" and "the
 * launch seam regressed" must never be the same red. A reader who cannot tell
 * them apart has learned nothing from the failure, and that is the whole defect
 * being fixed. See {@link classifyLaunchFailure}.
 *
 * THE ONE THING THAT IS NOT NEGOTIABLE, and the reason this guard lives at the
 * LAUNCH seam rather than as a pre-flight boolean. A guard that asks "can this
 * browser launch?" by checking a PATH is the bug again, one layer up. So
 * {@link probeLaunchability} LAUNCHES: it runs the same code the test would run,
 * and reports what actually happened. When it cannot launch it captures the real
 * error text and hands it to the classifier — so the reason in the failure is the
 * browser's own words, not a guess this file made up.
 *
 * WHY THE EXISTING VERDICT MODULE IS NOT REUSED FOR THE CLASSIFIER. It is, for
 * the OS-library axis: {@link classifyLaunchFailure} delegates to
 * `classifyIntegrationFailure` from `./browser-verdict.js` so there is exactly ONE
 * answer to "is this missing shared object Debian's fault or ours?" in this
 * repository. What it does NOT reuse is `makeVerdict`/`writeVerdict`: that file's
 * schema is pinned to `suite: "integration"` and read by `gate-wiring.test.ts` as
 * the record of `npm test`. This guard is the UNIT lane's record of a per-test
 * launch, and overwriting the integration verdict from inside a unit test would
 * destroy the very fact GOAL 150 exists to preserve — a unit run would silently
 * relabel a passed integration as a skip. So the two share the CLASSIFIER (the
 * part that decides) and deliberately do not share the FILE (the part that
 * records), because they record different runs.
 */
import { existsSync } from "node:fs";
import type { TestContext } from "node:test";
import { classifyIntegrationFailure, type Classification } from "./browser-verdict.js";

/**
 * Which seam a launch goes through. This is load-bearing and not decoration: the
 * ui2api seam has a system-Chrome fallback ladder and the wigolo daemon tier does
 * not, so on a box with a system Chrome but no cached headless shell these two
 * behave DIFFERENTLY at the same moment. MEASURED on this box: `launchBrowser()`
 * succeeded through `/usr/bin/google-chrome-stable` in 1.5s, while the wigolo
 * daemon's `chromium.launch({headless:true})` failed on the missing headless
 * shell. A guard that reported one boolean "browser available?" for both would
 * have been wrong about one of them.
 */
export type LaunchSeam =
  /** `launchBrowser()` in `src/runtime/browser.ts` — the ladder with the system-Chrome fallback. */
  | "ui2api-ladder"
  /** `chromium.launch({headless:true})` inside the wigolo daemon — NO channel fallback (MEASURED). */
  | "wigolo-daemon-tier";

export type Launchability =
  /** The probe really launched a browser and closed it. The test may run. */
  | { launchable: true; seam: LaunchSeam; detail: string }
  /**
   * The probe did not launch. `reason` is a NAMED verdict, never empty, and it is
   * built from the browser's own error text so it can be acted on.
   */
  | {
      launchable: false;
      seam: LaunchSeam;
      /** `browser-provisioning` = a cached artifact is absent. `launch-regression` = ours. */
      kind: "browser-provisioning" | "launch-regression";
      reason: string;
    };

/**
 * PLAYWRIGHT'S OWN "the artifact you asked for is not on disk" diagnostic.
 *
 * Named and matched rather than inferred from a path shape, for the reason the
 * OS-library classifier spells out at length: the only thing available at failure
 * time is the text, and a shape heuristic ("looks like a cache path") would happily
 * accept a regression that merely mentions a cache path. Playwright emits this
 * exact sentence when `executablePath()` names an artifact that is absent.
 */
const BINARY_ABSENT =
  /executable doesn't exist|looks like playwright was just installed or updated|browserType\.launch:.*executable/i;

/**
 * Classify a launch failure into the one axis that matters to a reader: is this
 * something a code change fixes, or something a provisioning command fixes?
 *
 * THE AXIS, and why it is the OS-library axis plus one term. A browser launch can
 * fail for a reason that belongs to THIS REPOSITORY (a regression in the launch
 * seam, an automation flag that stopped being passed, a profile that no longer
 * resolves) or for a reason that belongs to the MACHINE (no cached browser, an OS
 * shared object `playwright install-deps` was supposed to provide). Both are red.
 * They must not be the SAME red, because the remedy differs completely — one is a
 * code change, the other is one command — and a reader who cannot tell them apart
 * has learned nothing from the failure.
 *
 * DELEGATION IS THE POINT. The OS-library half is answered by
 * `classifyIntegrationFailure`, the same function `test/integration.ts` calls and
 * the same function `test/gate-wiring.test.ts` pins. So "is this missing shared
 * object Debian's fault or ours?" has exactly ONE answer in this repository. A
 * second copy of that list would be a second thing that can drift, and it would
 * drift in the direction that hides a regression — which is the direction this
 * whole file exists to close.
 *
 * FAIL-CLOSED, in both directions, deliberately:
 *   - an unrecognised OS library stays a FAILURE (delegated, unchanged);
 *   - an unrecognised launch failure stays `launch-regression`, i.e. red.
 * There is no third bucket that silently absorbs the unknown. The default is the
 * honest one: we do not know, so it is not excused.
 */
export function classifyLaunchFailure(blob: string): {
  kind: "browser-provisioning" | "launch-regression";
  reason: string;
} {
  // Axis 1 — Playwright told us the artifact it was told to launch is not on disk.
  // This is the class this box measured, and it is unambiguously a provisioning
  // fact: no code change to ui2api or to wigolo makes a missing file appear.
  if (BINARY_ABSENT.test(blob)) {
    return {
      kind: "browser-provisioning",
      reason:
        "the browser binary Playwright was told to launch is not present in its cache " +
        "(this is a PROVISIONING fault, not a code fault: run `npx playwright install chromium` " +
        "— and `npx playwright install chromium-headless-shell` for the wigolo daemon tier, which " +
        "launches a DIFFERENT artifact than `chromium.executablePath()` reports). " +
        `Browser said: ${firstLine(blob)}`,
    };
  }
  // Axis 2 — the dynamic loader, delegated to the ONE classifier. Its `skipped`
  // answer is reported here as provisioning, and it is the only path on which that
  // word appears: everything below is a regression.
  const loader: Classification = classifyIntegrationFailure(blob);
  if (loader.outcome === "skipped") {
    return { kind: "browser-provisioning", reason: loader.reason };
  }
  // Axis 3 — the browser was present and something else went wrong. Red, named.
  return {
    kind: "launch-regression",
    reason:
      "the browser binary was present and the launch still failed, so this is a real failure and " +
      `not an environment fault: ${firstLine(blob)}`,
  };
}

function firstLine(blob: string): string {
  const line = blob
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^[║╔╚═╠╣╦╩]*$/.test(l));
  return (line ?? blob).slice(0, 300);
}

/**
 * Probe the REAL seam by running the same launch the test would run.
 *
 * `launch` is injected rather than imported so this helper stays a pure judge:
 * the caller passes the launch its own seam performs. That is what lets ONE guard
 * serve both seams (see {@link LaunchSeam}) without this file knowing anything
 * about playwright, wigolo, or ui2api's ladder — and it is what makes the probe
 * honest, because the code under test is the code being probed.
 *
 * `probe` must CLOSE whatever it opened. A probe that leaks a browser would make
 * every guarded test slower and would eventually trip the spawn-leak gates.
 *
 * The probe is bounded by the caller: `run` is expected to be already-bounded, and
 * a hang inside it surfaces as a test timeout rather than as an unbounded wait,
 * because `node --test-timeout` is the outer bound on the whole `it`.
 */
export async function probeLaunchability(
  seam: LaunchSeam,
  launch: () => Promise<{ close?: () => Promise<unknown> | unknown } | unknown>,
): Promise<Launchability> {
  let opened: { close?: () => Promise<unknown> | unknown } | undefined;
  try {
    opened = (await launch()) as { close?: () => Promise<unknown> | unknown } | undefined;
    return { launchable: true, seam, detail: `${seam} launched and closed cleanly during the probe` };
  } catch (e) {
    const blob = `${(e as Error)?.message ?? String(e)}\n${(e as { stack?: string })?.stack ?? ""}`;
    const { kind, reason } = classifyLaunchFailure(blob);
    return { launchable: false, seam, kind, reason };
  } finally {
    // The probe's own cleanup is best-effort and MUST NOT throw: a close failure
    // is not the launch verdict, and letting it escape would replace a truthful
    // "not launchable" with an unrelated error.
    try {
      await opened?.close?.();
    } catch {
      /* the probe's verdict is the launch, not the teardown */
    }
  }
}

/**
 * THE GUARD. Decides whether a browser-dependent test body may run, and makes the
 * "no" branch a NAMED red rather than a silent skip.
 *
 * WHY IT FAILS INSTEAD OF SKIPPING — the load-bearing decision, argued once here
 * rather than at each of the call sites that use it:
 *
 *   1. A skip here is invisible. These bodies run inside `it(...)`, so skipping
 *      yields `skipped 4`, exit 0, green box — with the browser half untested and
 *      nothing anywhere recording that. GOAL 150 spent this repository's effort
 *      making "the browser half did not run" an assertable fact for `npm test`;
 *      a silent skip in the unit lane would undo that for the lane that runs more
 *      often and is read less carefully.
 *   2. A green box is the WORST outcome available. Not red-and-annoying, not
 *      red-and-wrong: green, with a browser regression shipping behind it. The
 *      whole reason this guard exists is that the previous one produced exactly
 *      that shape for every fault that was not "the daemon is down".
 *   3. The fix is one bounded command. `npx playwright install chromium-headless-shell`
 *      is ~30s and needs no credentials. A red whose message names the artifact
 *      and the command is a BETTER teacher than a green that hides a missing
 *      binary — and unlike the artifacts-uploader mistake, this red says WHY it is
 *      red and names which of the two worlds it came from.
 *
 * THE HONEST LIMIT, stated rather than buried: a box that has never run
 * `npx playwright install` WILL be red here, and this is intended. That is the
 * price of not lying, and it is paid only by boxes that genuinely cannot run
 * these tests. It is emphatically NOT the same as a permanent red for a code
 * defect — {@link classifyLaunchFailure} keeps the two reasons textually
 * distinct so the reader knows which one they have.
 *
 * `launch` runs once per guarded test, not once per file, so a browser that dies
 * mid-file is caught by the test that needed it rather than being assumed good for
 * the ones after it.
 */
export async function guardBrowser<T>(
  t: TestContext,
  seam: LaunchSeam,
  launch: () => Promise<{ close?: () => Promise<unknown> | unknown } | unknown>,
  run: () => Promise<T>,
): Promise<T | undefined> {
  const verdict = await probeLaunchability(seam, launch);
  if (!verdict.launchable) {
    // The FAILURE, not a skip. `t.diagnostic` is not enough on its own — it does
    // not change the outcome — so the throw below is what actually turns the lane
    // red, and the diagnostic is there so the reason is legible without a stack
    // trace if someone reads only the test runner's summary.
    t.diagnostic(
      `browser not launchable via the ${seam} seam — classified ${verdict.kind}. ${verdict.reason}`,
    );
    throw new Error(
      `browser not launchable (${verdict.kind}) via the ${seam} seam. ` +
        `This is the launchability guard, not the test body: the body is never reached when the ` +
        `browser cannot launch, and it is never skipped either, because a silent skip would report ` +
        `this suite green while the browser half went untested. ${verdict.reason}`,
    );
  }
  return run();
}

/**
 * TRUE ONLY WHEN a browser binary is cached on disk. Deliberately NOT used to
 * decide launchability — see the file header: `chromium.executablePath()` names
 * the full chromium while a headless launch resolves to the headless shell, so
 * this returns true on a box whose headless launches all fail.
 *
 * It exists for one narrow job: letting a caller report a MISSING artifact by
 * name (the path), which is the single most useful thing to put in the message
 * when a launch fails. Anything that treats its result as "the browser works" has
 * reintroduced the bug this file was written to remove.
 */
export function cachedBinaryPath(candidate: string): string | null {
  return existsSync(candidate) ? candidate : null;
}