import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePackagedProfileFile } from "../src/profile/profile.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";
import { KimiCapabilities } from "../src/capabilities/kimi.js";
import { HunyuanCapabilities } from "../src/capabilities/hunyuan.js";
import { VeniceCapabilities } from "../src/capabilities/venice.js";
import { DeepSeekCapabilities } from "../src/capabilities/deepseek.js";
import { TencentAistudioCapabilities } from "../src/capabilities/tencent-aistudio.js";
import { ClaudeCapabilities } from "../src/capabilities/claude.js";
import { ChatGPTCapabilities } from "../src/capabilities/chatgpt.js";
import { GeminiCapabilities } from "../src/capabilities/gemini.js";
import { HuggingChatCapabilities } from "../src/capabilities/huggingchat.js";
import { CopilotCapabilities } from "../src/capabilities/copilot.js";
import { YouTubeCapabilities } from "../src/capabilities/youtube.js";
import { ArapratCapabilities } from "../src/capabilities/araprat.js";
import { GmailCapabilities } from "../src/capabilities/gmail.js";
import { DuckduckgoCapabilities } from "../src/capabilities/duckduckgo.js";

// ────────────────────────────────────────────────────────────────────────────
// Hermetic capability-runner dispatch tests (no browser, no network, no daemon)
//
// Behavior verified by reading the source of each runner:
//
//   UNKNOWN CAPABILITY → every runner's `run()` has a switch/capability default
//   that returns {ok:false, error:"unknown <id> capability: …"} BEFORE any
//   `ensureBrowser()` or `openPage()` call. No browser is launched for an
//   unknown capability name in any runner. The race guard below is a
//   belt-and-suspenders confirmation.
//
//   MANIFEST <-> DISPATCH DRIFT: the sets of `case` labels in each runner's
//   dispatch table and the `capabilities[].id` entries in its manifest.json are
//   compared below and drift is a HARD failure (HARD_FAIL_ON_DRIFT = true —
//   GOAL 79, 2026-09-25; the deep-equal assertion is reachable and green).
//   Measured baseline: all 14 RUNNERS are IN-SYNC — dispatch exactly matches
//   manifest ("IN-SYNC" diagnostics, zero DRIFT lines; the former "5 of 6
//   runners have drift" justification for the soft gate was measured false).
//   The moment a manifest gains a capability its runner does not dispatch (or
//   vice versa), the suite fails LOUD with the DRIFT diagnostics + the
//   assertion message — the gate has been SEEN to fail on a scratch fixture.
// ────────────────────────────────────────────────────────────────────────────

const UNKNOWN_CAPABILITY = "definitely-not-a-capability";
const GUARD_SETTLE_TIMEOUT_MS = 7000;

// GOAL 79: drift is a HARD failure. Measured baseline (2026-09-25): 14 ×
// IN-SYNC, zero drift — the gate's deep-equal assertion is reachable and green,
// and a real manifest<->runner pair divergence now fails the suite.
const HARD_FAIL_ON_DRIFT = true;

// ─── Helpers ────────────────────────────────────────────────────────────────

interface RunnerDef {
  id: string;
  profilePath: string;
  manifestPath: string;
  sourcePath: string;
  make(profile: ChatSiteProfile): { run(capability: string, args?: Record<string, unknown>): Promise<unknown> };
}

function u(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url));
}

const RUNNERS: RunnerDef[] = [
  {
    id: "kimi",
    profilePath: u("../capabilities/kimi/profile.json"),
    manifestPath: u("../capabilities/kimi/manifest.json"),
    sourcePath: u("../src/capabilities/kimi.ts"),
    make: (p) => new KimiCapabilities(p),
  },
  {
    id: "hunyuan",
    profilePath: u("../capabilities/hunyuan/profile.json"),
    manifestPath: u("../capabilities/hunyuan/manifest.json"),
    sourcePath: u("../src/capabilities/hunyuan.ts"),
    make: (p) => new HunyuanCapabilities(p),
  },
  {
    id: "venice",
    profilePath: u("../capabilities/venice/profile.json"),
    manifestPath: u("../capabilities/venice/manifest.json"),
    sourcePath: u("../src/capabilities/venice.ts"),
    make: (p) => new VeniceCapabilities(p),
  },
  {
    id: "deepseek",
    profilePath: u("../capabilities/deepseek/profile.json"),
    manifestPath: u("../capabilities/deepseek/manifest.json"),
    sourcePath: u("../src/capabilities/deepseek.ts"),
    make: (p) => new DeepSeekCapabilities(p),
  },
  {
    id: "tencent-aistudio",
    profilePath: u("../capabilities/tencent-aistudio/profile.json"),
    manifestPath: u("../capabilities/tencent-aistudio/manifest.json"),
    sourcePath: u("../src/capabilities/tencent-aistudio.ts"),
    make: (p) => new TencentAistudioCapabilities(p),
  },
  {
    id: "claude",
    profilePath: u("../capabilities/claude/profile.json"),
    manifestPath: u("../capabilities/claude/manifest.json"),
    sourcePath: u("../src/capabilities/claude.ts"),
    make: (p) => new ClaudeCapabilities(p),
  },
  {
    id: "chatgpt",
    profilePath: u("../capabilities/chatgpt/profile.json"),
    manifestPath: u("../capabilities/chatgpt/manifest.json"),
    sourcePath: u("../src/capabilities/chatgpt.ts"),
    make: (p) => new ChatGPTCapabilities(p),
  },
  {
    id: "gemini",
    profilePath: u("../capabilities/gemini/profile.json"),
    manifestPath: u("../capabilities/gemini/manifest.json"),
    sourcePath: u("../src/capabilities/gemini.ts"),
    make: (p) => new GeminiCapabilities(p),
  },
  {
    id: "huggingchat",
    profilePath: u("../capabilities/huggingchat/profile.json"),
    manifestPath: u("../capabilities/huggingchat/manifest.json"),
    sourcePath: u("../src/capabilities/huggingchat.ts"),
    make: (p) => new HuggingChatCapabilities(p),
  },
  {
    id: "copilot",
    profilePath: u("../capabilities/copilot/profile.json"),
    manifestPath: u("../capabilities/copilot/manifest.json"),
    sourcePath: u("../src/capabilities/copilot.ts"),
    make: (p) => new CopilotCapabilities(p),
  },
  {
    id: "youtube",
    profilePath: u("../capabilities/youtube/profile.json"),
    manifestPath: u("../capabilities/youtube/manifest.json"),
    sourcePath: u("../src/capabilities/youtube.ts"),
    make: (p) => new YouTubeCapabilities(p),
  },
  {
    id: "araprat",
    profilePath: u("../capabilities/araprat/profile.json"),
    manifestPath: u("../capabilities/araprat/manifest.json"),
    sourcePath: u("../src/capabilities/araprat.ts"),
    make: (p) => new ArapratCapabilities(p),
  },
  {
    id: "gmail",
    profilePath: u("../capabilities/gmail/profile.json"),
    manifestPath: u("../capabilities/gmail/manifest.json"),
    sourcePath: u("../src/capabilities/gmail.ts"),
    make: (p) => new GmailCapabilities(p),
  },
  {
    id: "duckduckgo",
    profilePath: u("../capabilities/duckduckgo/profile.json"),
    manifestPath: u("../capabilities/duckduckgo/manifest.json"),
    sourcePath: u("../src/capabilities/duckduckgo.ts"),
    make: (p) => new DuckduckgoCapabilities(p),
  },
];

type Outcome<T> = { kind: "settled"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" };

function settleWithinMs<T>(promise: Promise<T>, ms: number): Promise<Outcome<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve({ kind: "settled", value }); },
      (error) => { clearTimeout(timer); resolve({ kind: "error", error }); },
    );
  });
}

function loadJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function extractDispatchLabels(sourcePath: string): string[] {
  const src = readFileSync(sourcePath, "utf8");
  return [...new Set([...src.matchAll(/case\s+"([^"]+)":/g)].map((m) => m[1]))];
}

function extractManifestIds(manifestPath: string): string[] {
  const m = loadJson(manifestPath) as { capabilities?: Array<{ id: string }> };
  return (m.capabilities ?? []).map((c) => c.id).sort();
}

// ─── 1. Guard: unknown capability is rejected without opening a browser ─────
//
// The switch default in every runner returns {ok:false} before any
// ensureBrowser/openPage call. We race with a timeout to prove the promise
// settles immediately (browser launch would block well beyond GUARD_SETTLE_TIMEOUT_MS).
// Verified by reading: kimi.ts:113-123, hunyuan.ts:113-122, venice.ts:132-143,
// deepseek.ts:142-153, claude.ts:136-151, gemini.ts:177-189.

for (const def of RUNNERS) {
  test(`${def.id}: run("${UNKNOWN_CAPABILITY}") → ok:false WITHOUT touching a browser`, async () => {
    // Packaged capability profiles resolve through the PERMISSIVE packaged
    // seam (the same loader http.ts's /capability fallback uses) — capability-
    // only packages may carry empty composer/answer; the strict GOAL-47
    // override gate applies only to the user's `--profile FILE` tuning seam.
    const profile = resolvePackagedProfileFile(def.profilePath);
    assert.equal(profile.id, def.id, "fixture resolved correctly via resolvePackagedProfileFile");
    assert.ok(profile.url.startsWith("https://"), "profile has a valid https url");
    assert.ok(Array.isArray(profile.composer), "profile has a composer array");

    const runner = def.make(profile);
    const outcome = await settleWithinMs(runner.run(UNKNOWN_CAPABILITY), GUARD_SETTLE_TIMEOUT_MS);
    assert.notEqual(outcome.kind, "timeout",
      `${def.id}: run(unknown) did not settle in ${GUARD_SETTLE_TIMEOUT_MS}ms — it likely tried to open a page`);

    assert.equal(outcome.kind, "settled",
      `${def.id}: run(unknown) rejected with ${outcome.kind === "error" ? String(outcome.error) : "unknown"} — expected a settled {ok:false} result, not a rejection or timeout`);

    const r = (outcome as { kind: "settled"; value: unknown }).value as { ok: boolean; capability: string; data: unknown; error?: string };
    assert.equal(r.ok, false, `${def.id}: expected ok:false for unknown capability`);
    assert.equal(r.capability, UNKNOWN_CAPABILITY, `${def.id}: capability echoes back in result`);
    assert.equal(r.data, undefined, `${def.id}: data is undefined for unknown capability`);

    const err = String(r.error ?? "");
    assert.ok(err.includes("unknown"), `${def.id}: error contains "unknown", got: ${err}`);
    assert.ok(err.includes(def.id), `${def.id}: error names the runner (confirms correct default branch), got: ${err}`);
  });
}

// ─── 2. Manifest <-> dispatch cross-check ───────────────────────────────────
//
// We extract the case-label set from the runner's dispatch switch by reading the
// source file (hermetic local read) and compare it against the capabilities[].id
// list in the package's manifest.json. Any asymmetry is drift — a real bug that
// signals either undocumented dispatch or manifest types that are not yet wired.

for (const def of RUNNERS) {
  test(`${def.id}: dispatch table exactly matches manifest capabilities (caps_drift_${def.id})`, (t) => {
    const dispatch = extractDispatchLabels(def.sourcePath).sort();
    const manifestIds = extractManifestIds(def.manifestPath);

    // Structural sanity — if these fail, the extraction harness is broken.
    assert.ok(dispatch.length > 0, `no case labels parsed from ${def.sourcePath}`);
    assert.ok(manifestIds.length > 0, `manifest ${def.manifestPath} lists no capabilities`);
    for (const label of dispatch) {
      // Site ids with a hyphen (e.g. "tencent-aistudio") still use UNDERSCORES
      // in their capability ids (tencent_aistudio_chat) — accept both
      // separators in the runner prefix so the convention check stays honest.
      const prefix = def.id.replace(/-/g, "[-_]");
      assert.match(label, new RegExp(`^${prefix}_[a-z_]+$`),
        `case label "${label}" does not follow ${def.id}_ naming convention`);
    }

    const missingFromDispatch = manifestIds.filter((id) => !dispatch.includes(id));
    const extraInDispatch = dispatch.filter((name) => !manifestIds.includes(name));

    if (missingFromDispatch.length > 0) {
      t.diagnostic(`DRIFT [${def.id}]: manifest proposes capabilities the runner does NOT dispatch: ${missingFromDispatch.join(", ")}`);
    }
    if (extraInDispatch.length > 0) {
      t.diagnostic(`DRIFT [${def.id}]: runner dispatches capabilities NOT in manifest: ${extraInDispatch.join(", ")}`);
    }
    if (missingFromDispatch.length > 0 || extraInDispatch.length > 0) {
      t.diagnostic(`DRIFT [${def.id}]: dispatch=${JSON.stringify(dispatch)} manifest=${JSON.stringify(manifestIds)}`);
    } else {
      t.diagnostic(`IN-SYNC [${def.id}]: dispatch exactly matches manifest (${dispatch.length} capabilities)`);
    }

    if (HARD_FAIL_ON_DRIFT) {
      assert.deepEqual(dispatch, manifestIds,
        `${def.id}: manifest<->dispatch drift detected — dispatch=${JSON.stringify(dispatch)} manifest=${JSON.stringify(manifestIds)}`);
    }
  });
}

// ─── 3. GOAL 79 negative pin: the HARD gate is proven to FAIL on drift ──────
//
// The gate's comparison — extractDispatchLabels vs extractManifestIds, the
// exact functions asserted in section 2 — is driven against a SCRATCH fixture
// with a deliberately drifted pair (a capability in the manifest the runner
// does not dispatch). Real packages are never mutated. A gate nobody has seen
// fail is the exact claim class this repo forbids; this pin shows it red.
test("drift gate: a deliberately drifted scratch manifest/runner pair FAILS the deep-equal the gate asserts", () => {
  const dir = mkdtempSync(join(tmpdir(), "caps-drift-gate-"));
  try {
    const manifestPath = join(dir, "manifest.json");
    const sourcePath = join(dir, "runner.ts");
    writeFileSync(
      manifestPath,
      JSON.stringify({ capabilities: [{ id: "scratch_site_cap_test" }, { id: "scratch_site_undispatched" }] }),
    );
    writeFileSync(sourcePath, 'case "scratch_site_cap_test": break;\n');
    const dispatch = extractDispatchLabels(sourcePath).sort();
    const manifestIds = extractManifestIds(manifestPath);
    assert.throws(
      () => assert.deepEqual(dispatch, manifestIds),
      "the gate's own deep-equal must report a manifest-proposes-but-runner-does-not-dispatch drift",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
