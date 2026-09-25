// GOAL 54 (2026-09-25): restriction-marker coverage gate for builtin chat
// profiles — node-only pins.
//
// Verbatim ask (docs/verbatim.md:1570): "all users does not have the same
// abiltiy as others ... the gemini itself someone has pro some noe not and the
// work i dont know if it can spot the restrcition message if ter use or
// selecting model or ablities of model the same thing is for kimi or hy3".
//
// The detection MACHINERY predates this goal (driver.ts:584 readRestrictions →
// doneReason:"restricted"; capability-probe.ts:303 → fingerprint restrictions[])
// but only 3 of 11 builtin chat profiles declared restrictionMarkers
// (gemini/kimi/deepseek). This gate pins that EVERY builtin chat profile
// declares non-empty markers with valid kinds — so a future profile added
// without markers fails LOUD instead of silently returning a blind empty
// answer behind a tier/plan/limit/login wall.
import { test } from "node:test";
import assert from "node:assert/strict";

// Static extraction — do NOT import profile.ts at runtime (it imports
// playwright types/universal code). Parse the source the same way the
// capability-dispatch harness does: name + field assertions over the file.
const { readFileSync } = await import("node:fs");
const { join, dirname } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "src", "profile", "profile.ts"), "utf8");

const PROFILE_IDS = [
  "gemini",
  "google-ai-search",
  "chatgpt",
  "claude",
  "copilot",
  "perplexity",
  "huggingchat",
  "kimi",
  "deepseek",
  "tencent-aistudio",
  "hunyuan",
];

const VALID_KINDS = new Set(["upgrade", "limit", "login"]);

test("GOAL54(a): every builtin chat profile declares restrictionMarkers (11/11)", () => {
  for (const id of PROFILE_IDS) {
    // Profile block: from its key line to the next 2-space key OR object end.
    const keyRe = new RegExp(`^\\s{2}"?${id}"?:\\s*\\{`, "m");
    const start = SRC.search(keyRe);
    assert.ok(start >= 0, `profile ${id} not found in src/profile/profile.ts`);
    const rest = SRC.slice(start);
    const nextKey = rest.search(/\n\s{2}"?[a-z0-9-]+"?:\s*\{\n/);
    const block = nextKey >= 0 ? rest.slice(0, nextKey) : rest;
    assert.match(block, /restrictionMarkers:\s*\[/,
      `${id}: chat profile must declare restrictionMarkers (tier/plan/limit/login walls must be detected, not blind-empty)`);
  }
});

test("GOAL54(b): every declared marker has a valid kind and non-empty patterns", () => {
  // Conservative, honest markers only: kinds ⊆ {upgrade, limit, login}, every
  // pattern non-empty (a never-matching conservative pattern is a silent miss,
  // never a fabricated restriction claim).
  const markerBlocks = [...SRC.matchAll(/restrictionMarkers:\s*\[([\s\S]*?)\n\s*\],/g)];
  assert.ok(markerBlocks.length >= 11, `expected >= 11 marker blocks, got ${markerBlocks.length}`);
  for (const [, body] of markerBlocks) {
    for (const entry of body.split("\n")) {
      const kind = entry.match(/kind:\s*"(\w+)"/);
      if (!kind) continue;
      assert.ok(VALID_KINDS.has(kind[1]), `invalid marker kind "${kind[1]}" — allowed: upgrade|limit|login`);
      const patterns = entry.match(/patterns:\s*\[([^\]]*)\]/);
      assert.ok(patterns, `marker ${kind[1]} must declare a patterns array`);
      assert.ok(patterns[1].trim().length > 0, `marker ${kind[1]} has EMPTY patterns — a marker with no patterns can never match`);
    }
  }
});

test("GOAL54(c): the verbatim-named hy3 (tencent-aistudio) carries markers (limit + login)", () => {
  const start = SRC.search(/^\s{2}"tencent-aistudio":\s*\{/m);
  assert.ok(start >= 0, "tencent-aistudio profile missing");
  const rest = SRC.slice(start);
  const nextKey = rest.search(/\n\s{2}"?[a-z0-9-]+"?:\s*\{\n/);
  const block = (nextKey >= 0 ? rest.slice(0, nextKey) : rest);
  assert.match(block, /restrictionMarkers:\s*\[/, "tencent-aistudio must declare restrictionMarkers");
  assert.match(block, /kind:\s*"limit"/, "tencent-aistudio must watch limit walls (请求过于频繁-class)");
  assert.match(block, /kind:\s*"login"/, "tencent-aistudio must watch login walls (登录/sign-in gates)");
});

test("GOAL54(d): in-band detection wiring is intact (driver + probe consume the same markers)", () => {
  const driver = readFileSync(join(ROOT, "src", "prompt", "driver.ts"), "utf8");
  const probe = readFileSync(join(ROOT, "src", "runtime", "capability-probe.ts"), "utf8");
  assert.match(driver, /restrictionMarkers/, "driver.ts readRestrictions must read profile restrictionMarkers");
  assert.match(driver, /doneReason:\s*"restricted"/, "driver must report doneReason:restricted on a marker hit");
  assert.match(probe, /restrictionMarkers/, "capability-probe must feed markers into the account fingerprint");
  assert.match(probe, /matchRestrictionMarkers\(/, "probe must run the shared matcher");
});

// --- GOAL 55 (2026-09-25): the PACKAGED chat surface. GOAL 54 pinned the
// builtin catalog; the served chat surface (registry.defaultChatSurface) also
// includes every installed driveable chat-shaped capabilities/<id>/profile.json
// (blackbox, codex, copilot-m365, duckduckgo, grok, inner-ai, manus, notion,
// poe, t3chat, v0, venice — plus dormant zenmux/xiaomimimo served on
// /registry + /capability). They ride the SAME ChatDriver, so they must watch
// the same walls. Verified node-only 2026-09-25: 23-entry surface, ALL 12
// packaged entries carried zero markers before this gate.
const PACKAGED_CHAT_PROFILES = [
  "blackbox",
  "codex",
  "copilot-m365",
  "duckduckgo",
  "grok",
  "inner-ai",
  "manus",
  "notion",
  "poe",
  "t3chat",
  "v0",
  "venice",
  "zenmux",
  "xiaomimimo",
];

function readPackagedProfile(id: string): string {
  return readFileSync(join(ROOT, "capabilities", id, "profile.json"), "utf8");
}

test("GOAL55(a): every chat-shaped packaged profile declares restrictionMarkers (14/14)", () => {
  for (const id of PACKAGED_CHAT_PROFILES) {
    const src = readPackagedProfile(id);
    const ok = JSON.parse(src); // shape is valid JSON (the packaged seam is JSON, not TS)
    assert.ok(ok.composer?.length > 0, `${id}: chat-shaped package must declare a composer`);
    assert.ok(ok.answer?.length > 0, `${id}: chat-shaped package must declare an answer`);
    assert.ok(
      ok.capability?.restrictionMarkers?.length > 0,
      `${id}: packaged chat profile must declare restrictionMarkers (walls reported, never blind-empty)`
    );
  }
});

test("GOAL55(b): packaged marker kinds ⊆ {upgrade,limit,login} with non-empty patterns", () => {
  for (const id of PACKAGED_CHAT_PROFILES) {
    const p = JSON.parse(readPackagedProfile(id));
    for (const marker of p.capability.restrictionMarkers) {
      assert.ok(VALID_KINDS.has(marker.kind), `${id}: invalid marker kind "${marker.kind}"`);
      assert.ok(Array.isArray(marker.patterns) && marker.patterns.length > 0, `${id}: marker ${marker.kind} has EMPTY patterns`);
    }
  }
});

test("GOAL55(c): the VERIFIED packaged chat (duckduckgo) and the dormant seam carry markers", () => {
  const ddg = JSON.parse(readPackagedProfile("duckduckgo"));
  assert.ok(ddg.capability.restrictionMarkers.some((m: { kind: string }) => m.kind === "limit"), "duckduckgo (verified chat): limit wall watch");
  assert.ok(ddg.capability.restrictionMarkers.some((m: { kind: string }) => m.kind === "login"), "duckduckgo (verified chat): login wall watch");
  const xm = JSON.parse(readPackagedProfile("xiaomimimo"));
  assert.ok(xm.capability.restrictionMarkers.length > 0, "dormant xiaomimimo still served on /registry — markers present");
});