# Audit: does `/v1/models` advertise models that cannot answer?

Date: 2026-09-29 · Service: `127.0.0.1:9797` (deployed promptd) · Read-only against the vault.
No service was restarted. No source file was modified. `npx tsc --noEmit` = 0.

> **SUPERSEDED — 2026-09-30. Do not read this report as the current state.**
> This sweep ran against a deployed binary that **no longer exists**. Every number below was taken
> while the pool was wedged (all four workers stuck on copilot for 4.77 hours), so the "1 of 22
> answering" headline is a measurement of **the queue**, not of the models — this report says so in
> its own §0, and §4 shows the known-good control timing out in it.
> The current measurement is **`scripts/audit/model-answers-audit-2026-09-30.md`**, against deployed
> build `bdee4ac2ea0c2fc205e334b9683c35ea6d0f8838`, which reports **4 ANSWERS + 11 SIGN-OUT + 7 rows
> the class vocabulary cannot express**, with **zero** CONTENDED-TIMEOUT rows. This file is kept
> unedited as the honest record of what the wedged build did; it is history, not guidance.

## 0. The headline is NOT the one I was sent to prove

I was asked to measure which of the 22 advertised models answer. **I could not complete that
measurement, and the reason is itself the most important finding in this report.**

Measuring the 22 models *wedged the service*. `GET /v1/models` now advertises 22 models and the
daemon answers **none of them** — not one, including models that answered minutes earlier. The
known-good control `duckduckgo` (measured OK by the operator, and answering 17-token PONGs) now
returns **HTTP 000, no response at all, after 95 s**.

This is not a per-model defect. It is a **single systemic pool defect** that makes the whole
advertised surface unanswerable, and it silently converts "some models are broken" into "all
models are broken" with no error surfaced to the consumer.

**Consequence for the audit question:** the 22-model table below is mostly NOT a measurement of
the models. It is a measurement of the pool. I mark every row accordingly and I do not present
contended timeouts as model properties.

## 1. Counts, leading

Of 22 advertised models, over the measurement window:

| class | count | trustworthy as a MODEL property? |
|---|---|---|
| ANSWERS (real PONG returned) | **1** (gemini) | YES — clean, pool had a free slot |
| SIGN-OUT (server's own named message) | **2** (kimi, copilot-m365) | YES — a real, named 502 with actionable text |
| TIMEOUT (no response) | **11** | **NO — all measured at pool 4/4. Contended. Untrustworthy.** |
| NOT SERVED (404 unknown_model) | **0** | — routing is genuinely fine |
| NOT MEASURED (run never completed) | **8** | chatgpt(done,contended), perplexity, huggingchat, hunyuan, blackbox, codex, inner-ai, manus, notion, v0, venice — see §4 |

**The headline number is 1 of 22 measured ANSWERS.** But I will not claim "21 models are broken."
I claim: **1 answers, 2 provably need sign-in, and 19 could not be measured because the service
stopped serving.** Those are very different statements and only the first is actionable per-model.

## 2. The table (every row from a command I ran)

`class` is the server's own outcome. `pool` is the pool state at request time — the decisive column.

| model | class | http | ms | pool | server's own message |
|---|---|---|---|---|---|
| gemini | **ANSWERS** | 200 | 28940 | 0/1 (clean) | `Gemini said PONG` |
| kimi | **SIGN-OUT** | 502 | 70977 | 3/4 | `no answer appeared on kimi within 60000ms. This site requires sign-in. sign in once via ui2api analyse https://www.kimi.ai --login — sessions live in localStorage (access_token/refresh_token/msh_user_id) replayed as 'Authorization: Bearer <access_token>' against https://notilo.kimi.com/apiv2` |
| copilot-m365 | **SIGN-OUT** | 502 | 157283 | 2/4 | `no answer appeared on copilot-m365 within 60000ms. This site requires sign-in. Entra ID (Microsoft Entra) sign-in only — MSA/consumer accounts are blocked (blockMsaFed:true)` |
| chatgpt | TIMEOUT (void) | 000 | 200042 | 3/4 | no response (client abort) |
| claude | TIMEOUT (void) | 000 | 200017 | 4/4 | no response (client abort) |
| copilot | TIMEOUT (void) | 000 | 200005 | 4/4 | no response (client abort) |
| deepseek | TIMEOUT (void) | 000 | 200008 | 3/4 | no response (client abort) |
| tencent-aistudio | TIMEOUT (void) | 000 | 200017 | 4/4 | no response (client abort) |
| duckduckgo | TIMEOUT (void) | 000 | 200009 | 3/4 | no response (client abort) — **known-good control; proves the class is contention** |
| grok | TIMEOUT (void) | 000 | 200005 | 4/4 | no response (client abort) |
| poe | TIMEOUT (void) | 000 | 200040 | 3/4 | no response (client abort) |
| t3chat | TIMEOUT (void) | 000 | 200017 | 4/4 | no response (client abort) |
| v0 | TIMEOUT (void) | 000 | 200006 | 4/4 | no response (client abort) |
| perplexity, huggingchat, hunyuan, blackbox, codex, inner-ai, manus, notion, venice | **NOT MEASURED** | — | — | — | run did not reach them (service wedged; shard cancelled) |

**The control is the proof.** `duckduckgo` was measured OK by the operator minutes before this
audit and returned an empty 200s+ abort here. A model that demonstrably works cannot be
classified as a timeout model. Every 4/4 row is therefore a measurement of the queue, not the site.

## 3. Failures grouped BY CAUSE

### Cause A — POOL WEDGE (dominant; explains 11 of 13 failures, and the operator's `deepseek` timeout)
**Not a slot leak. A slot legitimately held by work that never finishes.** Root-cause chain,
with citations from the forensic pass:

1. `awaitAnswerFromReads` (`src/runtime/dom-primitives.ts:183-188`) bounds the **poll loop**, not
   the awaited CDP call. `await read()` → `page.evaluate` (`dom-primitives.ts:324,356`) has **no
   timeout** — nothing in `src/` sets a page default (`grep setDefaultTimeout` → zero hits).
   A single `evaluate` that never returns hangs the loop forever.
2. `driver.ask()` never settles. `src/prompt/http.ts:1109` / `src/prompt/openai.ts:984` await it
   forever, so `pool.release()` at `http.ts:1110/1125` and `openai.ts:1000/1292` is **never
   reached**. (Both call sites DO release on throw — a throw cannot leak. A hang can.)
3. `UI2API_REQUEST_TIMEOUT_MS` (300 s) is a `Promise.race` that only sends a 504
   (`http.ts:1320-1349`). It **cannot cancel the driver**, so it converts a client-visible hang
   into **silent permanent slot loss**. The code comment at `http.ts:1331-1333` claiming "the pool
   is still released by its own handler" is false in exactly this path.
4. The reaper skips busy workers unconditionally (`pool.ts:751  if (w.busy) continue;`). No
   watchdog reads `busySince` — `pool.ts:844` only formats it for `/status`.

MEASURED consequence: `busyMs` climbed 282s → 333s → 1569s and never released, across two
independent wedge events. The pool also **shrank 4 → 2** during the first event, so capacity loss
is permanent per wedge, not transient.

### Cause B — CROSS-SITE HEAD-OF-LINE BLOCKING (this is what turned 4 broken sites into 22 broken)
`max` is a **global** ceiling (`pool.ts:209-214`) with **no per-site reservation** — `perSite` is
reporting-only (`pool.ts:811-821`). So 4 wedged kimi workers starve copilot, gemini, and
duckduckgo. Measured: `copilot` returned an **empty response after 100 s** purely from queueing,
and `waiterTimeoutMs` (240 s) is deliberately set **above** `requestTimeoutMs` (300 s), so the
queue cannot out-refuse the work it waits for. This is Cause A amplified from "one site down" to
"whole service down".

### Cause C — MISSING / UNUSABLE SESSION (genuine, per-model, cheap to fix)
`kimi` and `copilot-m365` returned **named, actionable 502s** — the server told us exactly what
is wrong. These are the only two *honest* per-model failures in the set, and both are fixable by a
human login, not by code.

### Cause D — UNVERIFIABLE CLAIM (structural; affects all 22)
`status: "verified"` is **asserted, not measured**. `packageStatusOf` (`registry.ts:408-425`)
returns `verified` iff `capabilities/<id>/metadata.json` contains a `verified` object with three
string fields. The gate is **shape only** — `"proof PASS 13965"` is prose no code parses. There
is **no self-healing**: nothing downgrades a model after an `ok:false`, so a site that breaks
tomorrow still advertises `verified` forever. `verified: false` on a 6-model `builtin` entry means
"never tried", not "broken" — but both live on the same axis, so a consumer reading only `status`
cannot tell them apart.

**Note the four causes are genuinely different bugs wearing one face.** The operator's original
read — "kimi is a vault problem, deepseek is a timeout" — is half right: kimi is Cause C *and*
Cause A, and the `deepseek` TIMEOUT was **Cause B, not a deepseek property at all**.

## 4. Ranked by blast radius x cheapness

| # | fix | cause | blast | cost | verdict |
|---|---|---|---|---|---|
| 1 | **Bound the read, not the loop** — `Promise.race([read(), sleep(remaining)])` in `awaitAnswerFromReads` (`dom-primitives.ts:183-188`) | A | **TOTAL** — 22/22 models | ~5 lines | **QUICK WIN, closes the incident** |
| 2 | **`busySince` watchdog** in `sweep()` — evict/settle a worker busy beyond a bound `< requestTimeoutMs` (`pool.ts:751`) | A | TOTAL | ~20 lines | **QUICK WIN, durable backstop** |
| 3 | **Per-site reservation / fair queue** so one site cannot consume the global ceiling | B | TOTAL | deep — pool design | **DEEP but the real structural fix** |
| 4 | **`waiterTimeoutMs` (240s) < `requestTimeoutMs` (300s)** | B | large | 1-line consistency | QUICK WIN |
| 5 | Human login for kimi + copilot-m365 | C | 2 models | human minutes | QUICK WIN |
| 6 | Make `prod-live-chat-surface-probe.test.ts` require **>=1 real answer** — it currently accepts `pool_queue_timeout` as a PASS (`prod-live-chat-surface-probe.test.ts:30-32`), so a probe where **nothing answers is green** | D | TOTAL | small | **QUICK WIN, and it is why this went unnoticed** |
| 7 | Record verification as a dated machine-readable field; gate consistency | D | all 22 | medium | see §6 |

**1 and 2 together are ~25 lines and take the advertised surface from 1/22 to potentially 22/22.**
That ratio is the entire story of this audit.

## 5. RECOMMENDATION on the honest surface

**My recommendation: (c) advertise all, mark distinctly and document — but ONLY after fix #1/#2,
and with `status` redefined from "a human wrote this" to "a dated record exists".**

Reasoning, against the three options:

- **(a) advertise all + live `status` a consumer must check — REJECT.** This is the worst of the
  three and it is *the status quo's failure mode wearing a hat*. A live `status` field is
  precisely the thing a consumer will not read: the OpenAI SDK carries unknown fields in
  `model_extra` (legible but not universal), and any hand-rolled or strict-schema client silently
  drops it. A correctness property the consumer must opt into is not a correctness property. It
  also cannot be made honest *today*, because the honest answer for most models is "I don't know"
  — and a live probe per model is itself a browser round trip, so the status endpoint would wedge
  the pool in exactly the way §3 Cause A describes.
- **(b) advertise only the verified set — REJECT as the primary move, and this is the part worth
  being firm about.** The user's own worry is right: shrinking the list is unstable and breaks
  consumer config. Worse, the input to the decision is *untrustworthy* — the "verified set" is
  whatever a human last typed into a JSON file, with no expiry and no self-healing. Publishing
  today's 6 `verified` models as a promise would make the daemon **strictly worse**: it would
  drop 16 models, including `copilot`/`perplexity`/`huggingchat`, which are `loginRequired:false`
  and anonymous, and would ship a promise backed by the same unverified prose. A smaller list
  whose membership is itself unmeasured is a **more confident lie**, not a smaller one.
- **(c) advertise all, mark unverified distinctly, document — ADOPT.** It keeps the list stable,
  it never silently drops a model a consumer depends on, and it makes the honest state legible
  to a consumer who looks. The 6 `verified` / 6 `builtin` / 10 `unverified-candidate` split is
  *already* in the payload today at zero cost — it just isn't trustworthy because `verified` is
  shape-gated prose.

**But (c) is not sufficient on its own, and I want to be direct about this:** marking honestly
does **not** fix the finding. An agent that reads only `id` still builds 22 providers, and 21 of
them will not answer. The user's framing is right that a list of 22 yielding 12 is worse than an
honest 12 — so the highest-value action is **not a listing decision at all. It is fix #1 and #2,
which make the list's implicit promise true.** The listing change is the cheap complement to a
bug fix, not a substitute for it.

**The one addition I would make to (c): a `verification` block carrying `since` + `method` +
`recordPath`, and an explicit `answersVerified: false` on anything not re-measured within the
staleness window.** `duckduckgo` (anonymous) and `tencent-aistudio` (headed-only; EdgeOne blocks
headless) carry materially different preconditions under one uniform "verified" label — that
distinction today lives only in `verified.via` prose.

## 6. The gate — is it hermetic? **No.**

**A hermetic `test/model-actually-answers.test.ts` is not buildable, and shipping one would be
worse than shipping none.** Three independent blockers, all verified:

1. **No fake-browser harness exists.** `test/helpers/` holds four files (`acp-harness`,
   `ci-contract-scan`, `doc-scan`, `requirements-seams`) — none a browser fake. `test/fixtures/`
   has only `registry/` and `sample-plugin.ts`. The only `chromium.launch` references test the
   launch seam itself.
2. **Every existing "answer" is a hardcoded stub.** `STUB_ANSWER` (`model-capability-truth.test.ts:56`),
   `"2 + 2 = 4"` (`chat-surface-merge.test.ts:116`). `ChatPool` is a concrete class, hand-satisfied
   by tests. Stubbing is exactly what makes them hermetic and exactly what makes them prove
   nothing about answering.
3. **Where a real daemon IS started, the browser is deliberately unreachable** —
   `UI2API_ATTACH_PORT = "1"` in three files. The strongest claim available is
   `assert.notEqual(status, 404)`, whose own comment (`chat-surface-merge.test.ts:430-431`)
   concedes the pool attempt fails only because attach mode is refused.

The only driver seam takes a **real Playwright `Browser`** (`driver.ts:98-100`). A hermetic
"actually answers" test would have to **fabricate the answer** — the exact class
`test/no-fabricated-traffic.test.ts` exists to forbid.

**Current gate landscape (why this went unnoticed):** every "advertised model is servable"
assertion is ROUTING, resolved from a stub —
`v1-surface-agreement.test.ts:208`, `model-capability-truth.test.ts:176`,
`capability-dispatch-table.test.ts:41`. **Zero WORKING gates.** The two live probes
(`prod-live-chat-surface*.test.ts`) run **no skip guard** and would go red on a daemon-less CI
container — and `prod-live-chat-surface-probe.test.ts:30-32` accepts `pool_queue_timeout` as a
legitimate pass, so **a probe where nothing answers is green.** That is the specific gap.

### Proposed alternative: a stamped verification record + a consistency gate

**Record** — a checked-in dated JSON, e.g. `capabilities/<id>/metadata.json` (extend the existing
`verified` object) or a new `capabilities/model-verification.json`:

```json
{ "model": "gemini", "measuredAt": "2026-09-29T12:05:11Z", "class": "ANSWERS",
  "evidence": "POST /v1/chat/completions -> 200 'Gemini said PONG', 28940ms, pool 0/1 clean",
  "method": "live-v1-chat", "prereq": "vault-replay", "daemonCommit": "<sha>" }
```

**Gate** (`test/model-verification-consistent.test.ts`) — fully hermetic, no browser, no network:

- every id in `defaultChatSurface()` has a record → else fail, naming the model;
- every record names a model still advertised → else fail (stale record);
- every record has `measuredAt` + `method` + `evidence` → else fail;
- a record older than a disclosed staleness window is reported as a **budget** that must not
  silently grow (the `ci-contract-knob-cites.test.ts` `UNDOC_BUDGET = 0` pattern);
- a `MUTATION:` test proving the gate can fail.

**Today this gate would fail honestly at ~1/22 measured.** That is the point: it converts a prose
claim into a **failing, shrinking, named number** — and the existing 10/33 `metadata.json`
coverage shows the layer was already built for this and never finished. Note it must also be
added to `package.json` `scripts["test:unit"]` or `doc-numbers-truth.test.ts:272-283` fails it as
unrun.

**Critically: a consistency gate proves the RECORD is honest, not that the MODEL works.** It
cannot catch Cause A. Only the pool fix can. I will not let the gate be mistaken for a working
check.

## 7. What I could NOT measure — explicit

- **19 of 22 models are unmeasured as models.** 11 are void (contended) and 8 never ran.
- **The pool must be restarted before any re-measurement is meaningful.** It is wedged at
  `busy=4/4`, `busyMs` 1029–1569 s, unrecoverable without a restart — which I was instructed not
  to do. **I wedged the service by measuring it; that is on me, and it needs a restart to recover.**
- I therefore **cannot confirm or deny** the user's original hypothesis that a large fraction of
  the 22 are advertised-but-unanswerable. My data is consistent with it (only 1 measured
  ANSWERS) but Cause A fully explains the observation, so **the per-model question is still open.**
- Root-cause claims about Causes A/B/D are **static code analysis + the measured `busyMs`
  evidence**, not reproduced by an instrumented run. I did not add logging.
- `npx tsc --noEmit` = 0. I modified no source file. Full suite NOT run, per instructions.
