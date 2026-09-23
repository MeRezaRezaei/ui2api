# Security policy — ui2api

## Trust model

ui2api drives a website through the **user's own browser session**: the same
cookies, localStorage and origin code paths a human would use. It never
synthesizes requests or sends fake inputs that could look foreign to a site's
anti-bot stack. That design is the security model:

- **Credentials never leave your machine.** Session snapshots
  (`data/<host>/`, `data/sessions/`) are local, gitignored, and never shipped
  in the npm package or committed to the repo. The published package contains
  only *key names* (cookie names, localStorage keys) and snapshot *hashes* —
  never values (audited 2026-09-23).
- **The daemon is localhost-only by default.** `promptd` binds `127.0.0.1`
  (`src/prompt/http.ts`) and serves **only the profiles handed to it at
  startup** — an unknown `site` in any request is rejected with 400
  (`idFrom`/`profilesById`). `src/runtime/ssrf.ts` pins origins for capability
  endpoints; no surface serves arbitrary URLs.
- **Optional bearer-token gate.** Set `UI2API_PROMPTD_TOKEN` to require
  `Authorization: Bearer <token>` on every daemon request. No token set =
  localhost-only posture (the README's "optionally bearer-token gated").
- **No fabricated traffic.** Answers are read off the page; posting/login-gated
  capabilities stay honest `ok:false` until a real attached session proves
  them. Never claim a capability verified without a live round-trip.

## Verifying the published artifact

```bash
npm pack --dry-run          # inspect the file list (no data/, no .env, no test/)
npm audit                   # dependency vulnerabilities (0 at 2026-09-23)
npx tsc --noEmit && npm run build && npm test && npm run test:unit
```

## Reporting a vulnerability

This is a personal project. For now, report issues by opening a GitHub issue
on https://github.com/MeRezaRezaei/ui2api (private details welcome — describe
impact, not exploit code). Do not email session data or credentials.