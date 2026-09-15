# Google AI search capabilities (from network/JS analysis, 2026-09-15)

Research notes: all findings below are from this host (geolocated Germany, Google auto-serves `lang=de`), fetched with a real Chrome 131 UA via `curl`. Nothing was logged in; no browser was launched. "Verified" = reproduced with curl in this session; "bundle" = found in the downloaded `boq-bard-web` JS bundles; "prior art" = from public reverse-engineering/press, NOT reproducible here because the endpoint needs a live session. Fingerprints are byte-counts/HTTP codes/marker strings so future runs can diff against them.

## 1. Direct URL scheme (what actually works, verified by curl)

**Headline result:** from this region, `www.google.com/search` no longer server-renders results to a non-JS client at all. Every variant returns the same "enable JS" bootstrap shell. So there is NO curl-able plain-HTML AI Mode from here — the AI Mode render requires the search page's JavaScript bundle to run with cookies. The `udm` parameter IS validated and preserved server-side (passed through to the JS client), which is the strongest static signal we can get.

Verified per-request fingerprints:

| intent | URL pattern | what comes back (verified fingerprint) |
|---|---|---|
| Classic search | `https://www.google.com/search?q=<q>&hl=en` | HTTP 200, `Content-Type: text/html; charset=UTF-8`, `Server: gws`, ~92 KB shell. `<title>Google Search</title>`, `lang="de"`. **No** `AF_initDataCallback`, **no** result markup. Single retry link embeds `emsg=SG_REL` + your `q` + `sca_esv` + `sei`. Cookie replies: `SEARCH_SAMESITE`, `AEC`, `__Secure-ENID`. |
| AI Mode | `https://www.google.com/search?q=<q>&udm=14&hl=en` | Identical wall (200 / 92 KB / `emsg=SG_REL`). The retry link echoes `udm=14` → param recognized & preserved server-side. |
| AI Overviews filter | `...&udm=50` | Same wall; `udm=50` echoed. |
| Web/Images/Videos/etc. | `udm=1,2,3,4,5,15,18,21,44` | Same wall; **each udm value echoed** in the retry URL → server validates the param space. |
| Invalid udm | `udm=26`, `udm=99` | `udm` **dropped** from the retry link → param space is closed; those values are not recognized. |
| Search root | `https://www.google.com/?hl=en` | 200 plain homepage, no wall, no consent redirect (no `CONSENT` cookie set). |
| `/async/` family | `/async/olaa_single?async=forum_id:x,...` | 404 in anonymous shell (only callable after JS boots + auth). |
| `...&async=ai:1` | `/search?q=test&udm=14&async=ai:1` | Same 200 wall (async token appears ignored anonymously). |

`udm` meaning (prior art; param is server-validated here but render meaning comes from press/JS client): `udm=14` = **AI Mode** (dedicated AI-only tab, pasted into `/search` since the March 2025 launch), `udm=2` = Images, `udm=5` = Videos, `udm=1/44` = Web filters. AI Mode reuses the standard `/search` SSR page: the rendered AI answer + citations arrives inside the `AF_initDataCallback` JSON blocks (the `{"aiMode"...}` / `kont`-style data), and follow-up prompts are just more `/search?q=...&udm=14` loads with the conversation state carried in `sei`/`sxsrf`/`sca_esv`. No separate RPC endpoint exists for it — that's the good news for ui2api: an agent needs ONLY the normal Google Search page + cookies, no custom backend.

**Fingerprint constant for regression tests:** the anonymous Search wall is exactly `~92 KB`, `<title>Google Search</title>`, one `emsg=SG_REL` link.

## 2. gemini.google.com search tool

**Verified surface (anonymous curl):**
- `https://gemini.google.com/app` → 200, ~840 KB BOQ-era app shell, `<title>Google Gemini</title>`, `Server: ESF`, `X-Frame-Options: DENY`, cookie `__Secure-ENID` (anonymous). No consent redirect.
- RPC base: **`/_/BardChatUi/data/batchexecute`** on `gemini.google.com` (string `"BardChatUi/data"` + `"batchexecute"` confirmed in bundle). Anonymous POST → **HTTP 400** with body `)]}'\n[["er",null,null,null,null,400,null,null,null,3],["di",<n>],["af.httprm","<n>","<random-id>",<n>]]`. So the batch frontend is reachable anonymously and hands out an `af.httprm` anti-replay id, but the inner RPC handlers reject unauthenticated calls with a generic 400. Logged-in requests carry session cookies + `f.req` payloads.
- App bundles: direct `/`_`/js/k=boq-bard-web.BardChatUi...` → **404** on both `www.google.com` and `gemini.google.com` (session-gated). **BUT the same bundle downloads fine from the managed-static host discovered in the page CSP:** `https://gemini.gstatic.com/_/mss/boq-bard-web/_/js/k=boq-bard-web.BardChatUi.<ver>/am=.../d=1/.../m=_b?wli=...` → **200**, 115 KB app module + 2.9 MB cached kernel. This is the reproducible analysis surface.

**From the 2.9 MB kernel bundle (`bard_bundle_1.js`):**
- Core chat RPC: **`assistant.lamda.BardFrontendService/StreamGenerate`** (short tag `RxAFq`) on `/_/BardChatUi/data/batchexecute`. Streaming; this is the only "ask Gemini" pipe.
- Other streaming methods: `StreamGenerateArtifact` (`ZiDWTc`), `StreamGenerateYourDay` (`Skfdkd`), `StreamGmailInlineRewrite` (`OcOsnb`), `GenerateBrandKit`, `GetTtsStream`, `ProcessFile`. 111 total `BardFrontendService.*` methods registered (includes `AbortGeneration`, `SearchConversations`, etc.).
- Search / Web-access plumbing (the "search" toggle):
  - **`BardFrontendService/GetAllToolConsentData`** — returns the per-tool consent state (this is what sets the Web Access switch).
  - **`BardFrontendService/UpdateToolPermission`** — toggles a tool on/off.
  - **`BardFrontendService/GetMentionableTools`** — the list of @-mentionable tools (search among them).
- `StreamGenerate` request proto: field **2 = `"tools"`**, field 3 = `"p13n"`, 4 = `"context"`, 5 = `"safety"`, 6 = `"formatting"`. So the on/off switch maps to a `tools:` entry inside the StreamGenerate body (prior art shape: `tools:[{"google_search":{}}]`, mirroring the public REST API's `google_search` tool).
- With search ON, the backend runs a Google Search then feeds snippet results into the model's context; citations come back inside the stream output as source chips with `attribution/source` metadata (the bundle contains an `attribution` + `request_source`/`detected_request_language` mapping used to render those source cards). The user never sees a distinct search endpoint — it is a tool inside the one streaming RPC.
- The bundle also recognizes `generativelanguage.googleapis.com/v1beta/models/...` (regex) — internal/server responses may be expressed in the same shape as the public Gemini API, which is the best mapping reference for constructing `StreamGenerate` bodies.
- Two internal API keys are embedded in the bundle (e.g. `AIzaSyBGb5fGAyC-pRcRU6MUHb__b_vKha71HRE`, `AIzaSyC-ZHwKiKTHrerA8sAZBW_gzJ2U5vPAFyY`) — public-in-bundle but heavily quota/binding restricted; treat as unusable-in-practice.

**How "search" merges into the answer (mechanism):** toggle state → `UpdateToolPermission`; then every `StreamGenerate` POST includes the `tools` field while ON; server performs search, injects top results as context, model emits synthesis + `attribution`/source chips; client renders chips. All inside the one streaming HTTP body on `batchexecute`.

## 3. Auth requirements per surface

| surface | anonymous (verified) | logged-in (inferred/prior art) |
|---|---|---|
| `google.com/search` plain | 200 but **JS wall** (`emsg=SG_REL`) — no results, only `SEARCH_SAMESITE`, `AEC`, `__Secure-ENID` cookies | NID/SID (+`__Secure-3PSID*`) → full SSR with `AF_initDataCallback` results; AI Mode needs the account to be in AI Mode rollout eligible set (the server silently degrades to normal results otherwise). |
| `google.com/search?udm=14` | same wall, param preserved | AI Mode render (AI answer + citations in the SSR init data); `udm=14` honored. |
| `gemini.google.com/app` | 200 shell (no auth to download shell/bundles) | Gemini UI; features like Workspace/search require login. |
| `gemini.google.com/_/BardChatUi/data/batchexecute` | reachable, everything → **HTTP 400** `["er",...400...,"af.httprm",...]` | session cookies + `f.req` + `at` → live streaming. |
| `*/_/mss/boq-bard-web/_/js/*` bundles | **200, no auth** (this is the reproducible analysis surface) | n/a |

## 4. Stealth-relevant observations

- **The `emsg=SG_REL` JS-wall is universal for non-JS clients in this region** — a curl-only agent (no browser engine) cannot render either Google AI surface from here; a headless browser is mandatory for v1. This is a "needs JS" gate, not a bot-captcha, so behaving like a normal JS browser is the whole game.
- Recognized `udm` set is closed (`1,2,3,4,5,14,15,18,21,44,50`); unknown values are silently dropped — cheap fingerprint to stay inside.
- Repeated anonymous hits to `batchexecute` are cheap to detect: each 400 response mints a distinct `af.httprm` nonce and the responses carry `Server: ESF`; there is no rate-limit message at 400, but hammering the batch frontend unauthenticated is the kind of thing an automated-pattern filter keys on. Must use the user's real session cookie jar, not raw anonymous probes, in production.
- Consent wall: **absent** from this region — `/` and `/app` serve directly with no `CONSENT` redirect; only the expected `SEARCH_SAMESITE`/`AEC`/`__Secure-ENID` cookies are negotiated. (Region-dependent; other IPs may hit `consent.google.com`.)
- `X-Frame-Options` (search: `SAMEORIGIN`, Gemini: `DENY`) → embedding surfaces in iframes is blocked; ui2api must run them as top-level documents (or use the browser's real tab).
- Bundle downloads from the `/_/mss/` host are happily unauthenticated — this is also an intelligence surface for keeping capability parity when Google updates AI features (re-resolve the CSP bundle URL from the app page, re-download, re-grep for `StreamGenerate`/method tables).

## 5. Suggested ui2api capabilities (max 8)

1. **google_ai_mode_search** *(NUMBER ONE — first working package)* — open `google.com/search?q=<prompt>&udm=14` in the user's logged-in session, wait for the AI answer block in the SSR init data, return `{answer, citations[]}` as JSON. Single page load, no custom RPC, uses real session cookies, looks exactly like a human clicking "AI Mode".
2. **gemini_search_toggle_result** — in the user's Gemini tab, turn on search (Web Access), send prompt via the page's own composer, capture StreamGenerate stream output, return `{answer, sources[]}`. Heavier (must sit on the real streaming UI) but the "search tool" analog.
3. **google_ai_overview** — classic query without `udm`, extract the AI Overviews block (when present) + organic results in one call; fallback when `udm=14` render fails.
4. **google_search_results** — plain parsed results (title/url/snippet) for non-AI queries where the user wants classic SERP only.
5. **google_web_filter_search** — `udm=1` (web-filter) variant; useful to dedupe sources/citations against English/indexed lists.
6. **gemini_grounded_query** — like #2 but return the raw source-citation list ("source chips") separately for citation-first consumers.
7. **ai_image_search** — `udm=2` images + AI Overview co-answer; narrow niche.
8. **google_ai_mode_followup** — AI Mode with conversation state (`sei`/`sca_esv` continuity) so an agent can ask follow-ups in the same AI Mode thread.

---

**5-line completion summary:**
- **Surfaces verified:** google.com/search (all udm values → JS-required `emsg=SG_REL` wall, ~92 KB, no SSR data); gemini.google.com app shell (200); `_/BardChatUi/data/batchexecute` (reachable, anonymous 400); and — the key win — the `boq-bard-web` JS bundles download unauthenticated from `gemini.gstatic.com/_/mss/boq-bard-web/_/js/` (115 KB + 2.9 MB analyzed).
- **URL patterns found:** search page = `?q=…&udm=14` (AI Mode), `udm∈{1,2,3,4,5,14,15,18,21,44,50}` server-validated; Gemini chat = `/_/BardChatUi/data/batchexecute` with `assistant.lamda.BardFrontendService/StreamGenerate` + `UpdateToolPermission`/`GetAllToolConsentData`/`GetMentionableTools` for the search tool; StreamGenerate field 2 = `tools`.
- **Auth notes:** everything anonymous is reachable but either JS-walled (search) or 400-inner-RPC (Gemini batch). Real renders need the user's NID/SID/`__Secure-3PSID` cookies and JS execution; no consent wall in this region.
- **Recommended first capability:** `google_ai_mode_search` — a single logged-in `udm=14` page load parsed into `{answer, citations}`; no custom endpoint, maximal legitimacy.
- **Open questions needing a live-browser test later:** exact `AF_initDataCallback` key shape for the udm=14 answer block; whether unlogged-in/rolled-out users get degraded AI Mode; whether StreamGenerate tool id is literally `google_search` in the current proto; the `af.httprm`/session-token flow for authenticated `batchexecute`; and whether AI Mode persists conversation across `sei` values.