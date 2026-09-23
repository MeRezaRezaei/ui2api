# Gemini capabilities (from JS bundle analysis, 2026-09-15)

> ## Status (2026-09-22): VERIFIED — works live, VAULT-driven, **DO NOT re-capture**
>
> Live verified + re-verified through `/v1/chat/completions` and one-shot
> ChatDriver (PONG, stable reads; `/v1/chat/completions` model=gemini OK) —
> driven by the vault account (`data/sessions/gemini.google.com/<slug>/state.json`).
> Per AGENTS.md: gemini was verified earlier; **do not re-capture**. The §0
> signed-out compact-ID decode below is a 2026-09-15 probe snapshot, NOT the
> product state — the only unresolved item is conversation-CRUD compact-ID
> pinning (create/rename/delete), which was not pinnable on the probe's
> signed-out SSR leaf and remains unpinned via the vault (v1 full paths listed
> at §0).

Bundles analyzed (fetched read-only with curl, no login/execution):
- `gemini-home.html` (840 KB; `WIZ_global_data`, `bard-initial-data`, `_F_toggles_default_BardChatUi`)
- `main.js` = `boq-bard-web.BardChatUi` base/bootstrap (115 KB; `m=_b`)
- `mod_bYMqif.js` (902 KB) — core RPC proto/wire layer + API clients
- `mod_LQaXg.js` (2.9 MB) — Wiz/Angular shell, feature logic, RPC descriptors
Server build: `boq_assistant-bard-web-server_20260914.08_p0` (`WIZ_global_data.cfb2h`).

All core app RPCs go through one batch endpoint, derived in code as
`_.bwa = () => \`${_.pd("eptZe")}data/batchexecute\`` where `eptZe = "/_/BardChatUi/"` →
**`POST /_/BardChatUi/data/batchexecute`** (transport `Zva`; params `f.req`, `f.sid`, `_reqid`;
header `X-Framework-Xsrf-Token`). RPCs are declared as descriptors
(`_.tB` unary / `_.SPc` server-streaming) whose 4th tuple is
`[_.cg /*frontendMethodType*/, <idempotent>, _.eg /*unobfuscatedRpcId*/, "/BardFrontendService.<Method>"]`,
plus a numeric "extension" id (`_.pna`) in the wire payload.

## 0. Live compact-ID decode (2026-09-15; replayed the UI's own bootstrap payloads on a headed Chrome + snapshot)

| compact id | method / role (verified live) | payload → response |
|---|---|---|
| `aPya6c` | ListConversations | `[]` → `[hasMore,totalCount,[convs]]` |
| `otAQ7b` | bootstrap/config catalog | `[]` → models catalog + grounding "sources" entries: **Search=1**, Gmail=3, Drive=4, Chat=12, plus `Flash3p6PaidV2Rollout` flag |
| `K4WWud` | client location lookup | `[[0],["en-US"]]` → `[city, consent label, false, null, maps/vt tile url]` (IP-derived) |
| `ozz5Z` | per-entitlement status check | `[[[null,"1",<id>],null,1],…]` → echoes rows, trailing `1→0` = not entitled (ids 447,448,702,961,960,1062,1240,1237,1238,1239,1241) |
| `o30O0e` | person profile request | `[["me"],[[["person.photo","person.name","person.email"]],null,[1,7]]]` → `null` in non-personalized sessions |
| `L5adhe` | popup/notification state upsert | `[<104+ null flags>, [[current_popup_id|popup_zs_visits_cooldown|last_selected_mode_id_on_web]]]` → `null` (void) |
| `sJBwce` | session/telemetry write | `[[1,2]]` → `null`+`[3]` (void) |
| `GPRiHf` / `maGuAc` (`[1]`,`[2]`) / `CNgdBe` (`[1|2,["en-US"],0]`) / `I4z33b` | state/pref writes | → `null`+`[7]` (void) |
| `cYRIkd` (`["en-US"]`) / `whPPme` (`["en-US",null,[4]]`) / `ku4Jyf` | read-style RPCs | → `[]` |
| `Te6DCf` | discovery/landing content | `[["en-US"],[1,2]]` → ~18 KB featured cards |
| `GPRiHf` empty | — | `null` + `[7]` |

Void RPCs carry no data-bearing payload; none merit their own capability. Conversation
CRUD compact IDs (create/rename/delete) were **not** pinnable live: New-chat fires no
batchexecute (conversation created lazily on first `StreamGenerate`), and the snapshot
account renders a signed-out SSR leaf with 0 conversations (rename/delete not
exercisable). **Status (2026-09-22): unchanged — CRUD compact IDs stay
unpinned; use the existing VAULT account (do NOT re-capture, AGENTS red line)
+ a row-kebab walk on its real conversation list to pin them; v1 full paths are
`CreateConversation / MutateConversation / UpdateChat / DeleteConversation /
BranchConversation / UpdateConversation / ListConversationTurns / GetConversationTurn`.

## 1. Chat core (baseline)
- Send path: composer → `StreamGenerate` (`"/BardFrontendService.StreamGenerate"`,
  descriptor `$Dd = new _.SPc("RxAFq",_.Fzc,_.tL,…)`, `server_streaming`).
- Request proto `_.Fzc`: `ka()`→`_.nzc` field 8 (repeated client caps 11,12); text `ha()` field 20;
  body `oa()`→`Ezc` field 45 (picker items `lzc` field 1, labeled text `_.Dzc` field 2);
  trailing `wa()`→`Bzc` field 42.
- Response: streamed proto `_.tL` (field 11 `Kp` id, field 31 client caps, field 68 typed chunk).
  Heartbeat via `_.yzc` field 37 (mask `nF=[11,21,23,28,37,49,51]`).
- Stop: `"/BardFrontendService.AbortGeneration"` (regenerate = re-send on new turn).
- Autosave/state: `ConversationProcessors(Ref)`, `ConversationsNgrxFeatureEnv`,
  `ConversationStateValidatorService`; turn lifecycle `"/BardFrontendService.MarkLastConversationTurn"`.
- v1 names still routed/recognized (`bAc` set): `CreateConversation CreateProject
  EnableWorkspaceEeccSettingAction GenerateAnswer ListConversations MutateConversation UpdateChat`.

## 2. Search mode / Google AI search integration
- UI trigger: composer Search toggle + mode-picker items (`lzc`/`_.kzc` id/title/type/icon);
  enum strings `"SEARCH"`, `"SEARCH_IMAGES"`, `MODE_CATEGORY_*` (§3.1).
- **Measured 2026-09-23 (GOAL 15, honest for `gemini_search_toggle`)**: replaying ALL
  stored gemini sources (vault `osbulk`, vault `merezarezaei@gmail.com`, legacy
  `data/gemini.google.com/.session`) renders **SIGNED-OUT** — Google auth cookies are
  browser-bound/app-bound (same phenomenon as youtube posting). In the signed-out
  surface of this UI revision there is NO Search/Web-access toggle: composer toolbar =
  "Upload & tools" + mode picker + "Dictate"; the tools panel lists upload/create
  entries then "Sign in to try tools" (no sources/extensions list); the mode picker
  shows only 3.5 Flash-Lite / 3.6 Flash / 3.1 Pro. Google-Search grounding is a
  SIGNED-IN composer sources/extensions entry (`otAQ7b`: Search=1, Gmail=3, Drive=4,
  Chat=12) exposed as a `menuitemcheckbox` that rides the StreamGenerate tools field —
  so the capability returns the measured blocker (ok:false) and needs the user's own
  signed-in Chrome (`UI2API_ATTACH_PORT`), like tencent-aistudio / youtube posting.
- Backbone = GLIC (grounded-link) service: `Pwc(a,b)` builds
  `https://gemini.google.com/glic/continue` with `cid`=conversationId, `turnId`, `query`,
  `send`, `suggestedQueries`(`b.bjg`); also route `/glic/intro`.
  State keys `glic_reload_circuit_breaker_timestamps`, `glicRequestSentThisWeekCount/Timestamp`,
  `captureRegion*` (region-capture → image search); quota gated weekly.
  Telemetry `/client_streamz/bard_chat_ui/glic/completed_prompt_count|failed_prompt_count`.
- The grounded answer itself streams back through `StreamGenerate`; results render as a normal
  turn with quoted-source cards. Deep-research variant gated by `DEEP_RESEARCH` (→ §3.4).
- Corp-only search hosts present: `search-latest.corp.google.com/search`, `gws-prod.corp.google.com`.

## 3. Additional capabilities (one H3 per capability)
### 3.1. Mode / model selection
- Mode enum: `MODE_CATEGORY_AUTO|CLASSIC|ADVANCED|PRO|THINKING|FAST|FAST_DYNAMIC_THINKING|FLASH_LITE|FLASH_PLUS|UNSPECIFIED`; thinking levels `THINKING_LEVEL_STANDARD|EXTENDED|DEEP_THINK`; UI `deep_think`/"deepthink" v2, "Thinking with 3 Pro".
- Model ids (strings): `gemini-2.0-flash`, `gemini-2.5-flash`, `gemini-2.5-flash-preview-04-17|-05-20|-09-2025|-tts`, `gemini-3-flash-preview`, image `gemini-2.5-flash-image(-preview)`, `gemini-3.1-flash-image(-preview)`, `gemini-3-pro-image(-preview-11-2025)`.
- Brand flags (`_.Iq`): `45740022="Gemini 2.5"`, `45738845="Gemini 2.5 Pro"`, `45693722="Libra"`, `45728348` 3.0 enable; "Gemini 3 Pro".
- Pick logic `pMc` over hex ids `1bc6b5d98741cd3d / 1a43ad63cc8a7f9a / a74ec8485b3b5ce4 / 9d8ca3786ebdfbea / e6fa609c3fa255c0 / 797f3d0293f288ad`, flagged by `_.nMc 45738508`, `_.aMc 45737518`, `_.dMc 45737517`, `_.bMc 45732476`; sent inside the StreamGenerate picker-item proto (no separate ListModels RPC).
### 3.2. Image generation & editing (Nano Banana / imagegen)
- Brand names "Nano Banana 2"/"Nano Banana Pro"; flags `enable_mm_gen`/`disable_mm_gen`,
  `mm_gen_disclaimer_version`, `BESPOKE_IMAGES`, `CODE_GENERATED_IMAGES`, `IMAGE_EDIT` (DiscoveryFeature=28), `STORYBOOK`(18), `has_seen_bespoke_tooltip`, `has_seen_redo_with_gempix2_tooltip` (`gempix`=edit).
- Backend "Remy": `CreateRemySchedule`, `List|SearchRemyGoals`, `UpdateRemyGoal`, `DeleteRemyGoal`,
  `ListRecommendedRemy*`; `RemyPermissionsApi`, `RemyScottyUploaderToken`, `RemyUploaderConfigToken`,
  `RemyAuthServiceToken`; "Load Remy goals" logs `_.Rdc…_.Udc`.
- Image upload: `https://content-push.googleapis.com/upload/`, headers `Push-ID:<feed>`,
  `X-Tenant-Id:"agent_skills"`, `X-Client-Pctx` (resumable `_.cSc`).
- Download: `"/BardFrontendService.DownloadGeneratedImage"`; Fife accessor `fetchFifeImageBlobUsingAlr`.
- Upsell id `IMAGE_GENERATION_LIMITS_UPSELL`=1238.
### 3.3. Video / music / likeness generation
- DiscoveryFeature ids: `VIDEO_GENERATION`=19, `MUSIC_GENERATION`=27, `LIKENESS`=26,
  `COMPUTER_USE`=20, `YT_VIDEO_UNDERSTANDING`=14.
- Ref ids: `"/BardFrontendService.ExportVideoToYouTube"`, `GetLikenessProgress`,
  `VIDEO_GENERATION_LIMITS_UPSELL`, `has_seen_video_generation_discovery_banner`,
  `has_seen_likeness_*`, `VEO_UPSELL`=1062, `MUSIC_GENERATION_LIMITS_UPSELL`=1239.
- TTS voice preview model `gemini-2.5-flash-preview-tts`.
### 3.4. Deep Research
- `DEEP_RESEARCH`,`DEEP_RESEARCH_IMMERSIVE`,`DEEP_RESEARCH_LIMITS_UPSELL`
  (DiscoveryFeature=2); category chips `RESEARCH_BUSINESS|EVENTS|FINANCE|GROWTH|HEALTH|LEARNING|LIFESTYLE|LOCAL|MARKET|SCIENCE_TECHNOLOGY|SHOPPING|TRAVEL`.
- Gating/disclaimers: `"bard_deep_research_visual_report_enabled"`,
  `deep_research_model_update_disclaimer_display_count`, `deep_research_has_seen_file_upload_tooltip`; accepts file uploads; runs via `StreamGenerate` mode item; report panel = `DEEP_RESEARCH_IMMERSIVE`.
### 3.5. Files / attachments / upload
- Standard attach upload: `https://push.clients6.google.com/upload/` (from `h1eoVe`) headers
  `Push-ID: feeds/mcudyrk2a4khkz` (`qKIAYe`), `X-Tenant-Id:"bard-storage"`,
  `X-Client-Pctx: CgcSBWjK7pYx` (`Ylro7b`); resumable `_.cSc`, chunked with `_.HRc`.
- Kinds: `UPLOADED_FILES|IMAGES|VIDEOS|UPLOADED_FILE`; status
  `UPLOAD_STATUS_UNKNOWN|IN_PROGRESS|SUCCESS|ERROR`; errors `FILE_UPLOAD_FAILURE`,
  `IMAGE|VIDEO|FILE_UPLOADS_RESTRICTED`. Drive picker `docs.google.com/picker`;
  type icon `drive-thirdparty.googleusercontent.com/64/type/application/vnd.google-apps.{file,unknown}`.
- `combined_files_button_tag_seen_count`, `FILE_IMMERSIVE`, `GetScreenshotData`, `ProcessFile` (video/frame understanding), `has_seen_first_youtube_video_disclaimer`.
### 3.6. Skills, Extensions (MCP), Workspace tools
- Skill RPCs: `CreateManagedSkill`, `GetManagedSkill(ByDriveId)`, `ListManagedSkills`,
  `UpdateManagedSkill`, `SetManagedSkillEnabled`, `DeleteManagedSkill`,
  `Add|ListRecommendedSkills`, `CreateOrUpdateSkill`, `Add/Update/RemoveSkillLicense`,
  `GetAllToolConsentData`, `UpdateToolPermission`, `GetMentionableTools`, `RevokePermission`.
- MCP apps: `CustomMcpToolsApi/Service`, `"/ListCustomMcpServers"`; agents `Drive_mcp_agent`,
  `Gmail_mcp_agent`, `People_mcp_agent`(Contacts), Evernote; streamz
  `/client_streamz/bard_chat_ui/mcp_app/loading_latency|load_status_count`.
- Workspace side: `CREATE_WEB_PAGE`(17), `"EMAIL_IMMERSIVE"`,`"DOC_IMMERSIVE"`,
  `CreateProjectSource|ListProjectSources|DeleteProjectSource`,
  `CreateNotebookSource|DeleteNotebookSource`, `ListImports`, `GetIframeContent`.
### 3.7. Gems (custom bots)
- RPCs: `CreateBot`, `GetBot`, `ListBots`, `DeleteBot`, `UpdateBotMetadata`, `RecordBotUsage`,
  `GetBotAcl` (shared Gems); `BotsApi`; Drive sharing (`DriveShareAvailabilityService`,
  `disable_bot_shared_in_drive_disclaimer`). Error `"Bot not found"` → `BardAnswerService.GenerateAnswer`.
### 3.8. Artifacts / Canvas / Immersives
- RPCs: `CreateArtifactVersion`, `ListArtifactVersions`, `BatchGetLatestArtifactVersions`,
  `GetArtifactVersion`, `UpdateCurrentArtifact`, `NavigateToNext|PreviousArtifactVersion`,
  `GetConversationIdForImmersive`, `AssociateImmersiveMetadata`.
- DiscoveryFeature ids: `CODE_IMMERSIVE`, `DATA_VISUALIZATION_IMMERSIVE`, `DOC_IMMERSIVE`,
  `EMAIL_IMMERSIVE`, `EDIT_IMAGE_IMMERSIVE`, `FILE_IMMERSIVE`, `PRODUCT_BROWSE_IMMERSIVE`,
  `WEBSITE_BRANDING_IMMERSIVE`, `AGENTIC_BUNDLE_IMMERSIVE`, `AUTOMATION_PLAN_IMMERSIVE`.
- "Create your…": `CREATE_TIMELINE|MIND_MAP|DATA_DASHBOARD|PRESENTATION|FLASH_CARDS|QUIZ|INFOGRAPHIC|WEB_PAGE|STORYBOOK`; `canvas_create_discovery_tooltip_seen_count`; `deep_zoom` artifact mode.
### 3.9. Conversation management / history / memory
- RPCs: `ListConversations`, `ListConversationTurns`, `GetConversationTurn`, `SearchConversations`,
  `DeleteConversation`, `BranchConversation`, `UpdateConversation`, `CreateSharedConversation`,
  `MarkLastConversationTurn`, `GetDiscoveryContent`, `ApplyUserActionOnDiscoveryCard`,
  `BatchGetGalleryModules`, `GetSideNavConfig`, `ListPinnedItems`, `GetUsageInfo`.
- LLM history import: `ListImports`, `disable_llm_history_import_disclaimer`,
  `has_seen_llm_history_import_page`, `is_imported_chats_panel_open_by_default`.
- Memory retrieval: `"/BardFrontendService.RetrieveMemories"`.
- Live decode: `aPya6c` = ListConversations is the only conversation RPC pinned to a
  compact id; CRUD compact ids un-pinnable in the current signed-out SSR session (see §0).
### 3.10. Your Day / scheduled briefs / proactive
- `GenerateDailyBrief`, `GetDailyBrief`, goal CRON-style RPCs; `SCHEDULED_PROMPTS`(4),
  `PROACTIVE_SCHEDULING`(15)/`_SUGGESTION`(21); keys `opt_out_your_day`,
  `opt_out_your_day_push_notifications`.
### 3.11. Sharing / pinned / immersion share
- RPCs: `CreateSharedConversation`, `GetSharedConversation`, `GetDriveSharedConversation`,
  `GetDriveSharedConversationForAbuseReview`; `ShareApi`; share page `gemini.google.com/sharing`;
  landing param `fromShareLandingPageId` → `buildVeMetadataFromShareLandingPageId`;
  `last_dismissed_immersive_share_disclaimer_sec`.
### 3.12. Personalization / health / merchant data
- `GetUserStatus`, `ReadUserProfile`, `ReadUserPreferences`, `UpdateUserPreferences`,
  `CheckGeminiQuota`, `CheckQuota`, `CheckGxuBudget`, `CheckModeFeatureQuota`.
- Personalization: `personal_intelligence_onboarded`, `require_reconsent_setting_for_personalization`,
  `personalization_one_p_*`, `has_accepted_agent_mode_fre_disclaimer`.
- Health: `"/ConnectToHealthAccount"`; accountlink base `healthapp.google.com/connections/accountlinking`; `WELLNESS_COACH`.
- Merchant: `"/FetchGoogleBusinessProfiles"`, `"/IsMerchant"`, `MerchantStatusApi`.
### 3.13. Projects / Workspace upgrade knobs
- `CreateProject`, `EnableWorkspaceEeccSettingAction`, `EnableUserWorkspaceEeccSetting`,
  `ClientDonateWorkspaceData`, `GetAdvancedZsUpsell`, `ListContainers`, `GEMINI_ENTERPRISE`,
  `ListUserOwnedCalendars`, `ShareCalendar`; upsell pages `one.google.com/explore-plan/gemini-advanced`.

## 4. Session & auth facts relevant to automation
- Cookie names read by code: `SAPISID`/`__Secure-3PAPISID` (→ `Authorization: SAPISIDHASH <ts>_<hash>`),
  `APISID` (→ `APISIDHASH`), `__1PSAPISID`, `__3PSAPISID`, `SID`; build serves `N1U0/Mr43xd`
  consent/session blobs (`CAIS…`).
- Batch endpoint `/_/BardChatUi/data/batchexecute`; upload endpoints
  `push.clients6.google.com/upload/` and `content-push.googleapis.com/upload/`; agent control-plane
  `waa-pa.clients6.google.com/$rpc/google.internal.waa.v1.Waa/{Create,Ping}`.
- LocalStorage capability/pref keys: `Bard-Color-Theme`, `BARD_EMBED_CHAT_STORAGE_KEY(_V2)`,
  `WEB_EMBEDDED_CHROME_CAPABILITIES_STORAGE`, `has_redirected_to_ge`,
  `glic_reload_circuit_breaker_timestamps`, `GqGm3b` (SSR-nav state) plus ~150 prefs (§3; e.g.
  `show_debug_info`, `enable_mm_gen`, `enforce_default_to_fast_version`, `opt_out_your_day`).
- Wire tokens: `X-Framework-Xsrf-Token`, `X-Client-Pctx=CgcSBWjK7pYx`, `Push-ID` feed
  `feeds/mcudyrk2a4khkz`; WIZ_global_data API keys `VVlN6d d2zJAe hKBnje i1PRRd nPMdNb ypY7lb`;
  `thykhd`/`PI9WOb` proto blobs.

## 5. Stealth-relevant observations
- Request id scheme `Yva` = hh*3600+mm*60+ss + counter*1E5, delivery mode `"BEST_EFFORT"`;
  retry wrapper `kwa`/`Rta`, error parse regexes `Qsa/Rsa/Ssa`, special `700+`/`6xx` codes.
- XSSI guard: batch responses peeled by `_.cYa` → `b(\`[${a.substring(4)}\`)` (strips `)]}'`);
  XSSI-protected JSON batches, `Incomplete XSS header` handled.
- Anti-bot: bundled copy `'your computer or network may be sending automated queries'`
  (429 page). Stream fallback: on error code `152` the client re-issues via raw `fetch`
  (`dGd`) with `AbortController` — a second, lighter transport to replicate.
- Framework caps sent in `_.nzc` fields 11/12 (client capability list per request) — expected
  by the model; mismatch may alter behavior.
- `GqGm3b!=="false"` adds `ssr-nav-open` body class; feature flags are server-driven numeric
  experiment ids (`_.Eq|Iq|Fq|Jq`) — no client-side enabling: gate on server response, not
  localStorage. `disable_new_conversation_dialog`, `disable_temp_chat_soft_badge` are UI-only.

## 6. Suggested capability list for ui2api (id, one-line description)
| id | description |
|----|-------------|
| `gemini_chat_stream` | Send prompt via `StreamGenerate` and stream `_.tL` response chunks (heartbeat-aware). |
| `gemini_abort_regenerate` | `AbortGeneration` + turn-based regenerate/undo of last assistant turn. |
| `gemini_search_toggle` | Set Search/GLIC mode item in request → grounded answer with Google AI Search cards. **Status 2026-09-23:** signed-in-only sources entry (`otAQ7b` Search=1); all stored gemini sources replay SIGNED-OUT (browser-bound Google auth) → runner returns measured honest blocker; toggle from the user's own signed-in Chrome. |
| `gemini_conversation_crud` | `ListConversations`, `ListConversationTurns`, `GetConversationTurn`, `BranchConversation`, `DeleteConversation`, `SearchConversations`. |
| `gemini_upload_attach` | Resumable upload to `push.clients6.google.com/upload/` (bard-storage tenant) + attach into `StreamGenerate`. |
| `gemini_model_picker` | Enumerate hex model ids (flash/pro/image `gemini-3-*`) and set picker item + thinking level in request. |
| `gemini_deep_research` | Trigger `DEEP_RESEARCH` mode item (optionally with file upload) → immersive report. |
| `gemini_image_gen` | Image generation/edit via Remy (`CreateRemySchedule`), `Nano Banana` models, image upload to content-push, `DownloadGeneratedImage`. |
| `gemini_video_gen` | Video generation (Veo) + `ExportVideoToYouTube`; likeness (`GetLikenessProgress`) polling. |
| `gemini_gems_crud` | `CreateBot/GetBot/ListBots/UpdateBotMetadata/DeleteBot` (Gems) incl. shared Gems acl. |
| `gemini_share_public` | `CreateSharedConversation`/`GetSharedConversation` → public link + read back. |
| `gemini_memory` | `RetrieveMemories` for personalized answers (requires consent flag). |
| `gemini_artifacts` | `CreateArtifactVersion`/`UpdateCurrentArtifact` + canvas/immersive panels (code, data viz, web page). |
| `gemini_mcp_skills` | `ListCustomMcpServers`/`CreateManagedSkill` / enable Drive-Gmail-People MCP extensions for the turn. |
| `gemini_daily_brief` | `GenerateDailyBrief`/`GetDailyBrief` scheduled-proactive chat (Your Day). |