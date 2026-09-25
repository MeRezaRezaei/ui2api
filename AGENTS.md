# AGENTS.md — ui2api, for AI agents

This file tells AI agents (Claude Code, Codex, Cursor, opencode, …) what this
project is and how to work in it. Read it before touching anything.

## What this repo is

`ui2api` turns **any website into an API driven by the user's own browser
session**. The flagship use-case: an AI chat site (Gemini, Kimi, DeepSeek,
Hunyuan, Claude, ChatGPT, …) becomes an OpenAI-compatible
`POST /prompt` endpoint whose requests are executed by the site's **own
JavaScript** in the **user's real logged-in session** — the same cookies,
localStorage, and origin code paths a human would use.

Core property (non-negotiable): **no fabricated traffic.** We never synthesize
requests or send fake inputs that could look foreign to the site's anti-bot
stack. We drive the site through its own UI/JS and read answers back off the
page. Docs: `docs/VISION.md`, `docs/ENGINE.md`, `docs/STEALTH.md` (stealth
audit + posture), `docs/AUDIT.md`, `docs/TROUBLESHOOTING.md`. New users: start
at `docs/ONBOARDING.md` (copy-paste v1 flow).

## Layout

```
src/
  cli.ts                 # the ui2api CLI (all commands live here)
  analyzer/              # fetch site, hook fetch/XHR/WS, record real calls
  mapper/                # build action map (normalize captures into typed actions)
  generator/             # generate MCP/ACP servers from the action map
  prompt/                # ChatDriver + daemon + HTTP endpoint (driver.ts, http.ts, pool.ts)
  profile/profile.ts     # BUILT-IN chat-site profiles (composer/send/answer selectors)
  capabilities/          # per-site capability runners (gemini.ts, kimi.ts, deepseek.ts, …)
  runtime/               # browser control, DOM primitives, session store, captures
  hub/                   # package hub (mirror, runtime, store, UI)
  registry/              # package install
  plugin/                # MCP plugin serving
capabilities/            # per-site package: manifest.json, profile.json, recipes/,
                         #   session.lock.json, CAPABILITIES.md (+ README.md inventory,
                         #   CAPTURE-RUNBOOK.md, provider-catalog.md)
data/<host>/.session/    # CAPTURED SESSIONS (gitignored — never commit, never paste)
sites/                   # generated per-site servers (build output)
test/                    # node:test suites (unit, integration, validation)
```

## The two execution models

1. **ChatDriver** (`src/prompt/`) — declarative profiles
   (`src/profile/profile.ts`, overridable via JSON with `--profile` or
   `UI2API_AI_SITE`). Paste prompt + Enter via the site's own JS, read the
   streamed answer until it stops growing. One driver, all sites. Model
   selection verifies it took (exact-row click, selected-state check) — never a
   silent wrong-model prompt. Answer readback is FRESH per prompt: `awaitAnswer`
   snapshots the pre-ask answer region as a baseline and judges only new text,
   so the warm daemon pool's reused pages never echo a previous prompt's
   still-mounted answer (stale-echo guard, `test/readback-freshness.test.ts`);
   `newChat` resets are verified after the click (answer region emptied or
   composer cleared) before composing.
2. **Capability runners** (`src/capabilities/*.ts`) — per-site capability
   surface (chat, list_conversations, web_search, image_gen, …) exposed as
   `/capability/<site>` endpoints, wired in `src/prompt/http.ts`, and kept
   in-sync with each site's manifest by `test/capability-dispatch.test.ts`.

Both use **snapshot-injected sessions**: capture once
(`ui2api profile add-all --known` for the one-command bulk login of every OS
Chrome-profile site session, or `profile capture <url> --login` / `profile
ingest <host>` for a single host / offline read of a live Chrome profile), lock
it in the package (`capabilities/<site>/session.lock.json`), and replay cookies
+ localStorage into fresh browser contexts at runtime.

## Commands

```bash
npm run build              # tsc -p tsconfig.json
npx tsx src/cli.ts prompt "hello" --site gemini      # one-shot prompt via ChatDriver
npx tsx src/cli.ts prompt --sites                    # list available sites (--site X)
npx tsx src/cli.ts promptd                           # daemon: POST /prompt, /status, /sites
npx tsx src/cli.ts analyse <url> [--login] [--llm]   # recorder + action map
npx tsx src/cli.ts profile scan|import|capture|ingest|list  # session management
npx tsx src/cli.ts profile add-all [--known|--interactive]  # one-command bulk import: ALL Chrome-profile site sessions → vault (read-back verified, no per-host loop)
npx tsx src/cli.ts requirements [site] (alias: doctor)     # OS-level readiness gates BEFORE any browser work: per-package verdict ready/working/on-hold/not-ready with the NAMED reason; exit nonzero on any not-ready
npx tsx src/cli.ts install <site> | plugin serve  # install + plugin workflows (`package` REFUSES LOUD — write-truth gate, GOAL 66; install --out = isolated, NOT daemon-served — GOAL 67)
npx tsx src/cli.ts hub | serve | remap | generate    # server generation pipeline
npm test                  # integration (test/integration.ts)
npm run test:unit         # full unit suite incl. validate-packages + capability-dispatch
```

Serving: `src/prompt/http.ts` exposes `POST /prompt` (`{"site","prompt"}`),
`GET /sites`, `GET /capabilities/<site>`, `POST /capability/<site>`,
`GET /status`, `GET /requirements`, `GET /health`. Binds `127.0.0.1` only,
configurable bearer-token gate (`UI2API_PROMPTD_TOKEN`).

**Multi-account** (live-verified 2026-09-22, GOAL 8): `POST /capability/<site>`
and `POST /prompt` accept an optional `"account":"<slug|email>"` — the account is
validated against the vault (`listAccounts`+`slugifyIdentity`) BEFORE any browser
launches; unknown account → 400 `no stored account "<acct>" for "<host>"; available: [<slugs>]`.
`GET /accounts?site=<id>` lists vault accounts — chat-profile set first, then any
installed capability package (GOAL 31: the same registryPackageFor vault /registry
+ /capabilities/<site> serve; host = the packaged url's host, null when url-less);
each `GET /registry` package
carries `accounts: [{slug, identity, host, source, capturedAt}]` (same list in the
`GET /capabilities/<site>` path form). Vault path `data/sessions/<host>/<slug>/state.json`;
`"default"` = the legacy flat session.

Consumer surfaces (what OmniRoute / any external tool consumes — the registry
is the ONLY info source, no site knowledge lives in the consumer):
- `GET /registry` — runtime package registry (built only from installed
  capability packages): `packages[]` each with `id/name/url/status/tools[]`
  (`tool.name` = `<site>_<capability>`, plus inputSchema), and `chat.model`
  ONLY on driveable chat packages — the same `defaultChatSurface()` gate
  `/v1/chat/completions` serves (GOAL 34: `chat` is absent on capability-only /
  url-less / dormant / dead-end packages — `/v1` would `404 unknown_model`
  them, so the registry never advertises chat it cannot serve; key on
  `pkg.chat?.model`, treat absence as "no chat"). Consumers
  materialize one provider per ACTIVE package and one tool per capability.
- `GET /v1/models`, `POST /v1/chat/completions` — OpenAI-compatible chat
  surface (model = site id; `stream:true` replays the finished DOM-rendered
  answer as SSE — honest: ChatDriver reads the page, it does not synthesize
  traffic). Non-chat capabilities stay on `/capability/<site>`.

## Environment knobs (runtime/browser.ts)

- `UI2API_HEADED=1` — headed browser (needs a display; use Xvfb headlessly).
- `UI2API_CHROME=1` / `UI2API_CHROME_PATH` — use **real Chrome**, not bundled
  Chromium. REQUIRED for anti-bot-sensitive sites (Tencent, see below).
- `UI2API_USER_DATA_DIR` (alias `UI2API_CHROME_PROFILE_PATH`) — reuse the
  user's real Chrome profile. Note: cannot launch a second process on a
  profile already locked by a running Chrome.
- `UI2API_ATTACH_PORT=9222` — attach to an already-running Chrome
  (`google-chrome --remote-debugging-port=9222`) instead of launching.
- `UI2API_POOL_MIN` — warm browser pool size (promptd).
- `UI2API_LLM_*` — optional LLM for `--llm` mapper (not required to run).

Bench rule: **every browser launch must go through `launchBrowser()`** in
`src/runtime/browser.ts` (single seam for headless/headed/chrome/attach
resolution + stealth posture). Never `launch()` a browser ad-hoc.

## Site status (2026-09-19)

- **Default chat set** (`defaultChatProfiles()`, `src/prompt/registry.ts`,
  GOAL 30 + GOAL 32 truth-gate): **23 sites** — the builtin profile catalog
  (gemini, chatgpt, claude, copilot, perplexity, huggingchat, deepseek, kimi,
  tencent-aistudio, + more) merged with every installed **driveable** chat-shaped
  package whose composer/answer selectors parse under Playwright's own selector
  grammar (t3chat's former prose rows refused; duckduckgo, poe, grok, …);
  dormant/dead-end packages (zenmux parked origin, xiaomimimo DNS dead-end) are
  EXCLUDED from the chat surface until live-verified but stay fully served on
  /registry + /capability/<id> with their honest metadata status; every surfaced
  packaged id carries its status (`verified` / `unverified-candidate`) on
  GET /sites + `prompt --sites`; capability-only packages (gmail/youtube/
  araprat/…) never become chat models.
- **Session-locked + live-verified round-trips**:
  - `deepseek` (chat.deepseek.com) — localStorage `userToken` Bearer auth;
    AWS WAF + PoW; verified answering (proof PASS 11462, 2026-09-19). Full
    surface verified: `deepseek_reasoner` + `deepseek_web_search` are REAL
    composer toggles (`div.ds-toggle-button:has-text("DeepThink"/"Search")`,
    state class `ds-toggle-button--selected`) feeding `thinking_enabled` /
    `search_enabled`; `deepseek_list_conversations` reads sidebar
    `a[href*='/chat/']` (both `/chat/<id>` and `/a/chat/s/<uuid>` shapes).
  - `kimi` (www.kimi.ai) — localStorage `access_token` Bearer on
    notilo.kimi.com/apiv2; verified answering (proof PASS 13965, 2026-09-19).
    **Selector gotcha**: the driver picks the LONGEST matching element text,
    and Kimi's thinking block also matches `.markdown` — the answer selector
    `.toolcall-rollup__part:has(+ .toolcall-rollup__tail) > .markdown-container > .markdown`
    exists specifically to exclude thinking. Full surface verified:
    `kimi_list_conversations` (sidebar `a.next-sidebar-history-item__link`),
    `kimi_model_list` (`[data-testid="model-select-trigger"]` →
    `button.model-item`), `kimi_web_search` (toolkit
    `[data-testid="toolkit-trigger-btn"]` → `button.toolkit-item`), and
    `kimi_file_upload` (`label.toolkit-item` wrapping hidden
    `input[type="file"]` — use `setInputFiles`, filechooser never fires).
  - `gemini` (gemini.google.com) — verified earlier; do not re-capture.
    **GOAL 53 (2026-09-25)**: `gemini_file_upload` WIRED — file/image attach via the
    composer's real hidden `input[type='file']` (kimi/duckduckgo live-verified
    setInputFiles pattern; the site's own JS uploads, nothing synthetic). Honest
    unverified-candidate: all stored gemini sources replay signed-out (Google auth
    browser-bound) — `ok:true` = input accepted, NOT a live upload claim; verify the
    chip from the user's own signed-in Chrome (UI2API_ATTACH_PORT) before treating
    upload as verified.
- **Suite gates (2026-09-21, fold #11)**: full suite now measured **418/418**.
  The two wigolo-engine infra gates (chromium warmup on ubuntu26.04-x64) CLOSED by
  aligning the wigolo clone's playwright 1.60→1.61: build 1228 is already present
  on the box (`~/.cache/ms-playwright/chromium-1228`), so `chromium.executablePath()`
  resolves to a real installed binary — genuine daemon browser launch, not a fabricated
  green. promptd on 127.0.0.1:9797 must be restarted with CURRENT code after wiring
  changes (a stale daemon predates new `/capability/*` routes and 404s them while
  `/registry` still looks live — a lost-direction symptom; kill + `tsx src/cli.ts promptd`).
  LIVE studio re-verification 2026-09-21 through the wire: `youtube_search`
  ok:true 10 rows, `araprat_search` ok:true 30 rows; posting recipes stay honest
  login-gated ok:false — never a fabricated post.
- **Session-locked + chat verified (headed/real-Chrome only)**: `tencent-aistudio`
  (aistudio.tencent.ai). Cookies verified (`hunyuan_token`/`hunyuan_user`/
  `hunyuan_source` on `.tencent.ai`); **Tencent Cloud EdgeOne blocks headless
  Chromium (HTTP 567) — headed / real-profile ONLY** (mirrors
  `capabilities/hunyuan`). Chat round-trip VERIFIED (proof PASS 6916, 2026-09-19):
  composer `textarea.t-textarea__inner` ("Ask me anything"), answer
  `.agent-chat__bubble--ai .hyc-content-md` → `.hyc-common-markdown`, completion
  marker "Completed". Cold-boot gotcha: sends typed before ~5–8s are silently
  dropped — `preComposeDelayMs: 8000` in the profile. Runner wired
  (`src/capabilities/tencent-aistudio.ts` + `/capability/tencent-aistudio`);
  **conversation list + open LIVE-VERIFIED 2026-09-23** (History → `/chat-history`
  renders the user's real dated conversation list as `div.list-item` rows —
  title/model/type; row click navigates into `/chat/HunyuanDefault/<id>?from=history`;
  ids are click-only, rows are divs, not anchors; rename/delete DOM NOT located).
  Chat re-verified 2026-09-23 through the wire (proof "415"). Remaining
  capabilities measured live 2026-09-23 → HONEST BLOCKED with measured reasons:
  web_search / deep_think toggles do NOT exist on the current Hy4 preview
  composer (no 搜索/联网, no deep-think switch; deep-think OUTPUT renders —
  "Deep thinking completed（Ran for …s）" — but there is no toggle to expose);
  no `input[type=file]`/attach for file_upload; `/image /code /tts /podcast
  /translate` are dead routes; image surface = separate `hy3d.tencent.ai` app
  (never claim verified without a live round-trip).
- **Walled / scaffold / dead-end** inventory lives in `capabilities/README.md`
  (poe, grok, perplexity, t3chat, blackbox, adapta, zenmux, …). Be honest about
  status: never claim a capability is verified without a live round-trip.
- **Scaffold→VERIFIED (live round-trips 2026-09-20, attached real Chrome/152)**:
  `youtube` (www.youtube.com) — capability surface, NOT a chat site.
  `youtube_search` **VERIFIED** (search→`ytd-video-renderer a#video-title`
  read-back, live proof 10 rows; manifest verified-2026-09-20);
  `youtube_transcript` **UI path verified, segments LOGIN-GATED** — panel
  expands but the site's own `get_transcript` endpoint answers HTTP 400
  "Precondition check failed" without SAPISID (needs a logged-in capture;
  honest partial, never claimed verified). Auth optional-cookie.
  **2026-09-21: POSTING surface implemented + dispatched** —
  `youtube_comment`/`youtube_like`/`youtube_subscribe`/`youtube_upload`/
  `youtube_playlist_add` on `/capability/youtube` (were "unknown youtube
  capability"); runner `openPage()` gained a vault-account ladder
  (`data/sessions/<host>/<slug>/` first, then legacy flat snapshot, then cookie
  file). **MEASURED login-bound**: a real account vault exists on the box
  (data/sessions/youtube.com/merezarezaei@gmail.com/, source=import) but
  Google auth cookies are **browser-bound** (app-bound encryption) — replaying
  the vault OR the real Chrome profile copy into fresh ephemeral contexts
  renders anonymous AND trips YouTube's "Sign in to confirm you're not a bot".
  Posting therefore needs the **user's own real Chrome attached**
  (`UI2API_ATTACH_PORT` / live profile), exactly like `tencent-aistudio`;
  never fabricate a post until a real attached session proves the flip.
  **`araprat`** = Aparat (www.aparat.com, Persian video platform; "araprat"
  resolved via web search) — NOT a chat site; ALL THREE capabilities
  **VERIFIED**: `araprat_search` (`input[name="search"]` → `/search/<q>` grid
  `a[href*='/v/']`, dedupe double-anchored cards; live 'موزیک' → 30 deduped),
  `araprat_trending` (homepage `/home`, 52 `/v/` anchors), `araprat_video_detail`
  (`h1` + `div.description` + related `a[href*='/v/']`; og:/twitter: metas are
  DEAD on this SPA — do not rely on them). Hydration: wait for
  `a[href*='/v/']`, h1 lands ~3.5s before desc/related.

- **Full-surface audit fold #17f (2026-09-22, done)** — per-site status after
  double-check + code-audit (details in `docs/verbatim-goals.md` GOAL 6):
  - **WORKS LIVE (re-verified this fold through the wire/attach)**: `gemini`
    (vault, PONG), `deepseek` (vault, PONG), `kimi` (vault, PONG),
    `tencent-aistudio` (headed .tencent.ai cookie session — the refreshed
    ui2api copy-Chrome profile carries hunyuan_token/user/source), `youtube_search`
    (ok:true rows), `araprat_search`/`araprat_trending`/`araprat_video_detail`
    (ok:true).
  - **FULL-SURFACE VERIFIED (GOAL 15, 2026-09-23, headed Xvfb ALL_OK=true)**:
    `duckduckgo` (duck.ai, anonymous) ALL SIX caps live-verified through the real
    runner (was 5 wire-mapped/DOM-unverified): `duckduckgo_chat` (answer reads
    `[id*="assistant-message"]`, first-send consent wall handled),
    `duckduckgo_model_picker` (composer chip → menu `[role='menuitemradio']`
    rows testid `model-picker-row-<id>`, aria-checked), `duckduckgo_web_search`
    (Tools → Web Search row → chip `button[aria-label='Remove Web Search']`
    read-back; enable+disable; chat after enable carried a REAL WebSearch
    tool-invocation, 5 citations in IDB), `duckduckgo_file_upload`
    (setInputFiles on composer `input[type='file']`, accept-list enforced →
    chip read-back), `duckduckgo_reasoning` (reasoning-mode button text flip;
    'extended' honestly ok:false — not offered on free GPT-5.6 Luna),
    `duckduckgo_chat_history` (real IndexedDB `savedAIChatData`
    saved-chats/pre-canonical-chats + sidebar corroboration; string-evaluate
    fixes the swc `__name` crash — named arrows inside page.evaluate hang-or-crash,
    keep evaluate code as strings). Dispatch test runner added: 581/581 green.
  - **HONEST dead-end (never claimed verified)**: `hunyuan` = yuanbao.tencent.com
    has NO session ANYWHERE on this box (not in real me-Chrome, not in the
    copy) — hy_user/hy_token are domain cookies the user has never generated.
    The Tencent AI surface the user means is aistudio.tencent.ai (VERIFIED,
    and its HunyuanDefault chat already serves modelId=hy4-preview-g).
    `google-ai-search` stays BLOCKED on portal v20 (external sign-in required).
  - **Audit fixes shipped**: `test/capability-dispatch.test.ts` RUNNERS now
    include `youtube` + `araprat` (12 runners, IN-SYNC manifest↔dispatch —
    was 10, these two live-verified runners were outside the suite);
    `src/capabilities/araprat.ts` + manifest now dispatch the 6 posting caps
    HONESTLY as login-gated (ok:false loginGated:true, no browser) so they no
    longer fall into the dead "unknown" branch; suite 430/430.
  - **Multi-account surfaces live-verified (GOAL 8, 2026-09-22)**: `account` param
    on `POST /capability/<site>` + `POST /prompt` (vault-validated pre-browser),
    `GET /accounts?site=`, registry `accounts[]` — **and `profile add-all`
    one-command bulk login live-verified (GOAL 9, 2026-09-22)** (read-back
    verdict table, zero temp residue; replaces the per-host import loop).

## Conventions & red lines

- **Never commit `data/`**, `.agents/`, `.opencode/`, `sites/*/server/` (see
  `.gitignore`). Session snapshots contain real credentials.
- **Origin pinning / SSRF guards** live in `src/runtime/ssrf.ts` — endpoints
  only serve configured sites, never arbitrary URLs.
- **Trust gate** (`src/prompt/http.ts` + `src/runtime/ssrf.ts`): the daemon
  binds `127.0.0.1` by default and answers ONLY the profiles handed to it at
  startup (`idFrom`/`profilesById`, `src/prompt/http.ts` — unknown site →
  400), never arbitrary URLs; optionally bearer-token gated via
  `UI2API_PROMPTD_TOKEN` (no token set = localhost-only posture, README's
  "optionally bearer-token gated").
- **Verification before claiming done**: `npx tsc --noEmit`, `npm run build`,
  `npm test`, `npm run test:unit`. Package + runner sync is enforced by
  `test/capability-dispatch.test.ts` (18/18) and package shape by
  `test/validate-packages.test.ts` (211/211).
- **Readiness checks are never fabricated**: `ui2api requirements` (GOAL 33,
  `src/runtime/requirements.ts`) only reports verdicts a real check can stand
  behind — every check runs for real (execute-only probes; a check that cannot
  run reports `not-ready`/`on-hold` + the NAMED reason, never a guessed
  verdict), and the checker itself NEVER launches a browser (chrome = the
  `resolveChromeExec` ladder + a `chrome --version` execute-only probe;
  attach = a short HTTP GET to an already-running Chrome's CDP endpoint;
  sessions = vault reads only). Capture age is surfaced honestly in the same
  gate (GOAL 39): every vault-backed package prints `captured <date> (N days
  ago)`, and a session older than the `SESSION_STALE_DAYS` risk threshold (14)
  gets a `⚠ stale` warn with the re-capture instruction — age ≠ expiry, so the
  flag never changes the ready/working verdict (site-dependent lifetimes).
- **Session writes are never fabricated either** (GOAL 49): every capture,
  ingest, and import path runs the WRITE truth gate (`snapshotHasAuth`,
  `src/runtime/session-store.ts`) — a snapshot with ZERO cookies AND ZERO
  localStorage for the target host is REFUSED at the write seam with a named
  `skipped-no-auth (nothing to save)` verdict (nothing written to the vault,
  never listed in `/accounts`, `cmdProfileIngest` exits nonzero). The
  "logged-in session — chat history persists" claim only prints for a usable
  snapshot, so the vault, the account guard, and the requirements age gate can
  never surface an anonymous session as fresh + valid. Decrypt-limited partials
  (cookies matched but undecryptable) keep their honest warning — they are a
  real logged-in session, not the anonymous class this gate kills.
- **Package installs are write-gated too** (GOAL 65): `ui2api install`
  (`src/registry/install.ts`) validates the WHOLE fetched package BEFORE any
  file lands on disk — every fetched JSON file must parse (corrupt
  metadata/profile/session.lock/recipe refuses naming the file), every manifest
  capability entry passes `validManifestCapability` (the GOAL 61 read-side
  filter, now also at the write seam — null/primitive/id-less entries refuse
  naming the index instead of silently landing to be dropped from /registry
  later), and profile.json passes `validatePackagedProfileShape` (GOAL 48/56
  shape) PLUS id agreement (profile.id must equal the package dir — a mismatch
  refuses naming file + both ids, the GOAL 64 shape). Any refusal throws with
  a named verdict and NOTHING is written (the write loop never runs, the dir
  never exists) — a broken package can no longer install "successfully" and
  be refused only later by the read/serve seams; same principle as the GOAL
  49/50 session-write gate, applied to packages.
- **Restriction walls are reported, never blind-empty** (GOAL 54 + GOAL 55): every
  builtin chat profile declares `capability.restrictionMarkers` (11/11 — gemini/kimi/
  deepseek predated the gate; chatgpt/claude/copilot/perplexity/huggingchat/
  google-ai-search/hunyuan added, incl. the verbatim-named hy3 = tencent-aistudio
  with limit+login) AND every chat-shaped packaged `capabilities/<id>/profile.json`
  declares them too (14/14 — the served packaged surface: blackbox, codex,
  copilot-m365, duckduckgo, grok, inner-ai, manus, notion, poe, t3chat, v0, venice,
  plus dormant zenmux/xiaomimimo still served on /registry + /capability). The
  same driver + fingerprint seam consumes both: `src/prompt/driver.ts`
  `readRestrictions()` scans the page in-band and answers
  `doneReason:"restricted"` + the named hits instead of a blind empty answer;
  `src/runtime/capability-probe.ts` feeds the same markers into the per-account
  fingerprint's `restrictions[]`. Patterns are conservative and honest: a
  never-matching pattern is a silent miss, a false-positive wall report is what's
  forbidden (and the driver's `if (!answer)` gate means a marker can only surface
  when there is no answer — a real wall); coverage is pinned by
  `test/restriction-markers.test.ts` (builtin + packaged) so a future profile
  added without markers fails LOUD (suite, like the manifest↔dispatch drift gate).
- **The profile-shape and storage READ gates are complete** (GOAL 56/57/58/59/60):
  `--profile FILE` overrides AND packaged `profile.json` validate the GOAL 54/55
  `capability` block at load (GOAL 56 packaged + GOAL 57 override — a wrong-typed
  `restrictionMarkers`/picker/toggle refuses LOUD naming file+field instead of a
  late `matchRestrictionMarkers` for…of-undefined at answer time); stored
  capability fingerprints are never served malformed — `GET /capabilities?site=`
  answers `probed:false` + the NAMED reason + re-probe hint (GOAL 58,
  `validateCapabilityReportShape`); stored snapshots are shape-gated at the load
  seam — a wrong-shaped `state.json` (cookies string etc.) returns null like
  corrupt JSON instead of crashing `injectSnapshot`'s `.filter` mid-runner
  (GOAL 59, `validateSnapshotShape`, legacy absent-field snapshots still load);
  and the vault `accounts.json` index is per-entry gated — hostile slugs
  (`../../..`, numeric) are excluded so they are never listed on /accounts +
  /registry accounts[] and never escape the vault through
  `accountSnapshotPath`'s resolve() (GOAL 60, `validStoredAccount`); and the
  registry BUILD is crash-proofed — a malformed installed manifest capability
  entry (null / primitive / id-less) is filtered out per-entry
  (`validManifestCapability`) instead of TypeErro3ing the whole /registry for
  every consumer (GOAL 61). And the packaged-profile load seam enforces id
  AGREEMENT (GOAL 64): a `capabilities/<id>/profile.json` whose `id` mismatches
  the package it is resolved as refuses LOUD naming the file + both ids
  (`resolvePackagedProfileFile`'s opt-in `expectedId`, wired into
  `resolvePackagedProfile` + the `resolveProfile` packaged branch + all 32
  `/capability` fallbacks) — never a silent merge of the WRONG builtin base
  (`BUILTIN_PROFILES[raw.id]`) that self-identifies as the wrong site;
  /registry + chat surface exclude the mismatch like any other malformed
  install (GOAL 48), /capability + CLI refuse it. Every write
  seam still runs its own truth gate (GOAL 49/50) — the read seams refuse the
  same malformed classes at serve/load time.
- **Account-INDEX collisions are refused too** (GOAL 50): `saveAccountSnapshot`
  is gated by `slugCollision` (`src/runtime/session-store.ts`) — a same-slug
  DIFFERENT identity on one host is never silently overwritten (the old
  filter-replace destroyed the first account's index entry + snapshot with zero
  warning); all three write seams (capture/import/xhost) refuse with a named
  `slug-collision (NOT overwritten — account "<slug>" already exists as
  "<identity>")` verdict, nothing written, the original account intact. Same
  identity string = latest-wins re-capture, never a false positive; slugs are
  host-scoped, so an identical slug on two hosts is valid.
- **Account READs are exact too** (GOAL 51): `resolveStoredAccount`
  (`src/runtime/session-store.ts`) is the canonical reader — an account
  reference resolves ONLY on the exact stored identity or the exact stored
  slug (the form `/accounts` lists); NO slugify folding and no blind snapshot
  path load. A write-refused alias ("john  smith" when "John Smith" is stored)
  now 400s with the named `no stored account "<acct>" for "<host>"; available:
  [<slugs>]` from `resolveCapabilityAccount` (`src/prompt/http.ts`) and
  `GET /capabilities?site=&account=` — it never silently drives the survivor's
  session (the write gate and the read gate agree on the same key space).
- **Consumer surfaces can pick an account too** (GOAL 52): the daemon wire was
  never the only entry — the generated/plugin consumers now carry the same
  identity-keyed selector: the generated PHP client's
  `chat(..., ?string $account = null)` / `capability(..., ?string $account = null)`
  forward `account` into the /v1 and /capability payloads (only when set);
  generated ACP/MCP servers read `UI2API_ACCOUNT` (+ `UI2API_DATA_DIR`) into
  `BrowserSession`, whose `resolveSessionAccountSnapshot(dataDir, host, account)`
  resolves EXACTLY (GOAL 51 semantics — no first-account, no folding) and throws
  a NAMED error when the requested account is missing or snapshot-less;
  `ui2api plugin serve <module> --account SLUG|EMAIL` selects which vault account
  drives the plugin page. One user, several accounts — pick the one that drives
  the request everywhere.
- **Selector rot**: site UIs change. Re-tune via JSON profile override
  (`--profile FILE`), not by editing one-off probe scripts; keep probe scripts
  out of the repo (delete after use). Overrides are validated with the same
  truth gate packaged profiles pass for /registry (parseable selectors + chat
  shape, plus an explicit `send` shape check) — a typo'd key or wrong-typed
  composer/answer/send entry fails LOUD at load, naming the file and the exact
  offending field/entry (never a silent drop → late "no composer found"
  timeout, answer-join TypeError, or Enter-press send fallback). The override
  seam validates the `capability` block the same way the packaged seam does
  (GOAL 57, the GOAL 56 helper) — a wrong-typed `restrictionMarkers`/picker/
  toggle in a `--profile FILE` refuses LOUD at load, never a late
  matchRestrictionMarkers for…of-undefined crash at answer time. The seam also
  enforces id AGREEMENT (GOAL 62): `--site X --profile FILE` never silently
  drops the tuning document — a file whose id mismatches the requested site
  fails LOUD naming both sides (`resolveProfileWithOverride`); absent file.id
  tunes the requested site. Installed
  `capabilities/<id>/profile.json` runs the same gate on the packaged running
  seam (CLI packaged id + `/capability` fallbacks, GOAL 48) — a wrong-typed or
  unparseable entry fails LOUD at serve time, naming the file + exact
  field/entry (never a late `answer.join` TypeError inside a runner); GOAL 56
  extends that gate to the `capability` block GOAL 54/55 made first-class on
  the chat surface: `restrictionMarkers` (kind ⊆ {upgrade,limit,login} +
  non-empty string patterns), `tierSelectors`/`pickerOpen`/`pickerOption`
  (parseable selector lists), `abilityToggles` (id/selector/label/selectedClass)
  — a wrong-typed capability entry (e.g. a string `restrictionMarkers`) refuses
  LOUD naming file + field + entry instead of a late `matchRestrictionMarkers`
  `for…of undefined` TypeError at answer time; absent capability
  (capability-only packages, chatglm) keeps resolving.
  Well-typed
  empty/absent/host-keyed-object fields (capability-only packages, chatglm)
  keep resolving.
- **When adding a site**: analyze (static bundles + wire) → package under
  `capabilities/<id>/` (manifest/profile/recipes/session.lock/CAPABILITIES.md +
  `metadata.json`) → builtin profile entry → runner in `src/capabilities/` →
  wire `/capability/<id>` in http.ts → capture + lock → live-verify → update
  `capabilities/README.md` inventory + this file + README site list.

## Package layout (see capabilities/README.md)

`capabilities/<site-id>/manifest.json` (id, name, url, capabilities, auth,
transport, permissions), `profile.json` (ChatSiteProfile overrides),
`recipes/<capability>.json`, `session.lock.json` (snapshot hash + capture
date + source), `CAPABILITIES.md` (human-readable analysis deliverable —
the wire facts). Validation: `scripts/validate-registry.mjs` +
`test/validate-packages.test.ts`.