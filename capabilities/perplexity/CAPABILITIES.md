# Perplexity capabilities (probe analysis, 2026-09-16)

Analysis method: static HTTP probing of `https://www.perplexity.ai` from a plain `curl` client (host-constrained: **no browser launched, no JS bundle download**). Perplexity fronts all browser-rendered surfaces with **Cloudflare "managed challenge"**: the HTML shell, every `/api/*` path except the NextAuth route group, `/socket.io/`, and all sub-sitemaps return a `403` challenge page to curl regardless of UA (tried Chrome, Safari, and Googlebot UA). The only first-party surfaces reachable are `GET /api/auth/*` (NextAuth), `/robots.txt`, and the `/sitemap.xml` index. Everything below is split into **verified-by-probe**, **inferred**, and **NOT verified** — nothing is fabricated.

## 1. Verified by first-party probe (images of actual HTTP responses)
- **App stack: Next.js + NextAuth (next-auth).** `GET /api/auth/providers` → 200 JSON:
  `apple` (oauth), `email` (magic-link email, type `email`), `google` (oauth),
  `googleonetap` (type `credentials` — Google Identity one-tap), **`pplx-jwt-to-cookie`** (type `credentials` — a custom provider that trades a Perplexity JWT for the session cookie), `workos` (WorkOS enterprise SSO).
- **NextAuth handshake is fully live:** `GET /api/auth/csrf` → 200 `{"csrfToken":"..."}`; `GET /api/auth/session` → 200 `{}` (next-auth standard empty session when logged out); `GET /api/auth/signin` → 302 → `/auth/signin` (custom signin route); `GET /api/auth/callback/email?email=x` → 307 (magic-link flow live).
- **Session cookie:** NextAuth JWT session cookie on the HTTPS host defaults to **`__Secure-next-auth.session-token`** (convention; exact name/sameSite/expiry to be confirmed on first live logged-in capture). This matches the `capabilities/provider-catalog.md` `perplexity-web` entry (kind `cookie`, credentialName `__Secure-next-auth.session-token`).
- **Route structure (robots + sitemap index):** robots.txt disallows `/search/new`, `/search?*`, `/marketing/prerelease/`, `/onboarding/`, `/join/` → UI search threads live under `/search` (query in URL or path segment). Sitemap index partitions: `marketing/sitemap/sanity.xml`, `sitemap/api-platform.xml`, `sitemap/comet-resources.xml`, `sitemap/comet-v2.xml`, `sitemap/core.xml`, `sitemap/enterprise.xml`, `sitemap/hub.xml` — *comet* is Perplexity's internal web-app codename; a dedicated `api-platform.xml` partition exists for the (paid) Perplexity API docs site. The sub-sitemap bodies are themselves Cloudflare-challenged (403), so their URL lists could not be read.

## 2. Chat / transport — NOT verified (this run)
- All chat/streaming surfaces are behind the managed challenge: `POST /api/chat`, GET+POST `/socket.io/?EIO=4&transport=polling`, `/rest/chat`, `/api/config`, `/api/perplexity/model`, `/api/search`, `/api/models` → 403 challenge to curl. No JS bundles were obtainable, so there is **no first-party evidence of the streaming mechanism (Socket.IO vs SSE vs fetch route handlers), request/response shapes, or chunk formats**.
- **Community-documented (EXPLICITLY NOT bundle-verified, do not build against):** several open-source perplexity scrapers (e.g. the `perplexity`/`Perplexity-AI` python packages) historically reversed the web transport as **Engine.IO/Socket.IO** (`GET /socket.io/?EIO=4&transport=polling`, namespace `/`) where the client emits a `perplexity_asks` JSON event carrying `{query, search_focus, model}` and receives streaming updates on `perplexity_request_update`, with `search_focus` values like `web`/`math`/`video`/`social`/`file`/`science`. Treat this as historical context only — Perplexity rewrites frontends frequently and the wall makes today's shapes unobservable statically.

## 3. Focus modes / search — NOT verified
- No bundle evidence for focus modes or model picker internals. **The `perplexity_*_focus` capabilities are deliberately NOT added to manifest.json** pending a live capture. First live capture should record: the in-app focus-mode button labels/DOM, the composer → network handshake, and any `search_focus`-style payload field.

## 4. Capabilities in this package
1. `perplexity_chat` — UI-path Ask: inject the logged-in session, type into the composer, Enter, read the streamed answer off the page. The only shipped capability; the wire behind it is unobservable statically today, which is fine for the UI path (the site's own JS drives whatever transport it uses).

## 5. What to verify on first live capture (checklist)
- `__Secure-next-auth.session-token` cookie shape, expiry, sameSite; whether `__Secure-next-auth.callback-url` / `csrf`/`csrf-token` accompanying cookies matter.
- Composer + answer DOM selectors (profile.json carries **unverified candidates** only — generic Ask textarea/contenteditable + common answer containers).
- Exact gRPC/REST/Socket.IO call made on send (from CDP `Network.*` on a real session), message/chunk shapes, done signal, citations DOM.
- Focus-mode payload field + legal values; model list + ids.
- Cloudflare posture for the *browser* session (the challenge is JS-gated; a real Playwright browser may pass, but expect `cf_clearance`/`cf_chl_*` cookies to appear in the snapshot and periodic "Are you human?" overlays).

## 6. Auth & session facts for automation
- Login-gated; anonymous "Ask" exists in the built-in profile (`src/profile/profile.ts`, `loginRequired:false`) but this package pins **`loginRequired:true`** per the provider-catalog `perplexity-web` entry.
- NextAuth magic-link (`email` provider) is the most automation-friendly path: `POST /api/auth/callback/email` (CSRF-protected) → email link → `GET /api/auth/callback/email?token=…&email=…` sets the session cookie. Apple/Google/WorkOS OAuth need interactive flows.
- Custom `pplx-jwt-to-cookie` Credentials provider: signin exchanges a Perplexity JWT for the NextAuth session cookie — the JWT is the token used by Perplexity's other surfaces; a captured JWT could be replayed to mint the cookie, but the provider's token shape is NOT verified.
- Expected snapshot cookies on login: `__Secure-next-auth.session-token` (+ JWE session `__Secure-next-auth.session-token.0` if using encrypted cookies), plus `cf_clearance`/`cf_chl_*` from the Cloudflare challenge.

## 7. Suggested ui2api capability list (id, one-line description)
1. `perplexity_chat` — UI-path Ask stream with session cookie `__Secure-next-auth.session-token`; verified auth surface, page-driven chat, wire shape pending first capture.
- (Deferred, no bundle evidence): `perplexity_search_focus` (focus modes), `perplexity_threads`, `perplexity_models`. Add only after a live capture grounds them.