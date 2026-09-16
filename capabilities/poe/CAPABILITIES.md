# Poe capabilities (from attempted bundle analysis, 2026-09-16)

Analysis constrained: **poe.com is bot-walled.** `curl` (Chrome-120-style UA, several variants) to
`https://poe.com`, `https://www.poe.com`, and `https://poe.com/login` all return **HTTP 403
"Just a moment…"** — a Cloudflare-managed interstitial (challenge script + Turnstile from
`challenges.cloudflare.com`). The challenge HTML ships a CSP allowing only `challenges.cloudflare.com`
and **contains no app JS bundle URLs**, so no transport/RPC surface could be recovered by static
analysis. Everything below the "Verified" headings is prior documented/community knowledge and is
**unverified**.

## Verified (this environment)
- Transport gate: Cloudflare challenge on every probed path (403 challenge page; ~5.6 KB HTML with no
  `src=`/`href=` app bundles). Fetching the app shell or any JS bundle requires solving the challenge —
  out of scope here (repo rule: no browser launch, static analysis only).
- No `window.*` exposure, API path, fetch target, or streaming mechanism could be observed (no bundle
  was retrievable).
- Auth fact (from `provider-catalog.md`, OmniRoute `poe-web`): auth kind=`cookie`, credential **`p-b`**.
- The existing ui2api ChatDriver ui-path flow (composer insertText + Enter, read streamed answer) is
  the correct fallback and depends only on selectors + a real session, not on the wire.

## Community-documented (prior knowledge — TO VERIFY on first live capture)
- The SPA serves routes like `/` (chat list), `/u/:handle` (bot pages), `/c/:threadId` (thread), and a
  composer for many models (Claude, GPT, Gemini, Llama, plus user-made bots).
- Historically the composer posts GraphQL-ish JSON to `https://poe.com/api/gql_POST` (HTTP POST) and
  streams the answer over a server-push channel (SSE-style); WS variants under `/api/...` have been
  described by community clients. **Endpoint names above are recall, not this analysis — confirm the
  real request shapes via DevTools on the first live capture before relying on any of them.**
- A request-level CSRF token (historically `t`, aka "formkey") has been embedded in the SPA boot
  payload next to app settings; expect to extract it alongside the session when reconstructing the
  first request.

## Verified vs to-verify split
- **Verified:** Cloudflare wall exists on all tested hosts/paths; `p-b` cookie auth fact from
  provider-catalog; no static surface (no bundles, no RPC, no streaming evidence retrievable here).
- **To verify on first live capture** (data/poe.com/.session + DevTools network tab):
  real transport + endpoint(s); streaming mechanism (SSE vs WS vs polling); composer/send/answer
  selectors; cookie set + cookie domain (poe.com vs www.poe.com); new-chat control; CSRF `t`/formkey;
  Cloudflare Turnstile behavior inside a real (non-headless) Playwright context.

## Capability list
- `poe_chat` — composer prompt → streamed answer via ui-path (ChatDriver insertText + Enter, site's
  own send handler). Implementation hint: proceed with the generic contenteditable composer
  candidates in profile.json; tune selectors against real DOM on first live capture; then, if desired,
  peel the real wire off the first captured request to add an `rpc` short-path capability later.