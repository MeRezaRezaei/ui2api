# Microsoft Copilot for M365 capabilities (Harmony app, copilot.cloud.microsoft) — from static analysis, 2026-09-16

Analyzed the **enterprise/M365** Copilot surface (`copilot.cloud.microsoft`, the "Harmony" app — CSP report-uri `csp.microsoft.com/report/Harmony-App-PROD`). This is a **DELTA package** against `capabilities/copilot` (the consumer `copilot.microsoft.com` surface); it documents what is *different* about the M365/Work wire and an honest auth verdict. No browser launched — static curl + redirect-chain + shell-bundle reading only (~1.9 MB of `unauth-*` landing bundles downloaded).

Host verdict: `copilot.cloud.microsoft` = the real Harmony app (hidden behind Entra for the chat), `m365.cloud.microsoft` = bare `OK` health root (200, 79 bytes), `www.microsoft365.com` = 301 loop into `m365.cloud.microsoft`. All three probed; the Copilot-for-work app lives at **`copilot.cloud.microsoft`**.

## TL;DR — auth outcome
**Hard auth wall at the CHAT layer, but the landing/login surface is fully observable** (HTTP 200, no bot wall on the marketing shell). Every app path (`/chat`, `/v1/chat`, `/chat/api`, `/health`, `/swagger`) 302s to the **Entra ID (Microsoft Entra) `authorize` endpoint**; the post-login chat SPA and its JS bundles are **never served pre-auth**, so the M365 chat wire (`/webchat/*`, bundled-conversation upload, or turbo backend) is **not derivable statically**. This package is shipped as *auth + landing verified, chat-wire open/to-verify* — an honest degraded state, not fabricated findings.

## 1. Auth: server-side Entra ID (Microsoft.Identity.Web) — NOT client MSAL
Divergence from consumer Copilot (which ships its own `msal-baCNE5FO.js` and runs **optional** client-side MSAL): M365 Copilot gates everything behind **server-side OpenID Connect on ASP.NET Core** (headers `x-client-SKU: ID_NET8_0 / ID_NET10_0`, `x-client-ver: 8.14.0.0 / 8.15.0.0` — Microsoft.Identity.Web middleware). No MSAL JS chunk exists in the served shell.

Observed redirect chain (literal, captured 2026-09-16):
```
GET https://copilot.cloud.microsoft/login?es=UnauthClick&ru=...&...
  → 302 /loginv2?es=UnauthClick&ru=...&siwa=1&siwg=1          (env_service_name: LoginService, azure_region: francecentral)
  → 302 https://login.microsoftonline.com/common/oauth2/v2.0/authorize
       ?client_id=4765445b-32c6-49b0-83e6-1d93765276ca
       &redirect_uri=https%3A%2F%2Fcopilot.cloud.microsoft%2Flandingv2
       &response_type=code|code+id_token
       &scope=openid+profile+offline_access+https://www.office.com/v2/OfficeHome.All           (unauth landing click)
       &scope=openid+profile+offline_access+https://m365.cloud.microsoft/v2/M365Copilot.Read.All (direct /chat access)
       &response_mode=form_post
       &x-client-SKU=ID_NET10_0&x-client-ver=8.15.0.0
```
- **`client_id` `4765445b-32c6-49b0-83e6-1d93765276ca`** — the M365 Copilot Entra app (from the authorize URL literal).
- Serialized shell config (`unauthConfig` JSON in HTML) carries a second appId **`4345a7b9-9a63-4910-a426-35363201d503`** with **`blockMsaFed: true`** — consumer Microsoft accounts are *blocked* on this enterprise surface. `loginUrl`/`probeLoginUrl` point at `/login?es=UnauthClick…` (SSO sign-in button), signOutUrl `https://login.microsoft.com/logout.srf`, MSA `meUrl` `https://login.live.com/me.srf?wa=wsignin1.0`.
- Auth cookies pre-auth: `OH.SID`, `OH.FLID` (Harmony session); ASP.NET Core OIDC state cookies issued on the authorize hop: **`.AspNetCore.OpenIdConnect.Nonce.<k>`, `.AspNetCore.Correlation.<k>`** (path `/landingv2`), plus `ASLBSA` / `ASLBSACORS` from the login service. Post-auth token lands via **form_post to `/landingv2`** (the OIDC callback), so tokens are an ASP.NET session, not a first-party JS token.
- **Delta vs consumer**: consumer = optional, anonymous temp-session default, `Authorization: Bearer <MSAL token>` + `accessToken` WS query/socket key; M365 = **required**, Entra-issued session cookie + `M365Copilot.Read.All` scope, **no temp-session path** (no `/user/sessions/temporary`), MSA blocked.

## 2. Chat surface & routes (open/to-verify)
- Deep-link prompt URL literal (in landing HTML, used by the "Get started" prompts): **`/chat/entity1-d870f6cd-4aa5-4d42-9626-ab690c041429/<base64>`** where base64 decodes to:
  `{"properties":{"promptSource":"microsoft"},"id":"<guid>_en-us","scenario":"tryinappgrowth","chatType":"Work","version":1.2,"referral":{"cmmid":"cmmm35wux52"}}` → **`chatType:"Work"`** — the enterprise surface discriminator (consumer `cmc` vs M365 `Work`), plus a `cmmid` campaign-referral field.
- Direct hits (all pre-auth):
  - `/chat` → 302 Entra authorize with `scope … M365Copilot.Read.All`
  - `/v1/chat`, `/chat/api` → 302 same authorize
  - `/webchat/api` → 302 same authorize (M365 **does** mount a `/webchat/*` segment per the 302, but its contents are not reachable pre-auth)
  - `/api/*`, `/api/v1/*`, `/api/v2/conversations`, `/swagger`, `/health` → 404 or 302 authorize. **No API literal is observable anonymously.**
- Backend targets from the landing **CSP `connect-src`** (the only real pre-auth leak about where the authed app talks):
  `https://turbo.microsoft.com` ⭐, `*.office.com`, `*.office.microsoft.com`, `https://deeplinkservice.svc.cloud.microsoft`, `https://sdf.deferreddeeplinkservice.microsoft.com`, `https://config.centro.core.microsoft`, `https://config.edge.skype.com`, `https://admin.microsoft.com`, aria/events browsers, `clarity.ms`. HTML `dns-prefetch`: `portal.office.com`, `outlook.office.com`, `login.microsoftonline.com`, `shell.cdn.office.net`, `appsforoffice.microsoft.com`, `ocws.officeapps.live.com`, **`graph.microsoft.com`** ⭐.
- The expected M365 wire — **SSE/WebSocket to `turbo.microsoft.com`** (Copilot Turbo backend) with a **"bundled conversation"** upload flow for tenant/SharePoint grounding — is *consistent with the CSP literal* (`https://turbo.microsoft.com` in connect-src) but **must be verified post-auth**. No WS URL, frame format, or bundled-conversation endpoint literal exists in pre-auth assets.
- **Grounding delta vs consumer**: consumer grounds on Bing search (citation events, `bing.com`); M365's `M365Copilot.Read.All` scope + `graph.microsoft.com` prefetch point to **tenant-data grounding (Graph / SharePoint)** — to verify live.

## 3. Feature flags / config (open)
- No feature-flag literals observable pre-auth (no `features=`/`setflight=` WS query like consumer; no Turnstile/hashcash workers). `config.centro.core.microsoft` in connect-src is the likely flight/config service — unverifiable without auth.
- Codebase layout: all served bundles are prefixed **`unauth-*`** (marketing/landing only): `unauth-c07bac78a1.js` (178 KB main), `unauth-vendor-f0ab3fa70e.js` (109 KB), `unauth-ccm-hero-*.js`, `unauth-prompt-input-*.js`, `unauth-copilotcom-modules-tabs-*.js`, `unauth-mcm-faq-*.js`, `microsoft-clarity-*.js`, `otel-logger-*.js`, `wcp-consent.js`. None contain chat/auth SDK internals (grep for `/api`, `webchat`, `turbo`, SSE, MSAL = no hits).

## 4. Anti-bot / edge
- Landing + full authorize chain: **no bot wall** (plain Chrome UA curl passes the marketing shell and reaches the Entra authorize hop, which is the point of the wall — not a Turnstile/bot page).
- `turbo.microsoft.com` root → **403** (Front Door WAF). Expected anti-bot on the real chat tier: Front Door/AEG WAF + Entra conditional access (device compliance, MFA) — much stronger than consumer Copilot's Turnstile+hashcash.

## 5. Verified vs to-verify (honest split)
**Verified statically (literal evidence above):** Harmony app identity + codename (CSP report-uri); host `copilot.cloud.microsoft`; full Entra authorize URL incl. client_id `4765445b…`, redirect `/landingv2`, `response_mode=form_post`, scopes `OfficeHome.All` (landing) vs `M365Copilot.Read.All` (chat); server-side OIDC (ID_NET8/10_0); cookie names; MSA blocked; `chatType:"Work"` deep-link payload; CSP backend targets (`turbo.microsoft.com`, graph, office.com); no anonymous chat API; `/webchat/*` segment mounts (302 evidence only).

**To-verify on first live (authenticated) capture / not derivable statically:**
1. The actual chat transport + endpoint (expected `turbo.microsoft.com` SSE/WS or `/webchat/...`; bundled-conversation upload shape) — blocked by Entra pre-auth.
2. Chat DOM selectors, composer DOM, message-block DOM, send strategy — **none observable**, profile selectors are all `unverified`.
3. Tenant grounding specifics (Graph/SharePoint scope calls, `M365Copilot.Read.All` usage), feature-flag/config API, `/webchat/*` API surface.
4. Whether Entra conditional access (MFA/device) further gates a headless context; cookie set post-auth.

## 6. Wall/gating outcome
Landing/shell: **not bot-walled** (200 + full HTML for Chrome UA). Chat app: **hard-gated by Entra ID OIDC** — every chat-capable path 302s to `login.microsoftonline.com/.../oauth2/v2.0/authorize`. Post-auth SPA and its JS bundles are served only to authenticated sessions (no anonymous bundle URL reachable; all bundle guesses 404). This matches the expected enterprise reality: **you cannot drive M365 Copilot without a real M365/Entra session snapshot**, and that session is an ASP.NET cookie (`.`AspNetCore.*`), not a JS token.

## 7. DELTA table vs `capabilities/copilot` (consumer)
| Dimension | consumer `copilot` (copilot.microsoft.com) | enterprise `copilot-m365-web` (copilot.cloud.microsoft) |
|---|---|---|
| App identity | surface `cmc`, errorReportConfig `10f62a4-prod` | **Harmony**, CSP report-uri `Harmony-App-PROD`, `chatType:"Work"` |
| Auth | optional; client-side **MSAL.js**; anonymous default | **required; server-side Entra OIDC** (Microsoft.Identity.Web); MSA blocked (`blockMsaFed:true`) |
| Token/session | `POST /user/sessions/temporary` → 6h `sessionKey`; WS `accessToken` query | Entra code+id_token via **form_post to `/landingv2`** → ASP.NET OIDC session cookies (`.AspNetCore.*`, `OH.SID`) |
| Client IDs | MSAL runtime-injected | **`4765445b-32c6-49b0-83e6-1d93765276ca`** (chat); `4345a7b9-…` (shell) |
| Scopes | WS params + REST scopes | `https://m365.cloud.microsoft/v2/M365Copilot.Read.All` (chat) / `OfficeHome.All` (landing) |
| Transport | **WebSocket** `wss://copilot.microsoft.com/c/api/chat?api-version=2` (verified literals) | **not observable pre-auth**; CSP suggests `turbo.microsoft.com` + office.com BT; open |
| Grounding | Bing search (`cs` mode, citation events) | **M365 tenant data** (`M365Copilot.Read.All`, graph.microsoft.com prefetch) — open |
| Anti-bot | Turnstile + hashcash (in-band challenge) | Front Door WAF (403 on turbo) + Entra conditional access; no Turnstile observed |
| Anonymous use | yes (temp session, no login) | **no** — loginRequired true; MSA blocked means only org AAD tenants |

## 8. Suggested capability list for this package
1. `copilot_m365_chat` — Chat stream; DELTA: requires Entra session; transport to-verify (turbo/webchat); composer selectors unverified.
2. `copilot_m365_auth_entra` — Entra OIDC authorize flow (verified literals) + `M365Copilot.Read.All` scope; session snapshot needed.
3. `copilot_m365_deep_link` — `/chat/entity1-<panel>/<base64>` Work-prompt deep links (`scenario:tryinappgrowth`, `chatType:Work`).
4. `copilot_m365_grounding` — Tenant-data grounding (Graph/SharePoint) — to-verify (scope + graph prefetch verified; wire open).
5. `copilot_m365_webchat` — `/webchat/*` API segment (302 evidence) — open/to-verify post-auth.

(Not exposing: admin.microsoft.com console, config.centro tenant-config/service admin — sensitive; noted as CSP targets only.)