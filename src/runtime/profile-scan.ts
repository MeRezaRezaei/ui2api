// OS-wide Chrome profile scanner + checkbox-import module.
//
// Scans every Linux user's home directory (plus /root) for Chrome/Chromium
// profile roots, indexes which sites have stored cookies across all discovered
// profiles, and lets the caller selectively import site snapshots into the
// identity-keyed vault — the "checkbox indexing" UX described in VERBATIM.md.
import { readdirSync, existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ingestProfile, detectProfileIdentity } from "./profile-ingest.js";
import { saveAccountSnapshot, accountSnapshotPath, slugifyIdentity, slugCollision, snapshotHasAuth } from "./session-store.js";
import { siteHostCatalog } from "../prompt/registry.js";
import type { IngestResult } from "./profile-ingest.js";

// --- Constants ---

/**
 * Config subpaths under every home directory that may hold a Chrome profile.
 *
 * `.config/ui2api-chrome` is the one this project CREATES for itself
 * (`scripts/ops/provision-ui2api-user.sh`) and the one `chrome-owner.ts` ranks
 * FIRST in `PROFILE_CANDIDATES` — the profile the daemon actually drives. The
 * OS-wide scanner did not walk it, so the operator's real point-of-use sign-ins
 * were invisible to `profile scan` / `profile add-all`. It was masked only by an
 * accident: `/home/ui2api/.config/google-chrome` also happens to exist, so the
 * scan found *a* profile for that user and nothing looked wrong.
 *
 * MEASURED on this box, as the owning user (`sudo -u ui2api` — as anyone else
 * the 0700 profile is EACCES and is reported as skipped, which is the honest
 * answer): `google-chrome` holds 3 known chat hosts, `ui2api-chrome` holds 2,
 * and those 2 — `gemini.google.com` and `copilot.microsoft.com` — were visible
 * to NOBODY. The bulk-login command the docs lead with silently skipped them.
 *
 * WHY WIDING THE SCAN IS SAFE HERE (the caution that made this undecided):
 * the scanner is careful about CONTENT and was only ever blind about PATHS.
 *   - `scanProfilesForSites` copies ONLY `Default/Network/Cookies` (+wal/shm) to
 *     a 0700 mkdtemp dir and reads `SELECT host_key, COUNT(*)` — it never reads
 *     a cookie name, value, or encrypted_value, and the copy is removed in a
 *     `finally` (`withCopyCookiesForReading`).
 *   - `importSiteSnapshot` → `ingestProfile` is already hardened for the
 *     credential class: 0700 mkdtemp, 0600 chmod on both the cookie DB and the
 *     `Local State` os_crypt key, target-host filtering, and a `finally` sweep
 *     (`copyProfileForReading`, whose header calls the copies "decrypted-
 *     credential material").
 *   - The added profile is the SAME DATA CLASS as one already scanned
 *     (`google-chrome`, owned by the same user, holding the same kind of site
 *     cookies). Nothing new is readable that was not already readable.
 *   - It is ui2api's OWN profile, created by this project's provisioning — not a
 *     third party's.
 *   - Reading a profile a running Chrome holds open is precisely what
 *     `copyCookiesForReading` exists for (Chrome locks the live DB).
 * The residual risk is not "a credential gets scanned" — it is that a snapshot
 * captured from the point-of-use profile lands in the vault under the detected
 * identity. That is the documented purpose of `profile add-all`, the vault is
 * 0600 and gitignored, and the same is already true of `google-chrome`.
 *
 * WHAT WOULD HAVE MADE IT UNSAFE: a profile whose contents the scan dumps
 * wholesale, or one outside a home directory the operator does not own. Neither
 * applies. The list is walked per-home-directory only, and `isProfileRoot`
 * requires a real profile (`Local State` + a `Default`/`Profile N`), so a stray
 * directory is not picked up.
 *
 * `test/posture-scan-truth.test.ts` fails LOUD if `chrome-owner.ts` ever ranks a
 * profile dir this list does not walk — the drift is made impossible to repeat
 * silently rather than fixed once and forgotten. That file was NAMED here for
 * years before it existed (the second instance of this repo's own "a pin nobody
 * counts" defect, after `test/chrome-profile-path-truth`); it is real now.
 *
 * AND IT EARNED ITS PLACE THE FIRST TIME IT RAN. It was RED on creation:
 * `PROFILE_CANDIDATES` ranks four dirs (`ui2api-chrome`, `google-chrome`,
 * `chromium`, `chrome`) and this list walked three of them — `chrome` was
 * missing. `resolveChromeOwner()` picks the first ranked dir that EXISTS and
 * holds a profile, so on a box with a real `.config/chrome` and no
 * `.config/ui2api-chrome`, the resolver would drive `.config/chrome` while
 * `profile scan` / `profile add-all` — the bulk-login command the README leads
 * with — skipped it silently. Same blindness as the `ui2api-chrome` case above,
 * one dir further out. `.config/chrome` is a defensive fallback name rather than
 * Google's usual `.config/google-chrome`, but "we have never seen it" is not a
 * reason to leave the point of use unscanned, and it is the same data class as
 * the other five entries: the user's OWN config dir, gated by the same
 * `isProfileRoot` (real `Local State` + `Default`/`Profile N`), read under the
 * same precautions documented above.
 */
const CANDIDATE_SUBPATHS = [
  ".config/google-chrome",
  ".config/chromium",
  ".config/google-chrome-beta",
  ".config/Chromium",
  ".config/Google/Chrome",
  // This project's own point-of-use profile (chrome-owner.ts ranks it first).
  ".config/ui2api-chrome",
  // chrome-owner.ts's fourth ranked candidate — see the gate finding above.
  ".config/chrome",
] as const;

/**
 * Hosts that are OURS, but that no site in this build declares.
 *
 * POLICY, not derivation — and kept separate from the derived catalog precisely
 * so the two cannot be confused. Every entry is a host a real capture has
 * plausibly written cookies under while no manifest/profile names it: the
 * apex/parent domains a site redirects through, and two url-less packages
 * (chatglm declares no `url` at all, so nothing can derive its host).
 *
 * What would invalidate an entry: a vault with no snapshot for that host any
 * more, AND no plausible future capture — i.e. when `ui2api profile list` no
 * longer shows an account for it. Nothing forces that; the test below is what
 * fails LOUD if a derived host is missing from the union.
 */
const LEGACY_KNOWN_HOSTS: readonly string[] = [
  "chatglm.cn", // url-less package — no manifest url to derive from
  "chatglm.com", // url-less package — no manifest url to derive from
  "tencent.com", // parent of aistudio.tencent.ai / yuanbao.tencent.com
  "deepseek.com", // parent of chat.deepseek.com
  "duckduckgo.com", // parent of duck.ai
  "kimi.com", // parent of www.kimi.ai
  "v0.dev", // v0's former domain
  "aistudio.google.com", // former Google AI Studio host
  "codex.openai.com", // OpenAI Codex surface
  "inner-ai.com", // parent of app.innerai.com
  "www.aigcbest.top",
  // The three APEX domains whose site moved behind a `www.`: the catalog names
  // www.notion.so / www.doubao.com / www.blackbox.ai, and `isKnownHost` matches a
  // SUBDOMAIN of a known host, never the other way round — so dropping these
  // three would have silently marked a real apex-domain capture [UNKNOWN]. Found
  // by the monotone gate in test/runtime-derivation-truth.test.ts, which is the
  // only reason they are listed here rather than forgotten again.
  "notion.so",
  "doubao.com",
  "blackbox.ai",
];

/**
 * Every host a stored session could belong to: the DERIVED site catalog
 * (builtin profiles + installed package manifests — see `siteHostCatalog`) plus
 * the policy list above.
 *
 * This used to be 31 hosts typed by hand, with no edge to either of the two
 * places that actually know which sites exist. MEASURED drift in the typed list:
 * 10 real sites were missing (www.kimi.ai, aistudio.tencent.ai, duck.ai,
 * youtube.com, mail.google.com, v0.app, www.aparat.com, adapta.app,
 * app.innerai.com, zenmux.com), so the bulk-login command the README leads with
 * marked them `[UNKNOWN]` on a box whose cookies were sitting right there.
 * The change is MONOTONE — every host the old set knew is still known (all 11
 * old-only hosts are kept above), so no host can lose its marker; 10 gain one.
 */
const KNOWN_HOSTS: ReadonlySet<string> = new Set([...siteHostCatalog(), ...LEGACY_KNOWN_HOSTS]);

// --- Helpers ---

/** Check whether a path looks like a Chrome profile root. */
function isProfileRoot(root: string): boolean {
  if (!existsSync(join(root, "Local State"))) return false;
  if (existsSync(join(root, "Default"))) return true;
  if (existsSync(join(root, "Profile 1"))) return true;
  try {
    return readdirSync(root).some((n) => /^Profile \d+$/.test(n));
  } catch {
    return false;
  }
}

/** Derive the owning Linux user from a filesystem path. */
function owningUser(root: string): string {
  const homeMatch = root.match(/^\/home\/([^/]+)/);
  if (homeMatch) return homeMatch[1];
  if (root === "/root" || root.startsWith("/root/")) return "root";
  const home = process.env.HOME;
  if (home) {
    const hm = home.match(/^\/home\/([^/]+)/);
    if (hm && (root === home || root.startsWith(home + "/"))) return hm[1];
    if (home === "/root") return "root";
  }
  try { return userInfo().username; } catch { return "unknown"; }
}

/**
 * Normalize a raw `host_key` from the cookies table.
 * Strips leading dot, trims, lowercases, and drops hosts that are not
 * valid domain-style names.
 */
function normalizeHostKey(raw: string): string | null {
  let h = raw.trim().toLowerCase();
  if (!h) return null;
  if (h.startsWith(".")) h = h.slice(1);
  if (!h || h === "localhost") return null;
  if (h.includes("chrome-extension")) return null;
  if (!h.includes(".")) return null;
  return h;
}

/** Check whether a normalized host is a known AI chat site. */
function isKnownHost(host: string): boolean {
  if (KNOWN_HOSTS.has(host)) return true;
  for (const k of KNOWN_HOSTS) {
    if (host.endsWith("." + k)) return true;
  }
  return false;
}

/**
 * Is this host one of ours? Exported so the gate can ask the REAL question
 * ("is every site in the catalog recognised by the scanner?") instead of
 * re-deriving the host list a second time in a test, which would be the same
 * hand-typed twin this constant just stopped being.
 */
export function isKnownSiteHost(host: string): boolean {
  return isKnownHost(host);
}

/**
 * Copy the Cookies SQLite DB (and WAL/SHM) out of a Chrome profile root so it
 * can be read without the lock that a running Chrome imposes.
 * Mirrors the copy logic in profile-ingest.ts (not exported there).
 * Never throws after creating its temp dir: any failure between mkdtemp and
 * return removes the dir again, so `copyCookiesForReading` alone leaves nothing
 * behind.
 */
function copyCookiesForReading(profileRoot: string): { dbPath: string } {
  const def = join(profileRoot, "Default");
  const dbSrc = existsSync(join(def, "Network", "Cookies"))
    ? join(def, "Network", "Cookies")
    : join(def, "Cookies");
  if (!existsSync(dbSrc)) {
    throw new Error(`no chrome cookies database at ${dbSrc}`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "u2a-scan-read-"));
  const dbPath = join(tmp, "Cookies");
  try {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const src = dbSrc + suffix;
      if (existsSync(src)) cpSync(src, dbPath + suffix);
    }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { dbPath };
}

/**
 * Copy a profile's Cookies DB for reading, run `fn` with the copy path, then
 * ALWAYS remove the temp dir — even when `fn` throws. This is the finally-style
 * wrapper for the scan path: a scan leaves zero `u2a-scan-read-*` residue in
 * the tmpdir no matter what the read does.
 */
export function withCopyCookiesForReading<T>(
  profileRoot: string,
  fn: (dbPath: string) => T
): T {
  const { dbPath } = copyCookiesForReading(profileRoot);
  try {
    return fn(dbPath);
  } finally {
    rmSync(dirname(dbPath), { recursive: true, force: true });
  }
}

// Other markers in the repo's temp family: profile-ingest.ts creates
// `u2a-ingest-` (copyProfileForReading) and `u2a-ls-` (readLocalStorageFor).
// readLocalStorageFor removes its own in a finally; copyProfileForReading does
// NOT — so the import path (importSiteSnapshot below) sweeps any new dirs of
// those markers after ingestProfile returns, keeping the GOAL 9 "zero residue
// after scan+import" invariant even for upsream leaks.
const INGEST_TMP_MARKERS = ["u2a-ingest-", "u2a-ls-"] as const;

/** Names of currently-present temp dirs matching the given marker prefixes. */
function tmpDirsByMarker(prefixes: readonly string[]): Set<string> {
  try {
    const found = new Set<string>();
    for (const name of readdirSync(tmpdir())) {
      if (prefixes.some((p) => name.startsWith(p))) found.add(name);
    }
    return found;
  } catch {
    return new Set<string>();
  }
}

/**
 * Remove every temp dir matching `markers` that did not exist yet in `before`.
 * Used to sweep the upstream `u2a-ingest-`/`u2a-ls-` copies created while an
 * ingest ran. Best-effort (tmpdir is volatile) — never throws.
 */
function sweepTempDirs(before: Set<string>, markers: readonly string[]): void {
  for (const name of tmpDirsByMarker(markers)) {
    if (before.has(name)) continue;
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    } catch {
      // best effort — left a dir? the next sweep will retry it.
    }
  }
}

// --- Exported types ---

/** One entry for a discovered site across all scanned profiles. */
export interface SiteHit {
  /** Normalized host domain. */
  host: string;
  /** Sum of cookie rows for this host across all profiles. */
  cookieCount: number;
  /** List of profile root directories that contain this host. */
  profiles: string[];
  /** True when the host matches a known AI chat site. */
  known: boolean;
}

/** Result of `scanProfilesForSites`. */
export interface ProfileSiteIndex {
  /** Distinct hosts, sorted by cookieCount descending. */
  hits: SiteHit[];
  /** Per-profile breakdown of which hosts were found. */
  byProfile: Array<{ root: string; user: string; hosts: string[] }>;
  /** Profile roots that could not be read. */
  skipped: string[];
}

/** Result of `findAllChromeProfilesOnOs`. */
export interface OsScanResult {
  /** Deduplicated profile roots. */
  profiles: Array<{ root: string; user: string }>;
  /** Root paths that were skipped (unreadable). */
  skipped: string[];
}

/** Options for `importSiteSnapshot`. */
export interface ImportOptions {
  /** Profile root to ingest from (e.g. `/home/alice/.config/google-chrome`). */
  root: string;
  /** Target host to import cookies/storage for. */
  host: string;
  /** Data directory for the vault (sessions stored here). */
  dataDir: string;
  /** Override for the identity string (e.g. email). When omitted the
   *  identity is detected from the profile's Preferences. */
  identity?: string;
}

/** Return type of `importSiteSnapshot`. */
export interface ImportResult {
  host: string;
  identity: string;
  snapshotPath: string;
  ok: boolean;
  stats: {
    cookiesMatched: number;
    cookiesTotal: number;
    localStorageEntries: number;
  };
  warnings: string[];
  profileUser: string | null;
}

// --- 1. findAllChromeProfilesOnOs ---

/**
 * Scan the Linux OS for Chrome/Chromium profile roots.
 *
 * For every home directory under `/home/*`, plus `/root`, plus `$HOME`
 * (deduplicated), check five standard config subpaths for a valid profile
 * root (a directory containing `Local State` + a `Default` / `Profile N`
 * subdirectory).
 *
 * @param opts.extraRoots — additional directories treated as candidate profile
 *   roots directly (no subpath joining).  Useful for tests and custom paths.
 * @returns Deduplicated profile roots with the owning Linux user, sorted by
 *   user then root path, plus a list of skipped (unreadable) paths.
 */
export function findAllChromeProfilesOnOs(
  opts?: { extraRoots?: string[] }
): OsScanResult {
  const rootSet = new Set<string>();
  const skipped: string[] = [];

  // Collect unique home directories to scan.
  const scanRoots = new Set<string>();
  const home = process.env.HOME;
  if (home) scanRoots.add(home);
  scanRoots.add("/root");
  try {
    for (const ent of readdirSync("/home", { withFileTypes: true })) {
      if (ent.isDirectory()) scanRoots.add(join("/home", ent.name));
    }
  } catch {
    skipped.push("/home");
  }

  // Check the five candidate config subpaths under each home directory.
  for (const scanRoot of scanRoots) {
    for (const cand of CANDIDATE_SUBPATHS) {
      const root = join(scanRoot, cand);
      try {
        if (isProfileRoot(root)) rootSet.add(root);
      } catch {
        skipped.push(root);
      }
    }
  }

  // Extra roots supplied directly.
  for (const extra of opts?.extraRoots ?? []) {
    if (!extra) continue;
    try {
      if (isProfileRoot(extra)) rootSet.add(extra);
    } catch {
      skipped.push(extra);
    }
  }

  const profiles = [...rootSet].map((root) => ({ root, user: owningUser(root) }));
  profiles.sort((a, b) => a.user.localeCompare(b.user) || a.root.localeCompare(b.root));
  return { profiles, skipped };
}

// --- 2. scanProfilesForSites ---

/**
 * Index which sites have cookies across the given Chrome profile roots.
 *
 * Each profile's Cookies SQLite DB is copied to a temp file and queried for
 * `host_key` counts.  Hosts are normalized (lowercased, leading dot stripped,
 * empty / localhost / no-dot / chrome-extension entries dropped) and aggregated
 * into one {@link SiteHit} per distinct host.
 *
 * @param profiles — array of `{ root, user }` as returned by
 *   {@link findAllChromeProfilesOnOs}.
 * @returns A {@link ProfileSiteIndex} with hits sorted by cookie count
 *   descending, a per-profile breakdown, and a list of unreadable profiles.
 */
export function scanProfilesForSites(
  profiles: Array<{ root: string; user: string }>
): ProfileSiteIndex {
  const hostMap = new Map<string, { count: number; roots: Set<string> }>();
  const byProfile: ProfileSiteIndex["byProfile"] = [];
  const skipped: string[] = [];

  for (const p of profiles) {
    let hostCounts: Map<string, number>;
    try {
      // withCopyCookiesForReading removes the u2a-scan-read- copy in a finally,
      // whether the read succeeds or throws — zero residue per profile.
      hostCounts = withCopyCookiesForReading(p.root, (dbPath) => {
        const counts = new Map<string, number>();
        const db = new DatabaseSync(dbPath, { readBigInts: true });
        try {
          const rows = db
            .prepare("SELECT host_key, COUNT(*) AS n FROM cookies GROUP BY host_key")
            .all() as Array<{ host_key: string; n: bigint | number }>;
          for (const r of rows) {
            const h = normalizeHostKey(r.host_key);
            if (!h) continue;
            counts.set(h, (counts.get(h) ?? 0) + Number(r.n));
          }
        } finally {
          db.close();
        }
        return counts;
      });
    } catch {
      skipped.push(p.root);
      continue;
    }

    for (const [host, count] of hostCounts) {
      const existing = hostMap.get(host) ?? { count: 0, roots: new Set<string>() };
      existing.count += count;
      existing.roots.add(p.root);
      hostMap.set(host, existing);
    }

    const hosts = [...hostCounts.keys()].sort();
    if (hosts.length > 0) {
      byProfile.push({ root: p.root, user: p.user, hosts });
    }
  }

  const hits: SiteHit[] = [...hostMap.entries()]
    .map(([host, v]) => ({
      host,
      cookieCount: v.count,
      profiles: [...v.roots],
      known: isKnownHost(host),
    }))
    .sort((a, b) => b.cookieCount - a.cookieCount || a.host.localeCompare(b.host));

  byProfile.sort((a, b) => a.root.localeCompare(b.root));

  return { hits, byProfile, skipped };
}

// --- 3. importSiteSnapshot ---

/**
 * Import a single site's cookies + storage from a Chrome profile into the
 * identity-keyed vault.
 *
 * Identity is determined in this order:
 * 1. `opts.identity` (explicit override, when non-empty)
 * 2. `detectProfileIdentity(root).best` (email or display name from prefs)
 * 3. `{owningUser}-default` fallback — never saves under an empty slug.
 *
 * GOAL 49 write truth gate: a fully anonymous import (zero cookies matched AND
 * zero localStorage entries) is REFUSED — nothing is written to the vault, the
 * returned `snapshotPath` is empty, and `ok` is false. Callers must check `ok`
 * (false also when no cookies matched a localStorage-carrying site, meaning
 * the snapshot may still be usable — `localStorage` can carry the auth).
 *
 * @throws When `ingestProfile` itself throws (e.g. no Cookies DB at all).
 */
export async function importSiteSnapshot(
  opts: ImportOptions
): Promise<ImportResult> {
  // ingestProfile talks to profile-ingest.ts, whose copyProfileForReading
  // creates a u2a-ingest- dir it never removes. Sweep any NEW ingest-marker dirs
  // after it returns (or throws), so the GOAL 9 "zero residue after scan+import"
  // invariant holds across module boundaries.
  const beforeIngest = tmpDirsByMarker(INGEST_TMP_MARKERS);
  let ingest: IngestResult;
  try {
    ingest = await ingestProfile({
      profileDir: opts.root,
      targetHost: opts.host,
    });
  } finally {
    sweepTempDirs(beforeIngest, INGEST_TMP_MARKERS);
  }

  const { snapshot, stats, warnings: ingestWarnings } = ingest;

  const detected = detectProfileIdentity(opts.root).best;
  const user = owningUser(opts.root);
  const override = opts.identity && opts.identity.trim() ? opts.identity.trim() : null;
  let identity = override ?? detected;
  if (!identity || !identity.trim()) identity = `${user}-default`;

  const slug = slugifyIdentity(identity);
  // GOAL 49 write truth gate: compute `ok` BEFORE any write. A fully anonymous
  // import (zero cookies matched AND zero localStorage entries) is REFUSED at
  // the write seam — the vault/index would otherwise surface it as a valid
  // account ("skipped-no-auth" rows persisting as listed accounts). Refusal
  // means NOTHING is written: no snapshot, no accounts.json entry — and the
  // returned snapshotPath is empty ("refused — nothing to save").
  // ...and the gate is on the SNAPSHOT, not on the stats. MEASURED defect
  // (ROUND N+99): `stats.cookiesMatched > 0` is NOT the same question as "does
  // the artifact I am about to write carry auth". A decrypt-limited cookie
  // (Chrome's "portal v20" — the value is matched to the host but NOT
  // extractable) counts as a MATCH, so `ok` was true, the write proceeded, and
  // the snapshot landed with `cookies: []` — silently OVERWRITING a previously
  // good per-account snapshot with an empty one. Measured live: after
  // `profile add-all --known`, `www.aparat.com` and `chatgpt.com` both held
  // 210-byte/204-byte snapshots with `cookies: []` and `localStorage: []`, and
  // `www.aparat.com` is a site this repo records as live-verified with three
  // working capabilities. The gate was measuring the wrong object: the stats
  // describe the READ, the snapshot is the WRITE.
  const ok = snapshotHasAuth(snapshot);
  const warnings = [...ingestWarnings];
  if (!ok) {
    warnings.push(
      `skipped-no-auth (nothing to save) — the snapshot carries no cookies and no ` +
        `localStorage (${stats.cookiesMatched} matched of ${stats.cookiesTotal} cookies, ` +
        `${stats.localStorageEntries} localStorage entries; a matched-but-undecryptable ` +
        `cookie does NOT count as auth)`
    );
    return {
      host: opts.host,
      identity,
      snapshotPath: "",
      ok: false,
      stats: {
        cookiesMatched: stats.cookiesMatched,
        cookiesTotal: stats.cookiesTotal,
        localStorageEntries: stats.localStorageEntries,
      },
      warnings,
      profileUser: user,
    };
  }
  // GOAL 50 account-INDEX collision gate: a same-slug DIFFERENT identity
  // already in the vault is REFUSED (nothing overwritten) with the named
  // verdict — never silently destroy the existing account. Same identity
  // string = latest-wins re-capture, NOT a collision.
  const collision = slugCollision(opts.dataDir, opts.host, identity);
  if (collision) {
    warnings.push(`slug-collision (NOT overwritten — account "${collision.slug}" already exists as "${collision.identity}")`);
    return {
      host: opts.host,
      identity,
      snapshotPath: "",
      ok: false,
      stats: {
        cookiesMatched: stats.cookiesMatched,
        cookiesTotal: stats.cookiesTotal,
        localStorageEntries: stats.localStorageEntries,
      },
      warnings,
      profileUser: user,
    };
  }
  saveAccountSnapshot(opts.dataDir, opts.host, identity, snapshot, {
    source: "import",
    profileDir: opts.root,
  });

  if (stats.cookiesMatched === 0) {
    warnings.push("no cookies matched — localStorage may carry the auth");
  }

  return {
    host: opts.host,
    identity,
    snapshotPath: accountSnapshotPath(opts.dataDir, opts.host, slug),
    ok,
    stats: {
      cookiesMatched: stats.cookiesMatched,
      cookiesTotal: stats.cookiesTotal,
      localStorageEntries: stats.localStorageEntries,
    },
    warnings,
    profileUser: user,
  };
}

// --- 4. renderCheckboxList ---

/**
 * Render a list of {@link SiteHit} as numbered checkbox-style lines suitable
 * for a terminal or CLI prompt.
 *
 * Format example:
 * ```
 * [ ] 1. gemini.google.com  (2 profiles, 47 cookies)  [KNOWN]
 * [ ] 2. random-site.com  (1 profile, 3 cookies)
 * ```
 */
export function renderCheckboxList(hits: SiteHit[]): string {
  return hits
    .map((h, i) => {
      const profileNoun = h.profiles.length === 1 ? "profile" : "profiles";
      const known = h.known ? "  [KNOWN]" : "";
      return `[ ] ${i + 1}. ${h.host}  (${h.profiles.length} ${profileNoun}, ${h.cookieCount} cookies)${known}`;
    })
    .join("\n");
}
