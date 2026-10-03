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
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
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
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.split("\n");
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
  const fm = parseFrontmatter(sf.text);
  const where = `${sf.rel}`;
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

export interface RouteClaim {
  token: string;
  line: number;
}

/** Every route a skill ASSERTS, with its 1-based line. URLs are excluded (a `/`
 *  inside `https://…` is not a claim), and so is any token that names a real file
 *  on disk (`src/prompt/driver.ts` is a path, not an endpoint). */
export function routeClaims(sf: SkillFile, root: string = ROOT): RouteClaim[] {
  const stripped = stripDataFences(sf.text);
  const out: RouteClaim[] = [];
  const lines = stripped.split("\n");
  lines.forEach((line, i) => {
    const masked = line.replace(/https?:\/\/\S+/g, " ");
    for (const m of masked.matchAll(ROUTE_TOKEN_RE)) {
      const token = m[0].slice(m[1]!.length).replace(/\/+$/, "") || "/";
      if (token === "/") continue;                      // bare root, no claim
      if (/\.(?:ts|js|mjs|sh|md|json|ya?ml|lock)$/i.test(token)) continue; // a file path
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

/** Every `UI2API_*` name appearing as a LITERAL in `src/**` or `scripts/**`.
 *  `.sh` is included on purpose: `scripts/ops/*.sh` read knobs too.
 *
 *  This asserts PRESENCE OF THE LITERAL, never `process.env` readability — which
 *  is why `UI2API_VERSION` needs no exemption: it is a local `const` reading
 *  package.json (AGENTS.md says so explicitly) and it IS in `src/`, so it passes
 *  for the honest reason rather than a special case. */
export function knobsInCode(root: string = ROOT): Set<string> {
  const out = new Set<string>();
  for (const dir of ["src", "scripts"]) {
    for (const f of codeFiles(join(root, dir))) {
      for (const m of readFileSync(f, "utf8").matchAll(/UI2API_[A-Z0-9_]+/g)) out.add(m[0]);
    }
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

/** Every site id that RESOLVES: a directory under `capabilities/`, or a key of
 *  `BUILTIN_PROFILES` (imported, not regexed — a profile key is code, not prose). */
export function resolvableSiteIds(root: string = ROOT): Set<string> {
  const out = new Set<string>(Object.keys(BUILTIN_PROFILES));
  try {
    for (const e of readdirSync(join(root, "capabilities"), { withFileTypes: true })) {
      if (e.isDirectory()) out.add(e.name);
    }
  } catch {
    /* no capabilities dir: BUILTIN_PROFILES still stands */
  }
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

/** Bare count claims about the surface — the shape that rots silently. */
export function countClaims(sf: SkillFile): string[] {
  const out: string[] = [];
  sf.text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\b\d+\s+(chat models|packages|verified sites|builtins|capabilities|sites|services)\b/gi)) {
      out.push(`${sf.rel}:${i + 1}: \`${m[0]}\``);
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
const SITES = resolvableSiteIds();

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
  ctx.diagnostic(`UI2API_* literals derived from src/+scripts/: ${KNOBS.size}`);
});

t("CHECK 4 — every site id a skill names resolves to a capabilities/ dir or a BUILTIN_PROFILES key", () => {
  assert.ok(SITES.size >= 20, `non-vacuity: only ${SITES.size} resolvable site ids derived — the derivation stopped reading`);
  const bad = FILES.flatMap((sf) => siteViolations(sf, SITES));
  assert.deepEqual(
    bad,
    [],
    `site ids named in skills that resolve to nothing:\n  ${bad.map((v) => `${v.file}:${v.line} \`${v.token}\`\n    fix: ${v.fix}`).join("\n  ")}`,
  );
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