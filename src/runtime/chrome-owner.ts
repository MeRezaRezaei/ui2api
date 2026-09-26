import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * THE CHROME POINT OF USE — the single most important operational fact about
 * this project, and the one most often gotten wrong.
 *
 * ui2api drives a Chrome that belongs to a DEDICATED LINUX USER, not to the
 * person sitting at the keyboard. On this box that user is `ui2api` (uid 1010,
 * home `/home/ui2api`), and its Chrome lives at
 * `/home/ui2api/.config/google-chrome` (plus a dedicated
 * `/home/ui2api/.config/ui2api-chrome`).
 *
 * WHY A DEDICATED USER IS THE ONLY WAY:
 *  - Your interactive browser CANNOT be driven. Chrome refuses to let another
 *    process attach to the browser you are personally using, and
 *    `--remote-debugging-port` on a live profile is refused for the same reason.
 *  - The dedicated user's Chrome works fine — including headless. There is no
 *    wall.
 *  - Therefore the ONLY setup step is: that user's Chrome info must EXIST. Once
 *    it does, everything else works. "Writing the Chrome info into that user"
 *    IS the integration.
 *
 * The owner is data, not a hardcode: `UI2API_CHROME_USER` names it, so the same
 * build works for `ui2api`, a per-customer service account, or CI.
 *
 * LOGIN, without copying anyone's profile: run that user's Chrome with
 * `xhost +` and log in to it directly. The credentials are then ingested by the
 * normal profile-ingest path exactly as before. Copying a whole profile across
 * users is the alternative, and it is the fragile one.
 */

export const CHROME_USER_ENV = "UI2API_CHROME_USER";
/** The dedicated user on this box. */
export const DEFAULT_CHROME_USER = "ui2api";

/** Candidate profile dirs inside a user's config dir, most specific first. */
const PROFILE_CANDIDATES = [
  "ui2api-chrome", // ui2api's own dedicated dir, if present
  "google-chrome",
  "chromium",
  "chrome",
];

export interface ChromeOwner {
  user: string;
  home: string | null;
  /** the profile dir we would actually use, or null when none exists yet */
  profile: string | null;
  /**
   * MEASURED: the profile dir is 0700 and owned by the chrome user, so a
   * readiness check run by ANYONE ELSE cannot read it — and used to report
   * "no profile" i.e. FAIL, even when the daemon is running perfectly. That is a
   * FALSE NEGATIVE that would send an operator chasing a healthy setup. This
   * says "exists but you may not inspect it", which is not a failure.
   */
  profileExistsButUnreadable: boolean;
  /** true when the process is ALREADY running as the chrome owner */
  runningAsOwner: boolean;
  /** why there is no profile, when there is none — named, never silent */
  missing: string | null;
}

function passwdEntry(user: string): { home: string; uid: string } | null {
  try {
    const out = execFileSync("getent", ["passwd", user], { encoding: "utf8", timeout: 5000 }).trim();
    if (!out) return null;
    const parts = out.split(":");
    return { uid: parts[2] ?? "", home: parts[5] ?? "" };
  } catch {
    return null;
  }
}

/** The user that owns the Chrome we drive. Data, not a hardcode. */
export function chromeOwnerUser(): string {
  return (process.env[CHROME_USER_ENV] ?? "").trim() || DEFAULT_CHROME_USER;
}

/** The resolved owner, with everything a caller needs to report honestly. */
export function resolveChromeOwner(): ChromeOwner {
  const user = chromeOwnerUser();
  const entry = passwdEntry(user);
  const home = entry?.home || null;

  let profile: string | null = null;
  let profileExistsButUnreadable = false;
  if (home) {
    const configDir = join(home, ".config");
    for (const cand of PROFILE_CANDIDATES) {
      const p = join(configDir, cand);
      try {
        if (existsSync(p) && statSync(p).isDirectory()) {
          // A real Chrome profile is not an empty dir: it has a Default profile.
          const hasProfile =
            readdirSync(p).some((e) => e === "Default" || e === "Profile 1" || e === "Local State");
          if (hasProfile) {
            profile = p;
            break;
          }
        }
      } catch (e) {
        // The dir EXISTS but we may not list it (0700, owned by the chrome
        // user). That is not "no profile" — record it honestly.
        if ((e as NodeJS.ErrnoException)?.code === "EACCES") {
          profileExistsButUnreadable = true;
          profile = p;
          break;
        }
        /* otherwise: unreadable for another reason — try the next candidate */
      }
    }
  }

  let runningAsOwner = false;
  try {
    runningAsOwner = process.getuid?.() === Number(entry?.uid ?? -1);
  } catch {
    runningAsOwner = false;
  }

  let missing: string | null = null;
  if (profileExistsButUnreadable) missing = null; // present, just not ours to read
  if (!entry) missing = `no such user: ${user} (create it, or set ${CHROME_USER_ENV})`;
  else if (!home) missing = `user ${user} has no home directory`;
  else if (!profile)
    missing =
      `no Chrome profile found for ${user} — expected one of ` +
      `${PROFILE_CANDIDATES.map((c) => join(home, ".config", c)).join(", ")}. ` +
      `That is the only required setup: run Chrome as ${user} once (or via \`su - ${user}\` / \`sudo -u ${user}\`), ` +
      `log in (xhost + if you need to log in from your desktop), and the profile appears.`;

  return { user, home, profile, runningAsOwner, missing, profileExistsButUnreadable };
}

/** The path to hand Chrome as --user-data-dir, when one exists. */
export function chromeOwnerProfilePath(): string | undefined {
  return resolveChromeOwner().profile ?? undefined;
}

/**
 * A one-line, honest readiness statement for the Chrome point of use.
 * Used by `ui2api requirements`, /status, and the docs.
 */
export function chromeOwnerStatus(): { ready: boolean; line: string } {
  const o = resolveChromeOwner();
  if (o.missing) return { ready: false, line: `chrome-owner ${o.user}: NOT READY — ${o.missing}` };
  const as = o.runningAsOwner ? "running as that user" : `process is not ${o.user}`;
  const vis = o.profileExistsButUnreadable ? " (present, 0700 — not readable by this user, which is correct)" : "";
  return { ready: true, line: `chrome-owner ${o.user}: ${o.profile} (${as})${vis}` };
}

/** Best-effort home for the owner, for callers that need to write into it. */
export function chromeOwnerHome(): string {
  return resolveChromeOwner().home ?? homedir();
}
