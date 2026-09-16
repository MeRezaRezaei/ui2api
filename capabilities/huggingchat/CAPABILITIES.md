# HuggingChat capabilities (from JS bundle analysis, 2026-09-16)

Site: **HuggingChat** — https://huggingface.co/chat (`huggingface.co/chat`, PUBLIC_VERSION **0.20.0**, commit `5f34e1f`).
Stack: **SvelteKit** (NOT Next.js), client-side rendered, app base `/chat` (`globalThis.__sveltekit_16puixl.base ?? "/chat"`).
Internal LLM router brand: `omni` (`PUBLIC_LLM_ROUTER_DISPLAY_NAME:"Omni"`, `PUBLIC_LLM_ROUTER_ALIAS_ID:"omni"`).

Not bot-walled: plain `curl` with a Chrome UA returned HTTP 200 and full real bundles. Every literal below was extracted
from the shipped JS/SSR payloads (no login, no browser, no execution).

Bundles analyzed (all fetched read-only via curl, ~0.8 MB total):
- `chat.html` (157 KB SSR shell: routes, `__sveltekit_16puixl`, `data-sveltekit-fetched` server-route payloads, `PUBLIC_*` env)
- `entry/app.D9jpR_uN.js` (10 KB — route dictionary: `/`, `/conversation/[id]`, `/models[/...model]`, `/r/[id]`, `/settings/(nav)/...`, `/privacy`)
- `chunks/DVITWop-.js` (16 KB — **API client factory**; derives every `/chat/api/v2/...` resource path)
- `chunks/D7aK-xnk.js` (42 KB — SvelteKit core; `M = base = "/chat"`)
- `chunks/D_6jIJz0.js` (417 KB — **chat wire**: `Qw` send, `vp`/`pp` stream codec, `Ar`/`Pa` event+status enums, message rendering, share, settings)
- `nodes/4.BaBAhJuN.js` (4 KB — `/` home; `POST /chat/conversation` new-chat)
- `nodes/5.Bktonmdl.js` (17 KB — `/conversation/[id]`; send loop, `EventSource` resume, `stop-generating`, `import-share`)
- `chunks/CZhNzXSe.js` (1.2 KB — settings store; debounced `POST /chat/settings`)
- `nodes/11.CeQVCVwh.js` (46 KB — `/models/[...model]`; `GET /chat/api/v2/models/{id}`)
- `nodes/12.CGn3Zabo.js` (14 KB — settings; `DELETE /chat/api/v2/conversations`)
- `chunks/DrANvt4t.js`, `Cqp9UCSu.js`, `BQRg9O0R.js`, `nodes/2|3`, `CzhNzXSe` misc UI/service chunks

## 1. Chat wire — FULLY PINNED (this is the deep-dive site)

There are **two parallel API surfaces**. The chat flow itself uses the legacy non-versioned routes
relative to `https://huggingface.co/chat`; management/loads use the `/chat/api/v2` REST surface.

### 1.1 Create conversation
`POST https://huggingface.co/chat/conversation` (JSON body, `Content-Type: application/json`)
```json
{ "model": "omni", "preprompt": "", "mlAssistant": false }
```
- `model` = any id from the models catalog (defaults to `settings.activeModel`, fallback to first listed model); `mlAssistant` toggles ML-intern mode (uses `mlAssistantModels[0]`).
- Response: `{ "conversationId": "<uuid>", "conversation": <conversation> }` → client navigates to `/conversation/{id}`.
- This is how a "New chat" fires from the home page: **new-chat does not need the sidebar button** — typing on `/` auto-creates.
- Verified in `nodes/4.BaBAhJuN.js` (`fetch(\`${base}/conversation\`, {method:"POST", ...body:JSON.stringify({model, preprompt, mlAssistant})})`).

### 1.2 Send message (the streaming call)
`POST https://huggingface.co/chat/conversation/{conversationId}` — **multipart/form-data** (browser `fetch` + `FormData`; the client sets *no* Content-Type header manually):
- field `files` (repeated): `new File([blob], "<mime>;<filename>", {type: "<mime>"})`
- field `data`: JSON string
```json
{
  "inputs": "<prompt text>",
  "id": "<parent message uuid (uuid v4)>",
  "is_retry": false,
  "is_continue": false,
  "generationId": "<client uuid v4>",
  "selectedMcpServerNames": ["Web Search (Exa)"],
  "selectedMcpServers": [{ "name": "...", "url": "...", "headers": { } }],
  "timezone": "Europe/London",
  "resumeElicitationId": "<uuid>?"   // only when resuming an elicitation turn
}
```
- Response is an **HTTP 200 streaming body**: chunked `ReadableStream` → `TextDecoderStream` → UTF-8 text, split on `\n` (`pp()`), where **every complete line is one standalone JSON event** (NDJSON, not SSE, not protobuf). Truncated trailing line is buffered and re-parsed on the next chunk.
- Error responses are JSON `{ "message": "..." }` (thrown as Error(message)). `402` = out of credits; `401` + `/oauth authorization|has been revoked|requested scopes/` → login; `429` = rate limited.
- `streamingMode` (`"smooth"` / `"raw"`) is **client-side rendering only** (`yp()` token-rate smoothing with `minDelayMs:5,maxDelayMs:80,minRateCharsPerMs:.3,maxBufferedMs:400`) — the wire is identical either way.
- Verified in `chunks/D_6jIJz0.js` — `async function Qw(a,e,r){... new FormData ... JSON.stringify({inputs,id,is_retry,resumeElicitationId,is_continue,generationId,selectedMcpServerNames,selectedMcpServers,timezone}) ... fetch(\`${e.base}/conversation/${a}\`,{method:"POST",body:i,signal}) ... return gp(vp(l,n),streamingMode??"smooth")}`
  and `function pp(a){const e=a.split("\n"),r=[];for(const n of e)try{r.push(JSON.parse(n))}catch(i){if(i instanceof SyntaxError)return{messageUpdates:r,remainingText:e.at(-1)??""}}return{messageUpdates:r,remainingText:""}}`.

### 1.3 Stream events (single union, field `type`)
Enum `Ar` (verified `chunks/D_6jIJz0.js`): `status | title | tool | stream | file | finalAnswer | reasoning | routerMetadata | elicitation | plan | budget | turnState`.

| type | fields (verified) | role |
|---|---|---|
| `stream` | `token` (text delta), optional `len`; client strips `\0` chars | the actual answer text, chunked |
| `finalAnswer` | `text` (final text; may arrive pre-truncated), `interrupted?: boolean` | end-of-answer anchor; client reconciles partial streams |
| `status` | `status`: `started \| error \| finished \| keepAlive` (enum `Pa`); error adds `message`, `statusCode` | lifecycle + heartbeat (`keepAlive`) omitted from render |
| `title` | `title` | auto conversation title |
| `routerMetadata` | `route`, `model` | which omni-router route/model answered |
| `file` | `sha`, `mime`, `name` | generated/attached file (rendered from `{id}/message/{mid}/output/{value}`) |
| `tool` | tool progress (sub-statuses `call|result|error|eta|progress`) | search/tool-call cards |
| `reasoning` | reasoning blocks | thinking display |
| `plan` | `steps` | artifact/agentic plan panel |
| `budget` | `totalMicroUsd`, `spentMicroUsd`, `reservedMicroUsd` | Pro billing meter |
| `turnState` | `serverNow` | server clock (turn accounting) |
| `elicitation` | elicitation state (opened/resolved) | interactive elicitation turns |

Terminal condition for a normal turn: a `status: finished` (or `finalAnswer`). No `end` marker in the NDJSON path.

### 1.4 Resume / continue a materialized stream
`GET https://huggingface.co/chat/conversation/{id}/stream?messageId={mid}&fromSeq={materializedSeq}` via browser **`EventSource`**:
- event `update` → `JSON.parse(e.data)` — one event-object per event (same union as §1.3);
- event `end` → close (terminal) — this is the SSE resume path used on page reload / history replay (`p()` in `nodes/5.Bktonmdl.js`).
- `fromSeq` = the message's `materializedSeq` watermark.

### 1.5 Stop generation
`POST https://huggingface.co/chat/conversation/{id}/stop-generating` — JSON body optional `{ "generationId": "<uuid>", "seenContentLength": <n> }`.
Client retries at 0 / 300 / 1000 / 3000 ms. (Verified `nodes/5.Bktonmdl.js`.)

### 1.6 Public share
`POST https://huggingface.co/chat/conversation/{id}/share` (no body) → `{ "shareId": "<7-char>" }`; public link = `https://huggingface.co/chat/r/{shareId}`.
If the conversation id itself is already 7 chars, it's used directly as the share id. Import: `POST /chat/api/v2/conversations/import-share {shareId}` → `{conversationId}`. (Verified `chunks/D_6jIJz0.js` + `nodes/5.Bktonmdl.js`.)

### 1.7 Message graph model
Returned by the conversation GET (and tracked client-side with uuid-v4 + `ancestors[]`/`children[]` sibling trees): every message is
`{ id: uuid, from: "user"|"assistant", content: string, files?: [{type:"hash"|"base64"|"url", value, mime, name}], ancestors: string[], children?: string[], generationId?, materializedSeq?, interrupted?, elicitationId?, routerMetadata?: {route, model} }`,
plus conversation-level `rootMessageId`, `title`, `model`, `preprompt`, `turnState.serverNow`. "Regenerate"/edit = sibling insert under the parent. Legacy conversations (no `rootMessageId`) can only append.

## 2. v2 REST management surface (base `https://huggingface.co/chat/api/v2`)

Derived verbatim from the client factory in `chunks/DVITWop-.js` (`d(r,path)` → `{get({query}), post(body), patch(body), delete()}`) and confirmed by the SSR `data-sveltekit-fetched` route payloads:

| method+path | purpose | evidence |
|---|---|---|
| `GET/POST/PATCH/DELETE /chat/api/v2/conversations` | list (`?p={page}` → `{conversations[], hasMore}`), create, rename?, **delete-all** | `De()` factory; `nodes/12`: `confirm("Are you sure you want to delete all conversations?")&&q.conversations.delete()` |
| `GET/PATCH/DELETE /chat/api/v2/conversations/{id}` | detail (query `fromShare`), PATCH (e.g. `{mlBudgetTotalUsd}`), delete | factory; `D_6jIJz0`: `conversations({id}).patch({mlBudgetTotalUsd:B})` |
| `GET/PATCH/DELETE /chat/api/v2/conversations/{id}/message/{messageId}` | per-message ops | factory |
| `POST /chat/api/v2/conversations/import-share` | `{shareId}` → `{conversationId}` | `nodes/5` share-consumption redirect |
| `GET/POST /chat/api/v2/models` | catalog list (140 models, live payload — §4) | SSR payload; factory |
| `GET /chat/api/v2/models/{id}` | model detail page | `nodes/11`: `C.models({id}).get()` |
| `GET /chat/api/v2/models/old` | legacy/renamed model aliases | factory |
| `GET /chat/api/v2/public-config` | env/config (PUBLIC_*) | SSR payload (`data-ttl="60"`) |
| `GET /chat/api/v2/feature-flags` | §5 | SSR payload |
| `GET /chat/api/v2/user` `?` `GET/POST` → `{}`/`null` | session user | SSR payload returned `{"json":null}` anonymous |
| `GET/POST /chat/api/v2/user/settings` (also `.../reports`, `.../billing-orgs`) | settings CRUD | SSR payload (settings shape §6) |
| `POST /chat/api/v2/export` | full export | factory |
| `POST /chat/api/v2/spaces/deploy` | `{conversationId, artifactIdentifier, title, kind, content, visibility}` → Space | `D_6jIJz0` `gv()` (deploy-to-Space dialog; `{repoId,url}` on success) |
| `GET /chat/api/v2/debug/config` | debug conf | factory |
| `GET /chat/api/mcp/servers` | base MCP servers (see §7) | SSR payload |

### 2.1 Settings upsert (separate route, NOT under /api/v2)
`POST https://huggingface.co/chat/settings` — full settings JSON body (same shape as §6), 300 ms debounced auto-save. (Verified `chunks/CZhNzXSe.js`: `fetch(\`${base}/settings\`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(settings)})`.)

## 3. Model selection / picker
- Model picker is a client store (`settings.activeModel`), applied at conversation-create time (`POST /chat/conversation` body `model`), echoed back by the server in `routerMetadata` stream events (`route`, `model`).
- Per-model page (`GET /chat/api/v2/models/{id}`) exposes description, `supportsTools`, `supportsReasoning`, `supportsArtifacts`, `promptExamples`, system-prompt UI (`aria-label="Custom system prompt"`), tool toggles (`toolsOverrides`), artifacts, reasoning-effort, provider overrides.
- No dedicated "ListModels" RPC — the catalog IS `GET /chat/api/v2/models`.
- "Assistants" feature exists in code (feature-flag `enableAssistants`, MCP-selected assistants) but the production `/chat/api/v2/feature-flags` returns `enableAssistants:false`.

## 4. Model catalog (live from `GET /chat/api/v2/models`, 2026-09-16)
`omni` (router, default, `isRouter:true`) + **140** community models. Flags per model (seen live): `multimodal` (+ `multimodalAcceptedMimetypes`, e.g. `["image/*"]`), `supportsTools`, `supportsReasoning`, `supportsArtifacts`, `unlisted`, `hasInferenceAPI`. Highlights:
- Reasoning+artifacts+multimodal: `deepseek-ai/DeepSeek-V4.1-Flash`, `moonshotai/Kimi-K3`, `zai-org/GLM-5.3-Flash`, `thinkingmachines/Inkling`, `MiniMaxAI/MiniMax-M3`, `stepfun-ai/Step-3.7-Flash`, `tencent/Hy3`, `Qwen/Qwen3.6-35B-A3B`, `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4`, `zai-org/GLM-5.2`, `deepseek-ai/DeepSeek-V4-Pro-0813`.
- Classic: `meta-llama/Llama-3.3-70B-Instruct`, `meta-llama/Llama-3.1-8B-Instruct`, `Qwen/Qwen3-32B`, `google/gemma-3-27b-it`, `deepseek-ai/DeepSeek-R1`.
- Reasoning-only (no tools): `deepseek-ai/DeepSeek-R1`, `Qwen/Qwen3-4B-Thinking-2507`.
Model object fields: `id, name, websiteUrl, modelUrl, datasetName, datasetUrl, displayName, description, logoUrl, promptExamples, preprompt, multimodal, multimodalAcceptedMimetypes, supportsTools, supportsReasoning, supportsArtifacts, unlisted, hasInferenceAPI, isRouter`.

## 5. Feature flags
`GET /chat/api/v2/feature-flags` → `{ enableAssistants:false, loginEnabled:true, isAdmin:false, transcriptionEnabled:true, taskModelId:"meta-llama/Llama-3.1-8B-Instruct", mlAssistantModels:[GLM-5.3-Flash, Kimi-K3, GLM-5.3, DeepSeek-V4-Pro-0813, DeepSeek-V4-Flash-0731] }`.
- `transcriptionEnabled` → voice input (composer `button[aria-label="Start voice recording"]`).
- `mlAssistantModels` → ML-intern/assistant persona models (5).

## 6. User settings shape (`GET /chat/api/v2/user/settings`, live payload)
```json
{ "welcomeModalSeen": false, "welcomeModalSeenAt": null, "mlInternOnboardingSeen": false,
  "activeModel": "omni", "streamingMode": "smooth", "directPaste": false, "hapticsEnabled": true,
  "hidePromptExamples": {}, "shareConversationsWithModelAuthors": true,
  "customPrompts": {}, "customPromptsEnabled": {},
  "multimodalOverrides": {}, "toolsOverrides": {}, "artifactsOverrides": {}, "providerOverrides": {},
  "reasoningEffortOverrides": {}, "reasoningOverrides": {},
  "billingOrganization": null, "billingResourceGroup": null }
```
Upsert via `POST /chat/settings` (§2.1). `streamingMode` toggles `smooth`/`raw` client rendering.

## 7. MCP servers
`GET /chat/api/mcp/servers` (live) → two base servers: `Web Search (Exa)` (`https://mcp.exa.ai/mcp?tools=web_search_exa,get_code_context_exa,crawling_exa`) and `Hugging Face` (`https://hf.co/mcp?login`). Enabled server names/descriptors are attached to every send (§1.2 `selectedMcpServerNames`/`selectedMcpServers`); discovery UI routes users to `huggingface.co/settings/mcp`. Per-model tool toggles write `toolsOverrides` into settings.

## 8. Auth & session facts for automation
- **Cookie-based same-origin** auth. The client sends NO `Authorization`/bearer/CSRF header anywhere in the chat flow (plain same-origin `fetch`, cookies implicit). No `hf-chat` cookie literal appears in the client bundles (server-set) — cookie set is **unverified statically**; recommend capturing a session snapshot on first live login and recording the set.
- Anonymous mode works: `GET /chat/api/v2/user` returned `{"json":null}`; 140 models + full chat flow are reachable signed-out (loginRequired acceptable as `false`, mirroring the builtin profile).
- Login flow: `https://huggingface.co/login?next=<encoded path>` (OAuth). Client redirects on 401 only for messages matching `/oauth authorization|has been revoked|requested scopes/`.
- Errors mapped by code: `402` → credits (billing upsell `huggingface.co/settings/billing?add-credits=true`), `429` → rate limit, message containing `"overloaded"` → "Too much traffic".
- No rate requests observed during static probing; expect normal HF anti-abuse only after sustained automation.

## 9. DOM facts relevant to the ui2api profile
Verified markup (static templates in bundles; not yet confirmed live):
- Composer: `<textarea rows="1" tabindex="0" inputmode="text" autocomplete="off" role="combobox" aria-autocomplete="list">` (v0.20 has **no placeholder**, unlike the builtin profile's `placeholder*='Ask'`).
- Send: `<button type="submit" aria-label="Send message" name="submit">` inside a `<form>` — Enter-to-submit works.
- Answer container: `[aria-label="Conversation messages"]` (scoped class `svelte-11kuu6h`, holds `.prose.prose-sm` assistant blocks); user bubble `class="... rounded-2xl border border-gray-100 ... prose-pre:my-2"`.
- Voice: `button[aria-label="Start voice recording"]`; share: `button[aria-label="Share conversation"]`.
- Builtin selectors `.ChatInput textarea`, `.message.overflow-y-auto`, `[data-testid="message"]`, `.chat-container .message` do **not** appear in the v0.20 bundles → flagged unverified in profile.json, with the grounded v0.20 selectors appended.

## 10. Suggested capabilities for ui2api
1. `huggingchat_chat` — Create conversation (`POST /chat/conversation`) or type on `/`, send via multipart `POST /chat/conversation/{id}`, read NDJSON stream (`status|stream|finalAnswer|routerMetadata|...`), stop via `/stop-generating`; resume via `EventSource` `/stream?messageId&fromSeq`.
2. `huggingchat_conversations` — List `/chat/api/v2/conversations?p=`, detail/delete one, delete-all, `import-share`; per-message GET/PATCH/DELETE.
3. `huggingchat_models` — Catalog + detail via `/chat/api/v2/models[/{id}]`, model flags, set `activeModel` via `/chat/settings` + `POST /chat/conversation model`.
4. `huggingchat_settings` — Read `/chat/api/v2/user/settings`, upsert `POST /chat/settings` (streamingMode, customPrompts, tools/artifacts/reasoning/provider overrides).
5. `huggingchat_mcp` — Read `/chat/api/mcp/servers`, attach `selectedMcpServers` (Exa / HF) to the send body.
6. `huggingchat_share` — `POST /chat/conversation/{id}/share` → `/r/{shareId}` link.