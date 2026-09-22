// InnerAi capability runner — every capability this package declares is
// dispatched HONESTLY as login-gated: this box holds NO captured InnerAi session
// and no verified runner implementation is wired yet, so each declared
// capability short-circuits to {ok:false, loginGated:true} WITHOUT opening a
// browser (GOAL 7 wiring: function → api → ui closure). This keeps the package's
// manifest ↔ dispatch surface IN-SYNC — no declared capability falls into the
// "unknown inner-ai capability" dead branch, and no fabricated result is ever
// returned. When a real implementation lands, return the working branches here.
import type { Browser } from "playwright";
import type { ChatSiteProfile } from "../profile/profile.js";
import { loginGatedResult, type GatedRunResult } from "./gated.js";

export interface InnerAiCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
}

export class InnerAiCapabilities {
  constructor(
    private readonly profile: ChatSiteProfile,
    private readonly opts: InnerAiCapabilityOptions = {},
  ) {}

  async run(capability: string, _args: Record<string, unknown> = {}): Promise<GatedRunResult> {
    switch (capability) {
      case "inner_ai_chat":
        return loginGatedResult(this.profile.id, capability);
      case "inner_ai_conversations":
        return loginGatedResult(this.profile.id, capability);
      case "inner_ai_models":
        return loginGatedResult(this.profile.id, capability);
      case "inner_ai_files":
        return loginGatedResult(this.profile.id, capability);
      case "inner_ai_realtime_history":
        return loginGatedResult(this.profile.id, capability);
      case "inner_ai_voice":
        return loginGatedResult(this.profile.id, capability);
      default:
        return { capability, ok: false, data: undefined, error: `unknown inner-ai capability: ${capability}` };
    }
  }

  async close(): Promise<void> {
    // login-gated runners never open a browser
  }
}
