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
import { CAPABILITY_RUNNERS } from "../src/prompt/http.js";
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

/**
 * ── THE DISPATCH KEY SET HAS ONE OWNER, AND THE ROUTE MAP MUST MATCH IT ─────
 *
 * `src/prompt/http.ts`'s `CAPABILITY_RUNNERS` and `src/prompt/capability-dispatch.ts`'s
 * `CAPABILITY_DISPATCH` are ONE fact — which site ids are dispatchable — held by
 * two owners, and the three GOAL-140 tests above never compared them. They read
 * `CAPABILITY_DISPATCH` (imported at :30) and the runner CLASSES in
 * `src/capabilities/`; before this gate, NO test in the repo read
 * `CAPABILITY_RUNNERS` at all (measured: zero references under `test/`).
 *
 * THE CONCRETE DRIFT. Add a package + its dispatch row — the exact edit every
 * "add a site" instruction in this repo asks for — and forget the runner map.
 * Then `registry.ts:1018` still reports `dispatch: "wired"` on `GET /registry`,
 * because it derives that from `CAPABILITY_DISPATCH` alone, while the route does
 * `new CAPABILITY_RUNNERS[site](...)` on `undefined` and answers a bare 500
 * `internal_error`. A consumer is told the capability is wired and gets a
 * server error. That is the "advertised, then 500" failure the dispatch table's
 * own header says it exists to kill — re-created by the map that serves it.
 *
 * WHAT IS AND IS NOT DERIVED, stated precisely: the VALUES are not derived, and
 * cannot be. `CAPABILITY_DISPATCH` holds its runner as a STRING so the table
 * stays importable without dragging 33 runner modules (and their playwright
 * imports) into every consumer. So the class binding stays typed at each site,
 * and the property that can drift — the KEY SET — is what this gate pins, by
 * comparing the two real sets rather than by grepping source.
 */
test("the route's runner map covers EXACTLY the dispatchable ids — no wired-but-absent site", () => {
  const dispatchIds = Object.keys(CAPABILITY_DISPATCH).sort();
  const runnerIds = Object.keys(CAPABILITY_RUNNERS).sort();

  assert.deepEqual(
    runnerIds,
    dispatchIds,
    "CAPABILITY_RUNNERS (the /capability route's site→class map) and CAPABILITY_DISPATCH (what /registry advertises as wired) must name the SAME ids. " +
      `Only in dispatch: ${JSON.stringify(dispatchIds.filter((i) => !runnerIds.includes(i)))} — advertised as wired but the route would 500. ` +
      `Only in runners: ${JSON.stringify(runnerIds.filter((i) => !dispatchIds.includes(i)))} — routed but not advertised.`,
  );

  // And each row's advertised runner NAME is the class the route actually uses,
  // so the gate covers the value too without importing the runner modules: the
  // dispatch row's `runner` string must appear as the key's class binding in
  // http.ts. This is the one place a source read is honest, because the binding
  // is a value in one file and a string in another and nothing else connects them.
  const httpSrc = readFileSync(resolve(ROOT, "src", "prompt", "http.ts"), "utf8");
  for (const id of dispatchIds) {
    const name = CAPABILITY_DISPATCH[id]!.runner;
    assert.match(
      httpSrc,
      new RegExp(`"${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*${name}\\b`),
      `the route must bind ${id} to ${name}, the class CAPABILITY_DISPATCH advertises for it`,
    );
  }
});
