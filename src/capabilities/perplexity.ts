// Perplexity capability runner — every capability this package declares is
// dispatched HONESTLY as login-gated: this box holds NO captured Perplexity session
// and no verified runner implementation is wired yet, so each declared
// capability short-circuits to {ok:false, loginGated:true} WITHOUT opening a
// browser (GOAL 7 wiring: function → api → ui closure). This keeps the package's
// manifest ↔ dispatch surface IN-SYNC — no declared capability falls into the
// "unknown perplexity capability" dead branch, and no fabricated result is ever
// returned. When a real implementation lands, return the working branches here.
import type { Browser } from "playwright";
import type { ChatSiteProfile } from "../profile/profile.js";
import { loginGatedResult, type GatedRunResult } from "./gated.js";

export interface PerplexityCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
}

export class PerplexityCapabilities {
  constructor(
    private readonly profile: ChatSiteProfile,
    private readonly opts: PerplexityCapabilityOptions = {},
  ) {}

  async run(capability: string, _args: Record<string, unknown> = {}): Promise<GatedRunResult> {
    switch (capability) {
      case "perplexity_chat":
        return loginGatedResult(this.profile.id, capability);
      default:
        return { capability, ok: false, data: undefined, error: `unknown perplexity capability: ${capability}` };
    }
  }

  async close(): Promise<void> {
    // login-gated runners never open a browser
  }
}
