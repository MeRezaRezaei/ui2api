# Claude capabilities (static scaffold, 2026-09-15)

Scaffolded from `capabilities/provider-catalog.md` auth facts + shipped package examples. No browser or bundle analysis (host-constrained); everything is marked **to be verified on first live capture**.

## Known (sourced from provider-catalog.md)
- **Auth**: `claude-web` entry → **cookie** kind, credential name **`sessionKey`** (host `claude.ai`). Login-required; capture via `ui2api analyse https://claude.ai --login`.
- Built-in profile already in `src/profile/profile.ts` (composer `.ProseMirror` / `[data-testid="prompt-editor"]`, answer `[data-testid="assistant-message"]`); package profile mirrors those selectors but stays tagged unverified for a package-owned capture.

## Capabilities in this package
1. `claude_chat` — UI-path chat: type into the ProseMirror composer, Enter, read the streamed answer off the page. The only capability shipped; provider-catalog documents no other claude endpoints.

## To be verified on first live capture
- Exact composer / answer DOM selectors (profile.json carries candidates only).
- Full cookie set (expiry, CSRF/anti-bot headers).
- Any additional surface (conversation history, artifacts) — NOT fabricated here because provider-catalog does not document them.

## Status
`session.lock.json` = **awaiting-capture**, no snapshot hash.