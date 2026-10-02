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

/** The config dir every candidate profile lives under. EXPORTED so a consumer
 *  derives `<config>/<candidate>` instead of restating the string `.config` —
 *  which is how a second spelling of the whole path appears in the first place. */
export const CHROME_CONFIG_DIR = ".config";

/** Candidate profile dirs inside a user's config dir, most specific first.
 *  EXPORTED (GOAL 177) so every other site that needs this path DERIVES it from
 *  this one ranked list. See `chromeOwnerRelativeProfilePath()` below. */
export const PROFILE_CANDIDATES: readonly string[] = [
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

/**
 * THE ONE passwd LOOKUP, and it is NSS (`getent passwd`), not `/etc/passwd`.
 *
 * Recorded decision, with its reasoning, because the two answers used to
 * coexist and this file had to pick one:
 *
 *   * `/etc/passwd` is only the FIRST file of the passwd DATABASE. On any host
 *     where accounts come from LDAP/SSSD/other NSS (the corporate/per-customer
 *     boxes this env knob exists for — `UI2API_CHROME_USER` names a per-customer
 *     service account), a real account has NO `/etc/passwd` line at all.
 *   * The two implementations disagreed exactly there. The launch guard
 *     (`isChromeOwnerProcess`, browser.ts) read `/etc/passwd`, got no line, and
 *     answered "-1"; the readiness gate (`runningAsOwner`, right here) read
 *     `getent`, got the REAL uid, and answered "yes, this is the owner". So the
 *     guard REFUSED while the gate said the same running process WAS the owner —
 *     two owners of one fact, stating opposite things about one process.
 *   * `getent` is what `id -u` and libc itself use, so it agrees with the
 *     kernel's notion of "who is this user" on every host, and it is equally
 *     unspoofable by an environment variable: nothing an operator can set in
 *     `UI2API_*` changes WHICH passwd database `getent` reads. (It is resolved
 *     through `PATH`, so a hostile `PATH` could shadow the binary — accepted and
 *     recorded, because the alternative silently refuses to recognise an owner
 *     that demonstrably exists, which is the fail-closed regression this file's
 *     whole design exists to avoid.)
 *
 * `test/chrome-owner-uid-single-owner.test.ts` pins that this stays the ONLY
 * place the passwd DATABASE is read: a second reader is a second answer, whether
 * it is after the uid or after the mere existence of the name.
 */
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

/**
 * ⛔ THE OTHER HALF of the one passwd lookup: "does this user exist" — asked of
 * the SAME database, so it is answered HERE and nowhere else.
 *
 * FOLDED HERE DELIBERATELY (this was a fourth reader, in
 * `xhost-capture.ts`'s `userExists()`, and it was left alone for one fold
 * before being folded for a reason that was MEASURED, not assumed):
 *
 *   * it is not a second answer to a second question — it is a second answer to
 *     the SAME question. "Does `ui2api` exist" is a question about the passwd
 *     database, and this file already owns that database;
 *   * the two readers were consumed by ONE readiness check, so a disagreement
 *     was observable rather than theoretical. `browserHomeCheck()`
 *     (src/runtime/requirements.ts) asks `userExists(user)` and then reads
 *     `resolveChromeOwner().missing`, which is `passwdEntry(user) === null`.
 *     The old `userExists` FELL BACK to a `/home/<user>` probe whenever the
 *     lookup failed, so on a box where the account is gone (or served by an NSS
 *     the local `getent` cannot see) but the home directory survives — the
 *     ordinary shape of a deleted or half-provisioned account — the SAME check
 *     printed `ui2api OS user present` AND `no such user: ui2api`. Two verdicts
 *     about one account, in one output, from one module's two readers.
 *
 * The `/home/<user>` fallback did NOT move with it, on purpose: it is not a
 * passwd-database question at all, it is the login-UX data dir asking whether
 * there is a home to write under. `xhost-capture.ts` keeps that policy and adds
 * it to this answer; this module keeps the fact.
 *
 * DERIVED, never re-read: this is `passwdEntry(user) !== null`, not a second
 * `getent` spawn. `test/chrome-owner-uid-single-owner.test.ts` pins both halves
 * — rule R3 (no second passwd-database reader anywhere in `src/`) and rule R5
 * (this function exists, is exported, and the consumer derives it).
 */
export function passwdUserExists(user: string): boolean {
  return passwdEntry(user) !== null;
}

/** The user that owns the Chrome we drive. Data, not a hardcode. */
export function chromeOwnerUser(): string {
  return (process.env[CHROME_USER_ENV] ?? "").trim() || DEFAULT_CHROME_USER;
}

/**
 * "This name resolved to no uid" — the sentinel. It is a STRING on purpose, not
 * `Number(-1)`, so it is visibly a marker and not a uid the kernel could hand
 * out. A real process's `process.getuid()` is never `-1` (uid 0 is root), so the
 * sentinel can only ever be matched by an injected one; that is exactly what
 * `test/chrome-owner-launch-refusal.test.ts` drives, and it is why the sentinel
 * is not a quiet admission path.
 */
export const CHROME_OWNER_UID_UNRESOLVED = "-1";

const ownerUidCache = new Map<string, string>();

/**
 * THE owner's uid, resolved HERE and nowhere else. Cached per name because this
 * is on the launch path: the previous `/etc/passwd` implementation cached its
 * read for the same reason, and `getent` costs a process spawn rather than a file
 * read, so the cache matters MORE here, not less.
 *
 * Only the UID is cached. `passwdEntry()` itself stays uncached, so a home
 * directory created after this process started is still SEEN by
 * `resolveChromeOwner()` — caching the whole entry would have traded a stale-uid
 * bug for a stale-home bug, which is the fail-closed regression the guard must
 * never introduce on a correctly-configured box.
 *
 * The cost of that choice is ONE extra lookup per name per process (the caller
 * usually wants `home` too, and it must stay fresh); it is not an optimisation to
 * hand this function an already-resolved entry. Doing that would put a second
 * reader of the uid back in `resolveChromeOwner`, which is the defect.
 */
export function chromeOwnerUid(user: string = chromeOwnerUser()): string {
  const cached = ownerUidCache.get(user);
  if (cached !== undefined) return cached;
  const raw = passwdEntry(user)?.uid ?? "";
  const uid = /^\d+$/.test(raw) ? raw : CHROME_OWNER_UID_UNRESOLVED;
  ownerUidCache.set(user, uid);
  return uid;
}

/**
 * ⛔ THE SINGLE OWNER of "is this process the chrome owner?" — one comparison,
 * derived everywhere else.
 *
 * Before this existed there were THREE implementations of the same question:
 * the launch guard (browser.ts, reading `/etc/passwd`), the readiness gate
 * (`runningAsOwner` below, reading `getent`) and the daemon's sudo decision
 * (`isThisProcessOwner`, chrome-daemon.ts, reading `getent` a second time). Any
 * two of them could answer differently about ONE running process — and they did,
 * on any host whose owner account lives in NSS rather than `/etc/passwd` (see
 * `passwdEntry` above). Three answers to one question is the defect; this is the
 * one answer.
 *
 * FAIL CLOSED, deliberately, on the two shapes that used to leak:
 *   * `uid` missing/undefined (a non-POSIX process, no `getuid`) is NOT the owner
 *     — "I cannot prove I am" is not "I am".
 *   * a THROWING uid read is the caller's try/catch to make, because the read
 *     happens at the call site; every call site in `src/` does exactly that.
 *   * an owner name that resolves to no uid can only match uid `-1`, which no
 *     real process has — so a MISSING owner user is never admitted, and the
 *     sentinel never becomes a bypass.
 */
export function isUidTheChromeOwner(
  uid: number | string | undefined | null,
  user: string = chromeOwnerUser(),
): boolean {
  if (uid === undefined || uid === null) return false;
  return String(uid) === chromeOwnerUid(user);
}

/** The resolved owner, with everything a caller needs to report honestly. */
export function resolveChromeOwner(): ChromeOwner {
  const user = chromeOwnerUser();
  const entry = passwdEntry(user);
  const home = entry?.home || null;

  let profile: string | null = null;
  let profileExistsButUnreadable = false;
  if (home) {
    const configDir = join(home, CHROME_CONFIG_DIR);
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

  // DERIVED, never re-derived: the same one comparison the launch guard and the
  // daemon's sudo decision use. Reading `entry.uid` here as well would be the
  // third answer to one question.
  let runningAsOwner = false;
  try {
    runningAsOwner = isUidTheChromeOwner(process.getuid?.(), user);
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
      `${PROFILE_CANDIDATES.map((c) => join(home, CHROME_CONFIG_DIR, c)).join(", ")}. ` +
      `That is the only required setup: run Chrome as ${user} once (or via \`su - ${user}\` / \`sudo -u ${user}\`), ` +
      `log in (xhost + if you need to log in from your desktop), and the profile appears.`;

  return { user, home, profile, runningAsOwner, missing, profileExistsButUnreadable };
}

/** The path to hand Chrome as --user-data-dir, when one exists. */
export function chromeOwnerProfilePath(): string | undefined {
  return resolveChromeOwner().profile ?? undefined;
}

/**
 * THE PROFILE PATH, RELATIVE TO THE OWNER'S HOME, DERIVED FROM ITS RANKED LIST —
 * `.config/ui2api-chrome` on this box.
 *
 * GOAL 177, and this function exists because of a measured failure. Two spellings
 * of one path coexisted: `.config/ui2api-chrome` (the provision script, the
 * systemd unit, the profile scanner) and `.ui2api-chrome` (the readiness gate),
 * and the gate was therefore probing a directory nothing provisions or launches.
 * Every consumer that restated the string is a copy that can drift; this is the
 * one place it is computed.
 *
 * A shell script and a systemd unit cannot import a TS module, so for those the
 * string is necessarily restated — and that is exactly why `test/
 * chrome-profile-path-truth.test.ts` COMPARES each restatement against this
 * derived value instead of trusting either. Derivation where it is possible,
 * comparison where it is not.
 */
export function chromeOwnerRelativeProfilePath(): string {
  return join(CHROME_CONFIG_DIR, PROFILE_CANDIDATES[0]);
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
