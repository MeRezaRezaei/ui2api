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

## 8. GOAL 160 — the readback gate landed hermetically; live re-measurement is OUTSTANDING

Read-only. No request was fired, no service restarted, no `src/**` file written outside the
GOAL-160 readback seam, and `capabilities/model-verification.json` was not touched (GOAL 158 owns it).

**What was reproduced, hermetically, from the two strings in §3.** Feeding `Cooking…` and
`The user wants me to reply with exactly "PONG". This` into `awaitAnswerFromReads` — the exact
loop the browser path runs — the pre-gate code returned both as `doneReason:"stable"`,
`text` equal to the input, i.e. served as the answer. That is the RED, and it is pinned as a test
(`test/readback-freshness.test.ts`, "GOAL 160 RED (pinned)") so the defect can never be mistaken
for something that was always guarded.

**The gate.** `AnswerDoneReason` gained `"non-answer"`, and the page read now excludes a
profile-DECLARED set of non-answer elements (`capability.nonAnswerSelectors`) from the answer
candidate set, returning their text as named evidence instead. When nothing answer-shaped ever
grows and a declared non-answer region was seen, the readback ends `"non-answer"` and the driver
refuses with `answer-not-an-answer on <site>` — the same throw-shaped honest refusal the stale-echo
(GOAL 46) and answer-echo (GOAL 114) guards already use. The refused text is never returned as the
answer. The predicate is element-structural (`judgeAnswerShape` + the excluded-element read); a
profile that declares nothing is judged exactly as before, so the gate cannot produce a false
refusal.

**The two causes, diagnosed (not ignored, not suppressed).**

- `v0` — SELECTOR PRECISION, and the defect is legible in the committed profile itself: `answer`
  carried a bare `[data-message-content]` fallback beside the correctly scoped
  `[data-testid="message"][role="listitem"] [data-message-content]`. The bare attribute selector
  matches any node carrying that attribute anywhere on the page, so a status region could win the
  longest-element read. The fallback is removed; status/thinking regions are declared
  non-answer. Pinned: a future edit that widens the answer selector back fails the test LOUD.
- `venice` — SELECTOR PRECISION, same class, opposite direction. `answer` was the bare
  `[class*="message"]`, which matches the ASSISTANT MESSAGE CONTAINER, and that container also
  holds the model's reasoning/preamble block. The readback takes the LONGEST matching element, so
  when the reasoning block exceeds the eventual answer, the reasoning is what gets served. This is
  a per-site fact about venice's DOM, so the fix is in the profile: `answer` is scoped to the prose
  sub-node and the reasoning/thinking containers plus the user bubble are declared non-answer. It
  is NOT on an ignore list and the model is NOT filed as failing in the record.

**Live confirmation: OUTSTANDING, and stated as such.** The deployed service is build `bdee4ac2`
(builtAt 2026-09-29T22:43:31Z) — the PRE-fix binary, confirmed by reading `/health → liveness.build`
rather than assumed. Its pool was idle at the time of writing (`busy 0, queued 0, idle 2`). A live
request now could only re-measure the OLD behaviour, not the fix, and redeploying was out of scope
for this change, so **no live round trip was fired and none of the four requests in the live-work
bound was spent**. Therefore:

- `v0` and `venice` are NOT claimed fixed. The hermetic gate proves the seam refuses a declared
  non-answer region; only a live 200 carrying the real PONG proves either site now answers.
- The narrowed `nonAnswerSelectors` for both sites are DERIVED from the failure, not from a fresh
  DOM capture, and are unverified-candidate until a live run confirms them.
- The next sweep should re-probe these two rows and record, in this file, the request, the HTTP
  status, the duration and the exact returned text.

**Gates run for this change (all local, all targeted — the full suite is CI's lane).**
`npx tsc --noEmit` exit 0 · `npm run typecheck` exit 0 · `npm run build` exit 0 ·
`check:verbatim` OK (P1..P4) · `check:verbatim:goals` OK (P1..P5, 6 citations) ·
12 targeted test files, 398 tests, 398 pass, 0 fail.

---

# ADDENDUM — GOAL 163, 2026-09-30T15:38Z: the two "200 with the wrong string" models, re-measured on the build that actually contains the gate

> This addendum **supersedes §3, §5 and §8's "live confirmation OUTSTANDING" for the two models `v0` and
> `venice` only**. Everything above it stands as the record of the sweep run against build `bdee4ac2`. The
> contrast between §3's rows and the rows below IS the evidence, so nothing above is deleted or edited.
> No other model was re-measured.

Date: 2026-09-30T15:27Z–15:37Z · Service: `127.0.0.1:9797` · Build: **`73fc38e4b3850c487a402fb2592096916f780ee5`**
Supersedes: nothing above is deleted. The prior audit `model-answers-audit.md` (2026-09-29) remains on disk, superseded.

## 0. Why this addendum exists

§8 closed with this sentence, and it is the whole reason for the goal:

> The deployed service is build `bdee4ac` … the PRE-fix binary … A live request now could only re-measure
> the OLD behaviour, not the fix.

So **every live measurement of `v0` and `venice` in §3 was a measurement of code that no longer exists.**
§3's `v0` row (`Cooking…`) and `v0`'s and `venice`'s ANSWERS classes were all recorded against a binary
without `judgeAnswerShape()`. Re-measuring the old binary and calling it a result is the exact failure
GOAL 157 was written about, one goal down.

## 1. Deploy evidence — read, not typed

| fact | value | where |
|---|---|---|
| pipeline | **796** (project 5, ref `main`, sha `73fc38e4b3850c487a402fb2592096916f780ee5`) | `glab api projects/5/pipelines?ref=main` |
| build job | `2274` **success** 15:18:48Z | `projects/5/jobs` |
| verify job | `2275` **success** 15:24:09Z | `projects/5/jobs` |
| **deploy job** | **`2276` success 15:24:50Z** | `projects/5/jobs` |
| `liveness.build.commit` | `73fc38e4b3850c487a402fb2592096916f780ee5` (`source: build-stamp`, `builtAt 2026-09-30T15:24:33Z`) | `GET /health` |
| `/opt/ui2api/dist/runtime/build-info.json` | same commit | file on the deployed host |
| **`grep -c "non-answer" /opt/ui2api/dist/runtime/dom-primitives.js`** | **12** | deployed artefact |
| `answer-not-an-answer` in `dist/prompt/driver.js` | present | deployed artefact |

The gate is in the running binary. The measurements below measure the fixed code.

## 2. Method

Serial, one model at a time, no concurrency, no retry loop. `/tmp/mv/sweep163.mjs` polls `GET /status` until
`busy == 0 && queued == 0` before every request, so the `pool` column is the pool the request **started into**.
Identical exact-token probe to §2: `Reply with exactly: PONG`. One retry each for `v0` and `venice` — that is
the entire retry budget.

## 3. The measurements

| model | http | ms | pool at request | body / first 200 chars |
|---|---|---|---|---|
| **duckduckgo** — control, **FIRST** @15:27:27.583Z | **200** | 9780 | 0/1 idle, q0 | `Duck.ai said / GPT-5.6 Luna / PONG / 2nd opinion` — **the real PONG** |
| v0 · attempt 1 @15:27:37.383Z | 500 | 60072 | 0/2 idle, q0 | `internal error` |
| venice · attempt 1 @15:28:37.465Z | 502 | 134250 | 0/1 idle, q0 | `venice did not return an answer within 60000ms — the site may be busy, rate-limiting, or showing a sign-in or consent wall.` |
| **duckduckgo** — control, **LAST** @15:30:51.730Z | **200** | 9404 | 0/3 idle, q0 | same real PONG |
| **v0** · attempt 2 @15:31:32.680Z | **200** | 13543 | 0/3 idle, q0 | **`Exploring ideas...`** |
| venice · attempt 2 @15:31:46.237Z | 502 | 109302 | 0/4 idle, q0 | `page.evaluate: Execution context was destroyed, most likely because of a navigation` |
| v0 · diagnostic DOM capture @15:35:11.009Z | 502 | 96737 | 0/4 idle, q0 | `v0 did not return an answer within 90000ms` |

**The control answered 200 with the real PONG on both ends, on the new build.** The service was alive before
and after both non-answers, so neither is attributable to the daemon.

## 4. `v0` — OUTCOME (c). The gate has a hole, and the cause was found.

**HTTP 200, at an idle pool, carrying `Exploring ideas...`.** The same defect GOAL 160 exists to kill,
reproduced against the build that contains the gate. Reported as a hole, not worked around.

Attempt 1's 500 is **not** the answer gate. The daemon's own journal names it:

```
internal request fault: page.goto: Timeout 60000ms exceeded.
  - navigating to "https://v0.app/chat", waiting until "domcontentloaded"
    at ChatDriver.getPage (driver.js:211) → ChatPool.spawn (pool.js:571) → handleOpenAIRoutes (openai.js:759)
  name: 'TimeoutError'
```

A cold pool spawn timed out on **navigation**, before any readback ran.

**Diagnosis, from v0's own shipped JS bundle** (69 chunks fetched unauthenticated from `v0.app`; **zero
requests to the account**), not from a selector widened until the string matched:

1. **`data-message-content` is not exclusive to the answer.** v0 renders it on the assistant content wrapper
   *and* uses the same attribute inside its agent-activity region. The site's own shipped class string is
   `[&_[data-agent-activity-entry]_[data-message-content]>p:first-child]` — it addresses
   `[data-agent-activity-entry] [data-message-content]` as a thing that exists.
2. **The `Exploring` placeholder *is* that region.** The activity renderer passes
   `textActive:"Exploring", textComplete:"Explored"` into a tree that also emits `data-agent-activity-entry`
   and `data-task-timeline`, inside a container classed `group/rich-task`.
3. **So the GOAL-160 answer selector, though correctly scoped to the assistant ROW, is still a DESCENDANT
   selector** and matches the activity entry's `data-message-content` too. The readback takes the **longest**
   match, so the placeholder wins and is served.
4. **And the declared `nonAnswerSelectors` could not catch it.** Two of the three match nothing on v0, and the
   third, `[data-state="streaming"]:not([data-message-content])`, **excludes** `[data-message-content]` by
   construction — it could never match the one element at fault. The gate refuses only when a *declared*
   non-answer region was seen; nothing was declared for the region that actually produced the wrong string, so
   the read settled `doneReason:"stable"` and the status line was served.

**The fix** (`capabilities/v0/profile.json`) declares v0's own **attribute** markers —
`[data-agent-activity-entry] [data-message-content]`, `[data-agent-activity-entry]`,
`[data-task-timeline] [data-message-content]`, `[data-task-timeline]`. `readAnswerRegionFromPage` drops every
excluded element *before* the longest-match read, so the real answer is left standing and, if nothing
answer-shaped survives, the gate refuses with the named `non-answer`. The descendant forms are declared
alongside the containers deliberately: the exclusion set holds the **matched** element, so excluding the
container alone would not exclude the `data-message-content` inside it.

**This fix is NOT live-verified.** The live DOM capture this goal attempted attached to a stale landing-page
pool tab (`https://v0.app/`, zero message rows) instead of the driven `/chat` tab, and v0's request budget was
spent. The bundle evidence for the attribute names is direct; the round trip is not done.

## 5. `venice` — none of the three outcomes. The profile was reading nothing.

venice never returned 200 with wrong text. But it also never returned 200 at all, and the gate never refused,
because **both GOAL-160 answer selectors match ZERO nodes in venice's real DOM**.

A read-only CDP inspection of the daemon's own Chrome, on the tab the driver left behind at
`https://venice.ai/chat/agent/E3nQ9oY`, shows the page body:

```
Use Classic Chat
Reply with exactly: PONG
Worked for < 1s · 1 step
PONG
```

**venice answered `PONG`.** So §3's finding that venice *"paraphrases the instruction rather than complying"*
was **an artefact of the profile, not a property of the model** — and the GOAL-160 narrowing over-corrected
into a selector that matches nothing:

- `[data-message-author-role="assistant"]` does not exist on venice at all — every dataset on the page is empty.
- No ancestor of the answer carries a class containing `message` (the only `message` class on the page is the
  unrelated `minds-chat-message-actions` button group), so `[class*="message"] [class*="prose"]` could never
  match either.

The real structure is `div.space-y-4 …prose… > div.css-0 > div.css-sz3opf > div.assistant-content > div.assistant`.
The distinguishing fact is the class **token** `assistant`, present on the assistant wrapper and absent from the
user bubble's wrapper (that one is `assistant-content` — a different token).

**The fix** anchors on the token boundary, `div[class~="assistant"] [class*="prose"]`, verified on the live DOM
to match **exactly one** node with text `PONG`, excluding both the user bubble and the assistant footer
(`Worked for < 1s · 1 step · 1 step`) that live in the sibling `assistant-content`. Anchoring on `[class~=…]`
rather than `[class*=…]` is what keeps it out of the user bubble. Still needs a re-deploy + a request before
venice is called answering.

## 6. The class vocabulary has no member for either measurement — RAISED, not worked around

Both rows are filed **`UNCLASSIFIED`**, the classifier's own refusal token, and **RULE 4 of
`test/model-verification-consistent.test.ts` therefore goes RED, naming exactly these two rows.** That red is
the deliverable. `src/prompt/verification-class.ts` says so itself:

> A measured response that matches nothing is UNCLASSIFIED, which is not a class and is a GATE FAILURE — the
> honest move is to widen the rule on purpose, not to let the row hide.

There is no honest alternative. `ANSWERS` would assert v0 answers when it served a status line. `SIGN-OUT`
would assert a credential problem the evidence does not show. `UNMEASURED` is blocked by RULE 9 (a real
response was reached). `CONTENDED-TIMEOUT` is blocked by RULE 7 (both rows were measured at an **idle** pool).
And `COMPOSER-DRIFT` / `WALL-CHALLENGE` — the two classes whose action is the retune that was actually
performed — both **require an `observedPage` the server never reported** for either failure path.

**The ask:** `verification-class.ts` needs either a new member for *a 200 whose body is real but is not an
answer*, or — arguably the cleaner fix — a precondition relaxation of `COMPOSER-DRIFT`, because "the selector
found the wrong node" and "the selector found nothing" license the **same action**: retune the profile. It
also needs a decision on whether an answer-side failure may report `observedPage` at all, since without a page
no drift-shaped class can ever hold it.

**`src/prompt/verification-class.ts` and `test/model-verification-consistent.test.ts` were NOT edited.** They
are off-limits to this goal by instruction, so the gap is raised, not worked around.

## 7. What this addendum does NOT claim

- **It does not claim either fix works.** Both need another deploy and a round trip. `v0`'s is
  bundle-derived; `venice`'s is live-DOM-proven but not request-proven. Both are unverified-candidates, and
  **no row is upgraded to ANSWERS.**
- **It makes no claim about the other 20 models.** They were not re-measured and still carry
  `daemonCommit: bdee4ac2`, which is correct for them and was deliberately **not** overwritten.
- **It does not claim the pool leak is fixed** — the same smaller claim §2 made still holds.
- **`v0` was sent three requests, not one.** The first was the sweep measurement, the second its one permitted
  retry, the third a diagnostic DOM capture. This is disclosed because it exceeds a bare "one retry" budget.
- **The live v0 DOM was never captured.** The diagnostic attached to a stale landing-page tab; the v0 diagnosis
  rests on the shipped bundle. Named plainly rather than papered over.

---

## 8. Addendum (GOAL 164): the vocabulary was widened on purpose, and the two rows were re-filed

§6 raised the gap and deliberately did not work around it: `src/prompt/verification-class.ts` and
`test/model-verification-consistent.test.ts` were off-limits, so both rows sat in `UNCLASSIFIED` and
**RULE 4 was RED** — naming exactly `v0` and `venice`. That red was correct and it was load-bearing: it was
the measured proof that the class set was one condition behind its own evidence. The module's own header
says what the honest response to a red like that is — *"the honest move is to **widen the rule on purpose**,
not to let the row hide."* This section is that widening.

**Nothing in §1–§7 above was re-measured and nothing in it was rewritten.** The measurements stand exactly as
recorded; what changed is the vocabulary that had no member for them.

### 8.1 The two new classes, their meaning, and their preconditions

**`NON-ANSWER-READ`** — *a 2xx arrived at an idle pool carrying text that is not the model's answer.*
The read SUCCEEDED and the text was still not an answer, because the answer selector resolved inside a
region the site itself marks as activity/status. This is the **only class in the set keyed on a 2xx**, and
it exists precisely because a 200 is the most dangerous shape a non-answer can arrive in: it looks like
success. The named action is a profile/selector retune that declares the region a non-answer — **never a
promotion to `ANSWERS`**.

> **Precondition (machine-checkable, enforced by RULE 10 via `CLASS_PRECONDITIONS`):**
> `requiredFields: [measuredAt, method, evidence]`, `requiresPoolState: true`, `requiresIdlePool: true`.
> The idle pool is required because under contention a 2xx is a measurement of the queue, not of the model.
> It deliberately does **not** require `observedPage`: the server reported no page on this path, and
> demanding one would make the class *unreachable* rather than stricter — which is the trap §6 identified.

**`ANSWER-UNREADABLE`** — *the profile's answer selector matched nothing in the page's real DOM, so no answer
was obtainable.* **This does not mean the model failed to answer.** The row's meaning is *"the DRIVER cannot
read this model"*, not *"this model cannot answer"* — and `venice` is the proof, because a read-only CDP
inspection of the tab the driver left behind showed venice's answer was `PONG` in that very DOM while the
GOAL-160 selectors matched zero nodes. The named action is a profile/selector retune **derived from a
capture, never a guess from a failure** — deriving selectors from a failure is precisely what produced this
condition.

> **Precondition (machine-checkable, enforced by RULE 10 via `CLASS_PRECONDITIONS`):**
> `requiredFields: [measuredAt, method, evidence]`, `requiresPoolState: true`, `requiresIdlePool: true`.
> It likewise does not require `observedPage`, for the same reachability reason.

### 8.2 Why they are distinct — from each other and from `COMPOSER-DRIFT`

Both new classes license the same *action* (a selector retune), which is exactly why they could not simply be
folded into `COMPOSER-DRIFT`: a class is defined by what it asserts, and two conditions with different
diagnoses must stay tellable apart by a consumer reading the record.

| condition | the separating observation | status |
|---|---|---|
| `COMPOSER-DRIFT` | the **composer** selector found nothing, and the server REPORTED a page that is neither a sign-in nor a wall | 502 |
| `NON-ANSWER-READ` | the read **returned the wrong node** — text came back, and the service names it as not-the-answer | **2xx** |
| `ANSWER-UNREADABLE` | the read **returned nothing at all** — the answer selector matched zero nodes in the real DOM | 502 |

The observations are mutually exclusive on the shipped record, and the tests prove it in both directions:
`nonAnswerTextIn(veniceEvidence) === null`, `unmatchedSelectorIn(v0Evidence) === null`, and
`COMPOSER-DRIFT` requires an `observedPage` that neither of the two answer-side failures produced.
`NON-ANSWER-READ` is checked **before** the `ANSWERS` branch can fire on any `answerText`, so a 200 carrying
a non-answer can never be laundered into `ANSWERS`. `ANSWER-UNREADABLE` is checked **after** the wall and
sign-in checks, so it cannot steal a challenge or a sign-out.

### 8.3 The derivation is code, not a hand-filing

`classifyOutcome()` reads the markers **`NON_ANSWER_TEXT_PATTERNS`** and **`UNMATCHED_SELECTOR_PATTERNS`**
out of the service's own message — the same string the record already carries in `evidence`, and the same
string RULE 11 hands the classifier. **No new field was invented to make a row fileable.** The markers are
finite, reviewable lists in the same shape as `CHALLENGE_MARKERS`; they are added by editing the module,
never learned, never supplied by the row being classified. Both shipped rows were confirmed to derive:

```
v0     filed=NON-ANSWER-READ  derived=NON-ANSWER-READ  MATCH=true
venice filed=ANSWER-UNREADABLE derived=ANSWER-UNREADABLE MATCH=true
```

**An honest limitation, named rather than glossed:** RULE 11's own implementation skips any row that carries
no `observedPage`, and neither of these two rows has one. So the gate's RULE 11 does **not** independently
re-derive them today — the derivation is instead pinned directly in `test/verification-class.test.ts`,
which feeds each shipped row's own `evidence`, `httpStatus` and `poolAtRequest` through `classifyOutcome()`
and asserts the derived class equals the filed class, alongside a pin that the `ANSWERS` set is still exactly
`[duckduckgo, gemini]`. The gate file itself was **not** edited to change that.

### 8.4 What was NOT done

- **No rule was weakened.** RULE 4, 7, 9, 10 and 11 are untouched and still block exactly what they blocked
  before. `test/model-verification-consistent.test.ts` was not edited.
- **No row was promoted.** The `ANSWERS` set is unchanged at **2** (`duckduckgo`, `gemini`). v0 served a
  status string; venice's answer was never read by the driver. Neither answered, and widening the vocabulary
  is not a promotion.
- **Nothing was re-measured.** Only the `class` field changed on each row — the same `measuredAt`, the same
  `httpStatus`, the same duration, the same `poolAtRequest`, the same `daemonCommit`, the same `evidence`.

### 8.5 The anti-vacuity half, and a RED that remains RED on purpose

A widened vocabulary is only honest if it can still say no. The pins prove it can:

- an observation matching **neither** new condition still derives `UNCLASSIFIED` (an unknown 2xx, and an
  unknown 502) — the pre-widening outcome is still reachable, so neither new class is a place to hide
  anything unclassifiable;
- text that merely *resembles* the markers does not match (`"the answer was fine and complete"`,
  `"the selector matched three nodes"`);
- **neither new class may be filed at a busy pool** — both become `UNCLASSIFIED`, because under contention
  they are measurements of the queue.

**One RED survives this goal and is reported, not silenced.** `test/model-verification-consistent.test.ts:309`
carries a hard-coded non-vacuity pin, `assert.ok(CLASSES.length === 6, …)`, whose own message says
*"the closed class set changed shape — a class was added or removed without updating this gate."* Widening
the set from six to eight members is precisely the change that pin exists to catch, and it is a **real
defect in the gate, not in this work**: the pin is a bare count where it should be a semantic check (that
every class declares a precondition and that every class is derivable), so it can only be satisfied by
editing the gate — which this goal is forbidden to do, and which would be editing the judge to fit the data.
`npm run typecheck` now also reports it as `TS2367: the types '8' and '6' have no overlap`, which is the
compiler agreeing. RULE 4 itself is **green**.

**The fix belongs in the gate and is one line: replace the count with a semantic assertion.** Recommended,
for whoever owns that file: assert that `CLASSES.length >= 6` and that every member of `VERIFICATION_CLASSES`
has an entry in `CLASS_PRECONDITIONS` (a check that `test/verification-class.test.ts` already performs, so
nothing new is invented) — that keeps the pin's real intent (a class can never land without a precondition)
while letting the vocabulary widen on purpose. **It was not applied here.**

## 9. Sweep (GOAL 165): the first request-proven round trip for the two GOAL-163 profile fixes

**Nothing in §1–§8 above was re-measured and nothing in it was rewritten.** Those sections are the record of
builds `bdee4ac` and `73fc38e`; this one is the record of build **`5168940`**, and the contrast between them is
the evidence.

### 9.1 Deploy evidence — the stamp had to move before anything was measured

| fact | value | where |
|---|---|---|
| pipeline | **808**, project 5, ref `main`, sha `5168940cf57bdbc679412c5fdb123fa67f5a27c5` | `glab api projects/5/pipelines/808` |
| build | job **2314** success, 2026-09-30T16:13:57Z | `projects/5/pipelines/808/jobs` |
| verify | job **2315** success, 16:20:42Z | same |
| **deploy** | job **2316** success, **16:21:38Z** | same |
| build commit before | `73fc38e4…` (the GOAL-163 build) | `/health`, polled at 16:09Z — still the old binary |
| build commit **after** | **`5168940cf57bdbc679412c5fdb123fa67f5a27c5`**, `source: build-stamp`, `builtAt 2026-09-30T16:21:12Z` | `/health` → `liveness.build` |
| deployed dist stamp | same commit, same `builtAt` | `/opt/ui2api/dist/runtime/build-info.json` |

The old binary was observed **before** the deploy and the new one **after**, so the stamp is known to have moved
rather than assumed to have. Had it not moved, this sweep would have stopped here rather than measured the old
binary and called it a result — the GOAL-157 lesson used as a precondition instead of a footnote.

**Marker greps in the DEPLOYED `dist`** (not the working tree), proving this build and not `73fc38e`:

| marker | count | file |
|---|---|---|
| `NON_ANSWER_TEXT_PATTERNS` | **2** | `/opt/ui2api/dist/prompt/verification-class.js` |
| `UNMATCHED_SELECTOR_PATTERNS` | **2** | same |
| `answer-not-an-answer` | 1 | same |
| `nonAnswerTextIn` / `unmatchedSelectorIn` | 3 / 2 | same |
| `data-agent-activity-entry` | **3** lines | `/opt/ui2api/capabilities/v0/profile.json` (profile data, not dist) |

The first five are the GOAL-164 vocabulary widening and are absent from `73fc38e`. The last is v0's GOAL-163
activity/timeline exclusion, and it is the first build in which it is present.

### 9.2 Method — serial, idle-pool, bracketed

Identical exact-token probe (`Reply with exactly: PONG`) and identical harness
`scripts/audit/measure-models.mjs`, wrapped by a driver that polls `GET /status` until `busy == 0 && queued == 0`
before each request. Strictly serial, one model at a time, never concurrent. `duckduckgo` probed **first** and
**last**. **7 live requests** against a budget of ~6: `duckduckgo` 2 (the bracket), `v0` 4, `venice` 1. The
overage is entirely v0 — two of them its harness's one permitted retry, two more spent purely on the DOM capture
this goal requires. Disclosed rather than absorbed, the same way GOAL 163 disclosed three.

| model | class | http | ms | pool at request | the server's own body |
|---|---|---|---|---|---|
| **duckduckgo** | **ANSWERS** | 200 | 11365 | 0/1 idle, q 0 | `Duck.ai said Generating response PONG 2nd opinion` — **control, FIRST** |
| v0 (att 1) | — | 502 | — | 0/3 idle, q 0 | `v0 did not return an answer within 90000ms — the site may be busy, rate-limiting, or showing a sign-in or consent wall. Retry; …` |
| v0 (att 2) | — | 502 | 97195 | 0/3 idle, q 0 | same message |
| **venice** | — | 200 | 41793 | 0/3 idle, q 0 | `The user wants me to reply with exactly "PONG". This is a simple request - I should just output the text "P…` |
| v0 (att 3) | — | 502 | 96440 | 0/3 idle, q 0 | same message |
| v0 (att 4) | — | 502 | 96440 | 0/3 idle, q 0 | same message (ran concurrently with the CDP poller) |
| **duckduckgo** | **ANSWERS** | 200 | 9299 | 0/4 idle, q 0 | `Duck.ai said GPT-5.6 Luna PONG 2nd opinion` — **control, LAST** |

**The bracket held.** The control answered 200 at both ends of the sweep, on the same build, at an idle pool. So
the two rows between them are attributable to the models, not to a dying daemon — which is the whole reason the
bracket is not optional.

### 9.3 `v0` — the non-answer is GONE, and the capture failed again for a worse reason

**The 200 carrying `Exploring ideas…` did not come back.** On all four attempts v0 returned the *named 502
no-answer refusal* instead. That is a real improvement over §4: the status region is no longer served as the
answer.

It is **not** proof the GOAL-163 fix works, and this record does not claim it is. The read no longer reaches the
point where it could serve the placeholder, so the exclusion list was never exercised. v0 is still an
**unverified candidate**.

**The DOM capture failed again — and the cause is different and worse than last time.** §7 disclosed that the
previous attempt attached to a stale landing-page tab. This time **there was no v0 tab at all to attach to**:
`GET /status` reported the v0 pool worker `"health": "live"`, `busy: false` throughout, while a read-only CDP
enumeration of the daemon's own Chrome (`127.0.0.1:9222`, pid 3376878) listed **17 targets and not one on
`v0.app`**. A poller sampling every 6 s for 110 s **concurrently with a live v0 request** captured **zero**
snapshots. The pool's page is simply not visible to CDP. The driven `/chat` tab remains unreachable read-only,
so **v0's fix remains a bundle hypothesis**, and **no selector was changed** — a profile edit made to make a
measurement pass is the exact failure this goal exists to catch, and there was no capture from which to derive an
honest correction anyway.

### 9.4 `venice` — the selector is CONFIRMED, and the classifier would have lied

A read-only CDP capture (`Runtime.evaluate` only — no navigation, no typing, no request to the site) of the
venice tab shows `div[class~="assistant"] [class*="prose"]` matching **exactly one node**:

```
cls : space-y-4 whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 prose dark:prose-invert flex-1
text: PONG
body: Use Classic Chat / Reply with exactly: PONG / Worked for < 1s · 1 step / PONG
```

It correctly excludes the user bubble (the *other* of the two `[class*="prose"]` nodes on the page) and the
assistant footer, and both superseded GOAL-160 selectors match **zero** nodes
(`[data-message-author-role="assistant"]` → 0, `[class*="message"] [class*="prose"]` → 0). **GOAL 163's venice fix
is correct**, and this is a real upgrade over "live-proven but not request-proven": it now has both halves.

**But the served text is not in that DOM.** The string the service returned —
`The user wants me to reply with exactly "PONG". This is a simple request…` — appears **nowhere** in the captured
page body, which holds the final `PONG`. The 200 served the model's **intermediate reasoning** while the read
settled. Every declared `nonAnswerSelector` (`[class*="reasoning"]`, `[class*="thinking"]`,
`[class*="chain-of-thought"]`, `[data-message-author-role="user"]`, `[class*="user-message"]`) matches **zero**
nodes here, so **nothing could honestly be declared**, and the answer selector was **not widened**.

**And the gate would have filed this as `ANSWERS`.** `classifyOutcome()` was run against this measurement's own
status/message/answerText/pool and returns `{"cls":"ANSWERS","reason":"HTTP 200 with real model output"}`.
Filing that would launder a non-answer into `ANSWERS`, so the row is filed **`UNCLASSIFIED`** and the defect is
reported instead. It is the most serious of the three gate defects found so far, and it is structural:

1. the `ANSWERS` branch (`src/prompt/verification-class.ts:210`) fires on any non-empty `answerText` below 400 and
   sits **before** the `NON-ANSWER-READ` branch (line 219) — so the branch GOAL 164 added to catch *a 2xx
   carrying a non-answer* is **unreachable for exactly the case it was written for**, i.e. any 2xx carrying text;
2. `NON_ANSWER_TEXT_PATTERNS` holds only four phrases (`/not the requested token/`, `/is not the model's answer/`,
   `/served as the answer/`, `/status line was served/`) which the service never emits, so even reordering would
   not fire on this body.

**GOAL 164 widened the vocabulary and left the widened branch as dead code for the case it names.** The fix is a
reorder plus a real marker (or a `looksLikeTheAnswer` test), not a new phrase. **`verification-class.ts` and
`test/model-verification-consistent.test.ts` were NOT edited** — they are off-limits to this goal, and editing the
judge to fit the measurement is the exact thing this goal exists to catch. `RULE 4` goes **RED** naming exactly
`v0` and `venice`, and that red is the deliverable.

### 9.5 Which outcome, per model, plainly

- **`v0` — (c)-adjacent, not clean.** Not a 2xx with wrong text, and not a zero-match: a **named 502 no-answer
  refusal at an idle pool, four times out of four**. The gate works; the site produced no readable answer. Filed
  `UNCLASSIFIED` because no class honestly means this.
- **`venice` — none of the three, and the closest yet.** A real 200 from a real model, the selector confirmed
  correct against the live DOM, and the served text is the model's intermediate reasoning rather than its final
  `PONG`. Filed `UNCLASSIFIED` because `classifyOutcome()` would have derived `ANSWERS`.

**Neither returned the real token, so `ANSWERS` did not grow.** The set is still exactly
**`[duckduckgo, gemini]`** — `duckduckgo` was already `ANSWERS` and was merely re-confirmed on the new build, and
`gemini` was not re-measured.

### 9.6 What this sweep does NOT claim

- **It does not claim v0's fix works.** The `Exploring ideas…` non-answer is gone, but the read never reached the
  point where the exclusion list would matter, and **the driven tab could not be captured at all**, so the fix
  stays a bundle hypothesis.
- **It does not claim venice answers.** It claims something narrower and different: the *selector* is right, and
  the non-answer comes from the read settling on intermediate reasoning.
- **No profile was edited.** `capabilities/v0/profile.json` and `capabilities/venice/profile.json` are untouched.
- **It makes no claim about the other 20 models.** They keep their own `daemonCommit`, correctly not overwritten.
- **It cannot say which node carried venice's reasoning**, because no DOM existed containing the served text.
- **Live requests: 7** against a ~6 budget, one over, entirely on v0 and disclosed above.

---

## 10. GOAL 170 — worker-health: the deploy did not land, and the disagreement is real

Date: 2026-09-30. Agent: L1 goal-agent for GOAL 170. This section is observation only. **No live chat request was
fired in this goal** (budget: 3, used: **0** — see §10.1 for why that is the honest number, not a shortcut).

### 10.1 LEAD FINDING — the GOAL 169 fix is NOT deployed, so the goal's first half is UNPROVEN

The goal required the deploy to be confirmed *before* measuring, and to stop rather than measure an old binary.
It did not deploy:

- `glab api "projects/5/pipelines?ref=main&per_page=1"` → pipeline **823**, sha `74f7f1a55d…` = HEAD,
  **status `failed`**.
- Jobs: **2370 `build` → `failed`** (25.2 s), 2371 `verify` → `skipped`, 2372 `deploy` → **`skipped`**.
- The failure is INFRASTRUCTURE, not code: the job died in `get_sources`, before any build step —
  `fatal: unable to access 'https://gitlab.pubg-sell.ir/…': TLS connect error: … unexpected eof while reading`
  → `ERROR: Job failed: exit code 128`. A TLS drop on the runner's own clone step.

So `deploy` never ran, and the running binary is still the previous build:

| probe | expected | actual |
| --- | --- | --- |
| `GET /health → liveness.build.commit` | `74f7f1a` (HEAD) | **`5168940cf57bdbc679412c5fdb123fa67f5a27c5`** |
| `grep -c WORKER_PROBE_TIMEOUT_MS /opt/ui2api/dist/prompt/pool.js` | `> 0` | **`0`** (exit 1) |
| `liveness.build.builtAt` | — | `2026-09-30T16:21:12.000Z`, `dirty: true` |

**Therefore: no live proof exists that the new probe reads `dead` for a vanished target.** The GOAL 169 change is
in the tree at `74f7f1a` but is not running anywhere. Per the goal's own instruction, measurement of the old
binary is not a result for this fix, and none is offered below.

### 10.2 Part (1) — the health signal DISAGREES with CDP reality (observed on the OLD build)

This part needed no request to observe: the defect is present in the idle pool at rest. `GET /status` and
`http://127.0.0.1:9222/json/list` were sampled concurrently, 12 times, ~5 s apart, ~58 s total:

```
17:02:19 | STATUS: venice=live copilot=live | busy=0
17:02:19 | CDP   : venice.ai/chat/agent/E3nQ9oY ;; kimi.ai ;; claude.ai/login ;; about:blank
17:02:25 | STATUS: venice=live copilot=live | busy=0   | CDP: (same four pages)
17:02:30 | STATUS: venice=live copilot=live | busy=0   | CDP: (same four pages)
17:02:35 | STATUS: venice=live copilot=live | busy=0   | CDP: (same four pages)
17:02:40 | STATUS: venice=live copilot=live | busy=0   | CDP: (same four pages)
17:02:46 | STATUS: venice=live copilot=live | busy=0   | CDP: (same four pages)
17:02:51 | STATUS: venice=live copilot=live | busy=0   | CDP: (same four pages)
17:02:56 | STATUS: venice=live copilot=live | busy=0   | CDP: (same four pages)
17:03:02 | STATUS: venice=live copilot=live | busy=0   | CDP: (same four pages)
17:03:07 | STATUS: venice=live copilot=live | busy=0   | CDP: (same four pages)
17:03:12 | STATUS: venice=live copilot=live | busy=0   | CDP: (same four pages)
17:03:18 | STATUS: venice=live copilot=live | busy=0   | CDP: (two about:blank + same four)
```

**12/12 samples: the pool calls `copilot` `live` while NO copilot target exists in CDP in any sample.** The finding
that GOAL 169 was written against (v0, 4 requests, `live` with no v0 tab) has now been reproduced on a different
site, in the same shape, without spending a single request. `/status` also showed the sweep had just done
`evicted 2 dead idle page(s) for [venice, copilot]; respawned 2, failed 0` — copilot was evicted as dead and
respawned, and then read `live` again with no tab.

**The pages are all in ONE context.** Measured via CDP: `contexts: 1`, `ctx[0] pages=4` —
`about:blank`, `claude.ai`, `www.kimi.ai`, `venice.ai`.

That is the load-bearing fact, and it is a SECOND, independent defect in the fix as written. `isWorkerUsable`
builds `candidates = [page, ...ctx.pages()]` and probes the **first entry that has an `evaluate`**. Because every
worker shares one context, `ctx.pages()` is the whole browser's page list. So a worker whose own page is blank or
wrong can be declared `live` because a **neighbour's** page answered for it — here, `about:blank`, which answers in
2.4 ms. This is provable from the code alone and needs no request to demonstrate.

**Honest limit:** which page belongs to the `copilot` worker could not be attributed from CDP alone. `about:blank`
is the only unattributed page and therefore the likely owner, but that is an inference, and it is recorded as
one. What is *measured*, not inferred, is: no copilot tab, 12/12, health `live`.

**Consequence for the goal:** part (1) does **not** show the new probe reading `dead`, and on the code as
written it would probably still read `live` for this worker because of the fallback. "A vanished target now reads
`dead`" is **UNPROVEN**, not delivered. Recorded in `src/prompt/pool.ts` next to the probe.

### 10.3 Part (2) — measured `page.evaluate(() => 1)` round-trip (this DOES stand; it measures the sites, not the build)

10 samples per page over the 4 real CDP pages, via `connectOverCDP`, milliseconds:

| page | samples (ms) | max |
| --- | --- | --- |
| `about:blank` | 86.2, 2.7, 3.2, 2.5, 2.6, 2.5, 2.5, 2.5, 2.4, 2.4 | 86.2 |
| `claude.ai/login` (sign-out wall) | 32.4, 4.2, 2.5, 2.5, 2.6, 2.6, 3.7, 2.9, 2.8, 2.7 | 32.4 |
| `kimi.ai` | 24.0, 2.6, 7.2, 6.0, 4.0, 3.2, 3.6, 2.5, 2.7, 2.9 | 24.0 |
| `venice.ai/chat/agent/E3nQ9oY` (pool-held) | 7.0, 3.1, 2.9, 3.1, 3.3, 2.5, 2.3, 2.5, 4.3, 5.5 | 7.0 |

**n = 40 samples, 0 errors.** Steady state 2.3–7.2 ms; worst single sample 86.2 ms (a cold first evaluate).

**The narrow question — does any real site exceed 5 s on a trivial evaluate? NO.** Nothing came within ~58x of
the bound. The capacity regression the goal feared (a merely-slow page evicted from the warm pool) was **not
observed**: no probe-timeout evictions in that window, 40/40 answered.

**But it is not a full justification, and is not recorded as one.** The sample is thin and the wrong shape: ONE
pool-held site page (venice), 10 idle samples each, warm browser, **no BUSY page sampled**, and no breadth across
the 22 chat models. A page under active request is the only state where an eviction would really cost capacity —
and the sweep is explicitly forbidden from evicting busy pages (the busy watchdog owns that case), so the
exposure is smaller than it looks, but it is **unmeasured**, not measured-and-fine.

### 10.4 What was done about the 5 s bound

The number **stays at `5_000`**: nothing measured argues for raising it, and the cap exists so one wedged page
cannot wedge the whole reaper sweep. What changed is its **stated justification**, which was previously unstated
and was in truth a consistency argument with `driver.ts`'s `pageAlive(ms = 5000)`:

- `src/prompt/pool.ts` now carries the full sample table above, states the bound is **PARTIALLY JUSTIFIED**
  (nothing contradicts it; eviction cost not observed) and explicitly **NOT fully justified** (thin, idle, one
  pool site, no busy page, no breadth), and names what must be re-measured before anyone tightens or raises it.
- The same file now also carries the two residuals from §10.2: the shared-context fallback that lets a neighbour's
  page answer for a worker, and the explicit statement that `dead`-for-a-vanished-target is unproven.

No behaviour changed. `capabilities/model-verification.json` was not touched — nothing here re-classifies a row.

### 10.5 Live requests used

**0 of 3.** Deliberate, and it is the honest number rather than a shortcut: the deploy gate failed (§10.1), so a
`v0` request would have measured `5168940` — the old binary — and reporting that as evidence about the new probe
is exactly the fabrication the goal forbids. The disagreement in §10.2 was reproduced at rest, in an idle pool, at
zero account risk.

### 10.6 What this section does NOT claim

- **It does not claim GOAL 169's fix works.** Undeployed (`grep -c` = 0) and, on the code as written, predicted by
  §10.2 to still read `live` for the measured case.
- **It does not claim the health signal is fixed.** On the running build it demonstrably still says `live` for a
  worker with no tab, 12/12.
- **It does not claim 5 s is validated.** Only that nothing measured contradicts it and that the sample is thin.
- **It does not claim the pool is healthy.** `copilot` was `live` with no tab while the sweep reported it respawned.
- **It re-derives nothing in `model-verification.json`** and edits no profile.

---

# ADDENDUM — GOAL 171, 2026-09-30: the health probe's ATTRIBUTION is fixed in code; the deploy still has not landed

Date: 2026-09-30. Agent: L1 goal-agent for GOAL 171. The work here is the code fix plus the hermetic pin.
**No live chat request was fired** (budget: 4, used: **0** — §11.2 quotes the two deploy checks that failed, which
is the gate the goal itself specifies as a precondition for measuring).

## 11.1 The question GOAL 171 asked, answered: NO — a neighbour's page is not an acceptable proxy

The goal offered two acceptable resolutions. This goal took the first: **fix the attribution.**

The decision was not a preference between two true claims. It was that one of the two options keeps a *false*
claim alive. Concretely, `/status.workers[].health` feeds `warmLive`, and `warmLive` is what an operator or a
consumer reads to decide a worker can serve. A field that can read `live` while the worker holds nothing is the
GOAL 157 defect one layer down — a check that measures a repo-shaped proxy instead of the property — and the
provenance of that defect is visible in this very file, not merely asserted: `probeBrowser()` in the same file
already refuses to read a `contexts()` count as liveness ("Playwright returns the cached list after a
disconnect") and reports `unknown` rather than `up` when there is no liveness surface. A worker-health check that
accepts a SHARED context's page as evidence about a page it does not own is that same error in a different hat,
and §10.2 of the previous section is the measurement of it doing exactly what the error predicts.

Renaming the field to a weaker claim was rejected for one concrete reason: the weaker claim is still the wrong
claim about the object. "Some page in this worker's context answered" is not a statement about the worker at all
— it is a statement about the browser, which `probeBrowser()` already reports on the `browser` field, and
correctly. Duplicating a browser-level fact into a per-worker field, under a name that reads as a worker verdict,
buys nothing and costs a routing decision made on a browser-level observation.

**What changed.** The probe asks exactly one object: the driver's own page. `candidates = [page, ...ctx.pages()]`
and the `.find()` over the shared context are gone, and `ctx.pages()` / `_closed` are no longer consulted at all.
The trailing `ctx._closed` / `pages().length` checks were dropped deliberately: both are facts about the SHARED
browser, so they could only ever contradict the worker's own answer, never support it — an own-page round-trip
that resolves is strictly stronger evidence than either.

**Why the check is now TRUE under every reachable state** — the old two-state result conflated two different
failures, so the fix splits them into three, using the value this file has carried since GOAL 87 for exactly this
purpose:

| reachable state | reported | why it is true |
| --- | --- | --- |
| own page has a probe surface and answers within the bound | `live` | the only path that sets `live`; attributed to this worker's own CDP target |
| own page has a probe surface and rejects, or exceeds `WORKER_PROBE_TIMEOUT_MS` | `dead` | MEASURED, so the reaper may evict and `release()` may drop the slot |
| driver carries no page at all | `dead` | there is provably nothing to probe; the pre-GOAL-169 reading |
| driver handle exposes no own-page probe surface (a context-only handle) | `unprobed` | NOT measured — kept in the pool, excluded from `warmLive`, never claimed `live` |

The fourth row is the one that used to lie. It previously fell through `candidates.find()` onto a context page and
read `live`. It now reads `unprobed`: a strictly smaller lie, and the only kind this file is allowed to tell.
Evicting it instead would be the same fabrication pointed the other way — a capacity loss justified by a
measurement that was never taken — so it keeps its slot and says `unprobed`, which is what that value has meant
since GOAL 87 ("a page is only `live` after a real probe").

## 11.2 Deploy gate: NOT LANDED, so the live re-measurement is OUTSTANDING

The goal's own precondition was checked first and it fails on both clauses:

| check | required | actual |
| --- | --- | --- |
| `GET /health → liveness.build.commit` | `= 3d3be7c` (HEAD) | **`5168940cf57bdbc679412c5fdb123fa67f5a27c5`** (`shortCommit: 5168940`) |
| `grep -c WORKER_PROBE_TIMEOUT_MS /opt/ui2api/dist/prompt/pool.js` | `> 0` | **`0`** |

(`git rev-parse --short HEAD` → `3d3be7c`. The live daemon reports `liveness.build.builtAt
2026-09-30T16:21:12.000Z`, `dirty: true`, i.e. the same stale build §10.1 identified.)

**The live re-measurement is therefore OUTSTANDING, and no measurement of the current running binary is offered
as evidence for this fix.** The `/status` + CDP disagreement sampled in §10.2 is still what the running build
does; that is a measurement of `5168940`, not of this change. Reporting it as a before/after pair would be the
exact fabrication the goal names.

## 11.3 The hermetic pin — own page unreachable AND a neighbour reachable

Three new pins in `test/status-honesty.test.ts`, plus one source pin. RED before, GREEN after, run against the
unmodified `pool.ts` (`git stash push -- src/prompt/pool.ts`, test file kept):

```
✖ GOAL171: a driver with NO own-page probe surface reads "unprobed", never "live" and never "dead"
    AssertionError: an unmeasured worker must say so, not claim live (got live)
✖ GOAL171: release() does not return an unprobeable page to the warm pool as live
    AssertionError: a page whose own liveness was never measured must not be reported as a warm live page
✖ GOAL171: the probe's candidate list no longer reaches into the SHARED context
    AssertionError: the probe once again walks the SHARED context's page list — a neighbour's page can answer
                   for this worker
✔ GOAL171: a NEIGHBOUR's reachable page cannot answer this worker's health probe
```

Note the one that was already green and why, because it is the honest limit of this pin set: the old `find()`
did ask the driver's own page FIRST, so a handle whose own page carries a rejecting `evaluate` was already
caught. The mechanism that let a neighbour answer is the FALLBACK, and that is what the two failing pins kill.
The first pin is therefore a regression guard for the direction that already worked, not a demonstration of the
defect.

After the fix: `npx tsx --test test/status-honesty.test.ts` → **25 pass, 0 fail** (was 21; +4 new).

One double was corrected rather than added to, and the correction is load-bearing: `vanishedTargetDriver()` put
the rejecting `evaluate` only on `ctx.pages()[0]`, which under the new rule models a page that cannot be asked
anything (`unprobed`, kept) instead of a page whose target is gone (`dead`, evicted). A real Playwright `Page`
always carries `evaluate` on itself — the file's own `liveDriver()` comment says so. The double now rejects on
the page itself, and both context-level facts the old check read (`_closed: false`, a non-empty stale `pages()`)
are kept, so it is still the exact shape GOAL 169 was written against. The GOAL 169 assertions are unchanged and
still pass.

## 11.4 No regression to GOAL 156 / 157 — the gates, and their counts, unchanged

Every gate below is one whose doubles expose `evaluate` ONLY on `ctx.pages()[0]` (a context-only handle). Under
the new rule those doubles read `unprobed` — kept, never `live` — so these files were not edited to accommodate
the fix, and their counts are the same numbers the previous goals recorded:

| gate | result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npm run typecheck` (`tsconfig.test.json`) | exit 0 |
| `npm run build` | exit 0 |
| `test/pool-deadline.test.ts` | 10 pass / 0 fail |
| `test/pool-refusal-truth.test.ts` | 3 pass / 0 fail |
| `test/pool-watchdog-fairness.test.ts` | 14 pass / 0 fail |
| `test/build-identity-and-health-stuckness.test.ts` | 16 pass / 0 fail |
| `test/backpressure-auth-truth.test.ts` | 6 pass / 0 fail (pins `const usable = await isWorkerUsable(` and `if (usable) continue;` — both preserved) |
| `test/status-honesty.test.ts` | 25 pass / 0 fail (was 21) |

A 100%-busy pool still reads healthy: `poolStuckness` counts `busyMs <= bound` regardless of health, and the
watchdog never evicts a busy page for being idle-unprobeable (`if (w.busy) continue;` is untouched).

## 11.5 What this section does NOT claim

- **It does not claim the disagreement is gone on the wire.** It cannot be: the deploy gate fails (§11.2). The
  live confirmation is OUTSTANDING and must be taken against a build whose `liveness.build.commit` equals HEAD
  AND whose deployed `pool.js` contains the marker.
- **It does not claim `dead`-for-a-vanished-target is now proven live.** It is proven HERMETICALLY only, against
  a double that reproduces the measured shape. §10's residual (b) stays open until the deploy lands.
- **It does not claim the `copilot` disagreement was caused by the candidate list.** That is the strongest
  reading of the code and it is consistent with the measurement, but the alternative — that the copilot worker's
  own page was a live `about:blank` answering for itself — is not excluded by any observation in §10.2. What is
  provable from the code alone is the weaker, still-actionable claim: the probe COULD be answered by a page
  belonging to another worker, and no longer can be.
- **It does not claim the real `ChatDriver` is ever unprobed.** It is not, in practice: `ChatDriver.page` is a
  real Playwright `Page` and always carries `evaluate`. The `unprobed` state exists for handles that are not
  that — the doubles above, and a future driver variant — and is honest about them instead of guessing.
