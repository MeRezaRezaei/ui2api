# ChatGPT capabilities (from JS bundle analysis + SSR bootstrap, 2026-09-16)

Analyzed statically (curl only, Chrome UA, no browser launched), 15 JS bundles (~13 MB) + the SSR HTML
and its `client-bootstrap` JSON from `https://chatgpt.com`.

- Site: `https://chatgpt.com` (`data-build="prod-5b8d5dfe2eea7423e6e12834a673d2dfc6b339cc"`,
  `data-seq="10817430"`, cluster `unified-193`). Bootstrap `authStatus: logged_out`, `isNoAuthEnabled: true`,
  `freeGoChatModelPickerAssignment: disabled`, `statsigPayloadSource: server_common_props`.
- Legacy host `https://chat.openai.com` serves only a static 8.6 KB logo landing page (no app bundles).
- Key bundles: `cg-4.js` (`4813494d…`, ~2.3 MB — auth/session/token-refresh machinery),
  `cg-10.js` (`conversation-small-…`, ~5.3 MB — conversation send + SSE + CRUD + model fields),
  `cg-6.js` (`8b34dbc2…`, ~3.6 MB — shell/EventSource plumbing),
  `cg-14.js` (`manifest-…`, ~680 KB).

## 1. Chat core (models, streaming)

- Send endpoint (current literal in this build): **`POST /backend-api/f/conversation`**; historical form
  `/backend-api/conversation` also appears in the codebase string table. Builtin profile ground truth:
  composer `#prompt-textarea` → Enter → assistant turns `[data-message-author-role='assistant']`.
- Resume path: **`/backend-api/conversation/resume`** (client treats `/backend-api/f/conversation` and
  `/conversation/resume` uniformly; stream must end with a `done`/`turn_complete` event or it throws
  `No done event received`).
- Streaming: **SSE, `text/event-stream`** (also `EventSource` usage in shell bundle). Literal event names
  in bundle: `stream_start`, `status_message`, `conversation_id`, `turn_complete`. The per-chunk answer
  event literal is **not** present as a plain string (delta event is composed dynamically) —
  **to verify on first live capture**.
- Request body fields (bundle-verified): `model_slug`, `model_slug_advanced` (only when
  model_picker group == `advanced`), `chatreq_token` (per-request token, optional in normal flows;
  `__chatreq_mode_at_send` may be `prepared_only`), `client_tools`, `history_and_training_disabled`,
  `conversation_mode` (`{kind: PrimaryAssistant}` or `{kind: GizmoInteraction, gizmo_id}` for GPTs),
  `parent_message_id`, `system_hints`, `system_prompt_type`, `contextScopes`.
- Model names present as literals: `gpt-4`, `gpt-4-1`, `gpt-4-1-mini`, `gpt-4-5`, `gpt-4o`, `o4-mini`,
  `gpt-5-2`, `gpt-5-3`, `gpt-5-mini`, `gpt-5-thinking`, `gpt-5-t-mini`. Default choice preference:
  `defaultModelId ?? default_model_slug`. (No o1/o3 family found.)

## 2. Web search / tools

- Request-level tool flags in the send payload: `web_search` and `cloud_browser` both feed
  `client_tools`. A `search`/`browser` gate feature (`e.web_search`, `e.cloud_browser`) exists.
- Toolbar/user-facing: not a separate RPC — tools ride inside the `/backend-api/f/conversation`
  request. **Exact tool-shape to verify on live capture.**

## 3. Files & artifacts (Estuary)

- Upload/content endpoints (bundle literals): `/backend-api/estuary/content`,
  `/backend-api/estuary/upload_content_bytes` (guard pattern `upload_url_expiry`; strategies
  `estuary_bytes`, `direct_azure`, `direct_azure_multipart`, `direct_aws`; size buckets `…20_to_100_mib`,
  `gte_100_mib`). Debug route `/api/estuary/content`.
- Artifacts/Canvas: `window.CanmoreNative` hook present; message fields `artifact_id`,
  `artifact_kind`, `artifact_files`, `artifact_preview_result`, `artifact_renderer`,
  `artifact_known_file_sizes_per_event`; conversation docs endpoint `/backend-api/conversation/{id}/textdocs`.
- A separate attachment endpoint is also reachable via the debug route prefix `/api/…` per the
  guard regex `/^\/(?:backend-)?api\/estuary\/upload_content_bytes\/?$/i`.

## 4. Conversations & accounts

- CRUD/history endpoints (bundle literals):
  `/backend-api/conversation/{conversation_id}` (GET/DELETE style),
  `/conversation/{id}/messages/{message_id}/existence`,
  `/conversation/{id}/lock`, `/conversation/{id}/stream_status`,
  `/conversation/{id}/async-status`, `/conversation/{id}/rename`,
  `/backend-api/conversation/message_feedback`, `/backend-api/conversation/textdocs`,
  `gpt-conversations` (usage/gate stats key).
- Accounts/limits: `/backend-api/accounts/check/{version}`, `/backend-api/accounts/optimized/check`.
- GPTs: `gizmo_id` + `/g/…` route; `conversation_mode.kind` enum has `GizmoInteraction` and `PrimaryAssistant`.

## 5. Voice

- `/backend-api/transcribe` endpoint literal; dictation/gate keys `gpt-dictation` (feature-gate style key).
  Voice + `voice_landing` field on the send payload.

## 6. Auth & session facts for automation

- Session source: same-origin **`/api/auth/session`** fetch (`Secure`), same `cookie` jar as the app.
- Wire auth: **`Authorization: Bearer <accessToken>`** (token set onto outgoing headers when present;
  headers stripped outbound from cross-origin unless explicitly set).
- Token lifecycle: refresh triggered by the session; BANDAid pattern with a **`BroadcastChannel` named
  `auth-session`** and event `access-token-refreshed-v1`; action log `access_token_*`
  (`refresh_started` / `refresh_succeeded` / `refresh_failed_session_error` / `session_sync_*`).
  Debug helpers: `/api/debug-refresh-token`.
- Cookies referenced by name: `__Secure-oai-is` (identity/immunity), `__Secure-oai-employee-device`;
  `csrfToken` present; headers `X-OpenAI-Target-Path`, `X-OpenAI-Target-Route`, `X-OpenAI-Target-…/api/auth/session`.
- provider-catalog entries: `chatgpt-web` kind **cookie** (`Playwright storage-state JSON`) and
  `chatgpt-web-codex` kind **cookie** (`ChatGPT Cookie header (full)`).
- Datadog RUM/tracing (`dd-trace`, `datadogRumProxyEnabled: true`) — expect DD session/rum cookies too.

## 7. Verified vs to-verify split

**Verified (static, from bundles/SSR):** endpoint paths in §1–§5; SSE transport + `text/event-stream`
+ the four event-literal names; Bearer auth + `/api/auth/session` source; token-refresh BroadcastChannel;
request-body field names (`model_slug`, `conversation_mode`, `client_tools`, …); model-name literals;
`window.CanmoreNative` + Estuary endpoints; `chat.openai.com` = static placeholder page; bootstrap
flag surface.

**To verify on first live (headed) capture** (no browser allowed this run):
1. The per-chunk SSE answer event literal (delta/`response_message.delta` name is composed dynamically).
2. Which cookie/localStorage key actually materializes after `/api/auth/session` (session-token storage —
   catalog says cookie; exact name unknown; `__Secure-next-auth.*` NOT found in these bundles).
3. Builtin selectors (`#prompt-textarea`, `[data-message-author-role='assistant']`) against live DOM,
   incl. consent/`auth/login` interstitial first-run path.
4. `web_search` / `cloud_browser` / artifacts tool-shapes inside a real `/backend-api/f/conversation`
   request body.
5. `chatreq_token` — when mandatory vs optional (`prepared_only` mode boundaries).
6. Live model picker↔`model_slug(_advanced)` mapping for GPT-5.x vs o4-mini entries.

## 8. Bot-wall outcome

- **No bot wall hit** on static fetch: plain curl with a Chrome UA returned the full 572 KB SSR app
  page (200, no challenge, no `cf-chl-*` tokens, no Cloudflare interstitial) and all 15 bundles served
  normally from `/cdn/assets/…`.
- Expect anti-automation (Guardian / datadog-session checks + account-tier limits back on
  `/accounts/check/{version}`) once headless-automation signals appear — the site does gate abuse
  server-side; no client obstacle observed at the static layer.

## 9. Suggested ui2api capability list (id, one-line description)

| id | description |
|----|-------------|
| `chatgpt_chat` | Composer send + SSE-streamed answer via `/backend-api/f/conversation` (UI-path driver). |
| `chatgpt_conversation_crud` | List/get/rename/delete conversations + message existence via `/backend-api/conversation/*`. |
| `chatgpt_web_search` | Toggle `web_search`/`cloud_browser` in `client_tools` → grounded answer. |
| `chatgpt_upload_attach` | Estuary upload (`/backend-api/estuary/upload_content_bytes`, azure/aws direct strategies) + attach. |
| `chatgpt_artifacts` | Canmore artifacts/Canvas (`window.CanmoreNative`, `/conversation/{id}/textdocs`). |
| `chatgpt_gpts` | Custom-GPT chat via `conversation_mode {GizmoInteraction, gizmo_id}`. |
| `chatgpt_voice` | `/backend-api/transcribe` audio→text input. |