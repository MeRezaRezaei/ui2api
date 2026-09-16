# DuckDuckGo AI Chat capabilities (from JS bundle analysis, 2026-09-16)

Analyzed statically (curl only, Chrome UA, no browser launched), 3 JS bundles (~4.3 MB) from
`https://duck.ai/chat` (the final host after `duckduckgo.com/?ia=chat` and `/aichat` both
302→`https://duck.ai/chat`). App shell is a React SPA; page version `serp_20260915_052329_ET`,
SHA `af41a90799e2d64643c19a933f25b799c589b2df`. **No bot wall on static fetch (200, full
app shell + all bundles served normally from duck.ai).**

**ANONYMOUS CAPABLE:** page meta says "Free. No account required." The chat works without
login. DDG account (`internal_duckchat_user` cookie) is optional and only enables chat history
sync. The `duckai` cookie from the provider-catalog entry (`duckduckgo-web`) is NOT required
for anonymous chat.

## 1. Chat core (models, streaming)

- Send endpoint: **`POST /duckchat/v1/chat`**; `Content-Type: application/json`,
  `accept: text/event-stream` (SSE). Verified from bundle literal:
  `` `${DUCKCHAT_API}/chat` `` where `DUCKCHAT_API="/duckchat/v1"``.
- Status/preflight endpoint: **`GET /duckchat/v1/status`** (returns usage limits, service
  config; response headers carry the VQD token for the next chat request). Sent with header
  `x-vqd-accept: "1"` + `Cache-Control: no-store`.
- Capabilities endpoint: **`GET /duckchat/v1/capabilities`** (pre-flight fetch, 3s timeout,
  sets auth headers for subsequent requests). Returns auth/feature config.
- Streaming: **SSE, `text/event-stream`**. Stream frames are either:
  - Marker lines: `[PING]` (heartbeat), `[DONE]` (stream complete),
    `[CHAT_TITLE:<title>]` (auto-generated chat title),
    `[FIXED_COST_WINDOW_USAGE:<encoded>]` (quota metering),
    `[STOP_REASON:<word>]` (e.g. `max_tokens`), `[LIMIT_ACCOUNT]`,
    `[LIMIT_ENTITY]`, `[LIMIT_CONVERSATION]`, `[LIMIT_IMAGE_GENERATIONS]`,
    `[WARN_CONVERSATION_LIMIT:<n>]`, `[SUMMARY_REFRESH_HINT:<json>]`,
    `[SUMMARY_INVALID]`, `[ADS:<json>]` (window ID update).
  - JSON frames: `JSON.parse(frame)` → `{action:"success", role, ...}` for message content;
    `{action:"error", type, status, overrideCode, r, challengeData, ...}` for errors.
    The `role` field distinguishes `"assistant"` (text content), `"partial-image"` (image gen).
- Request body fields (bundle-verified): `model` (string, e.g. `"gpt-4o"`),
  `metadata` (`{toolChoice: {WebSearch: bool, GenerateImage: bool}, customization: {...}}`),
  `messages` (array of `{role:"user"|"assistant", content: [{type:"text",text}|{type:"image",mimeType,image}|{type:"file",content,encoding,mimeType,filename,url?,title?,source?}], windowID?}`),
  `canUseTools`, `reasoningEffort`, `canUseApproxLocation`, `canDelegateImageGeneration`,
  `canUseWebSearch`, `canUploadFiles`, `canShowGreeting`, `durableStream`, `summary`.
- Headers on chat POST: `Content-Type: application/json`, `accept: text/event-stream`,
  `x-fe-version: ${__DDG_BE_VERSION__}-${__DDG_FE_CHAT_HASH__}` (runtime-injected),
  `x-fe-signals: <fraud-signals-string>`, VQD token header (module-internal name),
  optional `x-journey-id` (analytics).
- Model names present as literals (embedded in bundle, NOT fetched from an endpoint):
  `gpt-4o`, `gpt-4.1`, `gpt-4.5`, `gpt-5`, `gpt-5.1`, `gpt-5.2`, `gpt-5.4`, `gpt-5.6`,
  `o3-mini`, `o4-mini`,
  `claude-3-haiku-20240307`, `claude-3-5-haiku-latest`, `claude-haiku`, `claude-haiku-4-5`,
  `claude-3-7-sonnet-latest`, `claude-sonnet-4`, `claude-sonnet-4-5`, `claude-sonnet-4-6`,
  `claude-opus-4`, `claude-opus-4-5`, `claude-opus-4-6`, `claude-opus-4-6-thinking`,
  `claude-opus-4-7`, `claude-opus-4-8`,
  `Llama-3.1-70B-Instruct-Turbo`, `Llama-3.3-70B-Instruct-Turbo`,
  `Llama-4-Maverick-17B-128E-Instruct-FP8`, `Llama-4-Scout-17B-16E-Instruct`,
  `Mistral-Small-24B-Instruct-2501`, `Mistral-Small-3`, `mistral-small-2603`,
  `Mixtral-8x7B-Instruct-v0.1`, `kimi-k2-5`.
  Internal-only (DDG employee tier): `claude-sonnet-4-internal`,
  `Llama-4-Maverick-internal`, `gpt-realtime`, `gpt-realtime-2.1-mini`, `gpt-oss`.
  `voice-mode` (realtime voice chat model).

## 2. Web search / tools

- In-chat web search: toggled per message via `metadata.toolChoice.WebSearch: true`.
  UI toggle in the composer toolbar (`DUCKCHAT_TOOLS_WEB_SEARCH_LABEL` i18n).
  When enabled, the backend performs search and injects results into context.
  The answer includes inline citations rendered as source chips.
- Image generation: `metadata.toolChoice.GenerateImage: true` — delegated to backend.
- File/image upload: multipart via composer attach button; base64-encoded in the request body
  (`{type:"image", mimeType, image: dataUrl}`, `{type:"file", content: base64, encoding:"base64"}`).
- Page context: browser extension / Electron integration can attach page content
  (`source:"page-context"` on file parts).

## 3. Reasoning modes

- Three modes visible in i18n: `fast`, `reasoning`, `extended`.
  `reasoningEffort` field in request body controls mode.
  Extended reasoning (`extendedThinking` / `usedExtendedReasoning` flag) is for models that
  support it (Claude opus/sonnet, etc.).

## 4. Chat history / accounts

- Chat history stored locally in IndexedDB (anonymous, device-local).
  DDG account sync (optional) uses `/duckchat/v1/auth/authorize` → `/duckchat/v1/auth/token`
  → `internal_duckchat_user` cookie. Sync is end-to-end encrypted.
- `AIChatHistoryEnabled`, `AIChatSync` feature flags control sync UI.
- Sharing: `/duckai/sharing-chats-in-duckai/` — share links with optional expiry.
- Models tier system: Free / Plus / Pro (DDG subscription), controlling model access
  and usage limits (6-hour, daily, weekly, monthly windows).

## 5. Anti-bot / abuse protection

- `AIChatAnomalyDetectionChallengeView` — anomaly challenge UI, triggered by `ERR_CHALLENGE`
  error type with `challengeData` payload.
- `X-Vqd-Hash-1` / `Vqd-Hash-1` — canvas fingerprinting PoW: `toDataURL()` → `atob()` →
  WebCrypto SHA-256 hash. Computed client-side and sent back to server.
- `x-fe-signals` — browser fingerprint/fraud signals sent with every request.
- No Cloudflare challenge on static page loads; no JSD wall. Chat POST may return
  `ERR_CHALLENGE` when abuse signals are detected.

## 6. Auth & session facts for automation

- **Anonymous:** no auth required for chat. The VQD token is obtained from `GET /duckchat/v1/status`
  (response header) and carried into the chat POST. Token refreshes on each chat response.
  The `x-vqd-accept: "1"` header initiates the VQD flow on the status endpoint.
- **DDG account (optional):** cookie `internal_duckchat_user` (set via `/duckchat/v1/auth/*`
  flow). Enables chat history sync across devices. Auth flow: `/duckchat/v1/auth/authorize` →
  `/duckchat/v1/auth/token?grant_type=refresh_token` → cookie set.
- provider-catalog entry: `duckduckgo-web` kind **cookie** (`duckai`) — this catalog entry
  predates the `duck.ai` rebrand; the current cookie name for DDG account auth is
  `internal_duckchat_user` (or `duckchat_user`). For anonymous-only use, NO cookie is needed.
- VQD token lifecycle: status response sets a header → client stores it → includes in chat POST
  headers → chat response sets a new VQD in response headers → client updates for next request.
  Exact header name: module-internal export (`f.TY`), historically `x-vqd-4` in DDG codebase.

## 7. Verified vs to-verify split

**Verified (static, from bundles/SSR):** endpoint paths `/duckchat/v1/{chat,status,capabilities,
usage,summarize}`; SSE transport + all marker-frame literal names; request-body field layout;
model-name literals; VQD token flow (status→chat header); auth endpoints for DDG account;
`x-fe-version`/`x-fe-signals` headers; `X-Vqd-Hash-1` challenge mechanism; error type
enum; anonymous usage (no login required); app shell served without bot wall.

**To verify on first live (headed) capture** (no browser launched):
1. Exact VQD response header name (the `x-vqd-4` / `f.TY` mapping) — confirmed to exist
   but the literal header name is obfuscated behind module exports.
2. `__DDG_BE_VERSION__` and `__DDG_FE_CHAT_HASH__` — runtime-injected values not in the
   static HTML; their source (likely a bootstrap data endpoint or server-set window variable).
3. JSON frame `role` field values for assistant text content (the `action:"success"` path
   processes `role` strings but the exact text-role literal is composed dynamically).
4. DOM selectors for the composer input, send button, answer container, model picker,
   and chat history sidebar.
5. The VQD challenge flow (`ERR_CHALLENGE` + `challengeData` → `AIChatAnomalyDetectionChallengeView`
   → canvas hash solve → retry) — when exactly it triggers.

## 8. Bot-wall outcome

- **No bot wall hit** on static fetch: `duckduckgo.com/?ia=chat` 302→`duck.ai/chat` (200,
  26 KB app shell, 4 JS bundles served normally; no `cf-chl-*`, no Cloudflare interstitial,
  no JS-detection wall). ETag `6aa91e96-66aa`, `Cache-Control: no-cache, no-store`.
- Expect the `ERR_CHALLENGE` / `AIChatAnomalyDetectionChallengeView` to trigger on chat POST
  abuse signals; the VQD-hashing mechanism is client-side and may fail if the browser doesn't
  expose canvas or WebCrypto APIs (headless Chromium should be fine).

## 9. Suggested ui2api capability list (id, one-line description)

| id | description |
|----|-------------|
| `duckduckgo_chat` | Composer send + SSE-streamed answer via `POST /duckchat/v1/chat` (UI-path driver). |
| `duckduckgo_model_picker` | Read available models from the embedded model config (static bundle list, no endpoint). |
| `duckduckgo_web_search` | Toggle `metadata.toolChoice.WebSearch` → grounded answer with inline citations. |
| `duckduckgo_image_generate` | Toggle `metadata.toolChoice.GenerateImage` → AI image generation via backend. |
| `duckduckgo_file_upload` | Attach files/images as base64 in the messages payload (PDF, images, documents). |
| `duckduckgo_reasoning` | Set `reasoningEffort` to fast/reasoning/extended for supported models. |
| `duckduckgo_chat_history` | Read/write recent chats from IndexedDB local storage (anonymous) or DDG account sync. |
