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

/** real-runner ids: the RUNNERS table in test/capability-dispatch.test.ts. */
export function realRunnerIds() {
  const src = readFileSync(join(ROOT, "test", "capability-dispatch.test.ts"), "utf8");
  return [...src.matchAll(/id: "([a-z0-9-]+)"/g)].map((m) => m[1]).filter((id, i, a) => a.indexOf(id) === i);
}

/** login-gated-by-design ids: the set in test/function-api-ui-closure.test.ts. */
export function gatedIds() {
  const src = readFileSync(join(ROOT, "test", "function-api-ui-closure.test.ts"), "utf8");
  return [...src.matchAll(/^\s+"([a-z0-9-]+)",\s*$/gm)].map((m) => m[1]);
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