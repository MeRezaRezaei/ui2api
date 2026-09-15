# DeepSeek capabilities (scaffold, 2026-09-15)

## What's known (from provider-catalog.md)
- Auth: token **`userToken`** (OmniRoute `deepseek-web`: kind=token, credentialName=`userToken`).
- Token storage location (localStorage vs cookie) is not documented; verify on first capture.
- Requires a real logged-in session on `chat.deepseek.com`.

## Capability
- `deepseek_chat` — composer prompt -> streamed answer (ui-path, ChatDriver insertText + Enter).

## To be verified on first live capture
- Composer / send / answer selectors (.ds-markdown is a guess from the current UI markup).
- How `userToken` is replayed (header / cookie / localStorage).
- deepseek-reasoner rendering (likely a separate CoT answer block) — unverified, un-packaged.