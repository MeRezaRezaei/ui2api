| goal183-unverified-ship-gate | L1 | EXECUTE (gate authoring) | L0 ui2api orchestrator | test/credential-leak-gate.test.ts - GOAL-183 section: range-based behaviour-change-shipped-with-no-test-change gate | 2026-10-04T15:55:50Z | running |
| `ui2api-latency-readback-L1` | L1 | EXECUTE (answer-readback slice) | main-chat | `src/runtime/dom-primitives.ts` + 1 new readback-overhead test | 2026-10-04T17:56:38+02:00 | running |
| pool-latency-lane | L1 | execute | L0-orchestrator | src/prompt/pool.ts acquire/page-open latency slice | 2026-10-04T17:57:14+02:00 | running |
| readback-measure | L2 | EXECUTE (measurement) | parent opencode session | /tmp/codeg-acp/2052-1d5445e2/readback-measure/ harness + <=350w latency report | 2026-10-04T15:57:15Z | running |
| readpath-overhead-audit | L2 | read-only inventory + candidate ranking | parent-session-0 (codeg restart) | read-only awaitAnswerFromReads overhead inventory + candidate ranking | 2026-10-04T15:57:16Z | running |
| L1-latency-launch | L1 | latency | root-orchestrator | verdict+gate for browser.ts/session-store.ts launch-attach-inject slice | 2026-10-04T17:58:14+02:00 | running (resumed after codeg restart; L2-measure done, L2-reuse-audit pending) |
| agent-driver-latency-ledger | L2 | execute | codeg (session orchestrator) | test/driver-latency-ledger.test.ts | 2026-10-04T18:03:53+02:00 | running |
| send-readiness-experiment | L2 | EXECUTE (experiment) | parent opencode session | test/driver-send-readiness.test.ts + mutation report + unapplied driver.ts polling diff + Tencent readiness verdict | 2026-10-04T18:04:15+02:00 | running |
| send-readiness-experiment | L2 | EXECUTE (experiment) | parent opencode session | VERIFIED-ALREADY-LANDED: no new test written (test/consent-wall-poll.test.ts, GOAL 161, covers this slice); mutation runs M1-M4 measured in /tmp/codeg-acp/438074-c81c438b/mut; Tencent verdict DECLINE | 2026-10-04T18:08:28+02:00 | done (no src/test edits; findings only) |
| `open_code` | L1 | GOAL pool.ts worker.busy-too-early | orchestrator (main chat) | src/prompt/pool.ts release-path fix + 1 new test | 2026-10-04T18:09:53+02:00 | running |
| `plugin-wigolo-honest-success` | L1 | GOAL (src/plugin/wigolo-context.ts invented success) | orchestrator | src/plugin/wigolo-context.ts + 1 new test | 2026-10-04T16:09:52Z | running |
| `l1-timeout-discipline-gate` | L1 | goal (gate-cannot-fire) | orchestrator | test/test-timeout-discipline.test.ts scanner window+anchor fix | 2026-10-04T18:10:28+02:00 | running |
| `L1-sweep-probe-overlap` | L1 | execute | codeg-orchestrator | src/prompt/pool.ts + test/pool-sweep-probe-concurrency.test.ts + package.json | 2026-10-04T16:22:05Z | running |
| `reuse-audit-l2` | L2 | VERIFY (audit report) | orchestrator | reuse+freshness audit report (Q1-Q5, <=500w) | 2026-10-04T18:22:18+02:00 | done (report delivered in-chat) |
| `readpath-callers` | L2 | read-only audit slice C: awaitAnswer read-path callers | L0-orchestrator | none (read-only sub-report) | 2026-10-04T18:27:39+02:00 | running |
| `lane-browser-launch` | L1 | execute | codeg-orchestrator | src/runtime/browser.ts + src/runtime/session-store.ts latency slice | 2026-10-04T18:33:50+02:00 | running |
| `readback-headroom` | L1 | execute (readback-overhead measurement) | parent-orchestrator | `src/runtime/dom-primitives.ts` + ONE new test file | 2026-10-04T18:40:21+02:00 | running |
| `consent-wall-poll` | L1 | execute | orchestrator (L0) | `src/prompt/driver.ts` + `test/consent-wall-poll.test.ts` | 2026-10-04T16:40:43Z | running |
| `pool-acquire-measure` | L1 | measurement (re-run after STOP) | ORCH-L0 | src/prompt/pool.ts + 1 new test | 2026-10-04T16:40:45Z | running |
| `consent-wall-poll` | L1 | execute | orchestrator (L0) | `src/prompt/driver.ts` + `test/consent-wall-poll.test.ts` | 2026-10-04T16:40:43Z | done — commits b85dddf, 9d4e972; 15/15 own tests, tsc + typecheck clean |
