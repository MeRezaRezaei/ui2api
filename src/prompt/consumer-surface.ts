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
  [/\bui2api\s+[a-z-]+(?:\s+[a-z-]+){0,3}\s+(?=[.,;—]|$)/gi, "the operator's own tooling "],
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
