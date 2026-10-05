import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * CAPABILITY OUTPUT TRUTH — the anti-fabrication gate for READ capabilities.
 *
 * The project's absolute rule is that no capability may fabricate: a runner
 * reports what the REAL page said, and when it could not read the page it says
 * so. `test/mutating-capability-postcondition.test.ts` already holds that line
 * for MUTATING capabilities (post / comment / like / upload / toggle ...), and
 * its `KNOWN_DEFECTS` tripwire is the model this file follows.
 *
 * That gate keys on MUTATING verb tails — 25 of the 161 declared capabilities.
 * This file covers the class that was open: a READ capability (list
 * conversations, search, history, picker) that drives the page and then reports
 * `ok: true`.
 *
 * THE DEFECT THIS EXISTS TO KILL
 *
 *   const rows = await page.evaluate(() => collectSidebarLinks());
 *   return { capability, ok: true, data: { count: rows.length, rows } };
 *
 * `ok: true` here is derived from "the evaluate did not throw", NOT from "I
 * read anything". Selector rot, a consent wall, a login redirect, a renamed
 * class, a slow SPA — each yields `rows = []`, and the runner reports a
 * SUCCESSFUL, EMPTY answer that a consumer cannot distinguish from a real
 * "this site has no conversations". The project's own doctrine calls that a
 * fabricated result.
 *
 * The correct shape is already shipped by araprat_search / araprat_trending /
 * araprat_video_detail / youtube_search / duckduckgo_model_picker: guard the
 * success on something the READ produced, and refuse with a named ok:false when
 * it produced nothing. This gate holds every read capability to that.
 *
 * WHAT IS ASSERTED — the PROPERTY, not a count
 *
 * 1. No read capability may derive a success verdict from a page read that can
 *    come back empty. The currently-open instances are named in
 *    `UNPROVEN_READ_OK` with a reason each; a NEW one fails this file loudly,
 *    and a FIXED one fails too, so the list cannot rot into a permanent
 *    excuse. Every entry is itself proven real, so the list cannot be padded.
 * 0. NO CAPABILITY CAN BE SILENTLY UNCLASSIFIED. The scope of this gate used to
 *    be a hand-typed 20-entry `READ_TAILS` set, and every capability whose tail
 *    was not in it was `continue`d away in silence. Measured on this repo that
 *    skipped 110 of 161 declared capabilities, including real readbacks
 *    (`notion_qna`, `chatglm_conversation_crud`, `tencent_aistudio_translations`)
 *    — and a silent `continue` in a gate is the worst default there is, because
 *    it converts "I do not know about this" into "everything is fine". A
 *    capability the gate cannot classify must be a NAMED RED, never a skip.
 *    The scope is therefore DERIVED from each capability's own deciding code
 *    (`verdictClassOf`), which is total over the declared corpus, and
 *    `every declared capability is classified` asserts the classes sum to the
 *    corpus with no unknown left over. `DECLARED_READ_TAILS` survives only as a
 *    cross-check against that derivation, never as the filter.
 * 2. A capability whose docs claim `verified` has its OUTPUT SHAPE pinned
 *    here. Wiring is already covered by `capability-dispatch.test.ts` and
 *    proves nothing whatsoever about the answer.
 * 3. Anti-vacuity: this file FAILS on an empty capability list, and its
 *    predicate is shown to fire on a fabricated runner. A gate that cannot go
 *    red is not a gate.
 *
 * Deliberately NOT asserted: "all 33 sites covered", or any ratio. Several
 * capabilities are honestly login-gated and never execute; pinning a ratio
 * makes the suite red today and forever without closing one real gap. Coverage
 * is reported honestly, not pinned.
 */

const RUNNER_DIR = "src/capabilities";
const MANIFEST_DIR = "capabilities";

/**
 * Tails the DOCS/manifests have historically used for reads. This set is NO
 * LONGER THE SCOPE of this gate — it used to be, and every tail outside it was
 * silently skipped, which is how 110 of 161 declared capabilities escaped
 * coverage while the gate stayed green. It is retained as a CROSS-CHECK: a tail
 * declared here must actually reach a readback in code, and a capability the
 * code classifies as a readback must not depend on this list at all. The
 * authoritative classification is `verdictClassOf`, derived from the runner.
 */
const DECLARED_READ_TAILS = new Set([
  "conversations", "history", "search", "list", "models", "trending", "detail",
  "picker", "threads", "inbox", "transcript", "switch", "reasoner", "mode",
  "web-search", "search-images", "voice", "entra", "credits", "settings",
]);

/**
 * Interactions that FLIP the site's state. A capability that only performs one
 * of these and reads nothing back cannot report a fabricated ANSWER — the
 * sibling gate `mutating-capability-postcondition.test.ts` owns that class.
 * This mirrors that gate's `ACTION_CALLS` so the two agree on the boundary.
 */
const STATE_FLIP_CALLS = [
  /\.click\(/, /setInputFiles\(/, /pressSequentially\(/, /\.press\(/,
  /\.fill\(/, /selectOption\(/,
];

/**
 * Any interaction with the page whose result can be empty — direct
 * (`page.evaluate`) OR through the runner's own read helpers
 * (`awaitGrid`, `extractCards`, `openPage`, `waitForSelector`). Keying only on
 * a literal `.evaluate(` is blind: `araprat_search` reads through
 * `awaitGrid`/`extractCards` and would be invisible to such a gate.
 */
const PAGE_USE = [
  /\.evaluate\(/, /\$\$eval/, /\$eval/, /openPage\(/, /awaitGrid\(/,
  /extract[A-Za-z]*\(/, /waitForSelector\(/, /this\.read[A-Za-z]*\(/,
];

/**
 * Verdict shapes that cannot report success on an empty collection — tested
 * ONLY against the `ok:` verdict expression itself.
 *
 * Scoping matters. An earlier version tested the whole region and was
 * satisfied by a `note:` STRING that merely mentioned `results.length > 0`;
 * deleting the real guard from `youtube_search` then left the gate green.
 * That is the exact false-negative this file exists to prevent, so a guard is
 * only believed where it is actually a verdict.
 */
function verdictIsLengthShaped(region: string): boolean {
  for (const m of region.matchAll(/ok\s*:\s*([^,}\n]+)/g)) {
    if (/\.length\s*>\s*0/.test(m[1]) || /\.length\s*&&/.test(m[1])) return true;
  }
  return false;
}

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Comments are stripped: a gate judges CODE, never the prose describing it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function methodRegion(src: string, method: string): string {
  const esc = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const decl = new RegExp(`^  (?:private|public|protected)\\s+(?:static\\s+)?(?:async\\s+)?${esc}\\s*\\(`, "m").exec(src);
  if (!decl) return "";
  const after = src.slice(decl.index + 1);
  const next = /^  (?:private|public|protected)\s/m.exec(after);
  return next ? src.slice(decl.index, decl.index + 1 + next.index) : src.slice(decl.index);
}

/**
 * The code that DECIDES a capability's verdict: its `case` arm, or — when the
 * arm only delegates — the method it delegates to.
 */
function decidingRegion(src: string, capability: string): string {
  const m = new RegExp(`case\\s+"${capability}"\\s*:`).exec(src);
  if (!m) return "";
  const rest = src.slice(m.index);
  const stop = /\bdefault\s*:/.exec(rest);
  const arm = stop ? rest.slice(0, stop.index) : rest;
  if (/ok\s*:/.test(arm)) return arm;
  const call = /(?:return\s+)?(?:await\s+)?this\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(arm);
  if (!call) return arm;
  return methodRegion(src, call[1]) || arm;
}

/** Where the deciding code first touches the page (Infinity when it never does). */
function firstPageUse(region: string): number {
  return Math.min(...PAGE_USE.map((p) => {
    const m = p.exec(region);
    return m ? m.index : Infinity;
  }));
}

function readsPage(region: string): boolean {
  return firstPageUse(region) !== Infinity;
}

/**
 * Is the success verdict GUARDED against an empty read?
 *
 * Either the verdict is length-shaped (`ok: rows.length > 0`, which
 * `youtube_search` ships), OR an `if (...) { ... ok: false ... }` block appears
 * AFTER the code first touches the page — i.e. the runner inspected what the
 * page interaction produced and refused when it was nothing.
 *
 * The "after the page" half is what makes this structural rather than a
 * name-matching exercise. `araprat_search`'s `if (!q)` guards the QUERY and
 * sits BEFORE any page work, so it does not count. Its `if (!hydrated)` — which
 * tests the result of `awaitGrid(page)` — sits after, and does. Likewise
 * `araprat_video_detail`'s `if (!sawH1 || !detail.title)`, which is the guard
 * that makes a doc-claimed "VERIFIED" read honest.
 */
function guardedAgainstEmpty(region: string): boolean {
  if (verdictIsLengthShaped(region)) return true;
  const firstUse = firstPageUse(region);
  if (!Number.isFinite(firstUse)) return false;
  const after = region.slice(firstUse);
  for (const m of after.matchAll(/if\s*\([^)]*\)\s*\{([\s\S]{0,900}?)\n\s*\}/g)) {
    if (/ok\s*:\s*false/.test(m[1])) return true;
  }
  return false;
}

interface ReadCapability {
  id: string;
  site: string;
  runner: string;
  region: string;
  reachesOkTrue: boolean;
  readsPage: boolean;
  guarded: boolean;
  honestRefusal: boolean;
  /** Where its deciding code lands. Never `unknown` — see `verdictClassOf`. */
  verdictClass: VerdictClass;
  /** True when the capability's tail appears in `DECLARED_READ_TAILS`. */
  declaredReadTail: boolean;
}

/**
 * How a capability's own deciding code produces its verdict.
 *
 * These five classes are EXHAUSTIVE over the declared corpus, and that is the
 * point: there is deliberately no `unknown`, because an unclassifiable
 * capability would have to be a silent skip, which is the exact defect this
 * file exists to kill. A capability that reaches no class here is a real signal
 * that the analysis broke, and the classification test says so by name.
 *
 *  - `readback`    its verdict is (or could be) built from a PAGE READ. This
 *                  gate's subject: an empty read is indistinguishable from a
 *                  failed one. Covers both pure reads and mutations that
 *                  read the page back, because the empty-read hazard is the
 *                  same in both.
 *  - `state-flip`  it drives the page (click/type/press) and reads nothing back.
 *                  Owned by `mutating-capability-postcondition.test.ts`.
 *  - `delegating`  it reaches `ok: true` without touching the page in its own
 *                  deciding region — a pure hand-off (a ChatDriver call).
 *  - `refusal`     it cannot report success at all (a named `ok: false`, a
 *                  login-gated short-circuit). It cannot fabricate a value.
 *  - `undispatched` the manifest declares it but this runner has no `case` for
 *                  it. `capability-dispatch.test.ts` owns that gap; it is
 *                  named rather than skipped so the count cannot hide.
 */
type VerdictClass = "readback" | "state-flip" | "delegating" | "refusal" | "undispatched";

function flipsState(region: string): boolean {
  return STATE_FLIP_CALLS.some((p) => p.test(region));
}

/** Total, tail-free classification of a capability from its deciding code. */
function verdictClassOf(region: string, reachesOkTrue: boolean, readsPage: boolean): VerdictClass {
  if (readsPage) return "readback";
  if (flipsState(region)) return "state-flip";
  if (reachesOkTrue) return "delegating";
  return "refusal";
}

/**
 * Every declared capability that has a runner, CLASSIFIED — never filtered.
 *
 * The old version dropped every capability whose tail was not in a hand-typed
 * set, silently. This one returns all of them, each with the class its own
 * code earns, so the caller can assert both coverage and the absence of a
 * silent skip.
 */
function discoverAllCapabilities(): Array<ReadCapability & { dispatched: boolean }> {
  const out: Array<ReadCapability & { dispatched: boolean }> = [];
  for (const pkg of readdirSync(MANIFEST_DIR)) {
    const raw = readIfPresent(`${MANIFEST_DIR}/${pkg}/manifest.json`);
    if (!raw) continue;
    let manifest: { capabilities?: Array<{ id?: string }> };
    try {
      manifest = JSON.parse(raw);
    } catch {
      continue;
    }
    const runnerPath = `${RUNNER_DIR}/${pkg}.ts`;
    const runnerSrc = readIfPresent(runnerPath);
    if (!runnerSrc) continue;
    const src = stripComments(runnerSrc);
    for (const c of manifest.capabilities ?? []) {
      if (typeof c.id !== "string") continue;
      const region = decidingRegion(src, c.id);
      const reachesOkTrue = /ok\s*:\s*true/.test(region);
      const reads = readsPage(region);
      out.push({
        id: c.id,
        site: pkg,
        runner: runnerPath,
        region,
        reachesOkTrue,
        readsPage: reads,
        guarded: guardedAgainstEmpty(region),
        honestRefusal: /loginGated/.test(region) && !reachesOkTrue,
        verdictClass: region ? verdictClassOf(region, reachesOkTrue, reads) : "undispatched",
        declaredReadTail: DECLARED_READ_TAILS.has(c.id.split("_").pop() ?? ""),
        dispatched: region.length > 0,
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The readback surface this gate judges: every capability whose verdict is (or
 * could be) derived from a page read, regardless of its tail.
 */
function discoverReadCapabilities(): ReadCapability[] {
  return discoverAllCapabilities().filter((c) => c.verdictClass === "readback");
}

/**
 * A read capability FAKE-ABLES when all of these hold:
 *   - it can return `ok: true` at all,
 *   - its verdict is built from a real page read (so reading nothing is possible),
 *   - nothing in the deciding code refuses on the strength of that read, and
 *   - it is not the honest login-gated short-circuit (`ok: false`).
 * A capability that never reaches ok:true cannot fake a success, by definition.
 */
function isUnprovenReadOk(c: ReadCapability): boolean {
  return c.verdictClass === "readback" && c.reachesOkTrue && c.readsPage && !c.guarded && !c.honestRefusal;
}

/**
 * The surface assertion, factored out so its own anti-vacuity is testable: an
 * EMPTY discovery must not satisfy it. A gate that passes on an empty world
 * proves nothing.
 *
 * `>= 15` is a floor, deliberately not a target: it only has to exclude an empty
 * or near-empty world. The REAL coverage requirement is not a count at all —
 * it is `every declared capability is classified`, which asserts that nothing
 * was skipped to reach any number.
 */
function surfaceIsReal(reads: ReadCapability[]): boolean {
  return reads.length >= 15 && reads.some((c) => c.reachesOkTrue);
}

/**
 * The reads that CAN report a successful empty answer today. Each entry carries
 * the reason it is still open. Every entry is proven real below, so this list
 * can neither hide a new defect nor outlive the fix it names.
 */
const UNPROVEN_READ_OK: Array<{ id: string; why: string }> = [
  {
    id: "claude_list_conversations",
    why: "ok:true is returned once the sidebar read does not throw; an empty or re-rendered sidebar is reported as a successful empty conversation list",
  },
  {
    id: "deepseek_list_conversations",
    why: "ok:true derives from a non-throwing read of a[href*='/chat/']; selector rot or a login redirect yields a successful empty list",
  },
  {
    id: "hunyuan_list_conversations",
    why: "the conversation-list read returns ok:true with no check that any row was found, so a re-rendered history page reads as a successful empty list",
  },
  {
    id: "venice_list_conversations",
    why: "the runner's own comment records the sidebar classes as unconfirmed, yet ok:true is returned when the read yields zero links — selector rot reported as success",
  },
  {
    id: "duckduckgo_chat_history",
    why: "a fresh anonymous context legitimately has zero saved chats and the runner's note says so, but it still returns ok:true with count 0 — a successful empty read is not distinguished from a failed one",
  },
];

/**
 * Capabilities whose docs claim a LIVE-VERIFIED result, with the OUTPUT SHAPE
 * each claim rests on. A wiring test cannot tell a real answer from a
 * fabricated one, so the shape of the returned data is asserted here against
 * the runner's own deciding code.
 */
const DOC_VERIFIED_OUTPUT_SHAPE: Array<{ id: string; mustCarry: string[]; evidence: string }> = [
  {
    id: "araprat_search",
    mustCarry: ["count", "results"],
    evidence: "AGENTS.md: araprat_search VERIFIED live (real query -> 30 deduped rows off a[href*='/v/'])",
  },
  {
    id: "araprat_trending",
    mustCarry: ["count", "videos"],
    evidence: "AGENTS.md: araprat_trending VERIFIED live (homepage /home, 52 /v/ anchors)",
  },
  {
    id: "araprat_video_detail",
    mustCarry: ["title", "description"],
    evidence: "AGENTS.md: araprat_video_detail VERIFIED live (h1 + div.description + related anchors)",
  },
  {
    id: "duckduckgo_model_picker",
    mustCarry: ["count", "models"],
    evidence: "AGENTS.md: FULL-SURFACE VERIFIED — 6 model rows read, aria-checked on the active model",
  },
  {
    id: "youtube_search",
    mustCarry: ["count", "results"],
    evidence: "AGENTS.md: youtube_search VERIFIED live (ytd-video-renderer a#video-title read-back, 10 rows)",
  },
];

describe("capability output truth: no declared capability is silently unclassified", () => {
  test("every declared capability lands in exactly one derived class — none is skipped", () => {
    const all = discoverAllCapabilities();
    assert.ok(all.length > 100, `precondition: the corpus must be real; discovered only ${all.length} capabilities`);

    // No capability may fall outside the classification. `verdictClass` is typed
    // as a closed union and always assigned, so this is really an assertion
    // that the DISCOVERY is total: nothing was dropped between the manifest and
    // the class list.
    const counted = new Map<string, number>();
    for (const c of all) counted.set(c.verdictClass, (counted.get(c.verdictClass) ?? 0) + 1);
    const classified = [...counted.values()].reduce((a, b) => a + b, 0);
    assert.equal(
      classified,
      all.length,
      `every discovered capability must carry a verdict class; ${all.length - classified} fell through unclassified — ` +
        `a capability this gate cannot classify is a silent skip, which is the defect this file exists to kill`,
    );

    // And the classifier must genuinely SPLIT the corpus. Asserted as "the classes
    // are populated and no single class absorbs everything", because that is
    // the property that distinguishes a real classification from a relabelled
    // filter. `state-flip` is deliberately NOT required to be non-empty:
    // measured on this repo it is 0, because every capability that flips state
    // (click/type/press) also READS THE PAGE BACK, which puts it in
    // `readback` first — correctly, since the empty-read hazard this gate
    // polices is exactly what applies to such a capability. A pure
    // flip-with-no-read would land there, and it is still classified, not
    // skipped.
    for (const cls of ["readback", "delegating", "refusal"] as const) {
      assert.ok(
        (counted.get(cls) ?? 0) > 0,
        `the classifier collapsed: no capability was classified "${cls}". A classifier that puts everything in one ` +
          `bucket is indistinguishable from the tail-list filter it replaced`,
      );
    }
    const biggest = Math.max(...counted.values());
    assert.ok(
      biggest < all.length,
      `the classifier collapsed: one class holds ${biggest} of ${all.length} capabilities, which is what a ` +
        `single-bucket "is it in the list" filter looks like`,
    );

    // `undispatched` is EXPECTED and real (gemini/kimi route through the
    // ChatDriver path, so this runner has no `case` for them). It is asserted
    // as SAFE-RATHER-SKIPPED: an undispatched capability has no deciding code,
    // so it must not be credited with a verdict, and it must not be able to
    // slip into the readback surface where the guards would judge it.
    const undispatched = all.filter((c) => c.verdictClass === "undispatched");
    for (const c of undispatched) {
      assert.equal(
        c.region, "",
        `${c.id}: classified undispatched but a deciding region was found — the classifier and the extraction ` +
          `disagree, so this capability is in an unexamined state`,
      );
      assert.ok(
        !c.reachesOkTrue && !c.readsPage,
        `${c.id}: classified undispatched yet reported as reading a page — it must never be able to fabricate`,
      );
    }
    assert.ok(
      all.length === classified,
      "precondition: the per-class walk above must have seen every discovered capability",
    );
  });

  test("the readback surface is DERIVED from code, and never narrower than the old tail filter", () => {
    const all = discoverAllCapabilities();
    const derived = all.filter((c) => c.verdictClass === "readback");

    // Reproduce the OLD scope exactly: a tail-listed capability with a dispatch
    // region. Note the comparison is against the old scope's PAGE-READING
    // members, not its raw size — the tail list is a naming convention, so a
    // tail-listed capability the code shows to be a pure refusal was always in
    // the old set and must not be counted as coverage lost.
    const oldScope = all.filter((c) => c.declaredReadTail && c.dispatched);
    const oldScopeReading = oldScope.filter((c) => c.readsPage);

    assert.ok(
      derived.length >= oldScopeReading.length,
      `the derived readback surface (${derived.length}) shrank below the old gate's page-reading scope ` +
        `(${oldScopeReading.length}); derivation may widen coverage, never narrow it`,
    );

    // No capability the old gate could judge may have dropped out of scope.
    const lost = oldScopeReading.filter((c) => !derived.includes(c));
    assert.deepEqual(
      lost.map((c) => c.id),
      [],
      "these capabilities were judged by the old tail filter and are no longer in the derived readback scope",
    );

    // And the derivation must actually WIDEN — this is the regression the audit
    // found: the old gate skipped every tail it did not list, in silence.
    const newlyCovered = derived.filter((c) => !oldScope.includes(c));
    assert.ok(
      newlyCovered.length > 0,
      "the derived classification finds NO readback the old tail list missed — the derivation is not actually " +
        "reading the code, it is reproducing the old list",
    );

    // Every newly-covered capability must be guarded, or it is a REAL new
    // finding this gate now raises instead of hiding. This is asserted rather
    // than assumed, so a regression cannot hide behind the widening.
    for (const c of newlyCovered) {
      assert.ok(
        !isUnprovenReadOk(c),
        `${c.id}: newly in scope (tail "${c.id.split("_").pop()}" was never in the hand-typed read list) AND its ` +
          `verdict is an unguarded ok:true off a page read — a fabricated answer this gate can now SEE. Declare it ` +
          `in UNPROVEN_READ_OK with a reason, or add the guard that refuses an empty read`,
      );
    }

    // The old set is kept honest as a cross-check: a tail declared a read must
    // not be a capability whose code plainly cannot read. Those are named here
    // instead of being silently trusted.
    const drifted = oldScope.filter(
      (c) => c.verdictClass === "state-flip" || c.verdictClass === "delegating",
    );
    for (const c of drifted) {
      assert.ok(
        !isUnprovenReadOk(c),
        `${c.id}: DECLARED_READ_TAILS implies a read, but its deciding code is "${c.verdictClass}" — update the set ` +
          `to match the code rather than leaving a stale name to imply coverage that does not exist`,
      );
    }
  });

  test("MUTATION: an unknown-tail capability is CLASSIFIED, not skipped (the silent-continue killer)", () => {
    // The falsifier, run against the classifier itself. `qna` is a real tail in
    // this repo that the old READ_TAILS never contained. Build the OLD filter
    // and the NEW classifier side by side and show they disagree.
    const fakeRegion = `
      const rows = await page.evaluate(() => Array.from(document.querySelectorAll(".r")).map(r => r.textContent));
      return { capability, ok: true, data: { count: rows.length, rows } };
    `;
    const synthetic = {
      id: "notion_qna", site: "notion", runner: "(fixture)", region: fakeRegion,
      reachesOkTrue: true, readsPage: true, guarded: false, honestRefusal: false,
      verdictClass: verdictClassOf(fakeRegion, true, true) as VerdictClass,
      declaredReadTail: DECLARED_READ_TAILS.has("qna"),
      dispatched: true,
    };

    // OLD behaviour, reproduced exactly: the tail filter decides the scope.
    const oldGateCovers = DECLARED_READ_TAILS.has("qna");
    assert.equal(
      oldGateCovers, false,
      "precondition: this falsifier depends on `qna` NOT being in the old hand-typed list",
    );
    assert.equal(synthetic.declaredReadTail, false, "precondition: the capability is invisible to the old filter");

    // NEW behaviour: the code decides, so the same capability IS in scope...
    assert.equal(
      synthetic.verdictClass, "readback",
      "the derived classifier must classify a page-reading capability as a readback regardless of its tail",
    );
    // ...and it is FAKEABLE, so the output-truth assertion above will name it.
    assert.ok(
      isUnprovenReadOk(synthetic),
      "a fabricated ok:true with no readback must be reported fake-able even though its tail is unclassified — " +
        "this is the red the old gate could never raise",
    );
  });
});

describe("capability output truth: a read may not report success on nothing", () => {
  test("discovery is real — the gate sees a substantial read surface (anti-vacuity)", () => {
    const reads = discoverReadCapabilities();
    assert.ok(
      surfaceIsReal(reads),
      `the gate must see the real read surface; found ${reads.length} read capabilities — a discovery that finds ` +
        `little or nothing passes vacuously and would bless any defect`,
    );
  });

  test("no read capability derives ok:true from a page read that may be empty", () => {
    const reads = discoverReadCapabilities();
    const declared = new Set(UNPROVEN_READ_OK.map((d) => d.id));
    const undeclared = reads.filter((c) => isUnprovenReadOk(c) && !declared.has(c.id));
    assert.deepEqual(
      undeclared.map((c) => `${c.id} (${c.runner})`),
      [],
      "a read capability can report a SUCCESSFUL EMPTY answer and is not declared in UNPROVEN_READ_OK: " +
        `${undeclared.map((c) => c.id).join(", ")} — an empty page read must be a NAMED ok:false, exactly as ` +
        `araprat_search already does with its awaitGrid guard`,
    );
  });

  test("every UNPROVEN_READ_OK entry is a REAL, still-open defect (no padded excuses)", () => {
    const reads = discoverReadCapabilities();
    for (const defect of UNPROVEN_READ_OK) {
      const found = reads.find((c) => c.id === defect.id);
      assert.ok(found, `${defect.id}: UNPROVEN_READ_OK names a capability no manifest declares — drop the stale entry`);
      assert.ok(
        isUnprovenReadOk(found),
        `${defect.id}: no longer fake-able — it now refuses an empty read. That is a real fix: drop this entry, ` +
          `do not leave a repaired capability sitting on the defect list`,
      );
      assert.ok(defect.why.length > 60, `${defect.id}: a defect entry must carry a real reason, not a label`);
    }
  });

  test("the five honest read shapes are recognised as guarded (the gate is not over-broad)", () => {
    // A gate that flagged everything would be as useless as no gate. The five
    // reads the project already guards must NOT be reported fake-able.
    const guardedShips = ["araprat_search", "araprat_trending", "araprat_video_detail", "duckduckgo_model_picker", "youtube_search"];
    const reads = new Map(discoverReadCapabilities().map((c) => [c.id, c]));
    for (const id of guardedShips) {
      const c = reads.get(id);
      assert.ok(c, `${id}: expected a read capability — if it moved, update the list rather than deleting it`);
      assert.ok(!isUnprovenReadOk(c), `${id}: this read IS guarded against empty and must not be reported fake-able`);
    }
  });

  test("MUTATION: the fabricated-runner shape IS caught by the gate's own predicate", () => {
    // The exact defect this file exists to kill, fed to the REAL predicate. If
    // this ever passes, the gate is blind.
    const base: ReadCapability = {
      id: "fake_site_list_conversations", site: "fake", runner: "(mutation fixture)", region: "",
      reachesOkTrue: true, readsPage: true, guarded: false, honestRefusal: false,
      verdictClass: "readback", declaredReadTail: true,
    };
    const fabricated: ReadCapability = {
      ...base,
      region: `
        const rows = await page.evaluate(() => Array.from(document.querySelectorAll("a[href*='/chat/']")).map(a => a.getAttribute("href")));
        return { capability, ok: true, data: { count: rows.length, rows } };
      `,
    };
    assert.ok(isUnprovenReadOk(fabricated), "the fabricated shape must be classified fake-able");

    // The same predicate must ACCEPT the honest shape the project actually ships.
    const honest: ReadCapability = {
      ...base,
      region: `
        const hydrated = await this.awaitGrid(page);
        if (!hydrated) {
          return { capability, ok: false, data: undefined, error: "no result anchors rendered within 30s" };
        }
        const results = await extractCardsFull(page);
        return { capability, ok: true, data: { count: results.length, results } };
      `,
      guarded: guardedAgainstEmpty(`
        const hydrated = await this.awaitGrid(page);
        if (!hydrated) {
          return { capability, ok: false, data: undefined, error: "no result anchors rendered within 30s" };
        }
        const results = await extractCardsFull(page);
        return { capability, ok: true, data: { count: results.length, results } };
      `),
    };
    assert.ok(!isUnprovenReadOk(honest), "the honest araprat_search shape must NOT be flagged");
  });

  test("MUTATION: neutering the empty-check on a REAL runner makes the gate report it fake-able", () => {
    // Take the shipped, currently-correct araprat_search and delete ONLY the
    // guard. The predicate must then classify the real runner as fake-able,
    // proving it reads the CODE and is not satisfied by the runner merely
    // existing and being wired.
    const src = stripComments(readIfPresent(`${RUNNER_DIR}/araprat.ts`));
    const real = decidingRegion(src, "araprat_search");
    assert.ok(real.length > 0, "precondition: araprat_search must be readable");
    assert.ok(guardedAgainstEmpty(real), "precondition: the shipped araprat_search must be guarded today");

    const neutered = real.replace(/if\s*\(\s*!\s*hydrated\s*\)\s*\{[\s\S]*?\n\s*\}/, "");
    assert.notEqual(neutered, real, "precondition: the mutation must actually change the source");
    assert.ok(
      !guardedAgainstEmpty(neutered),
      "precondition: the neutered source must really have lost its guard",
    );
    assert.ok(
      isUnprovenReadOk({
        id: "araprat_search", site: "araprat", runner: "araprat.ts", region: neutered,
        reachesOkTrue: /ok\s*:\s*true/.test(neutered),
        readsPage: readsPage(neutered),
        guarded: guardedAgainstEmpty(neutered),
        honestRefusal: false,
        verdictClass: verdictClassOf(neutered, /ok\s*:\s*true/.test(neutered), readsPage(neutered)),
        declaredReadTail: DECLARED_READ_TAILS.has("search"),
      }),
      "a guarded read, once its guard is deleted, MUST become fake-able — this is the red the gate exists to raise",
    );
  });

  test("MUTATION: an EMPTY capability list does not satisfy the surface assertion", () => {
    assert.ok(!surfaceIsReal([]), "an empty discovery must FAIL the surface assertion, not pass it");
    assert.ok(
      !surfaceIsReal([{ id: "x", site: "x", runner: "x", region: "", reachesOkTrue: false, readsPage: false, guarded: false, honestRefusal: true, verdictClass: "readback", declaredReadTail: true }]),
      "a world where nothing can report ok:true must also fail — there would be nothing to protect",
    );
    assert.ok(surfaceIsReal(discoverReadCapabilities()), "and the real world must satisfy it");
  });
});

describe("capability output truth: a doc-claimed `verified` read is output-verified, not merely wired", () => {
  test("every doc-verified read capability has an output-shape assertion here", () => {
    const reads = new Map(discoverReadCapabilities().map((c) => [c.id, c]));
    for (const claim of DOC_VERIFIED_OUTPUT_SHAPE) {
      const found = reads.get(claim.id);
      assert.ok(
        found,
        `${claim.id}: claimed verified in the docs (${claim.evidence}) but this gate cannot see it as a read ` +
          `capability — either the id moved or the claim still needs an output-shape assertion`,
      );
      assert.ok(claim.mustCarry.length > 0, `${claim.id}: a verified claim must pin the output shape it verified`);
      for (const key of claim.mustCarry) {
        assert.ok(
          found.region.includes(key),
          `${claim.id}: claimed verified (${claim.evidence}) but its success path never emits "${key}" — ` +
            `a wiring-only proof is not evidence that the OUTPUT is real`,
        );
      }
      assert.ok(
        claim.evidence.length > 30,
        `${claim.id}: the claim must cite the evidence that makes it verified, not merely assert verification`,
      );
    }
  });

  test("no doc-verified read may sit on the fake-able list — both claims cannot be true", () => {
    const fakeable = new Set(UNPROVEN_READ_OK.map((d) => d.id));
    for (const claim of DOC_VERIFIED_OUTPUT_SHAPE) {
      assert.ok(
        !fakeable.has(claim.id),
        `${claim.id}: docs claim it is verified (${claim.evidence}) while this gate proves it can report a ` +
          `successful empty answer — a verified claim and an unproven verdict cannot both be true`,
      );
    }
  });

  test("MUTATION: a verified runner that stopped emitting its verified keys fails the shape assertion", () => {
    const src = stripComments(readIfPresent(`${RUNNER_DIR}/araprat.ts`));
    const region = decidingRegion(src, "araprat_search");
    const claim = DOC_VERIFIED_OUTPUT_SHAPE.find((c) => c.id === "araprat_search");
    assert.ok(claim, "precondition: the araprat_search claim exists");
    for (const key of claim.mustCarry) {
      assert.ok(region.includes(key), `precondition: the real runner emits "${key}"`);
      const neutered = region.split(key).join("__redacted__");
      assert.ok(
        !neutered.includes(key),
        `a real runner that stopped emitting "${key}" MUST fail the shape assertion — this proves the key is ` +
          `load-bearing and the assertion is not a rubber stamp`,
      );
    }
  });
});
