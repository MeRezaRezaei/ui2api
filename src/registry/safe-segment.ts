/**
 * THE PACKAGE-TARGET SEGMENT GATE — one definition, both write seams.
 *
 * A package `name` / `version` / install `site` is not user input. It is an
 * IDENTIFIER: one safe path segment. Two seams turn one into a filesystem
 * path, and they were protected by rules that had drifted apart:
 *
 *   1. `src/hub/store.ts` `RegistryStore.save` — GOAL 121, over the wire: a
 *      PUT body whose `name` was `../../ESCAPED-DATA-DIR` landed OUTSIDE
 *      dataDir, and `name:"..", version:"registry"` overwrote the store's own
 *      `registry.json`. Gated by `assertSafePackageSegment`.
 *   2. `src/registry/install.ts` — GOAL 113, from a registry: gated the FILE
 *      KEYS inside a package (`assertPackageRelPath`) but NOT the package
 *      DIRECTORY NAME. `dir = resolve(packagesRoot, host)` with an unvalidated
 *      `host` is an escape that walks straight past a containment gate which
 *      is already in place: every file then passes, because containment was
 *      measured against the escaped `dir` instead of against `packagesRoot`.
 *      PROVEN over a real local registry: an index key `"../PWNED"` made
 *      `installPackage` return ok and write `metadata.json` + `manifest.json`
 *      to `<packagesRoot>/../PWNED` — outside the install root, one level up,
 *      which is the REPO ROOT in the default (no `--out`) case.
 *
 * The rule is POLICY, not a derivation: nothing in this repo computes the legal
 * spelling of a package identifier, and inventing one would be the fabrication
 * the repo forbids. It is a FILESYSTEM-SAFETY ALLOWLIST. What IS derivable —
 * and what this module exists to make true — is that both `resolve()`-into-a-
 * path seams share ONE definition of it, so a third state of the charset can
 * never exist on one seam and not the other.
 *
 * WHAT WOULD INVALIDATE IT: a package name or version that legitimately needs
 * `:`, `/`, or non-ASCII. Measured against the real corpus — 68 values, the 34
 * `capabilities/*` site ids plus their `ui2api-site-<host>` package names —
 * every one already passes, so the allowlist is a superset of what this repo
 * produces. Widening it is a one-line change with a named consequence;
 * narrowing it independently per seam is the thing this module exists to
 * prevent.
 *
 * WHY A SEPARATE MODULE (cycle check, measured not assumed): `src/hub/api.ts`
 * imports `src/hub/ui.ts`, so `ui.ts` importing a gate back out of `api.ts`
 * would close a loop — that is why the publish contract lives in its own leaf.
 * This module is a stricter leaf: its only import is `node:path` (a builtin,
 * not a repo edge), so its relative-import closure is {safe-segment} alone.
 * Verified by walking the relative-import graph from each importer — adding
 * this edge to `src/registry/install.ts` or `src/hub/store.ts` grows that
 * importer's closure by exactly this one file and cannot close a loop, because
 * the new node has no outgoing repo edges to begin with. Neither seam imports
 * the other, so the shared rule costs no new direction between the two.
 */
import { sep } from "node:path";

/**
 * GOAL 121 (hub publish) + GOAL 113 (registry install): refuse an identifier
 * that is not exactly one safe path segment, NAMING the field and the reason,
 * before any filesystem work happens.
 *
 * The order is load-bearing and the messages are ordered with it, so a reader
 * is always told the most specific reason that applies: type/length, then the
 * directory-reference form, then separators/NUL, then the charset. The first
 * three alone already make every traversal shape impossible (`..`, `a/b`,
 * `a\0b`); the charset is the tightening layer on top of them.
 */
export function assertSafePackageSegment(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid package ${field}: must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  if (value === "." || value === "..") {
    throw new Error(`invalid package ${field}: ${JSON.stringify(value)} is a directory reference, not a name`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\u0000")) {
    throw new Error(
      `invalid package ${field}: ${JSON.stringify(value)} must be a single path segment (no separators, no NUL)`
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`invalid package ${field}: ${JSON.stringify(value)} may only contain letters, digits, dot, underscore and dash`);
  }
  return value;
}
