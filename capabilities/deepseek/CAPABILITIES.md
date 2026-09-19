# DeepSeek capabilities (from JS bundle analysis, 2026-09-16)

Analyzed 2 JS bundles (~2.5 MB) hosted on `fe-static.deepseek.com/chat/static/` (`default-vendors.73c732e189.js`, `main.39d5f46438.js`, SPA commit `9a1e24e6`). Entry `chat.deepseek.com/` itself is behind an **AWS WAF JS challenge** (HTTP 202 empty + `x-amzn-waf-action: challenge`; curl UA → HTTP 403); the SPA HTML was recovered from same-origin API paths (`/api/v0/users/me` serves the index HTML) and bundles are on the un-walled `fe-static.deepseek.com` CDN. API base = **same origin `https://chat.deepseek.com/api`** (relative `/api/v0/...`).

## 1. Transport & envelope
- REST JSON over HTTP POST + **SSE streaming** for chat (`text/event-stream` response; client checks content-type and downshifts to json when absent). Fetch-based streaming reader, no `EventSource`. SSE event names (enum `NewSSEEventName`): `ready`, `delta`, `toast`, `title`, `finish`, `close`, `hint`, `updateSession`, `updateParentMessage`, `updateFile`.
- SSE `delta` payloads are JSON-patch ops `{p:path, o:SET|BATCH|APPEND, v:value}`; `ready` carries `{response_message_id, request_message_id, model_type}`; `close` carries `{click_behavior: retry|none}`; terminal chunk types `error|warning` expose `finish_reason`. MessageStatus enum: `FINISHED`, `WIP`, `INCOMPLETE` (+ `CONTENT_FILTER`, `CONTENT_TOO_LONG`, `CANCELLED`, `CONTENT_EMPTY`, …).
- Response envelope everywhere: HTTP 200 + `{data:{biz_code, biz_data, biz_msg}}`; `biz_code !== 0` = error. `mayMissingApiCode` flag marks endpoints returning raw bodies.
- Heartbeat + auto-resume: watch dog over SSE (`x-ds-sse-heartbeat-timeout-secs` constant, `getSSEAutoResumeConfig`) + `POST /api/v0/chat/resume_stream`; dropped networks leave a `WIP` message surfaced as `completionWipNetworkErrorToast`.

## 2. Auth (verified)
- Token in **localStorage key `userToken`** → every authed request gets `Authorization: Bearer <userToken>` (http interceptor keyed on `context.withToken`; token resolved via `getUserTokenWithSource()`). Also stored: `settingsJwt` → sent as `x-settings-token`, and `__appKit_userInfo` (user id).
- Login/register (PoW-guarded, list from interceptor): `/v0/users/register`, `/v0/users/register_by_mobile`, `/v0/users/login_by_mobile_sms`; OTP via `/api/v0/users/create_sms_verification_code` / `create_email_verification_code`; device gate `/auth_token/check_device`; guest entry `/api/v0/users/create_guest_challenge`. No password-login path string found in bundles (mobile-SMS/email-OTP/register only) — to probe live.
- **Proof-of-work anti-bot**: `POST /api/v0/chat/create_pow_challenge {target_path}` → `{algorithm, challenge, salt, signature, expire_at, expire_after}`; client mines (`preparePowChallengeAndSolve`, difficulty) and submits `X-DS-PoW-Response: base64(JSON{algorithm, challenge, salt, answer, signature, target_path})` (guest variant `X-DS-Guest-PoW-Response`, `{salt, answer}`). Mining loop lives in an async chunk (not in main) — solve algorithm not read. Client also detects AWS `awsChallenge`/`awsCaptcha` from status/headers.
- Rate/throttle headers: request `x-hif-leim`, `x-hif-dliq` (bucket tokens), response `x-hif-ttl` (secs, default 600) and `x-fetch-after-sec` (server tells client when to retry), `x-ds-trace-id` per request.

## 3. Chat endpoints (all verified strings in main bundle)
- `POST /api/v0/chat/completion` — main chat; body `{chat_session_id, parent_message_id, model_type, prompt, ref_file_ids, thinking_enabled, search_enabled, source, action, preempt}`.
- `POST /api/v0/chat/continue` · `/regenerate` · `/edit_message` · `/stop_stream` · `/resume_stream` · `/message_feedback` · `GET /api/v0/chat/history_messages`.
- Sessions: `/api/v0/chat_session/create|delete|delete_all|fetch_page|update_title|batch_update_pinned`.
- Files: `POST /api/v0/file/upload_file` (multipart `file`, headers `x-thinking-enabled:"1"|"0"`, `x-model-type`, `x-file-size`), `/api/v0/file/fetch_files`, `/api/v0/file/fork_file_task` (`{file_id, to_model_type}`).
- Other: `/api/v0/index/query` (`{query, before_seq_id}` — semantic chat search), `/api/v0/index/prepare` (bootstrap), `/api/v0/share/{create,delete,fork,list}`, `/api/v0/share/content`, `/api/v0/download_export_history`, `/api/v0/export_all`, `/api/v0/client/settings` + `/report`.

## 4. Reasoning / "deepseek_reasoner" (CoT mode) — behavior verified, model ids are not
- Mechanism **verified in bundles**: `thinking_enabled` boolean in completion body; `x-thinking-enabled` + `x-model-type` headers on file upload; per-session `model_type` passed on every completion; local toggle state in localStorage (`thinkingEnabledStorageHandle`, `searchEnabledStorageHandle`); i18n tooltips "Think before responding to solve reasoning problems" / "Search the web when necessary" (toggle-off state). `reasoning` output streams inside the same SSE `delta`/`title` tree (applies a `path`-addressed state patch), not as a separate field — the exact reasoning-path key is in a chunk.
- Model list is **server-driven, not in bundles**: fetched from `/api/v0/client/settings` feature `model_configs` → `[{model_type, is_default, enabled, switchable, file_feature:{vision}}]`; bundle only hardcodes the sentinel `"default"`. Literal ids `deepseek-chat`/`deepseek-reasoner`/R1 **do not appear** in either bundle — assign `model_type` from a live `/client/settings` read.

## 5. Other
- **TTS**: WebSocket `wss://<host>/api/v0/chat/tts/` (+ `/chat/tts/voices`, `/chat/tts/voice`); engine lazily chunk-loaded (async chunk 74268).
- SPA is a custom closure-compiled micro-bundler output (not webpack); async chunks + PoW miner + TTS engine load from `https://fe-static.deepseek.com/chat/`.

## 6. Verified vs to-verify
- **Verified (static)**: API base+envelope, all `/api/v0/...` paths, SSE event protocol + JSON-patch delta, Bearer-auth from localStorage `userToken`, PoW header scheme + challenge endpoint, hif throttle headers, `thinking_enabled`/`search_enabled` toggles + per-session `model_type`, model config source, TTS WebSocket.
- **To verify (live/browser)**: actual `model_type` id values and current default; PoW mining algorithm + difficulty; composer/send/answer DOM selectors (`.ds-markdown` remains a candidate from prior UI knowledge); reasoning block selector/path; password login existence; whether completion needs a fresh PoW per request/session.
## 5. LIVE VERIFICATION LOG — 2026-09-19 (DOM + functionality, end-to-end)

Session: injected snapshot lock 2026-09-18T14:42:47Z (5 cookies / 31 localStorage
keys incl. `userToken` → `Authorization: Bearer`). `ui2api proof --site deepseek`
PASS (7023). Headless-safe.

| Capability | Result | Verified mechanism (DOM) |
|---|---|---|
| `deepseek_chat` | ✔ proof PASS | composer → Enter → streamed answer read off the page; AWS WAF + PoW invisible to the page path. |
| `deepseek_reasoner` | ✔ live toggle verified | real toggle `div.ds-toggle-button:has-text("DeepThink")`; state class `ds-toggle-button--selected`. `args.state` on/off; verified flips false→true and back (state reaches the wire as `thinking_enabled`). |
| `deepseek_web_search` | ✔ live toggle verified | same toggle family `div.ds-toggle-button:has-text("Search")`; verified true→false and back (`search_enabled` on the next completion). |
| `deepseek_list_conversations` | ✔ real items | `page.waitForSelector("a[href*='/chat/']", {timeout:15000})` then read hrefs (both `/chat/<id>` and `/a/chat/s/<uuid>` shapes) + titles. |

Model_type note: literal `deepseek-reasoner`/`deepseek-chat` ids still never
appear in the wire DTOs — model is addressable via the UI toggle, not by id.
