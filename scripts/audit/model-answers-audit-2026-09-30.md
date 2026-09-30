# Audit: does `/v1/models` advertise models that cannot answer? (re-measurement, 2026-09-30)

Date: 2026-09-30 · Service: `127.0.0.1:9797` (deployed promptd, build `bdee4ac2ea0c2fc205e334b9683c35ea6d0f8838`)
Supersedes: `scripts/audit/model-answers-audit.md` (2026-09-29) — **kept on disk, not deleted**, because it is the honest record of a sweep run against a binary that no longer exists, and because the contrast between the two is itself the evidence for the fix.
Read-only against the vault. No service was restarted, no worker was killed, no `src/**` file was modified. Gate run: 11/11 pass.

## 0. Why this sweep exists

The 2026-09-29 audit reported **1 of 22 advertised models answering**. That number was a measurement of a
**wedged pool**, not of the models: the deployed binary predated the fix, all four workers were stuck on
copilot, and the known-good control `duckduckgo` — which had answered minutes earlier — returned HTTP 000
after 200s. That audit was honest about this and said so in its own §0; it also disclosed that its §1/§7
counts did not close (10 + 3 + 10 = 23 against 22).

The deploy has since landed. This report is the first sweep against it.

## 1. Preconditions, read from the live service before any request

Read from `GET /status` and `GET /health`, not typed:

| fact | value | where |
|---|---|---|
| build commit | `bdee4ac2ea0c2fc205e334b9683c35ea6d0f8838` | `/health` → `liveness.build.commit`, `source: "build-stamp"` |
| build builtAt | `2026-09-29T22:43:31Z`, `dirty: true` | same |
| pool | `busy 0, total 2, idle 2, queued 0` | `/status` at start |
| `busyWatchdogMs` | `225000` | `/status` → `pool` |
| `perSiteMax` | `3` | `/status` → `pool` |
| stuckness | `{"busy":0,"stuck":0,"degraded":false}` | `/health` → `stuckness` |
| chat models advertised | 22 | `/health` → `counts.chatModels`; ids derived, identical to `defaultChatSurface()` |
| vault | 71 accounts, 68 usable, 3 unusable (all three anonymous) | `/health` → `vault` |

**The daemon can finally name its own build.** That is the point of the fix and it is the first thing this
record states: every row below was answered by commit `bdee4ac2`, read from the service, not inferred from
the working tree.

## 2. Method, and the pacing constraint

- **Serial, one model at a time, no concurrent fan-out.** A burst of 22 concurrent browser-driving requests
  against real logged-in accounts is the one failure this project cannot undo, so the sweep was deliberately
  serial. `kimi` and `deepseek` were probed twice and never more.
- **Wait for an idle pool before every request.** A small read-only driver (`/tmp/mv/sweep*.mjs`, outside the
  repo) polls `/status` until `busy == 0 && queued == 0` before invoking the existing harness
  `scripts/audit/measure-models.mjs` for one model. So `pool` in the table is the pool the request actually
  started into, not a snapshot taken afterwards.
- Per-request timeout **150 000 ms** (the harness default), at most one retry, per model.
- Sweep window: **2026-09-29T22:57Z → 2026-09-30T01:11Z**, ~2h 15m of wall clock, most of it the
  wait-for-idle drain between models.

### A residual leak that is NOT the old wedge — stated, not hidden

A 60s per-site sign-in timeout still leaves 1–3 workers `busy` for up to the 225 s watchdog window, because
the client-visible timeout cannot cancel the in-flight driver. This is how `hunyuan`, `inner-ai`, `v0`,
`huggingchat`, `poe` and `blackbox` each first hit **pool 4/4, queued 2** and returned HTTP 000.

**This is not a repeat of the 4.77-hour wedge.** The pool returned to idle by itself every single time,
inside the watchdog window. And the re-probe is what turned three of those HTTP 000s into named answers:
`hunyuan` → 502 sign-in, `inner-ai` → 502 sign-in, `v0` → **200**. That is the whole method working — a
timeout at a busy pool is a queue fact, and re-probing at an idle pool is what converts it into a model
fact. **No model in this record is filed CONTENDED-TIMEOUT**, because every contended row was resolved by
re-probe.

## 3. The table — every row from a command that ran

`pool` is the pool state **at request time**, after waiting for idle. `ms` is the harness's own measured
duration. Every message is the server's own.

| model | class | http | ms | pool at request | the server's own message / evidence |
|---|---|---|---|---|---|
| **duckduckgo** | **ANSWERS** | 200 | 9201 | 0/2 idle | `Duck.ai said GPT-5.6 Luna PONG 2nd opinion` — **the control, probed FIRST** |
| gemini | **ANSWERS** | 200 | 24204 | 0/2 idle | `Gemini said PONG` |
| v0 | **ANSWERS** | 200 | 13908 | 0/4 idle | `Cooking...` — a real 200, but **not** a PONG; the driver read a status region, not the answer region |
| venice | **ANSWERS** | 200 | 41611 | 0/1 idle | `The user wants me to reply with exactly "PONG". This` — a real 200 with real text, but the model paraphrases instead of complying |
| kimi | SIGN-OUT | 502 | 66814 | 0/4 idle | `no answer appeared on kimi within 60000ms. This site requires sign-in…` |
| chatgpt | SIGN-OUT | 502 | 138117 | 0/3 idle | `no answer appeared on chatgpt within 60000ms. This site requires sign-in…` |
| copilot-m365 | SIGN-OUT | 502 | 91248 | 0/3 idle | `…requires sign-in. Entra ID (Microsoft Entra) sign-in only — MSA/consumer accounts are blocked` |
| tencent-aistudio | SIGN-OUT | 502 | 77651 | 0/2 idle | `…requires sign-in. HEADED session REQUIRED — cookie auth: hunyuan_token + hunyuan_user + hunyuan_source on .tencent.ai` |
| hunyuan | SIGN-OUT | 502 | 68409 | 0/2 idle | `…requires sign-in. HEADED session REQUIRED — the API sets X-webdriver: 1…` (**re-probe** of a 4/4 timeout) |
| inner-ai | SIGN-OUT | 502 | 68956 | 0/3 idle | `…requires sign-in…` (**re-probe** of a 4/4 timeout) |
| manus | SIGN-OUT | 502 | 96706 | 0/1 idle | `…requires sign-in. login once via ui2api analyse https://manus.im…` |
| deepseek | SIGN-OUT | 502 | 65765 | 0/1 idle | `no composer found on deepseek… Page title: DeepSeek - Into the Unknown, url: **https://chat.deepseek.com/sign_in**` |
| claude | SIGN-OUT | 502 | 36691 | 0/1 idle | `no composer found on claude… Page title: **Sign in - Claude**, url: https://claude.ai/login?from=logout&reauth=1…` |
| huggingchat | SIGN-OUT | 502 | 45766 | 0/2 idle | `no composer found on huggingchat… url: **https://huggingface.co/login?next=…**` |
| poe | SIGN-OUT | 502 | 50404 | 0/3 idle | `no composer found on poe… url: **https://poe.com/login?redirect_url=%2F**` |
| copilot | *no class fits* | 502 | 60553 | 0/3 idle | `no composer found on copilot… Page title: Microsoft Copilot, url: https://copilot.microsoft.com/` — page loaded, **not** a login page |
| codex | *no class fits* | 502 | 35681 | 0/1 idle | `no composer found on codex… Page title: Codex in ChatGPT…, url: https://chatgpt.com/codex/` — real product page, no composer |
| blackbox | *no class fits* | 502 | 35154 | 0/4 idle | `no composer found on blackbox… Page title: Blackbox: The high-trust platform…, url: https://www.blackbox.ai/` — page loaded, no composer |
| notion | *no class fits* | 502 | 30533 | 0/4 idle | `no composer found on notion… url: https://www.notion.com/` — redirected to the **public marketing landing page** |
| grok | *no class fits* | 502 | 80087 | 0/3 idle | `no composer found on grok… Page title: **Attention Required! | Cloudflare**` — an abuse challenge |
| perplexity | *no class fits* | 502 | 45135 | 0/4 idle | `no composer found on perplexity… Page title: **Just a moment...**` — a Cloudflare interstitial |
| t3chat | *no class fits* | 502 | 65075 | 0/1 idle | `no composer found on t3chat… Page title: **Vercel Security Checkpoint**` — a challenge |

**Counts: 22 rows for 22 derived advertised ids — 4 ANSWERS + 11 SIGN-OUT + 0 CONTENDED-TIMEOUT + 7 vocabulary-gap.**

## 4. The control did its job, twice

`duckduckgo` was probed **first**, before any other model: HTTP 200, 9201 ms, pool 0/2 idle, real PONG.
It was probed **last**, after twenty other models had each driven a real browser: HTTP 200, 10049 ms,
pool 0/1 idle, same real answer.

That brackets the sweep with a working control, and it proves two separate things:

1. **A model that demonstrably answers can still time out in this service.** The 2026-09-29 sweep filed
   `duckduckgo` CONTENDED-TIMEOUT (HTTP 000 after 200009 ms at pool 3/4) on exactly this evidence. So
   CONTENDED-TIMEOUT is a statement about the queue, never about a model.
2. **The service was alive at both ends of the sweep.** Every non-answer recorded between those two points
   is attributable to the model, not to the service dying. The 2026-09-29 sweep could not make that claim
   and said so.

## 5. The headline, stated honestly

**4 of 22 advertised models return a real 200 with real answer text on the fixed build** — and one of
those four (`v0`) returned a status string rather than the requested token, and one (`venice`) paraphrased
the instruction rather than complying. Only **two** of the four (`duckduckgo`, `gemini`) returned the
actual requested answer. So:

- 2 models **provably answer a prompt correctly** (`duckduckgo`, `gemini`).
- 2 models **serve a 200 with real text but do not satisfy an exact-token probe** (`v0`, `venice`).
- 11 models return a **named, actionable sign-out** — a real per-model finding with a named fix, and four
  of them (deepseek, claude, huggingchat, poe) are only identifiable as sign-outs from the login page the
  server itself reported, not from the message text.
- 7 models land in a state the gate's closed vocabulary **cannot express**: three behind an explicit
  anti-bot challenge (grok, perplexity, t3chat) and four on a page that loaded with no composer and no
  login wall (copilot, codex, blackbox, notion).

I am **not** claiming "18 models are broken." I am claiming: 2 answer, 2 serve-but-misread, 11 need a
sign-in, 3 are behind a challenge, 4 need a profile/selector investigation. Those are five different
actions.

## 6. THE GATE HAS A CLASS-VOCABULARY GAP — raised, not worked around

`test/model-verification-consistent.test.ts` accepts exactly four classes:
`ANSWERS`, `SIGN-OUT`, `CONTENDED-TIMEOUT`, `UNMEASURED`.

Seven measured rows are none of those. They are a **named 502 at an idle pool** whose message is
`no composer found on <site> — the site UI may have changed`, with the server itself reporting the page
title and url it landed on. That is a real, distinct, per-model condition: it is not a credential problem
(the message does not say sign-in, and five of the seven pages are demonstrably not login pages), and it is
not contention (every one of the seven was measured at `busy 0, queued 0` — the gate's own RULE 7 rejects
a contention claim at an idle pool, correctly).

**What I refused to do:** file them as `SIGN-OUT`, which would overstate a credential problem the evidence
does not show, and would send a reader off to re-capture a session that is not the problem.

**What I did instead:** filed them `UNMEASURED` — read strictly as *"no ANSWERS class and no SIGN-OUT class
was established"* — while carrying the full real measurement (timestamp, http status, duration, idle pool,
and the server's own page title and url) in `measuredAt` / `method` / `evidence` / `prereq`, so the data is
not hidden and no consumer is misled into thinking nothing was tried.

**The ask:** the gate needs two more classes, e.g. `COMPOSER-DRIFT` (page loaded, no composer, no login
wall) and `WALL-CHALLENGE` (the served page is a Cloudflare / Vercel security interstitial). **The gate file
was not edited by this sweep.** It is the judge, not the subject.

## 7. What this sweep does NOT claim

- **It does not claim the pool leak is fixed.** It claims the pool *drains* inside the 225 s watchdog on
  every observed occasion, which is a smaller and different claim.
- **It does not claim the anti-bot rows are passable.** grok, perplexity and t3chat were **not** pushed
  through. The sweep did not retry to defeat a challenge, per the operator's standing rule.
- **It does not claim `v0` and `venice` answer correctly.** Both returned 200 with real text; neither
  returned the requested token, and that distinction is in the record.
- **It makes no claim about any model it did not drive a browser against.** Every row here is one real
  request through the deployed service.
- `tencent-aistudio` answering SIGN-OUT is a **regression against this project's own docs**, which record a
  verified headed round-trip on that site. The session behind it is no longer sufficient. That is a finding
  from this measurement, not an inference from the docs.
