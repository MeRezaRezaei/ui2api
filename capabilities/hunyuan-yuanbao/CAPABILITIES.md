# Hunyuan / Yuanbao capabilities (from JS bundle analysis, 2026-09-15)

Source: passive analysis of `https://yuanbao.tencent.com/` (HTTP 200, final URL unchanged) and 16 Next.js webpack chunks downloaded from `https://static.yuanbao.tencent.com/_next/static/chunks/`. Only bundled JS was inspected; no requests were executed against the API. Bundle legend used below:

- `api-util` = `yb_v2_yb-util.a63b4fee0b6f4b02.js` (env/API const map)
- `chat-util` = `yb_v2_yb-chat.6b8a3ec74608878d.js` (chat/tool-call render logic)
- `_app` = `yb_v2_pages/_app.4d5cb8ed18c27aaa.js` (SSE/XHR client, feature-flag config, agent API map)
- `index` = `yb_v2_pages/index.c4cdd1b811b80c16.js` (homepage/chat submit, model selector)
- `component` = `yb_v2_yb-component.a1e230e3a891ea4a.js`

---

## 1. Chat core (Hunyuan 3 models, thinking mode, streaming)

**UI trigger:** the single web page `/` and `/chat/*` routes = one chat input box (Quill editor with `quillFocusHold`, file chips, plus-panel) that submits to the backend; model picker in the input area; anonymous visitors get `showLoginModalWhenAnonAsk`.

**Transport (streaming SSE via XHR):**
- Chat submit POST endpoint: `https://yuanbao.tencent.com/api/chat/` (`API_CHAT`), answers streamed over a vendored **SSE-over-XHR** client (`custom_sse`, chunk parsing with field separator, `event:` / `data:` lines, dispatch of `CustomEvent("message")`). No native `EventSource`; controlled by global config `custom_sse_xhr_instance`.
- `_app` streaming-status enum: `START_CHAT → LOGIN → FIRST_RECEIVE_DATA → FINISH_CHAT → CHAT_ERROR / CHAT_TIMEOUT / PARSE_DATA_FAIL / SSE_REQUEST_FAIL / SSE_PROGRESS_FAIL`. So chat results flow through this single endpoint regardless of model or mode.
- Response headers used as stream ids: `x-traceid`, `x-answer-msgid`, `x-query-msgid`.
- Streaming chunk `content[].type` values handled by `chat-util`: `text`, `step`, `continue_step`, `page`, `middle_message` / `middle_messages`, `doc_percent`, `deepSearch`, `deep_think_box`, `searchGuid`, `progress`, `yuanqi_tool_call`, `toolCall`, `docDeepModeInfo`, `status`, `tips`, `card`, `news`, `error`, `voice_recorder`, `reasoner` (chain-of-thought), `deep_search` (CoT), `ai_search_pro`/`ai_search_pro_fin` (deep-search cards), `docDeepReadCard`.
- Per-session replay/stop endpoints: `API_REPEAT /api/chat/repeat/:chatId`, `API_STOP_CHAT /api/stop/chat`, `API_STOP_CONVERSATION /api/stop/conversation` (+ `…/relation_convs` for comparison mode), `API_SUITABLE /api/ai/suitable`, `API_COMPLAIN /api/ai/complaint`, `API_CHAT_FEEDBACK /api/ai/feedback`, `API_SET_REPEAT_INDEX /api/user/agent/conversation/selectRepeatIndex`.

**Models & modes:**
- Model lease endpoint `API_MODELS /api/models` and `GET_MODEL_LIST /api/agent/model/list`; `index` page merges model objects with `chatModelId`, optional `subModelList`, and `agentModeModelList` (finds by `modelId`), each model can carry an `internetSearch` capability flag. The browser remembers the last pickup in localStorage key `"{userId}_chatModelExtInfo"`.
- Model-id strings observed in bundles: `hunyuan` (plain), `hunyuan_gpt_175B_0404`, `hunyuan_t1`, plus Tencent-hosted `deep_seek`, `deep_seek_v3`, `deep_seek_v4`, `deep_seek_v4_thinking`, `gpt_oss`; URL-query parameter `modelId=` is honoured (`YB_ASK_AI_MODEL_ID`). `index` page exposes a `[{modelId, modelType:"fastThink"},{modelId, modelType:"deepThink"}]` switch → **fast-think / deep-think toggle** per model.
- Chat "scene"/mode values sent as content or chosen per conversation: `default`, `ai_search_light`, `ai_search_pro`, `ai_search_deepseek`, `yuanqi`, `ai_writing`, `ai_search_text_2_image`, `ai_search_image_2_image`, `ai_search_image_2_video`. App-flavoured `applicationId` enum: `application_id_web_search / knowledge_search / ai_image / wa_ai_image / ai_coding / meeting / ai_reading / ai_answering / ai_writing / ppt_generation / professional_writing / teaching_assistant / data_analysis / investment_analysis / personal_plan / working_agent`.
- Input-guide (suggestions/prompt templates): `/api/inputguide/sug`, `/api/inputguide/list`, `/api/inputguide/v2/agentSkills`, `/api/discovery/goodquestionrec`.

**Request/response shape (from code, not executed):** request bus is axios instances created with `withCredentials: true` and JSON headers; chat SSE body is JSON, and the server responds `event: message, data: <json>` chunks; per-`content[].type` renderers exist (see above) rather than a simple delta string — capability/modality is encoded in `type`, not in endpoint variation.

**Gating:** `app_chat_config` / `isWaitChatStart`, `showLoginModalWhenAnonAsk`, `allowAnonDeepSearchNavigateOnAskDone`; per-model `internetSearch` flag; `uploaderTypeList` limits accepted file kinds.

---

## 2. Web search / internet mode

**UI trigger:** "联网" (internet) mode toggle on the input box + AI-search entry (`inputguard` ask bar), plus deep-search cards inside chat.

**Mechanics:** chat-mode scenes (`ai_search_light`, `ai_search_pro`, `ai_search_deepseek`, default → hunyuan web search) are set on submit; model objects carry an `internetSearch: boolean` flag; a global event `INTERNET_SEARCH_CHANGE_EVENT` toggles it; search mode preference is persisted as `YB_ASK_AI_SEARCH_TYPE_NETWORK`.

**Search tool names seen in stream (`toolCallName`):** `hunyuan_web_search`, `google_web_search`, `paper_search`, `flight_ticket_search`, `hotel_search`, `train_ticket_search`, `vlm_deepthink_image_search`, plus customer-service search (`thirdparty_intervention_search`).
Search render sets:
- `A = {"google_web_search","paper_search","hunyuan_web_search","flight_ticket_search","hotel_search","train_ticket_search"}` → rendered as search-result cards (`docs`, `state` per-step).
- `L = {"google_web_search","paper_search","hunyuan_web_search"}` → deep-search CoT cards.

**API surface:**
- `GET_AI_SEARCH_LIST /api/inputguide/search/list`, `GET_AI_SEARCH_SESSION_ID /api/inputguide/search/create`, `GET_AI_SEARCH_TYPE_LIST /api/inputguide/searchtype/list` (AI-search session provisioning; `searchType=` URL param stored as `YB_ASK_AI_SEARCH_TYPE_NETWORK`).
- `/api/search/global` (`GET_SEARCH_GLOBAL`) for site-wide global search.
- `hot_search` / `intervention_search` strings confirm search-suggestion fallbacks.

**Gating:** `ai_search_pro` and `allowAnonDeepSearchNavigateOnAskDone` flags; search mode appears model-dependent (DeepSeek scene `ai_search_deepseek`); expects real logged-in session cookies.

---

## 3. Document & file analysis (the headline capability — detail it deeply)

**UI triggers:**
- File chips on the chat input (plus-panel `input-upload`, per-file **upload → parsing → speaking** statuses `SPEAKING/STOPPING/SPLIT/UPLOADING/PARSING`), accepted types from `uploaderTypeList`: `pdf:"capture=filesystem,.pdf,.txt,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv"` (PDF first, one document per turn — toast "一次仅可上传一个文档").
- **深度阅读 / Deep Reading**: dedicated tool page `/tool/deep-reading` (+ `/tool/deep-reading/detail`), registered routes `READER`, `FILE_VIEWER`, `DEEP_READING`, `DEEP_READING_DETAIL`, `HISTORY`; flag `third_party_deep_reading` sets `onDeepReading` with prompt "深度阅读以下文档" (deep-read this document), `fileId/fileSize/fileType/fileName`, `autoSubmit: true`, and file bytes supplied via a `getFile()` callback. Status enum for doc analysis: `NORMAL / READING / TRANSLATION / SUMMARY / GUIDE / DEEP_SEARCH`.

**Upload & parse pipeline (client flow):**
1. `API_GENERATE_COS_KEY /api/resource/genUploadInfo` (white-listed as `/api/resource/genWxUploadInfo` too) → grants a COS upload write for the file; `tencentFileUpload` mode (also `SHARE_N_SAVE_IMG` app capability).
2. File bytes go straight to Tencent COS buckets — observed hosts `hunyuan-*` prod/test CDNs (`https://hunyuan-prod*`, `https://hunyuan-test*` white-listed), `https://xj-psd-1258344703.file.myqcloud.com/image`, `https://hunyuan-base-prod-1258344703.cos.ap-guangzhou.myqcloud.com`. `media_upload` event + `/api/upload/*`, `/api/file/*` are pre-chat white-listed.
3. Parsing is announced to the chat backend, then documents are force-referenced on the turn: `API_CHAT_FILE_PARSE /api/resource/fileParse` (sync) and `API_CHAT_FILE_PARSE_ASYNC /api/resource/asyncFileParse`; per-resource asset queries `/api/resource/download`, `/api/resource/v1/download` (COS signed read), `/api/resource/public/download`, `/api/resource/check/status`; `disable_preload_file` flag gates prefetch.
4. Streaming progress during analysis rides the chat stream as `doc_percent`, `docDeepModeInfo`, `step` chunks.

**Returned artifacts per conversation**, via `_app` agent API map:
- Mind-map: `GET_MIND_MAP /api/user/agent/doc/getMindMap`, share `GET_DOC_MINDMAP_SHARE_INFO /api/user/agent/doc/mindMap/share`.
- Translation of the doc: `AGENT_DOC_TRANSLATE /api/user/agent/doc/translate`, «summary/translation» modes `TRANSLATION/SUMMARY`, share `GET_DOC_TRANSLATE_SHARE_INFO /api/user/agent/doc/translate/share`, download `GET_DOC_DOWNLOAD_DEEP_TRANSLATE /api/user/agent/doc/translate/download`.
- Download of deep-read output: `GET_DOC_DOWNLOAD_DEEP /api/user/agent/doc/download`.
- Doc chat provenance records: `GET_DOC_CHAT_RECORD /api/user/agent/docChatRecord/query`, `…/queryMsg`, `…/visit`, `GET_V2_DOC_CHAT_RECORD /api/user/agent/v2/docChatRecord/query`, `DELETE_CHAT_RECORD_FILE /api/user/agent/docChatRecord/delete`.
- Tencent Docs integration: `GET_TX_DOC_LIST /api/user/docs/list`, `GET_TX_DOC_V2_LIST /api/user/docs/v2/list`, `SEARCH_DOC /api/user/docs/search`, `API_USER_DOCS_V2 /api/user/docs/v2/filter`, `DELETE_DOC /api/user/docs/delete`, `GET_TEN_DOC_EXPORT /api/user/docs/upload`, `GET_TEN_DOC_EXPORT_FILE /api/user/docs/file/upload`, `API_RESOURCE_TENCENT_DOC_TEMP_LINK /api/resource/getTencentDocTempLink`, `/extra/tencent-doc` proxy; docs-opening flow reads a `docsUrl` and handles “Tencent doc authorization expired”.

**Gating:** account/WeChat binding required for some doc features (`/api/user/docs/account/detail|bind|unbind`), `deep_reading_button` flag, `hide_tx_doc`, `show-tencent-doc`, `!/safe/restricted-access` ignore in the URL-blocker list, and the `uploaderTypeList` allow-list. Deep-read runs inside the same authenticated chat stream.

---

## 4. Image generation

**UI trigger:** "AI 生图" (draw) via chat (search-mode `ai_search_text_2_image` / `ai_search_image_2_image` / `ai_search_image_2_video` scenes, `draw_with_search`/`draw_with_image` message cards) and image-workbench buttons (text_to_image_operations, image_agent_button).

**Chat-native draw:** `_app` enum `text_to_image_operations` enables the image panel; draw results stream as `image_with_text`, `image-group`, `image_with_3d` (3D), `figure-to-video` (face→video), `multimodal`, `video_asset`; status `running/success/error`; per-image on-chain gen events `perf_creation_image`, `perf_image`, `evt/image`.

**Dedicated image agent APIs (`_app`):**
- `/api/vision/draw` (vision/draw family), `/api/user/agent/imageGenerate/getImage` (`GET_CHART_OPTION`), `/api/image/intention/*` (generate/update/status), `/api/image/resource/review`, `/api/image/goodcase/get`.
- Editing toolkit: `/api/image/clarity` (enhance), `/api/image/style`, `/api/image/outpainting`, `/api/image/elimination`, `/api/image/removewatermark`, `/api/image/search`, `/api/image/bubble/*`, `/api/image/edit/asset/save|list|delete`, `GALLERY_SEARCH /api/image/inspiration/search`.
- AI photo (人像): `AGENT_AI_GENERATE_AI_PHOTO /api/prettyimg/task/generations`, `AGENT_AI_GENERATE_AI_PROGRESS /api/prettyimg/asset/continue`, `REPEAT_AI_GENERATE_PHOTO /api/prettyimg/task/repeat`, `/api/prettyimg/resource/review`, `/api/prettyimg/share` (clock-in share → `clock_in_share_to_image`).
- Share/waterfall: `/api/image/v1/share/waterfalls`, `/api/image/agent/ai_picture_book/asset/share`, `/api/aigc/v1/screenshot`.

**Storage/COS:** generated art lands in the same COS buckets (`xj-psd-1258344703.file.myqcloud.com/image/hunyuan/…`, placeholder PNG under `text2image/public/…`); the `index` page calls `//xj-psd-1258344703.cos.ap-guangzhou.myqcloud.com/image/hunyuan/logo/anno.png` for user-logos.

**Gating:** `hide_ai_edit`, `text_to_image_operations` feature-flag block, `image_agent_button`/`ai_image_search_button` flags, `<aida aegis>` content-moderation reporting (`appId:"hunyuan_app"`, `host:https://api.aida.qq.com`, endpoint `/api/aigc/v1/datareport/zhiyanmonitor/report`).

---

## 5. Threads & conversation management

**API surface (api-util / _app):**
- List & detail: `API_CONV_LIST /api/convs`, `API_CONV_DETAIL /api/conv`; agent-scoped: `GET_AGENT_CHAT_LIST /api/user/agent/conversation/list`, `GET_AGENT_CHAT_DETAIL /api/user/agent/conversation/v1/detail`; sessions: `GET_AGENT_SESSION_LIST /api/user/agent/session/list`, `GET_USER_MAIN_CID /api/user/agent/session/getUserMainCid`.
- Create/start: `/api/generate/id` + `API_GENERATE_ID_V2 /api/v2/generate/id` (message generation ids), `CREAT_AGENT_CHAT /api/user/agent/conversation/create`, `USER_FAVORITE_NEW_CREATE /api/base/createConversation`; continue: `AGENT_CHAT_CONTINUE /api/user/agent/conversation/continue`.
- Update/rename: `API_TITLE_MODIFY /api/conv/title`, `API_GENERATE_TITLE /api/chat/title`, `GENERATE_CHAT_TITLE /api/user/agent/conversation/gentitle`, `UPDATE_AGENT_CHAT /api/user/agent/conversation/update`, `TOP_AGENT_CHAT …/top`, `TOP_SESSION /api/user/agent/session/top`, `UPDATE_SESSION …/session/update`.
- Delete/clear: `API_DELETE_CONV /api/conv/delete`, `API_CLEAR_CONV /api/convs/clear`, `DELETE_AGENT_HISTORY /api/user/agent/conversation/v1/clear`, `API_CONV_BATCH_CLEAR /api/user/agent/conversation/v1/batchHistoryConversationClear`, `DELETE_SESSION /api/user/agent/session/clear`, `USER_AGENT_CONVERSATION_DELETE /api/user/agent/conversation/v1/delete`.
- Share: `API_CHAT_SHARE /api/convs/share`, `API_CHAT_SHARE_NEW /api/conversations/share`, `SHARE_AGENT_CHAT_V2 /api/conversations/v2/share`, `GET_AGENT_SHARE_V2 /api/v5/share/detail`, `GET_SHARE_TOKEN /api/share/generatetoken`, `GET_SHARE_IMAGE /api/aigc/v1/screenshot`, `GET_SHARE_MINI_QRCODE /api/weixin/getwxaqrcode`, `GET_SHARE_WECHAT_TICKET /api/v5/accountLogic/ticket/getTicket`.
- Quota/feedback: `API_CHAT_QUOTA_INFO /api/query/chat/quotainfo`, `API_CHAT_FEEDBACK /api/ai/feedback`, `API_CHAT_COMPLAINT /api/chat/complaint/`, `DISCOVERY /api/discovery/goodquestionrec`.

`index` page: deleting a conversation clears localStorage model-ext-info; each message carries a `conversationId` (id = `"{id}_…"` split on `_`).

---

## 6. Voice input / speech

**UI:** mic in the input box; ASR experiment `media.asr.exp_asr_web_voice_input_switch`; chat content type `voice_recorder` with recorder statuses `SPEAKING/STOPPING/SPLIT`; audio attachments gated by `input.plus_panel.audio_max_file`.
**API:** `API_GET_VOICE_SDK_TOKEN /api/generate/voice_tmpkey` (TTS/ASR SDK temp key), `/api/agent/conversation/…voice…`; reviewer flow mentions ASR-returned text being editable (X-Input-Type `text` vs `voice`).
**Not confirmed from bundles:** TTS output shaping (expected to ride the same chat stream as `voice_recorder`/`ai_speaking` chunk fields `aiSpeakingState`). Treat voice as thin, chat-coupled; needs live session validation.

---

## 7. AI-search / deep-search sessions (meta-capability)

- Distinct from plain web mode: `GET_AI_SEARCH_SESSION_ID /api/inputguide/search/create` creates a search session; deep mode = `ai_search_pro`, finance deep mode = `ai_search_pro_fin`, DeepSeek deep search = `ai_search_deepseek`; `GET_AGENT_DOC_DEEP_MODE_SEARCH /api/user/agent/docDeepMode/search` searches within a deep-read document corpus.
- Deep search CoT streams as `deep_search` content chunks with `step`/`process` state and per-step `waits`; search guidance cards as `searchGuid`.
- **Gating:** `allowAnonDeepSearchNavigateOnAskDone` (anon navigate after deep-search done) and `isSetSearchTypeToModelExtInfoOnAskWithNewSession` — search-type choice is persisted into the model ext-info of a new session.

---

## 8. Memory & personalization

- `GET_MEMORY_LIST /api/memory/list`, `GET_MEMORY_SEARCH /api/memory/search` (memory recall — RAG against user's archived notes/chat context), `DELETE_MEMORY /api/memory/delete`; UI toggles `agent_memory` block.
- Presets/templates: `/api/templates/list`, `/api/templates/types/list`, `/api/coding/templates/list`, `/api/coding/templates/types/list`, `/api/generate/prompts`, `/api/inspirations/template`; shortcuts: `/api/v2/shortcut/*`, tags `/api/v2/shortcut/tag/*`.
- Agents directory & favorites: `/api/user/agent/list`, `/api/agent/v2/list`, `/api/agent/v3/list`, `/api/user/agent/v4/list`, `/api/agent/personal/agent/list`, `/api/user/agent/favorite/*`, `/api/application/subscribe/agent/*`, `/api/v1/application/list`.
- **Gating:** privacy agreement endpoints `/api/privacy/status`, `/api/privacy/agree`, guidance `/api/get_guidance_info`.

---

## 9. Auth & session facts for automation

**API host:** `https://yuanbao.tencent.com/api/…` (prod). Env-resolution keys in bundles: prod set `{hunyuan.tencent.com, yb.tencent.com, ai.tencent.com, yf.tencent.com, yuanfang.tencent.com, yb2.tencent.com, ai.qq.com, m.ai.qq.com, yuanbao.tencent.com}`; test/pre hosts resolve chat to `yuanbao.test.hunyuan.woa.com` / `yuanbao.pre.hunyuan.woa.com`. Static assets: `static.yuanbao.tencent.com/_next/…`. Streaming WSS endpoint constant (conversation voice/video): `wss://wss-stream.yuanbao.tencent.com` (prod).

**Auth & cookies:** the SPA never writes `hy_user`/`hy_token` in bundle code — **these cookies are domain session credentials managed by Tencent's login (oneid/oauth) and asserted by the API server via the Cookie header**. Browser JS only sees them indirectly. The client authenticates by:
- `credentials: 'include'` / `withCredentials: true` on every axios instance → cookies are what the server trusts.
- Explicit ID headers in many requests: `X-ID` (userId) + `X-Token` (session token), headers registered via handlers `(0,R.B4)().userId/.token`; `T-UserID`, `X-Source: "web" | "h5" | "event_h5"`.
- Anonymous/tourist path: `X-Check-Token-Type: hy_anon_token`, `/api/anon/login` (guest token), `/api/oalogin` (oauth), `/api/joint/login`, `/api/login/phonelogin`, `/api/open/cauth/login`, `/api/v5/accountLogic/login/config`, `/api/v5/accountLogic/login/accountList`.

**Login endpoints:** `/api/oalogin`, `/api/anon/login`, `/api/joint/login`, `/api/login/phonelogin`, `/api/login/logout`, `/api/v5/accountLogic/safeVerify/doVerify|detail`, `/api/account/binding`, `/api/oneid/authorization/info`, `/api/open/oauthcode`, `/api/open/apppublicinfo`.

**Anti-bot / fingerprint signals (relevant to automation):**
- Header `X-webdriver: +!!navigator.webdriver` (i.e. `1` when a headless/automated Chrome is detected) — **bot-puppeteer/chromedriver Chrome will be flagged**.
- `X-ybuitest: +!!<uiTestFlag>` (UI-test marker), `X-Trid-Channel`, `X-Exp-Params`, `x-web-ch-id` (sessionStorage `ybChannel`), `X-Web-Third-Source`, `X-Platform: win|mac|…`, `X-Browser-Name` (mobile UA only), `X-H5-AppId` (WeChat). QIMEI fingerprint SDK (`yb_v2_vendor_qimei`, `finger_id`/`visitor_id` fields), AEGIS/beacon telemetry (`beacon.qq.com/analytics/v2_upload`, `h.trace.qq.com`, `aegis.qq.com`).
- Turing.js risk-control loader (`https://static.yuanbao.tencent.com/m/lib/Turing.js`) with timeouts for SDK-init & token phases; behavioral markers `guestAnonLogin`, `guestChatRequest`.
- Commercial traffic proxy: `/rtx_proxy/query` (RTX user search) — live integration must decide whether to proxy or perform the full browser session.

---

## 10. Suggested ui2api capability list (id, one-line description) — max 12

1. `hunyuan_chat` — Ask the loaded Hunyuan 3 model via `/api/chat`; returns streamed text, step, chain-of-thought (`reasoner`/`deep_think_box`), and tool-call chunks.
2. `hunyuan_models` — List available models with `chatModelId`, sub/supporting modes, and per-model `internetSearch` from `/api/models` + `/api/agent/model/list`.
3. `hunyuan_deep_think` — Send a turn with fast→deep-think toggling (`modelType:"deepThink"`) and surface the reasoning stream.
4. `hunyuan_web_search` — Internet-mode ask (scene `ai_search_light`/`ai_search_pro`/`ai_search_deepseek`); render search cards, sources, and follow-up queries.
5. `hunyuan_deep_search` — Deep-search session via `/api/inputguide/search/create` + `ai_search_pro` streaming CoT report.
6. `hunyuan_upload_file` — Upload a doc (pdf/doc/docx/ppt/pptx/xls/xlsx/txt/csv) → COS via `/api/resource/genUploadInfo`, parse, attach to a chat turn.
7. `hunyuan_doc_analysis` — Analyze an uploaded/parsed doc (summary, Q&A, translation, mind-map `/api/user/agent/doc/getMindMap`, export `/api/user/agent/doc/download`).
8. `hunyuan_doc_deep_reading` — Deep-read a document on `/tool/deep-reading` semantics: long-context structured extraction with doc-percent progress.
9. `hunyuan_image_gen` — Generate/edit images (text-to-image, style/outpainting/elimination/remove-watermark, clarity) and manage generation history.
10. `hunyuan_threads` — Create, list, rename, pin, and clear conversations/sessions (`/api/convs`, `/api/user/agent/conversation/*`); fetch per-turn history.
11. `hunyuan_memory` — Query/delete user memory items (`/api/memory/list|search|delete`) so history can inform prompts.
12. `hunyuan_voice` — Start voice input round-trip (ASR/TTS temp key from `/api/generate/voice_tmpkey`, `voice_recorder` chunks) — lower priority, needs live validation.

---

### Appendix notes
- Capability vector is dominated by **feed-driven streaming**: nearly all "tools" (search, doc-deep-read, image gen, memory) are injected as chat-stream content types and tool-calls over the single `/api/chat` SSE endpoint, not separate REST microservices — ui2api should treat Yuanbao as "one chat endpoint + capability layers".
- 361 unique `/api/...` path strings and 283 named endpoint constants were extracted to `/tmp/opencode/capabilities/all-api-paths.txt` for follow-up mapping, plus this inventory.