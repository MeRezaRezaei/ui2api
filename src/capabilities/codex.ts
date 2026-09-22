// Codex capability runner — every capability this package declares is
// dispatched HONESTLY as login-gated: this box holds NO captured Codex session
// and no verified runner implementation is wired yet, so each declared
// capability short-circuits to {ok:false, loginGated:true} WITHOUT opening a
// browser (GOAL 7 wiring: function → api → ui closure). This keeps the package's
// manifest ↔ dispatch surface IN-SYNC — no declared capability falls into the
// "unknown codex capability" dead branch, and no fabricated result is ever
// returned. When a real implementation lands, return the working branches here.
import type { Browser } from "playwright";
import type { ChatSiteProfile } from "../profile/profile.js";
import { loginGatedResult, type GatedRunResult } from "./gated.js";

export interface CodexCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
}

export class CodexCapabilities {
  constructor(
    private readonly profile: ChatSiteProfile,
    private readonly opts: CodexCapabilityOptions = {},
  ) {}

  async run(capability: string, _args: Record<string, unknown> = {}): Promise<GatedRunResult> {
    switch (capability) {
      case "codex_chat":
        return loginGatedResult(this.profile.id, capability);
      case "codex_task_crud":
        return loginGatedResult(this.profile.id, capability);
      case "codex_task_turns":
        return loginGatedResult(this.profile.id, capability);
      case "codex_environment":
        return loginGatedResult(this.profile.id, capability);
      case "codex_repo_connect":
        return loginGatedResult(this.profile.id, capability);
      case "codex_usage_credits":
        return loginGatedResult(this.profile.id, capability);
      case "codex_cloud":
        return loginGatedResult(this.profile.id, capability);
      case "codex_oauth_cli":
        return loginGatedResult(this.profile.id, capability);
      default:
        return { capability, ok: false, data: undefined, error: `unknown codex capability: ${capability}` };
    }
  }

  async close(): Promise<void> {
    // login-gated runners never open a browser
  }
}
