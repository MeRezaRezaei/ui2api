// Registry surface for promptd — GET /registry
//
// This is the CONTRACT OmniRoute (and any other consumer) reads to drive a
// deployed ui2api daemon. It is built exclusively from the installed ui2api
// capability packages (the registry repo's content mirrored into
// capabilities/<id>/) — whatever is in the registry repository appears here,
// and nothing else. OmniRoute holds no site knowledge of its own: it syncs
// this endpoint into provider nodes (models) + MCP tools (capabilities).
//
//   GET /registry
//   -> { packages: [
//        { id, name, url, description, version, site, authRequired,
//          chat:   { model: <siteId>, streaming: true },   // ONLY on driveable chat packages
//          tools:  [ { name, description, method,
//                      inputSchema: {type:"object", properties, required} } ]
//        }, ...
//      ],
//      generatedAt }
//
// "tools" are the package's capabilities expressed as MCP-tool-shaped
// definitions. Tool naming: "<site>_<capability>" (capability ids already
// carry the site prefix, e.g. deepseek_chat); consumers prefix their own
// namespace (OmniRoute registers them as ui2api_<site>_<capability>).
//
// `chat` is stamped ONLY on ids in the servable chat set — the exact
// `defaultChatSurface()` gate promptd builds its `/v1` (profilesById) allow-list
// from (GOAL 34 truth-gate). Every other installed package (capability-only
// surfaces like gmail/youtube/araprat, url-less chatglm, dormant zenmux,
// dead-end xiaomimimo, …) carries NO `chat` key at all: `/v1/chat/completions`
// would refuse it with 404 unknown_model, so an honest registry must not
// advertise it as chat. Consumers treat absence as "no chat" — never
// materialize a chat provider from a package without `chat.model`.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { isDispatchable } from "./capability-dispatch.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackagedProfile, listProfiles, isDriveableChatProfile, type ChatSiteProfile } from "../profile/profile.js";
import { listAccounts, verifyStoredAccount, withAccountVerdict, type StoredAccount } from "../runtime/session-store.js";
import { consumerAccountsSummary, consumerProse, consumerVerifiedRecord, type ConsumerAccountsSummary } from "./consumer-surface.js";
import { VERIFICATION_CLASSES, capabilityDataEvidence, falsifiesClaim } from "./verification-class.js";

export interface RegistryToolInputSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; default?: unknown }>;
  required: string[];
  /**
   * GOAL 139: "at least one of these" groups. A runner that reads
   * `args.q ?? args.query` accepts EITHER name — declaring BOTH required would
   * be a false claim (a consumer would send both, or reject a valid call), and
   * declaring NEITHER would let it send nothing. `anyOf` is the honest form, and
   * it is what a validating consumer needs to check a call correctly.
   */
  anyOf?: { required: string[]; description?: string }[];
}

export interface RegistryTool {
  /** Normalized "<site>_<capability>" name (consumer-facing, MCP id). */
  name: string;
  /** Raw capability id the daemon's /capability/<site> understands. */
  id: string;
  description: string;
  /**
   * Execution style for this capability:
   *  - "ui-path":   drive the site's own real UI — mouse/keyboard against the
   *                 page (composer typing, toggle clicks). Slower, visible as
   *                 a genuine human session, works on any site.
   *  - "js-function": inject what the site's own JS function expects into the
   *                 DOM and call the function directly (no mouse/keyboard).
   *                 Faster, invisible — the site runs exactly its own code
   *                 path. Work type is chosen per-capability here, in the map.
   * Defaults to "ui-path".
   */
  workType: "ui-path" | "js-function";
  /**
   * Reload-after-success policy, part of the map contract itself: the only
   * thing the daemon needs to do after each successful action is to refresh
   * the page, so anything the host site's server knows about this session is
   * re-established and a missing piece of info in the current DOM can never
   * leak into the next call — the map functions keep working by just
   * reloading the page each time.
   */
  reloadAfterSuccess: boolean;
  method: string;  inputSchema: RegistryToolInputSchema;
  /**
   * GOAL 139: was `inputSchema` DECLARED by the package, or guessed? A guessed
   * schema has been measurably wrong, so a consumer that auto-generates a client
   * must be able to see the difference rather than trust a fabrication.
   */
  argsDeclared: boolean;
  /**
   * GOAL 140: "wired" = the daemon can execute this tool; "declared-only" = the
   * package declares it but no dispatch route exists, so a call 404s. Never
   * advertise the second as servable.
   */
  dispatch: "wired" | "declared-only";
  /**
   * WHAT THE MEASUREMENT RECORD SAYS ABOUT THIS ONE TOOL — the per-capability
   * resolution from `capabilities/roundtrip.json`, carried onto the tool the
   * consumer is about to call.
   *
   * WHY IT IS PER TOOL AND NOT ONLY PER PACKAGE. `status` is the package's
   * claim and a package with one working and one 502-ing capability is honestly
   * `verified` (the claim is about the surface). But a `/registry` consumer
   * materialises ONE TOOL PER CAPABILITY and calls them independently, so the
   * package verdict is the wrong resolution for the decision the consumer is
   * actually making: measured, `youtube` published `status: "verified"` with
   * seven equally-present tools and nothing distinguished the search that
   * returns 10 rows from the transcript that answers HTTP 502. A limitation a
   * consumer cannot see is the same blindness one layer out.
   *
   * ABSENT (`undefined`) when the record says nothing at all about this tool —
   * which is the honest default, since "never measured" must never render as a
   * measured state. Present in every other case, including the `unmeasured`
   * reading, so "a row exists and none of the derived readings apply" is
   * distinguishable from "no row".
   */
  roundTrip?: CapabilityRoundTrip;
}

export interface RegistryChat {
  model: string;
  streaming: boolean;
}

export interface RegistryPackage {
  id: string;
  name: string;
  url: string;
  description: string;
  version: string;
  site: string;
  authRequired: boolean;
  status: string;
  /**
   * Machine-checkable verification record, from metadata.json `verified`.
   * `false` (or absent) = NOT verified — the registry consumer can rely on
   * this to gate which packages it surfaces as working. Never set without a
   * real recorded live round-trip in this repo.
   */
  verified: RegistryVerified | false;
  /**
   * Chat claim of this package — ABSENT (undefined) on every package NOT in
   * the servable chat set. Present ONLY when `id` is on `defaultChatSurface()`
   * (the SAME gate promptd builds its /v1 profilesById allow-list from): then
   * `model` = the site id `/v1/chat/completions` actually answers for.
   * Capability-only / url-less / dormant / dead-end packages (gmail, youtube,
   * araprat, chatglm, zenmux, xiaomimimo, …) keep status/tools/accounts but
   * carry NO chat key — /v1 would refuse them with 404 unknown_model, so an
   * honest registry never advertises them as chat (GOAL 34). Consumers must
   * treat absence as "no chat" (key on `pkg.chat?.model`, never `pkg.chat.model`).
   */
  chat?: RegistryChat;
  /**
   * GOAL 159: why this addressable package carries NO `chat` key. Present only
   * when the id is on the addressable surface (GOAL 34) but its measured record
   * class is not ANSWERS. A consumer keying on `pkg.chat` therefore never
   * materialises a provider for a model the record says cannot answer, and a
   * consumer reading the catalogue can still see the package and read exactly
   * what is missing.
   */
  chatWithheld?: { class: string; reason: string };
  tools: RegistryTool[];
  /**
   * The identity-keyed vault accounts stored for this site — the SAME source
   * as `GET /accounts?site=<id>` (http.ts). Host is derived from the packaged
   * profile's url (`new URL(profile.url).host`), matching /accounts exactly.
   * `[]` is honest: it means "no accounts stored for this site's host". The
   * field is ABSENT (undefined) only when the package has no resolvable url
   * (no host to key the vault by) — never an empty-by-accident array.
   *
   * GOAL 89: every row carries the RECONCILED verdict (`usable` + a NAMED
   * `reason` when it cannot drive requests) — see `accountsSummary` below.
   */
  accounts?: StoredAccount[];
  /**
   * GOAL 89 host-level rollup of the account verdicts above. The registry is
   * the ONLY info source a consumer has, so an all-unusable host must be
   * visible as such and not merely look like an empty choice set: `usable: 0`
   * with the NAMED reasons listed. ABSENT when the package has no accounts.
   */
  accountsSummary?: ConsumerAccountsSummary;
}

export interface RegistryVerified {
  /** ISO date the live round-trip was recorded. */
  since: string;
  /** Human-readable proof pointer (proof id / live-qualified check). */
  evidence: string;
  /**
   * How it was verified. On the WIRE this is deliberately the mechanism-free
   * class: the operator's own record names the mechanism (a replayed session,
   * an attached browser, a virtual display, the site's anti-bot vendor, a
   * localStorage key, a request header) and the registry republishes this
   * object verbatim to every consumer, so the free prose used to be handed out
   * whole. A consumer cannot act on it and cannot avoid branching on it; the
   * dated, scoped fact below is what it needs.
   */
  via: string;
  /** Optional honesty note: which capabilities the verification covers. */
  scope?: string;
}

interface Metadata {
  status?: string;
  verified?: RegistryVerified | boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE STATUS PROVENANCE GATE
//
// ================================ WHAT WENT WRONG ============================
//
// `buildRegistryPackages()` read `metadata.json`'s `status` as a bare string and
// republished it verbatim on `/registry` and `/capabilities/<site>`:
//
//     if (typeof meta.status === "string" && meta.status.trim()) status = meta.status.trim();
//
// So a package could CLAIM the one status in the shipped vocabulary that means
// "a live round-trip was recorded and I can point at it" — `verified` — with no
// `verified` record behind it. The registry is the ONLY info source an external
// consumer has, and it publishes `status` next to a `verified` RECORD field, so
// an unearned `status: "verified"` reads on the wire exactly like an earned one:
// a fabricated capability claim, handed to every consumer, in the one place this
// repo's own rule says nothing is claimed without evidence.
//
// The contradiction was already visible in this very file, which is how the rule
// is DERIVED rather than invented: `packageStatusOf()` (line ~419) — the
// resolver `/sites`, `prompt --sites` and `requirements` all call — has always
// returned `verified` ONLY from a full record and never from the string. The
// same package therefore reported `verified` on `/registry` while `/sites`
// reported `unverified-candidate` for it. Two surfaces, one package, opposite
// answers, and the dishonest one is the one every consumer reads. So the gate
// below is not a new policy: it is the `/sites` rule applied to the surface that
// forgot it.
//
// ============================== THE RULE =====================================
//
// The EARNED classification is `verified`. It survives only when the record that
// `RegistryVerified` already defines is present and complete — `since`,
// `evidence`, `via` all non-empty strings, the same shape `packageStatusOf()`
// demands and `validate-registry.mjs` already refuses otherwise. Absent that
// record the declared string is not trusted and the status degrades to
// `unverified-candidate`, the honest word this module already uses for exactly
// "driveable, no recorded live round-trip" (`defaultChatSurface()` line ~546).
//
// Everything else passes through untouched, DELIBERATELY:
//
//   - `dormant` / `dead-end` are not claims of success, they are the honest
//     report of a limitation, and demoting them would hide a blocker.
//   - `active` / `scaffold` / any future operator string is not an earned
//     classification, so gating it would be inventing a rule from nothing.
//
// The alternative rule — "only publish statuses from a known enum" — was
// rejected on measurement: it would rewrite 9 of the 33 shipped packages
// (`active`, `scaffold`, `dead-end`, `dormant`) and invent vocabulary the
// packages do not use. Narrow the gate to the earned claim instead.

// The one status in the shipped vocabulary that asserts a verification HAPPENED.
const EARNED_STATUS = "verified";
// What a package with driveable selectors and no recorded round-trip is called.
const UNEARNED_STATUS = "unverified-candidate";

/** The shape `RegistryVerified` requires before a `verified` claim is honoured. */
function isCompleteVerifiedRecord(v: unknown): v is RegistryVerified & { evidence: string; via: string } {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const nonEmpty = (x: unknown): boolean => typeof x === "string" && x.trim().length > 0;
  return nonEmpty(r.since) && nonEmpty(r.evidence) && nonEmpty(r.via);
}

// ── THE ROUND-TRIP MEASUREMENT SEAM (capabilities/roundtrip.json) ────────────
//
// WHAT THIS IS. A receipt shape is a claim that a round trip happened. Nothing
// that `isCompleteVerifiedRecord` can see PROVES it: `verified.evidence` is
// free text ("proof PASS 13965"), and no code parses that. So until this seam
// existed, `/registry` published `status: "verified"` for 7 packages on the
// strength of prose alone, and a reader could not tell a measured round trip
// from a sentence asserting one.
//
// THE DESIGN'S OWN CLAIM WAS WRONG ABOUT ITS OWN SEAM, and this is the
// correction. The design named `honestPackageStatus` (the function above) as the
// place to enforce the measurement. Measured against the tree: it cannot work
// there. Its degrade branch fires only when a package DECLARES
// `status: "verified"`, and all 7 packages carrying a complete receipt declare
// `status: "active"` instead — so that branch has never fired for a single
// shipped package. The status a consumer actually reads is minted by
// `packageStatusOf` below, which is also what `chatSurfaceStatus` and
// `buildRegistryPackages` call, so THAT is where the measurement is consulted.
// Enforcing it in `honestPackageStatus` would have been a gate that could not
// fire — precisely the defect class this seam exists to kill.
//
// THE DIRECTION, which is the whole honesty argument and is not symmetric:
//
//   MEASUREMENT WINS.  A measured row that disagrees with the receipt degrades
//   the claim to the word this module already uses for "not earned"
//   (`unverified-candidate`).
//   A MEASUREMENT MAY NEVER PROMOTE.  No row, and no combination of rows, can
//   raise a package that lacks a receipt to `verified`. Promotion is the
//   author's judgement; only demotion is mechanical.
//
// AND THE HONEST CONSEQUENCE, stated here because it is a visible behaviour
// change and not a silent one: with the record as shipped, 7 packages hold a
// receipt and NO measured row, so all 7 now publish `unverified-candidate`
// rather than `verified`. That is not the seam inventing a negative result —
// `unverified-candidate` says exactly what is true, which is "not measured".
// Claiming otherwise from an absent measurement would be a fabricated positive,
// which is the one thing this repo forbids outright. Consumers that branch on
// `status` keep working: the word is the existing one, and surfacing is
// unaffected (`chatSurfaceStatus` already returned `unverified-candidate` for
// every id-less/scaffold package).

/** One row of the published round-trip record, as read. */
export interface RoundTripRow {
  site?: unknown;
  capability?: unknown;
  class?: unknown;
  provenance?: unknown;
  measuredAt?: unknown;
  httpStatus?: unknown;
  answerChars?: unknown;
  probeNonceMatched?: unknown;
  doneReason?: unknown;
  poolAtRequest?: unknown;
  daemonCommit?: unknown;
  /** `result.ok` — the runner's own verdict. `null` on a chat row. */
  capabilityOk?: unknown;
  /** The SHAPE of the returned capability result (never its content). */
  resultShape?: unknown;
}

/** Repo-relative location of the round-trip record, walked up like
 *  `modelVerificationPath` so a built `dist/` copy still resolves. */
function roundTripRecordPath(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const up of [2, 3]) {
    let p = here;
    for (let i = 0; i < up; i++) p = dirname(p);
    const candidate = resolve(p, "capabilities", "roundtrip.json");
    if (existsSync(candidate)) return candidate;
  }
  return resolve(process.cwd(), "capabilities", "roundtrip.json");
}

const ROUNDTRIP_SCHEMA = "ui2api/roundtrip/1";

export interface RoundTripReading {
  /** A NAMED failure instead of an empty measurement, so an unreadable record
   *  can never read as "nothing measured, therefore degrade" — which would be
   *  a fabricated negative. */
  refusal: string | null;
  schema: string | null;
  stalenessWindowDays: number;
  rows: RoundTripRow[];
}

/** Pure fs read of the published round-trip record. Never throws: every failure
 *  becomes a NAMED `refusal`, mirroring `readModelVerification` above, because a
 *  record that cannot be read must be VISIBLE rather than silently treated as an
 *  absence of measurement. */
export function readRoundTripRecord(): RoundTripReading {
  const abs = roundTripRecordPath();
  const base: RoundTripReading = { refusal: null, schema: null, stalenessWindowDays: 30, rows: [] };
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (e) {
    return {
      ...base,
      refusal: `round-trip record unreadable at capabilities/roundtrip.json (${(e as Error).message}) — status falls back to the receipt alone and the gate reports the record as MISSING`,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return {
      ...base,
      refusal: `round-trip record at capabilities/roundtrip.json is not parseable JSON (${(e as Error).message}) — status falls back to the receipt alone and the gate reports the record as UNPARSEABLE`,
    };
  }
  if (parsed.schema !== ROUNDTRIP_SCHEMA) {
    return {
      ...base,
      refusal: `round-trip record declares schema ${JSON.stringify(parsed.schema)}, expected ${JSON.stringify(ROUNDTRIP_SCHEMA)} — status falls back to the receipt alone`,
    };
  }
  const win = parsed.stalenessWindowDays;
  const rows = Array.isArray(parsed.rows) ? (parsed.rows as RoundTripRow[]) : [];
  return {
    refusal: null,
    schema: ROUNDTRIP_SCHEMA,
    stalenessWindowDays: typeof win === "number" && Number.isFinite(win) && win > 0 ? win : 30,
    rows,
  };
}

/**
 * THE PREDICATE: does a MEASURED row exist for `siteId`?
 *
 * "MEASURED" is deliberately narrow, and every clause is load-bearing. It has
 * TWO ARMS, because a round trip has two shapes — and admitting only the first
 * was the defect this second arm exists to close:
 *
 * A CHAT surface is proven by a NONCE. A warm daemon pool reuses pages, so text
 * left on the page by an earlier prompt reads back as this prompt's answer.
 * Only a nonce generated per measurement and echoed by the model proves the
 * served text is THIS request's. So the chat arm requires `probeNonceMatched ===
 * true` AND `class === "ANSWERS"` AND a 2xx AND `answerChars > 0` AND
 * `doneReason === "stable"`.
 *
 * A CAPABILITY surface returns JSON, not an answer, so a nonce proves nothing
 * there — and MEASURED, every capability surface therefore derived
 * `UNCLASSIFIED`, which is not a class, so `scripts/audit/record-trip.mjs`
 * refused to write the row at all and NO capability package could ever be
 * recorded as measured. The capability arm is proven by the returned result's
 * SHAPE instead: `class === "RETURNS-DATA"` AND a 2xx AND the runner's own
 * `ok === true` AND a well-formed `resultShape` whose DECLARED count and
 * COUNTED rows agree at `>= 1`. The agreement is what keeps the arm honest —
 * the declared half alone is a claim, the counted half alone is a shape, and
 * requiring both is what stops a row from being filed on one of them.
 *
 * Both arms require `provenance === "harness"`. A row converted from prose
 * (`method: "imported-from-prose"`, `probeNonceMatched: null`) is a real
 * measurement of SOMETHING, and it is kept in the record so the history is not
 * lost — but it backs nothing, because its text cannot be attributed to the
 * request that fetched it. And both require `measuredAt` inside the staleness
 * window: a month-old measurement of a working site is not evidence about
 * today's site, and CI can never re-measure (no session, no Chrome owner), so
 * the window is the only thing standing between this record and a permanent lie.
 */
/**
 * The verdict on a site's round trip. TWO absences are not one thing, and this
 * is the type that says so.
 *
 * `measured` — a round trip that WORKED. It backs a `verified` claim.
 *
 * `contradicted` — a round trip that was PERFORMED and did not work: a harness
 * row exists, inside the staleness window, whose DERIVED class is one of the
 * named failure classes. This is not `measured`, and it is emphatically not the
 * same thing as having no row at all.
 *
 * WHY THAT DISTINCTION IS A CORRECTNESS REQUIREMENT AND NOT A NICETY. A refused
 * measurement is a hole in the evidence, not evidence of absence. Before this
 * verdict existed, `measuredRoundTripFor` had exactly one negative answer, so a
 * site whose freshest measurement was an honest, named, diagnosable failure read
 * identically to a site nobody ever asked — and the gate reported "no measured
 * row", which UNDERSTATES what is known. MEASURED on this record: `kimi` and
 * `tencent-aistudio` carry `UNATTRIBUTED-NO-ANSWER` rows and `deepseek` an
 * `UNATTRIBUTED-NO-COMPOSER` one, all refused by the write seam before their
 * classes existed; every one of them was being published as "not measured".
 *
 * THE DIRECTION IS UNCHANGED AND ASYMMETRIC: a contradiction may only ever
 * DEMOTE. `packageStatusOf` mints `unverified-candidate` for both negatives,
 * because both fail to earn `verified`; what this type adds is the ability to
 * say WHICH negative it was, so the gate can require that a contradicted site
 * is not published as `verified` instead of merely noticing it is unmeasured.
 */
export interface RoundTripVerdict {
  measured: boolean;
  contradicted: boolean;
  /** The DERIVED failure class behind a `contradicted` verdict, else null. */
  failureClass: string | null;
  /**
   * A round trip that was PERFORMED, delivered nothing, and did NOT falsify a
   * published claim — the third reading, and the reason this type has three
   * negatives' worth of vocabulary instead of two.
   *
   * MEASURED, the case: `youtube_transcript` answers HTTP 502 with the runner's
   * own `no-transcript-button:` refusal on a page that offers no transcript
   * control for the requested video. That sentence LISTS its two candidate causes
   * (this video has no captions, or this repo's selector has gone stale) and
   * asserts NEITHER, so the row establishes a non-delivery for ONE ARGUMENT and
   * nothing about the surface. Filing it as `contradicted` would assert a
   * surface-wide failure from a single target-scoped observation; filing it as
   * "no row at all" would throw away a real measurement. It is neither.
   *
   * WHICH ROWS LAND HERE is not a second opinion about the class: it is the
   * class's own answer, derived by importing `falsifiesClaim` from the
   * classifier rather than restated here, so the writer and this reader cannot
   * disagree about which failures demote.
   *
   * IT STILL NEVER PROMOTES. A qualifying row earns no `verified` claim —
   * `measured` stays false — it only declines to DEMOTE.
   */
  qualified: boolean;
  /** The DERIVED class behind a `qualified` verdict, else null. */
  qualifiedClass: string | null;
  /**
   * A NAMED CAPABILITY LIMITATION on an otherwise-healthy site: the surface
   * measured, and one of its capabilities did not deliver. This is NOT a fourth
   * overall verdict — `measured` is still `true` and the site still earns its
   * claim, because a claim is about the surface. What it stops is the site
   * verdict being the ONLY resolution available, which is what made
   * `youtube` read healthy with no word anywhere about its 502-ing
   * `youtube_transcript`: the healthy sibling answered first and the failing
   * row was never looked at.
   *
   * `null` whenever the site is not measured (a contradiction already demotes,
   * and a site with no measured surface has no healthy claim to qualify), and
   * `null` when every capability measured. Its `class` is the DERIVED class, so
   * a consumer can branch on the failure's own vocabulary instead of parsing
   * prose.
   */
  limitation: CapabilityLimitation | null;
  reason: string;
  /**
   * THE PER-CAPABILITY RESOLUTION this site verdict is FOLDED from — one entry
   * per capability the record says something about, each read at its own level.
   *
   * WHY IT EXISTS. The site verdict was per-SITE: `youtube_search` returns 10
   * real rows and `youtube_transcript` answers HTTP 502, and the site-level
   * answer was simply `measured: true` — the 502 was discarded by a resolver
   * that never asked the capability question. That is a checker whose
   * resolution cannot express the thing it is asked to check: the vocabulary
   * gained `UNATTRIBUTED-NO-TRANSCRIPT` precisely so this honest outcome could
   * be RECORDED, and then the read seam threw the record away. A measurement
   * nobody can act on is the same defect as a measurement never taken.
   *
   * IT IS THE FOLD, NOT A REPLACEMENT. `measuredRoundTripFor` still returns the
   * same three readings with the same meanings, and it derives them FROM this
   * array — one classification, read twice, so the site answer and the
   * capability answers cannot disagree.
   */
  capabilities: CapabilityRoundTrip[];
}

/** One capability's own reading of the record. */
export interface CapabilityRoundTrip {
  /** The record's `capability` value, or `(unnamed)` for a row that carries none. */
  capability: string;
  /**
   * `measured` — this capability's round trip worked.
   * `contradicted` — it was performed and the DERIVED class falsifies a claim.
   * `qualified` — it was performed and the non-delivery is argument-scoped.
   * `unmeasured` — a row exists for it and none of the above derived.
   */
  reading: "measured" | "contradicted" | "qualified" | "unmeasured";
  /** The DERIVED class of the newest in-window row, else null. */
  class: string | null;
  reason: string;
}

/** The named limitation a healthy site carries, quoted for a consumer. */
export interface CapabilityLimitation {
  capability: string;
  /** The DERIVED class — the branch a consumer keys on, not prose. */
  class: string;
  reading: "contradicted" | "qualified";
  reason: string;
}

/** The classes that mean "the round trip worked". Everything else in the closed
 *  set is a MEASURED FAILURE except `UNMEASURED`, which asserts nothing at all —
 *  it is the row that says "never reached", so it can neither back nor
 *  contradict a claim. Derived from the vocabulary rather than re-listed, so a
 *  member added later cannot be silently unreadable here. */
const ROUNDTRIP_SUCCESS_CLASSES: ReadonlySet<string> = new Set(["ANSWERS", "RETURNS-DATA"]);

export function measuredRoundTripFor(siteId: string, now: number = Date.now()): RoundTripVerdict {
  return resolveRoundTripVerdict(readRoundTripRecord(), siteId, now);
}

/**
 * THE PURE RESOLVER — the whole verdict, over an INJECTED record.
 *
 * WHY THE SEAM EXISTS. Every honest statement about this resolver is about what
 * it does to a set of rows, so it must be askable about a set of rows that is
 * not the one on disk. Reading the record inside the resolver meant the only way
 * to ask "what happens when a capability-level contradiction lands on an
 * otherwise-healthy site?" was to EDIT `capabilities/roundtrip.json` — and that
 * file is written only by the harness, so the question had no answer that did not
 * involve hand-editing a measurement. A checker whose shape makes its own
 * central question unaskable is the defect class, not the fixture.
 *
 * The fs read is one line in `measuredRoundTripFor` and everything else is here,
 * so there is exactly one implementation and no path that can bypass it.
 */
export function resolveRoundTripVerdict(rec: RoundTripReading, siteId: string, now: number = Date.now()): RoundTripVerdict {
  if (rec.refusal) {
    return {
      measured: false,
      contradicted: false,
      failureClass: null,
      qualified: false,
      qualifiedClass: null,
      limitation: null,
      capabilities: [],
      reason: rec.refusal,
    };
  }
  const mine = rec.rows.filter((r) => typeof r.site === "string" && r.site === siteId);
  if (mine.length === 0) {
    return {
      measured: false,
      contradicted: false,
      failureClass: null,
      qualified: false,
      qualifiedClass: null,
      limitation: null,
      capabilities: [],
      reason: `no row in capabilities/roundtrip.json for "${siteId}"`,
    };
  }
  const settled = (r: (typeof mine)[number]): boolean => {
    if (r.provenance !== "harness") return false;
    const st = typeof r.httpStatus === "number" ? r.httpStatus : 0;
    if (st < 200 || st >= 300) return false;
    if (typeof r.measuredAt !== "string") return false;
    const age = (now - Date.parse(r.measuredAt)) / 86_400_000;
    if (!(Number.isFinite(age) && age >= 0 && age <= rec.stalenessWindowDays)) return false;
    if (r.class === "ANSWERS") {
      if (r.probeNonceMatched !== true) return false;
      if (typeof r.answerChars !== "number" || r.answerChars <= 0) return false;
      if (r.doneReason !== "stable") return false;
      return true;
    }
    if (r.class === "RETURNS-DATA") {
      // The SAME derivation the classifier ran, imported rather than restated:
      // two copies of this predicate is how the write seam and the read seam end
      // up disagreeing about what counts as measured.
      return capabilityDataEvidence({
        httpStatus: st,
        capabilityOk: r.capabilityOk,
        resultShape: (r.resultShape ?? null) as { topLevelKeys?: unknown; rowsPath?: unknown; count?: unknown; rows?: unknown } | null,
      }) !== null;
    }
    return false;
  };

  // A row counts only from HARNESS provenance, inside the staleness window.
  // `falsifiesClaim` is IMPORTED, not restated: which named failures demote is
  // the CLASSIFIER's answer about its own members, and a second copy of that
  // rule here is how the writer and this reader end up disagreeing about whether
  // a recorded refusal is a surface failure or a scoped one. Both are row-level
  // and both are capability-blind by DESIGN — see the fold below for why the
  // scope of a non-delivery is a property of its CLASS and not of which surface
  // kind it arrived on.
  const inWindow = (r: (typeof mine)[number]): boolean => {
    if (r.provenance !== "harness") return false;
    if (typeof r.measuredAt !== "string") return false;
    const age = (now - Date.parse(r.measuredAt)) / 86_400_000;
    return Number.isFinite(age) && age >= 0 && age <= rec.stalenessWindowDays;
  };
  const namedFailure = (r: (typeof mine)[number], wantFalsifying: boolean): boolean => {
    const cls = typeof r.class === "string" ? r.class : "";
    if (!VERIFICATION_CLASSES.includes(cls as (typeof VERIFICATION_CLASSES)[number])) return false;
    if (ROUNDTRIP_SUCCESS_CLASSES.has(cls)) return false;
    if (falsifiesClaim(cls) !== wantFalsifying) return false;
    return inWindow(r);
  };
  const newestOf = (rows: RoundTripRow[]): RoundTripRow =>
    rows.slice().sort((a, b) => String(b.measuredAt).localeCompare(String(a.measuredAt)))[0]!;

  // ── THE PER-CAPABILITY CLASSIFICATION ──────────────────────────────────────
  // Each capability is read at ITS OWN level, first, and the site verdict is
  // folded from the result.
  //
  // THE ORDER INSIDE ONE CAPABILITY IS CONTRADICTION FIRST, and that is not a
  // cosmetic reshuffle: it is the SAME rule the fold below applies, at the level
  // it applies. The pre-existing order was settled-then-contradicted, which was
  // correct only while the whole verdict was per-site — one site, one question.
  // Per capability it is the "healthy sibling answers first" defect restated one
  // rung down: a site that probed `araprat_trending` twice, once returning rows
  // and once answering 502 `UNATTRIBUTED-NO-COMPOSER`, would have reported that
  // capability as `measured` because a good row existed somewhere in its
  // history. MEASURED, that is exactly what happened when this pin was first
  // written: the array said `araprat_trending=measured` while a contradicting
  // row sat in the same capability's rows, unconsulted.
  //
  // WHY ONE LEVEL OF `contradicted` STILL BEATS ANOTHER'S `measured` AT THE
  // FOLD: a demotion is a statement about the PACKAGE, not about the row that
  // produced it. So the fold asks the question at package scope and the
  // classification asks it at capability scope, and neither needs to know what
  // the other one decided.
  const byCapability = new Map<string, (typeof mine)[number][]>();
  for (const r of mine) {
    const key = typeof r.capability === "string" && r.capability ? r.capability : "(unnamed)";
    const list = byCapability.get(key);
    if (list) list.push(r);
    else byCapability.set(key, [r]);
  }
  const capabilities: CapabilityRoundTrip[] = [];
  for (const key of [...byCapability.keys()].sort()) {
    const rows = byCapability.get(key)!;
    // A MEASURED ROUND TRIP THAT DID NOT WORK — the class was DERIVED by the
    // writer, and test/round-trip-record-truth.test.ts re-derives it from the
    // row's own machine fields, so a hand-typed class cannot buy this state any
    // more than it can buy `measured`.
    //
    // `falsifiesClaim` is IMPORTED, not restated: which named failures demote is
    // the CLASSIFIER's answer about its own members, and a second copy of that
    // rule here is how the writer and this reader end up disagreeing about
    // whether a recorded refusal is a surface failure or a scoped one.
    const failed = rows.filter((r) => namedFailure(r, true));
    if (failed.length > 0) {
      const top = newestOf(failed);
      capabilities.push({
        capability: key,
        reading: "contradicted",
        class: typeof top.class === "string" ? top.class : null,
        reason:
          `MEASURED AND FAILED — capabilities/roundtrip.json carries ${failed.length} row(s) for "${siteId}/${key}" whose DERIVED class is a named FAILURE, ` +
          `the newest being ${String(top.capability)} class=${String(top.class)} httpStatus=${String(top.httpStatus)} ` +
          `answerChars=${String(top.answerChars)} probeNonceMatched=${String(top.probeNonceMatched)} measuredAt=${String(top.measuredAt)} ` +
          `(inside the ${rec.stalenessWindowDays}-day window). The round trip was PERFORMED and the surface DID NOT WORK, which CONTRADICTS a ` +
          `published \`verified\` claim rather than qualifying it. It establishes NO cause — read the class's own evidence for what the service ` +
          `refused to attribute.`,
      });
      continue;
    }
    const good = rows.filter(settled);
    if (good.length > 0) {
      const first = good[0]!;
      const shape =
        first.class === "RETURNS-DATA"
          ? capabilityDataEvidence({
              httpStatus: Number(first.httpStatus),
              capabilityOk: first.capabilityOk,
              resultShape: (first.resultShape ?? null) as { topLevelKeys?: unknown; rowsPath?: unknown; count?: unknown; rows?: unknown } | null,
            })
          : null;
      capabilities.push({
        capability: key,
        reading: "measured",
        class: typeof first.class === "string" ? first.class : null,
        reason:
          first.class === "RETURNS-DATA" && shape
            ? `capabilities/roundtrip.json carries ${good.length} MEASURED row(s) for "${siteId}/${key}" — the capability ${String(first.capability)} returned ${shape.rows} record(s) at ${shape.rowsPath} (runner ok=true, declared count ${shape.count} = counted rows, HTTP ${first.httpStatus}, inside the ${rec.stalenessWindowDays}-day window)`
            : `capabilities/roundtrip.json carries ${good.length} MEASURED row(s) for "${siteId}/${key}" (nonce matched, ANSWERS, ${first.httpStatus}, doneReason=stable, inside the ${rec.stalenessWindowDays}-day window)`,
      });
      continue;
    }
    // A MEASURED ROUND TRIP THAT DELIVERED NOTHING FOR ONE ARGUMENT. Reached
    // only after the contradicting branch declined, so a capability with a real
    // surface-wide failure never hides an argument-scoped one behind it.
    //
    // WHY IT IS ITS OWN READING RATHER THAN "no row": the row exists, the round
    // trip was performed, and the refusal is quotable from it. Reporting it as
    // unmeasured throws away real evidence; reporting it as CONTRADICTED asserts
    // a surface-wide failure from an observation scoped to one `videoId`. What
    // the read seam may then say is "this argument did not deliver", and it
    // still may not say "this capability works".
    const qualifying = rows.filter((r) => namedFailure(r, false));
    if (qualifying.length > 0) {
      const top = newestOf(qualifying);
      capabilities.push({
        capability: key,
        reading: "qualified",
        class: typeof top.class === "string" ? top.class : null,
        reason:
          `MEASURED, DID NOT DELIVER, AND QUALIFIES — capabilities/roundtrip.json carries ${qualifying.length} row(s) for "${siteId}/${key}" whose ` +
          `DERIVED class is an ARGUMENT-SCOPED non-delivery, the newest being ${String(top.capability)} class=${String(top.class)} ` +
          `httpStatus=${String(top.httpStatus)} measuredAt=${String(top.measuredAt)} (inside the ${rec.stalenessWindowDays}-day window). The round trip ` +
          `was PERFORMED and the surface delivered nothing for the argument this row was given; the row is kept because the refusal is quotable ` +
          `and inspectable. It does NOT CONTRADICT a published \`verified\` claim, because a claim is about the surface and this observation is ` +
          `about one argument — and it establishes NO cause: read the class's own evidence for the candidates the service refused to choose ` +
          `between. It also does NOT PROMOTE: this capability is still not measured, so it earns no verified claim.`,
      });
      continue;
    }
    capabilities.push({
      capability: key,
      reading: "unmeasured",
      class: null,
      reason: rows
        .map((r) =>
          r.provenance !== "harness"
            ? `provenance=${String(r.provenance)} (imported from prose — backs nothing)`
            : `${String(r.capability)}: probeNonceMatched=${String(r.probeNonceMatched)} class=${String(r.class)} httpStatus=${String(r.httpStatus)} answerChars=${String(r.answerChars)} doneReason=${String(r.doneReason)} capabilityOk=${String(r.capabilityOk)}`,
        )
        .join("; "),
    });
  }

  const at = (reading: CapabilityRoundTrip["reading"]): CapabilityRoundTrip[] =>
    capabilities.filter((c) => c.reading === reading);

  // ── THE FOLD: the site verdict is DERIVED from the capability readings ─────
  //
  // CONTRADICTION DOMINATES, AND THAT IS THE ANSWER TO "can a capability-level
  // failure contradict a site?". YES — and it must, for a reason that is not
  // symmetry for its own sake: whether a non-delivery is a statement about the
  // SURFACE is a property of its CLASS, and the classifier already owns that
  // answer (`falsifiesClaim`, imported above, never restated). A row whose class
  // says "this surface did not work" says it whether it came from the chat
  // endpoint or from `youtube_search`. Restricting demotion to chat rows would
  // restate the per-site collapse this lane exists to remove, one rung down: the
  // surface KIND would become the gate, and a package whose only working
  // capability was a chat one would keep a `verified` claim its own transcript
  // row had already falsified.
  //
  // AND THE OPPOSITE IS NOT FORGOTTEN, it is the whole reason `limitation`
  // exists. `UNATTRIBUTED-NO-TRANSCRIPT` was deliberately chosen to QUALIFY,
  // because the refusal was scoped to ONE `videoId` while the claim is about the
  // surface — and that reasoning is untouched, because it lives in the class
  // rather than in the surface kind. So the two decisions stay orthogonal:
  // `falsifiesClaim` decides WHETHER a non-delivery demotes, and the
  // per-capability array decides WHERE it is reported. A qualifying capability
  // can therefore never demote the site (it becomes a named limitation), and a
  // contradicting one always does.
  //
  // DEMOTE-ONLY IS UNCHANGED AND ASYMMETRIC. A contradiction or a limitation may
  // only ever take a claim away; `packageStatusOf` mints `unverified-candidate`
  // for every negative, and nothing here can raise a package to `verified`.
  const failedCaps = at("contradicted");
  if (failedCaps.length > 0) {
    const top = failedCaps.slice().sort((a, b) => String(b.class).localeCompare(String(a.class)))[0]!;
    const newestFailure = failedCaps[0]!;
    return {
      measured: false,
      contradicted: true,
      failureClass: top.class,
      qualified: false,
      qualifiedClass: null,
      limitation: null,
      capabilities,
      reason:
        `MEASURED AND FAILED — capabilities/roundtrip.json carries ${failedCaps.length} capability/capabilities for "${siteId}" whose DERIVED class is a named FAILURE, ` +
        `the newest being ${newestFailure.capability} class=${String(newestFailure.class)} — ${newestFailure.reason.split(". ")[1] ?? newestFailure.reason} ` +
        `(inside the ${rec.stalenessWindowDays}-day window). This is NOT the same as never having measured: the round trip was performed and the surface ` +
        `DID NOT WORK, which CONTRADICTS a published \`verified\` claim rather than qualifying it. It establishes NO cause — read the class's own ` +
        `evidence for what the service refused to attribute — and it may only ever DEMOTE, never promote.`,
    };
  }

  const settledCaps = at("measured");
  if (settledCaps.length > 0) {
    // HEALTHY, WITH A NAMED CAPABILITY LIMITATION. The third state of a
    // measured site, and the one the per-site collapse made unexpressible:
    // `measured` stays true (the claim is about the surface and the surface
    // answered), while the capability that did not deliver is named, with the
    // DERIVED class a consumer branches on. Measured, the case: `youtube`
    // searched 10 real rows AND `youtube_transcript` answered HTTP 502
    // `UNATTRIBUTED-NO-TRANSCRIPT`, and the site answer was `measured: true`
    // with the 502 never read.
    const limited = at("qualified");
    const limitation: CapabilityLimitation | null =
      limited.length > 0
        ? {
            capability: limited[0]!.capability,
            class: String(limited[0]!.class),
            reading: "qualified",
            reason: limited[0]!.reason,
          }
        : null;
    return {
      measured: true,
      contradicted: false,
      failureClass: null,
      qualified: false,
      qualifiedClass: null,
      limitation,
      capabilities,
      reason:
        `${settledCaps[0]!.reason}` +
        (limitation
          ? ` — but this site is NOT uniformly healthy: ${limited.length} of its capability/capabilities measured a NON-DELIVERY (${limited
              .map((c) => `${c.capability} class=${String(c.class)}`)
              .join(", ")}), which QUALIFIES rather than contradicts: a published \`verified\` claim is about the surface and this observation ` +
              `is about one argument, so the claim stands while the limitation is reported. It is a demote-only signal: it can take a claim away ` +
              `and can never add one. See \`capabilities\` for the per-capability resolution.`
          : ` — and every capability the record measures for this site measured OK, so there is no limitation to report.`),
    };
  }

  // A site with NO measured surface. The same two negatives as before, read
  // from the same per-capability classification: a contradiction was already
  // returned above, so what is left is the argument-scoped reading, which
  // neither proves the surface works nor was ever absent.
  const qualifiedCaps = at("qualified");
  if (qualifiedCaps.length > 0) {
    const top = qualifiedCaps[0]!;
    return {
      measured: false,
      contradicted: false,
      failureClass: null,
      qualified: true,
      qualifiedClass: top.class,
      limitation: null,
      capabilities,
      reason:
        `MEASURED, DID NOT DELIVER, AND QUALIFIES — capabilities/roundtrip.json carries ${qualifiedCaps.length} capability/capabilities for "${siteId}" whose ` +
        `DERIVED class is an ARGUMENT-SCOPED non-delivery, the newest being ${top.capability} class=${String(top.class)}. It does NOT CONTRADICT a published ` +
        `\`verified\` claim, because a claim is about the surface and this observation is about one argument — and it establishes NO cause. ` +
        `It also does NOT PROMOTE: this site is still not measured, so it earns no verified claim.`,
    };
  }

  const why = capabilities.map((c) => `${c.capability}: ${c.reason}`).join("; ");
  return {
    measured: false,
    contradicted: false,
    failureClass: null,
    qualified: false,
    qualifiedClass: null,
    limitation: null,
    capabilities,
    reason: `rows exist for "${siteId}" but none is MEASURED: ${why}`,
  };
}

/**
 * The ONE status resolver: a package's declared `metadata.json` status, gated on
 * the verification record that has to back an earned classification.
 *
 * Returned as a pair because they are one fact: `status: "verified"` is the
 * claim and `verified: {...}` is the receipt. Deriving them in one place is what
 * stops the two from disagreeing — which is exactly the defect this replaces.
 */
export function honestPackageStatus(meta: unknown): { status: string; verified: RegistryVerified | false } {
  const m = (meta && typeof meta === "object" ? meta : {}) as Metadata;
  const declared = typeof m.status === "string" && m.status.trim() ? m.status.trim() : "unknown";
  const record = isCompleteVerifiedRecord(m.verified)
    ? { since: m.verified.since, ...consumerVerifiedRecord(m.verified) }
    : false;
  // An earned claim with no receipt behind it is not published as earned. The
  // word it degrades to is the one this module already uses for that state, so
  // a consumer branching on `status` sees the same word everywhere it can.
  const status = declared === EARNED_STATUS && record === false ? UNEARNED_STATUS : declared;
  return { status, verified: record };
}

interface ManifestCapability {
  id: string;
  name?: string;
  description?: string;
  method?: string;
  /**
   * GOAL 139: the DECLARED arg contract — the real fix for the app authoring the
   * registry's own metadata. Measured: 0 of 33 packages declared one, so
   * `capabilityInputSchema` had to GUESS from the capability id, and it guessed
   * wrong (youtube_search advertised `{}` while its runner requires `args.query`;
   * it advertised `new_chat` which no runner reads — they read `newChat`).
   *
   * The arg names live in the RUNNER, so a guess can never be right by
   * construction. Declaring them here puts the contract in the PACKAGE — which
   * is the registry — so the app only READS it, and a consumer (a skill, a doc,
   * a generated client) reads the same single source. `test/registry-args-truth`
   * then fails LOUD when a declaration drifts from what the runner reads, so the
   * manifest cannot quietly become a lie.
   */
  inputSchema?: unknown;
  args?: unknown;
}

interface Manifest {
  id: string;
  name?: string;
  url?: string;
  description?: string;
  version?: string;
  site?: string;
  auth?: { required?: boolean };
  capabilities?: ManifestCapability[];
}

/** Locate the capabilities/ package dir for a site (same source resolvePackagedProfile uses). */
export function findPackageDir(siteId: string): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const up of [2, 3]) {
    let p = here;
    for (let i = 0; i < up; i++) p = dirname(p);
    for (const root of [resolve(p, "capabilities", siteId), resolve(p, "src", "capabilities", siteId)]) {
      if (existsSync(resolve(root, "manifest.json"))) return root;
    }
  }
  return null;
}

/** List installed package site ids (capabilities/<id>/manifest.json on disk). */
export function listInstalledPackageIds(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const up of [2, 3]) {
    let p = here;
    for (let i = 0; i < up; i++) p = dirname(p);
    for (const root of [resolve(p, "capabilities"), resolve(p, "src", "capabilities")]) {
      if (!existsSync(root)) continue;
      try {
        const ids = readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(resolve(root, d.name, "manifest.json")))
          .map((d) => d.name);
        if (ids.length > 0) return ids;
      } catch {
        // fall through to next candidate root
      }
    }
  }
  return [];
}

/** Strip a leading "<site>_" (or "<site-with-underscores>_") prefix from a capability id. */
export function bareCapabilityId(siteId: string, capabilityId: string): string {
  const hyphenPrefixed = `${siteId}_`;
  if (capabilityId.startsWith(hyphenPrefixed)) return capabilityId.slice(hyphenPrefixed.length);
  const underscorePrefixed = `${siteId.replace(/-/g, "_")}_`;
  if (capabilityId.startsWith(underscorePrefixed)) return capabilityId.slice(underscorePrefixed.length);
  return capabilityId;
}

/**
 * GOAL 139: a DECLARED arg contract, validated before any consumer can see it.
 *
 * A malformed declaration must be REFUSED, never served: an empty-but-present
 * schema is worse than none, because a consumer trusts it. Mirrors the GOAL 61
 * per-entry filter (a bad capability is excluded, it does not poison the list).
 * Returns null when absent or wrong-shaped, so the caller falls back honestly.
 */
export function declaredCapabilityInputSchema(
  c: ManifestCapability
): RegistryToolInputSchema | null {
  const raw = c.inputSchema ?? c.args;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as { type?: unknown; properties?: unknown; required?: unknown; anyOf?: unknown };
  if (o.type !== "object") return null;
  if (typeof o.properties !== "object" || o.properties === null || Array.isArray(o.properties)) {
    return null;
  }
  // Every property must itself be a {type} object — an untyped property is
  // exactly the kind of half-declaration that misleads a consumer.
  for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
    if (k.trim() === "") return null;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    if (typeof (v as { type?: unknown }).type !== "string") return null;
  }
  const required = Array.isArray(o.required)
    ? o.required.filter((r): r is string => typeof r === "string" && r.trim() !== "")
    : [];
  // A required key that is not a declared property is a self-contradiction.
  const propNames = new Set(Object.keys(o.properties as Record<string, unknown>));
  if (required.some((r) => !propNames.has(r))) return null;
  // anyOf ("at least one of") must be well-formed for the same reason: each
  // branch needs a non-empty `required` naming only declared properties.
  let anyOf: RegistryToolInputSchema["anyOf"];
  if (o.anyOf !== undefined) {
    if (!Array.isArray(o.anyOf) || o.anyOf.length === 0) return null;
    const branches: { required: string[]; description?: string }[] = [];
    for (const raw of o.anyOf as unknown[]) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
      const b = raw as { required?: unknown; description?: unknown };
      if (!Array.isArray(b.required)) return null;
      const names = b.required.filter((r): r is string => typeof r === "string" && r.trim() !== "");
      if (names.length === 0) return null;
      if (names.some((r) => !propNames.has(r))) return null;
      branches.push({
        required: names,
        ...(typeof b.description === "string" ? { description: b.description } : {}),
      });
    }
    anyOf = branches;
  }
  return {
    type: "object",
    properties: o.properties as RegistryToolInputSchema["properties"],
    required,
    ...(anyOf ? { anyOf } : {}),
  };
}

/**
 * Derive an MCP-tool-shaped input schema for a capability from its manifest entry.
 *
 * A DECLARED contract wins outright. The regex branches below are now an
 * explicitly-labelled LAST RESORT for a package that has not declared one yet —
 * they are a guess, they have been measurably wrong, and `argsDeclared:false`
 * on the served tool tells every consumer not to trust them.
 */
export function capabilityInputSchema(
  siteId: string,
  capabilityId: string,
  _method: string | undefined,
  description: string | undefined,
  declared?: RegistryToolInputSchema | null
): RegistryToolInputSchema {
  if (declared) return declared;
  const bare = bareCapabilityId(siteId, capabilityId);
  // Chat capabilities carry the composer args.
  if (/_chat$/.test(capabilityId) || bare === "chat") {
    const properties: RegistryTool["inputSchema"]["properties"] = {
      prompt: { type: "string", description: "The prompt to send on the site's own composer" },
      // GOAL 139: the runners read camelCase `newChat` (gemini.ts:259,
      // kimi.ts:215). The old `new_chat` was read by NOTHING, so a consumer
      // following the schema sent it and silently continued the old
      // conversation instead of starting a new one — a wrong answer, not an
      // error. The name now matches the code that actually reads it.
      newChat: { type: "boolean", description: "Start a fresh conversation first (default false)" },
    };
    const required = ["prompt"];
    // Site-specific rendered toggles named in the manifest description surface as
    // extra boolean args so a single chat tool can flip them inline. GUESS ONLY:
    // these are keyed on description prose, and no runner reads them yet, so they
    // are deliberately NOT emitted (a schema property nothing implements is a
    // lie a consumer can act on). Declared args are the way to add one.
    void description;
    return { type: "object", properties, required };
  }
  // Toggle capabilities ("reasoner", "web_search", ...) — flip a real UI toggle.
  if (/reasoner|web_search|\bsearch\b|toggle|_state$/i.test(capabilityId)) {
    return {
      type: "object",
      properties: {
        state: { type: "boolean", description: "Desired toggle state" },
      },
      required: [],
    };
  }
  // Pure-read capabilities (list_conversations, model_list, ...) take hints only.
  if (/list_conversations|model_list|history/.test(capabilityId)) {
    return {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of entries to return" },
        account: { type: "string", description: "Identity key of a stored account for this site (optional)" },
      },
      required: [],
    };
  }
  // Everything else: method-driven, no declared args.
  return { type: "object", properties: {}, required: [] };
}

/** Resolve the daemon's data dir the same way promptd/pool do (env → "data"). */
export function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

// ─────────────────────────────────────────────────────────────────────────────
// THE REMEDIATION-ADVICE DERIVATION — what a human is TOLD to run
//
// WHAT THIS IS. Every gate in this repo may report a gap, and the gap message is
// the ONE part of a gate anybody acts on. A gate whose advice cannot be executed
// fails the reader even when the finding is correct: following it correctly still
// fails, and the failure looks like the tool being broken rather than the advice
// being wrong.
//
// MEASURED (2026-10-05). `test/round-trip-record-truth.test.ts` closed its gaps
// with ONE hardcoded line:
//
//     Close it by running `node scripts/audit/record-roundtrip.mjs --site youtube
//     --capability chat`
//
// and `youtube` HAS NO CHAT. Its manifest says "No chat composer exists; no chat
// capability is registered", `builtinProfile` is "none", it declares SEVEN
// capabilities and not one of them is chat, its `profile.json` carries
// `composer:[] answer:[]`, and it is ABSENT from `GET /sites`. So the command the
// gate printed was unrunnable twice over: `--capability chat` is not a capability
// the site declares (the daemon answers HTTP 400 `unknown_capability "chat" for
// "youtube"`), and the invocation omits the `--import tsx` loader the harness
// documents as REQUIRED in a source checkout (`record-roundtrip.mjs:118`). The
// lane that found it REFUSED to run the command, which is the correct call — and
// it is why this is a defect and not a curiosity.
//
// WHY IT LIVES HERE AND NOT IN THE GATE. Every input is a fact this module
// already owns and no gate re-derives: which ids the daemon can address as CHAT
// (`defaultChatSurface()` — the same gate promptd's `/v1` allow-list is built
// from), which capabilities a package DECLARES (`validManifestCapability` over the
// same manifest `buildRegistryPackages()` reads), and what arguments each one
// requires (`declaredCapabilityInputSchema` — the DECLARED contract, never the
// regex guess `capabilityInputSchema` falls back to). A gate that re-read the
// manifest to format a sentence would be a second reader of the same data, and
// this file's own history is the argument against that: `capabilityInputSchema`
// already GUESSED wrong once (advertising `new_chat` while every runner reads
// `newChat`) purely because a second implementation existed.
//
// WHAT IT DOES NOT DO. It reads a manifest and formats a string. It NEVER launches
// a browser, never opens a daemon connection, and never runs the harness — a gate
// that executed its own advice would measure nothing and prove nothing.
// ─────────────────────────────────────────────────────────────────────────────

/** The harness invocation, matched to its REAL CLI contract: `--site`,
 *  `--capability`, `--args`, `--dry-run` (record-roundtrip.mjs:118-122). The
 *  `--import tsx` loader is in the prefix because the harness documents it as
 *  REQUIRED — there is no `dist/` in a source checkout, so without it the script
 *  cannot import the shipped classifier and refuses with exit 2. */
const PROBE_HARNESS = "node --import tsx scripts/audit/record-roundtrip.mjs";

/** A placeholder value for a REQUIRED arg, derived from its DECLARED type. A
 *  string arg becomes a visible `<name>` placeholder rather than a fabricated
 *  value: a gate may not invent the query or the videoId a real probe needs, and
 *  a placeholder that reads as a placeholder is an instruction, not a claim. */
function probeArgValue(declared: RegistryToolInputSchema, key: string): unknown {
  switch (declared.properties[key]?.type) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      // The placeholder is a JS VALUE, encoded once by the caller's
      // JSON.stringify — encoding it here too produced `"\"<query>\""`, a
      // doubly-quoted string a runner would take literally.
      return `<${key}>`;
  }
}

export interface RoundTripProbeAdvice {
  siteId: string;
  /** "chat" when the daemon can address this id on POST /prompt, "capability"
   *  when it declares capability surfaces only, "none" when it declares neither. */
  shape: "chat" | "capability" | "none";
  /** True iff `defaultChatSurface()` carries the id — the same truth `/v1/models`
   *  and `/sites` serve. A capability-only package is NEVER `true` here, which is
   *  what makes `--capability chat` unprintable for it. */
  chat: boolean;
  /** The declared capability ids the advice names, in manifest order. The
   *  synthetic `chat` sentinel is NOT one of them. */
  capabilities: string[];
  /** Copy-pasteable commands: the chat probe first when the site has a chat
   *  surface, then one per declared capability. */
  commands: string[];
  /** An honest sentence when there is nothing to run. Never an empty command. */
  note: string | null;
}

/**
 * The executable remediation for `siteId`, DERIVED from the package rather than
 * from a template. Pure: manifest reads only, no browser, no daemon, no harness.
 */
export function roundTripProbeAdvice(siteId: string): RoundTripProbeAdvice {
  const chat = defaultChatSurface().some((e) => e.id === siteId);
  const pkgDir = findPackageDir(siteId);
  let caps: (ManifestCapability & { id: string })[] = [];
  if (pkgDir) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(pkgDir, "manifest.json"), "utf8")) as Manifest;
      caps = (Array.isArray(manifest.capabilities) ? manifest.capabilities : []).filter(validManifestCapability);
    } catch {
      caps = [];
    }
  }

  const commands: string[] = [];
  if (chat) {
    // The chat sentinel is the harness's DEFAULT `--capability`, and it is the
    // only shape that can derive class ANSWERS: it posts to /prompt, so the
    // per-measurement nonce probe runs and `probeNonceMatched` is meaningful.
    // A `<site>_chat` capability row is measured over /capability instead, which
    // returns JSON with no nonce — RETURNS-DATA at best. So a chat site is told
    // to probe as chat FIRST, and its declared capabilities after it.
    commands.push(`${PROBE_HARNESS} --site ${siteId} --capability chat`);
  }
  for (const c of caps) {
    const declared = declaredCapabilityInputSchema(c);
    const required = declared?.required ?? [];
    // `anyOf` ("at least one of") picks the FIRST branch: it is the first
    // satisfying alternative the package itself declared, so the command is
    // correct by construction and the alternatives are reported alongside it.
    const anyOfBranch = declared?.anyOf?.[0]?.required ?? [];
    const keys = required.length > 0 ? required : anyOfBranch;
    const args = keys.length > 0 && declared
      ? ` --args '${JSON.stringify(Object.fromEntries(keys.map((k) => [k, probeArgValue(declared, k)])))}'`
      : "";
    commands.push(`${PROBE_HARNESS} --site ${siteId} --capability ${c.id}${args}`);
  }

  const shape: RoundTripProbeAdvice["shape"] = commands.length === 0 ? "none" : chat ? "chat" : "capability";
  return {
    siteId,
    shape,
    chat,
    capabilities: caps.map((c) => c.id),
    commands,
    note:
      commands.length === 0
        ? `\`${siteId}\` declares NO capability in its installed manifest and is NOT on the daemon's chat surface ` +
          `(GET /sites), so there is nothing this gate can tell you to run: a probe needs a surface to probe. ` +
          `Either the package's manifest under capabilities/${siteId}/ is missing its capabilities array, or the ` +
          `published claim names a surface this build cannot serve — resolve that before re-running anything.`
        : null,
  };
}

/**
 * Machine status of a SURFACED chat id (GOAL 32 truth-gate). "builtin" for the
 * curated catalog (its verification lives in the profile's own note, not a
 * machine field); packaged ids derive it from their manifest/metadata:
 * "verified" ONLY from a real metadata.verified record with a live round-trip;
 * "unverified-candidate" = driveable selectors, no recorded live round-trip
 * (annotated, never claimed verified); "dormant"/"dead-end" = excluded from
 * the chat surface until a live round-trip exists.
 */
export type ChatSurfaceStatus = "verified" | "unverified-candidate" | "dormant" | "dead-end" | "builtin";

/** Per-id status of the SURFACED chat set. Unknown/id-less ids get the
 *  conservative "unverified-candidate" (nothing beyond a packaged profile is
 *  ever asserted). */
export function chatSurfaceStatus(siteId: string): ChatSurfaceStatus {
  // GOAL 92: a builtin profile that ALSO has a packaged verified/dormant/dead-end
  // record must report THAT status, not the bare "builtin" — otherwise a
  // /registry consumer cannot tell "builtin + live-verified" from "builtin +
  // never tried", and the shipped status column cannot be pinned to the machine
  // truth. "builtin" is only the fallback for a profile with no package record.
  const packaged = packageStatusOf(siteId);
  if (listProfiles().some((p) => p.id === siteId)) {
    return packaged === "unknown" ? "builtin" : packaged;
  }
  return packaged === "unknown" ? "unverified-candidate" : packaged;
}

/** The manifest/metadata status of an installed package: "dormant", "dead-end"
 *  (both excluded from the chat surface), "verified" (real verified record) or
 *  "unknown" (scaffold/unverified — no metadata or no record). */
function packageStatusOf(siteId: string): ChatSurfaceStatus | "unknown" {
  const pkgDir = findPackageDir(siteId);
  if (!pkgDir) return "unknown";
  let meta: Metadata | null = null;
  try {
    meta = JSON.parse(readFileSync(resolve(pkgDir, "metadata.json"), "utf8")) as Metadata;
  } catch {
    meta = null; // no metadata.json -> scaffold/experimental, unverified
  }
  if (typeof meta?.status === "string") {
    if (meta.status === "dormant" || meta.status === "dead-end") return meta.status;
  }
  // The SAME record predicate `buildRegistryPackages()` gates its published
  // `status` on (THE STATUS PROVENANCE GATE below). Sharing it is what makes
  // "/registry says verified" and "/sites says verified" the same statement:
  // two different record tests would let the two surfaces drift apart on a
  // half-written record, and the honest answer would live on whichever surface
  // nobody was reading.
  if (isCompleteVerifiedRecord(meta?.verified)) {
    // THE MEASUREMENT GATE. The receipt above says a round trip happened; this
    // says whether one is RECORDED as machine-measured. Both must hold before
    // `verified` is minted, and the measurement may only ever DEMOTE (see the
    // seam note above for the direction argument and for why this is here and
    // not in `honestPackageStatus`).
    const m = measuredRoundTripFor(siteId);
    if (!m.measured) return UNEARNED_STATUS;
    return EARNED_STATUS;
  }
  return "unknown";
}

/**
 * Every cookie host this build knows a site for: the builtin catalog's own
 * profile urls plus every installed package manifest's url, deduplicated.
 *
 * This is the DERIVATION for anything that needs to recognise "a host we care
 * about" — the bulk-login scanner's `[KNOWN]` flag above all. It used to be a
 * 31-host list typed by a human in `src/runtime/profile-scan.ts`, with no edge
 * to either of the two places that actually know the sites. MEASURED drift: 10
 * real sites were missing from it — `www.kimi.ai`, `aistudio.tencent.ai` (the
 * live-verified Tencent chat surface), `duck.ai` (the full-surface-verified
 * DuckDuckGo package), `youtube.com`, `mail.google.com` and five more — so an
 * operator running the one-command bulk login on a box whose cookies live
 * under `www.kimi.ai` saw a host with no `[KNOWN]` marker, i.e. the command the
 * README tells them to run looked like it had found nothing.
 *
 * A url-less package (chatglm declares none) contributes nothing here; hosts
 * only a human knows about belong in that caller's own POLICY list, not here.
 */
export function siteHostCatalog(): string[] {
  const hosts = new Set<string>();
  const add = (u: unknown) => {
    if (typeof u !== "string" || !u) return;
    try {
      hosts.add(new URL(u).host);
    } catch {
      /* a relative or placeholder url names no host */
    }
  };
  for (const p of listProfiles()) add(p.url);
  for (const id of listInstalledPackageIds()) {
    const dir = findPackageDir(id);
    if (!dir) continue;
    try {
      add((JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as Manifest).url);
    } catch {
      /* a malformed manifest names no host; validate-packages gates that case */
    }
  }
  return [...hosts].sort();
}

export interface ChatSurfaceEntry {
  id: string;
  profile: ChatSiteProfile;
  /** GOAL 32 status of this surfaced id (see ChatSurfaceStatus). Excluded
   *  ids are NOT in this list — they stay on /registry with their honest
   *  manifest status instead. */
  status: ChatSurfaceStatus;
  packaged: boolean;
}

/**
 * The daemon's DEFAULT configured chat-site set (GOAL 30 merge + GOAL 32
 * truth-gate): the builtin chat catalog PLUS every installed, driveable
 * chat-shaped package profile (capabilities/<id>/profile.json — the same
 * canonical source /capability and /registry serve). This is what
 * `--site`-less promptd, `GET /sites`, `GET /v1/models` and
 * `ui2api prompt --sites` all reflect. Rules:
 *   - a builtin id is authoritative for that id (packaged overrides never
 *     shadow the builtin profile);
 *   - GOAL 147: a BUILTIN id is gated by the SAME `isDriveableChatProfile`
 *     truth-gate the packaged loop below already ran. The builtin loop used to
 *     admit the whole catalog unconditionally, so a builtin that is NOT
 *     chat-shaped (composer-less urlTemplate surface `google-ai-search`, whose
 *     manifest declares no `*_chat` capability and whose runner implements
 *     none) was stamped chat: /v1/models advertised a chat model with no chat
 *     tool in the map, and /registry emitted `chat.model` for a package the
 *     daemon cannot serve as chat. Catalog membership is not a chat claim —
 *     authority is about WHICH profile serves an id, never about WHETHER it
 *     is chat. An excluded builtin keeps every other surface exactly as before
 *     (its package stays fully served on /registry + /capability/<id>, and an
 *     explicit `--site google-ai-search` still resolves, because an explicit
 *     profiles list stays authoritative);
 *   - a package only joins when `isDriveableChatProfile` — chat-shaped
 *     (composer + answer + url, GOAL 30) AND every composer/answer entry is a
 *     PARSEABLE CSS selector (GOAL 32: prose entries like t3chat's former
 *     "UNVERIFIED-SCAFFOLD — …" crash the driver's querySelectorAll at send
 *     time); capability-only surfaces (gmail/youtube/araprat/chatglm/
 *     tinycms/…) never become chat models;
 *   - a packaged id whose manifest status is "dormant" or "dead-end"
 *     (zenmux parked-origin, xiaomimimo DNS-pinned dead-end) is EXCLUDED from
 *     the chat surface until live-verified — it stays fully served on
 *     /registry + /capability/<id> with that honest status;
 *   - an explicit `--site`/`profiles` list stays authoritative (startPromptd
 *     only calls this in its default path; resolveProfile is untouched).
 */
export function defaultChatSurface(): ChatSurfaceEntry[] {
  const entries: ChatSurfaceEntry[] = [];
  const byId = new Map<string, ChatSiteProfile>();
  for (const p of listProfiles()) {
    if (!isDriveableChatProfile(p)) continue; // GOAL 147 — same gate as the packaged loop below
    byId.set(p.id, p);
    // ONE resolver for the status, never a second implementation of it. This
    // hard-coded "builtin" while `chatSurfaceStatus()` — the function /sites,
    // `prompt --sites` and `requirements` actually call — reported the packaged
    // record instead, so the two disagreed on every builtin that has one
    // (MEASURED: gemini, kimi, deepseek, tencent-aistudio all said "builtin"
    // here and "verified" there). Both are public exports of this module, so a
    // consumer reading either got a different answer for the same id.
    entries.push({ id: p.id, profile: p, status: chatSurfaceStatus(p.id), packaged: false });
  }
  for (const id of listInstalledPackageIds()) {
    if (byId.has(id)) continue;
    const packaged = resolvePackagedProfile(id);
    if (!packaged || !isDriveableChatProfile(packaged)) continue;
    const status = packageStatusOf(id);
    if (status === "dormant" || status === "dead-end") continue; // honest exclusion until live-verified
    byId.set(id, packaged);
    entries.push({ id, profile: packaged, status: status === "verified" ? "verified" : "unverified-candidate", packaged: true });
  }
  return entries;
}

export function defaultChatProfiles(): ChatSiteProfile[] {
  return defaultChatSurface().map((e) => e.profile);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE MEASUREMENT GATE — "does it answer" (GOAL 159)
//
// `defaultChatSurface()` above answers ONE question: can this daemon ADDRESS
// this id — does the profile carry a url, a composer and an answer, and do those
// selectors parse. That is a routing/selector-shape question, and it is the
// GOAL 34 gate. It is NOT the question a consumer cares about, which is whether
// a prompt sent to the id comes back as an answer. The two were conflated into
// one boolean, so /v1/models advertised 22 models on a service where the
// measured record (capabilities/model-verification.json) says 4 of them return a
// real 200 with real answer text and 18 do not.
//
// They are now two separately-named gates that both feed the served surface:
//   defaultChatSurface()  = ADDRESSABLE (selector shape)  — the full catalogue
//   answerableChatSurface() = ANSWERS (measured round trip) — the promise
// The promise is the intersection. Neither gate is allowed to stand in for the
// other: a model can be addressable and unmeasured (a human must sign in), and a
// model with a parsed selector can still 502 on a live round trip.
//
// The restriction reads the RECORD ONLY. It never infers, upgrades, or predicts
// a class — a class this module does not recognise withholds the model, because
// an uninterpretable class is a claim no code can check. And a MISSING record
// withholds too: an unmeasured model is not a promise, it is an absence. Both
// halves are reported, so a consumer can tell "this service offers 4" from
// "this service hides 18 and says why".
// ─────────────────────────────────────────────────────────────────────────────

/** The record's own schema tag. A different tag means a reader this gate does
 *  not implement, so the honest move is a named refusal, not a guess. */
export const MODEL_VERIFICATION_SCHEMA = "ui2api/model-verification/1";

/** The class that means "a real measured round trip returned real answer text".
 *  It is the ONLY class that earns an advertisement. */
export const MODEL_ANSWER_CLASS = "ANSWERS";

/** Every class the record's vocabulary can carry — DERIVED from the classifier
 *  that defines them, so it cannot drift.
 *
 *  This used to be a hand-typed four-name list
 *  ("ANSWERS", "SIGN-OUT", "CONTENDED-TIMEOUT", "UNMEASURED") under a comment
 *  claiming it was "the closed class vocabulary this reader can interpret". That
 *  comment was two lies at once, and both were rot:
 *
 *  1. THE VOCABULARY HAS NINE MEMBERS. This module never imported
 *     `verification-class.js`, so nothing here could notice when WALL-CHALLENGE
 *     and COMPOSER-DRIFT arrived with GOAL 158 and NON-ANSWER-READ,
 *     ANSWER-UNREADABLE and UNATTRIBUTED-NO-ANSWER arrived later. The list was
 *     a snapshot of the vocabulary as it stood the day the reader was written,
 *     presented as the vocabulary.
 *
 *  2. "CAN INTERPRET" WAS NOT A SUBSET, SO THE SUBSET MEANT NOTHING. A row this
 *     list omitted did not become unreadable: it fell through `withheldReason`'s
 *     `default:` arm to `classMeaning()`, which QUOTES the record's own `classes`
 *     entry for that class. So the reader interpreted WALL-CHALLENGE and
 *     COMPOSER-DRIFT perfectly well, three goals' worth, while a comment claimed
 *     it could not — and the four-name list described no capability boundary
 *     that had ever existed.
 *
 *  So the list is the whole derived vocabulary, not a curated subset: every
 *  member is interpretable, three of them with a bespoke reason from
 *  `withheldReason` and the rest by quoting the record. A record class outside
 *  this set is still handled (it takes the `default:` arm and is reported with
 *  the record's own meaning) — this set is what the reader RECOGNISES, not a
 *  whitelist that withholds the unknown. */
export const MODEL_ANSWER_CLASSES = VERIFICATION_CLASSES;

export type ModelAnswerClass = (typeof MODEL_ANSWER_CLASSES)[number];

export interface WithheldModel {
  model: string;
  /** The record's class, or the reader sentinel "NO-RECORD" when the record
   *  carried no class for this id (either no entry at all, or an empty `class`
   *  field). "NO-RECORD" is NOT a VerificationClass and is not in the record's
   *  vocabulary — it is this reader saying it had no measurement to report. An
   *  earlier version of this comment also named "UNREADABLE", which no code path
   *  has ever emitted; if a future unreadable-record sentinel is added, add it
   *  here with the line that emits it. */
  class: string;
  /** Why this id is not advertised, in words a consumer can act on. */
  reason: string;
}

export interface ModelVerification {
  /** Repo-relative path of the record this was read from. */
  recordPath: string;
  schema: string | null;
  generatedAt: string | null;
  /** Whole days between generatedAt and now, or null when undatable. */
  ageDays: number | null;
  /** Ids whose record class is ANSWERS. Sorted. */
  answers: string[];
  /** Every other classified id, with the named reason it is withheld. Sorted. */
  withheld: WithheldModel[];
  /**
   * NAMED refusal, or null when the record was read. NON-NULL means the record
   * is missing, unparseable, or shaped unlike anything this reader knows — and
   * the advertisement must REFUSE rather than serve everything (the old lie) or
   * serve nothing (an unexplained zero).
   */
  refusal: string | null;
}

/** Repo-relative location of the record. Walked up like findPackageDir so it
 *  resolves the same way from src/ and from the build output. */
function modelVerificationPath(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const up of [2, 3]) {
    let p = here;
    for (let i = 0; i < up; i++) p = dirname(p);
    const candidate = resolve(p, "capabilities", "model-verification.json");
    if (existsSync(candidate)) return candidate;
  }
  return resolve(process.cwd(), "capabilities", "model-verification.json");
}

/** The class's own meaning, quoted from the record's own vocabulary where the
 *  record supplies it — the reader never writes its own definition of a class. */
function classMeaning(classes: Record<string, unknown>, cls: string): string {
  const m = classes[cls];
  return typeof m === "string" && m.trim() !== "" ? m.trim() : `the record classes this id as ${cls}`;
}

function withheldReason(cls: string, meaning: string): string {
  switch (cls) {
    case "SIGN-OUT":
      return "the record measured this id and it refused the request: sign-in is required, which is a human login action this build does not attempt";
    case "CONTENDED-TIMEOUT":
      return "the record measured a queue timeout, not an answer — a measurement of the pool rather than a property of the model, and no ANSWERS class was established";
    case "UNMEASURED":
      return "the record established no class about this model, so no promise can be made for it";
    default:
      return meaning;
  }
}

/**
 * Read the dated measurement record. Pure fs, no browser, no network, and never
 * throws: every failure mode becomes a NAMED `refusal` the caller surfaces,
 * because a record that cannot be read must be visible rather than silently
 * treated as "advertise everything".
 */
export function readModelVerification(): ModelVerification {
  const abs = modelVerificationPath();
  const recordPath = "capabilities/model-verification.json";
  const base: ModelVerification = {
    recordPath,
    schema: null,
    generatedAt: null,
    ageDays: null,
    answers: [],
    withheld: [],
    refusal: null,
  };
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (e) {
    return {
      ...base,
      refusal: `model-verification record unreadable at ${recordPath} (${(e as Error).message}) — /v1/models refuses rather than advertise a promise no measurement backs`,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return {
      ...base,
      refusal: `model-verification record at ${recordPath} is not parseable JSON (${(e as Error).message}) — /v1/models refuses rather than advertise a promise no measurement backs`,
    };
  }
  const schema = typeof parsed.schema === "string" ? parsed.schema : null;
  if (schema !== MODEL_VERIFICATION_SCHEMA) {
    return {
      ...base,
      schema,
      refusal: `model-verification record declares schema ${JSON.stringify(schema)}, not ${MODEL_VERIFICATION_SCHEMA} — /v1/models refuses rather than guess at a record shape it does not implement`,
    };
  }
  const records = Array.isArray(parsed.records) ? (parsed.records as Record<string, unknown>[]) : null;
  if (!records) {
    return {
      ...base,
      schema,
      refusal: `model-verification record at ${recordPath} carries no records array — /v1/models refuses rather than advertise a promise no measurement backs`,
    };
  }
  const classes =
    typeof parsed.classes === "object" && parsed.classes !== null && !Array.isArray(parsed.classes)
      ? (parsed.classes as Record<string, unknown>)
      : {};
  const answers: string[] = [];
  const withheld: WithheldModel[] = [];
  for (const r of records) {
    const model = typeof r?.model === "string" ? r.model.trim() : "";
    if (model === "") continue;
    const cls = typeof r?.class === "string" ? r.class.trim() : "";
    if (cls === MODEL_ANSWER_CLASS) {
      answers.push(model);
      continue;
    }
    const named = cls === "" ? "NO-RECORD" : cls;
    withheld.push({ model, class: named, reason: withheldReason(named, classMeaning(classes, named)) });
  }
  const generatedAt = typeof parsed.generatedAt === "string" ? parsed.generatedAt : null;
  const parsedAt = generatedAt === null ? NaN : Date.parse(generatedAt);
  return {
    recordPath,
    schema,
    generatedAt,
    ageDays: Number.isNaN(parsedAt) ? null : Math.max(0, Math.floor((Date.now() - parsedAt) / 86_400_000)),
    answers: [...new Set(answers)].sort(),
    withheld: withheld.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)),
    refusal: null,
  };
}

/**
 * THE ANSWERING GATE. An id is advertised only when it is addressable AND its
 * record class is ANSWERS. An id on the addressable surface with no record, or
 * with any other class, is withheld with the record's own reason — it stays
 * fully reachable on /registry, /sites and /capability/<id>, because discovery
 * and promise are different surfaces and a withheld model must stay discoverable.
 */
export function answerableChatSurface(verification = readModelVerification()): ChatSurfaceEntry[] {
  if (verification.refusal !== null) return [];
  const answering = new Set(verification.answers);
  return defaultChatSurface().filter((e) => answering.has(e.id));
}

/** Every addressable id that is NOT advertised, each with its named reason —
 *  including the ids the record never mentions, which are withheld for a
 *  different reason (nothing measured) than a class that was measured. */
export function withheldChatModels(verification = readModelVerification()): WithheldModel[] {
  const answering = new Set(verification.answers);
  const out = verification.withheld.filter((w) => !answering.has(w.model));
  const recorded = new Set([...verification.answers, ...out.map((w) => w.model)]);
  for (const e of defaultChatSurface()) {
    if (recorded.has(e.id)) continue;
    out.push({
      model: e.id,
      class: "NO-RECORD",
      reason: "the record carries no entry for this model, so nothing was ever measured about it and no promise can be made",
    });
  }
  return out.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

/** The honest split a consumer needs: how many are offered, how many are held
 *  back, and under which measured classes. This is the block /v1/models and
 *  /health both carry, so "this service offers 4" is never confused with
 *  "this service hides 18". */
export interface ModelAdvertisementSummary {
  offered: number;
  addressable: number;
  withheld: number;
  withheldByClass: Record<string, number>;
  record: string;
  recordGeneratedAt: string | null;
  recordAgeDays: number | null;
  rule: string;
  catalogueEndpoints: string[];
  refusal: string | null;
}

export function modelAdvertisementSummary(
  verification = readModelVerification(),
  servedIds?: Iterable<string>,
): ModelAdvertisementSummary {
  // The counts are about THIS DAEMON'S served surface, not the repo's. A daemon
  // started with `--site deepseek` serves one id; reporting the repo-wide 4/22/18
  // there would tell the consumer a number that is not true of the process it is
  // talking to — the honest count and an inflated count are the same defect.
  const served = servedIds === undefined ? null : new Set(servedIds);
  const inScope = (id: string) => served === null || served.has(id);
  const addressable = defaultChatSurface().filter((e) => inScope(e.id));
  const answering = new Set(verification.answers);
  const offered = addressable.filter((e) => answering.has(e.id)).length;
  const withheld = withheldChatModels(verification).filter((w) => inScope(w.model));
  const withheldByClass: Record<string, number> = {};
  for (const w of withheld) withheldByClass[w.class] = (withheldByClass[w.class] ?? 0) + 1;
  return {
    offered,
    addressable: addressable.length,
    withheld: withheld.length,
    withheldByClass,
    record: verification.recordPath,
    recordGeneratedAt: verification.generatedAt,
    recordAgeDays: verification.ageDays,
    rule: "only ids whose record class is ANSWERS are advertised; every other addressable id is withheld with its named reason and stays discoverable on the catalogue endpoints",
    catalogueEndpoints: ["/registry", "/sites", "/capability/{site}"],
    refusal: verification.refusal,
  };
}

/** Build the registry 'packages' array from the installed capability packages. */
/**
 * GOAL 61: crash-proofing filter for manifest capability entries. A malformed
 * installed manifest (capabilities entry that is null / primitive / missing
 * its string `id`) must NEVER take down the whole /registry build — the read
 * seams refuse malformed storage gracefully (GOAL 58/59/60), and this is the
 * registry-build twin. Malformed entries are EXCLUDED (never advertised, never
 * crash); well-formed entries pass through untouched.
 */
export function validManifestCapability(c: unknown): c is ManifestCapability & { id: string } {
  if (typeof c !== "object" || c === null || Array.isArray(c)) return false;
  const id = (c as { id?: unknown }).id;
  return typeof id === "string" && id.trim() !== "";
}

/**
 * GOAL 139: the SELF-SUFFICIENCY BLOCK.
 *
 * The audit that started this found the load-bearing gap: `/registry` described
 * WHAT exists but never HOW to call it. A third-party consumer — a generated
 * PHP client, a skill teaching an AI to register a site, per-site docs — had to
 * know the verb, the path, and the body keys out of band, i.e. it had to know
 * ui2api's HTTP internals. That is precisely the coupling the registry exists to
 * remove, and it is why the PHP generator had to hardcode `/capability/` and
 * `{capability, args}` (lang-php.ts:363-369).
 *
 * So the daemon now ships its own call contract alongside its inventory. A
 * consumer reads this and can construct a valid request with zero knowledge of
 * the app. `contractVersion` is the DRIFT GATE: it changes whenever the wire
 * contract does, so a consumer built against an older daemon can detect the
 * mismatch instead of failing silently at runtime.
 */
export const REGISTRY_CONTRACT_VERSION = 1;

export interface RegistryContract {
  contractVersion: number;
  endpoints: {
    capability: { method: string; pathTemplate: string; bodyKeys: string[]; requiredBodyKeys: string[] };
    chatCompletions: { method: string; pathTemplate: string; bodyKeys: string[]; requiredBodyKeys: string[]; openAICompatible: boolean };
    registry: { method: string; pathTemplate: string };
    models: { method: string; pathTemplate: string };
    accounts: { method: string; pathTemplate: string; note: string };
  };
  auth: { header: string; scheme: string; required: boolean; note: string };
  /**
   * Honest scope note, so a consumer never over-reads the payload: the package
   * list is built ONLY from installed packages under capabilities/<id>/. The
   * daemon cannot fetch or publish registry content — that is a CLI action.
   */
  scope: { source: string; daemonFetchesRegistry: false; daemonPublishesRegistry: false };
}

export function buildRegistryContract(tokenRequired: boolean): RegistryContract {
  return {
    contractVersion: REGISTRY_CONTRACT_VERSION,
    endpoints: {
      capability: {
        method: "POST",
        pathTemplate: "/capability/{site}",
        // `account` is a TOP-LEVEL body key, not an arg — the audit found the
        // old schema advertising it inside `properties`, which would have made
        // a consumer nest it under args and have it ignored.
        bodyKeys: ["capability", "args", "account"],
        requiredBodyKeys: ["capability"],
      },
      chatCompletions: {
        method: "POST",
        pathTemplate: "/v1/chat/completions",
        bodyKeys: ["model", "messages", "stream", "new_chat", "account"],
        requiredBodyKeys: ["model", "messages"],
        openAICompatible: true,
      },
      registry: { method: "GET", pathTemplate: "/registry" },
      models: { method: "GET", pathTemplate: "/v1/models" },
      accounts: {
        method: "GET",
        pathTemplate: "/accounts?site={site}",
        note: "`account` accepted by the capability/chat endpoints is a slug or identity from this list",
      },
    },
    auth: {
      header: "Authorization",
      scheme: "Bearer",
      required: tokenRequired,
      note: tokenRequired
        ? "this daemon is token-gated; send `Authorization: Bearer <UI2API_PROMPTD_TOKEN>` on every call"
        : "no daemon token is configured; this daemon is loopback-only posture",
    },
    scope: {
      source: "installed packages under capabilities/<id>/ (manifest.json + metadata.json)",
      daemonFetchesRegistry: false,
      daemonPublishesRegistry: false,
    },
  };
}

export function buildRegistryPackages(): RegistryPackage[] {
  const ids = listInstalledPackageIds();
  const dataDir = resolveDataDir();
  const packages: RegistryPackage[] = [];
  // The ONLY servable chat set — the same gate promptd's /v1 profilesById is
  // built from (defaultChatProfiles → defaultChatSurface). A package is marked
  // chat iff its id is on this surface (GOAL 34 truth-gate): registry chat
  // claims must never exceed what /v1/chat/completions can actually answer.
  const chatSurfaceIds = new Set(defaultChatSurface().map((e) => e.id));
  // GOAL 159: the chat key is a PROMISE, so it follows the MEASURED gate, not
  // the addressable one. A package whose record class is not ANSWERS gets no
  // `chat` key — a consumer materialising one provider per `pkg.chat` must not
  // build 18 providers that cannot answer — while the package itself stays
  // fully listed with its tools, status and metadata. The reason it carries no
  // chat key is named in `chatWithheld`, so the catalogue explains its own
  // omission instead of leaving the consumer to guess.
  const answerableIds = new Set(answerableChatSurface().map((e) => e.id));
  const withheldBy = new Map(withheldChatModels().map((w) => [w.model, w]));
  for (const siteId of ids) {
    // Only packages the daemon can actually serve (has a packaged ChatSiteProfile).
    const profile = resolvePackagedProfile(siteId);
    if (!profile) continue;
    const pkgDir = findPackageDir(siteId);
    if (!pkgDir) continue;
    let manifest: Manifest | null = null;
    try {
      manifest = JSON.parse(readFileSync(resolve(pkgDir, "manifest.json"), "utf8")) as Manifest;
    } catch {
      manifest = null;
    }
    const caps = Array.isArray(manifest?.capabilities) ? manifest.capabilities : [];
    // ONE status resolver for both fields (see THE STATUS PROVENANCE GATE
    // above). It used to be the two lines below, which republished
    // `metadata.json`'s `status` verbatim:
    //
    //     if (typeof meta.status === "string" && meta.status.trim()) status = meta.status.trim();
    //
    // so `status: "verified"` was published as an EARNED classification with no
    // verification record behind it, while `/sites` — which reads the same file
    // through `packageStatusOf()` — reported the same package as
    // `unverified-candidate`. The consumer-facing registry is the surface that
    // must never be the more generous of two readings of one package.
    let status = "unknown";
    let verified: RegistryVerified | false = false;
    try {
      const meta = JSON.parse(
        readFileSync(resolve(pkgDir, "metadata.json"), "utf8")
      ) as Metadata;
      const honest = honestPackageStatus(meta);
      status = honest.status;
      // A truthy `verified` value must be a full record; anything else (true,
      // bogus) is refused here and by validate-registry.mjs so consumers can
      // trust the field.
      verified = honest.verified;
    } catch {
      // metadata.json absent → scaffold/experimental package, status stays "unknown"
    }
    // GOAL 61: per-entry filter — a malformed capability entry is EXCLUDED
    // (never advertised), never a TypeError that kills the whole registry.
    // ONE per-capability read of the round-trip record, taken BEFORE the tool
    // list so each tool can be answered from it. Read ONCE per package: a second
    // `measuredRoundTripFor()` call per tool would re-read and re-classify the
    // record seven times for youtube alone, and — worse — a consumer reading the
    // tools could be served by a record read that disagrees with the package
    // verdict printed beside it.
    const siteVerdict = measuredRoundTripFor(siteId);
    const toolRoundTrip = new Map(siteVerdict.capabilities.map((c) => [c.capability, c]));
    const tools: RegistryTool[] = caps.filter(validManifestCapability).map((c) => {
      const declared = declaredCapabilityInputSchema(c);
      // A record row names the capability by the harness's own id, which is the
      // raw manifest id (`youtube_transcript`) OR the bare chat sentinel
      // (`chat`). Both spellings are looked up, so a chat-shaped row is not
      // silently dropped for want of a match — a dropped lookup would read as
      // "no measurement", which is exactly the fabrication this field exists to
      // prevent.
      const bare = bareCapabilityId(siteId, c.id);
      const measured = toolRoundTrip.get(c.id) ?? toolRoundTrip.get(bare) ?? toolRoundTrip.get(`${bare}_chat`);
      return {
        name: `${siteId}_${bare}`,
        id: c.id,
        description: consumerProse(c.description) || c.name || c.id,
        method: c.method || "ui-path",
        workType: c.method === "js-function" ? "js-function" : "ui-path",
        reloadAfterSuccess: true,
        inputSchema: capabilityInputSchema(siteId, c.id, c.method, c.description, declared),
        // GOAL 139: the honesty flag. `false` means the schema above is a
        // best-effort GUESS, because the package declared no arg contract. A
        // consumer can then refuse to auto-generate a client for a tool it
        // cannot trust, instead of shipping a call that silently sends the
        // wrong fields.
        argsDeclared: declared !== null,
        // GOAL 140: is this tool actually CALLABLE, or only declared? /registry
        // is built from the manifest (data) while execution goes through the
        // dispatch table (also data now, but a separate one) — so a package can
        // declare a capability the daemon cannot route. Before this field that
        // was invisible: the tool was advertised and then 404'd at call time.
        // A consumer building a client keys on this instead of finding out.
        dispatch: isDispatchable(siteId) ? "wired" : "declared-only",
        ...(measured ? { roundTrip: measured } : {}),
      };
    });
    // Stored vault accounts for this site, keyed by the packaged profile's host
    // — EXACTLY the host GET /accounts?site= uses (http.ts: new URL(profile.url).host).
    // No url → no host to key the vault by → field omitted (undefined).
    //
    // GOAL 89: the index is RECONCILED, not trusted. Every row is re-checked
    // against the snapshot actually on disk by the SAME pure reconciler
    // /accounts serves (`verifyStoredAccount`), so a row that points at a
    // missing / unreadable / anonymous / wrong-shaped snapshot is advertised
    // as `usable: false` with its NAMED reason — a consumer that trusts the
    // registry (the ONLY info source it has) can never pick an account that
    // can only replay signed-out. An unusable row is still LISTED (a real
    // stored row the user may want to see and delete), and the host-level
    // rollup makes an all-unusable host visible instead of silently empty.
    let accounts: StoredAccount[] | undefined;
    let accountsSummary: ConsumerAccountsSummary | undefined;
    const profileUrl = profile.url;
    if (profileUrl) {
      try {
        const host = new URL(profileUrl).host;
        accounts = listAccounts(dataDir, host).map((a) => withAccountVerdict(a, verifyStoredAccount(dataDir, host, a)));
        // The rollup is published from CONSUMER reason classes, never the
        // reconciler's own strings: those name the credential stores it
        // examined and an internal gate number, and the registry is the only
        // info source a consumer has, so a reason it cannot act on is a
        // reason that teaches it our internals without helping it.
        accountsSummary = consumerAccountsSummary(accounts);
      } catch {
        accounts = undefined;
        accountsSummary = undefined;
      }
    }
    packages.push({
      id: siteId,
      name: manifest?.name || profile.name || siteId,
      url: manifest?.url || profile.url || "",
      description: consumerProse(manifest?.description),
      version: manifest?.version || "",
      site: manifest?.site || "",
      authRequired: manifest?.auth?.required !== false,
      status,
      verified,
      // GOAL 159: the chat key is a PROMISE, so it follows the MEASURED gate, not
      // the addressable one. An addressable id the record does not call ANSWERS
      // gets NO `chat` key — a consumer materialising one provider per `pkg.chat`
      // must not build 18 providers that cannot answer — while the package itself
      // stays fully listed with its tools, status and metadata, and the reason for
      // the missing key is named in `chatWithheld` below.
      ...(chatSurfaceIds.has(siteId) && answerableIds.has(siteId)
        ? { chat: { model: siteId, streaming: true } }
        : {}),
      // GOAL 159: present only when the id is addressable but NOT advertised,
      // and it always says why — the measured class and the reason in words.
      ...(chatSurfaceIds.has(siteId) && !answerableIds.has(siteId) && withheldBy.has(siteId)
        ? {
            chatWithheld: {
              class: withheldBy.get(siteId)!.class,
              reason: withheldBy.get(siteId)!.reason,
            },
          }
        : {}),
      tools,
      ...(accounts !== undefined ? { accounts } : {}),
      ...(accountsSummary !== undefined ? { accountsSummary } : {}),
    });
  }
  return packages;
}