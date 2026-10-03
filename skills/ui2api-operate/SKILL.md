---
name: ui2api-operate
description: >-
  Use when starting, stopping, or diagnosing the ui2api daemon — running the
  readiness gate, bringing up the persistent Chrome daemon, checking posture,
  installing or wiring the generated MCP/ACP server into an agent runtime, or
  recovering from a site that answers with a challenge, a consent wall, or
  ERR_CHALLENGE instead of a reply. Also use when a headless browser produced
  ok:false and headfulness is suspected rather than the site.
---

# ui2api-operate

Running ui2api is mostly **posture**. The code path is usually right; the browser
is the lie. Read this before blaming a site.

**Derive live state; never trust a count in this file.** Derive the live surface
with `npx tsx src/cli.ts prompt --sites` or `GET /v1/models`.

## HEADLESS IS WHAT GETS US BLOCKED

Measured on one site, one request, changing **only** headfulness:

| browser | result |
| --- | --- |
| `--headless=new` | `ok:false` — abuse challenge, `ERR_CHALLENGE`, consent wall re-blocked |
| **headed Chrome on `Xvfb :99`** | `ok:true` — DOM-read answer, the site's own JS drove the real request |

A headless browser is a forgery and it fails *differently* from a plain bot, so
retrying never fixes it. The point of use is a **HEADED Chrome on a virtual
display** (`src/runtime/browser.ts`, `resolvedHeadless`).

`UI2API_HEADED=1` **without** a display is `headless-degraded` and is NOT a
substitute — the seam falls back to `--headless=new` and gets challenged again.
**Xvfb is what makes `UI2API_HEADED=1` true** (`src/prompt/posture.ts`).

## What do I run first

| step | command | do not skip because |
| --- | --- | --- |
| readiness | `npx tsx src/cli.ts requirements` | OS gate before any browser work; nonzero exit on any `not-ready` |
| chrome daemon | `DISPLAY=:99 npx tsx src/cli.ts chrome start` | never fire Chrome per request |
| posture | `curl -s 127.0.0.1:9797/status` | only honest proof the browser is the one you think |
| one real call | `npx tsx src/cli.ts prompt "ping" --site <id>` | one honest answer beats ten guesses |

Readiness (`src/runtime/requirements.ts`) is load-bearing: **every check runs for
real** (execute-only probes; a check that cannot run reports `not-ready`/`on-hold`
with a NAMED reason, never a guess) and **the checker NEVER launches a browser** —
it resolves the binary through the ladder and reads `chrome --version`. Verdict
vocabulary: `ready | working | on-hold | not-ready`.

## Daemon lifecycle

```bash
npx tsx src/cli.ts chrome status            # where is it, and the port to attach to
npx tsx src/cli.ts chrome start  [--headed] # idempotent — never fires a second Chrome
npx tsx src/cli.ts chrome stop   [--force]  # refuses to kill a Chrome we did not start
npx tsx src/cli.ts promptd --port 9797     # port default from UI2API_PROMPTD_PORT
```

`src/runtime/chrome-daemon.ts`:

- **start adopts.** Owner's Chrome live on *another* port ⇒
  `adopting the Chrome already running for <user> … not spawning another`, and it
  persists `origin: "adopted"`. Checking only our own port is exactly how a prior
  attempt wrongly concluded "nothing is running" and got refused by Chrome's
  one-instance-per-profile rule.
- **stop refuses.** `state.origin !== "spawned"` ⇒ `refusing to stop: this Chrome
  was ADOPTED, not started by ui2api`.

## Headed/Xvfb recovery — the common fix

```bash
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
DISPLAY=:99 UI2API_HEADED=1 npx tsx src/cli.ts chrome start   # NO --headless
DISPLAY=:99 UI2API_HEADED=1 npx tsx src/cli.ts promptd --port 9797
```

`DISPLAY=:99` must be on **both** the daemon and every process that launches a
browser. Prove it — `curl -s 127.0.0.1:9797/status` must show
`"headful": true, "headlessDegraded": false`. `headlessDegraded: true` means the
request for headful was refused by the environment and the run is worthless for a
sensitive site. For the persistent version, `scripts/ops/provision-ui2api-user.sh`
is idempotent and registers the `ui2api-xvfb`, `ui2api-chrome` and `ui2api-api`
units — it writes no unit file itself, it delegates to the single installer
`scripts/ops/install-services.sh`.

**The display number is not a knob.** `scripts/ops/units/ui2api-xvfb.service`
starts `Xvfb :99` in its `ExecStart`, and every shipped unit hardcodes
`Environment=DISPLAY=:99`; the installer copies those files verbatim
(`install -m 0644`, no template substitution anywhere). `UI2API_XVFB_DISPLAY` is
read into a shell variable at `scripts/ops/provision-ui2api-user.sh` and consumed
**only inside a printed message** — it is never substituted into a unit, so
setting it changes nothing that gets installed. To use a different display, edit
the unit files and re-run `scripts/ops/install-services.sh`.

## The chrome point of use is a DEDICATED LINUX USER

Not the operator's own browser. Chrome refuses another process attaching to a
browser a person is using, and refuses `--remote-debugging-port` on a live
profile. A wall, not a bug to engineer around.

- Owner is **data**: `UI2API_CHROME_USER`, default `ui2api`
  (`src/runtime/chrome-owner.ts`, `resolveChromeOwner` / `chromeOwnerStatus`).
- The only setup step in the world is that user's Chrome **profile existing**. Run
  Chrome as that user once, log in, the profile appears.
- That user's Chrome works headless included.
- A non-owner spawning its own browser is refused by name in
  `src/runtime/browser.ts` — orphaned Chrome processes were the real cost.

## Attach vs snapshot replay

`UI2API_ATTACH_PORT` attaches to an already-running Chrome instead of launching.

- **Replay a snapshot** when auth is a normal cookie/token:
  `capabilities/<id>/` + `session.lock.json`, injected into a fresh context.
- **Attach when auth is browser-bound** (app-bound encryption). Replaying the
  vault *or* a real profile copy into an ephemeral context renders **anonymous**
  and trips an anti-bot check. Attach to the owner's live Chrome; do not replay.

```bash
sudo -u ui2api -H google-chrome --remote-debugging-port=9222   # as the owner
UI2API_ATTACH_PORT=9222 npx tsx src/cli.ts promptd --port 9797
```

**Real Chrome, not bundled Chromium:** `UI2API_CHROME=1` / `UI2API_CHROME_PATH`.
Required for anti-bot-sensitive sites, and needed when a bundled build is missing
or wrong-version. Let `launchBrowser()`'s ladder resolve it; never hardcode a path.

## Trust posture

`src/prompt/http.ts`:

- Binds **`127.0.0.1`** by default.
- `UI2API_PROMPTD_TOKEN` is an **optional** bearer gate. Unset = localhost-only
  posture, not "unprotected". Set ⇒ every request needs
  `Authorization: Bearer <token>`; a mismatch is `401 {"error":"unauthorized"}`.
- **Profile allowlist.** The daemon answers only the profiles handed to it at
  startup (`profilesById`). An unknown site is refused, not served — there is no
  arbitrary-URL endpoint. Under an explicit site list an unlisted site is a `400`
  naming the allow-list.
- Origin pinning / SSRF guards: `src/runtime/ssrf.ts` (`sameOrigin`,
  `assertChannelUrl`) rebuild the URL from validated components; `page.goto()`
  never receives raw caller input.

Posture-weakening knobs, read before setting any: `UI2API_ATTACH_PORT`,
`UI2API_USER_DATA_DIR`, `UI2API_SINGLE_PROCESS`, `UI2API_CHROME_NO_SANDBOX`,
`UI2API_WIGOLO_ALLOW_REMOTE`, `UI2API_WIGOLO_ALLOW_REMOTE_TOKEN`,
`UI2API_HUB_BIND`. **Do not duplicate the knob table** — full surface with each
knob's purpose and read site is in repo `AGENTS.md`.

Session writes are truth-gated (`src/runtime/session-store.ts`): zero cookies AND
zero localStorage for the host is refused at the write seam with a named
`skipped-no-auth (nothing to save)` verdict, and an account-index slug collision is
refused rather than silently overwritten. Rule: **an anonymous session is never
presented as a logged-in one.** `data/` holds real credentials and is gitignored —
never commit it, never paste it.

## Integrating into an agent runtime

```bash
npx tsx src/cli.ts install <host> --registry <url>   # write-gated, below
npx tsx src/cli.ts generate <host> --out <dir>
npx tsx src/cli.ts serve <host> --trust
npx tsx src/cli.ts plugin serve <module.ts> --base-url <url> --account <slug>
npx tsx src/cli.ts hub run <host>
npx tsx src/cli.ts package <host>      # REFUSES LOUD by design — see AGENTS.md
```

`install` (`src/registry/install.ts`) validates the **whole** fetched package
before any file lands: required files, parseable JSON, manifest capability entries,
recipe path traversal, profile shape, profile/package id agreement. A refusal
names the file and writes nothing, so a broken package can never install
"successfully" and be refused only later at serve time.

**MCP registration** — the generated server is stdio. Use the argv the generator
itself spawns (`src/generator/skill-template.ts`):

```
command: node
args:    ["--import", "tsx", "<abs path>/sites/<host>/server/index.ts"]
env:     { UI2API_TRUST: "1" }
```

Runtime knobs the generated server reads: `UI2API_TRUST`
(`src/generator/generate.ts`), `UI2API_ENGINE` (`src/plugin/context.ts`).
**UNVERIFIED:** no canonical MCP-client JSON block is committed anywhere in this
repo — the argv above is reconstructed from the generator's own spawn, so copy it
rather than trusting this file.

Also emitted: per-host leaf skill `server/SKILL.md` + `skill-loader.mjs`
(`src/generator/skill-template.ts`), the ACP server
(`src/generator/acp-template.ts`, reads `UI2API_ACCOUNT` + `UI2API_DATA_DIR`), and
the PHP client (`src/generator/lang-php.ts`, `Ui2apiClient`, `config/ui2api.php`).
The CLI's `generate` emits the MCP server + action map; ACP comes via `hub run --acp`.

## Troubleshooting ladder — keyed on the honest symptom

| symptom | do this |
| --- | --- |
| `ERR_CHALLENGE` / abuse signal / consent wall | headed + Xvfb **first**, then the wigolo tier |
| empty answer with `headlessDegraded: true` | environment refused headful — add a display |
| authenticated as anonymous, bot check | browser-bound auth — attach, do not replay |
| `refusing to spawn a browser` | not the chrome owner — run as it, or attach |
| `ProcessSingleton` / one-instance refusal | owner Chrome already up — read `chrome status`, adopt |
| `unknown site "<id>"` | not on the allowlist; there is no arbitrary-URL path |
| package installed but absent from `/registry` | the write gate refused it, by name |

**Never** retry the plain path in a loop and **never** raise a timeout to "fix" a
challenge — both only deepen the rate-limit signal. Reach for the wigolo tier
(`docs/WIGOLO_BYPASS.md`, `src/runtime/wigolo.ts`). Its non-negotiables:

- **Loopback only** unless `UI2API_WIGOLO_ALLOW_REMOTE=1` explicitly.
- The bearer token never leaves loopback without the **second, separate** opt-in
  `UI2API_WIGOLO_ALLOW_REMOTE_TOKEN=1`. Allowing traffic out and handing over a
  credential are two different decisions.
- **A cross-origin daemon answer is REFUSED**, so a 200 from any base can never be
  served as a page's answer. No fabricated results outranks convenience.
- If wigolo cannot get a real answer either, the result stays `ok:false` with the
  named reason. That is the honest outcome.

## Never

- **Never trigger a production deploy.** `.gitlab-ci.yml` deploy is
  `when: manual`, `allow_failure: false`, protected `production` environment,
  gated on `main`. Operator-triggered only. Never claim to be allowed to.
- **Never fabricate a result** — no synthesized answer, no forged request, no
  "verified" claim without a live round-trip through the site's own JS.
- Never assert a package, capability, or site works because a doc said so.
- Never log, print, or commit session snapshots, cookies, or `data/`.
- Never `launch()` a browser ad hoc — every launch goes through `launchBrowser()`
  in `src/runtime/browser.ts`.
- Never claim a challenge is fixed without re-reading the honest answer off the page.