# Notion AI capabilities (from JS bundle analysis, 2026-09-16)

Analyzed ~30 JS bundles under `/_assets/` (plus `nt.html`/`nt-login.html` app shells) from `https://www.notion.so` (homepage title: "The AI workspace that works for you. | Notion"). Transport: **same-origin eventName RPC** — the app routes AI calls through a dynamic client (webpack-module `773163`, exports `qU` = query / `G2` = transaction) that builds `POST /api/v3/<EventName>`. No WebSocket / EventSource / `text/event-stream` literal was found in any downloaded bundle (streaming transport UNVERIFIED; `ReadableStream` + `getReader()` ARE present). Core app bundle: `nt-app-26c0114797c87e7f.js` (rolldown/webpack-style monolith, dynamic chunk loader `a.e(<numericId>)`).

## 1. Chat / AI Q&A (core surface)
- Routes: `/ai` (route map incl. `/ai`, `/ai-command-center{/:subtab}`, `/login/ai`, `/signup/ai`, `/chat`, `/meet`, `/library`, `/agents/new`).
- `/ai` route handler state: `experienceId` (from query `exp`), `targetConfig` (types: `["search","researcher","markdown-chat","workflow"]`), `spaceId`, `origin`, `initialAgentActions` (with `injectSearchTool`), `defaultUserMessage`, `promptFill`, `promptCategory`.
- At-mention / thread query params: `chatThreadId` (`t` / `ct`), `agentChatThreadId` (`at`), workflow params `wfv`, `wfa`, `wfk`, prefill `q`/`aq` (`assistantQueryPrefill` / `promptFill`).
- "Make" prompt categories (module `806127` list `S`): `visualize`, `create_slides`, `spreadsheet`, `deep_research`, `schedule_tasks` — filterable by `promptCategory`.
- Model + reasoning config (pmb_setup / qna_setup experiences): literal `model:"orange-mousse"`, `reasoningEffort:"high"`.
- UI components: `AIChat`, `AIChatStore`, `AIChatActions`, `AiBlock`, `AIEphemeralView`, `AIGoogleDriveQna`, `AiLandingPage`; page-type values `"chat" | "notion_ai" | "library"`.
- Analytics events: `ai_chat`, `ai_qna`, `ai_chat_ephemeral_*`, `ai_writer`, `db_agent`, `tryAI`.

## 2. In-page AI & commands
- AI settings tab ids (module `660023` array `i`): `qna`, `ai_writer`, `db_agent`, `create_form`, `tryAI`, `upgrade_requests`, `ai`, `aigeneral`, `aiusage`, `aiconnectors*`, `aicustomagents`, `aimeetingnotes` — the per-feature toggles behind `/settings` AI panel.
- `ai_writer` = inline page AI commands (Improve writing, Summarize, etc. — flag literal only; exact command list NOT in static bundles, TO-VERIFY); `db_agent` = database agent prompt; `create_form` = AI form builder.
- Notion AI Q&A (the `/ai` search home) runs the same Q&A model with full-workspace source search.

## 3. QnA connectors / ingestions
Flag map (connector → QnA ingestion/connector literal in bundle): google-drive → `google_drive_qna_ingestion`, jira → `jira_qna_ingestion_v2`, github → `github_qna`, gmail → `gmail_ai_connector`, microsoft-teams → `microsoft_teams_qna`, sharepoint → `sharepoint_qna`, salesforce → `salesforce_qna`, linear → `linear_ai_connector`, outlook → `outlook_ai_connector`, notion-mail → `notion_mail_connector`, google-calendar → `google_calendar_ai_connector`, notion-calendar → `notion_calendar_ai_connector`, asana → `asana_qna`, box → `box_qna`, confluence → `confluence_qna`. Managed under `aicustomagents` / `aiconnectors*` settings tabs.

## 4. Auth & session facts for automation
- API base: `api:{http:"/api/v3"}` (module `nt-96265`). Route parser guard (module `806127`) bypasses page routing for paths starting `/api/v3/`, `/signed/`, `/image/`, `/internal/mail/render/`, `/getStatus`.
- Literal endpoints (single-quoted in bundles): `/api/v3/authValidate`, `/api/v3/getSkilljarProfile` (`nt-47654`), `/api/v3/contentPreview`, `/api/v3/queryCollectionHTML` (`nt-contentPreview-*`). The chat/Q&A request method is reconstructed dynamically by the eventName RPC client — NOT available as a literal.
- Cookie read via `getCookieWithoutPermissionCheck`. Cookie literals (class map, `token_v2:"necessary"`): `token_v2`, `notion_user_id`, `notion_users`, `notion_public_domain_user_id`, `notion_browser_id`, `notion_ghost_admin_user_id`, `csrf`, `file_token`, plus consent/experiment cookies `notion_cookie_consent`, `notion_check_cookie_consent`, `notion_experiment_device_id`.
- provider-catalog: `notion-web` kind=`cookie`, credentialName `"token_v2 (optional: space_id, notion_browser_id)"`.
- Prefetch for paid-workspace loader via `prefetchMultiCellHttpRequest` / `prefetchHttpRequest` (fanout `getSpacesFanout`); eventName RPC literals observed: `getAppConfig`, `getSpaces`, `getSpacesInitial`, `getUserSharedPagesInSpace`, `queryCollection`, `queryCollectionHTML`.
- No bot wall on anonymous probe (plain `curl` with Chrome UA → HTTP 200 on `https://www.notion.so` and `/login`).

## 5. API / transport notes (what to verify on first live capture)
- RPC body contract is NOT statically legible: `qU`/`G2` take `{connection, sql, args}` (debug console) / `{connection, statements}` (debug transaction) — the public request envelope is built from dynamic modules loaded by chunk id (e.g. loader hash `d.j="71889"`).
- Streaming/polling mechanism unconfirmed (no SSE/WebSocket literal; `ReadableStream` present). Capture once headed: record exact request URL, method, headers (cookie/Token vs Bearer), and response shape for `/api/v3/<chatMethod>` and `/api/v3/queryCollection*`; then pin the answer/reply selectors (below).
- getAnswer / enrichedAIGenerate / chatAnswer family is NOT present in any downloadable bundle — treat as dynamic-chunk-only, do not fabricate an endpoint.

## 6. Suggested ui2api capability list (id, one-line description)
1. `notion_chat` — Send a prompt in the Notion AI composer (`/ai` or in-page Notion AI); answer renders in the chat thread. **UI-path VERIFIED** (route + flags + model literal); wire shape/selectors TO-VERIFY on first capture.
2. `notion_qna` — Workspace Q&A search on `/ai` across connected sources (Q&A model `orange-mousse`). Route/flags grounded; request shape TO-VERIFY.
3. `notion_ai_commands` — In-page AI commands (Improve writing / Summarize, `ai_writer` tab). Flag grounded; command list TO-VERIFY.
4. `notion_ai_search` — AI web-search tool mode (`injectSearchTool`, `targetConfig` types incl. `search`, `promptCategory=deep_research`). Flags grounded; live walk TO-VERIFY.
5. `notion_ai_connectors` — Manage QnA source ingestions (connector→ingestion map above) from `aicustomagents`/`aiconnectors*`. Flag map grounded; UI/settings shapes TO-VERIFY.

(Not exposed: identity, payments/billing, admin — present only as auth-adjacent cookies and `/internal/*` routes; no dedicated RPC literals recovered.)