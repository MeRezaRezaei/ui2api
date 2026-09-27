// GOAL 40: `ui2api smoke` — the one-command anonymous self-test. Falsifiable
// tests for the smoke module (src/prompt/smoke.ts) with INJECTED seams — the
// requirements gate, the anonymous-profile resolution, the install seam and
// the round-trip are all overridden, so NO browser is ever launched and no
// network is touched in the suite (same pattern as test/requirements.test.ts).
// Covers the four success-criteria verdicts: OS-fail -> exit 1 + named reason;
// no-anonymous-package -> named not-ready + install hint; round-trip ok ->
// exit 0; round-trip fail -> exit 1 + named reason.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ChatSiteProfile } from "../src/profile/profile.js";
import type { RequirementsCheck, RequirementsReport } from "../src/runtime/requirements.js";
import type { InstallResult } from "../src/registry/install.js";
import {
  firstContentLine,
  runSmoke,
  SMOKE_ANON_SITE,
  SMOKE_PROMPT,
  smokeExitCode,
  type SmokeDeps,
  type SmokeOutcome,
} from "../src/prompt/smoke.js";

const ENV_KEYS = [
  "UI2API_HEADED",
  "UI2API_ATTACH_PORT",
  "UI2API_USER_DATA_DIR",
  "UI2API_CHROME_PROFILE_PATH",
  "UI2API_CHROME",
  "UI2API_CHROME_PATH",
  "UI2API_USER",
  "UI2API_REGISTRY_URL",
  "UI2API_DATA_DIR",
  "UI2API_DATA_DIR_OVERRIDE",
];

// Clear the env knobs the smoke's default seams read, run fn, restore.
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

const ANON = (): ChatSiteProfile => ({
  id: "duckduckgo",
  name: "DuckDuckGo AI Chat (duck.ai)",
  url: "https://duck.ai/chat",
  loginRequired: false,
  composer: ["textarea"],
  send: { kind: "keyEnter" },
  answer: ['[id*="assistant-message"]'],
  // The REAL packaged duckduckgo profile's answer-readback timings
  // (capabilities/duckduckgo/profile.json) — 45s to capture, 2s of stability
  // before the answer is considered settled. Not 0: a 0 capture window would
  // be a profile no real site carries, and this fixture stands in for that
  // package.
  captureMs: 45000,
  stableMs: 2000,
});

const INSTALLED: InstallResult = {
  dir: "/tmp/pkgs/duckduckgo",
  siteId: "duckduckgo",
  version: "0.3.0",
  trust: "unreviewed",
  files: ["metadata.json", "manifest.json", "profile.json"],
};

function osReport(checks: RequirementsCheck[]): RequirementsReport {
  return {
    generatedAt: "2026-09-25T00:00:00.000Z",
    node: "v24.20.0",
    checks,
    packages: [],
    summary: { ready: 0, working: 0, "on-hold": 0, "not-ready": 0 },
  };
}

function makeDeps(overrides: Partial<SmokeDeps> = {}): SmokeDeps {
  return {
    dataDir: "/tmp/smoke-test-data",
    registryBaseUrl: "https://example.invalid/registry/master",
    packagesRoot: "/tmp/smoke-pkgs",
    checkOs: async () => osReport([{ id: "node", status: "pass", detail: "node v24.20.0 (>= 22.13.0)" }]),
    anonymousProfile: () => ANON(),
    installAnon: async () => INSTALLED,
    ask: async (profile, prompt) => ({
      answer: "GPT-5.6 Luna\n\nSMOKE OK",
      chunkCount: 3,
      doneReason: "stable",
      url: profile.url,
      title: "DuckDuckGo AI Chat",
    }),
    ...overrides,
  };
}

// --- the four success-criteria verdicts + exit-code mapping ---

test("OS-fail -> exit 1 + named reason (never a guessed verdict)", async () => {
  await withCleanEnv(async () => {
    const outcome = await runSmoke({
      deps: makeDeps({
        checkOs: async () =>
          osReport([
            { id: "node", status: "pass" },
            { id: "chrome", status: "pass" },
            {
              id: "display",
              status: "fail",
              reason: "headless: no usable Chrome executable (nothing the launchBrowser ladder resolves, or its --version probe failed) — install Chrome or run `npx playwright install chromium`",
            },
            {
              id: "browser-home",
              status: "fail",
              reason: "ui2api data dir not usable from this session — run one setup pass as root/sudo -u ui2api",
            },
          ]),
      }),
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /OS-level requirements not met/);
    assert.match(outcome.message, /display: headless: no usable Chrome executable/);
    assert.match(outcome.message, /browser-home: ui2api data dir not usable/);
    assert.equal(smokeExitCode(outcome), 1);
    // GOAL 42: the fail path carries the report — the NAMED fails are
    // machine-readable in report.checks[], not just buried in the message.
    assert.ok(outcome.report, "fail path still carries the requirements report");
    const display = outcome.report.checks.find((c) => c.id === "display");
    const browserHome = outcome.report.checks.find((c) => c.id === "browser-home");
    assert.equal(display?.status, "fail");
    assert.match(display?.reason ?? "", /no usable Chrome executable/);
    assert.equal(browserHome?.status, "fail");
    assert.match(browserHome?.reason ?? "", /ui2api data dir not usable/);
  });
});

test("no-anonymous-package + install seam fails -> named not-ready + install hint, exit 1", async () => {
  await withCleanEnv(async () => {
    const outcome = await runSmoke({
      deps: makeDeps({
        anonymousProfile: () => null,
        installAnon: async () => {
          throw new Error("GET registry index.json -> HTTP 404");
        },
      }),
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /no anonymous chat package installable/);
    assert.match(outcome.message, /installing "duckduckgo" failed \(GET registry index\.json -> HTTP 404\)/);
    assert.match(outcome.message, /Hint: 'ui2api install duckduckgo'/);
    assert.equal(smokeExitCode(outcome), 1);
    assert.ok(outcome.report, "install-seam fail path still carries the report");
  });
});

test("no-anonymous-package + install ok but still not driveable -> named not-ready, exit 1", async () => {
  await withCleanEnv(async () => {
    const outcome = await runSmoke({
      deps: makeDeps({ anonymousProfile: () => null }), // install succeeds, resolution still null
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /anonymous chat package "duckduckgo" installed \(v0\.3\.0\) but still not driveable/);
    assert.match(outcome.message, /loginRequired=false/);
    assert.equal(smokeExitCode(outcome), 1);
  });
});

test("round-trip ok -> exit 0 + `smoke OK: duckduckgo answered \"…\" in Nms` + install printed when it ran", async () => {
  await withCleanEnv(async () => {
    let installCalls = 0;
    let anonAvailable = false; // the package appears only after the install seam runs
    const outcome = await runSmoke({
      deps: makeDeps({
        anonymousProfile: () => (anonAvailable ? ANON() : null),
        installAnon: async () => {
          installCalls++;
          anonAvailable = true;
          return INSTALLED;
        },
      }),
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.site, "duckduckgo");
    // The chip chrome line was stripped — the verdict quotes the real content line.
    assert.equal(outcome.answer, "SMOKE OK");
    assert.match(outcome.message, /^smoke OK: duckduckgo answered "SMOKE OK" in \d+ms$/);
    assert.ok(outcome.ms !== undefined && outcome.ms >= 0);
    assert.equal(installCalls, 1);
    assert.equal(outcome.installedAnon?.version, "0.3.0");
    assert.equal(smokeExitCode(outcome), 0);
  });
});

test("round-trip ok without install -> exit 0, no install line (package already present)", async () => {
  await withCleanEnv(async () => {
    let installCalls = 0;
    const outcome = await runSmoke({
      deps: makeDeps({
        installAnon: async () => {
          installCalls++;
          return INSTALLED;
        },
      }),
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.installedAnon, undefined);
    assert.equal(installCalls, 0);
    assert.equal(smokeExitCode(outcome), 0);
  });
});

test("round-trip fails (driver throws) -> exit 1 + named reason", async () => {
  await withCleanEnv(async () => {
    const outcome = await runSmoke({
      deps: makeDeps({
        ask: async () => {
          throw new Error("no answer appeared on duckduckgo within 45000ms. The page may be behind a consent wall");
        },
      }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.site, "duckduckgo");
    assert.match(outcome.message, /^smoke FAIL: round-trip failed on duckduckgo — no answer appeared on duckduckgo within 45000ms/);
    assert.equal(smokeExitCode(outcome), 1);
    assert.ok(outcome.report, "round-trip fail path still carries the report");
  });
});

test("round-trip returns an empty answer -> exit 1 with the driver's doneReason named", async () => {
  await withCleanEnv(async () => {
    const outcome = await runSmoke({
      deps: makeDeps({
        ask: async () => ({
          answer: "",
          chunkCount: 0,
          doneReason: "empty",
          url: "https://duck.ai/chat",
          title: "DuckDuckGo AI Chat",
        }),
      }),
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /returned no answer \(doneReason=empty\)/);
    assert.equal(smokeExitCode(outcome), 1);
    assert.ok(outcome.report, "empty-answer fail path still carries the report");
  });
});

test("the round-trip uses the caller's prompt (default = the SMOKE OK ask)", async () => {
  await withCleanEnv(async () => {
    let asked = "";
    await runSmoke({
      deps: makeDeps({
        ask: async (profile, prompt) => {
          asked = prompt;
          return { answer: "SMOKE OK", chunkCount: 1, doneReason: "stable", url: profile.url, title: "" };
        },
      }),
    });
    assert.equal(asked, SMOKE_PROMPT);
    assert.match(SMOKE_PROMPT, /SMOKE OK/);
  });
});

// --- GOAL 42: the machine payload — the report rides every outcome ---

test("GOAL 42: ok path carries the report — the --json payload shape (report.checks[] present, undefined fields omitted)", async () => {
  await withCleanEnv(async () => {
    const outcome = await runSmoke({
      deps: makeDeps({
        checkOs: async () =>
          osReport([
            { id: "node", status: "pass", detail: "node v24.20.0 (>= 22.13.0)" },
            { id: "chrome", status: "pass", detail: "/usr/bin/google-chrome-stable 152.0.7977.82" },
            { id: "display", status: "pass", detail: "headless — ladder-resolved chrome /usr/bin/google-chrome-stable 152.0.7977.82" },
          ]),
      }),
    });
    assert.equal(outcome.ok, true);
    // The report the gate computed is carried, NOT thrown away (smoke.ts:153).
    assert.ok(outcome.report, "outcome.report present on the ok path");
    assert.ok(Array.isArray(outcome.report.checks));
    const node = outcome.report.checks.find((c) => c.id === "node");
    assert.equal(node?.status, "pass");
    assert.match(node?.detail ?? "", /node v24\.20\.0/);
    // The --json payload: the exact object cmdSmoke serializes. JSON.stringify
    // drops undefined-valued keys (installedAnon absent here), keeps the report.
    const payload = JSON.parse(
      JSON.stringify({
        ok: outcome.ok,
        site: outcome.site,
        answer: outcome.answer,
        ms: outcome.ms,
        message: outcome.message,
        installedAnon: outcome.installedAnon,
        report: outcome.report,
      })
    );
    assert.equal(payload.ok, true);
    assert.equal(payload.site, "duckduckgo");
    assert.equal(payload.answer, "SMOKE OK");
    assert.equal(typeof payload.ms, "number");
    assert.equal(payload.installedAnon, undefined);
    assert.match(payload.message, /^smoke OK: duckduckgo answered "SMOKE OK" in \d+ms$/);
    assert.equal(payload.report.checks.length, 3);
    assert.equal(payload.report.checks[1].detail, "/usr/bin/google-chrome-stable 152.0.7977.82");
  });
});

test("GOAL 42: --json verdict shape on an ok-with-install path carries installedAnon (undefined-omission guest)", async () => {
  await withCleanEnv(async () => {
    let anonAvailable = false;
    const outcome = await runSmoke({
      deps: makeDeps({
        anonymousProfile: () => (anonAvailable ? ANON() : null),
        installAnon: async () => {
          anonAvailable = true;
          return INSTALLED;
        },
      }),
    });
    assert.equal(outcome.ok, true);
    assert.ok(outcome.report);
    const payload = JSON.parse(
      JSON.stringify({
        ok: outcome.ok,
        site: outcome.site,
        answer: outcome.answer,
        ms: outcome.ms,
        message: outcome.message,
        installedAnon: outcome.installedAnon,
        report: outcome.report,
      })
    );
    assert.equal(payload.installedAnon.version, "0.3.0");
    assert.equal(payload.report.checks.length, 1);
  });
});

// --- firstContentLine: the site-agnostic chrome-skip heuristic ---

test("firstContentLine: strips a short punctuation-less UI chrome line (duckduckgo's model chip)", () => {
  assert.equal(firstContentLine("GPT-5.6 Luna\n\nSMOKE OK"), "SMOKE OK");
  assert.equal(firstContentLine("5.6 Luna\nAlso check"), "Also check");
});

test("firstContentLine: keeps a single-line answer and punctuation-complete first lines", () => {
  assert.equal(firstContentLine("SMOKE OK"), "SMOKE OK");
  assert.equal(firstContentLine("SMOKE OK. That's all."), "SMOKE OK. That's all.");
  assert.equal(firstContentLine("What is 2+2?\n\n2 + 2 = 4"), "What is 2+2?");
});

test("firstContentLine: tolerates leading blank lines; caps length", () => {
  assert.equal(firstContentLine("\n\n  SMOKE OK\n\n"), "SMOKE OK");
  const long = "x".repeat(500);
  assert.equal(firstContentLine(long).length, 200);
});

// --- help text anchor (the CLI case + help line are wired up top-level) ---

test("smoke anchors in the CLI command table + help line + --json wiring (GOAL 42)", () => {
  const cli = readFileSync("src/cli.ts", "utf8");
  assert.match(cli, /case "smoke":\n\s+return cmdSmoke\(flags\);/);
  assert.match(cli, /async function cmdSmoke\(flags: Flags\)/);
  assert.match(cli, /ui2api smoke\s+\(ONE command:/);
  // GOAL 42: cmdSmoke consumes flags.json — the machine verdict serializes
  // the outcome (undefined fields omitted via JSON.stringify) with the report
  // riding along, and the exit code stays the gate.
  assert.match(cli, /if \(flags\.json\)/);
  assert.match(cli, /installedAnon: outcome\.installedAnon,/);
  assert.match(cli, /report: outcome\.report,/);
  assert.match(cli, /process\.exitCode = smokeExitCode\(outcome\);/);
  assert.match(cli, /ui2api smoke\s+\(ONE command:[\s\S]*?\[--json = \{ok, site, answer\?, ms\?, message, installedAnon\?, report\}\]/);
  // GOAL 42: cmdRequirements consumes the same flag for the SAME report shape
  // the daemon serves, honoring the doctor <site> scope.
  assert.match(cli, /async function cmdRequirements\(siteOrEmpty: string, flags: Flags\)/);
  assert.match(cli, /scopeRequirementsReport\(report, siteOrEmpty\)/);
  assert.match(cli, /JSON\.stringify\(scoped, null, 2\)/);
  assert.match(cli, /ui2api requirements \[site\][\s\S]*?\[--json = the same report/);
});