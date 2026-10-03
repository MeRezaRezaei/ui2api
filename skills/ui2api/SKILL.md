---
name: ui2api
description: >-
  Use when working in the ui2api repo, or when a task involves turning a website
  into an API driven by the user's own logged-in browser session — prompting an AI
  chat site, capturing or replaying a session, editing a chat-site profile, calling
  a per-site capability, generating or installing an MCP/ACP server, or diagnosing
  why a site answers a challenge instead of a reply. Routes to the sibling skills
  for depth on the chat surface, the capability surface, and daemon operation.
---

# ui2api

ui2api turns any website into an API driven by the user's own browser session: an AI
chat site becomes an OpenAI-compatible `POST /prompt` endpoint whose requests are
executed by the site's **own JavaScript** in the user's **real logged-in session**.
Answers are read back off the DOM. **No fabricated traffic, ever** — never synthesize
a request or send a synthetic input that could look foreign to a site's anti-bot
stack. A blocked site answers `ok:false` with a named reason; that honest failure is
the feature, not a bug to paper over. Two execution models sit behind one launch seam:
the ChatDriver (`src/prompt/driver.ts` + declarative profiles in
`src/profile/profile.ts`) and per-site capability runners (`src/capabilities/*.ts`).

This file is ORIENTATION. Depth lives in the siblings.

## Router — pick the sibling, not this file

| Need | Skill | Covers |
| --- | --- | --- |
| Prompt a chat site; OpenAI-compatible chat; choose an account | `skills/ui2api-chat/SKILL.md` | `/v1/models`, `POST /prompt`, `POST /v1/chat/completions` (incl. `stream:true`), `/sites`, `/accounts`, multi-account selection, the fresh-answer rule |
| Call a site's non-chat tools | `skills/ui2api-capabilities/SKILL.md` | `/registry` as the ONLY discovery source, `/capabilities/<site>`, `POST /capability/<site>`, per-site capability inventory + honest status classes, restriction walls |
| Run and integrate the thing | `skills/ui2api-operate/SKILL.md` | `promptd` lifecycle, the bearer-token gate, `/health` `/status` `/requirements`, installing the generated MCP server into an agent, the headed/Xvfb and attach-mode recovery paths |

**Per-host leaf skill.** Need ONE host's tools in detail? `src/generator/skill-template.ts`
emits a `ui2api-<host>` `SKILL.md` plus a `skill-loader.mjs` beside the generated MCP
server — the generator writes them to `sites/<host>/server/SKILL.md`, beside that
server's `index.ts` and `action-map.json` (`src/generator/generate.ts`). That location is
GENERATED build output: the per-host server directories under `sites/` are gitignored
(`.gitignore`), so nothing in one is committed and an agent must not go looking for a
tracked `skills/` file the generator never writes. `ui2api generate <host>` writes the
server and the action map; the
leaf skill is written only when the generator is called with `skill: true`
(`src/generator/generate.ts`), so treat it as present only where a caller asked for it —
never hand-write it.

## Rules that must never break

- **No fabricated traffic.** Drive the site's own UI/JS; read the answer off the page.
  Only sites you are authorized to automate (`docs/VISION.md`).
- **Never claim "verified" without a recorded live round-trip.** Everything else is
  `ok:false` with its measured reason (`loginGated`, the wall's own text) — never a
  fabricated green (`src/prompt/driver.ts`, `src/capabilities/*.ts`).
- **Headless is what gets us blocked.** Measured on one site and one request, changing
  ONLY headfulness: `--headless=new` → `ok:false` (abuse challenge / `ERR_CHALLENGE`);
  headed Chrome on `Xvfb :99` → a real DOM-read answer. `UI2API_HEADED=1` with no
  display is `headless-degraded` and is NOT a substitute — Xvfb is what makes it true.
  Point of use is a headed Chrome on a virtual display:
  `Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &` then `DISPLAY=:99 npx tsx src/cli.ts chrome start`
  (`src/runtime/browser.ts`, `src/prompt/posture.ts`, `src/runtime/chrome-daemon.ts`).
- **One launch seam.** Every browser launch goes through `launchBrowser()` in
  `src/runtime/browser.ts`. Never `launch()` a browser ad-hoc.
- **Loopback + token.** The daemon binds `127.0.0.1` and answers only configured
  profiles; origin pinning and SSRF guards live in `src/runtime/ssrf.ts`.
  `UI2API_PROMPTD_TOKEN` optionally bearer-gates every route — unset means a
  localhost-only posture (`src/prompt/http.ts`). **The ACP surface is a different
  door with a stricter default:** it has **no auth at all** and executes tools, so it
  binds loopback and refuses a wider bind unless `UI2API_ACP_BIND` names that exact
  host (`src/agent/acp.ts`). Do not assume the hub's read-only wider bind carries over.
- **The CLI refuses what it does not understand.** An unknown flag or a malformed
  numeric value is a **named error with a nonzero exit**, never a silently ignored
  token (`src/cli.ts`). An extra token from a harness surfaces as an error you can
  read — not as a run that quietly did something else.
- **Never commit `data/`.** Session snapshots are real credentials: gitignored, never
  committed, never pasted (`src/runtime/session-store.ts`).
- **Never deploy.** The production deploy job is `when: manual` in `.gitlab-ci.yml` —
  operator-triggered by design. A green pipeline is a necessary condition for a deploy,
  never a decision to make one.

## First 60 seconds

Readiness first — it runs real checks and names the reason for every refusal:

```bash
npx tsx src/cli.ts requirements     # alias: doctor; exits nonzero if anything is not-ready
```

Then ONE real call — anonymous, no sign-in, no capture:

```bash
npx tsx src/cli.ts prompt "reply with PONG" --site duckduckgo
```

Or over the daemon:

```bash
npx tsx src/cli.ts promptd &        # binds 127.0.0.1:9797 (UI2API_PROMPTD_PORT)
curl -s http://127.0.0.1:9797/health
curl -s -X POST http://127.0.0.1:9797/prompt \
  -H 'content-type: application/json' \
  -d '{"site":"duckduckgo","prompt":"reply with PONG"}'
```

`ok:true` with a DOM-read answer is the only green that counts.

## Knobs, counts, and deeper docs

- **Env knobs are NOT listed here.** The full `UI2API_*` table — purpose, default, and
  the file each one is read at — lives in `AGENTS.md`. A copy here would be a second,
  rotting copy of it.
- Derive live state; never trust a count in this file.

  ```bash
  npx tsx src/cli.ts prompt --sites        # the live chat surface
  curl -s http://127.0.0.1:9797/v1/models  # the same, over the wire
  npx tsx src/cli.ts install --catalog     # installable packages: site, version, trust
  ```

  The number of chat models, installed packages and verified sites moves as gates
  tighten. Any figure stated in `AGENTS.md`, `README.md` or `docs/` is a dated record,
  not today's answer — re-derive it with the command above.
- **Consumer rule:** `/registry` is the ONLY discovery source a consumer needs; no site
  knowledge belongs in the caller. Materialize one provider per active package and one
  tool per capability, and treat an absent `chat.model` as "no chat", not as a bug.
- Architecture: `docs/VISION.md`, `docs/ENGINE.md`. Anti-bot posture and the vectors
  that must stay closed: `docs/STEALTH.md`. Per-site honest status inventory:
  `capabilities/README.md`. Cold start: `docs/ONBOARDING.md`.