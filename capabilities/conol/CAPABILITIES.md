# Conol.ai capabilities (static analysis, 2026-09-16)

Analyzed statically (curl only, Chrome UA, no browser launched), 22 JS bundles (~958 KB total) from `https://conol.ai`, plus live API probe against better-auth endpoints.

- Site: `https://conol.ai` (200, alive). Title: "Conol — Your Knowledge Base, Powered by Agents That Work". Meta: "Conol is a knowledge base powered by agents that research, run long jobs in the background, file results into your notes, and reach you when done."
- Framework: **Next.js + Turbopack** (immutable chunks under `/_next/static/immutable/chunks/`). Vercel-hosted (vercel speed-insights, Vercel 404 error pages).
- App shell: SPA at `/home`, `/chat` (200; client-side rendered; no app code reachable in the static bundle set). Marketing pages at `/`, `/blog`, `/cookies`, `/privacy`, `/terms`, `/download/mac`.

## 1. Auth (better-auth v1.6.16, passkey-only)

- Client library: **better-auth** client v1.6.16 (found in chunk `06_ytnjcgtyhz.js`), plugins: **passkey** (simplewebauthn), **organization**.
- Cookie: `__Secure-better-auth.session_token` (confirmed by OmniRoute catalog source `webSessionCredentials.ts` -- literal in placeholder text; better-auth default Secure prefix cookie).
- Better-auth server base path: **`/api/auth/*`** (live-probed, confirmed live):

| Route | Method | Status | Body |
|-------|--------|--------|------|
| `/api/auth/get-session` | GET | 200 | `null` (unauthenticated) |
| `/api/auth/sign-out` | POST | 200 | `{"success":true}` |
| `/api/auth/passkey/generate-register-options` | GET | 401 | `{"message":"Unauthorized","code":"UNAUTHORIZED"}` |
| `/api/auth/passkey/register` | POST | 401 | `{"message":"Unauthorized","code":"UNAUTHORIZED"}` (client-confirmed path) |
| `/api/auth/passkey/authenticate` | POST | 401 | `{"message":"Unauthorized","code":"UNAUTHORIZED"}` (client-confirmed path) |
| `/api/auth/admin/list-users` | GET | 401 | (empty body; admin plugin present) |
| `/api/auth/error` | GET | 302 | redirect |
| `/api/auth/sign-in/email` | POST | 404 | (not mounted) |
| `/api/auth/sign-up/email` | POST | 404 | `{"code":"NOT_FOUND","message":"Not found"}` |
| `/api/auth/sign-in/google` | GET | 404 | (not mounted) |

- **Auth is passkey-only (WebAuthn)**: email+password, Google OAuth, OTP, and magic-link routes all return 404. No social login provider found.
- Error shape (401): `{"message": "Unauthorized", "code": "UNAUTHORIZED"}`.
- No bot wall hit on static fetch; 22 bundles served normal 200.

## 2. App API surface (NOT REACHABLE STATICALLY)

The following routes returned 404 from the Vercel 404 handler (92 KB HTML body -- Next.js not-found page, not a real 404 from the app):
- `/api/agents`, `/api/agent`, `/api/knowledge`, `/api/notes`, `/api/research`

These are **guesses** based on the marketing copy -- the real agent/knowledge/note API paths are embedded in the SPA chunk graph behind auth and NOT available in the 22 static chunks. The app UI is a client-side SPA: the `/home` route serves the same 98 KB HTML shell as `/`, and all app logic is lazy-loaded via RSC dynamic imports not reachable without a live session.

- Attribution: localStorage key `conol.attribution` (`conol.attribution.uploaded` flag); `POST /api/user/attribution` (JSON body).
- Waitlist: `POST /api/waitlist` (reCAPTCHA v3 guarded via `executeRecaptcha("waitlist")`).

## 3. Chat / agent wire (UNVERIFIED -- requires headed live capture)

**No chat/agent API endpoints or streaming transports were found in the static bundle set.** The 22 chunks totalling ~958 KB cover: better-auth client + passkey (chunk `06_ytnjcgtyhz.js`, 204 KB), Next.js internals (`2rysxo11dqu0_.js`, 150 KB; `0c0hxoamwjsbw.js`, 112 KB), landing page + waitlist (`0wyp-n9omww8q.js`), attribution (`0dvsj0f3blrki.js`), and framework plumbing.

The SPA app chunks (knowledge base UI, agent runner, note editor, chat composer) are NOT part of the initial HTML load and are only available as dynamic RSC payload after authentication. Therefore: **no selectors, no API paths, no streaming protocol, no model names can be extracted statically.**

This is an honest limitation, not a bot-wall or blocked fetch -- the app simply lazy-loads all functionality behind session auth.

## 4. Verified vs to-verify split

**Verified (static + live API probe):**
- Domain: `https://conol.ai` alive, 200, real AI product
- Framework: Next.js Turbopack, Vercel-hosted
- Auth: better-auth v1.6.16 client + passkey plugin + organization plugin
- Cookie: `__Secure-better-auth.session_token` (catalog + better-auth default)
- Better-auth routes: `/api/auth/get-session` (200), `/api/auth/sign-out` (200), `/api/auth/passkey/*` (401), `/api/auth/admin/*` (401)
- Attribution: `conol.attribution` localStorage + `POST /api/user/attribution`
- Waitlist: `POST /api/waitlist` (recaptcha v3)
- No email/password, no Google OAuth

**To verify on first live (headed) capture:**
1. App SPA routes behind auth: `/home`, `/chat` -- knowledge base, agent runner, note editor, chat UI
2. Chat/agent backend API paths (likely Next.js route handlers under `/api/*`)
3. Streaming transport (SSE / fetch ReadableStream / WebSocket -- unknown)
4. Model names / model picker (if present)
5. Passkey registration ceremony UX (browser-native WebAuthn prompt)
6. Organization/workspace features (better-auth org plugin present but not probed)
7. DOM selectors for composer, answer, new-chat (all unknown from static analysis)

## 5. Summary verdict

This is NOT a dead-end. The domain is alive, auth surface is confirmed (better-auth + passkey), and the product is real. However, the chat/agent capability is **partially scaffolded** -- the wire protocol, DOM selectors, and streaming transport are all unverifiable without a live authenticated session. This package provides the maximum honest scaffold from what IS available, and honestly flags everything else.

## 6. Bot-wall outcome

- **No bot wall on static fetch** -- all 22 JS bundles served 200, all marketing pages returned full HTML. No Cloudflare challenge, no cf-clearance cookie, no 403.
- Better-auth API routes respond with proper HTTP status codes (401/404/200) without challenge pages.
- `/login` returned 429 after multiple rapid requests -- **rate limiting is present** but not a bot wall (it is the auth endpoint rate limiter).
- No anti-bot fingerprint SDK detected (no VolcanoEngine, no TrustDecision, no Cloudflare Turnstile in static surface).
