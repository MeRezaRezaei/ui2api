/**
 * Item 3 — the measured dead branch in `capabilityInputSchema`'s four regex
 * guessers: KEEP, and this file is the record of that decision.
 *
 * WHERE THE BRANCH LIVES. It is NOT in scripts/derive-capability-args.ts (this
 * work's editable surface) — it is in `src/prompt/registry.ts:319`, reached from
 * `buildRegistryPackages()` at registry.ts:690 with `declared` =
 * `declaredCapabilityInputSchema(entry)`. The derivation in
 * scripts/derive-capability-args.ts is what makes every `declared` truthy, so
 * this file measures the derivation's OUTPUT CONDITION — which is the only
 * reason the branch is unreachable — rather than re-testing the branch.
 *
 * THE MEASURED FACTS (2026-09-27, 33 packages / 161 capabilities):
 *   - 161 of 161 capabilities carry a DECLARED `inputSchema`. Undeclared: 0.
 *     So on the served path `if (declared) return declared` always wins and NO
 *     regex ever names a consumer's arguments. The pin at
 *     test/runtime-derivation-truth.test.ts:242 measures the same reachability
 *     from the SERVED-registry side; this file measures it from the derivation's
 *     input side, which is the condition that must not rot.
 *   - The branch is NOT unreferenced code. Four call sites in three existing
 *     test files exercise and ASSERT its output: test/registry.test.ts:36
 *     (chat), :52 (toggle), :55 (read), test/registry-args-truth.test.ts:61
 *     (terminal-empty), :69 (chat). Deleting the branches breaks tests this
 *     change is not allowed to edit.
 *
 * WHY KEEP RATHER THAN DELETE — the load-bearing number:
 *   were the branch ever reached, it would hand a consumer a NON-EMPTY schema
 *   for 54 of the 161 capabilities (29 chat, 10 toggle, 15 read) and an empty
 *   one for 107. Deleting the four branches does not make that empty — it makes
 *   all 161 empty. An empty `{}` is precisely the defect this derivation was
 *   written to kill (`youtube_search` advertised `{}` while its runner requires
 *   `args.query`). So deletion converts "a guess that is wrong for 70 of 161"
 *   into "a guaranteed-wrong answer" for the 54. A guess at least has a chance;
 *   the empty schema has none.
 *
 *   The roles are complementary, not redundant: the branch is the last-resort
 *   BEHAVIOUR, and the pin is the ENFORCEMENT that keeps it unreachable. The
 *   pin's own failure message already prescribes the correct repair — "Declare
 *   inputSchema in the manifest (see GOAL 139)" — i.e. it is built to keep the
 *   branch unreachable, not to remove it.
 *
 *   And the "record of a mistake" role the branch's comment claims is ALREADY
 *   filled by a better artifact: test/registry-args-truth.test.ts:65-71 is a
 *   dedicated named test that the chat arg is `newChat` and that the old
 *   `new_chat` is advertised nowhere. That is where the mistake is preserved;
 *   the branch does not need to double as the memorial.
 *
 * Every case is a real top-level `test(...)` — never a bare `describe` body — so
 * a regression is counted in `# tests` instead of passing invisibly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { capabilityInputSchema, declaredCapabilityInputSchema } from "../src/prompt/registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAPABILITIES = join(ROOT, "capabilities");

type Entry = {
  id: string;
  method?: string;
  description?: string;
  name?: string;
  inputSchema?: unknown;
};

interface Row {
  site: string;
  cap: string;
  declared: ReturnType<typeof declaredCapabilityInputSchema>;
  served: ReturnType<typeof capabilityInputSchema>;
  guess: ReturnType<typeof capabilityInputSchema>;
}

/** The whole installed manifest surface, walked the way registry.ts walks it. */
function walkSurface(): Row[] {
  const rows: Row[] = [];
  const sites = readdirSync(CAPABILITIES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(CAPABILITIES, e.name, "manifest.json")))
    .map((e) => e.name)
    .sort();
  for (const site of sites) {
    const manifest = JSON.parse(
      readFileSync(join(CAPABILITIES, site, "manifest.json"), "utf8")
    ) as { capabilities?: Entry[] };
    for (const c of manifest.capabilities ?? []) {
      if (typeof c?.id !== "string") continue;
      const id = c.id;
      const method = typeof c.method === "string" ? c.method : undefined;
      const description = typeof c.description === "string" ? c.description : undefined;
      const declared = declaredCapabilityInputSchema(c);
      rows.push({
        site,
        cap: id,
        declared,
        served: capabilityInputSchema(site, id, method, description, declared),
        guess: capabilityInputSchema(site, id, method, description, null),
      });
    }
  }
  return rows;
}

test("every capability carries a DECLARED inputSchema — the condition that keeps the regex guess unreachable", () => {
  const rows = walkSurface();
  assert.ok(
    rows.length > 100,
    `expected the whole installed surface, saw ${rows.length} capabilities — if this is ~0 the walk is broken and every gate below is vacuous`,
  );
  const undeclared = rows.filter((r) => !r.declared).map((r) => `${r.site}/${r.cap}`);
  assert.deepEqual(
    undeclared,
    [],
    `these capabilities declare no inputSchema, so a REGEX would name a consumer's arguments for them: ` +
      `${undeclared.join(", ")}. Run \`node --import tsx scripts/derive-capability-args.ts --write\` — ` +
      `do not let a regex decide what a consumer must send.`,
  );
  assert.equal(rows.length, 161, `the measured surface moved: ${rows.length} capabilities (was 161 at this fold)`);
});

test("on the served path NO regex decides a consumer's args — served is byte-identical to declared", () => {
  const rows = walkSurface();
  const byRegex = rows.filter((r) => JSON.stringify(r.served) !== JSON.stringify(r.declared));
  assert.deepEqual(
    byRegex.map((r) => `${r.site}/${r.cap}`),
    [],
    "a served schema differs from its declared one, so a guess reached the wire",
  );
});

test("the four regex branches are still LIVE code, not dead — deleting them would be a behaviour change", () => {
  // This is the falsifiability half. It goes RED if the branches are deleted:
  // every guess would then be empty and `nonEmpty` would be 0, not 54. That is
  // the point — the "dead" label is only safe because the branch is a
  // deliberate last resort, and this asserts the last resort still exists rather
  // than letting it be quietly deleted as dead code.
  const rows = walkSurface();
  const nonEmpty = rows.filter((r) => Object.keys(r.guess.properties ?? {}).length > 0);
  const empty = rows.filter((r) => Object.keys(r.guess.properties ?? {}).length === 0);
  assert.equal(
    nonEmpty.length,
    54,
    `the guess path should still hand a non-empty schema to 54 capabilities (29 chat + 10 toggle + 15 read); ` +
      `got ${nonEmpty.length}. If this is 0 the four regex branches were DELETED — which is not a no-op, ` +
      `see the next test: it would make all ${rows.length} guesses empty.`,
  );
  assert.equal(empty.length, 107, `the remaining 107 should fall through to the empty terminal branch; got ${empty.length}`);
  // And the branches are individually covered by existing assertions, so a
  // deletion would break three other test files rather than pass unnoticed.
  const chatGuess = rows.find((r) => r.site === "gemini" && r.cap === "gemini_chat");
  assert.ok(chatGuess, "gemini_chat must be in the surface");
  assert.ok(
    "newChat" in (chatGuess.guess.properties ?? {}),
    "the chat branch must still advertise newChat (the name every runner reads)",
  );
  assert.ok(
    !("new_chat" in (chatGuess.guess.properties ?? {})),
    "new_chat is read by no runner and must not be advertised",
  );
});

test("the guess is DEMONSTRABLY WRONG for most of the surface — which is why it must stay unreachable", () => {
  // The number that decides the keep/delete question. 70 of 161 capabilities
  // would receive a DIFFERENT (wrong) contract if the branch were reached. So
  // the branch is a genuine last resort, and the enforcement that keeps it
  // unreachable is load-bearing rather than decorative.
  const rows = walkSurface();
  const wrong = rows.filter((r) => JSON.stringify(r.guess) !== JSON.stringify(r.served));
  assert.equal(
    wrong.length,
    70,
    `the guess path disagrees with the served contract for ${wrong.length}/${rows.length} capabilities (measured 70 at this fold). ` +
      `If this dropped, the guesser got BETTER and the branch is worth re-examining; if it rose, the guesser is drifting again.`,
  );
  // The youtube_search shape the whole derivation exists to prevent: the guesser
  // answers `{}` where the runner requires a query. This is what deletion would
  // generalise to all 161.
  const yt = rows.find((r) => r.cap === "youtube_search");
  assert.ok(yt, "youtube_search must be in the surface");
  assert.deepEqual(yt.guess, { type: "object", properties: {}, required: [] });
  assert.ok(
    "query" in ((yt.served.properties as Record<string, unknown>) ?? {}),
    "the served youtube_search schema must carry `query` — the runner reads args.query",
  );
});
