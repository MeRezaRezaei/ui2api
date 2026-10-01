/**
 * THE CONSUMER ERROR REDACTION SEAM
 *
 * One function, one job: take any internally-generated error text and decide
 * what a consumer — who is contractually promised nothing about how this
 * service drives a chat site — is allowed to read.
 *
 * HONESTY RULE THAT SHAPES THE WHOLE FILE: a redaction that deletes the
 * diagnosis is not a safety win, it is a second lie. A caller who is told
 * "internal error" cannot correct anything and cannot report anything useful;
 * the failure becomes indistinguishable from a broken daemon. So the output
 * must always carry three things: WHAT happened, WHICH model, and WHAT THE
 * CALLER CAN DO. Only the internals go (the repo path, the CLI flags, the env
 * knobs, the Playwright verbatims, the DOM-locator language, the session
 * vocabulary, the absolute paths, the upstream hostnames and headers).
 *
 * WHY IT IS A NAMED FUNCTION AND NOT A SCATTER OF `.replace()` CALLS: a sink
 * nobody can unit-test is a sink that rots. Every classification below is a
 * (matcher, wording) pair, so a test can assert both that a real internal
 * message is redacted AND that the wording still tells the caller something.
 * A replace-soup has neither property.
 *
 * PERMISSION IS NOT A REDACTION PROBLEM. Nothing here may cause a refusal to
 * be relaxed, re-scoped or answered with more detail than the caller was
 * already entitled to. If a message cannot be reduced to something both safe
 * AND non-empty, the honest answer is the generic fallback, never the raw text.
 */

// The account-refusal SENTENCE is owned by `consumerAccountRefusal()` in
// `./consumer-surface.ts` and is imported, never re-typed. This file used to
// carry its own near-copy of it, and the two had already drifted: the closing
// clause read "or use an account id returned by GET /accounts?site=X" here and
// "or pass an id from GET /accounts?site=X" there. Two wordings of one condition
// means a consumer can be handed two different sentences for the same refusal,
// and a reword of either copy leaves the other stale with nothing to catch it —
// the same shape as the credential gate that once asserted on a string a
// redaction step had already replaced, and so proved nothing.
//
// REDACTION IS NOT AN EXCUSE FOR A SECOND OWNER: it rewrites what a caller may
// READ, and this sentence is already the roster-free projection written for
// exactly that reader. Delegating is therefore both the dedup fix and the more
// correct behaviour. `test/error-redaction.test.ts` pins it two ways: the
// clause may be TYPED in exactly one file under `src/`, and the bytes this seam
// emits must equal the owner's bytes.
import { CONCEPT_TERMS, consumerAccountRefusal } from "./consumer-surface.js";

/** The site/model the request was for — always known at the sink. */
export interface RedactionContext {
  /** The model id the caller asked for (already a public /v1 id). */
  site?: string;
  /** The account slug the caller asked for, when the request carried one. */
  account?: string;
}

/** How the caller may recover. Named, not inlined, so the wording cannot drift. */
const RETRY = "Retry; if it repeats, pick another model id from GET /v1/models.";

/**
 * Known internal failure classes, MOST SPECIFIC FIRST. Each entry is
 * (does this raw message look like that class, what the caller is told).
 * A class that is not listed here falls through to the mechanical scrub and,
 * failing that, to the fallback.
 */
const CLASSES: ReadonlyArray<{ re: RegExp; say: (ctx: RedactionContext, raw: string) => string }> = [
  {
    // The account the caller asked for is not one this daemon can use. The
    // words "session"/"vault" are dropped: what the caller controls is the
    // account selector, so that is the vocabulary the answer uses.
    //
    // THE SENTENCE IS NOT AUTHORED HERE — see the import note at the top. This
    // class decides only WHICH account was refused (the caller's own `account`
    // wins; otherwise the one quoted in the raw message) and what to say when
    // the raw message named none, which is a DIFFERENT condition and keeps its
    // own sentence: with no account to echo, the caller cannot fix a typo, so
    // the honest remedy is the operator granting access.
    re: /no stored (?:session|account) for|sl[ug]?-collision/i,
    say: (c, raw) => {
      const asked = c.account ?? /\baccount "([^"]+)"/i.exec(raw)?.[1];
      return asked
        ? consumerAccountRefusal(asked, c.site ?? "this model")
        : `no account is available for ${c.site ?? "this model"}; the service operator must grant access before this model can be used`;
    },
  },
  {
    // The request outran the wait budget. This is the closest thing to a
    // well-behaved message we produce, and it is the wording standard: what
    // happened, which site, what the caller can do. The timer value is KEPT
    // (it is our own number, tells the caller whether to raise their timeout)
    // and the remediation is restated in caller terms, not in profile terms.
    re: /no answer appeared on .* within \d+ms/i,
    say: (c, raw) => {
      const m = /within (\d+)ms/i.exec(raw);
      const ms = m ? ` within ${m[1]}ms` : "";
      return `${c.site ?? "this model"} did not return an answer${ms} — the site may be busy, rate-limiting, or showing a sign-in or consent wall. ${RETRY}`;
    },
  },
  {
    // The site never presented an input we could type into. The upstream host
    // and the page title are dropped (a title and a URL are reconnaissance for
    // an impersonation attempt, and neither helps the caller act).
    re: /no composer found on|newChat reset not verified|composer still empty/i,
    say: (c) =>
      `${c.site ?? "this model"} did not present a usable prompt input on its chat page this time — the site may have changed its layout, or it may be showing a sign-in or consent wall. ${RETRY}`,
  },
  {
    // The service could not give this model a slot right now. The internal
    // cause is a queue with a page budget, which is not the caller's business
    // — but "come back shortly" IS, because it is the difference between a
    // retry and an abort.
    re: /\bpool (?:saturated|closed|queue timeout)\b/i,
    say: (c) =>
      `${c.site ?? "this model"} is at capacity right now — the request was refused without being run. Wait a moment and retry the same request.`,
  },
  {
    // The site itself refused the turn. This is the one class where the site's
    // own anti-abuse behaviour is the cause, and the caller's remedy (back off,
    // then retry) is exactly right — so it is named rather than scrubbed.
    re: /\brate limit|\b429\b|\btoo many requests\b|\bconsent wall\b|\bchallenge\b|\bERR_CHALLENGE\b/i,
    say: (c) =>
      `${c.site ?? "this model"} refused this turn — the site is rate-limiting, or it showed a sign-in/consent check instead of the chat page. Back off and retry the same request later; repeated immediate retries make it worse.`,
  },
  {
    // A package/file/vault-shaped failure. Whatever the cause, a consumer
    // cannot act on a filesystem error, so the fallback's named class is
    // strictly more useful than a scrubbed errno.
    re: /\bENOENT\b|\bEACCES\b|\bno such file or directory\b|\bopen '|\bpermission denied\b/i,
    say: (c) =>
      `${c.site ?? "this model"} is not available on this deployment — the service operator must enable it. GET /v1/models lists the models currently served.`,
  },
  {
    // The page went away mid-round-trip. Playwright's own verbatim is the leak:
    // it names a transport and a handle that exist only inside this service.
    re: /Target page, context or browser has been closed|page died|Target closed/i,
    say: (c) =>
      `${c.site ?? "this model"}'s chat page went away before an answer could be read. ${RETRY}`,
  },
];

/* ── THE CONCEPT WORDS ARE NOT TYPED HERE ────────────────────────────────────
 * THIS USED TO BE A SECOND, HAND-WRITTEN COPY. That is the defect this block
 * removes, and it was measured before anything was edited: the alternation
 * below carried 8 of the concept words the prose seam knows and MISSED SIX —
 * `xorg` (a `has("Xorg")` exec probe in `src/runtime/requirements.ts:454`),
 * `zod` and `classic-level` (real entries in `package.json:dependencies`),
 * `selenium` and `puppeteer`, and `headful` (the sibling the exact-match
 * `headless` form cannot see). Each reached a consumer verbatim, because the
 * re-check below did not list them either — two copies of one vocabulary, and
 * the copy that mattered most was the one nobody was proving.
 *
 * So the vocabulary now lives ONCE, in `CONCEPT_TERMS` in `./consumer-surface.ts`
 * — the file that already owns `mechanismTermsIn()`, the derivation that
 * discovers concept words from the code's own exec surfaces. This seam CONSUMES
 * it. It does not re-type it, and `test/error-redaction.test.ts` fails if the
 * words are typed in two places again.
 *
 * WHY THE SEAM DOES NOT CALL `mechanismTermsIn()` DIRECTLY. It is tempting, and
 * it would make the list self-maintaining with no gate at all. It is refused for
 * a stated reason: that derivation READS THE SOURCE TREE, and this is the last
 * gate before the wire. A daemon running without `src/` beside it would scan
 * nothing, derive NOTHING, and silently redact fewer words — a redaction seam
 * that FAILS OPEN. The declared list is constant; the derivation stays a
 * TEST-TIME obligation, which is where a "this word exists in the code" claim
 * belongs, and it is the same shape the prose seam already uses.
 */

/**
 * The words ONLY this seam owns, each with the reason it is not shared. These
 * are the DOM-locator language, the credential stores, and our own name — none
 * of them is a mechanism noun the derivation can reach, and none of them may be
 * handed to the PROSE seam, where they would redact ordinary words:
 *
 *   - `browser` (bare) — an ordinary English word a capability description may
 *     legitimately use, so `consumerProse` deliberately leaves it; in an ERROR
 *     message it is never anything the caller needs.
 *   - `locator`, `selector` — Playwright's DOM-query language. The caller
 *     cannot act on "waiting for locator".
 *   - `localStorage`, `cookie jar` — the credential stores. A description never
 *     names them and must not; an internal error can, so they are deleted.
 *   - `profile.ts` — redundant with the file-extension rule above it, kept
 *     explicit because the bytes it produces are pinned by a test.
 *   - `ui2api` — our own name, and the error seam has no CLI phrase to match.
 */
const ERROR_ONLY_TERMS: readonly string[] = [
  "browser",
  "locator",
  "selector",
  "localStorage",
  "cookie jar",
  "profile.ts",
  "ui2api",
];

/** Escape a vocabulary term for use inside an alternation. EVERY term arrives
 *  RAW — a term is a word, not a pattern — so this is the single place a
 *  metacharacter is escaped, and it runs exactly once.
   *
   * THE DOUBLE-ESCAPE THIS FUNCTION EXISTS TO PREVENT, because it shipped in
   * the first draft of this change and was caught by measurement rather than by
   * reading: `ERROR_ONLY_TERMS` carried `profile\\.ts` PRE-ESCAPED, on the
   * theory that the alternation was built from a string. The escape set below
   * includes the backslash, so the pre-escaped term came out as `profile\\\\.ts`
   * — a literal backslash followed by ANY character — and `profile.ts` silently
   * STOPPED being redacted while every test stayed green. A pre-escaped term in
   * a list whose builder escapes is the same shape as the duplicate vocabulary
   * this whole change exists to remove: two places that must agree, one of them
   * invisible. */
function termPattern(term: string): string {
  return term.replace(/[\\^$*+?()[\]{}|]/g, "\\$&");
}

/**
 * THE WORD LIST, ASSEMBLED FROM ITS TWO OWNED PARTS. Exported so the gate can
 * assert on the pattern itself rather than on a hand-copied expectation — a test
 * that re-typed the words would be the second copy this change removed.
 *
 * ORDER. The shared terms come first, in `CONCEPT_TERMS`' declared order, then
 * this seam's own. Every alternative deletes, so order cannot change WHICH span
 * is removed except where one term is a prefix of another (`chrome` vs
 * `chrome-browser`) — and none of the eight words this seam already carried is a
 * prefix of any shared term, so the assembled pattern matches the pre-change one
 * on every word it used to match. `test/error-redaction.test.ts` proves that
 * against the frozen original rather than trusting the claim.
 */
export const INTERNAL_WORD_RE = new RegExp(
  `\\b(?:${[...CONCEPT_TERMS, ...ERROR_ONLY_TERMS].map(termPattern).join("|")})\\b`,
  "gi",
);

/** The SAME vocabulary, non-global. `RESIDUAL_INTERNAL` is consulted with
 *  `.some(re => re.test(text))`, and `.test()` on a `g`-flagged regex advances
 *  `lastIndex` and therefore returns a different answer on a second call — a
 *  verdict that depended on how many times the scrub had already run. Two
 *  instances, ONE vocabulary. */
export const INTERNAL_WORD_RE_NON_GLOBAL = new RegExp(INTERNAL_WORD_RE.source, "i");

/** Anything in here is internal by construction and never reaches a caller. */
const MECHANICAL: ReadonlyArray<[RegExp, string]> = [
  [/\bUI2API_[A-Z0-9_]+/g, "<an internal setting>"],
  [/--[a-z][a-z0-9-]*/g, "<an internal flag>"],
  [/\bGOAL\s+\d+\b/g, ""],
  [/\bhttps?:\/\/\S+/g, ""],
  [/(?:locator|getByRole|waitForSelector|evaluate)\s*\(/g, ""],
  [/\[[a-z-]+=[^\]]*\]/g, ""],
  [/::?[a-z-]+\(/g, ""],
  [/\b\/(?:home|opt|usr|var|etc|tmp)\/\S*/g, ""],
  [/\b[\w./-]+\.(?:ts|tsx|js|mjs|json)\b/g, ""],
  [/\bx-[a-z-]+\b/gi, ""],
  [INTERNAL_WORD_RE, ""],
  [/\s{2,}/g, " "],
  [/^\s*[-—,:;]\s*/g, ""],
];

/** The last-resort answer. Names the model, names the class, gives one action. */
function fallback(ctx: RedactionContext): string {
  return `${ctx.site ?? "this model"} could not complete this request — the site did not behave as expected on this turn. ${RETRY} The daemon log holds the internal detail.`;
}

/**
 * The seam. Turns any internally-generated error into what a consumer may
 * read, without widening anything the caller was already allowed to see.
 *
 * ORDER MATTERS: a known class is answered from the class table (so the
 * diagnosis is authored, not salvaged); only an UNKNOWN message is run
 * through the mechanical scrub, and even then the result is re-checked
 * against the internal-vocabulary patterns before it is allowed out. That
 * re-check is what stops a new internal error shape from leaking by default:
 * the fallback is always available, so the scrub can never be the only guard.
 */
export function redactInternalError(raw: unknown, ctx: RedactionContext = {}): string {
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : String(raw ?? "");
  for (const c of CLASSES) {
    if (c.re.test(text)) return c.say(ctx, text);
  }
  let scrubbed = text;
  for (const [re, to] of MECHANICAL) scrubbed = scrubbed.replace(re, to);
  scrubbed = scrubbed.replace(/^[\s"':;-]+/, "").trim();
  // The floor is a DIAGNOSIS floor, not a secrecy floor: below it there is
  // nothing left for the caller to act on, so the honest answer is the
  // named fallback rather than a stub.
  if (scrubbed.length >= 24 && !residualInternal(scrubbed)) return scrubbed;
  return fallback(ctx);
}

/**
 * The re-check. A scrubbed message is only allowed out if it carries none of
 * the shapes that forced the scrub in the first place. Kept deliberately
 * BROADER than the class table: this is the last gate before the wire, and it
 * must fail closed.
 *
 * THE WORD ROW HERE USED TO BE A THIRD HAND-WRITTEN COPY — and the narrowest of
 * the three: it listed 8 words where the scrub listed 15 and the shared
 * vocabulary lists 14. That is the defect in its purest form, because this row
 * is the one that decides whether a surviving word is ALLOWED OUT. A word the
 * scrub missed AND this row missed is a word that reaches a consumer, and the
 * gap was invisible because all three lists were "correct" in isolation.
 *
 * It is now built from the same `CONCEPT_TERMS` as the scrub, and it is a SEPARATE
 * non-global regex because `.test()` on a `g` regex is stateful: sharing the
 * scrub's `g` instance would make the verdict depend on how many times the scrub
 * had run before it. Two instances, one vocabulary.
 *
 * WHY WIDENING IT COSTS NOTHING, MEASURED rather than assumed. In every case where
 * the scrub worked, this row could never fire — the word is already gone. It only
 * decides anything where the scrub FAILED, and where it failed the honest answer
 * is the named fallback rather than the raw text. That is the direction the
 * honesty rule at the top of this file demands, and it is why widening a
 * fail-closed gate is safe while widening a delete rule is not.
 */
const RESIDUAL_INTERNAL: readonly RegExp[] = [
  /https?:\/\//,
  /\/(?:home|opt|usr|var|etc|tmp)\//,
  /\b[\w./-]+\.(?:ts|tsx|js|mjs|json)\b/,
  /\bUI2API_[A-Z0-9_]+/,
  /--[a-z][a-z0-9-]*/,
  /\bGOAL\s+\d+\b/,
  INTERNAL_WORD_RE_NON_GLOBAL,
  /(?:locator\(|getByRole\(|waiting for |\[data-testid|:has-text\()/,
  /:has-text\(|::after/,
  /\bx-[a-z-]+\b/i,
  /:\d{2,5}\b/,
];

function residualInternal(text: string): boolean {
  return RESIDUAL_INTERNAL.some((re) => re.test(text));
}
