# Capability packages — ui2api site libraries

> A site is not "one prompt box". A site's *capabilities* are the actions its own
> JavaScript can perform (chat, search-with-AI, web access, images, uploads,
> threads, tools, …). ui2api packages each site's full capability surface the
> same way it packages the session: **capture once, lock, install anytime.**

## Why packages

- Analyzed once → stored as a **manifest + recipes + locked session snapshot**.
- If the site UI does not change, the package stays **usable and installable at
  any time** — no re-analysis, no re-login.
- Capabilities are discovered by **reading the site's own JS bundles**
  (endpoints, RPC methods, in-page functions), so we expose what the site really
  can do — not just `send_prompt`.

## Package layout

```
capabilities/<site-id>/
  manifest.json        # id, name, url, site-version hash, capability list
  profile.json         # ChatSiteProfile (composer/send/answer selectors)
  recipes/
    <capability>.json  # how to invoke one capability (DOM steps or in-page JS)
  session.lock.json    # snapshot hash + capture date + source profile
  CAPABILITIES.md      # human-readable inventory (the deliverable of analysis)
```

Plus `capabilities/provider-catalog.md` — the harvested catalog of chat-AI sites
with documented web-session auth (from the open-source OmniRoute repo).

## Discovery method

1. Fetch the site's HTML → extract JS bundle URLs.
2. Download bundles → scan for:
   - internal RPC/API paths (`/_/…`, `*/rpc`, fetch targets)
   - in-page functions reachable from `window` (or module registries)
   - feature flags / capabilities toggles (search mode, tools, image gen)
3. Map each to a recipe: either **DOM steps** (existing primitives) or
   **in-page JS call** (`page.evaluate` invoking the site's own internals — the
   site's own code path, so no synthetic input that could look foreign).

## Stealth + performance contract (non-negotiable)

- **No trace**: drive the site through its own JS and the user's real session
  (snapshot-injected). Same cookies, same storage, same origin code paths.
- **No speed tradeoff**: warm pool stays; capabilities run concurrently where
  the site allows; recipes prefer the fastest site-native path (direct JS
  calls, not slow synthetic clicks).
- Analysis agents never launch browsers (host is constrained) — static bundle
  reading + curl only.

## Inventory status (2026-09-15 — JS bundle analysis, no browser launched)

| Package | Status | Key discovery |
|---|---|---|
| `google-ai-search` | ✅ implemented | **AI Mode = `/search?q=…&udm=14`**, urlTemplate flow (one page load per query → `{answer, citations[]}`); session snapshot (www.google.com) pending first capture |
| `gemini` | ✅ implemented | all RPCs over one `POST /_/BardChatUi/data/batchexecute`; compact descriptor IDs live-captured (`aPya6c`=ListConversations, `otAQ7b`=bootstrap/model-catalog, `otAQ7b` also carries the grounding "sources" picker; `sJBwce`=session/telemetry write — see `gemini/CAPABILITIES.md` §0 live decode table); `gemini_chat` via trusted ChatDriver insertText path; **live-tested**: chat answers, list_conversations (RPC), model_list (Flash-Lite/Flash/Pro); search toggle = **no standalone switch in this UI revision** (grounding rides StreamGenerate `tools`; sources-picker fallback selector added) |
| `kimi` | ✅ inventory + package + runner + **session locked + live-verified** | Connect/protobuf RPC on `notilo.kimi.com/apiv2`; **411 methods / 45 services decoded**; chat via `ChatService.Chat` (server-stream), search = `Tool.Search{force}` + `search.v2.SearchService`, threads via `ListChats`, files via `/apiv2-files/file/upload`; auth = localStorage `access_token` (Bearer + `x-msh-shield-data`); runtime runner `src/capabilities/kimi.ts` + `/capability/kimi` wired; **snapshot + round-trip verified live 2026-09-18** and **full surface verified 2026-09-19** — list_conversations (DOM sidebar, 15 real), model_list (K3/K3 Swarm/K2.8/Instant), web_search (toolkit `[data-testid="toolkit-trigger-btn"]` + `button.toolkit-item`), file_upload (`label.toolkit-item` + hidden `input[type=file]`, setInputFiles — filechooser never fires); answer selector `.toolcall-rollup__part:has(+ .toolcall-rollup__tail) > .markdown-container > .markdown` (isolates the final answer from the thinking block; awaitAnswer takes the longest match) |
| `hunyuan-yuanbao` | ✅ inventory + package + runner | Next.js shell, everything is tool-call content over one SSE endpoint `POST /api/chat/` (custom SSE-over-XHR); auth = `hy_user`/`hy_token` cookies; **anti-bot: `X-webdriver: 1` on headless + Turing.js/QIMEI → headed/real-profile only**; runtime runner `src/capabilities/hunyuan.ts` + `/capability/hunyuan` wired (chat via ChatDriver Qill composer); package under `capabilities/hunyuan` + deep-search & doc-QA recipes, snapshot awaiting capture |
| `poe` | ⬜ scaffold (bot-walled) | auth: `p-b` cookie (provider-catalog); **Cloudflare 403 challenge on every path — no bundles retrievable, transport unknown until first headed live capture** |
| `venice` | ✅ grounded + runner | **REST/SSE on `api.venice.ai/api/v1`, OpenAI-compatible**: `POST /chat/completions` (+`venice_parameters.enable_web_search`/`enable_web_citations`), `POST /image/generate` (flux-2-pro), `POST /video/queue` (veo3-full), `POST /audio/queue` (stable-audio-25); models incl. kimi-k2-6, claude-opus-4-6; Bearer-key auth; runtime runner `src/capabilities/venice.ts` + `/capability/venice` wired (chat via ChatDriver UI); recipes: chat + `venice_image`/`venice_video`/`venice_audio`; token-mint + DOM selectors to-verify on capture |
| `deepseek` | ✅ grounded + runner + **session locked + live-verified** | **`POST /api/v0/chat/completion`** (BigModel-style) + session CRUD/file/share/`/index/query`; SSE events `ready/delta/toast/finish/close` (JSON-patch deltas); **CoT + web search VERIFIED live 2026-09-19** — real composer toggles `div.ds-toggle-button:has-text("DeepThink"/"Search")` (state class `ds-toggle-button--selected`) feeding `thinking_enabled`/`search_enabled` (model ids server-driven via client/settings, never literal in bundles); conversation list VERIFIED (sidebar `a[href*='/chat/']`, both `/chat/<id>` + `/a/chat/s/<uuid>` shapes); auth = localStorage `userToken` → Bearer (SMS/email-OTP only); **AWS WAF + PoW** (`create_pow_challenge`/`X-DS-PoW-Response` — invisible to the page path); runtime runner `src/capabilities/deepseek.ts` + `/capability/deepseek` wired; proofs PASS (deepseek 11462, 2026-09-19) |
| `grok` | ⬜ scaffold (bot-walled) | auth: `sso` + `sso-rw` (unverified); **Cloudflare 403 + JSD challenge on every path**; x.ai sibling SPA has zero chat wire endpoints — transport unknown until first headed live capture |
| `claude` | ✅ grounded + runner | **bundles public via `assets-proxy.anthropic.com`** (html is Cloudflare-walled): `GET/PUT /api/organizations/{org}/chat_conversations/{conv}` (+`?rendering_mode=raw`), `queued_message` poll, `debug_block` (SSE), `dust/chat_continuations`, `mcp/probe`, `/v1/code/sessions/*/events/stream`; SSE `Ping/MessageStart/MessageDelta/MessageStop/ContentBlock*` + resumable `resume_token`; flags `extended_thinking`/`web_search`/artifacts; **selectors grounded**: `.ProseMirror` composer, `[data-testid="assistant-message"]` answer; runtime runner `src/capabilities/claude.ts` + `/capability/claude` wired (`claude_extended_thinking`/`artifacts`/`web_search` = honest ok:false, selector unverified); send-endpoint lives in lazy chunk — to-verify on live log |
| `perplexity` | ⬜ scaffold (auth verified, chat walled) | **NextAuth live-verified**: `/api/auth/providers` → apple/email(magic link)/google/**`pplx-jwt-to-cookie`** custom provider/workos; cookie `__Secure-next-auth.session-token`; app codename "comet"; chat transport 403 Cloudflare — streaming/focus-modes unverified (no bundle evidence, nothing fabricated) |
| `chatgpt` | ✅ grounded + runner | **SSE over same-origin `/backend-api/*`**: send = `POST /backend-api/f/conversation` (this build's literal), resume/conversation CRUD, Estuary upload (`/backend-api/estuary/content`), transcribe; events `stream_start`/`status_message`/`conversation_id`/`turn_complete`; models `gpt-5-2`/`gpt-5-3`/`gpt-5-mini`/`gpt-5-thinking`/`gpt-5-t-mini` + `o4-mini`/gpt-4 family; auth = `Authorization: Bearer` from `/api/auth/session` (chatreq_token, conversation_mode fields); selectors = builtin profile truth; **no bot wall** — direct 200 + 15 bundles; runner `src/capabilities/chatgpt.ts` + `/capability/chatgpt` wired (7 caps IN-SYNC); awaiting first live capture |
| `copilot` | ✅ grounded + runner | **Transport is WebSocket (not SSE)**: `wss://copilot.microsoft.com/c/api/chat?api-version=2&clientSessionId=…` — out `{event:"send", content, mode:"chat"|"research"}`, in `startMessage/appendText/replaceText/done/chainOfThought/citation/titleUpdate/challenge`; REST `/c/api/user/sessions/temporary → {sessionKey}` (6h anonymous) + conversations CRUD; **fraud stack: Cloudflare Turnstile + SHA-256 hashcash PoW + copilot method**; modes `cs`(Bing search)/`td`(Think deeper)/`st`(Study)/`ac`(computerUse); composer grounded `<textarea id="userInput">` + `data-testid="composer-input"`; runner `src/capabilities/copilot.ts` + `/capability/copilot` wired (5 caps IN-SYNC); answer selectors = the main live-capture fix |
| `huggingchat` | ✅ grounded + runner | **Full chat wire pinned statically** (SvelteKit v0.20.0, base `/chat`): create `POST /chat/conversation`; send `POST /chat/conversation/{id}` multipart (`data=<JSON{inputs,generationId,…}>`) → **NDJSON** (one JSON event/line, events `status`/`stream{token}`/`finalAnswer{text}`/`reasoning`/`tool`/`file`/`routerMetadata`/`budget`); resume via `GET /chat/conversation/{id}/stream` EventSource (`update`/`end`); stop/share/import-export + `/chat/api/v2/*` management; `/chat/api/mcp/servers` (Exa+HF); 140 models `omni` router default; auth = same-origin cookie (anonymous OK); runner `src/capabilities/huggingchat.ts` + `/capability/huggingchat` wired (5 caps IN-SYNC); cookie names server-set (to-verify on capture) |
| `inner-ai` | ✅ grounded (package) | **Live product (Brazilian multi-model chat)**: SPA `app.innerai.com`, API `platformapi.innerai.com/api/`, realtime **Centrifuge WS** (`wss://chat-api-v3-ws.innerai.com/connection/websocket`, tokens from `/api/v1/realtime/tokens`); chat = `POST /api/v1/chat/messages` `{session_id,message}` → `{turn_id,assistant_message_id}`; auth = cookies `token`/`email`/`deviceId` → headers `USER-TOKEN`/`USER-EMAIL`/`DEVICE-ID`; **live-verified public endpoint** `GET /api/v1/ai_models/index_unauthenticated` → 27 models (gpt-5.6/claude-4.5/gemini-3/grok-4/deepseek-4/kimi-k3/glm-5.3…); `inner-ai.com` (hyphen) = parked — the catalog id's spelling is the parked domain, real product is innerai |
| `tencent-aistudio` | ✅ grounded (package) + **session locked + chat live-verified** | **"Hy AI Studio" (混元 developer studio)** `aistudio.tencent.ai`, React+TDesign, bundles from `cdn-portal.hunyuan.tencent.com`; chat = `POST /api/new-portal/chat/{chatId}` (per-chunk JSON, not standard SSE; `chatId` from `/generate/id`, multi-turn `/user/agent/conversation/continue`); 60+ endpoints under `/api/new-portal/*` + `/api/vision_platform/*` + `/api/image/*`; models `hunyuan_t1`/`deep_seek_v3`/`deep_seek`(R1)/`hunyuan-image`/Hunyuan-Large; auth = **VERIFIED cookies `hunyuan_token`+`hunyuan_user`+`hunyuan_source` on `.tencent.ai`** (Hunyuan umbrella; NOT hy_user/hy_token) + iOA QR (`POST /api/oalogin`) / WeChat; **anti-bot VERIFIED: Tencent Cloud EdgeOne blocks headless (HTTP 567) — headed/real-profile ONLY** (same posture as hunyuan); **chat round-trip VERIFIED LIVE 2026-09-19** (headed real Chrome + injected snapshot, proofs PASS 6916/13717) — composer `textarea.t-textarea__inner` ("Ask me anything"), answer `.agent-chat__bubble--ai .hyc-content-md` → `.hyc-common-markdown`, completion marker "Completed", cold-boot `preComposeDelayMs: 8000`; runner `src/capabilities/tencent-aistudio.ts` + `/capability/tencent-aistudio` wired; History drawer renders no anchor list (conversation CRUD honest ok:false); remaining caps wire-mapped / DOM-unverified |
| `codex` | ✅ grounded (package) | **ChatGPT Codex agent** (`chatgpt.com/codex`, same SPA+host as chatgpt): task/turn REST under `/backend-api/wham/*` (`POST /wham/tasks`, `/wham/tasks/{id}/turns[/{id}][/cancel|fork|logs|pr]`, environments/machines, GitHub/GitLab connectors, usage credits, settings); **task SSE**: `GET /backend-api/tasks/{task_id}/stream` (`text/event-stream`, `[DONE]`, events `task_status`/`final_message`/`row`/`title`); sentinel mode `codex_create_task_turn`, headers `x-openai-codex-window-type`/`x-codex-entrypoint`; model slugs server-driven (no hardcoded); gate flags `wham_access`/`windows_computer_use`/`codex_only`; **DELTA vs chatgpt** documented in `codex/CAPABILITIES.md`; Cloudflare challenge on bare curl but 200 with browser headers — logged-out /codex = marketing only |
| `doubao` | ✅ grounded (package) | **豆包** `www.doubao.com/chat/` (ByteDance Modern.js): chat = `POST /samantha/chat/completion` (fetchSSE, `Agw-Js-Conv` header), HTTP gateway `/alice/*` (100+ endpoints: chat/bots/images/audio/office/commerce), realtime WS `wss://www.doubao.com/ws/v2` (**pbbp2 binary protocol**); auth = cookies `sessionid`/`ttwid`/`s_v_web_id` + `X-Bogus` byted_acrawler signing; anti-bot = byted_acrawler + `X-MS-STUB`; composer `s2-input-engine-editor-v2-host`; deep-search/code-interpreter/canvas/ppt/voice surface flagged (12 caps, chat has full recipe) |
| `notion` | ✅ grounded (package) | Notion AI = workspace-assistant (inline Q&A + /ai commands), NOT standalone chat: transport = **eventName-RPC** `POST /api/v3/<EventName>` (module 773163), `/ai` + `/ai-command-center` routes, `orange-mousse` (max) + `reasoningEffort:"high"` prompt literals, connectors→ingestion map; auth = `token_v2` cookie (+`notion_browser_id`), `/api/v3/authValidate`; manifest honest: `notion_chat` ui-path + Q&A/commands/search/connectors marked LIVE-SHAPE-TO-VERIFY (chat wire method not recoverable statically) |
| `duckduckgo` | ✅ grounded (package) | **DDG AI Chat (`duck.ai/chat` — DDG AI Chat)**: **anonymous-capable** (no login!); API family `/duckchat/v1/{chat,status,capabilities,usage,summarize}` — VQD token from `GET /duckchat/v1/status` (`x-vqd-accept:1`), refreshed per response; SSE with full marker frames + `ERR_CHALLENGE` error enum; model literals GPT-5.x/Claude 4.x/Llama 4/Mistral/Kimi extracted from 4.3MB bundle set; profile `loginRequired:false`; VQD header name obfuscated (`x-vqd-4`/`f.TY`) → primary live-capture fix |
| `xiaomimimo` | ✅ grounded (package) | MiMo Studio = **`aistudio.xiaomimimo.com` — DNS-pinned to 127.0.0.1 (dead-end for bundles)**, but api sibling **`api.xiaomimimo.com` LIVE** (`GET /v1/models` → 401 invalid-key, OpenAI/Anthropic shape, `api-key` header); console (`platform.xiaomimimo.com`) verified: `/authorize` code-exchange, `/api/v1/logout`, `/auth/sendCode|verifyCode`, console routes; models documented: **MiMo-V2.5/-Pro/-UltraSpeed/-ASR/-TTS/-TTS-VoiceClone** + `mimo-v2-flash*` + `mimo-v2-omni`; auth = catalog cookie `session`; all chat-wire to-verify (unreachable host) |
| `v0` | ✅ grounded (package) | **v0 by Vercel** (redirect `v0.dev`→`v0.app`): chat = `POST /chat/api/chat` (`Accept: text/event-stream` but body is **newline-delimited JSON**, not SSE frames) with `modelConfiguration` (default `modelId:"v0-max"`, `imageGenerations:true`), `permissionsMode:"full"`, response header `x-v0-user-message-id`; resume/ping/latest endpoints; model union `v0-mini/pro/max/max-fast/auto/fable-5.1/gpt-5.6-sol/gemini/grok/kimi-k3/opus-4.7` + gateway `creator/model` ids; true SSE for publish (`publish.progress/.result/.error`) and deploy (`deployment.progress/.log/.created/.error`); 2 WS surfaces (VM console + Hono multiplexed — not main chat); auth = `__vercel_session` cookie (+GitHub login `/api/auth/login?next=/`); no bot wall; ProseMirror composer, `data-testid="message"` |
| `conol` | ✅ grounded (package) | **Conol — AI knowledge base with background agents**, `conol.ai` (Next.js/Turbopack, Vercel), **not a dead end**: auth = **better-auth v1.6.16 passkey-only (WebAuthn)** — no email/password/OTP/OAuth; cookie `__Secure-better-auth.session_token`; probed live: `/api/auth/get-session` → 200 `null`, `/api/auth/sign-out` → 200, admin plugin present; zero chat-wire in 22 static bundles (lazy RSC behind session) — everything chat/agent to-verify on first capture |
| `copilot-m365` | ✅ grounded (package) | **M365 Copilot** (`copilot.cloud.microsoft`, Harmony app): **hard Entra ID gate on all chat paths** — `/login → loginv2 → login.microsoftonline.com/common/oauth2/v2.0/authorize` (`client_id=4765445b-32c6-49b0-83e6-1d93765276ca`, `response_mode=form_post`, scope `M365Copilot.Read.All`, `blockMsaFed:true`); server-side OIDC (Microsoft.Identity.Web), cookies `.AspNetCore.OpenIdConnect.Nonce.*`; CSP `connect-src` → `turbo.microsoft.com`+`*.office.com`+`graph.microsoft.com` (tenant grounding); `/webchat/*` mounts + `chatType:"Work"` deep-link; **DELTA vs consumer copilot documented** (server-side Entra vs client MSAL + anon temp-sessions); chat wire unobservable pre-auth |
| `t3chat` | ⬜ scaffold (bot-walled) | **Vercel Security Checkpoint** on every path (`t3.chat` → 429 JS challenge: obfuscated Web Worker + mouse telemetry + 15s timeout) — zero bundles recoverable; public repo `t3-oss/t3-chat` is 404 (not public); catalog: `t3-web` cookie `convex-session-id`, `t3-chat-web` token; transport (Convex WS vs AI-SDK HTTP) unknown until headed capture |
| `blackbox` | ⬜ scaffold (no chat surface) | Root = **B2B marketing site** (Next.js/Turbopack); `/chat` 404, `app.blackbox.ai` 302→root — **consumer chat SPA absent from anonymous graph**; verified API surface (terminal demo bundle): `POST https://enterprise.blackbox.ai/chat/completions` (OpenAI-compatible, Bearer `sk-*`) + SSE `.../enc/<model>/message_stream` (models `nvidia/nemotron-3.5-lightning`, `nemotron-3-ultra-550b-a55b`); **zero auth literals** in bundles (`__Secure-authjs.session-token` is catalog-only); chat URL after login = first capture question |
| `zenmux` | ⬜ dead-end | domain `zenmux.com` **parked** (CSC registrar, empty shell since ≥2026-06 Wayback); :443 times out; catalog `zenmux-free` cookie-kind entry unverifiable — honest scaffold with `baseUrl:null` |
| `adapta` | ⬜ dead-end | `adapta.app` **parked** (DonDominio); `adapta.ai` = different company (Adapta Dynamics); catalog cookie `__client` inherited-unverifiable — scaffold slot for re-pointing once the real brand/domain is known |
| `tinycms` | ⬜ dead-end | 13 domains probed (cc/app/com/io/ai/net/chat/com.cn/cn/xyz…): 11 dead, `tinycms.xyz` = CMS docs site (not AI); catalog `tinycms-web` (token kind, credential `app-config-uuid`) = placeholder or shut down |
| provider catalog | ✅ | 30 web providers with documented auth (from OmniRoute) |

Also: `docs/STEALTH.md` — runtime stealth audit (8 findings, 10 quick wins,
8-point checklist packages must pass; verdict: attach/headed+real-profile is
the only true no-trace posture).

## Roadmap (implementation order)

1. **Stealth baseline** — apply the 10 quick wins (attach-by-default posture,
   gate light-mode aborts off for real profiles, `keyboard.insertText` over
   `fill()`, drop GPU-flag stack + synthetic viewport for real sessions,
   jittered waits). No perf loss by design. ✅ done (2026-09-15)
2. `google-ai-search` — **first package**: one logged-in `udm=14` page load →
   `{answer, citations}`. (The "use Google from my AI" ask.) ✅ built-in profile +
   package files (manifest/profile/recipe/session.lock) + driver urlTemplate flow
   implemented; **runtime smoke test still needs the first www.google.com session
   capture** (`ui2api profile capture "https://www.google.com" --login`).
3. `gemini` — focused implementation: batchexecute RPC layer rebuilt + live-verified
   (`aPya6c`=conversation list, `otAQ7b`=model catalog on the UI's real wire
   format); `gemini_chat` = ChatDriver insertText path; task branch
   `task/gemini-surface`. ✅ implemented + live-tested (2026-09-15) + re-verified
   post-refactor (2026-09-16). Remaining
   stretch: search toggle, conversation CRUD, Gems, deep research.
4. `kimi` — chat core + web search + file upload (the 411-method RPC surface).
   ✅ **DONE (2026-09-18)**: package grounded (`capabilities/kimi/`, recipes
   closed — validator 211/211); session captured on www.kimi.ai; ChatDriver
   round-trip live-verified (thinking-block-safe answer selector locked in).
5. `hunyuan-yuanbao` — chat + deep search + doc analysis (single SSE endpoint,
   needs the real session cookies for /api/chat). Package grounded in inventory
   under `capabilities/hunyuan/` (+`hunyuan_list_conversations`/`hunyuan_voice_mode`
   recipes + self-contained CAPABILITIES.md); needs first `--login` capture
   (headed only — anti-bot fingerprint flags headless).
6. Remaining catalog scaffolds ready (`poe`, `venice`, `grok`,
   `claude`, `perplexity` — auth facts from provider-catalog, chat ui-path
   recipes; each needs a first `--login` capture).
7. **Runner sync (2026-09-16)**: all 9 runners (gemini/kimi/hunyuan/venice/
   deepseek/claude/chatgpt/copilot/huggingchat) manifest↔runner IN-SYNC —
   enforced by `test/capability-dispatch.test.ts` (18/18). **2026-09-19: +1
   runner (`tencent-aistudio`) → 10 runners, 20/20**, unknown-capability guard
   safe in all (branch before any browser op).
8. **Second catalog wave (2026-09-16)**: +14 packages from provider-catalog —
   grounded: inner-ai/tencent-aistudio/codex/doubao/notion/duckduckgo/
   xiaomimimo/v0/conol/copilot-m365; walled scaffold: t3chat/blackbox;
   dead-end (honest): zenmux/adapta/tinycms. All awaiting first `--login`
   capture (duckduckgo + huggingchat are anonymous-capable — capture optional).
9. **Capture wave (2026-09-18)**: deepseek + kimi + tencent-aistudio sessions
   captured and locked; deepseek + kimi prompt round-trips verified live
   (builtin profiles + packages in sync). Remaining: venice/claude/chatgpt/
   copilot/hunyuan captures.
10. **Full-surface verification wave (2026-09-19)** — the three user-supplied
    sessions are now mapped end-to-end (each site has a DIFFERENT surface):
    deepseek = chat + real DeepThink/Search toggles + conversation list;
    kimi = chat + conversation list (DOM sidebar) + model picker + web-search
    toolkit + file upload (attach UI); tencent-aistudio = chat (headed-only,
    EdgeOne 567 on headless, preComposeDelayMs 8000 cold-boot) with the rest
    wire-mapped/honest. Proofs PASS: deepseek 11462, kimi 13965, tencent 6916.
    Packages bumped (deepseek 0.3.0 / kimi 0.2.0 / tencent 0.2.0) + metadata.json
    added + registry (MeRezaRezaei/ui2api-registry) synced + pushed `c8483a1`
    with trust=reviewed for all three.
11. Then: rest of the provider catalog (gemini-business, and any others) as requested.