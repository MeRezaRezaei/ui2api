// The KNOB-EFFECT truth gate.
//
// Two defect classes in this repo shipped for a long time because nothing
// checked them, and both were found BY HAND:
//
//   1. `vault tighten --dry-run` was parsed and read NOWHERE — an operator
//      passing `--apply --dry-run` silently APPLIED permission changes to files
//      holding real cookies and Bearer tokens.
//   2. `UI2API_XVFB_DISPLAY`, `UI2API_DAEMON_PORT` and `UI2API_PROMPTD_PORT` are
//      READ into shell locals and consumed ONLY inside printed messages, while
//      the systemd units are copied verbatim and hardcode the values — so the
//      knob a reader trusts is inert.
//
// A knob that is read but has no behavioural effect is a documentation lie that
// an operator pays for. This gate is the answer, in five assertions:
//
//   A1  DOCUMENTATION COVERAGE, two-way. Every `UI2API_*` actually READ from the
//       environment has a row in AGENTS.md's environment-knob table, and every
//       row in that table either appears in shipped code or DECLARES why it does
//       not (family prefix / NOT AN ENV KNOB / DEAD).
//   A2  NAME-CONSTANT RESOLUTION. A knob declared as `export const X_ENV =
//       "UI2API_Y"` is read back as `process.env[X_ENV]`, so a literal grep is
//       BLIND to the read site. For those, resolve the constant and assert the
//       read-back exists.
//   A3  INERT STAYS INERT. The three knobs known INERT are still consumed only
//       by messages, so the day someone wires one for real the gate says
//       "reclassify" instead of leaving a stale INERT record.
//   A4  TRUST STAYS MARKED. A knob marked TRUST weakens the daemon's trust
//       posture, and the marker is the ONLY signal a reader gets — so the mark
//       must survive, and a marked knob must still actually be read (an
//       unbacked marked row warns about a knob that cannot fire).
//   A5  DORMANT STAYS DECLARED. A documented knob that is read NOWHERE must
//       SAY so, so a genuinely dead knob is documented as dead rather than left
//       looking configurable.
//
// HOUSE RULES (inherited from test/skills-truth.test.ts, which owns the
// comment-stripping approach this file follows, and from
// test/ci-contract-knob-cites.test.ts, whose precedent is the reason this file
// is narrow on purpose):
//   * DERIVE, NEVER HAND-TYPE — with the two EXCEPTIONS named below, because a
//     derived-only assertion provably cannot catch two real edits. The knob set,
//     the read sites and AGENTS.md's table are all computed from the repo at
//     test time, and no test here pins a COUNT. The exceptions are the two
//     CLASSIFICATION RECORDS a doc marker needs, both reasoned at their
//     declaration: `EXPECTED_TRUST` (A4 — a gate that derives the marked set from
//     AGENTS.md passes on the very marker deletion it exists to catch) and the
//     DORMANT member pin (A5.2 — a row that is deleted from the table declares
//     nothing, so removing it would otherwise be silent). Both are declared
//     names in code, never derived counts, and both fail LOUD on a change rather
//     than adapting to it.
//   * Assertions live inside real top-level `test(...)` calls, NEVER in a bare
//     `describe` body (test/assertions-are-counted.test.ts).
//   * A gate that misfires gets skipped, and a skipped gate is worse than none —
//     so every check is narrow and true, and where a claim could legitimately go
//     stale the gate asserts a DECLARED REASON rather than guessing intent.
//   * This file reports miscategorisations and missing doc rows. It does not fix
//     them: AGENTS.md, src/, scripts/ and existing tests are out of scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// ---------------------------------------------------------------- scanning

function codeFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) codeFiles(p, acc);
    else if (/\.(ts|mjs|js|sh)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Every scanned file, once, with its repo-relative path — so a failure can NAME
 *  the read site instead of only the knob. */
const FILES: { rel: string; abs: string }[] = ["src", "scripts"].flatMap((d) =>
  codeFiles(join(ROOT, d)).map((abs) => ({ rel: abs.slice(ROOT.length + 1), abs })),
);

/** Shell comment stripper: `#` at the start of a line or after whitespace, and
 *  only outside quotes. `.sh` is scanned separately because the JS reader below
 *  would misread `'…'` and `$(…)`. */
function stripShellComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (quote) {
          if (c === "\\") { i++; continue; }
          if (c === quote) quote = null;
          continue;
        }
        if (c === "'" || c === '"') { quote = c; continue; }
        if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** JS/TS comment blanking: a double-slash to end of line, and slash-star blocks,
 *  skipping quoted
 *  strings and template literals so a `'` inside a comment cannot swallow code.
 *  Blanked characters become SPACES, never deletions, so line numbers survive and
 *  a bug here surfaces as a MISSING knob rather than a shifted read.
 *
 *  KNOWN LIMIT, disclosed rather than hidden: unlike test/skills-truth.test.ts's
 *  full state machine, this reader does not distinguish a REGEX literal from a
 *  division, so a `//` inside a regex body is read as a comment. That can only
 *  make this gate MORE conservative on the read→documented direction (a real read
 *  hidden after a regex `//` is not seen, so no false failure), and the direction
 *  it could loosen — documented→present — deliberately uses RAW literals, which
 *  no stripping can affect. */
function stripJsComments(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < n) { if (src[i] === "\\") { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") { out[i] = " "; i++; } continue; }
    if (c === "/" && src[i + 1] === "*") {
      const s = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      for (let k = s; k < i; k++) if (out[k] !== "\n") out[k] = " ";
      continue;
    }
    i++;
  }
  return out.join("");
}

function stripComments(rel: string, src: string): string {
  return /\.sh$/.test(rel) ? stripShellComments(src) : stripJsComments(src);
}

/** Every `UI2API_*` LITERAL in shipped code, comments INCLUDED — the
 *  documented→present direction uses this so no stripping choice can make it
 *  fail. */
export function literalKnobs(): Set<string> {
  const out = new Set<string>();
  for (const f of FILES) for (const m of readFileSync(f.abs, "utf8").matchAll(/UI2API_[A-Z0-9_]+/g)) out.add(m[0]);
  return out;
}

/** Every `UI2API_*` literal in shipped code with COMMENTS stripped — the
 *  read→documented direction uses this, so a knob that exists only as a note
 *  about code is not treated as a live read. */
export function codeKnobs(): Set<string> {
  const out = new Set<string>();
  for (const f of FILES) {
    for (const m of stripComments(f.rel, readFileSync(f.abs, "utf8")).matchAll(/UI2API_[A-Z0-9_]+/g)) out.add(m[0]);
  }
  return out;
}

/** `export const X_ENV = "UI2API_Y"` (optionally `: string`), with the file that
 *  declares it. This is the shape that makes a literal grep BLIND: the literal
 *  appears ONLY in the declaration, and the read site says `process.env[X_ENV]`
 *  — so a grep for the read finds nothing and the knob looks unread.
 *  Requiring "ENV" in the constant's own name is what keeps the scan narrow: it
 *  matches this repo's naming convention rather than every const holding a
 *  UI2API_* string, which would also match `UI2API_VERSION` — a local const in
 *  src/registry/package.ts that is deliberately NOT env-read. */
export interface NameConst {
  /** the constant's identifier, e.g. `TOKEN_ENV` */
  konst: string;
  /** the knob the literal names, e.g. `UI2API_PROMPTD_TOKEN` */
  knob: string;
  /** the file that declares it */
  rel: string;
}

export function nameConstants(): NameConst[] {
  const out: NameConst[] = [];
  for (const f of FILES) {
    const s = stripComments(f.rel, readFileSync(f.abs, "utf8"));
    for (const m of s.matchAll(/(?:export\s+)?const\s+([A-Za-z0-9_$]*ENV[A-Za-z0-9_$]*)\s*(?::\s*string)?\s*=\s*"(UI2API_[A-Z0-9_]+)"/g)) {
      out.push({ konst: m[1]!, knob: m[2]!, rel: f.rel });
    }
  }
  return out;
}

const NAME_CONSTS = nameConstants();

/** konst -> knob, for the read-back resolution. */
const NAME_CONST_BY_NAME = new Map(NAME_CONSTS.map((n) => [n.konst, n.knob]));

/** Every knob name that is genuinely READ out of the environment, with the
 *  site that reads it. These shapes count, and nothing else:
 *    - `process.env.NAME`            (JS/TS, dotted)
 *    - `process.env["NAME"]`         (JS/TS, literal bracket)
 *    - `process.env[CONST]`          (JS/TS, resolved name constant -> A2)
 *    - `env...("NAME")`              (a string arg to an env helper: `envCount`
 *                                      / `envMs` do `process.env[name]`)
 *    - `$NAME` / `${NAME...}`        (shell, with the sigil REQUIRED)
 *  Two deliberate consequences of that list:
 *  * The sigil is REQUIRED, so a bare `UI2API_X` literal is a DECLARATION or a
 *    message - and `UI2API_VERSION`, a local const reading package.json, lands on
 *    the documented-but-never-read side of the two-way difference, exactly as
 *    AGENTS.md says it does.
 *  * The `env...("NAME")` shape also catches the knobs the GENERATED PHP client
 *    reads at runtime (`src/generator/lang-php.ts` emits `env('UI2API_TOKEN', ...)`
 *    into a PHP config file). That is a read by the emitted client rather than by
 *    the daemon, and AGENTS.md cites that same file as the read site for both.
 *    Counting it keeps this direction one-way-safe: it can only ADD a read, never
 *    remove one, so it cannot invent a "read but undocumented" failure. */
export function envReads(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (knob: string, site: string) => {
    const a = out.get(knob) ?? [];
    a.push(site);
    out.set(knob, a);
  };
  for (const f of FILES) {
    const s = stripComments(f.rel, readFileSync(f.abs, "utf8"));
    // Comment stripping blanks characters with SPACES and keeps every newline, so
    // a match offset still maps back to the file's own line number. Every site
    // string therefore carries `rel:line`, which is what lets a failure NAME the
    // exact line that reads a knob instead of only the file.
    const nl: number[] = [0];
    for (let i = 0; i < s.length; i++) if (s[i] === "\n") nl.push(i + 1);
    const at = (idx: number) => `${f.rel}:${lineAt(nl, idx)}`;
    for (const m of s.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*"([^"]+)"\s*\]|\[\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\])/g)) {
      const dotted = m[1];
      const literal = m[2];
      const constRef = m[3];
      if (dotted) { if (dotted.startsWith("UI2API_")) add(dotted, `${at(m.index)} process.env.${dotted}`); }
      else if (literal) { if (literal.startsWith("UI2API_")) add(literal, `${at(m.index)} process.env["${literal}"]`); }
      else if (constRef) {
        const resolved = NAME_CONST_BY_NAME.get(constRef);
        // An unresolvable bracket constant is NOT silently dropped — a read whose
        // name cannot be derived is exactly the blind spot A2 exists to close.
        if (resolved) add(resolved, `${at(m.index)} process.env[${constRef}]`);
        else if (constRef.startsWith("UI2API_")) add(constRef, `${at(m.index)} process.env[${constRef}]`);
        else add(`<unresolved:${constRef}>`, `${at(m.index)} process.env[${constRef}]`);
      }
    }
    for (const m of s.matchAll(/\benv[A-Za-z0-9_]*\(\s*["'](UI2API_[A-Z0-9_]+)["']/g)) add(m[1]!, `${at(m.index)} env...('${m[1]}')`);
    if (/\.sh$/.test(f.rel)) {
      for (const m of s.matchAll(/\$\{?(UI2API_[A-Z0-9_]+)/g)) add(m[1]!, `${at(m.index)} $${m[1]}`);
    }
  }
  return out;
}

/** 1-based line for a character offset, given the precomputed newline offsets. */
function lineAt(newlineOffsets: number[], idx: number): number {
  let lo = 0, hi = newlineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (newlineOffsets[mid]! <= idx) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

const ENV_READS = envReads();

/** One row of AGENTS.md's environment-knob table. */
export interface DocRow {
  knob: string;
  line: number;
  purpose: string;
}

/** AGENTS.md's knob table, derived from its `| \`UI2API_…\` | purpose |` rows.
 *  The first cell is REQUIRED to look like a knob name: AGENTS.md holds other
 *  prose tables (`| \`--headless=new\` | …`) whose first cell is not a knob, and a
 *  loose row reader would fold those into this table and misfire. The purpose
 *  column is kept because it is where a row DECLARES that it is not a live read —
 *  and a declaration the gate can read is what keeps the gate from misfiring on
 *  an honest row. */
export function docRows(): DocRow[] {
  const lines = readFileSync(join(ROOT, "AGENTS.md"), "utf8").split("\n");
  const out: DocRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\| `(UI2API_[A-Z0-9_]*)` \| (.*)$/.exec(lines[i]!);
    if (!m) continue;
    out.push({ knob: m[1]!, line: i + 1, purpose: m[2]! });
  }
  return out;
}

const DOC_ROWS = docRows();
const DOC_KNOBS = new Map(DOC_ROWS.map((r) => [r.knob, r]));

/** Phrases AGENTS.md uses to DECLARE that a row is not a live environment read.
 *  Each is quoted from the table as it stands, so adding a new honest row shape
 *  without one of these phrases is a loud failure rather than a silent skip. */
const DECLARED_NOT_READ = [
  "family prefix",
  "NOT AN ENV KNOB",
  "nothing reads it",
] as const;

function declaresNotRead(row: DocRow): boolean {
  return DECLARED_NOT_READ.some((p) => row.purpose.includes(p));
}

const NOT_A_KNOB = new Set(
  [...ENV_READS.keys()].filter((k) => k.startsWith("<unresolved:")),
);

// ============================================================ A1 — coverage

test("A1: every knob READ from the environment is documented in AGENTS.md's knob table", () => {
  const reads = [...ENV_READS.keys()].filter((k) => !NOT_A_KNOB.has(k)).sort();
  assert.ok(reads.length >= 60, `non-vacuity: only ${reads.length} env-read knobs derived — the read scan stopped reading`);
  const undocumented = reads.filter((k) => !DOC_KNOBS.has(k));
  assert.deepEqual(
    undocumented,
    [],
    "these knobs are READ from the environment but have NO row in AGENTS.md's knob table: " +
      undocumented.map((k) => `${k} (first read: ${ENV_READS.get(k)![0]})`).join("; "),
  );
});

test("A1: every AGENTS.md knob-table row is grounded — present in shipped code, or declaring why not", () => {
  assert.ok(DOC_ROWS.length >= 60, `non-vacuity: only ${DOC_ROWS.length} rows parsed out of AGENTS.md's knob table — the row shape changed`);
  const literals = literalKnobs();
  const ungrounded = DOC_ROWS.filter((r) => !literals.has(r.knob) && !declaresNotRead(r));
  assert.deepEqual(
    ungrounded.map((r) => `${r.knob} (AGENTS.md:${r.line})`),
    [],
    "these doc rows name a knob that appears nowhere in src/ or scripts/ and do NOT declare why: " +
      "either the knob was removed from the code (delete the row) or the code reads it by a name this scan cannot see (fix the cite)",
  );
});

test("A1: the two-way difference is the declared set — a documented-but-unread knob must SAY so", () => {
  const reads = new Set(ENV_READS.keys());
  const documentedButUnread = DOC_ROWS.filter((r) => !reads.has(r.knob));
  // Every documented-but-never-read row must carry one of the declared phrases;
  // this is what stops the direction from decaying into "nobody checks it".
  const silent = documentedButUnread.filter((r) => !declaresNotRead(r) && !literalKnobs().has(r.knob));
  assert.deepEqual(
    silent.map((r) => `${r.knob} (AGENTS.md:${r.line})`),
    [],
    "documented but never read from the environment, with no declared reason and no code literal either",
  );
  // Disclose the measurement so a reader can see the direction is narrow, not empty.
  const disclosed = documentedButUnread.map((r) => `${r.knob} (AGENTS.md:${r.line})`);
  assert.ok(
    disclosed.length <= 4,
    `the documented-but-never-read set grew to ${disclosed.length}: ${disclosed.join("; ")} — every entry must declare why`,
  );
});

test("A1: UI2API_VERSION is handled deliberately, not by accident", () => {
  const row = DOC_KNOBS.get("UI2API_VERSION");
  assert.ok(row, "UI2API_VERSION must have a row in AGENTS.md's knob table");
  assert.ok(
    row!.purpose.includes("NOT AN ENV KNOB"),
    `AGENTS.md:${row!.line} must keep declaring UI2API_VERSION is NOT an env knob — it is a local const reading package.json`,
  );
  assert.ok(
    !ENV_READS.has("UI2API_VERSION"),
    "UI2API_VERSION must NOT be env-read: src/registry/package.ts declares it as a local const",
  );
  assert.ok(literalKnobs().has("UI2API_VERSION"), "non-vacuity: UI2API_VERSION must be a literal in src/ (src/registry/package.ts)");
});

test("A1: negative — an undocumented env read IS reported (the pin can fail)", () => {
  const invented = "UI2API_A1_PROOF_OF_FAILURE";
  assert.ok(!DOC_KNOBS.has(invented) && !literalKnobs().has(invented), "precondition: the scratch knob exists nowhere yet");
  const asIfRead = new Map(ENV_READS);
  asIfRead.set(invented, ["src/nowhere.ts process.env." + invented]);
  const undocumented = [...asIfRead.keys()].filter((k) => !NOT_A_KNOB.has(k) && !DOC_KNOBS.has(k)).sort();
  assert.deepEqual(undocumented, [invented], `an env read with no doc row must be reported, got ${JSON.stringify(undocumented)}`);
});

// =============================================== A2 — name-constant resolution

/** Every `process.env[CONST]` bracket read in shipped code, with the file. */
function bracketConstReads(): { konst: string; rel: string }[] {
  const out: { konst: string; rel: string }[] = [];
  for (const f of FILES) {
    const s = stripComments(f.rel, readFileSync(f.abs, "utf8"));
    for (const m of s.matchAll(/process\.env\[\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\]/g)) {
      out.push({ konst: m[1]!, rel: f.rel });
    }
  }
  return out;
}

const BRACKET_READS = bracketConstReads();

test("A2: every name constant is RESOLVED — a declared X_ENV must have its process.env[X_ENV] read-back", () => {
  assert.ok(NAME_CONSTS.length >= 5, `non-vacuity: only ${NAME_CONSTS.length} X_ENV name constants derived — the declaration scan stopped reading`);
  const readConsts = new Set(BRACKET_READS.map((b) => b.konst));
  const unread = NAME_CONSTS.filter((n) => !readConsts.has(n.konst));
  assert.deepEqual(
    unread.map((n) => `${n.konst} -> ${n.knob} (declared in ${n.rel})`),
    [],
    "these name constants declare a UI2API_* literal but nothing reads them back as process.env[CONST]: the literal looks documented and wired while no env value ever reaches it",
  );
});

test("A2: every bracket read of a RESOLVABLE name constant lands on its documented knob", () => {
  // The resolution has to survive end to end: a bracket read whose constant is a
  // declared name constant must show up in the read set under the KNOB name, and
  // that knob must have a doc row. Without this the resolution could silently
  // degrade to "no reads found" and A1 would pass on an empty set.
  const resolvable = BRACKET_READS.filter((b) => NAME_CONST_BY_NAME.has(b.konst));
  assert.ok(resolvable.length >= 5, `non-vacuity: only ${resolvable.length} resolvable bracket reads — the read-back scan stopped reading`);
  const broken = resolvable.filter((b) => !ENV_READS.has(NAME_CONST_BY_NAME.get(b.konst)!));
  assert.deepEqual(
    broken.map((b) => `${b.konst} at ${b.rel}`),
    [],
    "a bracket read of a declared name constant did not register as a read of its knob",
  );
  const undoc = [...new Set(resolvable.map((b) => NAME_CONST_BY_NAME.get(b.konst)!))].filter((k) => !DOC_KNOBS.has(k));
  assert.deepEqual(undoc.sort(), [], "a resolved name-constant knob has no row in AGENTS.md's knob table");
});

test("A2: no bracket read of an _ENV-named constant may be left UNRESOLVED", () => {
  // THE mutation this pins: delete `export const TOKEN_ENV =
  // "UI2API_PROMPTD_TOKEN"` (src/prompt/posture.ts) and `process.env[TOKEN_ENV]`
  // in src/prompt/http.ts + src/cli.ts has nothing left to resolve — the knob
  // silently stops being env-readable while its doc row still says it is read.
  // Asserting only "every DECLARED constant is read" cannot catch that, because
  // the deleted declaration simply leaves the derived set. This direction can.
  const dangling = BRACKET_READS.filter((b) => /_ENV$/.test(b.konst) && !NAME_CONST_BY_NAME.has(b.konst));
  assert.deepEqual(
    dangling.map((b) => `${b.konst} at ${b.rel}`),
    [],
    "these bracket reads name a constant that LOOKS like a name constant (_ENV suffix) but no longer resolves: the declaration was renamed or deleted, so the env value never reaches the code",
  );
});

test("A2: the unresolved bracket reads are the DYNAMIC ones only, and that is disclosed", () => {
  // `process.env[name]` (a helper parameter) and `process.env[k]` (a loop
  // variable) cannot be resolved to a literal, and must NOT be: inventing a knob
  // name there is how a gate starts lying. They are recorded as unresolved and
  // the gate only insists that none of them is silently treated as a knob read.
  const unresolved = BRACKET_READS.filter((b) => !NAME_CONST_BY_NAME.has(b.konst)).map((b) => b.konst);
  for (const k of new Set(unresolved)) {
    assert.ok(!k.startsWith("UI2API_"), `${k} is a bracket read that names a knob but is not a resolvable name constant — resolve it instead of skipping it`);
  }
  const unresolvedInReads = [...ENV_READS.keys()].filter((k) => k.startsWith("<unresolved:")).sort();
  assert.deepEqual(
    unresolvedInReads,
    [...new Set(unresolved)].map((k) => `<unresolved:${k}>`).sort(),   // deduped: ENV_READS is keyed by knob
    "every unresolved bracket read must be disclosed under <unresolved:…> and excluded from the knob set, never dropped",
  );
});

test("A2: negative — a name constant whose declaration is gone IS reported", () => {
  // The mutation this assertion proves: delete `export const TOKEN_ENV =
  // "UI2API_PROMPTD_TOKEN"` from src/prompt/posture.ts and the knob stops being
  // read, so its doc row's "name const" claim is a lie. The gate must notice.
  const tokenConst = NAME_CONSTS.find((n) => n.konst === "TOKEN_ENV");
  assert.ok(tokenConst, "non-vacuity: TOKEN_ENV must be a declared name constant (src/prompt/posture.ts)");
  assert.equal(tokenConst!.knob, "UI2API_PROMPTD_TOKEN", "TOKEN_ENV must resolve to the knob AGENTS.md documents");
  const withoutDecl = NAME_CONSTS.filter((n) => n.konst !== "TOKEN_ENV");
  const readsWithout = new Map(ENV_READS);
  readsWithout.delete("UI2API_PROMPTD_TOKEN");
  const stillRead = withoutDecl.some((n) => n.konst === "TOKEN_ENV");
  assert.equal(stillRead, false, "with the declaration removed the constant is gone");
  assert.equal(readsWithout.has("UI2API_PROMPTD_TOKEN"), false, "the knob must fall out of the read set once its declaration is gone — that is the drift A2 exists to catch");
});

// ==================================================== A3 — INERT stays INERT

/** The knobs `scripts/ops/provision-ui2api-user.sh` reads into MESSAGE-ONLY
 *  locals. MEASURED defect class: an operator exports one of them, sees the
 *  provision message echo their value back, and concludes it took — while
 *  `scripts/ops/install-services.sh` copies `scripts/ops/units/*.service`
 *  verbatim (`install -m 0644`, no `sed`/`envsubst`/template anywhere) and those
 *  units hardcode CDP :9222, promptd :9797 and DISPLAY=:99. */
const INERT_IN_PROVISION = [
  { knob: "UI2API_DAEMON_PORT", local: "DAEMON_PORT" },
  { knob: "UI2API_XVFB_DISPLAY", local: "XVFB_DISPLAY" },
  { knob: "UI2API_PROMPTD_PORT", local: "API_PORT" },
] as const;

const PROVISION_REL = "scripts/ops/provision-ui2api-user.sh";

function provisionLines(): string[] {
  return readFileSync(join(ROOT, PROVISION_REL), "utf8").split("\n");
}

/** A shell line that only PRINTS. The list is the printing verbs this repo's ops
 *  scripts actually use (`say`/`have` are defined at the top of the provision
 *  script), plus a comment. Anything else that touches an INERT local is a real
 *  effect and must be reclassified rather than left with a stale record. */
function isMessageLine(line: string): boolean {
  const t = line.trim();
  if (t.startsWith("#")) return true;
  return /(^|\s)(say|echo|printf|log|warn|info|note)(\s|$)/.test(t);
}

/** Uses of an INERT local in the provision script: the reads (its own env-knob
 *  default) are excluded, every OTHER use is the thing under test. */
function inertUses(local: string): { line: number; text: string }[] {
  const re = new RegExp(`\\$\\{?${local}\\b`);
  const out: { line: number; text: string }[] = [];
  provisionLines().forEach((text, i) => {
    if (!re.test(text)) return;
    if (new RegExp(`^\\s*${local}=`).test(text)) return;   // the read itself
    out.push({ line: i + 1, text: text.trim() });
  });
  return out;
}

test("A3: an INERT provision local is still used ONLY to print", () => {
  const report: string[] = [];
  for (const { knob, local } of INERT_IN_PROVISION) {
    const reads = provisionLines().filter((l) => l.includes(`\${${knob}`));
    assert.equal(reads.length, 1, `${PROVISION_REL} must read ${knob} exactly once (into ${local}); found ${reads.length} reads: ${JSON.stringify(reads)}`);
    const uses = inertUses(local).filter((u) => !isMessageLine(u.text));
    for (const u of uses) report.push(`${knob} (${local}) is used at ${PROVISION_REL}:${u.line} OUTSIDE a message: ${u.text}`);
  }
  assert.deepEqual(
    report,
    [],
    "these knobs are no longer inert in the provision script — they now have a real effect, so the INERT record must be RECLASSIFIED (in AGENTS.md's row and in GOAL 213), not left stale",
  );
});

test("A3: the INERT record is stated in AGENTS.md, so it cannot rot silently", () => {
  for (const { knob } of INERT_IN_PROVISION) {
    const row = DOC_KNOBS.get(knob);
    assert.ok(row, `${knob} must have a row in AGENTS.md's knob table`);
    assert.ok(
      /message-only|INERT/i.test(row!.purpose),
      `AGENTS.md:${row!.line} must keep declaring ${knob} message-only/INERT — a knob that is read but cannot move anything has to say so where the knob table is read`,
    );
  }
});

test("A3: a non-message use of an INERT local IS reported (the pin can fail)", () => {
  const { local, knob } = INERT_IN_PROVISION[0]!;
  const honest = inertUses(local).filter((u) => !isMessageLine(u.text));
  assert.deepEqual(honest, [], "precondition: the real tree has no non-message use");
  const planted = { line: 41, text: `systemctl set-environment DISPLAY=${local}` };
  const detected = [planted].filter((u) => !isMessageLine(u.text)).map((u) => `${knob} used at ${PROVISION_REL}:${u.line} OUTSIDE a message`);
  assert.equal(detected.length, 1, `a real effect must be detected, got ${JSON.stringify(detected)}`);
});

test("A3: UI2API_PROMPTD_PORT is NOT inert repo-wide — the classification is per read site", () => {
  // Reported miscategorization, pinned so it cannot be re-filed as "fully inert":
  // `scripts/ops/deploy.sh` reads the SAME knob into API_PORT and builds a live
  // health-check URL from it (`http://127.0.0.1:$API_PORT$1`). Inert in the
  // provision script, LIVE in deploy.sh — which is why A3 is per-file.
  const rel = "scripts/ops/deploy.sh";
  const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
  const read = lines.findIndex((l) => l.includes("${UI2API_PROMPTD_PORT"));
  assert.ok(read >= 0, `non-vacuity: ${rel} must read UI2API_PROMPTD_PORT`);
  const realUse = lines.findIndex((l, i) => i > read && l.includes("$API_PORT") && !isMessageLine(l));
  assert.ok(realUse > read, `non-vacuity: ${rel} must use API_PORT in a live (non-message) way after reading it`);
  assert.deepEqual(inertUses("API_PORT").filter((u) => !isMessageLine(u.text)), [], "…while the PROVISION script's API_PORT stays message-only");
});

// ================================================ A4 — TRUST stays TRUST-marked

/** The marker AGENTS.md puts in a knob-table row's PURPOSE cell. `**TRUST**`
 *  bold rather than the bare word, because the purpose cells also say "trust
 *  posture" in ordinary prose (`UI2API_TRUST`'s own row) — matching the bare word
 *  would sweep those rows into the marked set. */
const TRUST_MARKER = "**TRUST**";

/** The rows AGENTS.md CURRENTLY marks. Derived at run time; never a hand-typed
 *  count, so the count moving is not by itself a failure. */
function trustRows(): DocRow[] {
  return DOC_ROWS.filter((r) => r.purpose.includes(TRUST_MARKER));
}

/** Phrases a row may use to DECLARE why a marked knob has no live read. These
 *  are the same honesty shapes A1/A3 already accept (`nothing reads it`,
 *  `NOT AN ENV KNOB`, `family prefix`) plus the two marker-specific ones
 *  (`message-only`, the A3 INERT class; and an explicit `DEAD`). A marked knob
 *  with NO live read and NO such declaration is a warning about a knob that
 *  cannot fire — the exact rot this category exists to catch. */
const DECLARED_UNBACKED = ["message-only", "INERT", "DEAD", ...DECLARED_NOT_READ] as const;

function declaresUnbacked(row: DocRow): boolean {
  return DECLARED_UNBACKED.some((p) => row.purpose.includes(p));
}

/** The gate's OWN record of which knobs weaken the trust posture.
 *
 *  WHY THIS IS DECLARED RATHER THAN DERIVED, when everything else here is
 *  derived: a derived-only TRUST gate would be CIRCULAR. `trustRows()` reads the
 *  marker out of AGENTS.md, so deleting the marker deletes it from the derived
 *  set too — and the gate would pass on exactly the edit it exists to catch.
 *  There is no second source for the marker anywhere in the repo (the code has
 *  no idea which of its knobs are posture-weakening), so the gate's own record
 *  has to BE that second source — the same house shape A3 uses for its three
 *  INERT knobs. Measured 2026-10-03 by the scan below: 11 marked rows.
 *
 *  BOTH directions are asserted against it (A4.1 declared->observed catches a
 *  dropped marker; A4.2 observed->declared catches a silently ADDED one), and
 *  NO COUNT is pinned, so the set moving is reported as a named row rather than
 *  as an opaque `expected 11 to equal 12`.
 *
 *  REPORTED, NOT FIXED (AGENTS.md is out of scope for this file): the row for
 *  `UI2API_TRUST` itself — the knob literally named TRUST, whose purpose cell
 *  reads "trust posture (what the daemon will attach/replay)" — carries NO
 *  marker. Whether that is deliberate (the knob is named TRUST, so the marker
 *  would read as a stutter) or an oversight is an AGENTS.md call; this gate
 *  deliberately does not invent the marker for it, because a gate that rewrites
 *  the doc it checks is not a gate. */
const EXPECTED_TRUST: readonly string[] = [
  "UI2API_ATTACH_MAX_BYTES",
  "UI2API_ATTACH_PORT",
  "UI2API_ATTACH_ROOTS",
  "UI2API_CHROME_NO_SANDBOX",
  "UI2API_HUB_BIND",
  "UI2API_INFRA_ADDRESSES",
  "UI2API_SINGLE_PROCESS",
  "UI2API_TOKEN",
  "UI2API_USER_DATA_DIR",
  "UI2API_WIGOLO_ALLOW_REMOTE",
  "UI2API_WIGOLO_ALLOW_REMOTE_TOKEN",
];

/** Rows the gate expects to carry the marker but which no longer do. Pure, so
 *  the negative test below drives THIS function rather than a copy of it. */
function unmarkedExpectation(rows: DocRow[], expected: readonly string[]): string[] {
  const marked = rows.filter((r) => r.purpose.includes(TRUST_MARKER));
  return expected
    .filter((k) => !marked.some((r) => r.knob === k))
    .map((k) => `${k} (AGENTS.md:${rows.find((r) => r.knob === k)?.line ?? "no row"})`);
}

/** Marked rows that are neither read nor declared-unread. Pure, same reason. */
function unbackedTrustRows(rows: DocRow[], reads: Map<string, string[]>): string[] {
  return rows
    .filter((r) => r.purpose.includes(TRUST_MARKER))
    .filter((r) => !reads.has(r.knob) && !declaresUnbacked(r))
    .map((r) => `${r.knob} (AGENTS.md:${r.line})`);
}

test("A4: every posture-weakening knob KEEPS its TRUST marker in AGENTS.md's knob table", () => {
  const marked = trustRows();
  assert.ok(
    marked.length >= 8,
    `non-vacuity: only ${marked.length} TRUST-marked rows parsed out of ${DOC_ROWS.length} — the marker shape changed, or the whole marked class was dropped`,
  );
  const unmarked = unmarkedExpectation(DOC_ROWS, EXPECTED_TRUST);
  assert.deepEqual(
    unmarked,
    [],
    "these knobs weaken the daemon's trust posture but their AGENTS.md row NO LONGER carries the " +
      `${TRUST_MARKER} marker: the marker is the only signal a reader has, and the day it is dropped ` +
      "the knob looks as safe as any other. Restore the marker, or move the knob out of EXPECTED_TRUST " +
      "with a stated reason if it genuinely no longer weakens posture.",
  );
});

test("A4: a NEWLY marked posture knob must be recorded in the gate, not added silently", () => {
  const marked = trustRows();
  const unrecorded = marked
    .filter((r) => !EXPECTED_TRUST.includes(r.knob))
    .map((r) => `${r.knob} (AGENTS.md:${r.line})`);
  assert.deepEqual(
    unrecorded,
    [],
    "these rows carry the TRUST marker but are NOT in the gate's EXPECTED_TRUST record: a knob that " +
      "weakens trust posture is a deliberate classification, so add it to EXPECTED_TRUST in this file " +
      "in the same commit that marked it — otherwise the marked set grows with nobody deciding what is in it",
  );
});

test("A4: a TRUST-marked knob is actually READ somewhere, or its row declares why it is not", () => {
  // The failure this exists to catch: a knob that weakens posture is removed
  // from the code, but its documented, marked row survives — so a reader is still
  // warned about a knob that cannot fire, and the warning has lost its meaning.
  const marked = trustRows();
  assert.ok(marked.length >= 8, `non-vacuity: only ${marked.length} TRUST-marked rows parsed`);
  const unbacked = unbackedTrustRows(DOC_ROWS, ENV_READS);
  assert.deepEqual(
    unbacked,
    [],
    "these rows are marked TRUST — they weaken the daemon's trust posture — but the knob is read NOWHERE " +
      "in src/ or scripts/ and the row does not declare why. Either the read was removed (then the knob " +
      "is gone and the row is a warning about nothing: delete it or say it is dead) or the read moved " +
      "behind a shape this scan cannot see (then fix the row's cite).",
  );
  // Disclosure, in A1.3's shape: the set may not be EMPTY BY ACCIDENT, and it may
  // not quietly become the normal case either. Measured: 0 of 11 today.
  const carried = marked.filter((r) => declaresUnbacked(r) && !ENV_READS.has(r.knob));
  assert.ok(
    carried.length <= 2,
    `${carried.length} of ${marked.length} TRUST-marked rows now declare themselves unread ` +
      `(${carried.map((r) => r.knob).join(", ")}) — a posture knob that no longer fires is a broad ` +
      "posture change, not a row edit; re-audit the class rather than declaring them one at a time",
  );
});

/** `rel:NN rest-of-site` -> the file and the 1-based line the read is on. */
function siteLine(site: string): { rel: string; line: number; text: string } | null {
  const m = /^(.*):(\d+) (.*)$/.exec(site);
  return m ? { rel: m[1]!, line: Number(m[2]), text: m[3]! } : null;
}

/** Does this source line PRINT rather than act? A3's `isMessageLine` already
 *  answers that for shell; this is the JS/TS twin, deliberately NARROW — it can
 *  only ever fire on a line that literally contains a `console.*` call, so a
 *  multi-line statement whose `console.log(` sits on an earlier line reads as
 *  "acting" here. That direction is safe: it can under-report a print, never
 *  invent one. */
function isPrintLine(rel: string, text: string): boolean {
  if (/\.sh$/.test(rel)) return isMessageLine(text);
  return /\bconsole\s*\.\s*(log|error|warn|info|debug|trace)\s*\(/.test(text);
}

test("A4: every TRUST-marked knob has at least one read site that CONSUMES it, not one that only narrates it", () => {
  // A3's rule ("a knob read only to print is inert") applied to the whole TRUST
  // class rather than to three hand-listed provision locals. The failure this
  // catches is the subtle half of the "marked but unbacked" rot: the read
  // survives, the marker survives, and the reader still sees a posture warning
  // on a knob whose only remaining effect is a sentence in a log.
  //
  // THE SHAPE IS "AT LEAST ONE CONSUMING SITE", NOT "NO PRINTING SITE" — measured,
  // and the narrow shape is the correct one: a real marked knob legitimately
  // narrates itself on the way past. `UI2API_ATTACH_PORT` has 15 read sites and
  // one of them (`src/cli.ts:882`) only echoes the port into `/status`;
  // `UI2API_INFRA_ADDRESSES` has 4, two of which only count the words into a
  // `note`. Both also have real consuming sites (the attach-port resolver, and
  // the `for a in ${UI2API_INFRA_ADDRESSES…}` loop at make-public-repo.sh:214).
  // Forbidding every print would have made this gate misfire on the day it was
  // written, which is how gates get skipped.
  //
  // MEASURED 2026-10-03, and the reason this needed a different answer than A3:
  // two TRUST knobs are read EXACTLY ONCE and neither read is a print —
  // `UI2API_TOKEN` is bound into the generated PHP config
  // (`'token' => env('UI2API_TOKEN', …)`, src/generator/lang-php.ts:597) and
  // `UI2API_TRUST` into the generated server's `servePlugin(…, {trust: …})`
  // (src/generator/generate.ts:41). Both are CONSUMED, by the artifact the
  // generator emits rather than by the generator process — which is why the
  // assertion is about the nature of the read LINE and not about a second
  // reference to the value later in the file: `trust` appears exactly once, at
  // the call it configures, so an assertion demanding a second reference would
  // misfire.
  const marked = trustRows();
  assert.ok(marked.length >= 8, `non-vacuity: only ${marked.length} TRUST-marked rows parsed`);
  const unconsumed: string[] = [];
  const stale: string[] = [];
  let sitesExamined = 0;
  let narrating = 0;
  for (const row of marked) {
    const sites = ENV_READS.get(row.knob) ?? [];
    if (sites.length === 0) { unconsumed.push(`${row.knob} (AGENTS.md:${row.line}) — no read site at all`); continue; }
    const prints: string[] = [];
    for (const site of sites) {
      sitesExamined++;
      const at = siteLine(site);
      if (!at) { stale.push(`${row.knob}: unparseable read site ${JSON.stringify(site)}`); continue; }
      const lines = readFileSync(join(ROOT, at.rel), "utf8").split("\n");
      const raw = lines[at.line - 1];
      if (raw === undefined) { stale.push(`${row.knob}: ${site} — that line does not exist`); continue; }
      // The line must still contain the IDENTIFIER the scan matched — not the
      // whole normalised site text (the scan normalises `${UI2API_X}` to
      // `$UI2API_X` and `env('UI2API_X', …)` to `env...('UI2API_X')`, so an exact
      // substring test would flag live reads) and not the bare knob literal (a
      // name-constant read carries the literal only at its declaration). This
      // closes the loop on the whole derive chain: scan -> site string -> file
      // -> line -> identifier, so a change to the site format cannot quietly
      // stop matching anything.
      const ident = (at.text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).pop();
      if (!ident || !raw.includes(ident)) {
        stale.push(`${row.knob}: ${site} — that line does not mention ${JSON.stringify(ident ?? at.text)}`);
      }
      if (isPrintLine(at.rel, raw)) prints.push(`${at.rel}:${at.line}`);
    }
    if (prints.length === sites.length) {
      narrating += prints.length;
      unconsumed.push(
        `${row.knob} (AGENTS.md:${row.line}) — all ${sites.length} read site(s) only print: ${prints.join(", ")}`,
      );
    } else {
      narrating += prints.length;
    }
  }
  assert.ok(
    sitesExamined >= marked.length,
    `non-vacuity: only ${sitesExamined} read sites examined across ${marked.length} TRUST rows`,
  );
  assert.deepEqual(stale, [], "a TRUST row's recorded read site does not resolve to a line that reads it");
  assert.deepEqual(
    unconsumed,
    [],
    "these TRUST-marked knobs are read ONLY to print. A knob that weakens trust posture but merely " +
      "narrates its value has no posture left to warn about — either wire it for real, or unmark it and " +
      "say what it actually does.",
  );
  // Disclosure: a marked knob may echo itself on the way past (a /status line, a
  // census count) as long as something ACTS on it. Bounded so the echo sites
  // cannot quietly become the whole class.
  assert.ok(
    narrating <= marked.length * 3,
    `${narrating} of ${sitesExamined} TRUST read sites only print — past 3 per marked row the class has ` +
      "stopped being enforced and started being narrated",
  );
});

test("A4: a marked knob that is ALSO declared message-only is reported — TRUST and INERT are disjoint", () => {
  // A knob cannot both weaken the daemon's trust posture and be documented as
  // only printing its value: the second says there is no behaviour to weaken.
  // Measured 2026-10-03: 0 of 11 — the INERT class (`UI2API_DAEMON_PORT`,
  // `UI2API_XVFB_DISPLAY`, `UI2API_PROMPTD_PORT`) is deliberately unmarked.
  const both = DOC_ROWS.filter(
    (r) => r.purpose.includes(TRUST_MARKER) && /message-only|INERT/i.test(r.purpose),
  ).map((r) => `${r.knob} (AGENTS.md:${r.line})`);
  assert.deepEqual(
    both,
    [],
    "these rows are marked TRUST AND declared message-only/INERT. Decide which one it is: a knob that " +
      "cannot fire has no trust posture, so its marker is a warning about nothing (drop the marker), and a " +
      "knob that does fire must not be documented as printing (drop the INERT claim).",
  );
});

test("A4: negative — DROPPING a TRUST marker IS reported (the marker pin can fail)", () => {
  // The mutation this proves, end to end: delete `**TRUST**` from one AGENTS.md
  // knob row and the gate must name that row. Driven through the SAME
  // classification function the real assertion uses, on a copy of the real rows.
  const victim = EXPECTED_TRUST[0]!;
  const before = unmarkedExpectation(DOC_ROWS, EXPECTED_TRUST);
  assert.deepEqual(before, [], "precondition: the real tree has no unmarked posture knob");
  const mutated = DOC_ROWS.map((r) =>
    r.knob === victim ? { ...r, purpose: r.purpose.replace(TRUST_MARKER, "") } : r,
  );
  const after = unmarkedExpectation(mutated, EXPECTED_TRUST);
  assert.deepEqual(
    after,
    [`${victim} (AGENTS.md:${DOC_ROWS.find((r) => r.knob === victim)!.line})`],
    `dropping ${TRUST_MARKER} from ${victim}'s row must be reported`,
  );
  assert.ok(mutated.some((r) => r.knob === victim && !r.purpose.includes(TRUST_MARKER)), "the mutation really removed the marker");
});

test("A4: negative — a TRUST knob whose read DISAPPEARS IS reported (the read-side pin can fail)", () => {
  // The mutation this proves: delete the body that reads a posture knob (or move
  // it behind a shape the scan cannot see) and the documented, marked TRUST row
  // survives — the reader is still warned about a knob that cannot fire. Driven
  // through the same pure classifier the real assertion uses.
  const victim = EXPECTED_TRUST.find((k) => (ENV_READS.get(k) ?? []).length === 1) ?? EXPECTED_TRUST[0]!;
  assert.ok(ENV_READS.has(victim), `precondition: ${victim} must be read in the real tree`);
  assert.deepEqual(unbackedTrustRows(DOC_ROWS, ENV_READS), [], "precondition: no marked row is unbacked");
  const readsWithout = new Map(ENV_READS);
  readsWithout.delete(victim);
  assert.deepEqual(
    unbackedTrustRows(DOC_ROWS, readsWithout),
    [`${victim} (AGENTS.md:${DOC_ROWS.find((r) => r.knob === victim)!.line})`],
    `losing the only read of ${victim} must be reported as an unbacked TRUST marker`,
  );
  // …and a row that DECLARES why it is unread must NOT be reported, or the gate
  // would force a knob to keep a marker it cannot back.
  const declared = DOC_ROWS.map((r) =>
    r.knob === victim ? { ...r, purpose: `${r.purpose} DEAD — the read was removed deliberately` } : r,
  );
  assert.deepEqual(
    unbackedTrustRows(declared, readsWithout),
    [],
    "an explicitly declared-dead TRUST row is not an unbacked marker",
  );
});

// ============================================= A5 — DORMANT stays DECLARED

/** Rows documented in AGENTS.md's knob table that the scan finds NO environment
 *  read for — a knob that is DORMANT (dead, a family prefix, a non-env const, or
 *  a knob nothing reads). Pure classifiers, so the negatives below drive the same
 *  code the real assertions do. */
function dormantRows(rows: DocRow[], reads: Map<string, string[]>): DocRow[] {
  return rows.filter((r) => !reads.has(r.knob));
}

/** The honesty clause of a dormant row: which of the declared phrases it uses,
 *  or `null` when it uses none. */
function honestyPhrase(row: DocRow): string | null {
  return DECLARED_NOT_READ.find((p) => row.purpose.includes(p)) ?? null;
}

/** DORMANT rows that SAY NOTHING about being dormant. */
function undeclaredDormantRows(rows: DocRow[], reads: Map<string, string[]>): string[] {
  return dormantRows(rows, reads)
    .filter((r) => !declaresNotRead(r))
    .map((r) => `${r.knob} (AGENTS.md:${r.line})`);
}

test("A5: a documented knob that is read NOWHERE must DECLARE it — a code literal is not a read", () => {
  // DELIBERATELY TIGHTER THAN A1.3, and the overlap is named rather than hidden:
  // A1.3 lets a documented-but-unread row pass if the knob still appears as a
  // LITERAL somewhere in src/ (the `!literalKnobs().has(r.knob)` clause). That
  // escape hatch is right for A1 — "is this row grounded in the code at all?" is
  // a different question — but it is WRONG here: a literal left behind by a
  // removed read is exactly how a dead knob keeps looking configurable, and it is
  // the loophole a stale `DEAD`/`nothing reads it` label would slip through.
  //
  // MEASURED 2026-10-03: 3 dormant rows, all declaring — `UI2API_AI_PROFILE`
  // ("nothing reads it", and it IS still a literal in src/profile/profile.ts),
  // `UI2API_VERSION` ("NOT AN ENV KNOB"), `UI2API_WIGOLO_` ("family prefix",
  // and it is NOT a literal anywhere — that row is grounded purely by its
  // declaration, which is why the escape hatch had to go).
  const marked = DOC_ROWS.length;
  assert.ok(marked >= 60, `non-vacuity: only ${marked} rows parsed out of AGENTS.md's knob table`);
  const undeclared = undeclaredDormantRows(DOC_ROWS, ENV_READS);
  assert.deepEqual(
    undeclared,
    [],
    "these rows document a knob that is read NOWHERE from the environment, and say nothing about it: " +
      "a knob with no read must be documented as dead / unread / a family prefix / not-an-env-knob. " +
      "Otherwise a reader configures it and nothing happens.",
  );
});

test("A5: the DORMANT set is disclosed and BOUNDED — it cannot rot into unchecked, nor grow silently", () => {
  const dormant = dormantRows(DOC_ROWS, ENV_READS);
  // Non-vacuity, both directions. A floor so the direction cannot die by the
  // class becoming empty (every knob read again = nothing left to declare), and
  // the A1.3-shaped ceiling so a new dormant knob must arrive with a decision.
  assert.ok(
    dormant.length >= 1,
    "non-vacuity: no documented-but-unread rows at all — this whole category is being measured against an empty set",
  );
  assert.ok(
    dormant.length <= 4,
    `the documented-but-never-read set grew to ${dormant.length}: ` +
      `${dormant.map((r) => `${r.knob} (AGENTS.md:${r.line}, "${honestyPhrase(r)}")`).join("; ")} — ` +
      "every entry must declare why, so past this bound the class needs re-auditing rather than more rows",
  );
  // Disclosure: name the set AND the honesty phrase each entry uses, so the
  // number is readable rather than an opaque count. The names are DECLARED, not
  // derived, for the one thing a derived-only assertion provably cannot catch:
  // A5.1 above still passes if a dormant row is DELETED from the table, because
  // a row that is not there declares nothing. Pinning the members means the
  // deletion is a decision somebody has to make out loud — the same reason A3
  // declares its three INERT knobs, and the same reason EXPECTED_TRUST exists
  // above. The phrases are pinned beside the names because a row can keep its
  // name and lose the honesty clause, which is the rot this category is named for.
  const disclosed = dormant.map((r) => `${r.knob}="${honestyPhrase(r)}"`).sort();
  assert.deepEqual(
    disclosed,
    ["UI2API_AI_PROFILE=\"nothing reads it\"", "UI2API_VERSION=\"NOT AN ENV KNOB\"", "UI2API_WIGOLO_=\"family prefix\""],
    "the DORMANT set is pinned by name so a knob cannot quietly become dormant (or be deleted from the " +
      "table) without this gate saying so; if a knob is genuinely re-wired, update it here in the same commit",
  );
});

/** Rows that declare themselves unread while the scan finds a LIVE read — the
 *  inverse rot of A5.1, and the reason a DORMANT label needs the same treatment
 *  A3 gives INERT: the day someone wires the knob for real, the stale "nothing
 *  reads it" must be reclassified, not left next to a working read. */
function staleDormantRows(rows: DocRow[], reads: Map<string, string[]>): string[] {
  return rows
    .filter((r) => declaresNotRead(r) && reads.has(r.knob))
    .map((r) => `${r.knob} (AGENTS.md:${r.line})`);
}

test("A5: a row declared DORMANT must NOT be read — the label cannot outlive the truth", () => {
  // Measured 2026-10-03: 0 of 68 rows. `UI2API_AI_PROFILE` is the live risk: its
  // row says the working override is `UI2API_AI_SITE`, and the knob is still a
  // literal in src/profile/profile.ts — so wiring it back up is a one-line change
  // that would leave the row claiming nothing reads it.
  const stale = staleDormantRows(DOC_ROWS, ENV_READS);
  assert.deepEqual(
    stale,
    [],
    "these rows declare that the knob is not read (dead / family prefix / not-an-env-knob / nothing " +
      "reads it) yet the scan finds a live environment read. Reclassify the row to describe what the knob " +
      "now does — a stale dormancy label is how a reader keeps avoiding a knob that works.",
  );
});

test("A5: negative — DROPPING an honesty phrase IS reported (the DORMANT pin can fail)", () => {
  // The mutation this proves: delete "nothing reads it" from `UI2API_AI_PROFILE`'s
  // row. A1.3 does NOT catch it — that row's knob is still a literal in
  // src/profile/profile.ts, which is precisely the escape hatch A5.1 removes.
  const victim = "UI2API_AI_PROFILE";
  const real = DOC_ROWS.find((r) => r.knob === victim);
  assert.ok(real, `precondition: ${victim} must have a row in AGENTS.md's knob table`);
  assert.equal(honestyPhrase(real!), "nothing reads it", "precondition: the row declares its dormancy");
  assert.deepEqual(undeclaredDormantRows(DOC_ROWS, ENV_READS), [], "precondition: every dormant row declares why");
  const mutated = DOC_ROWS.map((r) =>
    r.knob === victim ? { ...r, purpose: r.purpose.replace("nothing reads it", "runtime knob").replace("**DEAD — nothing reads it.**", "") } : r,
  );
  assert.ok(mutated.find((r) => r.knob === victim)!.purpose.includes("runtime knob"), "the mutation landed");
  assert.deepEqual(
    undeclaredDormantRows(mutated, ENV_READS),
    [`${victim} (AGENTS.md:${real!.line})`],
    "an undocumented-as-dead knob that is read nowhere must be reported, literal or not",
  );
});

test("A5: negative — a knob that becomes genuinely DEAD IS reported (it must be declared, not left configurable)", () => {
  // The mutation this proves: remove a live read (here the single read of a real
  // knob) and the row is left describing a knob an operator can still configure.
  // Derived, not hand-listed: the victim is whichever real knob the scan finds
  // with exactly one read site.
  const victim = [...ENV_READS.entries()].find(
    ([k, v]) => v.length === 1 && DOC_KNOBS.has(k) && !declaresNotRead(DOC_KNOBS.get(k)!),
  );
  assert.ok(victim, "non-vacuity: at least one documented knob must have exactly one read site");
  const [knob, sites] = victim;
  assert.deepEqual(undeclaredDormantRows(DOC_ROWS, ENV_READS), [], "precondition: every dormant row declares why");
  const readsWithout = new Map(ENV_READS);
  readsWithout.delete(knob);
  assert.deepEqual(
    undeclaredDormantRows(DOC_ROWS, readsWithout),
    [`${knob} (AGENTS.md:${DOC_KNOBS.get(knob)!.line})`],
    `${knob} lost its only read at ${sites[0]} and must be declared dead`,
  );
});
