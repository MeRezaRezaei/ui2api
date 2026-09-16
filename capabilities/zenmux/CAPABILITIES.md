# ZenMux capabilities (static probe, 2026-09-16)

## Verdict: DEAD-END — parked/empty domain, no application served

Analyzed statically (curl only, Chrome UA, no browser launched). **zenmux.com does not
currently serve an AI chat product.** The domain is registrar-parked infrastructure with
no TLS service and an empty HTTP shell. The `zenmux-free` entry in
`provider-catalog.md` (auth kind **cookie**, credential `Cookie header (full)`) describes
a web-session proxy/aggregator tier, but the origin that would issue that cookie is not
reachable. Nothing to reverse-engineer; package shipped as a minimal, honestly-marked
scaffold so the catalog slot stays tracked.

## 1. Domain resolution outcome

- `https://zenmux.com` — **connection timeout on :443** (no TLS responder).
- `https://www.zenmux.com` / `https://app.zenmux.com` — same: timeout on :443.
- `http://zenmux.com` — HTTP **200**, but body = 94-byte empty shell:
  `<html><head><title></title><meta name="revised" content="1.1.7" /></head><body></body></html>`
  No scripts, no links, no app HTML.
- DNS: `165.160.13.20`, `165.160.15.20`; MX `custmx.cscdns.net` — CSC (Corporation
  Service Company) registrar/DNS parking infrastructure.
- Subdomains probed `app.`, `api.`, `chat.`, `m.` — no connect (000) on HTTP; no TLS.
- Wayback Machine (2026-06-14T13:31:25Z snapshot of `http://zenmux.com/`) serves the
  **identical empty shell** — parked since at least mid-June 2026.
- The `meta[name="revised" content="1.1.7"]` echo is a generic parking-page marker, not
  an app version.

## 2. Static analysis outcome

No JS bundles exist on the served page — there is no app to extract bundle URLs from.
Endpoints, streaming, model literals, and feature flags therefore **could not be found**
and are **not fabricated** in this package.

What the catalog implies (label only, unverifiable today): free tier of a proxy /
aggregator front for chat models, authenticated by a **cookie** (full Cookie header
replayed). No API base, path, auth scheme, or request shape could be confirmed.

## 3. Verified vs to-verify

**Verified (static, this run):**
- Domain resolves but is parked; HTTPS dead, HTTP serves an empty shell.
- Was already parked at the 2026-06-14 Wayback snapshot.
- No bot wall hit — there is nothing behind the shell; the server answers instantly.

**To verify (blocked — requires the origin to come back up):**
1. Whether zenmux.com ever serves an AI chat/proxy app again, and on which host
   (zenmux.com vs app./) the SPA and API live.
2. The OpenAI-compatible surface it exposes (`/v1/chat/completions` or similar) —
   presumed for a proxy/aggregator tier but unproven.
3. Streaming transport (SSE vs other); model literals; feature flags.
4. The cookie the catalog names — name, domain, and which Cookie header the free tier
   expects. `loginRequired: true` is kept because the catalog says cookie auth, but the
   capture command will fail against a dead origin.

## 4. Bot-wall outcome

**None.** No Cloudflare/challenge marker (`cf-chl-*`, Turnstile, interstitial) was served.
A parked shell has no defenses; it simply has no service.

## 5. Suggested ui2api capability list

| id | description | status |
|----|-------------|--------|
| `zenmux_chat` | Composer send + streamed answer (exact wire UNKNOWN — catalog implies an OpenAI-compatible proxy tier). | scaffold only; dormant pending domain revival |