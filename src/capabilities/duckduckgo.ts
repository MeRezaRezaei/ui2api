// Duckduckgo capability runner — every capability this package declares is
// dispatched HONESTLY as login-gated: this box holds NO captured Duckduckgo session
// and no verified runner implementation is wired yet, so each declared
// capability short-circuits to {ok:false, loginGated:true} WITHOUT opening a
// browser (GOAL 7 wiring: function → api → ui closure). This keeps the package's
// manifest ↔ dispatch surface IN-SYNC — no declared capability falls into the
// "unknown duckduckgo capability" dead branch, and no fabricated result is ever
// returned. When a real implementation lands, return the working branches here.
import type { Browser } from "playwright";
import type { ChatSiteProfile } from "../profile/profile.js";
import { loginGatedResult, type GatedRunResult } from "./gated.js";

export interface DuckduckgoCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
}

export class DuckduckgoCapabilities {
  constructor(
    private readonly profile: ChatSiteProfile,
    private readonly opts: DuckduckgoCapabilityOptions = {},
  ) {}

  async run(capability: string, _args: Record<string, unknown> = {}): Promise<GatedRunResult> {
    switch (capability) {
      case "duckduckgo_chat":
        return loginGatedResult(this.profile.id, capability);
      case "duckduckgo_web_search":
        return loginGatedResult(this.profile.id, capability);
      case "duckduckgo_model_picker":
        return loginGatedResult(this.profile.id, capability);
      case "duckduckgo_file_upload":
        return loginGatedResult(this.profile.id, capability);
      case "duckduckgo_reasoning":
        return loginGatedResult(this.profile.id, capability);
      case "duckduckgo_chat_history":
        return loginGatedResult(this.profile.id, capability);
      default:
        return { capability, ok: false, data: undefined, error: `unknown duckduckgo capability: ${capability}` };
    }
  }

  async close(): Promise<void> {
    // login-gated runners never open a browser
  }
}
