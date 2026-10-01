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
import { consumerAccountRefusal } from "./consumer-surface.js";

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
  [/\b(?:browser|chrome|chromium|playwright|Xvfb|CDP|locator|selector|headless|headed|webdriver|localStorage|cookie jar|profile\.ts|ui2api)\b/gi, ""],
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
 */
const RESIDUAL_INTERNAL: readonly RegExp[] = [
  /https?:\/\//,
  /\/(?:home|opt|usr|var|etc|tmp)\//,
  /\b[\w./-]+\.(?:ts|tsx|js|mjs|json)\b/,
  /\bUI2API_[A-Z0-9_]+/,
  /--[a-z][a-z0-9-]*/,
  /\bGOAL\s+\d+\b/,
  /\b(?:browser|chrome|chromium|playwright|Xvfb|CDP|localStorage|locator)\b/i,
  /(?:locator\(|getByRole\(|waiting for |\[data-testid|:has-text\()/,
  /:has-text\(|::after/,
  /\bx-[a-z-]+\b/i,
  /:\d{2,5}\b/,
];

function residualInternal(text: string): boolean {
  return RESIDUAL_INTERNAL.some((re) => re.test(text));
}
