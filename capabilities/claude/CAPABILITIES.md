# Claude capabilities (from JS bundle analysis, 2026-09-16)

Analyzed 22 JS bundles (~4.2 MB) harvested from `https://claude.ai` static shell
(`index-DviVWZR7.js`, `shared-0..16`, `shared-msg-0..2`, `shared-common(sg)-*`,
`shared-frame-*`, `vendor-router`, `vendor-*`), served by
`https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/<hash>.js` (public CDN,
NOT behind the Cloudflare gate). Strings are minified rolldown/Vite output
(`__vite__mapDeps`, `.fine-` module style).

Bot-wall status: **claude.ai is Cloudflare-gated.** Plain curl (fresh IP, Chrome UA)
gets a "Just a moment…" login/JS challenge page (HTTP 200, CF inline challenge).
The challenge HTML still embeds the REAL app-shell module manifest (bundle URLs
above), so transport = **headed live capture** for auth + DOM, bundle CDN is freely
scriptable for endpoint mining. No over-the-wire chat request was captured yet.

## 1. Chat core (composer, send path, streaming)
- The SPA is a **ProseMirror** composer app (bundles `shared-3`, `shared-15`; strings
  `ProseMirror`, `contenteditable`, `parent_message_uuid`, `type:"user"`). Answer DOM
  nodes are tagged `data-testid="assistant-message"` (confirmed: `shared-7`, `shared-msg-1`,
  `shared-common-msg-1`). These ground the built-in claude profile selectors.
- Conversation-scoped REST root: `https://claude.ai/api/organizations/{orgUuid}/chat_conversations/{convUuid}/…`
  (all fetches use `credentials:"include"` — cookie auth; headers
  `anthropic-version: 2023-06-01`, `anthropic-beta: ccr-byoc-2025-07-29` on mutable calls).
- The **message-send call itself was not found** in the harvested chunks (details §5) —
  expected to be a lazy route chunk. The send wire from prior builds is
  `POST …/chat_conversations/{conv}/completion` (SSE) but that literal string is absent from
  these bundles → treat as **unverified for this build**; the UI path drives the site's own
  handler so no reconstruction is needed.
- Queued-send / rate handling: `GET …/chat_conversations/{conv}/queued_message` (react-query
  poll, key `rate-limit-queued-message`; statuses `user_canceled_for_queued_message`,
  `model_not_available`, `conversation_too_long`, timeout keys `conversation_too_long`).
- Models on page: `opus` / `sonnet` / `haiku` (strings in `shared-7`, `shared-msg-1`);
  per-message model override + `model_not_available` error surfaced in UI.
- Feature flags present in bundles: `extended_thinking` (`shared-0`, `shared-13`),
  `web_search` tool (6 refs `shared-0`, plus `shared-12/14/15`), artifacts
  (CCR sandbox: `anthropic.claude.usercontent.sandbox.ClaudeCompletionRequest/Response`),
  MCP (`anthropic.beta` plugins, `mcp/probe`), art-completions push notifications
  (`notification_feature_category==="completion"`).

## 2. Wire endpoints recovered (real, from bundles)
- `GET/PUT …/api/organizations/{org}/chat_conversations/{conv}` — conversation resource;
  PUT with `?rendering_mode=raw` + body `{project_uuid}` (voice-mode association).
- `GET …/chat_conversations/{conv}/queued_message` — queue poll (see §1).
- `POST …/chat_conversations/{conv}/tool_approval` — human-in-the-loop tool approval
  (background/SDK tool calls).
- `GET/POST …/chat_conversations/{conv}/composer_notices[/action]` — composer surface notices.
- `POST …/chat_conversations/{conv}/debug_block` — SSE (`Accept: text/event-stream`,
  body `{}`), debug block stream.
- `DELETE …/chat_conversations/{conv}/chat_messages/{msgUuid}/flags` — flag/unflag a message.
- `GET/POST …/chat_conversations/{conv}/task/{taskUuid}/status|stop` — background-task
  lifecycle (status poll + stop); task base under `…/task/`.
- `POST …/api/organizations/{org}/dust/chat_continuations` — follow-up suggestion chips.
- `POST …/api/organizations/{org}/cowork/safety_flags/batch` — in-flight message safety gate.
- `POST …/api/organizations/{org}/mcp/probe` — SSE, server-side URL probe for MCP fetches.
- `…/api/organizations/{org}/{library/discover/*, marketplaces/*, plugins/*, cowork_plugin_metadata}`
  — Claude skills/marketplace/plugin surface (peripheral; not needed for chat).
- `GET /api/account`, `GET /api/account/cli_op_permissions` — account / CLI (Claude Code) area.
- Claude Code / reports SSE: `/v1/code/sessions/{id}/events/stream`, `/v1/code/sessions/{id}/watch?exclude_tags=-`,
  `/v1/code/sessions` base (all `Accept: text/event-stream`, `credentials:"include"`).
- Misc: `/api/frame/*` (shared-frame iframes), `/api/event_logging/v2/batch` (telemetry),
  `/api/referral`, `/api/team-trial/exposure-eligible`, `/api/auth/trusted_devices`,
  `/api/desktop/…` (app download).

## 3. Streaming mechanism
- **SSE (`text/event-stream`)** is the streaming transport; fetches set
  `Accept:"text/event-stream"`, `credentials:"include"`, `openWhenHidden:true`.
- A shared SSE client in `shared-msg-0` implements **resumable streams**: `resume_token`
  query param (`e.streamPosition.token`), `attemptFromOwnPosition`, `sse_recovered`
  event, lineage tracking, DataBroker-style `onopen/onmessage` parsing; sensitive
  streams add header `X-Device-Attestation` (client attestation, fed by hCaptcha).
- Typed stream events follow Anthropic Messages-API shapes: `Ping`, `MessageStart`,
  `MessageDelta`, `MessageStop`, `ContentBlockStart`, `ContentBlockDelta`, `Error`
  (switch in `shared-0`; used by memory-edit and debug-block streams).
- Server-side probes distinguish CF mitigation: `cf-mitigated === "challenge"` →
  `probe_challenged`; wrong content-type → `probe_not_sse`; status → `probe_http_{code}`.

## 4. Auth & session facts for automation
- Cookie-session auth: all fetches `credentials:"include"` (browser same-origin cookie jar).
  provider-catalog.md names the credential cookie **`sessionKey`** (claude-web, kind: cookie);
  `sessionKey` also appears as a react-query cache key in `shared-msg-0` (unrelated UI state) —
  cookie name itself confirmed only via provider-catalog, not raw bundle strings.
- API version headers on writes: `anthropic-version: "2023-06-01"`, and `anthropic-beta`
  (e.g. `ccr-byoc-2025-07-29`).
- **Anti-bot stack**: Cloudflare (challenge page on plain fetch; `cf-mitigated` header
  honored by app probes), **hCaptcha invisible** attestation loaded from
  `js.hcaptcha.com/1/api.js` with `__antClientAttestationHcaptchaInvisibleReady`, plus
  `X-Device-Attestation` request header on streams. Expect CF to gate the DOM/app until a
  real headed session passes; sessions must be captured live, then replayed with cookies.

## 5. Unverified / to capture on first live headed capture
- **The message-send request shape** (URL + body). Not present in harvested chunks; classic
  claude-web build used `POST …/chat_conversations/{conv}/completion` with `text/event-stream`,
  but this build may route sends through `…/chat_messages` + `…/task/…` — must be read from
  the network log during a live session, not guessed.
- `sessionKey` cookie name/expiry and any extra required cookies (authorization, cf_\*).
- Exact initial-message POST payload fields (`parent_message_uuid`, attachments, files,
  model, `server_tools`).
- `data-testid="prompt-editor"` and `.font-claude-message` class (built-in-profile ground
  truth; not found literally in minified bundles — they may be runtime/template-injected).
- New-chat entrypoint selector (`aria-label="New chat"` / `[data-testid="new-chat"]`).

## 6. Suggested ui2api capability list (id, one-line description)
1. `claude_chat` — Send message on the ProseMirror composer (insertText + Enter);
   read streamed answer off `[data-testid="assistant-message"]` nodes. (core; live capture required)
2. `claude_queued_send` — Queue-aware send: poll `…/queued_message` when rate-limited,
   surface `model_not_available`/`conversation_too_long`.
3. `claude_web_search` — Toggle in-chat `web_search` tool (`extended_thinking` flag present
   as sibling); grounded at bundle level, request-level mapping pending live capture.
4. `claude_extended_thinking` — Enable `extended_thinking` mode flag on send once payload
   shape is captured.
5. `claude_task_control` — Background generation via `…/task/{id}/status|stop` (artifact
   / long jobs lifecycle).
6. `claude_tool_approval` — Approve/deny tool calls via `POST …/tool_approval`.

(Not exposing: account/CLI (`/api/account`, `/v1/code/sessions`), skills marketplace,
marketplaces/plugins admin, telemetry — sensitive or peripheral; endpoints above if needed.)