import { readFileSync } from "node:fs";
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
  },
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT (chatgpt.com)",
    url: "https://chatgpt.com",
    loginRequired: true,
    loginHint: "sign in once via `ui2api analyse https://chatgpt.com --login`, or reuse your real Chrome profile (UI2API_USER_DATA_DIR)",
    composer: ["#prompt-textarea", 'div[contenteditable="true"]'],
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

export function listProfiles(): ChatSiteProfile[] {
  return PROFILE_IDS.map((id) => ({ ...BUILTIN_PROFILES[id] }));
}