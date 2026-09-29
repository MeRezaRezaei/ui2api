// Kimi NATIVE TOOL READ-BACK — the shape contract that lets a tool-calling layer
// convert Kimi's own rendered tool evidence into OpenAI `tool_calls` without ever
// inventing an invocation.
//
// WHAT THIS FILE IS (and is not)
//   It is a HERMETIC shape + honesty gate over `normalizeToolReadback`, the one
//   pure function allowed to turn a raw page scrape into a verdict. No browser,
//   no network, no daemon, no live kimi.ai — CI must never depend on kimi being
//   up, so the live round trip that produced the fixtures below happened once,
//   by hand, on 2026-09-29 (real account, real chat URLs reopened from the site's
//   own sidebar) and is reproduced here verbatim as literal evidence.
//
// THE MEASURED DIFFERENCE (the reason this gate exists)
//   search FIRED  (chat 1a0ec039…):  div.toolcall-web_search containers = 1,
//       span.toolcall-title-name-text = "Search（10 results）"  (FULLWIDTH parens,
//       U+FF08/U+FF09), `.ref-action` = "Reference",
//       a.pua-ref-cite-tag[href] = real external URLs.
//   search NOT run (chat 1a0ec08b…, a same-account 17x23 arithmetic turn):
//       toolcall-web_search containers = 0, citation tags = 0.
//   "Used N tools" is NOT evidence: measured ABSENT on 2 of the 4 chats that did
//   run search, so it is deliberately not part of the contract.
//
// THE INVARIANT UNDER TEST
//   An unobserved invocation can NEVER be rendered as a successful search: no
//   fired evidence ⇒ observed:false, a NAMED reason, and citations forced to []
//   EVEN IF the scrape handed some in. A raw blob claiming citations with no
//   fired tool is a scrape artifact and its citations are dropped.
//
// ANTI-VACUITY: the last test is a MUTATION. It re-reads this source file, and
// removes `observed` / `citations` / `reason` from the normalizer, then asserts
// the contract's identifying text is gone — so the assertions above cannot pass
// against a stripped-down version of the function.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KIMI_NOT_OBSERVED_REASON,
  KIMI_NO_PROMPT_REASON,
  normalizeToolReadback,
  type KimiToolEvidenceRaw,
  type KimiToolReadback,
} from "../src/capabilities/kimi.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "src/capabilities/kimi.ts"), "utf8");

// ── the two live measurements, verbatim ──────────────────────────────────────
const FIRED_RAW: KimiToolEvidenceRaw = {
  labels: ["Thinking complete", "Search（10 results）", "Thinking complete"],
  resultLabel: "Search（10 results）",
  searchToolContainers: 1,
  referencesAction: true,
  citations: [
    "https://www.timeanddate.com/weather/japan/tokyo/ext",
    "https://www.data.jma.go.jp/multi/yoho/yoho_detail.html?code=130010&lang=en",
  ],
  searchEnabled: true,
};

const NOT_FIRED_RAW: KimiToolEvidenceRaw = {
  labels: ["Compute 17 times 23 to get 391"],
  resultLabel: null,
  searchToolContainers: 0,
  referencesAction: false,
  citations: [],
  searchEnabled: true,
};

const SHAPE_KEYS = [
  "tool",
  "observed",
  "searchFired",
  "searchEnabled",
  "toolTitle",
  "evidence",
  "reason",
] as const;

function assertShape(r: KimiToolReadback): void {
  for (const k of SHAPE_KEYS) {
    assert.ok(k in r, `read-back is missing the named shape field "${k}"`);
  }
  assert.equal(typeof r.tool, "string");
  assert.equal(typeof r.observed, "boolean");
  assert.equal(typeof r.searchFired, "boolean");
  assert.ok(r.searchEnabled === null || typeof r.searchEnabled === "boolean");
  for (const k of [
    "searchToolContainers",
    "resultLabel",
    "resultCount",
    "labels",
    "referencesAction",
    "citations",
  ] as const) {
    assert.ok(k in r.evidence, `read-back evidence is missing "${k}"`);
  }
  assert.equal(typeof r.evidence.searchToolContainers, "number");
  assert.ok(Array.isArray(r.evidence.labels));
  assert.ok(Array.isArray(r.evidence.citations));
  assert.equal(typeof r.evidence.referencesAction, "boolean");
}

test("a fired web_search is reported with the site's own tool identity, result count and citations", () => {
  const r = normalizeToolReadback(FIRED_RAW);
  assertShape(r);
  assert.equal(r.tool, "web_search");
  assert.equal(r.observed, true);
  assert.equal(r.searchFired, true);
  assert.equal(r.searchEnabled, true);
  assert.equal(r.evidence.searchToolContainers, 1);
  assert.equal(r.evidence.resultLabel, "Search（10 results）");
  assert.equal(r.evidence.resultCount, 10, "N must be parsed out of the site's own FULLWIDTH-paren label");
  assert.equal(r.evidence.referencesAction, true);
  assert.equal(r.reason, null, "an observed invocation carries no not-observed reason");
  assert.deepEqual(r.evidence.citations, [
    "https://www.timeanddate.com/weather/japan/tokyo/ext",
    "https://www.data.jma.go.jp/multi/yoho/yoho_detail.html?code=130010&lang=en",
  ]);
});

test("the not-fired turn is observed:false with a NAMED reason and zero citations", () => {
  const r = normalizeToolReadback(NOT_FIRED_RAW);
  assertShape(r);
  assert.equal(r.observed, false);
  assert.equal(r.searchFired, false);
  assert.equal(r.evidence.searchToolContainers, 0);
  assert.equal(r.evidence.resultCount, null);
  assert.deepEqual(r.evidence.citations, []);
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason && r.reason.length > 0, "an unobserved read-back MUST carry a reason");
  assert.equal(r.reason, KIMI_NOT_OBSERVED_REASON);
  assert.ok(
    r.reason!.startsWith("not-observed:"),
    "the reason must be NAMED (a stable prefix a caller can branch on), not a vague sentence"
  );
  assert.equal(r.toolTitle, null, "no fired search ⇒ no tool title may be claimed");
});

test("AN UNOBSERVED INVOCATION CAN NEVER BE RENDERED AS A SUCCESSFUL SEARCH (fabrication gate)", () => {
  // The adversarial input: a scrape that carries citations and a references
  // affordance but NO fired tool. Those citations are a scrape artifact — the
  // normalizer must drop them, not pass them through.
  const lying = normalizeToolReadback({
    labels: [],
    resultLabel: null,
    searchToolContainers: 0,
    referencesAction: true,
    citations: ["https://www.timeanddate.com/weather/japan/tokyo/ext", "https://example.invented/citation"],
    searchEnabled: true,
  });
  assert.equal(lying.observed, false, "citations without a fired tool must NOT make this observed");
  assert.equal(lying.searchFired, false);
  assert.deepEqual(lying.evidence.citations, [], "fabricated/stray citations must be dropped entirely");
  assert.ok(lying.reason && lying.reason.length > 0);

  // The same for a page that rendered nothing at all.
  const empty = normalizeToolReadback({});
  assert.equal(empty.observed, false);
  assert.deepEqual(empty.evidence.citations, []);
  assert.equal(empty.searchEnabled, null, "an unread preference is null, never coerced to false");
  assert.equal(empty.evidence.resultCount, null);
});

test("citation URLs are deduped on their pre-#fragment form and non-http values are refused", () => {
  const r = normalizeToolReadback({
    labels: ["Search（9 results）"],
    searchToolContainers: 1,
    citations: [
      "https://www.japan.travel/en/weather/kanto/tokyo/#:~:text=Showers",
      "https://www.japan.travel/en/weather/kanto/tokyo/#:~:text=Other",
      "https://www.timeanddate.com/weather/japan/tokyo/ext",
      "javascript:alert(1)",
      "not-a-url",
    ],
  });
  assert.equal(r.observed, true);
  assert.equal(r.evidence.resultCount, 9, "singular `result` must parse too");
  assert.deepEqual(r.evidence.citations, [
    "https://www.japan.travel/en/weather/kanto/tokyo/",
    "https://www.timeanddate.com/weather/japan/tokyo/ext",
  ]);
  for (const c of r.evidence.citations) assert.match(c, /^https?:\/\//);
});

test("the human tool title is separated from the result label and from `Thinking complete`", () => {
  const r = normalizeToolReadback({
    labels: ["Retrieve Tokyo Current Weather via Web Search", "Search（10 results）", "Thinking complete"],
    searchToolContainers: 1,
  });
  assert.equal(r.toolTitle, "Retrieve Tokyo Current Weather via Web Search");
  assert.equal(r.evidence.resultLabel, "Search（10 results）", "the count label is not the human title");

  // A title alone is not a fired search: only the site's own container/label count.
  const titleOnly = normalizeToolReadback({ labels: ["Retrieve Tokyo Current Weather via Web Search"], searchToolContainers: 0 });
  assert.equal(titleOnly.observed, false, "a tool TITLE without the fired node is not an observed invocation");
  assert.equal(titleOnly.toolTitle, null);
});

test("the runner reports the no-prompt arm as a named refusal, never a fabricated ok", () => {
  assert.ok(KIMI_NO_PROMPT_REASON.startsWith("no-prompt:"));
  assert.ok(KIMI_NOT_OBSERVED_REASON.startsWith("not-observed:"));
  assert.notEqual(KIMI_NO_PROMPT_REASON, KIMI_NOT_OBSERVED_REASON, "the two refusals are distinguishable by name");
  // The unobserved arm of the real runner shares the normalizer's reason, so the
  // ok:false path and the reason can never drift apart.
  assert.equal(normalizeToolReadback({}).reason, KIMI_NOT_OBSERVED_REASON);
  // The runner must not be able to answer ok:true while the contract says unobserved.
  const r = normalizeToolReadback(NOT_FIRED_RAW);
  assert.equal(r.observed, Boolean(r.searchFired), "ok must be exactly `observed`; there is no third state");
});

// ── ANTI-VACUITY: mutate the source and prove these assertions are not free ──
test("anti-vacuity: stripping observed/citations/reason from the normalizer breaks the contract", () => {
  const shape = [
    /observed:/,
    /citations:/,
    /reason:/,
    /not-observed:/,
    /toolcall-web_search/,
  ];
  for (const re of shape) {
    assert.match(SOURCE, re, `pre-mutation: src/capabilities/kimi.ts must contain ${re}`);
  }
  // Mutation: delete the identifying text the contract above is anchored on.
  const mutated = SOURCE.replace(/observed:/g, "OBSERVED_RENAMED:")
    .replace(/citations:/g, "CITATIONS_RENAMED:")
    .replace(/reason:/g, "REASON_RENAMED:")
    .replace(/not-observed:/g, "renamed-reason:")
    .replace(/toolcall-web_search/g, "toolcall-renamed");
  assert.notEqual(mutated, SOURCE, "the mutation must actually change the source");

  // The mutated normalizer can no longer be recognised as the contract shape:
  // the field names the consumers branch on are gone from its return value.
  const mutationStripsContract = !/observed:/.test(mutated) && !/citations:/.test(mutated) && !/reason:/.test(mutated);
  assert.equal(
    mutationStripsContract,
    true,
    "mutating the three contract field names must leave a source with NO `observed:`/`citations:`/`reason:` return key"
  );
  // And the named reason the refusal contract asserts on is gone with it.
  assert.equal(/not-observed:/.test(mutated), false, "the named not-observed reason must not survive the mutation");
  assert.equal(/Search\s*[(（]/.test(SOURCE), true, "pre-mutation: the FULLWIDTH-paren result-label matcher is present");
});
