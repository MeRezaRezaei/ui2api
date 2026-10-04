// GOAL 233 — the `docs/AUDIT.md` "re-derive the shape numbers" transcript block
// was UNGATED prose, and it drifted by an order of magnitude while every other
// gate in this repo stayed green.
//
// ============================ WHAT WAS MEASURED ===========================
//
//   docs/AUDIT.md:91 asserted, inside the quoted transcript:
//
//     # registry packages: 33 | carrying chat.model: 22
//
//   Re-running that same block verbatim against today's code:
//
//     registry packages: 33 | carrying chat.model: 2   (ids: duckduckgo, gemini)
//
//   while the block's OTHER two lines still reproduced exactly:
//
//     chat surface: 22 = builtin 10 + packaged 12
//     BUILTIN_PROFILES: 11 | not surfaced: google-ai-search
//
// WHY: the block predates GOAL 159, which added the record-class gate
// (`chatWithheld`, src/prompt/registry.ts:132). A surfaced chat id whose
// measured record class is not `ANSWERS` now carries NO `chat` key at all, so 20
// of the 22 surfaced ids are unstamped. A number nobody re-derives is a number
// nobody notices; the other two lines surviving is the tell — the block was
// half-right, which reads as "still correct" to a skimming reader.
//
// ============================ WHAT THIS FILE DOES =========================
//
// It parses the numbers OUT of the doc's own transcript block and asserts them
// against the live code (`defaultChatProfiles`, `BUILTIN_PROFILES`,
// `buildRegistryPackages`). The doc is not trusted and not duplicated: there is
// no second copy of "2" in this file, only the extraction and the comparison, so
// editing the doc to a wrong number fails here rather than rotting.
//
// It also gates the sibling claims from the same defect class that had no gate:
//   - `capabilities/README.md` may not list a builtin that is NOT on the chat
//     surface among the builtin CHAT profiles (it listed google-ai-search, 11).
//   - `README.md` / `docs/VISION.md` may not describe `chat.model` as stamped on
//     the servable chat set WITHOUT naming the narrower measured gate and the
//     live stamped count — the "upper bound so not false" reading that in
//     practice communicated 22.
//
// OFFLINE BY CONSTRUCTION: every input is a repo file or a pure in-process
// derivation. `buildRegistryPackages()` reads `capabilities/**` from disk and
// makes no network call, so this file adds no reach-out and no machine
// dependency (test/host-independence-gate.test.ts GOAL149(b) scans the corpus
// from disk, so this file is inside it without needing an allow-list entry).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_PROFILES } from "../src/profile/profile.js";
import {
  buildRegistryPackages,
  defaultChatProfiles,
  type RegistryPackage,
} from "../src/prompt/registry.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

// ------------------------------------------------------------- derivation ---

export interface ShapeNumbers {
  chatSurface: number;
  builtinSurfaced: number;
  packagedSurfaced: number;
  builtinProfiles: number;
  notSurfaced: string[];
  packages: number;
  stampedChatModel: number;
  stampedIds: string[];
}

/** Every number the AUDIT transcript block prints, derived from the code. */
export function realShapeNumbers(): ShapeNumbers {
  const chat = defaultChatProfiles().map((p) => p.id);
  const keys = Object.keys(BUILTIN_PROFILES);
  const pkgs = buildRegistryPackages() as (RegistryPackage & { chatWithheld?: unknown })[];
  const stamped = pkgs.filter((p) => p.chat?.model);
  return {
    chatSurface: chat.length,
    builtinSurfaced: chat.filter((i) => keys.includes(i)).length,
    packagedSurfaced: chat.filter((i) => !keys.includes(i)).length,
    builtinProfiles: keys.length,
    notSurfaced: keys.filter((k) => !chat.includes(k)).sort(),
    packages: pkgs.length,
    stampedChatModel: stamped.length,
    stampedIds: stamped.map((p) => p.id).sort(),
  };
}

// ------------------------------------------------- the AUDIT.md transcript ---

/**
 * The AUDIT.md fenced block that carries the re-derive command. Found BY CONTENT
 * (it imports `buildRegistryPackages`), not by line number — a line pin is the
 * same rot in a different shape.
 */
export function auditTranscriptBlock(doc: string): string {
  const blocks = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const found = blocks.find((b) => b.includes("buildRegistryPackages"));
  assert.ok(found, "docs/AUDIT.md no longer prints the re-derive command — the shape numbers lost their derivation");
  return found;
}

test("GOAL233: the AUDIT.md re-derive block still PRINTS the command that produced its numbers", () => {
  const block = auditTranscriptBlock(read("docs/AUDIT.md"));
  for (const call of ["defaultChatProfiles", "buildRegistryPackages", "BUILTIN_PROFILES"]) {
    assert.ok(block.includes(call), `the transcript block must still dispatch ${call} — a comment with no command above it is a number nobody re-derives`);
  }
  assert.ok(
    /chat\.model/.test(block),
    "the transcript block must still print the `carrying chat.model:` line — that is the line that drifted",
  );
});

test("GOAL233: the AUDIT.md transcript numbers EQUAL the live code (the ungated block is now gated)", () => {
  const block = auditTranscriptBlock(read("docs/AUDIT.md"));
  const real = realShapeNumbers();

  const surface = /^#\s*chat surface:\s*(\d+)\s*=\s*builtin\s*(\d+)\s*\+\s*packaged\s*(\d+)\s*$/m.exec(block);
  assert.ok(surface, "transcript block no longer has a `# chat surface: N = builtin N + packaged N` line");
  assert.deepEqual(
    [Number(surface[1]), Number(surface[2]), Number(surface[3])],
    [real.chatSurface, real.builtinSurfaced, real.packagedSurfaced],
    `docs/AUDIT.md transcript disagrees with the code: doc says chat surface ${surface[1]} = builtin ${surface[2]} + packaged ${surface[3]}, code says ${real.chatSurface} = builtin ${real.builtinSurfaced} + packaged ${real.packagedSurfaced} (${real.chatSurface} = builtin ${real.builtinSurfaced} + packaged ${real.packagedSurfaced})`,
  );

  const builtins = /^#\s*BUILTIN_PROFILES:\s*(\d+)\s*\|\s*not surfaced:\s*(.*)$/m.exec(block);
  assert.ok(builtins, "transcript block no longer has a `# BUILTIN_PROFILES: N | not surfaced: ...` line");
  assert.equal(Number(builtins[1]), real.builtinProfiles, `docs/AUDIT.md transcript says BUILTIN_PROFILES ${builtins[1]}, code has ${real.builtinProfiles}`);
  assert.deepEqual(
    builtins[2].trim().split(/\s+/).filter(Boolean).sort(),
    real.notSurfaced,
    `docs/AUDIT.md transcript lists not-surfaced builtins ${JSON.stringify(builtins[2].trim())}, code says ${JSON.stringify(real.notSurfaced.join(" "))}`,
  );

  const stamped = /^#\s*registry packages:\s*(\d+)\s*\|\s*carrying chat\.model:\s*(\d+)\s*$/m.exec(block);
  assert.ok(stamped, "transcript block no longer has a `# registry packages: N | carrying chat.model: N` line");
  assert.equal(Number(stamped[1]), real.packages, `docs/AUDIT.md transcript says ${stamped[1]} registry packages, code builds ${real.packages}`);
  // THE line that drifted: 22 -> 2 when GOAL 159's record-class gate landed.
  assert.equal(
    Number(stamped[2]),
    real.stampedChatModel,
    `docs/AUDIT.md transcript says ${stamped[2]} package(s) carry chat.model, buildRegistryPackages() stamps ${real.stampedChatModel} (${real.stampedIds.join(", ") || "none"}) — the GOAL 159 record-class gate withholds the key from every surfaced id whose measured record class is not ANSWERS`,
  );
});

test("GOAL233: a bare corrected number is not enough — AUDIT.md must say WHY only some carry chat.model", () => {
  const doc = read("docs/AUDIT.md");
  const real = realShapeNumbers();
  // The paragraph is located by the code symbol it must explain, so the reason
  // cannot be deleted while leaving the corrected number in place.
  assert.ok(
    /chatWithheld/.test(doc),
    "docs/AUDIT.md must name `chatWithheld` — a corrected count with no stated reason is what drifted the first time",
  );
  assert.ok(
    /GOAL 159/.test(doc),
    "docs/AUDIT.md must attribute the withheld-key gate to GOAL 159 so a reader can find the rule",
  );
  assert.ok(
    new RegExp(`\\b${real.stampedChatModel}\\b`).test(doc),
    `docs/AUDIT.md must state the live stamped count (${real.stampedChatModel}) when explaining the gate`,
  );
  // And the gate must still be narrowing: a "servable set == stamped set" world
  // would make this whole file vacuous, so assert the two genuinely differ.
  assert.ok(
    real.stampedChatModel < real.chatSurface,
    `${real.stampedChatModel} of ${real.chatSurface} surfaced ids carry chat.model — if they are now equal the record-class gate stopped withholding and these docs must be rewritten, not this gate relaxed`,
  );
});

// ------------------------------------------- the sibling ungated doc claims ---

test("GOAL233: capabilities/README.md lists only builtins that ARE on the chat surface", () => {
  const doc = read("capabilities/README.md");
  const m = /The (\d+) builtin chat profiles on the chat surface \(([^)]*)\)/.exec(doc);
  assert.ok(m, "capabilities/README.md no longer prints its builtin-chat-profile inventory line");
  const listed = m[2].split(",").map((s) => s.trim()).filter(Boolean);
  const chat = defaultChatProfiles().map((p) => p.id);
  const offSurface = listed.filter((id) => !chat.includes(id));
  assert.deepEqual(
    offSurface,
    [],
    `capabilities/README.md lists ${offSurface.join(", ")} as builtin CHAT profiles but defaultChatProfiles() does not surface ${offSurface.join(", ")} — a builtin PROFILE is not automatically a chat model`,
  );
  assert.equal(Number(m[1]), listed.length, "the stated count must be the count of the ids actually listed beside it");
  assert.equal(
    Number(m[1]),
    realShapeNumbers().builtinSurfaced,
    `capabilities/README.md says ${m[1]} builtin chat profiles; code surfaces ${realShapeNumbers().builtinSurfaced} builtins`,
  );
});

test("GOAL233: README.md and docs/VISION.md cannot describe chat.model as stamped on the whole servable set", () => {
  const real = realShapeNumbers();
  const stamped = new RegExp(`\\b${real.stampedChatModel}\\b`);
  for (const rel of ["README.md", "docs/VISION.md"]) {
    const doc = read(rel);
    const paras = doc.split(/\n\s*\n/).filter((p) => p.includes("chat.model"));
    assert.ok(paras.length > 0, `${rel} must keep describing the chat.model stamp — its absence would silently drop the contract`);
    for (const para of paras) {
      assert.ok(
        para.includes("chatWithheld") || /record class/.test(para),
        `${rel} describes \`chat.model\` without naming the GOAL 159 record-class gate — the servable chat set (${real.chatSurface}) is an UPPER BOUND on the stamped set, and reading it as the stamped count is exactly the drift this closes`,
      );
      assert.ok(
        stamped.test(para),
        `${rel} discusses the chat.model stamp without stating the live stamped count (${real.stampedChatModel} of ${real.chatSurface} surfaced ids, ${real.stampedIds.join(", ") || "none"})`,
      );
    }
  }
});
