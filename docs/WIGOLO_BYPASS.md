# Wigolo — the bypass tier

> **When a site answers with a challenge, a consent wall, or an abuse signal, wigolo
> is the engine to reach for — not a retry loop and not a longer timeout.**
>
> This is the operator's standing instruction, recorded here so it is never
> re-derived.

## The failure this addresses

MEASURED live on 2026-09-26, driving real duckduckgo.com through the persistent
Chrome of the `ui2api` user (`docs/CHROME_POINT_OF_USE.md`):

```
POST /capability/duckduckgo  {"capability":"duckduckgo_chat",
                              "args":{"prompt":"Reply with exactly: PONG-READY"}}
-> ok: false
   error: "no answer appeared on duckduckgo — either ERR_CHALLENGE (abuse signal)
           or the consent wall re-blocked; honest on-page read returned empty"
```

That is an **honest** failure — no fabricated answer, a named cause — and it is
the right behaviour. But it is still a failure, and the answer is not to keep
retrying the same path.

The same class shows up as:

- **ERR_CHALLENGE / abuse signal** — the site decided this client looks automated.
- **A consent wall on first send** — a one-time interstitial before any answer.
- **A site that simply refuses the plain Chrome path** even though it works in a
  real browser.

## Wigolo is the bypass tier

`src/runtime/wigolo.ts` + `src/plugin/wigolo-context.ts` are the integration. It
runs its own browser tier and offers:

| operation | use |
| --- | --- |
| `pageMarkdown` | render a page to markdown, through a different tier than the plain driver |
| `dom.extract` | structured extraction via wigolo's DOM service |
| `dom.paste` | put content into a page that refuses programmatic input |
| `ensureWigoloDaemon` | start/attach the wigolo daemon on loopback, with autostart |

The daemon is a **separate tier on purpose**: same-origin, loopback-only, and it
never weakens the normal path. `ui2api` keeps using the site's own JS for normal
traffic — wigolo is what you reach for when the site refuses that.

## The rules wigolo is held to (GOAL 123 — do not weaken these)

- **Loopback only.** `WIGOLO_DAEMON_URL` must be loopback unless
  `UI2API_WIGOLO_ALLOW_REMOTE=1` is set explicitly.
- **The bearer token never leaves loopback** unless the SECOND, separate opt-in
  `UI2API_WIGOLO_ALLOW_REMOTE_TOKEN=1` is set. Allowing traffic out and handing
  over a credential are two different decisions and take two different flags.
- **No fabricated results.** A daemon answer whose `url`/`source_url` is
  cross-origin is REFUSED, so a 200 from any base cannot be served as a page's
  answer. This is the project's absolute rule and it outranks convenience.
- A `wigolo refused …` security error is re-thrown, never silently degraded into
  "daemon unavailable".

## How to use it

```bash
# the daemon is loopback; it autostarts when a wigolo-backed tool is called
export WIGOLO_DAEMON_URL=http://127.0.0.1:3333     # optional; loopback is the default
npx tsx src/cli.ts plugin serve <module>            # the MCP surface that exposes it
```

Wigolo's checkout lives beside the app (`../wigolo`, pinned to a verified commit
in CI — see `.gitlab-ci.yml`). `WIGOLO_REPO` points the tests at it.

## What to do when a site challenges

1. **Do not** retry the plain path in a loop, and do not raise a timeout. That
   only deepens the rate-limit signal.
2. **Do** reach for the wigolo tier for that site.
3. **Do** keep the honest verdict. If wigolo cannot get a real answer either, the
   answer stays `ok:false` with the named reason. A challenge is a real outcome,
   not something to paper over.
4. Record it as a site capability with its honest status — the same rule as every
   other unverified or blocked site here.
