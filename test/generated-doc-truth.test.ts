/**
 * GOAL 141 — THE GENERATED-DOC TRUTH GATE.
 *
 * What this pins: the generated PHP client documents ONLY methods it actually
 * generates.
 *
 * The defect it kills: `readmeFile()` emitted `$map->chat(...)`,
 * `$map->listConversations(...)` and `$map->webSearch(...)` UNCONDITIONALLY —
 * for EVERY package. Proven live against the youtube package, which has no chat
 * and neither of those capabilities: the README told a consumer to call three
 * methods that were never generated, so the first call was a fatal "Call to
 * undefined method". Generated documentation that invents an API is the same
 * class of defect as a fabricated verdict — it is a claim about reality that
 * reality does not support.
 *
 * The invariant, stated once so both tests read the same rule:
 *
 *   every method the README's example section calls MUST be a `public function`
 *   the generated map actually defines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { buildRegistryPackages } from "../src/prompt/registry.js";
import { generatePhpMaps } from "../src/generator/lang-php.js";

type Generated = { id: string; readme: string; map: string };

function generate(id: string): Generated {
  const pkg = buildRegistryPackages().find((p) => p.id === id);
  assert.ok(pkg, `no installed package for ${id}`);
  const dir = mkdtempSync(resolve(tmpdir(), "ui2api-phpdoc-"));
  try {
    generatePhpMaps([pkg], dir, id);
    const root = resolve(dir, id);
    const mapRel = readdirSync(root, { recursive: true }).find((f) =>
      String(f).endsWith("Map.php")
    ) as string | undefined;
    assert.ok(mapRel, `no generated *Map.php for ${id}`);
    return {
      id,
      readme: readFileSync(resolve(root, "README.md"), "utf8"),
      map: readFileSync(resolve(root, mapRel), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every `$map->name(` the README's prose promises. */
function documentedMethods(readme: string): string[] {
  return [...readme.matchAll(/\$map->([A-Za-z0-9_]+)\(/g)].map((m) => m[1]);
}

/** Every `public function name(` the generated map defines. */
function definedMethods(map: string): string[] {
  return [...map.matchAll(/public function ([A-Za-z0-9_]+)\(/g)].map((m) => m[1]);
}

test("GOAL 141: the generated README never documents a method the map does not define", () => {
  // Checked across the WHOLE installed surface, not one hand-picked site — the
  // defect was unconditional, so the guarantee has to be universal.
  const ids = buildRegistryPackages().map((p) => p.id);
  assert.ok(ids.length > 20, `expected the full surface, got ${ids.length}`);
  const lies: string[] = [];
  for (const id of ids) {
    const { readme, map } = generate(id);
    const defined = new Set(definedMethods(map));
    for (const m of documentedMethods(readme)) {
      if (!defined.has(m)) lies.push(`${id}: README calls $map->${m}() but the map defines no such method`);
    }
  }
  assert.deepEqual(lies, [], `generated documentation promises methods that do not exist:\n  ${lies.join("\n  ")}`);
});

test("GOAL 141: a CHATLESS package is told so, instead of being shown a chat example", () => {
  // youtube is the measured proof case: no chat model, no list_conversations,
  // no web_search — the exact package the old README lied about.
  const { readme, map } = generate("youtube");
  const defined = new Set(definedMethods(map));
  assert.ok(defined.size > 0, "the youtube map must define methods");
  for (const absent of ["chat", "listConversations", "webSearch"]) {
    assert.ok(
      !readme.includes(`$map->${absent}(`),
      `youtube is chatless but its README still shows $map->${absent}()`
    );
  }
  // The honest alternative is stated, not silently omitted.
  assert.ok(
    /exposes NO chat model/i.test(readme),
    "a chatless package's README must SAY it has no chat model, not just omit the example"
  );
  // And its real capabilities are still documented. The example section only
  // shows chat/conversation/search METHODS (the quick-start), so the real
  // youtube surface is proven in the derived Capabilities list below — which is
  // where a consumer looks for "what can this map do".
  assert.ok(
    /`search\(\)`/.test(readme),
    "youtube's real search() must still appear in the Capabilities list"
  );
  assert.ok(
    !/^\s*\$answer = \$map->search\(/m.test(readme),
    "the quick-start must not invent a search() example signature that does not exist as documented"
  );
});

test("GOAL 141: a CHAT package keeps its chat example (the fix is not over-correction)", () => {
  // The counterpart guard. Dropping every example would also satisfy the test
  // above, so the chat case must still document what it really has.
  const { readme, map } = generate("deepseek");
  const defined = new Set(definedMethods(map));
  assert.ok(defined.has("chat"), "deepseek must still generate a chat method");
  assert.ok(readme.includes("$map->chat("), "deepseek's README must still show the chat example");
  assert.ok(readme.includes("$map->listConversations("), "deepseek really has list_conversations, so it must stay documented");
  assert.ok(readme.includes("$map->webSearch("), "deepseek really has web_search, so it must stay documented");
  // done_reason is a chat concept and rides along with the chat example.
  assert.ok(readme.includes("done_reason"), "a chat package must still document done_reason");
});

test("GOAL 141: the per-site Capabilities list is still derived from the registry", () => {
  // The part that was already correct and must not regress while fixing the lie.
  const { readme, map } = generate("youtube");
  const defined = new Set(definedMethods(map));
  // `__construct` is the PHP constructor, not a capability — it is correctly
  // absent from a capability list.
  for (const m of defined) {
    if (m === "__construct") continue;
    assert.ok(
      readme.includes(`\`${m}()\``),
      `youtube's Capabilities list must mention its real method ${m}()`
    );
  }
});

test("GOAL 142: generated build output is never TRACKED by git (it carries machine paths)", () => {
  // The defect: `.gitignore` said `sites/*/server/`, which cannot match the
  // `sites/server/` directory that a direct-target run actually produces — so six
  // generated files were COMMITTED, one embedding this machine's absolute source
  // path. Build output is regenerable and machine-specific, so it must never be
  // tracked. Asserted against git itself rather than by re-reading .gitignore,
  // because the point is what git ACTUALLY does with the path.
  const tracked = execFileSync("git", ["ls-files", "sites/"], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    timeout: 60_000,
  })
    .split("\n")
    .filter(Boolean);
  const offenders = tracked.filter((f) => /(^|\/)server\//.test(f));
  assert.deepEqual(
    offenders,
    [],
    `generated server output is tracked and would ship machine-specific paths: ${offenders.join(", ")}`
  );
  // And an absolute machine path must not be sitting in a tracked file.
  for (const f of tracked) {
    const abs = resolve(import.meta.dirname, "..", f);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, "utf8");
    assert.ok(
      !/(^|[\s"'`])(\/home\/[A-Za-z0-9._-]+|\/Users\/)/m.test(src),
      `tracked file ${f} embeds a machine-absolute path — generated output must not be tracked`
    );
  }
});
