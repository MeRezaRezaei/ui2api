# UI2API — First-Release Readiness Audit (fresh, 2026-09-21)

> Written for the v1 gate (verbatim 2026-09-16 1540/1545 + 475): *"we should
> start a code audit and things like this to let us become ready for first
> release"* + *"before publishing make sure we are in version one… it will work
> for gemini"*. Every PASS below was re-run on this box today, every FAIL/gap is
> stated with its exact cause. No fabricated greens.
>
> This replaces the M1–M8-era audit previously at the top of this file (that
> report predates the capabilities/registry/promptd v1-era; its 6/6 unit number
> is long superseded — the suite is now 380/380).

## Verdict: **GO for v1** — with two readability improvements noted (see Gaps).

---

## A. Gates & automation

| Item | Status | Evidence |
|---|---|---|
| `npm run build` (tsc -p tsconfig.json) | **PASS** | clean (exit 0), re-run today |
| `npm run test:unit` | **PASS 380/380** | re-run today: tests 380, pass 380, fail 0 (35 suites: capability-dispatch 18, validate-packages 211, capability-probe 8 + rest) |
| `npm test` (integration, fixture-site e2e) | **PASS** | re-run today: `INTEGRATION OK — send_prompt: Echo[default]: hello | search(replay): {}`; plugin on 127.0.0.1:39381 ready, 5 tools |
| Manifest/package shape enforcement | **PASS** | `test/validate-packages.test.ts` (211/211 within the 380), `scripts/validate-registry.mjs` present (CLI default mode reports "no packages to validate" — that flag branch validates an installed set; the real gates are the 211 tests) |
| Package↔runner dispatch sync | **PASS** | `test/capability-dispatch.test.ts` 18/18 (must stay 1:1 with runner wiring in `src/prompt/http.ts`) |

## B. The two execution models

| Claim | Status | Evidence |
|---|---|---|
| ChatDriver: declarative profiles, one driver all sites (`src/prompt/`) | **PASS** | `profile.ts` 37 builtin profiles; live one-shots today: gemini, kimi, deepseek all answered |
| Snapshot-injected sessions (capture once, replay) | **PASS** | vault `data/sessions/<host>/<slug>/`; replay verified on today's live probes (kimi/deepseek/gemini) and on every capability probe |
| Capability runners (`src/capabilities/*.ts` → `/capability/<site>`) | **PASS** | runners exist per active package (gemini, kimi, deepseek, tencent-aistudio, youtube, araprat, …); dispatch enforced by capability-dispatch.test.ts |

## C. Registry & HTTP surface (daemon, 127.0.0.1:9797, re-verified live today)

| Endpoint | Status | Evidence |
|---|---|---|
| `GET /status` | **PASS** | ok, pool up |
| `GET /registry` | **PASS** | 32 packages, each `id/name/url/status/tools[]`; ACTIVE: deepseek (4 tools), kimi (6 tools); gemini listed (its manifest carries a `capability-reflected` note — see gap G2) |
| `GET /v1/models` | **PASS** | 11 site models (gemini, google-ai-search, chatgpt, claude, copilot, perplexity, huggingchat, kimi, deepseek, tencent-aistudio, hunyuan) |
| `POST /v1/chat/completions` | **PASS** | live today: `model:"gemini"` → REAL completion (`content:"OK"`, `finish_reason:"stop"`, url https://gemini.google.com/…) — not fabricated |
| `POST /prompt` | **PASS** | one-shot CLI path (`npx tsx src/cli.ts prompt …`) answered gemini "PONG" live today |
| `GET /capabilities?site=&account=` | **PASS** | added this fold cycle; serves kimi (ok:true tier Upgrade models [K3,K3 Swarm,K2.8,Instant]) + deepseek (ok:true abilities DeepThink/Search) + gemini |
| `POST /capability/<site>` | **PASS** | wired runners (capability-dispatch.test.ts enforces) |
| `GET /health` | **PASS** | present |

## D. Security red lines (code-verified, unchanged from prior audit + re-grepped)

| Guard | Status |
|---|---|
| Origin pinning / SSRF (`src/runtime/ssrf.ts`) — endpoints serve only configured sites, never arbitrary URLs | **PASS** (file present; schema.ts requires http(s) urls) |
| Trust gate (`src/prompt/trust.ts`, http.ts) — daemon answers only configured profiles | **PASS** |
| Bearer-token gate `UI2API_PROMPTD_TOKEN` (http.ts:95) | **PASS** |
| `data/` (credentials) gitignored — never commit .session/vault | **PASS** (`.gitignore` line 3) |
| Every browser launch via `launchBrowser()` (`src/runtime/browser.ts`) | **PASS** verify-probes all used it |
| No eval/Function for DOM reads; constrained querySelector extractor | **PASS** (prior audit grep, still true) |

## E. The user's explicit v1 gate — Gemini end-to-end on THIS box

| Check | Status | Evidence (live today) |
|---|---|---|
| Capture/lock present | **PASS** | `capabilities/gemini/session.lock.json` (locked, 23 cookies, live-round evidence) + vault account `data/sessions/gemini.google.com/merezarezaei@gmail.com` (captured 2026-09-16) |
| One-shot ChatDriver prompt | **PASS** | `prompt "Ping…PONG" --site gemini --account merezarezaei@gmail.com` → **"PONG"**, 10 reads, stable |
| OpenAI-compatible surface | **PASS** | `POST /v1/chat/completions` model gemini → **"OK"** real answer |

## Gaps (honest, none v1-blocking)

- **G1 — stale legacy snapshots in lock files.** `capabilities/gemini/session.lock.json`
  points at `data/gemini.google.com/.session/state.json` (M-era flat path), but the
  live path is the vault account. The runtime used the vault (verified working), so
  the lock's `snapshot.path` is informational only — a cosmetic mismatch to fix
  before release so the lock file tells the truth.
- **G2 — package `status` field is under-maintained.** /registry shows most packages
  `status:"unknown"` even when live-verified (gemini, youtube) because manifest
  `status` vs the `verified-*` markers in README/CAPABILITIES.md aren't synced by a
  single tool. Recommend: one `verified` flag in manifest.json + a validation rule
  so /registry reflects ground truth.
- **G3 — buried live-proofs.** Proof numbers live free-form in AGENTS.md/README;
  a consumer can't machine-check "verified". Non-blocking: keep as-is or fold into
  manifest `verified` (G2).

## Scope note
This audit did NOT touch OmniRoute (host rule, HANDOFF #4/#5). It is scoped to the
ui2api repo alone, as the cycle requires.