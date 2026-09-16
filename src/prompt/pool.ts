// ChatPool — the prompt daemon's stand-by page pool. One persistent headless
// browser is spawned once; `min` pages per peeked site are pre-warmed (opened,
// composer ready) and sit idle as a daemon, so a prompt hits an already-loaded
// page in milliseconds instead of spawning + tearing down Chrome per request.
// Pages beyond `min` are created on demand up to `max`, which scales with the
// host's free memory. Requests over capacity queue on the next free page.
import { spawnChromeAndConnect, connectExistingChrome } from "../runtime/browser.js";
import { ChatDriver } from "./driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";
import { freemem } from "node:os";

export interface PoolOptions {
  profiles: ChatSiteProfile[];
  min?: number;          // pages warmed up front (default 1)
  max?: number;          // hard ceiling; default auto from memory
  defaultProfile?: string; // the site that gets pre-warmed at boot
  dataDir?: string;
  /* Attach mode: the browser is the operator's OWN long-running Chrome (CDP
     over UI2API_ATTACH_PORT). Pages stand by as tabs in its real session, and
     the daemon never spawns/kills a browser — so the pool survives exactly like
     its attached host. Enabled automatically when UI2API_ATTACH_PORT is set. */
  attach?: boolean;
}

export interface PoolWorker {
  profileId: string;
  driver: ChatDriver;
  busy: boolean;
  /* Dedicated single-request workers (identity-keyed account) are created on
     demand, handed out once, and closed on release — they never join the idle
     pool, because a warm page carries the legacy default account. */
  dedicated?: { account: string };
}

export type PoolStatus = {
  browser: "up" | "down";
  warm: number;
  idle: number;
  busy: number;
  total: number;
  max: number;
  perSite: Record<string, { idle: number; busy: number; total: number }>;
};

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

// Cap the pool at what the host's memory allows: each warm page costs a few
// hundred MB in Chromium. Default max = min(4, floor(availGB/2)) => ~2 pages per
// headful-GB, at least 1. Override with UI2API_POOL_MAX.
function resourceMax(): number {
  const env = Number(process.env.UI2API_POOL_MAX);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  const gb = Math.floor(freemem() / 2 ** 30);
  return Math.max(1, Math.min(4, Math.floor(gb / 2)));
}

export class ChatPool {
  private browser?: Browser;
  private workers: PoolWorker[] = [];
  private waiters: Array<(w: PoolWorker) => void> = [];
  private readonly min: number;
  private readonly max: number;
  private readonly defaultProfile: string;
  private readonly dataDir: string;
  private readonly attach: boolean;

  constructor(private readonly opts: PoolOptions) {
    const envMin = Number(process.env.UI2API_POOL_MIN);
    const min = opts.min ?? (Number.isFinite(envMin) && envMin >= 1 ? Math.floor(envMin) : 1);
    this.min = Math.max(1, min);
    this.max = Math.max(this.min, opts.max ?? resourceMax());
    this.dataDir = opts.dataDir ?? resolveDataDir();
    this.defaultProfile = opts.defaultProfile ?? opts.profiles[0]?.id ?? "";
    this.attach = Boolean(opts.attach || process.env.UI2API_ATTACH_PORT);
  }

  get attached(): boolean {
    return this.attach;
  }

  async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    // A stand-by Chrome can die while idle (the sandboxed-Chromium crash this
    // host fights); respawn instead of handing the corpse to the next driver,
    // which would 500 every acquire until the daemon restarts.
    this.browser = undefined;
    const b = this.attach
      ? await connectExistingChrome(Number(process.env.UI2API_ATTACH_PORT))
      : await spawnChromeAndConnect({ headless: process.env.UI2API_HEADED !== "1" });
    this.browser = b;
    return b;
  }

  // The pool's shared browser handle — capability runners reuse the SAME
  // logged-in browser so their RPC/DOM calls run on the proven session.
  async sharedBrowser(): Promise<Browser> {
    return this.ensureBrowser();
  }

  // Warm the pool: ensure at least `min` idle pages for the default site when it
  // is part of this pool (else the first available profile). Other sites are
  // warmed lazily on first request. Fails softly: a down site must not take the
  // whole daemon down — requests will still be served on demand.
  async warm(): Promise<void> {
    const target = this.opts.profiles.some((p) => p.id === this.defaultProfile)
      ? this.defaultProfile
      : this.opts.profiles[0]?.id ?? "";
    if (!target) return;
    const needed = this.min - this.idleCount(target);
    for (let i = 0; i < Math.min(needed, this.max); i++) {
      try {
        const w = await this.acquire(target);
        await this.release(w);
      } catch {
        break;
      }
    }
  }

  private idleCount(siteId: string): number {
    return this.workers.filter((w) => w.profileId === siteId && !w.busy).length;
  }

  // Borrow a ready page for `siteId`, creating + warming one on demand (subject
  // to `max`); past capacity, wait for the next released page. An explicit
  // `account` (identity-keyed vault account, "default" = legacy) gets a
  // dedicated worker instead of a pooled page, so warm pages keep the default
  // account and per-account requests never pick up the wrong session.
  acquire(siteId: string, account?: string): Promise<PoolWorker> {
    if (account && account !== "default") {
      return this.spawn(siteId, account).then((w) => {
        w.busy = true;
        return w;
      });
    }
    const existing = this.workers.find((w) => w.profileId === siteId && !w.busy);
    if (existing) {
      existing.busy = true;
      return Promise.resolve(existing);
    }
    if (this.workers.length < this.max) {
      return this.spawn(siteId).then((w) => {
        this.workers.push(w);
        w.busy = true;
        return w;
      });
    }
    return new Promise((resolve) => {
      this.waiters.push((w) => {
        if (w.profileId !== siteId) {
          // wrong site freed; re-enqueue
          this.waiters.push(resolve as (x: PoolWorker) => void);
          return;
        }
        w.busy = true;
        resolve(w);
      });
    });
  }

  private async spawn(siteId: string, account?: string): Promise<PoolWorker> {
    const profile = this.opts.profiles.find((p) => p.id === siteId);
    if (!profile) throw new Error(`unknown site: ${siteId}`);
    const browser = await this.ensureBrowser();
    const driver = new ChatDriver(profile, {
      browser,
      dataDir: this.dataDir,
      defaultContext: this.attach,
      account,
    });
    await driver.start();
    const dedicated = account && account !== "default" ? { account } : undefined;
    return { profileId: siteId, driver, busy: false, dedicated };
  }

  // Return a page to the pool after a prompt. Unusable pages (browser died) are
  // discarded and replaced lazily. Dedicated account workers are closed right
  // away — they never idle back into the pool.
  async release(worker: PoolWorker): Promise<void> {
    worker.busy = false;
    if (worker.dedicated) {
      this.workers = this.workers.filter((w) => w !== worker);
      await worker.driver.close();
      return;
    }
    const usable = await isWorkerUsable(worker);
    if (!usable) {
      this.workers = this.workers.filter((w) => w !== worker);
      await worker.driver.close();
      this.drain(worker.profileId);
      return;
    }
    this.drainWorker(worker);
  }

  private drainWorker(worker: PoolWorker): void {
    const next = this.waiters.shift();
    if (next) {
      if (next && typeof next === "function") {
        worker.busy = true;
        next(worker);
        return;
      }
    }
    // else stay idle in the pool
  }

  private drain(siteId: string): void {
    const waiting = this.waiters.shift();
    if (waiting && typeof waiting === "function") {
      void this.acquire(siteId).then(waiting);
    }
  }

  get status(): PoolStatus {
    const perSite: PoolStatus["perSite"] = {};
    for (const w of this.workers) {
      let s = perSite[w.profileId];
      if (!s) {
        s = { idle: 0, busy: 0, total: 0 };
        perSite[w.profileId] = s;
      }
      s.total++;
      if (w.busy) s.busy++;
      else s.idle++;
    }
    const idle = this.workers.filter((w) => !w.busy).length;
    const busy = this.workers.length - idle;
    return {
      browser: this.browser ? "up" : "down",
      warm: idle,
      idle,
      busy,
      total: this.workers.length,
      max: this.max,
      perSite,
    };
  }

  get total(): number {
    return this.workers.length;
  }

  async close(): Promise<void> {
    this.waiters = [];
    // In attach mode the browser is the operator's own Chrome: the daemon must
    // never close/kill it. Only the pool's own tabs (workers) are closed; the
    // stand-by pages quietly close as the daemon goes down.
    const closeBrowser = !this.attach && this.browser;
    const workers = this.workers;
    this.workers = [];
    for (const w of workers) {
      try {
        await w.driver.close();
      } catch {
        // tab already gone
      }
    }
    this.browser = undefined;
    try {
      if (closeBrowser) await closeBrowser.close();
    } catch {
      // already gone
    }
  }
}

async function isWorkerUsable(w: PoolWorker): Promise<boolean> {
  try {
    const page: Page | undefined = (w.driver as unknown as { page?: Page }).page;
    const ctx = page?.context();
    if (!ctx) return false;
    await ctx.pages()[0]?.evaluate(() => 1).catch(() => {});
    return !(ctx as unknown as { _closed?: boolean })._closed && (ctx.pages().length ?? 0) > 0;
  } catch {
    return false;
  }
}