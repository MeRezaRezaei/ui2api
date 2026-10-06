import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  chatSurfaceStatus,
  listInstalledPackageIds,
  findPackageDir,
  readRoundTripRecord,
  measuredRoundTripFor,
  resolveRoundTripVerdict,
  roundTripProbeAdvice,
  defaultChatSurface,
  buildRegistryPackages,
} from "../src/prompt/registry.js";
import { classifyOutcome, composerRefusalMatcher, controlAbsentClauses, VERIFICATION_CLASSES, type VerificationClass } from "../src/prompt/verification-class.js";
import { NO_ANSWER_REFUSAL_CLAUSE } from "../src/prompt/error-redaction.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE ROUND-TRIP RECORD-TRUTH GATE
//
// WHAT THIS IS NOT, stated first because the sibling gate is explicit about it:
// this does NOT prove any site answers. A hermetic "does it answer" test is not
// buildable here — CI has no vault session, no Chrome owner and no browser, and
// shipping one would fabricate the answer, the exact class
// test/no-fabricated-traffic.test.ts exists to forbid. So this gate proves
// something narrower and still load-bearing:
//
//   A PUBLISHED `verified` claim and a MEASURED round trip can never disagree.
//
// THE DEFECT THIS KILLS. `capabilities/model-verification.json` looked like the
// machine-derivable round-trip record and was not one. Measured before this
// gate: nothing in the repo writes it (`scripts/audit/measure-models.mjs:101`
// only `console.log`s its result, and its `source.harness` names a `/tmp`
// script), its decisive field is PROSE (`evidence` quotes the answer), and its
// two ANSWERS rows carry no `answerText` field at all even though the reader
// prefers `r.answerText` (test/model-verification-consistent.test.ts:255) and
// falls back to a regex over that prose. So all 22 rows were hand-transcribed,
// and a `verified` claim in capabilities/README.md rested on nothing a machine
// can check. `test/site-status-truth.test.ts` already named this as its own
// HONEST LIMIT (its header, lines 53-75: "the round-trip EVIDENCE is prose…
// isCompleteVerifiedRecord is therefore a RECORD-SHAPE gate, not proof a round
// trip happened"). This file is that named limit, closed.
//
// THE THREE SETS, and they are three DIFFERENT claims:
//   CLAIMED   — the package's own capabilities/<id>/metadata.json carries a
//               complete verified receipt (verified.since/evidence/via non-empty).
//   PUBLISHED — capabilities/README.md's status cell claims a live round trip.
//   MEASURED  — capabilities/roundtrip.json carries a row that is genuinely
//               measured: provenance=harness AND probeNonceMatched=true AND
//               class=ANSWERS AND a 2xx AND answerChars>0 AND doneReason=stable
//               AND measuredAt inside the staleness window.
//
// WHY THE UNIVERSE IS DERIVED (installed packages ∪ README rows) and never a
// literal: a hand-typed list in a test file is a snapshot, and a snapshot rots
// the moment a gate tightens — the "11 builtins vs 10 surfaced" error, made and
// fixed repeatedly in AGENTS.md. A new package is inside this check on arrival.
//
// WHY THIS GATE IS EXPECTED TO BE RED, stated up front so a red run is not read
// as a bug in the gate: as shipped, 7 packages hold a receipt and publish the
// claim, and 0 of them have a MEASURED row — because measuring them requires a
// live daemon with a real vault session and a Chrome owner, which no agent and
// no CI can supply. The gap is named per-site in `knownGaps` in the record, and
// the gate asserts that named set equals the gap it derives. So the RED is the
// finding, not a relaxed predicate: the alternative — weakening the predicate
// until it passes — would recreate exactly the defect this file exists to kill.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const RECORD_PATH = resolve(ROOT, "capabilities/roundtrip.json");
const README_PATH = resolve(ROOT, "capabilities/README.md");

const nonEmptyStr = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;

// ── the record ──────────────────────────────────────────────────────────────
const record = readRoundTripRecord();
const raw = JSON.parse(readFileSync(RECORD_PATH, "utf8")) as Record<string, unknown>;
const rows = (Array.isArray(raw.rows) ? raw.rows : []) as Record<string, unknown>[];
const windowDays = record.stalenessWindowDays;

/**
 * Resolve a site against an INJECTED record — a byte-identical copy of the
 * shipped one, or a derived mutation of it.
 *
 * WHY NOT WRITE A COPY TO DISK. `capabilities/roundtrip.json` is written ONLY by
 * the harness (`scripts/audit/record-roundtrip.mjs`); a hand-edited row would be
 * a fabricated measurement, and swapping one in to run a test then swapping it
 * back is exactly the shape of accident this repo's gates exist to prevent. So
 * the copy never touches the file: `resolveRoundTripVerdict` takes the record as
 * data, the schema/window come from the REAL record so a mutation cannot invent a
 * longer window, and the rows are the real rows.
 */
function resolveWithRecord(rawRecord: Record<string, unknown>, siteId: string) {
  const parsed = rawRecord as { rows?: unknown; stalenessWindowDays?: unknown };
  return resolveRoundTripVerdict(
    {
      // The refusal/schema are the REAL record's, so a mutation cannot smuggle in
      // a wider window or a different schema and have its verdict mean something
      // the shipped resolver would never say.
      refusal: null,
      schema: record.schema,
      stalenessWindowDays:
        typeof parsed.stalenessWindowDays === "number" && Number.isFinite(parsed.stalenessWindowDays) && parsed.stalenessWindowDays > 0
          ? parsed.stalenessWindowDays
          : windowDays,
      rows: Array.isArray(parsed.rows) ? (parsed.rows as Parameters<typeof resolveRoundTripVerdict>[0]["rows"]) : [],
    },
    siteId,
    // The SAME clock the shipped gate reads with, so an age comparison cannot
    // differ between the real verdicts and the mutated one.
    Date.now(),
  );
}

// ── the other two sources ───────────────────────────────────────────────────
function parseStatusRows(doc: string): { id: string; status: string }[] {
  const out: { id: string; status: string }[] = [];
  for (const m of doc.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|\s*([^|]*)\|/gm)) out.push({ id: m[1]!, status: m[2]! });
  return out;
}
const readme = readFileSync(README_PATH, "utf8");

/** A README status cell reads as a round-trip claim the way a consumer scanning
 *  the table reads it. Reuses the sibling gate's own predicate via its exported
 *  helpers is NOT possible (it is a test file), so this mirrors it exactly —
 *  and the mirror is itself checked below against chatSurfaceStatus. */
const CLAIM_RE = /\bverified\b|\bround-?trip\b/i;
const CLAIM_EXCLUDE = /never claimed verified|unverified-candidate|not verified|auth verified|auth-verified|no chat surface|dead-?end|dormant|scaffold/i;
const publishedRoundTripIds = (): string[] =>
  [...new Set(parseStatusRows(readme).filter((r) => CLAIM_RE.test(r.status) && !CLAIM_EXCLUDE.test(r.status)).map((r) => r.id))].sort();

/** The receipt predicate, applied INDEPENDENTLY to each package's own file, so
 *  the resolver in src/prompt/registry.ts is cross-checked rather than trusted. */
function hasCompleteReceipt(id: string): boolean {
  const dir = findPackageDir(id);
  if (!dir) return false;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(resolve(dir, "metadata.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const v = meta.verified as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") return false;
  return nonEmptyStr(v.since) && nonEmptyStr(v.evidence) && nonEmptyStr(v.via);
}

const universe = (): string[] =>
  [...new Set([...listInstalledPackageIds(), ...parseStatusRows(readme).map((r) => r.id)])].sort();

const claimedIds = (): string[] => universe().filter(hasCompleteReceipt).sort();
const publishedIds = (): string[] => publishedRoundTripIds();

/** MEASURED — the same predicate the READ SEAM uses (registry.ts
 *  `measuredRoundTripFor`), called over the derived universe. Derived from the
 *  reader rather than re-implemented, so the gate and the resolver cannot
 *  disagree about what counts as measured. */
const measuredIds = (): string[] => universe().filter((id) => measuredRoundTripFor(id).measured).sort();

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE THREE-WAY SET EQUALITY
// ─────────────────────────────────────────────────────────────────────────────

/** A readable, one-line-per-site report of all three sides, so a red run names
 *  the divergence instead of just saying the sets differ.
 *
 *  THE MEASURED CELL HAS FOUR READINGS, not two, because three different facts
 *  were being printed as one. `measuredRoundTripFor` distinguishes them, and a
 *  report that collapsed any pair of them would be the understatement this lane
 *  exists to remove:
 *
 *    MEASURED yes                            — a round trip WORKED and is recorded.
 *    MEASURED no — CONTRADICTED by <class>   — a round trip was PERFORMED and the
 *                                               surface DID NOT WORK. Asking and
 *                                               failing is not never asking.
 *    MEASURED no — QUALIFIED by <class>      — a round trip was performed, the
 *                                               argument it was given did not
 *                                               deliver, and the refusal names its
 *                                               candidates without choosing one. It
 *                                               is not evidence about the surface,
 *                                               so it must not demote — and it is
 *                                               not an absence either, so it must
 *                                               not print as bare `no`.
 *    MEASURED no                             — nothing was established.
 *
 *  AND THE `yes` CELL IS NOT BARE. A site whose surface measured while one of
 *  its capabilities did not is printed `yes — but LIMITED by <cap> <class>`,
 *  because `measuredRoundTripFor` now resolves PER CAPABILITY and a bare `yes`
 *  for `youtube` would put `youtube_search`'s 10 rows and `youtube_transcript`'s
 *  HTTP 502 in the same cell — which is precisely how the failing capability was
 *  invisible before this lane: the healthy sibling answered first and the
 *  failing row was never read.
 *
 *  MEASURED, before this gate could say it: `kimi` and `tencent-aistudio` carried
 *  `UNATTRIBUTED-NO-ANSWER` rows and `deepseek` an `UNATTRIBUTED-NO-COMPOSER` one,
 *  and every one of them printed as plain `MEASURED no` — indistinguishable from a
 *  site with no row at all. The third reading arrived with
 *  `UNATTRIBUTED-NO-TRANSCRIPT`: `youtube_transcript` performs a real round trip,
 *  is refused by the site's own page for ONE video, and would have been filed as
 *  a surface failure had the vocabulary not distinguished a scoped non-delivery
 *  from a real one. */
function threeWayReport(): string[] {
  const claimed = new Set(claimedIds());
  const published = new Set(publishedIds());
  const measured = new Set(measuredIds());
  return universe()
    .filter((id) => claimed.has(id) || published.has(id) || measured.has(id))
    .map((id) => {
      const verdict = measuredRoundTripFor(id);
      const measuredCell = verdict.measured
        ? verdict.limitation === null
          ? "yes"
          : `yes — but LIMITED by ${verdict.limitation.capability} ${String(verdict.limitation.class)}`
        : verdict.contradicted
          ? `no — CONTRADICTED by ${String(verdict.failureClass)}`
          : verdict.qualified
            ? `no — QUALIFIED by ${String(verdict.qualifiedClass)}`
            : "no ";
      const sides = [
        `CLAIMED ${claimed.has(id) ? "yes" : "no "}`,
        `PUBLISHED ${published.has(id) ? "yes" : "no "}`,
        `MEASURED ${measuredCell}`,
      ].join(" | ");
      return `  ${id.padEnd(20)} ${sides}`;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE REMEDIATION ADVICE — a gate you can ACT on
//
// THE DEFECT THIS KILLS. The gap message used to close itself with ONE hardcoded
// line, for every site:
//
//     Close it by running `node scripts/audit/record-roundtrip.mjs --site youtube
//     --capability chat`
//
// MEASURED: `youtube` has NO chat. Its manifest declares no chat capability and
// says so in prose ("No chat composer exists; no chat capability is registered"),
// its `builtinProfile` is "none", its `profile.json` carries `composer:[]`
// `answer:[]`, and it is absent from `GET /sites`. So `--capability chat` is a
// capability the package does not declare — the daemon answers HTTP 400
// `unknown capability "chat" for "youtube"` — and the invocation also omitted the
// `--import tsx` loader the harness documents as REQUIRED in a source checkout.
// A remediation message is the one part of a gate a reader ACTS on, so an
// unexecutable one fails a reader who followed it correctly, and the failure
// reads as the tool being broken. That is the "a checker that cannot express
// what the code does" class in its most actionable form.
//
// DERIVED, NOT TEMPLATED. `roundTripProbeAdvice` (src/prompt/registry.ts) reads the
// package's manifest, filters it through the SAME `validManifestCapability` the
// registry serves, and takes each capability's arguments from the SAME declared
// `inputSchema` contract (`declaredCapabilityInputSchema`) — never the regex
// guess. Chat-ness comes from `defaultChatSurface()`, the exact gate promptd's
// `/v1` allow-list is built from. So the advice cannot name a capability the site
// lacks, cannot omit one it has, and cannot invent an argument shape.
//
// WHY IT NEVER EXECUTES ANYTHING. Formatting a string from a manifest is the whole
// scope: no browser, no daemon connection, no harness run. A gate that measured
// its own advice would need a live session it can never have in CI.
// ─────────────────────────────────────────────────────────────────────────────

function remediationFor(id: string): string {
  const advice = roundTripProbeAdvice(id);
  if (advice.note !== null) return `${advice.note} Never edit the record by hand.`;
  const lines = advice.commands.map((c) => `  ${c}`).join("\n");
  const shape = advice.chat
    ? `\`${id}\` IS on the daemon's chat surface (GET /sites), so probe it as chat FIRST — that is the only shape that derives class ANSWERS — and then each capability it declares:`
    : `\`${id}\` has NO chat surface (it is absent from GET /sites), so it cannot be probed as chat at all; probe the ${advice.capabilities.length} capabilit${advice.capabilities.length === 1 ? "y" : "ies"} its own manifest declares:`;
  return (
    `Close it against a live daemon by running ONE of these — never by editing the record by hand. ` +
    `${shape}\n${lines}\n` +
    `Replace each \`<…>\` placeholder with a real argument value (they come from the manifest's own declared ` +
    `required args — a gate may not invent the query or the id a live probe needs).`
  );
}

/** Every `--capability X` the REMEDY A READER RECEIVES names, in order — read
 *  through `remedyFor`, the same function the failure message is built from, so
 *  no path can print advice that bypasses these pins. */
function remedyCapabilities(id: string): string[] {
  return [...remedyFor(id).matchAll(/--capability (\S+)/g)].map((m) => m[1]!);
}

/** ONE function builds the remedy, so a pin can read the string a reader
 *  actually receives. Measured, why this exists: the first version of these pins
 *  called `roundTripProbeAdvice()` directly, and when the hardcoded
 *  `--capability chat` string was put back into the message they STILL PASSED —
 *  a pin on the derivation is worth nothing if the printed message can bypass
 *  it. This is the only path from a verdict to the advice a reader is given. */
function remedyFor(id: string): string {
  const v = measuredRoundTripFor(id);
  if (v.contradicted) {
    return `A round trip WAS measured for \`${id}\` and it FAILED (${String(v.failureClass)}), which CONTRADICTS the published claim rather than qualifying it — ` +
      `re-measure only after the named condition is addressed; re-running the same probe reproduces the same honest failure.`;
  }
  if (v.qualified) {
    return `A round trip WAS measured for \`${id}\`, the argument it was given did not deliver (${String(v.qualifiedClass)}), and the refusal names its ` +
      `candidate causes without choosing one — so this is NOT a surface failure and re-running the SAME probe reproduces it. Close it by probing ` +
      `an argument the surface can serve, or by addressing what the class's own evidence names.`;
  }
  return remediationFor(id);
}

/** Every `--capability X` the advice names, in order. */
function adviceCapabilities(advice: ReturnType<typeof roundTripProbeAdvice>): string[] {
  return advice.commands
    .map((c) => /--capability (\S+)/.exec(c)?.[1])
    .filter((x): x is string => typeof x === "string");
}

test("THREE-WAY: every published round-trip claim is backed by a MEASURED row, and every measured row backs a published claim", () => {
  const gaps: string[] = [];
  const unbackedClaims = claimedIds().filter((id) => !measuredIds().includes(id));
  for (const id of unbackedClaims) {
    const v = measuredRoundTripFor(id);
    // THE REMEDY IS NOT THE SAME for the three negatives, and printing one remedy
    // for all of them is how a measured failure gets "fixed" by re-running the
    // same measurement forever. Built by `remedyFor`, so the pin below reads the
    // SAME string this pushes into the failure message.
    const remedy = remedyFor(id);
    gaps.push(
      `\`${id}\` holds a complete verified receipt AND publishes a live round-trip claim in capabilities/README.md, ` +
        `but capabilities/roundtrip.json carries no MEASURED row: ${v.reason}. ${remedy}`,
    );
  }
  assert.deepEqual(
    gaps,
    [],
    `claims with no measured round trip (${unbackedClaims.length} of ${claimedIds().length} claimed):\n` +
      threeWayReport().join("\n") +
      `\n\nEach gap above is a REAL, currently-published claim the record cannot back.`,
  );
});

test("ADVICE: every DECLARED capability of every reported site appears in that site's advice, and no UNDECLARED one does", () => {
  // THE WHOLE UNIVERSE, not a spot check. The gate reports on
  // installed ∪ README-row ids, so the advice is asserted for every one of them:
  // both directions, because a template satisfies neither.
  //
  //   DIRECTION 1 (no omission): every id the manifest declares must be named.
  //   DIRECTION 2 (no fabrication): nothing else may be named — `chat` is legal
  //     ONLY on a site that is genuinely on the chat surface, which is what makes
  //     the youtube regression unprintable rather than merely unlikely.
  const offenders: string[] = [];
  for (const id of universe()) {
    const advice = roundTripProbeAdvice(id);
    const named = adviceCapabilities(advice);
    const declared = advice.capabilities;
    if (advice.note !== null) {
      // shape "none": nothing to name, and it must say so rather than emit a command.
      if (named.length > 0) offenders.push(`\`${id}\` claims no surface yet names ${named.join(", ")}`);
      continue;
    }
    // THE REMEDY A READER RECEIVES, not only the derivation: `remedyFor` is what
    // the failure message is built from, so this reads the printed string. A
    // CONTRADICTED/QUALIFIED site legitimately gets PROSE (re-running the same
    // probe reproduces the same honest failure), so its remedy names no command
    // and is exempt from the command assertions — asserted to be prose below.
    const remedy = remedyFor(id);
    const remedyCaps = remedyCapabilities(id);
    const v = measuredRoundTripFor(id);
    if (v.contradicted || v.qualified) {
      if (remedyCaps.length > 0) {
        offenders.push(`\`${id}\` is ${v.contradicted ? "CONTRADICTED" : "QUALIFIED"} yet its remedy hands out a command (${remedyCaps.join(", ")}) — re-running the same probe reproduces the same honest failure`);
      }
      continue;
    }
    const missing = declared.filter((c) => !remedyCaps.includes(c));
    if (missing.length > 0) {
      offenders.push(`\`${id}\` declares ${missing.join(", ")} but its advice never names them — a reader is left unable to close it`);
    }
    const extra = remedyCaps.filter((c) => c !== "chat" && !declared.includes(c));
    if (extra.length > 0) {
      offenders.push(`\`${id}\` names ${extra.join(", ")} which its manifest does NOT declare — the daemon answers HTTP 400 unknown_capability for that`);
    }
    const chatNamed = remedyCaps.includes("chat");
    if (chatNamed !== advice.chat) {
      offenders.push(
        `\`${id}\`: the printed advice names \`--capability chat\`=${String(chatNamed)} but the daemon's chat surface says ${String(advice.chat)}`,
      );
    }
    // The chat sentinel, when present, must come FIRST: it is the only shape that
    // can derive ANSWERS, so a reader who starts at the capability list is told to
    // re-measure something that can only ever record RETURNS-DATA.
    if (advice.chat && remedyCaps[0] !== "chat") offenders.push(`\`${id}\` has a chat surface but does not probe as chat FIRST`);
    // …and the derivation and the printed remedy must AGREE, capability for
    // capability. Two readers of the same data is the defect class; a pin that
    // lets them diverge is how the youtube message came back.
    assert.deepEqual(remedyCaps, named, `\`${id}\`: the printed remedy and the derivation name different capabilities`);
  }
  assert.deepEqual(offenders, [], `remediation advice that cannot be executed:\n${offenders.join("\n")}`);
});

test("ADVICE: every printed command matches the harness's REAL CLI contract, and every --args is a JSON object", () => {
  // Matched to the shipped harness, not to a remembered spelling:
  // scripts/audit/record-roundtrip.mjs reads `--site` / `--capability` / `--args`
  // / `--dry-run`, REQUIRES `--import tsx` in a source checkout (no dist/), and
  // refuses `--args` that is not a JSON OBJECT.
  const harness = readFileSync(resolve(ROOT, "scripts/audit/record-roundtrip.mjs"), "utf8");
  const offenders: string[] = [];
  for (const id of universe()) {
    const advice = roundTripProbeAdvice(id);
    for (const cmd of advice.commands) {
      if (!cmd.startsWith("node --import tsx scripts/audit/record-roundtrip.mjs ")) {
        offenders.push(`\`${id}\`: \`${cmd}\` — the harness requires the --import tsx loader in a source checkout`);
      }
      if (!/ --site [a-z0-9-]+( |$)/.test(cmd)) offenders.push(`\`${id}\`: \`${cmd}\` carries no --site <id>`);
      const m = /--args '([^']*)'/.exec(cmd);
      if (m) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(m[1]!);
        } catch (e) {
          offenders.push(`\`${id}\`: \`${cmd}\` carries --args that is not valid JSON (${(e as Error).message})`);
          continue;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          offenders.push(`\`${id}\`: \`${cmd}\` carries --args that is not a JSON OBJECT — the harness refuses exit 3`);
        }
      }
    }
    // The advice must not drift from the harness's own vocabulary. Checked against
    // how the script ACTUALLY reads a flag — `flag("site")` / `has("dry-run")`,
    // not a literal `--site` (which is why the first version of this check found
    // nothing and reported every flag as unknown). `--import` is node's own loader
    // flag, consumed before the script runs, so it is exempt by construction.
    const harnessFlags = new Set<string>();
    for (const m of harness.matchAll(/\b(?:flag|has)\("([a-z-]+)"\)/g)) harnessFlags.add(`--${m[1]!}`);
    for (const cmd of advice.commands) {
      for (const m of cmd.matchAll(/ (--[a-z-]+)/g)) {
        const flagName = m[1]!;
        if (flagName === "--import") continue;
        if (!harnessFlags.has(flagName)) {
          offenders.push(`\`${id}\`: the advice prints ${flagName}, which scripts/audit/record-roundtrip.mjs never reads (it reads: ${[...harnessFlags].sort().join(" ")})`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `advice that does not match the harness contract:\n${offenders.join("\n")}`);
});

test("ADVICE: a site with neither a chat surface nor a declared capability says so — never an empty or invented command", () => {
  // The falsifier for the honest-empty branch. MEASURED, no shipped package is in
  // this state (all 33 declare capabilities and 22 are on the chat surface), so the
  // branch is exercised through a PROVEN-ABSENT id rather than left unproven: a
  // reader who lands on it must get a named reason, not `--capability chat` and
  // not an empty string that looks like a command.
  const advice = roundTripProbeAdvice("no-such-package-in-this-repo");
  assert.equal(advice.shape, "none");
  assert.equal(advice.chat, false);
  assert.deepEqual(advice.commands, [], "a surface-less site must produce NO command at all");
  assert.ok(advice.note !== null && advice.note.length > 0, "a surface-less site must produce a NAMED reason, not silence");
  assert.match(advice.note!, /nothing this gate can tell you to run/, "the note must say plainly that there is nothing to run");
  assert.doesNotMatch(advice.note!, /--capability/, "the note must not emit a command it is refusing to recommend");

  // AND the branch is not hypothetical: a REAL reported id derives it. MEASURED,
  // `hunyuan-yuanbao` is a capabilities/README.md row (so the gate reports on it)
  // whose dir carries only CAPABILITIES.md — no manifest.json, hence no declared
  // capability — and it is not on the chat surface either. So the honest-refusal
  // branch is exercised by the shipped universe, not only by a synthetic id.
  const shapeNone = universe().filter((id) => roundTripProbeAdvice(id).shape === "none");
  assert.ok(
    shapeNone.length > 0,
    `no reported id derives shape "none", so the honest-refusal branch is unexercised — \`${"no-such-package-in-this-repo"}\` exercises it in this test, but a shipped id must too`,
  );
  for (const id of shapeNone) {
    const advice = roundTripProbeAdvice(id);
    assert.deepEqual(advice.commands, [], `\`${id}\` derives shape "none" yet emits ${advice.commands.length} command(s)`);
    assert.ok(advice.note !== null && advice.note.length > 0, `\`${id}\` derives shape "none" with NO note`);
    assert.doesNotMatch(advice.note!, /--capability/, `\`${id}\`'s refusal note emits a command it is refusing to recommend`);
  }
  // Both derivable shapes are exercised too, so "none" is a refusal rather than
  // the common case hiding behind a green run.
  const shapes = new Set(universe().map((id) => roundTripProbeAdvice(id).shape));
  assert.ok(shapes.has("chat"), `the universe exercises no chat-shaped site, so the chat advice shape is unexercised: [${[...shapes].join(", ")}]`);
  assert.ok(shapes.has("capability"), `the universe exercises no capability-only site, so the capability advice shape is unexercised: [${[...shapes].join(", ")}]`);
});

test("ADVICE: the youtube regression is unprintable — a capability-only site is never told to probe as chat", () => {
  // The named defect, pinned at the site it happened on rather than described in
  // prose. `youtube` is the package whose advice used to be
  // `--site youtube --capability chat`: no chat composer, no `*_chat` capability,
  // `builtinProfile: "none"`, `profile.json` composer/answer both empty, and
  // absent from GET /sites. If a future change ever makes youtube chat-shaped, the
  // first assertion below fires and this test must be revisited deliberately —
  // which is the point: the pin fails LOUD rather than quietly becoming a lie.
  const advice = roundTripProbeAdvice("youtube");
  assert.equal(advice.chat, false, "youtube grew a chat surface — this pin names the old fact and must be re-derived, not deleted");
  assert.ok(
    !defaultChatSurface().some((e) => e.id === "youtube"),
    "youtube appeared on GET /sites — the chat advice shape would then be correct for it and this pin must be re-derived",
  );
  // NOT asserted, and deliberately so: `chatSurfaceStatus("youtube")` is `verified`
  // and that is CORRECT — it is the PACKAGE's status (youtube_search measures
  // RETURNS-DATA), not a claim that youtube has a chat composer. It was this
  // conflation that made the old advice look reasonable: a reader who saw
  // `verified` for youtube and was then told to probe `--capability chat` had no
  // signal that the two facts were about different surfaces. The advice therefore
  // derives chat-ness from `defaultChatSurface()` — the surface `/v1` actually
  // serves — and this pin holds THAT, not the package status.
  assert.ok(
    !remedyFor("youtube").includes("--capability chat"),
    "the youtube advice still tells the reader to probe a chat surface youtube does not have",
  );
  assert.match(remedyFor("youtube"), /has NO chat surface/);
  // …and it names the surface that IS there, with its declared argument shape.
  assert.match(remedyFor("youtube"), /--capability youtube_search --args '\{"query":"<query>"\}'/);
});

test("THREE-WAY: an ARGUMENT-SCOPED non-delivery is QUALIFIED — never CONTRADICTED, and never MEASURED either", () => {
  // THE DIRECTION OF THE THIRD READING. A `verified` claim is a claim about the
  // SURFACE; a refusal scoped to one argument the harness supplied is a claim
  // about that argument. MEASURED, the case: `youtube_transcript` performs a real
  // round trip and the site's page offers no transcript control for THAT video —
  // a condition whose own sentence lists two candidate causes (no captions /
  // stale selectors) and chooses neither.
  //
  // So all three properties are asserted here, and the middle one is the teeth:
  // it must NOT become a contradiction, because that would assert a surface-wide
  // failure from a target-scoped observation, and it must NOT become MEASURED,
  // because that would promote a surface nothing has shown working. The two
  // halves together are what make "qualifies" a real third answer instead of a
  // softer synonym for "unmeasured".
  const verdicts = universe().map((id) => ({ id, v: measuredRoundTripFor(id) }));
  const qualifying = verdicts.filter((x) => x.v.qualified);
  // Not a pass by default: a record carrying no qualifying row cannot exercise
  // this branch, so say so rather than let a green run prove nothing about it.
  if (qualifying.length === 0) {
    assert.ok(
      rows.some((r) => r.class === "UNATTRIBUTED-NO-TRANSCRIPT"),
      "capabilities/roundtrip.json carries no UNATTRIBUTED-NO-TRANSCRIPT row — the QUALIFIED branch below is unexercised, so a green run here would prove nothing about it",
    );
    return;
  }
  assert.deepEqual(
    qualifying.filter((x) => x.v.contradicted || x.v.measured).map((x) => x.id),
    [],
    `a site whose round trip only QUALIFIED was also reported as contradicted or measured:\n${threeWayReport().join("\n")}`,
  );
  for (const { id, v } of qualifying) {
    assert.equal(typeof v.qualifiedClass, "string", `${id}: a qualifying verdict must NAME the class that qualified it`);
    assert.ok(
      v.reason.includes(String(v.qualifiedClass)),
      `${id}: the reason must quote the class so a reader does not have to re-derive it`,
    );
    assert.match(v.reason, /does NOT CONTRADICT/, `${id}: the reason must state the direction it decided`);
    assert.match(v.reason, /does NOT PROMOTE/, `${id}: the reason must state that it did not promote either`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PER-CAPABILITY RESOLUTION — the healthy sibling must not average a broken
// capability away
//
// THE GAP. `measuredRoundTripFor` was per-SITE: it filtered the record to the
// site, took the FIRST settled row it found, and returned `measured: true` — so
// `youtube_search` (10 real rows read off the site's own results page) answered
// first and `youtube_transcript`'s HTTP 502 `UNATTRIBUTED-NO-TRANSCRIPT` was
// never looked at. A `/registry` consumer saw a `verified` package with seven
// equally-present tools and nothing distinguishing the one that answers from the
// one that 502s.
//
// IT IS THE SAME CLASS AS EVERY OTHER GAP THIS ROUND HAS CLOSED, and that is why
// it is worth naming rather than filing as a feature: the vocabulary gained
// `UNATTRIBUTED-NO-TRANSCRIPT` PRECISELY so this honest outcome would be
// RECORDED — and then the resolver discarded the record. A measurement nobody
// can act on is the same defect as a measurement never taken.
//
// THE THREE READINGS ARE UNCHANGED. This adds a RESOLUTION (per capability) and
// a fourth state OF A MEASURED SITE (healthy with a named limitation), never a
// fourth overall verdict: `measured` is still `true` for youtube, because a
// published claim is about the SURFACE and the surface answered.
// ─────────────────────────────────────────────────────────────────────────────

test("PER-CAPABILITY: every measured site resolves EACH capability separately, and a non-delivering one is named with its class", () => {
  // PIN 1 — THE STRUCTURE. The site verdict must be FOLDED from a per-capability
  // array rather than computed per-site, which is asserted structurally: the
  // array must exist, be non-empty for any site with rows, and agree with the
  // site verdict on every reading. A resolver that kept one row per site would
  // have no array to agree with.
  for (const id of universe()) {
    const v = measuredRoundTripFor(id);
    const siteRows = rows.filter((r) => r.site === id);
    if (siteRows.length === 0) {
      assert.deepEqual(v.capabilities, [], `${id}: no rows in the record means no per-capability readings`);
    } else {
      assert.ok(v.capabilities.length > 0, `${id}: the record carries rows but the per-capability resolution is empty`);
      // ANTI-VACUITY, and the half that matters: agreement between the array and
      // the verdict is NOT enough, because a resolver that collapsed every row
      // into ONE synthetic entry ("SITE") satisfies every agreement assert above
      // while having resolved nothing per capability. MEASURED, that is exactly
      // what happened when this pin was first written: reverting the resolver to
      // a per-site key left this test GREEN and reddened only the two pins that
      // happen to look at youtube. So the array must carry ONE ENTRY PER
      // DISTINCT CAPABILITY the record names — derived from the record, never
      // from the resolver, so a collapse cannot reduce the expectation.
      const declared = [
        ...new Set(
          siteRows
            .map((r) => (typeof r.capability === "string" && r.capability ? r.capability : "(unnamed)"))
            .filter((c) => siteRows.some((r) => c === (typeof r.capability === "string" && r.capability ? r.capability : "(unnamed)"))),
        ),
      ].sort();
      assert.deepEqual(
        v.capabilities.map((c) => c.capability).slice().sort(),
        declared,
        `${id}: the per-capability resolution does not carry one entry per capability the record names (a per-site collapse would satisfy every other assert in this test and prove nothing)\n  resolved: ${v.capabilities.map((c) => c.capability).join(", ")}`,
      );
    }
    // AGREEMENT, both directions: a capability the fold called `measured` cannot
    // sit on a site the fold called unmeasured-with-no-success, and a site called
    // contradicted must have at least one contradicting capability. This is what
    // makes the array the SOURCE of the verdict rather than a decoration beside it.
    const at = (reading: string) => v.capabilities.filter((c) => c.reading === reading);
    assert.equal(
      v.measured,
      at("measured").length > 0,
      `${id}: \`measured\` disagrees with the per-capability array (measured=${String(v.measured)}, measured capabilities=${String(at("measured").length)})\n${threeWayReport().join("\n")}`,
    );
    assert.equal(
      v.contradicted,
      at("contradicted").length > 0,
      `${id}: \`contradicted\` disagrees with the per-capability array\n${threeWayReport().join("\n")}`,
    );
    assert.equal(
      v.qualified,
      !v.measured && !v.contradicted && at("qualified").length > 0,
      `${id}: \`qualified\` disagrees with the per-capability array\n${threeWayReport().join("\n")}`,
    );
    // The limitation is not a fourth verdict: it is a projection of the SAME
    // array, so it can only exist where a measured capability coexists with a
    // qualifying one, and it must name a capability that really is in the array.
    if (v.limitation !== null) {
      assert.equal(v.measured, true, `${id}: a limitation on a site that is not measured has no claim to qualify`);
      const named = v.capabilities.find((c) => c.capability === v.limitation!.capability);
      assert.ok(named !== undefined, `${id}: the limitation names \`${v.limitation.capability}\`, which is not in the per-capability array`);
      assert.equal(named!.reading, "qualified", `${id}: the limitation names a capability whose reading is \`${named!.reading}\` — only a QUALIFYING capability may be a limitation`);
      assert.equal(v.limitation!.class, named!.class, `${id}: the limitation's class disagrees with the per-capability reading it names`);
      assert.ok(v.reason.includes(v.limitation!.capability), `${id}: the reason must NAME the limiting capability, not merely carry it as a field`);
      assert.ok(v.reason.includes(String(v.limitation!.class)), `${id}: the reason must quote the limitation's class`);
    }
    if (v.measured && v.limitation === null) {
      // The other half of the projection: a site with NO qualifying capability
      // must carry no limitation. Without this, an always-populated `limitation`
      // would pass pin 1 vacuously.
      assert.deepEqual(
        at("qualified"),
        [],
        `${id}: measured with no limitation yet the array carries a qualifying capability`,
      );
    }
  }
});

test("PER-CAPABILITY: the shipped record's youtube limitation is VISIBLE at the level a reader acts on", () => {
  // PIN 2 — THE MEASURED CASE. Not a synthetic fixture: the shipped record
  // carries exactly this pair, so the pin reads the real thing. If a future
  // re-probe closes the gap, the row stops deriving and this pin goes RED with a
  // message that says the limitation cleared — which is the point: a limitation
  // that CANNOT clear is not a measurement.
  const v = measuredRoundTripFor("youtube");
  if (v.limitation === null) {
    assert.ok(
      !rows.some((r) => r.site === "youtube" && r.class === "UNATTRIBUTED-NO-TRANSCRIPT"),
      "capabilities/roundtrip.json carries no UNATTRIBUTED-NO-TRANSCRIPT row for youtube — the limitation branch is unexercised, so a green run here would prove nothing about it",
    );
    return;
  }
  // The claim STANDS: a limitation qualifies, it does not demote, and it never
  // promotes either. Asserted so this lane cannot be "fixed" by making youtube
  // unmeasured — which would make the failure invisible in a second way.
  assert.equal(v.measured, true, "a QUALIFYING capability limitation must not demote a site whose surface measured");
  assert.equal(v.contradicted, false, "a qualifying capability is not a contradiction");
  assert.equal(v.qualified, false, "a site that measured is not `qualified` — that reading means the site did NOT measure");
  assert.equal(v.limitation.capability, "youtube_transcript", "the limitation must name the capability that failed, not the one that worked");
  assert.equal(v.limitation.class, "UNATTRIBUTED-NO-TRANSCRIPT", "the limitation must carry the DERIVED class a consumer branches on");
  // …and the healthy sibling is still reported healthy, at ITS own resolution.
  const search = v.capabilities.find((c) => c.capability === "youtube_search");
  assert.ok(search !== undefined, "youtube_search's measured reading disappeared from the per-capability array");
  assert.equal(search!.reading, "measured", "youtube_search measures 10 real rows — collapsing that into anything else would be the defect in reverse");
  assert.equal(search!.class, "RETURNS-DATA");
  // The array must not MERGE the two into one entry: that merge IS the bug.
  assert.equal(v.capabilities.length, 2, `youtube must resolve to exactly its two recorded capabilities, not a merged single reading (got ${v.capabilities.map((c) => c.capability).join(", ")})`);
});

test("PER-CAPABILITY: a capability-level CONTRADICTION can demote an otherwise-healthy site", () => {
  // PIN 3 — THE DIRECTION, DECIDED AND PINNED. The task asked for an explicit
  // decision here, and the decision is YES, for a reason that is not symmetry:
  // whether a non-delivery is a statement about the SURFACE is a property of its
  // CLASS, and the classifier already owns that answer (`falsifiesClaim`,
  // imported by the resolver, never restated). A row whose class says "this
  // surface did not work" says so whether it came from the chat endpoint or from
  // `youtube_search`; restricting demotion to chat rows would restate the
  // per-site collapse one rung down.
  //
  // EXERCISED ON A BYTE-IDENTICAL COPY of the shipped record, then restored —
  // never on the record itself, which is written only by the harness. The copy
  // is built by DERIVING from the real one (deepseek's own contradicting chat
  // row is re-pointed at an araprat search capability), so the rows it contains
  // are rows the classifier actually derived and the pin cannot be satisfied by
  // inventing a class.
  const araprat = buildRegistryPackages().find((p) => p.id === "araprat");
  if (!araprat) {
    assert.fail("araprat is not in the registry — this pin needs a healthy multi-capability package to contradict");
  }
  const deepseekFailure = rows.find((r) => r.site === "deepseek" && r.class === "UNATTRIBUTED-NO-COMPOSER");
  if (!deepseekFailure) {
    assert.fail(
      "the record carries no UNATTRIBUTED-NO-COMPOSER row — the falsifying branch is unexercised, so a green run here would prove nothing about it",
    );
  }
  const healthy = rows.filter((r) => r.site === "araprat" && r.class === "RETURNS-DATA");
  if (healthy.length === 0) {
    assert.fail("araprat carries no healthy RETURNS-DATA row — there is nothing healthy to contradict");
  }
  const mutated: Record<string, unknown> = JSON.parse(readFileSync(RECORD_PATH, "utf8")) as Record<string, unknown>;
  (mutated.rows as Record<string, unknown>[]).push({
    ...deepseekFailure,
    site: "araprat",
    // A CAPABILITY id, never `chat` — the whole point is that a capability-level
    // failure is what demotes.
    capability: "araprat_trending",
    evidence: `${String(deepseekFailure.evidence)} [pointer row re-pointed at araprat_trending on a byte-identical copy of the shipped record]`,
  });
  const verdict = resolveWithRecord(mutated, "araprat");
  assert.equal(
    verdict.contradicted,
    true,
    `a capability-level CONTRADICTION did not demote a site whose other capabilities measured — the resolver still lets a healthy sibling answer first:\n  ${JSON.stringify(verdict.capabilities.map((c) => `${c.capability}=${c.reading}`))}`,
  );
  assert.equal(verdict.measured, false, "a contradicted site must not also report `measured`");
  assert.equal(verdict.failureClass, "UNATTRIBUTED-NO-COMPOSER", "the demotion must NAME the derived class that caused it");
  assert.equal(verdict.limitation, null, "a contradiction is a demotion, not a limitation — reporting both would let one failure read as two mild ones");
  // The healthy siblings are still resolved, at their own level: demotion is not
  // erasure. A consumer must still be able to see WHICH capability failed.
  assert.ok(
    verdict.capabilities.some((c) => c.reading === "contradicted" && c.capability === "araprat_trending"),
    `the contradicting capability must be named in the per-capability array: ${JSON.stringify(verdict.capabilities.map((c) => `${c.capability}=${c.reading}`))}`,
  );
  assert.ok(
    verdict.capabilities.filter((c) => c.reading === "measured").length >= 1,
    "demotion must not erase the capabilities that measured — the resolution is per capability, the verdict is the fold",
  );
  // …and the demotion REACHES the published status, which is the point of it.
  assert.equal(
    chatSurfaceStatus("araprat"),
    "verified",
    "araprat's OWN record is healthy — this assert only holds because the mutated record is not the one on disk; if it fires, the copy leaked",
  );
});

test("THREE-WAY: a site whose round trip was MEASURED and FAILED is never published as verified", () => {
  // THE TEETH OF THE DISTINCTION. A contradicted site must not reach a consumer
  // as `verified`: `packageStatusOf` mints `unverified-candidate` for both
  // negatives, and this asserts that for the negative that HAS a row — so a
  // reader of `/registry` cannot be told a surface works when the freshest
  // measurement of it says it did not.
  const contradicted = universe()
    .map((id) => ({ id, v: measuredRoundTripFor(id) }))
    .filter((x) => x.v.contradicted)
    .map((x) => x.id)
    .sort();
  if (contradicted.length === 0) {
    // Not a pass by default: a record where nothing has ever failed cannot
    // exercise this assertion, so say so rather than let a green run imply the
    // branch was checked.
    assert.ok(
      rows.length > 0,
      "capabilities/roundtrip.json carries no rows at all — the contradicted branch below is unexercised, so a green run here would prove nothing about it",
    );
    return;
  }
  const publishedVerified = contradicted.filter((id) => chatSurfaceStatus(id) === "verified");
  assert.deepEqual(
    publishedVerified,
    [],
    `these sites were MEASURED and the measurement FAILED, yet the resolver still publishes them as verified:\n  ${contradicted.join(", ")}\n${threeWayReport().join("\n")}`,
  );
});

test("THREE-WAY: a MEASURED row never exists for a site with no published claim (the record may not promote)", () => {
  const orphans = measuredIds().filter((id) => !publishedIds().includes(id) || !claimedIds().includes(id));
  assert.deepEqual(
    orphans,
    [],
    `a measurement exists for ${orphans.join(", ")} but no receipt/published claim does — a measurement may only ever DEMOTE, never PROMOTE:\n` +
      threeWayReport().join("\n"),
  );
});

test("THREE-WAY: the gap this gate derives is exactly the gap the record NAMES (both directions)", () => {
  const declared = ((raw.knownGaps as { sites?: unknown } | undefined)?.sites ?? []) as unknown;
  assert.ok(Array.isArray(declared), "capabilities/roundtrip.json must carry a `knownGaps.sites` array naming every unmeasured published claim");
  const named = (declared as string[]).slice().sort();
  const derived = claimedIds().filter((id) => !measuredIds().includes(id)).sort();
  assert.deepEqual(
    named,
    derived,
    `the record's named gaps and the gap the gate derives must be the same set, so a gap APPEARING and a gap being ` +
      `quietly CLOSED are both build failures:\n  named:   [${named.join(", ")}]\n  derived: [${derived.join(", ")}]`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CLASS RE-DERIVATION — the anti-hand-typing core
// ─────────────────────────────────────────────────────────────────────────────

/** Re-derive a row's class from its OWN machine fields, through the shipped
 *  classifier. The nonce gate is what stops a hand-typed ANSWERS from buying a
 *  `verified` status: a row that claims ANSWERS while its own fields cannot
 *  produce ANSWERS is caught HERE, by re-derivation — not by a name check,
 *  which a determined editor could satisfy by also renaming the fields.
 *
 *  THE CAPABILITY FACTS ARE FED TOO, and that is not optional bookkeeping. The
 *  first version of this re-derivation passed only the chat fields, because the
 *  chat fields were all the vocabulary could use — so when `RETURNS-DATA` landed
 *  (a capability surface that returned real data over the wire), every capability
 *  row would have re-derived UNCLASSIFIED no matter what it claimed, and the
 *  gate would have failed every true measurement while a hand-typed class on the
 *  same fields would have passed the OTHER assertions. A re-derivation that
 *  cannot see the decisive fields is not a re-derivation of that class. */
function rederive(row: Record<string, unknown>): string {
  const nonceOk = row.probeNonceMatched === true;
  const answerText = nonceOk ? "x".repeat(Number(row.answerChars) || 1) : "";
  const pool = row.poolAtRequest as { busy?: unknown; total?: unknown; queued?: unknown } | undefined;
  return classifyOutcome({
    httpStatus: typeof row.httpStatus === "number" ? row.httpStatus : 0,
    message: typeof row.evidence === "string" ? row.evidence : "",
    answerText,
    noResponse: row.httpStatus === 0,
    poolAtRequest: pool ? { busy: pool.busy, total: pool.total, queued: pool.queued } : undefined,
    page: (row.observedPage ?? undefined) as never,
    capabilityOk: row.capabilityOk,
    resultShape: (row.resultShape ?? null) as never,
  }).cls;
}

test("CLASS: every row's class is what classifyOutcome re-derives from that row's OWN machine fields", () => {
  const wrong = rows
    .filter((r) => r.provenance === "harness")
    .filter((r) => rederive(r) !== r.class)
    .map((r) => `\`${String(r.site)}\`: row claims class ${String(r.class)} but its own fields re-derive ${rederive(r)} — a class that disagrees with the measurement is the defect this gate exists to catch`);
  assert.deepEqual(wrong, [], `hand-typed classes:\n${wrong.join("\n")}`);
});

test("CLASS: a row may not claim ANSWERS unless its nonce matched, it was 2xx, it carried answer text, and it stabilised", () => {
  const lying = rows
    .filter((r) => r.class === "ANSWERS")
    .filter((r) => {
      const st = typeof r.httpStatus === "number" ? r.httpStatus : 0;
      const chars = typeof r.answerChars === "number" ? r.answerChars : 0;
      return !(r.probeNonceMatched === true && st >= 200 && st < 300 && chars > 0 && r.doneReason === "stable");
    })
    .map((r) => `\`${String(r.site)}\` claims ANSWERS but probeNonceMatched=${String(r.probeNonceMatched)}, httpStatus=${String(r.httpStatus)}, answerChars=${String(r.answerChars)}, doneReason=${String(r.doneReason)} — ANSWERS requires a MATCHED per-measurement nonce (the anti-stale-echo core), a 2xx, real answer text and a stable read`);
  assert.deepEqual(lying, [], `ANSWERS claimed without the fields that produce it:\n${lying.join("\n")}`);
});

// ── the CAPABILITY-SURFACE class ─────────────────────────────────────────────
//
// THE DEFECT THIS KILLS, restated because it is the whole lane: every member of
// the verification vocabulary keyed on a CHAT answer, so `araprat_search`
// answering HTTP 200 `ok:true` with 29 real rows derived UNCLASSIFIED — not a
// class — and the write seam refuses to write an UNCLASSIFIED row at all. So NO
// capability surface could ever be recorded as MEASURED and the three-way gate
// below was red on every capability-only package no matter how many times the
// harness ran. A vocabulary that cannot express the thing it is asked to check.

test("ANTI-VACUITY: the shipped record actually EXERCISES the capability class — the vocabulary is not unexercised", () => {
  const capabilityRows = rows.filter((r) => r.capability !== "chat" && r.provenance === "harness");
  const returnsData = capabilityRows.filter((r) => r.class === "RETURNS-DATA");
  assert.ok(
    capabilityRows.length > 0,
    "capabilities/roundtrip.json carries no capability-surface row at all — the capability write path is " +
      "never exercised in the shipped record, so RETURNS-DATA would be a class nothing can ever reach (the " +
      "same 'a gate that cannot fire' defect, one level down from the one this class closes)",
  );
  assert.ok(
    returnsData.length > 0,
    `capability rows exist (${capabilityRows.map((r) => `${String(r.site)}/${String(r.capability)}=${String(r.class)}`).join(", ")}) ` +
      `but NONE derives RETURNS-DATA — so no capability surface can be recorded as MEASURED. Measure one with ` +
      `\`node --import tsx scripts/audit/record-roundtrip.mjs --site <id> --capability <cap> --args '<json>'\` against a live daemon.`,
  );
});

test("CLASS: a capability row claiming RETURNS-DATA must have the fields that produce it (the hand-typing case)", () => {
  // A row with the DECLARED half of the evidence only, the COUNTED half absent.
  const declaredOnly = rederive({
    class: "RETURNS-DATA",
    httpStatus: 200,
    capabilityOk: true,
    resultShape: { topLevelKeys: ["capability", "ok", "data"], rowsPath: "data.results", count: 12, rows: null },
    poolAtRequest: { busy: 0, total: 2, queued: 0 },
    evidence: "class derived by classifyOutcome()",
  });
  assert.notEqual(
    declaredOnly,
    "RETURNS-DATA",
    `a runner's DECLARED count alone derived RETURNS-DATA — the class must require the counted rows to agree with it, got ${declaredOnly}`,
  );

  // The two halves DISAGREEING: a runner claiming 12 over 0 records.
  const disagreeing = rederive({
    class: "RETURNS-DATA",
    httpStatus: 200,
    capabilityOk: true,
    resultShape: { topLevelKeys: ["capability", "ok", "data"], rowsPath: "data.results", count: 12, rows: 0 },
    poolAtRequest: { busy: 0, total: 2, queued: 0 },
    evidence: "class derived by classifyOutcome()",
  });
  assert.notEqual(disagreeing, "RETURNS-DATA", `a self-contradicting result derived RETURNS-DATA (${disagreeing})`);
});

test("CLASS: an EMPTY capability result is a measurement of NOTHING and must not derive the data-returned class", () => {
  // MEASURED against the live daemon: `duckduckgo_chat_history` answers HTTP 200
  // `ok:true` with `{count: 0, chats: []}` for a session with no history — a real
  // round trip that returned no records.
  const empty = rederive({
    class: "RETURNS-DATA",
    httpStatus: 200,
    capabilityOk: true,
    resultShape: { topLevelKeys: ["capability", "ok", "data"], rowsPath: "data.chats", count: 0, rows: 0 },
    poolAtRequest: { busy: 0, total: 2, queued: 0 },
    evidence: "class derived by classifyOutcome()",
  });
  assert.notEqual(empty, "RETURNS-DATA", `an empty result set derived the data-returned class (${empty})`);
  assert.equal(
    empty,
    "UNCLASSIFIED",
    `an empty result set should land on the classifier's refusal so the write seam REPORTS it and writes nothing — a class that admitted it would let the gate be satisfied by a surface that returns nothing forever. Got ${empty}`,
  );
});

test("CLASS: a capability REFUSAL (ok:false with a named reason) must not derive the data-returned class", () => {
  // The login-gated shape, measured in src/capabilities/gated.ts:38
  // (`loginGatedResult`) — `{ok:false, loginGated:true, error:"login-required: …"}`.
  const refused = rederive({
    class: "RETURNS-DATA",
    httpStatus: 502,
    capabilityOk: false,
    resultShape: { topLevelKeys: ["capability", "ok", "error", "loginGated"], rowsPath: null, count: null, rows: null },
    poolAtRequest: { busy: 0, total: 2, queued: 0 },
    evidence: "POST /capability/araprat -> HTTP 502 login-required: araprat_comment needs an authorized captured araprat session",
  });
  assert.notEqual(refused, "RETURNS-DATA", `a login-gated refusal derived the data-returned class (${refused})`);

  // …and it must not be the classifier's silent fallback either: a refusal that
  // reached the wire is a MEASUREMENT, so it lands in the vocabulary or it is
  // reported as a finding — never filed as a success.
  assert.notEqual(refused, "ANSWERS", "a refusal is not an answer");
  assert.notEqual(refused, "UNMEASURED", "UNMEASURED means never reached; this response WAS reached");
});

test("CLASS: the shipped capability rows re-derive from their OWN fields, and the read seam agrees", () => {
  for (const r of rows.filter((x) => x.provenance === "harness")) {
    assert.equal(rederive(r), r.class, `\`${String(r.site)}/${String(r.capability)}\` claims ${String(r.class)} and its own fields re-derive something else`);
  }
  for (const r of rows.filter((x) => x.class === "RETURNS-DATA")) {
    const site = String(r.site);
    assert.equal(
      measuredRoundTripFor(site).measured,
      true,
      `\`${site}\` carries a RETURNS-DATA row the classifier derived, but the read seam does not count it: ${measuredRoundTripFor(site).reason}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. AN UNMEASURED ROW MUST BE IDENTIFIABLE AS UNMEASURED
// ─────────────────────────────────────────────────────────────────────────────

test("PROVENANCE: every imported row says so, carries no nonce, and backs nothing", () => {
  const offenders = rows
    .filter((r) => r.provenance === "imported")
    .filter((r) => r.probeNonceMatched !== null || r.method !== "imported-from-prose" || measuredIds().includes(String(r.site)))
    .map((r) => `\`${String(r.site)}\` is provenance=imported but ${r.probeNonceMatched !== null ? "carries a nonce value" : "carries no nonce marker"} / method=${String(r.method)} — an imported row must be identifiable as unmeasured and must never count as MEASURED`);
  assert.deepEqual(offenders, [], `imported rows:\n${offenders.join("\n")}`);
});

test("PROVENANCE: no row is `imported` while carrying fields only a real probe could produce", () => {
  const impossible = rows
    .filter((r) => r.provenance === "imported")
    .filter((r) => r.probeNonceMatched !== null || r.doneReason !== null || r.elapsedMs !== null)
    .map((r) => `\`${String(r.site)}\`: an imported row cannot have probeNonceMatched=${String(r.probeNonceMatched)}, doneReason=${String(r.doneReason)}, elapsedMs=${String(r.elapsedMs)} — those come from a live probe, and inventing them is fabricating a measurement`);
  assert.deepEqual(impossible, [], `imported rows claiming probe-derived fields:\n${impossible.join("\n")}`);
});

test("PROVENANCE: a capability-surface row records resultShape, and never borrows the chat nonce rule", () => {
  const offenders = rows
    .filter((r) => r.capability !== "chat")
    .filter((r) => r.probeNonceMatched !== null)
    .map((r) => `\`${String(r.site)}/${String(r.capability)}\` is a capability surface but carries probeNonceMatched=${String(r.probeNonceMatched)} — a capability returns JSON, so a nonce proves nothing there and the row must record resultShape instead`);
  assert.deepEqual(offenders, [], `capability rows borrowing the chat nonce rule:\n${offenders.join("\n")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. STALENESS — a month-old measurement is not evidence about today
// ─────────────────────────────────────────────────────────────────────────────

test("STALENESS: every MEASURED row is inside the window the record declares", () => {
  const stale = rows
    .filter((r) => measuredIds().includes(String(r.site)))
    .filter((r) => {
      const age = (Date.now() - Date.parse(String(r.measuredAt))) / 86_400_000;
      return !(age >= 0 && age <= windowDays);
    })
    .map((r) => `\`${String(r.site)}\` measured ${String(r.measuredAt)} is outside the ${windowDays}-day window`);
  assert.deepEqual(stale, [], `stale measurements still counted:\n${stale.join("\n")}`);
});

test("STALENESS: every measured row names the daemon commit it was taken against", () => {
  const missing = rows
    .filter((r) => r.provenance === "harness" && r.probeNonceMatched === true)
    .filter((r) => !nonEmptyStr(r.daemonCommit))
    .map((r) => `\`${String(r.site)}\` has no daemonCommit — CI can never re-measure this (no session, no Chrome owner), so the build the row came from is the only provenance a reader will ever have`);
  assert.deepEqual(missing, [], `measured rows without a commit:\n${missing.join("\n")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE READ SEAM HONOURS THE MEASUREMENT
// ─────────────────────────────────────────────────────────────────────────────

test("READ SEAM: a site with a receipt but no MEASURED row is not published `verified`", () => {
  const overclaimed = claimedIds().filter((id) => !measuredIds().includes(id) && chatSurfaceStatus(id) === "verified");
  assert.deepEqual(
    overclaimed,
    [],
    `these sites publish \`verified\` on a receipt alone, with no measured round trip backing them:\n${threeWayReport().join("\n")}`,
  );
});

test("READ SEAM: the resolver's verdict for a site matches the gate's independent derivation", () => {
  const drift = universe()
    .filter((id) => {
      const resolverSaysVerified = chatSurfaceStatus(id) === "verified";
      return resolverSaysVerified !== measuredIds().includes(id);
    })
    .map((id) => `\`${id}\`: resolver says ${chatSurfaceStatus(id)}, gate derives ${measuredIds().includes(id) ? "verified" : "not verified"}`);
  assert.deepEqual(drift, [], `resolver vs gate:\n${drift.join("\n")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE RECORD'S OWN SHAPE + THE PRIVACY PROPERTY THAT MAKES IT PUBLISHABLE
// ─────────────────────────────────────────────────────────────────────────────

test("RECORD: the file declares its schema, and the reader agrees it is readable", () => {
  assert.equal(raw.schema, "ui2api/roundtrip/1", "capabilities/roundtrip.json must declare schema ui2api/roundtrip/1");
  assert.equal(record.refusal, null, `the record must be readable by the seam: ${record.refusal}`);
});

test("RECORD: no class outside the shipped vocabulary (a typo in a class is a lie)", () => {
  const unknown = rows.filter((r) => !VERIFICATION_CLASSES.includes(String(r.class) as VerificationClass));
  assert.deepEqual(
    unknown.map((r) => `${String(r.site)}: ${String(r.class)}`),
    [],
    `classes outside VERIFICATION_CLASSES`,
  );
});

/**
 * THE SCANNED PROSE, with the SERVICE'S OWN REFUSAL VOCABULARY removed first.
 *
 * WHY, and why this is a narrowing of the scan rather than a loosening of the
 * property. The property is that the published record carries no PROMPT text, no
 * ANSWER text, no account and no cookie — none of which a refusal clause is. The
 * scan implements it as "any single-quoted span of 4+ characters inside prose is
 * a quote of something the service returned", which is the right blunt instrument
 * for every prose field, and `classifyOutcome` deliberately writes the service's
 * own refusal SENTENCE into `evidence` so the row can be re-derived (see
 * `rederive` above: it feeds `row.evidence` back as the message). Those two
 * requirements collided here, and the collision is real rather than hypothetical:
 *
 *   MEASURED. `youtube_transcript`'s runner-owned refusal names the control it
 *   could not find and quotes the site's own button label to do it —
 *   `no-transcript-button: 'Show transcript' not offered on this page (video
 *   without captions, or selector rot)` — so the youtube row's evidence carries a
 *   16-character single-quoted span and this gate, correctly by its own rule,
 *   reported a PRIVACY violation on a row holding no served content whatsoever.
 *
 * THE FIX IS TO EXCLUDE THE VOCABULARY, NOT THE PROPERTY, and the vocabulary is
 * not a hand-written list of strings: it is the same set of clauses the
 * classifier itself derives from the modules that EMIT them, read out of the
 * classifier rather than retyped here. Removing them before the scan means the
 * quoted marks inside a refusal clause are treated as what they are — part of a
 * sentence the repo owns and publishes in its own source — while every other
 * quoted span in the same field is scanned exactly as before.
 *
 * IT KEEPS ITS TEETH, and the case that gives them is the reason this is not a
 * deletion: an answer is never inside a refusal clause, so a genuine quoted
 * answer, a prompt, or an account in the same field still trips the scan. That is
 * asserted below, so a future widening of this exemption is visible.
 */
function withoutRefusalVocabulary(prose: string): string {
  const vocabulary = [
    composerRefusalMatcher()?.clause,
    ...controlAbsentClauses(),
    NO_ANSWER_REFUSAL_CLAUSE,
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  let out = prose;
  for (const clause of vocabulary) out = out.split(clause).join(" ");
  return out;
}

test("PRIVACY: excluding the service's own refusal vocabulary does NOT weaken the scan", () => {
  // The exemption removes a DERIVED refusal clause and nothing else, so a real
  // quoted span in the same field still fires, and a quoted span that merely sits
  // beside a clause still fires. If this ever passes because the scan was
  // disabled rather than narrowed, the exemption has become a hole.
  const offender = (prose: string): boolean => /(?<![A-Za-z0-9_])'([^']{4,})'(?![A-Za-z0-9_])/.test(withoutRefusalVocabulary(prose));
  const clause = controlAbsentClauses()[0];
  assert.equal(typeof clause, "string", "precondition: the classifier must derive at least one refusal clause, or this case is vacuous");
  // The quoted marks INSIDE a refusal clause are vocabulary, not served content.
  assert.equal(offender(`the service's own refusal ("${clause}") is what the row quotes`), false);
  // A real quoted answer anywhere in the field still trips it.
  assert.equal(offender(`the service's own refusal ("${clause}") came back with the answer 'my bank code is 4417'`), true);
  // …including one that merely ADJACENT to a clause, with no clause present.
  assert.equal(offender(`the service answered 'Exploring ideas...'`), true);
  // And an apostrophe pair inside ordinary words is still not a quote.
  assert.equal(offender("the runner's own verdict ok=true and the runner's declared count"), false);
});

test("PRIVACY: the published record carries no prompt text, no answer text, no account, and no cookie", () => {
  const offenders: string[] = [];
  for (const row of rows) {
    const text = JSON.stringify(row);
    for (const [field, value] of Object.entries(row)) {
      if (["answerText", "prompt", "account", "identity", "cookie", "cookies", "vaultPath", "snapshot"].includes(field)) {
        offenders.push(`\`${String(row.site)}\` carries a ${field} field`);
      }
    }
    // The record is published in the sanitized mirror, so it must not quote a
    // served answer either — only its length and a truncated digest.
    //
    // CHECKED BY SHAPE, NOT BY PHRASING, and that correction is load-bearing.
    // The first version of this test looked for the literal `answer text '...'`
    // and PASSED a record that still carried a second quote of the same answer in
    // the same sentence ("the SAME real answer '...'") — the exact text the file
    // promises not to publish. A phrasing check only catches the phrasing you
    // thought of, so this one looks for ANY quoted span inside a prose field.
    for (const proseField of ["evidence", "prereq", "notes"]) {
      const prose = row[proseField];
      if (typeof prose !== "string") continue;
      // A single-quoted span of 4+ chars inside prose is a quote of something
      // the service returned. The vocabulary literals that legitimately appear
      // ('harness', 'ANSWERS', 'imported') live in non-prose fields and are
      // checked by the class test above.
      //
      // AND THE APOSTROPHE IS NOT A QUOTE MARK, which this pattern only learned
      // by being WRONG first. The classifier's reason prose says "the runner's
      // own verdict" and "the runner's declared count", and the naive pattern
      // paired the two apostrophes into a 200-character "quote" and reported two
      // PRIVACY violations on two rows that carry no quoted service output at
      // all. A quoted span opens after a space or a bracket, never immediately
      // after a word character — so both boundaries are asserted, and a genuine
      // quote (which is what this gate exists to catch) still matches. Fixing it
      // the other way — deleting the check because it fired — would have left
      // the load-bearing property unguarded for the wrong reason.
      for (const m of withoutRefusalVocabulary(prose).matchAll(/(?<![A-Za-z0-9_])'([^']{4,})'(?![A-Za-z0-9_])/g)) {
        offenders.push(`\`${String(row.site)}\` quotes ${m[0]} in its ${proseField} prose`);
      }
      if (/\bPONG-[0-9a-f]{8,}/i.test(prose)) offenders.push(`\`${String(row.site)}\` carries a literal probe nonce in ${proseField}`);
    }
    if (/"probe"\s*:\s*"PONG-/i.test(text)) offenders.push(`\`${String(row.site)}\` carries a literal probe nonce`);
  }
  assert.deepEqual(
    offenders,
    [],
    `the privacy property is load-bearing (.brain/ is stripped by scripts/ci/make-public-repo.sh:471 and data/ at :562, so a measurement kept only there is unreviewable):\n${offenders.join("\n")}`,
  );
});

test("WRITE SEAM: only the harness writes the record, and the service under measurement never certifies itself", () => {
  const src = readFileSync(resolve(ROOT, "src/prompt/http.ts"), "utf8");
  assert.ok(
    !/roundtrip\.json/.test(src),
    "src/prompt/http.ts must never write capabilities/roundtrip.json — a read-only service that certifies itself is not certified",
  );
  const harness = readFileSync(resolve(ROOT, "scripts/audit/record-roundtrip.mjs"), "utf8");
  assert.match(harness, /v1\/chat\/completions/, "the harness must measure over the daemon's own wire, never fabricate site traffic");
});