# Changelog

All notable changes to ui2api are tracked here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [0.2.0] — 2026-09-23

GOAL 15/16/17 verified surface (full-functionality live verification + registry
re-sync + consumer surface proof). API/registry data changes.

### Added
- duckduckgo capabilities now carry the **full verified surface** (0.3.0):
  chat, model_picker, web_search, file_upload, reasoning, chat_history — all
  six VERIFIED live 2026-09-23 through the real runner (headed Xvfb
  ALL_OK=true) with 5 new recipe JSONs + chat recipe.
- kimi metadata gains `long_context` verified (picker + enum mapping live;
  Extra Long honestly plan-gated on free accounts).
- tencent-aistudio metadata gains conversation list+open VERIFIED (live
  `/chat-history` rows → open by id); the remaining 8 capabilities are
  recorded HONEST-BLOCKED with measured reasons (no UI exists for them on the
  current Hy4 preview composer / dead routes / separate app).

### Fixed
- `src/plugin/context.ts` MCP session-injection bug: generated-consumer pages
  booted anonymous (loaded a nonexistent `cookies.json`). They now inject the
  same snapshot → vault → cookies chain as the runners, gated on
  `!usingUserChrome()` — external MCP consumers are signed into the site.

### Docs
- `docs/ONBOARDING.md` §11: consumer quickstart — promptd up → OpenAI-compatible
  `POST /v1/chat/completions` (SSE) call → external MCP stdio client →
  `ui2api plugin serve` tool invocation, with measured live outputs.

## [0.1.1] — 2026-09-23

Production-readiness hardening (GOAL 14 zero-to-sell audit). No API changes.

### Fixed
- `engines.node` aligned `>=18.19.0` → `>=20.0.0` (playwright requires node >=20; CI runs 20).
- `homepage` field added to package.json.
- Machine-absolute paths (`/home/me`, `/ott/ui2api-work`, `/home/ui2api/...`)
  removed from the published tarball: capability `metadata.json` evidence fields
  and `capabilities/youtube/session.lock.json` now say "proof JSON kept outside
  the repo (gitignored)" / "the user's real Chrome profile"; dev scripts
  (`scripts/capture-js-index.ts`, `scripts/verify-indexed-call.ts`,
  `scripts/ops/launch-ui2api-chrome.sh`) parametrize via `WORK`/`SNAP_PATH`/
  `UI2API_OS_USER`/`UI2API_USER_DATA_DIR` env with tempdir defaults.
- AGENTS.md trust-gate section corrected to the real gate
  (`src/prompt/http.ts` profilesById + `127.0.0.1` bind + optional bearer;
  phantom `trust.ts` reference removed).
- README verification matrix updated: five live-verified chat sites (adds
  duckduckgo, verified 2026-09-22) with honest unverified flags.

### Added
- `SECURITY.md` — trust model + verification + reporting.
- HTTP-level security tests: bearer gate (401 without/wrong token, 200 with)
  and localhost-only posture when no token is set (`test/prompt.test.ts`).
- `.gitignore`: `.plans/` (local planning docs, intentionally unpublished).
- GitHub Release + repo homepage/topics.

### Security
- Published tarball re-audited: 535 files, 0 machine paths, 0 credential
  values (cookie-name regexes only), no `data/`, `.env`, `test/`, `node_modules`.
- `npm audit`: 0 vulnerabilities.

## [0.1.0] — 2026-09-23

First public release — published to npm (registry.npmjs.org, maintainer
merezarezaei, MIT).

### Added
- ChatDriver (`src/prompt/`) — declarative chat-site profiles; paste prompt +
  Enter via the site's own JS, read the streamed answer off the page. One
  driver, all sites.
- Capability runners (`src/capabilities/*`) — per-site capability surfaces
  (chat, list_conversations, web_search, image_gen, …) exposed as
  `POST /capability/<site>`.
- `promptd` daemon — warm page pool, `POST /prompt`, `/sites`, `/status`,
  `/health`, `/v1/models`, `/v1/chat/completions` (OpenAI-compatible),
  `GET /registry` consumer surface.
- Session snapshot system — `ui2api profile capture|ingest|import|add-all`;
  snapshot-injected sessions replayed into fresh browser contexts.
- Analyzer / mapper / generator pipeline — fetch a site, hook
  fetch/XHR/WS, record real calls, build typed action maps, generate per-site
  MCP/ACP servers.
- Builtin profiles + session-locked packages: gemini, deepseek, kimi,
  tencent-aistudio (headed/real-Chrome only), duckduckgo (verified 2026-09-22),
  youtube (capability site), araprat (capability site), plus anonymous
  chatgpt/claude/copilot/perplexity/huggingchat profiles.
- Multi-account support — `account` param on `POST /capability/<site>` and
  `POST /prompt`, `GET /accounts?site=`, vault `data/sessions/<host>/<slug>/`.
- Package hub / registry / plugin serving (`ui2api package`, `hub`, `install`,
  `plugin serve`).

### Fixed (pre-release hardening, 2026-09-23)
- See 0.1.1 for the full production-readiness audit (machine-path removal,
  engines alignment, SECURITY.md) — published as 0.1.1 because the npm 0.1.0
  tarball went live before those fixes.

### Security
- See SECURITY.md — localhost-only default bind, profile allow-list, optional
  bearer-token gate, no credentials in the published artifact, no fabricated
  traffic.

[0.1.1]: https://github.com/MeRezaRezaei/ui2api/releases/tag/v0.1.1
[0.1.0]: https://github.com/MeRezaRezaei/ui2api/releases/tag/v0.1.0