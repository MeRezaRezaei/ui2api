<!--
  Thank you for contributing to UI2API! Start from AGENTS.md →
  CONTRIBUTING.md → the "Add a site / capability package" workflow, and walk
  every step against a real package (capabilities/duckduckgo/) before opening
  this PR. Every box you tick must be true, not aspirational.
-->

## What does this PR add?

<!-- One line: a new site package, a capability, a doc fix, ... -->

- [ ] **Site / package** (check all that apply):
- [ ] `capabilities/<site-id>/manifest.json` — capabilities mirror the site's
      real UI/wire, `analysisMethod` records how it was analyzed
- [ ] `capabilities/<site-id>/profile.json` — ChatSiteProfile (composer/send/
      answer selectors, loginRequired)
- [ ] `capabilities/<site-id>/recipes/<capability>.json` — one per capability
      (+ explicit `recipe:` field when the file name diverges)
- [ ] `capabilities/<site-id>/session.lock.json` — locked:true + snapshotHash
      for captured sites; null snapshot only for genuinely anonymous sites
      (duckduckgo precedent)
- [ ] `capabilities/<site-id>/metadata.json` — `verified` absent/false unless a
      **live round-trip** is quoted under it (since/evidence/via)
- [ ] `capabilities/<site-id>/CAPABILITIES.md` — status header + per-capability
      wire facts + measured blockers + proof lines
- [ ] Runner `src/capabilities/<site>.ts` — `launchBrowser()` only, unknown
      capability → `{ok:false}` DEFAULT branch BEFORE any browser work
- [ ] `POST /capability/<site>` wired in `src/prompt/http.ts` (registry-first
      profile fallback, `resolveCapabilityAccount`, `result.ok ? 200 : 502`)
- [ ] Chat-capable site: `BUILTIN_PROFILES` entry in `src/profile/profile.ts`
      (capability-only sites skip this — packaged profile.json suffices)
- [ ] Runner registered in `test/capability-dispatch.test.ts` `RUNNERS`
- [ ] `capabilities/README.md` inventory row + `README.md` site list updated
- [ ] Session captured + locked (capture / add-all --known / ingest), or the
      honest blocker documented instead (Google app-bound cookies → the
      UNLOCK.md two-step; never a promised-but-anonymous replay)

## Honesty red lines (your PR fails review if any are broken)

- [ ] **No capability claimed verified without a live `ok:true` round-trip +
      a real DOM read-back quoted as evidence.** Wire-mapped / should-work are
      written as such and carry `verified:false`.
- [ ] **No fabricated traffic.** The site is driven through its own UI/JS; no
      synthesized requests, no fake inputs.
- [ ] **Login-gated capabilities return `ok:false loginGated:true`** without
      opening a browser — never an invented ok:true.
- [ ] One-off probe scripts lived in `/tmp` and were deleted; none are in this
      PR.
- [ ] No `data/`, `sites/*/server/`, `.agents/`, or `.opencode/` files are
      staged (session snapshots are credentials and must never be committed).
- [ ] No fabricated proof id / date in any doc or ledger entry.

## Verification

- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` passes
- [ ] `npm run test:unit` passes (incl. validate-packages + capability-dispatch)
- [ ] `npm test` passes (integration; needs the chromium browser)

## Notes for the reviewer

<!-- Measured blockers, attach/plan/login caveats, selector-rot risks ... -->