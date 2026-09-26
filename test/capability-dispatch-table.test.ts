/**
 * GOAL 140 — THE DISPATCH GATE.
 *
 * What this pins: registering a site is DATA, not an edit to a 1,700-line HTTP
 * handler.
 *
 * The audit behind this work found the last real leak between the app and the
 * registry. `/registry` was built from package data, but EXECUTION was 33
 * hand-written `if (req.url === "/capability/<site>")` blocks in http.ts —
 * 54,851 characters of copy-paste. A package dropped into `capabilities/<id>/`
 * appeared on /registry and then 404'd at call time, and a skill teaching an AI
 * to "register a site" would have had to teach it to edit the HTTP handler.
 * That is app code standing in for registry data.
 *
 * It is now ONE table (`src/prompt/capability-dispatch.ts`) plus one handler.
 * These tests make that structure load-bearing rather than aspirational:
 *
 *   1. Every served tool is WIRED — nothing is advertised that 404s.
 *   2. Every package with capabilities has a dispatch row AND a runner class
 *      (the two halves cannot drift apart).
 *   3. The table's runner names match the real exported classes (a rename fails
 *      here instead of at the first live call).
 *   4. Every table row names a real file on disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { CAPABILITY_DISPATCH, dispatchableSiteIds, isDispatchable } from "../src/prompt/capability-dispatch.js";
import { buildRegistryPackages } from "../src/prompt/registry.js";

const ROOT = resolve(import.meta.dirname, "..");
const RUNNERS = resolve(ROOT, "src", "capabilities");
const CAP = resolve(ROOT, "capabilities");

test("GOAL 140: no served tool is advertised without a dispatch route", () => {
  const tools = buildRegistryPackages().flatMap((p) =>
    p.tools.map((t) => ({ pkg: p.id, ...t }))
  );
  assert.ok(tools.length > 100, `expected the whole surface, got ${tools.length}`);
  const unwired = tools.filter((t) => t.dispatch !== "wired");
  assert.deepEqual(
    unwired.map((t) => `${t.pkg}/${t.id}`),
    [],
    "a declared-only tool is honest ONLY if it is visible as such; if this list is non-empty the registry is advertising capabilities the daemon cannot route"
  );
  // And the field itself must exist and be one of the two honest values.
  for (const t of tools) {
    assert.ok(
      t.dispatch === "wired" || t.dispatch === "declared-only",
      `${t.pkg}/${t.id}: dispatch must be "wired" or "declared-only", got ${JSON.stringify(t.dispatch)}`
    );
  }
});

test("GOAL 140: every package with capabilities has a dispatch row AND a runner class", () => {
  const rows = new Set(dispatchableSiteIds());
  for (const site of readdirSync(CAP)) {
    const mf = resolve(CAP, site, "manifest.json");
    if (!existsSync(mf)) continue;
    const manifest = JSON.parse(readFileSync(mf, "utf8"));
    if (!(manifest.capabilities ?? []).length) continue;
    assert.ok(
      rows.has(site),
      `package ${site} declares capabilities but has NO dispatch row — it would be advertised and then 404`
    );
    const entry = CAPABILITY_DISPATCH[site];
    const runnerFile = resolve(RUNNERS, `${site}.ts`);
    assert.ok(
      existsSync(runnerFile),
      `package ${site} is dispatchable but src/capabilities/${site}.ts does not exist`
    );
    assert.ok(
      entry.runner.length > 0,
      `package ${site} has a dispatch row with no runner class`
    );
  }
});

test("GOAL 140: each dispatch row's runner name is a REAL exported class", () => {
  for (const site of dispatchableSiteIds()) {
    const entry = CAPABILITY_DISPATCH[site];
    const file = resolve(RUNNERS, `${site}.ts`);
    assert.ok(existsSync(file), `no runner file for dispatched site ${site}`);
    const src = readFileSync(file, "utf8");
    assert.ok(
      new RegExp(`export\\s+class\\s+${entry.runner}\\b`).test(src),
      `src/capabilities/${site}.ts does not export class ${entry.runner} — the table names a class that does not exist`
    );
  }
});

test("GOAL 140: the table is the ONLY dispatch path — no per-site handler remains", () => {
  const http = readFileSync(resolve(ROOT, "src", "prompt", "http.ts"), "utf8");
  // The old shape was one hardcoded `if` per site. Any survivor means registering
  // a site still needs an app edit, which is the whole defect.
  const perSite = http.match(/req\.url === "\/capability\/[a-z0-9-]+"/g) ?? [];
  assert.deepEqual(
    perSite,
    [],
    "a per-site /capability/<id> literal is back in http.ts — the dispatch table was bypassed"
  );
  // The table-driven handler must be present and use startsWith (prefix match).
  assert.ok(
    http.includes('req.url?.startsWith("/capability/")'),
    "the table-driven capability handler is missing from http.ts"
  );
});

test("GOAL 140: isDispatchable agrees with the table (no prototype-key confusion)", () => {
  // `isDispatchable("toString")` must be false: an inherited key would make a
  // nonsense site id "dispatchable" and then crash on a missing runner class.
  for (const bogus of ["toString", "constructor", "__proto__", "hasOwnProperty", "nope"]) {
    assert.equal(isDispatchable(bogus), false, `"${bogus}" must not be dispatchable`);
  }
  assert.equal(isDispatchable("duckduckgo"), true);
});
