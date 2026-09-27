# ui2api — FUNCTIONS → API → UI MAP

Code-verified as of **2026-09-25 (GOAL 82 fold)**. Every row traced end-to-end
from `capabilities/<site>/manifest.json` → runner dispatch branch in
`src/capabilities/<site>.ts` → served route in `src/prompt/http.ts` /
`src/prompt/openai.ts` → consumer surface in `src/prompt/registry.ts`
(`GET /registry`). Statuses are the honest ones recorded in `AGENTS.md` and
each package's `metadata.json` — never "verified" without a live round-trip.

The headline census below is **machine-parsed by `test/function-doc-truth.test.ts`**
and re-measured from disk by `scripts/measure-function-map.mjs` — these numbers
cannot rot silently.

- **PACKAGES: 33** (a `capabilities/<id>/` dir carrying both `manifest.json`
  and `profile.json`; `hunyuan-yuanbao/` has no manifest and is not a package)
- **CAPABILITIES: 161** (manifest capability functions across the 33 packages)
- **REAL_RUNNERS: 14** — **REAL_CAPS: 85** (live-or-scaffold runner switches)
- **GATED: 19** — **GATED_CAPS: 76** (login-gated-by-design, honest
  `{ok:false, loginGated:true}` with no browser)
- **ROUTES: 1** (`POST /capability/<site>` — ONE table-driven handler in
  `src/prompt/http.ts`; the 33 per-site dispatchers it replaced are now the
  data table `CAPABILITY_DISPATCH` in `src/prompt/capability-dispatch.ts`, one
  row per site. GOAL 140.)
- **SITES_DISPATCHED: 33** (rows in `CAPABILITY_DISPATCH`,
  `src/prompt/capability-dispatch.ts` — the per-site inventory the single
  handler serves)
- **CHAT_PROFILES: 22** (`defaultChatProfiles()`, src/prompt/registry.ts —
  the `GET /sites` list under `src/prompt/http.ts:253`. GOAL 147 dropped
  `google-ai-search`: the BUILTIN loop admitted the whole catalog without the
  `isDriveableChatProfile` gate the packaged loop ran, so a composer-less
  profile whose manifest declares no `*_chat` capability was advertised as a
  chat model with no chat tool behind it. It stays fully served as a capability
  package.)

Every one of the 161 functions has **all three layers**: a dispatch branch in
`src/capabilities/<site>.ts`, a `POST /capability/<site>` route in http.ts, and
a `/registry` tool row. **Zero advertised tools are unreachable.** Suite:
**817 tests / 44 suites (816 pass + 1 env skip)** as of GOAL 82 (re-measured
per flip — the doc's standing count is the node-only `npm run test:unit`
output, never prose).

---

## 0. The three layers (trace mechanics)

| Layer | Files | What it provides |
|---|---|---|
| **FUNCTION** | `capabilities/<site>/manifest.json` (capabilities[] `id/name/description/method`); `src/capabilities/<site>.ts` `run()` switch; `src/profile/profile.ts` `BUILTIN_PROFILES` (chat); `capabilities/<site>/profile.json` (packaged chat selectors). 19 sites dispatch every capability through the shared honest gate `loginGatedResult()` (src/capabilities/gated.ts:38-48) | the actual action the site's own JS/browser performs — or, for a login-gated package, the *declared* action honestly short-circuited until a captured session exists |
| **API** | `src/prompt/http.ts`: bearer gate http.ts:212 (token read :174); capability pre-dispatch manifest guard http.ts:220-237 (unknown → 400 listing `available: [...]`, http.ts:232); `/v1/*` openai.ts delegation http.ts:239-252; `GET /capabilities/<site>` path-form from manifest http.ts:321-346; `POST /capability/<site>` ×**33**; `GET /registry` http.ts:272; `GET /sites` http.ts:253; `GET /status` http.ts:392; `GET /health` http.ts:414; `GET /accounts?site=` http.ts:290; `GET /capabilities?site=&account=` http.ts:350-…; `POST /prompt` http.ts:417; 404 fallback http.ts:1402. `src/prompt/openai.ts` (`GET /v1/models` openai.ts:95, `POST /v1/chat/completions` openai.ts:111, terminal unknown-`/v1` 404 openai.ts:193-208) | the HTTP wire each function is served by |
| **UI / consumer** | `src/prompt/registry.ts` — `buildRegistryPackages()` registry.ts:366 builds the `GET /registry` response from `listInstalledPackageIds()` registry.ts:168 (`capabilities/<id>/manifest.json` on disk), skipping only packages with no packaged profile registry.ts:377 (via `resolvePackagedProfile(siteId)`); each tool from manifest capabilities registry.ts:335-367, inputSchema via `capabilityInputSchema()` registry.ts:198, `status`/`verified` from `metadata.json` registry.ts:392; `/v1/models` = the daemon's configured chat profiles only (http.ts via openai.ts:95) | what OmniRoute materializes (provider = ACTIVE package, tool = capability) |

Route/runner wiring map — all **33** run() dispatch switches and all **33**
`POST /capability/*` routes in http.ts. 14 are full runner implementations
(real switches + honest per-capability gating as their status demands;
statuses per §1). 19 are login-gated-by-design runners whose every `case`
returns `loginGatedResult()` (gated.ts:38-48) — e.g.
src/capabilities/adapta.ts:25-27 dispatches `adapta_chat` → gated, the residual
default still names `unknown <site> capability`.

| runner | dispatch switch | `/capability/<id>` route |
|---|---|---|
| gemini | src/capabilities/gemini.ts:215-223 | http.ts:443 |
| kimi | src/capabilities/kimi.ts:169-179 | http.ts:473 |
| hunyuan | src/capabilities/hunyuan.ts:152-160 | http.ts:502 |
| venice | src/capabilities/venice.ts:164-174 | http.ts:530 |
| deepseek | src/capabilities/deepseek.ts:165-171 | http.ts:559 |
| tencent-aistudio | src/capabilities/tencent-aistudio.ts:148-233 | http.ts:589 |
| claude | src/capabilities/claude.ts:157-165 | http.ts:617 |
| chatgpt | src/capabilities/chatgpt.ts:167-179 | http.ts:644 |
| copilot | src/capabilities/copilot.ts:167-175 | http.ts:671 |
| huggingchat | src/capabilities/huggingchat.ts:169-177 | http.ts:698 |
| youtube | src/capabilities/youtube.ts:172-184 | http.ts:727 |
| gmail | src/capabilities/gmail.ts:172-180 | http.ts:762 |
| araprat | src/capabilities/araprat.ts:220-237 | http.ts:793 |
| duckduckgo | src/capabilities/duckduckgo.ts:235-245 | http.ts:1029 |
| adapta | gated switch → `adapt-…` (src/capabilities/adapta.ts:25-27) | http.ts:823 |
| blackbox | gated switch (per-cap `case`, all `loginGatedResult`) | http.ts:852 |
| chatglm | gated switch (8 caps) | http.ts:881 |
| codex | gated switch (8 caps) | http.ts:910 |
| conol | gated switch (1 cap) | http.ts:939 |
| copilot-m365 | gated switch (5 caps) | http.ts:968 |
| doubao | gated switch (12 caps) | http.ts:997 |
| google-ai-search | gated switch (1 cap) | http.ts:1058 |
| grok | gated switch (1 cap) | http.ts:1087 |
| inner-ai | gated switch (6 caps) | http.ts:1116 |
| manus | gated switch (5 caps) | http.ts:1145 |
| notion | gated switch (5 caps) | http.ts:1174 |
| perplexity | gated switch (1 cap) | http.ts:1203 |
| poe | gated switch (1 cap) | http.ts:1232 |
| t3chat | gated switch (5 caps) | http.ts:1261 |
| tinycms | gated switch (1 cap) | http.ts:1290 |
| v0 | gated switch (9 caps) | http.ts:1319 |
| xiaomimimo | gated switch (3 caps) | http.ts:1348 |
| zenmux | gated switch (1 cap) | http.ts:1377 |

Cross-checks verified by reading the tests:

- **3-layer closure for EVERY package** is enforced by
  `test/function-api-ui-closure.test.ts`: for all 33 packaged sites it asserts
  (A) every manifest capability has a `case` label in the runner (no dead
  `unknown <site> capability` fall-through reachable for a declared capability),
  (B) a `req.url === "/capability/<site>"` dispatcher exists in http.ts, and
  (C) `GET /registry` emits a `<site>_<capability>` tool per manifest
  capability. For the 19 LOGIN_GATED_BY_DESIGN sites it additionally asserts
  the runner source dispatches through an honest `loginGated` branch and, in a
  live-behavior guard, that each capability returns `ok:false loginGated:true`
  naming the site with **no browser ever launched** and an unknown name still
  lands in the dead default.
- **14 RUNNERS** are enforced in `test/capability-dispatch.test.ts` (RUNNERS
  table lines 70-169): kimi, hunyuan, venice, deepseek, tencent-aistudio,
  claude, chatgpt, gemini, huggingchat, copilot, youtube, araprat, gmail,
  duckduckgo. The manifest↔dispatch drift gate is **HARD** since GOAL 79
  (`HARD_FAIL_ON_DRIFT = true`, capability-dispatch.test.ts:16-39) — a runner
  added without a manifest row, or vice versa, FAILS the suite.
- **Headline census is pinned since GOAL 82** by
  `test/function-doc-truth.test.ts` against `scripts/measure-function-map.mjs`
  (same disk sources): packages, capability total, real/gated split, route
  count, and `defaultChatProfiles()` length — a manual doc edit that drifts
  from disk falls RED.
- Every real runner's `run()` default branch returns `{ok:false, error:"unknown
  <id> capability: …"}` **before** any `ensureBrowser()`/`openPage()` call —
  no browser is ever launched for an unknown capability name.
- **Pre-dispatch manifest guard** http.ts:220-237 rejects `POST /capability/<x>`
  anything not declared by the package manifest with
  `400 {error:"unknown capability "<cap>" for "<site>"; available: […]}`
  **before** any runner/browser work — `/registry` tools and the API accept
  exactly the same capability set.

---

## 1. Site map

### 1.1 gemini — https://gemini.google.com (builtin profile.ts:90-134, manifest, verified)

| Function | Source | STATUS |
|---|---|---|
| `gemini_chat` | manifest id → runner gemini.ts:215; ChatDriver via pool shared browser; also builtin `POST /prompt` | **VERIFIED** (vault, PONG re-verified 2026-09-21, fold #17f; jsIndex `default_BardChatUi.dTi` capture proof profile.ts:100-107) |
| `gemini_list_conversations` | gemini.ts:217 — batchexecute RPC, DOM-sidebar fallback | **VERIFIED** |
| `gemini_model_list` | gemini.ts:219 — WIZ_global_data / dom-picker read | **VERIFIED** |
| `gemini_search_toggle` | gemini.ts:221 — composer search switch | **VERIFIED** |
| `gemini_file_upload` | gemini.ts:223 — the composer's real hidden `input[type='file']` via `setInputFiles` (GOAL 53, 2026-09-25); honest unverified-candidate: stored sources replay signed-out, `ok:true` = input accepted not upload | **WIRED (unverified-candidate)** |

### 1.2 kimi — https://www.kimi.ai (builtin profile.ts:232-281, verified)

- `kimi_chat` kimi.ts:169 — **VERIFIED** (proof PASS kimi 13965, 2026-09-19; answer selector excludes the thinking block, profile.ts:252-260).
- `kimi_web_search` kimi.ts:175 — **VERIFIED** (toolkit drawer; manifest desc `LIVE-VERIFIED 2026-09-19`).
- `kimi_list_conversations` kimi.ts:171 — **VERIFIED** (sidebar DOM, 15 items; manifest desc).
- `kimi_model_list` kimi.ts:173 — **VERIFIED** (`[data-testid="model-select-trigger"]` → `button.model-item`).
- `kimi_file_upload` kimi.ts:177 — **VERIFIED** (`label.toolkit-item` + hidden input; `setInputFiles`, no filechooser).
- `kimi_long_context` kimi.ts:179 — **SCAFFOLD→VERIFIED-surface** (ChatRequestOptions context_length; wire-mapped).

### 1.3 deepseek — https://chat.deepseek.com (builtin profile.ts:282-319, verified)

- `deepseek_chat` deepseek.ts:165 — **VERIFIED** (proof PASS 11462, 2026-09-19; vault).
- `deepseek_list_conversations` deepseek.ts:167 — **VERIFIED** (sidebar `a[href*='/chat/']`, both `/chat/<id>`+`/a/chat/s/<uuid>` shapes).
- `deepseek_reasoner` deepseek.ts:169 — **VERIFIED** (REAL composer toggle DeepThink, `div.ds-toggle-button` → `ds-toggle-button--selected`, feeds `thinking_enabled`; abilityToggle `id:"reasoner"` profile.ts:307).
- `deepseek_web_search` deepseek.ts:171 — **VERIFIED** (real "Search" toggle → `search_enabled`).

### 1.4 tencent-aistudio — https://aistudio.tencent.ai (builtin profile.ts:320-351; `realProfileOnly`, headed/real-Chrome ONLY — EdgeOne blocks headless HTTP 567)

- `tencent_aistudio_chat` tencent-aistudio.ts:148 — **VERIFIED** (proof 6916 headed 2026-09-19; re-verified through the wire 2026-09-23 proof "415"; `preComposeDelayMs:8000` profile.ts:348; answer `.agent-chat__bubble--ai .hyc-content-md → .hyc-common-markdown`, completion marker "Completed").
- `tencent_aistudio_conversation_crud` tencent-aistudio.ts:150 — **VERIFIED list+open** (History → `/chat-history` renders `div.list-item` rows title/model/type; row click navigates `/chat/HunyuanDefault/<id>?from=history`; ids click-only, rows are divs not anchors — 2026-09-23 live).
- `tencent_aistudio_deep_think` tencent-aistudio.ts:152 — **HONEST BLOCKED** (no deep-think toggle on the current Hy4 preview composer — output renders but there is no switch to expose).
- `tencent_aistudio_web_search` tencent-aistudio.ts:165 — **HONEST BLOCKED** (no 搜索/联网 toggle on the current composer).
- `tencent_aistudio_image_gen` tencent-aistudio.ts:177 — **HONEST BLOCKED** (image surface = separate hy3d.tencent.ai app; `/image` is a dead route).
- `tencent_aistudio_code_run` tencent-aistudio.ts:189 — **HONEST BLOCKED** (`/code` dead route).
- `tencent_aistudio_file_upload` tencent-aistudio.ts:200 — **HONEST BLOCKED** (no `input[type=file]`/attach found on the current composer).
- `tencent_aistudio_tts` tencent-aistudio.ts:211 — **HONEST BLOCKED** (`/tts` dead route).
- `tencent_aistudio_podcast` tencent-aistudio.ts:221 — **HONEST BLOCKED** (`/podcast` dead route).
- `tencent_aistudio_translations` tencent-aistudio.ts:233 — **HONEST BLOCKED** (`/translate` dead route).

### 1.5 youtube — https://www.youtube.com (NOT a chat site; packaged profile only — no builtin, sees note profile.ts:373-378)

- `youtube_search` youtube.ts:172 — **VERIFIED** (proof 10 rows 2026-09-20 attached Chrome/152; `ytd-video-renderer a#video-title` read-back).
- `youtube_transcript` youtube.ts:174 — **LOGIN-GATED** (UI path expands panel but `get_transcript` answers HTTP 400 without SAPISID — honest, not claimed).
- `youtube_comment` youtube.ts:176 — **LOGIN-GATED** (dispatch implemented 2026-09-21; browser-bound auth → never fabricated).
- `youtube_like` youtube.ts:178 — **LOGIN-GATED** (`ytd-segmented-like-dislike-button` clicks; account-bound).
- `youtube_subscribe` youtube.ts:180 — **LOGIN-GATED**, **origin-pinned**: `channelId` (or `@handle` / full URL) is validated and REBUILT by `assertChannelUrl()` (src/runtime/ssrf.ts:22-45, `UC[\w-]{22}` id / `@[\w.\-]{1,64}` handle shapes only) before any `openPage(url)` — raw caller input can never become a cross-origin navigation.
- `youtube_upload` youtube.ts:182 — **LOGIN-GATED** (needs user's real attached Chrome — Google app-bound cookies; never fabricated).
- `youtube_playlist_add` youtube.ts:184 — **LOGIN-GATED** (Save menu `button[aria-label^=Save]`).

### 1.6 araprat — https://www.aparat.com (NOT a chat site; packaged profile only)

- `araprat_search` araprat.ts:220 — **VERIFIED** (`/search/<q>` grid `a[href*='/v/']`, 30 deduped rows, live 2026-09-20 proof).
- `araprat_trending` araprat.ts:222 — **VERIFIED** (52 `/v/` anchors on `/home`).
- `araprat_video_detail` araprat.ts:224 — **VERIFIED** (`h1` + `div.description` + related; og:/twitter metas DEAD).
- `araprat_comment` araprat.ts:232 — **LOGIN-GATED** (`this.loginGated(capability)`, araprat.ts:229-239: `ok:false loginGated:true`, no browser).
- `araprat_like` araprat.ts:233 — **LOGIN-GATED**.
- `araprat_follow` araprat.ts:234 — **LOGIN-GATED**.
- `araprat_subscribe` araprat.ts:235 — **LOGIN-GATED**.
- `araprat_upload` araprat.ts:236 — **LOGIN-GATED**.
- `araprat_playlist` araprat.ts:237 — **LOGIN-GATED**.

### 1.7 duckduckgo — https://duck.ai (anonymous chat; packaged profile; runner VERIFIED 2026-09-23)

- `duckduckgo_chat` duckduckgo.ts:235 — **VERIFIED** (headed Xvfb round-trip: composer + Enter → consent wall → refocus → site's own JS `POST /duckchat/v1/chat` SSE; answer via `[id*='assistant-message']`; proofs "say hi"→"Hi", "2+2?"→"2 + 2 = 4").
- `duckduckgo_model_picker` duckduckgo.ts:237 — **VERIFIED** (composer chip → menu `[role='menuitemradio']` rows testid `model-picker-row-<id>`, aria-checked).
- `duckduckgo_web_search` duckduckgo.ts:239 — **VERIFIED** (Tools → Web Search row → chip `button[aria-label='Remove Web Search']`; enabled chat carried a REAL WebSearch tool-invocation).
- `duckduckgo_file_upload` duckduckgo.ts:241 — **VERIFIED** (setInputFiles on composer `input[type='file']`, accept-list enforced → chip read-back).
- `duckduckgo_reasoning` duckduckgo.ts:243 — **VERIFIED** (reasoning-mode button text flip; `extended` honestly `ok:false` — not offered on free GPT-5.6 Luna).
- `duckduckgo_chat_history` duckduckgo.ts:245 — **VERIFIED** (real IndexedDB `savedAIChatData` + sidebar corroboration).

### 1.8 gmail — https://mail.google.com (NOT a chat site; packaged profile only; `auth.required:true` — GOAL 19 measured 2026-09-23)

- `gmail_read_inbox` gmail.ts:172 — **DOM-UNVERIFIED (auth-walled)** — real Playwright UI path reading rendered conversation rows; mail.google.com is 100% behind the Google auth wall (every path measured 302 → accounts.google.com/ServiceLogin), so selectors are known-stable Gmail surface names, explicitly DOM-unverified.
- `gmail_list_threads` gmail.ts:174 — **DOM-UNVERIFIED (auth-walled)**.
- `gmail_open_thread` gmail.ts:176 — **DOM-UNVERIFIED (auth-walled)**.
- `gmail_search` gmail.ts:178 — **DOM-UNVERIFIED (auth-walled)**.
- `gmail_send` gmail.ts:180 — **LOGIN-GATED by design** (dispatched honestly `ok:false` until a real captured/attached session exists — NEVER fabricated; mutation).

Auth class: Google web session with the app-bound-cookie caveat (same as
youtube posting) — the honest primary seam is the user's own real Chrome
attached via `UI2API_ATTACH_PORT=9222`. `session.lock` stays awaiting-capture.
**Not a chat site — never a `/v1` model; present only on /registry + /capability.**

### 1.9 hunyuan — https://yuanbao.tencent.com (builtin profile.ts:352-372 — packaged profile copy, note "UNVERIFIED selectors")

- `hunyuan_chat` hunyuan.ts:152 — **SCAFFOLD** (no session ANYWHERE on the box; hy_user/hy_token domain cookies never generated — fold #17f dead-end; profile selectors verbatim-unverified profile.ts:371).
- `hunyuan_list_conversations` hunyuan.ts:154 — **SCAFFOLD**.
- `hunyuan_deep_search` hunyuan.ts:156 — **SCAFFOLD**.
- `hunyuan_document_qa` hunyuan.ts:158 — **SCAFFOLD**.
- `hunyuan_voice_mode` hunyuan.ts:160 — **SCAFFOLD**.

### 1.10 venice — https://venice.ai (packaged profile only; runner in-sync with the 14-runner gate; venice is a chat site — `/v1` surface presence governed by the GOAL 30/34 driveable gate, not this table)

- `venice_chat` venice.ts:164 — **SCAFFOLD**
- `venice_list_conversations` venice.ts:166 — **SCAFFOLD**
- `venice_model_list` venice.ts:168 — **SCAFFOLD**
- `venice_image` venice.ts:170 — **SCAFFOLD**
- `venice_video` venice.ts:172 — **SCAFFOLD**
- `venice_audio` venice.ts:174 — **SCAFFOLD**

### 1.11 claude / chatgpt / copilot / huggingchat (builtin chat profiles + runners)

- claude: `claude_chat` claude.ts:157, `claude_list_conversations` claude.ts:159, `claude_extended_thinking` claude.ts:161, `claude_artifacts` claude.ts:163, `claude_web_search` claude.ts:165 — all **SCAFFOLD** runner-dispatch (DOM/wire-mapped, no captured session, never claimed verified).
- chatgpt: `chatgpt_chat` chatgpt.ts:167, `chatgpt_conversation_crud` chatgpt.ts:169, `chatgpt_web_search` chatgpt.ts:171, `chatgpt_upload_attach` chatgpt.ts:173, `chatgpt_artifacts` chatgpt.ts:175, `chatgpt_gpts` chatgpt.ts:177, `chatgpt_voice` chatgpt.ts:179 — **SCAFFOLD** dispatch.
- copilot: `copilot_chat` copilot.ts:167, `copilot_search_mode` copilot.ts:169, `copilot_thinking_mode` copilot.ts:171, `copilot_history` copilot.ts:173, `copilot_image_gen` copilot.ts:175 — **SCAFFOLD** dispatch. (chat itself is anonymous-capable builtin profile.ts:192-205.)
- huggingchat: `huggingchat_chat` huggingchat.ts:169, `huggingchat_conversations` huggingchat.ts:171, `huggingchat_models` huggingchat.ts:173, `huggingchat_settings` huggingchat.ts:175, `huggingchat_mcp` huggingchat.ts:177 — **SCAFFOLD** dispatch.

### 1.12 — the 19 login-gated-by-design packages (route + dispatch, honest ok:false loginGated:true)

Every capability below is dispatched by its own runner switch (all returning
`loginGatedResult()` — gated.ts:38-48), served by its own `/capability/<site>`
route, emitted as a `/registry` tool, and verified at runtime by
`test/function-api-ui-closure.test.ts` to settle `{ok:false, loginGated:true}`
with **no browser launch**. The gating is a *status*, not a gap: `ok:false` +
`loginGated:true` + an error naming the site and the missing precondition is
the honest answer until a live capture + implementation lands.

| site | caps | route | notes |
|---|---|---|---|
| adapta | 1 | http.ts:823 | gated; scaffold/awaiting-capture |
| blackbox | 2 | http.ts:852 | gated |
| chatglm | 8 | http.ts:881 | gated |
| codex | 8 | http.ts:910 | gated |
| conol | 1 | http.ts:939 | gated |
| copilot-m365 | 5 | http.ts:968 | gated |
| doubao | 12 | http.ts:997 | gated |
| google-ai-search | `google_ai_mode_search` (1) | http.ts:1058 | gated (NOT a chat model — GOAL 147: composer-less profile, no `*_chat` capability, so it is absent from `defaultChatProfiles()` / `/v1/models` while remaining served here; BLOCKED at the site — portal v20 external sign-in, fold #17f honest dead-end; manifest tool now dispatches honestly gated instead of dead) |
| grok | 1 | http.ts:1087 | gated |
| inner-ai | 6 | http.ts:1116 | gated |
| manus | 5 | http.ts:1145 | gated |
| notion | 5 | http.ts:1174 | gated |
| perplexity | 1 | http.ts:1203 | gated (also builtin `POST /prompt` chat profile) |
| poe | 1 | http.ts:1232 | gated |
| t3chat | 5 | http.ts:1261 | gated |
| tinycms | 1 | http.ts:1290 | gated (`metadata.status: "dead-end"` — tool inert but honestly gated, not fabricated) |
| v0 | 9 | http.ts:1319 | gated |
| xiaomimimo | 3 | http.ts:1348 | gated |
| zenmux | 1 | http.ts:1377 | gated |

Sum: **76 functions / 19 packages** — every one route-reachable, no dead
branch reachable by a declared capability, no browser launched.

---

## 2. Layer 2 — HTTP endpoints (all bound 127.0.0.1, bearer-token gate http.ts:212)

| Method | Path | Body | Response | Dispatch → source |
|---|---|---|---|---|
| POST | `/prompt` | `{prompt, site?, newChat?, account?, model?}` (http.ts:417) | `{ok, answer, chunkCount, doneReason, url, title[, citations]}` | `pool.acquire(site, account)` → `worker.driver.ask` (ChatDriver) http.ts:417-… |
| POST | `/capability/<site>` ×**33** (14 real runners http.ts:443-793 + 1029, 19 gated http.ts:823-997 + 1058-1377) | `{capability, args?}` | `200` ok:true → result; `ok:false → 502`, throw → 500; unknown/undeclared capability → `400 {error:"unknown capability "<cap>" for "<site>"; available: […]}` (pre-dispatch manifest guard http.ts:220-237, 400 at :232) | manifest guard `registryPackageFor(site)` http.ts:224 → `new <Site>Capabilities(profile, {browser: pool.sharedBrowser()})` → `run()` switch (table in §0) |
| GET | `/capabilities/<site>` | — | `200 {site, name, url, capabilities:[{id,name,description,method}], accounts}` for EVERY installed package (gate = package existence, not profile — works for capability-first sites like youtube/araprat); `400 {error:"no capability package installed for "<site>"}` otherwise | path-form branch http.ts:321-346 (regex http.ts:322, response http.ts:327-344) from `registryPackageFor(site)` → manifest `tools[]` |
| GET | `/registry` | — | `{packages:[{id,name,url,description,version,site,authRequired,status,verified,chat?:{model,streaming} /* ONLY on the servable chat surface — GOAL 34: refused packages carry no chat key */,tools:[{name,id,description,method,workType,reloadAfterSuccess,inputSchema}]}], generatedAt}` | `buildRegistryPackages()` registry.ts:366 |
| GET | `/sites` | — | `{sites:[{id,name,url,loginRequired,status}]}` — the driveable chat catalog http.ts:253 | `defaultChatProfiles()` (22 — measured 2026-09-27) → `chatSurfaceStatus(id)` |
| GET | `/v1/models` | — | `{object:"list", data:[{id,object,created,owned_by:"ui2api",root,parent,site,url,loginRequired}]}` openai.ts:95 | `Object.values(profilesById)` — configured chat profiles only |
| POST | `/v1/chat/completions` | `{model?"ui2api/<site>"\|"ui2api-<site>", messages:[{role,content\|parts}], stream?, new_chat?, account?}` openai.ts:111 | non-stream: chat.completion JSON + `ui2api` meta (openai.ts:171-185); stream: SSE `chat.completion.chunk` → `[DONE]` replay of the completed DOM answer (openai.ts:153-169) | `siteIdFromModel` openai.ts:55 → `profileById` (origin pin) → `pool.acquire` → `driver.ask` |
| GET | `/status` / `/health` (`/`) | — | `{ok, pool:{…}}` http.ts:392 / http.ts:414 | pool.status |
| GET | `/accounts?site=` | — | vault accounts for a site http.ts:290 | `listAccounts` session-store |
| GET | `/capabilities?site=&account=` | — | stored per-account capability fingerprint http.ts:350-… | `loadCapabilities` session-store |
| * | anything else (non-`/v1`) | — | `404 {error:"not found"}` http.ts:1402 | — |
| * | **any unmatched `/v1/*`** (e.g. `/v1/embeddings`, wrong method on `/v1/...`) | — | `404 {error:{message, type:"invalid_request_error", code:"not_found"}}` — terminal fallback in openai.ts:193-208 (GOAL 81: no `/v1/*` request may hang the connection; the native http.ts:1402 404 stays the non-`/v1` fallback) | `handleOpenAIRoutes` terminal return |

Field mapping detail: the registry tool's **`id`** (raw, e.g. `tencent_aistudio_chat`) is what `/capability/<site>` accepts as `body.capability`; the tool **`name`** is the consumer/MCP id `<site>_<bare>` (e.g. `tencent-aistudio_chat` — the bare strip eats the underscore form). OmniRoute prefixes its own namespace: `ui2api_<site>_<capability>` (registry.ts:21-23). The new path-form `GET /capabilities/<site>` and the pre-dispatch 400 branch read the SAME manifest-derived set, so all surfaces agree.

---

## 3. Layer 3 — Consumer surface trace

`GET /registry` is **derived only from installed packages**:
1. `listInstalledPackageIds()` registry.ts:168 reads `capabilities/*/manifest.json` on disk.
2. Each id must also resolve a packaged profile via `resolvePackagedProfile(siteId)` (profile.ts) or the package is **skipped** (registry.ts:377).
3. `tools[]` = one entry per manifest `capabilities[].id` (registry.ts:335-367); `workType` = `js-function` only when `method === "js-function"`, else `ui-path` (registry.ts:412).
4. `status` + `verified` come from each package's `metadata.json` (registry.ts:392) — bare `true` is refused, matching `scripts/validate-registry.mjs` (lines 71-81).
5. `inputSchema` is derived per capability shape (registry.ts:198-217): chat → `{prompt, new_chat}` (+ `thinking`/`search` booleans if the description names them); toggle (`reasoner|web_search|search|toggle|_state`) → `{state}`; read (`list_conversations|model_list|history`) → `{limit, account}`; everything else → `{}`.

Every registry tool row maps 1:1 to a dispatch branch and a route (closure
test A+B+C, §0). **No tool row is unreachable**: for the 14 real runners the
branch executes the site action; for the 19 gated package tools the branch
returns the honest login-gated short-circuit.

`GET /v1/models` is **not** the registry — it lists only the daemon's configured
chat profiles. `defaultChatProfiles()` (registry.ts:347) currently enumerates
**22** (measured 2026-09-27; re-measure with
`node scripts/measure-function-map.mjs`, which spawns the real registry — the
same seam that feeds the `CHAT_PROFILES:` census line at the top): the builtin
catalog — minus `google-ai-search`, which has a composer-less profile, no
`*_chat` manifest capability and a `loginGatedResult(...)` runner, so it is no
chat model — plus every installed driveable chat-shaped package
whose composer/answer selectors parse. Capability-only packages (gmail,
youtube, araprat, …) and dormant/dead-end packages are **absent from /v1/models**
even though they exist in `/registry` and on `/capability/<site>` — that is
expected: /v1 is the chat surface, /capability + /registry is the general
capability surface.

---

## 4. Appendix — RESIDUAL GAPS vs. HONEST GATING

Cross-checked: 3-layer closure test (`test/function-api-ui-closure.test.ts`, all
33 packages), the 14-runner manifest↔dispatch gate
(`test/capability-dispatch.test.ts`, HARD since GOAL 79), the GOAL 82 census pin
(`test/function-doc-truth.test.ts`), the 33-route table in http.ts, and the
registry builder. Result:

1. **Routes — full coverage.** Every installed package (33/33) has a
   `POST /capability/<site>` dispatcher (http.ts:443-1377) and answers
   `GET /capabilities/<site>` from its manifest (http.ts:321-346). The prior
   "82 functions / 20 packages have NO runner and NO route" gap predates fold
   #17f and is **closed**: those now dispatch through honest login-gated
   branches (76/19 measured 2026-09-25).
2. **Reachability — zero advertised tools are unreachable.** For every one of
   the 161 manifest capability ids across all 33 packages there is (a) a `case` label
   in its runner (closure test A), (b) a `/capability/<site>` route accepting it
   (closure test B), (c) a `/registry` tool row named `site_<cap>` (closure
   test C), and (d) either a real execution path (14 runners / 85 caps) or an
   honest `ok:false loginGated:true` short-circuit verified with no browser
   (guard test). Unknown names are rejected with a 400 listing `available: [...]`
   (http.ts:232) or the runner's dead default — never a fabricated success.
   **RESIDUAL GAP FOUND: none.**
3. **The only status difference is honest gating.** 14 sites run real switches
   (85 functions; live-verified families: gemini, kimi, deepseek,
   tencent-aistudio chat/conversations, youtube search, araprat
   search/trending/detail, duckduckgo all 6; the rest run honest
   SCAFFOLD/LOGIN-GATED/DEAD-END per-status branches: hunyuan, venice, claude,
   chatgpt, copilot, huggingchat, gmail auth-walled); 19 sites (76 functions)
   are login-gated-by-design until a captured session + implementation lands.
   Both classes ship declared manifest metadata; neither ever fakes an outcome.
4. **Security hardening landed.** `youtube_subscribe` validates `channelId`
   via `assertChannelUrl()` (ssrf.ts:22-45; rebuilds the URL from a `UC{22}`
   id, `@handle`, or same-host https URL — rejects cross-origin hosts and
   non-https) before any navigation; used with `sameOrigin()` (ssrf.ts:1-7) for
   the other posting caps. `/v1/*` hangs are impossible since GOAL 81 (terminal
   unknown-endpoint 404 in openai.ts:193-208).
5. **Stale code comments (not gaps — honesty notes):** http.ts comments above
   the deepseek and youtube routes predate their verifications; the map above
   reflects AGENTS.md/metadata, not those comments.

**Bottom line:** all **33 packages / 161 functions** are closed across
FUNCTION → API → UI. Every package has a route; every tool is reachable; the
only status difference is honest gating (14 real/live-or-scaffold runner sites
vs 19 login-gated-by-design); zero advertised tools are unreachable; suite green
(verified per flip: `npx tsc --noEmit`, `npm run test:unit` — the count is
re-measured on every fold, never reused from prose).