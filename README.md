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
- **LLM-assisted naming with offline fallback** — `--llm` uses a model to produce
  semantic tool names and task mappings; a deterministic heuristic fallback keeps
  the pipeline fully offline when no model is configured.
- **Trust gate** — generated maps are marked `trusted:false` and `serve` refuses
  to run an untrusted map without an explicit `--trust`, so generated tools are
  reviewed before they can act.

## Quick start

```bash
npm i -g ui2api

# 1. Analyze a site once
npx ui2api analyse https://app.example.com --llm

# 2. Generate a per-site MCP server
npx ui2api generate app.example.com

# 3. Serve it — your AI agent now calls the site as tools
npx ui2api serve app.example.com
```

Then connect any MCP/ACP client to the generated server and call tools like
`send_prompt`. Re-run `analyse`/`generate` when the site changes.

```bash
npm test   # runs the integration test against the fixture SPA
```

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
  a site's terms of service. It does not help you do anything you are not already
  permitted to do.

## Docs & links

- Documentation: [`docs/`](docs/)
- License: [MIT](LICENSE)
