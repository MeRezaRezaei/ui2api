// OS-wide Chrome profile scanner + checkbox-import module.
//
// Scans every Linux user's home directory (plus /root) for Chrome/Chromium
// profile roots, indexes which sites have stored cookies across all discovered
// profiles, and lets the caller selectively import site snapshots into the
// identity-keyed vault — the "checkbox indexing" UX described in VERBATIM.md.
import { readdirSync, existsSync, mkdtempSync, cpSync } from "node:fs";
import { userInfo } from "node:os";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ingestProfile, detectProfileIdentity } from "./profile-ingest.js";
import { saveAccountSnapshot, accountSnapshotPath, slugifyIdentity } from "./session-store.js";
import type { IngestResult } from "./profile-ingest.js";

// --- Constants ---

const CANDIDATE_SUBPATHS = [
  ".config/google-chrome",
  ".config/chromium",
  ".config/google-chrome-beta",
  ".config/Chromium",
  ".config/Google/Chrome",
] as const;

const KNOWN_HOSTS: ReadonlySet<string> = new Set([
  "gemini.google.com",
  "chatgpt.com",
  "claude.ai",
  "copilot.microsoft.com",
  "www.kimi.com",
  "yuanbao.tencent.com",
  "huggingface.co",
  "www.perplexity.ai",
  "www.google.com",
  "poe.com",
  "deepseek.com",
  "venice.ai",
  "grok.com",
  "aistudio.google.com",
  "chat.deepseek.com",
  "doubao.com",
  "duckduckgo.com",
  "v0.dev",
  "notion.so",
  "manus.im",
  "chatglm.cn",
  "aistudio.xiaomimimo.com",
  "conol.ai",
  "t3.chat",
  "codex.openai.com",
  "copilot.cloud.microsoft",
  "blackbox.ai",
  "www.aigcbest.top",
  "inner-ai.com",
  "tencent.com",
  "chatglm.com",
]);

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
 * Copy the Cookies SQLite DB (and WAL/SHM) out of a Chrome profile root so it
 * can be read without the lock that a running Chrome imposes.
 * Mirrors the copy logic in profile-ingest.ts (not exported there).
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
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const src = dbSrc + suffix;
    if (existsSync(src)) cpSync(src, dbPath + suffix);
  }
  return { dbPath };
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
    let dbPath: string;
    try {
      ({ dbPath } = copyCookiesForReading(p.root));
    } catch {
      skipped.push(p.root);
      continue;
    }

    const hostCounts = new Map<string, number>();
    try {
      const db = new DatabaseSync(dbPath, { readBigInts: true });
      try {
        const rows = db
          .prepare("SELECT host_key, COUNT(*) AS n FROM cookies GROUP BY host_key")
          .all() as Array<{ host_key: string; n: bigint | number }>;
        for (const r of rows) {
          const h = normalizeHostKey(r.host_key);
          if (!h) continue;
          hostCounts.set(h, (hostCounts.get(h) ?? 0) + Number(r.n));
        }
      } finally {
        db.close();
      }
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
 * The snapshot is always saved; callers must check `ok` (false when no cookies
 * matched the target host, meaning the user is probably logged out).
 *
 * @throws When `ingestProfile` itself throws (e.g. no Cookies DB at all).
 */
export async function importSiteSnapshot(
  opts: ImportOptions
): Promise<ImportResult> {
  const { snapshot, stats, warnings: ingestWarnings } = await ingestProfile({
    profileDir: opts.root,
    targetHost: opts.host,
  });

  const detected = detectProfileIdentity(opts.root).best;
  const user = owningUser(opts.root);
  const override = opts.identity && opts.identity.trim() ? opts.identity.trim() : null;
  let identity = override ?? detected;
  if (!identity || !identity.trim()) identity = `${user}-default`;

  const slug = slugifyIdentity(identity);
  saveAccountSnapshot(opts.dataDir, opts.host, identity, snapshot, {
    source: "import",
    profileDir: opts.root,
  });

  const ok = stats.cookiesMatched > 0;
  const warnings = [...ingestWarnings];
  if (!ok) warnings.push("no cookies matched — probably logged out");

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
