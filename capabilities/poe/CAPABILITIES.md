# Poe capabilities (scaffold, 2026-09-15)

## What's known (from provider-catalog.md)
- Auth: cookie **`p-b`** (OmniRoute `poe-web`: kind=cookie, credentialName=`p-b`).
- Requires a real logged-in session; the app may serve from `www.poe.com`.
- No endpoint shapes are documented for poe in provider-catalog.md.

## Capability
- `poe_chat` — composer prompt -> streamed answer (ui-path, ChatDriver insertText + Enter).

## To be verified on first live capture
- Composer / send / answer selectors (profile.json candidates are generic guesses).
- Underlying API wire (Poe has historically used GQL-style channel RPC; nothing documented here).
- Exact cookie set beyond `p-b`; cookie domain (poe.com vs www.poe.com).
- New-chat control and dismissable overlays.