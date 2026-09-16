# TinyCMS capabilities — DEAD-END VERDICT (2026-09-16)

## Summary

**tinycms-web is a dead end.** No AI chat product exists at any resolvable domain.
The OmniRoute catalog entry (`src/shared/providers/webSessionCredentials.ts`) lists
`tinycms-web` with `kind: "token"`, `credentialName: "app-config-uuid"`,
`placeholder: "R..."` — but the underlying product cannot be found.

## Domain resolution

| Candidate domain | Result |
|---|---|
| `tinycms.cc` | 000 (DNS failure) |
| `tinycms.app` | 000 (DNS failure) |
| `tinycms.com` | timeout (no response) |
| `www.tinycms.com` | 000 (DNS failure) |
| `tinycms.io` | 000 (DNS failure) |
| `tinycms.ai` | 000 (DNS failure) |
| `tinycms.net` | 000 (DNS failure) |
| `tiny-cms.com` | 000 (DNS failure) |
| `tinycms.chat` | 000 (DNS failure) |
| `tinycms.com.cn` | 000 (DNS failure) |
| `tinycms.cn` | 000 (DNS failure) |
| `tinycms.xyz` | **200** — but see below |
| `app.tinycms.xyz` | 000 (DNS failure) |

## tinycms.xyz — what it actually is

`https://tinycms.xyz` serves a docute-based documentation site for a Chinese foreign-trade
inquiry form / CMS product by "leadscloud". It has:
- A GitHub repo (`leadscloud/inquiry`) for an inquiry form backend
- A live-chat widget JS plugin (`cdn.livechatinc.xyz`)
- A Chrome SERP-analyzer extension

**This is NOT an AI chat product.** It is a lead-gen CMS for foreign trade businesses.
No chat UI, no model picker, no streaming endpoints, no AI backend whatsoever.

## OmniRoute catalog entry

Source: `diegosouzapw/OmniRoute/src/shared/providers/webSessionCredentials.ts`

```typescript
"tinycms-web": {
  kind: "token",
  credentialName: "app-config-uuid",
  placeholder: "R...",
  acceptsFullCookieHeader: false,
  storageKeys: ["apiKey", "token", "uuid", "app-config-uuid"],
}
```

The `placeholder: "R..."` suggests a token/API-key starting with "R", but no product
matching this credential shape was found. The entry may be:
1. A speculative/placeholder catalog entry never linked to a live product
2. A product that has since shut down or rebranded beyond recognition
3. An internal/private tool not publicly accessible

## Bot-wall outcome

Not applicable — no target product to bot-wall against. tinycms.xyz is a static doc
site served by nginx (no JS app bundles, no chat functionality).

## Verified vs to-verify

**Verified (static, curl only):**
- All 12 candidate domains probed; 11 dead, 1 (xyz) is a non-AI CMS docs site
- OmniRoute catalog entry shape confirmed from source
- No JS bundles to analyze (no app to analyze)

**To verify:** N/A — dead end. No package can be built.

## Recommendation

Mark `tinycms-web` as **unsupported** in any downstream capability registry.
If the product resurfaces under a different domain, re-run this probe. The
OmniRoute catalog entry should be flagged for potential removal or archival.

## Files in this package

All files are scaffolded for structural completeness but carry the dead-end verdict.
No selectors, no recipes, no live session data — all marked accordingly.
