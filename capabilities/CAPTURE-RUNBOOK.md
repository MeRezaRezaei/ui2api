# CAPTURE-RUNBOOK — capturing real sessions for the ai-chat-site packages

Operator guide for turning an "awaiting-capture" package into a **locked** package by
capturing one real authenticated session per site. Facts below are grounded in the CLI
source (`src/cli.ts`), `src/prompt/http.ts`, `capabilities/README.md`, each package's
`CAPABILITIES.md`, and each package's `session.lock.json`, as of 2026-09-16.

> There is **no per-command `--help`**. The CLI ignores unknown flags and errors or hangs on
> them (`analyse --help` → `Invalid URL`, `promptd --help` → starts the daemon).
> The only usage printout is the bare invocation: `node --import tsx src/cli.ts`.
> Everything in this runbook is read from source, not from `--help`.

---

## 0. What a capture IS

A capture is a **profile snapshot** written to `data/<host>/.session/state.json`:

- Content: `cookies` **+ `localStorage` + `sessionStorage` + `IndexedDB`** for the target
  host (captured in `doInteractiveLogin`, `src/cli.ts`). Cookies are also written to the
  cookie store under the same `.session/` dir.
- It is captured **once**, headfully, by the operator logging in by hand; then it is
  **injected into fresh browser contexts** for every later run, so the site's own JS sees
  a normal logged-in user.
- It is consumed by the capability runners and the built-in profiles: `src/prompt/driver.ts`
  (ChatDriver) and `src/capabilities/{gemini,kimi,hunyuan}.ts` reuse it for the
  `/capability/*` surface and `/prompt` (via `promptd`), so **chat history and auth
  persist** across runs.
- The package lock file `capabilities/<site>/session.lock.json` records the snapshot hash,
  capture date, cookie/localStorage keys, and evidence when the capture is done.
- **The snapshot JSON is gitignored** (it is auth material — never commit it; see §7).

Why a live session is required at all: the sites in this repo are either JS-walled
(Google search anonymous shell), Cloudflare-gated (poe/grok/perplexity/claude), or
hashed behind session-derived headers (deepseek PoW, kimi/kimi local-token, hunyuan
cookie session). `<site>.CAPABILITIES.md` does the static bundle mining; the capture is
what makes the *live round-trip* possible.

### Login flow (what the command does)

1. Launches a **headed** browser (your Chrome + profile when
   `UI2API_CHROME=1`/`UI2API_USER_DATA_DIR` is set, otherwise a fresh bundled Chromium).
2. Opens the URL; prints `Sign in, then return here and press Enter`.
3. You sign in / pass any challenge in that window, then press Enter in the terminal.
4. It saves cookies + the storage snapshot to `data/<host>/.session/` and closes the browser.
5. `analyse --login` additionally continues into a full headless analysis pass afterwards;
   `profile capture` stops after the snapshot (the package already exists for these sites).

---

## 1. The capture commands

Both commands below run the **same login + snapshot** flow. Prefer `profile capture`
when the package already exists and you only need the session (all packages here).

```bash
# The two real capture commands (from src/cli.ts):
node --import tsx src/cli.ts profile capture <url> [--data-dir DIR]
node --import tsx src/cli.ts profile ingest  <host> [--profile DIR] [--data-dir DIR]
# profile ingest = OFFLINE: read cookies+localStorage straight out of a real Chrome
# profile directory on disk (no browser opens). Useful where a headless capture is
# impossible (Cloudflare-walled sites, deepseek's PoW).

# The analyse variant (records the snapshot too, then runs analysis — same snapshot on disk):
node --import tsx src/cli.ts analyse <url> --login [--root App] [--out DIR] [--llm] [--max-tasks N]
```

Real flags that exist (read from `src/cli.ts`):

| flag | meaning |
|---|---|
| `--login` | headed login window → save full session before continuing |
| `--cookies FILE` | inject cookies from a JSON file into the site session store |
| `--data-dir DIR` | override snapshot location (default `data/`) |
| `--profile DIR` | (ingest) source Chrome profile directory |
| `--root App` / `--out DIR` | analyse output roots |
| `--llm` | LLM-assisted naming (offline heuristics otherwise) |
| `--max-tasks N` | analyse task budget |

Environment that changes the *browser*, not the session format:

| env | effect |
|---|---|
| `UI2API_CHROME=1` | use your installed system Chrome (channel `chrome`) |
| `UI2API_CHROME_PATH=...` | specific Chrome/Chromium binary |
| `UI2API_USER_DATA_DIR=...` | reuse an existing Chrome profile (cookies + sign-in) — **the Cloudflare-wall escape hatch** |
| `UI2API_ATTACH_PORT=9222` | adopt YOUR long-running Chrome over CDP (loopback) instead of spawning |
| `UI2API_HEADED=1` (+ `DISPLAY=:99`) | headed daemon pool on a virtual display (Xvfb) — for heavy SPA / anti-bot sites |
| `UI2API_DATA_DIR` | `profile capture` data-dir fallback |
| `UI2API_PROMPTD_TOKEN` / `UI2API_PROMPTD_PORT` | daemon auth / port |

> Caveat: **two Chrome instances cannot share one profile directory.** Close your normal
> Chrome before `UI2API_USER_DATA_DIR` reuse, or copy the profile first.

---

## 2. Per-site capture sheet

Legend: **status** from `capabilities/README.md` inventory. **Storage** = what the
snapshot must preserve for auth (from `CAPABILITIES.md` + `session.lock.json`).
**URL** = the site host that determines `data/<host>/`. Everything marked
*to verify on first capture* was not verifiable from static analysis.

### ✅ gemini — already captured, do not re-capture
- Package dir: `capabilities/gemini/`. Status: **implemented + live-tested** (2026-09-15).
- Host: `gemini.google.com`. Locked `2026-09-14`, sha `2d2095c4b6369d9f`, 23 cookies,
  localStorage keys: `BARD_EMBED_CHAT_STORAGE_KEY_V2`, `GqGm3b`, `_gcl_ls`, `brd_dctG`.
- Evidence on file: 3 live chat rounds (chat `1dc93d7438476596a` / `95f64c582ebffca8`).
- Capture command recorded in its lock: `ui2api profile capture "https://gemini.google.com" --login`.
- **No action needed.** If re-capturing anyway, expect the same compact-ID RPC decode
  (§0 of `gemini/CAPABILITIES.md`); cookie-only auth, snapshot needs cookies + those
  localStorage keys.

### google-ai-search — implemented, waiting on its first www.google.com session
- Package dir: `capabilities/google-ai-search/`. Status: **✅ implemented**, `urlTemplate`
  flow `https://www.google.com/search?q=…&udm=14` → `{answer, citations[]}`.
- Host: **`www.google.com`** (note: not gemini.google.com — the snapshot must be a Google
  Search session), target `data/www.google.com/.session/state.json`.
- Required cookies (from its lock): `NID`, `SID`, `__Secure-3PSID`.
- What to do in the browser: sign in at `https://www.google.com`, confirm you can run an
  **AI Mode** query (`/search?q=test&udm=14`) and see an AI answer + citation cards
  (anonymous loads are JS-walled with an `emsg=SG_REL` shell — see `google-ai-search/CAPABILITIES.md`).
  If your account is not in the AI Mode rollout, the server silently degrades to normal
  results — *verify the udm=14 answer actually renders before locking the package.*
- Command:
  ```bash
  node --import tsx src/cli.ts profile capture "https://www.google.com"
  ```
- Expected after-capture: `data/www.google.com/.session/state.json` exists →
  `capabilities/google-ai-search/session.lock.json` flips `locked:true` /
  `status:"locked"` with the hash + `capturedAt` (lock authoring is separate; there is
  no auto-edit — update the lock file by hand, mirroring the gemini one).

### kimi — runner wired, waiting on session  ⭐ capture first
- Package dir: `capabilities/kimi/`. Status: inventory + package + runner
  (`src/capabilities/kimi.ts`, `/capability/kimi` wired in `src/prompt/http.ts`).
- Host: `www.kimi.com` → `data/www.kimi.com/.session/state.json`.
- **Storage that must be preserved: localStorage, not cookies.** Auth is the
  localStorage keys `access_token`, `refresh_token`, `msh_user_id`; the token is replayed
  as `Authorization: Bearer <access_token>` (+ `x-msh-shield-data` TrustDecision blackbox)
  against `https://notilo.kimi.com/apiv2` (Connect/protobuf). The exact cookie set is
  secondary — `session.lock.json` notes "tokens live in localStorage, not cookies".
- What to do in the browser: sign in at `www.kimi.com` (SMS/QR/third-party — no bot-wall
  was hit on static probes); land on the chat UI with history visible; press Enter.
- Command:
  ```bash
  node --import tsx src/cli.ts profile capture "https://www.kimi.com"
  ```
- Expected after-capture: lock file records localStorage keys
  `access_token/refresh_token/msh_user_id`; `/capability/kimi` chat + list_conversations
  (DOM sidebar) return live results. `model_list`/RPC list_conversations stay "future work".

### hunyuan-yuanbao — runner wired, HEADED-ONLY  ⭐ capture second
- Package dir: `capabilities/hunyuan/` (package id `hunyuan`; product `yuanbao.tencent.com`).
  Status: inventory + package + runner (`src/capabilities/hunyuan.ts`,
  `/capability/hunyuan` wired).
- Host: `yuanbao.tencent.com` → `data/yuanbao.tencent.com/.session/state.json`.
- **Storage: the `hy_user` + `hy_token` cookies** (asserted server-side via the Cookie
  header; JS never writes them).
- **Anti-bot: HEADED ONLY, no headless.** The SPA sends `X-webdriver: +!!navigator.webdriver`
  (i.e. `1` on headless/automated Chrome) and runs Turing.js + QIMEI fingerprinting
  (`static.yuanbao.tencent.com/m/lib/Turing.js`). A headless capture will be flagged.
- What to do in the browser: open `https://yuanbao.tencent.com/` **headfully** (your real
  Chrome; `UI2API_CHROME=1` + `UI2API_USER_DATA_DIR` preferred, or `UI2API_ATTACH_PORT=9222`
  attach), complete Tencent login/oneid, send one test message in the Quill composer,
  press Enter. If a guest `hy_anon_token` was minted instead of a real login
  (`/api/anon/login`), real signed-in users still carry `hy_user`/`hy_token`.
- Command:
  ```bash
  UI2API_CHROME=1 node --import tsx src/cli.ts profile capture "https://yuanbao.tencent.com"
  ```
  (The lock file still records the older `ui2api analyse https://yuanbao.tencent.com --login`
  form — identical snapshot, both write `data/yuanbao.tencent.com/.session/state.json`.)
- Expected after-capture: `/capability/hunyuan` chat runs against `/api/chat`
  (SSE-over-XHR); lock file records `hy_user`/`hy_token`; headed-only caveat persists in
  every runner result.

### venice — grounded package (REST), no runner yet
- Package dir: `capabilities/venice/`. Status: ✅ grounded (endpoints verified statically).
  Transport is plain **OpenAI-compatible REST on `https://api.venice.ai/api/v1`**
  (`/chat/completions`, `/image/generate`, `/video/queue`, `/audio/queue`) — not RPC.
- Host: `venice.ai` → `data/venice.ai/.session/state.json`.
- Storage: cookie **`session`** (provider-catalog, `venice-web`). The cookie→token-mint
  flow and the exact cookie set beyond `session` are **unverified — to verify on first
  capture** (the `/chat/v2` bundles are lazy and were not in the landing graph).
- What to do in the browser: `https://venice.ai` (no bot wall on the landing via curl) →
  sign up/in → open `/chat/v2`, send one message (watch for the session cookie + any
  bearer minted in the network tab) → press Enter.
- Command:
  ```bash
  node --import tsx src/cli.ts profile capture "https://venice.ai"
  ```
- Expected after-capture: lock records `session` cookie; `venice_chat` etc. remain
  "recipe present, **to verify on live session**" until a captured network log confirms
  the mint + SSE shapes (`venice/CAPABILITIES.md` §8).

### deepseek — grounded, localStorage + AWS WAF/PoW
- Package dir: `capabilities/deepseek/`. Status: ✅ grounded (bundles verified).
- Host: `chat.deepseek.com` → `data/chat.deepseek.com/.session/state.json`.
- **Storage that must be preserved: localStorage `userToken`→`Authorization: Bearer`,**
  plus `settingsJwt` (`x-settings-token`) and `__appKit_userInfo`. The static shell on
  `/` is behind an **AWS WAF JS challenge** (`x-amzn-waf-action: challenge`; also
  `cf_*`-style `awsChallenge`/`awsCaptcha` detection), so the captured cookies/state must
  let an injected context pass the WAF, and chat needs the **PoW** (`POST
  /api/v0/chat/create_pow_challenge` → `X-DS-PoW-Response`) — PoW solving lives in an
  async chunk and is not reverse-engineered yet.
- Login method: **SMS / email-OTP only** (`/v0/users/login_by_mobile_sms`,
  `/v0/users/register_by_mobile`); no password path found — password existence *to probe
  live on first capture*.
- What to do in the browser: `https://chat.deepseek.com` → login by phone **OTP** → land
  on the chat UI → send one test prompt → press Enter.
- Command:
  ```bash
  node --import tsx src/cli.ts profile capture "https://chat.deepseek.com"
  ```
  If the WAF blocks even the headed bundled Chromium, use `UI2API_USER_DATA_DIR` (your
  already-cleared Chrome) or `profile ingest` against your Chrome profile dir (offline).
- Expected after-capture: lock records `userToken` (kind `token`); DOM sidebar
  (`src/capabilities/deepseek.ts`) reflects the session. Full `/api/v0/chat/completion`
  replay stays gated on PoW capture — *verify on live session*.

### claude — grounded, Cloudflare/hCaptcha-gated HTML but public bundles
- Package dir: `capabilities/claude/`. Status: ✅ grounded (22 bundles from the public
  `assets-proxy.anthropic.com` CDN; **`claude.ai` HTML itself is Cloudflare-gated**).
- Host: `claude.ai` → `data/claude.ai/.session/state.json`.
- Storage: cookie **`sessionKey`** (provider-catalog `claude-web`) — cookie name confirmed
  only via provider-catalog, **to verify on first capture**; expect additional
  `cf_*`/attestation cookies. Streams may send `X-Device-Attestation` (fed by **hCaptcha**).
- What to do in the browser: `https://claude.ai` → pass CF ("Just a moment…") →
  sign in → open a chat, type in the **ProseMirror** composer
  (`.ProseMirror`, answer nodes `[data-testid="assistant-message"]`), press Enter.
  **Record the send request in the network tab** — the send-endpoint lives in a lazy
  chunk and is *unverified for this build* (classic path was
  `POST …/chat_conversations/{conv}/completion`); the UI path works regardless.
- Command:
  ```bash
  UI2API_USER_DATA_DIR=/path/to/logged-in-chrome \
    node --import tsx src/cli.ts profile capture "https://claude.ai"
  ```
- Expected after-capture: `claude_chat` (insertText + Enter) reads answers off the
  `assistant-message` nodes; lock records `sessionKey`.

### poe — scaffold only, Cloudflare-walled to curl
- Package dir: `capabilities/poe/`. Status: ⬜ scaffold (bot-walled).
- Host: `poe.com` (`www.poe.com` possible — **confirm cookie domain on first capture**).
- Storage: cookie **`p-b`** (provider-catalog `poe-web`); a CSRF `t`/formkey historically
  rides the boot payload — **to verify on first capture**. Transport (SSE/WS/polling) is
  **unknown** — CF 403 challenge on every path, no bundles retrievable.
- What to do in the browser: `https://poe.com` → pass Cloudflare Turnstile in a REAL
  headed browser (expect `cf_clearance`) → sign in → open a thread → send one message.
- Command:
  ```bash
  UI2API_USER_DATA_DIR=/path/to/logged-in-chrome \
    node --import tsx src/cli.ts profile capture "https://poe.com"
  ```
  If a fresh profile fails the Turnstile, attach your running Chrome
  (`UI2API_ATTACH_PORT=9222`) or `profile ingest`.
- Expected after-capture: `poe_chat` ui-path (composer insertText + Enter) — the only
  capability — plus the real wire + selectors recorded *as observed*, not assumed.

### grok — scaffold only, Cloudflare JSD-walled
- Package dir: `capabilities/grok/`. Status: ⬜ scaffold (bot-walled).
- Host: `grok.com` → `data/grok.com/.session/state.json`.
- Storage: cookies **`sso` + `sso-rw`** (provider-catalog `grok-web`) — **unverified**;
  x.ai's sibling SPA has zero chat-wire endpoints, and grok.com returns hard 403 +
  Cloudflare **JSD** (JavaScript Detection) challenge to curl.
- What to do in the browser: `https://grok.com` in a real headed Chrome → clear the JSD
  challenge → sign in (the `.grok.com` auth real cookie set is **to verify**) → send one
  chat message → press Enter. Record what you see: composer markup, cookie names/flags,
  and the request that actually sends (method/path/streaming format) — nothing is assumed
  in `grok/CAPABILITIES.md` §5.
- Command:
  ```bash
  UI2API_USER_DATA_DIR=/path/to/logged-in-chrome \
    node --import tsx src/cli.ts profile capture "https://grok.com"
  ```
- Expected after-capture: only `grok_chat` (ui-path) plus the captured facts.

### perplexity — scaffold only (auth verified live, chat walled)
- Package dir: `capabilities/perplexity/`. Status: ⬜ scaffold (auth verified, chat walled).
- Host: `www.perplexity.ai` → `data/www.perplexity.ai/.session/state.json`.
- Storage: cookie **`__Secure-next-auth.session-token`** (NextAuth JWT session cookie).
  NextAuth handshake is **live-verified**; the **magic-link path is automation-friendly**:
  `POST /api/auth/callback/email` (CSRF-protected) → emailed link → the cookie gets set.
- What to do in the browser: easiest is login via email magic link; Google OAuth works too.
  Chat transport (`/api/chat`, `/socket.io/`, `/rest/chat`) is Cloudflare-challenged to
  curl — a real browser may pass but expect `cf_clearance`/`cf_chl_*` in the snapshot and
  the occasional "Are you human?" overlay.
- Command:
  ```bash
  UI2API_USER_DATA_DIR=/path/to/logged-in-chrome \
    node --import tsx src/cli.ts profile capture "https://www.perplexity.ai"
  ```
- Expected after-capture: `perplexity_chat` ui-path Ask works; focus modes/threads/models
  stay intentionally NOT in the manifest (`perplexity/CAPABILITIES.md` §3) until grounded.

---

## 3. Capture order / roadmap (dependency-matched)

Runners exist and are only waiting on a session — capture those first. Wall-scaffolds last.

1. **kimi** — runner + `/capability/kimi` wired; only `localStorage` auth, no wall.
2. **hunyuan-yuanbao** — runner + `/capability/hunyuan` wired; **must be headed**
   (X-webdriver/Turing.js/QIMEI). Use your real Chrome / attach mode.
3. **google-ai-search** — fully implemented, cheapest to unlock: one signed-in
   `www.google.com` snapshot opens the `udm=14` AI Mode flow.
4. **venice / deepseek / claude** — grounded packages (REST / localStorage+WAF / CF+hCaptcha).
   deepseek needs localStorage + PoW note; claude needs a headed CF pass; venice is
   curl-friendly but its cookie→mint is unverified.
5. **poe / grok / perplexity** — scaffolds, Cloudflare-walled everywhere. Expect to need
   a real Chrome profile / attach mode / profile-ingest; verify each fact rather than
   trusting community endpoints.

Order mapping matches `capabilities/README.md` roadmap items 4–6 (gemini already done,
item 3; google-ai-search is item 2 and only the session is missing).

---

## 4. Verify your capture worked

Snapshot presence check (no browser needed):

```bash
ls -la data/<host>/.session/state.json          # exists after a successful capture
cat capabilities/<site>/session.lock.json       # should flip to locked + hash+date (hand-authored, mirror gemini)
```

Live round-trip through the daemon (the pattern from `src/prompt/http.ts`):

```bash
# Daemon with a warm pool; headed+virtual-display for heavy/anti-bot sites:
DISPLAY=:99 UI2API_HEADED=1 UI2API_PROMPTD_TOKEN=op-secret \
  node --import tsx src/cli.ts promptd --port 9797 --site gemini
# (repeat --site <ids> for each captured site; drop --site to serve all built-ins)

# /prompt — works for every built-in profile id (gemini, kimi, hunyuan, google-ai-search,
# claude, perplexity, …):
curl -s -X POST http://127.0.0.1:9797/prompt \
  -H 'authorization: Bearer op-secret' -H 'content-type: application/json' \
  -d '{"site":"gemini","prompt":"say hi","newChat":true}'

# /capability/<site> — wired runners only (gemini, kimi, hunyuan):
curl -s -X POST http://127.0.0.1:9797/capability/kimi \
  -H 'authorization: Bearer op-secret' -H 'content-type: application/json' \
  -d '{"capability":"kimi_list_conversations","args":{}}'
# /capability/gemini  -> {"capability":"gemini_list_conversations"} etc.
# /capability/hunyuan -> chat / list_conversations (DOM)
```

Health endpoints: `GET /sites` (ids + loginRequired), `GET /status` (pool warmth),
`GET /health`. The daemon binds `127.0.0.1` only and never drives unconfigured origins.

One-shot check without the daemon:

```bash
node --import tsx src/cli.ts prompt "hello" --site kimi     # needs the kimi snapshot
node --import tsx src/cli.ts prompt --sites                 # lists ids + login flags
```

> Sites without a built-in profile id (venice, deepseek, poe, grok are NOT in
> `src/profile/profile.ts`; deepseek/venice/poe/grok have no `/capability/*` route): verify
> the snapshot on disk + the lock file, then run the site's recorded wire/REST recipe against
> `data/<host>/` per `profile.json` — final live proof happens at the recipe level.

---

## 5. Troubleshooting

- **Cloudflare walls (poe / grok / perplexity / claude):** curl will always 403. Use the
  **real Chrome profile** escape hatch: `UI2API_USER_DATA_DIR=/path` (close that Chrome
  first or copy the profile); or **attach your running Chrome** over CDP with
  `UI2API_ATTACH_PORT=9222`; or `profile ingest` to read cookies+localStorage straight
  out of a Chrome profile **with no browser launched at all**. Expect `cf_clearance` /
  `cf_chl_*` / `_cfuvid`-style cookies in the snapshot.
- **hunyuan anti-bot (X-webdriver / Turing.js / QIMEI):** **headed only.** Never capture
  or run it headless; the API flags `X-webdriver: 1` and risk-control logs behavioral
  marks. Real-profile + headed + stable window is the only validated posture
  (`capabilities/hunyuan/CAPABILITIES.md` §9; `docs/STEALTH.md` verdict is the same:
  attach/headed+real-profile is the only true no-trace posture).
- **deepseek WAF/PoW:** the snapshot MUST carry `localStorage.userToken` (a cookie-only
  capture will not authenticate); PoW is server-gated per request and its miner is not yet
  reverse-engineered — a synthetic fetch layer is blocked until a live PoW pair is captured.
- **`pkill` trap: never bare `pkill node`.** It kills unrelated processes and — as the
  `chrome-cdp.service` pkill loop proved (`docs/TROUBLESHOOTING.md`) — can silently murder
  every CDP browser for days. Kill by pid / session id (e.g. the PTY session or
  `kill <promptd-pid>`), and stop the daemon through its own SIGINT/SIGTERM handler.
- **Snapshot JSON is gitignored (secrets):** `data/**/.session/` holds auth material and
  never goes into git. Back up your captures by copying the directory, not by committing.
- **Two Chromes, one profile:** sharing a live Chrome profile with a freshly spawned
  browser fails; close the browser or copy the profile dir first.
- **`promptd` appears to hang / `--help` hangs:** there is no per-command help; pass a
  real URL to `analyse`, and stop promptd with Ctrl-C (it registers SIGINT/SIGTERM).
- **Fresh-spawn browsers crash (AppArmor userns traps):** use attach mode
  (`UI2API_ATTACH_PORT=9222`) against a standing Chrome; the daemon adopts it and never
  spawns/kills a browser.

---

## 6. After-capture checklist

- [ ] `data/<host>/.session/state.json` exists and is non-empty.
- [ ] The **required storage** is present: cookies for
  hunyuan/google-ai-search/venice/claude/poe/grok/perplexity; **localStorage** for
  kimi (`access_token`) and deepseek (`userToken`); gemini: already locked.
- [ ] Verify the required keys live in the snapshot (`jq` the JSON / grep the file):
  e.g. `hy_user`,`hy_token` — or `access_token` — or `userToken` — or
  `__Secure-next-auth.session-token` — etc.
- [ ] `session.lock.json` updated by hand to `locked:true`, hash prefix, `capturedAt`,
  cookie/localStorage key list, and one line of evidence (mirror the gemini lock).
- [ ] Live check passed: `/prompt` (built-ins) or `/capability/*` (gemini/kimi/hunyuan)
  returned a streamed answer using the injected snapshot.
- [ ] Unverified facts recorded *as observed* (cookie domains, `cf_*` cookies, send-endpoint
  method/path, DOM selectors) — never fabricated.

## 7. Facts that could not be verified from the repo (all static analysis)

These stay "to verify on first capture" — do not hard-code them into recipes or manifests:
venice's `session` cookie→bearer mint + SSE frames; deepseek's actual `model_type` ids,
PoW mining algorithm/difficulty, and whether password login exists; claude's real
message-send request shape (lazy chunk) and exact cookie set incl. hCaptcha; poe's real
transport, CSRF `t`/formkey, and cookie domain (`poe.com` vs `www.poe.com`); grok's real
session cookie set and whether `sso`+`sso-rw` alone authenticate; perplexity's chat wire
shape and focus-mode payload; google-ai-search's exact `AF_initDataCallback` shape for the
`udm=14` answer block and whether AI Mode is rollout-gated on the capturing account.