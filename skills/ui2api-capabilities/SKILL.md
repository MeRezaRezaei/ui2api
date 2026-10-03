---
name: ui2api-capabilities
description: >-
  Use when calling a ui2api site's NON-CHAT tool surface: discovering capabilities
  via GET /registry, introspecting one via GET /capabilities/<site>, invoking one
  via POST /capability/<site>, picking a vault account, or interpreting an honest
  failure (login-gated, restriction wall, abuse challenge). Triggers on "call the
  youtube_search capability", "what capabilities does <site> have", "list installed
  packages", "multi-account", "loginGated", "register a provider/tool from ui2api".
  Not for chat completion — see ui2api-chat. Not for daemon/MCP setup — see
  ui2api-operate.
---

# ui2api — capability & tool surface

Every claim below is derived from the running daemon, not from prose.

Derive live state; never trust a count in this file.

```bash
curl -s http://127.0.0.1:9797/registry | jq '.packages[] | {id, status, chat: .chat.model}'
curl -s http://127.0.0.1:9797/capabilities/youtube | jq
curl -s http://127.0.0.1:9797/accounts?site=gemini | jq
```

## 1. Discovery contract — `/registry` is the ONLY source

`GET /registry` (`src/prompt/http.ts:1174`, builder `src/prompt/registry.ts:946`) returns
`{contractVersion, endpoints, auth, scope, packages[], generatedAt}`.
**No site knowledge may live in a consumer.**

`packages[]` (`registry.ts:1052`): `id`, `name`, `url`, `description`, `version`, `site`,
`authRequired`, `status`, `verified`, `chat?`, `chatWithheld?`, `tools[]`, `accounts?`, `accountsSummary?`

`tools[]` (`registry.ts:996`): `name`, `id`, `description`, `method`, `workType`,
`reloadAfterSuccess`, `inputSchema`, `argsDeclared`, `dispatch`

| field | rule |
|---|---|
| `tool.name` | `` `${siteId}_${bareCapabilityId(...)}` `` (`registry.ts:999`) — your tool key |
| `tool.id` | the bare capability id (`registry.ts:1000`) — what you send as `capability` |
| `argsDeclared` | `false` = `inputSchema` is a best-effort GUESS (`registry.ts:1011`). Do not auto-generate a client; ask. |
| `dispatch` | `wired` \| `declared-only` (`registry.ts:1018`). `declared-only` ⇒ a call 404s. Filter it out. |
| `status` | `metadata.json` verbatim; `"unknown"` if absent (`registry.ts:983`) — see §5 |
| `verified` | `false` or a full `{since, evidence, via}` record (`registry.ts:988`). Truthy requires all three. |

## 2. `chat` is a PROMISE, not a hint

`chat: { model, streaming: true }` is emitted **only** when the id is on
`defaultChatSurface()` (`src/prompt/registry.ts:954`) **and** on the measured
`answerableChatSurface()` (`src/prompt/registry.ts:962`).

- Key on `pkg.chat?.model`. **Absence means "no chat", never an error.**
- The package is still fully listed — tools, status, metadata — and still served on
  `/registry` + `POST /capability/<site>`. This is exactly how capability-only sites work.
- If the id is addressable but not answerable, `chatWithheld: { class, reason }` names the omission (`registry.ts:1075`).

## 3. Introspect one site

| route | returns |
|---|---|
| `GET /capabilities/<site>` (`http.ts:1225`) | `{site,name,url,capabilities[{id,name,description,method}],source:"manifest",accounts[]}` |
| `GET /capabilities?site=<id>&account=<id>` | the stored `CapabilityReport` (`http.ts:1253`) |
| `GET /accounts?site=<id>` (`http.ts:1193`) | `{site, host, accounts[]}` |

`probed:false` (+ `hint`, or `error` when the stored file is malformed — `http.ts:1326`) means
**no fingerprint stored**. Probe it, don't infer it. Unresolvable account ⇒ `400
{error:{code:"no_stored_account", message}}` (`http.ts:1298`).

Stored report (`src/runtime/capability-probe.ts:66`): `site`, `host`, `account`, `observedAt`,
`tier`, `models`, `modelsMethod`, `restrictions[]`, `abilities?`, `abilitiesMethod?`, `ok`, `reason?`.
`restrictions[]` entries are exactly `{kind, matched}` (`capability-probe.ts:23`).
`ok:false` carries `reason: "nothing readable with the current probe selectors"`.

Accounts (`CONSUMER_ACCOUNT_FIELDS`, `src/runtime/session-store.ts:852`) — an allow-list, the
consumer wire shape: `{account, capturedAt, usable?}`. `accountsSummary`:
`{total, usable, unusable, reasons}`. An unusable row is still LISTED; `usable:false` is the signal.

## 4. Call one capability

`POST /capability/<site>` (`http.ts:1480`); site is the path suffix.

```bash
curl -s -X POST http://127.0.0.1:9797/capability/youtube \
  -H 'content-type: application/json' \
  -d '{"capability":"youtube_search","args":{"query":"<q>"},"account":"<slug|email>"}'
```

| body key | required | note |
|---|---|---|
| `capability` | yes | the bare `tool.id`, not `tool.name`. `400 "capability is required"`. |
| `args` | no | defaults `{}` |
| `account` | no | slug or email; empty = legacy shared session. Resolved against the vault **before any browser launches** (`http.ts:1510`), so a bad ref never spins up Chrome. |

The response **is the runner's own object, verbatim** — no wrapper; `200` when `ok`, else `502`
(`http.ts:1521`). Check `ok` FIRST. Read `ok`, `data`, `error` (the named reason string —
**gated failures live here; there is no `reason` field on gated results**), `loginGated`
(`src/capabilities/gated.ts:38`), `scaffold` (unverified DOM selectors,
`src/capabilities/youtube.ts:113`), plus `method`/`latencyMs`/`wireNote?`/`antiBot?` provenance.

Codes: unknown site ⇒ `404 {error:{code:"site_not_dispatched"}, reason_code, dispatchable[]}`
(`http.ts:1486`) — read `dispatchable[]` rather than guessing a site id; unknown capability ⇒
`400 {error:{code:"unknown_capability"}}`; runner throw ⇒ `500 {ok:false, reason_code:"runner_error"}`.

## 5. Status & truth — what you may claim

`status` is `metadata.json`'s verbatim string, `"unknown"` when absent. Chat-surface
vocabulary (`src/prompt/registry.ts:398`): `verified`, `unverified-candidate`, `dormant`,
`dead-end`, `builtin`.

**No live round-trip, no verified claim.** A capability is `verified` only after a real
round-trip against a real session. An `ok:true` from a **replayed** snapshot means *input
accepted* — never *action performed*.

| status | you may say | you may NOT say |
|---|---|---|
| `verified` + `verified` record | "live round-trip, evidence dated" | — |
| `unverified-candidate` | "implemented, not live-verified" | "works" |
| `dormant` / `dead-end` | "cannot drive chat; capability surface still served" | "chat model" |
| `unknown` (no metadata) | "no status recorded" | anything positive |
| `loginGated: true` | "recipe shipped, not executable without capture" | "posted" / "sent" |
| `scaffold` | "selectors unverified, no round-trip" | "verified" |

`loginGated` is not universal: `src/capabilities/youtube.ts` signals with `scaffold` + `error`
instead. **Absence of `loginGated` does not mean verified** — read `ok` and `error`.

## 6. Failure ladder

1. **Restriction wall** — REPORTED, never a blind empty. Every chat profile declares
   `capability.restrictionMarkers`, `kind ∈ {upgrade, limit, login}` + case-insensitive
   substring patterns (`src/profile/profile.ts:830`). The driver scans in-band
   (`readRestrictions()`, `src/prompt/driver.ts:779`) and on an empty answer returns
   `doneReason:"restricted"` with the named hits (`src/prompt/driver.ts:723`).
   A blind empty answer where a marker matched is a BUG, not a wall.
2. **Challenge** — abuse challenge, consent wall, or `ERR_CHALLENGE`.
   **Do NOT retry the plain path and do NOT raise a timeout.** That only deepens the
   rate-limit signal.
3. **Wigolo tier** — a separate browser tier for exactly this (`src/runtime/wigolo.ts`,
   `src/plugin/wigolo-context.ts`). Its own rules are NOT to be weakened: loopback only
   unless `UI2API_WIGOLO_ALLOW_REMOTE` (`src/runtime/wigolo.ts:109`), and the bearer token may
   not leave loopback without the SECOND opt-in `UI2API_WIGOLO_ALLOW_REMOTE_TOKEN`
   (`src/runtime/wigolo.ts:376`). Autostart is `UI2API_WIGOLO_AUTOSTART` (`wigolo.ts:320`);
   auth is `UI2API_WIGOLO_USE_AUTH` (`src/plugin/wigolo-context.ts:125`).
4. **Honest `ok:false`** — if wigolo cannot get a real answer either, the result stays
   `ok:false` with the named reason. **Never fabricate, never retry-loop a challenge.**

## 7. Attach, do not replay — browser-bound auth

Some surfaces hold auth cookies a snapshot cannot carry (app-bound encryption: gmail,
youtube, tencent). Replaying the vault — or a profile copy — into a fresh context renders
**anonymous** and trips the site's anti-bot check. **Attach the user's own real Chrome
instead:** `UI2API_ATTACH_PORT` (`src/runtime/browser.ts:201`) points the daemon at an
already-running browser's CDP endpoint (the dedicated chrome owner's live profile, or the
operator's own, via `google-chrome --remote-debugging-port=9222`). Verify with
`GET /status` → `posture` (`src/prompt/http.ts:1336`). See `src/capabilities/gmail.ts:72`
for the named auth-wall note and its unblock steps.

## 8. Sibling skills

- `ui2api` — entry point, routes here. `ui2api-chat` — chat surface (`/prompt`,
  `/v1/chat/completions`). `ui2api-operate` — daemon, MCP install, headed-posture recovery.
- **Per-host generated leaf skill** — `src/generator/skill-template.ts` emits a `SKILL.md`
  (`name: ui2api-<host>`) + `skill-loader.mjs` per generated server. Read it for that host's
  exact tools. It complements this file; it does not replace the discovery contract.

## 9. Repo map

`src/prompt/http.ts` (every route above; authority for shapes) ·
`src/prompt/registry.ts` (`packages[]` construction, `defaultChatSurface()` gate) ·
`src/capabilities/gated.ts` (honest login-gated helper) ·
`src/runtime/capability-probe.ts` (fingerprint shape, `restrictions[]`) ·
`capabilities/README.md` (walled/scaffold/dead-end inventory) ·
`AGENTS.md` (the `UI2API_*` knob table — not duplicated here).
Gates: `test/capability-dispatch.test.ts` (manifest↔dispatch sync),
`test/restriction-markers.test.ts` (marker coverage).
