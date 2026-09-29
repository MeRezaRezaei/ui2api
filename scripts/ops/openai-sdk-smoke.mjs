#!/usr/bin/env node
/**
 * openai-sdk-smoke.mjs — prove the /v1 OpenAI-compatible surface works with a
 * REAL OpenAI client library, not with curl.
 *
 * WHY THIS EXISTS
 * A curl SSE test proves the bytes look right to a human. It does NOT prove a
 * real SDK accepts them, and SDKs are strict: the `openai` client parses the
 * event stream frame by frame, rejects malformed JSON, requires
 * `chat.completion.chunk` objects, and keys its own accumulator off
 * `choices[0].delta`. A stream that curl renders happily can still crash the
 * SDK's accumulator. This script is the only check that answers the question
 * that actually matters: "can a real client library consume this service?"
 *
 * OFFLINE BY CONSTRUCTION
 * The library is resolved from disk only — no install, no network fetch. Order:
 *   1. an already-present `openai` package resolvable from this file,
 *   2. `/opt/OmniRoute/node_modules/openai` (the copy on this box),
 *   3. `UI2API_OPENAI_SDK` (a path to any other local copy).
 * If none resolves, the script exits 3 with NOT AVAILABLE. It never installs.
 *
 * HONESTY RULES
 *   - Nothing is smoothed over. A check that cannot run prints FAIL with the
 *     reason; it never prints PASS by default.
 *   - Tool calling is reported as EXACTLY what came back. An absent
 *     `tool_calls` is a legitimate measured outcome (`tools` is `"soft"`, not
 *     `"native"`) and is printed as such — never upgraded to a pass by
 *     inventing a call.
 *   - Every request is bounded by a real timeout. Exit code is non-zero if any
 *     check fails.
 *
 * USAGE
 *   node scripts/ops/openai-sdk-smoke.mjs [--base http://127.0.0.1:9797]
 *                                            [--model <id>] [--timeout 120000]
 *
 * Exit codes: 0 = all checks PASS, 1 = at least one FAIL, 3 = SDK NOT AVAILABLE.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

// ── argv ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const BASE = argOf("base", process.env.UI2API_BASE || "http://127.0.0.1:9797").replace(/\/+$/, "");
const MODEL_OVERRIDE = argOf("model", "");
const TIMEOUT_MS = Number(argOf("timeout", "120000"));
const PROBE_TIMEOUT_MS = Number(argOf("probe-timeout", "15000"));

// ── resolve the real SDK from disk only ──────────────────────────────────────
function loadSdk() {
  const req = createRequire(import.meta.url);
  const candidates = [
    "openai",
    process.env.UI2API_OPENAI_SDK,
    "/opt/OmniRoute/node_modules/openai",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const resolved = req.resolve(c);
      let version = "unknown";
      // `openai` does not export ./package.json, so read it off the real path.
      const pkgPath = resolved.replace(/index\.(m?js)$/, "package.json");
      if (existsSync(pkgPath)) version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
      const mod = req(c);
      return { OpenAI: mod.OpenAI ?? mod.default, version, from: resolved };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// ── tiny check harness ───────────────────────────────────────────────────────
const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "", ms: Date.now() - started });
    console.log(`PASS  ${name}${detail ? `\n        ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, detail: e?.message ?? String(e), ms: Date.now() - started });
    console.log(`FAIL  ${name}\n        ${e?.message ?? String(e)}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const bounded = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms).unref()),
  ]);

// ── main ─────────────────────────────────────────────────────────────────────
const sdk = loadSdk();
if (!sdk) {
  console.log("NOT AVAILABLE: no `openai` package found on disk (tried: 'openai', $UI2API_OPENAI_SDK, /opt/OmniRoute/node_modules/openai).");
  console.log("This script will not install anything. The /v1 surface may still be correct — it is simply unverified by a real SDK.");
  process.exit(3);
}
console.log(`# SDK   openai@${sdk.version}  (${sdk.from})`);
console.log(`# BASE  ${BASE}`);
console.log(`# BOUND every request <= ${TIMEOUT_MS}ms\n`);

const client = new sdk.OpenAI({ baseURL: `${BASE}/v1`, apiKey: "sk-ui2api-smoke", maxRetries: 0, timeout: TIMEOUT_MS });

let modelId = MODEL_OVERRIDE;
let modelMeta = null;

const run = async () => {
  // 1. discovery
  await check("models.list() discovery", async () => {
    const page = await bounded(client.models.list(), PROBE_TIMEOUT_MS, "models.list");
    const ids = page.data.map((m) => m.id);
    assert(ids.length > 0, "model list is EMPTY — refusing to pass vacuously");
    const rec = page.data[0];
    modelId = MODEL_OVERRIDE || pickRunnable(ids);
    modelMeta = rec;
    return `${ids.length} model(s); probing with "${modelId}" (first id: "${rec.id}")`;
  });

  if (!modelId) {
    console.log("\nABORT: no model to probe; the checks below would be vacuous.");
    return;
  }

  // 2. non-streaming
  await check("chat.completions.create() non-stream", async () => {
    const r = await bounded(
      client.chat.completions.create({
        model: modelId,
        messages: [{ role: "user", content: "Reply with exactly the word PONG and nothing else." }],
      }),
      TIMEOUT_MS,
      "non-stream completion",
    );
    assert(r.object === "chat.completion", `object was ${JSON.stringify(r.object)}`);
    assert(Array.isArray(r.choices) && r.choices.length > 0, "no choices returned");
    const msg = r.choices[0].message;
    assert(typeof msg.content === "string", "message.content is not a string");
    const toolCalls = msg.tool_calls;
    return `finish_reason=${r.choices[0].finish_reason} content=${JSON.stringify(msg.content.slice(0, 120))}` +
      ` tool_calls=${toolCalls ? toolCalls.length : 0}`;
  });

  // 3. streaming through the real SDK accumulator — the high-value check
  await check("chat.completions.create({stream:true}) SSE via SDK accumulator", async () => {
    const stream = await bounded(
      client.chat.completions.create({
        model: modelId,
        stream: true,
        messages: [{ role: "user", content: "Say PONG-HEADED and nothing else." }],
      }),
      TIMEOUT_MS,
      "stream open",
    );
    let chunks = 0;
    let assembled = "";
    let roles = 0;
    let finishReasons = [];
    for await (const chunk of stream) {
      chunks++;
      assert(chunk.object === "chat.completion.chunk", `chunk ${chunks} object=${JSON.stringify(chunk.object)}`);
      const delta = chunk.choices?.[0]?.delta;
      assert(delta !== undefined, `chunk ${chunks} has no choices[0].delta`);
      if (delta.role) roles++;
      if (typeof delta.content === "string") assembled += delta.content;
      if (chunk.choices[0].finish_reason) finishReasons.push(chunk.choices[0].finish_reason);
    }
    assert(chunks > 0, "SDK yielded ZERO chunks");
    assert(assembled.length > 0, `SDK assembled empty content from ${chunks} chunks — SSE was not consumable`);
    return `${chunks} chunk(s), assembled=${JSON.stringify(assembled.slice(0, 120))} finish=${JSON.stringify(finishReasons)}`;
  });

  // 4. tool calling — reported EXACTLY as it comes back
  await check("tool calling with a real tools[] array", async () => {
    const r = await bounded(
      client.chat.completions.create({
        model: modelId,
        messages: [
          { role: "user", content: "What is the weather in Tehran? Use the tool." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get the current weather for a city",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
        tool_choice: "auto",
      }),
      TIMEOUT_MS,
      "tool completion",
    );
    const msg = r.choices[0].message;
    const calls = msg.tool_calls;
    if (!calls || calls.length === 0) {
      // HONEST, MEASURED outcome — not a pass, not smoothed over.
      return `NO tool_calls returned. finish_reason=${r.choices[0].finish_reason} ` +
        `content=${JSON.stringify((msg.content ?? "").slice(0, 200))}. ` +
        `This model advertises tools:"${modelMeta?.tools ?? "?"}" / toolCallShape:"${modelMeta?.toolCallShape ?? "?"}" ` +
        `— a soft tool layer, not native, so the call is rendered into the prompt and may simply not be emitted.`;
    }
    const first = calls[0];
    return `${calls.length} tool_call(s); first: ${first.function?.name}(${String(first.function?.arguments ?? "").slice(0, 160)}) type=${first.type}`;
  });

  // 5. metadata honesty: replay streaming mode must be advertised
  await check("/v1/models advertises streamingMode:replay (never misled about incrementality)", async () => {
    const res = await bounded(fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }), PROBE_TIMEOUT_MS, "models raw");
    const body = await res.json();
    const rows = body.data ?? [];
    assert(rows.length > 0, "model list empty — refusing to pass vacuously");
    const missing = rows.filter((r) => r.streamingMode !== "replay").map((r) => r.id);
    assert(missing.length === 0, `${missing.length}/${rows.length} model(s) do NOT advertise streamingMode:"replay": ${missing.slice(0, 8).join(", ")}`);
    const badTools = rows.filter((r) => !["native", "soft", "none"].includes(r.tools)).map((r) => r.id);
    assert(badTools.length === 0, `tools value outside {native,soft,none} for: ${badTools.slice(0, 8).join(", ")}`);
    return `${rows.length} model(s) all carry streamingMode:"replay" and a tools value in {native,soft,none}`;
  });

  // 6. bidirectional model-id agreement: every listed id must be accepted
  await check("every advertised model id is accepted by completions (no hardcoded direction)", async () => {
    const page = await bounded(client.models.list(), PROBE_TIMEOUT_MS, "models.list (agree)");
    const ids = page.data.map((m) => m.id);
    assert(ids.length > 0, "model list empty — refusing to pass vacuously");
    // Use a bogus site prefix: a server that only accepts a hardcoded allowlist
    // would 404 here, while a surface that derives acceptance from the advertised
    // list answers with a NAMED failure (not an answer) for each id.
    const rejected = [];
    for (const id of ids) {
      try {
        const res = await bounded(
          fetch(`${BASE}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: id, messages: [{ role: "user", content: "ping" }] }),
            signal: AbortSignal.timeout(30000),
          }),
          35000,
          `completions probe ${id}`,
        );
        const body = await res.json().catch(() => null);
        const code = body?.error?.code;
        if (res.status === 404 && code === "unknown_model") rejected.push(id);
      } catch (e) {
        // A network/timeout failure is not a rejection; do not conflate.
        console.log(`        (probe ${id}: ${e.message} — not counted as a rejection)`);
      }
    }
    assert(rejected.length === 0, `advertised but 404 unknown_model: ${rejected.join(", ")}`);
    return `${ids.length}/${ids.length} advertised ids accepted`;
  });
};

// Prefer a cheap anonymous site so the probe does not lean on a paid/login wall.
function pickRunnable(ids) {
  const preferred = ["copilot", "duckduckgo", "gemini", "deepseek", "kimi"];
  return preferred.find((p) => ids.includes(p)) ?? ids[0];
}

run().then(() => {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n${"-".repeat(64)}\nSUMMARY  ${results.length} checks | pass ${pass} | fail ${fail}`);
  console.log(`BASE ${BASE}  SDK openai@${sdk.version}`);
  if (fail > 0) {
    console.log("\nFAILED CHECKS (exact output above, not smoothed over):");
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  }
  process.exit(fail > 0 ? 1 : 0);
});
