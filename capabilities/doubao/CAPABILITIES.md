# CAPABILITIES.md — Doubao (豆包)

> **Provider:** doubao (ByteDance)
> **Status:** `awaiting-capture` — static-only analysis via curl + bundle dissection; no browser launched
> **Last updated:** 2026-09-16
> **Source:** `https://www.doubao.com/chat/` (SSR HTML → Modern.js route manifest → 949 async chunks)

---

## 1. Overview

Doubao is ByteDance's consumer AI chat platform, built on the Modern.js framework (Goofy Node / React SSR). The web app is same-origin (`https://www.doubao.com`), uses ByteDance's **Frontier WebSocket** protocol (`pbbp2`) for IM and real-time, and the **Alice gateway** (`/alice/*`) for HTTP API operations. Chat completion goes through `POST /samantha/chat/completion` with SSE streaming.

---

## 2. Transport

### 2.1 HTTP API (Alice Gateway)
- **Base:** same-origin `https://www.doubao.com`
- **Method:** POST
- **Content-Type:** `application/json`
- **Common header:** `Agw-Js-Conv: str`
- **Auth:** cookie-based (`sessionid`, `ttwid`, `s_v_web_id`)
- **Anti-bot:** `byted_acrawler` library generates `X-Bogus`, `X-MS-STUB` headers
- **Request signing:** `device_platform: "web"`, `aid` (wsAppId), `device_id`, `version_code`

### 2.2 Chat Completion (SSE)
- **Endpoint:** `POST /samantha/chat/completion`
- **Request body:** JSON with conversation data (via `(0,s.B)` body builder)
- **Response:** SSE stream, handled by `onMessage` callback
- **Event name:** `stream_call_bot`
- **Interceptors:** `tlb429ErrorInterceptor` (429 handling), `sseLogoutInterceptor`
- **Credentials:** `same-origin`

### 2.3 WebSocket (Frontier Protocol)
- **URL:** `wss://www.doubao.com/ws/v2`
- **Protocol:** `pbbp2` (binary framed)
- **Params:** `fpID` (wsProductId), `accessKey` (wsAccessKey), `aID` (wsAppId), `ttwID` (ttwid), `version_code`, `device_platform`
- **Frame types:** 16 (data), 32 (cursor/QoS)
- **Message envelope:** `SeqID`, `LogID`, `service` (numeric), `method`, `headers[]` (key/value), `payloadType` (e.g. `application/json`), `payloadEncoding`, `payload` (binary)
- **QoS:** cursor-based dedup, auto-ACK, IndexedDB persistence (`frontier_*` stores)
- **Config:** `im/launch` response provides `wsProductId`, `wsAccessKey`, `wsAppId` per session

---

## 3. API Endpoints (Verified in Bundles)

### 3.1 Chat & Messages
| Endpoint | Description | Verified |
|---|---|---|
| `POST /samantha/chat/completion` | Main chat completion (SSE) | ✅ s2-chat-runtime |
| `POST /alice/message/stream_call_bot` | Message streaming (Alice API) | ✅ 14852.4d22807a.js |
| `POST /alice/message/stream_reply` | Stream reply for existing messages | ✅ 14852 |
| `POST /alice/message/list/v2` | Paginated message list | ✅ 14852 |
| `POST /alice/message/content` | Get message content | ✅ 14852 |
| `POST /alice/message/pre_handle_v2` | Pre-send validation/processing | ✅ 14852 |
| `POST /alice/message/pre_handle_v2_without_conv` | Pre-handle without conversation context | ✅ 14852 |
| `POST /alice/message/put_chat_record` | Save chat record | ✅ 14852 |
| `POST /alice/message/rate_limit` | Rate limit info | ✅ 14852 |
| `POST /alice/message/report` | Message abuse/feedback report | ✅ 14852 |
| `POST /alice/message/cmd_list` | Message command list | ✅ 14852 |
| `POST /alice/message/get_reply` | Get reply for a message | ✅ 14852 |
| `POST /alice/message/replay` | Replay a message | ✅ 14852 |
| `POST /alice/message/update_content` | Edit message content | ✅ 14852 |
| `POST /alice/message/update_record` | Update message record | ✅ 14852 |

### 3.2 Deep Research
| Endpoint | Description | Verified |
|---|---|---|
| `POST /alice/message/deep_research/get` | Get deep research results | ✅ 14852 |
| `POST /alice/message/deep_research/retry` | Retry deep research | ✅ 14852 |
| `POST /alice/message/deep_research/share` | Share deep research output | ✅ 14852 |

### 3.3 Conversations
| Endpoint | Description | Verified |
|---|---|---|
| `POST /alice/conversation/list` | List conversations | ✅ 14852 |
| `POST /alice/conversation/info` | Get conversation info | ✅ 14852 |
| `POST /alice/conversation/update` | Update conversation | ✅ 14852 |
| `POST /alice/conversation/pin` / `unpin` | Pin/unpin conversation | ✅ 14852 |
| `POST /alice/conversation/clear` | Clear conversation | ✅ 14852 |
| `POST /alice/conversation/archive` | Archive conversation | ✅ 14852 |
| `POST /alice/conversation/mark_conversation_read` | Mark as read | ✅ 14852 |
| `POST /alice/conversation/latest_messagelist` | Latest messages per conversation | ✅ 14852 |
| `POST /alice/conversation/add_bot` | Add bot to conversation | ✅ 14852 |
| `POST /alice/conversation/create_sub_conversation` | Create sub-conversation | ✅ 14852 |
| `POST /alice/conversation/create_section` | Create section divider | ✅ 14852 |
| `POST /alice/conversation/report` | Report conversation | ✅ 14852 |
| IM via WS: `/im/conversation/batch_get` | Batch get conversation info | ✅ 79cfb1f3 |
| IM via WS: `/im/chain/single` | Pull single conversation chain | ✅ 5cf8352e |

### 3.4 Bots & Skills
| Endpoint | Description | Verified |
|---|---|---|
| `POST /alice/bot/create` | Create custom bot | ✅ 14852 |
| `POST /alice/bot/get_bot` | Get bot details | ✅ 14852 |
| `POST /alice/bot/get_bot_list` / `v2` | List bots | ✅ 14852 |
| `POST /alice/bot/update_bot` | Update bot settings | ✅ 14852 |
| `POST /alice/bot/enrich` | Enrich bot with context | ✅ 14852 |
| `POST /alice/bot/recommend` | Recommended bots | ✅ 14852 |
| `POST /alice/bot/discover` | Discover bots | ✅ s2-chat-runtime |
| `POST /alice/bot/skill_cards` | Get skill cards | ✅ 14852 |
| `POST /alice/bot/action_bar_list` | Action bar items | ✅ 14852 |
| `POST /alice/bot/action_bar_v3/list` | Action bar v3 config | ✅ 14852 |
| `POST /alice/bot/plugin_list` | Plugin list | ✅ 14852 |
| `POST /alice/bot/plugin_auth` | Plugin auth check | ✅ 14852 |
| `POST /alice/bot/coco/settings` | Coco bot settings | ✅ 14852 |
| `POST /alice/bot/first_met` | First interaction event | ✅ 14852 |
| `POST /alice/bot/clear_memory` | Clear bot memory | ✅ 14852 |
| `POST /alice/bot/insert_memory` | Insert memory entry | ✅ 14852 |
| `POST /alice/bot/list_memory` | List memory entries | ✅ 14852 |
| `POST /alice/bot/url-action` | URL action handler | ✅ s2-chat-runtime |

### 3.5 Image Generation & Search
| Endpoint | Description | Verified |
|---|---|---|
| `POST /alice/aippt/gen_images` | Generate images | ✅ 14852 |
| `POST /alice/aippt/search_images` | Search images | ✅ 14852 |
| `POST /alice/aippt/images/ai_edit_prompts/sse` | AI edit prompts (SSE) | ✅ 14852 |
| `POST /alice/aippt/images/recommend_prompts/sse` | Recommend prompts (SSE) | ✅ 14852 |
| `POST /alice/aippt/images/search_keywords/sse` | Search keyword suggestions (SSE) | ✅ 14852 |
| `POST /alice/aippt/template_list` | PPT templates | ✅ 14852 |
| `POST /alice/aippt/template/detail` | PPT template detail | ✅ 14852 |
| `POST /alice/aippt/share_info` | Share image/PPT info | ✅ 14852 |

### 3.6 Audio & Voice
| Endpoint | Description | Verified |
|---|---|---|
| `POST /alice/audio/launch` | Initialize audio session | ✅ 14852 |
| `POST /alice/audio/conf_detail` | Audio config detail | ✅ 14852 |
| `POST /alice/audio/conf_create_bot_voice` | Create custom voice | ✅ 14852 |
| `POST /alice/audio/conf_save_user_bot_voice` | Save user voice | ✅ 14852 |
| `POST /alice/audio/create_query_pair` | Create voice query pair | ✅ 14852 |
| `POST /alice/audio/get_dora_vision_settings` | Dora vision settings | ✅ 14852 |
| `POST /alice/audio/voice_feedback` | Voice feedback | ✅ 14852 |
| `POST /alice/audio/social/get_audio_url` | Get shared audio URL | ✅ 14852 |
| `POST /alice/audio/rtc/token` | RTC token for live voice | ✅ 14852 |
| `POST /alice/user_voice/clone` | Voice clone | ✅ 14852 |
| `POST /alice/user_voice/create` / `v2` | Create custom voice | ✅ 14852 |
| `POST /alice/user_voice/list` | List saved voices | ✅ 14852 |

### 3.7 Office / Skills / Tools
| Endpoint | Description | Verified |
|---|---|---|
| `POST /alice/office/skills/list_my` | My installed skills | ✅ 14852 |
| `POST /alice/office/skills/manage/store/list` | Skill store listing | ✅ 14852 |
| `POST /alice/office/skills/manage/install` | Install skill | ✅ 14852 |
| `POST /alice/office/skills/manage/uninstall` | Uninstall skill | ✅ 14852 |
| `POST /alice/office/skills/manage/create` | Create custom skill | ✅ 14852 |
| `POST /alice/office/asset/import/start` | Start file import | ✅ 14852 |
| `POST /alice/office/asset/import/count` | Import file count | ✅ 14852 |
| `POST /alice/office/tool_local/upload_command_result` | Code interpreter result upload | ✅ 14852 |
| `POST /alice/office/tool_local/chunk_stream` | Code interpreter chunked output | ✅ 14852 |

### 3.8 Writing
| Endpoint | Description | Verified |
|---|---|---|
| `POST /alice/writing/docs/list` | List writing docs | ✅ 14852 |
| `POST /alice/writing/docs/batch_meta` | Batch doc metadata | ✅ 14852 |
| `POST /alice/writing/styles/list` | List writing styles | ✅ 14852 |
| `POST /alice/writing/auth/gen_url` | Generate auth URL for writing | ✅ 14852 |
| `POST /alice/writing/doc/download` | Download writing doc | ✅ 14852 |

### 3.9 Commerce & Account
| Endpoint | Description | Verified |
|---|---|---|
| `POST /alice/user/launch` / `core` | User launch (init session) | ✅ 14852 |
| `POST /alice/user/get_account_info` | Get account info | ✅ 14852 |
| `POST /alice/user/config/pull` / `sync` | User config sync | ✅ 14852 |
| `POST /alice/auth/grant` / `verify` | Auth grant/verify | ✅ 14852 |
| `POST /alice/basic/launch` | Basic launch (pre-auth) | ✅ 14852 |
| `POST /alice/commerce/sale/subscription/status` | Subscription status | ✅ 14852 |
| `POST /alice/commerce/sale/trade/create` | Create purchase trade | ✅ 14852 |
| `POST /alice/account_manager/logout` | Logout | ✅ 14852 |

### 3.10 Search
| Endpoint | Description | Verified |
|---|---|---|
| `POST /alice/search/query` | Search query | ✅ 14852 |
| `POST /alice/search/launch` | Initialize search | ✅ 14852 |
| `POST /alice/comprehensive/search` | Comprehensive search | ✅ 14852 |
| `POST /alice/aispace/facade/get_user_storage` | User storage info | ✅ 14852 |

### 3.11 Media & Video
| Endpoint | Description | Verified |
|---|---|---|
| `POST /alice/media/video_model` | Video model selection | ✅ 14852 |
| `POST /alice/media/source/2`/`3`/`4` | Media source streams | ✅ 14852 |
| `POST /alice/media/bigmusic/lyrics` | Music lyrics | ✅ 14852 |
| `POST /alice/media/card_search` | Media card search | ✅ 14852 |

### 3.12 Share & Export
| Endpoint | Description | Verified |
|---|---|---|
| `POST /alice/message/share/save` | Save shared message | ✅ 14852 |
| `POST /alice/message/share/get` | Get shared message | ✅ 14852 |
| `POST /alice/message/export/save` / `get` | Export conversation | ✅ 14852 |
| `POST /alice/message/webpage/share` | Webpage share | ✅ 14852 |

---

## 4. Key Modules (Route Manifest)

### 4.1 Chat Core
- `s2-chat-runtime` → `static/js/async/s2-chat-runtime.08092a45.js` (531 KB) — Main chat runtime, `/samantha/chat/completion`
- `s2-chat-runtime-sse-request-context-service` → `s2-chat-runtime-sse-request-context-service.f99cc10e.js` (1.4 KB) — SSE request meta builder
- `async-infra-message-cmd` → `async-infra-message-cmd.5cf8352e.js` (313 KB) — IM message command service
- `s2-im-sdk-runtime` → `s2-im-sdk-runtime.9c49d2ba.js` (102 KB) — IM SDK with WS commands
- `s2-chat-im-service-runtime` → `s2-chat-im-service-runtime.13e9d700.js` (10 KB) — Chat IM service

### 4.2 Submit Pipeline
- `async-business-input-engine-submit` → `async-business-input-engine-submit.b2f13c42.js` (468 KB) — Input submission
- `s2-submit-pipeline` → `s2-submit-pipeline.ea5f2fa4.js` (49 KB) — Pipeline engine (preSubmit/submit/afterSubmit)
- `s2-submit-runtime` → `s2-submit-runtime.fa6d8446.js` (16 KB) — Submit runtime
- `s2-input-engine-submit-runtime` → `s2-input-engine-submit-runtime.f0eedb17.js` (5 KB) — Submit runtime with node timeout handling
- `s2-submit-node-generate-message` → `s2-submit-node-generate-message.c49a13a9.js` (61 KB) — Message generation node

### 4.3 WebSocket / IM
- `s2-lib-socket-client-default` → `s2-lib-socket-client-default.cc92cba0.js` (72 KB) — Frontier WebSocket client (pbbp2, cursor QoS, IndexedDB persistence)
- `s2-lib-socket-client-worker` → `s2-lib-socket-client-worker.c38c5d25.js` (83 KB) — WebSocket worker thread

### 4.4 Conversation Management
- `s2-conversation-list-v2-service` → `s2-conversation-list-v2-service.79cfb1f3.js` (40 KB) — Conversation list/batch_get
- `use-create-new-chat` → `use-create-new-chat.011cf28e.js` (2 KB) — New chat creation

### 4.5 Account & Auth
- `s2-account-dialog` → `s2-account-dialog.fe832016.js` (35 KB) — Login dialog
- `s2-account-shell-api` → `s2-account-shell-api.0dd92248.js` (22 KB) — Account API shell
- `s2-account` → `s2-account.03f04fbc.js` — Account management

### 4.6 Model Selection
- `s2-model-select-v2-entry` → `s2-model-select-v2-entry.e0ddb53c.js` (20 KB) — Model selector
- `54528.f4159fc9.js` (42 KB) — Model select dependencies

### 4.7 Shared Infra (used by many features)
- `14852.4d22807a.js` (235 KB) — Core API service (Alice gateway), all `/alice/*` endpoint methods
- `93476.c9134aa7.js` (50 KB) — Shared dependency (auth, routing)
- `93823.42dec5fe.js` (56 KB) — Shared IM dependencies
- `6411.7e5c9ba4.js` (445 KB) — Heavy shared chunk (UI components, auth)

---

## 5. Auth & Anti-Bot

### 5.1 Cookies
- `sessionid` — session identifier (primary auth)
- `ttwid` — ByteDance tracking ID (set by `POST https://ttwid.bytedance.com/ttwid/union/register/`)
- `s_v_web_id` — Visitor web ID

### 5.2 Request Signing
- **X-Bogus**: generated by `byted_acrawler` library (loaded from ByteDance CDN)
- **X-MS-STUB**: additional anti-bot header
- **device_platform**: `"web"`
- **version_code**: hardcoded in JS config
- **aid**: application ID (wsAppId)

### 5.3 Auth Flow
- Pre-login page returns `set-cookie: ttwid` on `.doubao.com`
- Login gate: page copy `"豆包，现在登录即可免费使用！"` blocks unauthenticated usage
- Auth domains: `accounts.doubao.com`, `accounts.feishu.cn`
- SMS login visible: `zjsms.com` referenced

### 5.4 WebSocket Auth
- Connection params include `ttwid`, `accessKey` (from im/launch), `fpID` (product ID), `aID` (app ID)
- `/alice/im/launch` returns: `ws_product_id`, `im_launch_config`, `messageServiceId`

---

## 6. Session State

```json
{
  "provider": "doubao",
  "url": "https://www.doubao.com/chat/",
  "status": "awaiting-capture",
  "loginRequired": true,
  "botWall": false,
  "reason": "Static-only analysis complete; browser capture needed for auth flow verification and UI selector grounding"
}
```

---

## 7. Feature Flags (Confirmed in Bundles)

| Feature | Module | Verified |
|---|---|---|
| Chat (text) | s2-chat-runtime | ✅ |
| Image generation (Seedance 2.0) | ai_image-* chunks | ✅ chunk names |
| Video generation | media/video_model | ✅ 14852 |
| Web search | search/* endpoints | ✅ 14852 |
| Deep research | message/deep_research/* | ✅ 14852 |
| Code interpreter | office/tool_local/* | ✅ 14852 |
| Canvas | ai-canvas-* chunks | ✅ chunk names |
| Document analysis | ai-space-*-url-parse-plugin | ✅ chunk names |
| Audio/voice | audio/*, user_voice/* | ✅ 14852 |
| PPT generation | aippt/* | ✅ 14852 |
| Writing styles | writing/* | ✅ 14852 |
| Office file import | office/asset/import/* | ✅ 14852 |
| Skills/plugins | office/skills/*, bot/plugin_* | ✅ 14852 |
| Cron jobs | job_cron/* | ✅ 14852 |
| Dispatch (devices) | dispatch/* | ✅ 14852 |
| Safety/reporting | safety/* | ✅ 14852 |
| Commerce/subscriptions | commerce/* | ✅ 14852 |

---

## 8. Named Chunks — Plugin Inventory

| Chunk Name | Asset JS File | Purpose |
|---|---|---|
| ai-coding-open-canvas-repo-plugin | ai-coding-open-canvas-repo-plugin.e8a07ef4.js | Canvas repo plugin |
| ai-coding-open-canvas-repo-pre-plugin | ai-coding-open-canvas-repo-pre-plugin.4057da15.js | Canvas pre-plugin |
| ai-ppt-push-message-cmd | ai-ppt-push-message-cmd.17e2551e.js | PPT message command |
| ai-search-skill-chat-input | ai-search-skill-chat-input.5d25e2da.js | Search skill input |
| ai-sheet-push-message-cmd | ai-sheet-push-message-cmd.9b83aaee.js | Sheet message command |
| ai-space-audio-player | ai-space-audio-player.91688a70.js | Audio player |
| ai-space-coding-url-parse-plugin | ai-space-coding-url-parse-plugin.ef5955d6.js | Coding URL parser |
| ai-space-doccanvasopenurl-url-parse-plugin | ai-doccanvasopenurl-url-parse-plugin.8b195ee8.js | Doc canvas URL parser |
| ai-space-imagecreate-url-parse-plugin | *(search manifest)* | Image create URL parser |
| ai-space-excelairead-url-parse-plugin | *(search manifest)* | Excel AI read |
| ai-space-fileairead-url-parse-plugin | *(search manifest)* | File AI read |
| ai-space-fileaskdoubao-url-parse-plugin | *(search manifest)* | File ask Doubao |
| ai-space-imageaskdoubao-url-parse-plugin | *(search manifest)* | Image ask Doubao |
| ai-space-imageedit-url-parse-plugin | *(search manifest)* | Image edit |
| ai-space-linkairead-url-parse-plugin | *(search manifest)* | Link AI read |
| ai-space-linkaskdoubao-url-parse-plugin | *(search manifest)* | Link ask Doubao |
| ai-space-mediaread-url-parse-plugin | *(search manifest)* | Media read |
| ai-space-minutemetting-url-parse-plugin | *(search manifest)* | Meeting minutes |
| ai-space-wordfileread-url-parse-plugin | *(search manifest)* | Word file read |

---

## 9. Open Questions (for live capture)

1. **SSE data format** — what is the exact event payload structure returned by `/samantha/chat/completion`? (need live streaming capture)
2. **Composer DOM selector** — `s2-input-engine-editor-v2-host` renders a contenteditable; exact CSS selector unknown until live DOM inspection
3. **Answer container selector** — the response text container DOM class/id is not deterministic from bundle analysis
4. **Model names** — model config is fetched dynamically from API at runtime; `Seedance 2.0` confirmed in title, but chat model IDs (e.g. `doubao-seed-1.6`, `doubao-pro-32k`) are loaded via `/alice/slot/*` or bot config
5. **Conversation creation flow** — whether `POST /alice/conversation/list` returns existing conversations or new-chat goes through `POST /alice/conversation/update` with a temp ID
6. **Cookie acquisition** — `ttwid` is set by a registration POST; `sessionid` and `s_v_web_id` require login; exact cookie-setting flow needs live capture

---

## 10. Files

| File | Size | Description |
|---|---|---|
| `manifest.json` | package manifest |
| `profile.json` | transport/auth/feature config |
| `session.lock.json` | session lock (kimi shape) |
| `recipes/doubao_chat.json` | chat recipe (gemini schema) |
| `CAPABILITIES.md` | this file |
