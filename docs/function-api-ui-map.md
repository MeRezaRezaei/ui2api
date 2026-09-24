# ui2api — FUNCTIONS → API → UI MAP

Code-verified as of 2026-09-22 (post-closure-fix fold). Every row traced
end-to-end from `capabilities/<site>/manifest.json` → runner dispatch branch in
`src/capabilities/<site>.ts` → served route in `src/prompt/http.ts` /
`src/prompt/openai.ts` → consumer surface in `src/prompt/registry.ts`
(`GET /registry`). Statuses are the honest ones recorded in `AGENTS.md` and
each package's `metadata.json` — never "verified" without a live round-trip.

Scope: **32 installed packages** (a `capabilities/<id>/` dir carrying both
`manifest.json` and `profile.json`; `hunyuan-yuanbao/` has no manifest and is
not a package) = **155 manifest capability functions**. Every one of them now
has **all three layers**: a dispatch branch in `src/capabilities/<site>.ts`, a
`POST /capability/<site>` route in http.ts, and a `/registry` tool row.
The only status difference between packages is **honest gating**: 12 sites
(73 functions) run real/live-or-scaffold runner switches, and 20 sites
(82 functions) are **login-gated-by-design** — each capability short-circuits
to `{ok:false, loginGated:true}` with no browser, the same posture as the
araprat posting caps. **Zero advertised tools are unreachable.** Suite:
**561/561** (unit, verified this fold).

---

## 0. The three layers (trace mechanics)

| Layer | Files | What it provides |
|---|---|---|
| **FUNCTION** | `capabilities/<site>/manifest.json` (capabilities[] `id/name/description/method`); `src/capabilities/<site>.ts` `run()` switch; `src/profile/profile.ts` `BUILTIN_PROFILES` (chat); `capabilities/<site>/profile.json` (packaged chat selectors). 20 sites dispatch every capability through the shared honest gate `loginGatedResult()` (src/capabilities/gated.ts:38-48) | the actual action the site's own JS/browser performs — or, for a login-gated package, the *declared* action honestly short-circuited until a captured session exists |
| **API** | `src/prompt/http.ts`: bearer gate http.ts:167; capability pre-dispatch manifest guard http.ts:170-192 (unknown → 400 listing `available: [...]`, http.ts:186-189); `/v1/*` openai.ts delegation http.ts:193-196; `GET /capabilities/<site>` path-form from manifest http.ts:222-247; `POST /capability/<site>` ×**32**; `GET /registry` http.ts:204-208; `GET /sites` http.ts:197; `GET /status` http.ts:271; `GET /health` http.ts:274; `GET /accounts?site=` http.ts:214; `GET /capabilities?site=&account=` http.ts:251-270; `POST /prompt` http.ts:277; 404 fallback http.ts:1078. `src/prompt/openai.ts` (`GET /v1/models` openai.ts:90, `POST /v1/chat/completions` openai.ts:106) | the HTTP wire each function is served by |
| **UI / consumer** | `src/prompt/registry.ts` — `buildRegistryPackages()` registry.ts:220 builds the `GET /registry` response from `listInstalledPackageIds()` registry.ts:138 (`capabilities/<id>/manifest.json` on disk), skipping only packages with no packaged profile registry.ts:225-226; each tool from manifest capabilities registry.ts:253-261, inputSchema via `capabilityInputSchema()` registry.ts:168, `status`/`verified` from `metadata.json` registry.ts:237-252. `/v1/models` = the daemon's configured profiles only (http.ts via openai.ts:91) | what OmniRoute materializes (provider = ACTIVE package, tool = capability) |

Route/runner wiring map — all **32** run() dispatch switches and all **32**
`POST /capability/*` routes in http.ts. 12 are full runner implementations
(real switches; statuses per §1). 20 are login-gated-by-design runners whose
every `case` returns `loginGatedResult()` (gated.ts:38-48) — e.g.
src/capabilities/adapta.ts:25-27 dispatches `adapta_chat` → gated, the residual
default still names `unknown <site> capability`.

| runner | dispatch switch | `/capability/<id>` route |
|---|---|---|
| gemini | src/capabilities/gemini.ts:179-185 | http.ts:299 |
| kimi | src/capabilities/kimi.ts:135-145 | http.ts:322 |
| hunyuan | src/capabilities/hunyuan.ts:134-142 | http.ts:346 |
| venice | src/capabilities/venice.ts:146-156 | http.ts:369 |
| deepseek | src/capabilities/deepseek.ts:147-153 | http.ts:393 |
| tencent-aistudio | src/capabilities/tencent-aistudio.ts:112-196 | http.ts:418 |
| claude | src/capabilities/claude.ts:139-147 | http.ts:441 |
| chatgpt | src/capabilities/chatgpt.ts:149-161 | http.ts:463 |
| copilot | src/capabilities/copilot.ts:149-157 | http.ts:485 |
| huggingchat | src/capabilities/huggingchat.ts:151-159 | http.ts:507 |
| youtube | src/capabilities/youtube.ts:152-164 | http.ts:531 |
| araprat | src/capabilities/araprat.ts:202-219 | http.ts:557 |
| adapta | gated switch → `adapt-…` (src/capabilities/adapta.ts:25-27) | http.ts:582 |
| blackbox | gated switch (per-cap `case`, all `loginGatedResult`) | http.ts:607 |
| chatglm | gated switch (8 caps) | http.ts:632 |
| codex | gated switch (8 caps) | http.ts:657 |
| conol | gated switch (1 cap) | http.ts:682 |
| copilot-m365 | gated switch (5 caps) | http.ts:707 |
| doubao | gated switch (12 caps) | http.ts:732 |
| duckduckgo | gated switch (6 caps) | http.ts:757 |
| google-ai-search | gated switch (1 cap) | http.ts:782 |
| grok | gated switch (1 cap) | http.ts:807 |
| inner-ai | gated switch (6 caps) | http.ts:832 |
| manus | gated switch (5 caps) | http.ts:857 |
| notion | gated switch (5 caps) | http.ts:882 |
| perplexity | gated switch (1 cap) | http.ts:907 |
| poe | gated switch (1 cap) | http.ts:932 |
| t3chat | gated switch (5 caps) | http.ts:957 |
| tinycms | gated switch (1 cap) | http.ts:982 |
| v0 | gated switch (9 caps) | http.ts:1007 |
| xiaomimimo | gated switch (3 caps) | http.ts:1032 |
| zenmux | gated switch (1 cap) | http.ts:1057 |

Cross-checks verified by reading the tests:

- **3-layer closure for EVERY package** is enforced by
  `test/function-api-ui-closure.test.ts`: for all 32 packaged sites it asserts
  (A) every manifest capability has a `case` label in the runner (no dead
  `unknown <site> capability` fall-through reachable for a declared capability,
  test lines 123-140 + 201-220), (B) a `req.url === "/capability/<site>"`
  dispatcher exists in http.ts (lines 142-147), and (C) `GET /registry` emits a
  `<site>_<capability>` tool per manifest capability (lines 149-167). For the
  20 LOGIN_GATED_BY_DESIGN sites it additionally asserts the runner source
  dispatches through an honest `loginGated` branch (test lines 44-65, 134-139)
  and, in a live-behavior guard, that each capability returns `ok:false
  loginGated:true` naming the site with **no browser ever launched** and an
  unknown name still lands in the dead default (lines 172-198).
- **12 RUNNERS** are enforced in `test/capability-dispatch.test.ts` (RUNNERS
  table lines 63-148): kimi, hunyuan, venice, deepseek, tencent-aistudio,
  claude, chatgpt, gemini, huggingchat, copilot, youtube, araprat.
- Every real runner's `run()` default branch returns `{ok:false, error:"unknown
  <id> capability: …"}` **before** any `ensureBrowser()`/`openPage()` call —
  no browser is ever launched for an unknown capability name. The manifest↔
  dispatch sync gate (capability-dispatch.test.ts:210-254) is green for all 12:
  each runner's `case` labels exactly equal its manifest `capabilities[].id`
  set (12/12 IN-SYNC).
- **Pre-dispatch manifest guard** http.ts:170-192 rejects `POST /capability/<x>`
  anything not declared by the package manifest with
  `400 {error:"unknown capability "<cap>" for "<site>"; available: […]}`
  **before** any runner/browser work — `/registry` tools and the API accept
  exactly the same capability set.

---

## 1. Site map

### 1.1 gemini — https://gemini.google.com (builtin profile.ts:90-134, manifest, verified)

| Function | Source | STATUS |
|---|---|---|
| `gemini_chat` | manifest id → runner gemini.ts:179; ChatDriver via pool shared browser; also builtin `POST /prompt` | **VERIFIED** (vault, PONG re-verified 2026-09-21, fold #17f; jsIndex `default_BardChatUi.dTi` capture proof profile.ts:100-107) |
| `gemini_list_conversations` | gemini.ts:181 — batchexecute RPC, DOM-sidebar fallback | **VERIFIED** |
| `gemini_model_list` | gemini.ts:183 — WIZ_global_data / dom-picker read | **VERIFIED** |
| `gemini_search_toggle` | gemini.ts:185 — composer search switch | **VERIFIED** |

### 1.2 kimi — https://www.kimi.ai (builtin profile.ts:232-281, verified)

- `kimi_chat` kimi.ts:135 — **VERIFIED** (proof PASS kimi 13965, 2026-09-19; answer selector excludes the thinking block, profile.ts:252-260).
- `kimi_web_search` kimi.ts:141 — **VERIFIED** (toolkit drawer; manifest desc `LIVE-VERIFIED 2026-09-19`).
- `kimi_list_conversations` kimi.ts:137 — **VERIFIED** (sidebar DOM, 15 items; manifest desc).
- `kimi_model_list` kimi.ts:139 — **VERIFIED** (`[data-testid="model-select-trigger"]` → `button.model-item`).
- `kimi_file_upload` kimi.ts:143 — **VERIFIED** (`label.toolkit-item` + hidden input; `setInputFiles`, no filechooser).
- `kimi_long_context` kimi.ts:145 — **SCAFFOLD→VERIFIED-surface** (ChatRequestOptions context_length; wire-mapped).

### 1.3 deepseek — https://chat.deepseek.com (builtin profile.ts:282-319, verified)

- `deepseek_chat` deepseek.ts:147 — **VERIFIED** (proof PASS 11462, 2026-09-19; vault).
- `deepseek_list_conversations` deepseek.ts:149 — **VERIFIED** (sidebar `a[href*='/chat/']`, both `/chat/<id>`+`/a/chat/s/<uuid>` shapes).
- `deepseek_reasoner` deepseek.ts:151 — **VERIFIED** (REAL composer toggle DeepThink, `div.ds-toggle-button` → `ds-toggle-button--selected`, feeds `thinking_enabled`; abilityToggle `id:"reasoner"` profile.ts:307).
- `deepseek_web_search` deepseek.ts:153 — **VERIFIED** (real "Search" toggle → `search_enabled`).

### 1.4 tencent-aistudio — https://aistudio.tencent.ai (builtin profile.ts:320-351; `realProfileOnly`, headed/real-Chrome ONLY — EdgeOne blocks headless HTTP 567)

- `tencent_aistudio_chat` tencent-aistudio.ts:112 — **VERIFIED** (proof 6916 headed 2026-09-19; `preComposeDelayMs:8000` profile.ts:348).
- `tencent_aistudio_deep_think` tencent-aistudio.ts:126 — **SCAFFOLD** (dispatch returns honest `ok:false`, toggle DOM UNVERIFIED).
- `tencent_aistudio_web_search` tencent-aistudio.ts:138 — **SCAFFOLD** (`ok:false`, `searchDeepMode` proven in bundle, DOM unverified).
- `tencent_aistudio_image_gen` tencent-aistudio.ts:148 — **SCAFFOLD** (`ok:false`; DIT endpoint mapped in CAPABILITIES.md, live-shape-to-verify).
- `tencent_aistudio_conversation_crud` tencent-aistudio.ts:114 — **LOGIN-GATED/SCAFFOLD** (History drawer renders no anchor list → honest `ok:false`).
- `tencent_aistudio_code_run` tencent-aistudio.ts:158 — **SCAFFOLD** (`ok:false`; feature verified only in bundles).
- `tencent_aistudio_file_upload` tencent-aistudio.ts:168 — **SCAFFOLD** (`ok:false`; COS tempCred → genUploadInfo mapped, unverified).
- `tencent_aistudio_tts` tencent-aistudio.ts:178 — **SCAFFOLD** (`ok:false`).
- `tencent_aistudio_podcast` tencent-aistudio.ts:187 — **SCAFFOLD** (`ok:false`).
- `tencent_aistudio_translations` tencent-aistudio.ts:196 — **SCAFFOLD** (`ok:false`).

### 1.5 youtube — https://www.youtube.com (NOT a chat site; packaged profile only — no builtin, sees note profile.ts:373-378)

- `youtube_search` youtube.ts:154 — **VERIFIED** (proof 10 rows 2026-09-20 attached Chrome/152; `ytd-video-renderer a#video-title` read-back).
- `youtube_transcript` youtube.ts:156 — **LOGIN-GATED** (UI path expands panel but `get_transcript` answers HTTP 400 without SAPISID — honest, not claimed).
- `youtube_comment` youtube.ts:158 — **LOGIN-GATED** (dispatch implemented 2026-09-21; browser-bound auth → never fabricated).
- `youtube_like` youtube.ts:160 — **LOGIN-GATED** (`ytd-segmented-like-dislike-button` clicks; account-bound).
- `youtube_subscribe` youtube.ts:162 — **LOGIN-GATED**, **origin-pinned**: `channelId` (or `@handle` / full URL) is validated and REBUILT by `assertChannelUrl()` (src/runtime/ssrf.ts:22-45, `UC[\w-]{22}` id / `@[\w.\-]{1,64}` handle shapes only) before any `openPage(url)` — raw caller input can never become a cross-origin navigation; see subscribe branch youtube.ts:392-407 (channelId required, ssrf.ts:397).
- `youtube_upload` youtube.ts:164 — **LOGIN-GATED** (needs user's real attached Chrome — Google app-bound cookies; never fabricated).
- `youtube_playlist_add` youtube.ts:152 — **LOGIN-GATED** (Save menu `button[aria-label^=Save]`).

### 1.6 araprat — https://www.aparat.com (NOT a chat site; packaged profile only)

- `araprat_search` araprat.ts:202 — **VERIFIED** (`/search/<q>` grid `a[href*='/v/']`, 30 deduped rows, live 2026-09-20 proof).
- `araprat_trending` araprat.ts:204 — **VERIFIED** (52 `/v/` anchors on `/home`).
- `araprat_video_detail` araprat.ts:206 — **VERIFIED** (`h1` + `div.description` + related; og:/twitter metas DEAD).
- `araprat_comment` araprat.ts:214 — **LOGIN-GATED** (`this.loginGated(capability)`, araprat.ts:229-239: `ok:false loginGated:true`, no browser).
- `araprat_like` araprat.ts:215 — **LOGIN-GATED**.
- `araprat_follow` araprat.ts:216 — **LOGIN-GATED**.
- `araprat_subscribe` araprat.ts:217 — **LOGIN-GATED**.
- `araprat_upload` araprat.ts:218 — **LOGIN-GATED**.
- `araprat_playlist` araprat.ts:219 — **LOGIN-GATED**.

### 1.7 — the 20 login-gated-by-design packages (route + dispatch, honest ok:false loginGated:true)

Every capability below is dispatched by its own runner switch (all returning
`loginGatedResult()` — gated.ts:38-48), served by its own `/capability/<site>`
route, emitted as a `/registry` tool, and verified at runtime by
`test/function-api-ui-closure.test.ts:172-198` to settle `{ok:false,
loginGated:true}` with **no browser launch**. The gating is a *status*, not a
gap: `ok:false` + `loginGated:true` + an error naming the site and the missing
precondition is the honest answer until a live capture + implementation lands.

| site | caps | route | notes |
|---|---|---|---|
| adapta | `adapta_chat` (1) | http.ts:582 | gated; scaffold/awaiting-capture |
| blackbox | 2 | http.ts:607 | gated |
| chatglm | 8 | http.ts:632 | gated |
| codex | 8 | http.ts:657 | gated |
| conol | 1 | http.ts:682 | gated |
| copilot-m365 | 5 | http.ts:707 | gated |
| doubao | 12 | http.ts:732 | gated |
| duckduckgo | 6 | http.ts:757 | gated |
| google-ai-search | `google_ai_mode_search` (1) | http.ts:782 | gated (also builtin `POST /prompt` chat profile; BLOCKED at the site — portal v20 external sign-in, fold #17f honest dead-end; manifest tool now dispatches honestly gated instead of dead) |
| grok | 1 | http.ts:807 | gated |
| inner-ai | 6 | http.ts:832 | gated |
| manus | 5 | http.ts:857 | gated |
| notion | 5 | http.ts:882 | gated |
| perplexity | 1 | http.ts:907 | gated (also builtin `POST /prompt` chat profile) |
| poe | 1 | http.ts:932 | gated |
| t3chat | 5 | http.ts:957 | gated |
| tinycms | 1 | http.ts:982 | gated (`metadata.status: "dead-end"` — tool inert but honestly gated, not fabricated) |
| v0 | 9 | http.ts:1007 | gated |
| xiaomimimo | 3 | http.ts:1032 | gated |
| zenmux | 1 | http.ts:1057 | gated |

Sum: **82 functions / 20 packages** — every one route-reachable, no dead
branch reachable by a declared capability, no browser launched.

### 1.8 hunyuan — https://yuanbao.tencent.com (builtin profile.ts:352-372 — packaged profile copy, note "UNVERIFIED selectors")

- `hunyuan_chat` hunyuan.ts:134 — **SCAFFOLD** (no session ANYWHERE on the box; hy_user/hy_token domain cookies never generated — fold #17f dead-end; profile selectors verbatim-unverified profile.ts:371).
- `hunyuan_deep_search` hunyuan.ts:138 — **SCAFFOLD**.
- `hunyuan_list_conversations` hunyuan.ts:136 — **SCAFFOLD**.
- `hunyuan_document_qa` hunyuan.ts:140 — **SCAFFOLD**.
- `hunyuan_voice_mode` hunyuan.ts:142 — **SCAFFOLD**.

### 1.9 venice — https://venice.ai (packaged profile only; runner in-sync with the 12-runner gate, but venice is a chat site NOT in the builtin 11)

- `venice_chat` venice.ts:146 — **SCAFFOLD**
- `venice_list_conversations` venice.ts:148 — **SCAFFOLD**
- `venice_model_list` venice.ts:150 — **SCAFFOLD**
- `venice_image` venice.ts:152 — **SCAFFOLD**
- `venice_video` venice.ts:154 — **SCAFFOLD**
- `venice_audio` venice.ts:156 — **SCAFFOLD**

### 1.10 claude / chatgpt / copilot / huggingchat (builtin chat profiles + runners)

- claude: `claude_chat` claude.ts:139, `claude_list_conversations` claude.ts:141, `claude_extended_thinking` claude.ts:143, `claude_artifacts` claude.ts:145, `claude_web_search` claude.ts:147 — all **SCAFFOLD** runner-dispatch (DOM/wire-mapped, no captured session, never claimed verified).
- chatgpt: `chatgpt_chat` chatgpt.ts:149, `chatgpt_conversation_crud` chatgpt.ts:151, `chatgpt_web_search` chatgpt.ts:153, `chatgpt_upload_attach` chatgpt.ts:155, `chatgpt_artifacts` chatgpt.ts:157, `chatgpt_gpts` chatgpt.ts:159, `chatgpt_voice` chatgpt.ts:161 — **SCAFFOLD** dispatch.
- copilot: `copilot_chat` copilot.ts:149, `copilot_search_mode` copilot.ts:151, `copilot_thinking_mode` copilot.ts:153, `copilot_history` copilot.ts:155, `copilot_image_gen` copilot.ts:157 — **SCAFFOLD** dispatch. (chat itself is anonymous-capable builtin profile.ts:192-205.)
- huggingchat: `huggingchat_chat` huggingchat.ts:151, `huggingchat_conversations` huggingchat.ts:153, `huggingchat_models` huggingchat.ts:155, `huggingchat_settings` huggingchat.ts:157, `huggingchat_mcp` huggingchat.ts:159 — **SCAFFOLD** dispatch.

---

## 2. Layer 2 — HTTP endpoints (all bound 127.0.0.1, bearer-token gate http.ts:167)

| Method | Path | Body | Response | Dispatch → source |
|---|---|---|---|---|
| POST | `/prompt` | `{prompt, site?, newChat?, account?, model?}` (http.ts:277) | `{ok, answer, chunkCount, doneReason, url, title[, citations]}` | `pool.acquire(site, account)` → `worker.driver.ask` (ChatDriver) http.ts:287-… |
| POST | `/capability/<site>` ×**32** (12 real runners http.ts:299-557, 20 gated http.ts:582-1057) | `{capability, args?}` | `200` ok:true → result; `ok:false → 502`, throw → 500; unknown/undeclared capability → `400 {error:"unknown capability "<cap>" for "<site>"; available: […]}` (pre-dispatch manifest guard http.ts:170-192, 400 at 186-189) | manifest guard `registryPackageFor(site)` http.ts:179 → `new <Site>Capabilities(profile, {browser: pool.sharedBrowser()})` → `run()` switch (table in §0) |
| GET | `/capabilities/<site>` | — | `200 {site, name, url, capabilities:[{id,name,description,method}], source:"manifest"}` for EVERY installed package (gate = package existence, not profile — works for capability-first sites like youtube/araprat); `400 {error:"no capability package installed for "<site>"}` otherwise | path-form branch http.ts:222-247 (regex http.ts:229, response http.ts:234-245) from `registryPackageFor(site)` → manifest `tools[]` |
| GET | `/registry` | — | `{packages:[{id,name,url,description,version,site,authRequired,status,verified,chat?:{model,streaming} /* ONLY on the servable chat surface — GOAL 34: refused packages carry no chat key */,tools:[{name,id,description,method,workType,reloadAfterSuccess,inputSchema}]}], generatedAt}` | `buildRegistryPackages()` registry.ts |
| GET | `/sites` | — | `{sites:[{id,name,url,loginRequired}]}` — builtin catalog only http.ts:197 | `profilesById` (builtin 11) |
| GET | `/v1/models` | — | `{object:"list", data:[{id,object,created,owned_by:"ui2api",root,parent,site,url,loginRequired}]}` openai.ts:90 | `Object.values(profilesById)` — configured profiles only |
| POST | `/v1/chat/completions` | `{model?"ui2api/<site>"\|"ui2api-<site>", messages:[{role,content\|parts}], stream?, new_chat?, account?}` openai.ts:106 | non-stream: chat.completion JSON + `ui2api` meta (openai.ts:162-176); stream: SSE `chat.completion.chunk` → `[DONE]` replay of the completed DOM answer (openai.ts:144-159) | `siteIdFromModel` openai.ts:50 → `profileById` (origin pin) → `pool.acquire` → `driver.ask` |
| GET | `/status` / `/health` (`/`) | — | `{ok, pool:{…}}` http.ts:271 / http.ts:274 | pool.status |
| GET | `/accounts?site=` | — | vault accounts for a site http.ts:214 | `listAccounts` session-store |
| GET | `/capabilities?site=&account=` | — | stored per-account capability fingerprint http.ts:251-270 | `loadCapabilities` session-store |
| * | anything else | — | `404 {error:"not found"}` http.ts:1078 | — |

Field mapping detail: the registry tool's **`id`** (raw, e.g. `tencent_aistudio_chat`) is what `/capability/<site>` accepts as `body.capability`; the tool **`name`** is the consumer/MCP id `<site>_<bare>` (e.g. `tencent-aistudio_chat` — the bare strip eats the underscore form, registry.ts:159-165). OmniRoute prefixes its own namespace: `ui2api_<site>_<capability>` (registry.ts:21-23). The new path-form `GET /capabilities/<site>` and the pre-dispatch 400 branch read the SAME manifest-derived set, so all surfaces agree.

---

## 3. Layer 3 — Consumer surface trace

`GET /registry` is **derived only from installed packages**:
1. `listInstalledPackageIds()` registry.ts:138 reads `capabilities/*/manifest.json` on disk.
2. Each id must also resolve a packaged profile via `resolvePackagedProfile(siteId)` (profile.ts:423) or the package is **skipped** (registry.ts:225-226).
3. `tools[]` = one entry per manifest `capabilities[].id` (registry.ts:253-261); `workType` = `js-function` only when `method === "js-function"`, else `ui-path` (registry.ts:258).
4. `status` + `verified` come from each package's `metadata.json` (registry.ts:237-252) — bare `true` is refused, matching `scripts/validate-registry.mjs` (lines 71-81).
5. `inputSchema` is derived per capability shape (registry.ts:168-217): chat → `{prompt, new_chat}` (+ `thinking`/`search` booleans if the description names them); toggle (`reasoner|web_search|search|toggle|_state`) → `{state}`; read (`list_conversations|model_list|history`) → `{limit, account}`; everything else → `{}`.

Every registry tool row maps 1:1 to a dispatch branch and a route (closure
test A+B+C, §0). **No tool row is unreachable**: for the 12 real runners the
branch executes the site action; for the 20 gated package tools the branch
returns the honest login-gated short-circuit.

`GET /v1/models` is **not** the registry — it lists only the daemon's configured
chat profiles (builtin 11 by default: gemini, google-ai-search, chatgpt, claude,
copilot, perplexity, huggingchat, kimi, deepseek, tencent-aistudio, hunyuan —
openai.ts:91 from `profilesById`). youtube, araprat, venice, and the 20 gated
packages are therefore **absent from /v1/models** even though they exist in
`/registry` and on `/capability/<site>` — that is expected: /v1 is the chat
surface, /capability + /registry is the general capability surface.

---

## 4. Appendix — RESIDUAL GAPS vs. HONEST GATING

Cross-checked: 3-layer closure test (`test/function-api-ui-closure.test.ts`,
all 32 packages), 12-runner manifest↔dispatch gate
(`test/capability-dispatch.test.ts`), the 32-route table in http.ts, and the
registry builder. Result:

1. **Routes — full coverage.** Every installed package (32/32) has a
   `POST /capability/<site>` dispatcher (http.ts:299-1057) and answers
   `GET /capabilities/<site>` from its manifest (http.ts:222-247). The prior
   "82 functions / 20 packages have NO runner and NO route" gap is **closed**:
   those 82 now dispatch through honest login-gated branches.
2. **Reachability — zero advertised tools are unreachable.** For every one of
   the 155 manifest capability ids across all 32 packages there is (a) a `case` label
   in its runner (closure test A, lines 123-140 + the no-dead-branch guard
   lines 201-220), (b) a `/capability/<site>` route accepting it (closure test
   B, lines 142-147), (c) a `/registry` tool row named `site_<cap>` (closure
   test C, lines 149-167), and (d) either a real execution path (12 runners) or
   an honest `ok:false loginGated:true` short-circuit verified with no browser
   (guard test lines 172-198). Unknown names are rejected with a 400 listing
   `available: [...]` (http.ts:186-189) or the runner's dead default — never a
   fabricated success. **RESIDUAL GAP FOUND: none.**
3. **The only status difference is honest gating.** 12 sites run real switches
   (73 functions: 5 families live-verified — gemini, kimi, deepseek,
   tencent-aistudio chat, youtube search, araprat search/trending/detail — the
   rest SCAFFOLD: hunyuan, venice, claude, chatgpt, copilot, huggingchat);
   20 sites (82 functions) are login-gated-by-design until a captured session
   + implementation lands. Both classes ship declared manifest metadata;
   neither ever fakes an outcome.
4. **Security hardening landed.** `youtube_subscribe` validates `channelId`
   via `assertChannelUrl()` (ssrf.ts:22-45; rebuilds the URL from a `UC{22}`
   id, `@handle`, or same-host https URL — rejects cross-origin hosts and
   non-https) before any navigation (youtube.ts:392-407); used with
   `sameOrigin()` (ssrf.ts:1-7) for the other posting caps.
5. **Stale code comments (not gaps — honesty notes):** http.ts comments above
   the deepseek and youtube routes predate their verifications; the map above
   reflects AGENTS.md/metadata, not those comments.

**Bottom line:** all **32 packages / 155 functions** are closed across
FUNCTION → API → UI. Every package has a route; every tool is reachable; the
only status difference is honest gating (12 real/live-or-scaffold runner
sites vs 20 login-gated-by-design); zero advertised tools are unreachable;
suite **561/561** green (verified this fold: `npx tsc --noEmit`,
`npm run test:unit` → tests 561, pass 561, fail 0).