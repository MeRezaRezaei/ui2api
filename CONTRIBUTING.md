# Contributing to UI2API

Thanks for helping make UI2API better! This project turns any website into
MCP/ACP tools for AI agents.

## Setup

```bash
npm install
```

This project uses [Playwright](https://playwright.dev) to drive a headless
Chromium browser during analysis and tests. The CI installs the browser with:

```bash
npx playwright install --with-deps chromium
```

Run that locally if you hit "browser not found" errors.

## Verify your changes

```bash
npm run build      # type-check / compile with tsc
npm test           # end-to-end integration test (headless Chromium + fixture SPA)
npm run test:unit  # unit suites (also launch browsers / spawn servers)
```

Keep `npm test` green — it is the project's main acceptance gate.

## Project layout

- `src/analyzer` — site analysis (call interception, capture)
- `src/mapper` — action-map normalization + LLM mapper agent
- `src/generator` — MCP / ACP / skill output
- `src/runtime` — browser session lifecycle
- `test/` — integration + unit suites

## Conventions

- All browser launches must go through `launchBrowser()` in
  `src/runtime/browser.ts`. Do not call Playwright's `chromium.launch()`
  directly elsewhere.
- Generated per-site servers import the shared runtime via the absolute
  `SRC_DIR`, not relative paths from `sites/*/`.
- Keep `npm test` green before opening a PR.

## More info & conduct

See the [README](README.md) for the full architecture and quick start.
Please be respectful and constructive in discussions and reviews.
