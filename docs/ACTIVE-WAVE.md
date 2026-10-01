# ACTIVE WAVE — 2026-10-01T19:30Z

Four lanes dispatched in ONE message (parallel siblings, not serialised). If you
are reading this after an interrupt, COLLECT THEM FIRST — their results do not
survive a stop, but their task ids do, and a finished-but-uncollected lane is a
silent result.

| task_id | lane | owns | state |
| --- | --- | --- | --- |
| `e048ab3d-9db0-4de0-935a-dbcc15741ea8` | duplicated account-refusal owner | runner-up #2 — `error-redaction.ts` vs `consumerAccountRefusal()` | dispatched |
| `e2ad4601-bc62-41f0-b0b7-30546f149c9d` | concept-word derivation | runner-up #3 — Chrome/Xvfb/CDP/headless not derivable | dispatched |
| `d7840483-0fc3-43fb-a0f6-5b30e74a126a` | stale classification record | runner-up #5 — classes 7-9 not enumerated | dispatched |
| `788cd004-5e75-4766-9d32-47ab0c491820` | SIGN-OUT runbook | runner-up #1 — 11 human-login rows | dispatched |

**Collect with `get_delegation_status` on 1–2 ids at a time** (6+ times out at the
MCP layer), re-armed until every task is terminal. A turn must never end with a
task still `running`.

## STATE AT DISPATCH

- HEAD `62e7398`, tree clean, nothing unpushed.
- Pipeline **1138 fully green**: build, verify, deploy, github_release, agent_reap
  all `success`. (github_release green means the artifacts-uploader 500 did not
  recur — that fault is intermittent, not fixed.)
- Public repo live and verified: `MeRezaRezaei/ui2api`, anonymous clone measured
  0 corpus paths / 0 addresses / 0 tokens / 0 `data/` paths across 407 commits.
- GOAL 172 closed (`aeb102e`); GOAL 175 closed (`83380f7`).

## WHEN THE LANES LAND

1. Verify each lane's claims YOURSELF before merging — a lane's report is a
   claim, not evidence. Run the test files it names and read the output.
2. Watch for the two failure modes this session keeps hitting:
   - a lane that edits `package.json` and deletes the
     `node --import tsx --test-concurrency=4 --test-timeout=120000 --test `
     prefix (a bare file list then fails with `sh: test/...: Permission denied`);
   - a lane that adds a `test/*.test.ts` without registering it, which
     `test/gate-wiring.test.ts` R4 catches and `test/doc-numbers-truth.test.ts`
     catches as a stale count in `README.md` + `.brain/PRODUCTION_READINESS.md` 4.1.
3. Run BOTH tsc projects before committing:
   `npx tsc --noEmit` AND `npx tsc --noEmit -p tsconfig.test.json`.
4. Merge to main, then let CI be the authority — do not claim green without
   reading the pipeline.

## THE POINT OF THE NESTING

The operator stopped this session several times; each stop killed every running
lane and the goal, so the next turn began with nothing. Two halves to the fix, and
both are needed:

- **durable** — `scripts/ops/resume-state.sh` plus this file, so the state is
  re-readable in one command instead of re-derived from history;
- **wide** — lanes in parallel from the start, so one stop costs one wave rather
  than a serial queue.
