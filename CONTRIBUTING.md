# Contributing to UI2API

Thanks for helping make UI2API better! This project turns any website into
MCP/ACP tools for AI agents — each site ships as a self-contained **capability
package** (`capabilities/<site-id>/`) plus a per-site **runner**
(`src/capabilities/<site-id>.ts`) exposed over `/capability/<site-id>`.

The complete, authoritative "how to add a site" checklist lives in
[`AGENTS.md`](AGENTS.md) (the *"When adding a site"* bullet). This file turns
that bullet into a copy-paste, end-to-end workflow, mapping **every** step to a
file that already exists in this repo so you can follow a real example the whole
way.

## Setup

```bash
npm install
```

This project uses [Playwright](https://playwright.dev) to drive a headless
Chromium browser during live verification and tests. The CI installs the browser
with:

```bash
npx playwright install --with-deps chromium
```

Run that locally if you hit "browser not found" errors. In a source clone every
`ui2api …` command below runs identically as `npx tsx src/cli.ts …`.

---

## Add a site / capability package (the whole pathway)

Worked against **`capabilities/duckduckgo/`** (a fully verified package) and
**`capabilities/gmail/`** (an honestly-blocked, auth-walled package) so every
prescribed artifact maps to a real file.

| Step | What you produce | Real example in this repo |
| --- | --- | --- |
| 1 | Analysis notes (static bundles + wire) | `capabilities/duckduckgo/CAPABILITIES.md`, `gmail/CAPABILITIES.md` |
| 2 | Package dir `capabilities/<site-id>/` | `capabilities/duckduckgo/` (all six files below) |
| 3 | Runner `src/capabilities/<site>.ts` | `src/capabilities/duckduckgo.ts`, `gmail.ts` |
| 4 | Route block in `src/prompt/http.ts` | the `/capability/duckduckgo` block |
| 5 | Built-in profile entry (chat sites only) | `src/profile/profile.ts` `BUILTIN_PROFILES` |
| 6 | Dispatch-suite entry | `test/capability-dispatch.test.ts` runner list |
| 7 | `session.lock.json` capture lock | `capabilities/duckduckgo/session.lock.json` |
| 8 | Live-verify proof | `metadata.json` `verified {since, evidence, via}` |
| 9 | Registry + docs rows | `capabilities/README.md` inventory, `README.md` site list |
| 10 | Green gates | CI (`npm test` + `npm run test:unit`) |

### 1. Analyze the site — statically first, never fake traffic

Fetch the site's HTML, extract the JS bundle URLs, download the bundles, and
scan them for RPC/API paths, in-page functions, and capability toggles. Record
exactly how you analyzed it in the manifest (`analysisMethod`):

- `capabilities/duckduckgo/manifest.json` →
  `"analysisMethod": "static curl + 3 JS bundles (~4.3MB) from duck.ai …; no browser launched"`.
- `capabilities/gmail/CAPABILITIES.md` → measured that `mail.google.com` is
  100% auth-walled (every path 302s to `accounts.google.com/ServiceLogin`), so
  zero selectors are statically observable — and says so honestly.

Rules:
- **No fabricated traffic.** Never synthesize requests or send fake inputs the
  site could treat as foreign. You read bundles and observe; you do not guess a
  "wire recipe" and hand it to a browser to replay.
- Measurement beats assumption. If a page is auth-walled, prove the wall (as
  gmail did) rather than fabricating selectors.
- Only when you need the real in-page behavior do you run a browser you
  control: `npx tsx src/cli.ts analyse https://<site> [--login]` records real
  calls while representative tasks run (`--llm` names actions semantically;
  fully offline without it).
- One-off probe scripts live in `/tmp` and are **deleted after use** — never
  committed.

### 2. Author the package `capabilities/<site-id>/`

A compliant package has six files (shape is enforced by
`test/validate-packages.test.ts`):

- **`manifest.json`** — `id`, `name`, `url`, `siteVersion` (+ bundle hash), each
  capability in `capabilities[]` (`{id, name, description, method,
  implementation, recipe}` → `recipes/<id>.json`), plus `transport`/`auth`/
  `models` when the wire maps. Copy the shape:
  `capabilities/duckduckgo/manifest.json`. Note: duckduckgo's package also
  carries `metadata.json` — see below.
- **`profile.json`** — a `ChatSiteProfile` (composer/send/answer/newChat/
  dismiss selector arrays, `captureMs`/`stableMs`, `loginRequired`). Every
  package ships one — capability-only sites too (the daemon falls back to
  `capabilities/<id>/profile.json` for `/capability/<site>`). Example:
  `capabilities/duckduckgo/profile.json`.
- **`recipes/<capability>.json`** — one per capability: open / new-chat / type /
  send / read steps for the UI path, plus the observed `rpc`/`stealth` notes.
  Example: `capabilities/duckduckgo/recipes/duckduckgo_chat.json`. A capability
  whose recipe file name diverges must set an explicit `recipe:` field in the
  manifest (see the mapping rule documented in
  `test/validate-packages.test.ts`).
- **`session.lock.json`** — `site`, `locked`, `status`, `requiredSession`
  (host/api endpoints/`captureCommand`/targetDir), `capturedAt`, `snapshotHash`.
  Anonymous sites lock with a `null` snapshot
  (`capabilities/duckduckgo/session.lock.json`); auth-bound sites record the
  capture precisely (step 7).
- **`metadata.json`** — registry-level record: `siteId`, `site`, `name`, `url`,
  `siteVersion`, `version`, `status`, `verified {since, evidence, via}`, plus
  `author`/`authorizedUse`/`license`/`ui2api`/`trust`/`publishedAt`. **`verified`
  stays absent/false until a live round-trip** (`capabilities/duckduckgo/
  metadata.json` has a `verified` block; `capabilities/gmail/metadata.json`
  does not).
- **`CAPABILITIES.md`** — the human deliverable of the analysis: status header,
  per-capability wire facts, measured blockers, proof lines.

Validate the package shape with:
```bash
npx tsx scripts/validate-registry.mjs   # (mirror-shaped validator, hub path)
npm run test:unit                       # includes test/validate-packages.test.ts
```

### 3. Write the runner `src/capabilities/<site>.ts`

A class `<Site>Capabilities` whose `run(capability, args)` dispatches on the
manifest capability ids and returns `{ok, data|error}`. Conventions that are
enforced by review and by `test/capability-dispatch.test.ts`:

- **Browser only through `launchBrowser()`** in `src/runtime/browser.ts` — never
  call Playwright's `chromium.launch()` directly elsewhere (this is the single
  seam for headless/headed/chrome/attach resolution + stealth posture).
- The dispatch `switch` has a **default branch that returns
  `{ok:false, error:"unknown <id> capability: …"}` BEFORE any browser work**. An
  unknown capability must never open a page (proven for 14 runners by the
  timing-guard test in `test/capability-dispatch.test.ts`).
- Drive **real UI paths**: trusted input + the site's own send handler (see
  `src/capabilities/duckduckgo.ts` for a fully verified runner).
- **Login-bound capabilities return `ok:false loginGated:true` without opening a
  browser and without fabricating a result** (precedent: the `adapta`/`blackbox`
  no-session runners, or `src/capabilities/gmail.ts` which detects the auth-wall
  redirect and reports the measured two-step unblock instead of inventing a
  read).

### 4. Wire `/capability/<site>` in `src/prompt/http.ts`

Add a `POST /capability/<site>` block identical in shape to the existing ones
(e.g. the `/capability/duckduckgo` block):

1. read `capability` (400 when missing) and forward the optional `account`;
2. resolve the profile — `idFrom("<site>", profilesById)` with a fallback to
   `resolvePackagedProfile("<site>") ?? resolveProfile("capabilities/<site>/profile.json")`;
3. `resolveCapabilityAccount(...)` validates the identity from the vault before
   any browser work;
4. `pool.sharedBrowser()`, instantiate your runner, `caps.run(capability, args)`,
   reply `result.ok ? 200 : 502`, and `caps.close()` in `finally`.

The pre-dispatch guard at the top of the request handler already rejects
capabilities the installed package's manifest does not declare (400 listing the
available set), so your block never sees an unknown capability for an installed
package.

### 5. Built-in chat profile (only if the site is chat-capable)

If the site is a prompt-and-read chat site, add an entry to
`BUILTIN_PROFILES` in `src/profile/profile.ts` so `ui2api prompt` /
`/prompt` / `GET /sites` can drive it (examples: `kimi`, `deepseek`).
**Capability-only sites skip this** — `youtube`, `araprat`, `gmail` are NOT
built-in chat profiles; their packaged `profile.json` is enough because the
`/capability/<site>` resolvers fall back to `capabilities/<id>/profile.json`
automatically (see `src/profile/profile.ts` `resolvePackagedProfile`).

### 6. Register the runner in the dispatch suite

Add your runner to the `RUNNERS` array in `test/capability-dispatch.test.ts`
(`id`/profile path/manifest path/source path/`make`). The suite keeps the
manifest capability set and the runner's dispatch `case` labels in sync and
proves unknown capabilities never touch a browser.

### 7. Capture + lock the session (`session.lock.json`)

- **Anonymous site** (duckduckgo) — no capture; lock with a `null` snapshot.
- **Portable auth** — sign in yourself in a real visible browser, then one of:
  ```bash
  npx tsx src/cli.ts profile add-all --known        # bulk import every OS-Chrome site session
  npx tsx src/cli.ts profile capture "https://<site>" --login   # one host, one normal login
  npx tsx src/cli.ts profile ingest <host>          # offline read of a live Chrome profile
  ```
  Lock the package: `session.lock.json` → `locked:true`, fill `capturedAt` +
  `snapshotHash` (sessions live in `data/sessions/<host>/<slug>/state.json` —
  **never commit `data/`**).
- **Google-class blocker (honest, not a dead-end)** — Google auth cookies are
  app-bound (Chrome's "portal" os_crypt v20): a replayed capture renders
  anonymous on `mail.google.com` / `www.google.com` / `youtube.com` /
  `gemini.google.com` (measured — see `docs/UNLOCK.md`). For these sites the
  primary seam is the user's own real Chrome attached over CDP:
  ```bash
  google-chrome --remote-debugging-port=9222
  UI2API_ATTACH_PORT=9222 npx tsx src/cli.ts promptd
  ```
  Document that two-step in `docs/UNLOCK.md` (same format as the gmail /
  google-ai-search / youtube / gemini rows) and link it from your
  `capabilities/<site-id>/CAPABILITIES.md`. **Never promise a captured replay
  that renders anonymous.**

### 8. Live-verify (+ proof id), then flip `metadata.json` verified

A capability is "verified" **only after a real round-trip answers `ok:true`
with a DOM read-back you can quote** — run it headed
(`UI2API_HEADED=1`, or Xvfb for headless CI — see `docs/TROUBLESHOOTING.md`),
or against an attached real Chrome. Record the proof (`ok:true` + the read-back
rows + a PROOF PASS id/date) in `CAPABILITIES.md` and set `metadata.json` →
`verified: {since, evidence, via, scope}`. An `ok:false` carrying the site's own
wall/limit text is honest evidence of *blocked* — still the correct thing to
merge, but keep `verified` absent.

**V1 honesty red line — never claim verified without the live round-trip.**

### 9. Registry + docs

`GET /registry` (`src/prompt/registry.ts`) is built **only** from the installed
packages under `capabilities/<id>/` — nothing else appears. So once your
package directory is complete the daemon serves it (capability reflection at
`GET /capabilities/<site>`, tools at `/registry`, dispatch at
`POST /capability/<site>`). Then update the human inventory:

- `capabilities/README.md` — add your site's row (status column: verified
  dates/proofs, or the honest blocker).
- `README.md` — add the site to the available-sites list (see the Verified /
  Scaffold sections).
- `AGENTS.md` — keep the "When adding a site" bullet in sync with the newly
  shipped reality (that bullet is the source of truth for future contributors).

### 10. Gates + submit

```bash
npx tsc --noEmit   # type-check
npm run build      # compile with tsc
npm run test:unit  # unit suites incl. validate-packages + capability-dispatch
npm test           # end-to-end integration (needs the chromium browser)
```

Keep all of them green, then open a PR using the checklist in
[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md).

---

## Honesty red lines

These are project-wide, non-negotiable, and every PR is reviewed against them:

- **Never claim a capability verified without a live `ok:true` round-trip + a
  real DOM read-back.** "Should work" and "wire-mapped" are honest statuses —
  write them as such.
- **No fabricated traffic.** Drive the site through its own UI/JS; never
  synthesize requests or send inputs the site could see as foreign.
- **Login-gated capabilities are gated honestly** — `ok:false loginGated:true`,
  no browser, no invented result.
- **One-off probe scripts go in `/tmp` and are deleted after use.** Never
  commit them.
- **Never commit `data/`** (session snapshots are real credentials), rendered
  `sites/*/server/`, or `.agents/`/`.opencode/`.

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
- `src/prompt` — ChatDriver + daemon + HTTP surface (`http.ts` = `/prompt`,
  `/capability/*`, `/registry`, `/v1/*`)
- `src/capabilities` — per-site capability runners
- `src/runtime` — browser lifecycle (incl. `launchBrowser()`), session store
- `capabilities/<id>/` — per-site packages (manifest/profile/recipes/
  session.lock/CAPABILITIES.md/metadata.json)
- `test/` — integration + unit suites (`capability-dispatch`,
  `validate-packages`)

## Conventions

- All browser launches must go through `launchBrowser()` in
  `src/runtime/browser.ts`. Do not call Playwright's `chromium.launch()`
  directly elsewhere.
- Generated per-site servers import the shared runtime via the absolute
  `SRC_DIR`, not relative paths from `sites/*/`.
- Keep `npm test` green before opening a PR.
- Selector rot: re-tune via a JSON profile override (`--profile FILE`), not by
  editing one-off probe scripts.

## More info & conduct

See the [README](README.md) for the full architecture and quick start, and
[`AGENTS.md`](AGENTS.md) for the authoritative conventions and the
"When adding a site" bullet. Please be respectful and constructive in
discussions and reviews.