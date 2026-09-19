# UI2API

[![CI](https://github.com/MeRezaRezaei/ui2api/actions/workflows/ci.yml/badge.svg)](https://github.com/MeRezaRezaei/ui2api/actions/workflows/ci.yml)
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
  checkbox-style site import, and an identity-keyed multi-account session vault.
  See [V1 gate](#v1-gate--login-made-simple-end-user-sessions).
- **Capability reflection** — learn what a specific account can actually do on a
  chat site (plan tier, available models, restriction walls) from what the site
  itself shows: `ui2api profile capabilities <host> [--account email]` probes the
  live session and stores a fingerprint per account; the daemon serves it at
  `GET /capabilities?site=X&account=Y`; prompts report in-band restrictions
  (`doneReason:"restricted"` + `restrictions[]`) and `--model NAME` selects a
  model or fails explicitly when the account lacks it.
- **LLM-assisted naming with offline fallback** — `--llm` uses a model to produce
  semantic tool names and task mappings; a deterministic heuristic fallback keeps
  the pipeline fully offline when no model is configured.
- **Trust gate** — generated maps are marked `trusted:false` and `serve` refuses
  to run an untrusted map without an explicit `--trust`, so generated tools are
  reviewed before they can act.

## Quick start

> **ui2api is not published to npm yet** — install from source until the first
> release lands:

```bash
git clone https://github.com/MeRezaRezaei/ui2api.git
cd ui2api
npm install
npx playwright install chromium   # one-time browser download
```

The CLI runs via `tsx` (no global install needed):

```bash
# 1. Analyze a site once  (drop --llm to run fully offline)
npx tsx src/cli.ts analyse https://app.example.com --llm

# 2. Generate a per-site MCP server
npx tsx src/cli.ts generate app.example.com

# 3. Serve it — your AI agent now calls the site as tools
npx tsx src/cli.ts serve app.example.com
```

Then connect any MCP/ACP client to the generated server and call tools like
`send_prompt`. Re-run `analyse`/`generate` when the site changes.

**Validate your install without owning a site** — these run against a local
fixture and print `INTEGRATION OK` / `X tests … pass`:

```bash
npm run test:unit   # 30 hermetic unit-test files (340+ tests) — no browser needed
npm test            # full integration test (needs the chromium browser above)
```

## MVP — use AI sites for doing prompts

The fastest path to a working prompt engine needs no API keys, no login, and no
servers to babysit: **ui2api drives an AI chat website (ChatGPT-style UI) the way
you would** — paste the prompt into the composer, hit Enter, and read the streamed
answer off the page. All in your own browser session.

```bash
# One command: prompt Microsoft Copilot anonymously (no sign-in needed)
npx tsx src/cli.ts prompt "summarize the last three books you know"

# Pick the site explicitly, or reuse your logged-in Chrome for sites that need it
npx tsx src/cli.ts prompt "hello" --site gemini            # needs a sign-in session
npx tsx src/cli.ts prompt --sites                          # list the available sites

# Or expose it as a localhost JSON service so live apps (e.g. anything in /var/www)
# can call it WITHOUT touching them:
UI2API_PROMPTD_TOKEN=op-secret npx tsx src/cli.ts promptd   # http://127.0.0.1:9797
curl -X POST http://127.0.0.1:9797/prompt -H 'authorization: Bearer op-secret' \
  -H 'content-type: application/json' \
  -d '{"site":"copilot","prompt":"what is 2+2?"}'
```

### promptd is a stand-by daemon (warm page pool)

`promptd` is a daemon that keeps `N` pages of the same site standing by, ready for
parallel requests — exactly like the request queue + a browser. Semantics:

- **`--pool-min N`** (or `UI2API_POOL_MIN`): warm at least `N` idle pages for the
  default site before serving (default `1`). More sites warm lazily on first request.
- **`--pool-max N`** (or `UI2API_POOL_MAX`): hard ceiling on per-site pages. Auto =
  `max(1, min(4, floor(freeGB/2)))`.
- A busy page is returned to the pool when the request finishes; pages whose
  underlying browser died are discarded and respawned on demand — the *daemon*
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
`copilot` (anonymous), `perplexity` (anonymous Ask), `huggingchat`, plus
session-locked packages `deepseek` (chat.deepseek.com), `kimi` (www.kimi.ai)
and `tencent-aistudio` (aistudio.tencent.ai — headed/real-profile only).
All three session-locked sites are **live-verified end-to-end** (2026-09-19,
see `capabilities/README.md`): deepseek = chat + real DeepThink/Search toggles +
conversation list; kimi = chat + conversation list + model picker + web-search
toolkit + file upload; tencent-aistudio = chat (EdgeOne-headed only) + full wire
map. Each exposes a `/capability/<site>` surface plus the shared `POST /prompt`.
Sending is always the site's **own JS**: paste event + Enter — no synthetic
mouse clicks; the answer is read from the page's event bus until it stops
growing. (`npx tsx src/cli.ts prompt --sites` lists what's available; the full
inventory of analyzed sites lives in `capabilities/README.md`.)

- **Just works on its own**: zero-config browser (bundled Chromium, auto-fallbacks
  to system Chrome), no external LLM API, no logins for the anonymous sites.
- **`--login` / real Chrome profile** for signed-in sites: the session is yours, so
  no captcha walls (see [Using your real Chrome profile](#using-your-real-chrome-profile)).
- **Red-line safe**: `promptd` binds `127.0.0.1` only, serves only the profiles you
  configure (never arbitrary URLs), optionally bearer-token gated, and never touches
  `/var/www`. Apps there just `POST` in and read the answer out.
- **Tuning a site**: profiles live in `src/profile/profile.ts`; ship a JSON override
  with `--profile /path/gemini.json` (or `UI2API_AI_SITE`) if a site's UI changed.

Wire it into an agent the same way as any generated server:
`npx tsx src/cli.ts plugin serve src/plugins/ai-web.ts --base-url https://gemini.google.com` exposes `send_prompt`, `new_chat`, `read_last_response` and `ai_status` over MCP.

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
there, and lets you import the ones you want into the identity-keyed vault:

```bash
npx tsx src/cli.ts profile scan      # every site in every Chrome profile on the OS
npx tsx src/cli.ts profile import gemini.google.com [--identity me@example.com]
npx tsx src/cli.ts profile list gemini.google.com   # accounts stored for the site
```

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
used, so existing setups are unaffected.

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

## Docs & links

- Documentation: [`docs/`](docs/) — start with [`docs/VISION.md`](docs/VISION.md)
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
