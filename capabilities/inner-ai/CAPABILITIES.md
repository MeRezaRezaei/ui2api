# Inner AI capabilities (from JS bundle analysis + live unauthenticated probe, 2026-09-16)

Analyzed statically (curl only, Chrome UA, no browser launched): the app SPA HTML from
`https://app.innerai.com`, its single 16,063,595-byte Vite bundle `assets/index-CNSyHRWx.js`
(downloaded in 4 capped ~4MB range chunks), the login bundle
`https://platform.innerai.com/login.0f167afe248f084794bb.bundle.js` (1.05 MB), and one
live **unauthenticated 200** probe of the public model catalog
`GET /api/v1/ai_models/index_unauthenticated`. 27 models returned.

## 0. Domain resolution (canonical host)

The catalog entry `inner-ai` (kind `cookie`, credentialName `token + email`) does not state a URL.
Candidate sweep (Chrome UA, `curl -sL`):

| candidate | result |
|---|---|
| `https://inner-ai.com` | **200 but parked** — 114 B JS `window.location.href = "/lander"`; `/lander` = GoDaddy parking lander (`LANDER_SYSTEM="PW"`, `window._trfd.push({ap:"parking"})`, `img1.wsimg.com/parking-lander`). Dead end. |
| `https://inner.ai` | no HTTPS; HTTP 301 → `https://www.innerai.com/` |
| `https://app.inner-ai.com` | no DNS |
| `https://www.innerai.com` | **200 — real product.** Next.js PT-BR marketing site: "Inner é uma plataforma de IA…" |
| `https://innerai.com`, `https://theinnerai.com` | 200; The Inner AI is a separate small site (has a `godaddy` marker), not the product |
| **app** | `https://app.innerai.com/` = the chat SPA (this package's host) |
| other | `platform.innerai.com` (login), `status.innerai.com`, `link.innerai.com`, `pages.innerai.com`, `checkout.innerai.com`, `gateway.innerai.com`, `healthcheck.innerai.com` |

**Canonical:** `https://app.innerai.com` (SPA), backed by `https://platformapi.innerai.com/api/`.
The marketed domain is innerai.com (no hyphen). `inner-ai.com` (the hyphenated spelling guessed from the
provider id) is a GoDaddy park — document that honestly: the provider-id → domain mapping must be the
no-hyphen spelling.

## 1. Chat core (models, send, streaming)

- **Send (v3 agentic chat):** `POST https://platformapi.innerai.com/api/v1/chat/messages`, body
  `{ session_id, message, document_ids?, metadata?: { capability_hint? } }`. Response:
  `{ turn_id, assistant_message_id }` (call site bundle-verified at `createMessage`).
- **Realtime:** Centrifuge client bundled in-app. Connection: `wss://chat-api-v3-ws.innerai.com/connection/websocket`
  (default; response `ws_url` overrides). Tokens: `POST /api/v1/realtime/tokens {session_id}` → `{connection_token, subscription_token}`;
  history variant: `POST /api/v1/realtime/tokens/history`. Unauthorized → 401/403 `UnauthorizedError`.
- **Turn events**: `GET /api/v1/chat/conversations/{id}/turns/{turn_id}/events?since_seq=&limit=` (seq-paginated;
  client loops pages via `next_since_seq`/`has_more` — a REST fallback to realtime). Turn cancel:
  `POST /api/v1/chat/turns/{turn_id}/cancel`. Mentions of `STREAM_STALE_THRESHOLD_MS=120000` and a 15s watchdog.
- **Legacy v2 chat** (`chatapi.innerai.com/v2/`, `chat-api-v2.innerai.com/v2/`, staging `chatapi-staging.innerai.com/v2/`):
  `sendMessageToServer({baseUrl: chatApiURL, apiPrivateKey, apiKey, fakeImei, useChatApiV2})` + EventSource SSE with
  query params `…&email=…&token=…&api_key=…&device_id=…`, events `status in completed|done` signal close. **Not** what the
  current UI drives for agentic chat (v3 is above) — keep as legacy note.
- Model catalog — **verified live (public 200, 27 models)** `GET /api/v1/ai_models/index_unauthenticated`
  (header `PRIVATE_KEY: 5xxiJxA7xC@jTLT4h`, bundled literal). Item shape: `{id (uuid), key, kind, llm_model,
  name (i18n), ai_model_categories[] (unique_identifier "text"), visible, main, recommended, can_use,
  can_read_image, pro_only, ultra_only, credits_cost, advanced_model_cost, fast_model_cost, settings}`.
  Authenticated catalog: `GET /api/v1/ai_model_categories(?category=)`. Picker writes `localStorage.llm_model`
  and POSTs `{ai_model_id}` (the final write endpoint resolves under /v1 — literal target to confirm on capture).
- Model literals found live: `gpt-5.6-luna`, `gpt-5.6-luna-fast`, `gpt-5.6-terra-thinking`, `inner-ai-assistant` (fusion),
  `claude-5-non-thinking` (Claude 5 Sonnet), `claude-sonnet-5`, `claude-4.5-haiku`, `gemini-3.8-flash`,
  `gemini-3.5-flash-lite`, `gemini-3.1-pro`, `gaia` (Google Gaia), `grok-4.6`, `grok-4.5-fast-non-reasoning`,
  `deepseek-4-pro`, `deepseek-4-flash`, `kimi-k3`, `llama-4-maverick`, `llama-4-scout`, `qwen/qwen3-32b` (QwQ),
  `glm-5.3`, `o3`, `sabia-4`, `sabia-4-thinking`, `perplexity` (Sonar), `command-r`, `amazon-nova-premier`, `gpt-oss-120b`.
  Constants: fusion = `inner-ai-assistant`; guest-mode fragment = `gemini-2.5-flash`.

## 2. Auth & session facts for automation

- Session snapshot required: cookies **`token`**, **`email`**, **`deviceId`** — read by an axios request
  interceptor (`getCookie("token")` / `getCookie("email")` / `getCookie("deviceId")`) and injected on EVERY
  platformapi call as headers **`USER-TOKEN` / `USER-EMAIL` / `DEVICE-ID`**. This is exactly the catalog's
  `credentialName: "token + email"` (deviceId is the third leg). Mirror store: `useUserStore {email, token, deviceId}`.
- Boot auth check: `GET {base}/v1/users/me` with the three headers; `handleUnauthorized` on failures.
- Login UI: `https://platform.innerai.com/login.html` — `input#email` (lowercased), `input#password`,
  `#login-button`, remember-me checkbox, social `#login-google/#login-microsoft/#login-apple`;
  `DEVICE_ID` cookie is minted client-side (device_id in localStorage/ cookie — exact ttl to verify).
- `apiBaseURL` = `https://platformapi.innerai.com/api/`, `processing.innerai.com/` (CaptionsAPI/processing),
  `service.innerplay.io` + `service-staging.innerplay.io` (legacy service host references), staging mirrors
  `platformapi-staging.innerai.com` / `platform-staging.innerai.com` / `processing-staging.innerai.com`.
- Other notable static hosts: `lambda.innerai.com/promptEnhancer`, `checkout.innerai.com`, `buy.innerai.com/pay/pro-anual-black-friday`, `go.innerai.com` (referral), `innerai-assets.s3.amazonaws.com`.

## 3. Conversation & message management

`AgentChatAPI` (bundle-verified literal set, base `https://platformapi.innerai.com/api`):
`listConversations` (GET /api/v1/chat/conversations?…), `getConversation` (…/{id}),
`getMessage` (…/messages/{message_id}), `createMessageFeedback` (…/messages/{message_id}/feedback),
`listFeedbackReasons` (GET /api/v1/chat/feedback_reasons), `cancelTurn` (POST /api/v1/chat/turns/{id}/cancel),
`getTurnEvents` (GET …/{conv}/turns/{turn}/events, since_seq/limit). Conversation object carries
`conversation_id`, `title`, `history_status`, `updated_at/created_at` (UI maps to the workspace's "agentic chat"
menu items).

## 4. Files, artifacts & workspace

- Uploads (multipart fields bundle-visible): `POST /api/v1/chat/conversations/{id}/uploads`,
  `POST /api/v1/chat/uploads/{id}/complete`, `POST …/{conv}/uploads/{upload_id}/cancel`;
  blob read `GET …/uploads/{id}/content` with optional `variant` param (images/pdfs with variants).
- Artifacts: `GET …/conversations/{id}/artifacts` (list), `GET …/artifacts/{artifact_id}`,
  `GET …/artifacts/{artifact_id}/content` (blob, `variant`), `GET …/conversations/{id}/workspace`,
  `GET …/workspace/folder_archive?path=…`.
- Jurisprudence (BR legal assistant mode!): `GET …/conversations/{id}/jurisprudence/{decision_id}`.
- Document ingestion elsewhere: `{base}/v1/spaces/{space}/documents?limit=&page=`, `DocumentsAPI.getDocumentStatus`, plus `processing.innerai.com` caption/translation (CaptionsAPI `translateSubtitle`), `MeetingsAPI` background document stream (EventSource SSE with email/token/api_key/device_id).

## 5. Other capabilities

- **Realtime history:** `POST /api/v1/realtime/tokens/history` → Centrifuge subscription; packet event seen:
  `history.conversation.deleted` (invalidation of the agent-conversations query).
- **Voice:** `GET /api/v1/get_voices` → `{voices: [{voice_id, names, previews:[{language, voiceUrl}]}]}` —
  feeds voice pickers/audio previews.
- **Prompt enhancer:** `https://lambda.innerai.com/promptEnhancer` (AI rewrites the prompt).
- **Flows / templates:** menu API `v2/menu_settings` (get/set user menu config), `v2/chat_templates` (composer templates),
  `v1/flow_groups/{id}`, `v1/prompt_templates/{id}/favorite`, `v1/spaces/…/documents`.
- **Affiliates / misc:** `v1/registered_affiliates/update_payout_pix_key`, `v1/users/register_affiliate`,
  `v1/affiliate_records?page=1&per_page=10&promo=set09`, `v1/get_voices`, `/api/1.1/wf/register_error` (Sentry-style).
- **Guest mode** exists (`guestModeChats` CSS-module strings, `GUEST_LLM_MODEL_FRAGMENT="gemini-2.5-flash"`,
  public model endpoint) — chat usable anonymously in theory, but the interceptor needs the three cookies;
  guest session shape to verify.
- Telemetry/third-party: Intercom widget, Mixpanel (`cdn.mxpnl.com`, `api-js.mixpanel.com`), CloudFront CDN.

## 6. Verified vs to-verify split

**Verified (static bundle + live probe, no browser):**
1. Canonical hosts: SPA `app.innerai.com`, API `platformapi.innerai.com/api/`, realtime
   `wss://chat-api-v3-ws.innerai.com/connection/websocket`, login `platform.innerai.com/login.html`.
2. `inner-ai.com` (hyphen) is a GoDaddy **parked** lander — dead end; use the no-hyphen spelling.
3. Auth contract: cookies `token`/`email`/`deviceId` → headers `USER-TOKEN`/`USER-EMAIL`/`DEVICE-ID` (interceptor);
   matches catalog kind=cookie credential "token + email". Login HTML inputs `#email`, `#password`.
4. Full `AgentChatAPI` endpoint + method set (§3–§4) and `createMessage` request/response shape
   (`turn_id`, `assistant_message_id`).
5. Realtime token endpoints (`/realtime/tokens`, `/realtime/tokens/history`) and Centrifuge client usage.
6. **Live 200:** public model catalog `/api/v1/ai_models/index_unauthenticated` with the bundled `PRIVATE_KEY`
   literal → 27 models incl. fusion `inner-ai-assistant`, gpt-5.6/claude-5/gemini-3.x/grok-4.x/deepseek-4/kimi-k3/etc.
7. Bot wall at static layer: **none** — plain curl + Chrome UA got the SPA shell (CloudFront from S3), the full 16 MB
   bundle, the login bundle, and the public JSON endpoint; `platformapi` returns 401 only when the credentials
   (cookies/PRIVATE_KEY) are absent.

**To verify on first live (headed) capture** (no browser allowed this run):
1. Composer + message DOM selectors — SPA is hashed CSS-modules; profile.json selectors are **UNVERIFIED**
   generic candidates ([contenteditable=true], textarea, role=textbox, `[data-message-role='assistant']`).
2. Centrifuge **channel naming** and per-turn event schema (what the subscription pushes vs what `getTurnEvents` returns).
3. Cookie-set materialization after login (are `token`/`email`/`deviceId` httponly? secure domain `innerai.com`? TTL; `/api/v1/users/me` flow on boot).
4. Where the final model-select POST targets under `/v1/…` (picker writes `localStorage.llm_model` + `{ai_model_id}`).
5. Guest-mode chat viability (cookieless session shape) — catalog assumes logged-in cookie auth regardless.
6. Legacy v2 SSE chat (`chatapi.innerai.com/v2/`) — deprecated in favor of v3; skip unless v3 disabled.

## 7. Bot-wall outcome

- **No bot wall hit** on static probing: CloudFront+S3 edge serves `app.innerai.com` SPA shell + 16 MB bundle freely
  with a plain Chrome UA; `platform.innerai.com/login.html` and `login.*.bundle.js` also freely served; the public
  model endpoint answers 200 with only the bundled `PRIVATE_KEY` header.
- Server-side gating is by credentials: `platformapi` 401s anonymous calls (expected). No Cloudflare challenge,
  no `cf-chl-*`, no captcha at the fetched layers. Whether automation triggers risk signals behind auth (quotas,
  device-fingerprint checks per `deviceId`) is unknown — the SPA mints its own deviceId, so a fresh session
  snapshot should look like a normal device.

## 8. Suggested ui2api capability list (id, one-line description)

| id | description |
|----|-------------|
| `inner_ai_chat` | Composer send → Centrifuge-streamed answer (REST `POST /v1/chat/messages` → `{turn_id,...}`; seq-paginated `turns/{id}/events` fallback). |
| `inner_ai_conversations` | Conversation/message CRUD: list/get conversations, messages, feedback reasons + feedback, cancelTurn. |
| `inner_ai_models` | Public 27-model catalog (`/v1/ai_models/index_unauthenticated`, PRIVATE_KEY literal) + picker set via `{ai_model_id}`/`llm_model`. |
| `inner_ai_files` | Upload lifecycle + blob read (`uploads`, `artifacts`, workspace/folder_archive) + jurisprudence. |
| `inner_ai_realtime_history` | Centrifuge history subscription from `/v1/realtime/tokens/history` (event `history.conversation.deleted`). |
| `inner_ai_voice` | Voice catalog (`/v1/get_voices`) + prompt enhancer (`lambda.innerai.com/promptEnhancer`). |