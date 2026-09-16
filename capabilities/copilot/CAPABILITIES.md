# Microsoft Copilot capabilities (from JS bundle analysis, 2026-09-16)

Analyzed the consumer app at `https://copilot.microsoft.com` (surface id **`cmc`**, errorReportConfig version **`10f62a4-prod`**, env `production`). Host responded **HTTP 200** with full SSR HTML for a Chrome UA — **no bot wall at the HTML/static layer** (see §7). All facts below are static bundle reading: no browser launched, no live socket handshake.

Bundles analyzed (read-only curl, ~2.8 MB total):
- `cop.html` (38.6 KB) — SSR shell: `window.PRE_START_CONFIG`, `window.errorReportConfig`, `__i18n-data__` (24 strings), composer DOM.
- `entry-ssr-j2VGbmp2.js` (1.57 MB) — app kernel: TanStack Router tree, WebSocket chat client + event processor, REST client, feature-flag plumbing.
- `vendor-DnpqayAT.js` (0.88 MB) — shared runtime.
- `msal-baCNE5FO.js` (0.37 MB) — MSAL.js auth.
- `hashcash.worker-DPHM8104.js` (1.1 KB) — WebCrypto SHA-256 proof-of-work worker (see §5).

## 1. Transport: WebSocket, NOT SSE (verified from literals)
- Chat runs over a **WebSocket**, not the historical `/sessions/chat` SSE. URL built by `getWssAPIUrl(path)` →
  **`wss://copilot.microsoft.com/c/api/chat?api-version=2&clientSessionId=<uuid>&features=…&setflight=…&promptBranch=…&countryCode=…&accessToken=…&X-UserIdentityType=…`**.
- API base literals: `VITE_API_URL = "copilot.microsoft.com/c/api"` → `Y3()` returns `${location.origin}/c/api` on the Copilot host; `wss://${host}/c/api/${path}?${query}`.
- Query params: `api-version:"2"`, `clientSessionId` (uuid), comma-joined `features` + `setflight` (experiment flags), optional `promptBranch`, `useSxs`, `sxsFeature`, `countryCode`, `appFlavor=beta` (beta flag), `temporarySessionKey` (anonymous) or `accessToken` + `X-UserIdentityType` (authenticated).
- Connection classes exist for `chat` (`Gl`), `temporary` (`Ki`), `health` (`zl`), and a mock. Socket path literal is **`"chat"`** for both authed and anonymous clients (the research variant uses a different internal path `iTe`, not pinned).

### Outgoing frames (JSON text frames; verified literals)
- `{"event":"send", conversationId, content:[…], mode:"chat"|"research", context}` — core send. `content` piece types: `text`, `command`, `file`, `image`, `reference`, `citations`, `card`. Command examples: `{type:"cancelTask",taskId}`, `{type:"topicClick",topic}`.
- `{"event":"stop", conversationId}`; regenerate frame `{event:"regenerate", messageId, commandMessageId, commandPartId, result}`.
- Heartbeat `{"event":"ping"}` / server replies `{"event":"pong"}` (ping-on-send option, pong timeout tracks liveness).
- `{"event":"challengeResponse", token, method}` — bots: method `cloudflare` (Turnstile), `hashcash`, `copilot`.
- Voice/audio: `audioStart` / `audio` / `audioEnd`, `setCallType`, `startReadAloud`; live-notes + typing: `sendLiveNoteStart/Pause/Stop`, `sendTypingStatus`.
- `{"event":"sendContext", conversationId, context}` — context injection; `{"event":"selectMessage", sideBySideComparisonId, selectedMessageId}` — A/B message selection.
- Send queue carries a resume cursor from `getUrl({cursor})` = `latestMessagePartId` (the `id` of the last inbound frame) — reconnect resumes mid-stream.
- The client blocks sends until the in-stream `challenge` event is answered (challenge-neutral events: `challenge`, `connected`, `pong`).

### Incoming frames (verified event dispatch switch)
JSON frames `{id, event, …}`; `id` feeds the resume cursor. Event names:
`received`, `newMessage`, `connected`, `disconnecting`, `emojiReaction`, `startMessage`, **`appendText`**, **`replaceText`**, `invokeAction`, `browserAutomate`, `chainOfThought` (reasoning tokens), `citation` (Bing search refs), `modelStatement`, `generatingImage`, `partialImageGenerated`, `imageGenerated`, `imageGenerationFailed`, `imageGenerationStatus`, `generatingCard`, `card`, `cardGenerationFailed`, `page`, `titleUpdate`, **`challenge`** (Turnstile/PoW), `document`, `taskStart`, `taskUpdate`, `error`, `chatMessageError`, `podcastError`, `banned`, **`done`** (terminal marker), `startSuggestion`, `appendSuggestion`, `suggestionCompleted`, `activityStart`, `activityUpdate`, `memorySignal`, `sideBySideComparison`, `suggestVision`, `modeSelected`.
Streaming = a `startMessage`/`newMessage` then a sequence of `appendText`/`replaceText` on the message, terminated by `done`. Message model: `author: "user"|"ai"`, `streamingState: "streaming"|"idle"|"interrupted"`, `content[]`.

## 2. REST surface (base `https://copilot.microsoft.com/c/api`)
- `POST /user/sessions/temporary` → `{sessionKey}` — **anonymous session key**, TTL `TEMPORARY_CONVERSATION_SESSION_TTL = 6h`; sent to the socket as `temporarySessionKey` and as header `X-Copilot-TemporarySessionKey` (plus `x-Copilot-Scope`).
- Conversations: `/conversations` CRUD, `/conversations/{id}`, `/conversations/{id}/history?api-version=2`, `/conversations/{id}/messages/{messageId}`, `/conversations/{id}/autosuggest`, `/conversations/{id}/react`, `/conversations/{id}/feedback`, `/conversations/{id}/attachments`, `/conversations/shares/{id}` (+ `/continue`), `/conversations/search/status`, `/conversations/join/{token}`.
- Files/images: `/attachments`, `/attachments/onedrive/` (OneDrive picker), `/sharing/podcasts/{id}`, `/api/sharing/artifacts/`.
- Headers observed: `Authorization: Bearer <MSAL access_token>` (authed), `x-trace-id`, `x-ceto-ref`, `X-Swag-Correlation-Id`, `X-Search-UILang`, `x-msrt-token`, `x-ms-flight`, `X-Copilot-Ring`, `X-Copilot-App-Flavor`, `x-Copilot-Scope`, `X-Copilot-TemporarySessionKey`. Methods GET/POST/PATCH/PUT/DELETE all present.

## 3. Auth & sessions
- Anonymous (profile default): `POST /user/sessions/temporary`, socket opened with `temporarySessionKey`; no cookies required beyond consent/MSCC. No sign-in needed — matches builtin profile `loginRequired:false`.
- Authenticated: MSAL.js bundle; authorities `login.microsoftonline.com/consumers|organizations|common`, `login.live.com`; scopes/clientId injected at runtime. Token goes in the WS query (`accessToken`) and the REST `Authorization` header; `X-UserIdentityType` ∈ {msa, aad/odt}.
- localStorage keys referenced: `hasBeenAuthenticated`, `auth0Migration*`, `auth0UserName`, `auth0UserAvatar`, `selectedVoiceId`, `voiceAppearanceId`, `voiceCharacterName` (voice persona), plus consent/onboarding keys. Cookie `MSCC` via MS consent (`wcp-consent.js`); 1DS analytics cookie manager reads `_mkto_trk` and syncs `MUID` (IdSync).
- `<title>Microsoft Copilot: Your AI companion</title>`; composer placeholder "Message Copilot", input cap 10,240 chars.

## 4. Feature flags, modes & hub sub-surfaces
- Flags ride the WS query (`features`, `setflight`) and `x-ms-flight` header; `appFlavor=beta`. Gate keys seen: `enable-temporary-conversation`, `kill-cf-turnstile`, `client-side-request-challenge`, `ping-on-send`, `kill-chat-auto-reconnect`, `kill-clarity`, `enable_appearance`, `aiModeTabs`, `video-gen`, `custom-1ds`, `sidebar-narrow`, `smart-mode-default`.
- Composer chat modes map (`nAe`): `td`→**reasoning / "Think deeper"**, `sm`→smart, `cs`→**search** (Bing grounding, answers with citations; `citation` inbound event; `bing.com` host), `st`→**study** ("Study and learn"), `ba`→browserAction, `ac`→computerUse. Create modes (`oAe` + composer): `hw`→homeworkHelper, `qz`→quiz, `pt`→practiceTest, `fc`→flashcards, plus image, page, liveNotes, podcast, video, researchReport.
- **Deep research / tasks**: `mode:"research"` over the same socket + `taskStart`/`taskUpdate` in-band; dedicated routes `/research/{id}`, `/tasks/{id}`; `sendCommandResults`/`sendActionResult` for agent/browser actions; `banned`/`taskLimit` errors.
- **Image generation**: `/imagine` route + in-band `generatingImage…imageGenerated` WS events (Bing Image Creator pipeline); gallery under `/imagine/{galleryItemId}`; "3D generations" + portrait labs surface.
- **Voice**: `/chats/{id}/talk`, `/chats/new/talk` routes; `audio*` WS events; `audio-base64.worker-C9NDBjTp.js`.
- Other routes: `/`, `/discover`, `/library`, `/labs/*`, `/agents`, `/health`, `/study`, `/shopping`, `/projects`, `/pages/{id}`, `/daily`, `/gaming`, `/login`, `/subscription/{start|pricing|manage|upsell-start}`, `/conversations/join/{token}`.
- Prompt passthrough: URL `?q=` / `?prompt=` triggers `submitMessage({text, inputMethod})` on load (deep-link to a chat).

## 5. Anti-bot stack (important for automation)
- **Cloudflare Turnstile**: `cf-turnstile`, in-band `challenge` WS event answered with `{event:"challengeResponse", token, method:"cloudflare"}`; kill-flag `kill-cf-turnstile`; render/timeout callbacks.
- **Hashcash proof-of-work** over WebCrypto SHA-256 (`hashcash.worker-DPHM8104.js`): worker protocol `{type:"start", token, difficulty, startNonce, batchSize}` → `{type:"success", nonce, timeElapsed, totalHashes}` (leading-zero-bit check `difficulty`); challenge methods `hashcash` (walkers `webworker`/`mainthread`), `copilot` (proprietary).
- Gating: `isBotDetectionEnabled` surface config + `client-side-request-challenge` flag → `window.MotionIsMounted`/`Mo6us` check before socket connect; counters `botDetectionTriggered`. Static curl+Chrome UA passed; a clean-IP Playwright context is expected to receive Turnstile for the first socket connect — **live challenge outcome is the main open risk** ($7).
- Analytics synced for fingerprinting: 1DS `OneDsAzureAnalytics`, Microsoft Clarity (`n59ae4ieqq`), Bing UET `window.uetq`, TikTok + Snapchat pixels, `bat.bing.com`, Adobe/Google consent via `MSCC`.

## 6. Window hooks
`window.clarity`, `window.OneDsAzureAnalytics`, `window.uetq`, `window.trustedTypes` (+ `copilotTrustedTypesPolicy`), `window.PRE_START_CONFIG`, `window.errorReportConfig`, `window.appStart`/`appEnd`, `window.MotionIsMounted`. No eval-style API exposed; the site drives its own WS/REST.

## 7. Verification status & honest split
**Verified (static, literal evidence above):** transport = WebSocket at `/c/api/chat?api-version=2`; JSON event protocol incl. `send`/`appendText`/`done`/`challenge`; anonymous temp-session endpoint; MSAL auth shape; mode/flag keys; anti-bot = Turnstile + hashcash PoW; REST path inventory; current composer DOM (`#userInput`, `data-testid="composer-input"`, `data-testid="composer-create-button"`, `aria-label="New chat"`). **Bot wall: NOT hit** — HTTP 200 full SSR for both `copilot.microsoft.com` and `copilot.cloud.microsoft` with a Chrome UA.

**To-verify on first live capture / not derivable statically:**
1. Exact `send` frame for a plain text turn (assumed `content:[{type:"text",text}]`; partId/messageId envelope fields inferred from message model, not pinned).
2. Inbound frame envelope beyond `id`+`event` (e.g. `conversationId`/`messageId`/`typeText` field names); `eA.parse` is a zod schema whose name is minified.
3. Whether Turnstile is actually thrown at a clean-IP headless context and whether the hashcash/copilot challenge must be answered before `send`.
4. Answer-message **DOM selectors** for the current React UI (builtin profile's `[data-content="ai-message"]`/`.ac-textBlock`/`.content-ai`/`[data-message-type="text"]` predate this UI and are unverified; SSR confirms only composer DOM).
5. Chat mode encoding on the wire (exact request field(s) that select think-deeper/search/study) and anonymous REST CRUD availability (header requirements).

## 8. Suggested ui2api capability list (id, one-line description)
| id | description |
|----|-------------|
| `copilot_chat_stream` | Open `wss://…/c/api/chat?api-version=2`, answer any `challenge`, send `{event:"send",mode:"chat"}`, read `appendText`/`replaceText` until `done`. |
| `copilot_anonymous_session` | `POST /user/sessions/temporary` → session key; socket `temporarySessionKey` param; no auth. |
| `copilot_search_mode` | Set composer chat-mode `cs` (search) → grounded answers with `citation` events (Bing refs). |
| `copilot_thinking_mode` | Set mode `td` (Think deeper / reasoning) → consume `chainOfThought` + full final text. |
| `copilot_history` | `/conversations/{id}/history?api-version=2` + `/conversations` CRUD + `titleUpdate` events. |
| `copilot_image_gen` | Image generation over `/imagine` via in-band `generatingImage…imageGenerated` WS events; gallery list. |
| `copilot_tasks_deep_research` | `mode:"research"` + `taskStart/taskUpdate` in-band; `/research/{id}` report route. |
| `copilot_voice_talk` | Audio frames over socket (`audioStart`/`audio`/`audioEnd`), `/chats/{id}/talk`, read-aloud. |
| `copilot_share` | Share a conversation (`/conversations/shares/{id}` → `{token}` join link; `/conversations/join/{token}`). |
| `copilot_autosuggest` | `POST /conversations/{id}/autosuggest` for follow-up suggestions; inbound `startSuggestion/appendSuggestion`. |

(Not exposing: browser-computer-use automation (`invokeAction`/`browserAutomate`), subscription/paywall, shopping — agentic/sensitive; they exist as wire events above if a future package needs them.)