# OmniRoute web-provider catalog (harvested from open-source repo, 2026-09-15)

Each entry = a chat-AI site with a documented web-session auth path. These are the
candidate capability packages for ui2api (in addition to our built-in profiles):

| provider id | auth kind | credential |
|---|---|---|
| `  "chatgpt-web": {
    kind: "cookie",
    credentialName: "Playwright storage-state JSON"` | chatgpt-web | cookie |
| `  "chatgpt-web-codex": {
    kind: "cookie",
    credentialName: "ChatGPT Cookie header (full)"` | chatgpt-web-codex | cookie |
| `  "zenmux-free": {
    kind: "cookie",
    credentialName: "Cookie header (full)"` | zenmux-free | cookie |
| `  "tencent-aistudio-web": {
    kind: "cookie",
    credentialName: "Cookie header (full)"` | tencent-aistudio-web | cookie |
| `  "tinycms-web": {
    kind: "token",
    credentialName: "app-config-uuid"` | tinycms-web | token |
| `  "grok-web": {
    kind: "cookie",
    credentialName: "sso + sso-rw"` | grok-web | cookie |
| `  "gemini-web": {
    kind: "cookie",
    credentialName: "__Secure-1PSID (optional: __Secure-1PSIDTS)"` | gemini-web | cookie |
| `  "notion-web": {
    kind: "cookie",
    credentialName: "token_v2 (optional: space_id, notion_browser_id)"` | notion-web | cookie |
| `  "gemini-business": {
    kind: "cookie",
    credentialName: "__Secure-1PSID (optional: __Secure-1PSIDTS)"` | gemini-business | cookie |
| `  "perplexity-web": {
    kind: "cookie",
    credentialName: "__Secure-next-auth.session-token"` | perplexity-web | cookie |
| `  "blackbox-web": {
    kind: "cookie",
    credentialName: "__Secure-authjs.session-token"` | blackbox-web | cookie |
| `  "claude-web": {
    kind: "cookie",
    credentialName: "sessionKey"` | claude-web | cookie |
| `  "deepseek-web": {
    kind: "token",
    credentialName: "userToken"` | deepseek-web | token |
| `  "copilot-web": {
    kind: "token",
    credentialName: "access_token"` | copilot-web | token |
| `  "copilot-m365-web": {
    kind: "token",
    credentialName: "access_token + chathubPath"` | copilot-m365-web | token |
| `  "t3-web": {
    kind: "cookie",
    credentialName: "convex-session-id + Cookie header"` | t3-web | cookie |
| `  "adapta-web": {
    kind: "cookie",
    credentialName: "__client"` | adapta-web | cookie |
| `  "inner-ai": {
    kind: "cookie",
    credentialName: "token + email"` | inner-ai | cookie |
| `  "yuanbao-web": {
    kind: "cookie",
    credentialName: "full Cookie header (hy_user + hy_token)"` | yuanbao-web | cookie |
| `  "poe-web": {
    kind: "cookie",
    credentialName: "p-b"` | poe-web | cookie |
| `  "venice-web": {
    kind: "cookie",
    credentialName: "session"` | venice-web | cookie |
| `  "v0-vercel-web": {
    kind: "cookie",
    credentialName: "__vercel_session"` | v0-vercel-web | cookie |
| `  "kimi-web": {
    kind: "token",
    credentialName: "access_token"` | kimi-web | token |
| `  "doubao-web": {
    kind: "cookie",
    credentialName: "full Cookie header (sessionid + ttwid + s_v_web_id)"` | doubao-web | cookie |
| `  "duckduckgo-web": {
    kind: "cookie",
    credentialName: "duckai"` | duckduckgo-web | cookie |
| `  "t3-chat-web": {
    kind: "token",
    credentialName: "token"` | t3-chat-web | token |
| `  "chatglm-web": {
    kind: "cookie",
    credentialName: "chatglm_session"` | chatglm-web | cookie |
| `  "xiaomimimo-web": {
    kind: "cookie",
    credentialName: "session"` | xiaomimimo-web | cookie |
| `  "manus-web": {
    kind: "cookie",
    credentialName: "manus_session"` | manus-web | cookie |
| `  "conol-web": {
    kind: "cookie",
    credentialName: "__Secure-better-auth.session_token"` | conol-web | cookie |

Source: diegosouzapw/OmniRoute `src/shared/providers/webSessionCredentials.ts`.
