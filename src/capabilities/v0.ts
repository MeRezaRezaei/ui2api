// V0 capability runner — every capability this package declares is
// dispatched HONESTLY as login-gated: this box holds NO captured V0 session
// and no verified runner implementation is wired yet, so each declared
// capability short-circuits to {ok:false, loginGated:true} WITHOUT opening a
// browser (GOAL 7 wiring: function → api → ui closure). This keeps the package's
// manifest ↔ dispatch surface IN-SYNC — no declared capability falls into the
// "unknown v0 capability" dead branch, and no fabricated result is ever
// returned. When a real implementation lands, return the working branches here.
import type { Browser } from "playwright";
import type { ChatSiteProfile } from "../profile/profile.js";
import { loginGatedResult, type GatedRunResult } from "./gated.js";

export interface V0CapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
}

export class V0Capabilities {
  constructor(
    private readonly profile: ChatSiteProfile,
    private readonly opts: V0CapabilityOptions = {},
  ) {}

  async run(capability: string, _args: Record<string, unknown> = {}): Promise<GatedRunResult> {
    switch (capability) {
      case "v0_chat":
        return loginGatedResult(this.profile.id, capability);
      case "v0_chat_history":
        return loginGatedResult(this.profile.id, capability);
      case "v0_agent_workspace":
        return loginGatedResult(this.profile.id, capability);
      case "v0_artifact_preview":
        return loginGatedResult(this.profile.id, capability);
      case "v0_deployments":
        return loginGatedResult(this.profile.id, capability);
      case "v0_image_generation":
        return loginGatedResult(this.profile.id, capability);
      case "v0_voice_input":
        return loginGatedResult(this.profile.id, capability);
      case "v0_integrations_mcp":
        return loginGatedResult(this.profile.id, capability);
      case "v0_git_sync":
        return loginGatedResult(this.profile.id, capability);
      default:
        return { capability, ok: false, data: undefined, error: `unknown v0 capability: ${capability}` };
    }
  }

  async close(): Promise<void> {
    // login-gated runners never open a browser
  }
}
