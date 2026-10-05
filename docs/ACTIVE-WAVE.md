# ACTIVE WAVE — 2026-10-02T06:40Z (SEVENTH)

| task_id | lane | owns |
| --- | --- | --- |
| `da1395db-bdd8-4c40-94d8-51bb62d585df` | chrome profile path divergence | **CLOSED** — see CLOSED #1. The probe is gone, the path has one owner, `test/chrome-profile-path-truth.test.ts` now exists and compares every restatement |
| `b4f765a7-3c34-4466-a4b2-0f8f2473a3cf` | browser-dependent UNIT tests | MERGED: `aa4e650` — the maybe() guard asked is the DAEMON alive, not can the BROWSER launch. **CLOSED for wigolo** (CLOSED #2); `session-store`/`prompt` survive as OPEN #1 |

| `e51f0a5b-5f39-4119-aab0-a875b1686a26` | the swallowed warm-up failure | **CLOSED** — see CLOSED #3. GOAL 178 made `warm()` return a `WarmOutcome` carrying the thrown error verbatim |

Collect with `get_delegation_status` on 1-2 ids at a time, re-armed until
terminal. **A turn must never end with a task still `running`.**

## EVERY WAVE SO FAR — collected and merged

1. `b1cb4e6` account-refusal owner · `91f787a` concept-word derivation ·
   `a90f439` class record · `f5a708a` SIGN-OUT runbook.
2. `ec85a66` origin divergence + `pushToMirror` allowlist · `8859f2a` error-seam
   concept list (six live leaks) · `326f377` goals-index closure.
3. `b314424` visibility probe + derived forms · `b0390c6` the probe's own tests
   were environment-dependent · `4027a06` the EMPTY commit-map artifact + jq.
4. `977df81` unbounded execFileSync in my own guard · `7ec59cd` the missing
   `mkdir` the loud failure exposed · `ab4c8e8` the reconstruction runbook +
   the backwards map orientation.
5. `b594efb` the silent browser skip, now a machine-readable verdict ·
   `8b77370` duplicate ownership repo-wide (a release artifact could ship
   `.brain` and print "exclusions re-checked: clean").
6. `6b9d673` the knob table's own stated figures, 62/0 -> 68/4, now asserted.

**Three lanes died across the session** (`child_rejected`, external — not an
operator stop). Their residue was read from the tree rather than re-requested,
and that is where the account-refusal fix and the lane-with-a-vacuous-gate came
from. A dead lane is not a failed lane.

## THE TWO PATTERNS, AND WHY THEY ARE THE SAME PATTERN

**Every gate a lane shipped was VACUOUS under mutation.** A file count where the
question was an occurrence count; four regexes where the code had an exec surface;
a pinned list where the vocabulary was derivable; a completeness gate silent on
its own class; a concept list typed three times, two leaking; a regex derivation
so broken it matched nothing; a gate that only checked the code NAMED the owner
rather than USED it; and one test asserting a hole I had just closed, so it would
have reported a fixed defect as open.

**Every mutation of MINE that did not fire was my mistake, not the gate's** —
three times: a comment when the gate pinned the runbook's HTML anchor, a prose
sentence when it pinned an anchor, and a misspelled GitHub handle in my own test.

The rule that follows from both: **mutate what the gate PINS, and if it still
does not fire, read the gate before touching anything else.**

**And duplication does not stay in sync — it drifts, silently.** Five facts with
duplicate owners today; six of twelve live divergences found in one sweep,
including a release exclusion list where the copy that checked the SERVED bytes
was the one missing `.brain/`.

## MEASURED AND STILL TRUE

- `origin` is GitLab for fetch and push; **zero remotes reference github.com**.
- The public destination has exactly one writer, and every push is preceded by a
  fail-closed proof of each destination's identity and declared visibility —
  asymmetric, because the public repo is deliberately public.
- **The commit-map artifact is finally real**: 38,050 bytes with 662 + 663 rows,
  after 13.4 hours of shipping 190-byte empty directories. Its format is verified
  against a LIVE `git filter-repo` run — header `old  new`, and a pruned commit
  present with forty zeros in column 1 — and the runbook is pinned to that
  measurement rather than to prose.
- A green pipeline can no longer hide an unrun browser half: `npm test` writes a
  verdict stamped with `$CI_JOB_ID`, and the discriminator is *which library* is
  missing, so a foreign Debian mirror fault keeps its skip while a library this
  project shipped goes hard red.
- Artifacts-uploader 500s are a burst, not a rate; `github_release`'s artifact is
  kept deliberately (it is the only copy on the RELEASE-SKIP path).

## CLOSED SINCE THE LAST RECONCILIATION — the record, not the work list

The two "STILL OPEN" lists this file used to carry were written across earlier
sessions and **duplicated each other** (7 + 7 entries, 7 unique). Reconciled
against the code on 2026-10-03: **3 of the 7 were fully stale, 2 were half
stale**, and the genuinely-open residue is the single list at the end of this
file. Closed here so the record is not lost — **a list nobody trusts is a list
nobody reads**, and an item deleted without a trace is an item that gets
re-opened.

1. **Chrome profile path divergence — CLOSED.** `defaultCopiedProfileProbe` is
   gone from `src/runtime/requirements.ts` (its absence is the fix; the doc block
   at `requirements.ts:254-288` is the record). The path now has ONE owner,
   `resolveChromeOwner()` (`src/runtime/chrome-owner.ts:251`), which is what
   `launchBrowser()` consumes, so the readiness gate and the launch seam cannot
   disagree by construction. The `.ui2api-chrome` spelling was MEASURED under
   `sudo -n` to be a 187M dead orphan (`requirements.ts:265-272`), not guessed.
   The cross-language restatements are compared against the derived value by
   `test/chrome-profile-path-truth.test.ts` (325 lines) — which `requirements.ts:277-279`
   admits **did not exist** when the comment first named it.
2. **`wigolo-engine.test.ts`'s `maybe()` asked the wrong question — CLOSED.**
   `test/wigolo-engine.test.ts:131-176` replaces it with `guardBrowser`, which
   probes the REAL seam (`ctx.dom.extract`) — a daemon that is healthy but whose
   browser tier cannot launch now produces a NAMED red, not a silent skip (GOAL 151).
   **The `session-store.test.ts` / `prompt.test.ts` half of this item did NOT
   close** and survives as open item #1.
3. **`http.ts:893` swallowed a real spawn failure — CLOSED.** GOAL 178 made the
   cause MEASURED rather than inferred: `warm()` returns a `WarmOutcome`
   (`src/prompt/pool.ts:232`, `:586`) carrying the thrown error verbatim, and
   `BootWarmStatus.outcome` (`src/prompt/http.ts:906`) forwards it. The catch
   is deliberately untouched — the daemon still starts. Gated by
   `test/boot-warm-real-cause.test.ts:80,101,127,148`. The ledger's separate claim
   that `codefor-prose-table.test.ts:76-79` "asserts `startPromptd` never warms
   the pool, which is factually wrong" is **superseded**: that file's header
   (`:83-95`) now explains the pre-built-pool seam AND pins
   `UI2API_ATTACH_PORT=1` so a boot warm cannot really spawn a Chrome.
4. **`package.json`'s `test:unit` as a duplicated owner — CLOSED BY DECISION.**
   The design named `scripts["test:unit"]` the SINGLE owner and derived
   everything else from it: `test/doc-numbers-truth.test.ts:224` fails any doc
   that hand-types a second owner, `:89` derives the file list from the script,
   `:346-356` asserts on-disk == script in BOTH directions (so a file dropped from
   both still moves the derived count), and `:359` is the mutation test. The
   "forbidden to edit" constraint was never the blocker — the gate reads it.
5. **`error-redaction.ts`'s module-level `g`-flagged regex — CLOSED.** The
   scrub's `INTERNAL_WORD_RE` (`error-redaction.ts:252`) is `g`-flagged but used
   only through `.replace()`; the gate `RESIDUAL_INTERNAL` (`:337`) is built from
   `INTERNAL_WORD_RE_NON_GLOBAL` (`:262`), a SEPARATE non-global instance over the
   SAME vocabulary, precisely because `.test()` on a `g` regex advances
   `lastIndex` (doc block `:257-262`). Every `g`-flagged regex in `MECHANICAL`
   (`:265-279`) is consumed exclusively at `:303`. **The digit-suffix half of this
   item did NOT close** and survives as open item #4.

### And three of the four "more duplicate owners" closed

- **pool refusal codes (3) — CLOSED.** `POOL_REFUSAL_CODES` (`src/prompt/pool.ts:191`)
  lives next to the throw; `src/prompt/http.ts:52` imports it and `:790-793` labels
  from it. A reword can no longer desync the emitter from the labeller (GOAL 145).
  The CODE is deliberately hand-written, not derived — it is a published contract
  string a PHP consumer branches on (`pool.ts:186-190`).
- **`attachRefusal` re-framed by four runners — CLOSED.** One helper,
  `src/runtime/file-attach.ts:115`. `youtube.ts:640`, `duckduckgo.ts:594`,
  `kimi.ts:660` and `gemini.ts:569` all CALL it; they are consumers, not owners.
- **`consumerAccountRefusal`'s opening clause vs its two classifiers — CLOSED.**
  `src/prompt/error-redaction.ts:29-45` imports the owner from `consumer-surface.ts`
  and never re-types it, because redaction is not a licence for a second owner.
  Pinned two ways by `test/error-redaction.test.ts:224` (the clause is typed in
  exactly ONE file under `src/`) and `:344`/`:347` (the redaction path emits the
  owner's bytes). **The no-answer matcher half did NOT close** — open item #2.

### One duplicate owner was only PARTLY consolidated

- **The 14 inline login-gated refusal strings — MOSTLY CLOSED.** Twenty runners
  now call the single `loginGatedResult()` (`src/capabilities/gated.ts:38`).
  `src/capabilities/araprat.ts:247` keeps a private near-duplicate of the same
  sentence with `Aparat` and a literal URL hard-coded where the helper takes
  `${siteId}`. Second owner survives — open item #3.

## THE THIRD PATTERN, found late: environment-dependent controls

Three gates in this session asserted something about **this machine** rather than
about a contract, and all three failed in CI for a reason unrelated to what they
protect:

1. the probe's own tests assumed `jq` was on PATH — fixed by skipping with a named reason;
2. the chrome positive control said "this box HAS a live owner profile" — failed on 1251;
3. my replacement said "resolveChromeOwner() returns a profile given a synthetic
   root" — the signature takes NO arguments, so the cast was a lie, and it failed
   on 1258 with a null profile.

**And the second one failed while LOOKING hermetic.** "Pass a root through a cast"
is not a fixture; it is an unchecked assumption with better manners. The seam to
drive was there the whole time (`chromeOwner?: () => {user, profile, missing}`) and
I reached past it to the real resolver twice.

The rule that follows, and it is the same rule as the mutation one: **a control
must exercise the seam the code under test consumes, and must be provable to bite
before you believe it.** Pointing that seam at `profile: null` -> 1 FAIL is what
makes the control a real assertion rather than a comment.

## THE ONE LIST — every item CLOSED 2026-10-04

**STATUS 2026-10-04: EVERY ITEM BELOW IS NOW CLOSED.** This section is kept as the
record of what was open and what closed it, because **an item deleted without a
trace is an item that gets re-opened** — the same rule this file already states
about its own two duplicated lists. The live residue is at the END of this file.

Every closing below was **verified by the orchestrator, not by the lane that wrote
it**, because nine lanes died (`child_rejected`, external) during the wave that
closed them and a dead lane leaves work with no report and no tests anyone ran.
Each closure is mutation-proven in both directions where a gate was involved.

### 1. Unguarded browser launches in `session-store`/`prompt` — **CLOSED**

Both files now import `guardBrowser` from `test/helpers/browser-launchability.ts` —
the seam `wigolo-engine` already used — wrapped in a local `guarded` helper. The
property that mattered is that **the guard CANNOT SKIP**, and that is an assertion
rather than a claim: the gate collects every `t.skip` the guard makes and asserts
the list is empty.

Proven as a **negative control** by forcing an unlaunchable browser
(`UI2API_CHROME_PATH=/nonexistent/chrome UI2API_ATTACH_PORT=1`): the run reported
**`skipped 0`** and a **named** verdict — *"browser not launchable via the
ui2api-ladder seam — classified launch-regression … this is the launchability
guard, not the test body"* — including a self-test named *"the launchability guard
NAMES an unlaunchable browser instead of skipping it"*. That is the whole
difference the item was about: **a mystery became a verdict.** Normal behaviour
unchanged (session-store 9/9, prompt 6/6). Commit `ba0af59`.

### 2. The no-answer matcher hand-typed a mirror of its emitter — **CLOSED**

`src/prompt/error-redaction.ts` now owns the wording as `NO_ANSWER_REFUSAL_CLAUSE`
(`:103`); the emitter renders it through a `{clause}` hole (`:118`); and
`NO_ANSWER_REFUSAL_RE` is **computed** from that clause plus the timer pattern
(`:131-132`). `verification-class.ts:44` **imports** the derived matcher instead of
holding a pattern, so its array member *is* the owner. The comment that made the
false derivation claim now states what is true — **half of this item was the
comment**, since a comment lying about its own derivation is the defect, not the
regex. The sentence went from **four** homes to one.

Gates in `test/error-redaction.test.ts`: the clause is typed exactly once under
`src/` (the classifier may not re-type it), and "ONE OWNER: the no-answer refusal
is authored in exactly one place". Both **strip prose first**, by the same rule as
the sibling gates — **a comment quoting the clause is not a second owner.**

Mutations: rewording the **owner** clause turned both of those files red, so a
reword can no longer pass silently; injecting a hand-typed second owner into the
classifier failed **both** one-owner gates. Per-file counts are a runtime-only
fact — read them from a run (`npx tsx --test test/error-redaction.test.ts`,
`test/verification-class.test.ts`) rather than trusting the numbers written here.
Commit `4feeb2f`.

### 3. `araprat.ts` was a second owner of the login-gated refusal — **CLOSED**

The private `loginGated()` builder is gone; the posting caps return
`loginGatedResult(this.profile.id, capability)`, the single owner at `gated.ts:38`.
The gate in `test/mutating-capability-postcondition.test.ts` scans **every
TypeScript file under `src/`**, so "typed in exactly one place" is a real property
rather than a claim about one file, and it **strips prose first** for the same
reason. Mutation: re-introducing the private builder fired it — *"no runner keeps a
private login-gated builder; every login-gated runner CALLS the owner"* (14 pass /
4 fail). Commit `14bb4ad`.

### 5. No reconstruction runbook consumer was automated — **CLOSED**

`scripts/ci/verify-commit-map.sh` now **executes** the documented procedure instead
of trusting prose, and it is **wired** (`scripts.check:commit-map`) — because a
consumer nothing invokes is still inert. It is **not** a session-resume script; the
runbook is about a REPOSITORY.

Checks **derived from the runbook**, not invented: the header is `old` then `new`
compared **whitespace-split** (because filter-repo's `%-40s` pads it — a raw-line
comparison would itself be the orientation bug this item exists to catch); rows are
exactly two 40-hex fields; and the **forty-zero pruned row is accepted**, since §2.1
calls it *"the single most misread fact"*. A deliberate **non-check**: no count, no
sha-existence, no set-membership — §2.1 records that the count prose was **false**
before 2026-10-01, so pinning counts would re-encode the defect, and those need the
repositories rather than the file (P7 owns them).

Measured exit codes: good map **0**; flipped header **1**
(`header-orientation (column 0 of line 1 is "new", expected "old")`); row missing
its second field **1** (`row-shape …`); no args **2**. Its test is
`test/verify-commit-map.test.ts` — run it for the live per-file count.

**Two facts it corrected in my own brief:** the **`private-full` map has NO header**
— it is a bare column of shas, not a correspondence — so the orientation check
applies only to the `public-sanitized` map, which is the only artifact this
consumer accepts. Commit `92f129f`.

### GOAL 238 — `hub publish` reached three `resolve()` seams unvalidated — **CLOSED**

Not on this list; it came from the friction hunt and the lane **disproved its own
brief** while closing it. See the CLOUD-shaped entry in `.brain/verbatim-goals.md`
round N+192. Commit `f25c5d0`.



**This replaces the two duplicated "STILL OPEN" lists this file used to end
with.** Those were 7 + 7 entries over the same 7 unique items, written across
earlier sessions. Reconciled against the code on 2026-10-03: everything that
closed is recorded with its closing `file:line` in the CLOSED section above, and
what follows is the residue — **only items proved still open**, each with the
evidence that it is. Nothing here is closed on the strength of a `grep` hit or
the ledger's age; where the code and the old wording disagreed, the code won and
the disagreement is named.

## ROUND N+194 — five lanes, five closure classes (2026-10-05)

Dispatched by `brain-L0-restart` from the round N+193 hunt ranking. All five slices were
**collision-free** (checked with `git status --short <paths>` before dispatch — each lane's
paths were clean, so no lane waited on another), so they went out as five parallel siblings
in ONE step. Each lane was mutation-proven and the fixes were independently re-verified at
fan-in.

| lane | closed | commit |
| --- | --- | --- |
| `l1-profile-ingest-array-guard` | `profile-ingest.ts` `prefs?.account_info?.find` — optional chaining guarded ABSENCE, not wrong TYPE, so a scalar `account_info` threw and `profile add-all` aborted mid-loop with earlier accounts already written (**partial write**). Now `Array.isArray`, degradation not throw. | `d7f1d3c` |
| `l1-openai-body-gate` | the `/v1` body reader had no object gate, so `body === null` reached `Boolean(body.stream)` and answered **500** with a leaked `TypeError` instead of the daemon's named 400. Mirrored `http.ts:738`. | `f4601cb` |
| `l1-registry-status-provenance` | `/registry` republished `metadata.json`'s `status` verbatim, so a manifest could claim `verified` **with no record** while `/sites` said `unverified-candidate` for the same package. One resolver now owns both. Blast radius **0 of 33** — no shipped package ever claimed it. | `8bba548` |
| `l1-capability-gate-real-predicate` | **two gates certifying a private copy**: `isGuarded` re-implemented the real predicate (weakening the real one left the mutation-proof test GREEN), and the `CHAT` corpus was ten hand-typed names (a new chat runner passed, measured exit 0). Predicate extracted once; corpus derived. | `c1edbe9` |
| `l1-timeout-gate-unblind` | the timeout-discipline gate read a fixed 1200-char window and asked an unanchored `/\.kill\(/`, so an unbounded spawn was vouched for by a **neighbouring child's kill 40 chars away** (measured: `scanSource` returned `[]`), and a real kill 1400 chars out was a false positive. Now the kill is **attributed to the child the spawn bound**. | `9e937a7` |

Fan-in re-verification (orchestrator, not the writing lanes): `tsc --noEmit` **0**,
`tsc -p tsconfig.test.json --noEmit` **0**, and the four gate files **55 tests / 54 pass /
0 fail / 1 skipped**, plus the two openai surfaces **30/30**. `gate-wiring`'s both-directions
rule held: no lane created a new `test/*.test.ts` that package.json would have had to name.

**The pattern across all five, and it is the point:** every one of these gates/codes was
**green while defective** — a gate that vouched for a copy, a status passed through as a
claim, a 1200-char window, an optional chain in the place of a type check. A green suite is
evidence about the assertions that ran, never about the code's honesty.

### ROUND N+194b — the Chrome-wedging pair, one lane CLOSED (2026-10-05)

Four lanes dispatched in one step from the same ranking, again collision-checked first.
Two of the four targets converge on ONE failure mode, which is why they rank where they do:
**a Chrome this repo cannot account for wedges the box.** `chrome start` refuses with
`Failed to create … ProcessSingleton`, forever, until a human runs `pkill`.

| lane | state |
| --- | --- |
| `l1-browser-orphan-kill` | **CLOSED — `c812df5`.** `killGroup` was defined and wired at `:546`, *after* `await connectWithTimeout(...)`, so every throw between the spawn and that line propagated with a real `google-chrome` still running. Now the child is killable at the instant it exists. Verified by me at fan-in, not by the writing lane: `test/runtime-launch-seam.test.ts` **7/7**, including `THE ORPHAN KILL — the spawned process is killable at the instant it exists`. |
| `l1-chrome-daemon-atomic-state` | **open** — `src/runtime/chrome-daemon.ts` + `test/chrome-daemon-reuse.test.ts` carry uncommitted residue (+187 / +246 lines). Its half of the same failure mode: a racing `start` records a **dead** child's pid as `origin:"spawned"`, so `chrome stop` kills nothing and the live Chrome becomes unstoppable. |
| `l1-infocache-type-guard` | **open** — `src/runtime/profile-ingest.ts` + `test/profile-ingest.test.ts` carry uncommitted residue (+75 / +141). Closes the whole class its sibling started: `info_cache` and every other untrusted on-disk read guarded by TYPE, so a malformed shape degrades to the existing honest fallback instead of forking a vault identity. |
| `l1-openai-body-cap-413` | **open** — `src/prompt/openai.ts` (+129) carries uncommitted residue. An oversized `/v1` body answers **400 `invalid_json`** where the daemon answers **413 `payload_too_large`** — a caller told its JSON is malformed, retrying forever on a false diagnosis. |

**All four are now closed, and each needed RESCUE rather than replacement** — the lanes'
sessions died mid-run (message counts frozen, then `status: canceled`) exactly as the doctrine
anticipates, and `resume_delegation` on the **same** `task_id` brought every one of them back to
finish its own task. **No lane was re-dispatched from scratch and no work was thrown away**; the
residue in the tree was the thing each resumed session picked up. That is the whole point of
LAW 12: the surviving edits were good, and the session that understood them was still recoverable.

| lane | closed at | what the resumed lane proved |
| --- | --- | --- |
| `l1-browser-orphan-kill` | `c812df5` | the child is killable **at the instant it exists**, so no later throw can leak it. Verified by me at fan-in: `runtime-launch-seam` 7/7. |
| `l1-chrome-daemon-atomic-state` | `648aae8` | state written **temp + rename** (atomic) with `0600` preserved, and a **dead child pid is never recorded as `origin:"spawned"`** — the interleaving that made the live Chrome unstoppable. CAS on the observed prior state chosen over a lock file (no stale lock to reap). |
| `l1-infocache-type-guard` | `f300686` | every untrusted on-disk read guarded by TYPE via `untrustedRecord`/`identityString`, no try/catch. **Three** defects, not one: a wrong-typed leaf (`email = 42`) still reached `slugifyIdentity`; an `info_cache` **array** made `Object.values(...)[0]` attribute a named profile to `Default` (**a wrong vault slug with no crash at all**); and a byte-**array** `encrypted_key` was silently accepted by `Buffer.from` and **forged** a 16-byte key, so every cookie would decrypt with garbage. |
| `l1-openai-body-cap-413` | `f55c32c` | oversized `/v1` body answers **413 `payload_too_large`** with `connection: close`, socket destroyed only after the answer flushes (the daemon's order — its reverse is what made this class unsendable). **The two limits did NOT agree**: `/v1` capped `raw.length` in UTF-16 units, i.e. up to ~4 MB of bytes on a surface whose sibling refuses at 1 MB — one daemon was accepting what another refused. Both numbers now re-derived from source by a gate, since `openai.ts` cannot import `http.ts` without a cycle. Also fixed in the same reader: `raw += c` on Buffers could decode a **split multi-byte character** to U+FFFD — a Persian or emoji prompt in 8 KB chunks was silently mangled before `JSON.parse` ever saw it. |

### ROUND N+194c — the shipped-file gate was RED because of a registration I owed (2026-10-05)

`gate-wiring` R4/R5 were failing on **five** test files no npm script ran. Four were **untracked**
(a concurrent workstream's in-flight files) — naming those would be naming files the repo does not
ship, which is the *opposite* direction of the same rule, and the gate correctly refused it. **Two
were tracked and shipped**: `test/driver-latency-ledger.test.ts` and `test/pool-release-busy-window.test.ts`.
Commit `d52a8c4` names those two, by reading `git ls-files` rather than `readdir` so the fix cannot
name an untracked file. Gate re-run by me: the two shipped-file failures are gone; the residual red is
entirely the foreign untracked set, which is not mine to register.

### ROUND N+194d — the "gate that certifies nothing" hunt, and one lane that corrected its own brief (2026-10-05)

Two read-only audit lanes ran in parallel (one on the `restartBrowser` leak, one sweeping every
gate for the **certifies-a-private-copy** class that round N+194 had just closed twice). The audit
found **5 real instances with executed falsifiers**, not reasoned ones — and then one of the
repair lanes **disagreed with the audit's own number**, which is the more useful result.

| lane | closed at | what it proved |
| --- | --- | --- |
| `l1-restart-worker-teardown` | `bb2dc7e` | `restartBrowser()` closes only the **idle** dropped drivers — **not the busy ones**, because a busy one self-cleans via its own `release()` and closing it would be a *new* worse defect. It also **disproved the audit's suggested fix** by verifying from `driver.ts:960-978` that in attach mode `close()` reaches only `this.page` (the shared context is never touched; `ownsBrowser` is false whenever the pool passes a browser), then made its own patch narrower than the brief. |
| `l1-readiness-gate-measured` | `9e43cea` | `production-readiness-gate` criterion **3.3** was a grep for the *identifier* `typedClientErrorCodes` standing in for "the error contract is measured" — emptying that function's body left readiness **green**. Now it runs the real measurement, extracted to `test/helpers/error-contract-measure.ts` so both gates share one implementation (importing a `.test.ts` under `node --test` re-registers its tests — a hazard already recorded at `test-timeout-discipline.test.ts:245-250`). **3.2** matched `--test-timeout=\d+`, which cannot tell a working bound from `999999999` **or** from `1`; the window is now **derived** from `test-timeout-discipline`'s own assertions. **3.5** was literally `() => true` and is now **relabelled** — it pins the CI hand-off instead of pretending to have run `tsc`, and the comment says so explicitly. |
| `l1-output-truth-read-tails` | `38a89e4` | `capability-output-truth`'s `READ_TAILS` silently `continue`d past every unrecognised tail — the worst possible default in a gate, converting "I do not know" into "all fine". The classifier is now **total by construction** (`readback/state-flip/delegating/refusal/undispatched`, no `unknown` member), asserted to sum to the corpus. **It refuted the audit's "69 unclassified": the real figure is 110 skipped, of which only 3 can genuinely fabricate `ok:true` off a page read** (`duckduckgo_chat`, `duckduckgo_file_upload`, `duckduckgo_reasoning`). Suite ends honestly GREEN — the readback surface grew 15→25 and all 10 newly-covered are asserted, and the derived fakeable set independently reproduces the pre-existing 5, which is real cross-check evidence rather than a coincidence. |

Also fixed directly by me at fan-in: `ff9bd19` — `test/chrome-daemon-reuse.test.ts:237` had an
**unbounded `spawnSync`**, a *committed* real `test-timeout-discipline` failure. The gate that was
rebuilt two rounds earlier caught it on its first honest run, which is the clearest evidence yet
that the rebuilt gate bites.

### ROUND N+194f — the README was wrong in three places, and said so (2026-10-05)

Dispatched on the `site-status-truth` lane's own follow-up. **The brief was wrong twice and the
lane corrected both**, which is now the third time in two rounds that has happened.

- **The duplicated table is in `capabilities/README.md`, not root `README.md`** — measured 0 id-rows
  in the root file, and no test reads a root-README site table.
- **The count is 9 duplicated ids, not 8.** Pre-fix: **42 rows / 33 ids / 9 duplicated**. Post-fix:
  **33 / 33 / 0**.

**And three of the nine disagreed on the FACT, not merely the wording** — the same site published
with two different verdicts, which is the serious case:

| id | the wrong cell said | the code-backed cell says |
| --- | --- | --- |
| `zenmux` | `⬜ dead-end` | `dormant` — what `/registry` actually publishes |
| `xiaomimimo` | `✅ grounded (package)` | `dead-end` — DNS-pinned to 127.0.0.1; the table read as a healthy site |
| `chatglm` | `⬜ scaffold — url-less` | `unverified-candidate` (url-less) — url-less vs driveable is not a wording nuance |

The other six were same-fact-different-wording (`duckduckgo` as `**VERIFIED**` and as
`✅ grounded (package)`), or a probe-sweep row that had drifted into looking like a status row.

`858e87b` also pins the class: `duplicateStatusIds()`, a row-count == distinct-id-count check, and
a **runtime-vocabulary** lead-word check so every cell leads with a word
`chatSurfaceStatus`/`packageStatusOf` actually returns — **no invented status word**. The gate now
goes **EXIT=1 naming all 9 with both cells quoted**, where the old one was **9/9 pass**.

**Why this one matters more than a doc fix:** three sites were being published to a human reader
with two contradictory verdicts, and in two of the three the *false* cell was the reassuring one
(`xiaomimimo` read as a healthy grounded site when it is a DNS dead-end). The rule this repo
already states — nothing is claimed without evidence — was being violated by the summary, while the
evidence underneath was correct.

### ROUND N+194g — a crash-resume ledger cannot hold a present-tense number (2026-10-05)

`test/doc-unverifiable-counts.test.ts` was **RED** on four committed hits in `docs/agent-registry.md`
(`skills-truth 18`, `gate-wiring 52`, `105/105`, `test/wire-layer-overhead-truth.test.ts 96`). The
class is structural, not cosmetic: that file is an **append-only historical ledger**, so a bare
tally in it was true on the day a lane ran it and is false after the next commit — **it can never
be kept true**, because its truth is a function of a repo that has since moved. `AGENTS.md` already
forbids exactly this shape in its own words (GOAL 110: *"a hand-typed total is unverifiable and can
only rot silently — get the truth from a run, never from prose"*).

`84e59d2` restructured the ledger so every row carries its own run's timestamp and states that a
tally inside a row **is that row's dated observation and not a current total**, plus where the live
number actually comes from (`npm run test:unit` prints the real totals). **Row count verified 61 → 61
with `comm` showing zero ids lost** — a crash-resume reader must still find every lane that existed,
and that is the whole reason the file exists.

**AND THE ANTI-VACUITY CHECK IS WHAT MAKES THIS TRUSTWORTHY** — a gate that passes because it
stopped reading would be worse than the red it started with, so I ran it myself rather than accept
the lane's word for it. A freshly appended bare count in an undated passage is **still caught**
(`undated: ['gate-wiring 52@147']`), and the three real registry tallies are now correctly reported
as **records** with their attribution (`skills-truth 18 <- passage line 75: 2026-10-04`). The gate
distinguishes them; it did not simply go quiet.

One honest limit, measured rather than assumed: the tier-2 rule only fires on a line carrying a
**measurement-context word** (`tests`, `suite`, `green`, `records`, …). A bare `gate-wiring 52` with
no such word is invisible to it — the count rule needs the measurement framing to read it as a
claim at all. That is the correct trade (otherwise every number in a doc becomes a candidate) but
it means the rule is a *claim* detector, not a *count* detector.

### ROUND N+194h — the deepest claim in the repo is finally MEASURED, not asserted (2026-10-05)

The top-ranked open item for the whole session: **every `verified` status in this repo rested on a
hand-typed receipt.** A read-only design lane, then three execution lanes, closed it.

**The design lane found the hole is deeper than "evidence is prose":** *nothing writes
`capabilities/model-verification.json` at all.* `scripts/audit/measure-models.mjs:101` only
`console.log`s its result and `source.harness` names a `/tmp` script — so **all 22 rows are
hand-transcribed**, and the two `ANSWERS` rows carry no `answerText` even though the reader prefers
it (`test/model-verification-consistent.test.ts:255`) and falls back to a regex over prose.

**What shipped, and the corrections the lanes made to their own briefs:**
- `d3fecdd` — `capabilities/roundtrip.json` (`ui2api/roundtrip/1`), a harness, and a three-way
  CLAIMED/PUBLISHED/MEASURED gate. It corrected the design **twice**: the named read seam
  (`honestPackageStatus`) could never fire, because all 7 receipted packages declare `"active"`,
  not `"verified"` — so the gate was enforced at `packageStatusOf` instead; **and** carrying the
  imported `ANSWERS` class forward was itself the hand-typed lie, since in this vocabulary
  `ANSWERS` means a **matched per-measurement nonce** while the 2026-09-30 sweep sent a fixed
  literal `PONG`. Shipped as `class:"UNMEASURED"` + `sourceClass:"ANSWERS"` — the downgrade visible
  rather than silent.
- `b477be4`/`7ff48f4` — **I found a live measurement bug at the orchestrator level.** The harness
  posted `{model, prompt}` to `/v1/chat/completions`, which requires `messages`, so its HTTP 400
  was **its own malformed request** — and it duly recorded `gemini` as "did not answer" while
  gemini answered perfectly. A measurement tool that manufactures a false negative about a real
  site is the worst possible failure here. Fixed, and the taxonomy gained the bucket it was
  missing: **a daemon fault is not a site verdict**, so a 4xx before any browser work and a 500
  from the daemon itself are both *reported* rather than filed against the site.
- `4cc0df0` — the classifier had **no member for "a capability surface returned data"**: every
  member keyed on a chat answer, so **no capability row could ever be measured**, for 26 of 33
  packages, no matter how long the harness ran. Eighth instance of this exact class in two rounds.
  Added `RETURNS-DATA`, derived from `capabilityOk` + 2xx + a **runner-declared `count` that agrees
  with machine-counted `rows`** — so it cannot be hand-typed.

**The measurements are real.** Against the live daemon: `gemini` answered a per-measurement nonce
(`probeNonceMatched:true`, `doneReason:"stable"`, 50 chars, 19.2s), `duckduckgo` likewise, and
`araprat`'s three surfaces returned **29 search rows, 30 trending videos, 11 related records** — all
machine-counted, none typed. The empty case is decided explicitly: `rows: []` is a *successful
measurement of nothing*, filed `UNCLASSIFIED` and written nowhere, because admitting it would let
the gate be satisfied by a surface returning nothing forever.

**Where it stands, honestly:** CLAIMED 7 / PUBLISHED 7 / **MEASURED 3** (araprat, duckduckgo,
gemini). The gate is registered in `test:unit` (`c598ffa`) and is **RED on four** — deepseek, kimi,
tencent-aistudio, youtube — and **all four are one reproducible daemon fault**: HTTP 500
`internal_error` after ~60s at an idle pool, because the daemon on `:9797` runs code from before
roughly twenty commits. `AGENTS.md` names that exact lost-direction symptom and its remedy. That
is the next lane, not a closed item.

### ROUND N+194i — three real defects the measurement exposed, one of them invisible for years (2026-10-05)

Measuring the four unmeasured sites turned an opaque failure into three named bugs. **The lane
disproved my own hypothesis** — I told it the daemon was stale; it established the daemon was
`999632e`, **126 commits behind HEAD**, rebuilt and redeployed it, and the fault **survived**. My
diagnosis was wrong and the lane said so.

**What was actually wrong — one fault, two answers, from the same daemon at the same commit:**

| request | answer |
| --- | --- |
| `POST /prompt {site: kimi}` | **500** `{"code":"internal_error","message":"internal error"}` (63.7s) |
| `POST /v1/chat/completions {model: kimi}` | **502** `{"code":"ui2api_driver_error","message":"kimi did not return an answer within 60000ms — …"}` (67.0s) |

The daemon's own journal for the first already said the truth: `no answer appeared on kimi within
60000ms. This site requires sign-in…`. So the cause was known, named and correct — and `/prompt`
**erased it** into an anonymous 500, sending a capable integrator hunting a server fault when the
truth is a login-gated site. `0169578`/`ca7d62c` introduced a typed `DriverRefusal` thrown by all
seven named readback verdicts, and `/prompt` now answers `/v1`'s exact code through the imported
sanitiser. **An unknown fault is still an anonymous 500**, caller mistakes are still 4xx, and the
live body was checked for paths, `node_modules`, stack frames, `.ts:` references and Playwright
diagnostics — clean, with the single `/v1/models` token deepEqual-pinned so a path cannot hide
beside it. The armed `no-internal-error-echo` gate stayed 35/35: the previous lane projected the
caught value and hit it, this one **classifies then projects**, which is the idiom that gate's own
doc sanctions.

**`youtube_search` could never navigate — and `AGENTS.md` publishes it as VERIFIED with live
proof.** `capabilities/youtube/profile.json` pins the bare host `youtube.com`; the runner navigates
`www.youtube.com`; `ssrf.ts:8-15` requires **exact host equality**. Live symptom, named by the
guard itself: `SSRF guard: refusing to navigate … origin pinning serves only youtube.com`.

**The lane ruled out the fix I suggested — by measurement, not taste.** I proposed repointing the
profile url. It established that the url is not a label but the **vault key**: `resolveCapabilityAccount`
(`http.ts:957`) and the registry rollup (`registry.ts:1359`) both derive `data/sessions/<host>/<email>/`
from it, and the box holds one real youtube account under `youtube.com`. Repointing to `www` would
have **silently emptied the account lookup**. Instead `7e3e3a6` ships
`sameOriginAllowingWwwSibling()` — opt-in, separate from `sameOrigin()`, backed by a frozen literal
table naming **exactly one host pair**, with no existing call site changed. Eleven off-host variants
still refused, including `m.youtube.com`, `evil.www.youtube.com`, trailing-dot hosts and `:8443`.
**Live after: `youtube_search` returned 8 real Persian results** — verified by me directly.

**And a ninth instance of the class, a regex character class.** `test/helpers/error-contract-measure.ts:63`
harvests the served code vocabulary with `/return \{ code: "([a-z_]+)" \}/g` — **no digit**, so it
cannot match `ui2api_driver_error`, the very code `/prompt` was just changed to answer. The
error-contract gate was blind to it **on both routes**. I verified this in one command before
dispatching. Being worked.

### ROUND N+194j — the deploy trap was worse than reported, and the error scanner now sees (2026-10-05)

Three lanes closed. **Two of them disproved something I asserted**, which is the second time in
two rounds and remains the most valuable thing this round produces.

**`e455e2c` — the deploy trap. I said the incident was caught by `set -e` ordering. That was wrong.**
The lane reproduced the destroying rsync in a scratch tree: with `--exclude 'node_modules/'` it
**exits 0**. So `set -e` would **not** have stopped the script — the caught run aborted for an
unrelated reason, and **there was no ordering property to rely on**. It also found **16 vulnerable
patterns**, not one: `node_modules/ dist/ .git/ .brain/ sites/ .agents/ .opencode/ graphify-out/`
in both the preserve (`:199`) and stage (`:482`) rsyncs, each independently enough to destroy
something. `data/` was safe **by accident** — `--exclude '/data'` has no trailing slash.
Two independent defences shipped: a `preflight()` that runs **before the first rsync of either
tree** and refuses a symlink/non-directory at any deploy-owned name (the destroy primitive is never
invoked, so step order cannot matter), and every exclude made type-agnostic. `--delete` **stays**
— stale sources are the half-written-file class — and is safe because rsync does not delete
*excluded* destination files; `--delete-excluded` inverts that and is now **banned by a gate**
(measured: it re-opens the hole). `--delete-delay` deliberately not used: it cannot help a wrong
exclude. Registered as `6800409`.

**`9a46d95` — the error-code scanner's blindness, now measured not argued.** The old pattern
`([a-z_]+)` missed **six** served codes, and the lane classified each rather than listing them:
`ui2api_driver_error` (`http.ts:1789`, `openai.ts:1378` — the real blindness, a digit),
hyphenated diagnostics `vault-root-unresolvable` `:464`/`:545`, `vault-unreadable` `:560`,
`host-unreadable` `:591`, `vault-probe-threw` `:1553`. One shared `CODE_CLASS = "A-Za-z0-9_-"`.
**Not `[^\"]*`, which accepts prose.** Vocabulary **16 → 17**, newly visible `502
ui2api_driver_error`. Reverting the class to `[a-z_]` turns **3 of its own pins RED**, naming the
class — so the gate is armed, not merely wider. Live agreement confirmed: `/prompt` and `/v1` both
answer `ui2api_driver_error` 502 for the same condition.

**`ccdd547` — a runner failure now names its cause without `DEBUG`.** Measured **before**, on a
real daemon with `UI2API_DEBUG` unset, the stderr capture for a genuine `youtube_search` failure was
**empty**. After:
```
[ui2api] capability youtube_search failed: cause=ssrf-guard-refusal — SSRF guard: refusing to
navigate https://www.youtube.com — origin pinning serves only youtube.com, never arbitrary URLs
```
**Option 2 chosen over Option 1, and the reasoning is the interesting part:** a scrub that deletes
the diagnosis *is* the defect wearing a safety hat. So `redactFaultCause` drops node_modules
references, absolute paths, stack frames, `Call log:`, DOM selectors and URL query — and **keeps**
the guard name, both hosts and the deadline. `/status` gains `capabilityFailures: {count, last:
{capability, cause, at}}`, a **code** with no redaction pass needed. The response body is unchanged
and still says only *"see the daemon log, which names the cause"* — a log may name the cause, a
response may not. Registered as `dd0a587`.

### ROUND N+194k — two more instances of the class, and a lane that caught its OWN new gate silently missing (2026-10-05)

**`0ed14f9` — the duplicated parser is DELETED, not repaired.** `declaredContract()` in
`test/pool-refusal-truth.test.ts` now **is** the shared `parseDocTable`. The measured consequence
of the copy was worse than blind vocabulary: **that copy decided which codes the reachability gate
iterated**, so the shipped `502 ui2api_driver_error` row was in the README table and *promised but
never tested*.

**And the indirection gap was CLOSED, not bounded.** `SHAPE_MESSAGES` codes reach the wire through
`code: shapeCode` — a literal-shaped scanner cannot see them. `shapeMessageCodes()` reads the
table's own rows and derives the status from the **send site consuming `shapeCode`**, and it
**throws by name** if it cannot read the table, the boundary, the guard or the send. No AST, no
`src/` edit. The `?? "bad_request"` fallback was proven unreachable (`some()` implies `find()` over
the same table and string), so it is not counted as served; `measureShapeFallback()` returns it by
name instead.

**Vocabulary 17 → 19**, with `400 unknown_site` and `400 not_chat` newly visible and each given a
**real loopback probe** rather than a presence check. Both anti-vacuity proofs quoted: restoring the
copy turns **2 pins red**; deleting the `shapeMessageCodes(http)` call turns **5 red**; and making
it *silently* blind turns **7 red**.

**The line in that report worth keeping:** *"My first sweep pin was itself defective three ways
(22 false positives → 2 → silently matching nothing) — a gate for the silent-miss class that
silently missed."* A lane built a gate to catch exactly this round's class and it **quietly matched
nothing** until the lane ran its own anti-vacuity. That is the class reproducing inside the remedy,
and it is the strongest argument in this file for mandating the falsifier on every gate.

**`5fb6983` — `COMPOSER-DRIFT` already existed and was unreachable from the wire.** The lane's brief
said "add a member"; the truth was sharper. Two measured reasons: `NO_COMPOSER_PATTERN` keyed on the
**driver's internal sentence**, which `redactInternalError` rewrites before any client sees it; and
its branch required an `observedPage` the refusal path never reports. So the lane added
`UNATTRIBUTED-NO-COMPOSER` — the **page-less twin**, not a widening of the existing member. The
matcher is built by **calling the owner**: `redactInternalError(<driver's throw>)`, then detaching the
shared `RETRY` tail. The only string typed is the *input*, never the output — so a name match, which
would be a second copy of a sentence owned by `error-redaction.ts`, was correctly rejected. Measured:
the fallback and no-answer projections share the same `RETRY` tail, so a fragment match pulls them in
behind it, and that is now pinned.

**The decision that mattered: CONTRADICTS, not "qualifies".** The surface did not work at
measurement time and the row is inside the staleness window. Letting `verified` stand with a caveat
is the blindness one level up. So `measuredRoundTripFor` grew a third verdict, `contradicted`, which
**may only ever demote, never promote** — and the gate now says so in words:

```
`kimi` … carries no MEASURED row: MEASURED AND FAILED — … 1 row(s) whose DERIVED class is a
named FAILURE, the newest being chat class=UNATTRIBUTED-NO-ANSWER httpStatus=502 …
This is NOT the same as never having measured: the round trip was performed and the surface
DID NOT WORK, which CONTRADICTS a published `verified` claim rather than qualifying it.
It establishes NO cause … and it may only ever DEMOTE, never promote.
```

That is the sentence this whole session was reaching for. Three sites are published `verified`,
were measured, and **failed** — and the gate can now say so precisely instead of reporting them as
merely unmeasured.

### ROUND N+194l — youtube closes on evidence, and four bounded residuals closed in four commits (2026-10-05)

**`fbc97d2` — youtube measured.** The lane first established that `--capability chat` was the
**wrong probe and refused to run it**: `manifest.json` says *"No chat composer exists; no chat
capability is registered"*, `builtinProfile: "none"`, 7 tools, **zero** chat, and live `GET /sites`
has youtube **absent** from 22 chat models. It then measured the surface that actually exists:
`youtube_search` → **RETURNS-DATA**, `httpStatus 200, elapsedMs 3161, resultShape {rowsPath:
"data.results", count:10, rows:10}`. **Ten rows read off the page.** Gate line before →
`youtube CLAIMED yes | PUBLISHED yes | MEASURED no`; after → `MEASURED yes`, that line gone, red
**4 → the 3 pre-existing CONTRADICTED**, `knownGaps` recomputed to `[deepseek, kimi,
tencent-aistudio]`, and **no foreign site changed**. `youtube_transcript` recorded **nothing** and
exited 2 — an honest refusal of a measurement the vocabulary cannot yet express, not a fabricated
row. The manifest's irreversible surfaces (comment/like/subscribe/upload/playlist_add) were
**deliberately not probed**, and saying so is the right call.

**Four residuals, four commits — one hard residual did not hold up the other three:**

| commit | residual |
| --- | --- |
| `4b92b30` | `COMPOSER-DRIFT` was reachable after all: the matcher now derives from the **wire** sentence rather than the driver's internal one. |
| `3f57012` | the `internal_error` probe's stub driver **was never being asked** — that 500 was really a page-open failure wearing a refusal's name. |
| `0073668` | the duplicate-reparse sweep now covers the depth it **claims** to cover, not depth 1. |
| `2e9e61c` | a **runtime-assembled** code string is now a **named failure**, not a silent gap. |

**And the lane itself died at the end** — `child_rejected`, report lost. The residue was the record,
so I verified its claims rather than trusting a report I no longer had: `tsc --noEmit` **0**, the
four-file set **97/97**, and `round-trip-record-truth` **22/21/1** with that 1 being the intended
CONTRADICTED red on the three sites, unchanged.

## OPEN — none that I can prove are still open

**Everything this file tracked is closed, each with its closing evidence above.** Unfixed, in rank
order, all re-confirmed still real:

1. **FORK GATE — awaiting the operator, not a fix.** Three sites are published `verified`, were
   genuinely measured, and the measurement **CONTRADICTS** the claim: `kimi` and `tencent-aistudio`
   (`UNATTRIBUTED-NO-ANSWER`, a sign-in/consent wall) and `deepseek` (`UNATTRIBUTED-NO-COMPOSER`,
   the site's own UI changed). Those receipts were earned on real round trips and have since stopped
   working. **Recommendation: demote to `unverified-candidate` and keep the CONTRADICTED
   measurement as the receipt**, so the claim stays inspectable rather than quietly deleted. The gate
   may only ever demote, never promote. I am not making this call unilaterally and I am **not**
   relaxing the gate to hide it.
2. `youtube_transcript` produces a real, named outcome (`no-transcript-button: 'Show transcript' not
   offered`) that **no classifier member can hold**, so the record loses it — the same refusal that
   cost `deepseek` its row before `UNATTRIBUTED-NO-COMPOSER` existed.
3. The gate's derived remediation advice still says `--site youtube --capability chat` for youtube —
   a site with **no chat model**. Actively wrong guidance, generated by the gate itself.
4. `test/error-redaction.test.ts:1596-1597` — **foreign, in-flight, not mine**: two `tsc` errors and
   3 test failures from a concurrent lane's half-finished edit, making
   `tsc -p tsconfig.test.json` exit 2 tree-wide. Reported, not touched.
5. `model-verification.json`'s `SIGN-OUT` rows for those same three sites now visibly **agree** with
   the three CONTRADICTED verdicts — the first time this file can point at corroboration rather than
   a hunch, and the strongest evidence for recommendation (1).
6. `docs/AGENT_INTEGRATION.md:55` says the classifier has **nine** members; it has eleven. Unpinned doc.
7. `gate-wiring` GOAL 145 / R4 — still red, **entirely foreign**: four test files no script names are
   UNTRACKED. The gate correctly refuses to register a file the repo does not ship. **Not mine to
   force.**

**Items that were on this list and are now closed**, each at the commit named above:
`browser.ts:537` orphan kill → `c812df5`; `chrome-daemon.ts:258/335` TOCTOU + non-atomic write →
`648aae8`; `profile-ingest.ts` `info_cache` type guard → `f300686`; `openai.ts` 400-vs-413 body cap
→ `f55c32c`; `pool.ts:945` dropped-worker teardown → `bb2dc7e`; the shipped-file registration gap →
`d52a8c4`; the repo's own unbounded `spawnSync` → `ff9bd19`.
The `pool.ts:1008` double-request race was closed by the **other** workstream in `5544246`
(GOAL 239) while this lane was blocked on the same file — which is exactly why the ledger
records the block rather than an open item that would have been closed underneath it.

### ROUND N+194e — all three remaining audit findings closed (2026-10-05)

Three lanes, one finding each, every falsifier run against the ORIGINAL code first so the
improvement is visible. The common shape: **each of these gates was green while unable to fail.**

| lane | closed at | what it proved |
| --- | --- | --- |
| `l1-wall-arm-all-arms` | `bd750b8` | `servesWallAsSuccess` windows ±700 chars around **the first** `answer: r.answer`. Now `matchAll`s every arm and attributes each to its **enclosing declaration** via `enclosingDeclaration`, searching that declaration's body **before** the arm — directionally true, because a branch after the `return` cannot guard it. Both falsifiers went OLD-green → NEW-red. **The real corpus is still GREEN, measured not assumed**: 10 files carry an arm, each exactly one, old-vs-new verdicts **identical, 0 divergences** — so nothing real was being missed. Two cleanup assertions were added so the rule cannot pass by reporting everything. |
| `l1-error-echo-all-spellings` | `9042b25` | The gate matched **one verbatim spelling** of a raw `e.message` echo and hit **0/4** equally-leaking variants. It is now a real `ts.createSourceFile` **taint walk**: every `catch` binding opens a taint source, local `const`s propagate it to a fixpoint, and every `send(res, status, body)` sink is checked for a tainted value — spelling stopped being the criterion. A mapped verdict is excused only when a guard that **branches on the error** proves it. All four leaks detected; the NAMED sanitised verdict still legal; real corpus GREEN with 0 findings, **mutation-proven** by injecting a leak into the real `http.ts`. The lane then found **five defects in its own detector** (a *sanitising* call read as a leak; `err.code`/`err.status` called leaks when they are the published contract; an unguarded value came out "mapped" — the purest leak passed) and fixed each at the source. |
| `l1-site-status-reverse` | `536960a` | Only `claimed.has(id)` was checked, never the reverse, and the count **7** was a hand-typed literal. Now bidirectional against the package's own `metadata.json` receipt — the same `isCompleteVerifiedRecord` predicate `registry.ts:242` applies, **re-derived independently** so the resolver is cross-checked rather than trusted. The hole was exactly the reverse direction: a NEW site given a valid receipt while the shipped table claims nothing was **GREEN 3/3**. Reconciliation is honest: **7 published = 7 recorded, equal today**, nothing suppressed. |

**The pattern across all three, stated once:** a gate whose corpus is hand-typed goes stale in the
direction nobody checks. Four separate instances in two rounds, and **not one of them was a wrong
assertion** — every one was an assertion that could not observe the thing it claimed to observe.
Round N+194e's three lanes each deleted a literal and replaced it with a derivation, and two of
them **disagreed with the brief or with an earlier audit's own numbers** (`restartBrowser`'s fix
was made narrower than the audit suggested; `output-truth`'s "69 unclassified" was corrected to 110
skipped / 3 genuinely fakeable). That correction is the strongest evidence in this file that the
lanes reasoned from the code rather than from the brief.

The next wave hunts NEW friction rather than re-reading this list — which is the failure
mode this file exists to prevent.
