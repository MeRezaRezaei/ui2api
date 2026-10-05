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
// WHY THE SET HAS NINE MEMBERS AND NOT FOUR: more than a couple have different
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

// THE MATCHER BELOW IS NOT AUTHORED HERE. It is computed by the module that
// EMITS the sentence, so a reword of the emitter moves the matcher with it
// instead of leaving this file describing a shape nothing produces any more.
// `./error-redaction.ts` owns the clause and builds the pattern; importing it
// here is a dependency on the owner, never a second copy of the words. The same
// shape as `CONCEPT_TERMS` / `consumerAccountRefusal` in `./consumer-surface.ts`.
import { NO_ANSWER_REFUSAL_RE } from "./error-redaction.js";

export const VERIFICATION_CLASSES = [
  "ANSWERS",
  // A CAPABILITY surface returned real data over the wire. Every OTHER member
  // keys on a CHAT ANSWER — `ANSWERS` needs `probeNonceMatched` + `answerChars>0`
  // + `doneReason:"stable"`, and the six failure members all key on a page
  // marker or a message the driver emitted. MEASURED: `araprat_search` answers
  // HTTP 200 `ok:true` with 29 real rows, and under the pre-widening vocabulary
  // that derived UNCLASSIFIED — a gate that structurally cannot fire for 26 of
  // the 33 packages, since NO capability surface could ever be recorded as
  // MEASURED. Same defect class this module exists to kill: a vocabulary that
  // cannot express the thing it is asked to check.
  "RETURNS-DATA",
  "SIGN-OUT",
  "WALL-CHALLENGE",
  "COMPOSER-DRIFT",
  "CONTENDED-TIMEOUT",
  "NON-ANSWER-READ",
  "ANSWER-UNREADABLE",
  "UNATTRIBUTED-NO-ANSWER",
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

/**
 * The SHAPE of a returned capability result — never its content.
 *
 * This is deliberately the shape and nothing else. The record carrying it is
 * published in the sanitized public mirror (`capabilities/roundtrip.json`), so a
 * measurement kept only in `.brain/` or `data/` — both stripped by
 * `scripts/ci/make-public-repo.sh` — would be unreviewable by anyone reading the
 * repo. Key NAMES and a COUNT are what makes a capability round trip reviewable
 * without publishing one row of the site's data.
 *
 * `count` and `rows` are BOTH recorded, and they must AGREE for the class to be
 * derivable. They are not redundant: `count` is the number the RUNNER declared
 * (`data.count` in the runner's own result), and `rows` is the number of records
 * a machine actually counted in the returned collection. A runner that reports
 * `count: 12` over 0 records is a runner whose claim and whose payload disagree,
 * and a class meaning "the site returned real data" must not be derivable from
 * the declared half alone — that is precisely a hand-typed class one layer down.
 */
export interface ResultShape {
  topLevelKeys?: unknown;
  /** Dotted path of the collection the rows were counted in, e.g. `data.results`. */
  rowsPath?: unknown;
  /** The runner's own declared count, read off the response. */
  count?: unknown;
  /** The number of records actually counted in that collection. */
  rows?: unknown;
  /** Dotted path of a single returned RECORD, for a detail-shaped result. */
  recordPath?: unknown;
  /** The sorted key names of that record (names only, never values). */
  recordKeys?: unknown;
  /** How many of that record's values are non-empty — a populated, not a shell. */
  nonEmptyValues?: unknown;
  /** The runner declared a count of ZERO somewhere: its own result is empty. */
  declaredZeroCount?: unknown;
}

/** The service's OWN verdict on the capability it ran: `result.ok`. A capability
 *  that answered `{ok:false, loginGated:true}` is a REFUSAL that reached the
 *  wire, and it must never derive a data-returned class. */
export interface Outcome {
  httpStatus: number;
  message: string;
  page?: ObservedPage;
  poolAtRequest?: PoolState;
  /** The service answered with real model output. */
  answerText?: string;
  /** No HTTP response at all (client abort / 000). */
  noResponse?: boolean;
  /** `result.ok` — the runner's own verdict, for a capability surface. */
  capabilityOk?: unknown;
  /** The shape of the returned result, for a capability surface. */
  resultShape?: ResultShape | null;
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

/** The service's OWN wording for the no-answer timeout it reports.
 *
 * WHAT IS ACTUALLY TRUE, STATED HERE BECAUSE THE PREVIOUS COMMENT WAS NOT: this
 * array holds NO hand-typed pattern. Its single member is `NO_ANSWER_REFUSAL_RE`,
 * whose source is COMPUTED in `./error-redaction.ts` from
 * `NO_ANSWER_REFUSAL_CLAUSE` — the clause the emitter itself renders — plus the
 * emitter's own timer-extraction pattern. The old comment here claimed the
 * pattern was "taken from the single template that produces it"; nothing took it
 * from anything, and the sentence was TYPED in this file as well, so a reword of
 * the emitter left this matcher matching NOTHING and the whole class
 * UNATTRIBUTED-NO-ANSWER unreachable while every gate stayed green.
 *
 * WHY IT COVERS THE CLAUSE AND NOT THE WHOLE SENTENCE, which is now derived
 * rather than asserted: the classifier is fed the service's own message, and the
 * real message is the sentence EMBEDDED in evidence prose — the shipped `v0` row
 * quotes it mid-paragraph and renders the dash as a plain hyphen. A whole-sentence
 * matcher would fail the one record that must re-derive. The clause is what
 * survives that embedding.
 *
 * It is therefore still the service naming a condition and listing its candidate
 * causes — busy, rate-limiting, sign-in or consent wall — without asserting which
 * one is real, and it still REQUIRES that clause, so text that merely resembles a
 * timeout is not a match and widening it to catch generic prose about timeouts
 * cannot pull a different failure in behind it. What "that shape" is, stated
 * exactly because the sentence above is derived and the shape is no longer a
 * hand-written one: the CLAUSE, optionally followed by the emitter's own
 * `within <digits>ms` — the clause alone matches, because the clause alone is what
 * survives being quoted inside evidence prose. This is the same breadth the
 * hand-typed pattern had (it made the timer group optional too), and
 * `test/error-redaction.test.ts` measures the derived matcher against what the
 * emitter actually emits, timed and untimed. v0 2026-09-30: four identical 502s
 * at an IDLE pool carrying this sentence. */
export const NO_ANSWER_REFUSAL_PATTERNS: readonly RegExp[] = [NO_ANSWER_REFUSAL_RE];

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

/** The service's own message is its named no-answer refusal. Returns the
 *  matched pattern, so the reason quotes the measurement's own shape. */
export function noAnswerRefusalIn(message: string): string | null {
  return NO_ANSWER_REFUSAL_PATTERNS.find((re) => re.test(message))?.source ?? null;
}

/** A non-empty string, or nothing. The shape facts are read off a real response
 *  as untrusted JSON, so nothing here trusts its type. */
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? v : null);

/**
 * THE CAPABILITY-SURFACE EVIDENCE — the one derivation `RETURNS-DATA` rests on.
 *
 * WHAT IT PROVES, and what it does not: the service answered 2xx, the RUNNER
 * declared `ok: true`, the returned payload is a well-formed object, and the
 * collection it returned holds AT LEAST ONE record — with the runner's declared
 * count and the machine-counted rows in AGREEMENT. That is "the site returned
 * real data over the wire". It is deliberately NOT a claim about the CONTENT,
 * and it is deliberately not a chat claim: a capability has no answer text and
 * no nonce, so nothing here is borrowed from the chat rules.
 *
 * EVERY CLAUSE IS LOAD-BEARING, and each one closes a specific way this could
 * have become a laundering machine:
 *
 *   - `capabilityOk === true`. A capability that answered `{ok:false}` with a
 *     NAMED refusal — `loginGated`, a challenge, a restriction wall — reached
 *     the wire and returned NOTHING. `ok:false` is the service's own word for
 *     that, and reading it is what keeps a refusal out of this class. The
 *     refusal then falls to the classes below (or to UNCLASSIFIED, which the
 *     write seam refuses to record at all).
 *   - `rows >= 1`. An EMPTY result set is NOT this class. See the empty-result
 *     decision below.
 *   - `count === rows`. The declared half alone is a claim; the counted half
 *     alone is a shape. Requiring both to agree means a row cannot buy the class
 *     by typing one of them.
 *   - `topLevelKeys` non-empty. A payload with no keys is not a result, it is a
 *     refusal that forgot to say `ok:false`.
 */
export function capabilityDataEvidence(o: {
  httpStatus: number;
  capabilityOk?: unknown;
  resultShape?: ResultShape | null;
}): { arm: "list"; rows: number; count: number; rowsPath: string; keys: number } | { arm: "record"; rows: number; count: null; rowsPath: string; keys: number } | null {
  if (!(o.httpStatus >= 200 && o.httpStatus < 300)) return null;
  if (o.capabilityOk !== true) return null;
  const shape = o.resultShape;
  if (!shape || typeof shape !== "object") return null;
  const keys = shape.topLevelKeys;
  if (!Array.isArray(keys) || keys.length === 0) return null;

  // ARM 1 — a COUNTED COLLECTION. The runner declared its result size and the
  // machine counted the records; the two must agree, at >= 1.
  const rowsPath = text(shape.rowsPath);
  const declared = count(shape.count);
  const counted = count(shape.rows);
  if (rowsPath && declared !== null && counted !== null && declared === counted && counted >= 1) {
    return { arm: "list", rows: counted, count: declared, rowsPath, keys: keys.length };
  }

  // ARM 2 — a SINGLE RECORD. MEASURED, why this arm exists at all:
  // `araprat_video_detail` answers `{ok:true, data:{id, url, title,
  // description, related:[…], relatedCount:n}}` — one record, not a collection,
  // and no count beside one. Under arm 1 alone that real, populated, live result
  // derived UNCLASSIFIED, which is the SAME defect this class was added to kill
  // one surface down: a vocabulary that cannot express what it is asked to
  // check. So the second arm accepts a POPULATED record object instead of a
  // counted collection.
  //
  // It is deliberately weaker than arm 1 and therefore deliberately GUARDED:
  // `declaredZeroCount` is the write seam's record that the runner DECLARED a
  // count of zero somewhere in the payload. A runner that says "my result is
  // empty" has answered the empty-result question, and a populated sibling key
  // must not talk its way past that. Arm 2 is only reachable when the runner
  // declared no count of zero at all.
  if (shape.declaredZeroCount === true) return null;
  const recordPath = text(shape.recordPath);
  const recordKeys = Array.isArray(shape.recordKeys)
    ? shape.recordKeys.filter((k: unknown): k is string => typeof k === "string" && k.trim() !== "")
    : [];
  const nonEmpty = count(shape.nonEmptyValues);
  if (!recordPath || recordKeys.length === 0 || nonEmpty === null || nonEmpty < 1) return null;
  return { arm: "record", rows: 1, count: null, rowsPath: recordPath, keys: keys.length };
}

/**
 * THE EMPTY-RESULT DECISION, stated once here because it changes what the class
 * means: an empty `rows: []` is a SUCCESSFUL MEASUREMENT OF NOTHING, and it is
 * filed on the UNCLASSIFIED side of the line, not under `RETURNS-DATA`.
 *
 * THE REASON, and it is a claim about the class rather than about the site: this
 * class means "the surface returned DATA". Zero rows is a real round trip — the
 * site answered, the read succeeded — but there is no data in it, and a
 * `verified` capability claim is a claim that the capability PRODUCES results.
 * Letting the empty case in would make the gate satisfiable by a surface that
 * returns nothing forever, which is the "gate that cannot fail" defect wearing
 * the opposite face.
 *
 * So an empty result is refused by `capabilityDataEvidence` (it requires
 * `rows >= 1`), falls through every named condition, and derives UNCLASSIFIED —
 * which is NOT a class, so the write seam reports the measurement and writes
 * nothing. An operator who wants "the surface works and legitimately matches
 * nothing" recorded must widen the rule on purpose with a NEW member, not have
 * this one stretch to cover it. That is the same bar every other class in this
 * file was held to.
 */
export function emptyCapabilityResult(o: { capabilityOk?: unknown; resultShape?: ResultShape | null }): boolean {
  if (o.capabilityOk !== true) return false;
  const shape = o.resultShape;
  if (!shape || typeof shape !== "object") return false;
  const declared = count(shape.count);
  const counted = count(shape.rows);
  if (declared !== null && counted !== null && declared === counted && counted === 0) return true;
  // The SINGLE-RECORD arm's empty twin: the runner declared a count of ZERO
  // somewhere in the payload, so it has already answered "my result is empty",
  // and no populated sibling key may talk the record arm past that answer. Named
  // here so the two arms cannot disagree about what "empty" means.
  return shape.declaredZeroCount === true;
}

/** The closed, ordered decision. Order is the whole honesty argument, in two
 * places: a challenge is checked BEFORE a login, because a challenge
 * interstitials a login page too and "capture a session" is the wrong action for
 * a bot wall; and a 2xx the service reports as carrying a non-answer is checked
 * BEFORE ANSWERS, because ANSWERS fires on any non-empty answerText and would
 * otherwise claim a read that returned the wrong node. */
export function classifyOutcome(o: Outcome): Classification {
  if (o.noResponse || o.httpStatus === 0) {
    if (!idle(o.poolAtRequest)) {
      return { cls: "CONTENDED-TIMEOUT", reason: `no HTTP response (status ${o.httpStatus}) at a NON-idle pool (busy=${String(o.poolAtRequest?.busy)}, queued=${String(o.poolAtRequest?.queued)}) — a measurement of the queue` };
    }
    return { cls: "UNCLASSIFIED", reason: `no HTTP response at an IDLE pool (busy=${String(o.poolAtRequest?.busy)}) — a model property with no named cause; widen a class on purpose or record the finding` };
  }

  // A 2xx that carried text is the sharpest hazard in this set, because every
  // other rule keys on a failure and this one arrives looking like success — so
  // it is settled BEFORE the ANSWERS branch, which would otherwise swallow it:
  // ANSWERS fires on any non-empty answerText below 400, and the shape this rule
  // exists for (a 2xx whose served text the service itself names as not-the-
  // answer) always carries text, so placing this after ANSWERS made the branch
  // unreachable for every input it names. It requires the pool to have been
  // idle: a non-answer served under contention is a measurement of the queue,
  // not of the model, so a busy pool is refused here as UNCLASSIFIED rather
  // than answered in either direction.
  if (o.httpStatus >= 200 && o.httpStatus < 300 && nonAnswerTextIn(o.message)) {
    if (!idle(o.poolAtRequest)) {
      return { cls: "UNCLASSIFIED", reason: `HTTP ${o.httpStatus} at a NON-idle pool (busy=${String(o.poolAtRequest?.busy)}, queued=${String(o.poolAtRequest?.queued)}) carried text the service itself names as not-an-answer — not a settled measurement` };
    }
    return { cls: "NON-ANSWER-READ", reason: `HTTP ${o.httpStatus} at an IDLE pool carried text the service itself reports is not the answer ("${nonAnswerTextIn(o.message)}") — the read SUCCEEDED and the text was still not an answer; the action is to find which node the site served that text from and retune the profile against a capture, never ANSWERS` };
  }

  if (o.answerText && o.answerText.trim().length > 0 && o.httpStatus < 400) {
    return { cls: "ANSWERS", reason: `HTTP ${o.httpStatus} with real model output` };
  }

  // A CAPABILITY surface that returned real data over the wire.
  //
  // WHERE IT SITS, and why it is in FRONT of every refusal rule below: the
  // refusals are all decided by a page marker or by a message the driver
  // emitted, and the gate in front of them is the service's OWN refusal switch
  // — `result.ok`. A named refusal (login-gated, challenge, restriction wall)
  // reaches the wire as `{ok:false, ...}`, so it cannot reach this branch at all:
  // `capabilityDataEvidence` requires `capabilityOk === true` and drops every
  // `ok:false` shape on the floor, where the message/page rules below name it.
  // Putting this AFTER them would have been defensible too, and would have
  // changed nothing, because a `ok:false` refusal carrying rows would be a runner
  // contradicting itself rather than a shape worth trusting.
  //
  // It sits after ANSWERS because a capability has no answer text to claim: a
  // row that carries BOTH a matched nonce and a capability result is a chat
  // round trip and is filed as ANSWERS, which is the stronger claim.
  const capData = capabilityDataEvidence(o);
  if (capData) {
    if (!idle(o.poolAtRequest)) {
      return {
        cls: "UNCLASSIFIED",
        reason: `the capability surface returned ${capData.rows} record(s) at ${capData.rowsPath}, but at a NON-idle pool (busy=${String(o.poolAtRequest?.busy)}, queued=${String(o.poolAtRequest?.queued)}) — under contention a shared browser's page is not this request's own result, so the read is a measurement of the queue, not of the surface`,
      };
    }
    return {
      cls: "RETURNS-DATA",
      reason:
        capData.arm === "list"
          ? `HTTP ${o.httpStatus}, the runner's own verdict ok=true, and the returned payload is a well-formed object ` +
            `(${capData.keys} top-level keys) whose collection at ${capData.rowsPath} holds ${capData.rows} record(s), ` +
            `with the runner's declared count=${capData.count} agreeing with the counted rows. ` +
            `This is a CLAIM ABOUT THE SURFACE'S OUTPUT SHAPE, not its content and not a chat answer: a capability ` +
            `returns JSON, so no nonce applies, and this class says exactly one thing — the site returned real data over the wire.`
          : `HTTP ${o.httpStatus}, the runner's own verdict ok=true, and the returned payload is a well-formed object ` +
            `(${capData.keys} top-level keys) carrying a POPULATED RECORD at ${capData.rowsPath}, with the runner declaring ` +
            `no count of zero anywhere (so this is not an empty result). This is a single-record result rather than a counted ` +
            `collection, and it is the WEAKER of this class's two evidence arms: it says the surface returned a non-empty ` +
            `result object, not how many records that object holds. Still a CLAIM ABOUT OUTPUT SHAPE, never about content, ` +
            `and never a chat answer — a capability returns JSON, so no nonce applies.`,
    };
  }

  // The service answered `ok:true` but returned an EMPTY collection. Said here
  // rather than left to the generic fallback so the refusal is legible: see
  // `emptyCapabilityResult` for why this is filed as the classifier's refusal
  // rather than as a class, and what the honest widening would be.
  if (emptyCapabilityResult(o)) {
    const s = (o.resultShape ?? {}) as ResultShape;
    const where =
      typeof s.rowsPath === "string" && s.rowsPath
        ? `the collection at ${s.rowsPath} came back EMPTY (declared count=${String(s.count)}, counted rows=${String(s.rows)})`
        : `the runner DECLARED a count of zero somewhere in the payload (declaredZeroCount), so its own result is empty`;
    return {
      cls: "UNCLASSIFIED",
      reason:
        `HTTP ${o.httpStatus} with the runner's own verdict ok=true, but ${where}. That is a SUCCESSFUL MEASUREMENT OF NOTHING: ` +
        `the read reached the site and the site returned no records, which is not evidence that the surface PRODUCES results, ` +
        `so it is deliberately NOT filed as RETURNS-DATA — a class that admitted the empty case would let the gate be satisfied ` +
        `by a surface that returns nothing forever. If "the surface works and legitimately matches nothing" is a claim worth ` +
        `recording, it needs its OWN class member on purpose, not this one stretched to cover it.`,
    };
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

  // The service reported its own named no-answer refusal. It is placed LAST, so
  // it can only ever hold what every specific condition above declined: no
  // challenge page, no sign-in surface and no sign-in assertion, no missing
  // composer, no zero-node answer selector, no answer text. WHAT IS KNOWN is
  // that a no-answer was reported at an idle pool with no page attached; WHICH
  // CAUSE produced it is NOT known, because the sentence names busy,
  // rate-limiting and a sign-in/consent wall as candidates and asserts none. So
  // this class licenses exactly one action — re-measure with something that
  // separates those candidates — and asserting any one of them here would be
  // the fabrication this project's own history forbids: a busy-pool timeout
  // filed as a model property produced a 4.77-hour diagnosis that was wrong.
  const refusal = noAnswerRefusalIn(o.message);
  if (refusal) {
    if (!idle(o.poolAtRequest)) {
      return { cls: "UNCLASSIFIED", reason: `the service reported its named no-answer refusal at a NON-idle pool (busy=${String(o.poolAtRequest?.busy)}, queued=${String(o.poolAtRequest?.queued)}) — a measurement of the queue, not of the model` };
    }
    return { cls: "UNATTRIBUTED-NO-ANSWER", reason: `HTTP ${o.httpStatus} at an IDLE pool, no page reported, and the service's own message is its named no-answer refusal (${refusal}) — the refusal LISTS its candidate causes (busy, rate-limiting, sign-in or consent wall) and asserts NONE of them, so NO CAUSE IS ESTABLISHED here and none may be assumed: this is not "the site is rate-limited", not "log in", and not contention. The action is to re-measure with a discriminator that separates the candidates the service itself named` };
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
  resultShape?: unknown;
  capabilityOk?: unknown;
}

export const CLASS_PRECONDITIONS: Record<VerificationClass, ClassPrecondition> = {
  ANSWERS: { requiredFields: ["measuredAt", "method", "evidence"], requiresPoolState: false, requiresIdlePool: false },
  // RETURNS-DATA asserts THE SURFACE'S OUTPUT SHAPE, so the minimum that means
  // anything is: a dated measurement, the method that took it, an evidence string
  // that NAMES what came back (shape and row count), the runner's own `ok:true`
  // verdict, and the resultShape the derivation reads — `resultShape` is in
  // requiredFields rather than implied, because `classifyOutcome` refuses the
  // class without it and a precondition that does not name it would let a row
  // satisfy the gate's letter while its derivation says otherwise.
  //
  // The IDLE pool is REQUIRED and that is the strictest clause here, stricter
  // than ANSWERS. A capability runner drives a SHARED browser out of the warm
  // pool, so under contention the page the rows were read from may not even be
  // this request's own result — which is the capability-surface form of the
  // stale-echo hazard `probeNonceMatched` exists to kill on the chat surface.
  // ANSWERS can afford to skip it because a per-measurement nonce proves the
  // served text is THIS request's; a capability has no nonce to carry that
  // proof, so an idle pool is the strongest guarantee available and it is
  // therefore mandatory.
  //
  // It deliberately does NOT require observedPage: `/capability` answers the
  // runner's result, not the driver's page observation, so demanding one would
  // make the class unreachable rather than stricter.
  "RETURNS-DATA": {
    requiredFields: ["measuredAt", "method", "evidence", "capabilityOk", "resultShape"],
    requiresPoolState: true,
    requiresIdlePool: true,
  },
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
  // UNATTRIBUTED-NO-ANSWER asserts only a REPORTED no-answer plus the absence of
  // every cause the record could have named, so the minimum that means anything
  // is a dated measurement, the method that took it, and an evidence string
  // that carries the service's own refusal sentence — an evidence string that
  // does not quote it proves no refusal happened. The idle pool is REQUIRED,
  // because at a busy pool the same refusal is a measurement of the queue (this
  // project's own lesson: a busy-pool timeout filed as a model property produced
  // a 4.77-hour diagnosis that was wrong, which is why CONTENDED-TIMEOUT is a
  // queue property and never a model property). It deliberately does NOT require
  // observedPage: the service reported no page on this path, so demanding one
  // would make the class unreachable rather than stricter. What it must NOT be
  // allowed to carry is a cause: nothing here licenses "the site is
  // rate-limited" or "log in", and the row stays a claim about a refusal whose
  // cause is UNKNOWN, never a diagnosis of one.
  "UNATTRIBUTED-NO-ANSWER": { requiredFields: ["measuredAt", "method", "evidence"], requiresPoolState: true, requiresIdlePool: true },
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
