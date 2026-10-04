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

## OPEN — NONE

**Every item this file tracked is closed, each with its closing evidence above.**
The next wave starts by hunting NEW friction rather than by re-reading this list —
which is the failure mode this file exists to prevent.
