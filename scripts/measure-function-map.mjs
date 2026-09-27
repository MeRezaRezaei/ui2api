// GOAL 82 — one measurement seam for the FUNCTION→API→UI map. Every number
// docs/function-api-ui-map.md prints is derived from THIS disk census (plus the
// test runner), never from prose. Both `test/function-doc-truth.test.ts` and
// the doc rewrite consume the same functions, so a corpus change moves the map
// and its pin together.
//
// Usage:
//   node scripts/measure-function-map.mjs          # human table
//   node scripts/measure-function-map.mjs --json    # machine-consumable
//
// Honest rules: reads committed sources + the project's own runner only. No
// browser, no network, no data/, no session mutation.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const CAPABILITIES = join(ROOT, "capabilities");
const RUNNERS = join(ROOT, "src", "capabilities");
const HTTP = join(ROOT, "src", "prompt", "http.ts");

/** ids of every dir carrying a manifest.json under capabilities/ (sorted). */
export function packageIds() {
  return readdirSync(CAPABILITIES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(CAPABILITIES, e.name, "manifest.json")))
    .map((e) => e.name)
    .sort();
}

/** manifest capability id list for one site (id with name fallback — the SAME
 *  resolution test/function-api-ui-closure.test.ts uses). */
function manifestCapabilityIds(site) {
  const m = JSON.parse(readFileSync(join(CAPABILITIES, site, "manifest.json"), "utf8"));
  return (m.capabilities ?? []).map((c) => c.id ?? c.name).filter((x) => typeof x === "string" && x.length > 0);
}

/** total manifest capability functions across all packages. */
export function capabilityTotal() {
  return packageIds().reduce((n, id) => n + manifestCapabilityIds(id).length, 0);
}

/** real-runner ids: the RUNNERS table in test/capability-dispatch.test.ts.
 *
 *  Scoped to the TABLE on purpose. A whole-file `/id: "…"/` scan counted any
 *  such literal anywhere in the file, so the first scratch fixture that carried
 *  an `id:` (GOAL 147's falsifiability proof wrote `id: "scratch-stamped"`)
 *  silently reported 15 real runners and turned a doc census number into a
 *  fiction. The census is a MEASUREMENT; a measurement that any unrelated edit
 *  can move is not one. It is anchored to `const RUNNERS` .. its closing `];`
 *  and refuses to answer if that table cannot be found, so a moved or renamed
 *  table is a named failure rather than a plausible wrong number. */
export function realRunnerIds() {
  const src = readFileSync(join(ROOT, "test", "capability-dispatch.test.ts"), "utf8");
  const start = src.search(/^const RUNNERS\b[^\n]*=\s*\[/m);
  if (start < 0) throw new Error("realRunnerIds: no `const RUNNERS = [` table in test/capability-dispatch.test.ts — the census can no longer be measured");
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error("realRunnerIds: the RUNNERS table in test/capability-dispatch.test.ts has no closing `];` — the census can no longer be measured");
  const table = src.slice(start, end);
  return [...table.matchAll(/id: "([a-z0-9-]+)"/g)].map((m) => m[1]).filter((id, i, a) => a.indexOf(id) === i);
}

/** login-gated-by-design ids: the `LOGIN_GATED_BY_DESIGN` Set in
 *  test/function-api-ui-closure.test.ts.
 *
 *  ANCHORED, and it refuses to answer when the anchor is gone. This was the one
 *  unguarded census in this file: it ran a whole-file
 *  /^\s+"([a-z0-9-]+)",\s*$/gm scan, which matches ANY bare quoted lowercase
 *  string sitting alone on a line ANYWHERE in a 259-line test file. Two
 *  independent ways to fabricate the number, both silent:
 *
 *    1. an unrelated scratch fixture on its own line ADDS a "gated" package
 *       (exactly how GOAL 147's falsifiability proof broke realRunnerIds — it
 *       wrote `id: "scratch-stamped"` and the census answered 15 real runners);
 *    2. renaming or reindenting the declaration makes the scan find NOTHING, and
 *       `realGatedSplit()` then reports `gatedN: 0` — a CLEAN ZERO presented as
 *       SUCCESS, with the doc number silently dropping 76 capabilities to 0.
 *
 *  A gate that finds nothing because it understood nothing is not a gate. So
 *  this anchors to `const LOGIN_GATED_BY_DESIGN = new Set([` .. its closing
 *  `]);` and throws a named error if either end is missing, exactly as
 *  realRunnerIds does. The 0-arg signature is fixed by
 *  scripts/measure-function-map.d.mts, so the anchoring is proved falsifiable
 *  in test/scripts-measure-anchoring.test.ts by relocating a byte-identical
 *  copy of THIS script into a temp root holding a mutated source file. */
export function gatedIds() {
  const file = join(ROOT, "test", "function-api-ui-closure.test.ts");
  const src = readFileSync(file, "utf8");
  const start = src.search(/^const\s+LOGIN_GATED_BY_DESIGN\s*=\s*new Set\(\[/m);
  if (start < 0)
    throw new Error(
      "gatedIds: no `const LOGIN_GATED_BY_DESIGN = new Set([` in " +
        `${file} — the census can no longer be measured (an unanchored scan would ` +
        `silently answer 0, which reads as "no package is login-gated")`
    );
  const end = src.indexOf("\n]);", start);
  if (end < 0)
    throw new Error(
      "gatedIds: the LOGIN_GATED_BY_DESIGN set in " +
        `${file} has no closing \`]);\` — the census can no longer be measured`
    );
  const table = src.slice(start, end);
  return [...table.matchAll(/^\s*"([a-z0-9-]+)",?\s*$/gm)].map((m) => m[1]);
}

/** capability totals split by real-runner vs gated (sums to capabilityTotal()). */
export function realGatedSplit() {
  const real = new Set(realRunnerIds());
  const gated = new Set(gatedIds());
  let realN = 0;
  let gatedN = 0;
  for (const site of packageIds()) {
    const n = manifestCapabilityIds(site).length;
    if (real.has(site)) realN += n;
    else if (gated.has(site)) gatedN += n;
  }
  return { realN, gatedN };
}

/** number of `req.url === "/capability/<id>"` dispatchers in http.ts. */
export function capabilityRouteCount() {
  const src = readFileSync(HTTP, "utf8");
  const m = src.match(/req\.url === "\/capability\/([^"\s]+)"/g) ?? [];
  return m.length;
}

/** number of driveable chat profiles defaultChatProfiles() returns — measured
 *  for real by spawning the project's own tsx loader (no pool/browser; pure
 *  builtin + packaged profile resolution). Requires the project deps to be
 *  installed (tsx resolves via node_modules), same as every test/ and cli run. */
export function chatProfileCount() {
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", "-e", 'import { defaultChatProfiles } from "./src/prompt/registry.ts"; process.stdout.write(String(defaultChatProfiles().length));'],
    { cwd: ROOT, encoding: "utf8" }
  );
  const n = Number(out.trim());
  if (!Number.isInteger(n) || n <= 0) throw new Error(`defaultChatProfiles() census failed: ${out}`);
  return n;
}

export function measure() {
  const ids = packageIds();
  const { realN, gatedN } = realGatedSplit();
  return {
    packageCount: ids.length,
    packages: ids,
    capabilityTotal: capabilityTotal(),
    realRunnerCount: realRunnerIds().length,
    realRunners: realRunnerIds(),
    gatedCount: gatedIds().length,
    gated: gatedIds(),
    realCaps: realN,
    gatedCaps: gatedN,
    capabilityRouteCount: capabilityRouteCount(),
    chatProfileCount: chatProfileCount(),
  };
}

if (process.argv[1] && process.argv[1].endsWith("measure-function-map.mjs")) {
  const json = process.argv.includes("--json");
  const m = measure();
  if (json) {
    console.log(JSON.stringify(m, null, 2));
  } else {
    console.log(`packages        ${m.packageCount}`);
    console.log(`manifest caps   ${m.capabilityTotal}`);
    console.log(`real runners    ${m.realRunnerCount} (${m.realRunners.join(", ")}) = ${m.realCaps} caps`);
    console.log(`gated-by-design ${m.gatedCount} = ${m.gatedCaps} caps`);
    console.log(`/capability routes in http.ts: ${m.capabilityRouteCount}`);
    console.log(`defaultChatProfiles(): ${m.chatProfileCount}`);
  }
}