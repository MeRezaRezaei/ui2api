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

export interface OpenAIOptions {
  pool: ChatPool;
  profilesById: Record<string, ChatSiteProfile>;
  /** Identity-keyed account validation, injected by the daemon (http.ts) so the
   *  /v1 surface enforces the SAME vault check as /prompt and /capability/<site>:
   *  an unknown account throws (→ 400 in the server catch) BEFORE any browser
   *  work. Absent → no account was requested (legacy default path). */
  validateAccount?: (account: string | undefined, profile: ChatSiteProfile) => void;
}

const PREFIX = "ui2api/";

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

  // GET /v1/models — the chat sites this daemon can serve
  if (req.method === "GET" && url === "/v1/models") {
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
    }));
    return sendJson(res, 200, { object: "list", data });
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
    const prompt = messagesToPrompt(body.messages);
    if (!prompt.trim()) {
      return sendJson(res, 400, {
        error: { message: "messages must contain at least one non-empty text part", type: "invalid_request_error", param: "messages" },
      });
    }
    const newChat = Boolean(body.new_chat);
    const account = typeof body.account === "string" && body.account ? body.account : undefined;
    // Validate the identity-keyed account BEFORE any browser work (the same
    // guard /prompt runs): unknown -> the throw propagates to the server catch
    // for a 400, never a silent fallback to the legacy default session.
    opts.validateAccount?.(account, profile);
    const worker = await pool.acquire(profile.id, account);
    try {
      const result = await worker.driver.ask(prompt, { newChat });
      await pool.release(worker);
      const answer = result.answer ?? "";
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