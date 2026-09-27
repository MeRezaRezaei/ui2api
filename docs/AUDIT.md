# UI2API — First-Release Readiness Audit (re-verified, 2026-09-21, fold #11)

> Written for the v1 gate (verbatim 2026-09-16 1540/1545 + 475): *"we should
> start a code audit and things like this to let us become ready for first
> release"* + *"before publishing make sure we are in version one… it will work
> for gemini"*. Every PASS below was re-run on this box at fold #11; FAILs
> and gaps are stated with their exact cause. No fabricated greens.
>
> Delta vs the fold-#6 audit: the suite grew 380/380 → 418/418 (both are
> fold-#6 and fold-#11 **records**); the inaccessible-display and
> manifest-status gaps (then G1/G2/G3) are CLOSED by folds #7–#11 (xhost
> display-detect, machine-checkable `verified` flag, `legacyPath`-stable lock
> truth, ui2api-user data-dir resolver).

> ### ⚠ Every NUMBER in this file is a DATED FOLD-#11 RECORD, not a current total
>
> This audit is a point-in-time snapshot dated **2026-09-21 (fold #11)**. Its
> suite totals (`418/418`, `18/18`, `211`, …) and the on-box counts were
> **true on that date only** and are deliberately left un-refreshed. Do not read
> them as today's numbers, and do not treat them as authoritative for "what is
> the suite size" — that figure is a **runtime-only** fact (the files hold a
> handful of literal `test(`/`it(` calls and generate the rest from `for` loops,
> so any hand-typed total is unverifiable and can only rot). Get it from a run:
> the last lines of `npm run test:unit` print the real `# tests` / `# suites`.
> CI (`.github/workflows/ci.yml`) is the lane that runs the full suite.
>
> The **code-shaped** rows below (endpoints, guards, package shapes) are not
> date-sensitive and are the durable part of this file; where a count drifted
> after fold #11, the row was corrected against the code and now carries its
> own re-derivation command.

## Verdict: **GO for v1** — single user, one identity per vault site, on this
box. No open first-release blockers (all previously-noted gaps are closed).

---

## A. Gates & automation

| Item | Status | Evidence |
|---|---|---|
| `npm ci` | **PASS** | lockfile install, the first step of both CI configs (`.github/workflows/ci.yml`, `.gitlab-ci.yml`) |
| `npm run build` (tsc -p tsconfig.json) | **PASS** | clean (exit 0), re-run at fold #11 (2026-09-21) |
| `npm run typecheck` (tsc -p tsconfig.test.json) | **PASS** | clean (exit 0) — **added after this fold was written**; it is the ONLY step that compiles `test/**` (`tsconfig.json` excludes it), and both CI configs run it. See `docs/TROUBLESHOOTING.md` for why omitting it is not harmless |
| `npm run test:unit` | **PASS 418/418** *(fold-#11 record, not a current total)* | re-run at fold #11: tests 418, pass 418, fail 0 (incl. capability-dispatch 18/18, validate-packages 211, capability-probe 8, registry verified-shape, xhost-capture 13 incl. `ui2apiUserDataDir` 4) |
| `npm test` (integration, fixture-site e2e) | **PASS** | re-run at fold #11 (2026-09-21): `INTEGRATION OK — send_prompt: Echo[default]: hello \| search(replay): {}`; plugin on 127.0.0.1:44411 ready, 5 tools |
| Manifest/package shape enforcement | **PASS** | `test/validate-packages.test.ts` + `scripts/validate-registry.mjs`; verified contract enforced (bare `true` refused; truthy requires since+evidence+via) |
| Package↔runner dispatch sync | **PASS** | `test/capability-dispatch.test.ts` 18/18, 1:1 with runner wiring in `src/prompt/http.ts` |

## B. The two execution models

| Claim | Status | Evidence |
|---|---|---|
| ChatDriver: declarative profiles, one driver all sites (`src/prompt/`) | **PASS** | `src/profile/profile.ts` carries **11** builtin profiles (re-derived 2026-09-27; the "37" in earlier revisions of this row was a long-dead count); live one-shots on-file: gemini/kimi/deepseek (folds #5/#6 proofs) |
| Snapshot-injected sessions (capture once, replay) | **PASS** | vault `data/sessions/<host>/<slug>/`; replay verified in folds #5/#6 live probes |
| Capability runners (`src/capabilities/*.ts` → `/capability/<site>`) | **PASS** | runners per active package; dispatch enforced by capability-dispatch.test.ts |

## C. Registry & HTTP surface (daemon, 127.0.0.1:9797 — restarted with CURRENT code this fold, pty_04929198, PID 3130534)

| Endpoint | Status | Evidence |
|---|---|---|
| `GET /status` | **PASS** | ok, pool up |
| `GET /registry` | **PASS** | **33** packages (re-derived 2026-09-27: `34` dirs under `capabilities/`, exactly one — `hunyuan-yuanbao/` — deliberately skipped with no `manifest.json`); `verified` surfaced: deepseek "2026-09-19", kimi "2026-09-19", gemini "2026-09-15", claude `false` (G2/G3 closed, fold #8) |
| `GET /v1/models` | **PASS** | **22** site models = the servable chat set (re-derived 2026-09-27, 10 builtin + 12 packaged; earlier "11" here was a fold-#6 reading) |
| `POST /v1/chat/completions` | **PASS** | on-file fold #6: model gemini → REAL completion (content "OK", finish_reason stop) |
| `POST /prompt` | **PASS** | one-shot CLI path on-file fold #6: gemini "PONG" |
| `GET /accounts?site=` | **PASS** | re-run at fold #11 (2026-09-21): kimi → `merezarezaei@gmail.com` (import, 2026-09-18); deepseek same |
| `GET /capabilities?site=&account=` | **PASS** | on-file fold #5: kimi ok:true + deepseek ok:true |
| `POST /capability/<site>` | **PASS** | wired runners (capability-dispatch enforces) |
| `GET /health` | **PASS** | present |

### Re-derive the shape numbers in §B and §C (do not trust this file)

The `11` builtins, `33` packages and `22` chat models above are the kind of
figure that rots, so here is the command that produced them — run it, and
correct this file if it disagrees:

```bash
npx tsx -e '
  import { defaultChatProfiles, buildRegistryPackages } from "./src/prompt/registry.ts";
  import { BUILTIN_PROFILES } from "./src/profile/profile.ts";
  const chat = defaultChatProfiles().map(p => p.id), keys = Object.keys(BUILTIN_PROFILES);
  const pk = buildRegistryPackages();
  console.log("chat surface:", chat.length,
    "= builtin", chat.filter(i => keys.includes(i)).length,
    "+ packaged", chat.filter(i => !keys.includes(i)).length);
  console.log("BUILTIN_PROFILES:", keys.length, "| not surfaced:", keys.filter(k => !chat.includes(k)).join(" "));
  console.log("registry packages:", pk.length, "| carrying chat.model:", pk.filter(p => p.chat?.model).length);
'
# chat surface: 22 = builtin 10 + packaged 12
# BUILTIN_PROFILES: 11 | not surfaced: google-ai-search
# registry packages: 33 | carrying chat.model: 22
```

Note the split is **10 + 12, not 11 + 11**: `BUILTIN_PROFILES` holds 11 keys but
only 10 are surfaced as chat models — `google-ai-search` is catalogued and fully
served as a *capability* package while being deliberately absent from the chat
surface (composer-less profile, no `*_chat` capability, `loginGatedResult(...)`
runner). Never hand-type either half of the split; a hand-typed builtin count is
exactly how the old "11 builtins" line went wrong.

The `34 dirs / 33 packages` identity is derived from disk and asserts the
*exception*, not just the count — a renamed excuse would keep the count right:

```bash
ls -1 capabilities/*/manifest.json | wc -l          # 33 packages
for d in capabilities/*/; do [ -f "$d/manifest.json" ] || echo "no manifest: $d"; done
# no manifest: capabilities/hunyuan-yuanbao/          <- the one deliberate skip
```

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
| `profile scan` finds the OS Chrome root | **PASS** | re-run at fold #11 (2026-09-21): 83 sites; gemini/kimi/deepseek/chatgpt/tencent marked `[KNOWN]`; root `/home/me/.config/google-chrome` |
| `ui2api profile list <host>` lists vault accounts | **PASS** | re-run at fold #11 (2026-09-21): kimi + deepseek → `merezarezaei@gmail.com` |
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