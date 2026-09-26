import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser } from "playwright";

/**
 * GOAL 140: THE DISPATCH TABLE — the last place registry knowledge lived in CODE.
 *
 * The audit behind this found the real leak behind the operator's question
 * ("make sure the AI didn't write registry things into the main app"):
 *
 *   /registry is built from DATA (capabilities/<id>/manifest.json), but EXECUTION
 *   was 33 hand-written `if (req.url === "/capability/<site>")` blocks in
 *   http.ts — 54,851 characters of copy-paste. A package dropped into
 *   capabilities/<id>/ therefore appeared on /registry and then 404'd at call
 *   time, and a skill teaching an AI to "register a site" would have had to
 *   teach it to edit a 1,700-line HTTP handler. That is app code standing in for
 *   registry data, which is exactly what must not happen.
 *
 * This table is the ONE place a site becomes dispatchable, and it is DATA. It was
 * measured from the 33 blocks before they were replaced: they collapse to THREE
 * shapes (20 / 10 / 3 sites), differing only in whether the runner gets the
 * pool's shared browser and whether a packaged profile is tried first.
 *
 * `shared: true` means the runner REUSES the pool's logged-in browser. That is
 * not cosmetic — a fresh per-request browser lands on the signed-out shell and
 * the DOM reads fail, which is why these sites take the pool browser at all.
 */
/**
 * The uniform runner surface every src/capabilities/<id>.ts exposes. Typed
 * structurally so the daemon can construct any of them the same way, and so a
 * runner that drifts from this shape is a TYPE error rather than a runtime 500.
 */
export interface CapabilityRunnerInstance {
  run(capability: string, args: Record<string, unknown>): Promise<{ ok: boolean } & object>;
  close(): Promise<void>;
}

/** The CONSTRUCTOR shape. Declaring it structurally is deliberate: a runner that
 *  stops exposing `run`/`close`, or changes either signature, becomes a TYPE
 *  ERROR here instead of a runtime 500 on a live call. */
export interface CapabilityRunner {
  // `ChatSiteProfile` is imported as a TYPE only — a structural ctor type keeps
  // this module free of a runtime dependency on the profile loader, while still
  // giving assignability checking (the param is `ChatSiteProfile`, not
  // `unknown`, or every runner's narrower signature would fail contravariance).
  new (profile: ChatSiteProfile, opts: CapabilityRunnerOpts): CapabilityRunnerInstance;
}

export interface CapabilityRunnerOpts {
  // Typed as the real Browser so assignability holds against each runner's own
  // options interface (a narrower `Browser` here would fail contravariance and
  // mask genuine drift behind a cast).
  browser?: Browser;
  dataDir?: string;
  account?: string;
}

export interface CapabilityDispatch {
  /** The runner class exported by src/capabilities/<id>.ts. */
  readonly runner: string;
  /** Reuse the pool's logged-in browser instead of launching a fresh one. */
  readonly shared: boolean;
  /** Validate the requested account against the vault before any browser work. */
  readonly account: boolean;
  /** Also try resolvePackagedProfile() before the packaged profile.json file. */
  readonly packagedFallback: boolean;
}

export const CAPABILITY_DISPATCH: Readonly<Record<string, CapabilityDispatch>> = {
  // --- 20 sites: no shared browser ---
  "adapta": { runner: "AdaptaCapabilities", shared: false, account: false, packagedFallback: true },
  "blackbox": { runner: "BlackboxCapabilities", shared: false, account: false, packagedFallback: true },
  "chatglm": { runner: "ChatglmCapabilities", shared: false, account: false, packagedFallback: true },
  "codex": { runner: "CodexCapabilities", shared: false, account: false, packagedFallback: true },
  "conol": { runner: "ConolCapabilities", shared: false, account: false, packagedFallback: true },
  "copilot-m365": { runner: "CopilotM365Capabilities", shared: false, account: false, packagedFallback: true },
  "doubao": { runner: "DoubaoCapabilities", shared: false, account: false, packagedFallback: true },
  "duckduckgo": { runner: "DuckduckgoCapabilities", shared: false, account: false, packagedFallback: true },
  "google-ai-search": { runner: "GoogleAiSearchCapabilities", shared: false, account: false, packagedFallback: true },
  "grok": { runner: "GrokCapabilities", shared: false, account: false, packagedFallback: true },
  "inner-ai": { runner: "InnerAiCapabilities", shared: false, account: false, packagedFallback: true },
  "manus": { runner: "ManusCapabilities", shared: false, account: false, packagedFallback: true },
  "notion": { runner: "NotionCapabilities", shared: false, account: false, packagedFallback: true },
  "perplexity": { runner: "PerplexityCapabilities", shared: false, account: false, packagedFallback: true },
  "poe": { runner: "PoeCapabilities", shared: false, account: false, packagedFallback: true },
  "t3chat": { runner: "T3chatCapabilities", shared: false, account: false, packagedFallback: true },
  "tinycms": { runner: "TinycmsCapabilities", shared: false, account: false, packagedFallback: true },
  "v0": { runner: "V0Capabilities", shared: false, account: false, packagedFallback: true },
  "xiaomimimo": { runner: "XiaomimimoCapabilities", shared: false, account: false, packagedFallback: true },
  "zenmux": { runner: "ZenmuxCapabilities", shared: false, account: false, packagedFallback: true },
  // --- 13 sites: shared pool browser ---
  "araprat": { runner: "ArapratCapabilities", shared: true, account: true, packagedFallback: false },
  "chatgpt": { runner: "ChatGPTCapabilities", shared: true, account: true, packagedFallback: false },
  "claude": { runner: "ClaudeCapabilities", shared: true, account: true, packagedFallback: false },
  "copilot": { runner: "CopilotCapabilities", shared: true, account: true, packagedFallback: false },
  "deepseek": { runner: "DeepSeekCapabilities", shared: true, account: true, packagedFallback: false },
  "gemini": { runner: "GeminiCapabilities", shared: true, account: true, packagedFallback: false },
  "gmail": { runner: "GmailCapabilities", shared: true, account: true, packagedFallback: false },
  "huggingchat": { runner: "HuggingChatCapabilities", shared: true, account: true, packagedFallback: false },
  "hunyuan": { runner: "HunyuanCapabilities", shared: true, account: true, packagedFallback: true },
  "kimi": { runner: "KimiCapabilities", shared: true, account: true, packagedFallback: true },
  "tencent-aistudio": { runner: "TencentAistudioCapabilities", shared: true, account: true, packagedFallback: false },
  "venice": { runner: "VeniceCapabilities", shared: true, account: true, packagedFallback: true },
  "youtube": { runner: "YouTubeCapabilities", shared: true, account: true, packagedFallback: false },
};

/** Every site id the daemon can actually dispatch — the honest servable set. */
export function dispatchableSiteIds(): string[] {
  return Object.keys(CAPABILITY_DISPATCH).sort();
}

/** Is this site dispatched, or only DECLARED by a package? */
export function isDispatchable(siteId: string): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_DISPATCH, siteId);
}
