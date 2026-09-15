# Perplexity capabilities (static scaffold, 2026-09-15)

Scaffolded from `capabilities/provider-catalog.md` auth facts + shipped package examples. No browser or bundle analysis (host-constrained); everything is marked **to be verified on first live capture**.

## Known (sourced from provider-catalog.md)
- **Auth**: `perplexity-web` entry → **cookie** kind, credential name **`__Secure-next-auth.session-token`** (host `www.perplexity.ai`). Login-required; capture via `ui2api analyse https://www.perplexity.ai --login`.
- NOTE: the `src/profile/profile.ts` built-in currently allows anonymous "Ask" (`loginRequired: false`); this package deliberately pins `loginRequired: true` to match the catalog's session credential.

## Capabilities in this package
1. `perplexity_chat` — UI-path Ask: type into the composer, Enter, read the streamed answer + citations off the page. The only capability shipped; provider-catalog documents no other perplexity endpoints.

## To be verified on first live capture
- Composer / answer DOM selectors (profile.json carries generic candidates only).
- Full cookie set (expiry, anti-bot headers).
- **Search focus modes / API endpoints are NOT fabricated** — provider-catalog.md does not document them; they are "to be verified on first live capture" before any `perplexity_*_focus` capability gets added.

## Status
`session.lock.json` = **awaiting-capture**, no snapshot hash.