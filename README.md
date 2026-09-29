# UI2API

[![CI](https://github.com/MeRezaRezaei/ui2api/actions/workflows/ci.yml/badge.svg)](https://github.com/MeRezaRezaei/ui2api/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/ui2api.svg)](https://npmjs.com/package/ui2api)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> Turn any site you use into AI tools — analyze a website once, then generate a per-site MCP or ACP server so your AI agent can drive it by calling tools.

**UI2API** analyzes a website once (instrumenting its in-page JS calls, network
calls, and DOM interactions), captures the site's *real* action recipes, and
generates a per-site [MCP](https://modelcontextprotocol.io) / ACP server so an AI
agent can drive the site by calling tools like `send_prompt(text)` instead of
screen-reading and clicking buttons.

## Why

Today AI agents interact with websites the way humans do — navigate, locate a
control, click, read the screen. That is high-friction and brittle. A site's real
capabilities are a finite, structured set of actions. UI2API makes those actions
first-class tools. When a site changes, re-run the analyzer and the tool surface
regenerates.

It is built for the sites you are *authorized* to automate: your own apps, APIs
you hold keys for, accessibility workflows, and personal productivity. The output
is a reviewable, generated tool-server you control.

## Demo

```bash
# 1. Analyze a site once — capture its real action recipes
npx ui2api analyse https://app.example.com --llm

# 2. Generate a per-site MCP server from the captured map
npx ui2api generate app.example.com

# 3. Serve it — your AI agent now calls the site as tools
npx ui2api serve app.example.com
```

An agent calling a generated tool:

```json
{
  "tool": "send_prompt",
  "arguments": { "text": "Summarize this thread" }
}
```

UI2API executes the captured recipe against the live, origin-pinned session and
returns the result — no brittle screen-scraping.

## Features

- **Real action recipes** — the analyzer captures the exact in-page JS functions,
  network calls, and DOM interactions a site actually uses, so generated tools
  mirror the site's true behavior.
- **MCP + ACP targets** — emit either a Model Context Protocol server or an ACP
  server from the same action map.
- **Agent-skill wrapper** — generated servers drop in as a callable tool source
  for your AI agents and orchestrators.
- **Cookie-session capture for auth'd sites** — `--login` records the authenticated
  session cookies so tools can act on sites that require sign-in.
- **V1 login simplicity gate** — `xhost+` display-share capture (login in a real
  visible browser as the `ui2api` user), OS-wide Chrome-profile scanning with
  checkbox-style site import, a one-command `profile add-all` bulk import of
  every Chrome-profile site session, and an identity-keyed multi-account
  session vault. Anonymous sessions (zero cookies AND zero localStorage) are
  refused at the write seam with a named `skipped-no-auth` verdict — the vault
  and `/accounts` never list a session that carries no sign-in. A same-slug
  different identity is likewise refused (`slug-collision`) instead of silently
  overwriting an existing account — and account reads are exact too
  (`resolveStoredAccount`): a refused alias 400s with the named available
  slugs, never silently driving the survivor's session. The generated/plugin
  consumer surfaces can pick the account too (GOAL 52): the generated PHP
  client's `chat()`/`capability()` forward an optional `$account`, generated
  ACP/MCP servers read `UI2API_ACCOUNT`, and `ui2api plugin serve --account`
  selects which vault account drives the plugin page. See
  [V1 gate](#v1-gate--login-made-simple-end-user-sessions).
- **Capability reflection** — learn what a specific account can actually do on a
  chat site (plan tier, available models, restriction walls) from what the site
  itself shows: `ui2api profile capabilities <host> [--account email]` probes the
  live session and stores a fingerprint per account; the daemon serves it at
  `GET /capabilities?site=X&account=Y`; prompts report in-band restrictions
  (`doneReason:"restricted"` + `restrictions[]`) and `--model NAME` selects a
  model or fails explicitly when the account lacks it (errors loudly if not on
  your account; the selection is verified after clicking).
- **LLM-assisted naming with offline fallback** — `--llm` uses a model to produce
  semantic tool names and task mappings; a deterministic heuristic fallback keeps
  the pipeline fully offline when no model is configured.
- **Trust gate** — generated maps are marked `trusted:false` and `serve` refuses
  to run an untrusted map without an explicit `--trust`, so generated tools are
  reviewed before they can act.

## Quick start

> **Published on npm** — `ui2api@0.2.0` is live (dist-tag `latest`, registry.npmjs.org/ui2api).
> Install globally, or run it on the spot with `npx`:

```bash
npm install -g ui2api            # the ui2api CLI (bin: ui2api)
npx playwright install chromium  # one-time browser download
```

Then analyze, generate, and serve a site:

```bash
# 1. Analyze a site once  (drop --llm to run fully offline)
ui2api analyse https://app.example.com --llm

# 2. Generate a per-site MCP server
ui2api generate app.example.com

# 3. Serve it — your AI agent now calls the site as tools
ui2api serve app.example.com
```

From a source clone (contributors / development), `npx tsx src/cli.ts …` works
identically to every `ui2api …` below.

Then connect any MCP/ACP client to the generated server and call tools like
`send_prompt`. Re-run `analyse`/`generate` when the site changes.

**Install a site package from a registry** — the one-command path with no
analyse/generate needed. A registry is a catalog of per-site capability packages
(`index.json` + `packages/<site>/…` on the `master` branch) served to your agents
by the same daemon that serves built-in sites.

> **The default registry is live and public** (measured 2026-09-27). The CLI
> defaults to `https://raw.githubusercontent.com/MeRezaRezaei/ui2api-registry/master`
> — the `master` branch of the public `MeRezaRezaei/ui2api-registry` repo
> (`private: false`, last pushed 2026-09-24, 33 catalog entries) — so
> `ui2api install` works with **no** `--registry` and no env var. Nothing below
> sets either.
>
> **Re-derive it, do not trust this paragraph** — it is a fact about the world and
> world-facts rot. One command says whether the default still answers:
>
> ```bash
> curl -s -o /dev/null -w '%{http_code}\n' \
>   https://raw.githubusercontent.com/MeRezaRezaei/ui2api-registry/master/index.json   # 200
> ui2api install --catalog        # prints the live catalog: site | version | trust
> ```
>
> If that 404s, the registry moved or is gone; then you need a registry you run
> or fork and the override below. You still do not need install at all — the same
> packages ship vendored in this repo, right after.

```bash
# OPTIONAL override — only if you want a registry OTHER than the public default.
# A raw base URL ending in the branch, e.g. <raw base of your fork>/ui2api-registry/master.
# A GitHub repo page (https://github.com/<owner>/<repo>) is normalized for you.
# export UI2API_REGISTRY_URL='https://raw.githubusercontent.com/<you>/ui2api-registry/master'
# …or per command: ui2api install duckduckgo --registry <url>

# Discover what's installable: site, version, trust (reviewed / unreviewed)
ui2api install --catalog

# Install a package — DuckDuckGo AI chat (anonymous, no login)
ui2api install duckduckgo

# Serve it — the daemon answers GET /registry, POST /capability/<site>, GET /v1/models
ui2api promptd

# Tighten the session vault's permissions — MODES ONLY, so it can never corrupt a
# credential. DRY RUN is the default; --apply is required to change anything.
ui2api vault tighten            # reports every file with old -> new mode
ui2api vault tighten --apply    # actually tightens (0600 files / 0700 dirs)

# Run a real installed capability (duck.ai's own browser session + UI)
curl -s localhost:9797/capability/duckduckgo \
  -H 'content-type: application/json' \
  -d '{"capability":"duckduckgo_web_search","args":{"query":"ui2api"}}'
```

Installed packages land in `capabilities/<site-id>/` — the exact layout
`promptd` already serves, so there is no "install dir vs. serve dir" split and
`GET /registry` picks the package up automatically. `--registry <url>` (or
`UI2API_REGISTRY_URL`) point install at your registry; the URL must be a **raw**
base ending in the branch (`…/ui2api-registry/master`) — a GitHub repo page is
normalized for you, a stale `/main` URL fails loudly with the corrective hint.
Check the package's `trust` (`unreviewed` until the operator reviews it) before
running it, and note login-bound capabilities need your real session (see
`docs/UNLOCK.md`), exactly like every built-in site.

**Already-working alternative (no registry, no install).** Every packaged site is
vendored in this repo under `capabilities/<site-id>/`, and that is the very
directory `promptd` serves — so a fresh clone already exposes them:

```bash
ls capabilities                     # duckduckgo, gemini, kimi, deepseek, youtube, …
ui2api promptd
curl -s localhost:9797/registry      # every vendored package, with its honest status
```

To add a site from scratch, the two-step path needs no registry at all:
`ui2api analyse <url>` then `ui2api generate <host>`.

**Validate the build against the fixture suite (source clone only)** — the
published npm package ships no test suite (`test/` is not in the tarball), so
these commands need a checkout and print `INTEGRATION OK` / `X tests … pass`:

```bash
npm run test:unit   # 146 hermetic unit-test files — no browser needed
npm test            # full integration test (needs the chromium browser above)
```

The `146` is the real length of the file list in `package.json`'s
`scripts["test:unit"]`, not a remembered figure — derive it yourself with

```bash
node -e 'const s=require("./package.json").scripts["test:unit"];console.log((s.match(/test\/[a-z0-9-]+\.test\.ts/g)||[]).length)'
```

and it is pinned by `test/doc-numbers-truth.test.ts`, so a stale count here
fails the suite instead of rotting. The per-file test *totals* (how many cases
each file generates at runtime) are deliberately NOT claimed here: they are
observable only by running the suite, so a hand-typed total can only rot. Get
the truth from the run itself — the last two lines of `npm run test:unit` print
the real `# tests` / `# suites`, and CI (`.github/workflows/ci.yml`) is the lane
that runs the full suite.

**Types are a separate gate, and `npx tsc --noEmit` is not it.** `npm run build`
compiles `src/` only — `tsconfig.json` sets `"exclude": [... "test"]` — so
neither it nor a bare `tsc` invocation ever looks at the test tree. The command
that does is:

```bash
npm run typecheck   # tsc -p tsconfig.test.json — src/ + test/ + scripts/
```

It is wired into **both** CI configs (`.github/workflows/ci.yml`,
`.gitlab-ci.yml`), and before it existed a test fixture could omit fields its own
interface declared required while both pipelines stayed green. See
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) for the two-config
breakdown.

## MVP — use AI sites for doing prompts

The fastest path to a working prompt engine needs no API keys, no login, and no
servers to babysit: **ui2api drives an AI chat website (ChatGPT-style UI) the way
you would** — paste the prompt into the composer, hit Enter, and read the streamed
answer off the page. All in your own browser session.

```bash
# ONE command — the buy-first self-test: OS requirements gate + one REAL
# anonymous AI-chat round-trip (no sign-in, no API key, no capture). Prints
# `smoke OK: duckduckgo answered "<answer>" in Nms` (exit 0) or the named
# failure (exit 1). DuckDuckGo ships vendored in capabilities/duckduckgo, so
# nothing is installed; only if that package were absent would smoke try the
# install seam, which reaches the public registry on its default URL (see above).
npx tsx src/cli.ts smoke

# Machine-readable verdicts for your CI/setup scripts — same honest gate,
# JSON output, the site token may come before OR after --json:
npx tsx src/cli.ts smoke --json
# {"ok":true,"site":"duckduckgo","answer":"SMOKE OK","ms":6926,
#  "message":"smoke OK: duckduckgo answered \"SMOKE OK\" in 6926ms",
#  "report":{"generatedAt":"...","node":"...","checks":[...],"packages":[...],"summary":{...}}}
# exit 0 = ok; exit 1 = any named failure (OS gate, install seam, round-trip)

# Zero-setup anonymous prompt — DuckDuckGo AI Chat (duck.ai) is the verified
# anonymous path: headless-by-default (verified headed; headless may hit the
# site's anti-bot wall), never login-gated
npx tsx src/cli.ts prompt "hello" --site duckduckgo

# Pick the site explicitly, or reuse your logged-in Chrome for sites that need it
npx tsx src/cli.ts prompt "hello" --site gemini            # needs a sign-in session
npx tsx src/cli.ts prompt --sites                          # list the available sites

# --json (and any other flag) is valid BEFORE or AFTER the prompt text — both
# ask the SAME text (a flag is never sent to the site as the prompt, so the
# flag-first form is safe and equivalent):
npx tsx src/cli.ts prompt --json "hello"                   # ≡ prompt "hello" --json

# Or expose it as a localhost JSON service so live apps (e.g. anything in /var/www)
# can call it WITHOUT touching them:
UI2API_PROMPTD_TOKEN=op-secret npx tsx src/cli.ts promptd   # http://127.0.0.1:9797
curl -X POST http://127.0.0.1:9797/prompt -H 'authorization: Bearer op-secret' \
  -H 'content-type: application/json' \
  -d '{"site":"copilot","prompt":"what is 2+2?"}'
```

`POST /prompt` body: `{"site","prompt"}` (plus optional `"newChat":true` to
force a fresh conversation, and `"account":"<slug|email>"` for a specific
vault account). By default the daemon reuses its warm pooled page for the site;
answer readback is baseline-fresh per ask, so a reused page never echoes a
previous prompt's still-mounted answer.

### promptd is a stand-by daemon (warm page pool)

`promptd` is a daemon that keeps `N` pages of the same site standing by, ready for
parallel requests — exactly like the request queue + a browser. Semantics:

- **`--pool-min N`** (or `UI2API_POOL_MIN`): warm at least `N` idle pages for the
  default site before serving (default `1`). More sites warm lazily on first request.
- **`--pool-max N`** (or `UI2API_POOL_MAX`): hard ceiling on per-site pages. Auto =
  `max(1, min(4, floor(freeGB/2)))`.
- A busy page is returned to the pool when the request finishes; pages whose
  underlying browser died are discarded and respawned on demand — the *daemon*
  `GET /requests` serves the daemon's **bounded request ring** (GOAL 87): the last
  N requests with their outcome (`done` / `refused` / `timeout`) plus the current
  in-flight count — it is the surface to read when a request seems stuck. It is a
  RING sized by `UI2API_REQUEST_LOG` (default 20) and carries NO secrets (no
  cookies, tokens or bodies). Like the rest of the daemon's surface it is
  unauthenticated on the localhost binding — set `UI2API_TOKEN` if you expose it.
  stays up even when a browser process cycles. `GET /status` shows the pool
  (`warm`: idle/busy pages per site).
- The daemon is **headless by default**: nothing opens on your desktop, and the
  spawned browser is the daemon's child — closing the daemon closes only pages
  it owns (nothing you opened yourself).
- **Headed pool** (`UI2API_HEADED=1` + `DISPLAY`): the stable route for
  signed-in, heavy-SPA sites — run the daemon against a virtual display
  (`Xvfb :99 ...`) and it keeps the browser alive where headless died. See
  [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) for the full recipe.
- **Attach mode** (`UI2API_ATTACH_PORT=9222`): instead of spawning, the pool adopts
  **your own long-running Chrome** over CDP (loopback only) and uses its logged-in
  session as the stand-by pages' identity. The daemon then never spawns or kills a
  browser; ending the daemon leaves your Chrome running untouched. This is the mode
  for hosts where freshly-spawned browsers crash (AppArmor `userns` traps etc.) but
  a standing browser is stable.
  ```
  # on a stable host, once, in your Chrome:
  google-chrome --remote-debugging-port=9222
  # then the daemon adopts it:
  UI2API_ATTACH_PORT=9222 UI2API_POOL_MIN=1 npx tsx src/cli.ts promptd
  ```
  (`promptd` itself starts Chrome with the debug port if you omit `--user-data-dir`.)

Available sites (declarative, tune-able): `gemini`, `chatgpt`, `claude`,
`copilot` (anonymous), `perplexity` (anonymous Ask), `huggingchat`,
`duckduckgo` (chat.duckduckgo.com), plus session-locked packages `deepseek`
(chat.deepseek.com), `kimi` (www.kimi.ai) and `tencent-aistudio`
(aistudio.tencent.ai — headed/real-profile only). Five chat sites are
**live-verified end-to-end** (see `capabilities/README.md`): deepseek = chat +
real DeepThink/Search toggles + conversation list; kimi = chat + conversation
list + model picker + web-search toolkit + file upload; gemini = chat
(re-verified fold #6/2026-09-15); tencent-aistudio = chat (EdgeOne-headed only)
+ full wire map; duckduckgo = **FULL SURFACE verified 2026-09-23** (chat,
model-picker, web-search toggle, file upload, reasoning-mode, chat-history —
all six live-verified headed/Xvfb, see `capabilities/duckduckgo/CAPABILITIES.md`).
Capability-
only sites (not chat): `youtube` (`youtube_search` verified 2026-09-20; posting
login-bound), `araprat` (search/trending/video_detail verified 2026-09-20) and
`gmail` (the flagship "working with a gmail agent" pitch — inbox read/list/open/
search + composer, all **DOM-unverified** because mail.google.com is 100%
auth-walled statically (GOAL 19 measured 2026-09-23); drive it via the user's
own real Chrome attached with mail.google.com signed in,
`UI2API_ATTACH_PORT=9222`). Every attach / plan / login-bound capability
(gmail, google-ai-search, youtube posting + transcript, gemini search toggle,
kimi Extra Long, tencent-aistudio's no-UI caps) has its measured blocker and
copy-paste unblock in **`docs/UNLOCK.md`**.
A machine-checkable `verified` record (since/evidence/via) rides on every
`/registry` package — absent or `false` = honestly not verified. Each package's
`chat.model` is present **only** on the servable chat ids `GET /v1/models`
lists (22 on a default daemon, measured 2026-09-27, GOAL 34 — derive the live
set from `GET /v1/models` or `npx tsx src/cli.ts prompt --sites`; `google-ai-search`
is deliberately absent, it has no chat surface behind it yet is still served as a
capability package) — absence = no chat surface, and
`POST /v1/chat/completions` 404s refused ids. Each verified
chat site exposes a `/capability/<site>` surface plus the shared `POST /prompt`.
Sending is always the site's **own JS**: paste event + Enter — no synthetic
mouse clicks; the answer is read from the page's event bus until it stops
growing. (`npx tsx src/cli.ts prompt --sites` lists what's available; the full
inventory of analyzed sites lives in `capabilities/README.md`)
Full copy-paste onboarding: **docs/ONBOARDING.md**.

- **Just works on its own**: zero-config browser (bundled Chromium, auto-fallbacks
  to system Chrome), no external LLM API, no logins for the anonymous sites.
- **`--login` / real Chrome profile** for signed-in sites: the session is yours, so
  no captcha walls (see [Using your real Chrome profile](#using-your-real-chrome-profile)).
- **Red-line safe**: `promptd` binds `127.0.0.1` only, serves only the profiles you
  configure (never arbitrary URLs), optionally bearer-token gated, and never touches
  `/var/www`. Apps there just `POST` in and read the answer out.
- **Tuning a site**: profiles live in `src/profile/profile.ts`; ship a JSON override
  with `--profile /path/gemini.json` (or `UI2API_AI_SITE`) if a site's UI changed.
  JSON overrides are validated before use (parseable selectors + chat shape +
  send shape) — a typo'd key or wrong-typed composer/answer/send entry fails
  loud at load, naming the file and the exact offending field. Installed
  packaged profiles (CLI site id / `/capability`) are validated the same way
  at serve time — a malformed `profile.json` is refused loudly, never a late
  runner crash.

Wire it into an agent the same way as any generated server:
`npx tsx src/cli.ts plugin serve src/plugins/ai-web.ts --base-url https://gemini.google.com` exposes `send_prompt`, `new_chat`, `read_last_response` and `ai_status` over MCP.
Consumer-side live proofs — a fresh OpenAI-compatible client streaming `POST /v1/chat/completions` (`stream:true` → real DOM-read SSE, deepseek→"418", kimi→"419") and an external MCP client invoking `deepseek_list_conversations` to `ok:true` over `plugin serve` (GOAL 17, 2026-09-23) — with copy-paste snippets, in **docs/ONBOARDING.md §11**.

## Error contract — the named failures

The daemon answers failures as `{"error": {"code": "...", "message": "..."}}`
(plus `type` and `param` on the `/v1` surface). Every code below is emitted by
the daemon today and is what a client should branch on — the `message` is prose
and may change; the `code` is the contract. This list is machine-pinned against
the source (a code that ships undocumented, or a doc entry with no code behind
it, fails the suite), so it cannot silently rot.

| status | `code` | when you get it | what to do |
| --- | --- | --- | --- |
| 400 | `invalid_json` | the request body is not a JSON **object** (`null`, an array, a bare string/number) | send a JSON object; a caller mistake is never a 500 |
| 413 | `payload_too_large` | the request body exceeds 1 MB (10⁶ bytes, `MAX_BODY_BYTES` in `src/prompt/http.ts`) — the upload is refused and the stream destroyed | split the request; the server stops reading immediately |
| 500 | `internal_error` | a genuine internal fault | retry later; the message is deliberately generic so no internal text, path or hostname leaks |
| 404 | `not_found` | unknown endpoint, or a model id `GET /v1/models` does not list (a refused/dormant package) | list `GET /v1/models`; do not retry — the id is not servable |
| 404 | `unknown_model` | the `model` is not a servable chat id (capability-only, dormant, or url-less package) | list `GET /v1/models`; do not retry — the id carries no chat surface |
| 503 | `pool_saturated` | every warm browser slot is busy | retry with backoff, or raise `UI2API_POOL_MIN` |
| 503 | `pool_queue_timeout` | the request waited in the pool queue longer than the queue deadline | retry later; sustained means the pool is undersized |
| 503 | `pool_closed` | the pool is closed (daemon shutting down) | not retryable on this instance; fail over or restart |
| 400 | `unknown_capability` | the `capability` is not in that site's manifest; the response lists the real ones | read the `available: [...]` list in the message and use one of those ids |
| 400 | `no_stored_account` | the requested `account` slug/identity is not in the vault for that host | use one of the slugs the message lists, or omit `account` for the shared session |
| 404 | `site_not_dispatched` | the site id is not in the daemon's dispatch table (it is not installed, or not routable) | the response carries a `dispatchable: [...]` list — pick one of those |
| 504 | `request_timeout` | the browser work outlived the daemon's aggregate deadline | raise `UI2API_REQUEST_TIMEOUT_MS`, then retry |

`POST /capability/<site>` and `POST /prompt` answer the same
`{"error": {"code", "message"}}` shape. The generated PHP client raises
`Ui2apiException` for all of them, carrying `errorCode` / `errorMessage` /
`status`, so a PHP consumer branches on the same codes.

- `ui2api proof` (alias `live-proof`) runs a LIVE end-to-end proof: it drives a
  chat site with a random arithmetic prompt and verifies the answer — an honest
  capability check, NOT a claim that any site is verified.
- `ui2api smoke` is the ONE command that runs the requirements gate and then the
  anonymous duckduckgo round-trip end to end.

## How it works

```
URL ──▶ analyze (headless browser + call interception + optional LLM mapper)
        ──▶ raw captures ──▶ build action map (normalize into typed action entries)
        ──▶ action-map.json ──▶ generate ──▶ MCP/ACP server
        ──▶ serve / execute (live, origin-pinned session) ──▶ agent calls tools
```

- **analyze** loads the site in Chromium, hooks `fetch`/`XHR`/`WebSocket` and
  in-page function calls, and records the real calls while representative tasks
  run. `--llm` names and describes actions semantically; otherwise deterministic
  heuristics are used.
- **build action map** normalizes repeated captures into typed action entries
  with inferred parameters.
- **generate** compiles the action map into one MCP/ACP tool per action.
- **serve / execute** keeps a live, authenticated browser session and runs each
  tool's recipe (live-JS delegation when state is needed, request replay when a
  pure call suffices).

## Security & trust

Generated artifacts are designed to be reviewed, not blindly trusted:

- **Generated maps are written `trusted:false`.** `serve` refuses to run an
  untrusted map unless you pass an explicit `--trust`.
- **Replay is origin-pinned** to the analyzed site and SSRF-guarded, so a
  generated tool can only act on the origin it was built for.
- **Cookie sessions are gitignored** — captured authentication is never committed.

Only use UI2API on sites you are authorized to automate. You are responsible for
complying with the terms of any site or API you point it at.

## What it is / what it is not

- **What it is:** a tool for turning sites you are *authorized* to use — your own
  properties, APIs you hold keys for, accessibility aids, personal productivity —
  into reviewable, generated tool-servers for your own AI agents.
- **What it is not:** it is not a substitute for a site's official API, and it does
  not grant access you do not already have. Use it only where you are permitted to
  automate.

## LLM mapping (tool naming)

`analyse --llm` uses a model to turn a site's captured actions into clean
`snake_case` tool names + descriptions. It is OpenAI-compatible, so any
OpenAI-style endpoint works — including **Google Gemini** via its OpenAI-compatible
API:

```bash
# Gemini (recommended): just set the key
export UI2API_LLM_PROVIDER=gemini
export UI2API_LLM_KEY=AIza...your-gemini-key
npx tsx src/cli.ts analyse https://app.example.com --llm

# Or any OpenAI-compatible endpoint explicitly:
export UI2API_LLM_BASE_URL=https://api.openai.com
export UI2API_LLM_KEY=sk-...
export UI2API_LLM_MODEL=gpt-4o-mini
```

Without these env vars, `analyse` still works fully offline using deterministic
heuristics (no LLM required).

## Using your real Chrome profile

> **This is the core of the product.** UI2API drives *your* Chrome with *your*
> data, so the site just sees a normal user — no bot fingerprint, no captcha
> wall. Read [`docs/VISION.md`](docs/VISION.md) before changing anything around
> the browser.

The vision requires the user to sign in to the site once in their own Chrome,
then UI2API acts inside that same session:

```bash
export UI2API_CHROME=1                        # use your installed Chrome
export UI2API_USER_DATA_DIR=/path/to/profile  # reuse your logged-in profile
npx tsx src/cli.ts analyse https://app.example.com --login   # sign in once (your Chrome)
npx tsx src/cli.ts generate app.example.com
npx tsx src/cli.ts serve app.example.com
```

- `UI2API_CHROME=1` → the system Chrome (`channel: "chrome"`).
- `UI2API_CHROME_PATH=/path/to/chrome` → a specific Chrome/Chromium binary.
- `UI2API_USER_DATA_DIR=/path` → reuse an existing profile (cookies + sign-in).
- `--login` now opens that same Chrome + profile headfully, so your login lives
  in your own data (fallback: a fresh Chromium window + cookie capture).

The bundled Chromium exists only as a zero-config fallback for demos/CI — never
present it as the product's mode of operation.

> Close your normal Chrome first, or copy the profile to another folder — two
> Chrome instances cannot share one profile directory at the same time. (For the
> strictest "this is literally my running browser" mode, the wigolo engine accepts
> `WIGOLO_CDP_URL` / `UI2API_CDP_URL` to attach to your live Chrome over CDP.)

## V1 gate — login made simple (end-user sessions)

> The v1 done-condition (verbatim: [`VERBATIM.md`](VERBATIM.md)). Login must not
> require scripts, cookies, or automation skills. Three mechanisms:

### 1. `xhost+` display-share capture — the most reliable way

On Linux the X display lock is released with `xhost +...`, so a browser running
as the **`ui2api` system user** appears on *your* screen and you log in **the
regular way** — typing and clicking normally. The only difference is the
command released the display lock, and the session data lands in the `ui2api`
user, **not** your own account.

```bash
# One command, one visible browser window, one normal login:
npx tsx src/cli.ts profile capture "https://gemini.google.com" --assist \
  [--identity me@example.com]      # optional identity label
```

- Data lands in `data/sessions/<host>/<slug>/state.json` **owned by the ui2api
  user** (`UI2API_USER`, default `ui2api`).
- `--xhost-all` uses the literal `xhost +` from the verbatim; the default is the
  scoped `xhost +SI:localuser:ui2api`.

### 2. Chrome-profile scanning — checkbox indexing

Chrome stores cookies/localStorage per site domain. ui2api scans the whole OS
for **any Chrome/Chromium profile** (all users), lists every site that has data
there, and lets you import the ones you want into the identity-keyed vault.
**One command imports them all** — no per-host loop:

```bash
# THE recommended first login: every known site session, read-back verified
npx tsx src/cli.ts profile add-all --known        # non-interactive bulk import
npx tsx src/cli.ts profile add-all --interactive  # checkbox-pick which hosts to import (the default; bare = same)
# --known and --interactive cannot be combined — the CLI refuses and names both.

# Or target one host explicitly:
npx tsx src/cli.ts profile scan      # every site in every Chrome profile on the OS
npx tsx src/cli.ts profile import gemini.google.com [--identity me@example.com]
npx tsx src/cli.ts profile list gemini.google.com   # accounts stored for the site
```

Every `add-all` row is read back from the vault and reported honestly —
`imported` / `decrypt-limited` / `skipped-no-auth` — never a blind "ok".

**Not sure the machine is ready?** One command, before any browser work:

```bash
npx tsx src/cli.ts requirements            # alias: doctor — per-package verdict
npx tsx src/cli.ts requirements gemini     # one site (exit nonzero on not-ready)
npx tsx src/cli.ts requirements --json     # machine-readable (same honest gate,
                                           #   same shape as GET /requirements);
                                           #   `requirements gemini --json` and
                                           #   `requirements --json gemini` scope
                                           #   identically; exit 0 = all pass in
                                           #   scope, exit 1 = named fail/not-ready
curl http://127.0.0.1:9797/requirements    # same report from a running promptd
```

JSON payload keys: `generatedAt`, `node`, `checks[]` (id/status/detail/reason),
`packages[]` (id/url/verdict/reason + `vault.{capturedAt,ageDays,stale}` where a
vault session exists), `summary {ready,working,on-hold,not-ready}`.

Every check runs for real (Chrome binary + version via the launchBrowser
ladder's execute-only probe, display/Xvfb, Playwright browser cache, the
`ui2api` OS user + copied-profile dir, per-host vault sessions, attach port,
env-knob conflicts) — verdicts are **ready / working / on-hold / not-ready**
with the named reason, and the checker never launches a browser.

### 3. Identity-keyed multi-account sessions

One user often has several accounts for one site (several Gemini accounts).
Sessions are stored keyed by **site + identity** (email, or whatever the site's
auth provides) — so you can use *any* account, aggregate them, and (future)
orchestrate across sites since everything is API:

```bash
# Drive a specific account:
npx tsx src/cli.ts prompt "hello" --site gemini --account me@example.com

# promptd: pick the account per request, and list what's stored:
curl -X POST http://127.0.0.1:9797/prompt -d '{"site":"gemini","account":"me@example.com","prompt":"hi"}'
curl http://127.0.0.1:9797/accounts?site=gemini
```

Fallback keeps working: without `--account`, the legacy single-session path is
used, so existing setups are unaffected. Each `GET /registry` package also
carries its stored `accounts[]` (`slug`, `identity`, `host`, `source`,
`capturedAt`), so an external consumer can discover every identity without any
site knowledge.

## Wigolo engine (`--engine wigolo`)

UI2API can offload its web intelligence — browser acquisition, anti-bot handling,
auth reuse, and structured extraction — to a local
[wigolo](https://github.com/KnockOutEZ/wigolo) daemon over loopback HTTP. This
keeps UI2API MIT and avoids any AGPL code import:

```bash
# Start a wigolo daemon in the background
npx -y wigolo serve &

# Analyze, generate, and serve through the daemon
npx tsx src/cli.ts analyse https://app.example.com
npx tsx src/cli.ts generate app.example.com
npx tsx src/cli.ts serve app.example.com --engine wigolo
```

The wigolo engine works for both `serve` and `hub run` (in-process generated
servers inherit the engine from the `UI2API_ENGINE` env var). The `native`
Playwright engine remains the default unless you pass `--engine wigolo` or set
`UI2API_ENGINE=wigolo`. See [`docs/ENGINE.md`](docs/ENGINE.md) for the full
design, env vars, and the MIT/AGPL license boundary.

## Responsibility

UI2API is an automation tool. You are responsible for how you use it. Only
automate sites you are authorized to use, respect each site's terms of service,
and comply with applicable law. Use it at your own risk.

## Contributing

UI2API is an open-source project. Anyone can add a site — the mechanism is an
**in-repo capability package** (`capabilities/<site-id>/` +
`src/capabilities/<site-id>.ts`), which keeps the work discoverable,
reviewable, and installed the same way as every built-in site.

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the complete "Add a site /
capability package" workflow — every step mapped to a real file in this repo
(analyze → package → runner → route → capture/lock → live-verify → registry →
docs) — plus the honesty red lines every contribution must pass.

- First PR? Start with the add-a-site pathway in `CONTRIBUTING.md` and the
  checklist in `.github/PULL_REQUEST_TEMPLATE.md`.
- The repo publishes `ui2api` to npm — the version shield at the top tracks the
  live package.
- Sponsor this work if you find it useful: see `.github/FUNDING.yml`.

## Docs & links

- Documentation: [`docs/`](docs/) — start with [`docs/VISION.md`](docs/VISION.md)
- Contributing & "Add a site / capability package": [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Attach / plan / login-bound capabilities unblocked: [`docs/UNLOCK.md`](docs/UNLOCK.md)
- Hard-won field notes: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — includes the
  `chrome-cdp.service` pkill loop that silently killed every CDP browser for days
- License: [MIT](LICENSE)

## Hub (hosted registry + plugin runtime)

UI2API can run as a small self-hosted **registry + runtime**: you publish generated
site packages, and the Hub serves them to your AI agents as managed MCP/ACP plugin
instances — no per-site server to babysit.

```bash
# Start the registry + operator UI on http://localhost:8787
UI2API_HUB_TOKEN=op-secret npx ui2api hub --port 8787

# In another terminal: build a site's package and publish it to your hub
UI2API_HUB_TOKEN=op-secret npx ui2api hub publish app.example.com

# ...optionally also push it to the public community mirror (ui2api-registry)
UI2API_HUB_TOKEN=op-secret npx ui2api hub publish app.example.com --mirror

# Serve a registered package as a live MCP plugin your agent can call
npx ui2api hub run app.example.com          # stdio MCP
npx ui2api hub run app.example.com --acp    # ACP JSON-RPC on :8788
```

- **Storage** is the filesystem (`data/registry.json` + `data/pkgs/<name>/<version>.json`) — backup = copy the folder. No database.
- **Publish** (`PUT /api/packages`) requires `UI2API_HUB_TOKEN` and runs the validator on every push; invalid packages are rejected.
- **Trust** — packages start `unreviewed`; the operator marks them `reviewed` from the UI or API. The Hub's resolve path proxies (read-only) the `ui2api-registry` mirror on a miss.
- **Plugins** are loaded through the allow-listed `Ui2ApiContext` — a plugin can only use the abilities the host grants (analyse, SSRF-guarded replay/fetch, page-scoped `call`, session, dom). It never receives `launchBrowser`, `generate`, or raw filesystem access.
- **Management UI** at `GET /` lists packages with trust badges, a publish form, and a review button.

Only publish and run sites you are authorized to automate. See [Responsibility](#responsibility).
