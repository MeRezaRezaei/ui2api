/**
 * THE CONSUMER-SURFACE PROJECTION — what a vault row is allowed to become on
 * the wire.
 *
 * A `StoredAccount` is an INTERNAL record. It names where the row came from on
 * this machine (`profileDir` — a real host filesystem path), how it was
 * acquired (`source` — our import vocabulary), who it belongs to in full
 * (`identity`, and the reconciler that validates it), and carries a verdict
 * whose prose explains which credential stores were examined and which
 * internal gate number refused the row. A consumer of an OpenAI-compatible
 * socket has no field for any of that, and cannot act on any of it: the path
 * is unreadable, the source is our word, the identity is a second spelling of
 * a value the caller already sent, and the verdict prose is bookkeeping.
 *
 * The projection is an ALLOW list, not a denylist, and that is the whole point.
 * The reconciler (`verifyStoredAccount`) attaches more diagnostic fields over
 * time — a denylist would publish each new one the moment it appeared, which
 * is how a leak reappears after a fix nobody touched. Here a new column is
 * published only when somebody deliberately adds it below, and the gate in
 * `test/consumer-abstraction-gate.test.ts` asserts the list, so widening the
 * wire contract is always a visible edit.
 *
 * This narrows the wire. It never widens access: no row is dropped, no
 * permission changes, and an account the caller may not use is still refused
 * by the same `resolveStoredAccount` gate it was refused by before. The only
 * thing that changes is WHICH BYTES of a permitted row cross the socket.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { StoredAccount } from "../runtime/session-store.js";
import {
  CONSUMER_ACCOUNT_FIELDS,
  consumerAccount,
  consumerAccounts,
  type ConsumerAccount,
} from "../runtime/session-store.js";

// The projection itself lives in `src/runtime/session-store.ts`, beside the row
// it projects, because the ROW carries it: `withAccountVerdict` installs a
// `toJSON` on every served row, so JSON.stringify — the only way a row leaves
// this process — yields the consumer shape from every route at once. A
// projection applied per-route is a projection a route can forget, and a
// forgotten route is how a leak returns after a fix nobody touched. These
// re-exports keep the consumer-surface entry point (and the gate that reads it)
// pointed at one implementation.

export { consumerAccount, consumerAccounts };
export type { ConsumerAccount };

/** The complete set of keys a consumer may ever see on an account row. The
 *  gate asserts this exact list, so widening the wire contract is a visible
 *  edit rather than a field the reconciler grows into publication. */
export function consumerAccountFields(): readonly (keyof ConsumerAccount)[] {
  return CONSUMER_ACCOUNT_FIELDS;
}

/**
 * The internal verdict reasons, translated. Each internal reason names the
 * mechanism that produced it (`snapshot-missing`, the credential stores a
 * reconciliation examined, an internal gate number), none of which a consumer
 * can act on; what the consumer CAN act on is the class of thing that is wrong
 * with the stored session. An unrecognised internal reason is never echoed —
 * it degrades to the honest generic, so a new internal reason can never reach
 * the wire by default.
 */
const REASONS: ReadonlyArray<{ internal: RegExp; say: string }> = [
  { internal: /snapshot-missing|no index row/, say: "no stored session" },
  { internal: /snapshot-unreadable/, say: "stored session unreadable" },
  { internal: /anonymous/, say: "stored session has no logged-in state" },
  { internal: /shape-invalid/, say: "stored session is not readable" },
];

export function consumerReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return REASONS.find((r) => r.internal.test(reason))?.say ?? "stored session cannot drive a request";
}

/** The rollup a consumer needs to decide whether to trust a site's accounts:
 *  counts, and the reason CLASSES — never the internal verdict strings. */
export interface ConsumerAccountsSummary {
  total: number;
  usable: number;
  unusable: number;
  reasons: string[];
}

export function consumerAccountsSummary(rows: readonly StoredAccount[]): ConsumerAccountsSummary | undefined {
  if (rows.length === 0) return undefined;
  const unusable = rows.filter((a) => a.usable === false);
  return {
    total: rows.length,
    usable: rows.length - unusable.length,
    unusable: unusable.length,
    reasons: [...new Set(unusable.map((a) => consumerReason(a.reason) ?? "stored session cannot drive a request"))],
  };
}

/** The verification record as a CONSUMER may read it. */
export interface ConsumerVerifiedRecord {
  /** Fixed, mechanism-free: a recorded live round-trip is what the record
   *  asserts, and that is the whole of what a consumer can act on. */
  evidence: string;
  via: string;
  scope?: string;
}

/**
 * The operator's own verification record is free prose that names the
 * mechanism — a replayed session, an attached browser, a virtual display, the
 * site's anti-bot vendor, a real localStorage key, a real request header. The
 * registry is the ONLY info source a consumer has and it republished those
 * fields verbatim, so every consumer was handed our internals as decoration.
 *
 * The DISCLOSURE survives: a dated record, an explicit "this was a live
 * round-trip", and the scope (which capabilities it covers) are all still
 * published, because those are the parts a consumer branches on. What is
 * dropped is the sentence about HOW we got there, which it cannot act on. The
 * operator's own copy of the mechanism stays in `capabilities/<id>/metadata.json`,
 * which is where it belongs.
 */
export function consumerVerifiedRecord(record: { evidence: string; via: string; scope?: string }): ConsumerVerifiedRecord {
  return {
    evidence: "live round-trip recorded",
    via: "live round-trip",
    ...(record.scope ? { scope: record.scope } : {}),
  };
}

/**
 * ── CONSUMER PROSE ───────────────────────────────────────────────────────────
 * A package's manifest carries prose the OPERATOR wrote for the operator: which
 * goal number drove a decision, which env knob enables a session, what the
 * honest blocker is. The registry republishes those strings as the tool
 * `description` every consumer reads — so "attach your own Chrome via
 * UI2API_ATTACH_PORT=9222" and "GOAL 19 measured 2026-09-23" were being handed
 * to every consumer as capability documentation.
 *
 * This is a REDACTION, and the honesty rule that governs it is the same one
 * that governs the error sink: a redaction that deletes the diagnosis is a
 * second lie. So the table below is (internal → what the consumer is actually
 * being told), never a delete. `GOAL 19` becomes `measured 2026-09-23` — the
 * date, which is the part that carries the information. An env knob becomes
 * "a session attached by the service operator" — the fact, without the knob.
 * The operator's own manifest is untouched; only the republished copy changes.
 */
const PROSE: ReadonlyArray<[RegExp, string]> = [
  // Internal gate numbers: the DATE beside them is the disclosure; the
  // bookkeeping is ours.
  [/\bGOAL\s+\d+\b[,:]?\s*/gi, ""],
  [/\(GOAL\s+\d+\)/gi, ""],
  // Our env knobs and CLI, as they appear in a capability description.
  [/\bUI2API_[A-Z0-9_]+(?:=\d+)?\b/g, "an operator-attached session"],
  // The operator's own command line. The rule was WIDENED by the derivation
  // rather than by memory: it used to require a sentence-ending punctuation mark
  // after the command, so the very common backticked form
  // "`ui2api profile capabilities <host> --account <email>`" survived it whole.
  // That was found by the marker-declared sample in `src/prompt/http.ts`, not by
  // a reviewer re-reading the table — which is the whole point of deriving the
  // classes instead of listing them.
  [/\bui2api\s+[a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3}/gi, "the operator's own tooling"],
  // The mechanism the requirement names. The REQUIREMENT survives — that a
  // logged-in session is needed is a fact a consumer acts on.
  [/\bthe user's own real Chrome attached\b/gi, "a session attached by the service operator"],
  [/\bthe user's own signed-in Chrome\b/gi, "a session attached by the service operator"],
  [/\battached real Chrome\b/gi, "an operator-attached session"],
  [/\breal Chrome\b/gi, "an operator-attached session"],
  // MECHANISM NOUNS, DERIVED (GOAL 167). The four rules these replace were
  // `real Chrome` / `headless|headed` / `Xvfb` / `CDP`, and MEASURED against the
  // shipped capability corpus they each had a HOLE the exact-match form could
  // not see: bare `Chrome`, `google-chrome`, `ui2api-chrome`, `Chromium`,
  // lowercase `xvfb`, lowercase `cdp` and `headful` ALL survived verbatim to
  // the wire. Each rule below is now a case-insensitive FAMILY, and each family
  // is a member of `mechanismTermsIn()` — the derivation that proves the family
  // is not a remembered instance. See the derivation section below.
  [/\bchrome(?:[-_]?(?:browser|stable|beta|driver))?[a-z]*\b/gi, "an operator-attached session"],
  [/\bchromium(?:[-_]browser)?[a-z]*\b/gi, "an operator-attached session"],
  [/\b(?:xvfb|xorg)[a-z]*\b/gi, "a virtual display"],
  [/\bhead(?:less|ed|ful)[a-z]*\b/gi, "display-attached"],
  // `CDP` is the ONE concept word that does not derive (measured: it appears in
  // `src/` only inside comments, never in a name, key, id, flag, ladder or
  // dependency). It stays an EXPLICIT, SELF-DOCUMENTING exception with its
  // reason recorded here and pinned by the gate — see `DECLARED_EXCEPTIONS`.
  [/\bcdp[a-z]*\b/gi, "the attach endpoint"],
  // The libraries the shipped daemon loads. `playwright` is the automation layer
  // the whole product is built on and leaked verbatim into two shipped capability
  // descriptions ("Playwright filechooser event NEVER fires", "Playwright/CDP UI
  // path") — measured on the corpus, not imagined. `zod` / `classic-level` are
  // our own internal plumbing; a consumer is never told which validation library
  // a daemon happens to use.
  [/\b(?:playwright|selenium|webdriver|puppeteer)[a-z]*\b/gi, "a session driven by the service operator"],
  [/\b(?:zod|classic-level)[a-z]*\b/gi, "internal implementation detail"],
  [/\bbrowser-bound[a-z]*\b/gi, "session-bound"],
  // Collapse the whitespace the removals left behind, and tidy the seams.
  [/\s{2,}/g, " "],
  [/\s+([,.;:])/g, "$1"],
  [/^[\s,;:—-]+/, ""],
];

/**
 * ── THE LEAK CLASSES ARE DERIVED, NOT REMEMBERED ─────────────────────────────
 * WHY THIS EXISTS. The table above is a REDACTION, and a redaction can only ever
 * SHRINK when somebody remembers to widen it. That is not a gate — it is a
 * comment asking to be maintained. So the things the table has to cover are
 * DISCOVERED FROM THE CODE and handed to the table as an obligation, which
 * means a new internal phrase fails here instead of reaching a consumer.
 *
 * There are exactly two derivable things, and the boundary between them is
 * drawn deliberately rather than by convenience:
 *
 *   DERIVED (these are facts ABOUT the tree, and a machine can count them):
 *     * `envKnobsIn(root)` — every `UI2API_*` identifier the code actually
 *       reads, scanned out of `src/` and `scripts/`. A knob added to the code
 *       the same day it is added here is covered WITHOUT anybody editing the
 *       redaction table; the gate's job is to PROVE the table still removes it,
 *       which is what stops the regex from being quietly narrowed to a
 *       hand-copied list.
 *     * `goalRefsIn(root)` — every `GOAL nn` bookkeeping reference, same shape.
 *     * `internalProseSamples(root)` — the MARKER convention below: a source
 *       file that authors prose carrying internal vocabulary declares it with
 *       `// @internal-prose <class>`, and the gate demands a rule that redacts
 *       that class's own harvested text.
 *     * `mechanismTermsIn(root, files)` — GOAL 167. The MECHANISM NOUNS, below.
 *
 * ── GOAL 167: THE CONCEPT WORDS ARE MOSTLY DERIVABLE, AND THE CLAIM WAS WRONG ──
 * The previous revision of this comment asserted that the concept words
 * ("Chrome", "Xvfb", "CDP", "headless") were NOT derivable, on the grounds that
 * "no amount of scanning the code can tell you that the word Xvfb is internal".
 * MEASURED against the tree, that claim was wrong for THREE of the four, and the
 * error was not academic: the four hand-typed rules had live holes.
 *
 * WHAT "DERIVABLE" MEANS HERE, precisely, because the word is otherwise vague.
 * A mechanism noun is not internal because a person says so — it is internal
 * because the code NAMES IT AS A THING IT EXECUTES. That is a checkable
 * property, and it has three machine-readable witnesses in this tree:
 *
 *   1. EXEC PROBE  — `has("Xvfb")` in `src/runtime/requirements.ts:453` is a
 *      string literal naming a PROGRAM the readiness checker runs. A generic
 *      English word never appears in that position, so the position itself is
 *      the evidence. This yields `Xvfb`, `Xorg`.
 *   2. EXEC LADDER — the closed path arrays `CHROME_SYSTEM_PATHS` /
 *      `CHROME_CHROMIUM_PATHS` (`src/runtime/browser.ts`) and `PROFILE_CANDIDATES`
 *      (`src/runtime/chrome-owner.ts:41`) list the browser BINARIES the launch
 *      seam resolves, one per string literal. Their leaves yield `chrome`,
 *      `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`,
 *      `ui2api-chrome`.
 *   3. BROWSER LAUNCH FLAG — `args.push("--headless=new")`
 *      (`src/runtime/chrome-daemon.ts:303`) names a flag passed to the browser
 *      process. The FLAG NAME (before any `=value`) yields `headless`.
 *   Plus package.json `dependencies`, which yields `playwright` — the automation
 *   library the entire product is built on, and which was leaking verbatim into
 *   two shipped capability descriptions.
 *
 * So `Chrome`, `Xvfb` and `headless` are DERIVED, and `proseRuleTokens()`'s
 * mechanism families are pinned against this derivation: a browser binary added
 * to a ladder tomorrow fails the gate until a rule covers it.
 *
 * WHAT THE SHAPE-BASED ALTERNATIVE COSTS, because it was the tempting option and
 * it was measured rather than assumed. "Redact any capitalised token that is not
 * a site name" would catch all four plus hundreds more — and it was run over the
 * real 162-description corpus, where it flags 276 distinct tokens including
 * `Answer`, `Capability`, `Search`, `Tool`, `Image`, `Response`, `Request`,
 * `model` and `session`. A gate that redacts "model" and "Tool" is a gate that
 * cries wolf on the words a consumer legitimately uses, which is why the three
 * EXEC-SURFACE derivations above are used instead: they are precise because
 * they are anchored to a position, not to a letter case.
 *
 * ── THE ONE GENUINE EXCEPTION: `CDP`, DECLARED AND PINNED ────────────────────
 * `CDP` is the only one of the four that does not derive, and the reason is
 * specific rather than philosophical: MEASURED, `CDP` occurs in `src/` only
 * inside COMMENTS (`driver.ts:197`, `pool.ts:19`, `chrome-daemon.ts:268`, …) and
 * inside `error-redaction.ts`'s own hand-written alternation. It appears in no
 * name, no key, no check id, no exec probe, no ladder, no flag, no path and no
 * dependency. There is nothing for a scan to read. (The nearest candidate,
 * `ALLOWED_SCHEMES` in `wigolo.ts:129`, contains "cdp" as a URL scheme — but
 * deriving from that set would also derive `http`, `https` and `ws`, which occur
 * legitimately throughout consumer prose. So that source is REJECTED, on
 * measured evidence, rather than quietly used.)
 *
 * So `CDP` is disposition (c): a DELIBERATE accepted exception, and the honest
 * fix for it is to make it self-documenting and pinned rather than to pretend it
 * derives. `DECLARED_EXCEPTIONS` below carries the term AND the reason, and the
 * gate asserts three things about every entry: it is non-empty, its reason is
 * non-empty, and `consumerProse` really does remove it. A stale exception — one
 * the code no longer mentions anywhere — is reported by the gate instead of
 * sitting in a comment forever.
 */

/** The marker a source file uses to declare "the next line is operator prose
 *  that carries internal vocabulary of class `<id>`". The class id is a
 *  CONTRACT: `proseRuleIds()` must name it, or the gate fails. */
export const INTERNAL_PROSE_MARKER = "@internal-prose";

export interface InternalProseSample {
  /** the declared class id — must appear in `proseRuleIds()` */
  cls: string;
  /** repo-relative source file that authored it */
  file: string;
  /** 1-based line number of the SAMPLE (the line after the marker) */
  line: number;
  /** the code's OWN text, harvested — never a hand-copied fixture */
  text: string;
}

/**
 * Harvest every marker-declared prose sample from the tree. Reads files only;
 * it never writes, and it never imports them.
 */
export function internalProseSamples(root: string, files: readonly string[]): InternalProseSample[] {
  const out: InternalProseSample[] = [];
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(join(root, rel), "utf8");
    } catch {
      continue; // a file that is not on disk contributes no obligation
    }
    const lines = src.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const m = new RegExp(`${INTERNAL_PROSE_MARKER}\\s+([a-z0-9-]+)`).exec(lines[i]!);
      if (!m) continue;
      // The sample is the next line that is not itself a comment or blank: the
      // rule must be proven against real code, and a comment is not code.
      let j = i + 1;
      while (j < lines.length && (lines[j]!.trim() === "" || lines[j]!.trim().startsWith("//"))) j++;
      if (j >= lines.length) continue;
      out.push({ cls: m[1]!, file: rel, line: j + 1, text: lines[j]!.trim() });
    }
  }
  return out;
}

/** Every `UI2API_*` identifier the CODE reads, scanned out of the tree. This is
 *  the derivation that makes the redaction table's generic knob rule
 *  self-maintaining: the set of knobs is measured, never listed. */
export function envKnobsIn(root: string, files: readonly string[]): string[] {
  const found = new Set<string>();
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(/\bUI2API_[A-Z0-9_]+\b/g)) found.add(m[0]);
  }
  return [...found].sort();
}

/** Every `GOAL nn` bookkeeping reference in the tree. The date that sits beside
 *  one in a description is a disclosure and SURVIVES the redaction; the number
 *  is ours and does not. */
export function goalRefsIn(root: string, files: readonly string[]): string[] {
  const found = new Set<string>();
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(/\bGOAL\s+\d+\b/gi)) found.add(m[0].replace(/\s+/g, " "));
  }
  return [...found].sort();
}

/**
 * ── GOAL 167: THE MECHANISM NOUNS, DERIVED FROM EXEC SURFACES ────────────────
 * A mechanism noun is internal because the code NAMES IT AS A THING IT RUNS —
 * not because a person typed it into a list. Three machine-readable witnesses of
 * that exist in this tree, and the derivation reads all of them. Each is anchored
 * to a POSITION (a probe argument, a closed path array, a browser-args push)
 * rather than to a letter case, which is what keeps it from crying wolf: see the
 * measurement in the header comment.
 *
 * Returns a map of lowercased term -> the `file:line` that earned it, so a
 * failing gate names the source of the obligation instead of just the word.
 */
export function mechanismTermsIn(root: string, files: readonly string[]): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  const note = (raw: string, where: string): void => {
    const term = raw.trim().toLowerCase();
    // Two characters cannot be a mechanism noun ("X" is an executable check, not
    // a product) and a term with punctuation is a path fragment, not a word.
    if (term.length < 3 || !/^[a-z0-9][a-z0-9.-]*$/.test(term)) return;
    if (!found.has(term)) found.set(term, where);
  };
  for (const rel of files) {
    // THIS MODULE IS EXCLUDED, and the reason is load-bearing rather than
    // cosmetic: the header comment above QUOTES `args.push("--headless=new")` and
    // `has("Xvfb")` as examples of the witnesses. If the derivation read itself,
    // this comment would MANUFACTURE the obligations it is supposed to discover —
    // `headless` and `xvfb` were both first "found" here, masking the real
    // witnesses in `chrome-daemon.ts` and `requirements.ts`. A gate that derives
    // its expectations out of its own documentation is a gate that passes when
    // the documentation changes. Skipping self also means an obligation cannot
    // be satisfied by editing the comment that describes it.
    if (rel === "src/prompt/consumer-surface.ts") continue;
    let src: string;
    let lineOf: (index: number) => string;
    try {
      src = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    lineOf = (index: number) => `${rel}:${src.slice(0, index).split("\n").length}`;
    // (1) EXEC PROBE — a string literal handed to `has(...)` names a PROGRAM the
    //     readiness checker runs. `src/runtime/requirements.ts` probes Xvfb/Xorg.
    for (const m of src.matchAll(/\bhas\("([^"]+)"\)/g)) note(m[1]!, lineOf(m.index));
    // (2) EXEC LADDER — the closed path arrays naming the browser binaries the
    //     launch seam resolves; the LEAF of each path is the product name.
    for (const m of src.matchAll(
      /const\s+[A-Z0-9_]*(?:_PATHS|_CANDIDATES)\b[^\n]*=\s*\[([\s\S]*?)\]/g,
    )) {
      for (const s of m[1]!.matchAll(/"([^"]+)"/g)) {
        const v = s[1]!;
        note(v.includes("/") ? v.slice(v.lastIndexOf("/") + 1) : v, `${rel}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    // (3) BROWSER LAUNCH FLAG — `args.push("--headless=new")` names a flag passed
    //     to the browser process. The FLAG NAME only: the `=value` half is a
    //     version string, and CLI flags are excluded on purpose (they are
    //     operator vocabulary, already covered by the `ui2api …` rule).
    for (const m of src.matchAll(/args\.push\("--([a-z0-9-]+)/g)) note(m[1]!, lineOf(m.index));
  }
  // (4) RUNTIME DEPENDENCIES — the libraries the shipped daemon actually loads.
  //     `dependencies` only, never `devDependencies`: a test-runner is not
  //     something a consumer is told about, and `tsx`/`typescript` in operator
  //     prose would be a redaction with no consumer benefit.
  //
  //     SCOPED PACKAGES ARE SKIPPED. Taking the last path segment of
  //     `@modelcontextprotocol/sdk` yields `sdk`, which is an ordinary English
  //     noun — and a rule for it would redact the word "SDK" out of legitimate
  //     prose. That is a false positive manufactured by the derivation itself,
  //     and the honest response is to not derive the fragment: a scoped
  //     package's segment is not a package name.
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (name.startsWith("@")) continue;
      note(name, "package.json:dependencies");
    }
  } catch {
    // no manifest on disk contributes no obligation
  }
  return found;
}

/**
 * ── THE DECLARED EXCEPTIONS: non-derivable by MEASUREMENT, and pinned ────────
 * A concept word the derivation cannot reach is not a silent gap and not a
 * comment asking to be maintained — it is a DECLARED exception carrying its own
 * reason, and the gate enforces three things about it: the list is not empty,
 * every reason is non-empty, and `consumerProse` really removes the term.
 *
 * The list is expected to be SHORT and is expected to be justified term by term.
 * `CDP` is the sole member; the reason is the measurement recorded in the header
 * comment (it exists only in comments and in `error-redaction.ts`'s own
 * alternation, so no scan can read it). If a second term is ever added here, the
 * gate still forces its reason to be written down, which is the whole point: a
 * bounded, self-documenting exception list can be audited, whereas a fourth
 * hand-typed regex in a table cannot.
 */
export interface DeclaredException {
  readonly term: string;
  /** WHY it cannot be derived. Non-empty, and the gate enforces it. */
  readonly why: string;
}

export const DECLARED_EXCEPTIONS: readonly DeclaredException[] = [
  {
    term: "cdp",
    why:
      "MEASURED: `CDP` occurs in src/ only inside comments and inside " +
      "error-redaction.ts's own hand-written alternation — never in a name, key, " +
      "check id, exec probe, exec ladder, launch flag or dependency, so no scan " +
      "has anything to read. ALLOWED_SCHEMES in wigolo.ts does contain \"cdp\" but " +
      "deriving from that set would also derive http/https/ws, which occur " +
      "legitimately in consumer prose (measured), so that source is rejected.",
  },
];

/**
 * ── THE CONCEPT VOCABULARY: DECLARED ONCE, CONSUMED BY BOTH SEAMS ────────────
 * WHY THIS IS A SEPARATE EXPORT AND NOT JUST THE PROSE TABLE. The prose table
 * above is not a vocabulary — it is a list of (matcher, REPLACEMENT) pairs, and
 * the replacement is half the meaning: `consumerProse` TRANSLATES (`chrome` →
 * "an operator-attached session") because a capability description has to stay a
 * sentence. The error seam in `./error-redaction.ts` DELETES the same words
 * because an error message that said "an operator-attached session was closed"
 * would be nonsense. Two different treatments, so the RULES cannot be shared.
 *
 * But the WORDS were shared, and they were typed twice — which is the rot this
 * removes. MEASURED on the tree before this export existed: the error seam's
 * hand-written alternation carried 8 of the 14 concept words and silently missed
 * SIX that the prose table and the derivation both know —
 * `xorg` (a `has("Xorg")` exec probe in `requirements.ts:454`), `zod` and
 * `classic-level` (both real entries in `package.json:dependencies`),
 * `selenium` / `puppeteer` (the automation family), and `headful` (the sibling
 * the exact-match `headless` form cannot see). Each of those six reached a
 * consumer verbatim in a scrubbed error message, because `redactInternalError`'s
 * re-check did not list them either. A shared list with a gate on it is what
 * turns "somebody remembered to widen it" into "the seam cannot stop covering it".
 *
 * ORDER IS PART OF THE CONTRACT, AND SO IS WHAT IS *ABSENT* FROM IT. The error
 * seam builds its alternation from this list, so a term that is a PREFIX of a
 * later term must not be moved after it — `chrome` before `chrome-browser`
 * deletes `chrome` out of `google-chrome-stable` and leaves `google--stable`,
 * and reversing the pair would delete the whole token and CHANGE THE BYTES a
 * consumer reads. MEASURED, not assumed: listing `google-chrome` after `chrome`
 * turned the scrubbed form of "google-chrome was headed" from `google- was`
 * into ` was` — a different string on the wire for no security gain.
 *
 * So the compound binary leaves are DELIBERATELY ABSENT: `chromium-browser`,
 * `chrome-browser`, `chrome-stable`, `chrome-beta`, `chrome-driver`,
 * `google-chrome`, `google-chrome-stable`, `google-chrome-beta` and
 * `ui2api-chrome` are all already removed by the two base tokens `chrome` and
 * `chromium`, which a `\b`-anchored match finds inside them (`google-chrome`
 * matches `chrome` because `-` is a non-word character). Listing them would add
 * no coverage and would only change WHICH SPAN a match removes. The derivation
 * still yields them — `mechanismTermsIn()` reports the full compound leaves — so
 * this is checked the only way that is actually true: the gate asserts the seam
 * REMOVES every derived term, not that the list NAMES it. Coverage is a
 * behavioural property, and a list that must contain a redundant compound to
 * prove it is a list that will rot the moment someone reorders it.
 *
 * WHAT IS NOT HERE, and why. `browser` (bare) is absent because
 * `consumerProse` deliberately does not redact it: "browser" is an ordinary
 * English word a capability description may legitimately use, and redacting it
 * is a false positive, not a leak. The error seam keeps it as its own word,
 * because in an ERROR message it is never something the caller needs. The same
 * is true of the DOM-locator and credential-store vocabulary (`locator`,
 * `selector`, `localStorage`, `cookie jar`) and of our own name (`ui2api`).
 * Those are the error seam's alone, they live in its `ERROR_ONLY_TERMS`, and
 * they are deliberately NOT shared — sharing them would widen the prose seam
 * onto words that cry wolf there.
 */
export const CONCEPT_TERMS: readonly string[] = [
  // Browser binaries — the exec ladders the launch seam resolves. The COMPOUND
  // leaves are absent on purpose; see the header. Two base tokens cover them.
  "chrome",
  "chromium",
  // Display / attachment mechanism — the exec probes and the launch flag.
  "xvfb",
  "xorg",
  "cdp",
  "headless",
  "headed",
  "headful",
  // Automation libraries — the runtime dependencies the daemon loads.
  "playwright",
  "selenium",
  "webdriver",
  "puppeteer",
  "zod",
  "classic-level",
  // How a session is bound, when prose names it at all.
  "browser-bound",
];

/** The classes the redaction table currently declares. The gate enumerates
 *  THIS, so widening the wire vocabulary is a visible edit here and a failing
 *  marker elsewhere — never a silent redaction that stopped matching. */
export function proseRuleIds(): readonly string[] {
  return [
    "goal-number",
    "env-knob",
    "operator-cli",
    "attach-mechanism",
    "display-mechanism",
    "browser-binding",
    "automation-library",
  ];
}

/** The tokens each declared class must remove, used by the gate to prove the
 *  coverage from the CODE's own words. A class with an empty token list is
 *  vacuous and the gate says so. */
export function proseRuleTokens(): Readonly<Record<string, readonly RegExp[]>> {
  return {
    "goal-number": [/\bGOAL\s+\d+\b/],
    "env-knob": [/\bUI2API_[A-Z0-9_]+\b/],
    "operator-cli": [/\bui2api\s+profile\b/, /\bui2api\s+chrome\b/],
    // The mechanism families are case-INSENSITIVE and cover the derived shapes,
    // not the four remembered instances: `real Chrome`/`headless`/`Xvfb`/`CDP`
    // each leaked a sibling form (bare `Chrome`, `google-chrome`, lowercase
    // `xvfb`, `headful`) that no gate watching the exact string would have seen.
  "attach-mechanism": [
      /\bchrome(?:[-_]?(?:browser|stable|beta|driver))?[a-z]*\b/i,
      /\bchromium(?:[-_]browser)?[a-z]*\b/i,
      /\bhead(?:less|ed|ful)[a-z]*\b/i,
      /\bxvfb[a-z]*\b/i,
      /\bcdp[a-z]*\b/i,
    ],
    "display-mechanism": [/\bxvfb[a-z]*\b/i, /\bxorg[a-z]*\b/i, /\bhead(?:less|ed|ful)[a-z]*\b/i],
    "browser-binding": [/\bbrowser-bound[a-z]*\b/i],
    "automation-library": [/\b(?:playwright|selenium|webdriver|puppeteer)[a-z]*\b/i],
  };
}

/**
 * What a consumer may read of an operator-facing prose blob. Idempotent, and
 * safe on an absent/short string: an empty result stays empty rather than
 * becoming invented text.
 */
export function consumerProse(text: string | undefined): string {
  if (!text) return text ?? "";
  let out = text;
  for (const [re, to] of PROSE) out = out.replace(re, to);
  return out.trim();
}

/**
 * ── THE ACCOUNT REFUSAL A CONSUMER MAY READ ─────────────────────────────────
 * A caller who asked for one account and got it wrong needs three things: the
 * account they asked for (they can fix the typo), the fact that it is not
 * available (so they know retrying will not help), and one action.
 *
 * It does NOT need, and must not be given, the roster of every other account
 * on this host. The old wording appended `available: [a, b, c]` — which, on a
 * loopback daemon reachable by any local process, hands one caller the
 * identities of every other stored session for that site. A refusal that names
 * MORE than it should is still a leak; naming LESS than the caller can act on
 * is the silent-failure defect. This names exactly the three things above.
 *
 * The PERMISSION is unchanged: this still refuses, it still refuses by name,
 * and it still refuses before any browser work. Only the wording changed.
 */
export function consumerAccountRefusal(account: string, site: string): string {
  return (
    `account "${account}" is not available for ${site}; send the request without ` +
    `"account" to use the default account, or pass an id from GET /accounts?site=${site}`
  );
}

/**
 * ── THE POOL REFUSAL A CONSUMER MAY READ ────────────────────────────────────
 * THE DESIGN DECISION (GOAL 162 — read this before "fixing" the numbers back).
 *
 * THE QUESTION. `pool_saturated` was answered with the pool's own sentence —
 * "pool saturated (3 waiting, limit 4) — no page is free and the queue is full".
 * Is that OPERATOR TELEMETRY or CONSUMER CONTRACT?
 *
 * THE ANSWER: the CODE is the contract; the NUMBERS are operator telemetry.
 *
 *   * The code is what an agent branches on. `pool_saturated` / `pool_queue_timeout`
 *     / `pool_closed` are published contract strings — they are in the shipped
 *     error-contract table, they are what the generated PHP client's
 *     `$errorCode` carries, and a consumer writes
 *     `if ($e->errorCode === 'pool_saturated') retry()`. That is the part of a
 *     503 that is API.
 *   * The numbers are OUR state. "(3 waiting, limit 4)" describes the warm page
 *     pool's internal queue at one instant. A consumer can do exactly one thing
 *     with it — retry — and the retry's success does not depend on the numbers
 *     being right. Worse, the numbers are a CAPACITY DISCLOSURE: on a
 *     loopback socket, "3 waiting, limit 4" tells a local caller the pool's
 *     size and load, which is reconnaissance about a resource it cannot act on.
 *   * So the numbers are NOT deleted. They live where telemetry belongs and
 *     where they are already published: `GET /status` reports the pool's queue
 *     depth and its bound (pinned by test/pool-deadline.test.ts, "pool status
 *     exposes the queue depth and its bound"). Dropping them from the 503 loses
 *     the operator nothing, because the operator reads /status.
 *
 * WHY NOT THE OPPOSITE (keep the prose, redact the counters)? Because the
 * prose IS the internal vocabulary: "no page is free and the queue is full"
 * names the pool's own queue model to a consumer who has no page, no page pool,
 * and no notion of "waiting". A consumer can act on exactly two facts — the
 * code, and whether WAITING will help — so those two facts are what the message
 * says.
 *
 * WHY THE PREFIX `pool saturated ` SURVIVES. It is not telemetry: it is the
 * CLASS NAME, and `codeFor()` in `src/generator/lang-php.ts` classifies a
 * Shape-1 refusal by message prefix. Keeping the prefix keeps that legacy entry
 * alive instead of letting it rot into a dead row, while every counter and
 * every pool noun after it is gone. A reword HERE (rather than in pool.ts) is
 * what makes that entry safe to keep.
 */
export function consumerPoolRefusal(code: PoolRefusalCodeName): string {
  switch (code) {
    case "pool_saturated":
      return "pool saturated — the service is at capacity; wait a moment and retry";
    case "pool_queue_timeout":
      return "pool queue timeout — the service stayed at capacity for the whole wait; wait a moment and retry";
    case "pool_closed":
      return "pool closed — the service is shutting down; retry against a restarted service";
  }
}

/** The three published pool refusal classes, typed without importing `pool.ts`
 *  (the consumer surface must not depend on the pool's implementation module,
 *  only on the vocabulary it is allowed to speak). */
export type PoolRefusalCodeName = "pool_saturated" | "pool_queue_timeout" | "pool_closed";
