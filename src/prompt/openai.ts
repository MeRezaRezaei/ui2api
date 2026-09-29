// OpenAI-compatible surface for promptd — /v1/models + /v1/chat/completions.
//
// Purpose: turn ui2api's browser-control chat sites into a first-class
// OpenAI-compatible endpoint so OmniRoute (and any OpenAI SDK/client) can
// route chat completions to the user's real logged-in sessions — the same
// machinery as POST /prompt, but speaking the industry wire format.
//
//   GET  /v1/models
//           -> {object:"list", data:[{id:"deepseek", ...}, {id:"kimi", ...}, ...]}
//   POST /v1/chat/completions
//           body: {model:"deepseek"|"ui2api/deepseek", messages:[...],
//                  stream?:boolean, new_chat?:boolean, account?:string,
//                  temperature?, max_tokens?}
//           -> non-stream: OpenAI chat.completion JSON
//              stream:     SSE of chat.completion.chunk events then [DONE]
//
// Streaming note (honest): the ChatDriver reads the site's rendered answer
// when it stops growing, so the completion is COMPLETE before we start
// writing. stream:true replays the finished answer as incremental SSE
// chunks — token timings are cosmetic; there is no half-answer visible.
//
// Capabilities beyond chat (web search toggles, file/vision upload, model
// pickers…) stay on the ui2api-native /capability/<site> routes; the /v1
// surface covers the chat core (the router's main call path).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatPool } from "./pool.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import { chatSurfaceStatus, defaultChatSurface, type ChatSurfaceStatus, type RegistryVerified } from "./registry.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface OpenAIOptions {
  pool: ChatPool;
  profilesById: Record<string, ChatSiteProfile>;
  /**
   * The prompt-driven tool layer, injected BY STRUCTURE (never imported — the
   * module is owned elsewhere and this file must not break while it is
   * absent). When the daemon passes the three functions below, this surface can
   * execute an OpenAI `tools` array the SOFT way: the tools are rendered into
   * the prompt, the model's reply is parsed back into a tool call, and the
   * markup is stripped from the visible answer. Absent → `tools: "none"`,
   * which is the honest state of a build with no tool layer.
   *
   * Structural on purpose: whoever wires the layer passes its exports and the
   * compiler checks the signature here, so a drift in the layer's shape is a
   * TYPE error instead of a runtime lie.
   */
  softTools?: {
    buildToolInstruction(tools: unknown): string;
    parseToolCall(raw: string, tools: unknown): unknown;
    stripToolCall(raw: string): { content: string; parsed: unknown };
  };
  /** Identity-keyed account validation, injected by the daemon (http.ts) so the
   *  /v1 surface enforces the SAME vault check as /prompt and /capability/<site>:
   *  an unknown account throws (→ 400 in the server catch) BEFORE any browser
   *  work. Absent → no account was requested (legacy default path). */
  validateAccount?: (account: string | undefined, profile: ChatSiteProfile) => void;
}

const PREFIX = "ui2api/";

// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITY METADATA ON /v1/models (the "make the models discoverable as a
// provider with their capabilities" ask)
//
// Before this, an entry carried `id` + `object:"model"` and nothing else: a
// consumer materialising one provider per advertised model could not tell
// whether it streams, whether it can take tools, or whether it is honestly
// blocked — it could only find out by making a request and failing. That is
// the same defect class this whole surface exists to prevent (a caller forced
// to discover a fact by failing).
//
// EVERY field below is DERIVED at request time from a source that already owns
// the truth. There is deliberately NO per-model capability table anywhere in
// this file: such a table is a snapshot that rots, and this repo has been
// burned by hand-typed snapshots more than once. If a fact is not derivable it
// is OMITTED, never filled in with a plausible number.
// ─────────────────────────────────────────────────────────────────────────────

/** Drift gate for the capability block (same idea as REGISTRY_CONTRACT_VERSION):
 *  bumped whenever the SHAPE of a capability field changes, so a consumer built
 *  against an older daemon can detect the mismatch instead of silently
 *  mis-reading a field. */
export const MODEL_CAPABILITIES_VERSION = 1;

/**
 * Tool-calling support, and the vocabulary a consumer must read:
 *  - "native" — the model/site emits a real tool call through this wire. NOT
 *    claimed by anything today (see NATIVE_TOOL_CALL_SUPPORTED).
 *  - "soft"   — the daemon renders the requested tools into the prompt and
 *                parses the reply back into a tool call. Works on any chat site
 *                because it uses only the site's own composer. Enabled by
 *                `opts.softTools` being wired.
 *  - "none"   — no tool layer is wired; a `tools` array in the request is
 *                ignored. Honest, and the default.
 */
export type ModelToolSupport = "native" | "soft" | "none";

export const MODEL_TOOL_SUPPORT_VALUES: readonly ModelToolSupport[] = ["native", "soft", "none"];

/**
 * Does THIS handler have a native tool-calling path? MEASURED: no.
 *
 * A native path would mean this file emits `message.tool_calls` /
 * `delta.tool_calls` sourced from the SITE's own tool machinery (the site's
 * toolkit panel, its real function-calling wire). Nothing in this handler
 * does: `/v1/chat/completions` reads only `model/messages/stream/new_chat/
 * account` from the body and answers with the rendered answer text. The site's
 * own tool UI (web-search toggles, model pickers, file attach) is driven
 * through `/capability/<site>`, not through this OpenAI wire.
 *
 * So `tools:"native"` is FALSE for every model, and the honest per-model value
 * is derived below. This constant is the single place that fact lives, so the
 * claim is auditable instead of scattered — and
 * `test/model-capability-truth.test.ts` greps THIS file for a `tool_calls`
 * emission and fails if any entry claims "native" while that path is absent.
 */
export const NATIVE_TOOL_CALL_SUPPORTED = false;

/**
 * Streaming is a property of the SURFACE, not of a site: the SSE branch below
 * is model-agnostic (any profile that clears the model gate gets the same
 * `text/event-stream` + `chat.completion.chunk` replay), so every advertised
 * model streams. `streamingMode: "replay"` is the honesty qualifier — the
 * ChatDriver reads the site's rendered answer when it stops growing, so the
 * completion is COMPLETE before the first chunk is written. Token timings are
 * cosmetic; a consumer that needs true incremental output must not infer it
 * from `streaming: true`. Omitting `streamingMode` would be the overstatement.
 */
export const MODEL_STREAMING_SUPPORTED = true;
export const MODEL_STREAMING_MODE = "replay";

/** The exact wire shape a tool call MUST take when this surface surfaces one.
 *  Declared here (not in the soft-tool layer) so the vocabulary `/v1/models`
 *  advertises and the vocabulary the answer uses cannot drift apart. */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenAIToolCallMessage = {
  role: "assistant";
  content: string | null;
  tool_calls: OpenAIToolCall[];
};

export const OPENAI_TOOL_CALL_FINISH_REASON = "tool_calls";

export interface ModelCapabilityMetadata {
  /** Streaming shape, surface-level (see MODEL_STREAMING_SUPPORTED). */
  streaming: boolean;
  /** "replay" — the answer is complete before the first chunk; see above. */
  streamingMode: typeof MODEL_STREAMING_MODE;
  /** native | soft | none (see ModelToolSupport). */
  tools: ModelToolSupport;
  /** Machine status from the registry's own resolver (verified /
   *  unverified-candidate / builtin / dormant / dead-end). */
  status: ChatSurfaceStatus;
  /** Where the serving profile comes from: the builtin catalog or an
   *  installed capability package. */
  provenance: "builtin" | "packaged";
  /** The package's real verification record from metadata.json, or `false`
   *  when there is none. Never synthesised. */
  verified: RegistryVerified | false;
  /** True when this site is only driveable with a real logged-in browser. */
  requiresRealBrowser: boolean;
  /** The tool-call shape a `tools:"soft"` call will come back in. */
  toolCallShape: "openai.function_call" | null;
}

/** Where a served profile's authority comes from — DERIVED, never typed.
 *  The default chat surface already resolves this (a builtin id is
 *  authoritative for itself, a packaged id otherwise); an explicitly
 *  allow-listed id that is NOT on the default surface is resolved from the
 *  package/profile the id actually has. */
function provenanceOf(siteId: string, onSurface: Map<string, { packaged: boolean }>): "builtin" | "packaged" {
  const entry = onSurface.get(siteId);
  if (entry) return entry.packaged ? "packaged" : "builtin";
  // Not on the default surface: only reachable through an explicit --site
  // allow-list. Ask the package dir, then the builtin catalog, in that order.
  for (const up of [2, 3]) {
    let p = fileURLToPath(new URL(".", import.meta.url));
    for (let i = 0; i < up; i++) p = dirname(p);
    for (const root of [resolve(p, "capabilities", siteId), resolve(p, "src", "capabilities", siteId)]) {
      if (existsSync(resolve(root, "manifest.json"))) return "packaged";
    }
  }
  return "builtin";
}

/** Read a package's real `verified` record (metadata.json) — the same file the
 *  registry reads. `false` when absent/unreadable/not a full record. This is a
 *  re-read rather than a second STATUS resolver on purpose: only the record
 *  (not the status, which has exactly one resolver) is needed here. */
function verifiedRecordOf(siteId: string): RegistryVerified | false {
  for (const up of [2, 3]) {
    let p = fileURLToPath(new URL(".", import.meta.url));
    for (let i = 0; i < up; i++) p = dirname(p);
    for (const root of [resolve(p, "capabilities", siteId), resolve(p, "src", "capabilities", siteId)]) {
      const file = resolve(root, "metadata.json");
      if (!existsSync(file)) continue;
      try {
        const v = (JSON.parse(readFileSync(file, "utf8")) as { verified?: unknown }).verified;
        if (v && typeof v === "object") {
          const r = v as { since?: unknown; evidence?: unknown; via?: unknown; scope?: unknown };
          if (typeof r.since === "string" && typeof r.evidence === "string" && typeof r.via === "string") {
            return {
              since: r.since,
              evidence: r.evidence,
              via: r.via,
              scope: typeof r.scope === "string" ? r.scope : undefined,
            };
          }
        }
      } catch {
        return false; // malformed metadata claims nothing
      }
    }
  }
  return false;
}

/** The tool level this daemon can actually execute, DERIVED from the wiring
 *  (not from a per-site table): native only if this surface ever grows a real
 *  native path, soft when the soft-tool layer is injected, else none. */
export function modelToolSupport(opts: Pick<OpenAIOptions, "softTools">): ModelToolSupport {
  if (NATIVE_TOOL_CALL_SUPPORTED) return "native";
  if (opts.softTools) return "soft";
  return "none";
}

/** Build the enriched, DERIVED capability block for one served profile. */
export function modelCapabilities(
  profile: ChatSiteProfile,
  ctx: {
    toolSupport: ModelToolSupport;
    onSurface: Map<string, { packaged: boolean }>;
  },
): ModelCapabilityMetadata {
  const soft = ctx.toolSupport !== "none";
  return {
    streaming: MODEL_STREAMING_SUPPORTED,
    streamingMode: MODEL_STREAMING_MODE,
    tools: ctx.toolSupport,
    status: chatSurfaceStatus(profile.id),
    provenance: provenanceOf(profile.id, ctx.onSurface),
    verified: verifiedRecordOf(profile.id),
    requiresRealBrowser: Boolean((profile as { realProfileOnly?: boolean }).realProfileOnly),
    toolCallShape: soft ? "openai.function_call" : null,
  };
}


function sendJson(res: ServerResponse, status: number, data: unknown): void {
  // GOAL 83: answer at most once. The daemon's aggregate deadline answers an
  // over-deadline /v1 request with a named 504 while this route's browser work
  // is still in flight; when that work finally settles, this guard makes the
  // late answer a no-op instead of a second write on a finished response. The
  // happy-path bytes are unchanged.
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(data);
  try {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  } catch {
    // socket already gone (client hung up / shutdown destroyed it)
  }
}

// profilesById is the daemon's configured allow-list; a site that is not
// configured here is refused (origin pinning — see src/runtime/ssrf.ts).
function profileById(id: string, profilesById: Record<string, ChatSiteProfile>): ChatSiteProfile {
  const p = profilesById[id];
  if (p) return p;
  throw new Error(`unknown site "${id}" — try one of ${Object.keys(profilesById).join(", ")}`);
}

function siteIdFromModel(model: unknown, fallback: string): string {
  let m = typeof model === "string" && model ? model : fallback;
  if (m.startsWith(PREFIX)) m = m.slice(PREFIX.length);
  // accept ui2api-deepseek style too (executor convenience)
  if (m.startsWith("ui2api-")) m = m.slice("ui2api-".length);
  return m;
}
export { siteIdFromModel };

function messagesToPrompt(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const parts: string[] = [];
  for (const m of messages) {
    const role = typeof (m as { role?: unknown })?.role === "string" ? (m as { role: string }).role : "user";
    let content = "";
    const raw = (m as { content?: unknown })?.content;
    if (typeof raw === "string") content = raw;
    else if (Array.isArray(raw)) {
      // multimodal content parts — keep text; image/file parts are refused on
      // /v1 for now (site file/vision flows live on /capability/<site>)
      content = raw
        .filter((p) => typeof (p as { type?: unknown })?.type === "string" && ((p as { type: string }).type === "text" || (p as { type: string }).type === "input_text"))
        .map((p) => String((p as { text?: unknown })?.text ?? ""))
        .join("\n");
    }
    if (content.trim()) parts.push(content.trim());
  }
  return parts.join("\n");
}
export { messagesToPrompt };

export async function handleOpenAIRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAIOptions
): Promise<void> {
  const { pool, profilesById } = opts;
  const url = req.url ?? "";

  // GET /v1/models — the chat sites this daemon can serve, each with the
  // DERIVED capability metadata a consumer needs to materialise a provider
  // without discovering the facts by failing. See the CAPABILITY METADATA block
  // above for what each field is derived from and what is deliberately absent
  // (context_window: this repo has no measured per-site value, so the field is
  // OMITTED rather than invented — a made-up context window is a number a
  // consumer would size real requests against).
  if (req.method === "GET" && url === "/v1/models") {
    const onSurface = new Map(defaultChatSurface().map((e) => [e.id, { packaged: e.packaged }]));
    const toolSupport = modelToolSupport(opts);
    const data = Object.values(profilesById).map((p) => ({
      id: p.id,
      object: "model",
      created: 0,
      owned_by: "ui2api",
      permission: [],
      root: p.id,
      parent: null,
      site: p.name,
      url: p.url,
      loginRequired: p.loginRequired ?? false,
      // …and the capability block, spread at the TOP level of the entry so a
      // consumer reads `m.tools` / `m.status` without unwrapping a sub-object
      // whose shape it would have to guess.
      ...modelCapabilities(p, { toolSupport, onSurface }),
    }));
    return sendJson(res, 200, { object: "list", capabilitiesVersion: MODEL_CAPABILITIES_VERSION, data });
  }

  if (req.method === "POST" && url === "/v1/chat/completions") {
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody(req)) as Record<string, unknown>;
    } catch {
      return openAiError2(res, 400, "request body is not valid JSON");
    }
    const stream = Boolean(body.stream);
    const modelRaw = body.model;
    const site = siteIdFromModel(modelRaw, "");
    let profile: ChatSiteProfile;
    try {
      profile = profileById(site, profilesById);
    } catch (e) {
      return sendJson(res, 404, {
        error: {
          message: e instanceof Error ? e.message : `unknown model "${modelRaw}"`,
          type: "invalid_request_error",
          code: "unknown_model",
          param: "model",
        },
      });
    }
    let prompt = messagesToPrompt(body.messages);
    // ROUND N+103 — the SOFT tool layer, wired here and nowhere else.
    //
    // This is deliberately the ONLY place the instruction is injected, and it is
    // injected into the PROMPT rather than into any wire payload: the site's own
    // JavaScript receives it, types it, and sends it exactly as a human's prompt
    // would. Nothing is forged, no internal API is called, and there is no
    // request shape here that a person clicking in the composer could not
    // produce. That is what keeps it ban-safe — the failure mode this project
    // cannot accept is a tool-calling implementation that gets an account
    // banned for traffic the site never saw a human generate.
    //
    // HONESTY, and it is the point of the whole exercise: the model has NOT run
    // the function. The caller receives a tool call, executes it themselves, and
    // sends the result back as a `role:"tool"` message. If the model ignores the
    // instruction we get `null` and the answer falls through untouched — we
    // never invent a function name to fill the gap.
    const softTools = opts.softTools;
    const requestedTools = Array.isArray(body.tools) ? body.tools : undefined;
    const toolInstruction =
      softTools && requestedTools && requestedTools.length > 0
        ? softTools.buildToolInstruction(requestedTools)
        : "";
    if (toolInstruction) prompt = `${prompt}\n\n${toolInstruction}`;
    if (!prompt.trim()) {
      return sendJson(res, 400, {
        error: { message: "messages must contain at least one non-empty text part", type: "invalid_request_error", param: "messages" },
      });
    }
    // ROUND N+103 — the OpenAI surface was NEVER starting a fresh conversation.
    //
    // It read `body.new_chat`, a ui2api-specific field that does not exist in the
    // OpenAI wire format, so for every standards-compliant request this was
    // `false` and the reset never ran. The driver then composed into whatever
    // page the warm pool had handed back — a page still holding the PREVIOUS
    // request's conversation. Measured: a request that had nothing to do with the
    // weather came back with `"title":"Weather in Paris"`, the prior
    // conversation's title, sitting in the response body.
    //
    // Why this matters more than a dirty title: the /v1 surface flattens the
    // whole `messages` array into ONE prompt, so the request is self-contained
    // and the site's own history is a SECOND, invisible source of truth. Two
    // sources of truth, one of them the previous caller's conversation, is how an
    // agent gets an answer that belongs to somebody else — silently, and with a
    // confident-looking answer attached.
    //
    // So the default flips: a standards-compliant request ALWAYS starts a fresh
    // chat, because the caller has just told us the entire conversation in
    // `messages`. `new_chat:false` remains available to opt out and keep a
    // warm page, for a caller that genuinely wants site-side continuity.
    const newChat = body.new_chat === undefined ? true : Boolean(body.new_chat);
    const account = typeof body.account === "string" && body.account ? body.account : undefined;
    // Validate the identity-keyed account BEFORE any browser work (the same
    // guard /prompt runs): unknown -> the throw propagates to the server catch
    // for a 400, never a silent fallback to the legacy default session.
    opts.validateAccount?.(account, profile);
    const worker = await pool.acquire(profile.id, account);
    try {
      const result = await worker.driver.ask(prompt, { newChat });
      await pool.release(worker);
      // Parse the reply BEFORE it is rendered. On a hit the scaffolding is
      // stripped so the caller never sees the JSON envelope we asked for, and the
      // message carries a real `tool_calls` array plus finish_reason "tool_calls".
      // On a miss (`null`) the answer is returned verbatim — an ordinary reply.
      // The `softTools` seam is structural and its `parseToolCall` is typed
      // `unknown` on purpose, so the layer cannot break this file's build while
      // absent. Narrow it HERE, at the one place a value is produced, and fail
      // closed: anything that is not a well-formed call is treated as NO call,
      // which sends the answer through untouched rather than emitting a
      // `tool_calls` array built from a shape nobody validated.
      const narrowed = (
        softTools && requestedTools && requestedTools.length > 0
          ? softTools.parseToolCall(result.answer ?? "", requestedTools)
          : null
      ) as {
        toolCallId?: unknown;
        name?: unknown;
        argumentsJson?: unknown;
      } | null;
      const parsedCall =
        narrowed &&
        typeof narrowed.toolCallId === "string" &&
        typeof narrowed.name === "string" &&
        typeof narrowed.argumentsJson === "string"
          ? {
              toolCallId: narrowed.toolCallId,
              name: narrowed.name,
              argumentsJson: narrowed.argumentsJson,
            }
          : null;
      const answer = parsedCall
        ? (softTools?.stripToolCall(result.answer ?? "").content ?? "")
        : (result.answer ?? "");
      const id = `chatcmpl-ui2api-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const created = Math.floor(Date.now() / 1000);
      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const chunk = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        // GOAL 109: a restriction wall (paywall / limit / login) is NOT an empty
        // success. The OpenAI protocol has the right vocabulary for it —
        // finish_reason "content_filter" plus a `refusal` string — so use it
        // rather than inventing a status. The named hits stay visible.
        if (result.doneReason === "restricted") {
          const detail = (result.restrictions ?? []).map((r) => `${r.kind}: ${r.matched}`).join("; ") || "restriction wall detected";
          chunk({
            id, object: "chat.completion.chunk", created, model: profile.id,
            choices: [{ index: 0, delta: { refusal: detail }, finish_reason: "content_filter" }],
            ui2api: { site: profile.id, doneReason: "restricted", restrictions: result.restrictions ?? [] },
          });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        chunk({ id, object: "chat.completion.chunk", created, model: profile.id, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        if (parsedCall) {
          // A tool call replaces the content replay: the caller is not being sent
          // prose, it is being told which function to run. Sending both would let
          // a consumer treat the instruction scaffolding as the model's answer.
          chunk({
            id,
            object: "chat.completion.chunk",
            created,
            model: profile.id,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: parsedCall.toolCallId,
                      type: "function" as const,
                      function: { name: parsedCall.name, arguments: parsedCall.argumentsJson },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          chunk({ id, object: "chat.completion.chunk", created, model: profile.id, choices: [{ index: 0, delta: {}, finish_reason: OPENAI_TOOL_CALL_FINISH_REASON }] });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        // replay the completed answer as incremental chunks
        for (let i = 0; i < answer.length; i += 8) {
          chunk({ id, object: "chat.completion.chunk", created, model: profile.id, choices: [{ index: 0, delta: { content: answer.slice(i, i + 8) }, finish_reason: null }] });
        }
        chunk({ id, object: "chat.completion.chunk", created, model: profile.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      return sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model: profile.id,
        choices: [
          {
            index: 0,
            // GOAL 109: never "stop" + empty content for a restriction wall.
            message: {
              role: "assistant",
              content: answer,
              // Present ONLY when a call was parsed, so a consumer can branch on
              // the key's existence rather than on a magic empty value. The
              // `executed:false` reality is NOT on the wire — OpenAI's schema has
              // no room for it — so a consumer that treats this as an executed
              // call is making that assumption itself, deliberately, rather than
              // being told it happened.
              ...(parsedCall
                ? {
                    tool_calls: [
                      {
                        id: parsedCall.toolCallId,
                        type: "function" as const,
                        function: { name: parsedCall.name, arguments: parsedCall.argumentsJson },
                      },
                    ],
                  }
                : {}),
              refusal:
                result.doneReason === "restricted"
                  ? (result.restrictions ?? []).map((r) => `${r.kind}: ${r.matched}`).join("; ") || "restriction wall detected"
                  : null,
            },
            finish_reason: result.doneReason === "restricted" ? "content_filter" : "stop",
            logprobs: null,
          },
        ],
        ui2api: { site: profile.id, chunkCount: result.chunkCount ?? 0, doneReason: result.doneReason ?? "stop", url: result.url ?? undefined, title: result.title ?? undefined },
      });
    } catch (e) {
      await pool.release(worker).catch(() => undefined);
      const msg = e instanceof Error ? e.message : String(e);
      return sendJson(res, 502, { error: { message: msg, type: "server_error", code: "ui2api_driver_error", param: null } });
    }
  }

  // Terminal fallback — NO /v1/* request may leave this handler without a
  // response. An unmatched path (any /v1/embeddings, /v1/completions, a wrong
  // method on /v1/chat/completions, …) used to fall through the whole function
  // and hang the connection forever: nothing ever wrote to res. Answer a named
  // 404 instead (the marketplace-class hang the user hit once — "the last
  // ocmmand you did stucked"). The native non-/v1 404 at http.ts stays the
  // fallback for paths outside the /v1 prefix.
  return sendJson(res, 404, {
    error: {
      message: `unknown endpoint ${req.method ?? "?"} ${url}; ui2api serves GET /v1/models and POST /v1/chat/completions`,
      type: "invalid_request_error",
      code: "not_found",
      param: null,
    },
  });
}

// --- helpers ----------------------------------------------------------------

function openAiError2(res: ServerResponse, status: number, message: string, code?: string): void {
  sendJson(res, status, { error: { message, type: "invalid_request_error", code, param: null } });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 2_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}