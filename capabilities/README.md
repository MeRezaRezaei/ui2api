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
| `google-ai-search` | ✅ inventory | **AI Mode = `/search?q=…&udm=14`**, SSR answer in `AF_initDataCallback`; first package candidate |
| `gemini` | ✅ inventory | all RPCs over one `POST /_/BardChatUi/data/batchexecute`; 109 `BardFrontendService.*` descriptors incl. `StreamGenerate`, search toggle via `UpdateToolPermission`, image/video gen, Gems, canvas, deep research, MCP/skills control plane |
| `kimi` | ✅ inventory | Connect/protobuf RPC on `notilo.kimi.com/apiv2`; **411 methods / 45 services decoded**; chat via `ChatService.Chat`, search = `Tool.Search{force}` + `search.v2.SearchService`, files via `/apiv2-files/file/upload`; auth = localStorage `access_token` (Bearer + `x-msh-shield-data`) |
| `hunyuan-yuanbao` | ✅ inventory | Next.js shell, everything is tool-call content over one SSE endpoint `POST /api/chat/` (custom SSE-over-XHR); deep search, upload→COS→doc analysis, image gen; auth = `hy_user`/`hy_token` cookies; anti-bot: `X-webdriver: 1` flag on headless + Turing.js/QIMEI fingerprint |
| provider catalog | ✅ | 30 web providers with documented auth (from OmniRoute) |

Also: `docs/STEALTH.md` — runtime stealth audit (8 findings, 10 quick wins,
8-point checklist packages must pass; verdict: attach/headed+real-profile is
the only true no-trace posture).

## Roadmap (implementation order)

1. **Stealth baseline** — apply the 10 quick wins (attach-by-default posture,
   gate light-mode aborts off for real profiles, `keyboard.insertText` over
   `fill()`, drop GPU-flag stack + synthetic viewport for real sessions,
   jittered waits). No perf loss by design.
2. `google-ai-search` — **first package**: one logged-in `udm=14` page load →
   `{answer, citations}`. (The "use Google from my AI" ask.)
3. `gemini` — chat stream + search toggle + conversation CRUD + model picker
   (the batchexecute RPC layer is already fully mapped).
4. `kimi` — chat core + web search + file upload (the 411-method RPC surface).
5. `hunyuan-yuanbao` — chat + deep search + doc analysis (single SSE endpoint,
   needs the real session cookies for /api/chat).
6. Then: rest of the provider catalog (poe, venice, doubao, deepseek, grok,
   claude, perplexity…) as requested.