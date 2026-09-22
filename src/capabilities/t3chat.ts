// T3chat capability runner — every capability this package declares is
// dispatched HONESTLY as login-gated: this box holds NO captured T3chat session
// and no verified runner implementation is wired yet, so each declared
// capability short-circuits to {ok:false, loginGated:true} WITHOUT opening a
// browser (GOAL 7 wiring: function → api → ui closure). This keeps the package's
// manifest ↔ dispatch surface IN-SYNC — no declared capability falls into the
// "unknown t3chat capability" dead branch, and no fabricated result is ever
// returned. When a real implementation lands, return the working branches here.
import type { Browser } from "playwright";
import type { ChatSiteProfile } from "../profile/profile.js";
import { loginGatedResult, type GatedRunResult } from "./gated.js";

export interface T3chatCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
}

export class T3chatCapabilities {
  constructor(
    private readonly profile: ChatSiteProfile,
    private readonly opts: T3chatCapabilityOptions = {},
  ) {}

  async run(capability: string, _args: Record<string, unknown> = {}): Promise<GatedRunResult> {
    switch (capability) {
      case "t3chat_chat":
        return loginGatedResult(this.profile.id, capability);
      case "t3chat_model_switch":
        return loginGatedResult(this.profile.id, capability);
      case "t3chat_conversation_crud":
        return loginGatedResult(this.profile.id, capability);
      case "t3chat_file_upload":
        return loginGatedResult(this.profile.id, capability);
      case "t3chat_model_list":
        return loginGatedResult(this.profile.id, capability);
      default:
        return { capability, ok: false, data: undefined, error: `unknown t3chat capability: ${capability}` };
    }
  }

  async close(): Promise<void> {
    // login-gated runners never open a browser
  }
}
