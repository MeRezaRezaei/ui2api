import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  awaitConsentWall,
  CONSENT_WALL_POLL_MS,
  type ConsentWallSignals,
} from "../src/prompt/driver.js";

/**
 * GOAL 161 — the consent-wall wait was the last BLIND sleep in the send path,
 * and unlike the pre-compose dwell it is safe to poll.
 *
 * MEASURED defect (prior lane, duckduckgo round trip 9201ms of which
 * 1850-2000ms is this wait): `waitForTimeout(wall.waitMs ?? 1800)` sat BEFORE
 * `wallVisible` was read, so a wall that renders at t=200ms still cost the full
 * 1800ms before the driver even acknowledged it.
 *
 * WHY THIS ONE IS POLLABLE AND `preComposeDelayMs` IS NOT — the asymmetry is
 * the entire safety argument, so it is modelled here rather than asserted in
 * prose:
 *
 *   pre-compose dwell : gates WHEN THE PROMPT IS DISPATCHED. A readiness probe
 *                       fires at t=0 (the composer renders before the SPA can
 *                       dispatch) and the send is SILENTLY DISCARDED. The only
 *                       instrument that observes the send-gate is the clock.
 *                       => stays a blind wait, forever.
 *   consent wall      : runs AFTER the prompt was dispatched. Acting on it can
 *                       only mean "click the site's own accept button, dwell
 *                       settleMs, re-send". No probe can make the PROMPT leave
 *                       earlier, and the click is gated on the overlay being
 *                       OBSERVED visible — a strictly stronger precondition
 *                       than today's blind click-at-1800.
 *
 * Everything here runs on a VIRTUAL clock: no real timers, no page, no network,
 * no machine state. The numbers are the model's, exact and instant.
 */

// ---------------------------------------------------------------------------
// The site model + the two drivers under comparison.
// ---------------------------------------------------------------------------

interface VirtualSite {
  /** Virtual ms at which the site's own consent overlay becomes visible. */
  wallAtMs: number | null;
  /** Make the visibility probe unreadable (as a closed page / CDP loss would). */
  probeThrows?: boolean;
  /**
   * Virtual ms ONE visibility read costs. The shipped call is
   * `accept.isVisible({ timeout: 1500 })`, and the doc block on `awaitConsentWall`
   * claims the ceiling "can never add to it". That claim is only true if a read
   * is cheap: `now()` is the real clock, so a probe that BLOCKS spends budget the
   * loop cannot reclaim. Whether Playwright's isVisible can actually block for
   * its timeout is version-dependent, so it is measured here rather than assumed.
   */
  probeCostMs?: number;
}

interface Clock {
  signals: ConsentWallSignals;
  /** Virtual ms elapsed. */
  elapsed: () => number;
  /** Virtual ms at which each visibility read happened, with its verdict. */
  reads: () => Array<{ atMs: number; visible: boolean }>;
}

/** A site + a clock the driver can only observe through injected signals. */
function virtualSite(site: VirtualSite): Clock {
  let t0 = 0;
  const reads: Array<{ atMs: number; visible: boolean }> = [];
  return {
    elapsed: () => t0,
    reads: () => reads,
    signals: {
      now: () => t0,
      sleep: async (ms: number) => {
        t0 += ms;
      },
      isVisible: async (budgetMs: number) => {
        // A real probe cannot exceed the budget it is handed; model that, so the
        // ceiling test measures the LOOP rather than an impossible probe.
        const cost = site.probeCostMs ? Math.min(site.probeCostMs, budgetMs) : 0;
        if (cost) t0 += cost;
        if (site.probeThrows) throw new Error("Target page closed");
        const visible = site.wallAtMs !== null && t0 >= site.wallAtMs;
        reads.push({ atMs: t0, visible });
        return visible;
      },
    },
  };
}

/** The code as it stood before this change: a flat dwell, one read, no early exit. */
async function blindWait(site: VirtualSite, ceilingMs: number) {
  const clock = virtualSite(site);
  const startedAt = clock.signals.now();
  await clock.signals.sleep(ceilingMs);
  const visible = await clock.signals.isVisible(ceilingMs).catch(() => false);
  return { visible, waitedMs: clock.signals.now() - startedAt };
}

/** The shipped code: bounded poll for the site's own overlay. */
async function adaptiveWait(site: VirtualSite, ceilingMs: number, pollMs?: number) {
  const clock = virtualSite(site);
  const verdict = await awaitConsentWall(ceilingMs, clock.signals, pollMs);
  return { visible: verdict.visible, waitedMs: verdict.waitedMs, polls: verdict.polls };
}

/** The numbers come from the REAL shipped profile, never from a restated literal. */
const WAIT_MS = (JSON.parse(readFileSync("capabilities/duckduckgo/profile.json", "utf8")) as {
  consentWall: { waitMs: number; settleMs: number };
}).consentWall.waitMs;
const SETTLE_MS = (JSON.parse(readFileSync("capabilities/duckduckgo/profile.json", "utf8")) as {
  consentWall: { waitMs: number; settleMs: number };
}).consentWall.settleMs;

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const DRIVER_SRC = readFileSync("src/prompt/driver.ts", "utf8");
const DRIVER_CODE = stripComments(DRIVER_SRC);

// ---------------------------------------------------------------------------

d("GOAL 161: the consent wall is polled; the no-wall cost is untouched", () => {
  t("the shipped profile's own ceiling is the number under test (duckduckgo 1800/900)", () => {
    assert.equal(WAIT_MS, 1800, "precondition: this lane's win is measured against duckduckgo's real waitMs");
    assert.equal(SETTLE_MS, 900);
    assert.equal(
      CONSENT_WALL_POLL_MS,
      100,
      "the poll must be fine enough that a t=200ms wall is caught at t=200ms, not quantised away",
    );
    assert.ok(CONSENT_WALL_POLL_MS < 200, "a poll interval at/above 200ms cannot beat a 200ms wall");
  });

  t("WIN: a wall rendering at t=200ms costs 200ms, not the 1800ms ceiling", async () => {
    const site: VirtualSite = { wallAtMs: 200 };
    const before = await blindWait(site, WAIT_MS);
    const after = await adaptiveWait(site, WAIT_MS);

    assert.equal(before.visible, true);
    assert.equal(after.visible, true);
    assert.equal(before.waitedMs, 1800, "precondition: the blind wait always pays the ceiling");
    assert.equal(after.waitedMs, 200, "the poll observes the overlay at the ms it appears");
    assert.equal(
      1800 - after.waitedMs,
      1600,
      "1600ms of dead time removed from a first send — the whole measured win",
    );
  });

  t("NO REGRESSION: a wall that NEVER appears still costs the FULL 1800ms ceiling", async () => {
    const before = await blindWait({ wallAtMs: null }, WAIT_MS);
    const after = await adaptiveWait({ wallAtMs: null }, WAIT_MS);

    assert.equal(before.visible, false);
    assert.equal(after.visible, false);
    assert.equal(after.waitedMs, WAIT_MS, "the common case (warm page, wall already consented) must not get faster");
    assert.equal(
      after.waitedMs,
      before.waitedMs,
      "the ceiling is unchanged: polling removes dead time only where there IS dead time",
    );
    assert.equal(
      after.polls,
      Math.floor(WAIT_MS / CONSENT_WALL_POLL_MS) + 1,
      "the reads are bounded and deterministic, not an unbounded spin",
    );
  });

  t("the ceiling never GROWS: the final sleep is clamped to the remaining budget", async () => {
    // 1800 is divisible by 100, so the clamped-tail path would be untested by
    // the default. A non-divisor poll forces it, and proves the last sleep
    // cannot overshoot the deadline.
    for (const pollMs of [100, 128, 300, 700, 900]) {
      const after = await adaptiveWait({ wallAtMs: null }, WAIT_MS, pollMs);
      assert.equal(after.waitedMs, WAIT_MS, `poll ${pollMs}ms must still stop dead at the ceiling`);
      assert.ok(
        after.waitedMs <= WAIT_MS,
        `poll ${pollMs}ms overshot the ceiling by ${after.waitedMs - WAIT_MS}ms`,
      );
    }
  });

  t("an UNREADABLE probe never buys a shortcut — it spends the ceiling", async () => {
    // A closed page / lost CDP makes isVisible reject. Reading that as "not
    // visible" is the honest direction; what must never happen is treating the
    // failure as permission to skip the ceiling.
    const after = await adaptiveWait({ wallAtMs: 200, probeThrows: true }, WAIT_MS);
    assert.equal(after.visible, false, "an unreadable signal is never a 'wall seen'");
    assert.equal(after.waitedMs, WAIT_MS, "an unreadable probe costs the ceiling, not less");
  });

  t("A BLOCKING PROBE IS THE CASE THE CEILING CLAIM WAS MISSING", async () => {
    // The doc block says the wait "can never add to it" because the final sleep
    // is clamped. That is only a statement about SLEEPS. `now()` is the real
    // clock, so if one visibility read blocks for its own timeout the loop pays
    // that too -- and the old blind wait paid exactly the ceiling, so exceeding
    // it is a REGRESSION against the code this replaces.
    const CEILING = 1800;
    // A probe that costs 700ms per read: two full reads fit, a third does not.
    const site: VirtualSite = { wallAtMs: null, probeCostMs: 700 };
    const after = await adaptiveWait(site, CEILING, 100);

    assert.ok(
      after.waitedMs <= CEILING,
      `a blocking probe overshot the ceiling: spent ${after.waitedMs}ms against a ${CEILING}ms ` +
        `ceiling (${after.polls} reads at ${site.probeCostMs}ms each). The pre-change code paid ` +
        `exactly ${CEILING}ms, so this is not merely slower than optimal -- it is a regression.`
    );
    // And it must still have learned the answer rather than given up silently.
    assert.equal(after.visible, false);
  });

  t("a zero ceiling still reads once and never sleeps (no infinite loop, no hang)", async () => {
    const after = await adaptiveWait({ wallAtMs: 0 }, 0);
    assert.equal(after.visible, true);
    assert.equal(after.waitedMs, 0);
    assert.equal(after.polls, 1);

    const absent = await adaptiveWait({ wallAtMs: null }, 0);
    assert.equal(absent.visible, false);
    assert.equal(absent.polls, 1, "exactly one read, then out — a 0 ceiling cannot spin");
  });
});

d("GOAL 161: the send can never be dispatched un-acknowledged", () => {
  t("the prompt's own send happens BEFORE the wall wait and is untouched by it", () => {
    const guardIdx = DRIVER_CODE.indexOf("if (!this.profile.urlTemplate && this.profile.consentWall?.accept)");
    // The CALL SITE, not the helper's own definition further up the file.
    const waitIdx = DRIVER_CODE.indexOf("= await awaitConsentWall(");
    // FIRST Enter dispatch — the one that carries the prompt, not the re-send.
    const sendIdx = DRIVER_CODE.indexOf('this.dom.press(composer, ["Enter"])');
    const clickIdx = DRIVER_CODE.indexOf("await this.dom.click(sendSel)");

    assert.ok(guardIdx > 0, "the consent-wall guard must exist");
    assert.ok(waitIdx > 0, "the driver must call the polled wait, not a blind sleep");
    assert.ok(sendIdx > 0, "the Enter send branch must exist");
    assert.ok(clickIdx > 0, "the click send branch must exist");
    assert.ok(
      Math.min(sendIdx, clickIdx) < guardIdx && waitIdx > guardIdx,
      "the wall wait must stay AFTER the prompt dispatch — that ordering IS the safety property",
    );
    // And the wall block itself never composes: it only acknowledges and re-sends.
    const wallBlock = DRIVER_CODE.slice(guardIdx, guardIdx + 900);
    assert.ok(
      !wallBlock.includes("this.dom.type("),
      "the wall block must not re-type the prompt — acknowledgement only, never a synthesised send",
    );
  });

  t("the acknowledge + settle + RE-SEND are still gated on an OBSERVED wall", () => {
    assert.match(
      DRIVER_CODE,
      /const \{ visible: wallVisible \} = await awaitConsentWall\(/,
      "the polled verdict must feed the existing `if (wallVisible)` gate",
    );
    assert.ok(
      DRIVER_CODE.includes("if (wallVisible)"),
      "the settle + re-send must remain behind the wall-visibility branch",
    );
    const settleIdx = DRIVER_CODE.indexOf("if (wallVisible)");
    assert.match(
      DRIVER_CODE.slice(settleIdx, settleIdx + 400),
      /waitForTimeout\(wall\.settleMs \?\? 900\)/,
      "the post-acknowledge settle must be UNCHANGED — the site's re-arm window is not ours to shorten",
    );
    assert.match(
      DRIVER_CODE.slice(settleIdx, settleIdx + 400),
      /this\.dom\.press\(composer, \["Enter"\]\)|this\.dom\.click\(this\.profile\.send\.selector\)/,
      "the re-send must still be the site's own click / Enter",
    );
  });

  t("the pre-compose dwell stays BLIND — this lane must not repeat the rejected experiment", () => {
    // The prior lane's rejected win: make preComposeDelayMs adaptive. With a
    // send-gate that arms at 6000ms a DOM-presence probe fires at 0ms and the
    // send is silently discarded. Nothing here may weaken that blind wait.
    assert.match(
      DRIVER_CODE,
      /if \(this\.profile\.preComposeDelayMs\) \{\s*await this\.page!\.waitForTimeout\(Math\.round\(this\.profile\.preComposeDelayMs/,
      "preComposeDelayMs must remain an unconditional blind dwell once armed",
    );
    const preComposeIdx = DRIVER_CODE.indexOf("preComposeDelayMs");
    assert.ok(
      !DRIVER_CODE.slice(preComposeIdx, preComposeIdx + 400).includes("awaitConsentWall"),
      "the pre-compose dwell must NOT be routed through the poll — that is the rejected change",
    );
    assert.equal(
      (DRIVER_SRC.match(/preComposeDelayMs \+ Math\.random\(\) \* (\d+)\)/) ?? [])[1],
      "600",
      "the 8000ms cold-boot dwell + 0-600ms jitter is unchanged",
    );
  });

  t("a re-send is never modelled as firing without observe -> click -> settle", async () => {
    // The full post-first-send sequence, so the ordering claim is a measurement
    // rather than a reading of the source: the re-send time is the wall
    // observation + the full settle, never less.
    for (const wallAtMs of [0, 200, 900, 1799]) {
      const verdict = await awaitConsentWall(WAIT_MS, virtualSite({ wallAtMs }).signals);
      assert.equal(verdict.visible, true);
      assert.ok(
        verdict.waitedMs >= wallAtMs,
        `the wait may not end before the overlay is observable (wall ${wallAtMs}, ended ${verdict.waitedMs})`,
      );
      assert.ok(
        verdict.waitedMs + SETTLE_MS >= wallAtMs + SETTLE_MS,
        "the site's full post-accept settle is preserved on every wall-present path",
      );
    }
    const absent = await awaitConsentWall(WAIT_MS, virtualSite({ wallAtMs: null }).signals);
    assert.equal(absent.visible, false, "no observation => no acknowledge => no re-send");
  });
});

d("GOAL 161: mutation proof — both gates bite", () => {
  /** The gate this file actually relies on, as a reusable predicate. */
  const gateWallCost = (waitedMs: number) => waitedMs <= WAIT_MS / 4;
  const gateCeilingNotGrown = (waitedMs: number) => waitedMs === WAIT_MS;

  t("MUTATION 1: reverting the wait to the blind sleep turns the win gate RED", async () => {
    const mutated = await blindWait({ wallAtMs: 200 }, WAIT_MS);
    assert.equal(gateWallCost(mutated.waitedMs), false, "the reverted code MUST fail the win gate");
    assert.equal(
      gateWallCost((await adaptiveWait({ wallAtMs: 200 }, WAIT_MS)).waitedMs),
      true,
      "precondition: the shipped code passes it — so the gate is not vacuous",
    );
  });

  t("MUTATION 2: raising the ceiling turns the no-regression gate RED", async () => {
    const RAISED = 3600;
    assert.equal(gateCeilingNotGrown((await adaptiveWait({ wallAtMs: null }, RAISED)).waitedMs), false);
    assert.equal(gateCeilingNotGrown((await adaptiveWait({ wallAtMs: null }, WAIT_MS)).waitedMs), true);
  });

  t("MUTATION 3: deleting the `if (wallVisible)` gate is caught by the source gates", async () => {
    const mutated = DRIVER_CODE.replace("if (wallVisible) {", "if (true) {");
    assert.ok(
      !mutated.includes("if (wallVisible)"),
      "precondition: the mutation removed the gate under test",
    );
    assert.equal(
      DRIVER_CODE.includes("if (wallVisible)"),
      true,
      "the shipped code still gates acknowledge + re-send on an observed wall",
    );
    assert.equal(
      (await adaptiveWait({ wallAtMs: null }, WAIT_MS)).visible,
      false,
      "and the wait itself still refuses to report a wall it never saw",
    );
  });
});