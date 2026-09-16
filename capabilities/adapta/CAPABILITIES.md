# Adapta (adapta.app) capabilities — DEAD-END (domain parked)

Analyzed 2026-09-16. Canonical domain per provider-catalog (`adapta-web`): `adapta.app`.
Static analysis only — NO browser launched; host constrained to curl/DNS.

## Verdict: DEAD-END — parked domain, not a live AI chat product

- `https://adapta.app` (also `https://www.adapta.app`): TCP connect to 443 **refused**
  (IP `31.214.178.55`, nothing listening). HTTP port 80 serves a **DonDominio
  (Spanish domain registrar) parking page**: title `adapta.app | Registrado en DonDominio`,
  lang `es`, `Parking del dominio`, "generated on 2026-09-16 15:14:35", Apache +
  `PHPSESSID` cookie. Plain parked/landing page — no chat UI, no app bundle, no auth.
- `https://adapta.com`: **NXDOMAIN** (does not resolve).
- Plausible alternates probed (bounded, 7 domains): `adapta.ai` → 200 but serves a
  **different company** — "Adapta Dynamics | A Dutch AI Technology Company", a SvelteKit
  **corporate marketing site** (`/_app/immutable` SvelteKit, only `/` route stubs in the
  entry bundle, no chat/conversation/llm references). `getadapta.com`, `useadapta.com`,
  `adapta.so`, `chat.adapta.app` → unreachable; `adapta.io` → 404.
- **No bot wall** was hit anywhere — no Cloudflare/DataDome/anti-bot interstitial; the
  parking page is served directly. The degradation is "dead-end", not "bot-walled".

## Why this package exists despite the dead-end

provider-catalog.md (line 56) lists `adapta-web` with `kind: "cookie"`,
`credentialName: "__client"` — i.e. the upstream OmniRoute repo (diegosouzapw/OmniRoute
`webSessionCredentials.ts`) tracks an adapta web-session provider and expects a `__client`
cookie. The catalog URL does not exist today: the domain is parked. This package holds the
slot, records the dead end, and will need the **brand/product re-identified** before any
live capability work: the parked `adapta.app` almost certainly points at a different
"Adapta" than the product catalog expected, and `adapta.ai` (Adapta Dynamics) is a
consulting firm, not the chat product.

## Verified

| fact | evidence |
|---|---|
| `adapta.app` resolves (A `31.214.178.55`, no CNAME) | `dig` / Google DoH |
| 443 refused on `adapta.app`, `www.adapta.app` | curl `Connection refused` |
| HTTP 80 → 302 → `http://www.adapta.app/` 200, DonDominio parking page | saved `/tmp/opencode/ad.html` |
| `adapta.com` NXDOMAIN | curl `Could not resolve host` |
| `adapta.ai` = Adapta Dynamics corporate SvelteKit site, no chat surface | `ad-ai.html` + entry bundle grep |
| No bot wall / anti-bot interstitial on any candidate | raw HTML contains none |

## To verify (blocks any real capability work)

1. **Re-identify the product**: what AI chat product does the catalog's `adapta-web`
   (cookie `__client`) actually correspond to? Check the upstream
   `webSessionCredentials.ts` context, brand + domain at capture time. If a correct
   `adapta.<other-slug>` exists, the package must be **re-pointed** (new `url`,
   re-analysis) — the current files document only the parked default.
2. **Live capture**: `ui2api profile capture "https://<resolved-domain>" --login` once the
   domain + brand are confirmed; then land `__client` cookie into
   `data/<domain>/.session/state.json` and fill `session.lock.json`.
3. **Selectors**: every selector here is `null`/UNVERIFIED — there is no rendered chat DOM
   to derive them from. Fresh from the first real page load.
4. **Wire facts** (streaming/stream-deltas, model literals, API endpoints, localStorage
   keys): none can be extracted — there are no app JS bundles; the parking page ships only
   `/js/searchlinks.js` (parking widgets) and `/css/*`. All previous analysis assumptions
   from a hypothetical app are invalidated until the real product is found.