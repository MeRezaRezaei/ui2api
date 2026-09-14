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
    return raw;
  } catch {
    return null;
  }
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