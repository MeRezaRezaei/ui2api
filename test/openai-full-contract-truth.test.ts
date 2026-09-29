// The OpenAI /v1 CONTRACT GATE — a consumer can code against this file.
//
// The /v1 surface already works with the real `openai` SDK (models.list,
// chat.completions.create, .stream). What an integrating agent needs NEXT is a
// CONTRACT — the fields, types and error envelope any off-the-shelf client can
// parse without special-casing — and proof that the contract HOLDS.
//
// This file is that proof. It is deliberately NOT a snapshot: a snapshot pins
// today's bytes and dies on the first legitimate change. These assertions pin
// the SHAPE a client depends on, and every one of them is shown to be
// load-bearing by a mutation that must turn the gate red.
//
//   §1  every OpenAI-required field, correctly typed, on BOTH paths
//   §2  the error envelope on every error path
//   §3  SSE well-formedness
//   §4  the class-D boundaries are ADVERTISED, not hidden
//   §5  ANTI-VACUITY: five mutations, each red, each proven load-bearing
//   §6  ANTI-FABRICATION: a tool_calls entry only ever accompanies a real call
//
// HERMETIC: no network beyond a loopback server this file starts itself, and
// no browser — the driver is stubbed. It runs on CI as-is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

import {
  handleOpenAIRoutes,
  buildNativeToolCall,
  modelToolSupport,
  nativeToolSites,
  NATIVE_TOOL_READERS,
  MODEL_STREAMING_MODE,
  MODEL_TOOL_SUPPORT_VALUES,
  type OpenAIOptions,
} from "../src/prompt/openai.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";

// ─── the harness ──────────────────────────────────────────────────────────────

const profile = (id: string, name: string, url: string) =>
  ({ id, name, url, loginRequired: true }) as unknown as ChatSiteProfile;

const PROFILES: Record<string, ChatSiteProfile> = {
  deepseek: profile("deepseek", "DeepSeek", "https://chat.deepseek.com"),
  kimi: profile("kimi", "Kimi", "https://www.kimi.ai"),
};

type AskResult = {
  answer?: string;
  chunkCount?: number;
  doneReason?: "stable" | "timeout" | "empty" | "restricted";
  url?: string;
  title?: string;
  restrictions?: Array<{ kind: string; matched: string }>;
};

/** A pool whose driver is a stub: `ask` resolves `result`, and `page` (when
 *  given) is what a native tool read-back scrapes. No browser, ever. */
function stubPool(result: AskResult | ((...a: unknown[]) => Promise<AskResult>), page?: unknown) {
  return {
    acquire: async () => ({
      driver: {
        ask: async (...a: unknown[]) =>
          typeof result === "function" ? (result as (...x: unknown[]) => Promise<AskResult>)(...a) : result,
        ...(page ? { page } : {}),
      },
    }),
    release: async () => undefined,
  };
}

/** A soft-tool layer that always "succeeds" — the SOFT path under test. */
const softTools: NonNullable<OpenAIOptions["softTools"]> = {
  buildToolInstruction: () => "CALL A TOOL IF ONE APPLIES.",
  parseToolCall: () => ({ toolCallId: "call_soft_1", name: "get_weather", argumentsJson: '{"city":"Paris"}' }),
  stripToolCall: () => ({ content: "calling the tool", parsed: {} }),
};

async function serve(opts: { pool: unknown; softTools?: boolean; profiles?: Record<string, ChatSiteProfile> }) {
  const server: Server = createServer(async (req, res) => {
    try {
      await handleOpenAIRoutes(req, res, {
        pool: opts.pool as never,
        profilesById: (opts.profiles ?? PROFILES) as Record<string, ChatSiteProfile>,
        ...(opts.softTools ? { softTools } : {}),
      });
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  return { server, port: typeof a === "object" && a ? a.port : 0, close: () => server.close() };
}

type Post = { model?: string; stream?: boolean; messages: unknown[]; tools?: unknown; new_chat?: boolean; account?: string };

async function post(port: number, body: unknown, raw?: string) {
  // Client-side deadline on EVERY call: a stream that never terminates is a
  // real defect, and it must surface as a named failure instead of hanging the
  // runner (an unbounded pin is a second dead path).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) as Json, contentType: res.headers.get("content-type") ?? "" };
  } finally {
    clearTimeout(timer);
  }
}

async function getModels(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
  return { status: res.status, json: (await res.json()) as ModelsBody };
}

type Json = Record<string, any>;
type ModelsBody = { object: string; capabilitiesVersion: number; data: Json[] };

/** A chat turn that answers cleanly. */
const CLEAN: AskResult = { answer: "Paris is sunny.", chunkCount: 1, doneReason: "stable", url: "https://x/1", title: "t" };

// ─── §1  THE REQUIRED-FIELD CONTRACT ──────────────────────────────────────────
//
// Asserted as a FUNCTION over a payload so §5 can feed it a mutated payload and
// require it to throw. A function is the only form in which "this assertion is
// load-bearing" is a checkable fact rather than a claim in a comment.

const REQUIRED_TOP_LEVEL = ["id", "object", "created", "model", "choices"] as const;

function assertCompletionShape(body: Json, where: string): void {
  for (const k of REQUIRED_TOP_LEVEL) {
    assert.ok(k in body, `${where}: required top-level field "${k}" is absent`);
  }
  assert.equal(typeof body.id, "string", `${where}: id must be a string`);
  assert.ok(body.id.length > 0, `${where}: id must be non-empty`);
  assert.equal(body.object, "chat.completion", `${where}: object must be "chat.completion"`);
  assert.equal(typeof body.created, "number", `${where}: created must be a number`);
  assert.ok(Number.isInteger(body.created), `${where}: created must be an integer (unix seconds)`);
  assert.equal(typeof body.model, "string", `${where}: model must be a string`);

  assert.ok(Array.isArray(body.choices), `${where}: choices must be an array`);
  assert.ok(body.choices.length > 0, `${where}: choices must be non-empty`);
  for (const c of body.choices) {
    assert.equal(typeof c.index, "number", `${where}: choices[].index must be a number`);
    assert.equal(c.message.role, "assistant", `${where}: choices[].message.role must be "assistant"`);
    assert.ok("content" in c.message, `${where}: choices[].message.content key must be PRESENT (null is fine, absent is not)`);
    assert.ok(
      c.message.content === null || typeof c.message.content === "string",
      `${where}: choices[].message.content must be a string or null, got ${typeof c.message.content}`,
    );
    assert.equal(typeof c.finish_reason, "string", `${where}: choices[].finish_reason must be a string`);
    assert.ok(
      ["stop", "tool_calls", "content_filter", "length"].includes(c.finish_reason),
      `${where}: finish_reason "${c.finish_reason}" is not an OpenAI value`,
    );
  }

  // usage: a client parsing this must not crash on `completion.usage`.
  // openai-python's accounting, LangChain's cost middleware and every budget
  // tracker read it; a field that is null or absent is a mis-bill, not a
  // neutral omission. It is an ESTIMATE over our own text and says so on the
  // wire (see §1b) — but it is a real object.
  assert.ok("usage" in body, `${where}: "usage" is ABSENT — a client reading completion.usage.prompt_tokens crashes or mis-bills`);
  assert.ok(body.usage !== null && typeof body.usage === "object" && !Array.isArray(body.usage), `${where}: "usage" must be an OBJECT, got ${body.usage === null ? "null" : typeof body.usage}`);
  for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    assert.equal(typeof body.usage[k], "number", `${where}: usage.${k} must be a number`);
    assert.ok(Number.isFinite(body.usage[k]) && body.usage[k] >= 0, `${where}: usage.${k} must be a finite non-negative number`);
  }
  assert.equal(body.usage.total_tokens, body.usage.prompt_tokens + body.usage.completion_tokens, `${where}: usage.total_tokens must be the sum of the two parts`);
}

/**
 * §1b — the estimate is ALWAYS LABELLED. A number a billing system can read but
 * never mistake for a measurement is the whole difference between an honest
 * estimate and a fabrication, and the label is what keeps it honest.
 */
function assertUsageIsLabelled(body: Json, where: string): void {
  const a = body.ui2api?.usageAccounting;
  assert.ok(a && typeof a === "object", `${where}: the usage estimate must travel with its label under ui2api.usageAccounting`);
  assert.equal(a.estimated, true, `${where}: the label must say estimated:true — there is no measured path here`);
  assert.equal(a.siteReported, false, `${where}: the site's own tokenization is never available, so siteReported must be false`);
  assert.equal(typeof a.method, "string");
  assert.equal(typeof a.basis, "string");
  assert.equal(typeof a.note, "string");
}

test("§1 non-streaming completion carries every OpenAI-required field, correctly typed", async () => {
  const s = await serve({ pool: stubPool(CLEAN) });
  try {
    const r = await post(s.port, { model: "deepseek", messages: [{ role: "user", content: "weather?" }] });
    assert.equal(r.status, 200);
    assert.match(r.contentType, /application\/json/);
    assertCompletionShape(r.json(), "non-stream");
    assertUsageIsLabelled(r.json(), "non-stream");
    const b = r.json();
    assert.equal(b.choices[0].message.content, "Paris is sunny.");
    assert.equal(b.choices[0].finish_reason, "stop");
    assert.equal(b.ui2api.site, "deepseek");
    // the estimate is over OUR OWN text, and it is the request's own two strings
    assert.equal(b.usage.completion_tokens, Math.ceil("Paris is sunny.".length / 4), "completion_tokens must be the ceil(chars/4) of the answer actually returned");
  } finally {
    s.close();
  }
});

test("§1 the restricted wall is a spec-correct completion, not an empty success", async () => {
  const s = await serve({
    pool: stubPool({ answer: "", chunkCount: 0, doneReason: "restricted", restrictions: [{ kind: "login", matched: "Sign in to continue" }] }),
  });
  try {
    const r = await post(s.port, { model: "deepseek", messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 200);
    assertCompletionShape(r.json(), "restricted");
    const b = r.json();
    assert.equal(b.choices[0].finish_reason, "content_filter");
    assert.match(String(b.choices[0].message.refusal), /login: Sign in to continue/);
  } finally {
    s.close();
  }
});

// ─── §2  THE ERROR ENVELOPE ──────────────────────────────────────────────────

interface ErrorEnvelope {
  message?: unknown;
  type?: unknown;
  param?: unknown;
  code?: unknown;
}

/**
 * The two /v1 error paths that carry NO `code`. Named, not swept under the rug:
 * `openAiError2` is called without a code for a malformed body, and the
 * empty-messages 400 was written without one. Everything else names a code, and
 * this list is what makes THAT claim checkable instead of assumed.
 */
const CODE_EXEMPT = ["400 invalid JSON body", "400 empty messages"] as const;

function assertErrorEnvelope(body: Json, where: string, exempt = false): void {
  const env = body?.error as ErrorEnvelope | undefined;
  assert.ok(env && typeof env === "object" && !Array.isArray(env), `${where}: body must carry an "error" OBJECT`);
  assert.equal(typeof env!.message, "string", `${where}: error.message must be a string`);
  assert.ok((env!.message as string).length > 0, `${where}: error.message must be non-empty`);
  assert.equal(typeof env!.type, "string", `${where}: error.type must be a string`);
  assert.ok((env!.type as string).length > 0, `${where}: error.type must be non-empty`);
  // `param` is part of the envelope: a client reads it to know WHICH field it
  // got wrong. null is the OpenAI spelling of "not field-specific".
  assert.ok("param" in env!, `${where}: error.param must be PRESENT (null is a value, absence is not)`);
  assert.ok(env!.param === null || typeof env!.param === "string", `${where}: error.param must be a string or null`);
  if (!exempt) {
    assert.equal(typeof env!.code, "string", `${where}: error.code must be a string (an off-the-shelf client branches on it)`);
    assert.ok((env!.code as string).length > 0, `${where}: error.code must be non-empty`);
  }
}

/** Every error path the surface can actually produce, captured for real. */
async function captureErrorPaths() {
  const rows: Array<{ name: string; body: Json; exempt: boolean }> = [];
  const okPool = stubPool(CLEAN);

  const s = await serve({ pool: okPool });
  try {
    rows.push({ name: "404 unknown model", exempt: false, body: (await post(s.port, { model: "nope", messages: [{ role: "user", content: "x" }] })).json() });
    rows.push({ name: "404 unknown /v1 path (no hang)", exempt: false, body: (await (await fetch(`http://127.0.0.1:${s.port}/v1/embeddings`)).json() as Json) });
    rows.push({
      name: "400 unsupported content part",
      exempt: false,
      body: (await post(s.port, { model: "deepseek", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:..." } }] }] })).json(),
    });
    rows.push({ name: "400 empty messages", exempt: true, body: (await post(s.port, { model: "deepseek", messages: [] })).json() });
    rows.push({ name: "400 invalid JSON body", exempt: true, body: (await post(s.port, null, "{not json")).json() });
  } finally {
    s.close();
  }

  const boom = await serve({
    pool: stubPool(async () => {
      throw new Error("no answer appeared on deepseek within 90000ms.");
    }),
  });
  try {
    rows.push({ name: "502 driver error", exempt: false, body: (await post(boom.port, { model: "deepseek", messages: [{ role: "user", content: "x" }] })).json() });
  } finally {
    boom.close();
  }
  return rows;
}

test("§2 every error path answers the OpenAI error envelope {message,type,param,code}", async () => {
  const rows = await captureErrorPaths();
  assert.ok(rows.length >= 6, `expected the full error-path inventory, got ${rows.length}`);
  for (const r of rows) {
    assertErrorEnvelope(r.body, r.name, r.exempt);
  }
  // The exemption list must stay EXACT: a new code-less path is a regression,
  // a fixed one is a removal. Either way it is a decision, not a drift.
  const codeLess = rows.filter((r) => typeof (r.body.error as ErrorEnvelope).code !== "string").map((r) => r.name).sort();
  assert.deepEqual(codeLess, [...CODE_EXEMPT].sort(), "the set of code-less error paths drifted — a new one must be named here, a fixed one removed");
});

test("§2 a driver's named failure reaches the caller verbatim, never as a fabricated answer", async () => {
  const s = await serve({
    pool: stubPool(async () => {
      throw new Error("answer-echo on deepseek: the answer region returned the sent prompt verbatim");
    }),
  });
  try {
    const r = await post(s.port, { model: "deepseek", messages: [{ role: "user", content: "x" }] });
    assert.equal(r.status, 502);
    assertErrorEnvelope(r.json(), "driver throw");
    assert.match(String(r.json().error.message), /answer-echo on deepseek/);
  } finally {
    s.close();
  }
});

// ─── §3  SSE WELL-FORMEDNESS ─────────────────────────────────────────────────

interface SseVerdict {
  frames: Json[];
  done: boolean;
  raw: string;
}

/** Parse an SSE body the way a real client does: `data: <json>` frames, one
 *  `data: [DONE]` terminator, nothing else on the wire. */
function parseSse(raw: string): SseVerdict {
  const frames: Json[] = [];
  let done = false;
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    if (!line.startsWith("data: ")) throw new Error(`malformed SSE frame — no "data: " prefix: ${JSON.stringify(line)}`);
    const payload = line.slice(6);
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    frames.push(JSON.parse(payload) as Json);
  }
  return { frames, done, raw };
}

function assertSseWellFormed(raw: string, where: string): SseVerdict {
  const v = parseSse(raw); // throws on a malformed frame
  assert.ok(v.frames.length > 0, `${where}: the stream carried no frames`);
  assert.ok(v.done, `${where}: the stream must terminate with the data: [DONE] sentinel`);
  // The terminator is the LAST thing on the wire — a client that stops reading
  // on it must not find another frame behind it.
  assert.match(raw.trimEnd(), /data: \[DONE\]$/, `${where}: [DONE] must be the final frame`);
  for (const f of v.frames) {
    assert.equal(typeof f.id, "string", `${where}: chunk.id must be a string`);
    assert.equal(f.object, "chat.completion.chunk", `${where}: chunk.object must be "chat.completion.chunk"`);
    assert.equal(typeof f.created, "number", `${where}: chunk.created must be a number`);
    assert.equal(typeof f.model, "string", `${where}: chunk.model must be a string`);
    assert.ok(Array.isArray(f.choices), `${where}: chunk.choices must be an array`);
    // A content frame always carries a choice. The ONE frame allowed to carry
    // an empty choices array is the usage-only frame, which is OpenAI's own
    // convention (stream_options.include_usage) — so a consumer reconciling the
    // stream has exactly one shape to special-case, and it is the spec's.
    if (f.choices.length === 0) {
      assert.ok(f.usage !== undefined, `${where}: only a usage-only frame may carry an empty choices array`);
      continue;
    }
    for (const c of f.choices) {
      assert.equal(typeof c.index, "number", `${where}: chunk choices[].index must be a number`);
      assert.ok(c.delta && typeof c.delta === "object", `${where}: chunk choices[].delta must be an object`);
      assert.ok("finish_reason" in c, `${where}: chunk choices[] must carry finish_reason on EVERY frame (null mid-stream)`);
    }
  }
  return v;
}

test("§3 the streaming path is well-formed SSE that terminates with data: [DONE]", async () => {
  const s = await serve({ pool: stubPool(CLEAN) });
  try {
    const r = await post(s.port, { model: "deepseek", stream: true, messages: [{ role: "user", content: "weather?" }] });
    assert.equal(r.status, 200);
    assert.match(r.contentType, /text\/event-stream/);
    const v = assertSseWellFormed(r.text, "stream");
    // the replayed deltas reassemble into exactly the answer the driver read
    const deltas = v.frames.flatMap((f) => f.choices).map((c: Json) => c.delta?.content ?? "").join("");
    assert.equal(deltas, "Paris is sunny.");
    const last = v.frames[v.frames.length - 1];
    assert.equal(last.choices[0].finish_reason, "stop", "the final frame must carry the terminal finish_reason");
    assert.deepEqual(last.choices[0].delta, {}, "the final frame carries no content, only the reason");
  } finally {
    s.close();
  }
});

test("§3 stream_options.include_usage puts the labelled estimate on the stream, and its absence is opt-in", async () => {
  const s = await serve({ pool: stubPool(CLEAN) });
  try {
    const withUsage = await post(s.port, {
      model: "deepseek",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "weather?" }],
    });
    const v = assertSseWellFormed(withUsage.text, "stream+usage");
    // The OpenAI convention: a final usage-only chunk with EMPTY choices, then
    // the terminator. A client that reconciles the stream reads it there.
    const usageFrame = v.frames.find((f) => f.usage !== undefined);
    assert.ok(usageFrame, "stream_options.include_usage:true must produce a usage frame");
    assert.deepEqual(usageFrame!.choices, [], "the usage frame carries an empty choices array (OpenAI's own convention)");
    assert.equal(typeof usageFrame!.usage.prompt_tokens, "number");
    assert.equal(usageFrame!.usage.total_tokens, usageFrame!.usage.prompt_tokens + usageFrame!.usage.completion_tokens);
    assertUsageIsLabelled(usageFrame!, "stream+usage");

    // …and without the flag the stream omits it, which is the OpenAI contract,
    // not a hole: a client that did not ask for it must not have to filter it.
    const noFlag = await post(s.port, { model: "deepseek", stream: true, messages: [{ role: "user", content: "weather?" }] });
    const v2 = assertSseWellFormed(noFlag.text, "stream no-usage");
    assert.ok(v2.frames.every((f) => f.usage === undefined), "without include_usage the stream must carry no usage frames");
  } finally {
    s.close();
  }
});

test("§3 a tool-call stream ends with finish_reason tool_calls and a null-content message", async () => {
  const s = await serve({ pool: stubPool({ ...CLEAN, answer: "calling the tool" }), softTools: true });
  try {
    const r = await post(s.port, {
      model: "deepseek",
      stream: true,
      tool_choice: "auto",
      messages: [{ role: "user", content: "weather in paris?" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
    });
    assert.equal(r.status, 200);
    const v = assertSseWellFormed(r.text, "tool stream");
    const choices = v.frames.flatMap((f) => f.choices);
    const terminal = choices[choices.length - 1];
    assert.equal(terminal.finish_reason, "tool_calls", "a tool-call stream must terminate on finish_reason tool_calls");
    assert.equal(terminal.ui2api?.toolCall?.mechanism, "soft-prompt");
    assert.equal(terminal.ui2api?.toolCall?.executed, false, "a soft call has NOT executed anything");
    // the call frame
    const callFrame = choices.find((c: Json) => c.delta?.tool_calls);
    assert.ok(callFrame, "the stream must carry a tool_calls delta");
    const call = callFrame.delta.tool_calls[0];
    assert.equal(call.type, "function");
    assert.equal(call.function.name, "get_weather");
    assert.equal(typeof call.function.arguments, "string", "arguments must be a JSON STRING, not an object — an OpenAI client JSON.parses it");
    // …and the equivalent non-streaming shape, where content is null
    const n = await post(s.port, {
      model: "deepseek",
      tool_choice: "auto",
      messages: [{ role: "user", content: "weather in paris?" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
    });
    const nb = n.json();
    assertCompletionShape(nb, "tool non-stream");
    // THE protocol rule, and the reason it matters: when a message carries
    // tool_calls its content is null. Prose alongside a call would let a
    // consumer read the instruction scaffolding as the model's answer.
    assert.equal(nb.choices[0].message.content, null, "a message carrying tool_calls must have content:null");
    assert.equal(nb.choices[0].finish_reason, "tool_calls");
    assert.equal(nb.choices[0].ui2api.toolCall.mechanism, "soft-prompt");
  } finally {
    s.close();
  }
});

// ─── §4  THE CLASS-D BOUNDARIES ARE ADVERTISED ───────────────────────────────

function assertModelsContract(body: ModelsBody, where: string): void {
  assert.equal(body.object, "list", `${where}: /v1/models must answer object:"list"`);
  assert.equal(typeof body.capabilitiesVersion, "number", `${where}: capabilitiesVersion must be a number (a consumer built on an older shape can detect the drift)`);
  assert.ok(Array.isArray(body.data) && body.data.length > 0, `${where}: /v1/models must list at least one model`);
  for (const m of body.data) {
    assert.equal(typeof m.id, "string", `${where}: model.id must be a string`);
    assert.equal(m.object, "model", `${where}: model.object must be "model"`);
    // THE boundary, advertised. A consumer that reads only `streaming: true`
    // would believe it is getting incremental output. It is not: the answer is
    // complete before the first byte. Omitting streamingMode is the
    // overstatement, so the field is mandatory.
    assert.equal(m.streamingMode, "replay", `${where}: model "${m.id}" must advertise streamingMode:"replay" — the answer is complete before the first chunk, and a consumer must never be misled about incrementality`);
    assert.equal(m.streaming, true, `${where}: model "${m.id}" must advertise streaming:true`);
    assert.ok(
      (MODEL_TOOL_SUPPORT_VALUES as readonly string[]).includes(m.tools),
      `${where}: model "${m.id}".tools must be one of ${MODEL_TOOL_SUPPORT_VALUES.join("|")}, got ${JSON.stringify(m.tools)}`,
    );
    // native is a per-SITE claim, derived from the reader registry — and a
    // consumer deserves the same derivation, not a table.
    if (m.tools === "native") {
      assert.ok(
        Object.prototype.hasOwnProperty.call(NATIVE_TOOL_READERS, m.id),
        `${where}: model "${m.id}" claims tools:"native" but has no read-back path in NATIVE_TOOL_READERS`,
      );
    }
  }
}

test("§4 /v1/models advertises streamingMode:\"replay\" and a native|soft|none tools value on EVERY entry", async () => {
  const withSoft = await serve({ pool: stubPool(CLEAN), softTools: true });
  try {
    const b = (await getModels(withSoft.port)).json;
    assertModelsContract(b, "models (soft wired)");
    const kimi = b.data.find((m) => m.id === "kimi")!;
    const deepseek = b.data.find((m) => m.id === "deepseek")!;
    // Derived, not typed: kimi HAS a measured read-back path, deepseek does not.
    assert.equal(kimi.tools, "native", "kimi has a measured native reader and must be advertised as native");
    assert.deepEqual(kimi.toolMechanisms, ["native", "soft"]);
    assert.equal(deepseek.tools, "soft", "a site with no reader but a wired soft layer is soft");
    assert.equal(deepseek.toolCallShape, "openai.function_call");
    assert.equal(kimi.toolCallProvenanceField, "choices[0].ui2api.toolCall.mechanism");
  } finally {
    withSoft.close();
  }

  const bare = await serve({ pool: stubPool(CLEAN) });
  try {
    const b = (await getModels(bare.port)).json;
    assertModelsContract(b, "models (no tool layer)");
    // With no tool layer wired, a site with a reader is still native and a site
    // without one is honestly "none" — a `tools` array would be IGNORED.
    assert.equal(b.data.find((m) => m.id === "kimi")!.tools, "native");
    assert.equal(b.data.find((m) => m.id === "deepseek")!.tools, "none");
    assert.equal(b.data.find((m) => m.id === "deepseek")!.toolCallShape, null);
  } finally {
    bare.close();
  }
});

test("§4 the advertised tool level is DERIVED from the read-back registry, never from a literal list", () => {
  // native ⇔ the site is a key of NATIVE_TOOL_READERS, in both directions, for
  // every site on the served surface. A hand-written ["kimi"] somewhere would
  // satisfy a weaker test and rot silently; this cannot.
  const sites = nativeToolSites();
  assert.deepEqual(sites, Object.keys(NATIVE_TOOL_READERS));
  for (const site of Object.keys(NATIVE_TOOL_READERS)) {
    assert.equal(typeof NATIVE_TOOL_READERS[site], "function", `${site} must map to a real reader function`);
    assert.equal(modelToolSupport({}, site), "native", `${site} has a reader and must derive native`);
  }
  for (const site of ["deepseek", "gemini", "claude", "chatgpt", "tencent-aistudio"]) {
    assert.notEqual(modelToolSupport({ softTools }, site), "native", `${site} has no read-back path and must never claim native`);
  }
  assert.equal(MODEL_STREAMING_MODE, "replay", "the surface-level streaming mode is the honest one; changing it must fail the /v1/models contract above");
});

// ─── §5  ANTI-VACUITY ─────────────────────────────────────────────────────────
//
// Every assertion above is only worth anything if it can FAIL. Each mutation
// below edits a REAL artifact this file captured from the REAL handler, proves
// the edit actually changed it (load-bearing), and then requires the matching
// assertion to reject it. A mutation that changes nothing, or that the
// assertion still accepts, is a hole in the gate and fails here.

interface Mutation {
  name: string;
  mutate: (raw: string) => string;
  /** The contract assertion the mutation must be caught by. */
  contract: (raw: string) => void;
}

test("§5 ANTI-VACUITY — each of the five forbidden regressions turns the gate RED, and each mutation is load-bearing", async () => {
  // Capture the REAL artifacts first. Mutating a hand-written fixture would
  // prove nothing about the shipped bytes.
  const s = await serve({ pool: stubPool(CLEAN), softTools: true });
  let completionRaw = "";
  let streamRaw = "";
  let modelsRaw = "";
  let errorRaw = "";
  try {
    const ok = await post(s.port, { model: "deepseek", messages: [{ role: "user", content: "weather?" }] });
    completionRaw = ok.text;
    const st = await post(s.port, { model: "deepseek", stream: true, messages: [{ role: "user", content: "weather?" }] });
    streamRaw = st.text;
    modelsRaw = JSON.stringify((await getModels(s.port)).json);
    const bad = await post(s.port, { model: "nope", messages: [{ role: "user", content: "x" }] });
    errorRaw = bad.text;
  } finally {
    s.close();
  }

  const mutations: Mutation[] = [
    {
      name: "usage is removed from the completion payload",
      mutate: (raw) => raw.replace(/"usage":\{"prompt_tokens":\d+,"completion_tokens":\d+,"total_tokens":\d+\},/, ""),
      contract: (raw) => assertCompletionShape(JSON.parse(raw), "M1 usage"),
    },
    {
      name: "streamingMode is removed from a model entry",
      mutate: (raw) => raw.replace(/"streamingMode":"replay",/, ""),
      contract: (raw) => assertModelsContract(JSON.parse(raw), "M2 streamingMode"),
    },
    {
      name: "the data: [DONE] terminator is removed from the stream",
      mutate: (raw) => raw.replace(/data: \[DONE\]\n\n/, ""),
      contract: (raw) => assertSseWellFormed(raw, "M3 [DONE]"),
    },
    {
      name: "the error envelope loses code",
      mutate: (raw) => raw.replace(/"code":"unknown_model",/, ""),
      contract: (raw) => assertErrorEnvelope(JSON.parse(raw), "M4 error.code"),
    },
    {
      name: "the error envelope loses type",
      mutate: (raw) => raw.replace(/"type":"invalid_request_error",/, ""),
      contract: (raw) => assertErrorEnvelope(JSON.parse(raw), "M5 error.type"),
    },
  ];

  const reds: string[] = [];
  for (const m of mutations) {
    const source = m.name.startsWith("usage is removed")
      ? completionRaw
      : m.name.startsWith("streamingMode")
        ? modelsRaw
        : m.name.startsWith("the data:")
          ? streamRaw
          : errorRaw;
    const mutated = m.mutate(source);
    // LOAD-BEARING: the edit must have actually changed the artifact. A no-op
    // mutation would let a vacuous assertion look green forever.
    assert.notEqual(mutated, source, `MUTATION "${m.name}" changed nothing — the pinned text is gone from the artifact, so this check is no longer testing what it claims`);
    assert.throws(() => m.contract(mutated), `MUTATION "${m.name}" was ACCEPTED by the contract — the gate has a hole in exactly this class`);
    reds.push(`red: ${m.name}`);
  }
  assert.equal(reds.length, 5, "all five forbidden regressions must be demonstrated red");
  assert.equal(reds.length, mutations.length);
});

// ─── §6  ANTI-FABRICATION ────────────────────────────────────────────────────
//
// A `tool_calls` key on a turn means a function was really invoked. The surface
// has exactly one producer for a NATIVE call and it takes site evidence alone
// (buildNativeToolCall), and exactly one gate that decides whether the site
// really ran the tool (normalizeToolReadback, in the kimi module). Two
// independent ways to lie are therefore closed here: synthesising a call where
// none was observed, and emitting an empty or shape-only call array.

test("§6 a tool_calls entry is emitted ONLY when the caller CONSENTED and a real call was parsed", async () => {
  const s = await serve({ pool: stubPool(CLEAN), softTools: true });
  try {
    // FAIL-CLOSED CONSENT. A caller that sends `tools` and no `tool_choice`
    // gets an ordinary answer, NEVER a call. The parser can see that an answer
    // CONTAINS a tool-shaped envelope; it cannot see that the MODEL chose it,
    // so without an explicit opt-in the layer does not run at all. Our soft
    // stub WOULD return a perfectly well-formed call here — and it must still
    // be discarded, because nothing about the turn says the model asked for it.
    for (const tool_choice of [undefined, "none", "required"] as unknown[]) {
      const miss = await post(s.port, {
        model: "deepseek",
        ...(tool_choice === undefined ? {} : { tool_choice }),
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      });
      const b = miss.json();
      assert.ok(
        !("tool_calls" in b.choices[0].message),
        `tool_choice ${JSON.stringify(tool_choice)} must produce NO call — there is no such thing as an empty or synthesised tool_calls array here`,
      );
      assert.equal(b.choices[0].finish_reason, "stop");
      assert.equal(b.choices[0].ui2api, undefined, "no call means no provenance block");
      assert.equal(b.choices[0].message.content, "Paris is sunny.", "the answer passes through untouched");
    }

    // …and with the explicit opt-in the SAME stub does yield a call, which is
    // what proves the previous three were refused by the consent gate and not
    // by accident.
    const yes = await post(s.port, {
      model: "deepseek",
      tool_choice: "auto",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
    });
    assert.equal(yes.json().choices[0].finish_reason, "tool_calls");

    // No tool layer wired at all: a `tools` array is simply ignored.
    const bare = await serve({ pool: stubPool(CLEAN) });
    try {
      const j = (await (await fetch(`http://127.0.0.1:${bare.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek",
          tool_choice: "auto",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
        }),
      })).json()) as Json;
      assert.ok(!("tool_calls" in j.choices[0].message), "no tool layer wired means no call, full stop");
    } finally {
      bare.close();
    }
  } finally {
    s.close();
  }
});

test("§6 a malformed soft parse fails CLOSED — no call, untouched answer", async () => {
  const malformed: NonNullable<OpenAIOptions["softTools"]> = {
    buildToolInstruction: () => "CALL A TOOL IF ONE APPLIES.",
    // Right keys, wrong types: the narrowing in openai.ts must reject this.
    parseToolCall: () => ({ toolCallId: 42, name: { nested: true }, argumentsJson: ["nope"] }),
    stripToolCall: () => ({ content: "", parsed: {} }),
  };
  const server = createServer(async (req, res) => {
    await handleOpenAIRoutes(req, res, {
      pool: stubPool(CLEAN) as never,
      profilesById: PROFILES as Record<string, ChatSiteProfile>,
      softTools: malformed,
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  const port = typeof a === "object" && a ? a.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      }),
    });
    const b = (await res.json()) as Json;
    assert.ok(!("tool_calls" in b.choices[0].message), "a wrong-typed parse must be treated as NO call, never emitted unvalidated");
    assert.equal(b.choices[0].finish_reason, "stop");
    assert.equal(b.choices[0].message.content, "Paris is sunny.", "the answer must pass through untouched");
  } finally {
    server.close();
  }
});

test("§6 a native call exists only where the site OBSERVED its own tool invocation", async () => {
  // The pure fabrication gate, exercised with no browser: a reader is the only
  // producer of a native call, and it needs `observed === true`.
  const site = nativeToolSites()[0];
  assert.equal(site, "kimi", "kimi is the measured native reader; a new one must be measured, not declared");

  // unobserved → NO call, even with a full-looking result set
  assert.equal(
    buildNativeToolCall({ tool: "web_search", observed: false, toolTitle: "x", resultCount: 5, resultLabel: "Search（5 results）", citations: ["https://a"], reason: "not observed" }, site),
    null,
    "an unobserved turn must never become a tool call",
  );
  // no evidence at all → no call
  assert.equal(buildNativeToolCall(null, site), null, "absent evidence must never become a tool call");

  // observed → exactly one call, named by the site's own vocabulary
  const built = buildNativeToolCall({ tool: "web_search", observed: true, toolTitle: "Weather", resultCount: 5, resultLabel: "Search（5 results）", citations: ["https://a", "https://a#frag"], reason: null }, site);
  assert.ok(built, "an observed invocation must produce a call");
  assert.equal(built!.call.type, "function");
  assert.equal(built!.call.function.name, "kimi_web_search", "the name is derived from the site's own tool vocabulary");
  assert.equal(built!.provenance.mechanism, "native");
  assert.equal(built!.provenance.executed, true, "a native call means the SITE ran the function");
  // the argument object is EXACTLY the measured evidence — buildNativeToolCall
  // is a pass-through, never an embellisher (the upstream normaliser is what
  // dedupes and forces citations to [] on an unobserved turn)
  const args = JSON.parse(built!.call.function.arguments) as Json;
  assert.deepEqual(args, { tool: "web_search", tool_title: "Weather", result_count: 5, citations: ["https://a", "https://a#frag"] });
});

test("§6 a NATIVE read-back on the wire reports the site's own evidence, and a miss is diagnosable", async () => {
  // The kimi reader, driven by a stubbed page — no browser, but the REAL
  // reader and the REAL fabrication gate.
  const pageWith = (raw: unknown) => ({ evaluate: async () => raw });
  const fired = {
    labels: ["Search（5 results）"],
    resultLabel: "Search（5 results）",
    searchToolContainers: 1,
    referencesAction: true,
    citations: ["https://example.com/a#:~:text=x", "https://example.com/a", "https://example.com/b"],
    searchEnabled: true,
  };
  const server = createServer(async (req, res) => {
    await handleOpenAIRoutes(req, res, {
      pool: stubPool(CLEAN, pageWith(fired)) as never,
      profilesById: { kimi: PROFILES.kimi } as Record<string, ChatSiteProfile>,
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  const port = typeof a === "object" && a ? a.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi", messages: [{ role: "user", content: "weather?" }] }),
    });
    const b = (await res.json()) as Json;
    assertCompletionShape(b, "native");
    assert.equal(b.choices[0].finish_reason, "tool_calls");
    const prov = b.choices[0].ui2api.toolCall;
    assert.equal(prov.mechanism, "native");
    assert.equal(prov.executed, true);
    assert.equal(prov.site, "kimi");
    assert.equal(prov.tool, "web_search");
    assert.equal(prov.evidence.resultCount, 5, "the result count is N out of the site's OWN label");
    assert.deepEqual(prov.evidence.citations, ["https://example.com/a", "https://example.com/b"], "citations are the site's own rendered URLs, deduped past the text fragment");
    assert.equal(b.ui2api.nativeTool.observed, true);
  } finally {
    server.close();
  }

  // …and a turn where the site rendered NO search node: an ordinary answer, no
  // call, and a NAMED reason so the missing call is diagnosable.
  const missServer = createServer(async (req, res) => {
    await handleOpenAIRoutes(req, res, {
      pool: stubPool(CLEAN, pageWith({ labels: [], resultLabel: null, searchToolContainers: 0, referencesAction: false, citations: [], searchEnabled: true })) as never,
      profilesById: { kimi: PROFILES.kimi } as Record<string, ChatSiteProfile>,
    });
  });
  await new Promise<void>((r) => missServer.listen(0, "127.0.0.1", () => r()));
  const b2 = missServer.address();
  const port2 = typeof b2 === "object" && b2 ? b2.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port2}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi", messages: [{ role: "user", content: "weather?" }] }),
    });
    const b = (await res.json()) as Json;
    assert.ok(!("tool_calls" in b.choices[0].message), "a site that rendered no invocation must produce NO call");
    assert.equal(b.choices[0].finish_reason, "stop");
    assert.equal(b.choices[0].message.content, "Paris is sunny.", "the answer is returned untouched");
    assert.equal(b.ui2api.nativeTool.observed, false, "the miss is reported, not hidden");
    assert.match(String(b.ui2api.nativeTool.reason), /not-observed/, "the miss carries a NAMED reason");
  } finally {
    missServer.close();
  }
});

// ─── a source-level pin, so the gate cannot be satisfied by a decoy ──────────

test("the contract is served from the one real implementation, not a parallel one", () => {
  const src = readFileSync(new URL("../src/prompt/openai.ts", import.meta.url), "utf8");
  // Exactly one non-streaming `chat.completion` writer and one `[DONE]` writer
  // family. A second emitter added beside it would satisfy no assertion here.
  assert.equal((src.match(/object: "chat\.completion",/g) ?? []).length, 1, "there must be exactly one chat.completion writer");
  assert.equal((src.match(/data: \[DONE\]/g) ?? []).length, 3, "every streaming exit (wall / tool call / answer) must terminate the stream");
  // The estimate must be built by the one exported helper and wired in, never
  // hand-rolled at a call site — a second estimator is a second set of numbers.
  assert.ok(src.includes("export function estimateUsage("), "the usage estimator must be the single exported helper");
  assert.ok(src.includes("...estimateUsage(") || /usage:\s*estimateUsage/.test(src) || src.includes("estimateUsage(prompt, answer)"), "the non-stream payload must actually spread the estimate — a computed-but-unwired estimator is a missing usage block on the wire");
});
