import { redactActionMap } from "../runtime/redact.js";
import { validateActionMap } from "../schema.js";

/**
 * Write-truth gate for hub-published package modules (GOAL 69).
 *
 * Mirrors the runtime's OWN classification (src/hub/runtime.ts getInstance):
 *   - a module that parses as JSON with an `actions` array is an action-map
 *     package — it must pass `validateActionMap` (the same schema
 *     `loadPluginFromMap` enforces at serve time);
 *   - anything else is a JS plugin module — the loader
 *     (src/plugin/loader.ts loadPluginModule) loads it via
 *     `import("data:text/javascript," + …)` and REQUIRES
 *     `mod.default ?? mod.plugin` to carry `setup()`, so a module text with no
 *     export statement is deterministically dead.
 *
 * The gate refuses only artifacts the runtime deterministically cannot serve,
 * with a NAMED verdict, so `PUT /api/packages` never answers `{ok:true}` for a
 * module that dies on first use. It never EXECUTES submitted code (a parse
 * check, not a run), and it never evaluates the value of a default export
 * (`export default 42` passes here — only the serve seam can see that, by
 * design; that throw is the loader's own named authority, like GOAL 65 leaves
 * the read/serve seams for shape drift).
 *
 * @returns null when the module is publishable, otherwise the named verdict.
 */
/**
 * GOAL 125: a captured action map can carry the operator's live session
 * credentials (a --login capture records the site's own auth POSTs), and
 * `hub publish` / `PUT /api/packages` shipped it. A shape gate cannot see a
 * credential, so this is a named CONTENT verdict.
 */
function credentialsInActionMap(text: string): string | null {
  let hits: string[];
  try {
    ({ hits } = redactActionMap(JSON.parse(text)));
  } catch {
    return null; // not JSON; the existing shape gate owns that verdict
  }
  if (hits.length === 0) return null;
  return `credentials-in-action-map: ${hits.length} credential field(s) would be published (${[
    ...new Set(hits),
  ].join(", ")}) — re-run \`ui2api analyse\` so the map is written redacted, or remove the field`;
}

export function validatePublishedModule(moduleText: string): string | null {
  if (moduleText == null) return "module required — nothing to publish";
  if (typeof moduleText !== "string") return "module must be a string";
  const text = moduleText;
  if (!text.trim()) return "module required — nothing to publish";

  const credVerdict = credentialsInActionMap(text);
  if (credVerdict) return credVerdict;

  let parsed: unknown = null;
  let isJson = false;
  try {
    parsed = JSON.parse(text);
    isJson = true;
  } catch {
    // not JSON → JS plugin module path
  }

  if (isJson) {
    if (parsed && Array.isArray((parsed as { actions?: unknown }).actions)) {
      try {
        validateActionMap(parsed);
        return null;
      } catch (e) {
        return `action-map-invalid: ${(e as Error).message}`;
      }
    }
    return "json-without-actions — JSON module text can never default-export a plugin; publish the JS module or an action-map with an actions array";
  }

  // JS plugin module. The loader needs `mod.default ?? mod.plugin` — a module
  // with no export statement at all can never provide either. (export default…,
  // export const plugin…, export { plugin }… all match `export`.)
  if (!/export\s+/.test(text))
    return "module-not-loadable — no export statement; the plugin loader requires a default export (or exported plugin) with setup()";

  return null;
}