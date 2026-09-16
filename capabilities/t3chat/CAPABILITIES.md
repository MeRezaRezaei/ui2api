# t3.chat capabilities (from provider-catalog + third-party clones, 2026-09-15)

**Ground-truth status: BOT-WALLED — NO live bundles recovered.**

t3.chat (https://t3.chat) is behind a Vercel Security Checkpoint bot wall. Every path returns HTTP 429 with body "We're verifying your browser" — including `/_next/build-manifest.json`, `/_next/static/chunks/*`, `/api/chat`, `/api/auth/session`, `/trpc/*`, and `/`. Zero JS bundles were recoverable via static curl. The public repo `github.com/t3-oss/t3-chat` returns 404 (private or non-existent as of 2026-09-16). All findings below are sourced from:

- **provider-catalog.md lines 53 + 83** (the ONLY documented auth facts): `t3-web` (cookie, `convex-session-id + Cookie header`) and `t3-chat-web` (token, `token`)
- **Third-party clone repos** (NOT ground truth): `TGlide/thom-chat`, `TomDoesTech/t3-chat`, `shaltielshmid/NotT3Chat`, `Hairetsu/NOT-T3-Chat`, `lulkebit/t3-cloneathon`, `heymaaz/t3.chat.cloneathon` — all use Convex + Next.js; confirm the tech stack but NOT the live wire
- **Public knowledge**: t3.chat is a Next.js/Convex LLM aggregator by Theo Browne (t3-oss) that routes prompts to Claude (Anthropic), GPT-4 (OpenAI), Gemini (Google), and other backends through a single chat UI

## Transport (UNVERIFIED — no bundle literals recovered)

- **Expected**: Convex real-time subscriptions over WebSocket (`wss://*.convex.cloud`) for live chat streaming + standard Convex mutations/queries for CRUD; Next.js API routes (`/api/chat`, `/api/auth/*`) likely proxy or relay
- **provider-catalog evidence**: `t3-web` entry = cookie auth with `convex-session-id` — confirms Convex as the backend; `t3-chat-web` entry = token auth with `token` — suggests an API-key mode exists
- **Streaming mechanism**: UNKNOWN from static analysis. Convex supports server-push via subscriptions (not SSE); the clone repos show `useQuery`/`useMutation` patterns (Convex client hooks), not SSE or fetch streaming. But the live site may use Next.js streaming (Route Handlers returning ReadableStream) or Vercel AI SDK patterns — **cannot confirm without bundles**
- **Auth scheme**: TWO documented modes from provider-catalog: (1) cookie: `convex-session-id` + full Cookie header, (2) token: a bearer token (exact storage location unknown — localStorage vs cookie vs httpOnly). No bundle evidence of JWT structure or refresh mechanism

## Chat core (UNVERIFIED)

- **Model/provider switching**: Widely documented in public discourse and clone repos: t3.chat lets users pick Claude 3.5/4, GPT-4o/4, Gemini Pro/Ultra, Llama, etc. via a model selector dropdown. **No bundle literals, DOM selectors, or API payloads verified.**
- **Wire path**: Clone repos suggest the chat goes through Convex mutations — e.g. `api.chat.send` or similar. The live site may use Vercel AI SDK (`/api/chat` with streaming response) or Convex server actions. **Unknown.**
- **SSE/Stream delta**: If using Vercel AI SDK, the response would be `POST /api/chat` returning `text/event-stream` with JSON delta chunks. If using Convex subscriptions, updates arrive via WebSocket. **Cannot determine which path the live site uses.**

## Auth & session (UNVERIFIED — provider-catalog only)

- `convex-session-id` cookie is documented for `t3-web` — this is the Convex auth session identifier
- A `token` credential is documented for `t3-chat-web` — may be a Convex auth token or a custom API key
- No JWT structure, refresh flow, or localStorage keys recovered
- Login likely via OAuth (Google, GitHub) or email — clone repos use Convex Auth or Clerk; **the live site's auth provider is unknown**

## Files: upload & analysis

- **No evidence from static analysis.** Clone repos show file/image attachment support via Convex storage or Vercel Blob; **not verified against the live site.**

## Thread & conversation management

- Clone repos show chat history stored in Convex `chats` and `messages` tables; real-time subscription keeps the sidebar in sync. **Not verified against the live site.**

## Anti-bot notes

- **Vercel Security Checkpoint** (JavaScript challenge) blocks all non-browser requests. The challenge runs an obfuscated JS evaluation via a Web Worker (`...v2.mic...s` script), checks for mouse movement, and issues a token cookie on pass. 15-second timeout before failure.
- Getting past this requires a real browser (Playwright with stealth, or UI2API_USER_DATA_DIR with a real Chrome profile). curl-based discovery is impossible.

## Suggested ui2api capability list (id, one-line description) — max 12 (ALL UNVERIFIED)

1. `t3chat_chat` — Send a prompt via the chat composer; answer streamed from the selected LLM backend (wire path UNKNOWN — Convex mutation or Vercel AI SDK /api/chat)
2. `t3chat_model_switch` — Select which LLM backend to use (Claude, GPT, Gemini, etc.) via the model picker dropdown (UNVERIFIED)
3. `t3chat_conversation_crud` — List/get/rename/delete conversations (Convex-backed, UNVERIFIED)
4. `t3chat_file_upload` — Attach files/images to a chat (UNVERIFIED — clone repos suggest Convex Blob storage)
5. `t3chat_search_toggle` — Web search grounding toggle if exposed in the live UI (UNVERIFIED — no evidence of this capability on the live site)
6. `t3chat_web_search` — In-chat internet search if available (UNVERIFIED)
7. `t3chat_model_list` — Read available models from the model picker (UNVERIFIED)
8. `t3chat_voice` — Voice input/transcription if exposed (UNVERIFIED)
9. `t3chat_stream_raw` — Direct streaming access to the LLM response bypassing DOM reading (UNVERIFIED — requires understanding the wire protocol)

(Not listing more than 9 — no evidence supports additional capabilities)

## Verification status

| Finding | Status | Source |
|---|---|---|
| Site is Vercel-deployed Next.js | PROBABLE | Vercel Security Checkpoint page content; Vercel deployment header `fra1::...` |
| Backend is Convex | PROBABLE | provider-catalog `t3-web` entry: credentialName `convex-session-id` |
| Auth = cookie (convex-session-id + Cookie header) | CATALOG-SOURCED | provider-catalog.md line 53 |
| Auth = token (token) | CATALOG-SOURCED | provider-catalog.md line 83 |
| Chat composer exists | UNVERIFIED | Every chat UI has one; no selectors proven |
| Model switching (Claude/GPT/Gemini) | UNVERIFIED | Public discourse + clone repos; no bundle/DOM evidence |
| Streaming via SSE | UNVERIFIED | Plausible (Vercel AI SDK common pattern); not proven |
| Streaming via Convex subscription | UNVERIFIED | Plausible (Convex is the backend); not proven |
| github.com/t3-oss/t3-chat repo exists | DISPROVEN | Returns 404 on 2026-09-16 |
| Any JS bundle content | DISPROVEN | Vercel Security Checkpoint (429) blocks all static curl |
