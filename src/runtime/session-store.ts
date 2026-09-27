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
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, lstatSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
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

// GOAL 106 — the vault holds DECRYPTED credentials (plaintext cookie values and
// localStorage tokens). Left to the default umask these land 0644 = world
// readable, i.e. any local user can lift a live session. Every credential-bearing
// write therefore goes through these two helpers with an explicit restrictive
// mode: dirs 0700, files 0600.
//
// `writeFileSync`'s `mode` only applies when the file is CREATED — a pre-existing
// 0644 file from an older build keeps its bits on a plain rewrite. So we write
// and then chmod: the mode is enforced, not merely requested.
const VAULT_DIR_MODE = 0o700;
const VAULT_FILE_MODE = 0o600;

/** mkdir -p a vault directory, and enforce 0700 even if it already existed. */
function mkdirVaultDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: VAULT_DIR_MODE });
  try {
    chmodSync(dir, VAULT_DIR_MODE);
  } catch {
    // best effort — a chmod refusal (foreign FS, perms) must not fail the write;
    // the file below is still written 0600, which is the load-bearing bit.
  }
}

// A legacy `data/sessions` tree is full of 0644 files and 0755 dirs, which any
// local user can read: a lifted live session. There is no non-destructive way to
// retrofit modes onto those trees, and a destructive re-capture has already
// overwritten captured credentials with empty ones on this box — so the only safe
// repair is a CHMOD-ONLY pass. It never opens a file for writing, never
// re-serializes, never moves or deletes; it only ever REMOVES permission bits.

export interface VaultTightenChange {
  path: string;
  kind: "file" | "dir";
  oldMode: number;
  newMode: number;
}

export interface VaultTightenResult {
  root: string;
  changes: VaultTightenChange[];
  /** already at or tighter than the vault mode — left untouched. */
  unchanged: number;
  /** symlinks skipped (never followed, never chmodded). */
  skippedSymlinks: string[];
  /** entries that could not be read/chmodded, with the reason. */
  errors: Array<{ path: string; error: string }>;
}

/**
 * Remove every permission bit the vault does not need: files keep only the
 * owner's rw (0600), dirs the owner's rwx (0700). Anything already tighter (or
 * with fewer bits set) is left alone — this pass can only tighten.
 */
export function tightenVaultModes(root: string, opts: { dryRun?: boolean } = {}): VaultTightenResult {
  // ROUND N+101 — the dry run was LYING, and it is worth recording exactly how.
  // The CLI printed "(not applied)" while calling this with no dry-run
  // parameter at all, so a DRY RUN STILL chmodded. Measured on a disposable tree:
  // a file at 0644 came back 0600 after a run whose entire output said it had not
  // been touched. The output was cosmetic; the mutation was real.
  //
  // That is the worst shape a security command can have — an operator who runs it
  // to SEE what would change has instead performed the change, and the report it
  // prints afterwards is untrustworthy in the one direction that matters. So the
  // dry run is a parameter HERE, at the seam that owns the syscall, not a string
  // the caller chooses to print.
  const dryRun = opts.dryRun === true;
  const result: VaultTightenResult = { root, changes: [], unchanged: 0, skippedSymlinks: [], errors: [] };

  const apply = (path: string, want: number, kind: "file" | "dir"): void => {
    let st: import("node:fs").Stats;
    try {
      // lstat, never stat: a symlink's OWN mode is meaningless (0777) and
      // chmod would follow it out of the vault. Chrome's dangling Singleton*
      // links live under data/ for exactly this reason.
      st = lstatSync(path);
    } catch (e) {
      result.errors.push({ path, error: (e as Error).message });
      return;
    }
    if (st.isSymbolicLink()) {
      result.skippedSymlinks.push(path);
      return;
    }
    if (st.isDirectory() !== (kind === "dir")) return;

    const oldMode = st.mode & 0o7777;
    // tighten only: (mode & ~want) === 0 means nothing to remove.
    if ((oldMode & ~want) === 0) {
      result.unchanged++;
      return;
    }
    if (dryRun) {
      result.changes.push({ path, kind, oldMode, newMode: oldMode & want });
      return;
    }
    try {
      chmodSync(path, oldMode & want);
    } catch (e) {
      result.errors.push({ path, error: (e as Error).message });
      return;
    }
    result.changes.push({ path, kind, oldMode, newMode: oldMode & want });
  };

  const walk = (dir: string): void => {
    apply(dir, VAULT_DIR_MODE, "dir");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      result.errors.push({ path: dir, error: (e as Error).message });
      return;
    }
    for (const name of names) {
      const child = join(dir, name);
      let st: import("node:fs").Stats;
      try {
        st = lstatSync(child);
      } catch (e) {
        result.errors.push({ path: child, error: (e as Error).message });
        continue;
      }
      if (st.isSymbolicLink()) {
        result.skippedSymlinks.push(child);
        continue;
      }
      if (st.isDirectory()) walk(child);
      else if (st.isFile()) apply(child, VAULT_FILE_MODE, "file");
    }
  };

  if (!existsSync(root)) {
    result.errors.push({ path: root, error: "root does not exist" });
    return result;
  }
  walk(root);
  return result;
}

/** Write credential-bearing JSON, 0600, mode-enforced for existing files too. */
function writeVaultFile(path: string, data: string): void {
  mkdirVaultDir(dirname(path));
  writeFileSync(path, data, { mode: VAULT_FILE_MODE });
  try {
    chmodSync(path, VAULT_FILE_MODE);
  } catch {
    // best effort — see mkdirVaultDir
  }
}

export function saveSnapshot(path: string, snap: ProfileSnapshot): void {
  writeVaultFile(path, JSON.stringify(snap, null, 2));
}

// GOAL 124 — a REFUSED snapshot must not silently collapse into "no session".
//
// `loadSnapshot` below returns a bare `null` for THREE genuinely different
// outcomes: the file is absent, the file exists but is unreadable (corrupt
// JSON / permissions / a half-written capture), and the file parses but is
// wrong-SHAPED (GOAL 59). Every consumer reads that single `null` as "no
// session, carry on anonymously" — so a REQUESTED-but-refused account degrades
// into an anonymous run that still answers `ok: true`. The reason was computed
// and thrown away.
//
// `loadSnapshotVerdict` is the ADDITIVE sibling that keeps it: the same load,
// but it returns the NAMED verdict. `loadSnapshot` is now a thin projection of
// it, so every existing call site keeps its exact `ProfileSnapshot | null`
// contract (nothing outside this file was changed), while the seams that must
// be able to REFUSE honestly migrate to the verdict deliberately.
export type SnapshotLoadStatus = "ok" | "absent" | "unreadable" | "shape-invalid";

export interface SnapshotLoadVerdict {
  /** The NAMED outcome. Never collapsed into a single "null". */
  status: SnapshotLoadStatus;
  /** The snapshot, ONLY when `status === "ok"`; null otherwise. */
  snapshot: ProfileSnapshot | null;
  /** The specific field message behind a `shape-invalid` refusal. */
  detail?: string;
}

const SNAPSHOT_UNREADABLE_DETAIL = "not valid JSON (corrupt file, partial write, or unreadable permissions)";

/** The load seam, with its verdict. Never throws. */
export function loadSnapshotVerdict(path: string): SnapshotLoadVerdict {
  let raw: unknown;
  try {
    if (!existsSync(path)) return { status: "absent", snapshot: null };
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { status: "unreadable", snapshot: null, detail: SNAPSHOT_UNREADABLE_DETAIL };
  }
  // GOAL 59: read-side truth gate — refuse a wrong-shaped stored snapshot
  // (hand-edited / stale build) at the load seam instead of letting it crash
  // injectSnapshot's `(snap.cookies ?? []).filter(...)` mid-runner or silently
  // replaying garbage cookies into addCookies. The field message that used to
  // be discarded is now the verdict's `detail`.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { status: "shape-invalid", snapshot: null, detail: "snapshot must be an object" };
  }
  const s = raw as Record<string, unknown>;
  if (s.version !== 1) return { status: "shape-invalid", snapshot: null, detail: "version must be 1" };
  if (typeof s.host !== "string" || s.host.trim() === "") {
    return { status: "shape-invalid", snapshot: null, detail: "host must be a non-empty string" };
  }
  const shape = validateSnapshotShape(s);
  if (shape !== null) return { status: "shape-invalid", snapshot: null, detail: shape };
  return { status: "ok", snapshot: s as unknown as ProfileSnapshot };
}

// Never throws; returns null for missing/corrupt/wrong-shaped files. The
// NAMED reason is available from the sibling `loadSnapshotVerdict`.
export function loadSnapshot(path: string): ProfileSnapshot | null {
  return loadSnapshotVerdict(path).snapshot;
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
  // --- GOAL 89: RECONCILED verdict (ADDITIVE, derived, never persisted) ---
  /**
   * Can this stored row actually drive a request? Computed at READ time by
   * `verifyStoredAccount` against what is on disk — the index row itself is
   * never trusted to assert it. `undefined` ONLY on a hand-built row object
   * that never went through `listAccounts`.
   */
  usable?: boolean;
  /** NAMED reason when `usable === false`; ABSENT on a usable row. */
  reason?: string;
  /** The specific field message behind a `shape-invalid` refusal. */
  reasonDetail?: string;
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

// --- GOAL 89: the vault INDEX is RECONCILED, never assumed ---
//
// Every honest write seam (GOAL 49 anonymous-content, GOAL 50 slug collision,
// GOAL 60 index shape) only governs what THIS code writes FROM NOW ON. A
// pre-existing, hand-edited, externally-written or partially-deleted index row
// is still a claim with nothing behind it: the row can point at a MISSING
// snapshot, an UNREADABLE (corrupt-JSON) one, an ANONYMOUS one (zero cookies
// AND zero localStorage — exactly the class the GOAL 49 write gate refuses to
// create, but which can pre-date it), or a wrong-SHAPED one (GOAL 59).
//
// Deriving /accounts, the registry `accounts[]` and the requirements vault
// verdict from accounts.json is only sound if that index is reconciled against
// what is actually on disk. Nothing did — so an account that can only ever
// replay signed-out was advertised as a normal available account, and a
// consumer could pick it.
//
// `verifyStoredAccount` is that reconciliation: PURE, fs-only, no browser, no
// network, no writes, and it REUSES the existing gates rather than
// re-implementing them (validStoredAccount for the row, GOAL 51's
// resolveStoredAccount for the reference, validateSnapshotShape for the file,
// snapshotHasAuth for the auth signal). Every verdict reason is a NAMED string
// a human can act on.
export const VAULT_NO_INDEX_ROW = "no index row";
export const VAULT_SNAPSHOT_MISSING = "snapshot-missing";
export const VAULT_SNAPSHOT_UNREADABLE = "snapshot-unreadable";
export const VAULT_ANONYMOUS =
  "anonymous (no cookies and no localStorage — the GOAL 49 write gate refuses to create this)";
export const VAULT_SHAPE_INVALID = "shape-invalid (see validateSnapshotShape)";

export interface AccountVerdict {
  /** True only when a resolvable index row points at a readable, well-shaped, AUTHED snapshot. */
  usable: boolean;
  /** NAMED reason when `usable === false`; absent when usable. */
  reason?: string;
  /** The specific field message behind a `shape-invalid` refusal. */
  detail?: string;
  /** Cookie COUNT (never values) the snapshot actually carries. */
  cookies: number;
  /** localStorage entry COUNT the snapshot actually carries. */
  localStorage: number;
  /** Whether the snapshot FILE exists on disk (false for a missing row/file). */
  exists: boolean;
}

/**
 * GOAL 89: reconcile ONE account reference against the vault on disk. Never
 * throws, never writes, never launches anything.
 *
 *   account: a reference STRING (exact stored identity or exact stored slug —
 *     GOAL 51 semantics, no folding; a hostile `../../..` slug resolves to
 *     nothing and NEVER reaches a path build) or a `StoredAccount` ROW object
 *     (as served by listAccounts, already GOAL-60-gated).
 */
export function verifyStoredAccount(
  sitesDir: string,
  host: string,
  account: string | StoredAccount
): AccountVerdict {
  const h = sanitizeHost(host);
  // GOAL 51: an account reference resolves ONLY on the exact stored identity or
  // the exact stored slug. A row object must itself pass the GOAL 60 gate
  // before it is trusted as a key.
  const row = typeof account === "string" ? resolveStoredAccount(sitesDir, h, account) : validStoredAccount(account) ? account : null;
  if (!row) {
    // No resolvable row: nothing on disk was even pointed at. The path is NOT
    // built here, so a traversal-shaped reference can never escape the vault.
    return { usable: false, reason: VAULT_NO_INDEX_ROW, cookies: 0, localStorage: 0, exists: false };
  }
  const path = accountSnapshotPath(sitesDir, h, row.slug);
  if (!existsSync(path)) {
    return { usable: false, reason: VAULT_SNAPSHOT_MISSING, cookies: 0, localStorage: 0, exists: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Corrupt JSON, or the file is unreadable (permissions, a directory, a
    // half-written capture). Same honest verdict: this account cannot drive a
    // request and the reason is named.
    return { usable: false, reason: VAULT_SNAPSHOT_UNREADABLE, cookies: 0, localStorage: 0, exists: true };
  }
  // GOAL 59 gate, reused (never re-implemented): a wrong-shaped stored snapshot
  // is refused, with validateSnapshotShape's own field message as the detail.
  const shape = validateSnapshotShape(parsed);
  if (shape !== null) {
    return { usable: false, reason: VAULT_SHAPE_INVALID, detail: shape, cookies: 0, localStorage: 0, exists: true };
  }
  const snap = parsed as Pick<ProfileSnapshot, "cookies" | "localStorage">;
  const cookies = Array.isArray(snap.cookies) ? snap.cookies.length : 0;
  const localStorage = Array.isArray(snap.localStorage) ? snap.localStorage.length : 0;
  // GOAL 49 gate, reused (never re-implemented): zero cookies AND zero
  // localStorage = an anonymous session, which can only ever replay signed-out.
  if (!snapshotHasAuth(snap)) {
    return { usable: false, reason: VAULT_ANONYMOUS, cookies, localStorage, exists: true };
  }
  return { usable: true, cookies, localStorage, exists: true };
}

/** Attach a verdict to an index row: `usable` always, the NAMED reason only
 *  when unusable. Any stale verdict already on the row is DROPPED first, so a
 *  re-reconciled row can never carry a leftover reason from an earlier pass. */
export function withAccountVerdict(row: StoredAccount, verdict: AccountVerdict): StoredAccount {
  const base = toIndexRow(row);
  const out: StoredAccount = { ...base, usable: verdict.usable };
  if (verdict.reason) out.reason = verdict.reason;
  if (verdict.detail) out.reasonDetail = verdict.detail;
  return out;
}

/** The ON-DISK index row shape — every DERIVED verdict field is stripped. A
 *  computed verdict is never persisted into accounts.json: it is read-time
 *  state, it would go stale the moment a snapshot is re-captured, and the read
 *  seam recomputes it anyway. Writing it back would make the index assert
 *  something it cannot know. */
function toIndexRow(row: StoredAccount): StoredAccount {
  const { usable: _u, reason: _r, reasonDetail: _rd, ...rest } = row;
  return rest;
}

/**
 * The NAMED refusal for a caller that asked for an account that exists in the
 * index but can never drive a request. Counts only — never a cookie value.
 */
export function unusableAccountMessage(ref: string, host: string, verdict: AccountVerdict): string {
  const h = sanitizeHost(host);
  return `stored account "${ref}" for "${h}" cannot drive requests: ${verdict.reason} (cookies=${verdict.cookies}, localStorage=${verdict.localStorage}) — re-capture: 'profile add-all --known' (or 'profile capture/import ${h}')`;
}

/**
 * The one call a request seam makes after GOAL 51 resolution succeeds: throw a
 * NAMED error when the resolved account cannot drive requests. Never falls back
 * to another account — refusing is correct, silently substituting is the
 * failure this repo forbids. Returns the verdict when the account is usable.
 */
export function assertUsableStoredAccount(
  sitesDir: string,
  host: string,
  account: string | StoredAccount
): AccountVerdict {
  const ref = typeof account === "string" ? account : account.slug;
  const verdict = verifyStoredAccount(sitesDir, host, account);
  if (!verdict.usable) throw new Error(unusableAccountMessage(ref, host, verdict));
  return verdict;
}

export function listAccounts(sitesDir: string, host: string): StoredAccount[] {
  const idx = accountsIndexPath(sitesDir, host);
  try {
    if (!existsSync(idx)) return [];
    const raw = JSON.parse(readFileSync(idx, "utf8")) as { accounts?: StoredAccount[] };
    if (!Array.isArray(raw.accounts)) return [];
    // GOAL 60: read-side gate on the vault INDEX — every entry served must be
    // a shape a consumer can safely resolve. A hostile/corrupt entry (path-
    // traversal slug, numeric slug, missing identity) is EXCLUDED here, so it
    // is never listed in /accounts + /registry accounts[], and never drives
    // path resolution (accountSnapshotPath's resolve() would escape the vault
    // with a `../../..` slug). Writes are safe (slugifyIdentity at save);
    // this closes the read seam for hand-edited / partial / stale indexes.
    //
    // GOAL 89: a row that PASSES the shape gate is still only a CLAIM. Every
    // served row is RECONCILED against the snapshot actually on disk by the
    // pure `verifyStoredAccount`, and the verdict rides on the row as the
    // additive `usable` + `reason` fields. An unusable row stays LISTED (it is
    // a real stored row a user may want to see and delete) but is never
    // presented as able to drive a request — no blind-empty, no silent drop.
    return raw.accounts.filter(validStoredAccount).map((a) => withAccountVerdict(a, verifyStoredAccount(sitesDir, host, a)));
  } catch {
    return [];
  }
}

/**
 * GOAL 60: per-entry read gate for the vault index. True only for an entry a
 * consumer can safely resolve: slug must be a non-empty string matching the
 * slugify alphabet `[a-z0-9._@-]+` (structurally no `/`, no `..` — path
 * traversal is impossible), identity/host non-empty strings, source one of
 * the AccountSource kinds, capturedAt a non-empty string. profileDir is
 * optional metadata (may be absent, non-string entries dropped as unsafe).
 */
export function validStoredAccount(entry: unknown): entry is StoredAccount {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const a = entry as Record<string, unknown>;
  // Slug must be a single safe path segment: slugify alphabet only (no `/`,
  // no `..`), and never the traversal sentinels `.` / `..` themselves —
  // resolve() would climb the vault with a `..` segment.
  if (typeof a.slug !== "string" || !/^[a-z0-9._@-]+$/.test(a.slug) || a.slug === "." || a.slug === "..") return false;
  if (typeof a.identity !== "string" || a.identity.trim() === "") return false;
  if (typeof a.host !== "string" || a.host.trim() === "") return false;
  const source = ["capture", "ingest", "import", "legacy"] as const;
  if (!source.includes(a.source as (typeof source)[number])) return false;
  if (typeof a.capturedAt !== "string" || a.capturedAt.trim() === "") return false;
  return true;
}

export function saveAccountSnapshot(
  sitesDir: string,
  host: string,
  identity: string,
  snap: ProfileSnapshot,
  meta: { source: AccountSource; profileDir?: string }
): StoredAccount {
  const slug = slugifyIdentity(identity);
  // ROUND N+99 — the per-account write seam refuses a zero-auth snapshot.
  //
  // The GOAL 49 gate ("a snapshot with ZERO cookies AND ZERO localStorage is
  // REFUSED at the write seam … nothing written to the vault") was true in the
  // COMMENT and in a test's own verdict ladder, but NOT in this function: it
  // wrote whatever it was handed. `snapshotHasAuth` existed and was consulted
  // only on the READ path. Reproduced directly — saving a snapshot with
  // `cookies: []` wrote a 208-byte `state.json` at 0600 plus an `accounts.json`
  // index row, with `snapshotHasAuth` returning `false` the whole time.
  //
  // Why that matters beyond tidiness: an account snapshot is OVERWRITTEN in
  // place, so writing an empty one DESTROYS a previously good captured session.
  // Measured live on this box: after one `profile add-all --known`,
  // `www.aparat.com` — recorded live-verified with `araprat_search` /
  // `araprat_trending` / `araprat_video_detail` all `ok:true` — was left holding
  // a 210-byte snapshot with `cookies: []`, and `chatgpt.com` a 204-byte one.
  // Both had reported `decrypt-limited (portal v20)`, where a cookie MATCHES the
  // host but its value is not extractable: the scan counted a match, so the
  // caller believed it had auth, and the artifact it wrote was empty. A gate
  // reachable only by a caller that remembers to call it is not a gate, so it
  // lives HERE — the one choke point every account write passes through — and it
  // throws a NAMED error rather than returning a value a caller may ignore.
  if (!snapshotHasAuth(snap)) {
    throw new Error(
      `no-auth-snapshot-refused: refusing to write a zero-auth snapshot for ` +
        `"${sanitizeHost(host)}" account "${slug}" — it would overwrite any existing ` +
        `captured session with an empty one, and a decrypt-limited cookie (matched but ` +
        `not extractable) does not count as auth. Nothing was written.`
    );
  }
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
  // GOAL 89: the rows carried over are stripped back to their ON-DISK index
  // shape — a derived verdict is read-time state and must never be persisted
  // into accounts.json (it would go stale on the next re-capture, and the read
  // seam reconciles every row again anyway).
  const existing = listAccounts(sitesDir, host).filter((a) => a.slug !== slug).map(toIndexRow);
  writeVaultFile(accountsIndexPath(sitesDir, host), JSON.stringify({ accounts: [...existing, account] }, null, 2));
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
  return loadSnapshotVerdict(snapshotPath(sitesDir, h)).snapshot;
}

// GOAL 124 — the ACCOUNT-level load verdict. A requested account that cannot
// be loaded is NOT "no session": it is a REFUSAL that must be reported by name
// (an unknown reference, a missing/unreadable/wrong-shaped snapshot) rather than
// degrading into an anonymous run. `no-index-row` reuses the GOAL 89
// `VAULT_NO_INDEX_ROW` name so both seams speak one vocabulary.
export type AccountLoadStatus = SnapshotLoadStatus | "no-index-row";

export interface AccountLoadVerdict {
  status: AccountLoadStatus;
  snapshot: ProfileSnapshot | null;
  detail?: string;
  /** The resolved index row's slug, when the reference resolved. */
  slug?: string;
}

export function loadAccountSnapshotVerdict(
  sitesDir: string,
  host: string,
  identity?: string
): AccountLoadVerdict {
  const h = sanitizeHost(host);
  if (identity && identity !== "default") {
    const acct = resolveStoredAccount(sitesDir, h, identity);
    if (!acct) return { status: "no-index-row", snapshot: null };
    const v = loadSnapshotVerdict(accountSnapshotPath(sitesDir, h, acct.slug));
    return { status: v.status, snapshot: v.snapshot, detail: v.detail, slug: acct.slug };
  }
  const v = loadSnapshotVerdict(snapshotPath(sitesDir, h));
  return { status: v.status, snapshot: v.snapshot, detail: v.detail };
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
  writeVaultFile(capabilitiesPath(sitesDir, host, slug), JSON.stringify(report, null, 2));
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