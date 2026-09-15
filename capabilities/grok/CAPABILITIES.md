# Grok capabilities (static scaffold, 2026-09-15)

Scaffolded from `capabilities/provider-catalog.md` auth facts + shipped package examples. No browser or bundle analysis (host-constrained); everything is marked **to be verified on first live capture**.

## Known (sourced from provider-catalog.md)
- **Auth**: `grok-web` entry → **cookie** kind, credential name **`sso` + `sso-rw`** (host `grok.com`). Login-required; capture via `ui2api analyse https://grok.com --login`.

## Capabilities in this package
1. `grok_chat` — UI-path chat: type into the composer, Enter, read the streamed answer off the page. The only capability shipped; provider-catalog documents no other grok endpoints.

## To be verified on first live capture
- Composer / answer DOM selectors (profile.json carries generic candidates only).
- Whether grok.com gates anonymous or logged-out sessions, and the full cookie set (expiry, anti-bot headers).
- Any additional surface (conversation history list, model picker, deep-search) — NOT fabricated here because provider-catalog does not document them.

## Status
`session.lock.json` = **awaiting-capture**, no snapshot hash.