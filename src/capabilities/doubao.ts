// Doubao capability runner — every capability this package declares is
// dispatched HONESTLY as login-gated: this box holds NO captured Doubao session
// and no verified runner implementation is wired yet, so each declared
// capability short-circuits to {ok:false, loginGated:true} WITHOUT opening a
// browser (GOAL 7 wiring: function → api → ui closure). This keeps the package's
// manifest ↔ dispatch surface IN-SYNC — no declared capability falls into the
// "unknown doubao capability" dead branch, and no fabricated result is ever
// returned. When a real implementation lands, return the working branches here.
import type { Browser } from "playwright";
import type { ChatSiteProfile } from "../profile/profile.js";
import { loginGatedResult, type GatedRunResult } from "./gated.js";

export interface DoubaoCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
}

export class DoubaoCapabilities {
  constructor(
    private readonly profile: ChatSiteProfile,
    private readonly opts: DoubaoCapabilityOptions = {},
  ) {}

  async run(capability: string, _args: Record<string, unknown> = {}): Promise<GatedRunResult> {
    switch (capability) {
      case "doubao_chat":
        return loginGatedResult(this.profile.id, capability);
      case "doubao_image-generation":
        return loginGatedResult(this.profile.id, capability);
      case "doubao_video-generation":
        return loginGatedResult(this.profile.id, capability);
      case "doubao_web-search":
        return loginGatedResult(this.profile.id, capability);
      case "doubao_deep-research":
        return loginGatedResult(this.profile.id, capability);
      case "doubao_code-interpreter":
        return loginGatedResult(this.profile.id, capability);
      case "doubao_canvas":
        return loginGatedResult(this.profile.id, capability);
      case "doubao_document-analysis":
        return loginGatedResult(this.profile.id, capability);
      case "doubao_audio-voice":
        return loginGatedResult(this.profile.id, capability);
      case "doubao_writing":
        return loginGatedResult(this.profile.id, capability);
      case "doubao_ppt-generation":
        return loginGatedResult(this.profile.id, capability);
      case "doubao_search-images":
        return loginGatedResult(this.profile.id, capability);
      default:
        return { capability, ok: false, data: undefined, error: `unknown doubao capability: ${capability}` };
    }
  }

  async close(): Promise<void> {
    // login-gated runners never open a browser
  }
}
