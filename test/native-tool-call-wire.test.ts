/**
 * NATIVE TOOL CALLS ON /v1/chat/completions — the real-thing pins.
 * ============================================================================
 *
 * The operator's ask, verbatim:
 *   "lets make it real we can have a real open ai compatible that hosts real ai
 *    requests behind the scene this is just a matter of wireing"
 *
 * A SOFT tool call — the layer that already existed — asks the MODEL, in prose,
 * to emit a function call and parses the reply back. MEASURED: 0-for-1. The
 * model ignored the instruction. It is not a tool call; it is a request for one.
 *
 * A NATIVE tool call is a record of something that actually happened: the SITE,
 * through its own UI and its own JavaScript, invoked a tool while answering this
 * turn, and rendered the result into the page we were already holding. Nothing
 * here is inferred, requested, or guessed. The evidence is read back off the
 * site's own DOM, and the verdict is made by the site's own fabrication gate
 * (`normalizeToolReadback` in src/capabilities/kimi.ts).
 *
 * The property that matters, and the one every pin below defends:
 *   AN UNOBSERVED TURN PRODUCES NO TOOL CALL.
 * Not an empty one, not a best-guess one, not a soft one wearing a native label.
 * No call at all, and an ordinary answer. Everything else here follows from it.
 *
 * These pins run against a STUB pool whose driver's page returns a fixed raw
 * DOM scrape — no browser, no network, no vault. The scrape is the same shape
 * src/capabilities/kimi.ts hands its normalizer after reading a live kimi.ai
 * account, so a green pin means the wire is right for a real scrape.
 */
import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

import * as REAL from "../src/prompt/openai.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";

type Mod = typeof import("../src/prompt/openai.js");

// ------------------------------------------------------------------ fixtures --

const kimiProfile = {
  id: "kimi",
  name: "Kimi",
  url: "https://www.kimi.ai",
  loginRequired: true,
} as unknown as ChatSiteProfile;
const deepseekProfile = {
  id: "deepseek",
  name: "DeepSeek",
  url: "https://chat.deepseek.com",
  loginRequired: true,
} as unknown as ChatSiteProfile;

const profilesById = { kimi: kimiProfile, deepseek: deepseekProfile };

/** The site's own citations — real URLs the site rendered on its own anchors. */
const SITE_CITATIONS = [
  "https://www.timeanddate.com/weather/japan/tokyo",
  "https://data.jma.go.jp/forecast/tokyo",
];
/** The site's own label, with the FULLWIDTH parens kimi actually uses (U+FF08/09). */
const SITE_RESULT_LABEL = "Search（10 results）";
const SITE_TOOL_TITLE = "Retrieve Tokyo current weather via Web Search";

/**
 * The raw DOM scrape for a turn where the SITE ITSELF ran web search — the exact
 * shape src/capabilities/kimi.ts collects. `searchToolContainers: 1` is the
 * site's own fired-search node; the label corroborates it.
 */
const FIRED_SCRAPE = {
  labels: [SITE_RESULT_LABEL, SITE_TOOL_TITLE],
  resultLabel: SITE_RESULT_LABEL,
  searchToolContainers: 1,
  referencesAction: true,
  citations: SITE_CITATIONS,
  searchEnabled: true,
};

/** A turn where the site ran NO tool: no container, no label, no citations. */
const NOT_FIRED_SCRAPE = {
  labels: [],
  resultLabel: null,
  searchToolContainers: 0,
  referencesAction: false,
  citations: [],
  searchEnabled: false,
};

/**
 * A turn whose raw scrape CARRIES citations but shows no fired tool — a scrape
 * artifact. The fabrication gate must drop the citations rather than promote
 * them, and the wire must show no call at all.
 */
const CITATIONS_WITHOUT_FIRE = {
  labels: ["Thinking complete"],
  resultLabel: null,
  searchToolContainers: 0,
  referencesAction: false,
  citations: SITE_CITATIONS,
  searchEnabled: false,
};

/** A page that returns a fixed raw scrape, like a real post-answer readback. */
function stubPage(scrape: unknown) {
  return { evaluate: async (_script: string) => scrape };
}

/**
 * A pool whose worker answers with `answer` and whose driver's page returns
 * `scrape`. `tools` (the caller's `tools` array) is threaded through so the soft
 * path can be exercised on the same wire.
 */
function stubPool(opts: { answer: string; scrape?: unknown; parseToolCall?: (raw: string, tools: unknown) => unknown; stripToolCall?: (raw: string) => string }) {
  return {
    acquire: async () => ({
      driver: {
        ask: async () => ({
          answer: opts.answer,
          chunkCount: 4,
          doneReason: "stable",
          url: "https://www.kimi.ai/chat/abc",
          title: "Tokyo weather",
        }),
        page: opts.scrape === undefined ? undefined : stubPage(opts.scrape),
      },
    }),
    release: async () => undefined,
  };
}

const softTools = {
  buildToolInstruction: () => "INSTRUCTION",
  parseToolCall: (raw: string, _tools: unknown) => (raw.includes("CALLME") ? { toolCallId: "call_soft_1", name: "get_weather", argumentsJson: '{"city":"Tehran"}' } : null),
  stripToolCall: (raw: string) => ({ content: raw.replace(/CALLME[\s\S]*$/, "").trim(), parsed: true }),
};

async function serve(mod: Mod, pool: unknown, withSoft: boolean): Promise<{ base: string; close(): Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    try {
      await mod.handleOpenAIRoutes(req, res, {
        pool: pool as never,
        profilesById: profilesById as Record<string, ChatSiteProfile>,
        ...(withSoft ? { softTools } : {}),
      });
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function complete(
  base: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "kimi", messages: [{ role: "user", content: "weather in Tokyo?" }], ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.json() };
}

const CHOICE = (b: any) => b.choices?.[0];

/** Ask once, with a stub pool built from the given fixture. */
async function ask(opts: {
  answer: string;
  scrape?: unknown;
  model?: string;
  withSoft?: boolean;
  tools?: unknown;
  stream?: boolean;
  /**
   * The explicit CONSENT the soft path requires (4b7ee4b). A soft tool call is
   * surfaced ONLY when the request carries `tool_choice: "auto"` (or an object);
   * anything else — absent, "none", "required" — leaves the layer unrun and the
   * answer untouched. So a request that means to exercise the SOFT path must say
   * so in its own body: offering `tools` is no longer enough.
   */
  toolChoice?: "auto";
}): Promise<any> {
  const { base, close } = await serve(
    REAL,
    stubPool({ answer: opts.answer, scrape: opts.scrape, parseToolCall: softTools.parseToolCall, stripToolCall: softTools.stripToolCall as never }),
    opts.withSoft === true
  );
  try {
    const { body } = await complete(base, {
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.stream ? { stream: true } : {}),
      ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
    });
    return body;
  } finally {
    await close();
  }
}

// ------------------------------------------------- 1. the real, observed call --

d("A NATIVE tool call is the site's own invocation, and its arguments are the site's own evidence", () => {
  t("an observed read-back emits tool_calls whose arguments are traceable to the evidence", async () => {
    const body = await ask({ answer: "It is 18C and humid in Tokyo.", scrape: FIRED_SCRAPE });
    const choice = CHOICE(body);

    assert.equal(body.status, undefined, "the response is a completion, not an error");
    assert.ok(Array.isArray(choice.message.tool_calls), "an observed native read-back MUST emit a tool_calls array");
    assert.equal(choice.message.tool_calls.length, 1, "exactly one call: the site made one search");

    const call = choice.message.tool_calls[0];
    assert.equal(call.type, "function");
    assert.ok(typeof call.id === "string" && call.id.length > 0, "a call carries an id, so a follow-up tool message can reference it");
    assert.equal(call.function.name, "kimi_web_search", "the name is DERIVED from the site's own tool id using this repo's <site>_<capability> rule");

    // TRACEABILITY: every argument value must be a value the site itself
    // rendered. This is the anti-fabrication property stated as a check on the
    // parsed arguments, not on a comment.
    const args = JSON.parse(call.function.arguments);
    assert.deepEqual(args.citations, SITE_CITATIONS, "the citations are the site's own rendered URLs, in page order");
    assert.equal(args.result_count, 10, "the result count is the N the site printed in its own label");
    assert.equal(args.tool_title, SITE_TOOL_TITLE, "the tool title is the site's own rendered title");
    assert.deepEqual(Object.keys(args).sort(), ["citations", "result_count", "tool", "tool_title"],
      "the argument object carries ONLY measured evidence — no prompt text, no answer text, no inferred query");

    // The fullwidth-paren label is the measured site format; if the normalizer
    // ever stops understanding it, the count silently becomes null and the pin
    // that asserts `=== 10` goes red. That is the point of asserting the number.
    assert.equal(args.result_count, Number("10"), "the FULLWIDTH-paren label `Search（10 results）` must yield 10");
  });

  t("an observed read-back finishes with finish_reason 'tool_calls', not 'stop'", async () => {
    const body = await ask({ answer: "It is 18C in Tokyo.", scrape: FIRED_SCRAPE });
    assert.equal(CHOICE(body).finish_reason, "tool_calls",
      "OpenAI's own vocabulary requires 'tool_calls' whenever the message carries the key; 'stop' with a call is a protocol error a strict SDK will not reconcile");
  });

  t("the streaming path emits the same call, with the mechanism on the FINAL frame", async () => {
    const { base, close } = await serve(REAL, stubPool({ answer: "18C in Tokyo.", scrape: FIRED_SCRAPE }), false);
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "kimi", messages: [{ role: "user", content: "weather?" }], stream: true }),
        signal: AbortSignal.timeout(20_000),
      });
      const raw = await res.text();
      const frames = raw.split("\n\n").filter((f) => f.startsWith("data: ") && !f.includes("[DONE]"));
      const payloads = frames.map((f) => JSON.parse(f.slice(6)));
      const callFrame = payloads.find((p) => p.choices[0].delta?.tool_calls);
      const last = payloads[payloads.length - 1];

      assert.ok(callFrame, "the stream must carry a delta.tool_calls frame");
      assert.equal(callFrame.choices[0].delta.tool_calls[0].index, 0, "the fragment index is required by a streaming SDK's accumulator");
      assert.equal(callFrame.choices[0].delta.tool_calls[0].function.name, "kimi_web_search");
      assert.equal(last.choices[0].finish_reason, "tool_calls", "the terminating frame carries the call finish_reason");
      assert.equal(last.choices[0].ui2api.toolCall.mechanism, "native", "the mechanism rides the FINAL frame — the one a consumer is guaranteed to read");
      assert.ok(raw.endsWith("data: [DONE]\n\n"), "the stream still terminates with the OpenAI sentinel");
    } finally {
      await close();
    }
  });
});

// ------------------------------------------------ 2. THE FABRICATION GUARD --
//
// These are the pins that make "real" mean real. A turn where the site ran no
// tool must look, on the wire, exactly like a turn that never could have.

d("An UNOBSERVED turn produces NO tool call", () => {
  t("no fired tool => no tool_calls, an ordinary answer, and finish_reason 'stop'", async () => {
    const answer = "17 x 23 = 391.";
    const body = await ask({ answer, scrape: NOT_FIRED_SCRAPE });
    const choice = CHOICE(body);

    assert.equal("tool_calls" in choice.message, false, "an unobserved read-back MUST NOT emit a tool_calls key — not empty, not absent-but-implied");
    assert.equal(choice.message.content, answer, "and the answer comes back completely untouched");
    assert.equal(choice.finish_reason, "stop", "an ordinary reply finishes as 'stop'");
  });

  t("the absence is DIAGNOSABLE: the response names the reason there was no call", async () => {
    const body = await ask({ answer: "391", scrape: NOT_FIRED_SCRAPE });
    const native = body.ui2api?.nativeTool;
    assert.ok(native, "a site with a native reader must report its native outcome, or a missing call is indistinguishable from a broken reader");
    assert.equal(native.attempted, true, "the read-back really was attempted");
    assert.equal(native.observed, false, "and it really observed nothing");
    assert.match(String(native.reason), /not-observed/, "with the site's own NAMED reason, not a generic 'no'");
  });

  t("citations in the raw scrape with NO fired tool are DROPPED, never promoted", async () => {
    const body = await ask({ answer: "391", scrape: CITATIONS_WITHOUT_FIRE });
    const choice = CHOICE(body);
    // This is the fabrication gate's whole reason for existing: a raw blob can
    // carry URLs with nothing behind them, and the only safe reading of that is
    // "the scrape lied", not "here are your citations".
    assert.equal("tool_calls" in choice.message, false, "citations with no fired tool are a scrape artifact, not an invocation");
    assert.deepEqual(body.ui2api?.nativeTool?.citations ?? [], [], "no citations are surfaced anywhere on the wire");
  });

  t("a site with NO native reader can never produce a call, even with a page that would satisfy one", async () => {
    const body = await ask({ answer: "391", scrape: FIRED_SCRAPE, model: "deepseek" });
    assert.equal("tool_calls" in CHOICE(body).message, false,
      "deepseek has no measured reader, so its turns never claim native — the same evidence-shaped page is not enough, the SITE must be one we measured");
    assert.equal(body.ui2api?.nativeTool, undefined, "and no native outcome is reported for a site that has no reader at all");
  });

  t("a driver with no readable page produces no call and no crash", async () => {
    const body = await ask({ answer: "391" }); // no scrape at all => driver.page undefined
    assert.equal("tool_calls" in CHOICE(body).message, false, "no page, no read-back, no call");
    assert.equal(CHOICE(body).message.content, "391");
  });
});

// ---------------------------------------- 3. native vs soft, IN THE RESPONSE --
//
// The ask: a consumer must be able to tell them apart WITHOUT reading ui2api
// docs. That is a FIELD, and these pins are the field's contract.

d("A consumer can tell a NATIVE call from a SOFT call by reading the response", () => {
  const OFFERED_TOOLS = [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];

  t("the two are distinguishable by mechanism + executed, with no ui2api documentation", async () => {
    // Both requests mean to exercise a path that can produce a call, so BOTH
    // carry the explicit consent the soft path requires. The native side ignores
    // it (its consent is the site's own read-back), but the soft side is gated on
    // it — without `tool_choice: "auto"` there is no soft call to compare to.
    const native = CHOICE(await ask({ answer: "18C in Tokyo.", scrape: FIRED_SCRAPE, withSoft: true, tools: OFFERED_TOOLS, toolChoice: "auto" }));
    const soft = CHOICE(await ask({ answer: 'CALLME {"name":"get_weather","arguments":{"city":"Tehran"}}', scrape: NOT_FIRED_SCRAPE, withSoft: true, tools: OFFERED_TOOLS, toolChoice: "auto" }));

    assert.equal(native.ui2api.toolCall.mechanism, "native");
    assert.equal(native.ui2api.toolCall.executed, true, "the site really ran the tool");
    assert.equal(soft.ui2api.toolCall.mechanism, "soft-prompt");
    assert.equal(soft.ui2api.toolCall.executed, false, "nothing ran; the CALLER runs the function");

    // The one-line discriminator a consumer can rely on:
    assert.notEqual(native.ui2api.toolCall.mechanism, soft.ui2api.toolCall.mechanism, "the two mechanisms are distinguishable from the response alone");
    // And the native one carries evidence while the soft one carries none:
    assert.ok(Array.isArray(native.ui2api.toolCall.evidence.citations) && native.ui2api.toolCall.evidence.citations.length > 0);
    assert.equal(soft.ui2api.toolCall.evidence, null, "a soft call has NO evidence, and says so with null rather than a plausible empty object");
  });

  t("both are valid OpenAI tool calls — the provenance is ADDITIVE, never a fork of the protocol", async () => {
    for (const body of [
      await ask({ answer: "18C in Tokyo.", scrape: FIRED_SCRAPE, withSoft: true, tools: OFFERED_TOOLS, toolChoice: "auto" }),
      await ask({ answer: 'CALLME {"name":"get_weather","arguments":{"city":"Tehran"}}', scrape: NOT_FIRED_SCRAPE, withSoft: true, tools: OFFERED_TOOLS, toolChoice: "auto" }),
    ]) {
      const m = CHOICE(body).message;
      assert.equal(m.role, "assistant");
      assert.equal(m.tool_calls.length, 1);
      assert.equal(m.tool_calls[0].type, "function", "the standard shape is intact for both");
      assert.equal(typeof m.tool_calls[0].function.arguments, "string", "arguments stay a JSON STRING, as OpenAI specifies — an object would be coerced to garbage by a real SDK");
      assert.equal(CHOICE(body).finish_reason, "tool_calls", "and both finish with the protocol's own value");
    }
  });

  t("a real native invocation OUTRANKS a soft one, and the suppression is recorded", async () => {
    // The site genuinely searched AND the model also emitted soft scaffolding.
    // Reporting the soft one would understate what happened and hand the caller
    // the weaker evidence — so native wins, and nothing is hidden.
    const choice = CHOICE(await ask({
      answer: 'CALLME {"name":"get_weather","arguments":{"city":"Tehran"}}',
      scrape: FIRED_SCRAPE,
      withSoft: true,
      tools: OFFERED_TOOLS,
      // The soft scaffolding is on the wire here, so consent must be too —
      // otherwise the soft layer never runs and there is nothing to suppress.
      toolChoice: "auto",
    }));
    assert.equal(choice.ui2api.toolCall.mechanism, "native", "the site's real invocation is the one reported");
    assert.equal(choice.message.tool_calls[0].function.name, "kimi_web_search");
    assert.equal(choice.ui2api.toolCall.suppressedSoft, true, "the suppressed soft call is disclosed, not silently dropped");
  });

  t("the soft path still fails CLOSED: a non-compliant model yields no call", async () => {
    const body = await ask({ answer: "I would rather just tell you it is sunny.", scrape: NOT_FIRED_SCRAPE, withSoft: true, tools: OFFERED_TOOLS });
    assert.equal("tool_calls" in CHOICE(body).message, false, "a model that ignored the instruction must yield NO call — never a name the caller never offered");
    assert.equal(CHOICE(body).finish_reason, "stop");
    assert.equal(CHOICE(body).message.content, "I would rather just tell you it is sunny.", "the answer is returned untouched");
  });

  t("/v1/models advertises which mechanism a site can reach, BEFORE any call is made", async () => {
    const { base, close } = await serve(REAL, stubPool({ answer: "x" }), true);
    try {
      const data = (await (await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(20_000) })).json()).data;
      const kimi = data.find((m: any) => m.id === "kimi");
      const ds = data.find((m: any) => m.id === "deepseek");
      assert.equal(kimi.tools, "native", "kimi HAS a measured reader, so it is honestly 'native'");
      assert.deepEqual(kimi.toolMechanisms, ["native", "soft"], "and it also honours a caller's tools array — both are true and both are listed");
      assert.equal(ds.tools, "soft", "deepseek has no reader, so it is honestly 'soft' on the same daemon");
      assert.equal(ds.toolMechanisms.includes("native"), false);
      assert.equal(kimi.toolCallProvenanceField, "choices[0].ui2api.toolCall.mechanism", "and the consumer is told WHICH FIELD carries the mechanism on a returned call");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------- 4. mutation reds --
//
// Two REAL reds, each produced by deleting one load-bearing line from the real
// source and re-running the real pin against the mutant MODULE. Not a
// re-implementation of the mutant — the real file, with a feature removed.
//
// Each mutant is also asserted to have CHANGED THE SOURCE. A surgery string
// that silently stops matching would leave the mutant identical to the original
// and the "red" would be green for no reason — that is the failure mode a
// mutation test is most vulnerable to, so it is checked explicitly.

const SRC_PATH = resolve(import.meta.dirname, "..", "src", "prompt", "openai.ts");
const SRC = readFileSync(SRC_PATH, "utf8");
const SRC_DIR = dirname(SRC_PATH);

/**
 * Materialise a mutant of the real openai.ts and import it.
 *
 * The mutant is written to a temp dir, so its RELATIVE imports would not
 * resolve. They are rewritten to absolute paths back into the real repo, which
 * keeps the mutant running the REAL registry, the REAL fabrication gate and the
 * REAL profile catalog — a mutant that stubbed those out would be proving
 * nothing about the file under test.
 */
async function mutant(label: string, surgery: (src: string) => string): Promise<{ mod: Mod; edited: string }> {
  let edited = surgery(SRC);
  // `node:*` specifiers stay; every relative one is repointed at the real file.
  edited = edited.replace(/from "(\.[^"]*)"/g, (_m, spec: string) => {
    const abs = resolve(SRC_DIR, spec).replace(/\.js$/, ".ts");
    return `from ${JSON.stringify(pathToFileURL(abs).href)}`;
  });
  assert.notEqual(edited, SRC, `mutation "${label}" did not change the source — the surgery string is stale, so the red below would be vacuous`);
  const dir = mkdtempSync(join(tmpdir(), `native-wire-${label}-`));
  const file = join(dir, "mutant.ts");
  writeFileSync(file, edited, "utf8");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { mod: (await import(pathToFileURL(file).href)) as Mod, edited };
}


/** PIN 1 as a predicate, OVER THE WIRE: an observed read-back still produces a
 *  real tool call on an actual HTTP response. This is the pin that binds the
 *  EMISSION SITE in the handler, not just the pure builder — a builder that
 *  works perfectly but is never called emits nothing, and "real" has to mean
 *  reachable. */
async function holdsNativeEmissionOverWire(m: Mod): Promise<boolean> {
  const { base, close } = await serve(m, stubPool({ answer: "18C in Tokyo.", scrape: FIRED_SCRAPE }), false);
  try {
    const { body } = await complete(base, {});
    return Array.isArray(CHOICE(body)?.message?.tool_calls) && CHOICE(body).message.tool_calls.length === 1;
  } finally {
    await close();
  }
}

/** PIN 2 as a predicate: an UNOBSERVED read-back still produces no call. */
function holdsUnobservedGuardPin(m: Mod): boolean {
  return (
    m.buildNativeToolCall(
      {
        tool: "web_search",
        observed: false,
        toolTitle: null,
        resultCount: null,
        resultLabel: null,
        citations: [],
        reason: "not-observed: the site rendered no tool evidence",
      },
      "kimi"
    ) === null
  );
}

d("MUTATION REDS: each load-bearing behaviour is held by a real pin", () => {
  t("RED A — removing the native EMISSION makes the observed pin fail", async () => {
    // The deletion: the handler stops building a native call. The builder itself
    // is left completely intact and still returns a perfect call when called —
    // which is the whole point. A pin on the pure builder would stay green here,
    // because the builder did not change. Only a pin that goes over the WIRE can
    // catch "the function works but nothing ever asks for it", which is how a
    // native path silently becomes dead code.
    const { mod: m, edited } = await mutant("no-native-emission", (s) =>
      s.replace(
        "const built = buildNativeToolCall(native, profile.id);",
        'const built = null as unknown as ReturnType<typeof buildNativeToolCall>; // MUTANT A: native emission removed'
      )
    );
    // ANTI-VACUITY: the surgery must actually have landed in the MUTANT. If the
    // anchor had not matched, the mutant would be byte-identical to the original
    // and the pin would pass — a silent green, the one failure mode a mutation
    // test cannot detect on its own.
    assert.match(edited, /MUTANT A/, "anti-vacuity: the mutation anchor did not land in the mutant source");
    assert.equal(
      m.buildNativeToolCall({ tool: "web_search", observed: true, toolTitle: SITE_TOOL_TITLE, resultCount: 10, resultLabel: SITE_RESULT_LABEL, citations: SITE_CITATIONS, reason: null }, "kimi") !== null,
      true,
      "the BUILDER is untouched by this mutation — so a red below is the emission site, not a broken builder"
    );
    assert.equal(await holdsNativeEmissionOverWire(m), false, "with the emission removed, an observed read-back produces NO tool call on the wire — the pin goes RED, which is what proves the emission was load-bearing");
    assert.equal(holdsUnobservedGuardPin(m), true, "and the unobserved guard is untouched, so the other pin must still pass — the mutant is surgical, not a blunt removal");
  });

  t("RED B — removing the observed:false guard makes the fabrication pin fail", async () => {
    // The deletion: the single line that makes an unobserved turn produce no
    // call. This is THE safety property of the whole file — delete it and the
    // surface starts inventing calls out of turns where nothing happened.
    const { mod: m, edited } = await mutant("no-observed-guard", (s) =>
      s.replace(
        "  if (!evidence) return null;\n  if (evidence.observed !== true) return null;",
        "  if (!evidence) return null;"
      )
    );
    // ANTI-VACUITY: this surgery is a pure DELETION, so the only proof it landed
    // is that the guard is GONE from the mutant while present in the real source.
    assert.match(SRC, /if \(evidence\.observed !== true\) return null;/, "the guard exists in the real source");
    assert.equal(edited.includes("if (evidence.observed !== true) return null;"), false, "anti-vacuity: the guard is still present in the mutant — the deletion did not land");
    assert.equal(holdsUnobservedGuardPin(m), false, "with the observed guard deleted, an UNOBSERVED turn fabricates a tool call — the pin goes RED, which is what proves the guard was load-bearing");
    assert.equal(await holdsNativeEmissionOverWire(m), true, "and the observed path still reaches the wire, so this red is the guard specifically and not a broken module");
  });

  t("both mutants are proven load-bearing: the surgery really removed a real line", async () => {
    // The blunt version of the anti-vacuity check: count the guards in the real
    // source. If a future edit renames or reorders them, these two pins' anchors
    // would stop matching and the reds above would quietly become greens.
    const guardLines = SRC.match(/if \(!evidence\) return null;/g) ?? [];
    const observedLines = SRC.match(/if \(evidence\.observed !== true\) return null;/g) ?? [];
    assert.equal(guardLines.length, 1, "exactly one null-evidence guard exists for the mutation anchor to target");
    assert.equal(observedLines.length, 1, "exactly one observed-guard exists for the mutation anchor to target");
    assert.ok(SRC.includes("buildNativeToolCall(native, profile.id)"), "the handler must reach the native emission through the evidence it read, not through a second path");
  });
});
