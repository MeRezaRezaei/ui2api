// Chatglm capability runner — every capability this package declares is
// dispatched HONESTLY as login-gated: this box holds NO captured Chatglm session
// and no verified runner implementation is wired yet, so each declared
// capability short-circuits to {ok:false, loginGated:true} WITHOUT opening a
// browser (GOAL 7 wiring: function → api → ui closure). This keeps the package's
// manifest ↔ dispatch surface IN-SYNC — no declared capability falls into the
// "unknown chatglm capability" dead branch, and no fabricated result is ever
// returned. When a real implementation lands, return the working branches here.
import type { Browser } from "playwright";
import type { ChatSiteProfile } from "../profile/profile.js";
import { loginGatedResult, type GatedRunResult } from "./gated.js";

export interface ChatglmCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
}

export class ChatglmCapabilities {
  constructor(
    private readonly profile: ChatSiteProfile,
    private readonly opts: ChatglmCapabilityOptions = {},
  ) {}

  async run(capability: string, _args: Record<string, unknown> = {}): Promise<GatedRunResult> {
    switch (capability) {
      case "chatglm_chat":
        return loginGatedResult(this.profile.id, capability);
      case "chatglm_conversation_crud":
        return loginGatedResult(this.profile.id, capability);
      case "chatglm_web_search":
        return loginGatedResult(this.profile.id, capability);
      case "chatglm_image_gen":
        return loginGatedResult(this.profile.id, capability);
      case "chatglm_model_list":
        return loginGatedResult(this.profile.id, capability);
      case "chatglm_file_upload":
        return loginGatedResult(this.profile.id, capability);
      case "chatglm_ppt":
        return loginGatedResult(this.profile.id, capability);
      case "chatglm_glms_assistant":
        return loginGatedResult(this.profile.id, capability);
      default:
        return { capability, ok: false, data: undefined, error: `unknown chatglm capability: ${capability}` };
    }
  }

  async close(): Promise<void> {
    // login-gated runners never open a browser
  }
}
