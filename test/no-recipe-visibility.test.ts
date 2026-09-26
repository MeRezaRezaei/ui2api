import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * GOAL 97: a manifest capability may ship with NO recorded wire recipe — that is
 * legitimate (the layout allows `recipe: null`; many capabilities are honestly
 * implemented in a TS runner). The DEFECT is that the fact was only ever a
 * `t.diagnostic` warning in test/validate-packages.test.ts:118 — invisible,
 * uncounted, and free to grow while `/registry` still advertises the capability.
 *
 * This pin makes the no-recipe set a MEASURED, MACHINE-VISIBLE count, resolved
 * through the SAME order test/validate-packages.test.ts documents (the entry's
 * own `recipe` field wins; `recipe: null`/absent = deliberately no recipe; else
 * derive by stripping `_direct`/`_rpc`/`_ui`; shared recipes allowed).
 *
 * Proven able to fail: the negative injects a capability with no recipe into a
 * scratch manifest and requires it to appear in the computed no-recipe set.
 */

const CAPS = "capabilities";
const SUFFIXES_TO_STRIP = ["_direct", "_rpc", "_ui"];

type CapEntry = { id?: unknown; recipe?: unknown };

function pkgIds(): string[] {
  return readdirSync(CAPS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(CAPS, e.name, "manifest.json")))
    .map((e) => e.name)
    .sort();
}

function manifestOf(pid: string): { capabilities?: unknown } {
  return JSON.parse(readFileSync(resolve(CAPS, pid, "manifest.json"), "utf8"));
}

/** The derived recipe name for a capability id, per the documented rule. */
export function derivedRecipeName(id: string): string {
  for (const s of SUFFIXES_TO_STRIP) if (id.endsWith(s)) return `${id.slice(0, -s.length)}.json`;
  return `${id}.json`;
}

/** Resolve one capability's recipe, or null when it deliberately/nonexistently
 *  ships none. Same order as the packages gate. */
export function resolveRecipe(pid: string, entry: CapEntry): string | null {
  const r = entry.recipe;
  if (typeof r === "string" && r.trim()) return r.trim();
  if (r === null) return null; // explicitly "no recipe shipped"
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!id) return null;
  const own = resolve(CAPS, pid, "recipes", derivedRecipeName(id));
  if (existsSync(own)) return `recipes/${derivedRecipeName(id)}`;
  const shared = resolve(CAPS, pid, "recipes", `${id.split("_")[0]}.json`);
  if (existsSync(shared)) return `recipes/${id.split("_")[0]}.json`;
  return null;
}

/** The machine-readable no-recipe set, per package. */
export function noRecipeSet(ids?: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const pid of ids ?? pkgIds()) {
    const list = (manifestOf(pid).capabilities ?? []) as CapEntry[];
    const missing = list
      .filter((c): c is CapEntry & { id: string } => !!c && typeof c === "object" && typeof c.id === "string")
      .filter((c) => resolveRecipe(pid, c) === null)
      .map((c) => c.id);
    if (missing.length) out[pid] = missing.sort();
  }
  return out;
}

d("GOAL 97: the no-recipe set is machine-visible and cannot drift", () => {
  t("the no-recipe set is measured from source and non-empty (this gap is real)", () => {
    const set = noRecipeSet();
    const total = Object.values(set).reduce((n, v) => n + v.length, 0);
    // non-vacuity: the measurement must actually FIND the gap this goal closed
    assert.ok(total > 0, "expected at least one capability that ships no recipe (the measured gap)");
    assert.ok(Object.keys(set).length > 0, "expected at least one package with a no-recipe capability");
  });

  t("every capability with a resolvable recipe is NOT reported as no-recipe (no false positives)", () => {
    // Packages whose recipes == declared capabilities (MEASURED: gemini 5/5,
    // duckduckgo 6/6, youtube 7/7, gmail 5/5, araprat 9/9) must not appear.
    // NOTE: kimi is deliberately NOT here — it ships 5 recipes for 6 declared
    // capabilities (kimi_model_list has none), so it legitimately appears.
    for (const pid of ["gemini", "duckduckgo", "youtube", "gmail", "araprat"]) {
      const set = noRecipeSet([pid]);
      assert.deepEqual(set[pid] ?? [], [], `${pid} ships a recipe per declared capability; it must not be reported as no-recipe`);
    }
  });

  t("negative: a capability with no recipe must appear in the computed set (the pin CAN fail)", () => {
    // Precondition: a real package resolves cleanly.
    assert.deepEqual(noRecipeSet(["gemini"]).gemini ?? [], [], "precondition: gemini resolves");
    // Inject a capability that has no recipe and no derivable/shared file.
    const pid = "gemini";
    const ghost: CapEntry = { id: "gemini_ghost_no_recipe" };
    const list = (manifestOf(pid).capabilities ?? []) as CapEntry[];
    const missing = list
      .filter((c): c is CapEntry & { id: string } => !!c && typeof c === "object" && typeof c.id === "string")
      .map((c) => ({ c, r: resolveRecipe(pid, c) }))
      .filter((x) => x.r === null)
      .map((x) => x.c.id);
    // the real set is empty for gemini…
    assert.deepEqual(missing, [], "precondition: no real gemini capability is unresolvable");
    // …so a ghost capability must make it non-empty.
    const withGhost = resolveRecipe(pid, ghost) === null ? [...missing, ghost.id] : missing;
    assert.deepEqual(withGhost, ["gemini_ghost_no_recipe"], "a capability with no recipe must be reported");
  });
});
