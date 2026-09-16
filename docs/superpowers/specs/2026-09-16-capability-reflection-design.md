# Capability Reflection — design (2026-09-16)

**Status:** approved (user delegated the decision; design presented in chat, node given).

## Problem

Users of the same AI site have different entitlements: Gemini free vs Pro, ChatGPT
free vs Plus, Kimi/Hunyuan tiers. The prompt engine today is blind to this:

- `ChatSiteProfile` is purely mechanical (composer/send/answer selectors). No
  concept of models, tiers, or restrictions.
- `PromptResult` = `{answer, chunkCount, doneReason, url, title}`. When a free
  user hits an upgrade wall, the driver reports `doneReason:"empty"` or returns
  the wall's text as the "answer". Callers cannot distinguish "the site changed"
  from "this account hit a plan limit", and cannot adapt (fall back to another
  site/model).

Constraint (user): we cannot know every site's full catalog. Real-world info is
limited. Goal: **reduce the friction** with what the site itself shows us.

## Insight

The site shows us what THIS account can do:

- the model picker lists only the models this account can pick;
- the plan badge / avatar menu states the tier;
- upgrade / limit banners appear in-page when a prompt hits a restriction.

So: **observe → store → watch → report.** Never fabricate a catalog; when
something is unreadable, say `method:"unknown"` instead of guessing.

## Data model

```ts
interface CapabilityReport {
  site: string;            // profile id
  host: string;            // e.g. gemini.google.com
  account: string;         // identity (email slug)
  observedAt: string;      // ISO
  tier: { value: string | null; method: "dom" | "declared" | "unknown" };
  models: Array<{ id: string; name: string; selected?: boolean; tier?: string }>;
  modelsMethod: "wire" | "dom" | "declared" | "none";
  restrictions: Array<{ kind: string; matched: string; source: "banner" | "marker" }>;
  ok: boolean;             // false when nothing readable (with reason)
  reason?: string;
}
```

Stored at `data/sessions/<host>/<slug>/capabilities.json` (identity-vault layout,
same as `state.json`). `session-store.ts` gains `capabilitiesPath`,
`saveCapabilities`, `loadCapabilities`.

## Profile capability block (declarative, JSON-safe)

```ts
capability?: {
  tierSelectors?: string[];                 // plan badge / avatar menu
  pickerOpen?: string[];                    // click-to-open the model picker
  pickerOption?: string[];                  // option rows inside the picker
  restrictionMarkers?: Array<{ kind: string; patterns: string[] }>;
  // e.g. { kind:"upgrade", patterns:["upgrade to", "get gemini"], }
}
```

`patterns` are case-insensitive substring matches (JSON-safe, no RegExp literals).
Selectors rot like composer selectors — same re-tune story (`--profile FILE`).

## Components

### L1 — Probe (`src/runtime/capability-probe.ts`, new)

`probeCapabilities(profile, opts: { page, host, account })` → reads the live
page best-effort:

1. tier: first `tierSelectors` visible → innerText (cleaned, short).
2. models: if the profile declares a wire model source (gemini `otAQ7b` via
   `gemini-rpc.ts`), use it (`method:"wire"`); else if `pickerOption` selectors
   are declared, open via `pickerOpen`, read rows (name, `selected` from
   aria/class), close the picker.
3. restrictions: collect visible text (body innerText truncated), match
   `restrictionMarkers` → `restrictions[]`.
4. Nothing readable → `ok:false, reason` (honest-unknown).

`GET /capabilities?site=X&account=Y` on the daemon serves the stored report
(`{probed:false}` when absent).

### L2 — Watch (in-band, in `ChatDriver.ask`)

- `PromptResult` gains `restrictions?: Array<{kind, matched}>` and
  `model?: string` (current selected model when readable).
- After the answer settles (or on empty result): scan the page text for
  `restrictionMarkers`. If hit → include `restrictions` in the result.
- Empty answer + restriction hit → return `{answer:"", doneReason:"restricted",
  restrictions:[...]}` instead of throwing the generic "no answer" error, so the
  caller can adapt. Empty + no marker → existing error path unchanged.

### L3 — Select (`--model`)

- `PromptOptions.model?: string`; CLI `--model`; daemon `/prompt` body `model`.
- When set, driver checks the account's observed models (from the probe or a
  picker read): if present → open picker, click it; if absent → explicit error
  `model "X" not available on this account (observed: [...])`.
- Phase 2 (future): `modelPolicy` per site (auto-fallback list).

### Wiring

- `cli.ts`: `profile capabilities <host> [--account Y]` (probe live + print);
  `--model` on `prompt`; probe at end of `profile capture --assist` (reuse the
  live page before closing).
- `http.ts`: `GET /capabilities?site=&account=`; pass `model` through `/prompt`;
  `restrictions`/`model` pass through in the result.
- `xhost-capture.ts`: probe-on-capture hook (optional param, default off).

## Testing

- Unit: marker classification (case-insensitive substring, multi-pattern),
  `CapabilityReport` shape, honest-unknown path (no selectors → ok:false),
  model has/not-has decision, JSON-safe profile parsing.
- Live: probe the real imported Gemini account (signed in) → first-ever real
  fingerprint; assert it returns `modelsMethod` + tier + model names, not ok:false.

## Honest limits (documented in code + README)

- Probe selectors rot; unknown ≠ absent (always `method:"unknown"`).
- Wire catalogs only where grounded (gemini today).
- This reduces friction; it does not pretend completeness.