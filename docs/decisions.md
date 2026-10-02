# Decisions

Architecture and behaviour decisions that are **not** derivable from the code, with the
alternatives that were rejected and the evidence that would prove the decision wrong.
Each entry is an ADR. Source comments cite these by id (`ADR-001`); a comment that cites
an ADR that does not exist is the "phantom citation" class and is a defect.

Rule of this file: **a decision that is not written down was not made.** If you resolve a
fork yourself, append it here — the reviewer's job is to check a record, not to answer an
interview.

Index: [ADR-001](#adr-001--inject-snapshot-returns-a-verdict-and-throws-only-on-a-total-refusal)

---

## ADR-001 — `injectSnapshot` returns a verdict, and throws only on a total refusal

- **Date:** 2026-10-02
- **Goal:** GOAL 182
- **Status:** accepted
- **Code:** `src/runtime/session-store.ts` — `injectSnapshot`, `InjectionVerdict`,
  `INJECTION_REFUSED` / `INJECTION_PARTIAL_COOKIES` / `INJECTION_PARTIAL_STORAGE`
- **Gate:** `test/injection-verdict.test.ts` (behavioural truth table + two
  mutation-proven structural pins; the per-assertion total is a runtime fact — read it
  from the run, never from this line)

### Context

`injectSnapshot(context, snap)` replays a stored session into a fresh browser context
before any page is opened: cookies over the CDP protocol, then origin storage through a
document-start replay script. It used to return `Promise<void>`.

Its own doc comment claimed **"a REJECTED injection is a NAMED failure, never
swallowed"**, and it did throw — `cookie-injection-rejected: …`. That throw sat **inside
the `try` whose `catch {}` swallowed it**. Measured with a stub context rejecting both
calls: `injectSnapshot` resolved `void`, a rejected `addInitScript` was eaten by the
following `catch {}` with no name at all, and all **22** call sites outside the file went
on believing a session had been replayed when nothing had been.

That is the exact failure this file exists to prevent: written, reported as injected,
actually signed out — and then an anonymous page read back as an answer.

### Decision

Account for the two channels **independently**, report what was measured, and refuse
only when **every attempted channel was refused**.

| outcome | condition | what happens |
| --- | --- | --- |
| `accepted` | nothing refused | proceed, no `reason` key at all |
| `partial` | ≥1 attempted channel accepted, ≥1 refused | **proceed**, with the refused channel named in `reason` + one `console.warn` |
| *(throw)* | every **attempted** channel refused | `session-injection-refused: …` |

Three properties are load-bearing and each is pinned:

1. **Nothing inferred.** `cookiesAccepted` is `addCookies` resolved;
   `storageRegistered` is `addInitScript` resolved — and `addInitScript` returns `void`,
   so that is the *strongest claim available*, not a weaker one. Neither value is ever
   derived from executing the replay. A cookie-free snapshot reports
   `cookiesAttempted: false` **alongside** `cookiesAccepted: true`, so "there were none to
   take" can never be misread as "the browser took them".
2. **Attempted ≠ present.** "Total refusal" is about channels that were *attempted*.
   `addInitScript` is always attempted, so a cookie-free snapshot whose replay script is
   refused injected **nothing** and therefore **throws**. The first cut of this change got
   this wrong (it counted "no cookies to add" as an accepted channel, so nothing-injected
   came back `partial`); `test/injection-verdict.test.ts` test 5 pins it.
3. **Neither outcome is a receipt.** `"accepted"` means the browser took the *mechanism*.
   It does not mean the page is authenticated: the replay script wraps every storage
   bucket in its own `try{}catch(e){}`, so a `setItem` that throws leaves no error
   anywhere, and an origin mismatch skips the replay entirely
   (measured — `test/session-injection-fidelity.test.ts`).

### Alternatives rejected

**A. Delete the swallowing `catch {}` and let any rejection throw.** The obvious fix, and
a regression across the whole capability surface. Real sites here authenticate from origin
storage alone — kimi `access_token`, deepseek `userToken` (`src/capabilities/kimi.ts`,
`src/capabilities/deepseek.ts`). Under A, one expired or malformed cookie fails **every**
request to a storage-only site, and a site that never used cookies would fail on every
request too. The old comment's "a failed injection must not sink the request (session may
still be cookie-only)" was a **real product decision hiding under the bug**, and A deletes
it along with the bug.

**B. Keep swallowing, add a `console.warn`.** Rejected: it preserves the defect exactly.
A total refusal stays a silent success, the warn is not observable by any of the 22
callers, and nothing stops the signed-out read. This is the shape the code had.

**C. Return a verdict but never throw — a total refusal is just another `partial`.**
Rejected: nothing-injected would be *reported* as a partial success, which is the original
defect wearing a new name. It also makes the return value untrustworthy in the one case
where it matters most.

**D. Throw and let every caller decide, no partial state at all.** Rejected: it is
alternative A with extra steps — the storage-only site breaks.

### Consequences, measured

The return value is a **new capability no caller uses yet**; all 22 sites still ignore it.
The throw is the part that reaches them today. Measured, all 22 sites (`grep -rc
"injectSnapshot(" src/ scripts/`):

- **21 of 22 propagate** the refusal, and **none** converts it into an anonymous success.
  `/capability/<site>` answers `500 {ok:false, reason_code:"runner_error"}` carrying the
  named cause (the `caps.run` catch in `src/prompt/http.ts`); the CLI prints it and exits
  nonzero; `driver.ask` rethrows it out of its retry loop (the transient pattern does not
  match).
- **`/prompt` is the weak one.** The same refusal lands in the generic 500 branch, which by
  ROUND N+117 deliberately does **not** echo internal text: the client sees
  `internal_error` and the name exists only in the daemon journal. Still an honest failure
  (a 500, not an answer), but the name does not reach that client.
- **`src/analyzer/explore.ts` is the one downgrade**: it catches, `console.error`s, and
  keeps going. Loud in the log; that exploration run is still on an anonymous page.
  Deliberate — the analyser's job is to look at whatever the site serves.

### Evidence that would make this decision wrong

- **A cookie-only site whose injection legitimately fails yet whose page still answers.**
  That would falsify "a total refusal means the page is certainly signed out" and argue
  for never throwing. Not observed; the sites in this repo that are storage-only still
  have the storage channel, and a refused storage channel means the page has no origin
  storage either.
- **Transient rejection of `addInitScript` in normal operation** (a context-warmup race,
  a context closed by the pool reaper between launch and injection) at a rate that makes
  `/prompt` 500s a routine event. Then the fix belongs *upstream* — retry the injection on
  a fresh context before refusing — not in this predicate. The right first measurement is
  the frequency of `session-injection-refused` in the journal, not a code change.
- **A caller-side measurement that a request which now fails would previously have
  returned a correct answer.** That would mean the signed-out page was serving real
  content, and the honest response would be to detect that rather than refuse.
- **Playwright making `addInitScript` report the replay's own result** (so
  `storageRegistered` could mean "the replay ran", not "the registration was taken"). That
  would *strengthen* the verdict and is a reason to revisit the field's meaning, not the
  decision.