# Venice capabilities (scaffold, 2026-09-15)

## What's known (from provider-catalog.md)
- Auth: cookie **`session`** (OmniRoute `venice-web`: kind=cookie, credentialName=`session`).
- Requires a real logged-in session.

## Capability
- `venice_chat` — composer prompt -> streamed answer (ui-path, ChatDriver insertText + Enter).
- Venice advertises private mode, model pickers, and image generation in its product, but NONE of those are catalogued in provider-catalog.md — not packaged yet.

## To be verified on first live capture
- Composer / send / answer selectors (profile.json candidates are generic guesses).
- Underlying API wire (unknown; nothing documented in provider-catalog.md).
- Exact cookie set beyond `session`.
- Whether private-mode / model-picker / image-gen surfaces are worth packaging.