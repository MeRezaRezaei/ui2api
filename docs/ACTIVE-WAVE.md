# ACTIVE WAVE — 2026-10-02T06:40Z (SEVENTH)

| task_id | lane | owns |
| --- | --- | --- |
| `da1395db-bdd8-4c40-94d8-51bb62d585df` | chrome profile path divergence | open item #1 — LIVE: requirements.ts probes a path nothing provisions or launches; two tests are green BECAUSE they disagree |
| `b4f765a7-3c34-4466-a4b2-0f8f2473a3cf` | browser-dependent UNIT tests | MERGED: `aa4e650` — the maybe() guard asked is the DAEMON alive, not can the BROWSER launch |

| `e51f0a5b-5f39-4119-aab0-a875b1686a26` | the swallowed warm-up failure | open item #2 — http.ts:893 discards a real spawn failure, and three suites DOCUMENT the resulting silence as if it were the design |

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

## OPEN — next wave should start at #1

1. **Chrome profile path divergence** — `.config/ui2api-chrome` in six places vs
   `.ui2api-chrome` in `requirements.ts`. LIVE: the readiness gate probes a path
   nothing provisions or launches, and two tests hard-code each spelling so they
   are green BECAUSE they disagree. Needs `sudo` to determine which profile is
   live.
2. **The browser-dependent unit tests have no guard** — `wigolo-engine.test.ts`'s
   `maybe()` checks DAEMON health, which says nothing about browser
   launchability, so 3 tests die inside the test. `session-store.test.ts` and
   `prompt.test.ts` have no guard at all.
3. **More duplicate owners**: pool refusal codes (3), the no-answer matcher vs
   emitter plus 14 inline refusal strings, `attachRefusal` re-framed by four
   runners, `consumerAccountRefusal`'s opening clause vs its two classifiers
   (a reword turns 400 into 500).
4. `package.json`'s `test:unit` list is a duplicated owner of "which tests exist",
   and it is the one file I have been forbidden to edit.
5. `error-redaction.ts` has a module-level `g`-flagged regex shared across calls;
   safe today only because `String.replace` resets `lastIndex`.
6. A digit suffix (`chrome2`, `selenium3`) still escapes the redaction rules.
   `[a-z]*` was applied and measured at 0 false positives over 3853 tokens;
   `\w*` was NOT applied because it widens past what could be honestly measured.
7. No reconstruction runbook consumer is automated — the runbook is prose plus a
   format pin, and no script performs the reconstruction.

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

## STILL OPEN — the next wave starts at #1

1. **`session-store.test.ts` and `prompt.test.ts` launch a browser with no guard**,
   so they go red with no named reason. They pass today only because the
   system-Chrome fallback exists. A wrong guard on `prompt.test.ts`'s live server
   is worse than none, which is why it was left.
2. **`http.ts:893` swallows a real spawn failure into silence** for
   `codefor-prose-table`, `pool-refusal-truth` and `chat-surface-merge` — and
   `codefor-prose-table.test.ts:76-79` asserts `startPromptd` never warms the
   pool, which is factually wrong (`warm()` IS at `http.ts:893`). Product code.
3. **More duplicate owners**: pool refusal codes (3), the no-answer matcher vs
   emitter plus 14 inline refusal strings, `attachRefusal` re-framed by four
   runners, `consumerAccountRefusal`'s opening clause vs its two classifiers.
4. `package.json`'s `test:unit` list is a duplicated owner of "which tests exist",
   and it is the one file I have been forbidden to edit.
5. `error-redaction.ts` has a module-level `g`-flagged regex shared across calls;
   safe today only because `String.replace` resets `lastIndex`.
6. A digit suffix (`chrome2`, `selenium3`) still escapes the redaction rules.
7. No reconstruction consumer is automated; the runbook is prose plus a format pin.
