# Venice capabilities (from JS bundle analysis, 2026-09-16)

Analyzed the logged-out landing (`venice.ai`, title "Venice | Private AI for Unlimited Creative Freedom") + 17 JS bundles (~900 KB) from `cdn.venice.ai/_next/static/immutable/chunks/*` (Turbopack). No bot wall: plain curl UA returned the full SSR HTML. Transport is **plain REST + SSE over HTTPS to `api.venice.ai`** (NOT protobuf/RPC/WS like Kimi). The chat-app bundles for `/chat/v2` are lazy-loaded and were NOT in the landing bundle graph — web-session wire details below stay to-verify.

## 1. Transport & base URL (verified)
- REST base: **`https://api.venice.ai/api/v1`** (embedded SDK snippets + `venice-14.js`, chunk `52809`).
- Protocol: OpenAI-compatible chat completions (`/chat/completions`); **streaming via OpenAI-style SSE** is implied by the OpenAI-compat contract (raw `stream:true` flag not observed in these bundles — inferred, to-verify).
- Output/media host: **`https://media.venice.ai`** (image/video/audio assets).
- Web app routes (from SSR nav): `/chat/v2` text, `/studio/image`, `/studio/video`, `/studio/audio`, `/models`.
- No WebSocket, no Connect/proto, no batchexecute-style tags — this is a clean OpenAI-style REST API (opposite end of the spectrum from kimi's Connect RPC).

## 2. Auth (split verified/to-verify)
- **Public API (verified)**: `Authorization: Bearer <api-key>` (`VENICE_API_KEY` env); request also sets `Content-Type: application/json`. Codex-CLI-style `experimental_bearer_token` and OpenRouter-style `openai/venice-uncensored` model path also documented in embedded samples.
- **Web session (to-verify)**: provider-catalog.md `venice-web` says cookie **`session`**. The logged-in chat canvas is a lazy chunk; the token-mint endpoint / exact bearer it sends is NOT in these bundles. Presumed to be the same `api.venice.ai/api/v1` with a session-derived bearer — confirm on first live capture.

## 3. Chat (verified endpoint; web-SSE details to-verify)
- `POST https://api.venice.ai/api/v1/chat/completions` — body: `{model, messages:[{role,content}], venice_parameters:{enable_web_search:"auto", enable_web_citations:true}}`.
- `venice_parameters` is the Venice extension namespace (web search + citations). Example model id in docs: **`kimi-k2-6`**.
- Published model ids beyond that: `openai/venice-uncensored` (CrewAI/agentic path), `claude-opus-4-6`, `claude-sonnet-4-6` (Claude Code config sample).

## 4. Image generation (verified endpoint; response shape to-verify)
- `POST https://api.venice.ai/api/v1/image/generate` — body: `{model:"flux-2-pro", prompt:"…", width:1024, height:1024}`.
- Marketing copy also advertises edit / upscale / background-remove (`/studio/image` UI).
- Model icons show image labs: Black Forest Labs, plus `sdxl`-era style models implied (icons only; exact ids not in these bundles).

## 5. Video & music (verified endpoints; async-queue shape to-verify)
- `POST https://api.venice.ai/api/v1/video/queue` — `{model:"veo3-full-text-to-video", prompt:"…"}` (queue → job/poll → download).
- `POST https://api.venice.ai/api/v1/audio/queue` — `{model:"stable-audio-25", prompt:"…"}`.
- Video/audio providers visible: Runway, Kling, Vidu, PixVerse, Bytedance, MiniMax, ElevenLabs, Inception.

## 6. Model lineup (from landing provider logos — names only, exact ids to-verify via /models)
Row 1 (text): Claude/Opus – Google – DeepSeek – OpenAI – Mistral – Meta – Qwen – Grok – Kimi – Black Forest Labs – NVIDIA. Row 2 (creative/agents): ElevenLabs – Runway – Bytedance – MiniMax – Inception – GLM(Zhipu) – Gemma – Kling – Arcee – PixVerse – Vidu. Agentic frameworks in samples: CrewAI, LangChain, Vercel AI SDK, ElizaOS, OpenClaw, Claude Code, Codex CLI.

## 7. Auth facts for automation
- Cookie `session` per provider-catalog (venice-web): kind=cookie, credentialName=`session`. Exact cookie set beyond `session` unknown — to-verify on first capture.
- No Cloudflare email/challenge wall observed on the landing (curl-friendly); web chat may harden behind the session.
- `amped.venice.ai` = GTM container only (tag id GTM-KFP6HX49); not an API host.

## 8. Verified vs to-verify
VERIFIED: base URL, 4 REST endpoints, request bodies, Bearer-key scheme, `venice_parameters` namespace, route inventory (/chat/v2, /studio/*), provider/model-icon lineup, example model ids.
TO-VERIFY (needs a live captured session + lazy chunks): exact `session` token → bearer flow, SSE frame shapes for real streamed turns, full /models catalog, composer/send/answer DOM selectors, image/video/audio job-poll endpoints.

## 9. Suggested ui2api capability list (id, one-line)
1. `venice_chat` — OpenAI-compatible `POST /api/v1/chat/completions` with `venice_parameters` (web search/citations); ui-path fallback on `/chat/v2`.
2. `venice_image` — `POST /api/v1/image/generate` (flux-2-pro, w/h); studio UI at `/studio/image`.
3. `venice_video` — `POST /api/v1/video/queue` (veo3-full-text-to-video) — async queue, poll/download.
4. `venice_audio` — `POST /api/v1/audio/queue` (stable-audio-25) — async queue.