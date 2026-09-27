# Execution engines

> Re-synced 2026-09-24 to the shipped model (fold #17–25). This file describes
> how ui2api actually executes work today. Architecture source of truth:
> [`AGENTS.md`](../AGENTS.md); session/browser posture: [`VISION.md`](VISION.md),
> [`STEALTH.md`](STEALTH.md).

## The two shipped execution models

Everything the product serves runs through one of these (see `AGENTS.md`):

| Model | Code | Execution path |
|---|---|---|
| **ChatDriver** | `src/prompt/driver.ts` + `src/profile/profile.ts` | declarative per-site profile (composer/send/answer selectors) → paste via trusted `keyboard.insertText`/`press` → read the streamed answer off the page until it stops growing. One driver, all sites. Wired to `POST /prompt` + `POST /v1/chat/completions` in `src/prompt/http.ts`. |
| **Capability runners** | `src/capabilities/<site>.ts` | per-site capability surface (chat, list_conversations, web_search, image_gen, …) exposed as `/capability/<site>`. Runner ↔ manifest sync enforced by `test/capability-dispatch.test.ts`. |

Both launch browsers exclusively through `launchBrowser()` in
`src/runtime/browser.ts` (attach / managed-spawn / Playwright-fallback order —
see `VISION.md`) and replay snapshot-injected vault sessions
(`data/sessions/<host>/<slug>/`, legacy flat snapshot fallback).

## The retained generated-server tier

The older analyse→generate pipeline is **still live** and supported, but it is
no longer the product's main story — it builds per-site MCP/ACP servers from a
recorded action map, whereas the ChatDriver/capability-runners path above was
built to supersede the "analyze every site" flow for chat and capability
surfaces.

| Command | Runtime path |
|---|---|
| `analyse` | `src/analyzer/explore.ts` — fetch the site, hook fetch/XHR/WS, record real calls into an action map (`--login` = interactive host login first; see `cli.ts` `cmdAnalyse`). |
| `generate` | `src/generator/generate.ts` — action map → generated MCP/ACP server under `sites/<host>/server/` (`--acp`, protocolVersion 2025-03-26). |
| `serve` | `src/hub/serve.ts` — run a generated server (stdlib or ACP); `--trust` gate for untrusted maps. |
| `remap` / `langgen` | re-analyse with a deprecation diff; PHP map generation. |
| `hub` / `hub run` / `hub publish` | local package hub + registered-plugin serving (`src/hub/*`, `src/registry/package.ts`). |

The `Runtime path` column names the **shipped source**, so it is always `.ts` —
the file you open is `src/generator/generate.ts`, not the build output
`dist/generator/generate.js`. That is not a slip: an `import … from "./x.js"`
specifier inside a code block is a *different* thing and stays `.js`, because
`tsconfig.json` sets `module`/`moduleResolution: NodeNext` and all 265 relative
imports in `src/` use the emitted extension. Prose cites `.ts`, import
specifiers `.js`; check with `ls` before "fixing" either one.

### The JS-function-indexed `call` mode (still live)

There are two honest ways to make a site's own JS do work, neither of which
synthesizes traffic:

1. **UI path** (mouse/keyboard): paste → Enter → read the streamed answer off
   the page event bus. This is the ChatDriver default, backed by
   `makeDomPrimitives` (`paste`, `press`, `capture`, `awaitAnswer`).
2. **Indexed-call path**: the analyzer captures real js-function entry points —
   `window.<root>.<method>(...args)` correlated with the network each call
   produced (`kind: "js-function"` / `"js-return"` / `"network"` captures keyed
   by callId, see `docs/AUDIT.md`). Instead of driving the DOM, the executor
   calls that SAME function with the SAME argument shape inside the live page,
   then correlates the produced fetch/XHR traffic with the result.

`src/runtime/js-exec.ts` implements the executor. Contract:

```ts
interface JsFunctionIndex {
  root: string;       // window.<root>
  method: string;
  params: string[];   // declared parameter order (analyzer parseParams)
  sampleArgs: unknown[]; // captured argument shape
}
interface JsCallResult {
  ok: boolean;
  value: unknown;
  error?: string;     // "not-a-function: <root>.<method>" when the index is stale
  networkHits: Array<{ url: string; method: string }>; // fetch/XHR the call fired
}

execJsFunction(getPage, index, { args?, reloadAfterSuccess?, reloadTimeoutMs? })
```

Verbatim rule for this mode: **"after each success action the only thing we
need to do is to refresh the page so anything the server knows about us will be
there again"** — pass `reloadAfterSuccess: true` and reload after every
successful indexed call (never after failure).

Access: the same `DomPrimitives` seam exposes it as
`jsCall(rootName, method, args?)`, so capability runners, generated servers
and the hub all get one implementation. `call` recipes always use the native
page (the wigolo daemon's tool surface has no arbitrary in-page JS execution —
see below).

## The serve-engine tier: `native` vs `wigolo` (secondary, still live)

For the generated-server tier only, the execution backend is pluggable; the
engine is selected per invocation with `--engine native|wigolo` or
`UI2API_ENGINE` (validated in `cli.ts` `validateEngine`).

| Engine | Flag / env | Who runs the browser | Auth reuse | Live JS (`call`) |
|---|---|---|---|---|
| `native` | (default) | in-process Playwright (`launchBrowser()`) | Chrome profile / vault snapshot | in-page `evaluate` |
| `wigolo` | `--engine wigolo`, `UI2API_ENGINE=wigolo` | local wigolo daemon (loopback HTTP) | Chrome profile/CDP | native fallback only |

**The ChatDriver and capability-runners never use the wigolo daemon** — they
drive the page directly through `launchBrowser()` and the `DomPrimitives`
trusted-input primitives. The wigolo engine is a retained option for
generated-server serving (and the `dom.*` recipe work in that tier).

### The wigolo engine

`serve` / `hub run ... --engine wigolo` executes recipe work through a local
**wigolo daemon** over loopback HTTP. UI2API never imports wigolo's code — MIT
stays MIT, and AGPL obligations stay with the daemon process you chose to run.

| Recipe work | Runtime path |
|---|---|
| `dom.click` / `dom.type` / `dom.waitFor` | wigolo `fetch` with browser actions → returns page markdown |
| `dom.extract` (selector text/json) | wigolo `extract` (selector mode) |
| `dom.extract` (attr / unsupported) | native page (attribute values aren't in markdown) |
| `dom.paste` / `dom.press` / `dom.capture` / `dom.status` | wigolo `fetch` actions `paste` / `keys` / `capture` / `status` — the JS-level primitives (drive the site's own JS via keyboard/paste events, read streamed chunks off the page event bus). Fall back to the same primitives on the native page when the daemon's browser tier is down |
| `replay` (captured network call) | plain `fetch` + saved session cookies, SSRF-guarded — **no browser at all** |
| `call` (`window.<root>.<method>`) | lazy native Playwright page (wigolo has no arbitrary in-page JS execution) |

#### Why this split

- wigolo's strength is **reading and interacting with the web** — tiered fetch
  routing, auth reuse, anti-bot challenge handling, structured extraction.
  That is exactly the `live-js`/`dom` recipe work, so it is delegated.
- wigolo has **no arbitrary in-page JS execution**, which is what a ui2api
  `call` recipe requires — so that path keeps a lazy native page, launched only
  when a genuine `call` recipe runs.

#### Graceful degradation

The daemon's browser tier may be unavailable in restricted environments
(sandboxed VMs, containers where Chromium refuses to launch).
Browser-required operations **try the daemon first**, and on a wigolo Chromium
failure fall back to the native page for that single operation, logged once —
never silent:

```
[wigolo-engine] wigolo browser tier down (wigolo fetch (HTTP 500):
  browserContext.newPage: Target page, context or browser has been closed);
  dom.click -> native browser
```

Reads (`dom.extract` selector, `replay`) never need a browser at all and always
run through the daemon.

#### Env vars

| Var | Default | Meaning |
|---|---|---|
| `UI2API_ENGINE` | `native` | `native` or `wigolo` (serving tier only) |
| `WIGOLO_BIN` | `wigolo` (npx) | Binary used to spawn the daemon (`... serve`) |
| `WIGOLO_DAEMON_URL` | `http://127.0.0.1:3333` | Existing daemon base URL (skip auto-start if healthy) |
| `WIGOLO_DAEMON_PORT` | `3333` | Port for an auto-started daemon |
| `WIGOLO_API_TOKEN` | `""` | Token for non-loopback daemon access |
| `UI2API_WIGOLO_AUTOSTART` | `1` | `0` = never spawn a daemon (use an existing one) |
| `UI2API_WIGOLO_USE_AUTH` | `1` | `0` = don't request auth cookies for the site |
| `UI2API_CHROME_PROFILE_PATH` / `UI2API_CDP_URL` / `UI2API_AUTH_STATE_PATH` | — | aliases forwarded to the daemon as `WIGOLO_CHROME_PROFILE_PATH` / `WIGOLO_CDP_URL` / `WIGOLO_AUTH_STATE_PATH`, so wigolo reuses the SAME user Chrome/profile as the native engine (see `docs/VISION.md`) |
| `WIGOLO_REPO` | (test only) | Path used by `test/wigolo-engine.test.ts` to spawn a daemon from source |

#### Start the daemon yourself

```bash
npx -y wigolo serve                # default http://127.0.0.1:3333 (loopback-open)
WIGOLO_DAEMON_PORT=4200 npx -y wigolo serve
```

With a daemon already running, UI2API skips auto-start:
`UI2API_WIGOLO_AUTOSTART=0 serve app.example.com --engine wigolo`.

## License boundary

UI2API is MIT. wigolo is AGPL-3.0. The integration is a **runtime split across
a process pipe**, not a source/derivative-work merge:

- UI2API talks to the daemon with a ~200-line zero-dependency HTTP client
  (`src/runtime/wigolo.ts`): `GET /health`, `POST /v1/fetch`, `POST /v1/extract`.
- No wigolo package is imported, bundled, or vendored; no wigolo code is copied.
- The daemon process runs whatever runtime it ships and is launched on the user's
  own machine as an external service.

If you prefer a single-process binary and the daemon is always available, the
`native` engine is the zero-extra-dependency default.

## Where the main path lives

For the shipped flagships (`prompt`, `promptd`, `/capability/<site>`), the
engine question never arises: **no daemon, no generated server** — the ChatDriver
and capability runners call `launchBrowser()` and replay the vault session
directly. The tiers above exist for the retained analyse/generate/serve/hub
pipeline and are kept in sync by the unit suite
(`test/wigolo-engine.test.ts`, `test/js-exec.test.ts`, `test/generate.test.ts`).