# Grok capabilities (bot-wall + static-bundle analysis, 2026-09-16)

Analysis date: 2026-09-16. Host-constrained: NO browser launch, static analysis only.

## Verdict (read first)
**grok.com is bot-walled at the Cloudflare WAF edge from this host.** Every probed path
returned the same hard `403 "Sorry, you have been blocked"` block page across UA, HTTP/1.1
and HTTP/2 variants. No grok.com HTML, JS bundles, or API response was retrievable, so the
chat transport CANNOT be confirmed and is marked **to-be-identified on first headed live
capture**. Nothing below about grok.com's wire protocol is asserted — this document records
the block, the probes, and the real facts that ARE observable, and does not fabricate endpoints.

## 1. Bot-wall evidence (grok.com, 2026-09-16, plain curl)
- `https://grok.com`, `/chat`, `/chat/1`, `/login`, `/api/rest/v1/models`, and `https://www.grok.com`
  → all **HTTP 403**, identical 5,488-byte Cloudflare block page:
  `<title>Attention Required! | Cloudflare</title>`, headline "Sorry, you have been blocked",
  reason "You are unable to access grok.com", footer `Performance & security by Cloudflare`
  with Ray IDs.
- Same result with Chrome 120 and Safari 131-style UAs, with/without `Accept-Language`,
  over both `--http2` and `--http1.1`.
- Block page embeds the Cloudflare **JSD (JavaScript Detection) challenge**: iframe injects
  `/cdn-cgi/challenge-platform/scripts/jsd/main.js`. This is a real-browser check — a headed
  browser (Playwright/CDP) is the plausible bypass, matching this repo's capture flow
  (`ui2api analyse https://grok.com --login`).
- Egress resolution lands on Cloudflare (edge IP `2606:4700::6812:1cea`, ASN of the datacenter).
- No alternate grok.com or grok.com-hosted CDN entry point served content on this network.

## 2. What IS observable (x.ai sibling SPA — real, attributed)
`https://x.ai` and `https://x.ai/grok` are NOT Cloudflare-blocked and serve the Grok product
marketing SPA as a Next.js + Turbopack build. 37 chunks (~3.6 MB incl. runtime) downloaded and
read from `/_next/static/chunks/` (build pin suffix `dpl=f5496767b0e65480015db0d425ea15a2380ba3ef`,
Sentry bundler plugin appKey `website`):
- **No chat wire endpoints in these bundles.** All 11 `grok.com` references are marketing nav
  links (`https://grok.com/?referrer=website|grok`, `/supergrok?referrer=grok`), iOS/Android
  store links. No `completions`, `app-chat`, SSE, or prompt-API strings (the one
  `text/event-stream` hit is Sentry's generic fetch instrumentation).
- Own REST surface is marketing-only: `/api/imagine`, `/api/changelog`, `/api/voice`,
  `/api/contact-us`-style routes, `/api/log`, `/api/observability/client-metrics`.
- Ecosystem infrastructure hosts (real, still live): `console.x.ai` (API-key + Voice-agent
  console), `docs.x.ai`, `status.x.ai`, `media.x.ai` (image blob host, used for site imagery).
- Auth-related strings are marketing analytics events only (signup-flow tracking, `sso` as an
  OAuth-login label in an event enum) — no auth host, token key, or cookie name for the chat app.
- Implies: the Grok chat app proper ships from grok.com (blocked), NOT from these marketing
  bundles. Do not mistake the x.ai marketing SPA for the chat application.

## 3. Auth facts (repo evidence, still UNVERIFIED against a live session)
- `capabilities/provider-catalog.md` `grok-web` entry: **kind `cookie`, credentialName `sso + sso-rw`**
  (host `grok.com`). Login required.
- Corroboration is weak: x.ai bundles mention `.grok.com` only for setting a visitor cookie
  (1-year `Max-Age=31536000`, `SameSite=Lax`, `Domain=.grok.com`) — analytics, not auth. No
  cookie name for the app session could be confirmed statically.
- **To verify on first headed capture**: the real session cookie set (names, expiry,
  `__Secure-*` flags), whether `/` prompts a sign-in wall, and whether `sso`/`sso-rw` alone
  authenticate chat requests.

## 4. Capabilities in this package
1. `grok_chat` — UI-path chat: type into the composer, Enter, read the streamed answer off the
   page. The ONLY capability shipped. Deliberately transport-agnostic: ui2api drives the site's
   own JS with a real session, so the underlying wire protocol does not need to be reconstructed
   for this path to work — it only needs to be RECORDED on first live capture.

## 5. What a first headed live capture must record (hunting checklist)
- DOM: composer / send / answer-text selectors (profile.json carries generic candidates only —
   confirm the real markup: `div[contenteditable]` vs `textarea`, answer container testid/class).
- Cookies: full grok.com cookie set + per-cookie flags; which ones gate chat.
- Network: capture the request that actually sends a chat message and its response stream
  (method, path, headers, payload shape, streaming format — SSE vs fetch-stream vs other).
- Feature surface to confirm existence of (do not assume): web-search toggle, image generation,
  voice mode, conversation-history list, model picker, "Deep Search". Record only what is seen.
- Anti-bot: whether Cloudflare JSD clears inside the headed browser and whether subsequent
  automation (CDP `Network.setCookie`/typed input) trips it.

## 6. Not verifiable today / explicitly not fabricated
- grok.com chat endpoint paths and streaming format: **unknown**, not guessed here.
- Feature flags, model names, image-gen / voice / deep-search surfaces on grok.com: not observed.
- CDP/Playwright compatibility with grok.com's WAF posture: unproven until a headed run.
- Anything in `profile.json` / `session.lock.json` remains scaffold-unverified (selectors,
  cookie set, capture path) — see `Status` below.

## Status
`session.lock.json` = **awaiting-capture**, snapshot hash `null`. Nothing about grok.com could
be confirmed without a headed browser session; the Cloudflare JSD gate is the concrete thing a
first live capture must negotiate.