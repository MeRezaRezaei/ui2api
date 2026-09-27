# Vision

> Status: live. This is the design contract for anyone (human or AI) working on
> UI2API. Read [`AGENTS.md`](../AGENTS.md) first (the current-architecture source
> of truth and command list), then this file. Cold-start order:
> `AGENTS.md` → `docs/ONBOARDING.md` → `docs/UNLOCK.md` → this file →
> [`CONTRIBUTING.md`](../CONTRIBUTING.md) (add a site) → the registry landing
> (the install catalog — the public `MeRezaRezaei/ui2api-registry` repo,
> published; see "The install loop" below).

## The core idea

**UI2API turns any website into an API driven by the user's own browser
session.** The flagship use-case: an AI chat site (Gemini, Kimi, DeepSeek,
Hunyuan, Claude, ChatGPT, …) becomes an OpenAI-compatible `POST /prompt`
endpoint whose requests are executed by the site's **own JavaScript** in the
**user's real logged-in session** — the same cookies, localStorage, and origin
code paths a human would use.

Non-negotiable core property: **no fabricated traffic.** We never synthesize
requests or send fake inputs that could look foreign to the site's anti-bot
stack. We drive the site through its own UI/JS and read answers back off the
page. From the site's perspective nothing is wrong — it is just a user
interacting. There is nothing synthetic to fingerprint, and existing auth
(cookies, session storage, device trust) is already in place because it is the
user's own account (captured once, replayed faithfully, or driven through the
user's actually-running Chrome).

What we do **not** do: captcha-bypass services, BYOIP/residential-proxy
tricks, or any "bot traffic" business. Only sites the user owns or is
authorized to use. See `CONTRIBUTING.md` red lines.

## The two execution models

Everything live in this repo is one of these (per `AGENTS.md`).

### 1. ChatDriver — declarative profiles, one driver for every chat site

`src/prompt/driver.ts` implements the shared loop: paste a prompt + Enter via
the site's own JS (trusted CDP input primitives, `keyboard.insertText`/`press`),
read the streamed answer off the page until it stops growing, return it. The
per-site knowledge is a `ChatSiteProfile` (`src/profile/profile.ts`: composer /
send / answer selectors, dismiss list, delays) — declarative, overridable via
JSON with `--profile FILE`. The default chat set is
`defaultChatProfiles()` (`src/prompt/registry.ts`): the builtin catalog merged
with every installed **driveable** chat-shaped package — **22 ids, measured
2026-09-27** (derive the live set with `npx tsx src/cli.ts prompt --sites` or
`GET /v1/models`; the number has already moved 25 → 23 → 22 as the gates
tightened) incl. duckduckgo, poe, grok — where "driveable" (GOAL 32 truth-gate)
means every composer/answer entry is a parseable CSS selector under Playwright's own
selector grammar (prose rows and playwright-only pseudo-classes are refused)
and the package's metadata status is not dormant/dead-end (zenmux, xiaomimimo
stay on /registry + /capability/<id> with their honest status until
live-verified) — capability-only packages never become chat models. GOAL 147
dropped `google-ai-search` from the chat surface (composer-less profile, no
`*_chat` capability, `loginGatedResult(...)` runner) for the same reason: it is
**not removed from the product** — it stays fully served on `/registry` +
`POST /capability/google-ai-search`, and an explicit `--site google-ai-search`
still resolves; only its chat-model claim is withdrawn. GOAL 34:
`/registry` stamps `chat.model` ONLY on these surfaced ids, so a consumer
never sees a chat provider that `/v1` would refuse.

- One-shot: `ui2api prompt 'hello' --site gemini`
- Daemon: `ui2api promptd` → `POST /prompt`, `POST /v1/chat/completions` (OpenAI-compatible, `stream:true` replays the finished DOM-read answer as SSE — honest: it is a page read, not synthesized traffic).

### 2. Capability runners — per-site capability surfaces

`src/capabilities/*.ts` expose a site's non-chat (and chat) surface as
`/capability/<site>` endpoints wired in `src/prompt/http.ts`: e.g.
`deepseek_reasoner`/`deepseek_web_search` (real composer toggles),
`kimi_list_conversations` (sidebar DOM), `youtube_search` (result grid),
`araprat_search`/`trending`/`video_detail`, `duckduckgo_*` (all six caps,
anonymous). Each package carries a `manifest.json`; the dispatch is kept
in-sync with the manifests by `test/capability-dispatch.test.ts`. Unknown
capability = `ok:false` before any browser; posting/login-bound caps answer
honestly `ok:false loginGated:true` (a browser may launch, a fabricated result
never does).

Both models launch their browsers through the one seam below and replay
snapshot-injected vault sessions the same way.

## The single browser seam

Every browser launch goes through **`launchBrowser()`** in
`src/runtime/browser.ts`. Never `launch()` a browser ad-hoc. It resolves, in
order:

1. **Attach** — `UI2API_ATTACH_PORT=9222` adopts the operator's already-running
   Chrome over CDP (zero spawn, zero flags, the user's real default context).
   The honest path for app-bound/login-gated sites (`docs/UNLOCK.md`).
2. **Managed spawn + CDP connect** — the default; a clean flag stack is used;
   real-profile/headed mode omits `--disable-gpu`/viewport/synthetic access so
   the page JS sees the user's real GPU, screen, and assets (see `STEALTH.md`).
3. **Playwright fallback** — bundled Chromium / system Chrome only, and never
   for the user's real profile (`--enable-automation` would leak as a tell).

Environment knobs (full table in `AGENTS.md`): `UI2API_HEADED`, `UI2API_CHROME`
(+`UI2API_CHROME_PATH`), `UI2API_USER_DATA_DIR`, `UI2API_ATTACH_PORT`,
`UI2API_POOL_MIN`.

## The session model (capture → lock → replay)

Sessions are **snapshot-injected**: capture once into the identity-keyed vault,
lock it in the package (`capabilities/<site>/session.lock.json`), and replay
cookies + localStorage + sessionStorage + IndexedDB into fresh browser contexts
at runtime (`injectSnapshot`). Capture surfaces:

- `ui2api profile add-all --known` — one-command bulk import of every KNOWN AI
  host session your OS Chrome profiles already hold, with a per-account
  read-back verdict table and zero temp residue (GOAL 9).
- `ui2api profile capture <url> [--assist]` — fresh headed login + capture for
  one host (`--assist` = xhost display-share, prefers the ui2api user's data
  dir when genuinely writable, says so honestly).
- `ui2api profile ingest <host> [--profile DIR]` — offline read of a live
  Chrome profile's DBs (cookies + localStorage), no browser launched.
- `ui2api profile import <host>` — one host from a scanned OS Chrome profile.
- `scan` / `list` / `capabilities` — discover hosts, vault accounts, and what
  an account can do.

Vault: `data/sessions/<host>/<slug>/state.json` (gitignored — never commit,
never paste; snapshots contain real credentials). Multi-account is live on the
wire: `"account":"<slug|email>"` on `POST /prompt` and `POST /capability/<site>`
(validated against the vault before any browser), `GET /accounts?site=`, and
each registry package carries `accounts[]`.

**Honest caveat measured in this project (fold #17f, GOAL 19/21):** some auth
classes are **not portable**. Google's auth cookies are browser/app-bound
(Chrome-152 portal v20) — importing/replaying them into fresh ephemeral
contexts renders anonymous (and can trip "confirm you're not a bot"). Those
capabilities can only run through the user's own real Chrome via the
`UI2API_ATTACH_PORT` **attach seam** — see `docs/UNLOCK.md`. Never claim a
portable replay for a site whose session is app-bound.

## Serving surfaces (the daemon)

`ui2api promptd` binds `127.0.0.1` only (optional bearer token via
`UI2API_PROMPTD_TOKEN`), trusts only configured profiles (`src/runtime/ssrf.ts`
origin-pinning — never arbitrary URLs), and exposes:

| Endpoint | Purpose |
|---|---|
| `GET /health` / `GET /status` | liveness / pool state |
| `GET /sites` | configured profiles |
| `GET /registry` | installed packages (`<site>_<capability>` tools + `verified` records + `accounts[]`) — the only info source consumers need |
| `GET /accounts?site=` | vault accounts for a profile |
| `GET /v1/models`, `POST /v1/chat/completions` | OpenAI-compatible chat (model = site id; `stream:true` replays the DOM-read answer as SSE) |
| `POST /prompt` | `{"site","prompt","account"?}` chat |
| `POST /capability/<site>` | non-chat capabilities |

External consumers: MCP over stdio via `ui2api plugin serve <module.ts>`
(live-proven end-to-end against a generated tool, GOAL 17); ACP via
`generate --acp` (unit-covered). The registry is the single source of truth for
consumers — no site knowledge lives in the caller.

## The install loop (community → local)

**Status: the public registry IS published, and the CLI defaults to it** (measured
2026-09-27). The registry is a public repo (`MeRezaRezaei/ui2api-registry`,
default branch `master`, `private: false`, last pushed 2026-09-24) whose
`index.json` served HTTP 200 with **33** entries, and `ui2api install --catalog`
/ `ui2api install <site>` work against it with no `--registry` and no
`UI2API_REGISTRY_URL`. Every site there is a full capability package (manifest /
profile / recipes / session.lock / CAPABILITIES.md / metadata) — mostly
`trust: unreviewed` (4 `reviewed`), so treat a package as unvetted until a
maintainer says otherwise. The equivalent local path is the packages vendored in
this repo's `capabilities/<site>/` (already served by `promptd` via
`GET /registry`), or `analyse` + `generate`; `--registry` /
`UI2API_REGISTRY_URL` selects a self-hosted or forked registry instead of the
default.

Re-derive the registry facts above rather than trusting this paragraph — they are
facts about a third-party repo and they rot like any other:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://raw.githubusercontent.com/MeRezaRezaei/ui2api-registry/master/index.json   # 200
npx tsx src/cli.ts install --catalog   # live catalog: site | version | trust
```

Both halves of the loop now exist:

1. **Add a site** (contributor → registry): the complete copy-paste workflow is
   `CONTRIBUTING.md` "Add a site / capability package" — analyze → package
   under `capabilities/<id>/` → runner in `src/capabilities/` → wire
   `/capability/<id>` → builtin profile (chat sites only) → capture+lock →
   live-verify → registry sync (site + docs rows) → gates + PR. Never claim
   verified without a live round-trip.
2. **Install** (stranger, one command, no analyse/generate): `npm i -g ui2api`;
   `ui2api install --catalog` lists; `ui2api install <site-id>` fetches
   `packages/<site-id>/` into `capabilities/<site-id>/` — the same layout
   `promptd` already serves, so `GET /registry` picks it up with no extra step.
   `trust` stays `unreviewed` until a maintainer reviews a package; login-bound
   capabilities still need your real session (`docs/UNLOCK.md`).

`ui2api` is published on **npm** (`ui2api@0.2.0`, running from source in a dev
checkout as `npx tsx src/cli.ts`); CI runs `build` + `integration` + full unit
suite on every push to `main` (one green GitHub Actions run against
`origin/main` is a GOAL-26-style completion gate).

## Honest per-site status (measured; a site is never "verified" by claim)

- **Live-verified round-trips on this box**: `gemini`, `deepseek` (reasoner +
  web_search toggles), `kimi` (chat + list_conversations + model_list +
  web_search + file_upload) via session-locked vault replay; `tencent-aistudio`
  chat (headed/real-Chrome only — EdgeOne blocks headless, HTTP 567);
  `duckduckgo` (duck.ai, anonymous — all six caps);
  `youtube_search`; `araprat_search`/`trending`/`video_detail`.
- **Honest dead-ends (never claimed verified)**: `google-ai-search` (portal v20,
  external sign-in required); `gmail` and youtube posting/transcript
  (app-bound — attach-only, UNLOCK.md); the tencent-aistudio
  web_search/deep_think/file_upload/tts/etc. surface (the product has no UI);
  `hunyuan` (yuanbao.tencent.com — no session exists anywhere); claude/chatgpt/
  poe/perplexity on this network (Cloudflare/OAuth walls). Full inventory:
  `capabilities/README.md`.

## Guardrails (non-negotiable)

- **No fabricated traffic; only authorized sites.** Never synthesize requests;
  answer reads come off the real page. Stealth posture = use the user's real
  browser/session faithfully (`docs/STEALTH.md`), never spoofing (no UA/WebGL/
  navigator trickery — the session IS real, so there is nothing to fake).
- **Privacy boundary:** `data/` and session snapshots are gitignored and never
  committed or pasted; the daemon binds localhost and answers only configured
  sites; `UI2API_PROMPTD_TOKEN` optionally gates with a bearer token.
- **Honesty rule:** a capability is verified only by a real recorded live
  round-trip; everything else is `ok:false` with the measured reason
  (`loginGated`, the wall's own text), never a fabricated green.

## Definition of done for a change

A change is vision-correct when a cold-start AI (or new contributor) can:
`npm i -g ui2api` (or `npx tsx src/cli.ts` from the checkout) → `ui2api prompt`
and `ui2api promptd` against a captured or installed session → reach the
site's real answer through the site's own JS — with the operations, session
model, and honesty rules above unchanged and documented. Every doc ships the
REAL command set (`src/cli.ts` is the source of truth; docs never invent
flags). A change that only works via fabricated traffic or a synthetic profile
is a fallback, not the feature — call it out as such.