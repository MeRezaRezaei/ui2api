// The SKILLS family truth gate.
//
// `skills/*/SKILL.md` is TRACKED prose that makes hard assertions about a moving
// codebase: which routes the daemon serves, which `UI2API_*` knobs exist, which
// site ids resolve. Nothing checked any of it. The repo already owns the lesson —
// `test/doc-numbers-truth.test.ts` exists because hand-typed counts rotted, and
// `.agents/` was gitignored (`.gitignore:6`) which is how an already-stale skill
// shipped as truth without a commit noticing it was missing.
//
// THE POINT OF THIS FILE: a prose skill is an assertion about code that nothing
// verifies. This is the verification. Five checks, one per class of claim:
//
//   1. FRONTMATTER SHAPE + NAME AGREEMENT — keys are EXACTLY `name` + `description`,
//      and `name` equals the directory name. A `tools:` key fails, and the
//      generated per-host template in `src/generator/skill-template.ts` is NOT
//      exempt: it emits `tools:` and is not under `skills/`, which is the point —
//      the family and the generator's output are different shapes on purpose.
//   2. ROUTES — every route token a skill names must be REGISTERED, derived by
//      scanning the daemon's own dispatch guards (`src/prompt/http.ts` PLUS
//      `src/prompt/openai.ts`; the /v1 OpenAI routes are dispatched in the latter,
//      so an http.ts-only scan is blind to `/v1/models` and would fire a false
//      positive on honest prose — the failure mode that kills a gate).
//   3. KNOBS — every `UI2API_*` name must exist as a LITERAL in `src/**` or
//      `scripts/**`. `UI2API_VERSION` needs no exemption: it IS in `src/`, and
//      this gate asserts presence-as-literal, never `process.env` readability, so
//      AGENTS.md's "NOT AN ENV KNOB" note stays true and needs no special case.
//      The bare `UI2API_WIGOLO_` family PREFIX is tolerated with no member; a
//      member that does not exist still fails.
//   4. SITE IDS — every site id must RESOLVE: a directory under `capabilities/`,
//      or a key of `BUILTIN_PROFILES`. Only tokens in a site-ISH context are
//      candidates (after `capabilities/`, after `--site`, in a `"site"` field, or
//      as a concrete `/capability/<id>`), because treating every lowercase word as
//      an id turns the gate into noise nobody reads.
//   5. NO BARE COUNTS + THE CONTRACT LINE — counts rot; the family's instruction is
//      to give the deriving command instead. The exact sentence is required so the
//      anti-rot stance is load-bearing rather than advisory.
//
// HOUSE RULES THIS FILE KEEPS (they are the ones AGENTS.md records):
//   * Assertions live inside real top-level `test(...)` calls, NEVER in a bare
//     `describe` body — GOAL 108's "assertions-are-counted" class: an assertion in
//     a describe body gates but reports `tests 0`, so coverage under-reports.
//   * Every expected value is DERIVED at run time from the repo. There is no
//     hand-typed route list and no hand-typed knob list in this file; writing one
//     would be the defect.
//   * Non-vacuity is PROVED: each check is fed a deliberately bad string through
//     its own exported predicate and shown to fail, so "it passes" can never mean
//     "it found nothing to check".
//   * The skill set is GLOBBED, never enumerated, so a fifth skill needs no code
//     change. A `skills/<dir>/` with no `SKILL.md` FAILS: a half-written skill
//     that a reader cannot find is the same rot as a gitignored one.

import { test as t, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_PROFILES } from "../src/profile/profile.js";

export const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** The one sentence the family requires in every skill, EXACTLY. */
export const CONTRACT_LINE = "Derive live state; never trust a count in this file.";

// ============================================================ discovery =====

/** Every `skills/<dir>/` on disk, sorted. GLOBBED — never enumerated. */
export function skillDirs(root: string = ROOT): string[] {
  try {
    return readdirSync(join(root, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export interface SkillFile {
  /** Path relative to the repo root, for failure messages. */
  rel: string;
  /** The directory name — what `name:` must equal. */
  dir: string;
  text: string;
}

/** Every skill whose `SKILL.md` EXISTS. A directory without one is a failure, not
 *  an absence: see `dirsMissingSkillFile`. */
export function skillFiles(root: string = ROOT): SkillFile[] {
  const out: SkillFile[] = [];
  for (const dir of skillDirs(root)) {
    const abs = join(root, "skills", dir, "SKILL.md");
    if (!existsSync(abs)) continue;
    out.push({ rel: `skills/${dir}/SKILL.md`, dir, text: readFileSync(abs, "utf8") });
  }
  return out;
}

/** `skills/<dir>/` directories that carry no `SKILL.md`. */
export function dirsMissingSkillFile(root: string = ROOT): string[] {
  return skillDirs(root).filter((d) => !existsSync(join(root, "skills", d, "SKILL.md")));
}

// =========================================================== frontmatter ====

export interface Frontmatter {
  /** True when the file opens with a `---` fenced block. */
  present: boolean;
  /** Top-level keys, in file order. A key is top-level = at column 0, `key:`. */
  keys: string[];
  /** The `name:` value, or null. */
  name: string | null;
  description: string | null;
}

/** The top-level `key:` lines of a `---` block. A leading-space line is a
 *  continuation of the previous key's value (a folded `>-` block, or a YAML list
 *  item), never a new top-level key — that distinction is what makes the
 *  "exactly name + description" rule meaningful rather than counting list items. */
/** True when the file carries Windows line endings.
 *
 *  A CRLF file is a REAL and common authoring accident, and this gate used to
 *  report it as `frontmatter has no \`name\` key` — because `---` and `name: x`
 *  arrive as `---\r` / `name: x\r`, so `line.trim() === "---"` fails and every
 *  top-level key goes unrecognised. That sends the author hunting for a missing
 *  key they never wrote. Named here so the failure names the ACTUAL cause.
 *  (A BOM needs no case of its own: `\uFEFF` is whitespace, so `.trim()` drops
 *  it and the first line already parses.) */
export function crlf(text: string): boolean {
  return text.includes("\r\n");
}

/** The CRLF problem, in the shape `frontmatterViolations` reports problems. */
export function crlfViolation(rel: string): FrontmatterViolation {
  return {
    file: rel,
    problem: "file uses CRLF (Windows) line endings, so no frontmatter key is recognised",
    fix: "convert the file to LF endings (`dos2unix skills/<dir>/SKILL.md`, or your editor's \"line endings: LF\") — the `name`/`description` keys ARE there",
  };
}

export function parseFrontmatter(text: string): Frontmatter {
  const lines = (crlf(text) ? text.replace(/\r\n/g, "\n") : text).split("\n");
  if (lines[0]?.trim() !== "---") return { present: false, keys: [], name: null, description: null };
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close === -1) return { present: false, keys: [], name: null, description: null };
  const keys: string[] = [];
  const values = new Map<string, string>();
  let current: string | null = null;
  for (const line of lines.slice(1, close)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/);
    if (m) {
      current = m[1]!;
      keys.push(current);
      values.set(current, m[2]!.trim());
      continue;
    }
    // A continuation line only carries the scalar when it is on the SAME line as
    // its key; a folded block's real text lives on indented lines and is
    // irrelevant to the name-agreement rule.
    if (current && !/^\s/.test(line) && line.trim() !== "") current = null;
  }
  return {
    present: true,
    keys,
    name: values.get("name") ?? null,
    description: values.get("description") ?? null,
  };
}

export interface FrontmatterViolation {
  file: string;
  problem: string;
  fix: string;
}

/** Check 1. Every reason a skill's frontmatter is wrong, named per offender. */
export function frontmatterViolations(sf: SkillFile): FrontmatterViolation[] {
  const where = `${sf.rel}`;
  // CRLF FIRST and ALONE. Reporting it alongside the two phantom "no `name`
  // key" / "no `description` key" problems was the defect: those keys are in the
  // file, and an author sent after them never finds them. The file must still
  // FAIL — a CRLF skill is not a loadable skill — just for the right reason.
  if (crlf(sf.text)) return [crlfViolation(where)];
  const fm = parseFrontmatter(sf.text);
  if (!fm.present) {
    return [{
      file: where,
      problem: "no frontmatter: the file does not open with a `---` block",
      fix: "open the file with a `---` block carrying `name` and `description`",
    }];
  }
  const out: FrontmatterViolation[] = [];
  const extra = fm.keys.filter((k) => k !== "name" && k !== "description");
  if (extra.length > 0) {
    out.push({
      file: where,
      problem: `top-level frontmatter keys other than name+description: ${extra.join(", ")}`,
      fix: "keep exactly `name` and `description`; anything else (a `tools:` key, metadata) belongs in the body",
    });
  }
  for (const required of ["name", "description"]) {
    if (!fm.keys.includes(required)) {
      out.push({ file: where, problem: `frontmatter has no \`${required}\` key`, fix: `add a \`${required}:\` key` });
    }
  }
  if (fm.name !== null && fm.name !== sf.dir) {
    out.push({
      file: where,
      problem: `frontmatter \`name: ${fm.name}\` does not equal its directory name \`${sf.dir}\``,
      fix: `rename the key to \`name: ${sf.dir}\` (the directory is what the skill is loaded as) or rename the directory`,
    });
  }
  // DELIBERATELY no rule on the description's VALUE, only on the key being present.
  // `description: >-` with an indented body is the shape every real skill uses and
  // it is perfectly valid; a gate that rejected it would be firing on honest prose.
  return out;
}

// ================================================================= routes ===

const ROUTE_SRC_FILES = ["src/prompt/http.ts", "src/prompt/openai.ts"] as const;

/**
 * Routes the daemon actually REGISTERS, derived from the dispatch guards
 * themselves rather than a hand-typed list.
 *
 * Both files are read on purpose: `src/prompt/http.ts` proxies `/v1/*` to
 * `src/prompt/openai.ts`, where `/v1/models` and `/v1/chat/completions` are
 * compared. Scanning only http.ts would make every honest mention of
 * `/v1/chat/completions` a false positive, and a gate that fires on honest prose
 * is a gate that gets deleted.
 *
 * The identifier alternation must carry every name the dispatch code compares
 * (`path`, `pathname`, `url`), and the optional-chain form must be matched as
 * `?.` — in an optional chain the `?` REPLACES the dot, so requiring a literal
 * dot after it matches nothing at all.
 */
export function registeredRoutes(root: string = ROOT): string[] {
  const src = routeSource(root);
  const found = new Set<string>();
  const IDENT = "(?:url|path|pathname)";
  for (const m of src.matchAll(new RegExp(`${IDENT}\\s*===\\s*"(\\/?[a-zA-Z0-9/_-]*)"`, "g"))) found.add(m[1]!);
  for (const m of src.matchAll(new RegExp(`${IDENT}(?:\\?\\.|\\.)\\s*startsWith\\("(\\/?[a-zA-Z0-9/_-]*)"`, "g"))) {
    // A bare version root (`/v1/`) is the PROXY branch, not an endpoint — but it
    // is still a real, servable NAMESPACE, so it is kept in its own set (below)
    // rather than dropped, and a skill naming `/v1` as a namespace is told true.
    if (/^\/v\d+\/?$/.test(m[1]!)) continue;
    found.add(m[1]!);
  }
  return [...found].sort();
}

/** Version NAMESPACES the daemon proxies (`/v1`), derived from the same scan.
 *  A skill that writes "`/v1` ignores `temperature`" is naming a namespace, not
 *  claiming an endpoint — failing that is a false positive on honest prose, so the
 *  namespace is recognised rather than rejected. Still DERIVED: nothing here is a
 *  hand-typed `/v1`. */
export function routeNamespaces(root: string = ROOT): string[] {
  const src = routeSource(root);
  const found = new Set<string>();
  for (const m of src.matchAll(new RegExp(`${"(?:url|path|pathname)"}(?:\\?\\.|\\.)\\s*startsWith\\("(\\/v\\d+)\\/?"`, "g"))) {
    found.add(m[1]!);
  }
  return [...found].sort();
}

function routeSource(root: string): string {
  return ROUTE_SRC_FILES.map((f) => readFileSync(join(root, f), "utf8")).join("\n");
}

/** Fenced blocks whose body is a payload, not prose: JSON/YAML data. A route
 *  token inside one is data, not a claim about the daemon's surface. */
function stripDataFences(text: string): string {
  return text.replace(/```[ \t]*([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)```/g, (all, info: string, body: string) =>
    /^(json|jsonc|json5|ya?ml|toml)$/i.test(info.trim()) ? "" : all,
  );
}

/** A route-shaped token: leading `/`, then path-ish characters. Templated segments
 *  (`<site>`, `<host>`) are allowed because a skill may write the templated form. */
const ROUTE_TOKEN_RE = /(^|[^\w.~/-])\/[a-zA-Z0-9][a-zA-Z0-9._~-]*(?:\/[a-zA-Z0-9<>{}._~-]+)*/g;

/** System roots that make a leading `/…` unambiguously a FILESYSTEM PATH rather
 *  than an HTTP route. Every real daemon route's first segment (`v1`, `prompt`,
 *  `registry`, `accounts`, `status`, …) is a word, never one of these, so
 *  requiring the first segment to be a real directory on disk is what separates
 *  the two shapes without a hand-typed route list.
 *
 *  DERIVED-BY-EXISTENCE rather than enumerated: `existsSync("/usr")` is true on
 *  every POSIX box, so this list is a set of PROBES, not policy. A path under a
 *  home or tmp tree resolves through the same test. */
function isFilesystemRoot(seg: string): boolean {
  return existsSync(join("/", seg)) || existsSync(join(ROOT, seg));
}

/** A route-shaped token that is really a PATH.
 *
 *  GAP: `ExecStart=/usr/bin/Xvfb` inside an operational skill was tokenised as
 *  the route `/usr/bin/Xvfb` and reported as an unregistered endpoint — a false
 *  positive on exactly the prose an agent needs in order to write a systemd unit
 *  verbatim. The check was paid for in real editing: the honest sentence had to
 *  be rewritten to dodge it.
 *
 *  Three shapes are recognised, each a path and never a claim:
 *   * a token with a FILE extension (`/tmp/out.log`) — the existing rule, widened;
 *   * a token whose FIRST segment is a real directory (`/usr/bin/Xvfb`,
 *     `/etc/systemd/system/x.service`) — the new rule;
 *   * a URI with an explicit scheme, so `file:///etc/hosts` is one token.
 *
 *  WHAT THIS DOES NOT COVER, stated plainly: a path under a directory that does
 *  not exist on the reader's box (`/opt/vendor/thing`) is still reported. The
 *  gate cannot distinguish "a route that happens to start like a path" from "a
 *  path on a machine I cannot see", so it reports and names the token; an author
 *  with such a path writes it as `` `/opt/vendor/thing` `` in a fenced data block
 *  (stripped by `stripDataFences`) or rewords. That residual is the honest limit
 *  of a filesystem test, not an oversight. */
function isPathToken(token: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return true;             // file://, ssh://, …
  if (/\.(?:ts|tsx|js|mjs|cjs|sh|bash|md|json|ya?ml|toml|lock|log|txt|conf|cfg|ini|service|socket|pid|so|dylib|dll|exe)$/i.test(token)) {
    return true;                                                       // a filename
  }
  const first = token.replace(/^\//, "").split("/")[0] ?? "";
  return first !== "" && isFilesystemRoot(first);
}

export interface RouteClaim {
  token: string;
  line: number;
}

/** Every route a skill ASSERTS, with its 1-based line. URLs are excluded (a `/`
 *  inside `https://…` is not a claim), and so is any token that is a real file
 *  path — by extension, by an on-disk first segment, or by existing under the
 *  repo root. */
export function routeClaims(sf: SkillFile, root: string = ROOT): RouteClaim[] {
  const stripped = stripDataFences(sf.text);
  const out: RouteClaim[] = [];
  const lines = stripped.split("\n");
  lines.forEach((line, i) => {
    const masked = line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
    for (const m of masked.matchAll(ROUTE_TOKEN_RE)) {
      const token = m[0].slice(m[1]!.length).replace(/\/+$/, "") || "/";
      if (token === "/") continue;                      // bare root, no claim
      if (isPathToken(token)) continue;                 // a path, not a route
      if (existsSync(join(root, token.replace(/^\//, "")))) continue;     // a real path on disk
      out.push({ token, line: i + 1 });
    }
  });
  return out;
}

/** Normalize a claimed route for comparison: templated and trailing-slash forms
 *  collapse, so `/capability/<site>` matches the registered prefix `/capability/`. */
function normalizeRoute(r: string): string {
  return r.replace(/\/+$/, "").replace(/\/[^/]*<[^/]*>[^/]*$/g, "");
}

export interface RouteViolation {
  file: string;
  line: number;
  token: string;
  fix: string;
}

/** Check 2. A claimed route the daemon does not register. */
export function routeViolations(sf: SkillFile, registered: string[], root: string = ROOT): RouteViolation[] {
  const regs = registered.map(normalizeRoute).filter(Boolean);
  const namespaces = new Set(routeNamespaces(root).map(normalizeRoute));
  const out: RouteViolation[] = [];
  const seen = new Set<string>();
  for (const c of routeClaims(sf, root)) {
    const norm = normalizeRoute(c.token);
    // A bare version root is a NAMESPACE the daemon proxies, not an endpoint.
    if (namespaces.has(norm)) continue;
    const known = regs.includes(norm) || regs.some((r) => r && norm.startsWith(`${r}/`));
    if (known) continue;
    if (seen.has(c.token)) continue;
    seen.add(c.token);
    out.push({
      file: sf.rel,
      line: c.line,
      token: c.token,
      fix: `the daemon registers ${registered.join(" ")} — drop the claim, or add the route to src/prompt/http.ts`,
    });
  }
  return out;
}

// ================================================================== knobs ===

const CODE_EXTENSIONS = [".ts", ".mjs", ".js", ".sh"] as const;

function codeFiles(dir: string, acc: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) codeFiles(p, acc);
    else if (CODE_EXTENSIONS.some((x) => e.name.endsWith(x))) acc.push(p);
  }
  return acc;
}

// The knob check asserts PRESENCE OF A LITERAL. That literal has to be CODE.
// A name that appears only inside a `//` comment is a note ABOUT a knob, not a
// knob: `// TODO: honour UI2API_PROBE_COMMENT_ONLY` satisfied the check, so a
// skill could name a knob nothing reads and the gate said nothing — the exact
// lie this check exists to catch. Comments are therefore blanked before the
// scan, which is why the measurement below is reported rather than assumed.
//
// WHAT IS NOT STRIPPED, and why each case is load-bearing:
//   * string literals — `"UI2API_X"` is how a knob is usually read at runtime;
//   * template literals — including the TEXT parts of `` `…${x}…` ``, where a
//     knob is named for a reader or written into a shell command line;
//   * regex literals — a `/…/` body can contain an escaped slash and must not be
//     mistaken for a `//` comment (the classic way a naive stripper eats the
//     rest of a line, taking a real knob with it).
// Blanked characters become SPACES, never deletions, so offsets and line numbers
// are unchanged and a bug here shows up as a missing knob rather than as a
// silently shifted read.
export function stripJsComments(src: string): string {
  const out = Array.from(src);
  const n = src.length;
  let i = 0;
  // A `/` opens a regex (not a division) when the last significant character
  // cannot end an expression. Without this, `url.replace(/\/\/h/g, "")` reads
  // the escaped pair as a line comment.
  const OPENS_REGEX = new Set("(,=:[!&|?{};+-*%~^<>".split(""));
  const KEYWORDS = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "case", "do", "else", "yield", "await", "throw",
  ]);
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const lastSignificant = (from: number): string => {
    let k = from - 1;
    while (k >= 0 && /\s/.test(src[k]!)) k--;
    if (k < 0) return "";
    if (/[A-Za-z0-9_$]/.test(src[k]!)) {
      let s = k;
      while (s >= 0 && /[A-Za-z0-9_$]/.test(src[s]!)) s--;
      return src.slice(s + 1, k + 1);
    }
    return src[k]!;
  };
  const matchBrace = (openIdx: number): number => {
    let depth = 0;
    let k = openIdx;
    while (k < n) {
      const ch = src[k]!;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return k; }
      else if (ch === '"' || ch === "'" || ch === "`") {
        const q = ch;
        k++;
        while (k < n) { if (src[k] === "\\") { k += 2; continue; } if (src[k] === q) break; k++; }
      } else if (ch === "/" && src[k + 1] === "/") { while (k < n && src[k] !== "\n") k++; continue; }
      else if (ch === "/" && src[k + 1] === "*") { k += 2; while (k < n && !(src[k] === "*" && src[k + 1] === "/")) k++; k++; }
      k++;
    }
    return n - 1;
  };
  // Scans [i, stop) and leaves `i` at `stop`. Recursive, because a `${…}` hole in
  // a template literal is CODE again — including its own comments, which the
  // first cut of this function skipped and therefore leaked a name through.
  const scan = (stop: number): void => {
    while (i < stop) {
      const c = src[i]!;
      const d = src[i + 1]!;
      if (c === "/" && d === "/") { let j = i; while (j < n && src[j] !== "\n") j++; blank(i, j); i = j; continue; }
      if (c === "/" && d === "*") {
        let j = i + 2;
        while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
        j = Math.min(n, j + 2);
        blank(i, j);
        i = j;
        continue;
      }
      if (c === '"' || c === "'") {
        i++;
        while (i < stop) { if (src[i] === "\\") { i += 2; continue; } if (src[i] === c) { i++; break; } i++; }
        continue;
      }
      if (c === "`") {
        i++;
        while (i < stop) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "`") { i++; break; }
          if (src[i] === "$" && src[i + 1] === "{") {
            i += 2;
            const close = matchBrace(i - 1);   // scans past nested strings/comments only
            scan(close);                       // …then strips the code inside it
            i = close + 1;
            continue;
          }
          i++;
        }
        continue;
      }
      if (c === "/") {
        const p = lastSignificant(i);
        if (p === "" || OPENS_REGEX.has(p) || KEYWORDS.has(p)) {
          i++;
          let inClass = false;
          while (i < stop) {
            const r = src[i]!;
            if (r === "\\") { i += 2; continue; }
            if (r === "[") inClass = true;
            else if (r === "]") inClass = false;
            else if (r === "/" && !inClass) { i++; break; }
            else if (r === "\n") break;
            i++;
          }
          while (i < stop && /[a-z]/.test(src[i]!)) i++;   // flags
          continue;
        }
      }
      i++;
    }
  };
  scan(n);
  return out.join("");
}

/** Shell comment stripper: `#` at the start of a line or after whitespace, and
 *  only outside quotes. Shell is scanned separately because the JS state machine
 *  would misread `'…'` and `$(…)` as JS. */
export function stripShellComments(src: string): string {
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

/** Code with every COMMENT blanked, whatever the language. */
export function stripComments(file: string, src: string): string {
  return /\.sh$/.test(file) ? stripShellComments(src) : stripJsComments(src);
}

/**
 * Every `UI2API_*` name appearing as a CODE literal in `src/**` or `scripts/**`.
 * `.sh` is included on purpose: `scripts/ops/*.sh` read knobs too.
 *
 *  COMMENTS ARE EXCLUDED (see `stripJsComments`). The union is taken across all
 *  files, so a knob named in one file's comment and in another file's code is
 *  still a real knob — which is why `commentOnlyKnobs` is a DISCLOSURE rather
 *  than a filter: it names the names that exist ONLY as prose about code.
 *
 *  This asserts PRESENCE OF THE LITERAL, never `process.env` readability — which
 *  is why `UI2API_VERSION` needs no exemption: it is a local `const` reading
 *  package.json (AGENTS.md says so explicitly) and it IS in `src/`, so it passes
 *  for the honest reason rather than a special case. */
export function knobsInCode(root: string = ROOT): Set<string> {
  const out = new Set<string>();
  for (const f of codeSourceFiles(root)) {
    for (const m of stripComments(f, readFileSync(f, "utf8")).matchAll(/UI2API_[A-Z0-9_]+/g)) out.add(m[0]);
  }
  return out;
}

/** Names that appear ONLY inside comments — i.e. every mention of them was a
 *  note about a knob, and no shipped code reads them. DISCLOSED, not silent:
 *  this is the measurement that makes the comment exclusion auditable, and the
 *  count is asserted to stay small in the CHECK 3 test. */
export function commentOnlyKnobs(root: string = ROOT): string[] {
  const inCode = new Set<string>();
  const anywhere = new Set<string>();
  for (const f of codeSourceFiles(root)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/UI2API_[A-Z0-9_]+/g)) anywhere.add(m[0]);
    for (const m of stripComments(f, src).matchAll(/UI2API_[A-Z0-9_]+/g)) inCode.add(m[0]);
  }
  return [...anywhere].filter((k) => !inCode.has(k)).sort();
}

/** Every scanned code file, once. Split out so the knob set and the comment-only
 *  disclosure cannot drift into scanning different trees. */
function codeSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const dir of ["src", "scripts"]) {
    for (const f of codeFiles(join(root, dir))) out.push(f);
  }
  return out;
}

/** Every knob a skill names. A BARE `UI2API_*` wildcard or a family PREFIX with no
 *  member (`UI2API_WIGOLO_`) is dropped here and reported separately: the prefix is
 *  a table label, not a knob — but a MEMBER that does not exist must still fail. */
export interface KnobClaim {
  name: string;
  line: number;
  /** True for `UI2API_` (the `UI2API_*` wildcard) and for a bare family PREFIX
   *  whose remainder carries no letters (`UI2API_WIGOLO_`). A bare prefix is a
   *  table label, not a knob — but a MEMBER like `UI2API_WIGOLO_ALLOW_REMOTE`
   *  carries letters and is checked for real. */
  bareLabel: boolean;
}

export function knobClaims(sf: SkillFile): KnobClaim[] {
  const out: KnobClaim[] = [];
  sf.text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/UI2API_[A-Z0-9_]+/g)) {
      const name = m[0];
      const body = name.slice("UI2API_".length);
      // A family PREFIX is recognised by its TRAILING underscore, not by the
      // absence of letters: `UI2API_WIGOLO_` ends in `_` and is a label, while
      // `UI2API_WIGOLO_ALLOW_REMOTE` does not and is a real member to check.
      out.push({ name, line: i + 1, bareLabel: body === "" || body.endsWith("_") });
    }
  });
  return out;
}

export interface KnobViolation {
  file: string;
  line: number;
  token: string;
  fix: string;
}

/** Check 3. A knob name no shipped code contains. */
export function knobViolations(sf: SkillFile, known: Set<string>): KnobViolation[] {
  const out: KnobViolation[] = [];
  const seen = new Set<string>();
  for (const c of knobClaims(sf)) {
    if (c.bareLabel) continue;   // the `UI2API_*` wildcard and a bare family prefix
    if (known.has(c.name)) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      file: sf.rel,
      line: c.line,
      token: c.name,
      fix: "nothing in src/ or scripts/ contains this name — the knob does not exist, or the real one has a different spelling",
    });
  }
  return out;
}

// =============================================================== site ids ===

/** `capabilities/` directories with NO `manifest.json`. These are NOT servable: the
 *  registry, `/capability/<id>` and `install` all key off the manifest, so a
 *  skill naming such an id as usable is claiming a package that does not exist.
 *  `hunyuan-yuanbao/` is the repo's one: a deliberately-skipped legacy dir kept
 *  for its `CAPABILITIES.md` notes. */
export function capabilitiesWithoutManifest(root: string = ROOT): string[] {
  try {
    return readdirSync(join(root, "capabilities"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !existsSync(join(root, "capabilities", name, "manifest.json")))
      .sort();
  } catch {
    return [];
  }
}

/** Every site id that RESOLVES: a directory under `capabilities/` THAT SHIPS A
 *  MANIFEST, or a key of `BUILTIN_PROFILES` (imported, not regexed — a profile
 *  key is code, not prose).
 *
 *  The manifest requirement is the fix for a hole the plain-directory rule left:
 *  `capabilities/hunyuan-yuanbao/` has no manifest, so nothing can install or
 *  serve it, yet `--site hunyuan-yuanbao` passed and a skill could tell an agent
 *  a site was usable when no package is installed. The BUILTIN_PROFILES arm is
 *  kept whole, which is what lets a profile-only id resolve — every current
 *  builtin happens to have a package too, but that is a coincidence of today's
 *  repo, not the contract, and pinning it would be the hand-typed list this file
 *  forbids. */
export function resolvableSiteIds(root: string = ROOT): Set<string> {
  const out = new Set<string>(Object.keys(BUILTIN_PROFILES));
  const missing = new Set(capabilitiesWithoutManifest(root));
  try {
    for (const e of readdirSync(join(root, "capabilities"), { withFileTypes: true })) {
      if (e.isDirectory()) out.add(e.name);
    }
  } catch {
    /* no capabilities dir: BUILTIN_PROFILES still stands */
  }
  for (const name of missing) out.delete(name);
  return out;
}

/** Contexts that make a token a site-id CANDIDATE. Deliberately narrow: without a
 *  context test the gate fires on ordinary English words and becomes noise. */
const SITE_CONTEXT_RES: RegExp[] = [
  // `capabilities/<id>` — but NOT `src/capabilities/<file>.ts`. A source FILE
  // under src/capabilities/ is a path reference, not a site id, and treating
  // `src/capabilities/gated.ts` as an id called `gated` is a false positive on
  // honest prose. Hence the negative lookahead on a code extension.
  /(?<!src\/)capabilities\/([a-z0-9][a-z0-9-]*)(?![a-z0-9-]*\.[a-z])/g,   // capabilities/<id>
  /--site[=\s]+["']?([a-z0-9][a-z0-9-]*)/g,                               // --site <id>
  /["']site["']\s*:\s*["']([a-z0-9][a-z0-9-]*)["']/g,                     // "site": "<id>"
  /\/capability\/([a-z0-9][a-z0-9-]*)/g,                                  // POST /capability/<id>
];

export interface SiteClaim {
  token: string;
  line: number;
}

export function siteClaims(sf: SkillFile): SiteClaim[] {
  const out: SiteClaim[] = [];
  sf.text.split("\n").forEach((line, i) => {
    for (const re of SITE_CONTEXT_RES) {
      for (const m of line.matchAll(re)) out.push({ token: m[1]!, line: i + 1 });
    }
  });
  return out;
}

export interface SiteViolation {
  file: string;
  line: number;
  token: string;
  fix: string;
}

/** Check 4. A site id that resolves to nothing. */
export function siteViolations(sf: SkillFile, known: Set<string>): SiteViolation[] {
  const out: SiteViolation[] = [];
  const seen = new Set<string>();
  for (const c of siteClaims(sf)) {
    if (known.has(c.token)) continue;
    if (seen.has(c.token)) continue;
    seen.add(c.token);
    out.push({
      file: sf.rel,
      line: c.line,
      token: c.token,
      fix: `no capabilities/${c.token}/ directory and no BUILTIN_PROFILES key \`${c.token}\` — run \`ls capabilities/\` or \`prompt --sites\` to get a real id`,
    });
  }
  return out;
}

// =========================================================== counts + line ==

/** Nouns that name THE SURFACE. A count only rots when it counts something the
 *  repo owns — packages, models, sites — so the noun is what separates a rot
 *  risk from ordinary prose: "a two-minute read" and "a dozen probes" are both
 *  number+noun, and neither noun is here. */
const SURFACE_NOUNS =
  String.raw`(?:chat\s+models?|models?|packages?|verified\s+sites?|sites?|builtins?|capabilit(?:y|ies)|services?)`;

/** How a count may be SPELLED.
 *
 *  Two arms, and the second is deliberately narrow. Digits are unambiguous. A
 *  spelled-out number is NOT: the real skills contain honest prose like
 *  "Measured on one site, one request" and "Two execution models", where "one"
 *  and "Two" count the sentence, not the surface — firing on those would be a
 *  false positive on prose the gate is required to accept. So a spelled count
 *  fires only in the DOZEN family, where "two dozen packages" and "a couple of
 *  dozen packages" are unambiguously claims about a set big enough to rot.
 *
 *  RESIDUAL LIMIT, stated rather than implied: a spelled count of the form
 *  "three packages" (small, no "dozen") is NOT caught, and neither is a count
 *  in another language. Bare small numbers are the ones an author is least
 *  likely to write as a rot claim, and they collide directly with prose the
 *  gate must accept — so this is a disclosed narrowing, not total coverage. */
const COUNT_QUANTITY =
  String.raw`(?:\d+[\s-]+|(?:a\s+couple\s+of\s+)?(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+)?dozens?(?:\s+of)?[\s-]+)`;

/** Bare count claims about the surface — the shape that rots silently.
 *
 *  Hyphenated compounds are covered because that is how the count is written
 *  when it modifies a noun: "the 33-package inventory", "the 22-model surface".
 *  The old pattern required whitespace, so both of those passed. */
export function countClaims(sf: SkillFile): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`\b${COUNT_QUANTITY}${SURFACE_NOUNS}\b`, "gi");
  sf.text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(re)) {
      out.push(`${sf.rel}:${i + 1}: \`${m[0].trim()}\``);
    }
  });
  return out;
}

/**
 * True when the file carries the contract line.
 *
 * DECORATION-TOLERANT, SENTENCE-EXACT — a narrowing made from measurement, not
 * taste. The three real skills each carry the sentence in a DIFFERENT markdown
 * form: bare on its own line, as a list item (`- …`), wrapped in bold
 * (`**…**`), and mid-sentence after an introductory clause. A gate matching only
 * the bare-own-line form fails all three, i.e. it fails every honest skill in
 * the family — which is precisely the "fires on honest prose, so it gets skipped"
 * outcome this repo already recorded for the line-exact knob cite.
 *
 * What is NOT relaxed is the SENTENCE: the line must contain
 * `${CONTRACT_LINE}` verbatim once markdown decoration (`**`, `*`, backticks,
 * a leading list bullet or ordered marker) is stripped. A paraphrase, a
 * near-miss word, or the sentence reworded does not satisfy it.
 */
export function missingContractLine(sf: SkillFile): boolean {
  return !sf.text.split("\n").some((raw) => {
    const line = raw
      .trim()
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/\*\*|__|`/g, "")
      .trim();
    return line.includes(CONTRACT_LINE);
  });
}

// ================================================================ fixtures ==

const FILES = skillFiles();
const DIRS = skillDirs();
const MISSING_MD = dirsMissingSkillFile();
const ROUTES = registeredRoutes();
const KNOBS = knobsInCode();
const COMMENT_ONLY = commentOnlyKnobs();
const SITES = resolvableSiteIds();
const NO_MANIFEST = capabilitiesWithoutManifest();

const fmt = (v: { file: string; line?: number; token: string; problem?: string }[]) =>
  v.map((x) => (x.line ? `${x.file}:${x.line} \`${x.token}\`${x.problem ? ` — ${x.problem}` : ""}` : `${x.file} \`${x.token}\`${x.problem ? ` — ${x.problem}` : ""}`));

// =================================================================== tests ==

t("the gate's own premise: skills/*/SKILL.md files exist and are non-empty", () => {
  assert.ok(DIRS.length > 0, `no skills/*/ directories found — the family is missing (looked in ${join(ROOT, "skills")})`);
  assert.ok(
    FILES.length > 0,
    `no skill files found: ${DIRS.length} skills/*/ director${DIRS.length === 1 ? "y" : "ies"} exist but none carries a SKILL.md — ` +
      `an unfindable skill is the same rot as a gitignored one`,
  );
  for (const sf of FILES) {
    assert.ok(sf.text.trim().length > 0, `${sf.rel} is empty — an empty skill teaches nothing and gates nothing`);
  }
});

t("every skills/<dir>/ directory carries a SKILL.md (a half-written skill fails)", () => {
  assert.deepEqual(
    MISSING_MD,
    [],
    `skills/ directories with no SKILL.md: ${MISSING_MD.join(" ")} — a directory a reader cannot find is a skill that never shipped`,
  );
});

t("CHECK 1 — frontmatter keys are exactly name+description, and name equals the directory", () => {
  assert.ok(FILES.length > 0, "precondition: at least one skill file to check");
  const bad = FILES.flatMap(frontmatterViolations);
  assert.deepEqual(bad, [], `frontmatter violations:\n  ${bad.map((v) => `${v.file} — ${v.problem}\n    fix: ${v.fix}`).join("\n  ")}`);
  // Non-vacuity: the real skills must be scanned, not skipped.
  const scanned = FILES.filter((sf) => parseFrontmatter(sf.text).present).length;
  assert.equal(scanned, FILES.length, "every skill's frontmatter was parsed");
});

t("CHECK 2 — every route a skill names is a route the daemon registers", (ctx: TestContext) => {
  assert.ok(ROUTES.length >= 8, `non-vacuity: derived only ${ROUTES.length} routes from ${ROUTE_SRC_FILES.join("+")} — the dispatch scan stopped reading`);
  const bad = FILES.flatMap((sf) => routeViolations(sf, ROUTES));
  assert.deepEqual(
    bad,
    [],
    `routes named in skills that the daemon does not register:\n  ${bad.map((v) => `${v.file}:${v.line} \`${v.token}\`\n    fix: ${v.fix}`).join("\n  ")}`,
  );
  ctx.diagnostic(`routes derived from ${ROUTE_SRC_FILES.join(" + ")}: ${ROUTES.join(" ")}`);
});

t("CHECK 3 — every UI2API_* knob a skill names exists as a literal in src/ or scripts/", (ctx: TestContext) => {
  assert.ok(KNOBS.size >= 40, `non-vacuity: read only ${KNOBS.size} UI2API_* literals out of src/+scripts/ — the code scan stopped reading`);
  const bad = FILES.flatMap((sf) => knobViolations(sf, KNOBS));
  assert.deepEqual(
    bad,
    [],
    `knobs named in skills that nothing in src/ or scripts/ reads:\n  ${bad.map((v) => `${v.file}:${v.line} \`${v.token}\`\n    fix: ${v.fix}`).join("\n  ")}`,
  );
  // UI2API_VERSION is a local const reading package.json, NOT an env knob. It
  // passes because the literal is in src/ — this asserts presence, never
  // process.env readability, which is what keeps AGENTS.md's note true.
  assert.ok(KNOBS.has("UI2API_VERSION"), "precondition: UI2API_VERSION is a literal in src/ (see src/registry/package.ts)");
  // The comment exclusion is a DISCLOSED measurement, not a silent filter: a name
  // that exists only inside a comment is prose about a knob, and the count is
  // small by construction (today: the dead knob AGENTS.md documents as such).
  // It is asserted as a BOUND that must not grow, because a growing set means
  // real knobs are being read out of comments and accepted for the wrong reason.
  assert.ok(
    COMMENT_ONLY.length <= 4,
    `comment-only UI2API_* names grew to ${COMMENT_ONLY.length} (${COMMENT_ONLY.join(" ")}) — ` +
      `each is a knob nothing reads, accepted by the old scan; check whether a real knob moved into a comment`,
  );
  assert.ok(
    KNOBS.has("UI2API_DATA_DIR"),
    "precondition: a knob whose ONLY scripts/ mention is a comment is still known, because src/ reads it (union across files)",
  );
  ctx.diagnostic(`UI2API_* CODE literals derived from src/+scripts/: ${KNOBS.size}`);
  ctx.diagnostic(`comment-only UI2API_* names excluded (disclosed, not silent): ${COMMENT_ONLY.length} — ${COMMENT_ONLY.join(" ") || "(none)"}`);
});

t("CHECK 4 — every site id a skill names resolves to a capabilities/ dir that ships a manifest, or a BUILTIN_PROFILES key", (ctx: TestContext) => {
  assert.ok(SITES.size >= 20, `non-vacuity: only ${SITES.size} resolvable site ids derived — the derivation stopped reading`);
  // A manifest-less dir is NOT resolvable, and the exclusion is disclosed rather
  // than silent so a reader can see which dirs the check is refusing.
  for (const name of NO_MANIFEST) {
    assert.ok(
      !SITES.has(name) || Object.keys(BUILTIN_PROFILES).includes(name),
      `capabilities/${name}/ has no manifest.json and no BUILTIN_PROFILES key, so it must not count as resolvable`,
    );
  }
  const bad = FILES.flatMap((sf) => siteViolations(sf, SITES));
  assert.deepEqual(
    bad,
    [],
    `site ids named in skills that resolve to nothing:\n  ${bad.map((v) => `${v.file}:${v.line} \`${v.token}\`\n    fix: ${v.fix}`).join("\n  ")}`,
  );
  ctx.diagnostic(`capabilities/ dirs with no manifest.json (not resolvable): ${NO_MANIFEST.join(" ") || "(none)"}`);
});

t("CHECK 5a — no skill makes a bare count claim about the surface", () => {
  assert.ok(FILES.length > 0, "precondition: at least one skill file to check");
  const bad = FILES.flatMap(countClaims);
  assert.deepEqual(
    bad,
    [],
    `bare count claims in skills (counts rot; give the command that derives it instead):\n  ${bad.join("\n  ")}`,
  );
});

t("CHECK 5b — every skill carries the exact contract line", () => {
  assert.ok(FILES.length > 0, "precondition: at least one skill file to check");
  const missing = FILES.filter(missingContractLine).map((sf) => sf.rel);
  assert.deepEqual(
    missing,
    [],
    `skills without the contract line: ${missing.join(" ")} — add this exact line, on its own line:\n    ${CONTRACT_LINE}`,
  );
});

// ============================================================== mutation ====
// Each check fed a deliberately BAD skill, through the SAME exported predicate
// the real tests use. Without this, "green" could mean "the predicate found
// nothing" and the gate would be decorative.

const BAD: SkillFile = {
  rel: "skills/<fixture>/SKILL.md",
  dir: "<fixture>",
  text: [
    "---",
    "name: wrong-name",
    "description: a fixture",
    "tools:",
    "- some_tool: does a thing",
    "---",
    "",
    "Ask `POST /not-a-real-route` and read `GET /registry`.",
    "Set `UI2API_TOTALLY_MADE_UP=1` before running.",
    "There are 22 chat models and 33 packages available.",
    "Use `--site definitely-not-a-site` for the ghost.",
    "See `src/prompt/driver.ts` and https://example.com/v1/fake for details.",
  ].join("\n"),
};

t("MUTATION: the frontmatter check fires on a tools: key and a name/dir mismatch", () => {
  const v = frontmatterViolations(BAD);
  const problems = v.map((x) => x.problem).join(" | ");
  assert.ok(v.some((x) => x.problem.includes("tools")), `a \`tools:\` key must be reported; got: ${problems}`);
  assert.ok(v.some((x) => x.problem.includes("does not equal its directory name")), `a name/dir mismatch must be reported; got: ${problems}`);
  assert.ok(v.some((x) => x.problem.includes("description")), `the folded/absent description shape must be reported; got: ${problems}`);
  // And the REAL skills are clean on this check, so the mutation is what fired.
  assert.deepEqual(FILES.flatMap(frontmatterViolations), [], "precondition: the real skills pass check 1");
});

t("MUTATION: the route check fires on an unregistered route and NOT on a real one, a file path, or a URL", () => {
  const v = routeViolations(BAD, ROUTES);
  assert.deepEqual(v.map((x) => x.token), ["/not-a-real-route"], `only the fake route must be reported, got ${fmt(v)}`);
  assert.ok(v[0]!.line > 0, "the violation names the line so the author can jump to it");
  assert.ok(ROUTES.some((r) => r.startsWith("/registry")), "precondition: /registry is a registered route the fixture also names");
  // Templated form accepted: `/capability/<site>` normalizes onto the registered prefix.
  const templated = routeViolations(
    { rel: "x", dir: "x", text: "Call `POST /capability/<site>` and `GET /v1/chat/completions`." },
    ROUTES,
  );
  assert.deepEqual(templated, [], "a skill may write the templated route form");
});

t("MUTATION: the knob check fires on a made-up knob, accepts a real one, and accepts a bare family prefix", () => {
  const v = knobViolations(BAD, KNOBS);
  assert.deepEqual(v.map((x) => x.token), ["UI2API_TOTALLY_MADE_UP"], `only the fake knob must be reported, got ${fmt(v)}`);
  assert.ok(KNOBS.has("UI2API_PROMPTD_TOKEN"), "precondition: a known-good knob exists to prove acceptance");
  assert.deepEqual(
    knobViolations({ rel: "x", dir: "x", text: "`UI2API_PROMPTD_TOKEN` gates it and `UI2API_WIGOLO_` is the family." }, KNOBS),
    [],
    "a real knob and a bare family PREFIX must both pass",
  );
  // …but a MEMBER of that family that does not exist must still fail.
  assert.deepEqual(
    knobViolations({ rel: "x", dir: "x", text: "`UI2API_WIGOLO_NOT_A_MEMBER`" }, KNOBS).map((x) => x.token),
    ["UI2API_WIGOLO_NOT_A_MEMBER"],
    "a non-existent family member must fail even though the bare prefix passes",
  );
});

t("MUTATION: the site-id check fires on an unresolvable id and accepts a real one", () => {
  const v = siteViolations(BAD, SITES);
  assert.deepEqual(v.map((x) => x.token), ["definitely-not-a-site"], `only the fake id must be reported, got ${fmt(v)}`);
  assert.ok(SITES.has("gemini"), "precondition: a resolvable id exists to prove acceptance");
  assert.deepEqual(
    siteViolations({ rel: "x", dir: "x", text: "Run `--site gemini` and `--site duckduckgo`." }, SITES),
    [],
    "a packaged id and a builtin-profile id must both resolve",
  );
  // Context discipline: an ordinary lowercase word is NOT a site-id candidate.
  assert.deepEqual(
    siteClaims({ rel: "x", dir: "x", text: "The browser should never fabricate a reply, and neither should the pool." }),
    [],
    "ordinary prose must not be read as a site id — a gate that fires on English is a gate nobody reads",
  );
});

t("MUTATION: the count check fires on bare count claims and the contract line is required exactly", () => {
  const claims = countClaims(BAD);
  assert.ok(claims.some((c) => c.includes("22 chat models")), `a bare chat-model count must be reported, got ${JSON.stringify(claims)}`);
  assert.ok(claims.some((c) => c.includes("33 packages")), `a bare package count must be reported, got ${JSON.stringify(claims)}`);
  assert.ok(missingContractLine(BAD), "a skill without the contract line must be reported");
  // …and the tolerance is for MARKDOWN DECORATION only, never for a paraphrase.
  // This is the half that keeps the narrowing from becoming a no-op.
  for (const rewrite of [
    "Derive live state, never trust a count in this file.",
    "Never trust a count in this file.",
    "Derive live state; never trust a count here.",
    "trust a count in this file",
  ]) {
    assert.ok(
      missingContractLine({ rel: "x", dir: "x", text: rewrite }),
      `a PARAPHRASE must not satisfy the contract line: ${JSON.stringify(rewrite)}`,
    );
  }
  for (const decorated of [
    "- Derive live state; never trust a count in this file.",
    "**Derive live state; never trust a count in this file.** Derive the live surface",
    "Everything below is derived from the daemon. Derive live state; never trust a count in this file.",
  ]) {
    assert.ok(
      !missingContractLine({ rel: "x", dir: "x", text: decorated }),
      `markdown decoration must not be punished: ${JSON.stringify(decorated)}`,
    );
  }
  // The real skills state no counts and carry the line, so both checks are live.
  assert.deepEqual(FILES.flatMap(countClaims), [], "precondition: the real skills make no bare count claim");
  for (const sf of FILES) {
    assert.ok(!missingContractLine(sf), `precondition: ${sf.rel} carries the contract line`);
  }
});

// ====================================================== gap mutation tests ====
// One mutation test per gap this file was strengthened for. Each fires on the
// bad input the gap was opened by AND stays quiet on the honest input next to
// it — the second half is what makes these usable: a check that only proves it
// can fail is a check nobody can rely on.

t("MUTATION: the knob check IGNORES comments — a comment-only knob fails, and a knob in code/string/template passes", (ctx: TestContext) => {
  // The bad input, planted the way the gap was found: the name appears in a
  // comment in real source, and nowhere else.
  const planted = mkTempTree({
    "src/x.ts": ["// TODO: honour UI2API_PROBE_COMMENT_ONLY when the seam lands", "export const a = 1;"],
    "src/y.ts": ["/* UI2API_PROBE_BLOCK_COMMENT is not read either */", "export const b = 2;"],
  });
  let real = "";
  let sh = "";
  try {
    const known = knobsInCode(planted);
    assert.ok(
      !known.has("UI2API_PROBE_COMMENT_ONLY"),
      "a name that appears ONLY inside a `//` comment must NOT count as a knob — that is the lie this check exists to catch",
    );
    assert.ok(
      !known.has("UI2API_PROBE_BLOCK_COMMENT"),
      "a name that appears ONLY inside a `/* */` comment must not count either",
    );
    assert.deepEqual(
      knobViolations({ rel: "skills/f/SKILL.md", dir: "f", text: "Set `UI2API_PROBE_COMMENT_ONLY=1`." }, known),
      [
        {
          file: "skills/f/SKILL.md",
          line: 1,
          token: "UI2API_PROBE_COMMENT_ONLY",
          fix: "nothing in src/ or scripts/ contains this name — the knob does not exist, or the real one has a different spelling",
        },
      ],
      "a skill naming the comment-only knob must be reported",
    );
    // …and the honest half: a knob that is really READ must survive the stripper,
    // in each of the three shapes that a naive comment stripper destroys.
    real = mkTempTree({
      "src/a.ts": ['export const E = "UI2API_PROBE_STRING";'],
      "src/b.ts": ["export const T = `UI2API_PROBE_TEMPLATE ${1} tail`;"],
      "src/c.ts": ["export const R = /\\/\\/ UI2API_PROBE_REGEX/;", "// UI2API_PROBE_GONE"],
      "src/d.ts": ["export const X = `${1 /* UI2API_PROBE_EXPR_COMMENT */}`; export const Y = 'UI2API_PROBE_AFTER_EXPR';"],
    });
    const realKnobs = knobsInCode(real);
    for (const keep of [
      "UI2API_PROBE_STRING",
      "UI2API_PROBE_TEMPLATE",
      "UI2API_PROBE_REGEX",
      "UI2API_PROBE_AFTER_EXPR",
    ]) {
      assert.ok(realKnobs.has(keep), `a REAL knob must survive comment stripping: ${keep} (got ${[...realKnobs].join(" ")})`);
    }
    assert.ok(!realKnobs.has("UI2API_PROBE_GONE"), "a `//` comment in the same file is still excluded");
    assert.ok(!realKnobs.has("UI2API_PROBE_EXPR_COMMENT"), "a comment inside a `${}` expression is still excluded");
    // Shell is scanned by its own stripper, and a real shell read still counts.
    sh = mkTempTree({
      "scripts/ops/thing.sh": ['#!/bin/sh', '# UI2API_PROBE_SH_COMMENT', 'export UI2API_PROBE_SH_REAL=1'],
    });
    const shKnobs = knobsInCode(sh);
    assert.ok(shKnobs.has("UI2API_PROBE_SH_REAL"), "a real shell read must survive shell comment stripping");
    assert.ok(!shKnobs.has("UI2API_PROBE_SH_COMMENT"), "a `#` comment in a shell script must not count as a knob");
    // The measured real-tree effect, disclosed rather than assumed.
    assert.ok(
      !KNOBS.has("UI2API_AI_PROFILE"),
      "precondition for the measurement: UI2API_AI_PROFILE survives ONLY as a comment in src/profile/profile.ts",
    );
    ctx.diagnostic(`real tree: ${KNOBS.size} code knobs, ${COMMENT_ONLY.length} comment-only excluded`);
  } finally {
    rmSync(planted, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
    rmSync(sh, { recursive: true, force: true });
  }
});

t("MUTATION: the site-id check rejects a manifest-less capabilities/ dir and keeps the BUILTIN_PROFILES arm working", () => {
  const planted = mkTempTree({
    "capabilities/real-pkg/manifest.json": '{"id":"real-pkg"}',
    "capabilities/legacy-dir/CAPABILITIES.md": "# notes only, no manifest\n",
  });
  try {
    const ids = resolvableSiteIds(planted);
    assert.ok(ids.has("real-pkg"), "a dir that ships a manifest must resolve");
    assert.ok(!ids.has("legacy-dir"), "a dir with NO manifest must NOT resolve — nothing can install or serve it");
    assert.deepEqual(
      capabilitiesWithoutManifest(planted),
      ["legacy-dir"],
      "the manifest-less dir is named explicitly, so the exclusion is disclosed",
    );
    assert.deepEqual(
      siteViolations({ rel: "skills/f/SKILL.md", dir: "f", text: "Run `--site legacy-dir`." }, ids).map((v) => v.token),
      ["legacy-dir"],
      "a skill claiming a manifest-less dir is usable must be reported",
    );
  } finally {
    rmSync(planted, { recursive: true, force: true });
  }
  // The REAL repo: the one manifest-less dir is the deliberately-skipped legacy
  // one, and the gate fires on it exactly as the verifier's probe required.
  assert.deepEqual(NO_MANIFEST, ["hunyuan-yuanbao"], "the real repo's manifest-less dir is the legacy one");
  assert.ok(!SITES.has("hunyuan-yuanbao"), "`--site hunyuan-yuanbao` must not resolve");
  assert.deepEqual(
    siteViolations({ rel: "skills/f/SKILL.md", dir: "f", text: "Try `--site hunyuan-yuanbao`." }, SITES).map((v) => v.token),
    ["hunyuan-yuanbao"],
    "the verifier's probe must now fire",
  );
  // The second arm is NOT a coincidence-of-today arm: a BUILTIN_PROFILES key with
  // no capabilities dir at all still resolves.
  assert.ok(
    Object.keys(BUILTIN_PROFILES).length > 0,
    "precondition: BUILTIN_PROFILES is non-empty, so the arm is live",
  );
  const profileOnly = mkTempTree({ "capabilities/other/manifest.json": "{}" });
  try {
    const only = resolvableSiteIds(profileOnly);
    for (const k of Object.keys(BUILTIN_PROFILES)) {
      assert.ok(only.has(k), `a BUILTIN_PROFILES key must resolve even with no capabilities/${k} dir: ${k}`);
    }
  } finally {
    rmSync(profileOnly, { recursive: true, force: true });
  }
});

t("MUTATION: the count check catches hyphenated and dozen phrasings, and stays quiet on honest non-surface prose", () => {
  for (const claim of [
    "the 33-package inventory",
    "the 22-model surface",
    "two dozen packages",
    "a couple of dozen packages",
    "dozens of sites",
    "There are 22 chat models.",
  ]) {
    const hits = countClaims({ rel: "skills/f/SKILL.md", dir: "f", text: claim });
    assert.ok(hits.length > 0, `a bare count claim must be reported: ${JSON.stringify(claim)}`);
  }
  // The honest half — number+noun prose that is NOT a claim about the surface.
  // "one site" and "two execution models" are verbatim from the real skills, and
  // the old whitespace-only pattern already let them through; the new DOZEN arm
  // must not widen the net onto them.
  for (const honest of [
    "a two-minute read",
    "a dozen probes",
    "Measured on one site, one request, changing only headfulness",
    "Two execution models sit behind one launch seam",
    "one honest answer beats ten guesses",
    "a 200 from any base can never be the page's answer",
    "First 60 seconds",
    "one provider per active package",
  ]) {
    assert.deepEqual(
      countClaims({ rel: "skills/f/SKILL.md", dir: "f", text: honest }),
      [],
      `honest prose must not be read as a count claim: ${JSON.stringify(honest)}`,
    );
  }
  // The real skills are the strongest honest sample available, and they are
  // asserted clean by CHECK 5a — re-asserted here so this narrowing is tied to
  // the sample that motivated it.
  assert.deepEqual(FILES.flatMap(countClaims), [], "precondition: the real skills make no bare count claim");
});

t("MUTATION: a CRLF skill fails for the CRLF reason, not for a phantom missing key", () => {
  const lf = ["---", "name: crlf-fixture", "description: >-", "  a folded description", "---", "", "body"].join("\n");
  const crlfText = lf.replace(/\n/g, "\r\n");
  const bad = frontmatterViolations({ rel: "skills/crlf-fixture/SKILL.md", dir: "crlf-fixture", text: crlfText });
  assert.equal(bad.length, 1, `a CRLF skill must fail with ONE named problem, got ${JSON.stringify(bad, null, 1)}`);
  assert.match(bad[0]!.problem, /CRLF/i, `the problem must name CRLF, got: ${bad[0]!.problem}`);
  assert.match(bad[0]!.fix, /LF/i, `the fix must say how to get LF endings, got: ${bad[0]!.fix}`);
  assert.ok(
    !bad.some((v) => /no `name` key|no `description` key/.test(v.problem)),
    "the phantom \"no `name` key\" problems are the defect this closes — the keys ARE in the file",
  );
  // The same content with LF endings is CLEAN: the failure is the line endings,
  // not the frontmatter.
  assert.deepEqual(
    frontmatterViolations({ rel: "skills/crlf-fixture/SKILL.md", dir: "crlf-fixture", text: lf }),
    [],
    "identical frontmatter with LF endings must pass",
  );
  // And a CRLF file that ALSO has a real problem is not shielded: it still fails,
  // and once the endings are fixed the real problem is reported.
  assert.equal(
    frontmatterViolations({ rel: "x", dir: "y", text: crlfText.replace("name: crlf-fixture", "name: wrong") }).length,
    1,
    "a CRLF file with a name/dir mismatch still fails (on the CRLF), so it is never silently accepted",
  );
});

t("MUTATION: an absolute filesystem path in a shell command is NOT a route, and a fake route still is", (ctx: TestContext) => {
  // The exact honest prose a sibling had to rewrite to dodge the old check.
  const honest = routeViolations(
    {
      rel: "skills/f/SKILL.md",
      dir: "f",
      text:
        "The xvfb unit runs `ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp`.\n" +
        "`Environment=DISPLAY=:99`, and the chrome unit carries `ExecStart=/usr/bin/google-chrome`.\n" +
        "Read the generated unit at `/etc/systemd/system/ui2api-chrome.service` and the log at `/tmp/xvfb.log`.",
    },
    ROUTES,
  );
  assert.deepEqual(honest, [], `absolute paths in operational prose must not be read as routes, got ${fmt(honest)}`);
  // A file:// URI is one token, and a path is a path.
  assert.deepEqual(
    routeViolations({ rel: "x", dir: "x", text: "See `file:///usr/lib/x/y.conf` and `/home/me/notes.md`." }, ROUTES),
    [],
    "a file:// URI and an absolute path under a home dir are paths, not routes",
  );
  // …and the check did not become a no-op: the fake route still fires, on both
  // the single-segment and the nested form, with its line.
  const fake = routeViolations(
    { rel: "skills/f/SKILL.md", dir: "f", text: "first line\nask GET /nope-not-real\nand POST /nope-not-real/deep" },
    ROUTES,
  );
  assert.deepEqual(
    fake.map((v) => v.token),
    ["/nope-not-real", "/nope-not-real/deep"],
    `a fake route must still be reported, got ${fmt(fake)}`,
  );
  assert.deepEqual(fake.map((v) => v.line), [2, 3], "the violation names the line so the author can jump to it");
  // A registered route is still a route even though `capabilities` is a real dir
  // on disk — the path rule must not swallow `/capabilities`.
  assert.deepEqual(
    routeViolations({ rel: "x", dir: "x", text: "GET /capabilities and GET /sites and GET /v1/models" }, ROUTES),
    [],
    "a real route whose first segment is also a repo directory must still pass",
  );
  // No real registered route may become a VIOLATION — the "no false positives"
  // property stated over the whole derived set rather than a sample.
  // NOTE the property is "never reported", not "always tokenised as a route":
  // `/capabilities` and `/sites` are BOTH registered routes AND real repo
  // directories, and the PRE-EXISTING "exists on disk" rule has always read them
  // as paths. That is correct — a path is not an unregistered endpoint — so this
  // asserts the outcome that matters and does not demand a change of shape.
  for (const r of ROUTES) {
    const violations = routeViolations({ rel: "x", dir: "x", text: `Call GET ${r}` }, ROUTES);
    assert.deepEqual(
      violations,
      [],
      `a registered route must never be reported as unregistered: ${r}${violations.length ? ` — got ${fmt(violations)}` : ""}`,
    );
  }
  ctx.diagnostic(`path-rule check: ${ROUTES.length} registered routes all still read as route claims`);
});

/** A throwaway tree under the OS temp dir, never the repo. `files` maps a
 *  relative path to its LINES (or to one literal string of file content).
 *  Returns the temp root; the caller removes it in a `finally`. */
function mkTempTree(files: Record<string, string[] | string>): string {
  const root = mkdtempSync(join(tmpdir(), "skills-truth-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Array.isArray(body) ? body.join("\n") : body);
  }
  return root;
}