// Shared honest login-gated dispatch for capability packages that have NO
// captured session and NO verified runner implementation yet. Every capability
// such a package declares is dispatched to a {ok:false, loginGated:true}
// short-circuit — NEVER a fabricated success, NEVER a browser launch, NEVER a
// dead "unknown <site> capability" fall-through. This is the same posture the
// araprat posting caps use (src/capabilities/araprat.ts loginGated()), lifted
// into one helper so every scaffolded package keeps its manifest ↔ dispatch
// surface IN-SYNC (GOAL 7: function → api → ui closure).
//
// These runners exist so `/capability/<site>` and GET /registry can honestly
// serve the package's declared surface BEFORE a live round-trip is recorded.
// The moment a real implementation lands for a site, return the capabilities
// from switch branches here — do not leave them gated once they work.

export interface GatedResult {
  capability: string;
  ok: boolean;
  data: undefined;
  error: string;
  /** Honest marker: no captured session exists; the recipe is shipped but not executable. */
  loginGated: boolean;
  /** Pointer to the missing precondition so a human caller knows what to do. */
  note?: string;
}

/** The runner's dead-branch default (a capability out of the manifest). NOT login-gated. */
export interface GatedUnknownResult {
  capability: string;
  ok: false;
  data: undefined;
  error: string;
}

/** Everything a gated runner may return: an honest login-gated short-circuit or the unknown default. */
export type GatedRunResult = GatedResult | GatedUnknownResult;

/** Build the honest login-gated result for an unwired capability. */
export function loginGatedResult(siteId: string, capability: string): GatedResult {
  return {
    capability,
    ok: false,
    data: undefined,
    error:
      `login-required: ${capability} needs an authorized captured ${siteId} session ` +
      `(ui2api profile capture <url> --login first); recipe shipped, not yet executable`,
    loginGated: true,
  };
}