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
audit + posture), `docs/AUDIT.md`, `docs/TROUBLESHOOTING.md`.

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
   streamed answer until it stops growing. One driver, all sites.
2. **Capability runners** (`src/capabilities/*.ts`) — per-site capability
   surface (chat, list_conversations, web_search, image_gen, …) exposed as
   `/capability/<site>` endpoints, wired in `src/prompt/http.ts`, and kept
   in-sync with each site's manifest by `test/capability-dispatch.test.ts`.

Both use **snapshot-injected sessions**: capture once
(`ui2api profile capture <url> --login` or `profile ingest <host>` for offline
read of a live Chrome profile), lock it in the package
(`capabilities/<site>/session.lock.json`), and replay cookies + localStorage
into fresh browser contexts at runtime.

## Commands

```bash
npm run build              # tsc -p tsconfig.json
npx tsx src/cli.ts prompt "hello" --site gemini      # one-shot prompt via ChatDriver
npx tsx src/cli.ts prompt --sites                    # list available sites (--site X)
npx tsx src/cli.ts promptd                           # daemon: POST /prompt, /status, /sites
npx tsx src/cli.ts analyse <url> [--login] [--llm]   # recorder + action map
npx tsx src/cli.ts profile scan|import|capture|ingest|list  # session management
npx tsx src/cli.ts package | install | plugin serve  # package + hub workflows
npx tsx src/cli.ts hub | serve | remap | generate    # server generation pipeline
npm test                  # integration (test/integration.ts)
npm run test:unit         # full unit suite incl. validate-packages + capability-dispatch
```

Serving: `src/prompt/http.ts` exposes `POST /prompt` (`{"site","prompt"}`),
`GET /sites`, `GET /capabilities/<site>`, `POST /capability/<site>`,
`GET /status`, `GET /health`. Binds `127.0.0.1` only, configurable bearer-token
gate (`UI2API_PROMPTD_TOKEN`).

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

- **Builtin profiles** (`src/profile/profile.ts`): gemini, chatgpt, claude,
  copilot, perplexity, huggingchat, deepseek, kimi, tencent-aistudio, + more.
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
  History drawer renders NO anchor list → conversation CRUD stays honest
  ok:false; remaining capabilities wire-mapped, DOM-unverified (never claim
  verified without a live round-trip).
- **Walled / scaffold / dead-end** inventory lives in `capabilities/README.md`
  (poe, grok, perplexity, t3chat, blackbox, adapta, zenmux, …). Be honest about
  status: never claim a capability is verified without a live round-trip.

## Conventions & red lines

- **Never commit `data/`**, `.agents/`, `.opencode/`, `sites/*/server/` (see
  `.gitignore`). Session snapshots contain real credentials.
- **Origin pinning / SSRF guards** live in `src/runtime/ssrf.ts` — endpoints
  only serve configured sites, never arbitrary URLs.
- **Trust gate** (`src/prompt/http.ts`, trust.ts): daemon answers only the
  profiles you configure, bearer-token gated by default posture.
- **Verification before claiming done**: `npx tsc --noEmit`, `npm run build`,
  `npm test`, `npm run test:unit`. Package + runner sync is enforced by
  `test/capability-dispatch.test.ts` (18/18) and package shape by
  `test/validate-packages.test.ts` (211/211).
- **Selector rot**: site UIs change. Re-tune via JSON profile override
  (`--profile FILE`), not by editing one-off probe scripts; keep probe scripts
  out of the repo (delete after use).
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