// GOAL 180 — the DURABLE gate for the "phantom gate" class.
//
// THE CLASS. A comment in `src/` names a `test/*.test.ts` file as the thing that
// asserts some property. The reader believes a check exists. Three such claims
// were found on 2026-10-02, all of them fabricated by decay rather than by
// malice — a gate existed, was deleted or renamed, and the citation outlived it:
//
//   src/runtime/session-store.ts        -> test/session-injection-fidelity.test.ts
//     (the CREDENTIAL path: a session snapshot reported as injected while the
//      browser runs signed out. Now written and mutation-proven.)
//   scripts/ci/forbidden-release-paths.txt
//                                       -> test/release-exclusion-single-source.test.ts
//     (the RELEASE path. The gate genuinely exists, under a different name —
//      test/credential-leak-gate.test.ts — so this is a stale POINTER, not a
//      missing check. Still dead documentation.)
//   scripts/audit/*.md                 -> gates named in dated evidence archives
//     (NOT a claim: see PROVENANCE_DIRS below.)
//
// A gate that can be named by a comment and never written WILL be named again —
// two of the three had already been re-found the same day. So this gate makes the
// CLAIM ITSELF checked: every `*.test.ts` cited from `src/` or `scripts/` must
// resolve to a real file, and a new citation that does not resolve is a red
// build rather than a silent rot.
//
// WHAT IS DELIBERATELY NOT A VIOLATION:
//   * Dated evidence archives under a directory named `audit/` are PROVENANCE —
//     they record what was true when the audit ran. History is not an
//     instruction, and rewriting history would destroy the evidence. They are
//     exempt, and the exemption is itself pinned: an exempt file must carry a
//     date, and `src/` can never be exempt.
//   * The one pre-existing phantom outside the exempt set is a NAMED baseline
//     entry below. It is reported, not silently swallowed, and the baseline may
//     not grow — that is what stops the class from regrowing.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** Directories scanned for citations. `src/` is the claim surface. */
const SCAN_ROOTS = ["src", "scripts"];

/** Path segments whose files are provenance archives, not instructions. */
const PROVENANCE_DIRS = new Set(["audit"]);

/**
 * Phantom citations that are known, named, and NOT this lane's to fix. Each is a
 * claim in a file owned elsewhere; each carries the reason it is tolerated so a
 * reader is never left thinking the check exists when it does not.
 *
 * ADDING A LINE HERE IS THE ONLY WAY TO SILENCE A NEW PHANTOM, which is exactly
 * why the growth rule below is a hard failure: tolerating one must be a visible,
// reviewed act rather than the path of least resistance.
 */
const KNOWN_PHANTOM_CLAIMS: Array<{ file: string; cites: string; why: string }> = [
  {
    file: "scripts/ci/forbidden-release-paths.txt",
    cites: "release-exclusion-single-source.test.ts",
    why:
      "Stale POINTER, not a missing gate: the release-exclusion single-source check DOES exist, as the 'THE RELEASE EXCLUSION LIST HAS ONE OWNER' test in test/credential-leak-gate.test.ts. The header cites a filename that never existed, so the claim cannot be followed. Owned by the release/CI surface — reported here, not fixed.",
  },
];

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", ".brain", "data", "graphify-out"]);

/** A citation of a `*.test.ts` file: `test/foo.test.ts` or a bare `foo.test.ts`. */
export const CITATION_RE = /([A-Za-z0-9._\-\/]*[A-Za-z0-9._\-]\.test\.ts)/g;

export function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/** Does this repo-relative path sit inside a provenance directory? */
export function isProvenance(relPath: string): boolean {
  return relPath.split("/").slice(0, -1).some((seg) => PROVENANCE_DIRS.has(seg));
}

export interface SourceEntry {
  /** repo-relative path, e.g. "src/runtime/session-store.ts" */
  file: string;
  src: string;
}

/**
 * Does `name` resolve to a real test file? A citation is accepted if it resolves
 * relative to the repo root as written, or as `test/<basename>` — a bare
 * `foo.test.ts` in prose is a citation of `test/foo.test.ts`, and rejecting that
 * form would make this gate cry wolf on ordinary writing.
 */
export function citationResolves(citation: string, root: string = ROOT): boolean {
  const cleaned = citation.replace(/[.,;:)'"`]+$/, "");
  const candidates = [
    join(root, cleaned),
    join(root, "test", cleaned.split("/").pop() as string),
  ];
  return candidates.some((p) => existsSync(p) && statSync(p).isFile());
}

export interface Phantom {
  file: string;
  line: number;
  cites: string;
  text: string;
}

/** Citations in one source that do not resolve — WITHOUT the provenance
 *  exemption applied. `findPhantomCitations` must stay the only place that
 *  decides what is exempt; asking it "is this provenance file itself in
 *  violation?" can only ever answer no, which is how a pin written to fire
 *  becomes a pin that never does. */
export function unresolvedInSource(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(CITATION_RE)) {
    const cites = m[1].replace(/[.,;:)'"`]+$/, "");
    if (!citationResolves(cites)) out.push(cites);
  }
  return out;
}

/** Every citation in `src/`+`scripts/` that does not resolve to a real file. */
export function findPhantomCitations(entries: SourceEntry[]): Phantom[] {
  const out: Phantom[] = [];
  for (const { file, src } of entries) {
    if (isProvenance(file)) continue;
    src.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(CITATION_RE)) {
        const cites = m[1].replace(/[.,;:)'"`]+$/, "");
        if (citationResolves(cites)) continue;
        out.push({ file, line: i + 1, cites, text: line.trim() });
      }
    });
  }
  return out;
}

function realEntries(): SourceEntry[] {
  const files = SCAN_ROOTS.flatMap((r) => walkFiles(join(ROOT, r)));
  return files.map((abs) => ({
    file: abs.slice(ROOT.length + 1).split("\\").join("/"),
    src: readFileSync(abs, "utf8"),
  }));
}

const phantoms = findPhantomCitations(realEntries());
// Matched by BASENAME, because prose spells the same file as both
// `test/foo.test.ts` and a bare `foo.test.ts`; a baseline keyed on the exact
// spelling would silently stop matching and read as "the debt was paid".
const tolerated = new Set(KNOWN_PHANTOM_CLAIMS.map((k) => `${k.file}|${k.cites.split("/").pop()}`));

// --- the gate ---------------------------------------------------------------

test("no file in src/ or scripts/ cites a test/*.test.ts file that does not exist", () => {
  const unexplained = phantoms.filter((p) => !tolerated.has(`${p.file}|${p.cites.split("/").pop()}`));
  assert.deepEqual(
    unexplained.map((p) => `${p.file}:${p.line} -> ${p.cites}`),
    [],
    "a comment in src/ or scripts/ names a gate that does not exist. Write the gate, " +
      "correct the citation, or — if the check exists under another name — fix the pointer. " +
      "Do NOT silence it by adding it to KNOWN_PHANTOM_CLAIMS: that list is how the class regrows."
  );
});

test("the scan actually reads src/ and scripts/ (it is not vacuously empty)", () => {
  const entries = realEntries();
  const srcFiles = entries.filter((e) => e.file.startsWith("src/"));
  const scriptFiles = entries.filter((e) => e.file.startsWith("scripts/"));
  assert.ok(srcFiles.length > 10, `src/ must be scanned, saw ${srcFiles.length} files`);
  assert.ok(scriptFiles.length > 3, `scripts/ must be scanned, saw ${scriptFiles.length} files`);
  // A citation that DOES resolve must be recognised as resolved, or the gate
  // would pass on a scanner that treats every citation as missing.
  const resolved = entries.flatMap((e) =>
    [...e.src.matchAll(CITATION_RE)].map((m) => m[1].replace(/[.,;:)'"`]+$/, ""))
  );
  assert.ok(resolved.length > 0, "the corpus must contain test-file citations to scan");
  assert.ok(
    resolved.some((c) => citationResolves(c)),
    `at least one citation must resolve, else the resolver is broken: ${JSON.stringify(resolved.slice(0, 8))}`
  );
});

// --- the exemptions, pinned so they cannot be widened into a loophole --------

test("the provenance exemption covers dated audit archives only, and never src/", () => {
  const exempt = realEntries().filter((e) => isProvenance(e.file));
  assert.ok(exempt.length > 0, "the audit archives must still be exempt, else this gate has no teeth on history");
  for (const e of exempt) {
    assert.ok(
      !e.file.startsWith("src/"),
      `src/ is the claim surface and can NEVER be provenance-exempt: ${e.file}`
    );
    // A provenance DOCUMENT asserts claims in prose, so a document that makes an
    // UNRESOLVABLE claim must be dated — an undated one is a live claim wearing
    // an archive's directory. Two consequences worth stating: a document that
    // resolves every gate it names needs no date to earn its exemption (there is
    // nothing to exempt), and provenance DATA (a .json census, say) asserts
    // nothing at all, so it is exempt by directory alone.
    const isDocument = /\.(md|txt)$/i.test(e.file);
    const unresolvedHere = unresolvedInSource(e.src);
    if (!isDocument || unresolvedHere.length === 0) continue;
    const dated = /\b20\d\d-\d\d-\d\d\b/.test(e.file) || /\b20\d\d-\d\d-\d\d\b/.test(e.src);
    assert.ok(
      dated,
      `${e.file} cites a gate that does not exist (${unresolvedHere.join(", ")}) but carries no date. An undated document is not provenance; it is a live claim.`
    );
  }
});

test("the tolerated-phantom baseline has not grown, and its entries are real", () => {
  const entries = realEntries();
  const exempt = new Set(entries.filter((e) => isProvenance(e.file)).map((e) => e.file));
  for (const known of KNOWN_PHANTOM_CLAIMS) {
    assert.ok(!exempt.has(known.file), `${known.file} is provenance-exempt; drop it from the baseline`);
    assert.ok(known.why.length > 40, `every tolerated phantom must carry a reason: ${known.cites}`);
    const found = phantoms.find(
      (p) => p.file === known.file && p.cites.split("/").pop() === known.cites
    );
    assert.ok(
      found,
      `${known.file} no longer cites a non-existent ${known.cites} — the debt was PAID. Delete this baseline entry; ` +
        `a stale entry hides the next real phantom behind an old name.`
    );
  }
});

// --- SELFTEST: the scanner catches a phantom it is shown -------------------

test("SELFTEST: a fabricated src/ citation of a missing gate IS reported, and a fabricated audit-archive one is NOT", () => {
  const fake: SourceEntry[] = [
    {
      file: "src/runtime/example.ts",
      src: [
        "// the absence of the key proves it ran, which is what",
        "// `test/this-gate-does-not-exist.test.ts` asserts.",
      ].join("\n"),
    },
    {
      file: "scripts/ci/example.sh",
      src: "# see test/also-not-real.test.ts for the check\n",
    },
    {
      file: "scripts/audit/2026-01-01-audit.md",
      src: "Date: 2026-01-01 · gate: test/an-audit-era-gate.test.ts (14 tests, 9 pass)\n",
    },
    {
      file: "src/runtime/fine.ts",
      src: "// gate: test/session-injection-fidelity.test.ts\n",
    },
  ];
  const found = findPhantomCitations(fake);
  const named = found.map((p) => `${p.file}|${p.cites}`);
  assert.deepEqual(
    named,
    [
      "src/runtime/example.ts|test/this-gate-does-not-exist.test.ts",
      "scripts/ci/example.sh|test/also-not-real.test.ts",
    ],
    "the scanner must report missing gates in src/ and scripts/, and must NOT report a dated audit archive"
  );
  assert.equal(
    found[0].line,
    2,
    "the report must carry the line number, or a reader cannot go and look"
  );
});

test("SELFTEST: a prose pointer to a test file that does not exist is caught however it is spelled", () => {
  const spellings = [
    "see test/never-written.test.ts for the check",
    "see test/never-written.test.ts:12 for the check",
    "the gate in `test/never-written.test.ts` asserts this",
    "asserted by test/never-written.test.ts, allegedly",
    "see test/never-written.test.ts",
  ];
  for (const s of spellings) {
    const found = findPhantomCitations([{ file: "src/x.ts", src: s }]);
    assert.equal(
      found.length,
      1,
      `must catch: ${JSON.stringify(s)} (found ${found.length}: ${JSON.stringify(found)})`
    );
  }
});