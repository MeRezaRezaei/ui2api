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
// an operator pays for. This gate is the answer, in three assertions:
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
//
// HOUSE RULES (inherited from test/skills-truth.test.ts, which owns the
// comment-stripping approach this file follows, and from
// test/ci-contract-knob-cites.test.ts, whose precedent is the reason this file
// is narrow on purpose):
//   * DERIVE, NEVER HAND-TYPE. The knob set, the read sites and AGENTS.md's
//     table are all computed from the repo at test time.
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
    for (const m of s.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*"([^"]+)"\s*\]|\[\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\])/g)) {
      const dotted = m[1];
      const literal = m[2];
      const constRef = m[3];
      if (dotted) { if (dotted.startsWith("UI2API_")) add(dotted, `${f.rel} process.env.${dotted}`); }
      else if (literal) { if (literal.startsWith("UI2API_")) add(literal, `${f.rel} process.env["${literal}"]`); }
      else if (constRef) {
        const resolved = NAME_CONST_BY_NAME.get(constRef);
        // An unresolvable bracket constant is NOT silently dropped — a read whose
        // name cannot be derived is exactly the blind spot A2 exists to close.
        if (resolved) add(resolved, `${f.rel} process.env[${constRef}]`);
        else if (constRef.startsWith("UI2API_")) add(constRef, `${f.rel} process.env[${constRef}]`);
        else add(`<unresolved:${constRef}>`, `${f.rel} process.env[${constRef}]`);
      }
    }
    for (const m of s.matchAll(/\benv[A-Za-z0-9_]*\(\s*["'](UI2API_[A-Z0-9_]+)["']/g)) add(m[1]!, `${f.rel} env...('${m[1]}')`);
    if (/\.sh$/.test(f.rel)) {
      for (const m of s.matchAll(/\$\{?(UI2API_[A-Z0-9_]+)/g)) add(m[1]!, `${f.rel} $${m[1]}`);
    }
  }
  return out;
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
