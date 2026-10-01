# ACTIVE WAVE — 2026-10-01T20:55Z (THIRD WAVE)

Two lanes out. Collect with `get_delegation_status` on 1-2 ids at a time, re-armed
until terminal. **A turn must never end with a task still `running`** — an
uncollected lane is a silent result, and its output lives in a database neither the
operator nor I can read.

| task_id | lane | owns |
| --- | --- | --- |
| `bcb5cc42-6aee-4773-9e30-61eb9438a1be` | `\\b` boundary leak class | `chromeless` / `headlessly` / `xorgs` / `zodish` survive both rules |
| `fcb7f28f-88e7-46fd-97c3-6aae6221d4a0` | visibility probe on the public push | no probe; and the destination is NOW PUBLIC, so the naive fix turns the pipeline red |

## PRIOR WAVES — all collected, merged, nothing outstanding

**Wave 1** (four lanes, two died before reporting — their residue was salvaged
from the tree and verified, which is where the account-refusal fix came from):
`b1cb4e6` account-refusal owner, `91f787a` concept-word derivation, `a90f439`
class record, `f5a708a` SIGN-OUT runbook.

**Wave 2:** `ec85a66` origin divergence + `pushToMirror` allowlist, `8859f2a`
error-seam concept list (six live leaks), `326f377` goals-index closure.

## THE PATTERN TO CARRY INTO ANY NEW GATE

Every lane so far shipped a gate that mutation proved VACUOUS:

- a file COUNT where the question was an occurrence COUNT
- four hand-typed regexes where the code had an exec surface to derive from
- a pinned list where the vocabulary was derivable
- a completeness gate silent on one of its own classes
- a concept-word list typed three times, two of them leaking

**Not one had been watched to go red before it was believed.** Mutate the thing
you are guarding and watch it fail. And if the mutation does NOT fire, establish
whether the gate is broken or the mutation was wrong — **both happened three times
today**, including once where I had misspelled the operator's own GitHub handle in
my own test and wrongly suspected the gate.

## MEASURED RESIDUALS, recorded so they are not re-litigated from scratch

- `\\b` boundary forms survive both redaction rules (wave 3, lane 1).
- The public mirror's push has no visibility probe (wave 3, lane 2) — and the
  naive fix is wrong, because the destination is deliberately public now.
- `error-redaction.ts` has a module-level `g`-flagged regex shared across calls;
  safe today because only `String.replace` uses it, and a future `.test()` would
  be stateful.
- The corpus for the error-seam differential was assembled from the test suite,
  not from production error text.
- CI's container cannot verify Debian signatures, so Playwright OS deps never
  install and the browser half of the suite skips. Host apt is fine — it is a
  runner image problem, and the skip is loud.
- GitLab's artifacts uploader intermittently 500s AFTER the job's real work has
  succeeded and self-verified, reddening `github_release` and `public_mirror`.
  Measured rate and attribution are in the session log; not yet a fix.

## STATE

HEAD `326f377` plus wave-2 commits, tree clean, nothing unpushed. Public repo
live, verified 0 on every class. `origin` is GitLab for fetch and push; **zero
remotes reference github.com**.
