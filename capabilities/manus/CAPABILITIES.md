# Manus (manus.im) — capability inventory

**Analysis**: static bundle analysis (6 bundles ~6.6MB) + manus.im Next.js SSR (231KB HTML). **No bot wall** — plain Chrome-UA curl 200, bundles served normally.

## Transport
- **REST family**: `POST /api/chat/*` — verified literals:
  `getSessionV2`, `getSessionFilesV2`, `getSessionOutline`, `getSandboxStatus`, `startSandbox`, `scheduleTask`, `getPresignedUploadUrl`, `uploadComplete`, `getMobilePreviewStatus`, `requestVncOtp`, `wakeMobilePreview`, `deleteSession`, `getDownloadUrl`, `getMapReduceTool`, `getOnlineMyBrowserClients`, plus `/api/internal/fixUrlMeta`, `/api/internal/resetDailyQuota`.
- **Streaming**: SSE (`event:` frames — 36 refs in ms-5.js) + WebSocket + ReadableStream all referenced; exact send endpoint literal NOT recoverable statically.
- **Protobuf**: `schedule/v1/sandbox` refs present.

## Auth
- Cookie + JWT + localStorage/sessionStorage. Catalog (`provider-catalog.md`: `manus-web`) = cookie auth, credential `manus_session`. Bundle localStorage keys: `manus`, `manus-account`, `manus_account_package`, `webrtc_token`; `*_session` cookie refs. Sentry plugin key `manus-web`. OAuth (Google/GitHub) signup expected.

## Task-autonomy model
Sessions/tasks (not flat conversations): session start/list, sandbox start/status, mobile preview + VNC OTP, presigned upload — Redux `sessions.sessions.entities[sessionId]`, user events (`session_delete`, `session_rename`...). `manus_chat` = plain conversational UI path; session/sandbox/upload = capability shapes to-verify on first live capture.

## Verified vs to-verify
| Fact | Status |
|---|---|
| REST family literals (`/api/chat/*`) | ✅ verified in bundles |
| SSE + WS + ReadableStream used | ✅ verified (event: frames, refs) |
| auth = cookie+JWT+localStorage, `manus_session` (catalog) | ✅ catalog / bundle corroborated |
| no bot wall | ✅ verified (200s, bundles served) |
| exact message-send endpoint | ⚠️ TO-VERIFY on first live capture (obfuscated) |
| SSE/WS event schemas, message types | ⚠️ TO-VERIFY |
| DOM composers/answers/model picker | ⚠️ TO-VERIFY (profile selectors = structural guesses) |
| presigned-upload flow, VNC OTP flow | ⚠️ TO-VERIFY |

## Capability list
`manus_chat` (UI path) · `manus_session_start` · `manus_session_list` · `manus_sandbox` · `manus_upload` (REST shapes, live-to-verify).

<!-- ui2api:capability-index:start -->
<!-- GENERATED from manifest.json by scripts/gen-capability-index.mjs — do not hand-edit. -->

## Capability index (machine-generated, complete by construction)

Package status: **unverified (no verified record)**.
The status column below is each capability's OWN declared status — it is a
declared surface, not a claim of a verified live round-trip.

| capability id | name | declared status | description |
| --- | --- | --- | --- |
| `manus_chat` | Chat (UI path) | awaiting capture |  |
| `manus_session_start` | Session start | verified-endpoint / live-to-verify |  |
| `manus_session_list` | Session list | verified-endpoint / live-to-verify |  |
| `manus_sandbox` | Sandbox control | verified-endpoint / live-to-verify |  |
| `manus_upload` | File upload | verified-endpoint / live-to-verify |  |

<!-- ui2api:capability-index:end -->
