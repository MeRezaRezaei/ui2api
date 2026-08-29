# UI2API — Security & Code Audit

**Scope:** whole branch at `main` (post M1–M8).  
**Method:** independent code review + targeted security fixes + full test suite.  
**Verdict: GO** (all must-fix items from the pre-audit review are resolved).

## Build & test status
- `npm run build` (`tsc`): clean.
- `npm test` (integration, end-to-end on a fixture site): **INTEGRATION OK**.
- `npm run test:unit` (node --test): **6/6 pass** — agent, session, acp, security.
- `test/generate.test.ts`, `test/llm.test.ts`, `test/trust.test.ts`: pass.

## Findings and resolutions

### 1. SSRF via replay (HIGH — FIXED)
Replay issued `page.request.fetch(net.url)` with the URL used verbatim. A crafted or
compromised action-map could point the browser at localhost / internal services,
carrying the page's session cookies.
- **Fix:** `BrowserSession.executeRecipe` now rejects any replay target that is not
  same-origin with `map.url` (`sameOrigin()` guard). `schema.ts` also rejects
  `recipe.network.url` unless it is `http(s)://` or a same-site path.

### 2. Path traversal in session cookies (MEDIUM — FIXED)
`sessionPath` built a path from the untrusted `map.host`, and `loadSession` used a
hardcoded `../../sites/<host>` path relative to the module (fragile + traversal-prone).
- **Fix:** `sanitizeHost()` strips everything but hostname characters; used in
  `sessionPath`. `schema.ts` rejects a non-hostname `host`. `loadSession` now uses
  `sessionPath(outDir, host)`. The generated MCP/ACP servers bake `SITES_ROOT`
  (`outDir`) so serve reads cookies from the same directory analyse wrote them to.

### 3. Broken DOM-action execution (MEDIUM — FIXED)
DOM-discovered actions were emitted as `js-function` recipes whose `target` was a CSS
selector; `executeRecipe` then did `window["#searchBtn"]` → always threw. Such tools
were non-functional.
- **Fix:** `buildActionMap` emits `recipe.kind: "dom-interaction"` for DOM actions.
  `executeRecipe` re-drives the live page by selector (Playwright `locator.click`,
  with a synthetic-event fallback). Network-bearing DOM actions remain `replay`.

### 4. Minor hardening
- `executeRecipe` now recovers from a browser that dies between `start()` and a call
  (re-`start()` if `!browser.isConnected()`).
- `schema.ts` requires `map.url` to be `http(s)`.

## Still correct by design (no change needed)
- No `eval` / `Function(...)` anywhere; DOM reads use a constrained `querySelector`
  extractor. (Verified by grep.)
- Only `child_process` use is the intentional skill-wrapper `spawn` of the generated server.
- All browser launches use `launchBrowser()` (`src/runtime/browser.ts`); the only
  `headless:false` call is the documented `--login` interactive flow.
- Trust gate intact: `serve` refuses untrusted maps without `--trust`; generated maps
  are written `trusted:false`.

## Residual / out-of-scope (cannot be fixed in code alone)
- **Novelty:** adjacent tools exist (browser-use, Playwright MCP, Skyvern, AgentQL).
  thought of this".
- **Real-site validation:** tested on a fixture SPA only; arbitrary complex/cookie-auth
  sites are unproven. `analyse --login` exists for gated sites but needs manual runs.
- **Live LLM task-driving:** architecture + `--llm` hook present, but the LLM naming/
  task loop needs a real `UI2API_LLM_*` key to exercise (heuristic fallback verified).
- `package.json` `repository.url` still has placeholder `YOURGITHUB` — replace before publish.
