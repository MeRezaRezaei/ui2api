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
  /* GOAL 83 — BOUNDED over-capacity queue. Past `max` pages a request waits
     for the next free one, but the wait is bounded on BOTH axes: at most
     `maxWaiters` requests may be parked at once, and each may wait at most
     `waiterTimeoutMs`. Past either bound `acquire()` REJECTS with a named
     cause instead of parking forever — an unbounded queue is what made the
     daemon un-stoppable: a parked request kept its HTTP handler (and its
     socket) alive indefinitely, so `server.close()` never finished and
     SIGINT/SIGTERM could not stop promptd. 0 disables that axis entirely
     (fail fast). Env overrides: UI2API_POOL_MAX_WAITERS,
     UI2API_POOL_WAITER_TIMEOUT_MS. */
  maxWaiters?: number;
  waiterTimeoutMs?: number;
}

/* A queued acquire(). It carries BOTH settle handles: `resolve` hands it a
   page, `reject` ends the wait with a named cause. GOAL 83: the old waiter had
   a resolve only, so every path that dropped it (close, drain, a failed
   re-acquire) left the promise pending forever. */
type PoolWaiter = {
  siteId: string;
  resolve: (w: PoolWorker) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
};

/* Queue bounds. `maxWaiters` 16 keeps a burst of parallel consumers serviceable
   (well past the 1-4 pages the pool actually runs) while refusing the pile-on
   that used to park without limit. `waiterTimeoutMs` 240s sits ABOVE the worst
   single-page occupancy (a real round-trip is page.goto 60s + captureMs, whose
   packaged maximum is 120s) so a legitimate wait is never cut short, and BELOW
   the daemon's 300s request deadline so a doomed request is told WHY it never
   got a page instead of running into the request-level timeout blind. */
const DEFAULT_MAX_WAITERS = 16;
const DEFAULT_WAITER_TIMEOUT_MS = 240_000;

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
  /* GOAL 83: how many requests are parked waiting for a free page right now,
     and the bound they are held to. Surfaces saturation in /status instead of
     leaving it invisible until requests start failing. */
  queued: number;
  maxWaiters: number;
  perSite: Record<string, { idle: number; busy: number; total: number }>;
};

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

// Non-negative integer from the environment, else the fallback.
function envCount(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
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
  private waiters: PoolWaiter[] = [];
  private readonly min: number;
  private readonly max: number;
  private readonly maxWaiters: number;
  private readonly waiterTimeoutMs: number;
  private readonly defaultProfile: string;
  private readonly dataDir: string;
  private readonly attach: boolean;

  constructor(private readonly opts: PoolOptions) {
    const envMin = Number(process.env.UI2API_POOL_MIN);
    const min = opts.min ?? (Number.isFinite(envMin) && envMin >= 1 ? Math.floor(envMin) : 1);
    this.min = Math.max(1, min);
    this.max = Math.max(this.min, opts.max ?? resourceMax());
    this.maxWaiters = Math.max(0, opts.maxWaiters ?? envCount("UI2API_POOL_MAX_WAITERS", DEFAULT_MAX_WAITERS));
    this.waiterTimeoutMs = Math.max(0, opts.waiterTimeoutMs ?? envCount("UI2API_POOL_WAITER_TIMEOUT_MS", DEFAULT_WAITER_TIMEOUT_MS));
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
    // Over capacity: wait for the next free page — but only inside the two
    // bounds. GOAL 83.
    if (this.waiters.length >= this.maxWaiters) {
      return Promise.reject(
        new Error(
          `pool saturated (${this.waiters.length} waiting, limit ${this.maxWaiters}) — no page is free and the queue is full`
        )
      );
    }
    return new Promise<PoolWorker>((resolve, reject) => {
      const waiter: PoolWaiter = { siteId, resolve, reject, settled: false };
      // A page of the WRONG site freed: re-park THIS waiter (its deadline keeps
      // running, the queue is still bounded) rather than hand over a page we
      // cannot use.
      waiter.resolve = (w: PoolWorker) => {
        if (w.profileId !== siteId) {
          if (!waiter.settled) this.waiters.push(waiter);
          return;
        }
        this.settleDelivered(waiter);
        w.busy = true;
        resolve(w);
      };
      if (this.waiterTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.settleWaiter(
            waiter,
            new Error(
              `pool queue timeout after ${this.waiterTimeoutMs}ms waiting for a "${siteId}" page ` +
                `(${this.waiters.length} waiting, limit ${this.maxWaiters})`
            )
          );
        }, this.waiterTimeoutMs);
        waiter.timer.unref?.();
      }
      this.waiters.push(waiter);
    });
  }

  // A waiter was handed its page: stop its deadline so the timer can never
  // reject a request that is already being served.
  private settleDelivered(waiter: PoolWaiter): void {
    waiter.settled = true;
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
  }

  // GOAL 83: settle ONE queued waiter with a named cause and take it out of
  // the queue. Every path that used to leave a waiter pending forever — its own
  // deadline, drain's failed re-acquire, shutdown — settles through here.
  private settleWaiter(waiter: PoolWaiter, err: Error): void {
    if (waiter.settled) return;
    this.settleDelivered(waiter);
    this.waiters = this.waiters.filter((w) => w !== waiter);
    waiter.reject(err);
  }

  // Settle EVERY queued waiter at once. The old `this.waiters = []` DROPPED
  // them: their resolve was never called and they carried no reject, so each
  // parked acquire() — and the HTTP handler awaiting it — stayed pending
  // forever, server.close() (http.ts) never finished, and the daemon could not
  // be stopped. Named cause, nothing silent.
  private settleAllWaiters(cause: string): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      if (waiter.settled) continue;
      this.settleDelivered(waiter);
      waiter.reject(new Error(`${cause} — ${pending.length} queued request(s) rejected`));
    }
  }

  private async spawn(siteId: string, account?: string): Promise<PoolWorker> {
    const profile = this.opts.profiles.find((p) => p.id === siteId);
    if (!profile) throw new Error(`unknown site: ${siteId}`);
    const realProfileOnly = Boolean((profile as { realProfileOnly?: boolean }).realProfileOnly);
    // Real-profile-only sites (e.g. tencent-aistudio under Tencent EdgeOne) get
    // one browser rotation: the site's anti-bot flags long-lived Chrome
    // instances ("Access Restricted"/567) even though a fresh instance on the
    // same IP+profile sails through (its challenge cookies are session-scoped).
    // Retry once with a brand-new browser before failing the request.
    const attempts = realProfileOnly ? 2 : 1;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const browser = await this.ensureBrowser();
      const driver = new ChatDriver(profile, {
        browser,
        dataDir: this.dataDir,
        // Real-profile-only sites must run on the browser's DEFAULT context —
        // the user's actual profile session — because their anti-bot serves
        // "Access Restricted" to ephemeral snapshot contexts (see
        // ChatSiteProfile.realProfileOnly).
        defaultContext: this.attach || realProfileOnly,
        account,
      });
      try {
        await driver.start();
        const dedicated = account && account !== "default" ? { account } : undefined;
        return { profileId: siteId, driver, busy: false, dedicated };
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        const blocked = /Access Restricted|Restricted Access|security policy|HTTP 567|web security policy/i.test(msg);
        if (attempt < attempts && blocked) {
          await this.restartBrowser();
          continue;
        }
        throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // Close the shared browser and forget it; the next ensureBrowser() spawns a
  // fresh instance. Used to rotate past anti-bot flags that attach to a
  // specific Chrome instance (EdgeOne on aistudio.tencent.ai) rather than the IP.
  private async restartBrowser(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // already gone
      }
      this.browser = undefined;
      this.workers = [];
      // Waiting requests re-acquire on a fresh browser (their waiters are
      // re-triggered through acquire()). GOAL 83: the waiter carries its reject
      // handle, so a failed re-acquire is settled with the NAMED cause instead
      // of being swallowed by `() => undefined` (which left the request
      // pending forever).
      const waiters = this.waiters;
      this.waiters = [];
      for (const waiter of waiters) {
        void this.acquire(waiter.siteId).then(
          (w) => waiter.resolve(w),
          (e) => this.settleWaiter(waiter, e instanceof Error ? e : new Error(String(e)))
        );
      }
    }
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
      if (next.siteId === worker.profileId) {
        worker.busy = true;
        next.resolve(worker);
        return;
      }
      // wrong site freed; keep it and try the next waiter
      this.waiters.unshift(next);
    }
    // else stay idle in the pool
  }

  private drain(siteId: string): void {
    const waiting = this.waiters.shift();
    if (!waiting || waiting.settled) return;
    // A page was discarded: serve the head waiter with a fresh one. GOAL 83:
    // BOTH outcomes settle the waiter — success hands it the page, failure
    // rejects it with the NAMED cause. The old `() => undefined` rejection
    // handler dropped the error on the floor and left the request pending
    // forever; if the re-acquire itself parks, the waiter's own queue deadline
    // still applies, so nothing stays unbounded.
    void this.acquire(siteId).then(
      (w) => waiting.resolve(w),
      (e) => this.settleWaiter(waiting, e instanceof Error ? e : new Error(String(e)))
    );
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
      queued: this.waiters.length,
      maxWaiters: this.maxWaiters,
      perSite,
    };
  }

  get total(): number {
    return this.workers.length;
  }

  /* GOAL 83: how many requests are parked right now (0 after a close — nothing
     is left waiting on a promise that will never settle). */
  get queued(): number {
    return this.waiters.length;
  }

  async close(): Promise<void> {
    // Shutdown settles EVERY queued waiter with a named cause before the
    // browser goes away. Never `this.waiters = []` (a silent drop: the parked
    // acquire() promises had no reject, so the awaiting HTTP handlers never
    // answered and their sockets kept server.close() waiting forever).
    this.settleAllWaiters("pool closed (daemon shutdown)");
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