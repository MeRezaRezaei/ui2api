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
  // Best-effort buttons to click away before composing (consent / promo
  // overlays on anonymous sites). Failures are swallowed.
  dismiss?: string[];
  captureMs: number;
  stableMs: number;
  note?: string;
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
    captureMs: 90000,
    stableMs: 2500,
  },
  kimi: {
    id: "kimi",
    name: "Kimi AI (www.kimi.com)",
    url: "https://www.kimi.com",
    loginRequired: true,
    loginHint: "sign in once via `ui2api analyse https://www.kimi.com --login` — sessions live in localStorage (access_token/refresh_token/msh_user_id) replayed as 'Authorization: Bearer <access_token>' against https://notilo.kimi.com/apiv2; or reuse your real Chrome profile (UI2API_USER_DATA_DIR)",
    composer: [
      'div[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="Ask anything"], textarea[placeholder*="Ask"], textarea[placeholder*="输入"]',
      ".chat-input textarea",
    ],
    send: { kind: "keyEnter" },
    answer: [".segment-text", '[class*="answer"]', '[class*="response"]'],
    newChat: '[aria-label*="New chat"], [aria-label*="new chat"], [aria-label*="新对话"]',
    dismiss: ['button[aria-label*="Sign in"], button[aria-label*="登录"]', 'button[aria-label*="Close"], button[aria-label*="关闭"]'],
    captureMs: 60000,
    stableMs: 2000,
    note: "UNVERIFIED selectors copied verbatim from capabilities/kimi/profile.json (inventory-grounded, no DOM proven) — confirm on first live capture (data/www.kimi.com/.session). Anti-bot: TrustDecision blackbox (x-msh-shield-data) + VolcanoEngine; drive the site's own UI.",
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
  throw new Error(
    `unknown AI site "${value}" — expected one of ${PROFILE_IDS.join(", ")} or a path to a *.json profile`
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