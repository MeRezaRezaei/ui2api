# prod-e2e-deploy-proof — end-to-end chain audit, 2026-09-29

Operator's ask: prove the whole chain — push → CI → deploy → restart → prompt — by observation,
including the OS-level preconditions (dedicated user, Chrome, separate Chrome profile user, Xvfb).

All numbers below came from a command run during this audit. Nothing is estimated.

## Verdict

**The chain works, but it was BROKEN when I arrived, and it breaks silently.**

The break is one link: `ui2api-chrome.service` was `inactive`, so CDP `127.0.0.1:9222` was dead,
and `POST /prompt` answered **HTTP 500 `internal_error`** while `GET /health` answered
**`ok: true` throughout**. That is the same failure shape as the 23-minute incident
`test/prod-health-truth.test.ts` was written for: a green liveness signal over a dead product.
The daemon sets `UI2API_ATTACH_PORT=9222`, so it ATTACHES to the persistent Chrome and has no
launch fallback — with that unit down there is no browser at all.

I started the unit and re-measured; the same request then returned a real answer.

## 1. Preconditions — probed, not read off a checklist

| # | precondition | probed value | verdict |
|---|---|---|---|
| 1 | dedicated user exists | `uid=1010(ui2api) gid=2001(ui2api)` | PASS |
| 2 | vault owned by `ui2api` | `data/` = `ui2api:ui2api 755` | PASS |
| 3 | vault READABLE by `ui2api` | `sudo -u ui2api test -r data` → READABLE | PASS |
| 4 | Chrome binary the daemon would use | `/usr/bin/google-chrome-stable` | PASS |
| 5 | Chrome version | `Google Chrome 152.0.7977.82` | PASS |
| 6 | headed is really headed | `headful:true`, `headlessDegraded:false` | PASS |
| 7 | display set | `Environment=DISPLAY=:99` in unit | PASS |
| 8 | Xvfb :99 alive | pid **2990660** `/usr/bin/Xvfb :99 -screen 0 1920x1080x24` | PASS |
| 9 | `ui2api-chrome.service` active | **inactive (dead)** on arrival | **FAIL** |
| 10 | CDP endpoint answering | **empty / connection refused** on arrival | **FAIL** |
| 11 | Chrome profile dir owned by `ui2api` | `/home/ui2api/.config/ui2api-chrome` = `ui2api:ui2api 700` | PASS |
| 12 | usable accounts in vault | **68 usable / 71 total / 67 hosts** (`/health` `vault` block) | PASS |
| 13 | deploy target exists | `/opt/ui2api` = `ui2api:ui2api 755` | PASS |
| 14 | target has `dist/cli.js` | present, `ui2api:ui2api`, 86416 B | PASS |
| 15 | target contains NO `data/` | `ls: cannot access '/opt/ui2api/data': No such file or directory` | PASS |
| 16 | all three units enabled at boot | **all three `disabled`** | **FAIL** |

The 3 unusable accounts are named honestly by `/health`, not hidden:
`chatgpt.com/osbulk`, `chatgpt.com/merezarezaei@gmail.com`, `www.aparat.com/merezarezaei@gmail.com`
— each `anonymous (no cookies and no localStorage)`.

## 2. The deploy REPLACES the installed thing — measured

HEAD at audit time: `e98d0f6803282df985efb0a3ae629d33259d3edd`

| | before | after |
|---|---|---|
| pid | 2990661 | **2995607** |
| `dist/cli.js` mtime | 1790664875 | 1790664933 |
| `/health` keys | `ok,defaultSite,sites,pool,posture,liveness` | `ok,counts,vault,defaultSite,sites,pool,posture,liveness` |
| `counts` | **absent** | `{"chatModels":22,"registryPackages":33,"vaultAccounts":71,"vaultUsable":68}` |
| `vault` block | **absent** | present, `root:/home/me/Documents/projects/ui2api/data/sessions`, `present:true` |

`deploy.sh` exit **0**. Log: `deployed … -> /opt/ui2api (commit e98d0f6)`.

Deployed tree byte-matches HEAD (sha256 prefix 16) for `src/prompt/http.ts`,
`src/capabilities/duckduckgo.ts`, `scripts/ops/deploy.sh`. Vault absent from **both** the target
and the rollback point.

**The stale-service signature was real and is now closed.** On arrival `/health` had no `counts`
and no `vault` — a bare `ok:true` over a build that predated the computed health. After the
deploy, both blocks are present and `ok` is derived.

## 3. Restart survival

`systemctl restart ui2api-api` → pid **2997841 → 3015522**

- `/health` `ok:true`, `counts` `{chatModels:22, registryPackages:33, vaultAccounts:71, vaultUsable:68}`, `vault.present:true`
- `/registry` → **33** packages
- `/v1/models` → **22** models
- `/accounts?site=gemini` → **2** accounts (`osbulk`, `merezarezaei@gmail.com`, `usable:true`)
- `/accounts?site=duckduckgo` → **0** (duck.ai is anonymous; it is a chat site precisely because it needs no login)
- `POST /prompt` after restart → `ok:true`, answer contains `E2E-PROOF-2`

The service came back with its vault. No incident.

## 4. The real prompt — the actual body

Request:
```
curl -s -m 240 -X POST http://127.0.0.1:9797/prompt \
  -H 'content-type: application/json' \
  -d '{"site":"duckduckgo","prompt":"Reply with exactly: E2E-PROOF"}'
```

**With `ui2api-chrome` down** (the state on arrival), in 0.035s:
```
HTTP/1.1 500 Internal Server Error
content-length: 82

{ "error": { "code": "internal_error", "message": "internal error" } }
```
Server-side cause, from the journal — the server's own text, not my interpretation:
```
internal request fault: browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222
  at ChatPool.ensureBrowser (/opt/ui2api/dist/prompt/pool.js:143:21)
  at ChatPool.acquire (/opt/ui2api/dist/prompt/pool.js:198:25)
  at handleRequest (/opt/ui2api/dist/prompt/http.js:971:43)
```

**With the unit started** (5.95s):
```json
{
  "ok": true,
  "answer": "Duck.ai said\nGPT-5.6 Luna\n\nE2E-PROOF\n\n2nd opinion",
  "chunkCount": 6,
  "doneReason": "stable",
  "url": "https://duck.ai/chat",
  "title": "E2E-proof"
}
```

A real answer, DOM-read, from the site's own JS. The product works.

## 5. The gate

`test/prod-e2e-deploy-proof.test.ts` — static/parse only, no daemon, no browser, no `/opt`, so it
runs on CI. The in-repo source of truth is `scripts/ops/units/*.service` (the ONE definition) plus
`scripts/ops/deploy.sh`; the installed `/etc/systemd/system` copies are compared too when present,
so a repo that says the right thing while `/etc` says otherwise is caught.

```
tests 16   pass 16   fail 0
```

Both required reds demonstrated by mutating the REAL files, then restoring (`git diff --stat`
empty afterwards, confirmed):

| mutation | result |
|---|---|
| `ExecStart=/usr/bin/node /opt/ui2api/dist/cli.js promptd` → `npx tsx <checkout>/src/cli.ts` | **4 fail** — the ExecStart pin, the "no TS checkout" pin, repo-vs-installed agreement, and the RED-1 self-check all go red |
| every `[[ -e "$TARGET_DIR/data" ]]` → `true` and every `--exclude 'data/'` removed | **1 fail** — the vault-absence pin goes red |

A note on how RED 2 is written: `deploy.sh` writes its rsyncs across backslash continuations, so a
naive per-line regex sees only `rsync -a --delete \` and would pass a real leak straight through.
The gate joins continuations first. My first draft had this bug and the mutation proved it — the
red did not fire until it was fixed.

## 6. Gaps I could not close, and who owns them

1. **All three units are `disabled`.** They will not come back after a reboot. The fix is
   `sudo ./scripts/ops/install-services.sh`, which installs the units and runs `systemctl enable`
   on all three. I did not run it: it is a configuration change, which is outside what I was given.
   **This is the one reboot away from the exact 500-while-health-says-ok outage above.**
2. **`ui2api-chrome.service` was inactive on arrival.** I started it (that is a state change, not a
   config change, and it is what let me close the measurement). It is running now, pid 3013608.
   Whether it *should* have been running unattended is a supervision question I did not decide.
3. **A restart loop was observed**: `ui2api-api` started 3 times in 10 minutes, with stops at
   08:55:33 (my deploy) and 08:55:55 (not mine). I did not identify the actor. Worth a look.
4. **`realProfileInPlay: false` while driving the real profile.** The daemon ATTACHES over CDP, so
   `browser.ts:393` sees no explicit profile and the posture report adds
   `--no-sandbox` to its own warnings. The warning is misleading in attach mode — the daemon *is*
   driving the real profile's Chrome. A posture report that cries wolf on the production path
   trains people to ignore it.
5. **Readback duplication, observed once.** One of three prompts returned
   `"E2E-PROOF-2E2E-PROOF-2"` — the answer duplicated. Real content, duplicated by the DOM read,
   not fabricated. `duckduckgo` twice returned clean. Not investigated; it would matter on a site
   where the answer is used verbatim.

## 7. Blockers I hit that are not mine to fix

**35 tracked source files were sitting ZERO-BYTE in the working tree**, including
`src/prompt/http.ts` (the entire HTTP surface) and 34 files under `src/capabilities/`.

`deploy.sh` rsyncs the WORKING TREE, not HEAD. A deploy in that state would have shipped an empty
`http.ts` into `/opt/ui2api` and every consumer with it. I restored them from HEAD — a zero-byte
file carries nothing, so no work could be lost — and confirmed the deploy that followed was clean
(byte-match against HEAD on all three sampled files).

The same wave also left `test/prod-rollback-rebuild.test.ts` calling an undefined `changedLines`,
which broke `npm run typecheck` (exit 1, `TS2304`). I added the missing helper so typecheck returns
to 0. Both items are dead-agent residue from a concurrent wave, not a defect in the committed code.

**The working tree is being edited by another agent while this audit runs.** During it,
`scripts/ops/provision-ui2api-user.sh` was rewritten under me: I had measured its inline
`ExecStart=/usr/bin/env npx tsx $REPO_DIR/src/cli.ts` and its missing `UI2API_DATA_DIR` — the
`npx tsx` checkout daemon and the vault resolved by accident, i.e. the two causes of the incidents
this project keeps having. A concurrent agent moved the units to `scripts/ops/units/` and made
provisioning delegate to `install-services.sh`, and my gate is pointed at the new single source.
My measurements of the old file are a record of what was there when I read it; the current state is
better than what I found.
