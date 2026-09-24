import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { usingUserChrome } from "../runtime/browser.js";

// --- Chat-site profiles: declarative "recipes" describing how to drive the web
// chat UI of an AI site (composer behavior, answer container selectors, send
// strategy) so the SAME ChatDriver/plugin code works across Gemini, ChatGPT,
// Claude, Copilot, Perplexity and HuggingChat — without per-site code.
//
// Selectors are best-effort snapshots of each site's current web UI; they rot,
// and when they do you re-tune them in a JSON override file (--profile FILE or
// UI2API_AI_PROFILE) instead of editing code. The flow itself stays identical:
// paste the prompt + Enter (the site's OWN JS runs), then read the streamed
// answer off the page.

export interface SendStrategy {
  kind: "keyEnter" | "click";
  selector?: string; // required when kind === "click"
}

export interface ChatSiteProfile {
  id: string;
  name: string;
  url: string;
  loginRequired: boolean;
  loginHint?: string;
  composer: string[];
  send: SendStrategy;
  answer: string[];
  newChat?: string;
  // Optional JS-function-indexed entry point (verbatim 2026-09-20T10:01):
  // when the analyzer captured a real window.<root>.<method> for this site, a
  // profile can carry it so a capability runner can call the site's own
  // function instead of (or before) driving the DOM — see src/runtime/js-exec.ts
  // + docs/ENGINE.md "JS-function-indexed execution". Only set when a live
  // capture proved the function callable; never invented.
  jsIndex?: { root: string; method: string; args?: unknown[] };
  // Best-effort buttons to click away before composing (consent / promo
  // overlays on anonymous sites). Failures are swallowed.
  dismiss?: string[];
  captureMs: number;
  stableMs: number;
  note?: string;
  // Cold-boot protection for slow SPAs (e.g. Tencent "Hy AI Studio"): the
  // composer is visible long before the app finished booting, and an Enter
  // pressed during boot is silently dropped. When set, the driver waits
  // `preComposeDelayMs` (+ a random jitter up to 600ms — human-dwell-plausible)
  // after the composer becomes visible and before composing.
  preComposeDelayMs?: number;
  // First-send consent wall on anonymous sites (e.g. duck.ai: the very first
  // send is intercepted by the site's own "By clicking 'Continue' you agree to
  // our Privacy Policy and Terms of Service" overlay — which must be answered
  // by the SAME code path a human uses). When set, the driver sends once, waits
  // `waitMs` for the overlay, clicks `accept` (the site's own button), waits
  // `settleMs`, then re-presses send on the still-filled composer. The wall's
  // own JS does the real dispatch; this only acknowledges the site's prompt.
  consentWall?: { accept: string; waitMs?: number; settleMs?: number };
  // Real-profile-only sites: their anti-bot (e.g. Tencent Cloud EdgeOne on
  // aistudio.tencent.ai) serves "Access Restricted" to ephemeral snapshot
  // contexts even with valid auth cookies. When true the driver uses the
  // browser's DEFAULT context (real logged-in profile — UI2API_USER_DATA_DIR
  // / attach) instead of a fresh injected context. Snapshot injection is
  // skipped so the site sees an identical, fingerprint-consistent session.
  realProfileOnly?: boolean;
  // Query-driven "capability" sites (e.g. Google AI Mode): instead of typing
  // into a composer, each prompt is ONE page load of `urlTemplate` with {q}
  // replaced by the URL-encoded prompt. `url` stays the warm-pool landing
  // page. There is no composer flow for these — the site's own JS renders the
  // answer (and citations) into the loaded page.
  urlTemplate?: string;
  // Selector(s) for the citations/sources block inside the answer (read as
  // link hrefs + text). Optional; only meaningful with urlTemplate.
  citations?: string[];
  // Capability reflection (see src/runtime/capability-probe.ts): how to learn
  // what THIS account can do on the site — tier badge, model picker, and the
  // restriction markers to watch for during prompts. Selectors rot like the
  // composer ones; patterns are case-insensitive substring matches.
  capability?: {
    tierSelectors?: string[];
    pickerOpen?: string[];
    pickerOption?: string[];
    restrictionMarkers?: Array<{ kind: string; patterns: string[] }>;
    abilityToggles?: Array<{
      id: string;
      selector: string;
      label: string;
      selectedClass?: string;
    }>;
  };
}

export interface BuiltinProfiles {
  [id: string]: ChatSiteProfile;
}

export const BUILTIN_PROFILES: BuiltinProfiles = {
  gemini: {
    id: "gemini",
    name: "Gemini (gemini.google.com)",
    url: "https://gemini.google.com",
    loginRequired: true,
    loginHint: "sign in once via `ui2api analyse https://gemini.google.com --login`, or reuse your real Chrome profile (UI2API_USER_DATA_DIR) and the site just works",
    composer: ['div[contenteditable="true"][role="textbox"]', ".ql-editor", "textarea"],
    send: { kind: "keyEnter" },
    answer: [".model-response-text", ".response-content", '[data-test-id="answer-container"] .markdown'],
    newChat: '[aria-label*="New chat"], [aria-label*="new chat"]',
    // JS-function-indexed entry (VERIFIED live 2026-09-22 against a
    // vault-injected session, UI2API_ATTACH_PORT=9222): the captured sender
    // default_BardChatUi.dTi(_, url) returns an RxJS observable; the seam
    // subscribes it (the site's own dispatch pattern) which fires the batchexecute
    // POST through the page's own JS — proof: ok:true, subscribed:true,
    // networkHits=[GET /_/BardChatUi/data/batchexecute]. Only a tiny warm handshake
    // — the ChatDriver DOM path still delivers every prompt.
    jsIndex: { root: "default_BardChatUi", method: "dTi", args: [undefined, "/_/BardChatUi/data/batchexecute"] },
    captureMs: 40000,
    stableMs: 2000,
    // Capability reflection: learn what THIS account can actually do. These
    // selectors are VERIFIED against a live Pro account (2026-09-16): tier via
    // the sidebar avatar footer, models via the composer model picker which
    // opens into a cdk-overlay-pane of gem-menu-item rows. The wire model
    // catalog (otAQ7b) is grounded in src/capabilities/gemini-rpc.ts and is
    // the preferred models source when probed from a logged-in page.
    capability: {
      tierSelectors: ["sidenav-mavatar-footer", "[class*='mavatar-footer']", "[aria-label*='Google Account:']"],
      pickerOpen: [
        "div.model-picker-container",
        "[data-test-id='bard-mode-menu-button']",
        "[data-test-id='model-picker']",
      ],
      pickerOption: [
        ".cdk-overlay-pane gem-menu-item[role='menuitem']",
        "gem-menu-item[role='menuitem']",
        "[data-test-id='model-picker'] [role='option']",
      ],
      restrictionMarkers: [
        { kind: "upgrade", patterns: ["upgrade to", "get gemini", "try gemini", "pro features", "unlock with"] },
        { kind: "limit", patterns: ["you've reached your limit", "limit reached", "rate limit", "too many requests"] },
        { kind: "login", patterns: ["log in to get answers", "sign in to continue", "to continue, sign in"] },
      ],
    },
  },
  // Google AI Mode ("use Google from my AI"): one logged-in /search?q=…&udm=14
  // page load per query, answer + citations read off the SSR'd init data. No
  // composer typing — the query goes in the URL, the site's own JS renders the
  // AI answer. Requires a www.google.com session snapshot (cookies NID/SID)
  // in data/www.google.com/.session — capture once via `ui2api profile capture
  // https://www.google.com --login`, then every prompt is one page load.
  "google-ai-search": {
    id: "google-ai-search",
    name: "Google AI Mode (google.com/search?udm=14)",
    url: "https://www.google.com/search?udm=14",
    loginRequired: true,
    loginHint: "capture a www.google.com session once: ui2api profile capture \"https://www.google.com\" --login",
    composer: [],
    send: { kind: "keyEnter" },
    answer: [
      '[data-attrid="ai_web_answer"]',
      ".Ants3c",
      'div[data-md][class*="Ai"]',
      '[aria-label="AI overview"]',
      "#AI-MODE",
      "#via-container",
    ],
    urlTemplate: "https://www.google.com/search?q={q}&udm=14&hl=en",
    citations: [
      '#via-container a[href^="http"], [data-attrid="ai_web_answer"] a[href^="http"]',
      ".Ants3c a[href^='http']",
    ],
    captureMs: 30000,
    stableMs: 2000,
    note: "AI Mode answer block; selectors tune per-account after a live capture (data/www.google.com/.session)",
  },
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT (chatgpt.com)",
    url: "https://chatgpt.com",
    loginRequired: true,
    loginHint: "sign in once via `ui2api analyse https://chatgpt.com --login`, or reuse your real Chrome profile (UI2API_USER_DATA_DIR)",
    composer: ["#prompt-textarea", "textarea#mobile-composer-prompt", 'div[contenteditable="true"]'],
    send: { kind: "keyEnter" },
    answer: ["[data-message-author-role='assistant']", ".markdown"],
    newChat: '[aria-label="New chat"], [aria-label*="New conversation"]',
    captureMs: 60000,
    stableMs: 2500,
  },
  claude: {
    id: "claude",
    name: "Claude (claude.ai)",
    url: "https://claude.ai/new",
    loginRequired: true,
    loginHint: "sign in once via `ui2api analyse https://claude.ai --login`, or reuse your real Chrome profile (UI2API_USER_DATA_DIR)",
    composer: [".ProseMirror", 'div[contenteditable="true"][data-testid="prompt-editor"]'],
    send: { kind: "keyEnter" },
    answer: ['[data-testid="assistant-message"]', ".font-claude-message", ".whitespace-pre-wrap"],
    newChat: '[aria-label="New chat"], [data-testid="new-chat"]',
    captureMs: 90000,
    stableMs: 2500,
  },
  copilot: {
    id: "copilot",
    name: "Microsoft Copilot (copilot.microsoft.com) — anonymous, no sign-in",
    url: "https://copilot.microsoft.com",
    loginRequired: false,
    loginHint: "no sign-in needed; if a consent/promo overlay appears the profile tries to dismiss it",
    composer: ["#userInput", "textarea[name='userInput']", "textarea[placeholder*='Ask']", "textarea"],
    send: { kind: "keyEnter" },
    answer: ['[data-content="ai-message"]', ".ac-textBlock", ".content-ai", '[data-message-type="text"]'],
    dismiss: ['button[aria-label*="Accept"]', 'button[id*="accept"]', 'button[aria-label*="Continue"]', '#c-accept'],
    captureMs: 60000,
    stableMs: 2000,
    note: "anonymous Microsoft Copilot — best 'zero-setup' default for a fresh server",
  },
  perplexity: {
    id: "perplexity",
    name: "Perplexity (perplexity.ai) — anonymous 'Ask'",
    url: "https://www.perplexity.ai",
    loginRequired: false,
    loginHint: "anonymous Ask usually works; sign in via `ui2api analyse https://www.perplexity.ai --login` if a modal blocks it",
    composer: ['textarea[placeholder*="Ask"]', "textarea[placeholder*='ask anything']", "div[contenteditable='true']"],
    send: { kind: "keyEnter" },
    answer: ["[data-testid='answer']", "div[class*='prose']", ".answer-content"],
    dismiss: ['button[aria-label*="Close"]', 'button[aria-label*="Dismiss"]', "button:has-text('Maybe later')"],
    captureMs: 90000,
    stableMs: 2500,
  },
  huggingchat: {
    id: "huggingchat",
    name: "HuggingChat (huggingface.co/chat)",
    url: "https://huggingface.co/chat",
    loginRequired: false,
    loginHint: "may ask for sign-in; provide a session via `ui2api analyse https://huggingface.co/chat --login` if needed",
    composer: ["textarea[placeholder*='Ask']", ".ChatInput textarea", "textarea"],
    send: { kind: "keyEnter" },
    answer: [".message.overflow-y-auto", '[data-testid="message"]', ".chat-container .message"],
    dismiss: ["button:has-text('Start chatting')"],
    captureMs: 90000,
    stableMs: 2500,
  },
  kimi: {
    id: "kimi",
    name: "Kimi AI (www.kimi.ai)",
    url: "https://www.kimi.ai",
    loginRequired: true,
    loginHint: "sign in once via `ui2api analyse https://www.kimi.ai --login` — sessions live in localStorage (access_token/refresh_token/msh_user_id) replayed as 'Authorization: Bearer <access_token>' against https://notilo.kimi.com/apiv2; or reuse your real Chrome profile (UI2API_USER_DATA_DIR)",
    composer: [
      'div[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="Ask anything"], textarea[placeholder*="Ask"], textarea[placeholder*="输入"]',
      ".chat-input textarea",
      // "next" UI (2026-09-19): composer container is [data-testid="chat-editor"]
      // wrapping div.chat-input-editor; the real editable sits deeper and matches
      // [role="textbox"]. Container selectors are LAST — focusing the container
      // breaks insertText, so the editable-first candidates above must win.
      '[data-testid="chat-editor"] [role="textbox"]',
      '[data-testid="chat-editor"] [contenteditable="true"]',
      '[data-testid="chat-editor"]',
      ".chat-input-editor",
    ],
    send: { kind: "keyEnter" },
    answer: [
      '.toolcall-rollup__part:has(+ .toolcall-rollup__tail) > .markdown-container > .markdown',
      // Fallback for non-rollup rendering — MUST exclude the thinking block:
      // its container carries `.toolcall-content-text` (guard discovered 2026-09-19:
      // the previous bare selector matched thinking transcripts and, because the
      // driver takes the LONGEST match, leaked them as the "answer").
      '.chat-content-item-assistant .markdown-container:not(.toolcall-content-text) > .markdown',
      '.segment-text',
    ],
    newChat: '[aria-label*="New chat"], [aria-label*="new chat"], [aria-label*="新对话"], [data-testid="sidebar-new-chat"]',
    dismiss: ['button[aria-label*="Sign in"], button[aria-label*="登录"]', 'button[aria-label*="Close"], button[aria-label*="关闭"]'],
    captureMs: 60000,
    stableMs: 2000,
    // Capability reflection (LIVE-verified 2026-09-21 against the account
    // vault snapshot): composer model select [data-testid="model-select-trigger"]
    // opens a panel of button.model-item rows (current: "Instant High" → the
    // K3-family row named "K3 Chat & Agent"); the membership-upgrade button in
    // the sidebar is the tier signal ("Upgrade" = not on the paid tier).
    capability: {
      pickerOpen: ['[data-testid="model-select-trigger"]'],
      pickerOption: ["button.model-item", "[role='menuitem'] button"],
      tierSelectors: ["button.membership-upgrade", "[class*='membership-upgrade']"],
      restrictionMarkers: [
        { kind: "upgrade", patterns: ["upgrade", "可行的升级", "升级会员"] },
        { kind: "limit", patterns: ["you've reached your limit", "limit reached", "message limit", "次数用尽"] },
        { kind: "login", patterns: ["log in to continue", "sign in to continue"] },
      ],
    },
    note: "LOCKED + LIVE-VERIFIED (2026-09-18/19): composer [data-testid='chat-editor'], answer excludes thinking block; new 'next' UI revision — sidebar history = a.next-sidebar-history-item__link (href /chat/<id>?chat_enter_method=history), model select [data-testid='model-select-trigger'] (Instant/High), toolkit panel (Web Search / Add files & images / Plugins / Skills) behind [data-testid='toolkit-trigger-btn']. Anti-bot: TrustDecision blackbox (x-msh-shield-data) + VolcanoEngine.",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek Chat (chat.deepseek.com)",
    url: "https://chat.deepseek.com",
    loginRequired: true,
    loginHint: "capture a chat.deepseek.com session once: ui2api profile ingest chat.deepseek.com (reads localStorage userToken + AWS WAF cookies from your Chrome), or reuse your signed-in Chrome via UI2API_USER_DATA_DIR",
    composer: [
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="请输入"]',
      'div[contenteditable="true"][role="textbox"]',
      "textarea",
    ],
    send: { kind: "keyEnter" },
    answer: [".ds-markdown", '[class*="markdown"]', '[class*="answer"]'],
    newChat: '[aria-label*="New chat"], [aria-label*="new chat"], button:has-text(\'new chat\')',
    dismiss: ['button[aria-label*="Close"]', 'button[aria-label*="Accept"]'],
    captureMs: 60000,
    stableMs: 2000,
    // Capability reflection (LIVE-verified 2026-09-21 against the account
    // vault snapshot): deepseek exposes NO model picker in the shell — what it
    // shows instead are composer TOGGLES, `.ds-toggle-button` rows labelled
    // "DeepThink" and "Search", the active one carrying class
    // ds-toggle-button--selected. Those are the real per-account abilities.
    capability: {
      abilityToggles: [
        { id: "reasoner", selector: ".ds-toggle-button", label: "DeepThink", selectedClass: "ds-toggle-button--selected" },
        { id: "web_search", selector: ".ds-toggle-button", label: "Search", selectedClass: "ds-toggle-button--selected" },
      ],
      restrictionMarkers: [
        // Full phrase matches only — bare "rate limit" matched a SIDEBAR
        // conversation title ("Fix GitHub Rate Limit and Redundant Downloads"),
        // a false positive found 2026-09-21. These are the real banner texts.
        { kind: "limit", patterns: ["rate limit reached", "too many requests, please", "you've reached the limit", "you have reached the limit", "server busy, please", "服务繁忙，请稍后重试", "请求过于频繁"] },
        { kind: "login", patterns: ["please log in", "log in to continue", "sign in to continue", "请登录"] },
      ],
    },
    note: "LOCKED — verified live against chat.deepseek.com (2026-09-18) with an ingested Chrome session (localStorage userToken → Bearer; AWS WAF token + ds_session_id cookies). HEADED session REQUIRED: AWS WAF JS challenge + PoW mining solved invisibly by the real browser.",
  },
  "tencent-aistudio": {
    id: "tencent-aistudio",
    name: "Tencent AI Studio (aistudio.tencent.ai)",
    url: "https://aistudio.tencent.ai",
    loginRequired: true,
    loginHint: "HEADED session REQUIRED — cookie auth: hunyuan_token + hunyuan_user + hunyuan_source on .tencent.ai. Capture once: npx tsx src/cli.ts profile ingest aistudio.tencent.ai, or reuse your signed-in Chrome via UI2API_USER_DATA_DIR. iOA QR scan login via /api/oalogin / WeChat.",
    composer: [
      "textarea.t-textarea__inner",
      'div[contenteditable="true"]',
      "textarea",
      '[class*="chat-input"] textarea',
      '[class*="input-box"] textarea',
    ],
    send: { kind: "keyEnter" },
    answer: [
      ".agent-chat__bubble--ai .hyc-content-md",
      ".agent-chat__bubble--ai .hyc-common-markdown",
      ".hyc-content-md",
      '[class*="speech_show"] .hyc-common-markdown',
      '[class*="message-content"]',
      '[class*="answer"]',
      '[class*="response-text"]',
      '[class*="chat-content"]',
    ],
    newChat: '[class*="new-chat"], [aria-label*="新对话"], [aria-label*="New chat"], a[href="/chat/HunyuanDefault"]',
    dismiss: ['button[aria-label*="关闭"], button[aria-label*="Close"]', '[class*="login-modal"] button[class*="close"]'],
    captureMs: 60000,
    stableMs: 2500,
    preComposeDelayMs: 8000,
    realProfileOnly: true,
    note: "LIVE-VERIFIED chat round-trip (2026-09-19, headed real Chrome + injected snapshot): composer textarea.t-textarea__inner (placeholder 'Ask me anything'), AI answer in .agent-chat__bubble--ai .hyc-content-md (markdown .hyc-common-markdown), human bubble .agent-chat__bubble--human .hyc-content-text, completion marker 'Completed'. EdgeOne blocks headless (HTTP 567) AND ephemeral snapshot contexts ('Access Restricted' — its challenge cookies are session-scoped, never captured) — real-profile/attach ONLY (realProfileOnly).",
  },
  hunyuan: {
    id: "hunyuan",
    name: "Tencent Hunyuan (yuanbao.tencent.com)",
    url: "https://yuanbao.tencent.com/",
    loginRequired: true,
    loginHint: "HEADED session REQUIRED — the API sets `X-webdriver: 1` when navigator.webdriver is true, so headless Chrome is fingerprint-flagged (Turing.js + QIMEI). Capture once with a real, headed profile: `ui2api analyse https://yuanbao.tencent.com --login`, or reuse your signed-in Chrome via UI2API_USER_DATA_DIR. The chat console trusts the hy_user/hy_token session cookies.",
    composer: [
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="输入你的问题"]',
      '[class*="chat-input"] textarea',
      "textarea",
    ],
    send: { kind: "keyEnter" },
    answer: ['[class*="message"]', ".chat-item", '[class*="answer"]', '[class*="assistant"] [class*="markdown"]'],
    newChat: '[aria-label*="新建对话"], [aria-label*="new chat"], [class*="new-chat"], button:has-text(\'新建对话\')',
    dismiss: ['button[aria-label*="关闭"]', 'button[aria-label*="Close"]', "button:has-text('知道了')"],
    captureMs: 60000,
    stableMs: 2000,
    note: "UNVERIFIED selectors copied verbatim from capabilities/hunyuan/profile.json. HEADED-ONLY + anti-bot: the SPA sets X-webdriver: 1 for automated Chrome (Turing.js + QIMEI fingerprinting); session = hy_user/hy_token cookies outside bundle JS. Tune every selector after the first live capture (data/yuanbao.tencent.com/.session).",
  },
  // NOTE: `youtube` + `araprat` (Aparat) are intentionally NOT builtin chat
  // profiles — they are capability-only surfaces (video platforms, no
  // composer/answer). Their /capability/<id> routes resolve the packaged
  // capabilities/<id>/profile.json fallback instead (same pattern as any
  // site without a builtin entry).
};

export const PROFILE_IDS = Object.keys(BUILTIN_PROFILES);

// The default site id when the caller didn't pick one:
//  - using the user's real Chrome/profile (somebody who signed in) -> Gemini
//    (their logged-in Google session), because it is the highest-quality answer
//    with zero extra setup;
//  - otherwise a fresh anonymous session -> Microsoft Copilot, because it is the
//    only big AI chat that accepts prompts with no sign-in at all.
export function defaultSiteId(): string {
  return usingUserChrome() ? "gemini" : "copilot";
}

// Resolve a profile from either a built-in id, a path to a JSON profile file,
// or nothing (defaults to defaultSiteId()). A JSON file may carry the full
// ChatSiteProfile shape; anything missing falls back to the built-in of the
// same `id` (so an override can be a thin slice).
export function resolveProfile(idOrPath?: string): ChatSiteProfile {
  const value = idOrPath?.trim() || process.env.UI2API_AI_SITE?.trim() || "";
  if (!value) return { ...BUILTIN_PROFILES[defaultSiteId()] };
  if (BUILTIN_PROFILES[value]) return { ...BUILTIN_PROFILES[value] };
  if (value.endsWith(".json")) {
    const raw = JSON.parse(readFileSync(value, "utf8")) as Partial<ChatSiteProfile>;
    if (!raw.id) throw new Error(`profile file ${value} must carry an "id"`);
    const base = BUILTIN_PROFILES[raw.id];
    return {
      ...(base ? { ...base } : {}),
      ...raw,
      composer: raw.composer ?? base?.composer ?? [],
      answer: raw.answer ?? base?.answer ?? [],
    } as ChatSiteProfile;
  }
  // Installed chat-shaped package profile (capabilities/<site>/profile.json):
  // same canonical source /capability and /registry serve. Only chat-shaped
  // packages resolve — non-chat capability surfaces (youtube, araprat, gmail,
  // …) keep the "unknown AI site" error so a prompt is never aimed at a site
  // the driver cannot drive.
  const packaged = resolvePackagedProfile(value);
  if (packaged && isChatShapedProfile(packaged)) return packaged;
  throw new Error(
    `unknown AI site "${value}" — expected one of ${PROFILE_IDS.join(", ")} or a path to a *.json profile`
  );
}

// A profile is driver-drivable (chat-shaped) when it actually drives a chat
// composer and reads an answer container — `composer.length > 0 && answer.length > 0`
// (GOAL 30 discriminator) plus a resolvable site url. Capability-only packages
// (gmail/youtube/araprat/chatglm/tinycms/…) are deliberately NOT chat shapes:
// they must never become daemon chat models.
export function isChatShapedProfile(p: ChatSiteProfile): boolean {
  return (
    typeof p === "object" &&
    p !== null &&
    Array.isArray(p.composer) &&
    p.composer.length > 0 &&
    Array.isArray(p.answer) &&
    p.answer.length > 0 &&
    typeof p.url === "string" &&
    p.url.length > 0
  );
}

/**
 * Resolve a packaged per-site profile.json (capabilities/<site>/profile.json)
 * robustly from ANY working directory and from an installed npm package, not
 * just from the repo root. Runtime-equivalent to resolveProfile(), which is
 * CWD-relative and breaks when the daemon is started elsewhere (or from the
 * packaged tarball). Returns null when the packaged profile is absent.
 */
export function resolvePackagedProfile(siteId: string): ChatSiteProfile | null {
  try {
    const here = fileURLToPath(new URL(".", import.meta.url));
    // Module sits at <root>/src/profile/ or <root>/dist/profile/ — two levels
    // up lands on the package root in both layouts (also covers symlinked
    // installs via realpath matching).
    const relRoots = new Set<string>();
    for (const up of [2, 3]) {
      let p = here;
      for (let i = 0; i < up; i++) p = dirname(p);
      relRoots.add(p);
    }
    for (const packageRoot of relRoots) {
      const candidates = [
        resolve(packageRoot, "capabilities", siteId, "profile.json"),
        resolve(packageRoot, "src", "capabilities", siteId, "profile.json"),
      ];
      for (const p of candidates) {
        if (existsSync(p)) return resolveProfile(p);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function listProfiles(): ChatSiteProfile[] {
  return PROFILE_IDS.map((id) => ({ ...BUILTIN_PROFILES[id] }));
}