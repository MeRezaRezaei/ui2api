# ChatGLM / Zhipu AI capabilities (from JS bundle analysis, 2026-09-16)

Analyzed statically (curl only, Chrome UA, no browser launched) across two hosts:
- **`https://chatglm.cn`** (zh, "智谱清言") — Vue/Vuex SPA, 5 JS bundles (~6.3 MB, main = 6.1 MB). Anthropic/Zhipu internal site.
- **`https://chat.z.ai`** (international, "Z.ai") — Vite/Svelte SPA (~3.2 MB entry + lazy chunks), based on Open WebUI-derived codebase.

`https://z.ai` redirects 301 → `https://chat.z.ai`. `https://chatglm.cn` serves the Chinese product directly. Both are separate codebases with distinct API surfaces. The page version for zh: `20260914183501-aa8fb894…`; for international: `prod-fe-1.1.95`. Both use Volcano Engine telemetry (collectEvent/GT).

## 1. Chat core (models, streaming)

### chatglm.cn (zh host)

- **Send endpoint (verified):** `POST /chatglm/backend-api/v1/stream_context?__requestid={uuid}`
  - The `_()` API function in the bundle: strips `__requestid` from the POST body and passes it as query param.
  - Request body is assembled by the Vuex conversation store. Fields `conversation_id`, `assistant_id`, model, message content — all assembled client-side (module 78114 area); exact field shape not fully decoded in static analysis.
  - Stop: `POST /chatglm/backend-api/v1/manualstop?__requestid={task_id}` — verified.
- **Streaming mechanism (verified as EventSource-style, to-verify exact format):** The app tracks an `isEventSourceaOpen` flag on the conversation message model. No `text/event-stream`, `EventSource`, or `application/x-ndjson` literal found in bundles — the response may be consumed via a custom reader on an axios response stream (axios `onDownloadProgress` pattern). Stream state mutations: `isEventSourceaOpen`, `printCompleted`, `isOnClose`, `isHeartbeat`, `manualStopStream`, `isRetry`.
  - **To-verify:** Whether the response is SSE (lines of `data: {json}\n\n`), NDJSON, or chunked JSON — first live capture will determine format.
- **Conversation CRUD (verified):**
  - `GET /chatglm/backend-api/v1/conversation/list?size=50&offset=0&type=default` — paginated list.
  - `GET /chatglm/backend-api/v1/conversation/{id}` — get one.
  - `DELETE /chatglm/backend-api/v1/conversation/delete/{id}` — delete.
  - `POST /chatglm/backend-api/v1/conversation` — create/update.
  - `POST /chatglm/backend-api/v1/conversation/share/create` / `GET /share/get/{id}` / `POST /share/import/{id}`.
  - `GET /chatglm/backend-api/v1/conversation/page_messages` — paginated messages.
- **Model list (verified):**
  - `GET /chatglm/agent-api/operation/detail?tag=available_models` — returns `{default, models[]}`. Vuex action `GetAvailableModels` dispatches `SET_DEFAULT_MODEL`.
  - `GET /chatglm/backend-api/v1/model_version` (GET) — current model version metadata.
  - `GET /chatglm/model_version` — alternate model-version endpoint.
  - Model literal found: `glm-4.7` (guest fallback in `selectedModels`). Full model names live on the server response — none hardcoded as a static list in the bundle.
- **Agent/GLMS endpoints (verified):**
  - `/chatglm/glms-api/assistant/*` — assistant info, likes, CRUD.
  - `/chatglm/mainchat-api/*` — alternate chat engine (GLMS task engine):
    - `POST /chatglm/mainchat-api/engine/submit` — task submit.
    - `POST /chatglm/mainchat-api/stream/stop_stream` / `stream/update_status`.
    - `POST /chatglm/mainchat-api/conversation/page_messages`.
    - `GET /chatglm/mainchat-api/guest/chat_status` — guest chat status check.
  - `/chatglm/mainchat-api/claw_agent` — Claw agent (coding tool).
  - `/chatglm/action-api/claw/crontab` — scheduled Claw tasks.

### chat.z.ai (international host)

- **Send endpoint (verified):** `POST /api/chat/completions` (standard Open WebUI pattern)
  - POST body: `{stream: bool, model: string, messages: OpenAI-format[], params: {format, keep_alive, …}, signature_prompt: string}`
  - Headers: `Authorization: Bearer {localStorage.token}`, `Content-Type: application/json`, `X-FE-Version: prod-fe-1.1.95`, `X-Signature: {key}`, `Accept-Language: en-US|zh-CN`
  - SSE via fetch reader (EventSource-like wrapper function `Yde`): `Accept: text/event-stream`; `GT="text/event-stream"`, `AN="last-event-id"` (Last-Event-ID). Standard OpenAI SSE format (`data: {json}\n\n`).
  - The function `bhe()` returns the raw fetch Response (stream body not consumed inline — caller reads the body reader).
  - **To-verify:** exact SSE event names, `[DONE]` sentinel, and per-chunk JSON shape on first live capture.
- **Conversation CRUD (verified):**
  - `POST /api/v1/chats/new` — create (body: `{chat, bot_id?}`)
  - `GET /api/v1/chats/?page=&type=` — list
  - `GET /api/v1/chats/{id}` — get
  - `POST /api/v1/chats/{id}/pin` / `pinned` / `archive` / `tags` / `clone` / `share` / `remix`
  - `POST /api/v1/chats/{id}/messages/batch` — batch operations
  - `POST /api/v1/chats/import` — import
- **Model list (verified):**
  - `GET /api/models` — full model list (Open WebUI standard). Auth required.
  - `GET /api/models/base` — base models without customization.
  - Guest fallback model: `glm-4.7`.
  - Model names from HTML meta keywords: `GLM-4.6`, `GLM-4.6-Air`, `GLM-4.5`, `GLM-4.1V`, `GLM-4.5V`, `GLM-5`, `GLM-5.0`, `GLM-5.2`, `GLM-4.7`, `GLM-5.3-Flash`, `Pony Alpha`, `Ox Alpha`.
  - Meta title explicitly: "Z.ai - Advanced AI Chatbot & Agent powered by GLM-5.3-Flash".

## 2. Web search / tools

### chatglm.cn

- `POST /chatglm/backend-api/v1/feed_back` and `/v1/score` — feedback endpoints (search tool feedback may route through these).
- No explicit `web_search` toggle literal found in the zh bundle. The GLMS engine (`/chatglm/mainchat-api/*`) uses `assistant_id` + config to drive tool selection — the search mode is server-controlled per assistant/config. **To-verify on live capture whether the composer exposes an explicit search toggle for the main chat.**
- The CogView image drawing tool exists as a separate mode: `cogview_chat_mode` state key, config endpoints `/chatglm/drawing-api/v1/drawing/config`, `/chatglm/feed-api/drawing/config`.

### chat.z.ai (verified)

- `web_search` is a client-side toggle (verified, `pt` reactive state). Flips a search flag that feeds into the chat completions request.
- Tool names from bundles: `zai_search_web_text`, `zai_search_web_images`, `zai_search_web_by_image`, `zai_search_similar_images`, `zai_search_scholar`, `zai_dr_search` (deep research search), `ppt` (presentation), `crop`, `draw_boxes`, `draw_point`, `open_img_url`, `image_reference`, `search_image`.
- "Advanced search" is a higher-tier search mode exposed in the UI.

## 3. Files: upload & image generation

### chatglm.cn (verified)

- Upload: `POST /chatglm/productivity-api/file/chat_upload` (multipart, `assistant_id`, `from` field for origin module). Also: `POST /chatglm/productivity-api/edu_buddy/project/file`.
- Knowledge: `/chatglm/productivity-api/knowledge`.
- CogView (image gen): config via `/chatglm/drawing-api/v1/drawing/config`. State model `cogview_chat_mode` with `chat_model`, `style`, `dpi`, `aspect_ratio`, `scene`, `skill`. Literal tool names in i18n: `cogview: "AI画图"`, `cogvlm: "图像识别"`, `generate_image: "画图工具"`.
- Video: `/chatglm/video-api/v1`.
- Viewers present: PDF, PPTX, XLSX viewer chunks (`PdfViewer`, `PptxViewer`, `XlsxUniverViewer`).

### chat.z.ai (verified)

- File upload: `GET/DELETE /api/v1/files/`; message file download: `GET /api/v1/storage/pfs/messages/{id}/files/download`.
- Image gen: no explicit `cogview` literal in international build; image tools appear to be served via the `/api/v1/images` base path.
- PPT: `GET /api/chat/ppt/{chatId}?v=latest`; `POST /api/chat/ppt_deploy`; `PATCH /api/chat/ppt/{chatId}` — PPT editing endpoints.

## 4. Other capabilities

### chatglm.cn

- **LLJ (聊乐久) assistant:** `POST /chatglm/llj-api/v1/reference/chat_bubbles`, `POST /chatglm/llj-api/v1/chat/history_list`, `POST /chatglm/llj-api/v1/reference/random_greeting`.
- **Member/subscription:** `/chatglm/member-api/member/member_info`.
- **Config/settings:** `/chatglm/operation-api/config/operation_data`, `mqtt_access`, `cur_ts`.
- **Backend user API:** `/chatglm/backend-api/v1/non_member_try_info`, `POST /backend-api/v3/user/register_application`, `POST /backend-api/v3/user/register_check_phone`, `POST /backend-api/v3/user/send_sms`, `POST /backend-api/v3/user/sign_out`, `GET /backend-api/v1/user/internal_application`.
- **Share:** `/chatglm/backend-api/v1/conversation/share/get/{id}`.
- **Web-dev/workspace:** `POST /chatglm/backend-api/v1/stream_context` (same endpoint used for coding tasks with `claw_agent`).
- **Features visible in i18n:** `page_up`, `page_down`, `find_on_page_ctrl_f`, `run_python`, `cogview`, `cogvlm`, `location_recognition`, `person_recognition`, `plant_recognition`, `search_images`.

### chat.z.ai (verified)

- **Pipelines:** `/api/v1/pipelines/*` (list, add, upload, delete, valves CRUD) — Open WebUI plugin/valve system.
- **MCP:** `/api/v1/mcp/config`.
- **Admin vibe-templates:** `/api/v1/admin/vibe-templates/*`.
- **Web-dev:** `POST /api/v1/web-dev/workspaces/up` — SSE stream for code workspace (Accept: text/event-stream). Body: `{chatId, flags, workspace_id}`.
- **Agents:** `/api/agent/v1/chats/?...`; `chats/subagents`, `chats/list/user/{id}`.
- **Audio:** `/api/v1/audio` base (TTS/STT).
- **Images:** `/api/v1/images` base (image gen/analysis).
- **Retrieval:** `/api/v1/retrieval` base (RAG/search).
- **Tasks:** `GET /api/v1/tasks/config`, `POST /api/v1/tasks/config/update`.
- **Users/settings:** `GET /api/v1/users/user/settings`.
- **OAuth:** `/api/oauth/authorize`, `/api/oauth/admin/clients`.
- **Completion draft:** `POST /api/v1/completion-draft/{chatId}`.
- **Logs:** `https://adapter-prod.chatglm.site/logs/{tenant}/{session}` — external log viewer.

## 5. Auth & session facts for automation

### chatglm.cn (verified)

- **Cookie-based auth (verified):**
  - Access token: cookie `chatglm_token` (set `SameSite=None; Secure; Expires=30d`; `domain: .chatglm.cn`). Retrieved with `"Bearer "` prefix prepended in JS.
  - Refresh token: cookie `chatglm_refresh_token` (`SameSite=None; Secure; Expires=180d`).
  - Token expiry cookie: `chatglm_token_expires` (set via `f()` helper — 2-hour window from refresh).
  - User ID: cookie `chatglm_user_id` (`Expires=30d`).
  - Cleanup on logout: `chatglm_token`, `chatglm_refresh_token`, `chatglm_user_id` + domain-scoped removes.
- **Refresh flow (verified):**
  - `POST /chatglm/user-api/user/refresh` with `Authorization: Bearer <chatglm_refresh_token>`.
  - Response: `{result: {access_token, refresh_token}}`. Access token + expiry + refresh token rewrite cookies.
  - Second refresh path with signature: headers `X-Timestamp`, `X-Nonce`, `X-Sign` = MD5(`${timestamp}-${uuid}-8a1317a7468aa3ad86e997d08f3f31cb`).
- **Request headers (verified):**
  - `Authorization: Bearer <chatglm_token>` (when useRefreshToken=false).
  - `App-Name: chatglm`.
  - `X-Device-Id: {chatglm-deid UUID4}`, `X-Request-Id: {uuid}`.
  - `Content-Type: application/json;charset=utf-8`.
  - `withCredentials: true` (cookies sent with every request).
- **Login flow:** `POST /chatglm/backend-api/v2/user/login?satoken={satoken}` (satoken-based SSO login). Guest mode: `GET /chatglm/mainchat-api/guest/chat_status`.
- **Device/telemetry:** Volcano Engine `collectEvent` (app_id: 20009687), `chatglm-deid` in localStorage (UUID4), `zp-chat-glm` browser SDK, `sdata.chatglm.cn` for data reporting.

### chat.z.ai (verified)

- **localStorage-based auth (verified):**
  - JWT token stored in `localStorage.getItem("token")` (key literal: `"token"`).
  - Set on session load: `localStorage.token = T.token` where T is the `/api/v1/auths/` response object `{id, email, name, role, profile_image_url, phone_num, token}`.
- **Refresh / session lifecycle:**
  - Bootstrap HTML inline script: `var token = localStorage.getItem('token');` — token read before SPA mount.
  - `window.GLOBAL_FETCHES.session = fetch('/api/v1/auths/')` — pre-hydration fetch. Returns `{id, email, name, role, token}`. If 401 → renders as guest.
  - `GET /api/v1/auths/` (standard Open WebUI endpoint): returns session with JWT `token` field.
  - OAuth: route `/auth?action=signup`, `/auth` for sign-in; `/api/oauth/authorize?response_type=json&client_id=&redirect_uri=&state=` (redirect-based OAuth).
  - **To-verify:** whether the JWT needs periodic refresh (Open WebUI typically issues long-lived JWTs or uses server-side session validation). No explicit refresh-token mechanism found in the Z.ai bundles.
- **Request headers (verified):**
  - `Authorization: Bearer {localStorage.getItem("token")}` (all authenticated requests).
  - `Accept: text/event-stream` for streaming chat.
  - `X-FE-Version: prod-fe-1.1.95`.
  - `X-Signature: {key}` — signature value (purpose unclear; `a` param from the bhe function).
  - `Accept-Language: en-US` or `zh-CN`.
  - `credentials: 'include'` (bootstrap fetch; cookies also sent).
- **Telemetry:** Google Tag Manager (`GTM-T9CBCLPX`, `G-Z8QTHYBHP3`), Alibaba Cloud RUM SDK, 3rd-party analytics (td-static.kimi.link not present — Z.ai does not use TrustDecision).

## 6. Verified vs to-verify split

### Verified (static, from bundles/HTML)

**chatglm.cn:**
- All endpoint paths in §1–§4 (stream_context, manualstop, conversation CRUD, llj-api, drawing-api, productivity-api, mainchat-api, backend-api/v3/user/*, member-api, model_version, available_models).
- Cookie auth: `chatglm_token`, `chatglm_refresh_token`, `chatglm_user_id`, `chatglm_token_expires`. Cookie attributes (SameSite, Secure, expiry).
- Refresh: `POST /chatglm/user-api/user/refresh` with Bearer refresh token → rewrites cookies.
- Request headers: `App-Name: chatglm`, `X-Device-Id`, `X-Request-Id`.
- Model literals: `glm-4.7` (guest fallback).
- CogView tool config surface, model state keys, i18n tool names.
- `window.ChatglmOpenJSBridge` (native bridge for mobile).
- Vue/Vuex SPA with cookie-persisted state, `vuex` key in localStorage.

**chat.z.ai:**
- All endpoint paths in §1–§4 (`/api/chat/completions`, `/api/v1/chats/*`, `/api/models`, `/api/v1/auths/`, `/api/v1/files/`, `/api/v1/pipelines/*`, `/api/v1/mcp/config`, etc.).
- Chat send body shape: `{stream, model, messages, params:{format,keep_alive,...}, signature_prompt}`.
- SSE via fetch reader (`text/event-stream`, `Accept` header, `last-event-id`).
- Token: `localStorage.token` (JWT), bootstrap session fetch pre-hydration.
- Model names from meta: GLM-4.5/4.6/4.7/5/5.0/5.2/5.3-Flash/Pony Alpha/Ox Alpha.
- Open WebUI codebase proven (pipelines, valves, completion-draft, vite-kanban-style routes).
- PPT endpoints, admin vibe-templates, task config, OAuth routes.

### To verify on first live (headed) capture

1. **chatglm.cn SSE format:** Whether `stream_context` response is SSE (`data: json\n\n`), NDJSON, or chunked JSON. The `isEventSourceaOpen` flag proves the client treats it as an event stream but the wire format literal is absent — dynamic parsing likely.
2. **chatglm.cn conversation submit payload:** Full field set in the stream_context POST body (model, messages, conversation_id, assistant_id, client_context, etc.) — the builder is spread across Vuex actions and not fully traced statically.
3. **chat.z.ai SSE event names/chunk shape:** The exact JSON structure of each SSE data chunk and the `[DONE]` sentinel format.
4. **chat.z.ai login flow:** Exact POST path for email/password or OAuth callback that sets `localStorage.token` (Open WebUI standard is `/api/v1/auths/signin` but literal not found).
5. **chatglm.cn composer/answer DOM selectors** (profile.json is a scaffold with unverified candidates).
6. **chat.z.ai composer/answer DOM selectors** — same.
7. **Full model list from `/api/v1/auths/` (Z.ai) or `/chatglm/agent-api/operation/detail?tag=available_models` (zh).**
8. **Web search payload shape** on chatglm.cn main chat engine (not the GLMS engine).
9. **`X-Signature` header purpose and derivation** for chat.z.ai.

## 7. Bot-wall outcome

- **chatglm.cn — No bot wall hit** on static fetch: 200 OK, 572 KB HTML with all bundles served. Expect server-side rate limiting / captcha on `/chatglm/backend-api/v3/user/*` (captcha_rid in localStorage, phone verification endpoints present). The app has a `captcha_rid` localStorage key suggesting CAPTCHA is implemented.
- **chat.z.ai — No bot wall hit** on static fetch: 200 OK, 15.7 KB HTML, index chunk served. No anti-bot fingerprinting SDK detected (unlike Kimi which uses TrustDecision). The app uses Alibaba Cloud RUM for performance telemetry but not anti-bot. Expect 401/guest gating once abuse signals appear.

## 8. Suggested ui2api capability list (id, one-line description)

| id | description |
|----|-------------|
| `chatglm_chat` | Composer send + streamed answer via `/chatglm/backend-api/v1/stream_context` (zh) or `/api/chat/completions` (Z.ai) — UI-path driver. |
| `chatglm_conversation_crud` | List/get/rename/delete conversations — `/chatglm/backend-api/v1/conversation/*` (zh) or `/api/v1/chats/*` (Z.ai). |
| `chatglm_web_search` | Toggle web-search mode in composer → grounded answer (Z.ai: client toggle; zh: server-controlled per assistant). |
| `chatglm_image_gen` | CogView image generation (zh: `/chatglm/drawing-api/v1/drawing/config` + chat tool; Z.ai: `/api/v1/images`). |
| `chatglm_model_list` | Read available models from picker DOM or `/api/models` (Z.ai) / `/chatglm/agent-api/operation/detail?tag=available_models` (zh). |
| `chatglm_file_upload` | Attach files to chat — zh: `/chatglm/productivity-api/file/chat_upload`; Z.ai: `/api/v1/files/`. |
| `chatglm_ppt` | PPT generation/editing (Z.ai: `/api/chat/ppt/*`; zh: CogView slides tools). |
| `chatglm_glms_assistant` | GLMS task engine assistant chat via `/chatglm/mainchat-api/engine/submit` (zh only, server-selected tools/prompts). |

(Not exposing: auth/user registration/subscription/telemetry — sensitive or tied to interactive UI flows.)
