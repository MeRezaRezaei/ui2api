// Profile ingester — serialize Chrome's own on-disk profile data into the
// portable ProfileSnapshot, fully offline. Solves the auth/history blockage
// without ANY browser: copy Chrome's Cookies SQLite DB + Local State + storages
// (a running Chrome locks the originals, but copies read fine), decrypt cookie
// values (Linux classic "peanuts" AES-128-CBC; keyring-era v11 AES-256-GCM),
// rebuild Playwright cookie objects, and group localStorage by origin.
//
// Reading strategy on locked dirs: COPY the live files to a temp dir first.
// SQLite WAL is replayed on open of the copy; LevelDB opens read-only.
import { readFileSync, existsSync, mkdtempSync, cpSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ProfileSnapshot } from "./session-store.js";

// --- Keys ---

// Linux classic fallback when no keyring / Local State key exists.
export function derivePeanutsKey(): Buffer {
  return pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
}

// Attempt to read an os_crypt key from Chrome's Local State. Returns undefined
// for both properties on Linux-without-keyring (the common headless case) —
// callers then fall back to the peanuts key. macOS stores "v10"+16B key here;
// Windows "DPAPI"+blob (not decryptable on Linux) is skipped.
export function deriveKeysFromLocalState(localStatePath: string): { cbc?: Buffer; gcm?: Buffer } {
  try {
    if (!existsSync(localStatePath)) return {};
    const ls = JSON.parse(readFileSync(localStatePath, "utf8")) as {
      os_crypt?: { encrypted_key?: string };
    };
    const b64 = ls.os_crypt?.encrypted_key;
    if (!b64) return {};
    let raw = Buffer.from(b64, "base64");
    if (raw.subarray(0, 5).toString() === "DPAPI") return {}; // Windows: undecryptable here
    if (raw.subarray(0, 3).toString() === "v10") raw = raw.subarray(3);
    if (raw.length === 16) return { cbc: raw }; // macOS-style AES-128 key
    if (raw.length === 32) return { gcm: raw }; // v11 AES-256 key
    return {};
  } catch {
    return {};
  }
}

// --- Cookie decryption ---

const PEANUTS = derivePeanutsKey();

// Is a decrypted candidate plausible page data? (printable-ish, no replacement
// chars, no control bytes). Kept permissive — some cookies are urlencoded or
// have a couple of binary bytes.
function looksDecrypted(s: string): boolean {
  if (!s || s.length === 0) return false;
  if (s.includes("\uFFFD")) return false;
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c < 0x7f) printable++;
    else if (c !== 0x09 && c !== 0x0a && c !== 0x0d && (c < 0x80 || c > 0x10ffff)) return false;
  }
  return printable > 0;
}

// Decrypt one Chrome cookie value. Tries every plausible scheme+key that could
// have produced it, returns the first that validates (or null).
//
// EMPIRICALLY CONFIRMED layout on modern Linux Chrome (2026-era, 257/257
// cookies): encrypted_value = "v10" + HDR(16 random bytes) + IV(16) + AES-128-
// CBC ciphertext, key = PBKDF2("peanuts","saltysalt",iter=1,16). The classic
// documented layout ("v10" + ciphertext, IV=16 spaces) is kept as a fallback
// for older profiles — garbage decrypts fail validation, so the right variant
// wins.
export function decryptCookieValue(
  enc: Buffer,
  keys: { cbc?: Buffer; gcm?: Buffer } = {}
): string | null {
  if (!enc || enc.length === 0) return "";
  const cbcKey = keys.cbc ?? PEANUTS;
  const prefix = enc.subarray(0, 3).toString();
  const spaces16 = Buffer.alloc(16, 0x20);
  const attempts: Array<{ algo: string; iv: Buffer; ct: Buffer; key: Buffer }> = [];
  if (prefix === "v10") {
    attempts.push({ algo: "v10-legacy", iv: spaces16, ct: enc.subarray(3), key: cbcKey });
    if (enc.length >= 3 + 16 + 16 + 16) {
      attempts.push({ algo: "v10-modern", iv: enc.subarray(19, 35), ct: enc.subarray(35), key: cbcKey });
    }
  } else if (prefix === "v11" && keys.gcm) {
    attempts.push({ algo: "v11-gcm", iv: enc.subarray(3, 15), ct: enc.subarray(15), key: keys.gcm });
  } else {
    // Unknown prefix — try everything we have.
    attempts.push({ algo: "any-legacy", iv: spaces16, ct: enc.subarray(3), key: cbcKey });
    if (keys.gcm) attempts.push({ algo: "any-gcm", iv: enc.subarray(3, 15), ct: enc.subarray(15), key: keys.gcm });
  }
  for (const a of attempts) {
    try {
      if (a.algo.endsWith("gcm")) {
        const nonce = a.iv;
        const ct = a.ct.subarray(0, a.ct.length - 16);
        const tag = a.ct.subarray(a.ct.length - 16);
        const d = createDecipheriv("aes-256-gcm", a.key, nonce);
        d.setAuthTag(tag);
        const out = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
        if (looksDecrypted(out)) return out;
      } else {
        const d = createDecipheriv("aes-128-cbc", a.key, a.iv);
        const out = Buffer.concat([d.update(a.ct), d.final()]).toString("utf8");
        if (looksDecrypted(out)) return out;
      }
    } catch {
      // wrong key/scheme — try next
    }
  }
  return null;
}

// Chrome stores expiry as microseconds since 1601-01-01 (Windows FILETIME).
// FILETIME values exceed Number.MAX_SAFE_INTEGER (2^53), so all math is BigInt
// until the final conversion to epoch milliseconds.
export function expiresUtcToEpoch(us: bigint | number): number {
  const b = typeof us === "bigint" ? us : BigInt(Math.trunc(us));
  return Number(b / 1000n - 11644473600000n);
}

// --- Row -> Playwright cookie ---

export interface CookieRow {
  host_key: string;
  name: string;
  encrypted_value: Buffer;
  path: string;
  expires_utc: bigint;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  has_expires: number;
  source_scheme: number;
  value: string;
}

function sameSiteOf(v: number): "Strict" | "Lax" | "None" | undefined {
  if (v === 1) return "Lax";
  if (v === 2) return "Strict";
  if (v === 0) return "None";
  return undefined; // UNSPECIFIED — let the site's default apply
}

// Rebuild a Playwright cookie object from a Chrome row, decrypting the value.
// Undecryptable cookies come back with an empty value (kept, so the cookie
// still exists) — callers that care can check the stats.
export function cookieRowToPlaywrightCookie(row: CookieRow): Record<string, unknown> {
  const decrypted = decryptCookieValue(row.encrypted_value);
  const cookie: Record<string, unknown> = {
    name: row.name,
    value: decrypted ?? "",
    domain: row.host_key,
    path: row.path || "/",
    secure: Boolean(row.is_secure),
    httpOnly: Boolean(row.is_httponly),
  };
  if (row.has_expires && row.expires_utc) {
    cookie.expires = expiresUtcToEpoch(row.expires_utc) / 1000;
  }
  const sameSite = sameSiteOf(Number(row.samesite));
  if (sameSite) cookie.sameSite = sameSite;
  return cookie;
}

// Do the cookies for `hostKey` apply to `host`? (RFC 6265 domain matching.)
function domainMatches(host: string, hostKey: string): boolean {
  const hk = hostKey.startsWith(".") ? hostKey.slice(1) : hostKey;
  return host === hk || host.endsWith("." + hk);
}

// --- Profile discovery + read ---

export interface IngestResult {
  snapshot: ProfileSnapshot;
  stats: {
    cookiesTotal: number;
    cookiesMatched: number;
    decrypted: number;
    undecryptable: number;
    localStorageEntries: number;
  };
  profileDir: string;
  warnings: string[];
}

const PROFILE_CANDIDATES = [
  "~/.config/google-chrome",
  "~/.config/chromium",
  "~/.config/google-chrome-beta",
] as const;

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

// Which default profile dirs exist that look like a Chrome profile?
export function findChromeProfileDirs(): string[] {
  const found: string[] = [];
  for (const cand of PROFILE_CANDIDATES) {
    const p = expandHome(cand);
    if (existsSync(join(p, "Local State")) && existsSync(join(p, "Default"))) found.push(p);
  }
  return found;
}

// Copy a running Chrome's session DB + Local State to a temp dir (the originals
// are locked). Returns paths to the readable copy.
function copyProfileForReading(profileDir: string): { dbPath: string; localStatePath: string } {
  const def = join(profileDir, "Default");
  // Newer Chrome keeps cookies under Default/Network/; older under Default/.
  const dbSrc = existsSync(join(def, "Network", "Cookies"))
    ? join(def, "Network", "Cookies")
    : join(def, "Cookies");
  if (!existsSync(dbSrc)) throw new Error(`no chrome cookies database at ${dbSrc}`);
  const tmp = mkdtempSync(join(tmpdir(), "u2a-ingest-"));
  const dbPath = join(tmp, "Cookies");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const src = dbSrc + suffix;
    if (existsSync(src)) cpSync(src, dbPath + suffix);
  }
  const localStatePath = join(tmp, "Local State");
  if (existsSync(join(profileDir, "Local State"))) {
    cpSync(join(profileDir, "Local State"), localStatePath);
  }
  return { dbPath, localStatePath };
}

// Read all cookies from a copied DB, filtered + decrypted for `targetHost`.
function readCookiesFor(
  dbPath: string,
  targetHost: string
): { cookies: Array<Record<string, unknown>>; total: number; matched: number; decrypted: number; undecryptable: number } {
  const db = new DatabaseSync(dbPath, { readBigInts: true });
  try {
    const rows = db
      .prepare(
        `SELECT host_key, name, value, encrypted_value, path, expires_utc,
                is_secure, is_httponly, samesite, has_expires, source_scheme
         FROM cookies`
      )
      .all() as Array<{
      host_key: string;
      name: string;
      value: string | null;
      encrypted_value: Uint8Array | null;
      path: string | null;
      expires_utc: bigint | null;
      is_secure: bigint;
      is_httponly: bigint;
      samesite: bigint;
      has_expires: bigint;
      source_scheme: bigint;
    }>;
    const cookies: Array<Record<string, unknown>> = [];
    let matched = 0;
    let decrypted = 0;
    let undecryptable = 0;
    for (const r of rows) {
      if (!domainMatches(targetHost, r.host_key)) continue;
      matched++;
      const enc = r.encrypted_value ? Buffer.from(r.encrypted_value) : Buffer.alloc(0);
      const value = decryptCookieValue(enc);
      if (value === null) {
        // An undecryptable cookie must NOT survive — injecting it with an empty
        // value would overwrite the site's real cookie with nothing.
        undecryptable++;
        continue;
      }
      if (enc.length > 0) decrypted++;
      cookies.push(
        cookieRowToPlaywrightCookie({
          host_key: r.host_key,
          name: r.name,
          encrypted_value: enc,
          path: r.path ?? "/",
          expires_utc: r.expires_utc ?? 0n,
          is_secure: Number(r.is_secure),
          is_httponly: Number(r.is_httponly),
          samesite: Number(r.samesite),
          has_expires: Number(r.has_expires),
          source_scheme: Number(r.source_scheme),
          value: r.value ?? "",
        })
      );
    }
    return { cookies, total: rows.length, matched, decrypted, undecryptable };
  } finally {
    db.close();
  }
}

// Best-effort localStorage read: copy the LevelDB dir, open, group by origin.
// Keys look like `_<origin>\x00<key>` (or `<origin>\x00<key>`).
// Scoped to `origin` only — auth tokens, not the whole store.
// 5-second hard timeout: ClassicLevel's native addon can deadlock on corrupted
// or mid-write LevelDB copies, so we NEVER block the caller.
async function readLocalStorageFor(profileDir: string, origin: string): Promise<Array<[string, string]>> {
  const src = join(profileDir, "Default", "Local Storage", "leveldb");
  if (!existsSync(src)) return [];
  // Opt-out escape hatch: classic-level's native addon has deadlocked on this
  // host with mid-write LevelDB copies. Cookies alone carry the auth; set
  // UI2API_INGEST_LEVELDB=0 to skip localStorage entirely.
  if (process.env.UI2API_INGEST_LEVELDB === "0") return [];
  const timeout = 5000;
  try {
    return await Promise.race([
      (async () => {
        const { ClassicLevel } = await import("classic-level").catch(() => ({ ClassicLevel: undefined as never }));
        if (!ClassicLevel) return [];
        const tmp = mkdtempSync(join(tmpdir(), "u2a-ls-"));
        try {
          cpSync(src, tmp, { recursive: true });
          const db = new ClassicLevel(tmp, { valueEncoding: "buffer" });
          await db.open().catch(() => undefined);
          const out: Array<[string, string]> = [];
          try {
            for await (const entry of db.iterator() as unknown as AsyncIterable<[Buffer, Buffer]>) {
              const [k, v] = entry;
              const key = k.toString("utf8");
              let body = key.startsWith("_") ? key.slice(1) : key;
              if (body.startsWith("META:")) continue;
              const nul = body.indexOf("\x00");
              if (nul < 0) continue;
              if (body.slice(0, nul) !== origin) continue;
              if (!Buffer.isBuffer(v) || v.length === 0) continue;
              out.push([body.slice(nul + 1), v.toString("utf8")]);
            }
          } catch {
            // iterator died (dir locked-ish) — what we got is still useful
          }
          await db.close().catch(() => {});
          return out;
        } finally {
          try { rmSyncSafe(tmp); } catch { /* ignore */ }
        }
      })(),
      new Promise<Array<[string, string]>>((resolve) =>
        setTimeout(() => resolve([]), timeout)
      ),
    ]);
  } catch {
    return [];
  }
}

import { rmSync as rmSyncSafe } from "node:fs";

// --- Top-level ingest ---

export interface IngestOptions {
  profileDir?: string;
  targetHost: string;
}

// Serialize the user's real Chrome profile for `targetHost` into a snapshot.
// profileDir defaults to UI2API_USER_DATA_DIR / ~/.config/google-chrome etc.
// Never spawns a browser. Throws only when no usable Chrome profile exists.
export async function ingestProfile(opts: IngestOptions): Promise<IngestResult> {
  const warnings: string[] = [];
  let profileDir = opts.profileDir;
  if (!profileDir) {
    const fromEnv = process.env.UI2API_USER_DATA_DIR || process.env.UI2API_CHROME_PROFILE_PATH;
    if (fromEnv && existsSync(fromEnv)) profileDir = fromEnv;
    else {
      const candidates = findChromeProfileDirs();
      profileDir = candidates[0];
      if (!profileDir) {
        throw new Error(
          "no chrome profile found (tried UI2API_USER_DATA_DIR, ~/.config/google-chrome, ~/.config/chromium)"
        );
      }
    }
  }
  if (!existsSync(join(profileDir, "Local State")) && !existsSync(join(profileDir, "Default", "Cookies"))) {
    throw new Error(`no chrome cookies database under ${profileDir}`);
  }
  const { dbPath } = copyProfileForReading(profileDir);
  const { cookies, total, matched, decrypted, undecryptable } = readCookiesFor(dbPath, opts.targetHost);
  const origin = `https://${opts.targetHost}`;
  const localStorage = await readLocalStorageFor(profileDir, origin);
  if (total === 0) warnings.push("cookies table is empty — is this the right profile?");
  if (matched === 0) warnings.push(`no cookies matched ${opts.targetHost} — are you logged in there?`);
  if (undecryptable > 0) warnings.push(`${undecryptable} cookie(s) could not be decrypted (wrong key or new scheme)`);

  const snapshot: ProfileSnapshot = {
    version: 1,
    host: opts.targetHost,
    origin,
    capturedAt: new Date().toISOString(),
    cookies,
    localStorage,
    sessionStorage: [],
    indexedDB: [],
  };
  return {
    snapshot,
    stats: { cookiesTotal: total, cookiesMatched: matched, decrypted, undecryptable, localStorageEntries: localStorage.length },
    profileDir,
    warnings,
  };
}