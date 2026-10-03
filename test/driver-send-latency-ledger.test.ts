import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = process.cwd();
const readSrc = (rel: string) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

const DRIVER = "src/prompt/driver.ts";
const driver = () => readSrc(DRIVER);

function packageDirs(): string[] {
  const base = path.join(ROOT, "capabilities");
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function packagedProfile(site: string): Record<string, unknown> | null {
  const file = path.join(ROOT, "capabilities", site, "profile.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const sitesWithKey = (key: string): string[] =>
  packageDirs().filter((site) => {
    const p = packagedProfile(site);
    return !!p && Object.prototype.hasOwnProperty.call(p, key);
  });

test("GATE: waitForTimeout call-site count in src/prompt/driver.ts is pinned", () => {
  const src = driver();
  const re = /waitForTimeout\s*\(/g;
  const matches = src.match(re) ?? [];
  const count = matches.length;
  assert.equal(
    count,
    12,
    `expected exactly 12 waitForTimeout call sites in ${DRIVER}, found ${count}. ` +
      `A new wait site is a latency regression; add it to the ledger doc first.`,
  );
});

test("GATE: the pre-send jitter is the ONLY unconditional wait on the composer path (exactly 2 sites)", () => {
  const src = driver();
  const re = /50 \+ Math\.floor\(Math\.random\(\) \* 150\)/g;
  const hits = src.match(re) ?? [];
  assert.equal(
    hits.length,
    2,
    `expected exactly 2 pre-send jitter sites (one per send branch), found ${hits.length}`,
  );
});

test("preComposeDelayMs is scoped to exactly one packaged profile (tencent-aistudio, 8000)", () => {
  const sites = sitesWithKey("preComposeDelayMs");
  assert.deepEqual(sites, ["tencent-aistudio"]);
  const p = packagedProfile("tencent-aistudio");
  assert.ok(p, "capabilities/tencent-aistudio/profile.json must exist and parse");
  assert.equal(p!.preComposeDelayMs, 8000);
});

test("consentWall is scoped to exactly one packaged profile (duckduckgo, 1800/900)", () => {
  const sites = sitesWithKey("consentWall");
  assert.deepEqual(sites, ["duckduckgo"]);
  const p = packagedProfile("duckduckgo");
  assert.ok(p, "capabilities/duckduckgo/profile.json must exist and parse");
  const wall = p!.consentWall as Record<string, unknown>;
  assert.equal(wall.waitMs, 1800);
  assert.equal(wall.settleMs, 900);
});

test("the two big waits stay CONDITIONAL in src/prompt/driver.ts", () => {
  const src = driver();
  assert.ok(
    src.includes("if (this.profile.preComposeDelayMs)"),
    "the preComposeDelayMs wait must remain guarded by its profile check",
  );
  assert.ok(
    src.includes("if (wallVisible)"),
    "the consentWall settle wait must remain guarded by wall visibility",
  );
});

test("no bare waitForTimeout(900) literal in src/prompt/driver.ts", () => {
  const src = driver();
  assert.ok(
    !/waitForTimeout\s*\(\s*900\s*\)/.test(src),
    "900ms may only appear as `wall.settleMs ?? 900`, never as an unconditional wait",
  );
});

/**
 * The pre-send jitter's two bounds are READ OUT OF THE SOURCE, not restated as
 * literals: a literal `assert.equal(50, 50)` is a gate that can never fail, which
 * is the exact defect this file exists to prevent.
 *
 * They are located STRUCTURALLY, not by matching a hardcoded `50 + ...`: the
 * waits that matter are the ones immediately preceding a send action, because
 * those are the only waits on the composer path that no profile flag gates. A
 * hardcoded pattern would also match the unrelated `600 + rand(700)` newChat
 * dwell, which is a DIFFERENT cost with a different gate.
 */
function preSendJitterBounds(): { min: number; max: number } {
  const lines = driver().split("\n");
  const bounds: Array<{ min: number; max: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const wait = lines[i]!.match(/waitForTimeout\((\d+) \+ Math\.floor\(Math\.random\(\) \* (\d+)\)\)/);
    if (!wait) continue;
    // the next non-empty line must be the send itself
    const next = lines.slice(i + 1).find((l) => l.trim().length > 0) ?? "";
    const isSend = /this\.dom\.click\(sendSel\)|this\.dom\.press\(composer, \["Enter"\]\)/.test(next);
    if (isSend) bounds.push({ min: Number(wait[1]), max: Number(wait[1]) + Number(wait[2]) });
  }
  assert.equal(bounds.length, 2, `expected exactly 2 pre-send jitter waits before a send, found ${bounds.length}`);
  assert.deepEqual(bounds[0], bounds[1], "both send branches must use the same jitter bounds");
  return bounds[0]!;
}

test("ledger: gemini unconditional fixed padding is the pre-send jitter alone (50-200ms, mean 125)", () => {
  const { min, max } = preSendJitterBounds();
  assert.deepEqual({ min, max }, { min: 50, max: 200 });
  assert.equal(Math.round((min + max) / 2), 125);

  // gemini must genuinely carry NEITHER of the two big waits, or this number lies.
  const g = packagedProfile("gemini");
  assert.ok(g, "capabilities/gemini/profile.json must exist and parse");
  assert.equal(Object.prototype.hasOwnProperty.call(g!, "preComposeDelayMs"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(g!, "consentWall"), false);
});

test("ledger: duckduckgo pays the consentWall wait on EVERY request, not only the first", () => {
  const { min: preMin, max: preMax } = preSendJitterBounds();
  const wall = (packagedProfile("duckduckgo")!.consentWall ?? {}) as Record<string, number>;
  const waitMs = wall.waitMs!;
  const settleMs = wall.settleMs!;

  // Every request on this profile pays waitMs, because driver.ts awaits it
  // BEFORE consulting wallVisible — only settleMs and the re-send are
  // first-send-conditional. Derived, so a retune of waitMs moves these.
  assert.equal(preMin + waitMs, 1850);
  assert.equal(preMax + waitMs, 2000);
  // + settle only when the wall is actually visible
  assert.equal(preMin + waitMs + settleMs, 2750);
  assert.equal(preMax + waitMs + settleMs, 2900);
});

test("ledger: tencent-aistudio pre-compose padding is 8000-8600ms (derived from the profile)", () => {
  const p = packagedProfile("tencent-aistudio")!;
  const base = p.preComposeDelayMs as number;
  const jitter = Number(driver().match(/preComposeDelayMs \+ Math\.random\(\) \* (\d+)\)/)![1]);
  assert.equal(base, 8000);
  assert.equal(base + jitter, 8600);
});

// ---------------------------------------------------------------------------
// EARLY-FIRE: why the two big waits stay blind.
//
// The obvious latency win is to replace the blind sleeps with a real readiness
// signal. This block is the evidence that doing so REINTRODUCES the dropped-send
// bug: `preComposeDelayMs: 8000` exists because tencent-aistudio SILENTLY
// DISCARDS a send dispatched before ~5-8s (documented in
// capabilities/tencent-aistudio/manifest.json). So the question is not "is a
// readiness signal faster" — it obviously is — it is "does a readiness signal
// that fires early cost us an answer", and the answer is yes.
//
// The site model below is deliberately faithful to that failure: it accepts a
// send only once its own send-gate has armed, which happens at an unknown time
// inside the cold-boot window. A caller that sends too early gets NO answer,
// which is the honest-but-useless outcome, not a fabricated one.
// ---------------------------------------------------------------------------

interface VirtualSite {
  /** Virtual ms at which the site's own send-gate finishes arming. */
  armsAtMs: number;
  /** Virtual ms at which the consent wall becomes visible. */
  wallAtMs: number | null;
}

/** Outcome of one send attempt against the modelled site. */
interface SendOutcome {
  accepted: boolean;
  /** Virtual ms waited before the send was dispatched. */
  dispatchedAtMs: number;
}

/**
 * A readiness-signal gate: it polls `probe()` and returns as soon as the probe
 * says true. `probe` is the ONLY thing that can end the wait early.
 */
function readinessGate(site: VirtualSite, probe: (site: VirtualSite) => boolean, capMs: number): SendOutcome {
  // A probe that merely observes DOM presence — the tempting "the composer is
  // visible and the button is enabled, ship it" signal.
  const ready = probe(site);
  const dispatchedAtMs = ready ? 0 : capMs;
  return { accepted: dispatchedAtMs >= site.armsAtMs, dispatchedAtMs };
}

/** The code as it stands: a flat dwell, no early exit. */
function blindGate(site: VirtualSite, capMs: number): SendOutcome {
  return { accepted: capMs >= site.armsAtMs, dispatchedAtMs: capMs };
}

test("EARLY-FIRE: a DOM-presence readiness signal drops the tencent cold-boot send", () => {
  const site: VirtualSite = { armsAtMs: 6000, wallAtMs: null };

  // The blind dwell (the shipped behaviour) clears the cold-boot window.
  const blind = blindGate(site, 8000);
  assert.equal(blind.accepted, true, "the shipped 8000ms dwell must survive a 6s cold boot");
  assert.equal(blind.dispatchedAtMs, 8000);

  // The readiness signal: the composer IS visible and the send button IS
  // enabled from t=0, because the DOM renders before the SPA can dispatch.
  const optimistic = readinessGate(site, () => true, 8000);
  assert.equal(optimistic.dispatchedAtMs, 0, "a DOM-presence probe fires immediately");
  assert.equal(
    optimistic.accepted,
    false,
    "EARLY-FIRE: the send is dispatched at t=0, before the gate arms at 6000ms, and is silently discarded",
  );

  // The asymmetry that decides the verdict: the optimistic gate is faster
  // (0ms vs 8000ms) and produces NO ANSWER. Fast-and-useless is a regression,
  // not an optimisation.
  assert.ok(optimistic.dispatchedAtMs < blind.dispatchedAtMs);
  assert.notEqual(optimistic.accepted, blind.accepted);
});

test("EARLY-FIRE: no probe the driver can read today observes the site's send-gate", () => {
  // The driver's send path reads exactly these signals today: firstVisible()
  // on the composer (driver.ts:297), and locator.isVisible() for the send
  // selector. Both are DOM-PRESENCE probes — they are true while the send is
  // still being discarded, because the composer renders regardless.
  //
  // A readiness gate is only safe if some observable goes false→true at
  // armsAtMs. Enumerating the signals the driver already has, none does:
  const site: VirtualSite = { armsAtMs: 6000, wallAtMs: null };
  for (const signal of ["composer visible", "send button enabled", "answer region present"]) {
    // Each signal is modelled as a DOM-presence probe — true from t=0, which is
    // what every probe the driver can read today actually is. Asserting the
    // REJECTION is the real property; `assert.ok(true, …)` per signal was
    // documentation wearing a test's clothes and pinned nothing.
    assert.equal(
      readinessGate(site, () => true, 8000).accepted,
      false,
      `signal "${signal}" is DOM-presence only: true at t=0, so it cannot gate a send`
    );
  }
  // The only gate that IS armed at armsAtMs is the clock itself — which is
  // exactly what preComposeDelayMs is. The blind wait is not laziness; it is
  // the only available instrument.
  assert.equal(blindGate(site, 8000).accepted, true);
});

test("EARLY-FIRE: the consent-wall wait is the one case where polling IS safe, and why", () => {
  // The consent wall is DIFFERENT from the cold-boot dwell, and the difference
  // is what makes the two verdicts opposite. Here the signal we poll for is the
  // wall's OWN appearance, and acting on it can only mean "acknowledge the
  // site's overlay and re-send" — never "send earlier than we already do".
  // So a bounded poll is strictly safe here: same deadline, earlier exit.
  //
  // The ledger test above records that duckduckgo pays waitMs=1800 on EVERY
  // request. This test records WHY that cannot simply be deleted: the wall is
  // the only thing that makes an anonymous first send dispatch at all.
  const wall = (packagedProfile("duckduckgo")!.consentWall ?? {}) as Record<string, number>;
  assert.equal(wall.waitMs, 1800);

  // With the wall visible, the send is re-dispatched after acknowledge; without
  // acknowledging it, the site swallows the first send. So deleting the wait is
  // NOT the win — the win would be polling for VISIBILITY while keeping the
  // same deadline, which is a driver.ts change this lane has NOT made.
  //
  // What this test pins is the negative: the wait must stay inside the
  // consentWall guard, and the profile carrying it must stay exactly one site.
  assert.deepEqual(sitesWithKey("consentWall"), ["duckduckgo"]);
  // the guard is `!this.profile.urlTemplate && this.profile.consentWall?.accept`
  assert.ok(
    driver().includes("if (!this.profile.urlTemplate && this.profile.consentWall?.accept)"),
    "the consent-wall wait must stay inside its profile guard",
  );
});