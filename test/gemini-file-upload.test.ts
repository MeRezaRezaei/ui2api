// GOAL 53 (2026-09-25): gemini file/vision attach capability — node-only pins.
// The flagship chat site had ZERO file/image attach surface (manifest listed
// only chat/list_conversations/model_list/search_toggle) while the verbatim's
// final-success list explicitly demands "send files vision ... end to end"
// (docs/verbatim.md:1753/:1862) and kimi/duckduckgo already carry LIVE-VERIFIED
// file_upload capabilities. These pins assert the WIRING + SHAPE only — the
// upload round-trip itself stays an honest unverified-candidate until a live
// signed-in run (Google auth cookies are browser-bound; nothing fabricated).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "capabilities", "gemini", "manifest.json");
const RECIPES_DIR = join(ROOT, "capabilities", "gemini", "recipes");

function manifest(): { capabilities: Array<{ id: string; recipe: string; notes?: string }> } {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

test("GOAL53(a): gemini manifest now lists gemini_file_upload with a recipe + honesty marker", () => {
  const caps = manifest().capabilities.map((c) => c.id);
  assert.ok(caps.includes("gemini_file_upload"), `gemini caps = ${JSON.stringify(caps)}`);
  const cap = manifest().capabilities.find((c) => c.id === "gemini_file_upload")!;
  assert.ok(cap.recipe.endsWith(".json"), `recipe ref: ${cap.recipe}`);
  const notes = cap.notes ?? "";
  assert.match(notes, /unverified-candidate|signed-in|UI2API_ATTACH_PORT/, `notes must carry the honesty posture: ${notes}`);
  assert.doesNotMatch(notes, /VERIFIED LIVE/, "never claim verified without the live round-trip");
});

test("GOAL53(b): recipes/gemini_file_upload.json exists and is valid JSON with the real-input flow", () => {
  const recipePath = join(RECIPES_DIR, "gemini_file_upload.json");
  assert.ok(existsSync(recipePath), "recipe file missing");
  const recipe = JSON.parse(readFileSync(recipePath, "utf8")) as { capability: string; steps: Array<{ action: string }> };
  assert.equal(recipe.capability, "gemini_file_upload");
  const actions = recipe.steps.map((s) => s.action);
  assert.ok(actions.includes("set-files"), `steps must drive the REAL input via setInputFiles: ${actions.join(", ")}`);
  assert.ok(actions.includes("read-back"), "must read the attachment chip back honestly (attached:null never fabricated)");
});

test("GOAL53(c): runner dispatch table carries gemini_file_upload (manifest↔dispatch sync, caps_drift_gemini)", () => {
  const source = readFileSync(join(ROOT, "src", "capabilities", "gemini.ts"), "utf8");
  assert.match(source, /case "gemini_file_upload":/, "runner run() must dispatch gemini_file_upload");
  assert.match(source, /private async fileUpload\(/, "runner must implement fileUpload()");
  // The dispatch method exists and returns the honest result shape — ok:true
  // means input accepted, with verified:false + the named honesty string.
  assert.match(source, /verified: false/, "result data must carry verified:false (no live claim)");
});

test("GOAL53(d): no fabricated upload — manifest + recipe + runner all refrain from a live VERIFIED claim", () => {
  const all = readFileSync(MANIFEST, "utf8") + readFileSync(join(RECIPES_DIR, "gemini_file_upload.json"), "utf8");
  assert.doesNotMatch(all, /VERIFIED LIVE/, "GOAL 53 wiring is unverified-candidate until a signed-in round-trip");
  // Sanity: every recipe json in the gemini package parses (no dangling refs).
  for (const f of readdirSync(RECIPES_DIR)) {
    if (f.endsWith(".json")) JSON.parse(readFileSync(join(RECIPES_DIR, f), "utf8"));
  }
});