# UI2API

> Turn any website into MCP/ACP tools for AI — no clicking, just real site functions.

**UI2API** analyzes a website once, captures its *real* action recipes (the
in-page JS functions and network calls the site actually uses), and generates a
per-site [MCP](https://modelcontextprotocol.io) / ACP server so an AI agent can
drive the site by calling tools like `send_prompt(text)` instead of
screen-reading and clicking buttons.

## Why

Today AI agents interact with websites the way humans do — navigate, locate a
control, click, read the screen. That is high-friction and brittle. A site's
real capabilities are a finite, structured set of actions. UI2API makes those
actions first-class tools. When a site changes, re-run the analyzer and the
tool surface regenerates.

## How it works

```
URL ──▶ analyze (headless browser + mapper agent + call interception)
        ──▶ raw captures ──▶ map (normalize into action entries)
        ──▶ action-map.json ──▶ generate ──▶ MCP server
        ──▶ serve (live browser session) ──▶ AI calls tools
```

- **analyze** loads the site in Chromium, hooks `fetch`/`XHR`/`WebSocket` and
  in-page function calls, and an LLM mapper agent performs representative tasks
  while the real calls are recorded.
- **map** diffs repeated captures to infer typed parameters and names each
  action.
- **generate** compiles the action map into one MCP tool per action.
- **serve** keeps a live, authenticated browser session so generated tools
  execute their recipe (Hybrid: live-JS delegation when state is needed,
  server-side request replay when a pure call suffices).

## Status

🧪 Design stage. See [`docs/superpowers/specs/2026-08-29-ui2api-design.md`](docs/superpowers/specs/2026-08-29-ui2api-design.md).
Implementation begins after the spec is reviewed.

## License

[MIT](LICENSE)
