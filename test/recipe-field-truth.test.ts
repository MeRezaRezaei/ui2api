import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startPromptd } from "../src/prompt/http.js";
import { listInstalledPackageIds } from "../src/prompt/registry.js";
import type { ChatPool } from "../src/prompt/pool.js";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT `recipe` IS — MEASURED, not assumed
//
// Two DIFFERENT fields share the name. Only one of them is on a package
// manifest, and conflating them is how this question gets answered wrongly:
//
//   1. THE MANIFEST CAPABILITY `recipe` — a STRING FILE PATH
//      (`recipes/<cap>.json`) on a package's manifest.json capability entry.
//      MEASURED over the real tree: 34 capability dirs, 33 packages declare a
//      `recipe` key on >=1 capability; 161 capability entries, 153 carry the
//      key, of which 81 are the empty string `""` (behaviour lives inline in
//      the manifest) and 72 are non-empty paths; 71 distinct paths; 0 of them
//      missing from disk.
//
//   2. THE ACTION-MAP `recipe` — an OBJECT (`{kind, target, network}`,
//      src/types.ts:21) on a captured ACTION in a generated action map, read
//      by src/schema.ts, src/plugin/loader.ts, src/runtime/browser-session.ts
//      and src/runtime/redact.ts. This one IS read at serve time — but it is a
//      different artifact entirely and has nothing to do with a package.
//
// WHAT THE MANIFEST `recipe` DOES AT SERVE TIME: NOTHING. Measured:
//   - src/prompt/registry.ts, src/prompt/http.ts, src/prompt/openai.ts each
//     contain 0 `.recipe` member reads and 0 "recipe" string literals;
//   - a real daemon over loopback puts 0 `recipe` keys on the wire, at ANY
//     depth, for /registry, /capabilities/<every installed package>,
//     /sites and /v1/models;
//   - the ONLY reader of a manifest capability's `recipe` in all of src/ is
//     src/registry/install.ts (`.map((c) => c?.recipe)`).
//
// So the honest verdict is NOT "a dead field nobody reads". It is: an
// INSTALL-TIME INDEX. It (a) tells the installer which files to FETCH, before
// any capability is validated; (b) is what makes a recipes/*.json file
// non-orphan in scripts/validate-registry.mjs; (c) is JSON-gated at install.
// It is declared in an artifact a consumer can read off disk, it drives a
// network request, and it never reaches or influences anything the daemon
// serves. The project's red line — nothing advertised may be unreachable — is
// at risk here in its quietest form: a field a reader of the package would
// reasonably take for serve-time behaviour.
//
// WHAT IS ALREADY PINNED ELSEWHERE (deliberately NOT restated as new ground —
// these are the pre-existing owners of the install/validate half):
//   - test/validate-packages.test.ts check B: every declared recipe resolves to
//     an existing file, on the REAL tree;
//   - test/validate-packages.test.ts check F + test/validate-registry.test.ts:
//     orphan recipe files, on synthetic fixtures;
//   - test/install-path-containment.test.ts: the path guard precedes the fetch;
//   - test/install.test.ts: recipe fetch lands + corrupt recipe JSON refuses.
//
// THE GAP THIS FILE CLOSES: the SERVE-SIDE half is asserted nowhere. It is
// stated as prose in a comment in src/registry/install.ts ("the serve seam
// already reads it that way: src/prompt/registry.ts contains no occurrence of
// recipe at all") — a measurement with no pin, so it can rot silently in
// either direction. These are the pins for that half.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const SERVE_FILES = ["src/prompt/registry.ts", "src/prompt/http.ts", "src/prompt/openai.ts"];
const INSTALL_FILE = "src/registry/install.ts";

/** Every `recipe` KEY at any depth of a decoded JSON payload. */
function recipeKeyPaths(value: unknown, path = "$", out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) recipeKeyPaths(value[i], `${path}[${i}]`, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "recipe") out.push(`${path}.recipe`);
      recipeKeyPaths(v, `${path}.${k}`, out);
    }
  }
  return out;
}

// ── (1) the serve path does not READ the manifest `recipe` field ─────────────

test("recipe: the serve path does not READ the manifest recipe field (0 member reads, 0 key literals, in all three serve files)", () => {
  // Scoped deliberately to READS, not to the word: a prose mention of "recipe"
  // in a comment — documenting this very finding — is legitimate and must not
  // redden the pin. What is forbidden is the field being consumed or surfaced.
  for (const rel of SERVE_FILES) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    const memberReads = (src.match(/\.recipe\b/g) ?? []).length;
    const keyLiterals = (src.match(/["']recipe["']/g) ?? []).length;
    assert.equal(memberReads, 0, `${rel} reads the manifest recipe field (${memberReads} .recipe member access(es)) — if recipe has become serve-time behaviour, that is a deliberate contract change and this pin is where it is recorded`);
    assert.equal(keyLiterals, 0, `${rel} carries a "recipe" string literal — the serve path must never key on the manifest recipe field`);
  }
});

test("recipe: install.ts is the ONE reader of a manifest capability's recipe, and every other .recipe read in src/ belongs to the action-map recipe (a different artifact)", () => {
  // Walk every .ts in src/ and classify each `.recipe` read. The manifest field
  // is read exactly once; the action-map reads are legitimate and must NOT be
  // "fixed" by deleting them (this pin is what stops that misreading).
  const files: string[] = [];
  (function walk(dir: string): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) files.push(p);
    }
  })(join(ROOT, "src"));

  const manifestReaders: string[] = [];
  const actionMapReaders = new Set<string>();
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1);
    const src = readFileSync(f, "utf8");
    for (const line of src.split("\n")) {
      if (!/\.recipe\b/.test(line)) continue;
      // `c?.recipe` / `cap.recipe` on a MANIFEST capability vs `action.recipe`
      // on a captured ACTION. The action-map field is an object with .kind/
      // .target/.network members; the manifest field is a path string.
      if (/\b(action|a)\s*\??\.\s*recipe\b/.test(line) || /action\??\.recipe/.test(line)) actionMapReaders.add(rel);
      else manifestReaders.push(`${rel}: ${line.trim().slice(0, 80)}`);
    }
  }
  assert.deepEqual(
    manifestReaders,
    [`${INSTALL_FILE}: .map((c) => c?.recipe)`],
    "exactly ONE site may read a manifest capability's recipe (the installer). A second reader means the field became serve-time behaviour — record that deliberately here.",
  );
  // Anti-vacuity: the action-map recipe IS read, and those reads are real.
  // (MEASURED: src/plugin/loader.ts, src/runtime/browser-session.ts,
  // src/runtime/redact.ts, src/schema.ts.)
  assert.ok(actionMapReaders.size >= 2, `the action-map recipe must still be read somewhere (found ${[...actionMapReaders].join(", ")})`);
  for (const rel of actionMapReaders) {
    assert.ok(
      !SERVE_FILES.includes(rel),
      `${rel} reads an action-map recipe — that is a DIFFERENT artifact and must not be confused with the manifest field`,
    );
  }
});

// ── (2) no recipe key reaches any serve-time wire payload ────────────────────

test("recipe: NO recipe key reaches any serve-time payload — /registry, /capabilities/<every installed package>, /sites, /v1/models (measured over loopback, no browser)", async () => {
  const prevAttach = process.env.UI2API_ATTACH_PORT;
  process.env.UI2API_ATTACH_PORT = "1";
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-recipe-wire-"));
  const pool = {
    startReaper() {}, stopReaper() {}, async close() {},
    async acquire() { return { driver: { ask: async () => ({ answer: "S", chunkCount: 1, doneReason: "stop" }) } }; },
    async release() {},
    status: () => ({ pages: [], warm: 0, idle: 0, busy: 0 }),
  } as unknown as ChatPool;
  const installed = listInstalledPackageIds();
  let svc: Awaited<ReturnType<typeof startPromptd>> | undefined;
  try {
    svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir, pool });
    const base = `http://127.0.0.1:${svc.port}`;
    const paths = ["/registry", "/sites", "/v1/models", ...installed.map((id) => `/capabilities/${id}`)];
    assert.ok(installed.length > 0, "anti-vacuity: expected installed packages to probe");
    const offenders: string[] = [];
    let probed = 0;
    for (const path of paths) {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) });
      if (res.status !== 200) continue;
      const hits = recipeKeyPaths(await res.json());
      probed++;
      if (hits.length) offenders.push(`${path} -> ${hits.slice(0, 3).join(", ")}`);
    }
    console.error(`[recipe-wire] probed ${probed} payloads (${installed.length} installed packages), payloads carrying a recipe key: ${offenders.length}`);
    assert.deepEqual(
      offenders,
      [],
      "a serve-time payload exposes the manifest recipe field — the daemon must never advertise a recipe it does not consume (a consumer would treat it as reachable behaviour)",
    );
  } finally {
    await svc?.close();
    if (prevAttach === undefined) delete process.env.UI2API_ATTACH_PORT;
    else process.env.UI2API_ATTACH_PORT = prevAttach;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── (3) the field is not dead: the install-time index still works ───────────

test("recipe: the install-time index is intact — guard BEFORE fetch, fetch BEFORE capability validation, validation BEFORE any write", () => {
  const src = readFileSync(join(ROOT, INSTALL_FILE), "utf8");
  const guard = src.lastIndexOf("assertPackageRelPath(recipe", src.indexOf("await fetch(`${pkgBase}/${recipe}`)"));
  const fetchIdx = src.indexOf("await fetch(`${pkgBase}/${recipe}`)");
  const validate = src.indexOf("validManifestCapability(caps[i])");
  const write = src.indexOf("writeFileSync(out, textByFile[file]!)");
  // Relative order only — absolute offsets rot on any edit above them.
  assert.ok(guard > 0 && fetchIdx > 0 && validate > 0 && write > 0, "the install seam's four anchors must all be present (a refactor that removes one must be deliberate)");
  assert.ok(guard < fetchIdx, "the manifest-declared recipe path must be validated BEFORE the fetch it drives (GOAL 113: a traversal ref must never reach the network)");
  assert.ok(fetchIdx < validate, "the recipe fetch happens before the capability is validated — the field drives a network request ahead of the capability it belongs to");
  assert.ok(validate < write, "no byte may be written before the whole package is validated (GOAL 65)");
});

// ── (4) the index is bidirectional over the REAL tree (the measured baseline) ─

test("recipe: over the real capabilities/ tree the recipe index is bidirectional — every declared non-empty recipe exists, and every recipes/*.json is referenced", () => {
  const capsDir = join(ROOT, "capabilities");
  const ids = readdirSync(capsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(capsDir, e.name, "manifest.json")))
    .map((e) => e.name)
    .sort();
  assert.ok(ids.length > 0, "anti-vacuity: expected installed packages");

  let declared = 0, empty = 0, packagesDeclaring = 0;
  const missing: string[] = [];
  const referenced = new Set<string>();
  for (const id of ids) {
    const manifest = JSON.parse(readFileSync(resolve(capsDir, id, "manifest.json"), "utf8")) as {
      capabilities?: Array<{ id?: unknown; recipe?: unknown }>;
    };
    let any = false;
    for (const c of manifest.capabilities ?? []) {
      if (!Object.prototype.hasOwnProperty.call(c, "recipe")) continue;
      any = true;
      declared++;
      const r = c.recipe;
      // The empty string is a documented "behaviour lives inline in the
      // manifest" marker, not a path — install.ts filters it out and
      // validate-registry.mjs skips it. It is NOT a missing file.
      if (typeof r !== "string" || r.length === 0) { empty++; continue; }
      referenced.add(`${id}/${r}`);
      if (!existsSync(resolve(capsDir, id, r))) missing.push(`${id}: ${c.id as string} -> ${r}`);
    }
    if (any) packagesDeclaring++;
  }
  // Measured baseline: this is what makes the "unread at serve time" pins
  // above non-vacuous — if no package declared a recipe, "nothing reads it"
  // would be trivially true.
  assert.ok(declared > 0, "expected manifest capabilities to declare a recipe field");
  assert.ok(packagesDeclaring > 0, "expected at least one package to declare a recipe");
  assert.deepEqual(missing, [], "a manifest declares a recipe file that does not exist — an advertised file that cannot be fetched (the quiet red line, on the install side)");

  // The reverse: a recipes/*.json nobody references is unreachable BY DESIGN —
  // the installer never fetches it, so it is dead weight shipped to every
  // consumer. (scripts/validate-registry.mjs owns the same rule on its own
  // fixtures; this is the real-tree half.)
  const orphans: string[] = [];
  for (const id of ids) {
    const rdir = resolve(capsDir, id, "recipes");
    if (!existsSync(rdir)) continue;
    for (const f of readdirSync(rdir)) {
      if (!f.endsWith(".json")) continue;
      if (!referenced.has(`${id}/recipes/${f}`)) orphans.push(`${id}/recipes/${f}`);
    }
  }
  console.error(`[recipe-index] packages=${ids.length} declaring=${packagesDeclaring} declared-keys=${declared} empty=${empty} referenced-paths=${referenced.size} missing=${missing.length} orphans=${orphans.length}`);
  assert.deepEqual(orphans, [], "a recipes/*.json file is referenced by NO capability — nothing will ever fetch it");
});
