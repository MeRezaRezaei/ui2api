// OS-level requirements readiness (GOAL 33) — falsifiable checks for the
// `requirements`/`doctor` module. Every check is exercised with INJECTED
// env (process.env overrides, restored after) + injected data dir + mocked
// display/attach/chrome-version seams — the module never launches a browser
// and never touches a real binary/network in these tests. The verdict table
// asserts the NAMED reason strings incl. every on-hold branch.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { StoredAccount } from "../src/runtime/session-store.js";
import type { RegistryVerified } from "../src/prompt/registry.js";
import { requirementsSiteArg } from "../src/cli.js";
import {
  checkNodeVersion,
  checkRequirements,
  defaultRequirementsDeps,
  envKnobChecks,
  packageVerdict,
  requirementPackagesFor,
  resolveVault,
  runOsChecks,
  scopeRequirementsReport,
  summarizeVerds,
  type PackageRequirements,
  type RequirementPackage,
  type RequirementsCheck,
  type RequirementsDeps,
  type VaultResult,
} from "../src/runtime/requirements.js";

const ENV_KEYS = [
  "UI2API_HEADED",
  "UI2API_ATTACH_PORT",
  "UI2API_USER_DATA_DIR",
  "UI2API_CHROME_PROFILE_PATH",
  "UI2API_CHROME",
  "UI2API_CHROME_PATH",
  "UI2API_USER",
];

// Clear the env knobs the module reads, run fn, restore. Async-safe.
async function withCleanEnv(fn: () => Promise<void> | void): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A deps world where every real seam passes without touching the real machine.
function makeDeps(overrides: Partial<RequirementsDeps> = {}): RequirementsDeps {
  return {
    dataDir: "/tmp/req-test-data",
    nodeVersion: "v24.20.0",
    ui2apiUser: () => "ui2api",
    userExists: () => true,
    ui2apiUserDataDir: () => "/home/ui2api/.local/share/ui2api",
    ui2apiUserHome: () => "/home/ui2api",
    copiedProfileProbe: () => "present",
    detectDisplay: () => ({ display: ":20", source: "env" }),
    chromeResolve: () => "/usr/bin/google-chrome-stable",
    chromeVersion: () => "152.0.7977.82",
    bundledChromium: () => "/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome",
    probeAttachPort: async () => true,
    listAccounts: () => [],
    legacySessionPresent: () => false,
    legacySnapshotCapturedAt: () => null,
    now: () => new Date("2026-09-25T00:00:00.000Z"),
    packages: () => [],
    registryVerified: () => false,
    ...overrides,
  };
}

function pkg(over: Partial<RequirementPackage>): RequirementPackage {
  return {
    id: "gemini",
    kind: "chat",
    url: "https://gemini.google.com",
    host: "gemini.google.com",
    loginRequired: true,
    siteStatus: "builtin",
    ...over,
  };
}

const PASS_OS = { node: "v24.20.0", checks: [] as RequirementsCheck[] };

// --- (a) node floor ---

test("node floor: >= 22.13.0 (the node:sqlite unflagged floor)", () => {
  assert.equal(checkNodeVersion("v24.20.0").status, "pass");
  assert.equal(checkNodeVersion("22.13.0").status, "pass");
  assert.equal(checkNodeVersion("22.13.7").status, "pass");
  assert.equal(checkNodeVersion("22.12.9").status, "fail");
  const r = checkNodeVersion("22.12.9");
  assert.match(r.reason ?? "", /< 22\.13\.0/);
  assert.equal(checkNodeVersion("nonsense").status, "fail");
});

// --- (b) chrome binary via the launchBrowser ladder (never duplicated) ---

test("chrome: resolvable via the ladder + execute-only version probe → pass with detail", async () => {
  await withCleanEnv(async () => {
    const { checks } = await runOsChecks(makeDeps());
    const c = checks.find((x) => x.id === "chrome")!;
    assert.equal(c.status, "pass");
    assert.match(c.detail ?? "", /\/usr\/bin\/google-chrome-stable 152\.0\.7977\.82/);
  });
});

test("chrome: unresolvable → fail naming the ladder + the fix", async () => {
  await withCleanEnv(async () => {
    const { checks } = await runOsChecks(makeDeps({ chromeResolve: () => null }));
    const c = checks.find((x) => x.id === "chrome")!;
    assert.equal(c.status, "fail");
    assert.match(c.reason ?? "", /no Chrome binary resolvable through the launchBrowser ladder/);
    assert.match(c.reason ?? "", /npx playwright install chromium/);
  });
});

test("chrome: binary present but --version probe fails → fail, execute-only probe named", async () => {
  await withCleanEnv(async () => {
    const { checks } = await runOsChecks(makeDeps({ chromeVersion: () => null }));
    const c = checks.find((x) => x.id === "chrome")!;
    assert.equal(c.status, "fail");
    assert.match(c.reason ?? "", /execute-only probe/);
    assert.match(c.reason ?? "", /--version probe failed/);
  });
});

// --- (c) display ---

test("display headed: real display present → pass", async () => {
  await withCleanEnv(async () => {
    process.env.UI2API_HEADED = "1";
    const { checks } = await runOsChecks(makeDeps());
    const c = checks.find((x) => x.id === "display")!;
    assert.equal(c.status, "pass");
    assert.match(c.detail ?? "", /headed \(UI2API_HEADED=1\) — display :20/);
  });
});

test("display headed: no display → on-hold reason 'UI2API_HEADED=1 but no display detected'", async () => {
  await withCleanEnv(async () => {
    process.env.UI2API_HEADED = "1";
    const { checks } = await runOsChecks(makeDeps({ detectDisplay: () => null }));
    const c = checks.find((x) => x.id === "display")!;
    assert.equal(c.status, "fail");
    assert.match(c.reason ?? "", /UI2API_HEADED=1 but no display detected/);
    assert.match(c.reason ?? "", /Xvfb/);
  });
});

test("display headless: the bundled playwright cache is what the ladder resolved → pass with the cache detail (GOAL 41 keeps that detail text)", async () => {
  await withCleanEnv(async () => {
    const bundled = "/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome";
    const { checks } = await runOsChecks(makeDeps({ chromeResolve: () => bundled, bundledChromium: () => bundled }));
    const c = checks.find((x) => x.id === "display")!;
    assert.equal(c.status, "pass");
    assert.match(c.detail ?? "", /playwright browser cache present/);
    assert.match(c.detail ?? "", /chromium-1228/);
  });
});

test("display headless: cache missing but system Chrome resolves (launchBrowser's real fallback) → pass naming the binary", async () => {
  await withCleanEnv(async () => {
    const { checks } = await runOsChecks(makeDeps({ bundledChromium: () => null }));
    const c = checks.find((x) => x.id === "display")!;
    assert.equal(c.status, "pass");
    assert.match(c.detail ?? "", /ladder-resolved chrome \/usr\/bin\/google-chrome-stable 152\.0\.7977\.82/);
  });
});

test("display headless: cache missing + no ladder chrome → fail with the honest remedy, never the env-blind UI2API_CHROME_PATH leaf", async () => {
  await withCleanEnv(async () => {
    const { checks } = await runOsChecks(makeDeps({ chromeResolve: () => null, bundledChromium: () => null }));
    const c = checks.find((x) => x.id === "display")!;
    assert.equal(c.status, "fail");
    assert.match(c.reason ?? "", /install Chrome or run `npx playwright install chromium`/);
    assert.doesNotMatch(c.reason ?? "", /UI2API_CHROME_PATH/); // setting it cannot flip this check — never printed as a remedy
  });
});

test("display headless: UI2API_CHROME_PATH resolved by the ladder + cache missing → pass (the ladder is env-aware; the seam stands in for it)", async () => {
  await withCleanEnv(async () => {
    // The default ladder reads UI2API_CHROME_PATH FIRST (resolveChromeExec,
    // browser.ts:191-193) — the injected seam IS that ladder boundary, so the
    // check passes on the env-resolved binary with no playwright cache.
    const { checks } = await runOsChecks(
      makeDeps({ chromeResolve: () => "/opt/chrome/chrome", bundledChromium: () => null, chromeVersion: () => "150.0.0.0" })
    );
    const c = checks.find((x) => x.id === "display")!;
    assert.equal(c.status, "pass");
    assert.match(c.detail ?? "", /ladder-resolved chrome \/opt\/chrome\/chrome 150\.0\.0\.0/);
  });
});

// --- (d) machine-owned browser home ---

test("browser-home: ui2api user present + data dir + copied profile → pass", async () => {
  await withCleanEnv(async () => {
    const { checks } = await runOsChecks(makeDeps());
    const c = checks.find((x) => x.id === "browser-home")!;
    assert.equal(c.status, "pass");
    assert.match(c.detail ?? "", /\/home\/ui2api\/\.ui2api-chrome present/);
  });
});

test("browser-home: ui2api OS user missing → fail naming 'sudo useradd'", async () => {
  await withCleanEnv(async () => {
    const { checks } = await runOsChecks(makeDeps({ userExists: () => false }));
    const c = checks.find((x) => x.id === "browser-home")!;
    assert.equal(c.status, "fail");
    assert.match(c.reason ?? "", /ui2api OS user "ui2api" missing/);
    assert.match(c.reason ?? "", /sudo useradd -m ui2api/);
  });
});

test("browser-home: data dir not usable from this session → fail named, and the reason NEVER offers UI2API_DATA_DIR (GOAL 41: that knob feeds only the vault; setting it cannot flip this check)", async () => {
  await withCleanEnv(async () => {
    const { checks } = await runOsChecks(makeDeps({ ui2apiUserDataDir: () => null }));
    const c = checks.find((x) => x.id === "browser-home")!;
    assert.equal(c.status, "fail");
    assert.match(c.reason ?? "", /ui2api data dir not usable from this session/);
    assert.match(c.reason ?? "", /run one setup pass as root\/sudo -u ui2api/); // the REAL remedy stays named
    assert.doesNotMatch(c.reason ?? "", /UI2API_DATA_DIR/); // the env-blind leaf is gone
  });
});

test("browser-home: copied Chrome profile missing → fail naming '.ui2api-chrome' + the copy-of-official-Chrome fix", async () => {
  await withCleanEnv(async () => {
    const { checks } = await runOsChecks(makeDeps({ copiedProfileProbe: () => "missing" }));
    const c = checks.find((x) => x.id === "browser-home")!;
    assert.equal(c.status, "fail");
    assert.match(c.reason ?? "", /copied Chrome profile dir \/home\/ui2api\/\.ui2api-chrome missing or empty/);
    assert.match(c.reason ?? "", /copy-of-official-Chrome/); // the named fix that can actually flip this check
  });
});

test("browser-home: copied profile unreadable (EACCES) → honest 'unreadable', never 'missing'", async () => {
  await withCleanEnv(async () => {
    const { checks } = await runOsChecks(makeDeps({ copiedProfileProbe: () => "unreadable" }));
    const c = checks.find((x) => x.id === "browser-home")!;
    assert.equal(c.status, "fail");
    assert.match(c.reason ?? "", /unreadable from this session \(permission denied\)/);
    assert.doesNotMatch(c.reason ?? "", /missing/);
  });
});

// --- (f) attach port (the only network this module ever touches) ---

test("attach: UI2API_ATTACH_PORT unset → honest skip", async () => {
  await withCleanEnv(async () => {
    const { checks } = await runOsChecks(makeDeps());
    const c = checks.find((x) => x.id === "attach")!;
    assert.equal(c.status, "skip");
    assert.match(c.reason ?? "", /UI2API_ATTACH_PORT not set/);
  });
});

test("attach: port reachable (HTTP GET /json/version answered) → pass", async () => {
  await withCleanEnv(async () => {
    process.env.UI2API_ATTACH_PORT = "9222";
    const { checks } = await runOsChecks(makeDeps());
    const c = checks.find((x) => x.id === "attach")!;
    assert.equal(c.status, "pass");
    assert.match(c.detail ?? "", /UI2API_ATTACH_PORT=9222 reachable/);
  });
});

test("attach: port refused → on-hold reason 'attach port not reachable' + fix", async () => {
  await withCleanEnv(async () => {
    process.env.UI2API_ATTACH_PORT = "9222";
    const { checks } = await runOsChecks(makeDeps({ probeAttachPort: async () => false }));
    const c = checks.find((x) => x.id === "attach")!;
    assert.equal(c.status, "fail");
    assert.match(c.reason ?? "", /attach port not reachable \(UI2API_ATTACH_PORT=9222\)/);
    assert.match(c.reason ?? "", /--remote-debugging-port=9222/);
  });
});

test("attach: probe is a short HTTP GET, not a browser launch — the injected probe is the only seam used", async () => {
  await withCleanEnv(async () => {
    process.env.UI2API_ATTACH_PORT = "9222";
    let probes = 0;
    await runOsChecks(makeDeps({ probeAttachPort: async (p) => { probes++; return p === 9222; } }));
    assert.equal(probes, 1);
  });
});

// --- (g) env-knob conflicts ---

test("env-knobs: attach + user-data-dir both set → conflict named", async () => {
  await withCleanEnv(async () => {
    process.env.UI2API_ATTACH_PORT = "9222";
    process.env.UI2API_USER_DATA_DIR = "/home/me/Chrome";
    const cs = envKnobChecks(process.env);
    assert.equal(cs.length, 1);
    assert.equal(cs[0].status, "fail");
    assert.match(cs[0].reason ?? "", /UI2API_ATTACH_PORT and UI2API_USER_DATA_DIR\/UI2API_CHROME_PROFILE_PATH both set/);
  });
});

test("env-knobs: UI2API_CHROME=0 + UI2API_CHROME_PATH both set → conflict named", async () => {
  await withCleanEnv(async () => {
    process.env.UI2API_CHROME = "0";
    process.env.UI2API_CHROME_PATH = "/opt/chrome/chrome";
    const cs = envKnobChecks(process.env);
    assert.equal(cs.length, 1);
    assert.equal(cs[0].status, "fail");
    assert.match(cs[0].reason ?? "", /UI2API_CHROME=0 \(explicit off\) conflicts with UI2API_CHROME_PATH/);
  });
});

test("env-knobs: clean knobs → pass", async () => {
  await withCleanEnv(async () => {
    const cs = envKnobChecks(process.env);
    assert.equal(cs.length, 1);
    assert.equal(cs[0].status, "pass");
    assert.match(cs[0].detail ?? "", /no conflicting env-knob combos/);
  });
});

// --- (e) vault session per host ---

const ACC: StoredAccount[] = [{ slug: "me", identity: "me@x.test", host: "gemini.google.com", source: "import", capturedAt: "2026-09-01T00:00:00.000Z" }];

test("vault: identity-keyed accounts present → pass with slug detail", () => {
  const deps = makeDeps({ listAccounts: () => ACC });
  const v = resolveVault(pkg({}), deps);
  assert.equal(v.status, "pass");
  assert.match(v.detail ?? "", /1 stored account\(s\) for gemini\.google\.com \(me\)/);
});

test("vault: no accounts but legacy flat session → pass (legacy 'default' honored)", () => {
  const deps = makeDeps({ legacySessionPresent: () => true });
  const v = resolveVault(pkg({}), deps);
  assert.equal(v.status, "pass");
  assert.match(v.detail ?? "", /legacy flat session present/);
});

test("vault: no session → fail 'no stored session for <host> — awaiting-capture' + capture commands", () => {
  const deps = makeDeps();
  const v = resolveVault(pkg({}), deps);
  assert.equal(v.status, "fail");
  assert.match(v.reason ?? "", /no stored session for gemini\.google\.com — awaiting-capture/);
  assert.match(v.reason ?? "", /profile add-all --known/);
  assert.match(v.reason ?? "", /capture\/import gemini\.google\.com/);
});

test("vault: anonymous package → honest skip (no stored session needed)", () => {
  const deps = makeDeps();
  const v = resolveVault(pkg({ loginRequired: false }), deps);
  assert.equal(v.status, "skip");
  assert.match(v.reason ?? "", /anonymous — no stored session needed/);
});

test("vault: unparsable url → skip naming the missing host (never guessed)", () => {
  const deps = makeDeps();
  const v = resolveVault(pkg({ host: null }), deps);
  assert.equal(v.status, "skip");
  assert.match(v.reason ?? "", /no resolvable url — no host to key the vault by/);
});

// --- (GOAL 39) vault capture-age freshness ---

// FIXED clock for every freshness case: injected now = 2026-09-25, fixtures
// captured 2026-09-01 → 24 days → stale at SESSION_STALE_DAYS = 14.

test("vault freshness: fresh account (capturedAt = now) → pass, age 0, NO stale flag", () => {
  const deps = makeDeps({
    listAccounts: () => [{ ...ACC[0], capturedAt: "2026-09-25T00:00:00.000Z" }],
  });
  const v = resolveVault(pkg({}), deps);
  assert.equal(v.status, "pass");
  assert.equal(v.stale, false);
  assert.equal(v.ageDays, 0);
  assert.equal(v.reason, undefined); // no warn reason when fresh
  assert.match(v.detail ?? "", /1 stored account\(s\) for gemini\.google\.com \(me\) — captured 2026-09-25 \(0 days ago\)/);
});

test("vault freshness: aged account (captured 2026-09-01, now 2026-09-25) → stale true + NAMED reason with re-capture", () => {
  const deps = makeDeps({ listAccounts: () => ACC }); // ACC capturedAt 2026-09-01
  const v = resolveVault(pkg({}), deps);
  assert.equal(v.status, "pass"); // age ≠ expiry — status stays pass
  assert.equal(v.stale, true);
  assert.equal(v.ageDays, 24);
  assert.match(v.detail ?? "", /captured 2026-09-01 \(24 days ago\)/);
  assert.match(v.reason ?? "", /stale: captured 2026-09-01 \(24 days ago\)/);
  assert.match(v.reason ?? "", /profile add-all --known/);
  assert.match(v.reason ?? "", /profile capture\/import gemini\.google\.com/);
  assert.doesNotMatch(v.reason ?? "", /expired/); // NEVER an "expired" verdict
});

test("vault freshness: the OLDEST account wins (oldest = the limiting session)", () => {
  const deps = makeDeps({
    listAccounts: () => [
      { ...ACC[0], slug: "fresh", identity: "fresh@x.test", capturedAt: "2026-09-24T00:00:00.000Z" },
      { ...ACC[0], slug: "old", identity: "old@x.test", capturedAt: "2026-09-01T00:00:00.000Z" },
    ],
  });
  const v = resolveVault(pkg({}), deps);
  assert.equal(v.stale, true);
  assert.equal(v.ageDays, 24);
  assert.match(v.detail ?? "", /captured 2026-09-01 \(24 days ago\)/);
});

test("vault freshness: aged legacy flat snapshot → stale true + NAMED reason", () => {
  const deps = makeDeps({
    legacySessionPresent: () => true,
    legacySnapshotCapturedAt: () => "2026-09-01T00:00:00.000Z",
  });
  const v = resolveVault(pkg({}), deps);
  assert.equal(v.status, "pass");
  assert.equal(v.stale, true);
  assert.equal(v.ageDays, 24);
  assert.match(v.detail ?? "", /legacy flat session present for gemini\.google\.com — captured 2026-09-01 \(24 days ago\)/);
  assert.match(v.reason ?? "", /stale: captured 2026-09-01 \(24 days ago\)/);
  assert.match(v.reason ?? "", /profile add-all --known/);
});

test("vault freshness: fresh legacy snapshot → pass, no stale flag", () => {
  const deps = makeDeps({
    legacySessionPresent: () => true,
    legacySnapshotCapturedAt: () => "2026-09-25T00:00:00.000Z",
  });
  const v = resolveVault(pkg({}), deps);
  assert.equal(v.status, "pass");
  assert.equal(v.stale, false);
  assert.equal(v.ageDays, 0);
  assert.equal(v.reason, undefined);
});

test("vault freshness: no-date account (capturedAt empty) → NO flag, detail keeps no age (never guessed)", () => {
  const deps = makeDeps({
    listAccounts: () => [{ ...ACC[0], capturedAt: "" }],
  });
  const v = resolveVault(pkg({}), deps);
  assert.equal(v.status, "pass");
  assert.equal(v.stale, undefined);
  assert.equal(v.capturedAt, undefined);
  assert.equal(v.ageDays, undefined);
  assert.equal(v.reason, undefined);
  assert.match(v.detail ?? "", /1 stored account\(s\) for gemini\.google\.com \(me\)/);
  assert.doesNotMatch(v.detail ?? "", /days ago/);
});

test("vault freshness: legacy snapshot with NO date → NO flag (never guessed)", () => {
  const deps = makeDeps({
    legacySessionPresent: () => true,
    legacySnapshotCapturedAt: () => null,
  });
  const v = resolveVault(pkg({}), deps);
  assert.equal(v.status, "pass");
  assert.equal(v.stale, undefined);
  assert.equal(v.capturedAt, undefined);
  assert.equal(v.reason, undefined);
  assert.doesNotMatch(v.detail ?? "", /days ago/);
});

test("vault freshness: unparsable capturedAt → NO flag (never guessed)", () => {
  const deps = makeDeps({
    listAccounts: () => [{ ...ACC[0], capturedAt: "not-a-date" }],
  });
  const v = resolveVault(pkg({}), deps);
  assert.equal(v.status, "pass");
  assert.equal(v.stale, undefined);
  assert.equal(v.capturedAt, undefined);
});

test("vault freshness: aged session keeps the verdict ready/working (stale is a risk signal, not an expiry)", () => {
  const deps = makeDeps({ listAccounts: () => ACC });
  const vault = resolveVault(pkg({}), deps);
  assert.equal(vault.stale, true);
  const ready = packageVerdict(pkg({}), PASS_OS, vault, false);
  assert.equal(ready.verdict, "ready");
  const working = packageVerdict(pkg({ id: "deepseek", siteStatus: "verified" }), PASS_OS, vault, {
    since: "2026-09-19",
    evidence: "proof PASS 11462",
    via: "session-locked vault replay",
  });
  assert.equal(working.verdict, "working");
});

// --- per-package verdicts (the four-word verbatim vocabulary) ---

function verdict(p: RequirementPackage, os = PASS_OS, vault: VaultResult = { status: "pass" }, verified: RegistryVerified | false = false): PackageRequirements {
  return packageVerdict(p, os, vault, verified);
}

test("verdict: all OS checks pass + vault + no recorded round-trip → ready (driveable, honestly unverified)", () => {
  const r = verdict(pkg({}));
  assert.equal(r.verdict, "ready");
  assert.deepEqual(r.reasons, []);
});

test("verdict: real metadata.verified record + pass → working with the recorded proof", () => {
  const r = verdict(pkg({ id: "deepseek", siteStatus: "verified" }), PASS_OS, { status: "pass" }, {
    since: "2026-09-19",
    evidence: "proof PASS 11462",
    via: "session-locked vault replay",
  });
  assert.equal(r.verdict, "working");
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /live round-trip verified 2026-09-19 \(proof PASS 11462\)/);
});

test("verdict: a named OS check failed → on-hold with that named reason", () => {
  const os = {
    node: "v24.20.0",
    checks: [
      { id: "attach", status: "fail" as const, reason: "attach port not reachable (UI2API_ATTACH_PORT=9222) — start Chrome with --remote-debugging-port=9222 or unset UI2API_ATTACH_PORT" },
    ],
  };
  const r = verdict(pkg({}), os);
  assert.equal(r.verdict, "on-hold");
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /attach port not reachable/);
});

test("verdict: vault fail → not-ready 'no stored session' (never captured)", () => {
  const r = verdict(pkg({}), PASS_OS, { status: "fail", reason: "no stored session for gemini.google.com — awaiting-capture" });
  assert.equal(r.verdict, "not-ready");
  assert.match(r.reasons[0], /no stored session/);
});

test("verdict: no host (check cannot run) → not-ready + reason, never guessed", () => {
  const r = verdict(pkg({ host: null }), PASS_OS, { status: "skip", reason: "no resolvable url — no host to key the vault by" });
  assert.equal(r.verdict, "not-ready");
  assert.match(r.reasons[0], /no host to key the vault by/);
});

test("verdict: dormant (GOAL 32 exclusion) → not-ready with 'dormant' reason, even when OS fails", () => {
  const os = { node: "v24.20.0", checks: [{ id: "attach", status: "fail" as const, reason: "attach port not reachable" }] };
  const r = verdict(pkg({ id: "zenmux", siteStatus: "dormant" }), os);
  assert.equal(r.verdict, "not-ready");
  assert.match(r.reasons[0], /dormant \(metadata.json\)/);
  assert.match(r.reasons[0], /excluded from the chat surface until live-verified/);
});

test("verdict: dead-end → not-ready with 'dead-end' reason", () => {
  const r = verdict(pkg({ id: "xiaomimimo", siteStatus: "dead-end" }));
  assert.equal(r.verdict, "not-ready");
  assert.match(r.reasons[0], /dead-end \(metadata.json\)/);
});

// --- end-to-end reports (injected world, no real binary/network) ---

test("checkRequirements: four-verdict world — summary math + named reasons + injected seams only", async () => {
  await withCleanEnv(async () => {
    const calls = { chromeVersion: 0, attach: 0, listAccounts: 0 };
    const deps = makeDeps({
      chromeVersion: (e) => { calls.chromeVersion++; return "152.0.0.0"; },
      probeAttachPort: async (p) => { calls.attach++; return false; },
      listAccounts: (d, h) => {
        calls.listAccounts++;
        return h === "gemini.google.com" || h === "chat.deepseek.com"
          ? [{ slug: "me", identity: "me@x.test", host: h, source: "import", capturedAt: "2026-09-01T00:00:00.000Z" }]
          : [];
      },
      legacySessionPresent: () => false,
      registryVerified: (id) =>
        id === "deepseek" ? { since: "2026-09-19", evidence: "proof PASS 11462", via: "session-locked vault replay" } : false,
      packages: () => [
        pkg({}),                                                                                    // gemini: ready
        pkg({ id: "deepseek", url: "https://chat.deepseek.com", host: "chat.deepseek.com", siteStatus: "verified" }), // working
        pkg({ id: "claude", url: "https://claude.ai/new", host: "claude.ai" }),                      // not-ready (no session)
        pkg({ id: "zenmux", url: "https://zenmux.ai", host: "zenmux.ai", siteStatus: "dormant" }),    // not-ready (dormant)
        pkg({ id: "youtube", kind: "capability", url: "https://www.youtube.com", host: "www.youtube.com", loginRequired: false, siteStatus: "unverified-candidate" }), // ready (anonymous)
      ],
    });
    const report = await checkRequirements({ deps });
    assert.equal(report.node, "v24.20.0");
    assert.ok(Number.isFinite(Date.parse(report.generatedAt)));
    assert.deepEqual(report.summary, { ready: 2, working: 1, "on-hold": 0, "not-ready": 2 });
    const byId = new Map(report.packages.map((p) => [p.id, p]));
    assert.equal(byId.get("gemini")!.verdict, "ready");
    assert.equal(byId.get("youtube")!.verdict, "ready");
    assert.equal(byId.get("deepseek")!.verdict, "working");
    assert.deepEqual(byId.get("claude")!.verdict, "not-ready");
    assert.deepEqual(byId.get("zenmux")!.verdict, "not-ready");
    assert.match(byId.get("claude")!.reasons[0], /no stored session for claude\.ai/);
    assert.match(byId.get("deepseek")!.reasons[0], /live round-trip verified 2026-09-19/);
    // The injected seams are the ONLY ones used — zero real binary/network.
    assert.equal(calls.chromeVersion, 1);
    assert.equal(calls.attach, 0); // UI2API_ATTACH_PORT not set in this world
    assert.equal(calls.listAccounts, 3); // gemini + deepseek + claude; anonymous youtube skipped
  });
});

test("checkRequirements: attach refused holds every non-dormant package on-hold with the named reason", async () => {
  await withCleanEnv(async () => {
    process.env.UI2API_ATTACH_PORT = "9222";
    const deps = makeDeps({
      probeAttachPort: async () => false,
      packages: () => [
        pkg({}),
        pkg({ id: "zenmux", url: "https://zenmux.ai", host: "zenmux.ai", siteStatus: "dormant" }),
      ],
    });
    const report = await checkRequirements({ deps });
    assert.deepEqual(report.summary, { ready: 0, working: 0, "on-hold": 1, "not-ready": 1 });
    const gemini = report.packages.find((p) => p.id === "gemini")!;
    assert.equal(gemini.verdict, "on-hold");
    assert.ok(gemini.reasons.some((r) => r.includes("attach port not reachable")));
    assert.equal(report.packages.find((p) => p.id === "zenmux")!.verdict, "not-ready");
  });
});

// --- surface derivation (real repo package files — falsifiable honesty) ---

test("requirementPackagesFor: chat surface first, capability packages after; the excluded dormant/dead-end packages are surfaced HONESTLY", async () => {
  const list = requirementPackagesFor([{ id: "gemini", url: "https://gemini.google.com", loginRequired: true }]);
  const kinds = list.map((p) => p.id);
  assert.ok(kinds.indexOf("gemini") < kinds.indexOf("youtube"), "chat comes before capability");
  const zenmux = list.find((p) => p.id === "zenmux");
  const xiaomimimo = list.find((p) => p.id === "xiaomimimo");
  assert.ok(zenmux, "zenmux is surfaced (not hidden)");
  assert.equal(zenmux!.siteStatus, "dormant");
  assert.ok(xiaomimimo, "xiaomimimo is surfaced (not hidden)");
  assert.equal(xiaomimimo!.siteStatus, "dead-end");
  const youtube = list.find((p) => p.id === "youtube");
  assert.equal(youtube!.kind, "capability");
  // host derives from the manifest url ("https://youtube.com" — the vault on
  // the box is keyed data/sessions/youtube.com/, no www).
  assert.equal(youtube!.host, "youtube.com");
  assert.equal(youtube!.loginRequired, false); // auth.required=false in the manifest
});

test("default deps keep real implementations (no-op on construction; never launches)", () => {
  // Construction must not touch the machine: only closures, no probe calls.
  const deps = defaultRequirementsDeps({ dataDir: "/tmp/req-default-test" });
  assert.equal(deps.dataDir, "/tmp/req-default-test");
  assert.equal(typeof deps.chromeVersion, "function");
  assert.equal(deps.nodeVersion, process.versions.node);
});

// --- GOAL 42: the scoped report the --json payload serializes (doctor <site>) ---

test("summarizeVerds: counts the four-verdict vocabulary, ignores nothing else", () => {
  assert.deepEqual(summarizeVerds([]), { ready: 0, working: 0, "on-hold": 0, "not-ready": 0 });
  assert.deepEqual(
    summarizeVerds([
      { verdict: "ready" },
      { verdict: "working" },
      { verdict: "on-hold" },
      { verdict: "not-ready" },
      { verdict: "ready" },
    ]),
    { ready: 2, working: 1, "on-hold": 1, "not-ready": 1 }
  );
});

test("GOAL 42: scoped report (doctor <site>) filters packages + recomputes the summary — the SAME set the human path prints, serialized for --json", async () => {
  await withCleanEnv(async () => {
    const deps = makeDeps({
      listAccounts: (d, h) => (h === "gemini.google.com" || h === "chat.deepseek.com" ? ACC : []),
      legacySessionPresent: () => false,
      registryVerified: (id) =>
        id === "deepseek"
          ? { since: "2026-09-19", evidence: "proof PASS 11462", via: "session-locked vault replay" }
          : false,
      packages: () => [
        pkg({}),
        pkg({ id: "deepseek", url: "https://chat.deepseek.com", host: "chat.deepseek.com", siteStatus: "verified" }),
        pkg({ id: "claude", url: "https://claude.ai/new", host: "claude.ai" }),
      ],
    });
    const report = await checkRequirements({ deps });
    assert.deepEqual(report.summary, { ready: 1, working: 1, "on-hold": 0, "not-ready": 1 });
    // The scoped view: exactly the deepseek row, with the scope's own summary —
    // the identical filtering the human `doctor <site>` path prints.
    const scoped = scopeRequirementsReport(report, "deepseek");
    assert.equal(scoped.packages.length, 1);
    assert.equal(scoped.packages[0].id, "deepseek");
    assert.equal(scoped.packages[0].verdict, "working");
    assert.deepEqual(scoped.summary, { ready: 0, working: 1, "on-hold": 0, "not-ready": 0 });
    // The --json payload: the serialized scoped report carries the filtered set
    // + the GOAL-39 vault fields (capturedAt/ageDays/stale) intact.
    const payload = JSON.parse(JSON.stringify(scoped));
    assert.equal(payload.packages.length, 1);
    assert.equal(payload.packages[0].verdict, "working");
    assert.match(payload.packages[0].vault.detail, /captured 2026-09-01 \(24 days ago\)/);
    assert.equal(payload.packages[0].vault.stale, true);
    assert.equal(payload.summary.working, 1);
  });
});

test("GOAL 42: scoping to a non-ready site keeps the not-ready verdict + reason in the payload (exit-code truth)", async () => {
  await withCleanEnv(async () => {
    const deps = makeDeps({
      listAccounts: () => [],
      legacySessionPresent: () => false,
      packages: () => [
        pkg({}),
        pkg({ id: "claude", url: "https://claude.ai/new", host: "claude.ai" }),
      ],
    });
    const report = await checkRequirements({ deps });
    const scoped = scopeRequirementsReport(report, "claude");
    assert.equal(scoped.packages.length, 1);
    assert.equal(scoped.packages[0].verdict, "not-ready");
    assert.deepEqual(scoped.summary, { ready: 0, working: 0, "on-hold": 0, "not-ready": 1 });
    const payload = JSON.parse(JSON.stringify(scoped));
    assert.match(payload.packages[0].reasons[0], /no stored session for claude\.ai/);
    // cmdRequirements maps this to exit 1: not-ready present in the scoped set.
    assert.equal(payload.packages.some((p: { verdict: string }) => p.verdict === "not-ready"), true);
  });
});

// --- GOAL 43: the requirements/doctor argv seam (arg-order silent scope-drop) ---
// The pure helper reads the <site> positional flag-aware from the whole argv:
// both arg orders must scope identically (measured: `requirements gemini
// --json` → 1 package/exit 0 vs `requirements --json gemini` → full 33-package
// report/exit 1 driven by unrelated dormant sites), a flag's VALUE is never
// misread as a site, and the `--json`-as-site guard stays. No browser, no
// network — pure argv parsing.

test("GOAL 43: --json-only (or no flags) is not a site — the --json-as-site guard is preserved", () => {
  assert.equal(requirementsSiteArg(["requirements"]), "");
  assert.equal(requirementsSiteArg(["requirements", "--json"]), "");
  assert.equal(requirementsSiteArg(["doctor", "--json"]), "");
});

test("GOAL 43: the site is honored regardless of position — before OR after --json (the silent scope-drop pinned)", () => {
  assert.equal(requirementsSiteArg(["requirements", "gemini", "--json"]), "gemini");
  assert.equal(requirementsSiteArg(["requirements", "--json", "gemini"]), "gemini");
  assert.equal(requirementsSiteArg(["doctor", "--json", "deepseek"]), "deepseek");
});

test("GOAL 43: a value-taking flag's VALUE is never misread as the site (flag-value pairs skipped)", () => {
  assert.equal(requirementsSiteArg(["requirements", "--data-dir", "/tmp/d", "--json", "gemini"]), "gemini");
  assert.equal(requirementsSiteArg(["requirements", "--out", "/tmp/o", "gemini"]), "gemini");
  // The token after a value-taking flag is skipped even when --json also sits
  // before it; the FIRST non-flag token wins, so flag-VALUE pairs cannot leak.
  assert.equal(requirementsSiteArg(["requirements", "--registry", "URL", "--out", "/tmp/o", "--json"]), "");
});

test("GOAL 43: the requirements/doctor dispatch consumes requirementsSiteArg from the whole argv (cli-anchor)", () => {
  const cli = readFileSync("src/cli.ts", "utf8");
  assert.match(cli, /return cmdRequirements\(requirementsSiteArg\(process\.argv\.slice\(2\)\), flags\);/);
  assert.match(cli, /export function requirementsSiteArg\(argv: string\[\]\): string/);
  assert.match(cli, /VALUE_TAKING_FLAGS\.has\(tok\)/);
  // main() must not run when the module is imported (tests import the pure
  // helper) — the entry guard keeps process.exit out of the test runner.
  assert.match(cli, /if \(isCliEntry\(\)\)/);
});