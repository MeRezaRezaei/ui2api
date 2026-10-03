#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
// Additive import for cmdHubPublish's staging/cleanup seam (copyFileSync,
// mkdtempSync, rmSync) + node:os tmpdir. Deliberately its own statement rather
// than an edit to the import above, so an unrelated change to that line cannot
// collide with it.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { analyse } from "./analyzer/explore.js";
import { redactActionMap } from "./runtime/redact.js";
import { generate } from "./generator/generate.js";
import { validateActionMap } from "./schema.js";
import { sessionPath, saveCookies, buildLaunchOptions, userChromeProfile } from "./runtime/browser.js";
import { capturePageStorage, saveSnapshot, snapshotPath, saveAccountSnapshot, listAccounts, loadAccountSnapshot, slugifyIdentity, slugCollision, snapshotHasAuth, tightenVaultModes } from "./runtime/session-store.js";
import { buildPackage, packageCommandRefusal } from "./registry/package.js";
import { installPackage, defaultPackagesRoot, fetchRegistryIndex, DEFAULT_REGISTRY_URL } from "./registry/install.js";
import { startHub } from "./hub/server.js";
import { pushToMirror } from "./hub/mirror.js";
import { RegistryStore } from "./hub/store.js";
import { HubRuntime } from "./hub/runtime.js";
import { serveInstanceStdio, serveInstanceAcp } from "./hub/serve.js";
import { servePlugin } from "./plugin/serve.js";
import { loadPluginModule } from "./plugin/loader.js";
import { resolveProfile, resolveProfileWithOverride, defaultSiteId } from "./profile/profile.js";
import { defaultChatProfiles, chatSurfaceStatus, resolveDataDir } from "./prompt/registry.js";
import { ChatDriver } from "./prompt/driver.js";
import { startPromptd, resolveCapabilityAccount } from "./prompt/http.js";
import { TOKEN_ENV } from "./prompt/posture.js";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SITES = resolve(SRC_DIR, "..", "sites");

/**
 * The CLI usage block printed by the `default:` case (bare `ui2api`, `ui2api
 * help`, any unknown command). Pure string table so tests pin the command
 * surface honestly — every advertised command must exist and behave as
 * described (GOAL 67: `ui2api package` is REFUSED since GOAL 66, so the help
 * line says so instead of advertising a working --author invocation).
 */
export const HELP_LINES: readonly string[] = [
  "UI2API — turn any website into MCP tools for AI\n",
  "  ui2api analyse  <url>   [--root App] [--out DIR] [--llm] [--max-tasks N] [--login] [--cookies FILE]",
  "  ui2api generate <host>  [--out DIR]  (MCP server only — --acp/--skill are REFUSED here, never read; the ACP surface is `ui2api hub run <host> --acp`)",
  "  ui2api serve    <host>  [--out DIR] [--trust] [--engine native|wigolo]  (--trust = the explicit consent gate cmdServe demands before an untrusted action-map runs; wigolo = drive the browser side through a local wigolo daemon)",
  "  ui2api remap    <host>  [--out DIR]",
  "  ui2api package  <host>       (REFUSED — GOAL 66 write-truth: only knows the DEAD metadata+action-map pair nothing serves; package the modern way: ui2api analyse → capabilities/<id>/ with manifest.json + profile.json + session.lock.json + CAPABILITIES.md, then it is served by /registry + install)",
  "  ui2api install  <host>  [--registry URL] [--out DIR]  (install a site package from the community registry; default = master branch; --out = isolated, NOT served by the daemon)",
  "  ui2api install  --catalog [--registry URL]  (list the registry catalog: site, version, trust)",
  "  ui2api chrome <start|status|stop>  (the PERSISTENT Chrome daemon: one long-lived browser owned by the dedicated ui2api user; start is idempotent and adopts an existing one)",
  "  ui2api hub            [--port N] [--data-dir DIR]  (start registry server)",
  "  ui2api hub publish <host> [--mirror] [--registry-repo URL]  (build + PUT to hub; --mirror also pushes to community registry)",
  "  ui2api hub run <host> [--acp] [--port N] [--data-dir DIR] [--engine native|wigolo]  (serve a registered plugin)",
  "  ui2api plugin serve <module.ts> [--base-url URL]  (serve a plugin module as MCP)",
  "  ui2api profile capture <url> [--data-dir DIR] [--login]  (login once, save cookies+localStorage+IndexedDB snapshot)",
  "  ui2api profile ingest <host> [--profile DIR] [--data-dir DIR]  (OFFLINE: read the real Chrome profile DBs — cookies+localStorage — no browser)",
  "  ui2api prompt '<text>' [--site ...]  (drive an AI chat website to answer a prompt — the MVP command)",
  "  ui2api promptd            [--port N] [--pool-min N] [--pool-max N]  (localhost HTTP service: POST /prompt, POST /capability/<site>, GET /sites, GET /registry, GET /accounts?site=, GET /capabilities/<site>, GET /v1/models, POST /v1/chat/completions, GET /status, GET /requirements, GET /health)",
  "  ui2api prompt --sites                (list the configured AI chat websites)",
  "  ui2api vault tighten [--dry-run|--apply]  (remove group/other bits from the session vault: files to 0600, dirs to 0700. MODES ONLY — it never rewrites, re-serializes or deletes a snapshot, and never follows a symlink, so it cannot corrupt a credential. DRY RUN is the default; --apply is required to change anything. Reports every file with old -> new mode, and may only tighten, never loosen)",
  "  ui2api requirements [site]           (alias: doctor — OS-level readiness per package: ready/working/on-hold/not-ready with named reasons; exit nonzero on any not-ready) [--json = the same report as a machine-readable object, honoring the <site> scope]",
  "  ui2api proof                        (`ui2api live-proof` = same — live end-to-end proof: drive a chat site with a random arithmetic prompt and verify the answer; --site NAME --data-dir DIR)",
  "  ui2api doctor                       (alias: requirements — OS-level readiness gate per package, with the named reason)",
  "  ui2api langgen                      (generate a language client (e.g. PHP) for a site map)",
  "  ui2api smoke                        (ONE command: requirements gate + ensure the anonymous duckduckgo package (installs it via the registry if missing) + ONE real anonymous chat round-trip through the ChatDriver — prints `smoke OK: …` with a real read-off-page answer (exit 0) or the NAMED failure (exit 1)) [--json = {ok, site, answer?, ms?, message, installedAnon?, report}]",
];

interface Flags {
  root?: string;
  out?: string;
  llm?: boolean;
  trust?: boolean;
  login?: boolean;
  cookies?: string;
  maxTasks?: number;
  author?: string;
  use?: string;
  registry?: string;
  dataDir?: string;
  /** GOAL 131: `ui2api chrome start --headed` / `stop --force` */
  headed?: boolean;
  force?: boolean;
  port?: number;
  poolMin?: number;
  poolMax?: number;
  acp?: boolean;
  /**
   * The generator API's `opts.skill` (emits SKILL.md + skill-loader.mjs into the
   * server dir). Declared HERE ONLY so `generate --skill` can be REFUSED by name
   * instead of ignored as an unknown token — see generateTargetRefusal.
   */
  skill?: boolean;
  mirror?: boolean;
  registryRepo?: string;
  baseUrl?: string;
  engine?: string;
  site?: string;
  profile?: string;
  apply?: boolean;
  dryRun?: boolean;
  json?: boolean;
  newChat?: boolean;
  timeoutMs?: number;
  sites?: boolean;
  assist?: boolean;
  catalog?: boolean;
  account?: string;
  identity?: string;
  identityPrefix?: string;
  known?: boolean;
  interactive?: boolean;
  xhostAll?: boolean;
  model?: string;
  lang?: string;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") f.root = argv[++i];
    if (argv[i] === "--out") f.out = argv[++i];
    if (argv[i] === "--llm") f.llm = true;
    if (argv[i] === "--trust") f.trust = true;
    if (argv[i] === "--login") f.login = true;
    if (argv[i] === "--cookies") f.cookies = argv[++i];
    if (argv[i] === "--max-tasks") f.maxTasks = Number(argv[++i]) || undefined;
    if (argv[i] === "--author") f.author = argv[++i];
    if (argv[i] === "--use") f.use = argv[++i];
    if (argv[i] === "--registry") f.registry = argv[++i];
    if (argv[i] === "--data-dir") f.dataDir = argv[++i];
    // GOAL 131: the chrome daemon's own flags
    if (argv[i] === "--headed") f.headed = true;
    if (argv[i] === "--force") f.force = true;
    if (argv[i] === "--port") f.port = Number(argv[++i]) || undefined;
    if (argv[i] === "--acp") f.acp = true;
    // `--skill` is parsed ONLY so the refusal can NAME it (generateTargetRefusal).
    // It is NOT a capability of any command: generate()'s `opts.skill` has no
    // CLI surface, and an unparsed token would be ignored as silently as --acp
    // was — the same false success, one step further from the source.
    if (argv[i] === "--skill") f.skill = true;
    if (argv[i] === "--mirror") f.mirror = true;
    if (argv[i] === "--registry-repo") f.registryRepo = argv[++i];
    if (argv[i] === "--base-url") f.baseUrl = argv[++i];
    if (argv[i] === "--engine") f.engine = argv[++i];
    if (argv[i] === "--site") f.site = argv[++i];
    if (argv[i] === "--profile") f.profile = argv[++i];
    if (argv[i] === "--json") f.json = true;
    if (argv[i] === "--new") f.newChat = true;
    if (argv[i] === "--timeout-ms") f.timeoutMs = Number(argv[++i]) || undefined;
    if (argv[i] === "--pool-min") f.poolMin = Number(argv[++i]) || undefined;
    if (argv[i] === "--pool-max") f.poolMax = Number(argv[++i]) || undefined;
    if (argv[i] === "--sites") f.sites = true;
    if (argv[i] === "--assist") f.assist = true;
    if (argv[i] === "--catalog") f.catalog = true;
    if (argv[i] === "--account") f.account = argv[++i];
    if (argv[i] === "--identity") f.identity = argv[++i];
    if (argv[i] === "--identity-prefix") f.identityPrefix = argv[++i];
    if (argv[i] === "--known") f.known = true;
    if (argv[i] === "--interactive") f.interactive = true;
    if (argv[i] === "--xhost-all") f.xhostAll = true;
    if (argv[i] === "--model") f.model = argv[++i];
    if (argv[i] === "--lang") f.lang = argv[++i];
    // MEASURED 2026-10-01: `--apply` was NOT parsed here, so `flags.apply` was
    // always undefined, `apply` was always false, and `vault tighten --apply`
    // ran in DRY-RUN mode forever while printing a confident, correct, and
    // completely inert report of the exposure it had not fixed:
    //
    //     266 entries would change, 55 already tight ... dry run — nothing was modified
    //
    // A credential-permissions tool that cannot apply is worse than no tool: the
    // output reads as a remediation report, so the world-readable session
    // snapshots (state.json / accounts.json holding real cookies and Bearer
    // tokens) looked handled by anyone who ran it. `--dry-run` is parsed too, so
    // the pair is explicit in both directions rather than implied by absence.
    if (argv[i] === "--apply") f.apply = true;
    if (argv[i] === "--dry-run") f.dryRun = true;
  }
  return f;
}

// Flags that CONSUME the next argv token as their value. requirementsSiteArg
// needs this so a flag's VALUE is never misread as the <site> positional — e.g.
// `--data-dir /tmp/d` must not yield "/tmp/d".
//
// ── DERIVED FROM THE PARSER, NOT RESTATED BESIDE IT ────────────────────────
// This set used to be a hand-typed literal whose comment said only "mirror
// parseFlags above". That made the SAME fact — which flags take a value — owned
// twice: once by parseFlags (which decides what actually consumes a token) and
// once by this list (which decides what firstNonFlagArg skips). Two owners, and
// the only thing holding them together was a comment, which is not a gate.
//
// THE CONCRETE FAILURE it invited. Add one value-taking flag to parseFlags and
// forget this list — the single most ordinary edit to this file — and the flag
// is parsed correctly while firstNonFlagArg treats its VALUE as the positional.
// `ui2api requirements --tenant acme gemini` then answers with the report for
// site "acme" (nonexistent) instead of "gemini", exits on the wrong site's
// verdict, and prints no hint that a flag was swallowed. Nothing errors; the
// tool quietly reports the wrong thing. That is the same shape as the `--apply`
// defect above it: a parsed-correctly flag whose second consumer still believed
// the old world.
//
// So the set is now read out of the parser's OWN source: every
// `argv[i] === "--x")` line whose body immediately assigns `argv[++i]` (with or
// without the `Number(...)` wrapper). The pattern requires the assignment to
// follow the flag test DIRECTLY — no gap to cross — so a BOOLEAN flag can never
// reach across to a later line's value and be captured. parseFlags is a plain
// module-local function declaration, so `.toString()` is its real source, and
// this file is compiled by tsc and never bundled, so there is no minifier to
// hide it from.
//
// MEASURED at this fold: the derived set and the hand-typed literal it replaced
// were identical (22 flags, the same 22 names), so this is a pure
// drift-ELIMINATION with no behaviour change.
//
// `valueTakingFlagsFrom` is exported and PURE so the mirror property can be
// pinned by feeding it a SYNTHETIC parser — test/cli-argv.test.ts asserts both
// directions against a fake source, which is the edit the old hand-typed
// arrangement could not survive. A pin that only re-reads the real source would
// pass just as happily against the old literal; that is the difference between
// testing the property and restating it.
export function valueTakingFlagsFrom(parserSource: string): Set<string> {
  return new Set(
    [...parserSource.matchAll(/argv\[i\]\s*===\s*"(--[\w-]+)"\)\s*f\.\w+\s*=\s*(?:Number\()?argv\[\+\+i\]/g)].map(
      (m) => m[1]!,
    ),
  );
}

const VALUE_TAKING_FLAGS = valueTakingFlagsFrom(parseFlags.toString());

// GOAL 44: the pure flag-aware first-positional reader shared by every
// free-string positional command. Iterates argv, skipping `--flag` tokens and
// (for VALUE_TAKING_FLAGS members) their VALUE token — so a flag's value is
// never mistaken for a positional and a positional is honored no matter where
// it sits (before OR after any flag). Returns the first remaining non-flag
// token, "" if none. Callers pass the argv slice AFTER their command token
// (a flag token can never be a positional value). Pure: no env, no I/O —
// directly unit-testable.
export function firstNonFlagArg(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) return tok;
    if (VALUE_TAKING_FLAGS.has(tok)) i++; // skip the flag's value token
  }
  return "";
}

// ── GOAL 215: THE INPUT-VALIDATION SEAM ─────────────────────────────────────
//
// ONE CLASS, FOUR COSTUMES. MEASURED before this seam existed:
// `ui2api prompt "hi" --site duckduckgo --bogus` printed nothing about `--bogus`
// and went on to a real 45-second browser call. A tool that hears a typed value
// and says nothing is worse than one that refuses, because the operator's NEXT
// act is built on the assumption it was heard. So four shapes refuse, and the
// policy is one line: **only CONTRADICTION and MALFORMATION refuse; a flag that
// is merely inert on the current command stays legal** (`--port` on `profile
// list` is harmless, and refusing it would be hostile).
//
// ── WHY EVERY SET BELOW IS DERIVED, NEVER RESTATED ───────────────────────────
// `KNOWN_FLAGS` and `NUMERIC_FLAGS` are read out of `parseFlags`' OWN source,
// exactly as `VALUE_TAKING_FLAGS` already is above. A hand-typed list beside
// the parser is the defect the GOAL 44 comment describes: the ordinary edit —
// add a flag to `parseFlags` — then leaves a second consumer believing the old
// world, and the new refusals would then fire on a flag that genuinely WORKS.
// A refusal on a live flag is worse than the silent no-op it replaced, so the
// flag set these refusals judge is read from the parser rather than copied.
// Both helpers are exported and PURE so the test lane can mutation-prove the
// derivation against a SYNTHETIC parser — a pin that only re-reads the real
// source would pass just as happily against a literal (the GOAL 44 lesson).

/**
 * Strip JS comments so a derivation cannot read PROSE. Measured, not
 * hypothetical: the GOAL 44 comment above literally quotes
 * `argv[i] === "--x")` to explain the pattern, and the un-stripped derivation
 * dutifully collected a flag named `--x` that `parseFlags` does not accept —
 * 41 flags where the parser has 40. A phantom in this set is not cosmetic:
 * `KNOWN_FLAGS` is what the refusals JUDGE, so a wrong member can wave a real
 * token through. String literals are preserved (a `//` inside one is not a
 * comment). `valueTakingFlagsFrom` needs none of this — its pattern requires
 * the assignment to follow the test directly, so prose cannot satisfy it — and
 * it is left exactly as measured.
 */
function stripJsComments(source: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    const n = source[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i++;
        continue;
      }
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

export function knownFlagsFrom(parserSource: string): Set<string> {
  return new Set(
    [...stripJsComments(parserSource).matchAll(/argv\[i\]\s*===\s*"(--[\w-]+)"/g)].map((m) => m[1]!),
  );
}

/** The subset whose value goes through `Number(...)` — the numeric flags. */
export function numericFlagsFrom(parserSource: string): Set<string> {
  return new Set(
    [
      ...stripJsComments(parserSource).matchAll(
        /argv\[i\]\s*===\s*"(--[\w-]+)"\)\s*f\.\w+\s*=\s*Number\(/g,
      ),
    ].map((m) => m[1]!),
  );
}

// `--help` is the ONE form the CLI acts on OUTSIDE parseFlags: `ui2api --help`
// does not parse as a command, so it lands on the `default:` help branch and
// has always printed help. It is added here rather than refused because
// REFUSING IT WOULD BE A REGRESSION THIS SEAM INTRODUCES ITSELF — and because
// `unknownFlagRefusal`'s own remedy line points the operator at exactly this
// command (`Run \`ui2api --help\``), so a set without it would tell a user to
// run a command that the very same refusal then rejects.
//
// The honest limit, recorded because it is NOT fixed here: `--help` is honoured
// only in COMMAND position. `ui2api promptd --help` therefore stays inert and
// still starts the daemon — the exact pathology capabilities/CAPTURE-RUNBOOK.md
// records ("There is no per-command `--help`"). Making help per-command is a
// behaviour ADDITION outside this seam's mandate (it would have to invent a
// help path per command); fixing it here would mean refusing a form that works.
const KNOWN_FLAGS = new Set([...knownFlagsFrom(parseFlags.toString()), "--help"]);
const NUMERIC_FLAGS = numericFlagsFrom(parseFlags.toString());

/** One `--x` token as the seam sees it. */
export interface FlagToken {
  /** the token itself, `--x` form */
  flag: string;
  /** the value token, when the flag is value-taking AND one follows */
  value?: string;
  /** true when a value-taking flag has NO token after it */
  missingValue: boolean;
}

/**
 * Every flag-shaped token in argv, in order — THE single definition of
 * "flag-shaped" the three refusals share, and the one that must AGREE with
 * `firstNonFlagArg` above (GOAL 215's crux: a value that happens to look like a
 * flag is legal input, so `--site --weird-dir` is a site named `--weird-dir`,
 * not a refusal).
 *
 * It agrees BY CONSTRUCTION, not by promise, because both walk the same two
 * derived sets:
 *   - only `--x` is flag-shaped — a single-dash token, a bare `-` and every
 *     positional (the command, a subcommand, a host, a URL, the prompt text)
 *     are never flags and are skipped here exactly as `firstNonFlagArg` skips
 *     them;
 *   - only a KNOWN value-taking flag consumes the next token, so a VALUE that
 *     looks like a flag is consumed as a value and never scanned;
 *   - an UNKNOWN flag consumes nothing (`VALUE_TAKING_FLAGS` does not contain
 *     it), which is the same answer `firstNonFlagArg` gives for the token after
 *     it — so this walker can never re-classify a token the positional reader
 *     already accepted.
 */
export function flagTokens(argv: string[]): FlagToken[] {
  const out: FlagToken[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) continue; // a positional is never a flag
    if (VALUE_TAKING_FLAGS.has(tok)) {
      const value = argv[i + 1];
      out.push({ flag: tok, value, missingValue: value === undefined });
      i++; // the value token is consumed — including one that looks like a flag
      continue;
    }
    out.push({ flag: tok, missingValue: false });
  }
  return out;
}

/** `ui2api` has no diff/levenshtein, but a near-miss is the one thing that turns
 *  a refusal into a next step instead of a dead end. Distance 1-3 only, so a
 *  suggestion is never noise. Pure. */
function nearestKnownFlag(flag: string): string | undefined {
  const target = flag.replace(/^--/, "");
  let best: { name: string; dist: number } | undefined;
  for (const known of KNOWN_FLAGS) {
    const name = known.replace(/^--/, "");
    const a = name.split("");
    const b = target.split("");
    if (Math.abs(a.length - b.length) > 3) continue;
    const row: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    const dist = row[b.length]!;
    if (dist >= 1 && dist <= 3 && (!best || dist < best.dist)) best = { name: known, dist };
  }
  return best?.name;
}

/**
 * Seam 1 — UNKNOWN FLAGS REFUSE, naming the flag and pointing at the help.
 *
 * Before this, an unknown token was inert: `parseFlags` never matched it,
 * `firstNonFlagArg` skipped it because it starts with `--`, and the command
 * ran and exited as though the operator had not typed it. That is the whole
 * class GOAL 215 names. The compatibility risk of refusing is real and is
 * accepted deliberately: a script that passed an extra token through was ALREADY
 * broken — it was passing a flag the tool ignored — so refusing surfaces the bug
 * at the call site instead of hiding it until production.
 *
 * Pure — no I/O, no exit — so the test lane can call it directly.
 */
export function unknownFlagRefusal(argv: string[]): string {
  for (const t of flagTokens(argv)) {
    if (KNOWN_FLAGS.has(t.flag)) continue;
    const near = nearestKnownFlag(t.flag);
    return (
      `unknown flag ${t.flag} — nothing ran. This CLI knows exactly ${KNOWN_FLAGS.size} flags ` +
      `and ${t.flag} is not one, so it would have been ignored ` +
      `in silence and the command would have exited as if it had been heard.` +
      (near ? ` Did you mean ${near}?` : "") +
      ` Run \`ui2api --help\` for the full command and flag list. Nothing was written.`
    );
  }
  return "";
}

/**
 * Seam 2 — MALFORMED NUMERIC VALUES REFUSE, naming the flag, the value
 * received, and the accepted form. `--pool-max abc` used to become
 * `Number("abc") || undefined` = `undefined` = "auto": a silent coercion to a
 * default, which is the same lie as an ignored flag wearing a value.
 *
 * ── WHAT THIS DOES *NOT* DECIDE, AND WHY IT IS NOT A PRODUCT QUESTION ─────────
 * This refusal fires ONLY on input that is not a number at all — absent, blank,
 * or `Number(...) === NaN`.
 *
 * `--pool-min 0` was long recorded here as AMBIGUOUS ("is 0 'zero' or 'auto'?")
 * and deferred to the operator. THAT WAS WRONG, and the claim was falsifiable in
 * four lines: `src/prompt/pool.ts:502-504` already answers it, and a runtime probe
 * against a real `ChatPool` confirms it:
 *
 *     flag --pool-min 0  -> min=1     env UI2API_POOL_MIN=0 -> min=1
 *     flag --pool-min 3  -> min=3     env UI2API_POOL_MIN=5 -> min=5
 *     flag --pool-min -2 -> min=1     (clamped by Math.max(1, min))
 *
 * `Number("0") || undefined` makes the FLAG path `undefined`, and the env branch
 * tests `envMin >= 1`, which `0` fails — so BOTH paths already fall to the default
 * of 1. `0` HAS ALWAYS MEANED AUTO on this pool, and the effective floor is 1,
 * never 0. There was no fork here; the code had already answered it.
 *
 * So the instruction to the next reader is the OPPOSITE of the old one: do NOT
 * "resolve" 0 here and do NOT add a refusal for it — the behaviour is correct and
 * already consistent, and changing it would alter documented pool pacing. Negative
 * values are likewise untouched: they parse, they were accepted before, and
 * clamping them is the pool's business, not this seam's.
 *
 * Pure — no I/O, no exit.
 */
export function numericFlagRefusal(argv: string[]): string {
  for (const t of flagTokens(argv)) {
    if (!NUMERIC_FLAGS.has(t.flag)) continue;
    const accepted = `a number, e.g. ${t.flag} 4`;
    if (t.missingValue) {
      return (
        `malformed value for ${t.flag}: the flag was given NO value (accepted form: ${accepted}). ` +
        `Without it the value was dropped in silence and the default was used instead. ` +
        `Nothing was written; re-run with a number after ${t.flag}.`
      );
    }
    const raw = t.value ?? "";
    if (raw.trim() === "" || Number.isNaN(Number(raw))) {
      return (
        `malformed value for ${t.flag}: got ${JSON.stringify(raw)}, which is not a number ` +
        `(accepted form: ${accepted}). It would have been coerced to the default in silence, ` +
        `so the run you asked for is not the run you would have got. ` +
        `Nothing was written; re-run with a number after ${t.flag}.`
      );
    }
  }
  return "";
}

/**
 * Seam 3 — A FLAG THAT IS ONLY MEANINGFUL *WITH* ANOTHER REFUSES, naming the
 * flag it needs. These are CONTRADICTIONS, not inertness: the flag was typed,
 * it is read only inside a sibling flag's branch, and the command exits
 * reporting work it did not do.
 *
 *   - `--xhost-all` without `--assist`: the GOAL 215 priority case. It widens
 *     the xhost relax mode of the `--assist` display-share capture and is read
 *     ONLY inside that branch, so without `--assist` the capture runs the
 *     ordinary path, opens a browser and reports a capture while relax-mode was
 *     never applied — the operator believes relax-mode ran.
 *   - `--registry-repo` without `--mirror`: the repo URL is the MIRROR
 *     destination and is read only inside the `--mirror` branch of publish, so
 *     without it the publish succeeds and the mirror push never happens.
 *   - `hub run --port` without `--acp`: `--port` is read only on the `--acp`
 *     (HTTP) path; without `--acp`, `hub run` serves STDIO and the port was
 *     ignored.
 *
 * Command-SCOPED on purpose, and this is seam 4: the same flag on a command
 * that has no such pairing is merely inert, which stays LEGAL. Refusing
 * `--xhost-all` on `prompt`, or `--port` on `profile list`, would be hostile.
 *
 * Pure — no I/O, no exit.
 */
export function needsCompanionRefusal(cmd: string | undefined, arg: string | undefined, flags: Flags): string {
  if (cmd === "profile" && arg === "capture" && flags.xhostAll && !flags.assist) {
    return (
      `ui2api profile capture --xhost-all: --xhost-all only means anything together with ` +
      `--assist (it widens the xhost relax mode of the --assist display-share capture, and ` +
      `is read only inside that branch). Without --assist this run would take the ordinary ` +
      `capture path and report a capture while relax-mode was never applied. ` +
      `Re-run as: ui2api profile capture <url> --assist --xhost-all. Nothing was written.`
    );
  }
  if (cmd === "hub" && arg === "publish" && flags.registryRepo && !flags.mirror) {
    return (
      `ui2api hub publish --registry-repo ${flags.registryRepo}: --registry-repo only means ` +
      `anything together with --mirror (the repo URL is the MIRROR destination, and is read ` +
      `only inside the --mirror branch). Without --mirror the package would publish and the ` +
      `mirror push would never happen. ` +
      `Re-run as: ui2api hub publish <host> --mirror --registry-repo <url>. Nothing was written.`
    );
  }
  if (cmd === "hub" && arg === "run" && flags.port !== undefined && !flags.acp) {
    return (
      `ui2api hub run --port ${flags.port}: --port is read only on the --acp (HTTP) path — ` +
      `without --acp, hub run serves STDIO and the port was ignored. ` +
      `Re-run as: ui2api hub run <host> --acp --port ${flags.port}. Nothing was written.`
    );
  }
  return "";
}

// GOAL 43: the requirements/doctor <site> positional, read flag-aware from the
// WHOLE command argv. `requirements --json gemini` and
// `requirements gemini --json` scope IDENTICALLY — a site token is honored no
// matter where it sits (the old positional-only dispatch silently dropped a
// site that came after a flag: full 33-package report, exit 1 driven by
// unrelated dormant sites, no error, no hint). Flags and their VALUES are
// skipped (a flag-value token is never a site, the `--json`-as-site guard is
// preserved), and no site token ⇒ "" = the full report — never a partial
// verdict. argv[0] is the command itself ("requirements"/"doctor"). Pure: no
// env, no I/O — directly unit-testable.
export function requirementsSiteArg(argv: string[]): string {
  return firstNonFlagArg(argv.slice(1));
}

// GOAL 44: the prompt <text> positional — the argv slice the prompt case sees
// (process.argv.slice(2), command token first). `prompt --json "hello"` and
// `prompt "hello" --json` MUST ask the SAME text: the old raw argv[2]
// pass-through sent the literal flag token to the live default site with
// "hello" dropped in rest (never read) — a plausible JSON answer to the wrong
// question, no error, no hint. A flag (and its value) is skipped, never sent
// as text; no text token ⇒ "" → the existing usage throw fires (honest).
export function promptTextArg(argv: string[]): string {
  return firstNonFlagArg(argv.slice(1));
}

function sitesRoot(flags: Flags): string {
  return flags.out || DEFAULT_SITES;
}

// The only accepted engine names, symmetrical with `readEngine()` in context.ts.
function validateEngine(name: string): void {
  if (name !== "native" && name !== "wigolo") {
    throw new Error("unknown engine '" + name + "' (expected 'native' or 'wigolo')");
  }
}

function mapPath(host: string, root: string): string {
  return resolve(root, host, "action-map.json");
}

async function cmdAnalyse(url: string, flags: Flags): Promise<void> {
  const root = sitesRoot(flags);
  const host = new URL(url).host;

  // M7: a supplied --cookies <file> is injected into the site's session path so
  // analyse() can pick it up. We just persist it before analysis runs.
  if (flags.cookies) {
    const cookies = JSON.parse(readFileSync(flags.cookies, "utf8"));
    saveCookies(sessionPath(root, host), cookies);
    console.log(`Loaded cookies from ${flags.cookies} -> ${sessionPath(root, host)}`);
  }

  // M7: --login opens a headed browser for the user to authenticate manually,
  // then saves the FULL session (cookies + localStorage/sessionStorage/IndexedDB
  // profile snapshot) before normal (headless) analysis runs. The snapshot is
  // what makes later runs behave like the user's real logged-in session.
  if (flags.login) {
    const host = new URL(url).host;
    const session = await doInteractiveLogin(url, host, dirname(snapshotPath(root, host)));
    saveCookies(sessionPath(root, host), session.cookies);
    saveSnapshot(snapshotPath(root, host), session.snapshot);
    console.log(`Saved session snapshot -> ${snapshotPath(root, host)}`);
  }

  const map = await analyse(url, {
    root: flags.root,
    outDir: root,
    llm: flags.llm,
    maxTasks: flags.maxTasks,
  });
  mkdirSync(resolve(root, host), { recursive: true });
  // GOAL 125: a --login capture records the site's own auth POSTs, and `analyse`
  // runs right after the interactive login, so the map on disk is the LOGGED-IN
  // one. Redact before it is written, and say so.
  const redactedMap = redactActionMap(map);
  writeFileSync(mapPath(host, root), JSON.stringify(redactedMap.map, null, 2));
  if (redactedMap.hits.length) {
    console.log(
      `[ui2api] redacted ${redactedMap.hits.length} credential field(s) from the action map ` +
        `before writing: ${[...new Set(redactedMap.hits)].join(", ")}`
    );
  }
  console.log(`Analyzed ${host}: ${map.actions.length} actions -> ${mapPath(host, root)}`);
  console.log("Run: ui2api generate " + host + (flags.out ? ` --out ${flags.out}` : ""));
}

// ── `analyse --login`: the interactive login window ───────────────────────────
//
// A DECLARED EXCEPTION to the launch-seam bench rule, and the reason is
// mechanical, not stylistic: Playwright's `chromium.launch()` has NO
// `userDataDir` parameter. The option is not in `LaunchOptions` at all
// (playwright-core/types.d.ts — 41 fields, `headless` among them,
// `userDataDir` not), the client DROPS it before the params leave the process
// (`filterLaunchOptions`, a 12-key whitelist), and the server mkdtemps a
// throwaway `playwright_chromiumdev_profile-*` for `--user-data-dir`. So the
// previous call — `chromium.launch(buildLaunchOptions({headless:false}))` —
// silently opened a TEMP-PROFILE browser, and the comment above it claimed the
// login "happens in THEIR real Chrome and profile so the authenticated session
// lives in their own data". MEASURED FALSE. The only Playwright API that hands
// a real on-disk profile to a browser is `launchPersistentContext`, and the
// repo already declares that exception for the identical reason
// (`xhost-capture.ts:292`). Same shape, same derivation from the seam.
//
// The option bag is still DERIVED from `buildLaunchOptions`, so the real-Chrome
// decision and the clean flag set (no `--no-sandbox`/`--disable-gpu` tells) are
// the seam's, not a second hand-typed list. `userDataDir` is positional for
// `launchPersistentContext`, so it leaves the bag and becomes argument one.

/** Where the login profile lives when the operator configured none of their own. */
export function interactiveLoginProfileDir(sessionDir: string): string {
  return resolve(sessionDir, "chrome-login-profile");
}

export interface InteractiveLoginLaunch {
  /** The on-disk profile Chrome will actually use. */
  profileDir: string;
  /** The seam's option bag, minus the positional `userDataDir`. */
  options: Record<string, unknown>;
  /** True when this is the operator's OWN configured profile, not ours. */
  usingRealProfile: boolean;
}

/**
 * Resolve the interactive-login launch: which profile, and with which options.
 *
 * PURE w.r.t. the filesystem (it never creates or launches anything) so the
 * contract is unit-testable without a browser.
 *
 * Profile choice, and why each branch says what it says:
 *   - `UI2API_USER_DATA_DIR` / `UI2API_CHROME_PROFILE_PATH` (the seam's
 *     `userChromeProfile()`): the login lands in the operator's OWN profile, so
 *     every later run of that browser is already signed in. TRUE now, and only
 *     true because of the persistent-context form.
 *   - otherwise: a dedicated per-site profile under the session dir
 *     (`sites/<host>/.session/chrome-login-profile`, covered by the
 *     `sites/<host>/.session/` gitignore rule). The login is still DURABLE — it
 *     is not a temp dir that vanishes with the process — and re-running
 *     `analyse --login` reuses the sign-in instead of asking again.
 */
export function interactiveLoginLaunch(sessionDir: string): InteractiveLoginLaunch {
  const real = userChromeProfile();
  const profileDir = real ?? interactiveLoginProfileDir(sessionDir);
  const { userDataDir: _positional, ...bag } = buildLaunchOptions({
    userDataDir: profileDir,
    // FORCED, not inherited: this window exists so a human can sign in. An
    // invisible window is not a login, so `resolvedHeadless` is never asked.
    headless: false,
  }) as Record<string, unknown>;
  void _positional;
  return { profileDir, options: bag, usingRealProfile: Boolean(real) };
}

// Launch a HEADED browser solely for the user to log in (`analyse --login`).
// Returns cookies + the full profile snapshot (cookies + localStorage +
// sessionStorage + IndexedDB).
async function doInteractiveLogin(url: string, host: string, sessionDir: string): Promise<{ cookies: unknown[]; snapshot: import("./runtime/session-store.js").ProfileSnapshot }> {
  const { chromium } = await import("playwright");
  const launch = interactiveLoginLaunch(sessionDir);
  mkdirSync(launch.profileDir, { recursive: true, mode: 0o700 });
  // A persistent context, so the sign-in DIES with nothing: the profile on disk
  // is the one Chrome writes, which is the whole point of an interactive login.
  const context = await chromium
    .launchPersistentContext(launch.profileDir, launch.options as any)
    .catch((e: unknown) => {
      // The one failure an operator can actually cause here: Chrome's
      // one-instance-per-profile rule. Name it instead of surfacing a raw
      // ProcessSingleton.
      const msg = String(e);
      if (/ProcessSingleton|profile appears to be in use/i.test(msg)) {
        throw new Error(
          `cannot open ${launch.profileDir} — a Chrome already holds that profile (Chrome allows one ` +
            `instance per profile). Close that Chrome and re-run, or unset ` +
            `UI2API_USER_DATA_DIR/UI2API_CHROME_PROFILE_PATH to log in on this site's own profile ` +
            `(${interactiveLoginProfileDir(sessionDir)}). Underlying error: ${msg}`,
        );
      }
      throw e;
    });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    const where = launch.usingRealProfile
      ? ` (your own Chrome profile: ${launch.profileDir})`
      : ` (this site's login profile: ${launch.profileDir} — the sign-in persists there)`;
    console.log(`[ui2api] Login page opened${where}. Sign in, then return here and press Enter.`);
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question("Press Enter once logged in: ", () => {
        rl.close();
        resolve();
      });
    });
    const cookies = await context.cookies();
    // The snapshot captures the same origin the page is on; if the login flow
    // redirected off the target origin, fall back to the final landing origin —
    // the FIRST-party cookies are what carry the auth.
    const snapshot = await capturePageStorage(page, {
      host,
    }).catch((e) => {
      console.error(`[ui2api] snapshot capture failed (${String(e)}) — saving cookies only`);
      return {
        version: 1 as const,
        host,
        origin: page.url().startsWith("http") ? new URL(page.url()).origin : "",
        capturedAt: new Date().toISOString(),
        cookies: cookies as unknown as Array<Record<string, unknown>>,
        localStorage: [],
        sessionStorage: [],
        indexedDB: [],
      };
    });
    return { cookies, snapshot };
  } finally {
    await context.close();
  }
}

/**
 * `generate` emits the **MCP** server only. `--acp` (and `--skill`) are the two
 * flags that used to make that claim false.
 *
 * THE DEFECT, measured. `ui2api generate <host> --acp` ran, printed
 * `Generated MCP server -> …/server/index.ts`, exited 0 — byte-identical to the
 * same command without the flag, and no `acp.ts` in either case. `flags.acp` was
 * parsed at the top of this file and read NOWHERE on this path: `cmdGenerate`
 * called `generate(map, root)` and dropped both of `generate`'s remaining
 * parameters. A REJECTED flag tells the user they were wrong; a silently accepted
 * one tells them IT WORKED, and they go on to build against an `acp.ts` that was
 * never written — with the failure surfacing somewhere else, much later.
 *
 * WHY A REFUSAL AND NOT A WIRING. `generate(map, dir, "acp")` does exist, is
 * unit-covered (test/acp.test.ts drives a real JSON-RPC initialize + list_tools
 * over the emitted file), and passing the flag through would have been a
 * one-argument change. That is not why it is refused:
 *
 *   - The shipped docs already name the ACP surface the CLI actually reaches:
 *     `ui2api hub run <host> --acp [--port N]` (docs/ONBOARDING.md §11,
 *     skills/ui2api-operate). `hub run --acp` reads `--acp` TODAY, so the flag
 *     stays LIVE there; it is only dead on `generate`.
 *   - Emitting a second, stdio, from-the-legacy-action-map ACP surface would add
 *     a second way to get an ACP server rather than remove a lie — a design
 *     decision, not a bug fix, and this audit is scoped to removing false
 *     success.
 *
 * So the honest fix is the cheap one: name the real path, exit nonzero, write
 * nothing. Same shape as GOAL 85's `addAllModeArg` contradiction refusal.
 * Pure — no I/O — so it is unit-testable without spawning the CLI.
 */
export function generateTargetRefusal(flags: Pick<Flags, "acp" | "skill">): string {
  const named: string[] = [];
  if (flags.acp) named.push("--acp");
  if (flags.skill) named.push("--skill");
  if (named.length === 0) return "";
  return (
    `ui2api generate ${named.join(" and ")}: this command emits the MCP server only ` +
    `(sites/<host>/server/index.ts) — it never read ${named.join(" nor ")}, so the flag was ` +
    `accepted and ignored (a silent no-op, exit 0).` +
    (flags.acp
      ? ` For ACP, serve the registered package instead: ui2api hub publish <host> then ` +
        `ui2api hub run <host> --acp [--port N]  (HTTP JSON-RPC, protocolVersion 2025-03-26, default :8788).`
      : "") +
    (flags.skill
      ? ` --skill has no CLI surface at all: only the generator API emits SKILL.md ` +
        `(generate(map, dir, "mcp", { skill: true })).`
      : "") +
    ` Nothing was written.`
  );
}

async function cmdGenerate(host: string, flags: Flags): Promise<void> {
  const refusal = generateTargetRefusal(flags);
  if (refusal) throw new Error(refusal);
  const root = sitesRoot(flags);
  if (!existsSync(mapPath(host, root))) throw new Error("No action-map for " + host + ". Run analyse first.");
  const map = validateActionMap(JSON.parse(readFileSync(mapPath(host, root), "utf8")));
  const serverDir = generate(map, root);
  console.log(`Generated MCP server -> ${serverDir}/index.ts`);
}

async function cmdServe(host: string, flags: Flags): Promise<void> {
  const root = sitesRoot(flags);
  const serverDir = resolve(root, host, "server");
  const mapPath = resolve(serverDir, "action-map.json");
  if (!existsSync(mapPath)) throw new Error("No generated server for " + host + ". Run generate first.");
  const map = validateActionMap(JSON.parse(readFileSync(mapPath, "utf8")));
  if (!map.trusted && !flags.trust) throw new Error("action-map is untrusted — review it and re-run with --trust");
  // Engine: --engine wins over UI2API_ENGINE. Validated so a typo fails fast.
  if (flags.engine) validateEngine(flags.engine);
  if (flags.engine) process.env.UI2API_ENGINE = flags.engine;
  const mod = await import(pathToFileURL(resolve(serverDir, "index.ts")).href);
  await (mod as any).runServer();
}

/**
 * GOAL 85: `ui2api package --author NAME --use 'authorized-use statement'` is
 * the wire shape a package submitter reaches for, and the runtime usage throw
 * taught it — but NOTHING read the two flags, so the throw advertised a dead
 * knob (the GOAL 80 defect). Resolution (a) — WIRED: the declared values are
 * now read and echoed into the refusal/verdict, so what the user declared is
 * never silently dropped, and the verdict names where a real package declares
 * them (capabilities/<id>/manifest.json). Nothing is written either way — the
 * GOAL 66 refusal stands; only the dead flag became live. Pure flag read.
 */
export function declaredAuthorUse(flags: Pick<Flags, "author" | "use">): string {
  const parts: string[] = [];
  if (flags.author) parts.push(`author="${flags.author}"`);
  if (flags.use) parts.push(`authorized-use="${flags.use}"`);
  if (parts.length === 0) return "";
  return (
    ` Declared on the command line: ${parts.join(", ")} — recorded in this verdict only;` +
    ` a real capability package declares author/authorized-use in capabilities/<id>/manifest.json.`
  );
}

async function cmdPackage(host: string, flags: Flags): Promise<void> {
  const root = sitesRoot(flags);
  // GOAL 66: the standalone packaging command refuses LOUD — buildPackage
  // writes the DEAD metadata+action-map pair into a dir nothing serves, and a
  // capture-level action-map cannot produce a modern capability package.
  // Nothing is written; the modern path is named (analyze → capabilities/<id>/).
  // GOAL 85: --author/--use are no longer dead knobs — their declared values
  // ride along in the refusal instead of vanishing.
  throw new Error(packageCommandRefusal(host, root) + declaredAuthorUse(flags));
}

async function cmdInstallCatalog(flags: Flags): Promise<void> {
  const reg = flags.registry ?? process.env.UI2API_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const index = await fetchRegistryIndex(reg);
  const rows = Object.entries(index).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) {
    console.log(`(registry catalog is empty at ${reg})`);
    return;
  }
  console.log(`Registry catalog (${reg}):`);
  for (const [site, e] of rows) {
    const url = typeof e.url === "string" ? e.url : "(no url)";
    console.log(`${site.padEnd(28)} v${(e.version ?? "?").padEnd(8)} ${(e.trust ?? "?").padEnd(10)} ${url}`);
  }
}

/**
 * GOAL 67 (2026-09-25): the honest post-install follow-up lines. The daemon
 * serves packages from `daemonRoot` (defaultPackagesRoot() — the repo-root
 * `capabilities/` climb) and NEVER from an `--out` dir, so the default case
 * names the RESOLVED root (not the old "defaultPackagesRoot" placeholder) and
 * the `--out` case says the install is isolated instead of printing the
 * daemon/promptd/registry lines the package cannot appear on.
 */
export function installFollowUp(
  installDir: string,
  daemonRoot: string,
  opts: { outOverride: boolean; registryBase: string }
): string[] {
  if (opts.outOverride) {
    return [
      `NOTE: the daemon serves packages from ${daemonRoot}, NOT ${installDir} — this --out install is isolated.`,
      `To serve it, install without --out.`,
    ];
  }
  return [
    `The daemon serves installed capability packages from ${daemonRoot}:`,
    `  ui2api promptd`,
    `  curl -s ${opts.registryBase}/registry`,
  ];
}

/**
 * The install's own line, split by WHO SAID IT.
 *
 * `Installed ${host} v${result.version} (${result.trust}) -> ${result.dir}` read as
 * one verified sentence, and it is three different kinds of statement glued
 * together:
 *
 *   - `host`, `result.dir`, `result.files` are LOCAL facts. The install ran, it
 *     wrote these bytes to this directory, it can list them. The daemon really
 *     does serve from there.
 *   - `result.version` and `result.trust` are NOT. They are `index[host].version`
 *     and `index[host].trust` (src/registry/install.ts:335-336), read straight off
 *     the REGISTRY INDEX — a stranger's JSON, fetched over the network from
 *     `--registry` / `UI2API_REGISTRY_URL` — and defaulted to the strings
 *     `"unknown"` / `"unreviewed"` when the stranger omits them. So `v1.2.3` is
 *     whatever the stranger typed, and `(reviewed)` is the stranger grading its
 *     OWN package. Nothing in the install path compares either value against the
 *     bytes that were actually fetched, so an operator reading that line had NO
 *     way to know the difference between "this install confirmed v1.2.3" and "a
 *     stranger asserted v1.2.3 and we believed it".
 *
 * The information is not removed — an operator needs both numbers — it is
 * LABELLED by provenance, using the same voice the repo already uses for things
 * nobody has verified (`unverified-candidate` in src/prompt/registry.ts:387):
 * `registry-claims-trust`. The claim is reported; the fact is not.
 */
export function installSummaryLine(
  host: string,
  dir: string,
  claim: { version: string; trust: string },
  registryBase: string
): string[] {
  return [
    `Installed ${host} -> ${dir}`,
    `  registry-claims-trust: version=v${claim.version} trust=${claim.trust}`,
    `    ^ UNVERIFIED third-party claim from the registry index at ${registryBase}.`,
    `      The install fetched and validated package FILES; it did not check these two values.`,
  ];
}

async function cmdInstall(host: string, flags: Flags): Promise<void> {
  const reg = flags.registry ?? process.env.UI2API_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  // The install target is the packages root (capabilities/<site>/) — the same
  // layout the daemon serves from (resolvePackagedProfile / buildRegistryPackages).
  // --out overrides it (e.g. into a temp dir for a clean/isolated install).
  const daemonRoot = defaultPackagesRoot();
  const root = flags.out ?? daemonRoot;
  const result = await installPackage(host, reg, root);
  const profileAbs = existsSync(resolve(result.dir, "profile.json"))
    ? resolve(result.dir, "profile.json")
    : undefined;
  for (const line of installSummaryLine(host, result.dir, result, reg)) {
    console.log(line);
  }
  console.log(`Files: ${result.files.join(", ")}`);
  for (const line of installFollowUp(result.dir, daemonRoot, {
    outOverride: flags.out !== undefined,
    registryBase: `localhost:${process.env.PORT ? Number(process.env.PORT) : 9797}`,
  })) {
    console.log(line);
  }
  if (profileAbs) {
    console.log(`Or prompt it directly via the ChatDriver with its packaged profile:`);
    console.log(`  ui2api prompt "hello" --site ${host} --profile ${profileAbs}`);
  }
}

async function cmdLangGen(host: string | undefined, flags: Flags): Promise<void> {
  const lang = flags.lang ?? "php";
  if (lang !== "php")
    throw new Error("langgen: only --lang php is implemented so far (laravel-compatible composer package)");
  const { buildRegistryPackages } = await import("./prompt/registry.js");
  const { generatePhpMaps } = await import("./generator/lang-php.js");
  const packages = buildRegistryPackages();
  if (host && !packages.some((p) => p.id === host))
    throw new Error(`langgen: no served registry package for '${host}' (installed: ${packages.map((p) => p.id).join(", ") || "none"})`);
  const outRoot = flags.out || resolve(process.cwd(), "sites", "map", lang);
  const dirs = generatePhpMaps(packages, outRoot, host);
  if (dirs.length === 0) throw new Error("langgen: no served registry packages to generate (run ui2api install <site> first)");
  for (const d of dirs) console.log(`Generated ${lang} map package -> ${d} (composer.json + src/, one method per capability)`);
}

async function cmdRemap(host: string, flags: Flags): Promise<void> {
  const root = sitesRoot(flags);
  const prevPath = mapPath(host, root);
  if (!existsSync(prevPath)) throw new Error("No action-map for " + host + ". Run analyse first.");
  const prev = validateActionMap(JSON.parse(readFileSync(prevPath, "utf8")));
  const map = await analyse(prev.url, { root: flags.root, outDir: root });
  // Diff: keep stable names, flag removed as deprecated.
  const prevNames = new Set(prev.actions.map((a) => a.name));
  const newNames = new Set(map.actions.map((a) => a.name));
  const added = [...newNames].filter((n) => !prevNames.has(n));
  const removed = [...prevNames].filter((n) => !newNames.has(n));
  writeFileSync(mapPath(host, root), JSON.stringify(map, null, 2));
  writeFileSync(
    resolve(root, host, "remap-diff.json"),
    JSON.stringify({ added, removed, kept: [...newNames].filter((n) => prevNames.has(n)) }, null, 2)
  );
  console.log(`Remap done. added=${added.length} removed=${removed.length}`);
  if (removed.length) console.log("DEPRECATED (downstream-safe): " + removed.join(", "));
}

async function cmdHubRun(host: string, flags: Flags): Promise<void> {
  if (!host) throw new Error("usage: ui2api hub run <host> [--acp] [--port N] [--data-dir DIR] [--engine wigolo|native]");
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  const store = new RegistryStore(dataDir);
  const rt = new HubRuntime({ store, dataDir });
  if (flags.engine) validateEngine(flags.engine);
  if (flags.engine) process.env.UI2API_ENGINE = flags.engine;
  const inst = await rt.getInstance(host);
  if (flags.acp) await serveInstanceAcp(inst, Number(flags.port ?? 8788));
  else await serveInstanceStdio(inst);
}

async function cmdHubPublish(host: string, flags: Flags = {}): Promise<void> {
  if (!host) throw new Error("usage: ui2api hub publish <host> [--mirror] [--registry-repo URL] [--data-dir DIR]");
  const sitesRoot = resolve(process.cwd(), "sites");
  // `--data-dir` is honored here by the SAME convention the sibling paths use
  // (cmdHubRun, cmdPluginServe, cmdPrompt: `flags.dataDir ?? <cwd>/data`).
  // It used to hardcode `resolve(process.cwd(), "data")`, which made the flag
  // INERT on publish — `hub publish <host> --data-dir <other>` still wrote into
  // `<cwd>/data/packages/<host>/` and never created `<other>`. That is a
  // CONTAINMENT defect, not a cosmetic one: run from the repo, `<cwd>/data` is
  // the live session vault (data/sessions/**), so a publish aimed at a scratch
  // dir wrote beside real credentials.
  const pkgRoot = flags.dataDir ?? resolve(process.cwd(), "data");
  const meta = {
    author: process.env.UI2API_HUB_AUTHOR || "cli",
    use: process.env.UI2API_HUB_USE || `own use of ${host}`,
  };
  // WRITE-BEFORE-TRUTH-GATE (the class session-store.ts's write gate and
  // registry/install.ts's install gate exist to kill — in the one publish path
  // nobody had looked): this used to call buildPackage() with the REAL pkgRoot
  // and only then PUT, so a REFUSED publish (4xx, or an unreachable hub) exited
  // 1 with metadata.json + action-map.json already on disk. buildPackage is the
  // ONLY writer of that pair (src/hub/publish-contract.ts derives the manifest
  // field set FROM it), so it cannot simply stop writing: the fix is ORDER.
  // Build into a private staging root, PUT against the hub's gate, and copy the
  // pair into pkgRoot ONLY after the gate accepted it. Every refusal path —
  // 4xx, unreachable hub, thrown fetch — unwinds through `finally` and removes
  // the staging root, so a failed publish leaves the tree byte-identical.
  const stagingRoot = mkdtempSync(resolve(tmpdir(), "ui2api-publish-"));
  try {
    const dir = buildPackage(host, sitesRoot, stagingRoot, meta);
    const metadata = JSON.parse(readFileSync(resolve(dir, "metadata.json"), "utf8"));
    const map = JSON.parse(readFileSync(resolve(dir, "action-map.json"), "utf8"));
    const manifest = { ...metadata, version: metadata.version || "1.0.0" };
    const moduleText = JSON.stringify(map, null, 2);
    const base = process.env.UI2API_HUB_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
    const token = process.env.UI2API_HUB_TOKEN ?? "";
    let r: Response;
    try {
      r = await fetch(`${base}/api/packages`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ manifest, module: moduleText }),
      });
    } catch (e) {
      // Unreachable hub / DNS / socket — the same gate, reached as a throw.
      // NAMED and loud, and it writes NOTHING: the staging root is removed by
      // the `finally` below and pkgRoot was never touched.
      throw new Error(
        `publish-refused: hub unreachable at ${base} (${e instanceof Error ? e.message : String(e)}) — ` +
          `nothing was written to ${pkgRoot}`
      );
    }
    if (!r.ok) {
      // The gate said no. Refuse LOUD with its own verdict, and write NOTHING:
      // no `process.exit` here — it would skip the `finally` that removes the
      // staging root. A non-ok publish exits 1 via main()'s top-level handler.
      throw new Error(`publish-refused: hub answered ${r.status} — ${(await r.text()).trim() || "(empty body)"} — nothing was written to ${pkgRoot}`);
    }
    // The gate ACCEPTED it: now, and only now, does the pair land under pkgRoot.
    const committed = resolve(pkgRoot, "packages", host);
    mkdirSync(committed, { recursive: true });
    copyFileSync(resolve(dir, "metadata.json"), resolve(committed, "metadata.json"));
    copyFileSync(resolve(dir, "action-map.json"), resolve(committed, "action-map.json"));
    console.log(`[ui2api] published ${manifest.name}@${manifest.version}`);
    if (flags.mirror) {
      pushToMirror({ name: manifest.name, version: manifest.version, manifest: manifest as Record<string, unknown>, module: moduleText }, { repoUrl: flags.registryRepo });
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function cmdPluginServe(modulePath: string, flags: Flags): Promise<void> {
  if (!modulePath) throw new Error("usage: ui2api plugin serve <module.ts> [--base-url URL] [--data-dir DIR] [--account SLUG|EMAIL]");
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  const baseUrl = flags.baseUrl ?? "https://example.com";
  const loaded = await loadPluginModule(resolve(modulePath), { dataDir, account: flags.account }, baseUrl);
  console.log(`[ui2api] serving plugin ${loaded.manifest?.name ?? modulePath} (${loaded.tools.size} tools) over MCP`);
  await servePlugin(loaded, { trust: true });
}

async function cmdPrompt(text: string, flags: Flags): Promise<void> {
  if (flags.sites) {
    for (const p of defaultChatProfiles()) {
      const status = chatSurfaceStatus(p.id);
      const statusSuffix = status === "builtin" ? "" : status === "verified" ? " — VERIFIED" : ` — ${status}`;
      console.log(`${p.id.padEnd(12)} ${p.name} — ${p.loginRequired ? "login required" : "anonymous"}${statusSuffix}`);
    }
    console.log(`\ndefault: ${defaultSiteId()}`);
    return;
  }
  if (!text?.trim()) {
    throw new Error(
      "usage: ui2api prompt '<text>' [--site gemini|chatgpt|claude|copilot|perplexity|huggingchat] [--profile FILE] [--new] [--model NAME] [--timeout-ms N] [--data-dir DIR] [--json]"
    );
  }
  // GOAL 62: the override seam must never silently drop the tuning file —
  // --site + --profile enforces id AGREEMENT (mismatched file.id -> LOUD
  // named error), absent file.id tunes the requested site. --profile alone
  // keeps the file-id-picks-base semantics unchanged.
  const profile =
    flags.site && flags.profile
      ? resolveProfileWithOverride(flags.site, flags.profile)
      : resolveProfile(flags.site ?? flags.profile);
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  // Same vault-validated account guard as the daemon surfaces: an unknown
  // account fails loudly (non-zero) BEFORE any browser work, never a silent
  // fallback to the legacy default session.
  resolveCapabilityAccount(flags.account, profile, dataDir);
  const driver = new ChatDriver(profile, { dataDir, account: flags.account });
  try {
    const r = await driver.ask(text, { newChat: flags.newChat, timeoutMs: flags.timeoutMs, ...(flags.model ? { model: flags.model } : {}) });
    if (flags.json) {
      console.log(JSON.stringify({ site: profile.id, account: flags.account ?? "default", ...r }, null, 2));
    } else {
      console.log(r.answer);
      console.error(`[ui2api] ${profile.id}${flags.account ? ` / ${flags.account}` : ""} · ${r.doneReason} · ${r.chunkCount} reads · ${r.url}`);
    }
  } finally {
    await driver.close();
  }
}

async function cmdLiveProof(flags: Flags): Promise<void> {
  const a = Math.floor(Math.random() * 10000) + 2;
  const b = Math.floor(Math.random() * 10000) + 2;
  const expected = a + b;
  console.log(`[proof] a=${a} b=${b} expected=${expected}`);
  const profile = resolveProfile(flags.site ?? "copilot");
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  // Same vault-validated account guard as `prompt` (live-proof rides accounts too).
  resolveCapabilityAccount(flags.account, profile, dataDir);
  const question = `What is ${a} + ${b}? Reply with ONLY the number, no words or explanation.`;
  // The host can hard-kill a fresh browser seconds after spawn (int3 trap), so
  // a live proof must ride fresh spawns until one survives the streamed answer.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const driver = new ChatDriver(profile, { dataDir, account: flags.account });
    try {
      console.log(`[proof] attempt ${attempt} — asking ${profile.id}: ${question}`);
      const r = await driver.ask(question, { timeoutMs: 55000, stableMs: 1200 });
      const match = String(r.answer).match(/[\d,]+/g);
      const got = match ? Number(match[match.length - 1]!.replace(/,/g, "")) : NaN;
      const pass = got === expected;
      console.log(`[proof] answer: ${r.answer}`);
      console.log(`[proof] parsed=${got} expected=${expected} -> ${pass ? "PASS" : "FAIL"}`);
      if (pass) {
        process.exitCode = 0;
        return;
      }
    } catch (e) {
      console.log(`[proof] attempt ${attempt} died: ${(e as Error).message.split("\n")[0].slice(0, 100)}`);
    } finally {
      await driver.close().catch(() => {});
    }
  }
  console.log("[proof] FAILED: no surviving browser completed the round-trip");
  process.exitCode = 1;
}

async function cmdPromptd(flags: Flags): Promise<void> {
  const port = Number(flags.port ?? process.env.UI2API_PROMPTD_PORT ?? 9797);
  // ROUND N+99 — this was `resolve(process.cwd(), "data")`, which never consults
  // UI2API_DATA_DIR. That works by ACCIDENT in a checkout, because the cwd IS the
  // repo and the repo has a data/ next to it. It breaks the moment the same code
  // runs from anywhere else, and it broke the moment it did.
  //
  // MEASURED, deployed: cwd /opt/ui2api, UI2API_DATA_DIR pointing at the real
  // vault, and `listAccounts` returned **0 accounts for every chat-profile site**
  // — gemini, deepseek, kimi all empty — while package-only sites like araprat
  // worked. Two resolvers were live inside ONE handler: the chat-profile branch
  // (`http.ts:729`) took this cwd-derived value and read a nonexistent
  // /opt/ui2api/data, while the package branch (`http.ts:731` ->
  // `registryPackageFor` -> `resolveDataDir()`) read the env var and got it
  // right.
  //
  // The service was healthy the whole time: /health ok, /registry serving 33
  // packages, /v1/models serving 22 models. It would have replayed SIGNED-OUT on
  // every chat site, and reported success while doing it. A wrong vault path is
  // not an error, it is a silent total failure — which is why the deploy asserts
  // the vault is visible rather than trusting a green health check.
  //
  // One resolver, env-aware, is the whole fix: `resolveDataDir()` honours
  // UI2API_DATA_DIR and falls back to the cwd-relative default, so the checkout
  // behaviour is unchanged and the deployed behaviour becomes correct.
  const dataDir = flags.dataDir ?? resolveDataDir();
  const profiles = flags.site && flags.profile
    ? [resolveProfileWithOverride(flags.site, flags.profile)]
    : flags.site ? [resolveProfile(flags.site)] : flags.profile ? [resolveProfile(flags.profile)] : undefined;
  const svc = await startPromptd({
    port,
    dataDir,
    // The knob NAME comes from the one definition site (prompt/posture.ts), never
    // from a literal typed here — a renamed knob that only this file still
    // answers to is how a gate silently stops gating.
    token: process.env[TOKEN_ENV] ?? "",
    profiles,
    min: flags.poolMin,
    max: flags.poolMax,
  });
  const shown = profiles ? profiles.map((p) => p.id).join(", ") : defaultChatProfiles().map((p) => p.id).join(", ");
  console.log(`[ui2api] promptd on http://127.0.0.1:${svc.port} · sites: ${shown} · default: ${defaultSiteId()}`);
  console.log(`[ui2api] POST /prompt  {"prompt":"...", "site":"gemini", "newChat":true}`);
  console.log(`[ui2api] POST /capability/<site>  ·  GET /registry  ·  GET /sites  ·  GET /accounts?site=  ·  GET /v1/models  ·  POST /v1/chat/completions`);
  console.log(`[ui2api] GET  /status  -> pool (warm/idle/busy pages)  ·  GET /requirements -> OS-level readiness (GOAL 33)  ·  UI2API_POOL_MIN/MAX=${flags.poolMin ?? "auto"}/${flags.poolMax ?? "auto"} · UI2API_ATTACH_PORT=${process.env.UI2API_ATTACH_PORT ?? "off"}`);
  const shutdown = async (): Promise<void> => { await svc.close(); process.exit(0); };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  svc.server.on("error", (e) => {
    console.error("[ui2api] promptd error:", e.message);
    process.exit(1);
  });
}

async function cmdProfileCapture(url: string, flags: Flags): Promise<void> {
  const dataDir = resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data");
  const host = new URL(url).host;

  // --assist: xhost display-share flow — data prefers the ui2api user (verbatim
  // 1495: "data ill be stored in the ui2api user not the current user"). The
  // browser runs headed on the caller's X display; the user logs in the
  // regular visual way. The data dir is the explicit flag/env override, else
  // the ui2api user's XDG data dir WHEN genuinely writable from this session,
  // else the current-user data dir (honest fallback — never fake the claim).
  if (flags.assist) {
    const { assistedLoginFlow, captureProfileFromLiveChrome, ui2apiUser, ui2apiUserDataDir, detectDisplayInfo } = await import("./runtime/xhost-capture.js");
    const { resolve } = await import("node:path");
    const ui2apiDataDir = ui2apiUserDataDir();
    const dataDir = flags.dataDir ?? process.env.UI2API_DATA_DIR ?? ui2apiDataDir ?? resolve(process.cwd(), "data");
    const vaultOwner = ui2apiDataDir ? `ui2api user (${dataDir})` : `current user (${dataDir}${flags.dataDir || process.env.UI2API_DATA_DIR ? ", explicit override" : " — ui2api-user dir not writable from this session"})`;
    const waitForEnter = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question("Press Enter once logged in: ", () => {
          rl.close();
          resolve();
        });
      });
    const display = detectDisplayInfo();
    if (!display) throw new Error("--assist requires a visible X display (set DISPLAY=:0 or similar)");
    const user = ui2apiUser();
    const { existsSync } = await import("node:fs");
    const profileDir = resolve(dataDir, `chrome-${host}`);
    const result = await assistedLoginFlow({
      url, host, dataDir, profileDir, display: display.display,
      ui2apiUser: user, relaxMode: flags.xhostAll ? "all" : "specific",
      identity: flags.identity,
    });
    if (!result.browserLaunched) throw new Error(result.error ?? "failed to launch browser");
    console.log(`[ui2api] Browser launched as ${user} on display ${display.display}.`);
    console.log(`  Log in to ${host} in the browser window, then return here and press Enter.`);
    await waitForEnter();
    const captured = await captureProfileFromLiveChrome({ profileDir, host, dataDir, identity: flags.identity });
    // GOAL 49 write truth gate: an anonymous capture returns an empty
    // snapshotPath — nothing was written, so no "captured" claim and no
    // capability fingerprint against an account that does not exist.
    if (!captured.snapshotPath) {
      console.warn(`[ui2api] nothing saved — no account written for ${host} (see named verdict below)`);
      for (const w of captured.warnings) console.warn(`  ! ${w}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[ui2api] identity-keyed session captured for ${host}:`);
    console.log(`  identity: ${captured.identity}`);
    console.log(`  snapshot: ${captured.snapshotPath}`);
    console.log(`  (data vault: ${vaultOwner})`);
    // Capability reflection at capture end: probe what THIS account can do.
    try {
      const { listProfiles } = await import("./profile/profile.js");
      const profile = listProfiles().find((p) => new URL(p.url).host === host || p.url.includes(host));
      if (profile) {
        const report = await probeAccountCapabilities(profile, captured.identity, dataDir);
        console.log(`[ui2api] capability fingerprint for ${profile.id}: ${report.ok ? `ok (${report.models.length} models, tier: ${report.tier.value ?? "?"})` : `unreadable (${report.reason})`}`);
      }
    } catch (e) {
      console.warn(`[ui2api] capability probe skipped: ${e instanceof Error ? e.message : e}`);
    }
    return;
  }

  // --login is the DEFAULT capture mode and is implied: `profile capture` is
  // login-first by design — its whole purpose is saving the user's sign-in. The
  // default path below runs the SAME interactive sign-in flow `analyse --login`
  // uses (doInteractiveLogin: headed browser via the buildLaunchOptions/launchBrowser
  // seam, the user signs in, presses Enter, and cookies + full profile snapshot
  // are saved). Accept the flag explicitly so `profile capture <url> --login` is a
  // real documented command (it was parsed by parseFlags but silently ignored here).
  if (flags.login) {
    console.log(`[ui2api] capture is login-first — opening the sign-in flow for ${host} (--login is the default capture mode)`);
  }

  // Default capture: headed browser as current user (existing flow). The login
  // profile lives in the SAME private session dir the snapshot is written to, so
  // the sign-in is durable and stays inside the gitignored `.session` tree.
  const session = await doInteractiveLogin(url, host, dirname(snapshotPath(dataDir, host)));
  const identity = flags.identity;
  if (identity) {
    // GOAL 50 account-INDEX collision gate: a same-slug DIFFERENT identity
    // already in the vault is refused (nothing overwritten, never a silent
    // destruction of the existing account); same identity = latest-wins.
    const collision = slugCollision(dataDir, host, identity);
    if (collision) {
      console.error(`[ui2api] nothing saved — account "${collision.slug}" already exists as "${collision.identity}" (slug-collision, NOT overwritten)`);
      console.error(`  captured identity "${identity}" collides on ${host} — use the SAME identity to re-capture, or list/remove the existing account first.`);
      process.exitCode = 1;
      return;
    }
    saveAccountSnapshot(dataDir, host, identity, session.snapshot, { source: "capture" });
    console.log(`[ui2api] profile captured for ${host} (identity: ${identity}):`);
    console.log(`  snapshot -> ${snapshotPath(dataDir, host)}`);
    // Capability reflection at capture end — probe the fresh session.
    try {
      const { listProfiles } = await import("./profile/profile.js");
      const profile = listProfiles().find((p) => new URL(p.url).host === host || p.url.includes(host));
      if (profile) {
        const report = await probeAccountCapabilities(profile, identity, dataDir);
        console.log(`[ui2api] capability fingerprint for ${profile.id}: ${report.ok ? `ok (${report.models.length} models, tier: ${report.tier.value ?? "?"})` : `unreadable (${report.reason})`}`);
      }
    } catch (e) {
      console.warn(`[ui2api] capability probe skipped: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    saveCookies(sessionPath(dataDir, host), session.cookies);
    saveSnapshot(snapshotPath(dataDir, host), session.snapshot);
    console.log(`[ui2api] profile captured for ${host}:`);
    console.log(`  cookies  -> ${sessionPath(dataDir, host)}`);
    console.log(`  snapshot (cookies + localStorage + sessionStorage + IndexedDB) -> ${snapshotPath(dataDir, host)}`);
  }
  // GOAL 49 claim gate: the "logged-in session" claim only prints for a usable
  // snapshot (cookies or localStorage present). A fully anonymous capture is
  // saved for the record but never claimed as a signed-in session.
  if (snapshotHasAuth(session.snapshot)) {
    console.log(`Sites driven through ui2api now see your logged-in session — chat history persists.`);
  } else {
    console.warn(`[ui2api] warning: no cookies and no localStorage captured for ${host} (logged out?) — this capture carries no session to reuse.`);
  }
}

async function cmdProfileIngest(host: string, flags: Flags): Promise<void> {
  const dataDir = resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data");
  const { ingestProfile } = await import("./runtime/profile-ingest.js");
  const { snapshot, stats, profileDir, warnings } = await ingestProfile({
    targetHost: host,
    profileDir: flags.profile,
  });
  // GOAL 49 write truth gate: an anonymous snapshot (zero cookies AND zero
  // localStorage in the CONTENT) is refused at the write seam — never saved to
  // disk, never claimed "logged in". Named message + nonzero exit (scriptable
  // gates), so a logged-out ingest fails LOUD instead of writing a fake account.
  if (!snapshotHasAuth(snapshot)) {
    console.error(`[ui2api] nothing saved — no cookies and no localStorage matched ${host} (logged out?) — no vault account written`);
    for (const w of warnings) console.warn(`  ! ${w}`);
    process.exitCode = 1;
    return;
  }
  const target = snapshotPath(dataDir, host);
  saveSnapshot(target, snapshot);
  console.log(`[ui2api] ingested ${profileDir} -> ${target}`);
  console.log(`  cookies: ${stats.cookiesMatched}/${stats.cookiesTotal} matched for ${host} (${stats.decrypted} decrypted, ${stats.undecryptable} skipped)`);
  console.log(`  localStorage: ${stats.localStorageEntries} entries for ${snapshot.origin}`);
  for (const w of warnings) console.warn(`  ! ${w}`);
  console.log("Sites driven through ui2api now see this logged-in session — chat history persists.");
}

// OS-wide Chrome profile scan: find any site with stored data in ANY Chrome
// profile on the machine (v1 gate: "scan the Linux of our user"). The result is
// a checkbox-index list of importable sessions.
async function cmdProfileScan(flags: Flags): Promise<void> {
  const { findAllChromeProfilesOnOs, scanProfilesForSites, renderCheckboxList } = await import("./runtime/profile-scan.js");
  const { profiles, skipped } = findAllChromeProfilesOnOs();
  if (profiles.length === 0) {
    console.log("[ui2api] no Chrome/Chromium profiles found on this machine.");
    console.log("  Install + sign in to Chrome (or Chromium), then re-run. Everything else stays local.");
    return;
  }
  const index = scanProfilesForSites(profiles);
  console.log(`[ui2api] scanned ${profiles.length} Chrome profile root(s):`);
  for (const p of profiles) console.log(`  - ${p.root} (user: ${p.user})`);
  console.log("");
  if (index.hits.length === 0) {
    console.log("No sites with stored cookie data were found in any profile.");
    return;
  }
  console.log("Sites found (checkbox index) — import any with:");
  console.log("  ui2api profile import <host> [--identity|--account email]");
  console.log("[ui2api] tip: add ALL known hosts in one step →  ui2api profile add-all [--known|--interactive]");
  console.log("");
  console.log(renderCheckboxList(index.hits));
  if (skipped.length > 0) {
    console.log("");
    console.warn(`Skipped (unreadable/denied): ${skipped.length} path(s) — run as the owning user or check permissions.`);
  }
  console.log("");
  console.log(`Tip: ${index.hits.filter((h) => h.known).length} of ${index.hits.length} hosts match known AI chat sites.`);
}

// GOAL 80: `profile import` keys the vault entry by the identity the user
// asked for. ONBOARDING §4b's copy-paste command named `--account email` while
// cmdProfileImport only read `--identity` — the flag was parsed and silently
// DEAD, so the import landed under the auto-detected identity instead. The
// canonical name stays `--identity` and `--account` now maps onto it; the
// import success output echoes the resolved identity so a requested-vs-detected
// divergence is never silent. Pure flag read — no I/O, directly unit-testable.
export function importIdentityArg(flags: Flags): string | undefined {
  return flags.identity ?? flags.account;
}

// Import one host from a scanned Chrome profile into the identity-keyed vault.
async function cmdProfileImport(host: string, flags: Flags): Promise<void> {
  const dataDir = resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data");
  const { findAllChromeProfilesOnOs, importSiteSnapshot } = await import("./runtime/profile-scan.js");
  const { profiles, skipped } = findAllChromeProfilesOnOs();
  const profileFilter = flags.profile;
  const chosen = profileFilter
    ? profiles.filter((p) => p.root === profileFilter || p.root.endsWith(profileFilter))
    : profiles;
  if (chosen.length === 0) {
    console.error("[ui2api] no matching Chrome profile. Available:");
    for (const p of profiles) console.error(`  ${p.root}  (user: ${p.user})`);
    if (skipped.length > 0) console.error(`  (${skipped.length} path(s) skipped — check permissions)`);
    throw new Error("no chrome profile found for import");
  }
  const wanted = host.toLowerCase();
  const requestedIdentity = importIdentityArg(flags);
  let found = false;
  for (const p of chosen) {
    try {
      const r = await importSiteSnapshot({ root: p.root, host: wanted, dataDir, identity: requestedIdentity });
      found = true;
      if (!r.snapshotPath) {
        // GOAL 49/50 write truth gates: a refused import (anonymous content,
        // or a same-slug identity collision) was NOT written — nothing saved,
        // no "imported" claim, named verdict in the warnings.
        console.warn(`[ui2api] nothing saved for ${r.host} from ${p.root}:`);
        console.warn(`  identity: ${r.identity}`);
        console.warn(`  cookies: ${r.stats.cookiesMatched}/${r.stats.cookiesTotal} matched`);
        for (const w of r.warnings) console.warn(`  ! ${w}`);
        process.exitCode = 1;
        continue;
      }
      console.log(`[ui2api] imported ${r.host} from ${p.root}:`);
      console.log(`  identity: ${r.identity}`);
      if (requestedIdentity && requestedIdentity.trim() !== r.identity) {
        console.warn(`  ! requested identity "${requestedIdentity}" but the import resolved to "${r.identity}"`);
      }
      console.log(`  snapshot: ${r.snapshotPath}`);
      console.log(`  cookies: ${r.stats.cookiesMatched}/${r.stats.cookiesTotal} matched${r.ok ? "" : " (NOT logged in — no cookies matched)"}`);
      console.log(`  localStorage: ${r.stats.localStorageEntries} entries`);
      for (const w of r.warnings) console.warn(`  ! ${w}`);
    } catch (e) {
      console.warn(`  ! ${p.root}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  if (!found) console.warn(`[ui2api] no Chrome profile matched host ${host}`);
}

// List identity-keyed accounts stored in the vault for a site.
async function cmdProfileList(host: string, flags: Flags): Promise<void> {
  const dataDir = resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data");
  const accounts = listAccounts(dataDir, host);
  if (accounts.length === 0) {
    console.log(`[ui2api] no identity-keyed accounts for ${host}.`);
    console.log("  Capture one:  ui2api profile capture https://<host> [--identity email] [--assist]");
    console.log("  Import from Chrome:  ui2api profile import <host>");
    return;
  }
  console.log(`[ui2api] accounts for ${host}:`);
  for (const a of accounts) {
    console.log(`  ${a.slug.padEnd(36)} ${a.identity}  (${a.source}, ${a.capturedAt.slice(0, 10)})`);
  }
  console.log("");
  console.log("Drive one with:  ui2api prompt '...' --site <id> --account <slug|email>");
}

// OS-level requirements readiness check (GOAL 33, the `requirements`/`doctor`
// command): reports every package's verdict — ready / working / on-hold /
// not-ready — with the NAMED reason, BEFORE any browser work. Pure checker
// (src/runtime/requirements.ts): no browser is ever launched (the attach probe
// is an HTTP GET against an already-running Chrome; chrome version is an
// execute-only --version probe). Exit is non-zero when any requested-scope
// package is not-ready (scriptable gates). --json (GOAL 42): the report shape
// the daemon's GET /requirements serves, honoring the `doctor <site>` scope
// (filtered packages + scoped summary — the SAME filtering the human path
// prints, just serialized).

/**
 * GOAL 131: the persistent Chrome daemon. "We should not fire Chrome each time"
 * — the operator's rule. One long-lived Chrome owned by the dedicated `ui2api`
 * user, started once, and every request ATTACHES to it over CDP.
 *
 *   ui2api chrome start    # idempotent: already-running is reported, not respawned
 *   ui2api chrome status
 *   ui2api chrome stop     # refuses to kill a Chrome we did not start
 */
async function cmdChrome(action: string, flags: Flags): Promise<void> {
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  const { startChromeDaemon, stopChromeDaemon, chromeDaemonStatus, resolveAttachPort } = await import(
    "./runtime/chrome-daemon.js"
  );
  if (action === "start") {
    const r = await startChromeDaemon({ dataDir, headless: flags.headed ? false : undefined });
    console.log(`[ui2api] ${r.note}`);
    if (r.started) console.log(`[ui2api] attach with: UI2API_ATTACH_PORT=${r.state?.port} (auto-detected when live)`);
    if (!r.started && !r.state) process.exitCode = 1;
    return;
  }
  if (action === "stop") {
    const r = stopChromeDaemon({ dataDir, force: flags.force });
    console.log(`[ui2api] ${r.note}`);
    if (!r.stopped) process.exitCode = 1;
    return;
  }
  const st = await chromeDaemonStatus(dataDir);
  const port = await resolveAttachPort(dataDir);
  console.log(`[ui2api] ${st.note}`);
  console.log(`[ui2api] attach port: ${port ?? "(none — a browser would be spawned per request)"}`);
  if (!st.running) process.exitCode = 1;
}

// ROUND N+101 — `ui2api vault tighten`: the non-destructive half of the vault
// remediation, and the reason it is safe to run at all.
//
// The readiness file told the operator to "rotate the credentials and tighten the
// modes". Rotation is DESTRUCTIVE, and when a re-capture was actually run on this
// box it overwrote two captured sessions with empty ones. Tightening the modes
// is the half that is safe: the credentials are already world-readable, so
// removing the group/other bits stops FURTHER exposure even though it cannot undo
// the past. `tightenVaultModes` already existed and was already gated; this is
// the operator-facing door onto it.
//
// TWO DEFAULTS, BOTH DELIBERATE:
//
//   - **A DRY RUN IS THE DEFAULT.** Nothing is tightened without an explicit
//     `--apply`. This command touches the credential store of a real account, and
//     the failure mode of a convenience default here is a surprise mutation of
//     the one thing that is hard to get back.
//   - **`--json` is available because the operator may want to diff two runs**,
//     and because a security action you cannot read back is one you cannot audit.
//
// A `--root` flag exists so the SAME code path can be exercised against a
// disposable tree, which is what the gate's non-vacuity proofs rely on.
/**
 * `vault tighten`'s MODE, decided from the two flags that declare one.
 *
 * `--dry-run` was parsed and read NOWHERE: the handler keyed off `flags.apply`
 * alone (`{ dryRun: !apply }`), so the pair `--apply --dry-run` — an operator
 * asking for BOTH, which is exactly the confused sentence a credential-permission
 * tool gets — silently APPLIED. The mode that changes 0600/0700 on files holding
 * real cookies and Bearer tokens was decided by a flag that was ignored, with no
 * refusal and no warning. The dry-run DEFAULT is unchanged and stays the default;
 * what changes is that the contradiction now REFUSES by name instead of being
 * swallowed (same shape as GOAL 85's `addAllModeArg`).
 *
 * Pure — no I/O — so the mode is testable without a vault.
 */
export function vaultTightenModeArg(flags: Pick<Flags, "apply" | "dryRun">): "apply" | "dry-run" {
  if (flags.apply && flags.dryRun) {
    throw new Error(
      "cannot combine --apply and --dry-run (tighten the vault vs report only) — re-run with exactly one",
    );
  }
  return flags.apply ? "apply" : "dry-run";
}

async function cmdVault(sub: string | undefined, flags: Flags): Promise<void> {
  if (sub !== "tighten") {
    console.error(`[ui2api] vault: unknown subcommand ${JSON.stringify(sub ?? "")} — try: ui2api vault tighten [--dry-run|--apply] [--json] [--root DIR]`);
    process.exitCode = 2;
    return;
  }
  const mode = vaultTightenModeArg(flags);
  const apply = mode === "apply";
  const root = flags.root ?? resolveDataDir();
  const res = tightenVaultModes(root, { dryRun: !apply });

  if (flags.json) {
    console.log(
      JSON.stringify(
        { mode: apply ? "apply" : "dry-run", root: res.root, changed: res.changes.length, unchanged: res.unchanged, skippedSymlinks: res.skippedSymlinks.length, errors: res.errors.length, changes: res.changes, errors_detail: res.errors },
        null,
        2
      )
    );
  } else {
    console.log(`[ui2api] vault tighten — ${apply ? "APPLY" : "DRY RUN (pass --apply to tighten)"}`);
    console.log(`[ui2api] root: ${res.root}`);
    for (const c of res.changes) {
      const from = c.oldMode.toString(8).padStart(4, "0");
      const to = c.newMode.toString(8).padStart(4, "0");
      console.log(`[ui2api]   ${c.kind.padEnd(4)} ${c.path}  ${from} -> ${to}${apply ? "" : "   (not applied)"}`);
    }
    console.log(
      `[ui2api] ${res.changes.length} entr${res.changes.length === 1 ? "y" : "ies"} ` +
        `${apply ? "CHANGED" : "would change"}, ` +
        `${res.unchanged} already tight, ${res.skippedSymlinks.length} symlink(s) skipped, ` +
        `${res.errors.length} error(s)`
    );
    if (!apply && res.changes.length > 0) console.log("[ui2api] dry run — nothing was modified. Re-run with --apply to tighten.");
  }

  // A partially-failed security pass must not read as a clean one. Nonzero on any
  // error, in BOTH modes, so a scripted caller cannot mistake either for success.
  if (res.errors.length > 0) process.exitCode = 1;
}

async function cmdRequirements(siteOrEmpty: string, flags: Flags): Promise<void> {
  const { checkRequirements, scopeRequirementsReport } = await import("./runtime/requirements.js");
  const report = await checkRequirements({
    deps: { dataDir: resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data") },
  });
  // GOAL 42: ONE scope helper for both the human table and the --json payload
  // so the machine view can never drift from the printed verdicts.
  const scoped = siteOrEmpty ? scopeRequirementsReport(report, siteOrEmpty) : report;
  if (siteOrEmpty && scoped.packages.length === 0) {
    throw new Error(`unknown site "${siteOrEmpty}" for requirements`);
  }
  if (flags.json) {
    console.log(JSON.stringify(scoped, null, 2));
    const notReady = scoped.packages.filter((p) => p.verdict === "not-ready");
    if (notReady.length > 0) process.exitCode = 1;
    return;
  }
  console.log(`[ui2api] OS-level requirements (doctor) — node ${report.node}`);
  for (const c of report.checks) {
    const mark = c.status === "pass" ? "[ok]  " : c.status === "fail" ? "[FAIL]" : "[skip]";
    console.log(`  ${mark} ${c.id.padEnd(13)} ${c.detail ?? c.reason ?? ""}`);
  }
  console.log("");
  const rows = scoped.packages;
  console.log(`${"site".padEnd(24)} kind            verdict     reasons`);
  for (const p of rows) {
    const reasons = p.reasons.length > 0 ? p.reasons.join("; ") : "driveable now (honestly unverified)";
    console.log(`${p.id.padEnd(24)} ${p.kind.padEnd(14)} ${p.verdict.padEnd(11)} ${reasons}`);
    // GOAL 39: capture-age honesty — the age line for every vault-backed
    // package and the ⚠ stale warn (risk signal only, never an expiry verdict)
    // when the limiting session is older than SESSION_STALE_DAYS.
    if (p.vault.detail) console.log(`  vault: ${p.vault.detail}`);
    if (p.vault.stale && p.vault.reason) console.log(`  ⚠ ${p.vault.reason}`);
  }
  console.log("");
  console.log(
    `summary: ${scoped.summary.ready} ready · ${scoped.summary.working} working · ${scoped.summary["on-hold"]} on-hold · ${scoped.summary["not-ready"]} not-ready`
  );
  const notReady = rows.filter((p) => p.verdict === "not-ready");
  if (notReady.length > 0) {
    console.error(
      `[ui2api] ${notReady.length} package(s) NOT READY (${notReady.map((p) => p.id).join(", ")}) — fix the named reasons, then re-run.`
    );
    process.exitCode = 1;
  }
}

// GOAL 40: the buy-first one-command anonymous self-test. The smoke module
// (src/prompt/smoke.ts) runs the real gates and decides the verdict line; this
// command only prints the outcome + maps it to the exit code — the same data
// dir resolution cmdRequirements uses, the real install seam for the missing
// anonymous package, and a REAL headless ChatDriver round-trip. --json
// (GOAL 42): the machine verdict {ok, site, answer, ms, message,
// installedAnon?, report} — the report the gate computed rides along (the WHY:
// passed-check detail + every package's GOAL-39 vault fields); undefined
// fields are omitted; the exit code stays the gate (smokeExitCode).
async function cmdSmoke(flags: Flags): Promise<void> {
  const { runSmoke, smokeExitCode } = await import("./prompt/smoke.js");
  const outcome = await runSmoke({
    deps: {
      dataDir: resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data"),
      ...(flags.registry ? { registryBaseUrl: flags.registry } : {}),
      ...(flags.out ? { packagesRoot: flags.out } : {}),
    },
  });
  if (flags.json) {
    // JSON.stringify omits undefined-valued keys — answer/ms/installedAnon
    // disappear on paths that don't carry them.
    console.log(
      JSON.stringify(
        {
          ok: outcome.ok,
          site: outcome.site,
          answer: outcome.answer,
          ms: outcome.ms,
          message: outcome.message,
          installedAnon: outcome.installedAnon,
          report: outcome.report,
        },
        null,
        2
      )
    );
    process.exitCode = smokeExitCode(outcome);
    return;
  }
  if (outcome.installedAnon) {
    const res = outcome.installedAnon;
    console.log(
      `smoke: anonymous chat package "${res.siteId}" was missing — installed v${res.version} (${res.trust}) via the registry seam -> ${res.dir}`
    );
  }
  console.log(outcome.message);
  process.exitCode = smokeExitCode(outcome);
}

// GOAL 85: `profile add-all` MODE selection — the checkbox pick vs the bulk
// import. `--interactive` was advertised at six sites (README, AGENTS,
// ONBOARDING ×2, the scan hint, the usage throw) and read NOWHERE, so the
// branch was `if (flags.known) … else …`: bare == the checkbox pick, the flag
// itself INERT, and `--known --interactive` silently took the --known branch —
// inverting the documented "checkbox-pick exactly which hosts to import" with no
// refusal and no warning. Now the flag is REAL and the contradiction REFUSES
// (named, nonzero exit) instead of being swallowed. Pure flag read — no I/O, no
// browser, directly unit-testable without spawning the CLI.
export function addAllModeArg(flags: Pick<Flags, "known" | "interactive">): "known" | "interactive" {
  if (flags.known && flags.interactive) {
    throw new Error("cannot combine --known and --interactive (bulk import vs checkbox pick) — re-run with exactly one");
  }
  return flags.known ? "known" : "interactive";
}

// Import EVERY site session found in the OS's Chrome profiles into the vault in
// ONE command — "a mother fucking command" (verbatim:1582). Scans all profiles,
// lets the user pick from a checkbox list (interactive: bare or --interactive)
// or bulk-imports every KNOWN host with no prompting (--known, the CI/bulk-demo
// path). Every import is then READ BACK from the vault — snapshot on disk,
// account listed, cookies/localStorage present — never an unverified "ok".
async function cmdProfileAddAll(flags: Flags): Promise<void> {
  // GOAL 85: the mode is decided (and a contradictory flag pair refused) BEFORE
  // any OS profile scan runs — a refused invocation costs nothing.
  const mode = addAllModeArg(flags);
  const dataDir = resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data");
  const { findAllChromeProfilesOnOs, scanProfilesForSites, renderCheckboxList, importSiteSnapshot } = await import("./runtime/profile-scan.js");
  const { profiles, skipped } = findAllChromeProfilesOnOs();
  if (profiles.length === 0) {
    console.log("[ui2api] no Chrome/Chromium profiles found on this machine.");
    console.log("  Install + sign in to Chrome (or Chromium), then re-run. Everything else stays local.");
    return;
  }
  const index = scanProfilesForSites(profiles);
  console.log(`[ui2api] scanned ${profiles.length} Chrome profile root(s):`);
  for (const p of profiles) console.log(`  - ${p.root} (user: ${p.user})`);
  console.log("");
  if (index.hits.length === 0) {
    console.log("No sites with stored cookie data were found in any profile.");
    return;
  }
  console.log("Sites found (checkbox index):");
  console.log(renderCheckboxList(index.hits));
  if (skipped.length > 0) {
    console.log("");
    console.warn(`Skipped (unreadable/denied): ${skipped.length} path(s) — run as the owning user or check permissions.`);
  }
  console.log("");

  // Choose which hosts to import. GOAL 85: the branch keys on the RESOLVED mode
  // (addAllModeArg), not on a raw flag read — so --interactive really is the
  // checkbox pick it is documented to be, and a contradictory pair already
  // refused above.
  const chosen: (typeof index.hits)[number][] = [];
  if (mode === "known") {
    chosen.push(...index.hits.filter((h) => h.known));
    if (chosen.length === 0) {
      console.log(`[ui2api] --known: no KNOWN AI chat hosts found — nothing to import.`);
      return;
    }
    console.log(`[ui2api] --known: importing ${chosen.length} KNOWN host(s) without prompting.`);
  } else {
    const answer = await askLine("import selected hosts (comma indices or 'all')? ");
    if (answer.trim().toLowerCase() === "all") {
      chosen.push(...index.hits);
    } else {
      for (const part of answer.split(",")) {
        const n = Number(part.trim());
        if (Number.isInteger(n) && n >= 1 && n <= index.hits.length) chosen.push(index.hits[n - 1]);
      }
    }
    if (chosen.length === 0) {
      console.log("[ui2api] nothing selected — nothing imported.");
      return;
    }
    console.log(`[ui2api] importing ${chosen.length} selected host(s).`);
  }

  // Identity: --identity-prefix overrides the slug base; otherwise the same
  // default `profile import <host>` uses (detected from the profile's
  // Preferences, falling back to the current user).
  const identity = flags.identityPrefix || flags.identity;

  // host -> slug/identity -> verdict table. One row per host, deduped by slug
  // (a host present in several profiles converges on one vault account).
  interface AddAllRow {
    host: string;
    slug: string;
    identity: string;
    verdict: string;
  }
  const rows = new Map<string, AddAllRow>();
  let attempted = 0;
  let hostSucceeded = 0;
  let hostFailed = 0;

  for (const hit of chosen) {
    let hostOk = false;
    // Import from every profile root the scan located for this host.
    for (const root of hit.profiles) {
      attempted++;
      let verdict: string;
      let slug = "";
      let importedIdentity = identity;
      let imp: Awaited<ReturnType<typeof importSiteSnapshot>>;
      try {
        imp = await importSiteSnapshot({ root, host: hit.host, dataDir, identity });
        importedIdentity = imp.identity;
        slug = slugifyIdentity(importedIdentity);
        // GOAL 49/50: a refused import (anonymous content, or a same-slug
        // identity collision) was REFUSED at the write seam — nothing written,
        // nothing to read back. Its row is the named verdict (from the import
        // warnings when available), never persisting as an account.
        if (!imp.ok || !imp.snapshotPath) {
          const collision = imp.warnings.find((w) => w.startsWith("slug-collision"));
          verdict = collision ? "slug-collision (not overwritten)" : "skipped-no-auth (nothing to save)";
        } else {
          // Verification pass: read the account back from the VAULT — same seams
          // `profile list` uses. Never claim ok for something not on disk.
          const listed = listAccounts(dataDir, hit.host).some((a) => a.slug === slug);
          const snap = loadAccountSnapshot(dataDir, hit.host, slug);
          if (!listed || !snap) {
            verdict = "failed(read-back-missing)";
          } else {
            const cookies = (snap.cookies ?? []).length;
            const ls = (snap.localStorage ?? []).length;
            if (cookies === 0 && imp.stats.cookiesMatched > 0) {
              // The profile HAD cookies for this host but every one was
              // undecryptable (app-bound, portal v20 class) — captured but not
              // usable; say so honestly instead of "imported".
              verdict = "decrypt-limited (portal v20)";
            } else if (cookies > 0 || ls > 0) {
              verdict = "imported";
            } else {
              verdict = "skipped-no-auth";
            }
          }
        }
      } catch (e) {
        verdict = `failed(${e instanceof Error ? e.message.split("\n")[0] : String(e)})`;
        if (!slug) slug = flags.identityPrefix || flags.identity || "?";
      }
      if (verdict !== "failed(read-back-missing)" && !verdict.startsWith("failed(")) hostOk = true;
      rows.set(`${hit.host}|${slug}`, {
        host: hit.host,
        slug,
        identity: importedIdentity ?? "?",
        verdict,
      });
    }
    if (hostOk) hostSucceeded++;
    else if (hit.profiles.length > 0) hostFailed++;
  }

  console.log("");
  console.log("[ui2api] add-all result (host -> slug/identity -> verdict):");
  for (const r of rows.values()) {
    console.log(`  ${r.host} -> ${r.identity} (${r.slug}) -> ${r.verdict}`);
  }

  // Exit non-zero only if ALL selected hosts failed AND at least one was
  // attempted (CI sees a real failure); 0 if any succeeded or all were skipped.
  const allFailed = attempted > 0 && hostFailed === chosen.length && hostSucceeded === 0;
  if (allFailed) {
    console.error(`[ui2api] ERROR: all ${chosen.length} selected host(s) failed to import (${attempted} import attempt(s)).`);
    process.exitCode = 1;
  }
}

// Ask one line on stdin (the repo's plain-readline convention for prompts).
async function askLine(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Probe an account's capability fingerprint (models, tier, restrictions) from
 * the LIVE page and store it next to the account snapshot in the vault.
 *   ui2api profile capabilities gemini.google.com --account merezarezaei@gmail.com
 */
/**
 * GOAL 118: an account reference must resolve EXACTLY on every entry point.
 *
 * `profile capabilities --account <X>` used to do a bare
 * `accounts.find(...) ?? accounts[0]`, so an unmatched `X` silently drove the
 * FIRST vault account: it probed, wrote `capabilities.json` for the WRONG
 * account, printed `saved ->`, and exited 0. The daemon already refuses this
 * exactly (src/prompt/http.ts) — one key space, or the write gate and the read
 * gate disagree.
 *
 * The first-account default remains, but ONLY when no account was requested.
 */
export function resolveRequestedAccount(
  accounts: Array<{ identity: string; slug: string }>,
  requested: string | undefined,
  host: string,
): { identity: string; slug: string } {
  if (requested) {
    const match = accounts.find((a) => a.identity === requested || a.slug === requested);
    if (!match) {
      throw new Error(
        `no stored account "${requested}" for "${host}"; available: [${accounts.map((a) => a.slug).join(", ")}]`
      );
    }
    return match;
  }
  return accounts[0]!;
}

async function cmdProfileCapabilities(host: string, flags: Flags): Promise<void> {
  const dataDir = resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data");
  const { listProfiles } = await import("./profile/profile.js");
  const profile = listProfiles().find(
    (p) => p.url.includes(host) || p.id === host || new URL(p.url).host === host
  );
  if (!profile) throw new Error(`no site profile matches "${host}" (known: ${listProfiles().map((p) => p.id).join(", ")})`);
  const siteHost = new URL(profile.url).host;
  const accounts = listAccounts(dataDir, siteHost);
  if (accounts.length === 0) {
    throw new Error(`no identity-keyed accounts for ${siteHost} — capture one first (ui2api profile capture ${profile.url} [--assist])`);
  }
  // GOAL 118: EXACT resolution, or a named refusal. An unmatched --account must
  // never silently fall through to the first account and write its fingerprint.
  const account = resolveRequestedAccount(accounts, flags.account, siteHost);
  if (!flags.account) {
    console.log(`[ui2api] no --account given; using the first stored account: ${account.slug}`);
  }
  const report = await probeAccountCapabilities(profile, account.identity, dataDir);
  const { capabilitiesPath } = await import("./runtime/session-store.js");
  console.log(`[ui2api] capability fingerprint for ${profile.id} / ${account.identity}:`);
  console.log(`  ${JSON.stringify(report, null, 2)}`);
  console.log(`  saved -> ${capabilitiesPath(dataDir, new URL(profile.url).host, account.slug)}`);
}

/**
 * Probe one account's capability fingerprint against the LIVE site and store
 * it in the vault. Shared by `profile capabilities` and capture-time probing.
 */
async function probeAccountCapabilities(
  profile: import("./profile/profile.js").ChatSiteProfile,
  identity: string,
  dataDir: string
): Promise<import("./runtime/capability-probe.js").CapabilityReport> {
  const siteHost = new URL(profile.url).host;
  const snapshot = loadAccountSnapshot(dataDir, siteHost, identity);
  if (!snapshot) throw new Error(`no snapshot for ${identity} on ${siteHost}`);

  const { probeCapabilities } = await import("./runtime/capability-probe.js");
  const { launchBrowser } = await import("./runtime/browser.js");
  const { injectSnapshot, saveCapabilities } = await import("./runtime/session-store.js");

  const browser = await launchBrowser(3, { headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies((snapshot.cookies ?? []) as never[]);
    await injectSnapshot(context, snapshot);
    const page = await context.newPage();
    await page.goto(profile.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Give the site a moment to hydrate the shell before reading.
    await page.waitForTimeout(3000 + Math.floor(Math.random() * 1000));

    const report = await probeCapabilities({
      profile,
      page: page as never,
      account: identity,
    });
    const slug = slugifyIdentity(identity);
    saveCapabilities(dataDir, siteHost, slug, report);
    return report;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  // Parse flags from the whole command line so e.g. `ui2api hub --port N` works
  // even though `--port` would otherwise be swallowed into `arg`.
  const flags = parseFlags(process.argv.slice(2));
  // ── GOAL 215 SEAM 1: UNKNOWN FLAGS REFUSE, AT THE DISPATCH SEAM ────────────
  // Placed here — after parseFlags, BEFORE the switch — so it precedes EVERY
  // command, not just the ones a handler remembered to guard. MEASURED before
  // this line existed: `ui2api prompt "hi" --site duckduckgo --bogus` printed
  // nothing about `--bogus` and went on to a REAL 45-second browser call; the
  // operator's next act was built on the belief the flag had been heard.
  //
  // WHY IT THROWS AND DOES NOT LOG: `main().catch` turns a throw into
  // `console.error("Error:", msg)` + `process.exit(1)` — the same shape
  // cmdGenerate uses for generateTargetRefusal, so a refused flag is a NONZERO
  // EXIT a script can test, never an exit 0 that reads as success.
  const unknownFlag = unknownFlagRefusal(process.argv.slice(2));
  if (unknownFlag) throw new Error(unknownFlag);
  // ── GOAL 215 SEAM 2: A MALFORMED NUMERIC VALUE REFUSES ─────────────────────
  // `--pool-max abc` reached `Number("abc") || undefined` = `undefined` =
  // "auto": the operator asked for a pool and the daemon printed a confident
  // "auto" and started, so the run they asked for was not the run they got.
  // Same throw-not-log seam as above, same nonzero exit.
  //
// `--pool-min 0` IS NOT THIS SEAM'S BUSINESS, and not because it is ambiguous
    // — it is NOT ambiguous. This comment used to call it a deferred product
    // question; `src/prompt/pool.ts:502-504` had already answered it (both the flag
    // and env paths land on the default of 1, so `0` has always meant auto, floor 1).
    // So this fires ONLY on input that is not a number at all, and `0` keeps
    // meaning exactly what it means today. See the long note at the seam above.
    const badNumeric = numericFlagRefusal(process.argv.slice(2));
  if (badNumeric) throw new Error(badNumeric);
  // ── GOAL 215 SEAM 3: A FLAG THAT ONLY MEANS SOMETHING *WITH* ANOTHER ───────
  // These are CONTRADICTIONS, not inertness: the flag was typed, it is read only
  // inside a sibling flag's branch, and the command exits reporting work it did
  // not do. `profile capture --xhost-all` without `--assist` widened nothing,
  // yet opened a browser and reported a capture.
  //
  // COMMAND-SCOPED, so the same flag on a command with no such pairing stays
  // LEGAL — refusing `--xhost-all` on `prompt` would be hostile, not strict.
  const needsCompanion = needsCompanionRefusal(cmd, arg, flags);
  if (needsCompanion) throw new Error(needsCompanion);
  switch (cmd) {
    case "hub": {
      if (arg === "publish") return cmdHubPublish(rest[0] ?? process.env.UI2API_HUB_HOST ?? "", flags);
      if (arg === "run") return cmdHubRun(rest[0] ?? "", flags);
      const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
      const token = process.env.UI2API_HUB_TOKEN ?? "";
      const port = Number(flags.port ?? process.env.PORT ?? 8787);
      const registryUrl = process.env.UI2API_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
      startHub({ port, dataDir, token, registryUrl });
      return;
    }
    case "analyse":
      if (!arg) throw new Error("usage: ui2api analyse <url> [--root App] [--out DIR]");
      return cmdAnalyse(arg, flags);
    case "generate":
      if (!arg) throw new Error("usage: ui2api generate <host> [--out DIR]");
      return cmdGenerate(arg, flags);
    case "serve":
      if (!arg) throw new Error("usage: ui2api serve <host> [--out DIR]");
      return cmdServe(arg, flags);
    case "remap":
      if (!arg) throw new Error("usage: ui2api remap <host> [--out DIR]");
      return cmdRemap(arg, flags);
    case "package":
      if (!arg) throw new Error("usage: ui2api package <host> [--author NAME --use 'authorized-use statement']  (the command REFUSES — GOAL 66: it only knows the DEAD metadata+action-map pair; --author/--use are read and echoed in the refusal, a real package declares them in capabilities/<id>/manifest.json)");
      return cmdPackage(arg, flags);
    case "langgen":
      // Optional <host> targets one package; without it, every served package.
      return cmdLangGen(arg || undefined, flags);
    case "install":
      if (flags.catalog) return cmdInstallCatalog(flags);
      if (!arg) throw new Error("usage: ui2api install <host> [--registry URL] | ui2api install --catalog [--registry URL]");
      return cmdInstall(arg, flags);
    case "plugin": {
      if (arg === "serve") return cmdPluginServe(rest[0] ?? "", flags);
      throw new Error("usage: ui2api plugin serve <module.ts> [--base-url URL] [--data-dir DIR]");
    }
    case "profile": {
      if (arg === "capture") {
        if (!rest[0]) throw new Error("usage: ui2api profile capture <url> [--assist] [--login] [--identity email] [--data-dir DIR]");
        return cmdProfileCapture(rest[0], flags);
      }
      if (arg === "ingest") {
        if (!rest[0]) throw new Error("usage: ui2api profile ingest <host> [--profile DIR] [--data-dir DIR]");
        return cmdProfileIngest(rest[0], flags);
      }
      if (arg === "scan") {
        return cmdProfileScan(flags);
      }
      if (arg === "import") {
        if (!rest[0]) throw new Error("usage: ui2api profile import <host> [--profile DIR] [--identity|--account email] [--data-dir DIR]");
        return cmdProfileImport(rest[0], flags);
      }
      if (arg === "add-all") {
        return cmdProfileAddAll(flags);
      }
      if (arg === "list") {
        if (!rest[0]) throw new Error("usage: ui2api profile list <host> [--data-dir DIR]");
        return cmdProfileList(rest[0], flags);
      }
      if (arg === "capabilities") {
        if (!rest[0]) throw new Error("usage: ui2api profile capabilities <host> [--account email] [--data-dir DIR]");
        return cmdProfileCapabilities(rest[0], flags);
      }
      throw new Error("usage: ui2api profile capture <url> [--assist] [--login] | ingest <host> [--profile DIR] | scan | import <host> | add-all [--known|--interactive] [--identity-prefix STR] | list <host> | capabilities <host> [--account email]");
    }
    case "prompt":
      // GOAL 44: <text> is read flag-aware from the whole argv — so
      // `prompt --json "hello"` and `prompt "hello" --json` ask the SAME
      // text (the old raw argv[2] pass-through sent the literal "--json"
      // flag token to the live default site with "hello" dropped in rest,
      // never read). A flag is never sent as text; no text token ⇒ "" →
      // the cmdPrompt usage throw fires (honest).
      return cmdPrompt(promptTextArg(process.argv.slice(2)), flags);
    case "promptd":
      return cmdPromptd(flags);
    case "vault":
      return cmdVault(arg, flags);
    case "chrome":
      return cmdChrome((arg ?? "status") as "start" | "status" | "stop", flags);
    case "requirements":
    case "doctor":
      // GOAL 43: <site> is read flag-aware from the WHOLE argv — so
      // `requirements --json gemini` and `requirements gemini --json` scope
      // identically (the old positional-only guard silently dropped a site
      // that came after a flag: full 33-package report + a lying exit 1 from
      // unrelated dormant sites). A leading-dash positional is still never a
      // site (`--json`-as-site guard preserved); no site token ⇒ "" = the
      // full report, and the exit code always matches the printed scope.
      return cmdRequirements(requirementsSiteArg(process.argv.slice(2)), flags);
    case "smoke":
      return cmdSmoke(flags);
    case "proof":
    case "live-proof":
      return cmdLiveProof(flags);
    default:
      for (const line of HELP_LINES) console.log(line);
      process.exit(cmd ? 1 : 0);
  }
}

// Run the CLI only when this module IS the entry point. Importing cli.ts from
// a test pulls the pure helpers (requirementsSiteArg) without executing main()
// — process.exit at the end of main() would otherwise kill the test runner.
function isCliEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  main().catch((e) => {
    console.error("Error:", e.message);
    process.exit(1);
  });
}
