# ACTIVE WAVE — 2026-10-01T22:40Z (FOURTH WAVE)

| task_id | lane | owns |
| --- | --- | --- |
| `c5801034-a9c7-499c-957f-fc23c9d96f31` | commit-map reconstruction runbook | the map's bytes now flow; nothing CONSUMES them, and two config claims about it are false |

Collect with `get_delegation_status` on 1-2 ids at a time, re-armed until
terminal. **A turn must never end with a task still `running`** — an uncollected
lane is a silent result.

## PRIOR WAVES — all collected and merged

Wave 1: `b1cb4e6` account-refusal owner · `91f787a` concept-word derivation ·
`a90f439` class record · `f5a708a` SIGN-OUT runbook. (Two lanes died before
reporting; their residue was salvaged from the tree and verified.)

Wave 2: `ec85a66` origin divergence + `pushToMirror` allowlist · `8859f2a`
error-seam concept list (six live leaks) · `326f377` goals-index closure.

Wave 3: `b314424` visibility probe + derived-form fix · `b0390c6` the probe's own
tests were environment-dependent · `4027a06` the empty commit-map artifact + jq.

## MEASURED, AND STILL TRUE

- **`origin` is GitLab for fetch AND push. Zero remotes reference github.com.**
  The public repo is reachable only by typing its URL.
- The public destination has exactly one writer, the sanitizer, and it now proves
  each destination's identity and declared visibility before pushing — fail-closed,
  and the assertion is asymmetric because the public repo is deliberately public.
- `pushToMirror` refuses the public destination by `owner/name` identity.
- `UI2API_*` knob rows exist for every knob read in `src/` + `scripts/`; the
  table's own gate enforces it and caught two rows within minutes of them existing.
- CI's artifacts uploader 500s in BURSTS, not at a rate: 9 in a 96-minute window,
  then 17 consecutive clean uploads over 4 hours. It co-occurs 7/7 with cache
  failure; both write to external S3. Inside pipeline 1086 one job uploaded 201
  while its sibling 500'd on the same runner in the same minute — so it is not
  configuration.
- `github_release`'s artifact is byte-redundant (same tarball on GitHub, sha256
  verified) but KEPT: in the deliberate RELEASE-SKIP path it is the only copy.
- The commit-map artifact was EMPTY for 13.4 hours (12/12 artifacts, 190 bytes)
  because CI copied `maps/` while the sanitizer writes `commit-maps/`. Fixed, and
  the error suppression removed so a future break is loud.
- `jq` was assumed present in a CI image that does not promise it; the probe
  correctly refused and its tests went red. Installed and pinned.

## STILL OPEN

- **The unpinned `git-filter-repo` is still unpinned.** The reconstruction
  runbook now exists — **`docs/RECONSTRUCTION-RUNBOOK.md`**, with the map's
  format measured against a real `filter-repo` run, the procedure, a four-check
  worked verification, and what the map does NOT let you do. Pinning the tool
  version (the runbook's §7 carries the exact YAML) is a separate `.gitlab-ci.yml`
  edit and is **not yet applied**; until it is, the map is regenerable only by
  luck.
- The browser-dependent half of the suite SKIPS when the loader cannot find
  `libnspr4`. The fault itself has cleared (15 consecutive INTEGRATION OK, same
  image digest), but nothing asserts the skip did NOT happen, so a recurrence
  would be invisible in the job status.
- `error-redaction.ts` has a module-level `g`-flagged regex shared across calls;
  safe today because only `String.replace` uses it, and a future `.test()` would
  be stateful.
- The error-seam differential corpus was assembled from the test suite, not from
  production error text.
- `\b` boundary forms: a digit suffix (`chrome2`, `selenium3`) still escapes.
  `[a-z]*` was applied and measured at 0 false positives over 3853 tokens; `\w*`
  was NOT applied because it widens past what could be honestly measured.

## THE PATTERN, FOR ANY NEW GATE

Every lane has shipped a gate that mutation proved VACUOUS — a file count where
the question was an occurrence count; four regexes where the code had an exec
surface; a pinned list where the vocabulary was derivable; a completeness gate
silent on its own class; a concept list typed three times. And one test asserted
a hole that was then CLOSED, reporting a fixed defect as open.

**Mutate the thing you guard and watch it fail.** If the mutation does NOT fire,
establish whether the gate is broken or the mutation is wrong — both happened
three times today, once because I misspelled the operator's own GitHub handle in
my own test and wrongly suspected the gate.
