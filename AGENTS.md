# AGENTS.md — ui2api, for AI agents

This file tells AI agents (Claude Code, Codex, Cursor, opencode, …) what this
project is and how to work in it. Read it before touching anything.

> # ⛔⛔ RED LINES — VIOLATE ANY ONE AND THE WORK IS A FAILURE ⛔⛔
>
> **1. Parallel-shaped work MUST run as nested parallel subagents.** If the
> pieces are independent, they go out as **parallel siblings in ONE message**,
> and every child is told it may nest further (depth ≤ 5). Collision analysis
> comes BEFORE dispatching. **Serial execution on a parallel-shaped task is a
> FAILURE, not a safe default.** A 429, a quota error, a crashed child, or a
> network blip **never** shrinks the next wave — it re-dispatches at full width.
>
> **2. Long work belongs in GitLab CI via `glab` — never a blocking terminal.**
> A full test suite, a big build, an e2e run, a migration, a long script: all of
> it goes to CI. Fire it, dispatch a watcher on the pipeline id, and **CONTINUE
> with the next task** — waiting, polling, or pausing on a pipeline is FORBIDDEN.
> A pipeline id proves a job was created, **not that it passed**: report
> `CI running (run N) — watcher pending`, never "tests pass". No CI channel? A
> bounded local run behind a timeout, never an open-ended wait.
>
> **3. Every command carries a real timeout.** `timeout -k 5 <secs> <cmd>`,
> sized to that command's real expected duration. Exit 124 is a **named failure
> you report**, never a silent retry loop. This binds the commands you run AND
> every command a subagent you dispatch runs.
>
> **4. The default behaviour is STARTUP WORK — you never need a command.**
> Silence is a command: START. Never open with "what should I do?"; never wait
> to be told. With no command, in order: (1) run the startup gate and probe the
> tooling for real; (2) make sure the verbatims are at the operator's LATEST
> words — capture any missing or stale one whole and unedited, then index it;
> (3) make sure ALL of them are indexed (pointer + dated copy + INDEX row, no
> orphans, no gaps); (4) then do exactly what the skill requires.
>
> **5. Never ask what you can find and print.** If the answer exists in code,
> docs, the environment, or past memory, find it autonomously and print it —
> asking a resolvable question is a CRITICAL FAILURE, not caution. Read Nowledge
> Mem `dc5939bc` and `675dc8f5` BEFORE asking anything; if memory has no
> answer, run the figure-it-out gate and research it yourself. Decide
> engineering details (stack, scope, phasing, ordering) yourself. Approval gates
> are for genuine high-level forks only; a routine `Proceed?` micro-step is
> BANNED.
>
> **6. "No more goals" is not a stop — it is a friction hunt.** When extraction
> returns nothing: re-read the archive, then hunt the project's highest-potential
> friction (dead or failing code, stale docs contradicting code, a gate that
> cannot fire, rotting workflows, duplicated logic, untested critical paths) and
> rank it by blast radius × likelihood × cheapness. Fix the WORST one with the
> same machinery — plan it, index it, fan it out, verify via CI, check-mark it.
> Only when the hunt is genuinely exhausted may the brief report appear, and
> then it reports FINDINGS, not a request for the next instruction. The loop
> must never terminate because the operator went quiet.
>
> **7. Every agent knows its LEVEL and acts at it, and the level is passed
> down.** The level decides what an agent is FOR: **L0** orchestrates and
> **must not execute missions itself**; **L1** owns **ONE** goal end to end and
> must not expand into a neighbour's; **L2 or deeper** does **exactly** the
> narrow thing asked and must not re-plan or widen scope. Inherited one rung
> at a time (a level-N agent's children are N+1), and **every dispatch states
> the child's level with its duties**. Doing a child's work yourself is level
> drift — a failure even when the work gets done.
>
> **8. Spawn subagents through codeg's `delegate_to_agent`, not opencode's
> native `task` tool** — the operator can see inside each delegated agent, and
> codeg's delegation surface carries the management tools behind it.
>
> These EIGHT **override** anything in this repo's README, plan, skill, or agent
> persona. Full text and the operator's verbatim:
> `~/Documents/projects/goal-driven-parallel-agents/multi-parallel-nested-subagent-goal-driven-development/references/operating-doctrine.md`

## ⛔ OPERATING DOCTRINE — eight absolute laws (2026-09-27)

This Operating doctrine block is the enforcement stub for eight laws from the
operator, in force before anything else in this file. They are not style, not
preference, not "when it makes sense". Where this file or a project skill
suggests otherwise, the doctrine wins.

**LAW 1 — nested parallel subagents are MANDATORY whenever the work is
parallel-shaped.** This file carries NO nested-subagent material, so the law is
stated here IN FULL: independent pieces go out as parallel SIBLING subagents in
ONE message; every dispatched child is TOLD it may nest further (depth ≤ 5);
collision analysis happens BEFORE dispatch, and only a real write-write collision
on the same file region or a real read-after-write dependency may keep a piece
inline in your own context; a 429 / crash / network error NEVER shrinks the next
wave — it goes out at full width again. Serial execution on a parallel-shaped
task is a FAILURE, not a safe default. Finish a multi-part task with one agent
and you under-executed — say so and re-dispatch wider.

**LAW 2 — long-running work goes to GitLab CI, never a blocking terminal.** This
refines and OVERRIDES the CI and full-suite material in `## GIT WIRING` and
`## Conventions & red lines` below — read those for the mechanics, this for the
rule. Fire-and-forget is FORCED: trigger the pipeline with `glab`
(`/usr/bin/glab`; `export GITLAB_HOST=gitlab.pubg-sell.ir` when needed), dispatch
a watcher on the pipeline id, then CONTINUE with the next task — waiting,
polling or pausing on a pipeline is forbidden. Evidence stays honest: a pipeline
id proves a job was CREATED, not that it passed, so report
`CI running (run N) — watcher pending`, never "tests pass"; GitLab
`.gitlab-ci.yml` is the long-running lane and the GitHub workflow is a redundant
lane. No CI channel at all → the suite runs locally, BOUNDED behind a timeout,
never an open-ended wait.

**LAW 3 — every command carries a real timeout.** Wrap anything that can hang:
`timeout -k 5 <secs> <cmd>`, sized to the real expected duration, not a round
number that hides a hang. Exit 124 is a NAMED failure you report — never a
silent retry loop, never "raised until it passes". This binds YOUR commands AND
every dispatched subagent's, and it refines the `--test-timeout` /
bounded-subprocess material in `## Conventions & red lines` (~line 601) and the
port-22 hang note in `## GIT WIRING` (~line 217).

**Full source of truth — go read it, and it OVERRIDES anything in this repo
that suggests otherwise:**
`/home/me/Documents/projects/goal-driven-parallel-agents/multi-parallel-nested-subagent-goal-driven-development/references/operating-doctrine.md`

## What this repo is

`ui2api` turns **any website into an API driven by the user's own browser
session**. The flagship use-case: an AI chat site (Gemini, Kimi, DeepSeek,
Hunyuan, Claude, ChatGPT, …) becomes an OpenAI-compatible
`POST /prompt` endpoint whose requests are executed by the site's **own
JavaScript** in the **user's real logged-in session** — the same cookies,
localStorage, and origin code paths a human would use.

Core property (non-negotiable): **no fabricated traffic.** We never synthesize
requests or send fake inputs that could look foreign to the site's anti-bot
stack. We drive the site through its own UI/JS and read answers back off the
page. Docs: `docs/VISION.md`, `docs/ENGINE.md`, `docs/STEALTH.md` (stealth
audit + posture), `docs/AUDIT.md`, `docs/TROUBLESHOOTING.md`. New users: start
at `docs/ONBOARDING.md` (copy-paste v1 flow).

## Layout

```
src/
  cli.ts                 # the ui2api CLI (all commands live here)
  analyzer/              # fetch site, hook fetch/XHR/WS, record real calls
  mapper/                # build action map (normalize captures into typed actions)
  generator/             # generate MCP/ACP servers from the action map
  prompt/                # ChatDriver + daemon + HTTP endpoint (driver.ts, http.ts, pool.ts)
  profile/profile.ts     # BUILT-IN chat-site profiles (composer/send/answer selectors)
  capabilities/          # per-site capability runners (gemini.ts, kimi.ts, deepseek.ts, …)
  runtime/               # browser control, DOM primitives, session store, captures
  hub/                   # package hub (mirror, runtime, store, UI)
  registry/              # package install
  plugin/                # MCP plugin serving
capabilities/            # 33 package dirs (the ones carrying a manifest.json;
                         #   `hunyuan-yuanbao/` is a deliberately-skipped legacy
                         #   dir with no manifest, so 34 dirs on disk, 33 packages).
                         #   Per-site package: manifest.json, profile.json, recipes/,
                         #   session.lock.json, CAPABILITIES.md (+ README.md inventory,
                         #   CAPTURE-RUNBOOK.md, provider-catalog.md)
data/<host>/.session/    # CAPTURED SESSIONS (gitignored — never commit, never paste)
sites/                   # generated per-site servers (build output)
test/                    # node:test suites (unit, integration, validation)
```

## The two execution models

1. **ChatDriver** (`src/prompt/`) — declarative profiles
   (`src/profile/profile.ts`, overridable via JSON with `--profile` or
   `UI2API_AI_SITE`). Paste prompt + Enter via the site's own JS, read the
   streamed answer until it stops growing. One driver, all sites. Model
   selection verifies it took (exact-row click, selected-state check) — never a
   silent wrong-model prompt. Answer readback is FRESH per prompt: `awaitAnswer`
   snapshots the pre-ask answer region as a baseline and judges only new text,
   so the warm daemon pool's reused pages never echo a previous prompt's
   still-mounted answer (stale-echo guard, `test/readback-freshness.test.ts`);
   `newChat` resets are verified after the click (answer region emptied or
   composer cleared) before composing.
2. **Capability runners** (`src/capabilities/*.ts`) — per-site capability
   surface (chat, list_conversations, web_search, image_gen, …) exposed as
   `/capability/<site>` endpoints, wired in `src/prompt/http.ts`, and kept
   in-sync with each site's manifest by `test/capability-dispatch.test.ts`.

Both use **snapshot-injected sessions**: capture once
(`ui2api profile add-all --known` for the one-command bulk login of every OS
Chrome-profile site session, or `profile capture <url> --login` / `profile
ingest <host>` for a single host / offline read of a live Chrome profile), lock
it in the package (`capabilities/<site>/session.lock.json`), and replay cookies
+ localStorage into fresh browser contexts at runtime.

## Commands

```bash
npm run build              # tsc -p tsconfig.json
npx tsx src/cli.ts prompt "hello" --site gemini      # one-shot prompt via ChatDriver
npx tsx src/cli.ts prompt --sites                    # list available sites (--site X)
npx tsx src/cli.ts promptd                           # daemon: POST /prompt, /status, /sites
npx tsx src/cli.ts analyse <url> [--login] [--llm]   # recorder + action map
npx tsx src/cli.ts profile scan|import|capture|ingest|list  # session management
npx tsx src/cli.ts profile add-all [--known|--interactive]  # one-command bulk import: ALL Chrome-profile site sessions → vault (read-back verified, no per-host loop)
npx tsx src/cli.ts requirements [site] (alias: doctor)     # OS-level readiness gates BEFORE any browser work: per-package verdict ready/working/on-hold/not-ready with the NAMED reason; exit nonzero on any not-ready
npx tsx src/cli.ts install <site> | plugin serve  # install + plugin workflows (`package` REFUSES LOUD — write-truth gate, GOAL 66; install --out = isolated, NOT daemon-served — GOAL 67)
npx tsx src/cli.ts hub | serve | remap | generate    # server generation pipeline
npm test                  # integration (test/integration.ts)
npm run test:unit         # full unit suite incl. validate-packages + capability-dispatch
```

Serving: `src/prompt/http.ts` exposes `POST /prompt` (`{"site","prompt"}`),
`GET /sites`, `GET /capabilities/<site>`, `POST /capability/<site>`,
`GET /status`, `GET /requirements`, `GET /health`. Binds `127.0.0.1` only,
configurable bearer-token gate (`UI2API_PROMPTD_TOKEN`).

**Multi-account** (live-verified 2026-09-22, GOAL 8): `POST /capability/<site>`
and `POST /prompt` accept an optional `"account":"<slug|email>"` — the account is
validated against the vault (`listAccounts`+`slugifyIdentity`) BEFORE any browser
launches; unknown account → 400 `no stored account "<acct>" for "<host>"; available: [<slugs>]`.
`GET /accounts?site=<id>` lists vault accounts — chat-profile set first, then any
installed capability package (GOAL 31: the same registryPackageFor vault /registry
+ /capabilities/<site> serve; host = the packaged url's host, null when url-less);
each `GET /registry` package
carries `accounts: [{slug, identity, host, source, capturedAt}]` (same list in the
`GET /capabilities/<site>` path form). Vault path `data/sessions/<host>/<slug>/state.json`;
`"default"` = the legacy flat session.

Consumer surfaces (what OmniRoute / any external tool consumes — the registry
is the ONLY info source, no site knowledge lives in the consumer):
- `GET /registry` — runtime package registry (built only from installed
  capability packages): `packages[]` each with `id/name/url/status/tools[]`
  (`tool.name` = `<site>_<capability>`, plus inputSchema), and `chat.model`
  ONLY on driveable chat packages — the same `defaultChatSurface()` gate
  `/v1/chat/completions` serves (GOAL 34: `chat` is absent on capability-only /
  url-less / dormant / dead-end packages — `/v1` would `404 unknown_model`
  them, so the registry never advertises chat it cannot serve; key on
  `pkg.chat?.model`, treat absence as "no chat"). Consumers
  materialize one provider per ACTIVE package and one tool per capability.
- `GET /v1/models`, `POST /v1/chat/completions` — OpenAI-compatible chat
  surface (model = site id; `stream:true` replays the finished DOM-rendered
  answer as SSE — honest: ChatDriver reads the page, it does not synthesize
  traffic). Non-chat capabilities stay on `/capability/<site>`.

## HEADLESS IS WHAT GETS US BLOCKED — run the daemon HEADED under Xvfb

MEASURED on the same site, the same request, changing ONLY headfulness:

| browser | live result |
| --- | --- |
| `--headless=new` | `ok:false` — *"either ERR_CHALLENGE (abuse signal) or the consent wall re-blocked"* |
| **headed on `Xvfb :99`** | `ok:true` — `answer: "GPT-5.6 Luna\n\nPONG-HEADED"`, DOM-read, the site's own JS driving `POST /duckchat/v1/chat` (SSE) |

A headless browser is a forgery and it fails differently from a plain bot. **The
point of use is a HEADED Chrome on a virtual display:**

```bash
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
DISPLAY=:99 ui2api chrome start        # NO --headless
```

`UI2API_HEADED=1` **without** a display is `headless-degraded` and is NOT a
substitute — the daemon falls back to `--headless=new` and gets challenged again.
**Xvfb is what makes `UI2API_HEADED=1` true.** Confirm with
`GET /status` -> `"headful":true, "headlessDegraded":false`.

## WHEN A SITE CHALLENGES YOU — reach for WIGOLO, not a retry loop

**If a site answers with an abuse challenge, a consent wall, or an
`ERR_CHALLENGE`, wigolo is the bypass tier.** Full detail: `docs/WIGOLO_BYPASS.md`.

MEASURED live (2026-09-26, real duckduckgo.com through the `ui2api` Chrome):
`no answer appeared on duckduckgo — either ERR_CHALLENGE (abuse signal) or the
consent wall re-blocked; honest on-page read returned empty`. The failure is
honest (no fabricated answer) but it is still a failure.

- **Do NOT** retry the plain path in a loop or raise a timeout — that only
  deepens the rate-limit signal.
- **DO** use the wigolo tier (`src/runtime/wigolo.ts`,
  `src/plugin/wigolo-context.ts`): a separate browser tier for exactly this.
- **DO** keep the honest verdict. If wigolo cannot get a real answer either, the
  result stays `ok:false` with the named reason, and the site is recorded with
  its honest status like any other blocked site.
- Wigolo's rules are NOT to be weakened: loopback only
  (`UI2API_WIGOLO_ALLOW_REMOTE`), the bearer token never leaves loopback without
  the SECOND opt-in (`UI2API_WIGOLO_ALLOW_REMOTE_TOKEN`), and a cross-origin
  daemon answer is REFUSED so a 200 from any base can never be served as a page's
  answer (GOAL 123). No fabricated results outranks convenience.

## THE PERSISTENT CHROME DAEMON — do not fire Chrome per request

**"We should not fire the Chrome each time. Run a user daemon from the `ui2api`
user, and after that Playwright works with it."** — the operator's rule, and it
is what the code now does.

- One long-lived Chrome, owned by the dedicated `ui2api` user, exposing a CDP
  port. Every request **ATTACHES** to it; nothing spawns a browser per call.
- Chrome is expensive to start (seconds) and holds the anti-bot warm state that
  makes a session look real. A freshly-spawned Chrome has been observed dying
  shortly after boot here while a long-lived one survives indefinitely.
- **It is already proven, not theorised**: during the first live round-trip the
  launched Chrome stayed alive holding the profile, the second launch was refused
  by Chrome's one-instance-per-profile rule, and attaching to the live one
  worked. The daemon makes that deliberate instead of accidental.

```bash
ui2api chrome start       # idempotent — never fires a second Chrome
ui2api chrome status      # where it is, and the port to attach to
ui2api chrome stop        # refuses to kill a Chrome we did not start

# or explicitly as the dedicated owner:
sudo -u ui2api -H npx tsx src/cli.ts chrome start    # idempotent
npx tsx src/cli.ts chrome status   # where is it, and what port to attach
npx tsx src/cli.ts chrome stop     # refuses to kill a Chrome we did not start
sudo -u ui2api -H npx tsx src/cli.ts chrome status
sudo -u ui2api -H npx tsx src/cli.ts chrome stop     # refuses to kill a Chrome we did not start
```

- **Idempotent, and it ADOPTS.** `start` never fires a second Chrome: if the
  port is live it reports that, and if a Chrome for the owner is running on
  *another* port it adopts that one and reports the port to attach to. MEASURED:
  a live Chrome on 127.0.0.1:38073 (pid 2003645) was adopted with nothing
  spawned. (Checking only our own port was not enough — that is how the first
  attempt wrongly concluded "nothing is running" and got refused with
  `Failed to create ... ProcessSingleton`.)
- The daemon **never kills a browser it did not start** (same rule as GOAL 119's
  attach-mode fix): `stop` refuses unless the recorded daemon is ours.
- Code: `src/runtime/chrome-daemon.ts` (`startChromeDaemon`, `chromeDaemonStatus`,
  `findOwnerChrome`, `resolveAttachPort`, `stopChromeDaemon`); the launch seam
  prefers the live daemon via `UI2API_ATTACH_PORT` (see `launchBrowser`).

## GIT WIRING — both remotes, and the privacy gate

The project lives on **GitHub AND GitLab**, and both are **private**.
`.brain/` is the operator's private IP and must never reach a public remote.

- `origin` fetches from GitHub and **pushes to BOTH** (two push URLs), so one
  `git push origin` lands in both places. `gitlab` is the explicit GitLab remote.
- **Port 22 is blocked on this box** — an SSH push hangs until timeout. GitLab is
  therefore HTTPS (443) with a token in a `0600` credential file, never in the
  repo. Do not "fix" a push by switching to SSH; it will hang.
- **CI is GitLab** (`.gitlab-ci.yml`). The GitHub workflow is a redundant lane.
- Verify privacy before any push that carries `.brain/`:
  `gh repo view MeRezaRezaei/ui2api --json isPrivate` -> `true`, and
  `glab api "projects/MeRezaRezaei%2Fui2api"` -> `visibility: private`.
- Export `GITLAB_HOST=gitlab.pubg-sell.ir` before `glab ci status`, or it reports
  "no GitLab remotes found" (it reads `origin`'s fetch URL, which is GitHub).
- Full detail, verification commands and gotchas: **`docs/GIT_WIRING.md`**.

## THE CHROME POINT OF USE — read this before touching any browser code

**ui2api drives the Chrome of a DEDICATED LINUX USER, not the operator's own browser.**

- The default owner is the **`ui2api`** user (uid 1010, home `/home/ui2api`). Its Chrome profile
  is `/home/ui2api/.config/ui2api-chrome` (a real `google-chrome` profile also lives beside it).
- The operator's interactive browser **cannot** be used: Chrome refuses to let another process
  attach to the browser a person is using, and refuses `--remote-debugging-port` on a live
  profile. That is a wall, not a bug to engineer around.
- The dedicated user's Chrome works fine, **headless included**. The only setup step in the whole
  world is: **that user's Chrome info must exist.** Writing the Chrome info into that user *is*
  the integration. Nothing else is required.
- The owner is **data, not a hardcode**: `UI2API_CHROME_USER` names it, so the same build works
  for `ui2api`, a per-customer service account, or CI.
- **Logging in without copying anyone's profile:** run that user's Chrome with `xhost +` and log
  in to it directly. Credentials are then ingested by the normal profile-ingest path exactly as
  before. Copying a whole Chrome profile between users is the fragile alternative — prefer `xhost +`.
- **Provisioned by code, not by hand:** `sudo ./scripts/ops/provision-ui2api-user.sh`
  creates the user, seeds the profile (never touching a live one) and registers
  `ui2api-chrome.service` (the one persistent Chrome) + `ui2api-api.service`
  (`promptd`, the HTTP API other programs call) with systemd, both running AS the
  chrome user. Idempotent; `--no-systemd` skips the units.
- Resolver: `src/runtime/chrome-owner.ts` (`resolveChromeOwner`, `chromeOwnerStatus`), consumed by
  `userChromeProfile()` in `src/runtime/browser.ts` so the launch seam and the docs cannot disagree.
  `ui2api requirements` reports it as a first-class check.

## Environment knobs (runtime/browser.ts)

- `UI2API_HEADED=1` — headed browser (needs a display; use Xvfb headlessly).
- `UI2API_CHROME=1` / `UI2API_CHROME_PATH` — use **real Chrome**, not bundled
  Chromium. REQUIRED for anti-bot-sensitive sites (Tencent, see below).
- `UI2API_USER_DATA_DIR` (alias `UI2API_CHROME_PROFILE_PATH`) — reuse the
  user's real Chrome profile. Note: cannot launch a second process on a
  profile already locked by a running Chrome.
- `UI2API_ATTACH_PORT=9222` — attach to an already-running Chrome
  (`google-chrome --remote-debugging-port=9222`) instead of launching.
- `UI2API_POOL_MIN` — warm browser pool size (promptd).
- `UI2API_LLM_*` — optional LLM for `--llm` mapper (not required to run).

Bench rule: **every browser launch must go through `launchBrowser()`** in
`src/runtime/browser.ts` (single seam for headless/headed/chrome/attach
resolution + stealth posture). Never `launch()` a browser ad-hoc.

### Environment knobs — the full `UI2API_*` surface (GOAL 94)

Every knob the code reads, machine-pinned against the shipped docs (a knob added
to the code without a doc row fails the suite). Purpose and default are as read at
the source site named in the last column. Rows marked **TRUST** weaken the daemon's
trust posture — read them before deploying.

**The `read at` column is "where to look FIRST", not the only place.** A knob read in
several places cites its most authoritative site (usually the launch seam, the daemon
gate, or the export that names it) and the purpose column says how many sites there
are, so you are never left believing a second reader does not exist. A knob read
INDIRECTLY through an exported name constant (`export const X_ENV = "UI2API_Y"`, read
back as `process.env[X_ENV]`) cites the **name** line and the purpose column names the
read line — that is the only place the literal appears. **What is pinned hard is the
FILE**: the cited file must exist and actually contain the knob, which is the defect class
a reader can act on. Line-exactness is re-measured as a **disclosed count that must not
regress**, not a `line ===` gate: while this table was being corrected, an unrelated edit
to `src/prompt/http.ts` moved three of its cited lines in under ten minutes with no change
to any knob. A pin that fires on that teaches the next maintainer to skip the file, which
is the failure mode AGENTS.md itself warns about. `test/ci-contract-knob-cites.test.ts`
holds both halves — the file pin is fatal, the drift count is measured and disclosed.
At this fold, measured: **62 rows, 62/62 file-correct, 0 wrong-file, 0 bare-path cells,
0 rows for a knob nothing reads, and every knob read in `src/`+`scripts/` has a row.**

| knob | purpose | default | read at |
| --- | --- | --- | --- |
| `UI2API_ACCOUNT` | runtime knob (generated ACP/MCP servers pick the vault account) | — | `src/generator/acp-template.ts:59` |
| `UI2API_AI_PROFILE` | **DEAD — nothing reads it.** The header once named this as the override knob; the working one is `UI2API_AI_SITE` (GOAL 63). Listed so a reader who meets the name in git history is told it does nothing; the cite below is the comment that records its death | — | `src/profile/profile.ts:15` |
| `UI2API_AI_SITE` | the working override knob: a builtin site id OR a `*.json` profile path | — | `src/profile/profile.ts:462` |
| `UI2API_ATTACH_MAX_BYTES` | **TRUST** max bytes a file-upload may read (GOAL 88 gate); the name const, the real read is `file-attach.ts:227`-style via `[ATTACH_MAX_BYTES_ENV]` | 20 MiB | `src/runtime/file-attach.ts:54` |
| `UI2API_DAEMON_PORT` | the persistent Chrome daemon's CDP port (the target `chrome start` opens and `chrome status` reports); name const, read at `chrome-daemon.ts:119`/`:226` | `9222` | `src/runtime/chrome-daemon.ts:29` |
| `UI2API_CHROME_DAEMON_STATE` | where the daemon records its `{port,pid,user,profile}` state (0600); name const, read at `chrome-daemon.ts:53` | `<data>/chrome-daemon.json` | `src/runtime/chrome-daemon.ts:30` |
| `UI2API_ATTACH_PORT` | **TRUST** attach to an already-running Chrome instead of launching one; 12 read sites, this is the launch seam's resolver | — | `src/runtime/browser.ts:166` |
| `UI2API_ATTACH_ROOTS` | **TRUST** dirs a file-upload path may be read from (GOAL 88 gate); name const, real read at `file-attach.ts:227` | none = path form refused | `src/runtime/file-attach.ts:52` |
| `UI2API_AUTH_STATE_PATH` | runtime knob (the `WIGOLO_*` name wins when both are set) | — | `src/runtime/wigolo.ts:268` |
| `UI2API_BASE_URL` | base URL for the served API (emitted into the generated PHP client) | — | `src/generator/lang-php.ts:586` |
| `UI2API_CDP_URL` | runtime knob (the `WIGOLO_*` name wins when both are set) | — | `src/runtime/wigolo.ts:267` |
| `UI2API_DEFAULT_MIN_INTERVAL_MS` | per-site pacing floor in ms: how long a SITE must be idle before the next request to it is sent. **On by default (1500)** — a free pool slot is not permission to send, because an agent integrating against `/v1` is exactly the caller that would hammer, and a challenge on a real account is unrecoverable. Malformed config falls through to this default rather than disabling the limit | `1500` | `src/prompt/pool.ts` |
| `UI2API_SITE_MIN_INTERVAL_MS` | per-site pacing overrides as a JSON object keyed by site id, e.g. `{"kimi":4000,"deepseek":4000}` — tunable WITHOUT a code change. An unlisted site falls back to the default rather than inheriting another site's number; a malformed object fails SAFE to the default | — | `src/prompt/pool.ts` |
| `UI2API_CHROME_OWNER_PROFILE` | allow the launch seam to use the chrome owner's profile even when the process is NOT that user | off (the profile is 0700 + locked; a non-owner normally cannot use it) | `src/runtime/browser.ts:62` |
| `UI2API_CHROME_USER` | **the dedicated Linux user that owns the Chrome we drive** — the point of use. Your interactive browser CANNOT be driven (Chrome refuses); this user's Chrome works, headless included. Its profile is auto-resolved from that user's `~/.config`. Name const, real read at `chrome-owner.ts:79` | `ui2api` | `src/runtime/chrome-owner.ts:35` |
| `UI2API_CHROME` | use real Chrome rather than bundled Chromium | — | `src/runtime/browser.ts:25` |
| `UI2API_CHROME_NO_SANDBOX` | **TRUST** run Chrome without its sandbox | off | `src/runtime/browser.ts:410` |
| `UI2API_CHROME_PATH` | explicit Chrome/Chromium executable path; 9 read sites, this is the launch seam's resolver | — | `src/runtime/browser.ts:26` |
| `UI2API_CHROME_PROFILE_PATH` | alias of `UI2API_USER_DATA_DIR`; 5 read sites, this is the launch seam's resolver | — | `src/runtime/browser.ts:35` |
| `UI2API_CHROME_STDERR` | surface Chrome stderr | off | `src/runtime/browser.ts:445` |
| `UI2API_DATA_DIR` | the sessions/vault dir; 30 read sites, this is the driver's `resolveDataDir()` | — | `src/prompt/driver.ts:841` |
| `UI2API_DATA_DIR_OVERRIDE` | override the data/sessions dir (read after `UI2API_DATA_DIR` at every `resolveDataDir()`) | — | `src/prompt/driver.ts:841` |
| `UI2API_DEBUG` | debug logging; 5 read sites across the driver/daemon/pool | off | `src/prompt/driver.ts:381` |
| `UI2API_ENGINE` | plugin engine (`native` or another); `--engine` overwrites it | `native` | `src/plugin/context.ts:21` |
| `UI2API_HEADED` | headed browser; 4 read sites, this is the posture report's resolver (`posture.ts`), and it is what `launchBrowser` falls back through | — | `src/prompt/posture.ts:66` |
| `UI2API_HUB_BIND` | **TRUST** host the hub binds; loopback (`127.0.0.1`) by default because the package inventory is LAN-visible on a wider bind | `127.0.0.1` | `src/hub/server.ts:19` |
| `UI2API_WIGOLO_ALLOW_REMOTE_TOKEN` | **TRUST** additionally allow `WIGOLO_API_TOKEN` to be sent to a NON-loopback wigolo daemon. Separate from `UI2API_WIGOLO_ALLOW_REMOTE` on purpose: allowing the traffic out is not the same decision as handing over the credential | off | `src/runtime/wigolo.ts:376` |
| `UI2API_WIGOLO_ALLOW_REMOTE` | **TRUST** allow the wigolo daemon base to be a NON-loopback host (and a non-loopback CDP endpoint); without it a non-loopback base is refused so `WIGOLO_API_TOKEN` is never sent off-loopback. Name const, real read at `wigolo.ts:115` | off | `src/runtime/wigolo.ts:109` |
| `UI2API_HUB_AUTHOR` | hub author for publishes | — | `src/cli.ts:498` |
| `UI2API_HUB_HOST` | hub host | — | `src/cli.ts:1321` |
| `UI2API_HUB_TOKEN` | runtime knob (publish + hub run) | — | `src/cli.ts:507` |
| `UI2API_HUB_URL` | hub endpoint | — | `src/cli.ts:506` |
| `UI2API_HUB_USE` | use the hosted hub | — | `src/cli.ts:499` |
| `UI2API_INGEST_LEVELDB` | session ingest level; `=0` skips localStorage entirely | — | `src/runtime/profile-ingest.ts:409` |
| `UI2API_INFRA_ADDRESSES` | **TRUST** the author's own infrastructure addresses, comma- or space-separated, consumed by the publication sanitizer (`scripts/ci/make-public-repo.sh`): they extend the infra scan, the blob redaction, the commit-message redaction and the coverage gate in `test/brain-publication-gate.test.ts`. **It exists because this repository publishes itself** — the addresses cannot be written in the code that publishes them, since `scripts/ci/*` and the gates ship inside the public copy. MEASURED 2026-10-01: both files carried them and the infra class measured `pub=7` against its own tooling. Lives in masked CI config, GitLab only, because GitLab is the publishing actor. **Unset is a real and weaker state**: the scan then covers private RANGES only (RFC1918 + the 100.64/10 range Tailscale uses), which is printed by the script and skips the census with a named reason rather than passing quietly. GitLab refused `masked: true` for a value shaped like IP addresses, so it is stored unmasked; the value never reaches a log, only counts do. | — | `scripts/ci/make-public-repo.sh` |
| `UI2API_LIGHT` | lightweight mode (off when `=0`) | on | `src/prompt/driver.ts:849` |
| `UI2API_LLM_BASE_URL` | runtime knob (optional `--llm` mapper LLM) | — | `src/mapper/llm.ts:12` |
| `UI2API_LLM_KEY` | runtime knob (optional `--llm` mapper LLM) | — | `src/mapper/llm.ts:9` |
| `UI2API_LLM_MODEL` | runtime knob (optional `--llm` mapper LLM) | — | `src/mapper/llm.ts:14` |
| `UI2API_LLM_PROVIDER` | runtime knob (optional `--llm` mapper LLM) | — | `src/mapper/llm.ts:8` |
| `UI2API_OS_USER` | OS user for session paths | — | `scripts/ops/launch-ui2api-chrome.sh:8` |
| `UI2API_POOL_MAX` | warm-pool page cap | — | `src/prompt/pool.ts:210` |
| `UI2API_POOL_MAX_WAITERS` | warm-pool queue cap | — | `src/prompt/pool.ts:246` |
| `UI2API_POOL_MIN` | warm-pool size (promptd) | — | `src/prompt/pool.ts:242` |
| `UI2API_POOL_WAITER_TIMEOUT_MS` | how long a queued request waits | — | `src/prompt/pool.ts:247` |
| `UI2API_PROMPTD_PORT` | promptd port | — | `src/cli.ts:608` |
| `UI2API_PROMPTD_TOKEN` | bearer token gating the daemon; 3 read sites, this is the server's own gate | — | `src/prompt/http.ts:531` |
| `UI2API_REAPER_INTERVAL_MS` | idle-page reaper interval (`0` disables it) | — | `src/prompt/pool.ts:248` |
| `UI2API_REGISTRY_REPO` | registry repo to install from | — | `src/hub/mirror.ts:28` |
| `UI2API_REGISTRY_URL` | runtime knob; 4 read sites, this is the smoke path's resolver | — | `src/prompt/smoke.ts:137` |
| `UI2API_REQUEST_LOG` | enable the bounded in-memory request log (a ring, hard-capped) | — | `src/prompt/http.ts:210` |
| `UI2API_REQUEST_TIMEOUT_MS` | aggregate daemon deadline for one request | — | `src/prompt/http.ts:325` |
| `UI2API_SHUTDOWN_GRACE_MS` | grace period for in-flight work on shutdown | — | `src/prompt/http.ts:1108` |
| `UI2API_SINGLE_PROCESS` | **TRUST** run single-process (no pool isolation) | — | `src/runtime/browser.ts:102` |
| `UI2API_TIMEOUT` | runtime knob (one round trip, in the generated PHP client) | — | `src/generator/lang-php.ts:592` |
| `UI2API_TOKEN` | **TRUST** bearer token gating the daemon (unset = localhost-only) | unset = localhost-only | `src/generator/lang-php.ts:589` |
| `UI2API_TRUST` | trust posture (what the daemon will attach/replay) | — | `src/generator/generate.ts:41` |
| `UI2API_USER` | runtime knob (`xhost` capture user) | — | `src/runtime/xhost-capture.ts:109` |
| `UI2API_USER_DATA_DIR` | **TRUST** reuse the user's real Chrome profile; 6 read sites, this is the launch seam's resolver | — | `src/runtime/browser.ts:35` |
| `UI2API_VERIFY_SITE` | verify a site | — | `scripts/live-verify-js-exec.ts:164` |
| `UI2API_VERSION` | **NOT AN ENV KNOB — a local `const` in the packager that reads `package.json`.** Listed because the name reads like a knob; there is no `UI2API_VERSION` environment variable | — | `src/registry/package.ts:8` |
| `UI2API_WIGOLO_` | family prefix; every member has its own row below | — | `src/runtime/wigolo.ts:109` |
| `UI2API_WIGOLO_AUTOSTART` | runtime knob (`=0` refuses to autostart the wigolo daemon) | — | `src/runtime/wigolo.ts:320` |
| `UI2API_WIGOLO_USE_AUTH` | runtime knob (`=0` drops the wigolo auth requirement) | — | `src/plugin/wigolo-context.ts:125` |
| `UI2API_XVFB_DISPLAY` | the virtual-display number provisioning starts `Xvfb` on, and the `DISPLAY` both generated systemd units run under. **A display is what makes `UI2API_HEADED=1` true** — see "HEADLESS IS WHAT GETS US BLOCKED" above | `99` | `scripts/ops/provision-ui2api-user.sh:27` |

## Site status (2026-09-19)

- **Default chat set** (`defaultChatProfiles()`, `src/prompt/registry.ts`,
  GOAL 30 + GOAL 32 truth-gate): **22 ids, measured 2026-09-27** — the builtin
  profile catalog (gemini, chatgpt, claude, copilot, perplexity, huggingchat,
  deepseek, kimi, tencent-aistudio, + more) merged with every installed
  **driveable** chat-shaped package whose composer/answer selectors parse under
  Playwright's own selector grammar (t3chat's former prose rows refused;
  duckduckgo, poe, grok, …); dormant/dead-end packages (zenmux parked origin,
  xiaomimimo DNS dead-end) are EXCLUDED from the chat surface until
  live-verified but stay fully served on /registry + /capability/<id> with their
  honest metadata status; every surfaced packaged id carries its status
  (`verified` / `unverified-candidate`) on GET /sites + `prompt --sites`;
  capability-only packages (gmail/youtube/araprat/…) never become chat models.
  **Do not trust this number — derive it** (it has already moved 25 → 23 → 22
  as gates tightened): `npx tsx src/cli.ts prompt --sites`, or
  `curl -s http://127.0.0.1:9797/v1/models | jq -r '.data[].id'`, both print the
  live surface. **The 10/12 builtin-vs-packaged split must ALSO be derived, never
  hand-typed** — hand-typing it is exactly how an older revision of this file came
  to claim "11 builtins":
  ```bash
  npx tsx -e '
    import { defaultChatProfiles } from "./src/prompt/registry.ts";
    import { BUILTIN_PROFILES } from "./src/profile/profile.ts";
    const chat = defaultChatProfiles().map(p => p.id), keys = Object.keys(BUILTIN_PROFILES);
    console.log(chat.length, "= builtin", chat.filter(i => keys.includes(i)).length,
      "+ packaged", chat.filter(i => !keys.includes(i)).length);
    console.log("BUILTIN_PROFILES:", keys.length, "| not surfaced:", keys.filter(k => !chat.includes(k)).join(" "));
  '
  # 22 = builtin 10 + packaged 12
  # BUILTIN_PROFILES: 11 | not surfaced: google-ai-search
  ```
  The split is **10 + 12, not 11 + 11**: `BUILTIN_PROFILES` holds 11 keys but only
  10 are surfaced as chat models. **GOAL 147 dropped `google-ai-search`
  (23 → 22):** its profile is
  composer-less, its manifest declares no `*_chat` capability, and its runner is
  a `loginGatedResult(...)` short-circuit — it was advertised as a chat model
  with no chat tool behind it. It is NOT removed: it stays fully served as a
  capability package on `/registry` + `POST /capability/google-ai-search`, and an
  explicit `--site google-ai-search` still resolves.
- **Session-locked + live-verified round-trips**:
  - `deepseek` (chat.deepseek.com) — localStorage `userToken` Bearer auth;
    AWS WAF + PoW; verified answering (proof PASS 11462, 2026-09-19). Full
    surface verified: `deepseek_reasoner` + `deepseek_web_search` are REAL
    composer toggles (`div.ds-toggle-button:has-text("DeepThink"/"Search")`,
    state class `ds-toggle-button--selected`) feeding `thinking_enabled` /
    `search_enabled`; `deepseek_list_conversations` reads sidebar
    `a[href*='/chat/']` (both `/chat/<id>` and `/a/chat/s/<uuid>` shapes).
  - `kimi` (www.kimi.ai) — localStorage `access_token` Bearer on
    notilo.kimi.com/apiv2; verified answering (proof PASS 13965, 2026-09-19).
    **Selector gotcha**: the driver picks the LONGEST matching element text,
    and Kimi's thinking block also matches `.markdown` — the answer selector
    `.toolcall-rollup__part:has(+ .toolcall-rollup__tail) > .markdown-container > .markdown`
    exists specifically to exclude thinking. Full surface verified:
    `kimi_list_conversations` (sidebar `a.next-sidebar-history-item__link`),
    `kimi_model_list` (`[data-testid="model-select-trigger"]` →
    `button.model-item`), `kimi_web_search` (toolkit
    `[data-testid="toolkit-trigger-btn"]` → `button.toolkit-item`), and
    `kimi_file_upload` (`label.toolkit-item` wrapping hidden
    `input[type="file"]` — use `setInputFiles`, filechooser never fires).
  - `gemini` (gemini.google.com) — verified earlier; do not re-capture.
    **GOAL 53 (2026-09-25)**: `gemini_file_upload` WIRED — file/image attach via the
    composer's real hidden `input[type='file']` (kimi/duckduckgo live-verified
    setInputFiles pattern; the site's own JS uploads, nothing synthetic). Honest
    unverified-candidate: all stored gemini sources replay signed-out (Google auth
    browser-bound) — `ok:true` = input accepted, NOT a live upload claim; verify the
    chip from a live signed-in Chrome (the dedicated owner's, or UI2API_ATTACH_PORT)
    before treating
    upload as verified.
- **Suite gates (2026-09-21, fold #11)**: full suite now measured **418/418**.
  The two wigolo-engine infra gates (chromium warmup on ubuntu26.04-x64) CLOSED by
  aligning the wigolo clone's playwright 1.60→1.61: build 1228 is already present
  on the box (`~/.cache/ms-playwright/chromium-1228`), so `chromium.executablePath()`
  resolves to a real installed binary — genuine daemon browser launch, not a fabricated
  green. promptd on 127.0.0.1:9797 must be restarted with CURRENT code after wiring
  changes (a stale daemon predates new `/capability/*` routes and 404s them while
  `/registry` still looks live — a lost-direction symptom; kill + `tsx src/cli.ts promptd`).
  LIVE studio re-verification 2026-09-21 through the wire: `youtube_search`
  ok:true 10 rows, `araprat_search` ok:true 30 rows; posting recipes stay honest
  login-gated ok:false — never a fabricated post.
- **Session-locked + chat verified (headed/real-Chrome only)**: `tencent-aistudio`
  (aistudio.tencent.ai). Cookies verified (`hunyuan_token`/`hunyuan_user`/
  `hunyuan_source` on `.tencent.ai`); **Tencent Cloud EdgeOne blocks headless
  Chromium (HTTP 567) — headed / real-profile ONLY** (mirrors
  `capabilities/hunyuan`). Chat round-trip VERIFIED (proof PASS 6916, 2026-09-19):
  composer `textarea.t-textarea__inner` ("Ask me anything"), answer
  `.agent-chat__bubble--ai .hyc-content-md` → `.hyc-common-markdown`, completion
  marker "Completed". Cold-boot gotcha: sends typed before ~5–8s are silently
  dropped — `preComposeDelayMs: 8000` in the profile. Runner wired
  (`src/capabilities/tencent-aistudio.ts` + `/capability/tencent-aistudio`);
  **conversation list + open LIVE-VERIFIED 2026-09-23** (History → `/chat-history`
  renders the user's real dated conversation list as `div.list-item` rows —
  title/model/type; row click navigates into `/chat/HunyuanDefault/<id>?from=history`;
  ids are click-only, rows are divs, not anchors; rename/delete DOM NOT located).
  Chat re-verified 2026-09-23 through the wire (proof "415"). Remaining
  capabilities measured live 2026-09-23 → HONEST BLOCKED with measured reasons:
  web_search / deep_think toggles do NOT exist on the current Hy4 preview
  composer (no 搜索/联网, no deep-think switch; deep-think OUTPUT renders —
  "Deep thinking completed（Ran for …s）" — but there is no toggle to expose);
  no `input[type=file]`/attach for file_upload; `/image /code /tts /podcast
  /translate` are dead routes; image surface = separate `hy3d.tencent.ai` app
  (never claim verified without a live round-trip).
- **Walled / scaffold / dead-end** inventory lives in `capabilities/README.md`
  (poe, grok, perplexity, t3chat, blackbox, adapta, zenmux, …). Be honest about
  status: never claim a capability is verified without a live round-trip.
- **Scaffold→VERIFIED (live round-trips 2026-09-20, attached real Chrome/152)**:
  `youtube` (www.youtube.com) — capability surface, NOT a chat site.
  `youtube_search` **VERIFIED** (search→`ytd-video-renderer a#video-title`
  read-back, live proof 10 rows; manifest verified-2026-09-20);
  `youtube_transcript` **UI path verified, segments LOGIN-GATED** — panel
  expands but the site's own `get_transcript` endpoint answers HTTP 400
  "Precondition check failed" without SAPISID (needs a logged-in capture;
  honest partial, never claimed verified). Auth optional-cookie.
  **2026-09-21: POSTING surface implemented + dispatched** —
  `youtube_comment`/`youtube_like`/`youtube_subscribe`/`youtube_upload`/
  `youtube_playlist_add` on `/capability/youtube` (were "unknown youtube
  capability"); runner `openPage()` gained a vault-account ladder
  (`data/sessions/<host>/<slug>/` first, then legacy flat snapshot, then cookie
  file). **MEASURED login-bound**: a real account vault exists on the box
  (data/sessions/youtube.com/merezarezaei@gmail.com/, source=import) but
  Google auth cookies are **browser-bound** (app-bound encryption) — replaying
  the vault OR the real Chrome profile copy into fresh ephemeral contexts
  renders anonymous AND trips YouTube's "Sign in to confirm you're not a bot".
  Posting therefore needs the **user's own real Chrome attached**
  (the dedicated Chrome owner's live profile, or `UI2API_ATTACH_PORT`), exactly like
  `tencent-aistudio`;
  never fabricate a post until a real attached session proves the flip.
  **`araprat`** = Aparat (www.aparat.com, Persian video platform; "araprat"
  resolved via web search) — NOT a chat site; the manifest declares 9
  capabilities, of which **3 verified** and 6 honestly login-gated. The 3
  **VERIFIED**: `araprat_search` (`input[name="search"]` → `/search/<q>` grid
  `a[href*='/v/']`, dedupe double-anchored cards; live 'موزیک' → 30 deduped),
  `araprat_trending` (homepage `/home`, 52 `/v/` anchors), `araprat_video_detail`
  (`h1` + `div.description` + related `a[href*='/v/']`; og:/twitter: metas are
  DEAD on this SPA — do not rely on them). Hydration: wait for
  `a[href*='/v/']`, h1 lands ~3.5s before desc/related.

- **Full-surface audit fold #17f (2026-09-22, done)** — per-site status after
  double-check + code-audit (details in `.brain/verbatim-goals.md` GOAL 6):
  - **WORKS LIVE (re-verified this fold through the wire/attach)**: `gemini`
    (vault, PONG), `deepseek` (vault, PONG), `kimi` (vault, PONG),
    `tencent-aistudio` (headed .tencent.ai cookie session — the refreshed
    ui2api copy-Chrome profile carries hunyuan_token/user/source), `youtube_search`
    (ok:true rows), `araprat_search`/`araprat_trending`/`araprat_video_detail`
    (ok:true).
  - **FULL-SURFACE VERIFIED (GOAL 15, 2026-09-23, headed Xvfb ALL_OK=true)**:
    `duckduckgo` (duck.ai, anonymous) ALL SIX caps live-verified through the real
    runner (was 5 wire-mapped/DOM-unverified): `duckduckgo_chat` (answer reads
    `[id*="assistant-message"]`, first-send consent wall handled),
    `duckduckgo_model_picker` (composer chip → menu `[role='menuitemradio']`
    rows testid `model-picker-row-<id>`, aria-checked), `duckduckgo_web_search`
    (Tools → Web Search row → chip `button[aria-label='Remove Web Search']`
    read-back; enable+disable; chat after enable carried a REAL WebSearch
    tool-invocation, 5 citations in IDB), `duckduckgo_file_upload`
    (setInputFiles on composer `input[type='file']`, accept-list enforced →
    chip read-back), `duckduckgo_reasoning` (reasoning-mode button text flip;
    'extended' honestly ok:false — not offered on free GPT-5.6 Luna),
    `duckduckgo_chat_history` (real IndexedDB `savedAIChatData`
    saved-chats/pre-canonical-chats + sidebar corroboration; string-evaluate
    fixes the swc `__name` crash — named arrows inside page.evaluate hang-or-crash,
    keep evaluate code as strings). Dispatch test runner added: 581/581 green.
  - **HONEST dead-end (never claimed verified)**: `hunyuan` = yuanbao.tencent.com
    has NO session ANYWHERE on this box (not in real me-Chrome, not in the
    copy) — hy_user/hy_token are domain cookies the user has never generated.
    The Tencent AI surface the user means is aistudio.tencent.ai (VERIFIED,
    and its HunyuanDefault chat already serves modelId=hy4-preview-g).
    `google-ai-search` stays BLOCKED on portal v20 (external sign-in required).
  - **Audit fixes shipped**: `test/capability-dispatch.test.ts` RUNNERS now
    include `youtube` + `araprat` (14 dispatch runners, IN-SYNC manifest↔dispatch —
    hard-enforced since GOAL 79 — was 10, these two live-verified runners were
    outside the suite);
    `src/capabilities/araprat.ts` + manifest now dispatch the 6 posting caps
    HONESTLY as login-gated (ok:false loginGated:true, no browser) so they no
    longer fall into the dead "unknown" branch; suite 430/430.
  - **Multi-account surfaces live-verified (GOAL 8, 2026-09-22)**: `account` param
    on `POST /capability/<site>` + `POST /prompt` (vault-validated pre-browser),
    `GET /accounts?site=`, registry `accounts[]` — **and `profile add-all`
    one-command bulk login live-verified (GOAL 9, 2026-09-22)** (read-back
    verdict table, zero temp residue; replaces the per-host import loop).

## Conventions & red lines

- **Never commit `data/`**, `.agents/`, `.opencode/`, `sites/*/server/` (see
  `.gitignore`). Session snapshots contain real credentials.
- **Origin pinning / SSRF guards** live in `src/runtime/ssrf.ts` — endpoints
  only serve configured sites, never arbitrary URLs.
- **Trust gate** (`src/prompt/http.ts` + `src/runtime/ssrf.ts`): the daemon
  binds `127.0.0.1` by default and answers ONLY the profiles handed to it at
  startup (`idFrom`/`profilesById`, `src/prompt/http.ts` — unknown site →
  400), never arbitrary URLs; optionally bearer-token gated via
  `UI2API_PROMPTD_TOKEN` (no token set = localhost-only posture, README's
  "optionally bearer-token gated").
- **Verification before claiming done**: `npm ci` (the lockfile install both CI
  configs run as their first step — `.github/workflows/ci.yml`,
  `.gitlab-ci.yml`; a missing/rotten `node_modules` otherwise explains a local
  failure CI never sees), `npx tsc --noEmit`, `npm run build`,
  **`npm run typecheck`** (GOAL 147 — the TEST tree, `tsconfig.test.json`, which
  `npm run build` does not compile; both CI configs run it, so omitting it here is
  how a pipeline step gets "removed" by accident), `npm test`, `npm run test:unit`,
  plus the verbatim-corpus completeness gate
  `npm run check:verbatim` (+ `npm run check:verbatim:goals` for the goals-index
  citations) — the standing P1..P5 verifier (`scripts/verify-verbatim-index.mjs`,
  GOAL 74/75) must pass on every flip: every user block has exactly its Index
  row (global + per-date equality), every row resolves to a real archive marker
  and is its block's own words, rows are chronological, and every T-stamped
  `- verbatim:` citation in `.brain/verbatim-goals.md` resolves. Package +
  runner sync is enforced by `test/capability-dispatch.test.ts` and package
  shape by `test/validate-packages.test.ts`.
  **No suite total is claimed here, and that is deliberate (GOAL 110).** The
  per-file case counts of those two gates are *runtime-only* facts — the
  files hold 3 and 2 literal `test(`/`it(` calls and generate the rest from
  `for` loops, so a hand-typed "(28/28)"-style total is unverifiable and can
  only rot silently (a loop that stops early keeps the file green while the
  number lies). Get the truth from the run, never from prose:
  `npm run test:unit` prints the real `# tests` / `# suites` in its last
  lines, and the FULL suite is CI's lane (`.github/workflows/ci.yml`,
  ubuntu-24.04, 30-min cap) — see below. What IS machine-derived is pinned:
  `test/doc-numbers-truth.test.ts` computes the `test:unit` file count from
  `package.json` and the `N/N` ratios below from the code, and fails if this
  file disagrees. Dated fold-log counts (418/418 at fold #11, 430/430 at fold
  #17f, 863/44 at GOALs 83-87, 900/48 → 908/40 → 911/42 → 914/44 mid-fold)
  are **history, not current totals** — kept as the dated record of what a
  run actually printed at that fold, and are never to be read as today's
  number. The 2026-09-25 full-suite run was re-confirmed under real load (box
  load 11.3 with 4-9 sibling-project phpunit processes running — 0 fail,
  EXIT=0), which is the actual proof
  that the concurrency bound works rather than a lucky idle run. 10 sleep+
  recheck cycles watching the box: load 26 -> 10 but never fully quiet, because
  those sibling suites cycle on their own; measuring under load is the honest
  answer, and it is green. GOALs 88-90 + 91
  files: attach-gate 26, vault-integrity 9, error-contract 2, lang-php 8.
  Those four per-file counts are likewise runtime facts, read off that dated
  run — not live claims.
  The two counted-test warts are CLOSED, not flagged: error-contract and
  lang-php both ran their assertions inside `describe` bodies and reported
  `tests 0` — they DID gate (a throw fails the run) but were invisible to
  the total, so the count was quietly under-reporting real coverage. Both
  are now real top-level sub-tests, which is why `suites` fell 48 -> 40
  (node counts a `describe` as a suite; those 8 describe-bodies became 8
  tests). Rule for new pins: assert inside a real `test(...)`, never in a
  bare `describe` body — a pin nobody counts is a pin nobody reads.
  `test:unit` is now `--test-concurrency=4 --test-timeout=120000` (GOAL 102: every exec-family subprocess/network call in `test/**` is timeout-bounded and every spawned CLI child gets a bounded SIGKILL, so a hang is a NAMED failure instead of a silent file-level drop — measured: a run that hung 900-1800s now finishes in ~61s and immediately surfaced a real error). The FULL suite is CI's lane (`.github/workflows/ci.yml`, ubuntu-24.04, 30-min cap) and is NOT run on this shared box; local verification is per-file and bounded.: unbounded 57-way parallelism let
  each of 16 workers spawn its own esbuild/tsx subprocess, and the box hit
  `ERR_WORKER_INIT_FAILED`/`EAGAIN`, which surfaced as ~12 spurious file-level
  failures (the "suite hangs" symptom). If you see a mass failure burst, check
  the box for foreign load before suspecting the code.
- **Readiness checks are never fabricated**: `ui2api requirements` (GOAL 33,
  `src/runtime/requirements.ts`) only reports verdicts a real check can stand
  behind — every check runs for real (execute-only probes; a check that cannot
  run reports `not-ready`/`on-hold` + the NAMED reason, never a guessed
  verdict), and the checker itself NEVER launches a browser (chrome = the
  `resolveChromeExec` ladder + a `chrome --version` execute-only probe;
  attach = a short HTTP GET to an already-running Chrome's CDP endpoint;
  sessions = vault reads only). Capture age is surfaced honestly in the same
  gate (GOAL 39): every vault-backed package prints `captured <date> (N days
  ago)`, and a session older than the `SESSION_STALE_DAYS` risk threshold (14)
  gets a `⚠ stale` warn with the re-capture instruction — age ≠ expiry, so the
  flag never changes the ready/working verdict (site-dependent lifetimes).
- **Session writes are never fabricated either** (GOAL 49): every capture,
  ingest, and import path runs the WRITE truth gate (`snapshotHasAuth`,
  `src/runtime/session-store.ts`) — a snapshot with ZERO cookies AND ZERO
  localStorage for the target host is REFUSED at the write seam with a named
  `skipped-no-auth (nothing to save)` verdict (nothing written to the vault,
  never listed in `/accounts`, `cmdProfileIngest` exits nonzero). The
  "logged-in session — chat history persists" claim only prints for a usable
  snapshot, so the vault, the account guard, and the requirements age gate can
  never surface an anonymous session as fresh + valid. Decrypt-limited partials
  (cookies matched but undecryptable) keep their honest warning — they are a
  real logged-in session, not the anonymous class this gate kills.
- **Package installs are write-gated too** (GOAL 65): `ui2api install`
  (`src/registry/install.ts`) validates the WHOLE fetched package BEFORE any
  file lands on disk — every fetched JSON file must parse (corrupt
  metadata/profile/session.lock/recipe refuses naming the file), every manifest
  capability entry passes `validManifestCapability` (the GOAL 61 read-side
  filter, now also at the write seam — null/primitive/id-less entries refuse
  naming the index instead of silently landing to be dropped from /registry
  later), and profile.json passes `validatePackagedProfileShape` (GOAL 48/56
  shape) PLUS id agreement (profile.id must equal the package dir — a mismatch
  refuses naming file + both ids, the GOAL 64 shape). Any refusal throws with
  a named verdict and NOTHING is written (the write loop never runs, the dir
  never exists) — a broken package can no longer install "successfully" and
  be refused only later by the read/serve seams; same principle as the GOAL
  49/50 session-write gate, applied to packages. **Hub publishes are
  write-gated too** (GOAL 69): `PUT /api/packages` (`src/hub/api.ts`) + the
  uplink cache seam refuse with a named verdict and NOTHING written any module
  the runtime deterministically cannot serve (`validatePublishedModule`,
  `src/hub/module-gate.ts` — mirrors the runtime's own JSON-actions-vs-JS
  dispatch: empty/omitted module, json-without-actions, schema-invalid
  action-map, no-export JS text), so `{ok:true}` is never answered for an
  artifact that dies on first serve; a malformed publish body is a named 400,
  never a process crash (readJson's parse is no longer inside the EventEmitter
  callback), and a broken remote module is never cached by the uplink seam
  (honest 404 instead of cache-then-crash).
- **Restriction walls are reported, never blind-empty** (GOAL 54 + GOAL 55): every
  builtin chat profile declares `capability.restrictionMarkers` (11/11 — gemini/kimi/
  deepseek predated the gate; chatgpt/claude/copilot/perplexity/huggingchat/
  google-ai-search/hunyuan added, incl. the verbatim-named hy3 = tencent-aistudio
  with limit+login) AND every chat-shaped packaged `capabilities/<id>/profile.json`
  declares them too (14/14 — the served packaged surface: blackbox, codex,
  copilot-m365, duckduckgo, grok, inner-ai, manus, notion, poe, t3chat, v0, venice,
  plus dormant zenmux/xiaomimimo still served on /registry + /capability). The
  same driver + fingerprint seam consumes both: `src/prompt/driver.ts`
  `readRestrictions()` scans the page in-band and answers
  `doneReason:"restricted"` + the named hits instead of a blind empty answer;
  `src/runtime/capability-probe.ts` feeds the same markers into the per-account
  fingerprint's `restrictions[]`. Patterns are conservative and honest: a
  never-matching pattern is a silent miss, a false-positive wall report is what's
  forbidden (and the driver's `if (!answer)` gate means a marker can only surface
  when there is no answer — a real wall); coverage is pinned by
  `test/restriction-markers.test.ts` (builtin + packaged) so a future profile
  added without markers fails LOUD (suite, like the manifest↔dispatch drift gate).
- **The profile-shape and storage READ gates are complete** (GOAL 56/57/58/59/60):
  `--profile FILE` overrides AND packaged `profile.json` validate the GOAL 54/55
  `capability` block at load (GOAL 56 packaged + GOAL 57 override — a wrong-typed
  `restrictionMarkers`/picker/toggle refuses LOUD naming file+field instead of a
  late `matchRestrictionMarkers` for…of-undefined at answer time); stored
  capability fingerprints are never served malformed — `GET /capabilities?site=`
  answers `probed:false` + the NAMED reason + re-probe hint (GOAL 58,
  `validateCapabilityReportShape`); stored snapshots are shape-gated at the load
  seam — a wrong-shaped `state.json` (cookies string etc.) returns null like
  corrupt JSON instead of crashing `injectSnapshot`'s `.filter` mid-runner
  (GOAL 59, `validateSnapshotShape`, legacy absent-field snapshots still load);
  and the vault `accounts.json` index is per-entry gated — hostile slugs
  (`../../..`, numeric) are excluded so they are never listed on /accounts +
  /registry accounts[] and never escape the vault through
  `accountSnapshotPath`'s resolve() (GOAL 60, `validStoredAccount`); and the
  registry BUILD is crash-proofed — a malformed installed manifest capability
  entry (null / primitive / id-less) is filtered out per-entry
  (`validManifestCapability`) instead of TypeErro3ing the whole /registry for
  every consumer (GOAL 61). And the packaged-profile load seam enforces id
  AGREEMENT (GOAL 64): a `capabilities/<id>/profile.json` whose `id` mismatches
  the package it is resolved as refuses LOUD naming the file + both ids
  (`resolvePackagedProfileFile`'s opt-in `expectedId`, wired into
  `resolvePackagedProfile` + the `resolveProfile` packaged branch + all 32
  `/capability` fallbacks) — never a silent merge of the WRONG builtin base
  (`BUILTIN_PROFILES[raw.id]`) that self-identifies as the wrong site;
  /registry + chat surface exclude the mismatch like any other malformed
  install (GOAL 48), /capability + CLI refuse it. Every write
  seam still runs its own truth gate (GOAL 49/50) — the read seams refuse the
  same malformed classes at serve/load time.
- **Account-INDEX collisions are refused too** (GOAL 50): `saveAccountSnapshot`
  is gated by `slugCollision` (`src/runtime/session-store.ts`) — a same-slug
  DIFFERENT identity on one host is never silently overwritten (the old
  filter-replace destroyed the first account's index entry + snapshot with zero
  warning); all three write seams (capture/import/xhost) refuse with a named
  `slug-collision (NOT overwritten — account "<slug>" already exists as
  "<identity>")` verdict, nothing written, the original account intact. Same
  identity string = latest-wins re-capture, never a false positive; slugs are
  host-scoped, so an identical slug on two hosts is valid.
- **Account READs are exact too** (GOAL 51): `resolveStoredAccount`
  (`src/runtime/session-store.ts`) is the canonical reader — an account
  reference resolves ONLY on the exact stored identity or the exact stored
  slug (the form `/accounts` lists); NO slugify folding and no blind snapshot
  path load. A write-refused alias ("john  smith" when "John Smith" is stored)
  now 400s with the named `no stored account "<acct>" for "<host>"; available:
  [<slugs>]` from `resolveCapabilityAccount` (`src/prompt/http.ts`) and
  `GET /capabilities?site=&account=` — it never silently drives the survivor's
  session (the write gate and the read gate agree on the same key space).
- **Consumer surfaces can pick an account too** (GOAL 52): the daemon wire was
  never the only entry — the generated/plugin consumers now carry the same
  identity-keyed selector: the generated PHP client's
  `chat(..., ?string $account = null)` / `capability(..., ?string $account = null)`
  forward `account` into the /v1 and /capability payloads (only when set);
  generated ACP/MCP servers read `UI2API_ACCOUNT` (+ `UI2API_DATA_DIR`) into
  `BrowserSession`, whose `resolveSessionAccountSnapshot(dataDir, host, account)`
  resolves EXACTLY (GOAL 51 semantics — no first-account, no folding) and throws
  a NAMED error when the requested account is missing or snapshot-less;
  `ui2api plugin serve <module> --account SLUG|EMAIL` selects which vault account
  drives the plugin page. One user, several accounts — pick the one that drives
  the request everywhere.
- **Selector rot**: site UIs change. Re-tune via JSON profile override
  (`--profile FILE`), not by editing one-off probe scripts; keep probe scripts
  out of the repo (delete after use). Overrides are validated with the same
  truth gate packaged profiles pass for /registry (parseable selectors + chat
  shape, plus an explicit `send` shape check) — a typo'd key or wrong-typed
  composer/answer/send entry fails LOUD at load, naming the file and the exact
  offending field/entry (never a silent drop → late "no composer found"
  timeout, answer-join TypeError, or Enter-press send fallback). The override
  seam validates the `capability` block the same way the packaged seam does
  (GOAL 57, the GOAL 56 helper) — a wrong-typed `restrictionMarkers`/picker/
  toggle in a `--profile FILE` refuses LOUD at load, never a late
  matchRestrictionMarkers for…of-undefined crash at answer time. The seam also
  enforces id AGREEMENT (GOAL 62): `--site X --profile FILE` never silently
  drops the tuning document — a file whose id mismatches the requested site
  fails LOUD naming both sides (`resolveProfileWithOverride`); absent file.id
  tunes the requested site. Installed
  `capabilities/<id>/profile.json` runs the same gate on the packaged running
  seam (CLI packaged id + `/capability` fallbacks, GOAL 48) — a wrong-typed or
  unparseable entry fails LOUD at serve time, naming the file + exact
  field/entry (never a late `answer.join` TypeError inside a runner); GOAL 56
  extends that gate to the `capability` block GOAL 54/55 made first-class on
  the chat surface: `restrictionMarkers` (kind ⊆ {upgrade,limit,login} +
  non-empty string patterns), `tierSelectors`/`pickerOpen`/`pickerOption`
  (parseable selector lists), `abilityToggles` (id/selector/label/selectedClass)
  — a wrong-typed capability entry (e.g. a string `restrictionMarkers`) refuses
  LOUD naming file + field + entry instead of a late `matchRestrictionMarkers`
  `for…of undefined` TypeError at answer time; absent capability
  (capability-only packages, chatglm) keeps resolving.
  Well-typed
  empty/absent/host-keyed-object fields (capability-only packages, chatglm)
  keep resolving.
- **When adding a site**: analyze (static bundles + wire) → package under
  `capabilities/<id>/` (manifest/profile/recipes/session.lock/CAPABILITIES.md +
  `metadata.json`) → builtin profile entry → runner in `src/capabilities/` →
  wire `/capability/<id>` in http.ts → capture + lock → live-verify → update
  `capabilities/README.md` inventory + this file + README site list.

## Package layout (see capabilities/README.md)

`capabilities/<site-id>/manifest.json` (id, name, url, capabilities, auth,
transport, permissions), `profile.json` (ChatSiteProfile overrides),
`recipes/<capability>.json`, `session.lock.json` (snapshot hash + capture
date + source), `CAPABILITIES.md` (human-readable analysis deliverable —
the wire facts). Validation: `scripts/validate-registry.mjs` +
`test/validate-packages.test.ts`.