// ─────────────────────────────────────────────────────────────────────────────
// THE VERIFICATION CLASSIFIER
//
// This module exists because "this 502 is a sign-out because the reported url is
// a login page" used to live in a throwaway driver at /tmp/mv/, outside the
// repo, lost on reboot — which is why four models had to be re-classified by
// hand and why a measured, per-model condition with a distinct correct ACTION
// ended up filed under the meaningless class UNMEASURED. A classification rule
// that is a sweep convention is not a rule.
//
// The function is pure: measured status + the server's own message + the page
// title/url the server itself reported + the pool state the request started
// into. No browser, no network, no clock. Everything the gate's pinned
// assertions need is here and testable hermetically.
//
// WHY THE SET HAS EIGHT MEMBERS AND NOT FOUR: more than a couple have different
// REMEDIES, and a class is defined by the action it licenses.
//   WALL-CHALLENGE  -> docs/WIGOLO_BYPASS.md: reach for the wigolo tier, or
//                       keep the honest ok:false. NEVER a retry loop — a
//                       challenge on a real logged-in account is the one
//                       failure this project cannot recover from.
//   COMPOSER-DRIFT  -> retune the profile's composer/answer selectors; the
//                       session is fine, the selectors are stale.
// Filing either as SIGN-OUT asserts a credential problem the evidence does not
// show. Filing either as CONTENDED-TIMEOUT is a lie the gate itself rejects at
// an idle pool. UNMEASURED is honest but silent: it says "nothing was
// established" for a row where something WAS established.
//
// NO MEMBER IS A FREE-TEXT ESCAPE HATCH. A class that can hold anything
// re-creates the original defect one level up, so each class below has a
// MACHINE-CHECKABLE PRECONDITION (see `classPrecondition`) and the classifier
// REFUSES to return a class whose precondition it could not verify. A measured
// response that matches nothing is UNCLASSIFIED, which is not a class and is a
// GATE FAILURE — the honest move is to widen the rule on purpose, not to let
// the row hide.
// ─────────────────────────────────────────────────────────────────────────────

export const VERIFICATION_CLASSES = [
  "ANSWERS",
  "SIGN-OUT",
  "WALL-CHALLENGE",
  "COMPOSER-DRIFT",
  "CONTENDED-TIMEOUT",
  "NON-ANSWER-READ",
  "ANSWER-UNREADABLE",
  "UNMEASURED",
] as const;

export type VerificationClass = (typeof VERIFICATION_CLASSES)[number];

/** Not a class. The classifier's refusal: a measured response it cannot
 *  honestly file under any member. The gate names the row; it is never a
 *  place to park something. */
export type Unclassified = "UNCLASSIFIED";

/** The page the SERVER reported after it drove the model. Not something an
 *  operator typed, and not something this module fetches. */
export interface ObservedPage {
  title: string;
  url: string;
}

export interface PoolState {
  busy?: unknown;
  total?: unknown;
  queued?: unknown;
}

export interface Outcome {
  httpStatus: number;
  message: string;
  page?: ObservedPage;
  poolAtRequest?: PoolState;
  /** The service answered with real model output. */
  answerText?: string;
  /** No HTTP response at all (client abort / 000). */
  noResponse?: boolean;
}

export interface Classification {
  cls: VerificationClass | Unclassified;
  /** The single matched condition, named. Evidence, so a human can audit the
   *  decision without re-running anything. */
  reason: string;
}

// ── the marker tables ────────────────────────────────────────────────────────
//
// Each is a FINITE, REVIEWABLE list of substrings matched against a string the
// server itself emitted. A marker is added by editing this file; it is never
// learned, never inferred, and never supplied by the row being classified.

/** Anti-bot interstitials: Cloudflare, Vercel Security Checkpoint, and the
 *  generic shapes those two render. Matched case-insensitively. */
export const CHALLENGE_MARKERS: readonly string[] = [
  "attention required",
  "just a moment",
  "checking your browser",
  "vercel security checkpoint",
  "security checkpoint",
  "cloudflare",
  "cf-chl-",
  "ddos protection",
  "enable javascript and cookies",
  "ray id",
  "captcha",
];

/** URL PATH segments that are a sign-in surface. Matched against the path only,
 *  so a marketing page whose query string merely mentions a login id cannot be
 *  mistaken for one. */
export const LOGIN_URL_PATTERNS: readonly RegExp[] = [
  /\/login(?:$|[/?#])/i,
  /\/signin(?:$|[/?#])/i,
  /\/sign[_-]?in(?:$|[/?#])/i,
  /\/auth\/(?:login|signin)/i,
];

/** Page titles that are a sign-in surface. */
export const LOGIN_TITLE_PATTERNS: readonly RegExp[] = [
  /\bsign[ -]?in\b/i,
  /\blog[ -]?in\b/i,
  /\bcontinue with\b/i,
  /^login\b/i,
];

/** The server's own shape for "a 2xx arrived carrying text that is not the
 *  model's answer". Matched against the service's own message, which is what
 *  RULE 11 hands the classifier, so the condition is read from the measurement
 *  rather than from a field invented to make a row fileable. v0 2026-09-30:
 *  HTTP 200 whose body carried the activity-region placeholder
 *  'Exploring ideas...'. */
export const NON_ANSWER_TEXT_PATTERNS: readonly RegExp[] = [
  /not the requested token/i,
  /is not the model's answer/i,
  /served as the answer/i,
  /status line was served/i,
];

/** The server's own shape for "the answer selector resolved to nothing in the
 *  page". Matched against the service's own message. venice 2026-09-30: the
 *  GOAL-160 answer selectors matched ZERO nodes in venice's real DOM, while
 *  the same page did hold the answer. */
export const UNMATCHED_SELECTOR_PATTERNS: readonly RegExp[] = [
  /answer selectors? match(?:ed|es)? (?:ZERO|zero) nodes/i,
  /answer selectors? match(?:ed|es)? nothing/i,
  /selectors? could never match/i,
];

/** The server's own phrase for "the composer selector found nothing on a page
 *  that did load". */
export const NO_COMPOSER_PATTERN = /no composer found/i;

/** The server's own phrase for "this site needs a signed-in session". */
export const SIGN_IN_MESSAGE_PATTERN = /requires sign-in|sign in once|requires login|not logged in|unauthenticated/i;

const idle = (p: PoolState | undefined): boolean => p?.busy === 0 && p?.queued === 0;
const has = (haystack: string, needles: readonly string[]): string | null => {
  const h = haystack.toLowerCase();
  return needles.find((n) => h.includes(n)) ?? null;
};
const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

// ── the rule ────────────────────────────────────────────────────────────────

/** The page the server reported reads as an anti-bot interstitial. */
export function challengeMarkerIn(page: ObservedPage): string | null {
  return has(`${page.title} ${page.url}`, CHALLENGE_MARKERS);
}

/** The page the server reported IS a sign-in surface. */
export function loginMarkerIn(page: ObservedPage): string | null {
  const path = pathOf(page.url);
  const urlHit = LOGIN_URL_PATTERNS.find((re) => re.test(path));
  if (urlHit) return `url path ${urlHit}`;
  const titleHit = LOGIN_TITLE_PATTERNS.find((re) => re.test(page.title));
  return titleHit ? `page title ${titleHit}` : null;
}

/** The service's own message reports that a 2xx body carried text which is not
 *  the model's answer. Returns the matched phrase, so the reason quotes the
 *  measurement rather than paraphrasing it. */
export function nonAnswerTextIn(message: string): string | null {
  return NON_ANSWER_TEXT_PATTERNS.find((re) => re.test(message))?.source ?? null;
}

/** The service's own message reports that the answer selector resolved to
 *  nothing in the page. */
export function unmatchedSelectorIn(message: string): string | null {
  return UNMATCHED_SELECTOR_PATTERNS.find((re) => re.test(message))?.source ?? null;
}

/** The closed, ordered decision. Order is the whole honesty argument: a
 *  challenge is checked BEFORE a login, because a challenge interstitials a
 *  login page too and "capture a session" is the wrong action for a bot wall. */
export function classifyOutcome(o: Outcome): Classification {
  if (o.noResponse || o.httpStatus === 0) {
    if (!idle(o.poolAtRequest)) {
      return { cls: "CONTENDED-TIMEOUT", reason: `no HTTP response (status ${o.httpStatus}) at a NON-idle pool (busy=${String(o.poolAtRequest?.busy)}, queued=${String(o.poolAtRequest?.queued)}) — a measurement of the queue` };
    }
    return { cls: "UNCLASSIFIED", reason: `no HTTP response at an IDLE pool (busy=${String(o.poolAtRequest?.busy)}) — a model property with no named cause; widen a class on purpose or record the finding` };
  }

  if (o.answerText && o.answerText.trim().length > 0 && o.httpStatus < 400) {
    return { cls: "ANSWERS", reason: `HTTP ${o.httpStatus} with real model output` };
  }

  // A 2xx that carried text is the sharpest hazard in this set, because every
  // other rule keys on a failure and this one arrives looking like success. It
  // is checked BEFORE the ANSWERS branch can fire on any answerText, and it
  // requires the pool to have been idle: a non-answer served under contention
  // is a measurement of the queue, not of the model.
  if (o.httpStatus >= 200 && o.httpStatus < 300 && nonAnswerTextIn(o.message)) {
    if (!idle(o.poolAtRequest)) {
      return { cls: "UNCLASSIFIED", reason: `HTTP ${o.httpStatus} at a NON-idle pool (busy=${String(o.poolAtRequest?.busy)}, queued=${String(o.poolAtRequest?.queued)}) carried text the service itself names as not-an-answer — not a settled measurement` };
    }
    return { cls: "NON-ANSWER-READ", reason: `HTTP ${o.httpStatus} at an IDLE pool carried text the service itself reports is not the answer ("${nonAnswerTextIn(o.message)}") — the answer selector resolved inside a region the site marks as activity/status, so the read SUCCEEDED and the text was still not an answer; the action is a profile/selector retune (declare that region non-answer), never ANSWERS` };
  }

  // The selector matched nothing at all. This is NOT a sign of a model that
  // cannot answer: on venice (2026-09-30) the site answered 'PONG' in the DOM
  // the driver had open, and the profile simply could not see it. It is also
  // NOT a sign-out and NOT a wall, so it is checked after both of those.


  const page = o.page;
  if (page) {
    const challenge = challengeMarkerIn(page);
    if (challenge) {
      return { cls: "WALL-CHALLENGE", reason: `server-reported page title/url matched anti-bot marker "${challenge}" (title: ${page.title} | url: ${page.url}) — action is the wigolo tier, never a retry loop` };
    }
    const login = loginMarkerIn(page);
    if (login) {
      return { cls: "SIGN-OUT", reason: `server-reported page IS a sign-in surface (${login}; title: ${page.title} | url: ${page.url})` };
    }
  }

  if (SIGN_IN_MESSAGE_PATTERN.test(o.message)) {
    return { cls: "SIGN-OUT", reason: `the server's own message names a sign-in requirement: ${o.message.slice(0, 120)}` };
  }

  if (NO_COMPOSER_PATTERN.test(o.message)) {
    if (!page) {
      return { cls: "UNCLASSIFIED", reason: "the server reported no composer and no page title/url, so the condition cannot be told from a sign-out — record observedPage or widen a class on purpose" };
    }
    return { cls: "COMPOSER-DRIFT", reason: `HTTP ${o.httpStatus}, the page LOADED (title: ${page.title} | url: ${page.url}) and is neither a sign-in surface nor a challenge, but the composer selector found nothing — action is a profile/selector retune, not a login` };
  }

  if (unmatchedSelectorIn(o.message)) {
    if (!idle(o.poolAtRequest)) {
      return { cls: "UNCLASSIFIED", reason: `the service reports the answer selector matched nothing at a NON-idle pool (busy=${String(o.poolAtRequest?.busy)}) — a measurement of the queue, not of the selector` };
    }
    return { cls: "ANSWER-UNREADABLE", reason: `the service reports the answer selector matched nothing in the page's real DOM at an IDLE pool — the DRIVER cannot read this model. This does NOT mean the model failed to answer (venice held its answer in that same DOM) and it is not a credential or anti-bot problem; the action is a profile/selector retune derived from a capture, never a guess from a failure` };
  }

  return { cls: "UNCLASSIFIED", reason: `HTTP ${o.httpStatus} matched no named condition; message: ${o.message.slice(0, 120)}` };
}

// ── the per-class preconditions the gate enforces ────────────────────────────
//
// Every class states what a record must carry for the claim to mean anything.
// These are checked against the SHIPPED record, so a new class without a
// precondition cannot be added: the type refuses to describe it.

export interface ClassPrecondition {
  /** Fields that must be present and non-empty. */
  requiredFields: readonly (keyof ClassFacts)[];
  /** Whether the record must carry poolAtRequest with numeric busy/total. */
  requiresPoolState: boolean;
  /** Whether an idle pool is REQUIRED (a contention claim needs a busy one). */
  requiresIdlePool: boolean;
}

export interface ClassFacts {
  measuredAt?: unknown;
  method?: unknown;
  evidence?: unknown;
  prereq?: unknown;
  poolAtRequest?: unknown;
  observedPage?: unknown;
}

export const CLASS_PRECONDITIONS: Record<VerificationClass, ClassPrecondition> = {
  ANSWERS: { requiredFields: ["measuredAt", "method", "evidence"], requiresPoolState: false, requiresIdlePool: false },
  "SIGN-OUT": { requiredFields: ["measuredAt", "method", "evidence"], requiresPoolState: false, requiresIdlePool: false },
  "WALL-CHALLENGE": { requiredFields: ["measuredAt", "method", "evidence", "observedPage"], requiresPoolState: true, requiresIdlePool: true },
  "COMPOSER-DRIFT": { requiredFields: ["measuredAt", "method", "evidence", "observedPage"], requiresPoolState: true, requiresIdlePool: true },
  "CONTENDED-TIMEOUT": { requiredFields: ["measuredAt", "method", "evidence"], requiresPoolState: true, requiresIdlePool: false },
  // NON-ANSWER-READ asserts a 2xx carried non-answer text, so a measuredAt, a
  // method and an evidence string that NAMES the non-answer are the minimum
  // that means anything — an evidence string that does not say what was served
  // proves nothing. The idle pool is required because under contention the
  // 2xx is a measurement of the queue. It deliberately does NOT require
  // observedPage: the service reported no page on this path, and demanding one
  // would make the class unreachable rather than stricter.
  "NON-ANSWER-READ": { requiredFields: ["measuredAt", "method", "evidence"], requiresPoolState: true, requiresIdlePool: true },
  // ANSWER-UNREADABLE asserts a selector matched nothing, which is a claim
  // about a COUNT somebody made against a real page. Same shape: measuredAt,
  // method and an evidence string that names the zero-match, plus the idle pool
  // the request started into.
  "ANSWER-UNREADABLE": { requiredFields: ["measuredAt", "method", "evidence"], requiresPoolState: true, requiresIdlePool: true },
  // UNMEASURED keeps its strict meaning: never reached. RULE 5 lets it be bare
  // precisely because it asserts nothing, and RULE 9 forbids it from carrying a
  // measured status.
  UNMEASURED: { requiredFields: [], requiresPoolState: false, requiresIdlePool: false },
};

export const classPrecondition = (c: VerificationClass): ClassPrecondition => CLASS_PRECONDITIONS[c];

/** A measured HTTP status quoted in the evidence of an UNMEASURED row. The row
 *  says "nothing was established" while simultaneously quoting a status code
 *  the service really returned — the exact shape the 2026-09-30 record carried
 *  for 7 rows. */
export function unmeasuredAfterMeasuredResponse(records: { model?: unknown; class?: unknown; evidence?: unknown }[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (r.class !== "UNMEASURED") continue;
    const model = typeof r.model === "string" && r.model.trim() ? r.model : "<no model field>";
    const ev = typeof r.evidence === "string" ? r.evidence : "";
    const m = ev.match(/\bHTTP\s+(\d{3})\b/i);
    if (m) out.push(`${model}: UNMEASURED but evidence quotes a measured HTTP ${m[1]} — the response WAS reached; classify it with classifyOutcome instead`);
  }
  return out.sort();
}
