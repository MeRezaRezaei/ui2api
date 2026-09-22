// Notion capability runner — every capability this package declares is
// dispatched HONESTLY as login-gated: this box holds NO captured Notion session
// and no verified runner implementation is wired yet, so each declared
// capability short-circuits to {ok:false, loginGated:true} WITHOUT opening a
// browser (GOAL 7 wiring: function → api → ui closure). This keeps the package's
// manifest ↔ dispatch surface IN-SYNC — no declared capability falls into the
// "unknown notion capability" dead branch, and no fabricated result is ever
// returned. When a real implementation lands, return the working branches here.
import type { Browser } from "playwright";
import type { ChatSiteProfile } from "../profile/profile.js";
import { loginGatedResult, type GatedRunResult } from "./gated.js";

export interface NotionCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
}

export class NotionCapabilities {
  constructor(
    private readonly profile: ChatSiteProfile,
    private readonly opts: NotionCapabilityOptions = {},
  ) {}

  async run(capability: string, _args: Record<string, unknown> = {}): Promise<GatedRunResult> {
    switch (capability) {
      case "notion_chat":
        return loginGatedResult(this.profile.id, capability);
      case "notion_qna":
        return loginGatedResult(this.profile.id, capability);
      case "notion_ai_commands":
        return loginGatedResult(this.profile.id, capability);
      case "notion_ai_search":
        return loginGatedResult(this.profile.id, capability);
      case "notion_ai_connectors":
        return loginGatedResult(this.profile.id, capability);
      default:
        return { capability, ok: false, data: undefined, error: `unknown notion capability: ${capability}` };
    }
  }

  async close(): Promise<void> {
    // login-gated runners never open a browser
  }
}
