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
| `kimi` | ✅ inventory + package + runner | Connect/protobuf RPC on `notilo.kimi.com/apiv2`; **411 methods / 45 services decoded**; chat via `ChatService.Chat` (server-stream), search = `Tool.Search{force}` + `search.v2.SearchService`, threads via `ListChats`, files via `/apiv2-files/file/upload`; auth = localStorage `access_token` (Bearer + `x-msh-shield-data`); runtime runner `src/capabilities/kimi.ts` + `/capability/kimi` wired (chat via ChatDriver UI, list_conversations via DOM sidebar, RPC future work); snapshot awaiting capture |
| `hunyuan-yuanbao` | ✅ inventory + package + runner | Next.js shell, everything is tool-call content over one SSE endpoint `POST /api/chat/` (custom SSE-over-XHR); auth = `hy_user`/`hy_token` cookies; **anti-bot: `X-webdriver: 1` on headless + Turing.js/QIMEI → headed/real-profile only**; runtime runner `src/capabilities/hunyuan.ts` + `/capability/hunyuan` wired (chat via ChatDriver Qill composer); package under `capabilities/hunyuan` + deep-search & doc-QA recipes, snapshot awaiting capture |
| `poe` | ⬜ scaffold (bot-walled) | auth: `p-b` cookie (provider-catalog); **Cloudflare 403 challenge on every path — no bundles retrievable, transport unknown until first headed live capture** |
| `venice` | ✅ grounded | **REST/SSE on `api.venice.ai/api/v1`, OpenAI-compatible**: `POST /chat/completions` (+`venice_parameters.enable_web_search`/`enable_web_citations`), `POST /image/generate` (flux-2-pro), `POST /video/queue` (veo3-full), `POST /audio/queue` (stable-audio-25); models incl. kimi-k2-6, claude-opus-4-6; Bearer-key auth; recipes: chat + new `venice_image`/`venice_video`/`venice_audio`; token-mint + DOM selectors to-verify on capture |
| `deepseek` | ✅ grounded | **`POST /api/v0/chat/completion`** (BigModel-style) + session CRUD/file/share/`/index/query`; SSE events `ready/delta/toast/finish/close` (JSON-patch deltas); **CoT verified** (`thinking_enabled` + `x-thinking-enabled`, model ids server-driven via client/settings); auth = localStorage `userToken` → Bearer (SMS/email-OTP only); **AWS WAF + PoW** (`create_pow_challenge`/`X-DS-PoW-Response`); captured snapshot requires localStorage |
| `grok` | ⬜ scaffold (bot-walled) | auth: `sso` + `sso-rw` (unverified); **Cloudflare 403 + JSD challenge on every path**; x.ai sibling SPA has zero chat wire endpoints — transport unknown until first headed live capture |
| `claude` | ✅ grounded | **bundles public via `assets-proxy.anthropic.com`** (html is Cloudflare-walled): `GET/PUT /api/organizations/{org}/chat_conversations/{conv}` (+`?rendering_mode=raw`), `queued_message` poll, `debug_block` (SSE), `dust/chat_continuations`, `mcp/probe`, `/v1/code/sessions/*/events/stream`; SSE `Ping/MessageStart/MessageDelta/MessageStop/ContentBlock*` + resumable `resume_token`; flags `extended_thinking`/`web_search`/artifacts; **selectors grounded**: `.ProseMirror` composer, `[data-testid="assistant-message"]` answer; send-endpoint lives in lazy chunk — to-verify on live log |
| `perplexity` | ⬜ scaffold (auth verified, chat walled) | **NextAuth live-verified**: `/api/auth/providers` → apple/email(magic link)/google/**`pplx-jwt-to-cookie`** custom provider/workos; cookie `__Secure-next-auth.session-token`; app codename "comet"; chat transport 403 Cloudflare — streaming/focus-modes unverified (no bundle evidence, nothing fabricated) |
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
   `task/gemini-surface`. ✅ implemented + live-tested (2026-09-15). Remaining
   stretch: search toggle, conversation CRUD, Gems, deep research.
4. `kimi` — chat core + web search + file upload (the 411-method RPC surface).
   Package grounded in inventory (`capabilities/kimi/`); needs first `--login`
   capture for the live round-trip.
5. `hunyuan-yuanbao` — chat + deep search + doc analysis (single SSE endpoint,
   needs the real session cookies for /api/chat). Package grounded in inventory
   under `capabilities/hunyuan/`; needs first `--login` capture (headed only —
   anti-bot fingerprint flags headless).
6. Remaining catalog scaffolds ready (`poe`, `venice`, `deepseek`, `grok`,
   `claude`, `perplexity` — auth facts from provider-catalog, chat ui-path
   recipes; each needs a first `--login` capture).
7. Then: rest of the provider catalog (doubao, and any others) as requested.