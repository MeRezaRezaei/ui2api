# Hunyuan / Yuanbao capability package digest

Self-contained digest of `capabilities/hunyuan/`. Full bundle-analysis inventory (361 API paths, 283 named endpoint constants, per-capability details) lives in **`capabilities/hunyuan-yuanbao/CAPABILITIES.md`** — read that for depth; this file is the package surface.

## Surface
- **Product:** Tencent Yuanbao (the consumer Hunyuan assistant), `https://yuanbao.tencent.com/`, Next.js shell (16 webpack chunks, `static.yuanbao.tencent.com/_next/...`).
- **Transport:** EVERYTHING rides one endpoint — `POST /api/chat/` — streamed by a vendored **SSE-over-XHR** client (`custom_sse`, `event: message, data: <json>`, NOT native EventSource). Capability/modality is encoded in `content[].type` (`text`, `step`, `continue_step`, `reasoner`/`deep_think_box` CoT, `toolCall`, `yuanqi_tool_call`, `deepSearch`/`deep_search`, `searchGuid`, `doc_percent`, `docDeepModeInfo`, `progress`, `news`, `card`, `error`, `voice_recorder`...). Stream ids: `x-traceid`, `x-answer-msgid`, `x-query-msgid`.
- **Auth:** `hy_user` + `hy_token` domain session cookies (never written by SPA JS — Tencent login domain cookies), asserted via the Cookie header; every axios call uses `credentials:'include'`/`withCredentials` + `X-ID` (userId) + `X-Token` (session token) headers. Anonymous/tourist path: `X-Check-Token-Type: hy_anon_token`, `/api/anon/login`.
- **Anti-bot:** `X-webdriver: 1` when `navigator.webdriver` — **headless/automated Chrome is flagged**; Turing.js risk-control loader + QIMEI fingerprint SDK. HEADED + real profile required.
- **Model selection:** `GET /api/models` + `GET /api/agent/model/list` (`chatModelId`, per-model `internetSearch`, fastThink/deepThink `modelType` switch); URL `modelId=` honoured (`localStorage "{userId}_chatModelExtInfo"` remembers the pick).

## Capabilities (manifest → recipe)
- `hunyuan_chat` → `recipes/hunyuan_chat.json` — composer prompt → streamed /api/chat/ answer (text/step/CoT/toolCall).
- `hunyuan_deep_search` → `recipes/hunyuan_deep_search.json` — `ai_search_pro` (finance `ai_search_pro_fin`, DeepSeek `ai_search_deepseek`), session provisioning `GET /api/inputguide/search/create`, deep-search CoT + searchGuid cards.
- `hunyuan_list_conversations` → `recipes/hunyuan_list_conversations.json` — `GET /api/convs` (+ `/api/user/agent/conversation/list`, `/api/conv`, rename `/api/conv/title`, delete `/api/conv/delete`, clear `/api/convs/clear`); DOM-sidebar fallback.
- `hunyuan_document_qa` → `recipes/hunyuan_document_qa.json` — upload one doc/turn (`pdf/doc/docx/ppt/pptx/xls/xlsx/txt/csv`) → `/api/resource/genUploadInfo` → COS → `/api/resource/fileParse|asyncFileParse`; analysis rides /api/chat/ as `doc_percent`/`docDeepModeInfo`/`step`; deep-read modes TRANSLATION/SUMMARY/GUIDE/DEEP_SEARCH, mind-map `/api/user/agent/doc/getMindMap`.
- `hunyuan_voice_mode` → `recipes/hunyuan_voice_mode.json` — **NOT directly scriptable** (real mic + speech + anti-bot); documented surface only: mic UI, `voice_recorder` chunks (SPEAKING/STOPPING/SPLIT), temp key `GET /api/generate/voice_tmpkey`, `X-Input-Type text|voice`.

## Status
- All wire endpoints grounded by static bundle analysis (2026-09-15), **none executed**; selectors and exact response shapes are `UNVERIFIED` until first live capture (`session.lock.json`, `status: awaiting-capture`). Analysis source: `capabilities/hunyuan-yuanbao/CAPABILITIES.md`.