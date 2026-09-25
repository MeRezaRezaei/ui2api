// Profile snapshot — the "auth blockage solved once and for all" store.
//
// A ProfileSnapshot is what a logged-in session reduces to: cookies +
// localStorage + sessionStorage + IndexedDB, keyed by host. It is captured once
// (from a login page, in whichever browser survives) into
// `data/sessions/<host>/state.json`, then INJECTED into any fresh incognito
// context before navigation. The site then behaves exactly like the user's real
// logged-in session — chat history persists, no profile dir reuse required, and
// it works on hosts that kill debug-channel Chrome (Playwright/WebDriver both
// need one, so profile-dir reuse is impossible there; a file is portable).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Page, BrowserContext, Cookie } from "playwright";
import { sanitizeHost } from "./browser.js";

export interface IndexedDBStoreSnapshot {
  name: string;
  keyPath: string | string[] | null;
  records: Array<[unknown, unknown]>; // [key, value]; value carries its own key when keyPath set
}

export interface IndexedDBSnapshot {
  name: string;
  version: number;
  stores: IndexedDBStoreSnapshot[];
}

export interface ProfileSnapshot {
  version: 1;
  host: string;
  origin: string;
  capturedAt: string;
  cookies: Array<Record<string, unknown>>;
  localStorage: Array<[string, string]>;
  sessionStorage: Array<[string, string]>;
  // Best-effort: skipped for stores whose values are not JSON-serializable
  // (Blobs/ArrayBuffers) — auth-critical data is almost always plain strings.
  indexedDB: IndexedDBSnapshot[];
}

// Where a site's portable session snapshot lives — same dir as its legacy
// cookies (sites|data/<host>/.session/), so every consumer that already reads
// cookies from sessionPath() finds the richer snapshot next to them.
export function snapshotPath(sitesDir: string, host: string): string {
  return resolve(sitesDir, sanitizeHost(host), ".session", "state.json");
}

export function saveSnapshot(path: string, snap: ProfileSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snap, null, 2));
}

// Never throws; returns null for missing/corrupt files.
export function loadSnapshot(path: string): ProfileSnapshot | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as ProfileSnapshot;
    if (!raw || raw.version !== 1 || !raw.host) return null;
    // GOAL 59: read-side truth gate — refuse a wrong-shaped stored snapshot
    // (hand-edited / stale build) at the load seam instead of letting it
    // crash injectSnapshot's `(snap.cookies ?? []).filter(...)` mid-runner or
    // silently replaying garbage cookies into addCookies. Same null-return
    // contract as corrupt JSON; validateSnapshotShape names the field for
    // tests/callers that want the reason.
    if (validateSnapshotShape(raw) !== null) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * GOAL 59: read-side shape gate for STORED ProfileSnapshots. GOAL 49/50 gate
 * the WRITE side (anonymous snapshots refused at the write seam) and GOAL 58
 * gates the fingerprint read-back; this closes the snapshot READ seam:
 * `loadSnapshot` previously accepted any JSON with `version===1 && host`
 * (TS-cast, never validated), so a wrong-shaped `cookies` (string) passed
 * straight through and then UNCAUGHT-crashed injectSnapshot's
 * `(snap.cookies ?? []).filter(...)` mid-runner, or "worked" in
 * `cookies.length > 0` (string length) and replayed garbage into addCookies.
 * Absent/null fields pass (legacy snapshots may lack sessionStorage /
 * indexedDB); a PRESENT wrong-typed field refuses, naming the FIRST
 * violation. Returns null when the shape is valid.
 */
export function validateSnapshotShape(snap: unknown): string | null {
  if (typeof snap !== "object" || snap === null || Array.isArray(snap)) {
    return "snapshot must be an object";
  }
  const s = snap as Record<string, unknown>;
  if (s.version !== 1) return "version must be 1";
  for (const field of ["host", "origin", "capturedAt"] as const) {
    if (s[field] !== undefined && s[field] !== null && (typeof s[field] !== "string" || (s[field] as string).trim() === "")) {
      return `${field} must be a non-empty string`;
    }
  }
  // cookies: array of { name: string, domain: string } (the injectSnapshot
  // filter's own contract); extra fields (cx/value/…) allowed, never refused.
  if (s.cookies !== undefined && s.cookies !== null) {
    if (!Array.isArray(s.cookies)) return "cookies must be an array";
    for (let i = 0; i < (s.cookies as unknown[]).length; i++) {
      const c = (s.cookies as unknown[])[i] as Record<string, unknown> | null | undefined;
      if (typeof c !== "object" || c === null || Array.isArray(c) || typeof c.name !== "string" || typeof c.domain !== "string") {
        return `cookies[${i}] must be { name: string, domain: string }`;
      }
    }
  }
  // localStorage / sessionStorage: arrays of [string, string] tuples.
  for (const field of ["localStorage", "sessionStorage"] as const) {
    const v = s[field];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) return `${field} must be an array of [key, value] tuples`;
    for (let i = 0; i < (v as unknown[]).length; i++) {
      const t = (v as unknown[])[i];
      if (!Array.isArray(t) || t.length !== 2 || typeof t[0] !== "string" || typeof t[1] !== "string") {
        return `${field}[${i}] must be a [string, string] tuple`;
      }
    }
  }
  // indexedDB: array of objects with a string name.
  if (s.indexedDB !== undefined && s.indexedDB !== null) {
    if (!Array.isArray(s.indexedDB)) return "indexedDB must be an array";
    for (let i = 0; i < (s.indexedDB as unknown[]).length; i++) {
      const db = (s.indexedDB as unknown[])[i] as Record<string, unknown> | null | undefined;
      if (typeof db !== "object" || db === null || Array.isArray(db) || typeof db.name !== "string") {
        return `indexedDB[${i}] must be an object with a string name`;
      }
    }
  }
  return null;
}

// WRITE-path truth gate (GOAL 49): a snapshot with ZERO cookies AND ZERO
// localStorage carries no auth signal — it is an anonymous session and must
// never be written + indexed as a valid vault account, listed in /accounts,
// accepted by the account guard, or surfaced by the requirements age gate as
// fresh + valid. Pure: judges snapshot CONTENT (what survives into the file),
// unlike the ingest stats (which also count undecryptable matched cookies).
export function snapshotHasAuth(
  snap: Pick<ProfileSnapshot, "cookies" | "localStorage">
): boolean {
  return (snap.cookies?.length ?? 0) > 0 || (snap.localStorage?.length ?? 0) > 0;
}

// --- Capture ---

// Dump a page's origin storage + the context's cookies into a ProfileSnapshot.
// Cookies come from the Playwright context (must be the SAME context as `page`).
export async function capturePageStorage(
  page: Page,
  meta: { host: string }
): Promise<ProfileSnapshot> {
  const cookies = await page.context().cookies();
  const storage = await page.evaluate(async () => {
    const ls: Array<[string, string]> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null) ls.push([k, localStorage.getItem(k) ?? ""]);
    }
    const ss: Array<[string, string]> = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k !== null) ss.push([k, sessionStorage.getItem(k) ?? ""]);
    }
    // IndexedDB: enumerate databases, stores, and every record. JSON-safe values
    // only — a store is skipped wholesale if any record fails to stringify.
    const idb: Array<{
      name: string;
      version: number;
      stores: Array<{ name: string; keyPath: string | string[] | null; records: Array<[unknown, unknown]> }>;
    }> = [];
    try {
      const metas = await indexedDB.databases();
      for (const meta of metas) {
        const dbName = meta.name ?? `db-${idb.length}`;
        const db = await new Promise<IDBDatabase>((res, rej) => {
          const r = indexedDB.open(dbName, meta.version);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const stores: Array<{ name: string; keyPath: string | string[] | null; records: Array<[unknown, unknown]> }> = [];
        for (const storeName of Array.from(db.objectStoreNames)) {
          try {
            const tx = db.transaction(storeName, "readonly");
            const store = tx.objectStore(storeName);
            const [keys, values] = await Promise.all([
              new Promise<unknown[]>((res, rej) => {
                const req = store.getAllKeys();
                req.onsuccess = () => res(req.result);
                req.onerror = () => rej(req.error);
              }),
              new Promise<unknown[]>((res, rej) => {
                const req = store.getAll();
                req.onsuccess = () => res(req.result);
                req.onerror = () => rej(req.error);
              }),
            ]);
            const records: Array<[unknown, unknown]> = [];
            let ok = true;
            for (let i = 0; i < Math.min(keys.length, values.length); i++) {
              try {
                JSON.stringify(keys[i]);
                JSON.stringify(values[i]);
                records.push([keys[i], values[i]]);
              } catch {
                ok = false; // un-serializable record — drop the whole store
                break;
              }
            }
            if (ok) stores.push({ name: storeName, keyPath: store.keyPath as string | string[] | null, records });
          } catch {
            // store unreadable — skip
          }
        }
        idb.push({ name: dbName, version: db.version, stores });
        db.close();
      }
    } catch {
      // IDB unavailable/blocked — cookie+localStorage capture still valuable
    }
    return { localStorage: ls, sessionStorage: ss, indexedDB: idb, origin: location.origin };
  });
  return {
    version: 1,
    host: meta.host,
    origin: storage.origin,
    capturedAt: new Date().toISOString(),
    cookies: cookies as unknown as Array<Record<string, unknown>>,
    localStorage: storage.localStorage,
    sessionStorage: storage.sessionStorage,
    indexedDB: storage.indexedDB,
  };
}

// --- Injection ---

// Build a self-contained document-start script that replays the snapshot into
// the page for the snapshot's origin. Runs BEFORE page scripts (addInitScript),
// so the site's own JS sees the data as if the user had just browsed there.
export function storageReplayScript(snap: ProfileSnapshot): string {
  const origin = JSON.stringify(snap.origin);
  const ls = JSON.stringify(snap.localStorage ?? []);
  const ss = JSON.stringify(snap.sessionStorage ?? []);
  const idb = JSON.stringify(snap.indexedDB ?? []);
  return `(()=>{const ORIGIN=${origin};if(location.origin!==ORIGIN)return;
const LS=${ls},SS=${ss},IDB=${idb};
try{for(const[k,v]of LS)localStorage.setItem(k,v)}catch(e){}
try{for(const[k,v]of SS)sessionStorage.setItem(k,v)}catch(e){}
try{for(const m of IDB){const r=indexedDB.open(m.name,m.version);
r.onupgradeneeded=()=>{try{for(const s of m.stores){if(!r.result.objectStoreNames.contains(s.name))r.result.createObjectStore(s.name,{keyPath:s.keyPath??undefined})}}catch(e){}};
r.onsuccess=()=>{try{const db=r.result;for(const s of m.stores){const tx=db.transaction(s.name,"readwrite");const st=tx.objectStore(s.name);
for(const[k,v]of s.records){try{if(s.keyPath)st.put(v);else st.put(v,k)}catch(e){}}}}catch(e){}db.close()};r.onerror=()=>{}} }catch(e){}})();`;
}

// Add the snapshot to a browser context BEFORE any page is opened: cookies via
// the protocol, the rest via a document-start replay script. Never throws —
// a failed injection must not sink the request (session may still be cookie-only).
export async function injectSnapshot(context: BrowserContext, snap: ProfileSnapshot): Promise<void> {
  const cookies = (snap.cookies ?? []).filter(
    (c) => c && typeof c.name === "string" && typeof c.domain === "string"
  ) as unknown as Cookie[];
  if (cookies.length) {
    try {
      await context.addCookies(cookies);
    } catch {
      // cookies rejected (e.g. expired) — storage replay may still work
    }
  }
  try {
    await context.addInitScript({ content: storageReplayScript(snap) });
  } catch {
    // nothing else to do
  }
}

// --- Identity-keyed account vault ---
//
// One user can hold SEVERAL accounts per site (several Gemini accounts, several
// ChatGPT accounts). Snapshots are therefore stored per (host, identity):
//
//   <sitesDir>/sessions/<host>/accounts.json   <- index of stored identities
//   <sitesDir>/sessions/<host>/<slug>/state.json <- ProfileSnapshot per identity
//
// The identity is whatever the site's auth provides — email for Google/GitHub
// logins, the profile display name otherwise. `slugifyIdentity` turns it into a
// filesystem-safe slug. The legacy flat path (<sitesDir>/<host>/.session/…)
// is RE-EXPORTED as the "default" account, so existing captures keep working.
export type AccountSource = "capture" | "ingest" | "import" | "legacy";

export interface StoredAccount {
  slug: string; // filesystem-safe id (slugifyIdentity of identity)
  identity: string; // email / display name the site identified the user by
  host: string;
  source: AccountSource;
  capturedAt: string;
  profileDir?: string; // where an ingest/import pulled the data from
}

export function slugifyIdentity(identity: string): string {
  const s = identity.trim().toLowerCase().replace(/[^a-z0-9._@-]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length <= 64 ? s : s.slice(0, 64);
}

export function vaultRoot(sitesDir: string): string {
  return resolve(sitesDir, "sessions");
}

export function accountDir(sitesDir: string, host: string, slug: string): string {
  return resolve(vaultRoot(sitesDir), sanitizeHost(host), slug);
}

export function accountSnapshotPath(sitesDir: string, host: string, slug: string): string {
  return resolve(accountDir(sitesDir, host, slug), "state.json");
}

export function accountsIndexPath(sitesDir: string, host: string): string {
  return resolve(vaultRoot(sitesDir), sanitizeHost(host), "accounts.json");
}

export function listAccounts(sitesDir: string, host: string): StoredAccount[] {
  const idx = accountsIndexPath(sitesDir, host);
  try {
    if (!existsSync(idx)) return [];
    const raw = JSON.parse(readFileSync(idx, "utf8")) as { accounts?: StoredAccount[] };
    if (!Array.isArray(raw.accounts)) return [];
    return raw.accounts;
  } catch {
    return [];
  }
}

export function saveAccountSnapshot(
  sitesDir: string,
  host: string,
  identity: string,
  snap: ProfileSnapshot,
  meta: { source: AccountSource; profileDir?: string }
): StoredAccount {
  const slug = slugifyIdentity(identity);
  const account: StoredAccount = {
    slug,
    identity,
    host: sanitizeHost(host),
    source: meta.source,
    capturedAt: snap.capturedAt,
    profileDir: meta.profileDir,
  };
  // Write the snapshot first, then append/replace in the index.
  saveSnapshot(accountSnapshotPath(sitesDir, host, slug), snap);
  const existing = listAccounts(sitesDir, host).filter((a) => a.slug !== slug);
  mkdirSync(dirname(accountsIndexPath(sitesDir, host)), { recursive: true });
  writeFileSync(accountsIndexPath(sitesDir, host), JSON.stringify({ accounts: [...existing, account] }, null, 2));
  return account;
}

// GOAL 50: a same-slug account whose identity differs from `identity` — the
// vault write seam must refuse loudly instead of silently destroying it. Same
// identity string (latest-wins re-capture) is NOT a collision.
export function slugCollision(
  sitesDir: string,
  host: string,
  identity: string
): StoredAccount | null {
  const slug = slugifyIdentity(identity);
  return listAccounts(sitesDir, host).find((a) => a.slug === slug && a.identity !== identity) ?? null;
}

// GOAL 51: the canonical READ resolver — an account reference resolves ONLY on
// the exact stored identity string OR the exact stored slug (the form
// /accounts lists). NO slugify folding: a write-refused alias ("john  smith"
// when "John Smith" is stored) must NOT silently resolve to the survivor's
// snapshot. The index is the key, the snapshot path is the cache.
export function resolveStoredAccount(
  sitesDir: string,
  host: string,
  account: string | undefined
): StoredAccount | null {
  if (!account || account === "default") return null;
  const stored = listAccounts(sitesDir, host);
  return stored.find((a) => a.identity === account || a.slug === account) ?? null;
}

// Load a snapshot for (host, identity|slug|undefined). Never throws.
//   - identity/slug given -> the vault account (EXACT identity or EXACT stored
//     slug ONLY — GOAL 51: a write-refused alias never resolves to the
//     survivor's snapshot), else null
//   - undefined            -> the legacy default path (old captures), else null
//   - "default"            -> explicit legacy path
export function loadAccountSnapshot(
  sitesDir: string,
  host: string,
  identity?: string
): ProfileSnapshot | null {
  const h = sanitizeHost(host);
  if (identity && identity !== "default") {
    const acct = resolveStoredAccount(sitesDir, h, identity);
    if (acct) return loadSnapshot(accountSnapshotPath(sitesDir, h, acct.slug));
    return null;
  }
  return loadSnapshot(snapshotPath(sitesDir, h));
}

// --- Capability reflection storage: capabilities.json next to each account ---

export function capabilitiesPath(sitesDir: string, host: string, slug: string): string {
  return resolve(accountDir(sitesDir, host, slug), "capabilities.json");
}

/** Save the account's capability fingerprint (report from capability-probe). */
export function saveCapabilities(
  sitesDir: string,
  host: string,
  slug: string,
  report: unknown
): void {
  const dir = accountDir(sitesDir, host, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(capabilitiesPath(sitesDir, host, slug), JSON.stringify(report, null, 2));
}

/** Load the account's stored capability fingerprint. Never throws. */
export function loadCapabilities(sitesDir: string, host: string, slug: string): unknown | null {
  try {
    const p = capabilitiesPath(sitesDir, host, slug);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as unknown;
  } catch {
    return null;
  }
}