# Decisions

Architecture and behaviour decisions that are **not** derivable from the code, with the
alternatives that were rejected and the evidence that would prove the decision wrong.
Each entry is an ADR. Source comments cite these by id (`ADR-001`); a comment that cites
an ADR that does not exist is the "phantom citation" class and is a defect.

Rule of this file: **a decision that is not written down was not made.** If you resolve a
fork yourself, append it here — the reviewer's job is to check a record, not to answer an
interview.

Index:
- [ADR-001](#adr-001--inject-snapshot-returns-a-verdict-and-throws-only-on-a-total-refusal)
- [ADR-002](#adr-002--do-not-gate-docsmd-citations-the-only-scoping-that-goes-green-makes-the-sibling-class-blind)

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

---

## ADR-002 — do NOT gate `docs/*.md` citations; the only scoping that goes green makes the sibling class blind

- **Date:** 2026-10-02
- **Goal:** GOAL 184
- **Status:** accepted (Option B — consciously not built)
- **Class:** one level over the class `test/phantom-gate-citation.test.ts` gates — a source
  comment citing a **document** that does not exist, rather than a test file that does not exist
- **Deliberately absent:** no gate file, no baseline, no allow-list. This ADR is the deliverable.

### Context

`test/phantom-gate-citation.test.ts` (GOAL 182) fails when `src/` or `scripts/` cites a
`test/*.test.ts` that does not exist. It found **three real phantoms**, one on the credential
path. The natural next rung is the same shape one level over: a source comment citing a
`docs/*.md` that does not exist.

GOAL 184 was opened to decide whether to build it, and to build it only if the answer was
yes. **The answer is no**, and the reason is not "there are no bugs" — it is that **the only
scoping which makes this gate green is the same scoping which would have hidden the sibling
gate's one real find.** That is a measured result, not a preference.

### Measurement (2026-10-02, this lane, re-derived independently)

19 unique `docs/*.md` citations from `src/` + `scripts/` (nested paths included); **13 resolve,
6 do not.** Restricting to single-segment names reproduces the briefed shape exactly: **13
unique, 9 resolve, 4 do not.** `src/` alone: **6 unique, 6/6 resolve.**

**Every single unresolved citation — under every regex variant tried — lives in exactly one
file: `scripts/ci/public-repo-paths.txt`.** That file is the auditable path-exclusion list fed
to `git filter-repo --paths-from-file`; its 6 misses are the pre-relocation locations of the
verbatim corpus (moved to `.brain/` on 2026-09-25). **Zero true phantoms exist on the claim
surface.**

### Why the obvious construction fails — watched, not assumed

The proposed escape was "parse citations in comment/prose context only, so a path-list is
excluded by construction". **This was built and run against the real tree. It fails: 6
unresolved, all inside `#` comment lines** (lines 37–48 of `public-repo-paths.txt` are a
`#`-commented table of those very paths). Comment-context parsing does not separate a
path-list from a claim, because a path-list *documents its own entries in comments*. The
proposed construction does not work.

### The only construction that goes green, and what it costs

Classifying by **what a file IS** — a prose surface (`.ts/.mts/.mjs/.js/.sh/.service`) versus
a data file — is green with **zero baseline**: 9 unique citations, 0 unresolved. It is
tempting and it is still wrong, because measured, it makes **9 citation-carrying files
invisible**, and among them:

- **`scripts/ci/forbidden-release-paths.txt`** — the file holding
  `test/phantom-gate-citation.test.ts`'s **one real, named phantom**
  (`release-exclusion-single-source.test.ts`). A gate scoped this way would have been blind to
  the exact defect that proved the sibling class is real.
- **`scripts/audit/*`** — the dated evidence archives, which the sibling gate deliberately
  keeps visible-but-exempt (a file claiming an exemption must carry a date).

So the scoping that makes GOAL 184 green is one that would have **deleted the sibling gate's
only true positive**. A gate bought by going blind somewhere else is not insurance; it is the
same vacuous-gate failure this repo has already produced twice, one level down.

### The cost argument, stated plainly

- **Zero live instances.** The class is real but empty. A gate over an empty class cannot be
  validated by the thing gates are for (catching the bug), only by a mutation test — and a
  mutation-proven green gate is exactly what "we wrote a test for our regex" looks like.
- **Asymmetric blast radius.** A phantom *test* citation makes a reader believe a **check
  exists** and skip writing it — that is how GOAL 182 found a credential-path hole. A phantom
  *doc* citation makes a reader open a file that is not there; they then read the code. The
  first silently suppresses a safety property; the second is an inconvenience. Insurance is
  worth buying against the silent failure.
- **This repo's own evidence.** Two gates have already shipped vacuous here. The strongest
  predictor of a third is that it was written to be green before it was written to bite.
- **Docs churn is slow and human.** 17 top-level files, 2 subdirs. `src/` carries **6**
  citations across 6 files — small enough that a reader meets every one of them organically.
  The audit archives are dated evidence and are *supposed* to name files that no longer exist.

### Alternatives considered and rejected

- **Option A, comment/prose-scoped.** Built and measured: reds on all 6. Rejected.
- **Option A, extension-scoped ("what it IS").** Green with zero baseline, but blind to
  `forbidden-release-paths.txt` and `scripts/audit/*`. Rejected as self-defeating.
- **Option A, content-shape classifier** (classify a file as a path-list by its density of
  bare path lines). Rejected: `public-repo-paths.txt` is **10 non-comment lines in 132** — it
  is *mostly comments*. Content shape cannot separate it from a claiming file, and inventing a
  threshold is an allow-list wearing a derivation's clothes.
- **Option A with a 6-entry baseline.** Explicitly out of bounds by the goal, and by this
  repo's history: a gate whose first act is to be silenced will be silenced again.

### Evidence that would make this decision wrong

This is a real result and it is **reversible**. Build the gate when **any** of these holds:

1. **A `docs/*.md` citation in `src/` or `scripts/` actually goes stale** — a real phantom on
   the claim surface. Insurance stops being insurance at the first claim; that is the signal.
2. **A bulk `docs/` move or rename** (a second corpus relocation like 2026-09-25's). One event
   would invalidate many citations at once and make the class worth gating *before* anyone
   notices. This is the most likely trigger.
3. **The citation surface grows past ~50 sites across >25 files** — past the point where
   "every citation is met organically while reading the file" stops being true.
4. **A construction appears that excludes `public-repo-paths.txt` by content while keeping
   `forbidden-release-paths.txt` visible** — i.e. one that can tell a *path-list* from a
   *claiming file* without an allow-list. That is the finding that would overturn this ADR, and
   it is the only one that makes building it cheap rather than merely possible.

### What was NOT done, on purpose

No test file was added, so `package.json` (`scripts["test:unit"]`) and `README.md`'s two
file-count figures are **deliberately untouched** — this lane owns both, and adding a gate for
a class chosen *not* to gate would have been the vacuous outcome this ADR argues against.
`test/phantom-gate-citation.test.ts` and `test/injection-verdict.test.ts` still pass.

## ADR-003 — do NOT gate the DERIVATION claim ("taken from the single … that produces it"); the one real instance is not separable from the true-claim population

- **Date:** 2026-10-03
- **Goal:** GOAL 180 (the derivation-shape remainder)
- **Status:** accepted (declined — consciously not built)
- **Class:** a comment in `src/` asserting that a value came from a shared owner, where the code
  actually restates it as a literal. Instances 1–3 of the briefed class are already impossible
  under GOAL 180's gate; instance 5 was declined by ADR-002. **Instance 4 is the whole remainder.**
- **Deliberately absent:** no gate file, no baseline, no allow-list. This ADR is the deliverable.

### Context

The five briefed instances reduce to one ungated case. Instances 1–3 were `test/*.test.ts`
citations, which `test/phantom-gate-citation.test.ts` now gates (all three files exist today).
Instance 5 was a `docs/*.md` citation, declined by ADR-002 with a measurement. What remained is
the **derivation** shape: a comment that names a shared owner and nothing backs it.

### Measurement (2026-10-03, this lane)

Scanned **122 files** (`src/` + `scripts/`, `.ts/.mts/.mjs/.sh`), comment-aware (string literals
kept as code, because imports and literals live there), and extracted every comment carrying a
derivation cue within ±1 comment line that names a concrete owner file.

- **12 derivation claims** across 8 files.
- **8 TRUE** — the owner is genuinely imported or referenced by the file's code. Each was read by
  hand, not by grep: `POOL_REFUSAL_CODES` and `./pool.js` in `http.ts`, `assertSafePackageSegment`
  in `mirror.ts`, `resolveChromeOwner` in `requirements.ts`, `passwdUserExists()` folded into
  `xhost-capture.ts`, `capability-dispatch.ts`, `busyWatchdogMs` in `pool.ts`, `xhost-capture.ts`
  in `cli.ts`.
- **1 FALSE — the class's only live instance:**

  **`src/prompt/verification-class.ts:158-160`.** The comment claims `NO_ANSWER_REFUSAL_PATTERNS`
  is *"taken from the single template that produces it (src/prompt/error-redaction.ts)"*. Measured:
  the file has **zero import statements**; `error-redaction.ts` exports `INTERNAL_WORD_RE`,
  `INTERNAL_WORD_RE_NON_GLOBAL` and `redactInternalError` — the no-answer sentence
  (`error-redaction.ts:94`) is a **template literal inside a function, never exported**; and the
  matcher is a hand-written regex literal. The claim's own wording names "the single template",
  so it is falsifiable by reading two files, and it is false.

  The repo already fixed this exact shape once, in `src/prompt/registry.ts:590-604`, whose comment
  records the previous hand-typed four-name list and names the fix — *"This module never imported
  `verification-class.js`, so nothing here could notice"*. `verification-class.ts` is that defect
  unfixed, one file over.

- **3 detector false positives on true claims** — see below.

### Why the gate is not buildable — watched, not assumed

The obvious construction — *claim names an owner, and the file never references that owner in
code* — reds on **4 of 12**: the one real instance plus three TRUE claims:

| red | claim | why it is a true claim |
| --- | --- | --- |
| `verification-class.ts:159` | owner `error-redaction.ts` | **the real one** |
| `registry.ts:143` | owner `http.ts` | TRUE. `(http.ts)` names the **route that must agree**, not the owner. The real shared owner is `session-store.js` (`listAccounts`), which `registry.ts` **does** import — and it *cannot* import `http.ts`, because the dependency runs the other way. |
| `requirements.ts:284` | owner `test/chrome-profile-path-truth.test.ts` | TRUE. The test exists and does compare each restatement against the derived value. A **test cannot be imported by the code it tests.** |
| `scripts/measure-function-map.mjs:3` | owner `test/function-doc-truth.test.ts` | TRUE. Both consumers read the same disk census. Same dependency-direction fact. |

Two of the three are removable by a rule that is defensible on its own: **a test file is not a
derivable owner** (the dependency direction forbids it). The third is not. Removing
`registry.ts:143` needs *"the owner must FOLLOW the cue"* — a rule with no justification beyond
"it removes the false positive I had just measured", and one that does not generalize (§ below).

**The tuned construction then fails in both directions.** Seven hand-built cases, run against the
real detector:

| case | expected | got |
| --- | --- | --- |
| false claim, the live instance's verbatim shape | RED | RED ✓ |
| false claim, "derived from X" wording | RED | RED ✓ |
| true claim, owner genuinely imported | GREEN | GREEN ✓ |
| true claim, owner named as a consumer (the `registry.ts` shape) | GREEN | GREEN ✓ |
| true claim, owner is a test that cannot be imported | GREEN | GREEN ✓ |
| true claim, **a shell script cannot import a TS owner** | GREEN | GREEN — **for the wrong reason** |
| false claim, **inside a shell script** | RED | **GREEN** ✗ |
| true claim, **owner deliberately restated because it is a published contract** | GREEN | **RED** ✗ |
| false claim, owner named only in a **string literal** | RED | **GREEN** ✗ |
| true claim, negated owner — *"not from `store.ts`"* | GREEN | **RED** ✗ |

**4 of 10 wrong, in both directions.** Two holes are structural, not tuning:

- **`.sh` comments are invisible to the segmenter.** It knows `//` and `/* */`, not `#`, so every
  shell line is CODE. A false derivation claim in a shell script is missed entirely, and the true
  claim in the row above is "green" only because it was never seen.
- **String literals count as references.** `export const R = /pool saturated/i;` satisfies a claim
  naming `pool.ts`, so a file that merely *names* the owner in a string passes.

And the two remaining false positives are shapes **this repo's own comments already use**:
`mirror.ts:13` writes *"not from `store.ts`"* (a negated claim — a red), and
`chrome-owner.ts:295` / `requirements.ts:284` document the legitimate case where a value **must**
be restated because the language cannot import it (a red).

### The cost argument, stated plainly

- **One instance, and a maintainer reading that file sees the claim.** It is a 3-line doc comment
  on an exported constant 10 lines above its use. The blast radius is a reader who believes a
  shared template exists.
- **The class was narrowed to reach it.** Three of the four reds had to be excluded, and the
  third exclusion has no justification independent of the false positive it removes. That is
  ADR-002's failure mode exactly — the scoping is fitted to the measured population, so its green
  would be an artifact of the fit rather than a property of the class.
- **This repo's own evidence.** ADR-002 already declined the neighbouring rung with a measured
  construction. Stacking a second fitted gate on the same seam is the strongest available
  predictor of a third vacuous gate.
- **The blast radius is asymmetric against the other way.** This claim names a string constant,
  not a credential path or a check. A reader who is misled opens `error-redaction.ts`, does not
  find a template, and reads the code.

### The construction that WOULD work, and does not exist yet

Instance 4's claim is falsifiable **semantically, not syntactically**: *does the named owner
export the binding whose text the claim says it takes?* `error-redaction.ts` exports three
bindings and none is that template, so the claim dies. `mirror.ts`'s claim survives because
`safe-segment.ts` **does** export `assertSafePackageSegment` and `mirror.ts` **does** import it. That
check distinguishes the two shapes without any allow-list, because it tests the claim's substance
rather than the file's spelling of it. It was not built here because it is a different gate (owner
**export surface**, not owner **citation**), and building it unmeasured would repeat the mistake
this ADR documents.

### Evidence that would make this decision wrong

This is a real result and it is **reversible**. Build when **any** of these holds:

1. **A second false derivation claim appears.** One is an anecdote; two is a class. This is the
   signal that stops being an anecdote, and it is the cheapest trigger to watch for — the five
   briefed instances were found by hand in a single session, so more exist.
2. **A claim of this shape is made about a safety property** — a threshold, a gate's verdict, a
   credential path, a redaction list. That raises the asymmetry argument above: insurance is worth
   buying against the silent failure, and this would be it.
3. **A shell-comment-aware segmenter exists** (or the claim surface stops including `.sh`). Half
   the holes above are that one gap; without it the gate is blind in the language where restatement
   is most often *forced*.
4. **The export-surface check is built and measured** (§ above) — the construction that separates
   the class without fitting the population. That is the finding that would overturn this ADR, and
   the only one that makes building it cheap rather than merely possible.

### What was NOT done, on purpose

No test file was added, so `package.json` (`scripts["test:unit"]`) and `README.md`'s two
file-count figures are **deliberately untouched** — this lane owns both, and adding a gate for a
class chosen *not* to gate would have been the vacuous outcome this ADR argues against.
`test/phantom-gate-citation.test.ts` and `test/injection-verdict.test.ts` still pass.