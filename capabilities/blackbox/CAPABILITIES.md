# Blackbox AI capabilities (from JS bundle analysis + SSR HTML, 2026-09-16)

Analyzed statically (curl only, Chrome UA, no browser launched): 14 JS bundles (~1 MB) + the SSR HTML of
`https://www.blackbox.ai` (root) and `https://www.blackbox.ai/login`. **Headline result: this is the B2B
marketing platform's Next.js site — the consumer chat SPA is not reachable statically.**

- Site: `https://www.blackbox.ai` (`<title>Blackbox: The high-trust platform for frontier inference</title>`;
  canonical org: Blackbox AI Technologies Inc., 535 Mission Street SF). Next.js App Router on **Turbopack**
  (`/_next/static/immutable/chunks/*.js`, `globalThis.TURBOPACK` bootstrap).
- Route findings: `/login` = 200 (224 KB, JS client form with `button.blackbox-authsubmit`, no SSO/endpoint
  strings exposed); `/chat` & `/chat/` = **404** ("Page not found | Blackbox"); `app.blackbox.ai` = 302 →
  `www.blackbox.ai`; `chat.blackbox.ai`/`apps.blackbox.ai` = unreachable (000).
- Key bundles: `0.js`–`10.js` (root; shared with /login) = Next.js framework + marketing components
  (`8.js` HeroHeatmap, `9.js` next-error page, `5.js` server-action helpers, `1.js` core-js bootstrap,
  `7.js` router/docs-links). Login-only: `20kp4u2pw1i21.js` (14 KB), `3milu56raom2d.js` (31 KB),
  `1qon19_jxa2iv.js` (130 KB) — **none contain auth/SSO/endpoint literals**.

## 1. Chat core (models, streaming) — UNVERIFIED (not statically reachable)

- The consumer chat SPA (composer, message stream, conversation list) is **code-split and loaded only at
  runtime behind login** — it is absent from the anonymous module graph, so no `/api/chat`-style literal,
  no SSE event names, and no composer DOM classes are statically discoverable. Also refer to the "Verified
  vs to-verify" section: **the whole chat UI must be reverse-engineered from the first logged-in capture.**

## 2. Verified inference API surface (sibling product — from `6.js` terminal demo)

- **OpenAI-compatible completions:** `POST https://enterprise.blackbox.ai/chat/completions`,
  `Authorization: Bearer sk-•-•-•-••••`, plaintext proxy `api-proxy-1` (`cc_proxy`/`api_proxy` keys), model
  path plaintext `<model>` (e.g. `nvidia/nemotron-3.5-lightning`).
- **Legacy encrypted streaming:** `https://enterprise.blackbox.ai/enc/<model>/message_stream`, encrypted
  proxy `e2ee-proxy-1`, path prefix `bbenc/<model>`. Literal `message_stream`; ~57 `stream` / 5 `SSE` /
  1 `streaming` occurrences across the 14 bundles (mostly marketing/decorative).
- Model literals: `nvidia/nemotron-3.5-lightning`, `nvidia/nemotron-3-ultra-550b-a55b`; marketing text
  lists `deepseek`, `llama`, `mistral(-small,-nemo)`, `qwen` (these are landing-page claims, not an
  exhaustive API catalog). Blog refs: `/blog/nemotron-3-5-lightning`, `/blog/benchmark-performance`.
- Demo prompt literal: `explain ssh`; terminal anim `docker logs <proxy> -f` with Braille spinner.

## 3. Auth & session facts for automation

- provider-catalog: `blackbox-web` → kind **cookie**, credentialName **`__Secure-authjs.session-token`**
  (AuthJS / NextAuth convention). This is a CATALOG claim — it was NOT re-confirmed in bundles: zero
  literals for `authjs`, `session-token`, `csrf`, `__Secure-*`, `Bearer` in the 14 statically-served chunks.
- `/login` fetches fine anonymously (200) but ships no OAuth/Credentials endpoints statically; the auth
  module is server-side or lazy-loaded. Expect the same `Secure` session-cookie pattern as perplexity-web
  (`__Secure-next-auth.session-token`, next line in the catalog) until proven otherwise.
- First live capture must record: real logged-in chat URL, `document.cookie` + `localStorage` set, and any
  `Authorization`/`csrf`/fingerprint headers on the chat requests.

## 4. Verified vs to-verify split

**Verified (static):** root = marketing site (Next.js/Turbopack, no bot wall); `/login` = 200 JS form;
`/chat` 404 + `app.blackbox.ai` 302 → root (no public chat route); 14 chunks = framework + marketing only;
inference API endpoints + model + proxy-mode literals in §2.

**To verify on first live (headed, logged-in) capture** (no browser allowed this run):
1. The real chat URL/route where the composer mounts (anonymous `/chat` 404s — do not assume it).
2. Composer / send / answer / new-chat / dismiss DOM (profile.json selectors are all UNVERIFIED guesses).
3. The actual chat wire — SSE/EventSource vs `chat/completions`-style POST, event names, and headers.
4. Auth: confirm `__Secure-authjs.session-token` cookie materializes (or which cookie/localStorage key
   actually does), and whether anti-bot (csrf/fingerprint/captcha) gates the chat API.

## 5. Bot-wall outcome

- **No bot wall hit** on static fetch: plain curl (Chrome UA) returned the full ~374 KB home page (200), the
  ~224 KB `/login` page (200), and all 14 bundles served normally from `/_next/static/immutable/chunks/`.
- Caveat: the marketing surface is trivially public; the **chat app is fully login-gated**, so the
  anti-automation surface only appears after login — expect AuthJS session cookies + possible server-side
  rate/captcha gating on the chat API, invisible to static probing.

## 6. Suggested ui2api capability list (id, one-line description)

| id | description |
|----|-------------|
| `blackbox_chat` | Composer send + streamed answer (UI-path driver) — transport UNVERIFIED; ship recipe, confirm DOM + wire on first logged-in capture. |
| `blackbox_inference_api` | Direct inference via `POST enterprise.blackbox.ai/chat/completions` (OpenAI-compatible) / `enc/<model>/message_stream` — endpoints verified statically, live shapes to verify. |