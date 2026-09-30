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
  [/\bheadless\b|\bheaded\b/gi, "display-attached"],
  [/\bXvfb\b/g, "a virtual display"],
  [/\bCDP\b/g, "the attach endpoint"],
  [/\bbrowser-bound\b/gi, "session-bound"],
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
 *
 *   NOT DERIVABLE (and named as such, because pretending otherwise is the
 *   rot this section exists to kill): the set of CONCEPT WORDS — "Chrome",
 *   "Xvfb", "CDP", "headless". No amount of scanning the code can tell you that
 *   the word "Xvfb" is internal; only a person knows that. So the lexicon is
 *   hand-declared ONCE, as the rules above, and the gate's leverage is applied
 *   where it is real: every marker-declared class must be covered, every knob
 *   the code reads must be removed, every goal reference must be removed. A
 *   NEW concept word needs a new rule, and `proseRuleIds()` is what the test
 *   enumerates — so it is a visible edit in one list, never a silent leak.
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
    "attach-mechanism": [/\breal Chrome\b/, /\bheaded\b/i, /\bheadless\b/i, /\bXvfb\b/, /\bCDP\b/],
    "display-mechanism": [/\bXvfb\b/, /\bheaded\b/i, /\bheadless\b/i],
    "browser-binding": [/\bbrowser-bound\b/i],
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
