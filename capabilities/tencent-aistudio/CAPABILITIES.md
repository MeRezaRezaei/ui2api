# Tencent AI Studio capabilities (from JS bundle analysis, 2026-09-16)

Analyzed statically (curl only, Chrome UA, no browser launched), 5 JS bundles (~12.6 MB total)
from `https://aistudio.tencent.com` (title: "Hy AI Studio"; lang: zh-CN).
Main app bundle: `hy-web__e62837fa9ff77f96314a.js` (~7.6 MB); route/feature bundle:
`index__70332c7932348066f545.js` (~4 MB).

- Site: `https://aistudio.tencent.com` — SPA (React + TDesign) under the Tencent Hunyuan
  umbrella. Tags alternate-name "腾讯混元" / "腾讯混元大模型". CDN host: `cdn-portal.hunyuan.tencent.com`.
  Sibling products: `yuanbao.tencent.com` (consumer Hunyuan — already covered by capabilities/hunyuan;
  different shell/API surface). The aistudio API is the developer/professional studio frontend.

## 1. Chat core (models, streaming)

- **Endpoint:** `POST /api/new-portal/chat/{chatId}` — primary chat send. The `chatId` is
  appended to the path (generated via `POST /api/new-portal/generate/id`). Request body:
  `{ model, prompt, displayPrompt, displayPromptType, options, plugin, translateModelList,
  podcast, aiRoleClone, searchDeepMode, displayImageIntentionLabels, agentId, continue,
  supportHint }`. Timeout: 900 000 ms (15 min). Also: `POST /api/new-portal/chat/repeat/{chatId}`
  (retry last turn); `POST /api/new-portal/stop/chat/{chatId}` (abort generation).
- **Streaming:** Responses arrive as JSON objects decoded per chunk (parseable via
  `JSON.parse(e.data)`). Each chunk carries a `type` field (`"text"`, `"card"`,
  `"ai_search_pro"`, `"reasoner"`, etc.), plus `content` and optional `code`/`msg`.
  The frontend maps chunk `type` to internal `HYCSpeechType` enum values:
  `TEXT` (27 refs), `STATUS` (25), `CARD` (12), `THOUGHT_WITH_IMG` (11), `DOC_CARD` (11),
  `DEEP_THOUGHT` (11), `PODCAST` (10), `DEEP_THINK` (9), `REASONER` (8), `OUTLINE` (8),
  `LOCAL_MOCK_LOADING` (8), `IMAGE_WITH_TEXT` (8), `DOC_DEEP_MODE` (8),
  `SEARCH_DEEP_MODE_FIN` (7), `SEARCH_DEEP_MODE` (7), `MULTI_MODEL_OUTPUT` (7),
  `DOC_DEEP_READ_CARD` (6), `MULTI_MODAL` (4), `MESSAGE_REVOKE` (4).
  **Stream framing** (newline-delimited? length-prefixed? custom delimiter?) is NOT known
  from static analysis — **to verify on first live capture**. No `text/event-stream` or
  `EventSource` literal was found; delivery is via fetch/XHR with body-parsing per chunk.
- **Conversation lifecycle:**
  - `POST /api/new-portal/generate/id` — generate a new `chatId`.
  - `POST /api/new-portal/user/agent/conversation/v1/detail` — get full conversation detail.
  - `POST /api/new-portal/user/agent/conversation/continue` — continue a prior conversation.
  - `POST /api/new-portal/chat/conversation/clear` — clear context (new turn).
  - `POST /api/new-portal/chat/conversation/update` — rename/update chat metadata.
  - `POST /api/new-portal/chat/conversation/history/del` — delete message history.
  - `POST /api/new-portal/chat/conversation/share` — share conversation.

## 2. Models

- Known model literals (from i18n strings and content references in bundles):
  - `HunyuanDefault` — default Hunyuan chat model (route: `/chat/HunyuanDefault`).
  - `hunyuan_t1` / `hunyuan-t1-latest` / `hunyuan-t1-lastest` [sic] — Hunyuan T1.
  - `hunyuan-large` / `hunyuan_gpt_175B_0404` / `hunyuan_1119` — Hunyuan-Large family.
  - `deep_seek_v3` — DeepSeek V3.
  - `deep_seek` — DeepSeek R1 (internal ref: `deep_seek`; UI caption: "来自于DeepSeek R1").
  - `hunyuan-image` — Hunyuan vision/recognition model ("混元识图").
  - `spark_desk`, `gpt_4`, `gpt_35_turbo`, `ernie_bot`, `doubao`, `hy3`, `Qwen3.5`
    — references in documentation/comparison material only (not user-selectable in picker).
- **Model listing APIs:**
  - `POST /api/agent/model/list` — agent model picker data.
  - `POST /api/models` — model list.
  - `POST /api/new-portal/config {key:"globalConfig"}` — global config (includes model assignments).
  - `POST /api/new-portal/config {key:"getChatConfig"}` — chat config (model picker state).
  - `POST /api/new-portal/config {key:"visionGeneration"}` — vision generation model config.
  - `POST /api/new-portal/config {key:"userConfig"}` — user-level model preferences.
- Default model field in request body: `model` key; default resolved from `gt.fr` module constant
  (HunyuanDefault). Model change triggers `chatType` switch in internal state.

## 3. Web search / deep search

- In-chat web search is a toggle in the composer (not a separate RPC). Activating it sets
  `searchDeepMode: true` on the chat request body, plus `searchDeepModeParentIndex`.
- Stream speech types for search: `SEARCH_DEEP_MODE`, `SEARCH_DEEP_MODE_FIN`, `ai_search_pro`,
  `card`, `news_and_news_article`. Deep-search mode is also exposed as `HYCSpeechMode.DEEP_SEARCH`.
- Config flag: `POST /api/new-portal/config {key:"getAgentConfig"}` — includes search capability
  flags (exact keys to verify on live capture).

## 4. Deep thought / reasoning

- `HYCSpeechType.DEEP_THOUGHT`, `DEEP_THINK`, `REASONER`, `THOUGHT_WITH_IMG` — streaming
  speech types carrying Chain-of-Thought reasoning blocks.
- Deep-think mode toggled via composer or model config; exact request-field to verify on live.

## 5. Image generation (DIT)

- Vision generation backend: `dit.hunyuan.tencent.com` (DiT diffusion model).
- Image generation API paths (in `vision_platform` namespace):
  - `POST /api/vision_platform/generation` — trigger image generation.
  - `POST /api/vision_platform/query_task` — poll generation task.
  - `POST /api/vision_platform/query_task_list` — list past generations.
  - `POST /api/vision_platform/taskHistoryDel` — delete generation history.
- Additional vision endpoints:
  - `POST /api/image/search` — image search / collection.
  - `POST /api/image/clarity`, `POST /api/image/style` — style/clarity enhancement.
  - `POST /api/image/outpainting`, `POST /api/image/elimination` — inpainting/outpainting.
  - `POST /api/image/removewatermark` — watermark removal.
  - `POST /api/image/edit/asset/save` — save edited image.
  - `POST /api/vision_platform/ocr` — OCR.
- 3D models: `3d-models.hunyuan.tencent.com` (3D model gallery/hosting).
- Video: `aivideo.hunyuan.tencent.com` (video generation).
- Content type: `HYCSpeechType.IMAGE_WITH_TEXT`, `MULTI_MODAL`, `OLYMPIC_POSTER`.

## 6. Code execution / sandbox

- `coder` and `runCode` features present in bundles (36 + 7 refs in index bundle respectively).
  Hunyuan "Coder" mode — code interpreter sandbox (language unknown; execution environment
  details to verify on live capture).
- Speech type for code output: not yet enumerated — likely included in `TEXT` or `CARD` types.

## 7. File upload & document analysis

- Upload uses Tencent COS (Cloud Object Storage):
  - `POST /api/new-portal/tempCred` — temporary COS credentials (TmpSecretId / TmpSecretKey /
    Token). COS SDK present in bundle: `cos-sdk__dcbf0ed4dec6fec14296.js` (~180 KB).
  - `POST /api/new-portal/chat/resource/genUploadInfo` — per-conversation upload info.
  - `POST /api/new-portal/chat/resource/download` / `v1/download` — resource download.
  - `POST /api/vision_platform/resource/genUploadInfo` — vision platform upload.
- Document parsing: `POST /api/resource/fileParse` — parse uploaded document.
- Chat speech types for document content: `DOC_CARD`, `DOC_DEEP_MODE`, `DOC_DEEP_READ_CARD`,
  `doc_percent`, `docDeepModeInfo`. Supported formats (from speechContent parser):
  pdf, doc, docx, ppt, pptx, xls, xlsx, txt, csv, md, video.

## 8. Speech: TTS & ASR

- **TTS:** `POST /api/new-portal/audio/synthesis` — text-to-speech audio synthesis.
  Speech type: `PODCAST` (10 refs); podcast speech carries `audioDeltaBase64` (base64 audio
  chunks) plus `script.text` for timing.
- **ASR:** `POST /api/new-portal/asr/file/recognize` — speech recognition (audio file upload).
  - `POST /api/new-portal/asr/file/queryTask` — poll ASR task status.
  - `POST /api/new-portal/asr/history/list` / `asr/history/del` — ASR history.
  - External host: `asr.cloud.tencent.com` (Tencent Cloud ASR service).
  - WebSocket events: `"asr.started"` (real-time ASR session events).
- Frontend audio: `WebRecorder`, `WebAudioSpeechRecognizer`, `SpeechRecognizer` window globals.

## 9. Podcast generation

- Podcast endpoint family:
  - `POST /api/new-portal/podcast/hint` — get podcast interaction hints.
  - `POST /api/new-portal/podcast/relInfo` — get related podcast info.
  - `POST /api/new-portal/podcast/interact` — interact with podcast content.
- Stream speech type: `PODCAST`. Podcast data includes `audioDeltaBase64` (chunked base64 audio)
  and `script.text` with word-level timing.

## 10. Translations

- `translateModelList` field on the chat request body carries the list of available translation
  models. `sourceLang` / `targetLang` / `sourceLangLabel` / `targetLangLabel` fields on the
  activeChat speech model control translation direction.
- UI route: chat accepts `sourceLang`/`targetLang` params. Exact translation-model picker DOM
  and selection flow: to verify on live capture.

## 11. Agent roles & cloning

- AI agent role system: `POST /api/new-portal/aiRoleClone/systemCharacterList` (list character
  archetypes), `POST /api/new-portal/aiRoleClone/characterDetail` (get character detail).
- Clone/create: `POST /api/new-portal/interview/publishClone`, `POST /api/new-portal/interview/cloneDetail`.
- Chat request field: `aiRoleClone` (carries agent clone configuration).
- Agent config: `POST /api/new-portal/getAgentConfig`; route `/chat/HunyuanDefault`.

## 12. Auth & session facts for automation

- **Login:** Tencent iOA (enterprise SSO) + QR code scan (二维码). API: `POST /api/oalogin`
  (initiates login flow); `POST /api/getuserinfo` (get logged-in user profile); logout via
  `/_logout/?url=...` or `POST /api/new-portal/login/logout`. UI: WeChat login, QR code
  scan, iOA SSO ("ioa登录过期" = iOA login expired).
- **Wire auth:** Cookie-based. Every request uses `credentials: "include"` (axios defaults +
  per-request). Cookies set by server on login (likely `hy_user` + `hy_token` based on
  shared umbrella with yuanbao.tencent.com); exact cookie names **to verify on live capture**.
  The page also injects X-Token/X-ID headers on `/openapi`-prefixed paths (for API key mode),
  but the primary web-app path is cookie-only.
- **Request headers (injected by app):**
  - `X-Token`: session token — when `ph()` or `Pf()` (miniprogram/webapp detect) is true,
    sourced from URL param `token` or `localStorage "weapp-token"` (miniprogram mode).
  - `X-ID`: user ID (from URL param `uid` or `localStorage "weapp-uid"`).
  - `X-Source`: `"miniprogram"` (when miniprogram context detected).
  - `Space-Id`: from `localStorage "hy-space-id"`.
  - `withCredentials: true` on all requests.
  - When path starts with `/openapi`: `Authorization: Bearer <X-Token>`.
- **LocalStorage keys observed:**
  `userInfo`, `lang`, `hy-space-id`, `hyUserName`, `weapp-uid`, `weapp-token`,
  `hasNewChat`, `anon-last-input-text`, `showExample`, `hy_device_id`.
- **Telemetry:** Galileo telemetry (`galileotelemetry.tencent.com`); `traceId` in all request
  helpers. Monitor bundle (`monitor__*.js`).
- provider-catalog: `tencent-aistudio-web` kind **cookie** (`Cookie header (full)`).

## 13. Verified vs to-verify split

**Verified (static, from bundles/SSR):**
- All endpoint paths in §1–§11 (literal string constants in the API URL map).
- Chat request body field names (`model`, `prompt`, `options`, `plugin`, `searchDeepMode`,
  `aiRoleClone`, etc.) — derived from the `xn()` payload builder.
- Streaming chunk parse: JSON objects via `JSON.parse(e.data)` with `type` → `HYCSpeechType`.
- Auth: `credentials: "include"` on all requests; iOA/QR scan login flow (`/api/oalogin`,
  `/api/getuserinfo`); header injection (`X-Token`, `X-ID`, `Space-Id`, `X-Source`).
- Model name literals: `HunyuanDefault`, `hunyuan_t1`, `deep_seek_v3`, `deep_seek`, etc.
- COS upload flow: tempCred → COS SDK → resource genUploadInfo.
- Feature flags via `/api/new-portal/config` keyed queries.

**To verify on first live (headed) capture:**
1. Stream wire framing — how JSON chunks are delimited in the response body (no `text/event-stream`
   literal; delivery mechanism is fetch/XHR with onProgress/onStateChange; exact byte framing unknown).
2. Exact cookie names set on `aistudio.tencent.com` after login (`hy_user` + `hy_token` are
   a hypothesis based on yuanbao.tencent.com overlap — could differ).
3. DOM selectors for composer, answer container, new-chat button, model picker —
   the SPA renders into `<div id="app"></div>` with TDesign components; no DOM class strings
   proven by bundles.
4. `/api/new-portal/config` response shapes — which flags drive web-search/deep-think toggles.
5. Live model picker ↔ `model` request-field mapping (exact picker-to-payload correlation).
6. `coder`/`runCode` feature — exact sandbox invocation endpoint and execution-environment type.
7. ASR WebSocket protocol (`asr.cloud.tencent.com`) — session negotiation shape.
8. Translation model list format and selection mechanism.

## 14. Bot-wall outcome

- **No bot wall hit** on static fetch: plain curl with Chrome UA returned the full SPA HTML
  (200, 3209 bytes; clean app shell, no challenge, no interstitial) and all 5 bundles served
  normally from `cdn-portal.hunyuan.tencent.com/public/`.
- The site has enterprise-grade Tencent Cloud anti-bot infrastructure (monitoring, traceId,
  `galileotelemetry.tencent.com`). Expect CAPTCHA / iOA-gated challenges once
  headless-automation signals appear — no client obstacle observed at the static layer.

## 15. Suggested ui2api capability list (id, one-line description)

| id | description |
|----|-------------|
| `tencent_aistudio_chat` | Composer send + streamed answer via `POST /api/new-portal/chat/{chatId}` (JSON stream). |
| `tencent_aistudio_web_search` | Toggle `searchDeepMode` → grounded answer (SEARCH_DEEP_MODE / ai_search_pro stream types). |
| `tencent_aistudio_deep_think` | Reasoner/deep-thought CoT mode (DEEP_THOUGHT / DEEP_THINK / REASONER stream types). |
| `tencent_aistudio_conversation_crud` | List/get/rename/delete/clear conversations + generate/id + continue via /api/new-portal/ endpoints. |
| `tencent_aistudio_image_gen` | Image generation via /api/vision_platform/generation (DIT model at dit.hunyuan.tencent.com). |
| `tencent_aistudio_code_run` | Code interpreter / sandbox execution (coder/runCode features; env to verify). |
| `tencent_aistudio_file_upload` | Upload docs via COS tempCred + genUploadInfo; parse via /api/resource/fileParse; doc QA. |
| `tencent_aistudio_tts` | Speech synthesis (POST /api/new-portal/audio/synthesis) + ASR via /api/new-portal/asr/ + asr.cloud.tencent.com. |
| `tencent_aistudio_podcast` | Podcast generation (audioDeltaBase64 chunks + script timing; podcast/hint + interact endpoints). |
| `tencent_aistudio_translations` | In-chat translation via translateModelList + sourceLang/targetLang fields. |
