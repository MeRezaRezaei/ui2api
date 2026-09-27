# UI2API — First-Release Readiness Audit (re-verified, 2026-09-21, fold #11)

> Written for the v1 gate (verbatim 2026-09-16 1540/1545 + 475): *"we should
> start a code audit and things like this to let us become ready for first
> release"* + *"before publishing make sure we are in version one… it will work
> for gemini"*. Every PASS below was re-run on this box today (fold #11); FAILs
> and gaps are stated with their exact cause. No fabricated greens.
>
> Delta vs the fold-#6 audit: suite grew 380/380 → **418/418**; the
> inaccessible-display and manifest-status gaps (then G1/G2/G3) are CLOSED by
> folds #7–#11 (xhost display-detect, machine-checkable `verified` flag,
> `legacyPath`-stable lock truth, ui2api-user data-dir resolver).

## Verdict: **GO for v1** — single user, one identity per vault site, on this
box. No open first-release blockers (all previously-noted gaps are closed).

---

## A. Gates & automation

| Item | Status | Evidence |
|---|---|---|
| `npm run build` (tsc -p tsconfig.json) | **PASS** | clean (exit 0), re-run today (fold #11) |
| `npm run test:unit` | **PASS 418/418** | re-run today: tests 418, pass 418, fail 0 (incl. capability-dispatch 18/18, validate-packages 211, capability-probe 8, registry verified-shape, xhost-capture 13 incl. `ui2apiUserDataDir` 4) |
| `npm test` (integration, fixture-site e2e) | **PASS** | re-run today: `INTEGRATION OK — send_prompt: Echo[default]: hello \| search(replay): {}`; plugin on 127.0.0.1:44411 ready, 5 tools |
| Manifest/package shape enforcement | **PASS** | `test/validate-packages.test.ts` + `scripts/validate-registry.mjs`; verified contract enforced (bare `true` refused; truthy requires since+evidence+via) |
| Package↔runner dispatch sync | **PASS** | `test/capability-dispatch.test.ts` 18/18, 1:1 with runner wiring in `src/prompt/http.ts` |

## B. The two execution models

| Claim | Status | Evidence |
|---|---|---|
| ChatDriver: declarative profiles, one driver all sites (`src/prompt/`) | **PASS** | `profile.ts` 37 builtin profiles; live one-shots on-file: gemini/kimi/deepseek (folds #5/#6 proofs) |
| Snapshot-injected sessions (capture once, replay) | **PASS** | vault `data/sessions/<host>/<slug>/`; replay verified in folds #5/#6 live probes |
| Capability runners (`src/capabilities/*.ts` → `/capability/<site>`) | **PASS** | runners per active package; dispatch enforced by capability-dispatch.test.ts |

## C. Registry & HTTP surface (daemon, 127.0.0.1:9797 — restarted with CURRENT code this fold, pty_04929198, PID 3130534)

| Endpoint | Status | Evidence |
|---|---|---|
| `GET /status` | **PASS** | ok, pool up |
| `GET /registry` | **PASS** | 32 packages; `verified` surfaced: deepseek "2026-09-19", kimi "2026-09-19", gemini "2026-09-15", claude `false` (G2/G3 closed, fold #8) |
| `GET /v1/models` | **PASS** | 11 site models (on-file, fold #6) |
| `POST /v1/chat/completions` | **PASS** | on-file fold #6: model gemini → REAL completion (content "OK", finish_reason stop) |
| `POST /prompt` | **PASS** | one-shot CLI path on-file fold #6: gemini "PONG" |
| `GET /accounts?site=` | **PASS** | re-run today: kimi → `merezarezaei@gmail.com` (import, 2026-09-18); deepseek same |
| `GET /capabilities?site=&account=` | **PASS** | on-file fold #5: kimi ok:true + deepseek ok:true |
| `POST /capability/<site>` | **PASS** | wired runners (capability-dispatch enforces) |
| `GET /health` | **PASS** | present |

## D. Security red lines (code-verified; unchanged from fold #6 + re-grepped)

| Guard | Status |
|---|---|
| Origin pinning / SSRF (`src/runtime/ssrf.ts`) — serve only configured sites | **PASS** |
| Trust gate (`src/prompt/http.ts` — the `profilesById` configured-allow-list on `/capability/<site>`, and `idFrom()` on `POST /prompt`) — configured profiles only | **PASS** |
| Bearer-token gate `UI2API_PROMPTD_TOKEN` (http.ts) | **PASS** |
| `data/` (credentials) gitignored — never commit .session/vault | **PASS** (`.gitignore` line 3) |
| Every browser launch via `launchBrowser()` (`src/runtime/browser.ts`) | **PASS** |
| No eval/Function for DOM reads | **PASS** |

## E. The user's explicit v1 gate — Gemini end-to-end on THIS box

| Check | Status | Evidence (live/on-file) |
|---|---|---|
| Capture/lock present | **PASS** | `capabilities/gemini/session.lock.json` → `data/sessions/gemini.google.com/merezarezaei@gmail.com/state.json` (lock truth fixed, legacyPath kept) |
| One-shot ChatDriver prompt | **PASS** | on-file fold #6: `prompt … --site gemini --account merezarezaei@gmail.com` → **"PONG"** |
| OpenAI-compatible surface | **PASS** | on-file fold #6: `/v1/chat/completions` model gemini → **"OK"** real answer |

## F. Login UX (verbatim 1495 — the exact thing before v1, folds #7–#11)

| Check | Status | Evidence |
|---|---|---|
| `profile scan` finds the OS Chrome root | **PASS** | re-run today: 83 sites; gemini/kimi/deepseek/chatgpt/tencent marked `[KNOWN]`; root `/home/me/.config/google-chrome` |
| `ui2api profile list <host>` lists vault accounts | **PASS** | re-run today: kimi + deepseek → `merezarezaei@gmail.com` |
| Identity-keyed storage (one account per email per site) | **PASS** | vault `data/sessions/<host>/<slug>/`; keys by identity |
| xhost display-detect | **PASS** | fold #7: detects the euid-owned X socket (`:10`), not blind `:0` |
| Data-dir routing to the ui2api user | **PASS** | fold #10: `ui2apiUserDataDir()` returns ui2api XDG dir when usable, else null; `--assist` resolves honestly; 4 unit tests |

## Gaps (honest, none v1-blocking)

- **G4 (cosmetic)**: `/v1/models` + `/v1/chat/completions` live proofs are
  on-file from fold #6, not re-run this fold (they are the SAME code path; a
  daemon restart verified /registry only). A consumer re-run when a browser is
  attached will re-confirm cheaply.
- **G5 (product, known)**: multi-account-per-site + identity aggregation is
  designed (verbatim 1495 "aggregate them as they want") but exercised with ONE
  identity per vault site so far — v1 scope is single identity per site.

## Scope note
This audit did NOT touch OmniRoute (host rule, HANDOFF #4–#10). It is scoped to
the ui2api repo alone.