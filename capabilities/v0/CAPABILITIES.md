# v0 by Vercel capabilities (from JS bundle analysis, 2026-09-16)

Analyzed statically (curl only, Chrome UA, no browser launched): `https://v0.dev` 301-redirects to
**`https://v0.app`** (final URL, HTTP 200). Downloaded the 1.0 MB SSR app page (`/chat-static/_next/static/...`,
Turbopack/Next.js build) + **9 JS bundles (~4.8 MB)** from `/chat-static/_next/static/immutable/chunks/`
(`1pzyzjp7dvrho` ~2.0 MB, `3p456nevqfbrh` ~857 KB, `30dpjruayszu9` ~507 KB, `06_li7d4qdaqu` ~487 KB,
`3hvs4_nozdjcg` ~343 KB, `24arcqmaky74i` ~256 KB, `2vmgmbi2xn1n6` ~241 KB, `0x184y9pdeaqp` ~204 KB,
plus `turbopack-0mcg6dj3-fnli` bootstrap).
Homepage title: "v0 by Vercel - Build Full-Stack Web Apps with AI" / "Your collaborative AI assistant to
design, iterate, and scale full-stack applications for the web."

v0 is **builder/artifact-oriented**: chat + live generated previews (agent workspace VM, frames, deployment).
Only the underlying chat transport is fully verifiable at the static layer; artifact/preview *rendering*
requires a live capture and is flagged **to-verify** below.

## 1. Chat core (send, stream, resume)

- Send: **`POST /chat/api/chat`** — `Accept: text/event-stream`, `Content-Type: application/json`, same-origin
  (`baseUrl ""` default on the transport client). Client transport API: `sendMessage(input)` /
  `resumeMessage({messageId})` / `getLatest(...)` (calls `rX`/`rK`/`rY` generators in the 1pzyzjp7dvrho bundle).
- Request body (bundle-verified object builder):
  `chatId`, `messageId`, `messageContent` (`{version:1, parts:[{type:"mdx", content:<string>}]}`,
  OR `{version:1, parts:[…]}` for programmatic multi-part input), `modelConfiguration`
  (default at send time `{modelId:"v0-max", imageGenerations:true}`; schema-documented default is `v0-pro`),
  `userMessageType` (`"message"`), `isNew`, `permissionsMode` (`"full"`), `attachments[]`,
  `projectId:null`, and optional `programmatic`, `sandbox:{enabled:true}`, `shouldCreatePR`, commands fields.
- Resume: **`GET /chat/api/chat/resume?messageId=<id>`** (`cache:"no-store"`); liveness probe
  **`HEAD /chat/api/chat/resume/ping`**; latest-state sync **`GET /api/chat/chat/latest?chatId=&lastSyncedAt=`**.
- Response header **`x-v0-user-message-id`** mirrors the created user message id (client falls back to its
  own `messageId` when absent).
- Response streaming: the fetch body is consumed as **newline-delimited JSON** — each line is `JSON.parse`d
  and reduced into client state by a per-call reducer (module-scoped `rT.f`, `s=(rT.f)(s,line)`); transport
  layer then emits wrapper events `{type:"message", assistantMessageId, content}` / `{type:"error"}`
  / `{type:"complete"}`. Lines that match LLM-error markers (`isLlmError`, `isRetried`, and finish-reason
  strings `provider_server_error[:<category>]` / `retry_provider_server_error[:<category>]`) abort the stream
  with an error event. **The per-line event schema inside the reducer was not fully recovered (reducer is in a
  not-downloaded chunk) — to verify on first live capture.**
- Stop: **`POST /chat/api/stop-agent`** (JSON body).
- Auth header handling: `headers` may be a function or object; the transport passes them through verbatim
  (same-origin; session carried by cookie, not an Authorization literal on chat calls).

## 2. Streaming / realtime surface

- Chat/artifacts/deployments use **HTTP fetch + `text/event-stream` Accept**; the chat body is plain NDJSON
  per §1 (not `event:`/`data:` SSE frames — the parser splits on single `\n`).
- True SSE frame parsers exist for deploy/publish endpoints (extract lines starting `data:`, split on `\r?\n\r?\n`):
  - Publish stream (**`POST /api/v2/internal/chats/{chatId}/publish`**): objects
    `{object:"publish.progress", phase, message}`, `{object:"publish.result", result}`, `{object:"error", code, message}`.
  - Deployment stream (**`POST /api/v2/internal/deployments/`**, body `{chatId, skippedDeployWarning}`): objects
    `{object:"deployment.progress", stage, message}`, `{object:"deployment.log", stream:"stdout"|"stderr", text}`,
    `{object:"deployment.created", id, url, inspectorUrl}`, `{object:"error", code, message}`.
- **WebSockets** (two distinct surfaces, neither is the main chat stream):
  1. `[ws-console]` — VM/sandbox console log stream, opens `new WebSocket(url)`, sends `{type:"get-history"}`,
     auto-reconnect with backoff (admin variant). This is the agent-workspace console.
  2. A multiplexed Hono-style ws client (`createClient({ webSocket })`, `connect({sessionId, startAfter, signal})`,
     `upgradeWebSocket`, `subscribe not confirmed` timeout 35 s) — workspace-service / stream subscription surface.

## 3. Models, reasoning effort, image generation

- Model id union (bundle literals): `v0-mini`, `v0-pro`, `v0-max`, `v0-max-fast`, `v0-auto`,
  `v0-fable-5`, `v0-fable-5.1`, `v0-gpt-5.6-sol`, `v0-gpt-5.6-sol-fast`, `v0-glm-5.2`, `v0-grok-4.6`,
  `v0-kimi-k3`, `v0-opus-4.7`, `v0-opus-4.7-fast`; gateway model ids use **`creator/model`** format and
  include `claude-code`; full catalog is served dynamically from **`GET /api/v2/internal/gateway-models`**.
  Default selection is `v0-max` at send time (send-body builder), `v0-pro` as schema-documented default.
- `modelConfiguration`/generation option fields (zod-verified): `modelId`, `imageGenerations` **boolean**
  ("enables image generations to generate up to 5 images per version", default `false`),
  `imageGeneration:{modelId}`, `thinking` **boolean**, and a reasoning-effort enum
  **`["none","minimal","low","medium","high","max","xhigh"]`**.
- Image models list endpoint: **`GET /api/v2/internal/image-models`**; per-user image prefs keyed by
  `imageModelId` and a `generateImages` tool flag (`legacyToolEnabled`), governed per scope (see §9).
- UI model Catalog/feature gates managed via a `scoped` settings module
  (`(0,f.q)("scoped")?.[e]?.imageGenerations`, `designSystemId`, `suggestedActionsEnabled`, …).

## 4. Artifacts & generated previews (flagged **to-verify** for rendering)

- Builder surfaces exist in code: `/chat/api/chat/leaf` (react-query trigger — streaming leaf/message node),
  **`GET /chat/api/chat/frame-token?cid=&vid=&bid=&tcid=`** → returns a frame **session token** (the preview frame
  is opened against a sandboxed host with the token), and `/chat/api/chat/download?url=` for artifact downloads.
- `sandbox:{enabled:true}` + `permissionsMode:"full"` ride on the chat send body; agent-workspace preview
  endpoints see §6.
- **No renderer/DOM evidence for AI-artifact visibility was obtained statically (SSR page is the marketing
  landing).** Whether generated previews are reachable/readable from an automated capture — **verify on first
  live capture**; the capability below is marked `to-verify`.

## 5. Chat & builder history / CRUD

- **`GET /chat/api/history`** and **`GET /chat/api/favorites`** (JSON) — chat list/favorites.
- **`GET /api/v2/chats/:chatId`** (with `revalidate:false`) and **`GET /api/v2/chats/:chatId/connect/status`** —
  modern chat REST surface.
- `GET /api/chat/chat/latest?chatId=&lastSyncedAt=` for incremental latest-state sync; client-side
  chat-index reducer tracks `routeReady`, `titleFinalized`, `favorite`, `hasGitConnection`, `vercelProjectId`,
  `recentChats` grouping by project. Uploaded-file endpoints: `/chat/api/chat/upload` (scoped),
  `/chat/api/chat/upload/check` (JSON `{component…}` body), `/chat/api/chat/upload-s3` (S3 direct upload).

## 6. Agent workspace / VM (build-execution sandbox)

- REST: `/chat/api/vm/status?cid=`, `/chat/api/vm/git?…`, `/chat/api/vm/actions/recreate?cid=`,
  `/chat/api/vm/actions/run-pipeline` (SSR HTML reference), `/chat/api/vm/admin/shell-command`,
  `/chat/api/vm/admin/install-tools`, `/chat/api/vm/admin/vm/kill`.
- Newer surface under **`/api/v2/internal/chats/:chatId/agent-workspace/*`**: `acquire`, `create`,
  `admin/resume`, `admin/sleep`, `browser`, `code-server`, `preview-intents`, `primary-preview`,
  `restore-previews`, `services/:name/logs`, `tasks/:taskId`, `keep-alive`, `blueprint(/write-access)`,
  `projects`, `projects/:projectId/diff`, `resume`. CI checks `/api/v2/internal/chats/:chatId/ci-checks`;
  git `/api/v2/internal/chats/:chatId/git-connection`, `/api/v2/internal/github/:namespace/:repo(/branches)`,
  `/chat/api/git/connect|create-branch|reconnect|reset-deleted-branch`,
  `/api/v2/internal/chats/:chatId/repository-link/reset`.
- Live VM console stream = `[ws-console]` WebSocket (§2).
- (All of the above are endpoint-verified; **behavior to-verify on live capture** — headful harness/session.)

## 7. Deployments & publishing

- `POST /api/v2/internal/deployments/` (SSE, §2), `POST /api/v2/internal/chats/{chatId}/publish` (SSE),
  `GET /api/v2/internal/deployments/:deploymentId/logs|/errors|/screenshot`;
  `/api/v2/internal/chats/:chatId/deployments`, `/repository-deployments`, `/snowflake-deployment`,
  `/snowflake-hosting/disable`, `/deployment-suggestion-responses`, `/publish-flow`.
- Deployment/publish stream object schemas (§2) are bundle-verified.

## 8. Other capabilities (endpoint-verified; live shapes to-verify)

- **Voice input**: `POST /api/chat/transcribe` (audio → text; `VoiceTranscriptionError` telemetry).
- **Integrations / MCP**: `/api/chat/integrations/oauth/discover|initiate`, `/api/chat/integrations/slack-mcp/authorize`,
  `/api/chat/integrations/figma/account|disconnect|get-current-user|get-oauth-url`,
  `/api/chat/integrations/snowflake/oauth`, `/api/chat/integrations/mcp/permissions`,
  `/api/v2/mcp-servers(/…id)`, `/api/v2/internal/integrations/*` (connectors, npm login/connection,
  network-policy), `/api/chat/integrations/refresh-vm-env`.
- **Skills**: `/api/chat/scoped/skills/list`, `/api/skills/curated`, `/api/v2/internal/design-system-skills/:skillName/logo`.
- **Self-service API key / billing**: `POST /chat/api/ai-gateway-key` (creates a gateway API key),
  `GET /chat/api/rate-limit`, `/chat/api/plan-info`, `/chat/api/scopes`,
  `/api/v2/internal/billing/credit-purchases/:intentId`.
- **Blocks** (shared builder blocks): `PUT /chat/api/blocks`, `PUT /chat/api/blocks/files`, `POST /chat/api/blocks/git-info`.
- **Config/admin**: `/api/v2/internal/gateway-models`, `/api/v2/internal/image-models`,
  `/api/v2/internal/custom-instructions(/…id)`, `/api/v2/internal/projects(/…workspace-settings)`,
  `/api/v2/internal/prompt-queue(/kick)`, `/api/v2/internal/teams/:teamId/settings`,
  `/api/v2/internal/scope-reauth/:scope`, `/api/v2/internal/new-feature-banner`, `/api/v2/internal/activity`.

## 9. Auth & session facts for automation

- Login: browser flows redirect to **`/api/auth/login?next=<path>`** (`&action=signup` variant);
  calls to `POST /api/auth/update`. Landing page shows GitHub branding and auto-login (`Sign in to continue`
  strings absent — SSR guest page is public marketing). **GitHub/Vercel OAuth is required to reach `/chat`.**
- Session: **same-origin cookie** (`__vercel_session` per provider-catalog entry `v0-vercel-web`
  kind=cookie / credentialName `__vercel_session`). **No `document.cookie` writes or Authorization Bearer
  literals in the app bundles** — cookies are httpOnly/browser-managed; chat calls are same-origin. Exact live
  cookie set + OAuth redirect chain **to-verify on capture**.
- Requests commonly carry a `scope` argument (team/project scope slug — `(0,D.y)()`), and some endpoints
  require `scope-reauth/:scope`. Frame previews are gated by the `/chat/api/chat/frame-token` session token.
- Anti-automation: no client-side challenge at the static layer; expect server-side abuse gating
  (rate-limit/plan checks, possibly OAuth re-auth on scopes).

## 10. Verified vs to-verify split

**Verified (static, from bundles/SSR):** `v0.dev → v0.app` redirect; `/chat/api/chat` POST (Accept
text/event-stream, NDJSON body parse + reducer + message/error/complete wrapper events); resume/ping/latest
endpoints; `chatId/messageId/chatContent{Mdx}/modelConfiguration{modelId:"v0-max", imageGenerations}/
permissionsMode/attachments/sandbox/userMessageType` body field names + `x-v0-user-message-id` response
header; model id union + gateway/image-model endpoints + reasoning enum + `imageGenerations`/"up to 5 images";
deploy/publish SSE object schemas; the full §5–§8 endpoint literals; `/api/auth/login?next=` + GitHub branding;
frame-token/leaf/download preview plumbing; `__vercel_session` (from provider-catalog.cfg, not the bundles).

**To verify on first live (headed) capture** (no browser allowed this run):
1. Live DOM selectors: ProseMirror composer (`.ProseMirror[contenteditable="true"]`), message rows
   (`[data-testid="message"]`, `role="listitem"`, `data-message-content`), `data-slot="new-chat-button"`,
   `data-testid="prompt-form-send-button"` — all bundle-derived, **unverified**.
2. The NDJSON **per-line event schema** (reducer internals in an un-downloaded chunk; only wrapper types known).
3. Exact cookie set after login (httpOnly; names to record from a live session) and the OAuth redirect chain.
4. Whether AI-artifact previews are visible/readable in an automated capture (`frame-token` + sandbox host;
   artifact capability stays **to-verify** until confirmed).
5. Chat/history and `agent-workspace` live request/response shapes.
6. Enter-to-send confirmations on the real composer (keydown handler verified in bundle; behavior to-verify).

## 11. Bot-wall outcome

- **No bot wall hit.** Plain curl with a Chrome UA returned HTTP 200 full SSR at both `https://v0.dev`
  (redirect) and `https://v0.app`; all downloaded bundles served 200. No `cf_chl*`/challenge-platform
  (Cloudflare) and no "Vercel Security"/verification interstitial markers in any payload.
- Expect *server-side* abuse gating (rate-limit + plan checks, scope re-auth) once headless-automation
  signals appear; nothing client-side blocked static probing.

## 12. Suggested ui2api capability list (id, one-line description)

| id | status | description |
|----|--------|-------------|
| `v0_chat` | wire-verified | Composer send → `POST /chat/api/chat` NDJSON stream; resume/ping/latest; modelConfiguration (`v0-max` default, imageGenerations, thinking, reasoning). |
| `v0_chat_history` | endpoint-verified | Chat list/favorites/latest: `/chat/api/history`, `/chat/api/favorites`, `/chat/api/chat/latest`, `/api/v2/chats/:chatId`. |
| `v0_agent_workspace` | endpoint-verified | Build sandbox VM: `/chat/api/vm/*`, `/api/v2/internal/chats/:chatId/agent-workspace/*`, `[ws-console]` WebSocket logs. |
| `v0_artifact_preview` | **to-verify** | Generated preview frames: `/chat/api/chat/frame-token`, `/chat/api/chat/leaf`, sandbox host; visibility needs a live capture. |
| `v0_deployments` | wire-verified | Publish/deploy streams (`publish.progress|result`, `deployment.progress|log|created`, `error` objects) via `/api/v2/internal/deployments/` + `/publish`. |
| `v0_image_generation` | field-verified | `imageGenerations`/`imageGeneration:{modelId}` request fields + `/api/v2/internal/image-models` catalog. |
| `v0_voice_input` | endpoint-verified | Audio→text via `POST /api/chat/transcribe`. |
| `v0_integrations_mcp` | endpoint-verified | OAuth connectors + MCP: `/api/chat/integrations/*`, `/api/v2/mcp-servers`. |
| `v0_git_sync` | endpoint-verified | GitHub link/branch/repo: `/chat/api/git/*`, `/api/v2/internal/github/:namespace/:repo`, repository-link reset. |

(Not exposed: billing/credit purchases, teams admin, ai-gateway-key minting, VM admin shell —
sensitive admin/paid surfaces; endpoints are listed above if a future capability needs them.)