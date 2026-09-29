# Session-injection fidelity — mutation evidence

Date: 2026-09-28 · Target: `test/session-injection-fidelity.test.ts` ·
Code under test: `src/runtime/session-store.ts:430-443` (`storageReplayScript`),
`src/runtime/session-store.ts:448-464` (`injectSnapshot`).

## How the mutations were applied

`src/**` was **never** edited. Each mutation is a **string-mutated copy of the
script `storageReplayScript()` actually emits**, produced inside the test file by
`mutant(kind)` and injected into a throwaway `BrowserContext` via
`addInitScript`. The measurement below was taken by a standalone probe
(`/tmp`-sourced, run from the repo so `playwright` resolved) against real Chrome
152 on a local `http://127.0.0.1:<port>` origin.

## Mutation table

| # | mutation | red? | observed read-back | what it proves |
|---|---|---|---|---|
| (a) | `try{for(const[k,v]of LS)localStorage.setItem(k,v)}` → `/* emptied */` | **YES** — `mutation (a) empty replay body -> read-back MUST fail` turns red via `assert.rejects(..., /did NOT land/)` | `localStorage=null`, `cookie="cookie-value-42"` | The positive read-back really reads the replayed value; a replay that sets nothing cannot pass. |
| (b) | `if(location.origin!==ORIGIN)return;` removed entirely (wrong-origin snapshot) | **YES** — `mutation (b) origin gate removed -> mismatch MUST be caught` turns red | `localStorage="replayed-value-42"` (leaked!) | The gate is the only thing stopping a wrong-origin snapshot from populating the page. With it gone the leak is real and observed. |
| (c) | gate inverted: `if(location.origin===ORIGIN)return;` | **YES** — both directions observed | wrong-origin snap → `localStorage="replayed-value-42"` (**leaks**); matching snap → `localStorage=null` (**silent no-op on a real match**) | Neither inversion is survivable: the comparison must be `!==` with a *mismatch* early-out, and it must not be able to no-op on a true match. |

## Expected (non-mutation) REDs — real defects, not test bugs

1. `RED/WAITING: a snap.origin mismatch is announced, not a bare return`
   → `src/runtime/session-store.ts:435`, the bare `return`.
2. `RED/WAITING: a rejected cookie/init-script injection must be NAMED, not swallowed`
   → `src/runtime/session-store.ts:455` and `:461`, the two empty `catch {}`s
   (proven: a closed context rejects *both* calls and `injectSnapshot` still
   resolves `void`).

Each has a **green post-fix simulation** in the same file
(`post-fix simulation: a corrected gate …` and `… a diagnosing injector …`), so
the reds are satisfiable, not unreachable assertions.

## Revert

No revert was needed: every mutation is computed in-memory per test from a fresh
`storageReplayScript()` call. `src/runtime/session-store.ts` is byte-identical
before and after this audit.
