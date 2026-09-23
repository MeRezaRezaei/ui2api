# DuckDuckGo AI Chat capabilities (from JS bundle analysis, 2026-09-16)

## STATUS (fold #20 / GOAL 15, 2026-09-23): **ANONYMOUS — FULL SURFACE VERIFIED live**

**ALL SIX capabilities** (`chat`, `model_picker`, `web_search`, `file_upload`,
`reasoning`, `chat_history`) are **VERIFIED** via live round-trips through the real
`DuckduckgoCapabilities` runner (headed Xvfb, `ALL_OK=true` probe):

- `duckduckgo_chat` — VERIFIED 2026-09-22 (see below).
- `duckduckgo_model_picker` — composer model chip opens `[role='menu'][aria-label='Choose a model']`; rows `[role='menuitemradio']` with `data-testid="model-picker-row-<id>"`, `aria-checked="true"` on active. Live: 6 rows read (GPT-5.6 Luna selected; GPT-5.4 mini, Claude Haiku 4.5, Mistral Small 4, gpt-oss 120B, Gemma 4 31B BETA).
- `duckduckgo_web_search` — composer `Tools` button → "Web Search" row; enabled state read back from composer chip `button[aria-label='Remove Web Search']`. Live: enable→chip present / disable→absent; a chat after enable carried a REAL WebSearch tool-invocation with 5 citations stored in `saved-chats`.
- `duckduckgo_file_upload` — attach `button[aria-label='Add images or PDFs']` wraps hidden `input[type='file']` (`accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.pdf"`); `setInputFiles` → chip `button[aria-label^='Remove image ']` read-back. Live: 1x1 PNG → chip "Remove image 1".
- `duckduckgo_reasoning` — `button[aria-label='Reasoning mode']` (text Fast/Reasoning) → popover `[role='menuitemradio']` rows. Live: selection flips button text. "extended" NOT offered on free GPT-5.6 Luna composer (measured limit → honest ok:false; never fabricated).
- `duckduckgo_chat_history` — real IndexedDB read (`savedAIChatData`: saved-chats / pre-canonical-chats keyed by chatId `{title, model, messages[], reasoningMode, lastEdit, pinned}`) + sidebar corroboration (`input[aria-label='Search chats']`, per-row `button[aria-label='Delete Chat']`). Live: sendProbe "Abilities list" row matches IDB + sidebar; internal `__metadata__` sentinel filtered.

Chat VERIFIED 2026-09-22 (headed, Xvfb): composer `textarea` + Enter → first-send
consent wall ("By clicking 'Continue' you agree…") dismissed by clicking its Continue
button → composer re-focused → Enter again → the site's own JS runs
`GET /duckchat/v1/status` (VQD) + `POST /duckchat/v1/chat` (SSE, wire-observed **200**)
→ answer read off the page (`[id*="assistant-message"]`). Proof: prompt "say hi" →
answer "Hi", model chip "GPT-5.6 Luna". **This site NEVER login-gates** — anonymous
by design; the pre-GOAL-13 runner wrongly short-circuited the surface to
`loginGated:true` (a fabricated excuse), now fixed.

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

**Verified (live, headed Xvfb round-trip 2026-09-22 — GOAL 13):** the full anonymous chat
path through `src/capabilities/duckduckgo.ts`: composer `textarea` → first-Enter consent wall
("By clicking 'Continue' you agree…", button text "Continue") → Continue click → composer
re-focus → Enter → site JS drives `GET /duckchat/v1/status` + `POST /duckchat/v1/chat` (SSE,
HTTP 200) → answer renders at `[id*="assistant-message"]` (innerText =
`<model chip>\n\n<answer>[ \n\n2nd opinion]` — runner strips the chip + footer; chip reads
"Generating response"/"Stop generating" while streaming, settles to e.g. "GPT-5.6 Luna").
Proofs: "say hi"→"Hi" & "what is 2+2?"→"2 + 2 = 4", both ok:true ~7–9 s.

**Verified (live, headed Xvfb 2026-09-23 — GOAL 15, all six ok:true / ALL_OK=true):**
- `model_picker`: composer model chip (text "5.6 Luna", `w≈100 h≈32`, no aria-label; hidden after a chat → New Chat + retry once) → `[role='menu'][aria-label='Choose a model']`, rows `[role='menuitemradio']` `data-testid="model-picker-row-<id>"`, `aria-checked` on active, text `name\nnote`. Live read: 6 rows, GPT-5.6 Luna selected.
- `web_search`: composer `Tools` → popover row "Web Search / Source answers from the web" (`[role='menuitemradio']`); enabled read-back = composer chip `button[aria-label='Remove Web Search']`. Enable→chip, disable→no chip. A chat after enable carried a REAL `WebSearch` tool-invocation (5 citations) stored in `saved-chats`.
- `file_upload`: attach `button[aria-label='Add images or PDFs']` wraps hidden `input[type='file']`; `setInputFiles` (filechooser never fires) → chip `button[aria-label^='Remove image ']` / `'Remove file '` read-back. Live: 1×1 PNG → "Remove image 1".
- `reasoning`: `button[aria-label='Reasoning mode']` text Fast|Reasoning → popover `[role='menuitemradio']` "Reasoning / Takes longer to respond" and "Fast / Answers right away"; selection flips the button text (read-back). "extended" is NOT in the free GPT-5.6 Luna composer menu (measured) → runner returns honest ok:false, never fabricated.
- `chat_history`: genuine IndexedDB read via string-evaluated `page.evaluate` (guard against the swc `__name` bug — named arrows inside evaluate crash/hang; strings are never transformed). DB `savedAIChatData` (v6); stores saved-chats / pre-canonical-chats / chat-images / sync-credentials / sync-state; rows keyed by `chatId`. Sidebar corroboration: `input[aria-label='Search chats']` + per-row `button[aria-label='Delete Chat']`. Internal `__metadata__` row filtered. Empty anonymous context → count 0 (honest).

**Remaining honest gap:** headless mode surfaced a transient "Oops... Duck.ai is temporarily
unavailable… anonymous code 02f8" after the consent wall (abuse/anti-bot posture on headless
fingerprints) — the VERIFIED path is headed (Xvfb with `UI2API_HEADED=1`); headless chat stays
unverified, NOT a defect claim to paper over. `image_generate` remains wire-mapped from the
bundle only (not in the manifest / runner) — never claimed verified.

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
| `duckduckgo_chat` | Composer send + SSE-streamed answer via `POST /duckchat/v1/chat` (UI-path driver). **VERIFIED live 2026-09-22.** |
| `duckduckgo_model_picker` | Read available models from the real composer picker panel (chip → menu, `menuitemradio` rows, `aria-checked`). **VERIFIED live 2026-09-23.** |
| `duckduckgo_web_search` | Toggle `metadata.toolChoice.WebSearch` via composer Tools → Web Search row; chip read-back. **VERIFIED live 2026-09-23** (enable + disable). |
| `duckduckgo_file_upload` | Attach files/images via the composer's own file input (`setInputFiles`, accept-list enforced). **VERIFIED live 2026-09-23.** |
| `duckduckgo_reasoning` | Set reasoning effort fast/reasoning via the composer reasoning-mode toggle (button text flip). **VERIFIED live 2026-09-23.** Extended not offered on free models (honest ok:false). |
| `duckduckgo_chat_history` | Read anonymous chats from IndexedDB `savedAIChatData` + sidebar corroboration. **VERIFIED live 2026-09-23.** |
| `duckduckgo_image_generate` | Toggle `metadata.toolChoice.GenerateImage` → AI image generation via backend. Wire-mapped from bundle only — NOT in manifest/runner, never claimed verified. |
