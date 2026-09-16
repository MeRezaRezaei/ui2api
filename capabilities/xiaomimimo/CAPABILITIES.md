# Xiaomi MiMo capabilities (from static analysis, 2026-09-16)

Analyzed statically (curl only, Chrome UA `152.0.0.0`, no browser launched), 7 JS bundles
(~3.3 MB total), 1 HTML entry, 1 JSON asset, 1 DoH DNS resolution.

## 0. Domain resolution — honest verdict

| Candidate host | Status | What it is |
|---|---|---|
| `mimo.xiaomi.com` | **LIVE (200, 43.8 KB)** | Rspress v1.46.2 static docs/blog; server MiFE/3.4.29; serves `/` + `/mimocode` + `/zh` |
| `mimo.chaoxing.com` | connection failed (000) | Not a live host |
| `support.xiaomi.com` | connection failed (000) | Not a chat product; hosts Xiaomi support |
| `aistudio.xiaomimimo.com` | **DEAD-END — A record 127.0.0.1 (DNSPod, TTL 600)** | The actual **MiMo Studio** chat web app, publicly pinned to localhost; **no app bundles obtainable** |
| `platform.xiaomimimo.com` | LIVE (200, 8.3 KB SPA) | Rspack SPA: **Xiaomi MiMo API Open Platform** (token-plan console / API-key management) |
| `mimo.xiaomimimo.com/desktop/invite/` | LIVE (200) | Desktop client download landing ("Xiaomi MiMo桌面客户端") |
| `api.xiaomimimo.com` | LIVE (401 on `/v1/models`) | OpenAI-compatible + Anthropic-compatible API gateway |

**Resolution:** The canonical `xiaomimimo-web` provider in `provider-catalog.md` (line 89) maps to
**MiMo Studio at `aistudio.xiaomimimo.com`**, confirmed by the platform console bundle:
`POST/GET https://aistudio.xiaomimimo.com/open-apis/v1/genLoginUrl?currentPath=<path>`
is used to build the sign-in deep link, and the console footer's `productStudio` label is the
aistudio URL. **Host is DNS-pinned to 127.0.0.1 — no live chat DOM or wire could be captured.**
The `mimo.xiaomi.com` docs site is crawler-friendly but is a static documentation blog, not a
chat product.

## 1. What was actually observed (platform.xiaomimimo.com SPA)

- **Rspack app** — `main.e2d982a0da07984e.chunk.js` (520 KB), chunk `766.e45c29dae7bf4756.chunk.js`
  (2.6 MB vendor), total ~3.1 MB.
- Router routes confirmed: `/console/api-keys`, `/console/balance`, `/console/inbox`,
  `/console/plan-manage`, `/console/plugin`, `/console/profile`, `/console/recharge`,
  `/console/usage`, `/console/invoice`, `/authorize`, `/authorize/code`, `/authorize/success`.
- Auth endpoints (bundle literals): `/authorize`, `/authorize/code`, `/authorize/success`
  (OAuth-style cookie-session authorize flow), `/api/v1/logout`, `/auth/sendCode`,
  `/auth/verifyCode`, `/auth/verificationStatus`, `/auth/checkBindCard`,
  `/auth/enterprise/reset`, `/auth/enterpriseStatus`, `/auth/enterprise/submit`,
  `/auth/enterprise/transferAmountV2`, `/auth/enterprise/verification/revoke`,
  `/auth/enterprise/verifyTransferAmount`, `/auth/faceRecognitionUrl`,
  `/auth/nonMainlandUserStatus`.
- Notification: `/inbox/messages`, `/inbox/recent`, `/inbox/unreadCount`, `/inbox/read`,
  `/inbox/readAll`, `/inbox/delete`.
- Invitation: `/invitation/code`, `/invitation/eligible`, `/invitation/bind`, `/invitation/progress`.
- AB testing: `/abtest/experiments`.
- Banner/localStorage: `announce_banner_dismissed` (boolean, controls top banner visibility).
- Analytics: `console_studio_chat_click` event, `topNavChatWithMiMo` nav item.
- Rate-limit: 429 response → `setShowRateLimitPopup(true)` (rate-limit token-plan popup).
- Logout clears a cookie via `document.cookie = <name>;` (minified; key name obfuscated).
- QR login groups: `qrs.json` at `aistudio-cdn.xiaomimimo.com` contains WeChat Enterprise
  (`work.weixin.qq.com`) and Feishu (`applink.feishu.cn`) chat-room QR codes — support
  channels, not login mechanism itself.

## 2. Models (verified literals)

**Console bundle (platform.xiaomimimo.com):** `MiMo-V2.5`, `MiMo-V2.5-Pro`,
`MiMo-2.5-Pro-UltraSpeed`, `MiMo-V2.5-ASR`.

**Docs/blog (mimo.xiaomi.com, 4752 bundle):** `MiMo-V2.5`, `MiMo-V2.5-Pro`,
`MiMo-V2.5-Pro-UltraSpeed`, `MiMo-V2.5-ASR`, `MiMo-V2.5-TTS`, `MiMo-V2.5-TTS-VoiceClone`,
`MiMo-V2.5-TTS-VoiceDesign`; page files referenced for `mimo-v2-flash`,
`mimo-v2-flash-hss`, `mimo-v2-flash-safety`, `mimo-v2-omni`.

**Docs confirm (verbatim):** "model is `mimo-v2.5-pro`. Reasoning output is returned as
`reasoning_content`. An Anthropic-compatible endpoint is also available at
`https://api.xiaomimimo.com/anthropic`."

## 3. API gateway (api.xiaomimimo.com — live, 401-verified)

- OpenAI shape: `POST https://api.xiaomimimo.com/v1/...` (chat completions format; server
  MiFE/3.4.29; DNS `mimo-pri-azams.alb.xiaomi.com`).
- Anthropic shape: `POST https://api.xiaomimimo.com/anthropic/...`.
- Auth: `api-key` HTTP header (bundle-verified from mimocode provider config:
  `"headers": {"api-key": "{env:MIMO_API_KEY}"}`); Bearer also possible per
  `Authorization` → 401 body `"type":"invalid_key","message":"Invalid API Key"`.
- Anonymous probe: `GET /v1/models` → `401 {"error":{"message":"Invalid API Key",
  "param":"Please provide valid API Key","code":"401","type":"invalid_key"}}`.

## 4. Chat surface — NOT OBSERVED (MiMo Studio = dead end)

- MiMo Studio (`aistudio.xiaomimimo.com`) is the web chat product (confirmed by console
  `open-apis/v1/genLoginUrl` redirect to aistudio + footer link `productStudio`).
- Public DNS (DoH via Cloudflare, authoritative DNSPod A record): `A 127.0.0.1, TTL 600`.
  This is NOT a hosts-file pin — it is the canonical public DNS answer.
- **No chat wire protocol (SSE/WS), no chat endpoints, no composer/answer DOM, no stream
  event names, no model-picker-on-chat-surface were obtainable.**
- Login gate (console bundle): `GET https://aistudio.xiaomimimo.com/open-apis/v1/genLoginUrl`
  + `?currentPath=<deep-link>` builds the sign-in redirect.
- The catalog credentialName `session` implies a cookie literally named `session` —
  unverifiable while host is pinned to 127.0.0.1.

## 5. Auth & session facts for automation (from bundles)

- **Catalog (provider-catalog.md line 89):** `xiaomimimo-web` kind `cookie`, credentialName
  `session` → Playwright storage-state cookie jar.
- **Console:** full authorize flow (`/authorize`, `/authorize/code`, `/authorize/success`);
  `/api/v1/logout` clears session; localStorage keys are minified (one known key:
  `user_language_preference`); rate-limit 429 triggers popup.
- **Studio:** QR-style account login (WeChat/Alipay/Feishu payment & login patterns in console
  i18n — `qrCodeTitle`, `qrPayTitleWechat`, `qrPayTitleAlipay`). Exact cookie name `session`
  is catalog-provided; not live-verified.
- **API platform:** APIKey via `api-key` header (MCP provider config pattern); not cookie-based.

## 6. Bot-wall outcome

- **No client-side bot wall/challenge** was hit on any reachable host — `mimo.xiaomi.com`,
  `platform.xiaomimimo.com`, `mimo.xiaomimimo.com/desktop/invite/`, and `api.xiaomimimo.com`
  all served plain 200/401 HTML+JSON without challenge tokens, interstitials, or
  Cloudflare/Guardian gates.
- The MiMo Studio dead-end is a **DNS-level unavailability** (A=127.0.0.1) — not a bot wall.
  Expect that once the host becomes publicly routable, cookie-based auth may introduce
  fingerprinting/captcha gates (console 429 → rate-limit popup is the only abuse signal seen).

## 7. Verified vs to-verify split

**Verified (static, from bundles/probes):**
- DNS resolution of all candidate hosts (§0).
- Rspack bundle structure + router routes of platform.xiaomimimo.com (§1).
- Model name literals across console + docs (§2).
- API gateway endpoints + 401 auth shape + `api-key` header (§3).
- Studio identity + genLoginUrl gate + MiMo Studio label (§4).
- Console auth flows + logout + minified localStorage (§5).
- Bot-wall negative finding (§6).

**To verify on first live capture (once aistudio.xiaomimimo.com is routable):**
1. Chat transport: SSE vs WebSocket vs long-poll (server-streamed, Connect-protobuf, or other).
2. Chat API endpoint path (e.g. `/open-apis/v1/chat/completions` or custom).
3. Composer DOM selector (input element class/id for prompt entry).
4. Answer DOM selector (assistant response container).
5. New-chat button selector.
6. Stream event names and completion signal (delta event literal, done/finish marker).
7. Session cookie name — is it literally `session` (as catalog says) or `mi_session`/other?
8. Model picker DOM ↔ `model_slug` / internal model-ID mapping on the chat surface.
9. Web-search / image-gen / voice toggles (if any) in the chat UI.
10. Login interstitial/consent page first-run path (QR vs phone-number vs email).

## 8. Suggested ui2api capability list (id, one-line description)

| id | description |
|----|-------------|
| `xiaomimimo_chat` | Composer send + streamed answer in MiMo Studio (aistudio.xiaomimimo.com); wire unobserved — skeleton only. |
| `xiaomimimo_api_gateway` | Call api.xiaomimimo.com/v1 (OpenAI shape) and /anthropic with api-key header; models MiMo-V2.5 / V2.5-Pro / V2.5-Pro-UltraSpeed / V2.5-ASR / V2.5-TTS. |
| `xiaomimimo_console` | Token-plan console (platform.xiaomimimo.com): API keys, balance, recharge, usage, billing invoice, plugin management. |

## 9. What the docs site bundles contained (not chat-relevant, kept honest)

- `mimo.xiaomi.com` is a static Rspress site with 5 JS bundles (~885 KB) for the docs
  blog and MiMo Code (CLI) product pages. No chat app JS, no chat route, no chat-relevant
  state or selectors. The only MiMo-chat-adjacent text found: the word "Studio" appears as
  a product label linking to aistudio (platform console i18n only, not in docs bundles).
