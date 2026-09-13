# Execution engines

UI2API generates per-site tool servers whose *execution backend* is pluggable.
Two engines are currently supported, selected per-invocation.

| Engine    | Flag / env                   | Who runs the browser | Auth reuse | Anti-bot | Live JS (`call`) |
|-----------|------------------------------|----------------------|------------|----------|------------------|
| `native`  | (default)                    | in-process Playwright | Chrome profile | —        | in-page `evaluate` |
| `wigolo`  | `--engine wigolo`, `UI2API_ENGINE=wigolo` | local wigolo daemon (loopback) | Chrome profile/CDP | baked-in | native fallback |

## The wigolo engine

`serve`/`hub run ... --engine wigolo` (or `UI2API_ENGINE=wigolo`) executes recipe
work through a local **wigolo daemon** over loopback HTTP. UI2API never imports
wigolo's code — MIT stays MIT, and AGPL obligations stay with the daemon process
you chose to run.

What maps where:

| Recipe work                       | Runtime path                                              |
|-----------------------------------|-----------------------------------------------------------|
| `dom.click` / `dom.type` / `dom.waitFor` | wigolo `fetch` with browser actions → returns page markdown |
| `dom.extract` (selector text/json) | wigolo `extract` (selector mode)                          |
| `dom.extract` (attr / unsupported) | native page (attribute values aren't in markdown)         |
| `dom.paste` / `dom.press` / `dom.capture` / `dom.status` | wigolo `fetch` actions `paste` / `keys` / `capture` / `status` — the **JS-level primitives** (drive the site's own JS via keyboard/paste events, read streamed chunks off the page event bus). Fall back to the same primitives on the native page when the daemon's browser tier is down |
| `replay` (captured network call)  | plain Node `fetch` + saved session cookies, SSRF-guarded — **no browser at all** |
| `call` (`window.<root>.<method>`) | lazy native Playwright page (wigolo has no arbitrary in-page JS execution) |

### Why this split

- wigolo's strength is **reading and interacting with the web** — tiered fetch
  routing, auth reuse, anti-bot challenge handling, and structured extraction.
  That is exactly the work a `live-js`/`dom` tool recipe performs, so it is
  delegated.
- wigolo has **no arbitrary in-page JS execution** on its tool surface, which is
  what a ui2api `call` recipe (live `window.<root>.<method>`) requires — so that
  path keeps a lazy native page. It only ever launches when a genuine
  `call` recipe runs.

### Graceful degradation

The daemon's browser tier is a heavyweight engine that may be unavailable in
restricted environments (sandboxed VMs, containers where Chromium refuses to
launch). Browser-required operations **try the daemon first**, and on a wigolo
Chromium failure fall back to the native page for that single operation, logged
once — never silent:

```
[wigolo-engine] wigolo browser tier down (wigolo fetch (HTTP 500):
  browserContext.newPage: Target page, context or browser has been closed);
  dom.click -> native browser
```

Reads (`dom.extract` selector, `replay`) never need a browser at all and always
run through the daemon.

### Env vars

| Var                          | Default          | Meaning                                             |
|------------------------------|------------------|-----------------------------------------------------|
| `UI2API_ENGINE`              | `native`         | `native` or `wigolo`                                |
| `WIGOLO_BIN`                 | `wigolo` (npx)   | Binary used to spawn the daemon (`... serve`)       |
| `WIGOLO_DAEMON_URL`          | `http://127.0.0.1:3333` | Existing daemon base URL (skip auto-start if healthy) |
| `WIGOLO_DAEMON_PORT`         | `3333`           | Port for an auto-started daemon                     |
| `WIGOLO_API_TOKEN`           | `""`             | Token for non-loopback daemon access                |
| `UI2API_WIGOLO_AUTOSTART`    | `1`              | `0` = never spawn a daemon (use an existing one)    |
| `UI2API_WIGOLO_USE_AUTH`     | `1`              | `0` = don't request auth cookies for the site       |
| `UI2API_CHROME_PROFILE_PATH` / `UI2API_CDP_URL` / `UI2API_AUTH_STATE_PATH` | — | aliases forwarded to the daemon as `WIGOLO_CHROME_PROFILE_PATH` / `WIGOLO_CDP_URL` / `WIGOLO_AUTH_STATE_PATH`, so wigolo reuses the SAME user Chrome/profile as the native engine (see `docs/VISION.md`) |
| `WIGOLO_REPO`                | (test only)      | Path used by `test/wigolo-engine.test.ts` to spawn a daemon from source |

### Start the daemon yourself

```bash
npx -y wigolo serve                # default http://127.0.0.1:3333 (loopback-open)
WIGOLO_DAEMON_PORT=4200 npx -y wigolo serve
```

With a daemon already running, UI2API skips auto-start:
`UI2API_WIGOLO_AUTOSTART=0 serve app.example.com --engine wigolo`.

## License boundary

UI2API is MIT. wigolo is AGPL-3.0. The integration is a **runtime split across a
process pipe**, not a source/derivative-work merge:

- UI2API talks to the daemon with a ~200-line zero-dependency HTTP client
  (`src/runtime/wigolo.ts`): `GET /health`, `POST /v1/fetch`, `POST /v1/extract`.
- No wigolo package is imported, bundled, or vendored; no wigolo code is copied.
- The daemon process runs whatever runtime it ships and is launched on the user's
  own machine as an external service.

If you prefer a single-process binary and the daemon is always available, the
`native` engine is the zero-extra-dependency default.