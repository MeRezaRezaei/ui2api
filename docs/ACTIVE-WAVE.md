# ACTIVE WAVE — 2026-10-01T23:40Z (FIFTH WAVE)

| task_id | lane | owns |
| --- | --- | --- |
| `7668a2c0-73dc-4a8a-afac-c4598cfe9c6b` | the silent browser skip | integration exits 0 when the browser cannot load; nothing asserts it did not run; the unit lane has NO guard at all |
| `8e74e907-1e42-401b-8a70-c9183f73975e` | duplicated ownership, repo-wide | five duplicate-owner defects already found and fixed this session; find the rest |

**Collect with `get_delegation_status` on 1-2 ids at a time, re-armed until
terminal. A turn must never end with a task still `running`.**

## PRIOR WAVES — all collected and merged

1. `b1cb4e6` account-refusal owner · `91f787a` concept-word derivation ·
   `a90f439` class record · `f5a708a` SIGN-OUT runbook.
   (Two lanes died before reporting; their residue was salvaged from the tree —
   that is where the account-refusal fix came from, and its gate was vacuous.)
2. `ec85a66` origin divergence + `pushToMirror` allowlist · `8859f2a` error-seam
   concept list · `326f377` goals-index closure.
3. `b314424` visibility probe + derived forms · `b0390c6` the probe's own tests
   were environment-dependent · `4027a06` the EMPTY commit-map artifact + jq.
4. `977df81` unbounded execFileSync in my own skip guard (caught by
   `test-timeout-discipline`) · `7ec59cd` the missing `mkdir` the loud failure
   exposed · `ab4c8e8` the reconstruction runbook + the backwards map orientation.

## THE PATTERN THIS SESSION ESTABLISHED

**Every lane shipped a gate that mutation proved VACUOUS.** A file count where
the question was an occurrence count; four regexes where the code had an exec
surface; a pinned list where the vocabulary was derivable; a completeness gate
silent on its own class; a concept list typed three times, two leaking. And one
test asserted a hole I had just CLOSED, so it would have reported a fixed defect
as open.

**And every mutation I ran that did NOT fire was my mistake, not the gate's** —
three times: I mutated the script's comment when the gate pinned the runbook's
HTML anchor; I mutated a prose sentence when the gate pinned an anchor; and I
misspelled the operator's own GitHub handle in my own test and suspected the gate.

The working rule: **mutate what the gate PINS, then if it still does not fire,
read the gate before touching anything else.**

## THE OTHER PATTERN — duplicated ownership

Five facts had more than one owner this session, and **in every case the copies
had already diverged**: the account-refusal sentence, the concept vocabulary
(three owners, two leaking), `MODEL_ANSWER_CLASSES` (no import, no consumers),
the consumer-prose word list, and the commit-map's orientation. Duplication does
not stay in sync — it drifts. Wave 5 lane 2 is hunting the rest.

## MEASURED AND STILL TRUE

- `origin` is GitLab for fetch and push; **zero remotes reference github.com**.
- The public destination has exactly one writer and now proves each destination's
  identity and declared visibility before pushing, fail-closed, asymmetrically
  because the public repo is deliberately public.
- The commit-map artifact was EMPTY for 13.4 hours (12/12 artifacts, 190 bytes)
  because CI copied `maps/` while the sanitizer writes `commit-maps/`. Fixed, the
  suppression removed, and the missing `mkdir` that loud failure then exposed is
  fixed too. The map is now real, documented, and pinned against a LIVE
  measurement of what `git filter-repo` actually writes.
- Artifacts-uploader 500s are a BURST, not a rate: 9 in a 96-minute window, then
  17 consecutive clean uploads over 4 hours, and inside one pipeline a sibling job
  uploaded 201 while this one 500'd on the same runner in the same minute.
- `jq` is installed and pinned; `jq`/`curl` absence makes the probe's tests SKIP
  loudly rather than report an environment gap as a code defect.

## STILL OPEN

- The browser half SKIPS with nothing asserting the skip did not run (wave 5, lane 1).
- `error-redaction.ts` has a module-level `g`-flagged regex shared across calls;
  safe today because only `String.replace` uses it, and a future `.test()` would be stateful.
- The error-seam differential corpus came from the test suite, not production text.
- A digit suffix (`chrome2`, `selenium3`) still escapes the redaction rules.
  `[a-z]*` was applied and measured at 0 false positives over 3853 tokens; `\\w*`
  was NOT applied because it widens past what could be honestly measured.
