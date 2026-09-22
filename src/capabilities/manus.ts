// Manus capability runner — every capability this package declares is
// dispatched HONESTLY as login-gated: this box holds NO captured Manus session
// and no verified runner implementation is wired yet, so each declared
// capability short-circuits to {ok:false, loginGated:true} WITHOUT opening a
// browser (GOAL 7 wiring: function → api → ui closure). This keeps the package's
// manifest ↔ dispatch surface IN-SYNC — no declared capability falls into the
// "unknown manus capability" dead branch, and no fabricated result is ever
// returned. When a real implementation lands, return the working branches here.
import type { Browser } from "playwright";
import type { ChatSiteProfile } from "../profile/profile.js";
import { loginGatedResult, type GatedRunResult } from "./gated.js";

export interface ManusCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
}

export class ManusCapabilities {
  constructor(
    private readonly profile: ChatSiteProfile,
    private readonly opts: ManusCapabilityOptions = {},
  ) {}

  async run(capability: string, _args: Record<string, unknown> = {}): Promise<GatedRunResult> {
    switch (capability) {
      case "manus_chat":
        return loginGatedResult(this.profile.id, capability);
      case "manus_session_start":
        return loginGatedResult(this.profile.id, capability);
      case "manus_session_list":
        return loginGatedResult(this.profile.id, capability);
      case "manus_sandbox":
        return loginGatedResult(this.profile.id, capability);
      case "manus_upload":
        return loginGatedResult(this.profile.id, capability);
      default:
        return { capability, ok: false, data: undefined, error: `unknown manus capability: ${capability}` };
    }
  }

  async close(): Promise<void> {
    // login-gated runners never open a browser
  }
}
