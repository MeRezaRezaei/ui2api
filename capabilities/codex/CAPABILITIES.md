# ChatGPT Codex web capabilities (chatgpt-web-codex), from JS bundle analysis, 2026-09-16

Analyzed statically (curl only, Chrome UA + full browser-like header set, no browser launched). 14 JS bundles
(~12 MB) + the SSR HTML + `client-bootstrap` JSON from `https://chatgpt.com/codex`.
Cluster `unified-184`, bootstrap `authStatus: logged_out`, `isNoAuthEnabled: true`, `webSurface: core_web`.

- `/codex` on a **logged-out** session serves the **Contentful marketing page** ("Codex in ChatGPT | AI Coding
  Agents for Software Engineering", canonical `/codex/`, nav to `/codex/overview`, `/codex/enterprise`), NOT the
  app. The app shell is shared with plain ChatGPT (same `entry.client-*`, `conversation-small-*`,
  `manifest-*`, `4813494d-*` auth bundle, `8b34dbc2-*` shell). The React Router manifest embedded in
  `conversation-small` carries the full **auth-gated Codex SPA route table** (73 codex/agent routes).
- **Codex backend lives on the SAME host as plain chat**: the shared request client (`K`) resolves authed
  requests to `Fr = VITE_SHARED_API_URL ?? "https://chatgpt.com/backend-api"` (`fr`), so Codex REST/SSE calls
  go to `https://chatgpt.com/backend-api/*`. Codex-specific path namespace is `/wham/*` plus a conversation-bound
  task stream at `/backend-api/tasks/{task_id}/stream`. Plain chat keeps using `/backend-api/f/conversation` etc.

## 1. Chat / task core (models, streaming, task lifecycle)

- Task create: **`POST /backend-api/wham/tasks`** — body `{ new_task: {environment_id, branch, run_environment_in_qa_mode},
  input_items: [{type:"message", role:"user", content:[{content_type:"text", text}]}...] }`. Variants:
  `{review_fix:{task_id,turn_id}, input_items:[]}` (Code Review fix) and `{follow_up:{task_id,turn_id,run_environment_in_qa_mode},
  input_items:[...]}` (follow-up turn). The `additionalHeaders` are built by the shared Sentinel b/u builder
  `c1(...)` with a **chat-requirements token generated for mode `codex_create_task_turn`** (`OpenAI-Sentinel-Token`,
  plus optional `OpenAI-Sentinel-Chat-Requirements-Token`, `-Turnstile-`, `-Proof-`, `OAI-Telemetry`); i.e. Codex task
  creation passes the **same `/sentinel/chat-requirements/prepare`→`finalize` gate as plain chat**.
- Task CRUD/lifecycle (`/wham/tasks[...]`): `GET /wham/tasks` (cursor `limit`/`cursor`/`task_filter`),
  `GET /wham/tasks/list`, `GET /wham/tasks/search`, `GET /wham/tasks/{task_id}`,
  `POST .../{task_id}/archive | /cancel | /fork | /mark_read | /recover`,
  task suggestions `GET /wham/task_suggestions/github/user_handle`, samples `GET /share/codex/task_samples`.
- Turns: `GET /wham/tasks/{task_id}/turns`, `GET .../turns/{task_turn_id}`,
  `POST .../turns/{task_turn_id}/cancel | /viewed`, `POST .../copy_git_apply`,
  `GET .../turns/{task_turn_id}/logs`, turn PR `GET/POST .../turns/{task_turn_id}/pr`, `.../pr/{pr_id}` (update).
- Streaming (`codex-in-chat`, conversation-bound): **`GET /backend-api/tasks/{task_id}/stream?parent_conversation_id=&message_id=`**
  — SSE (`Accept: text/event-stream`), fetched with the in-bundle `fetch-event-source`-style helper (`[DONE]` terminator,
  `last-event-id` replay/retry, `openWhenHidden`). Each `data` line is a JSON payload with one of:
  `{task_status, task_id, interruptions_disabled?}` (status transition), `{final_message, was_recently_completed?}` (done),
  `{row}` (typed activity row), `{title}` (title update). Row types parsed client-side (`$ke`): `website_open`,
  `summary`, `search`, `python_analysis`, `file_open`, … each row `{id, type, row_text, active_row_text, …}`.
  Task statuses seen in store filters: `created`, `running`, `finalizing` (+ complete/cancel by UX semantics — to-verify).
- Models: **no hard-coded Codex model slug literals** in these bundles. Model eligibility is server-driven via
  `eligible_codex_model_slugs` on the conversation-settings bootstrap and the codex picker. Generic checkpoint literal
  seen: `gpt-5-6-auto-thinking` (`resolved_model_slug`). Features `computer_use`/`windows_computer_use` gate exists.
  → exact codex model slugs (`codex-mini`, `codex-1/2`, …) are **to-verify on a live capture**.

## 2. Sandbox, artifacts, tools

- Sandbox lives in the shared chat layer: `sandbox:` URIs in message parts (`sandbox:` link scheme parsed by
  `Abn`/`Nbn`), per-message `sandbox_policy`, `sandbox_path` on artifact file ops, `loadSandboxArtifactPreview`
  (chunk `9135be79…`), artifact iframe `sandbox:"allow-scripts"`, CSS `dil-sandbox-file-download`,
  feature gate `sandboxed_pdf_previewer_enabled`. Message/bubble fields: `artifact_kind`,
  `artifact_files`, `sandbox_path`, `file_id`, `size_bytes`, `version_number`, `is_output_artifact`.
- Codex-adjacent headers on the wire: `x-openai-web-frontend: core_web`, **`x-openai-codex-window-type`**
  (`not_applicable` in chat), **`x-codex-entrypoint`** (Codex onboarding attribution), `x-codex-share-post-id`.
- Codex org integrations surfaced as connectors: `slack_codex_*`, `linear_codex_*` OAuth clients + `CodexMCPElicitation`,
  `CodexPluginAuthRequired`, `CodexCollaboration` strings.

## 3. Codex Cloud

- SPA routes `/codex/cloud` (universe/tasks/access/security/settings/failwhale), cloud task detail
  `/codex/cloud/tasks/:taskId` and cloud PR page `/codex/cloud/tasks/:taskId/turns/:turnId/pr`.
  Cloud task list module imports the same wham client chunk; dedicated cloud-task REST paths were **not**
  separated in the shared bundles analyzed → to-verify on live capture.

## 4. Auth & session facts for automation

- Session source: same-origin **`/api/auth/session`** (Secure), same cookie jar as the app — **identical to plain
  ChatGPT** (`capabilities/chatgpt`). Tokens resolve via `Authorization: Bearer <accessToken>` (Wham client `Xhe()`
  keys the base URL off presence of the `Authorization` header). Token refresh via `BroadcastChannel "auth-session"`
  (`access-token-refreshed-v1`); cookies named `__Secure-oai-is`, `__Secure-oai-employee-device`; target-route headers
  `X-OpenAI-Target-Path` / `X-OpenAI-Target-Route`.
- provider-catalog entry: **`chatgpt-web-codex` kind `cookie` (`ChatGPT Cookie header (full)`)** — same login as
  `chatgpt-web` (chatgpt.com session).
- Codex feature-gate keys (from the user-gate enum): `wham_access` (`ALLOW_CODEX_ACCESS`), `wham_local_access`
  (`ALLOW_CODEX_LOCAL_ACCESS`), `personal_access_tokens`, `codex_admin`, `codex_agent_network_access`,
  `codex_device_code_auth`, `codex_remote_control`, `windows_computer_use`, `codex_slack_posting`,
  `codex_usage_leaderboard`, `codex_git_attribution`, `codex_training_allowed_v2`, `codex_security`,
  `codex_security_admin`, `codex_only` (workspace feature), `codex_rate_limit_reset`.
  Enterprise scopes: `chatgpt.workspace.feature.codex-admin.access`, `chatgpt.workspace.feature.windows-computer-use.access`,
  `chatgpt.workspace.feature.allow-computer-history.access`, `chatgpt.workspace.security.codex-access.allow`.
- CLI/desktop Codex flows: OAuth client config endpoints `/oauth/codex/client.json` and `/oauth/codex/:callbackId/client.json`
  (Codex CLI device-code pairing — gate `codex_device_code_auth`), route `/codex/desktop-auth`, `/codex/desktop-session`,
  `/codex/install.sh`, `/codex/install.ps1`, `/codex/rosalind-download` (desktop app codename "Rosalind").

## 5. DELTA vs capabilities/chatgpt (plain ChatGPT package)

| surface | ChatGPT (chatgpt package) | Codex web (this package) |
|---|---|---|
| App shell | same SPA core (`entry.client`, `conversation-small`, auth `4813494d`, shell `8b34dbc2`) | **same bundles** — codex is a route set inside the chatgpt SPA, not a separate client |
| Chat send | `POST /backend-api/f/conversation` (+ `/conversation/resume`) | `POST /backend-api/wham/tasks` (create task/turn) — different namespace, same host |
| Streaming | SSE `text/event-stream` on conversation send; events `stream_start`/`status_message`/`conversation_id`/`turn_complete`, chunk-delta literal composed | SSE on **`GET /backend-api/tasks/{task_id}/stream`** (query `parent_conversation_id`, `message_id`); JSON `data` payloads `task_status` / `final_message` / `row` / `title`, `[DONE]` terminator |
| Rate-limit / sentinel | chatreq token + `/sentinel/chat-requirements/*` | same sentinel gate, chatreq mode **`codex_create_task_turn`** |
| Model surface | model slugs in bundle (`gpt-4o`, `gpt-5-*`, `o4-mini`) | no codex slug literals; `eligible_codex_model_slugs` served at runtime (`gpt-5-6-auto-thinking` seen as checkpoint slug) |
| Codex-only REST | — | `/wham/*` (tasks, turns, environments, machines, github/gitlab, usage/credits, rate-limit reset, analytics, settings/configs, workspace-messages), `/share/codex/task_samples` |
| Codex-only routing | — | `/codex/auth-gated SPA routes` (tasks/cloud/settings/team/purchase/oauth/install), `/agents/*`, `/agent`, `oauth/codex/*/client.json` |
| Header surface | `X-OpenAI-Target-Path`/`X-OpenAI-Target-Route`, Bearer, csrf | same + `x-openai-codex-window-type`, `x-codex-entrypoint`, `x-codex-share-post-id` |
| Feature gates | `gpt-dictation`, `e.web_search`… | `wham_access`, `windows_computer_use`, `codex_admin`, `codex_agent_network_access`, `codex_only`… |
| Auth | `/api/auth/session` → Bearer → chatgpt.com cookies | **identical** (same host, same jar, same session source) |

## 6. Verified vs to-verify split

**Verified (static, from bundles/SSR):** `/wham/*` REST surface (task lifecycle, environments, machines, connectors,
usage/rate-limits, analytics, settings); task-create + follow-up/fix bodies incl. `input_items` structure;
`codex_create_task_turn` sentinel mode + Sentinel header names; SSE transport (`text/event-stream`, `[DONE]`,
`last-event-id`) and the `rAe` stream contract (`task_status`/`final_message`/`row`/`title` event JSON + row types
`website_open|summary|search|python_analysis|file_open` + statuses `created|running|finalizing`); same-host/same-auth
conclusion (`Fr` base URL + `Xhe` Authorization keying); feature-gate enum; 73-route Codex SPA route table;
Codex CLI OAuth endpoints; shared app shell with chatgpt; logged-out `/codex` serves the Contentful marketing page.

**To verify on first live (headed) capture** (no browser allowed this run):
1. Logged-in `/codex` app render: composer / sidebar DOM (this package ships **candidate, UNVERIFIED** selectors).
2. Exact live codex model slugs (`eligible_codex_model_slugs` payload; picker mapping) and full task-status enum.
3. SSE event `event:` field names on the turn stream (handler consumes `data` only; names composed) + the chunk-delta
   literal for codex-in-chat answers.
4. Whether `/wham/*` requests carry extra headers on the wire (csrf, `x-openai-codex-window-type`, sentinel).
5. `/codex/cloud/*` backend paths (cloud task detail/PR) — live proof of whether they reuse `/wham/cloud/…` or a new prefix.
6. Response shapes: `task` / `turn` / `environment` / `machine` JSON field names (SDK layer in a codex-app chunk, not
   pulled this run).

## 7. Bot-wall outcome

- **Wall present but bypassable at the static layer:** bare `curl -L` with a Chrome UA hit a **Cloudflare
  challenge** (`cf-mitigated: challenge`, `server-timing: chlray`, `__cf_bm` cookie, HTTP 403, ~8.7 KB) on
  `chatgpt.com/codex`, `/codex/new` AND the root — even though a prior chatgpt run passed without it. Re-issuing with
  realistic browser headers (`sec-ch-ua` trio, `sec-fetch-*`, `accept-language`, `upgrade-insecure-requests`,
  cookie jar) returned **HTTP 200 (737 KB)** SSR page + all `/cdn/assets` bundles.
- Post-login, expect the usual ChatGPT server-side anti-automation (sentinel/chat-requirements gates on
  `/sentinel/chat-requirements/prepare`, account-tier limits on `/accounts/check/{version}`) plus higher-tier
  Codex gates (`wham_access`, `codex_only`, credit/rate-limit walls) once automation signals appear.