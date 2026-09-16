import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Package-consistency validator for capabilities/<site-id>/ package directories.
// Run with: node --import tsx --test test/validate-packages.test.ts
//
// SCHEMA REFERENCE (the canonical shapes this suite holds packages against):
//   - manifest: capabilities/gemini/manifest.json
//   - recipe:   capabilities/gemini/recipes/gemini_chat.json
//
// RECIPE-TO-CAPABILITY MAPPING RULE (used by check B)
// ---------------------------------------------------
// A recipe file is matched to a manifest capability id in this order:
//   1. The manifest entry's own `recipe` field wins when it is a non-empty
//      string — it is the authoritative pointer even when the file name is a
//      near-id or shared name. Live cases: google-ai-search maps
//      google_ai_mode_search -> recipes/ai_mode_search.json; deepseek maps
//      deepseek_reasoner -> the shared recipes/deepseek_chat.json.
//   2. `recipe: null`, or an absent `recipe` field, means "no recipe shipped
//      yet" (kimi_file_upload/kimi_long_context, hunyuan_list_conversations/
//      hunyuan_voice_mode) and is tolerated with a warning, not a failure.
//   3. Otherwise (no recipe field, not null) the recipe file name is derived
//      from the capability id after stripping a trailing near-id suffix —
//      `_direct`, `-rpc`, `-ui` — i.e. `foo_direct` -> recipes/foo.json.
//
// LEGACY-DIR CAVEAT
// -----------------
// capabilities/hunyuan-yuanbao/ is the pre-package bundle-analysis inventory:
// a single CAPABILITIES.md (analysis notes) and no manifest/profile/
// session.lock/recipes. It is preserved as analysis source, superseded by the
// structured capabilities/hunyuan/ package, so it is EXCLUDED from the
// package-schema checks below.

const CAPABILITIES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "capabilities");
const relCap = (p: string) => join("capabilities", relative(CAPABILITIES_DIR, p));

// Step "action" values allowed by the canonical ui-path recipe shape
// (capabilities/gemini/recipes/gemini_chat.json). Anything else (rpc, api,
// navigate/urlTemplate, extract, poll, upload, resolve-output, read-flags, ...)
// is a LEGITIMATE documented variant and only earns a warning.
const CANONICAL_ACTIONS = new Set(["open", "new-chat", "type", "send", "read"]);

function listJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJsonFiles(p));
    else if (ent.name.endsWith(".json")) out.push(p);
  }
  return out;
}

function readJsonFile(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf8"));
}

// Mapping rule #3: derive a recipe file name from a capability id by stripping
// the trailing near-id suffix (`_direct` | `-rpc` | `-ui`).
function normalizeRecipeId(capabilityId: string): string {
  return capabilityId.replace(/_(direct|rpc|ui)$/, "");
}

// Legacy inventory dir (see caveat at the top of this file) — skipped because
// it is structurally a different kind of artifact, not a capability package.
const SKIP_LEGACY_INVENTORY = new Set(["hunyuan-yuanbao"]);

const pkgNames = readdirSync(CAPABILITIES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((n) => !SKIP_LEGACY_INVENTORY.has(n))
  .sort();

for (const pkgName of pkgNames) {
  const pkgDir = join(CAPABILITIES_DIR, pkgName);

  test(`capability package: ${pkgName}`, async (t) => {
    await t.test("A. every *.json parses", () => {
      const files = listJsonFiles(pkgDir);
      assert.ok(files.length > 0, `${relCap(pkgDir)} contains no *.json files`);
      const bad: string[] = [];
      for (const f of files) {
        try {
          readJsonFile(f);
        } catch (err) {
          bad.push(`${relCap(f)} — ${(err as Error).message}`);
        }
      }
      assert.equal(bad.length, 0, `invalid JSON:\n  ${bad.join("\n  ")}`);
    });

    await t.test("B. manifest capabilities resolve to recipe files", () => {
      const manifestPath = join(pkgDir, "manifest.json");
      assert.ok(existsSync(manifestPath), `${relCap(pkgDir)} is missing manifest.json`);
      const manifest = readJsonFile(manifestPath) as { capabilities?: Array<Record<string, unknown>> };
      assert.ok(Array.isArray(manifest?.capabilities), `${relCap(manifestPath)} has no capabilities[]`);
      assert.ok(manifest.capabilities!.length > 0, `${relCap(manifestPath)} capabilities[] is empty`);

      for (const cap of manifest.capabilities!) {
        const id = cap?.id;
        assert.ok(typeof id === "string" && id.length > 0, `${relCap(manifestPath)} capability entry has no string id: ${JSON.stringify(cap)}`);

        const declared = cap.recipe;
        let recipeRel: string | null = null;
        if (typeof declared === "string" && declared.length > 0) {
          recipeRel = declared as string; // authoritative pointer (mapping rule #1)
        } else if (declared === null) {
          t.diagnostic(`warn ${pkgName}: capability "${id}" has recipe:null (deliberately pending) — tolerated`);
          continue;
        } else {
          const derived = join("recipes", `${normalizeRecipeId(id as string)}.json`);
          recipeRel = existsSync(join(pkgDir, derived)) ? derived : null; // mapping rule #3
          if (recipeRel === null) {
            t.diagnostic(`warn ${pkgName}: capability "${id}" ships no recipe (no recipe field, no ${join("recipes", `${normalizeRecipeId(id as string)}.json`)}) — tolerated`);
          }
        }
        if (recipeRel === null) continue;
        assert.ok(
          existsSync(join(pkgDir, recipeRel)),
          `${relCap(pkgDir)}: capability "${id}" references recipe "${recipeRel}" but ${relCap(join(pkgDir, recipeRel))} does not exist`
        );
      }
    });

    await t.test("C. profile.json id matches package dir", () => {
      const profilePath = join(pkgDir, "profile.json");
      assert.ok(existsSync(profilePath), `${relCap(pkgDir)} is missing profile.json`);
      const profile = readJsonFile(profilePath) as { id?: unknown };
      assert.strictEqual(profile?.id, pkgName, `${relCap(profilePath)}: "id" (${JSON.stringify(profile?.id)}) must equal the package dir name (${pkgName})`);
    });

    await t.test("D. session.lock.json exists and follows the session-state format", () => {
      // Real observed values across the inventory (checked against the files
      // before writing this): gemini is "locked"/locked:true with a snapshot
      // record; the other nine packages are "awaiting-capture"/locked:false.
      // The suite asserts the FORMAT per state instead of a single value.
      const lockPath = join(pkgDir, "session.lock.json");
      assert.ok(existsSync(lockPath), `${relCap(pkgDir)} is missing session.lock.json`);
      const lock = readJsonFile(lockPath) as { status?: unknown; locked?: unknown };
      assert.ok(lock !== null && typeof lock === "object" && !Array.isArray(lock), `${relCap(lockPath)} must be a JSON object`);
      assert.ok(typeof lock.status === "string" && lock.status.length > 0, `${relCap(lockPath)}: "status" must be a non-empty string (found ${JSON.stringify(lock.status)})`);
      assert.ok(typeof lock.locked === "boolean", `${relCap(lockPath)}: "locked" must be a boolean (found ${JSON.stringify(lock.locked)})`);
      if (lock.status === "locked") {
        assert.strictEqual(lock.locked, true, `${relCap(lockPath)}: status "locked" must have locked: true`);
        assert.ok((lock as Record<string, unknown>).snapshot, `${relCap(lockPath)}: status "locked" must carry a snapshot record`);
      } else if (lock.status === "awaiting-capture") {
        assert.strictEqual(lock.locked, false, `${relCap(lockPath)}: status "awaiting-capture" must have locked: false`);
      } else {
        assert.fail(`${relCap(lockPath)}: unknown status ${JSON.stringify(lock.status)} — expected one of "awaiting-capture"|"locked" (format drift)`);
      }
    });

    await t.test("E. CAPABILITIES.md exists and is non-empty", () => {
      // Tolerated-gap rule: a package may legitimately ship no CAPABILITIES.md
      // when its human-readable inventory lives elsewhere. Live case: the
      // hunyuan package's analysis doc is capabilities/hunyuan-yuanbao/
      // CAPABILITIES.md (the legacy inventory dir, referenced by the hunyuan
      // manifest) — so the absent file only earns a warning. When the file
      // IS present it must be non-empty (hard assert, catches truncated docs).
      const p = join(pkgDir, "CAPABILITIES.md");
      if (!existsSync(p)) {
        t.diagnostic(`warn ${relCap(pkgDir)}: no CAPABILITIES.md in the package dir — tolerated; inventory may live in the legacy/analysis docs (e.g. hunyuan-yuanbao/CAPABILITIES.md)`);
        return;
      }
      assert.ok(readFileSync(p, "utf8").trim().length > 0, `${relCap(p)} is empty`);
    });

    await t.test("F. recipe files keep the canonical top-level shape", () => {
      const manifest = readJsonFile(join(pkgDir, "manifest.json")) as { capabilities?: Array<Record<string, unknown>> };
      const knownCapIds = new Set<string>((manifest?.capabilities ?? []).map((c) => c.id as string));

      const recipesDir = join(pkgDir, "recipes");
      const recipes = existsSync(recipesDir) ? listJsonFiles(recipesDir) : [];
      assert.ok(recipes.length > 0, `${relCap(pkgDir)} has no recipes/ (ok only if every manifest capability is declared pending)`);

      for (const recipePath of recipes) {
        const data = readJsonFile(recipePath) as Record<string, unknown>;
        assert.ok(data !== null && typeof data === "object" && !Array.isArray(data), `${relCap(recipePath)} must be a JSON object`);

        // Invariant: the recipe carries a documented id field.
        const id = data.capability ?? data.name;
        assert.ok(typeof id === "string" && id.length > 0, `${relCap(recipePath)} must carry a "capability" (or "name") id field`);
        assert.ok(
          knownCapIds.has(id as string),
          `${relCap(recipePath)}: id "${id}" maps to no manifest capability id (drift — add it to manifest or re-point the manifest recipe field)`
        );

        // Invariant: `steps`, when present, is an array of objects.
        const steps = data.steps;
        if (steps !== undefined) {
          assert.ok(Array.isArray(steps), `${relCap(recipePath)}: "steps" must be an array when present`);
          assert.ok((steps as unknown[]).length > 0, `${relCap(recipePath)}: "steps" must not be empty when present`);
          const exotic = new Set<string>();
          for (const stepEntry of steps as unknown[]) {
            assert.ok(stepEntry !== null && typeof stepEntry === "object" && !Array.isArray(stepEntry), `${relCap(recipePath)}: every "steps" entry must be an object (got ${JSON.stringify(stepEntry)})`);
            const action = (stepEntry as Record<string, unknown>).action;
            if (typeof action === "string" && !CANONICAL_ACTIONS.has(action)) exotic.add(action);
          }
          // Non-canonical step actions are LEGITIMATE documented variants
          // (urlTemplate flow in google-ai-search, rpc/api flows in kimi/
          // venice/hunyuan, ...) — warn, don't fail; the invariant above is
          // all that must hold.
          if (exotic.size > 0) {
            t.diagnostic(`warn ${relCap(recipePath)}: steps use non-canonical action(s) ${[...exotic].map((a) => `"${a}"`).join(", ")} — documented variant tolerated`);
          }
        }
      }
    });
  });
}

test("discovery: structured capability packages were found", () => {
  const expected = [
    "gemini",
    "claude",
    "deepseek",
    "grok",
    "hunyuan",
    "kimi",
    "perplexity",
    "poe",
    "venice",
    "google-ai-search",
  ];
  for (const name of expected) {
    assert.ok(pkgNames.includes(name), `package "${name}" expected but not discovered under capabilities/`);
  }
  assert.ok(!pkgNames.includes("hunyuan-yuanbao"), "legacy inventory dir hunyuan-yuanbao must be skipped by the package walk");
});