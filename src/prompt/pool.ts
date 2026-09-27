// ChatPool — the prompt daemon's stand-by page pool. One persistent headless
// browser is spawned once; `min` pages per peeked site are pre-warmed (opened,
// composer ready) and sit idle as a daemon, so a prompt hits an already-loaded
// page in milliseconds instead of spawning + tearing down Chrome per request.
// Pages beyond `min` are created on demand up to `max`, which scales with the
// host's free memory. Requests over capacity queue on the next free page.
import { resolvedHeadless, spawnChromeAndConnect, connectExistingChrome } from "../runtime/browser.js";
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
  /* GOAL 87 — how often the liveness reaper re-checks IDLE pages and evicts the
     dead ones (0 disables it). The sweep never spawns a browser (that would be
     fabricated traffic from a timer) — it only drops a page it measured dead
     and re-warms when the browser it can prove is up. Env:
     UI2API_REAPER_INTERVAL_MS. */
  reaperIntervalMs?: number;
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

/**
 * GOAL 145: the pool refusal classes, in ONE place.
 *
 * Before this the daemon's `poolRefusal()` (http.ts) kept a hand-written COPY
 * of these three message prefixes, and a reword here silently turned a named
 * 503 into a bare 500 `internal_error` for every client — the copy was the
 * rot. So the PREFIX lives here, next to the throw, and `http.ts` imports it:
 * a reword can no longer desync the emitter from the labeller.
 *
 * The KEY is the code, deliberately not derived from the prefix: a code is a
 * published contract string (a PHP consumer branches on it — see the generated
 * `Ui2apiException::$errorCode`), and contract strings are written down, not
 * computed. Only the prose follows the emitter.
 */
export const POOL_REFUSAL_CODES = {
  pool_saturated: "pool saturated ",
  pool_queue_timeout: "pool queue timeout ",
  pool_closed: "pool closed ",
} as const;

/** A code from `POOL_REFUSAL_CODES` — the set the daemon labels a 503 with. */
export type PoolRefusalCode = keyof typeof POOL_REFUSAL_CODES;

/* GOAL 87 — the reaper's default interval. 30s is frequent enough that a dead
   idle page is evicted long before the next request would have hit it, and rare
   enough that the probe (one `evaluate` round-trip per idle page) is noise. */
const DEFAULT_REAPER_INTERVAL_MS = 30_000;

/* GOAL 87 — what we may say about the browser. The old status was
   `this.browser ? "up" : "down"`, a NULL-CHECK wearing a liveness label: a
   disconnected-but-still-set handle answered "up" forever, because the respawn
   only happened inside the next ensureBrowser() — i.e. only when a REQUEST
   arrived, which a health-checker polling /status never does.
   - "up"       — a real probe talked to the handle and it is connected.
   - "down"     — no handle at all, or a handle whose liveness probe answered
                  "not connected" (or threw). Never reported for a live browser.
   - "unknown"  — a handle exists but exposes no liveness surface, so the truth
                  cannot be measured. The honest answer, never a false "up". */
export type BrowserLiveness = "up" | "down" | "unknown";

export interface BrowserProbe {
  state: BrowserLiveness;
  /* The named reason, always present: why this state and not another one. */
  reason: string;
  checkedAt: string;
}

/* GOAL 87 — per-worker health as last MEASURED. "unprobed" is the honest
   default: a page is only "live" after a real probe, and "dead" only after a
   probe failed (or the reaper evicted it). */
export type WorkerHealth = "live" | "dead" | "unprobed";

export interface PoolWorker {
  profileId: string;
  driver: ChatDriver;
  busy: boolean;
  /* Dedicated single-request workers (identity-keyed account) are created on
     demand, handed out once, and closed on release — they never join the idle
     pool, because a warm page carries the legacy default account. */
  dedicated?: { account: string };
  /* GOAL 87 — when this page was handed out (epoch ms). "busy: 1" with no start
     time is not diagnosable; busyMs is measured from THIS stamp, and is null
     (never a fabricated 0) whenever the page is not busy. */
  busySince?: number;
  /* GOAL 87 — the last MEASURED health of this page (the reaper's /status's
     per-worker view), with the time it was measured. */
  health?: WorkerHealth;
  checkedAt?: string;
}

export interface PoolWorkerStatus {
  /* Which site this page serves (the honest "which request is this page on"). */
  site: string;
  busy: boolean;
  /* How long this page has been busy, measured from busySince. null whenever
     the page is idle — a null is a fact, a 0 would be a guess. */
  busyMs: number | null;
  /* The identity-keyed account in flight, or null for the pool's shared default
     session (a warm page carries the legacy account — null says exactly that). */
  account: string | null;
  health: WorkerHealth;
  checkedAt: string | null;
  dedicated: boolean;
}

/* GOAL 87 — what one liveness sweep measured. Recorded even when it did
   nothing, so "the reaper ran and found nothing wrong" is a claim the daemon
   can back with numbers instead of silence. */
export interface SweepReport {
  checkedAt: string;
  checked: number;
  evicted: number;
  respawned: number;
  respawnFailed: number;
  sites: string[];
  note: string;
}

export type PoolStatus = {
  browser: BrowserLiveness;
  /* GOAL 87: WHEN the honest browser probe last ran (ISO), and WHY it answered
     what it answered. `null` only when the pool has never been probed at all. */
  browserCheckedAt: string | null;
  browserProbe: string;
  warm: number;
  /* GOAL 87: how many of the IDLE pages were PROVED live by their last measured
     probe. `warm` is kept byte-compatible (it counts idle pages, as it always
     did), but a page that has never been probed is NOT counted here — this is
     the number you can lean on, and it never counts an unmeasured page. */
  warmLive: number;
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
  /* GOAL 87: the busy/idle pages with their MEASURED detail, so "busy: 1" says
     which site, for how long, and under which account — no debugger attached. */
  workers: PoolWorkerStatus[];
  /* GOAL 87: the reaper's last measured sweep (null until one has run). */
  lastSweep: SweepReport | null;
  /* GOAL 87: is the liveness sweep running? A started-but-leaked reaper would
     keep the process alive; this makes the claim checkable, not assumed. */
  reaper: "running" | "stopped";
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
  // GOAL 103: slots RESERVED by an in-flight spawn. `workers.length` alone
  // undercounts: spawn() awaits a browser + driver start, so concurrent acquires
  // all saw the same pre-spawn length and every one of them spawned — measured
  // 2 live pages at max=1, which also bypassed the maxWaiters bound entirely
  // because the over-capacity branch sits after the spawn branch.
  private spawning = 0;
  private waiters: PoolWaiter[] = [];
  private readonly min: number;
  private readonly max: number;
  private readonly maxWaiters: number;
  private readonly waiterTimeoutMs: number;
  private readonly defaultProfile: string;
  private readonly dataDir: string;
  private readonly attach: boolean;
  /* GOAL 87 — the liveness reaper's timer. Owned by the pool, started
     EXPLICITLY (startReaper), stopped in close(): never a bare module-level
     setInterval that outlives the daemon or keeps the process alive. */
  private reaperTimer?: ReturnType<typeof setInterval>;
  private reaperMs = 0;
  private sweeping = false;
  private lastSweep: SweepReport | null = null;

  constructor(private readonly opts: PoolOptions) {
    const envMin = Number(process.env.UI2API_POOL_MIN);
    const min = opts.min ?? (Number.isFinite(envMin) && envMin >= 1 ? Math.floor(envMin) : 1);
    this.min = Math.max(1, min);
    this.max = Math.max(this.min, opts.max ?? resourceMax());
    this.maxWaiters = Math.max(0, opts.maxWaiters ?? envCount("UI2API_POOL_MAX_WAITERS", DEFAULT_MAX_WAITERS));
    this.waiterTimeoutMs = Math.max(0, opts.waiterTimeoutMs ?? envCount("UI2API_POOL_WAITER_TIMEOUT_MS", DEFAULT_WAITER_TIMEOUT_MS));
    this.reaperMs = Math.max(0, opts.reaperIntervalMs ?? envCount("UI2API_REAPER_INTERVAL_MS", DEFAULT_REAPER_INTERVAL_MS));
    this.dataDir = opts.dataDir ?? resolveDataDir();
    this.defaultProfile = opts.defaultProfile ?? opts.profiles[0]?.id ?? "";
    this.attach = Boolean(opts.attach || process.env.UI2API_ATTACH_PORT);
  }

  get attached(): boolean {
    return this.attach;
  }

  /* GOAL 87 — the honest liveness probe. It TALKS to the handle; the old status
     never did. A Playwright Browser answers isConnected() locally, so this is
     free to call on every /status read:
       - no handle            → "down"    (measured: there is no browser)
       - isConnected() true   → "up"      (measured: the handle is live)
       - isConnected() false  → "down"    (the lie this whole goal is about)
       - probe threw          → "down"    (a set handle that cannot be probed
                                          alive is not serving anyone)
       - no liveness surface  → "unknown" (the truth cannot be measured — and
                                          an honest "unknown", never a lie) */
  probeBrowser(): BrowserProbe {
    const checkedAt = new Date().toISOString();
    const b = this.browser as unknown as { isConnected?: () => boolean; contexts?: () => unknown[] } | undefined;
    if (!b) {
      return { state: "down", reason: "no browser handle: the pool has not spawned one (it spawns on the first request)", checkedAt };
    }
    if (typeof b.isConnected === "function") {
      try {
        if (b.isConnected()) return { state: "up", reason: "browser.isConnected() === true", checkedAt };
        return { state: "down", reason: "browser.isConnected() === false — the handle is set but the browser is disconnected (respawned on the next request)", checkedAt };
      } catch (e) {
        return { state: "down", reason: `liveness probe threw (${e instanceof Error ? e.message : String(e)}) — a handle that cannot answer is not a live browser`, checkedAt };
      }
    }
    if (typeof b.contexts === "function") {
      // A context count is NOT liveness: Playwright returns the cached list after
      // a disconnect, so "0 contexts" would still read as a live browser. Say
      // so honestly instead of guessing.
      return { state: "unknown", reason: "this browser handle exposes no isConnected() liveness surface — its liveness cannot be measured, so it is never reported as up", checkedAt };
    }
    return { state: "unknown", reason: "this browser handle exposes no liveness surface at all — reported as unknown, never as up", checkedAt };
  }

  async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    // A stand-by Chrome can die while idle (the sandboxed-Chromium crash this
    // host fights); respawn instead of handing the corpse to the next driver,
    // which would 500 every acquire until the daemon restarts.
    this.browser = undefined;
    const b = this.attach
      ? await connectExistingChrome(Number(process.env.UI2API_ATTACH_PORT))
      : await spawnChromeAndConnect({ headless: resolvedHeadless() });
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
        this.markBusy(w);
        return w;
      });
    }
    const existing = this.workers.find((w) => w.profileId === siteId && !w.busy);
    if (existing) {
      this.markBusy(existing);
      return Promise.resolve(existing);
    }
    // Atomic ceiling: the reservation is taken BEFORE the await and released in
    // `finally`, so a failed spawn cannot leak a slot and deadlock the pool.
    if (this.workers.length + this.spawning < this.max) {
      this.spawning++;
      return this.spawn(siteId)
        .then((w) => {
          this.workers.push(w);
          this.markBusy(w);
          return w;
        })
        .finally(() => {
          this.spawning--;
        });
    }
    // Over capacity: wait for the next free page — but only inside the two
    // bounds. GOAL 83.
    if (this.waiters.length >= this.maxWaiters) {
      return Promise.reject(
        new Error(
          `${POOL_REFUSAL_CODES.pool_saturated}(${this.waiters.length} waiting, limit ${this.maxWaiters}) — no page is free and the queue is full`
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
        this.markBusy(w);
        resolve(w);
      };
      if (this.waiterTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.settleWaiter(
            waiter,
            new Error(
              `${POOL_REFUSAL_CODES.pool_queue_timeout}after ${this.waiterTimeoutMs}ms waiting for a "${siteId}" page ` +
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
        // GOAL 119: this driver already opened a browser CONTEXT and a PAGE
        // (ChatDriver.start -> getPage -> newContext/newPage/goto). Leaving it
        // open leaks both, invisibly: the driver was never pushed to
        // this.workers, so close(), the reaper sweep and the max/spawning
        // accounting all skip it. If the driver launched its OWN browser
        // (ownsBrowser, when the shared one was dead) this also orphans a whole
        // chromium process. Close it before doing anything else.
        await driver.close().catch(() => undefined);
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
        // GOAL 119: in ATTACH mode this browser is the OPERATOR'S OWN Chrome,
        // reached over CDP. Closing it kills their real, signed-in browser —
        // their tabs, their session, their work. We own it only when we launched
        // it, so only then may we close it. Rotating an attached browser is a
        // no-op by design; the operator restarts their own Chrome if they want a
        // fresh instance.
        if (this.attach) {
          if (process.env.UI2API_DEBUG === "1") console.error("[ui2api] attach mode: not closing the operator's own browser on restart");
        } else {
          await this.browser.close();
        }
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

  // GOAL 87: hand a page out and STAMP when. `busy: 1` without a start time is
  // not diagnosable — /status now reports how long each busy page has been busy,
  // measured from this stamp.
  private markBusy(worker: PoolWorker): void {
    worker.busy = true;
    worker.busySince = Date.now();
  }

  // Return a page to the pool after a prompt. Unusable pages (browser died) are
  // discarded and replaced lazily. Dedicated account workers are closed right
  // away — they never idle back into the pool.
  async release(worker: PoolWorker): Promise<void> {
    worker.busy = false;
    worker.busySince = undefined;
    if (worker.dedicated) {
      this.workers = this.workers.filter((w) => w !== worker);
      await worker.driver.close();
      return;
    }
    const usable = await isWorkerUsable(worker);
    worker.health = usable ? "live" : "dead";
    worker.checkedAt = new Date().toISOString();
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
        this.markBusy(worker);
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

  /* GOAL 87 — start the liveness reaper. EXPLICIT (the daemon calls this) and
     pool-owned: a bare module-level setInterval would outlive the daemon and
     keep the process alive. The timer is unref'd AND cleared by close(), so a
     stopped daemon is a stopped daemon.
     `intervalMs` 0 (or UI2API_REAPER_INTERVAL_MS=0) disables it — honest opt-out,
     and /status then reports reaper:"stopped" rather than pretending one runs. */
  startReaper(intervalMs?: number): boolean {
    if (intervalMs !== undefined) this.reaperMs = Math.max(0, intervalMs);
    if (this.reaperMs <= 0) return false;
    if (this.reaperTimer) return true; // idempotent — never a second timer
    this.reaperTimer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, this.reaperMs);
    this.reaperTimer.unref?.();
    return true;
  }

  stopReaper(): void {
    if (!this.reaperTimer) return;
    clearInterval(this.reaperTimer);
    this.reaperTimer = undefined;
  }

  get reaperRunning(): boolean {
    return Boolean(this.reaperTimer);
  }

  get reaperIntervalMs(): number {
    return this.reaperMs;
  }

  /* GOAL 87 — ONE liveness sweep, and the numbers it measured.

     Before this existed there was no reaper anywhere in src/prompt/: the only
     liveness check for a page was isWorkerUsable() inside release(), so a page
     that died while IDLE kept reporting warm/idle (an ARRAY ENTRY, not a live
     page) until the next request happened to touch it. A health-checker
     polling /status therefore never learned anything.

     Rules that keep it honest:
       - a BUSY page is never evicted (it is mid-request; killing it would fail
         work that is actually running),
       - the sweep NEVER spawns a browser: a timer launching Chrome would be
         fabricated traffic. It re-warms only when the honest probe says the
         browser is up (the dead-page case), and records the refusal otherwise,
       - every count in the report is measured here, so "the reaper ran and
         found nothing wrong" is a checkable claim rather than silence. */
  async sweep(): Promise<SweepReport> {
    const checkedAt = new Date().toISOString();
    if (this.sweeping) {
      const busy: SweepReport = { checkedAt, checked: 0, evicted: 0, respawned: 0, respawnFailed: 0, sites: [], note: "a sweep is already running" };
      return busy;
    }
    this.sweeping = true;
    try {
      const sites: string[] = [];
      let checked = 0;
      let evicted = 0;
      for (const w of [...this.workers]) {
        if (w.busy) continue; // in use: never evicted mid-request
        checked++;
        const usable = await isWorkerUsable(w);
        w.health = usable ? "live" : "dead";
        w.checkedAt = new Date().toISOString();
        if (usable) continue;
        evicted++;
        this.workers = this.workers.filter((x) => x !== w);
        try {
          await w.driver.close();
        } catch {
          // tab already gone
        }
        if (!sites.includes(w.profileId)) sites.push(w.profileId);
        // A parked request is waiting for exactly this kind of replacement.
        this.drain(w.profileId);
      }
      let respawned = 0;
      let respawnFailed = 0;
      const probe = this.probeBrowser();
      for (const siteId of sites) {
        if (this.workers.length >= this.max) {
          respawnFailed++;
          continue;
        }
        if (probe.state !== "up") {
          // No browser to re-warm on (measured, not assumed): the next REQUEST
          // spawns one, exactly as it always did. The sweep stays silent about
          // it rather than pretending it did something.
          respawnFailed++;
          continue;
        }
        try {
          const w = await this.acquire(siteId);
          await this.release(w);
          respawned++;
        } catch {
          respawnFailed++;
        }
      }
      const report: SweepReport = {
        checkedAt,
        checked,
        evicted,
        respawned,
        respawnFailed,
        sites,
        note:
          evicted === 0
            ? `swept ${checked} idle page(s), none dead`
            : `evicted ${evicted} dead idle page(s) for [${sites.join(", ")}]; respawned ${respawned}, failed ${respawnFailed}${probe.state === "up" ? "" : ` (browser is ${probe.state}: left to the next request to spawn)`}`,
      };
      this.lastSweep = report;
      return report;
    } finally {
      this.sweeping = false;
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
    // GOAL 87: a REAL probe, not `this.browser ? "up" : "down"`.
    const probe = this.probeBrowser();
    const now = Date.now();
    return {
      browser: probe.state,
      browserCheckedAt: probe.checkedAt,
      browserProbe: probe.reason,
      warm: idle,
      warmLive: this.workers.filter((w) => !w.busy && w.health === "live").length,
      idle,
      busy,
      total: this.workers.length,
      max: this.max,
      queued: this.waiters.length,
      maxWaiters: this.maxWaiters,
      perSite,
      workers: this.workers.map((w) => ({
        site: w.profileId,
        busy: w.busy,
        // null when idle — a measured "not busy" is a fact, a 0 would be a guess.
        busyMs: w.busy && typeof w.busySince === "number" ? Math.max(0, now - w.busySince) : null,
        account: w.dedicated?.account ?? null,
        health: w.health ?? "unprobed",
        checkedAt: w.checkedAt ?? null,
        dedicated: Boolean(w.dedicated),
      })),
      lastSweep: this.lastSweep,
      reaper: this.reaperTimer ? "running" : "stopped",
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
    // GOAL 87: stop the reaper FIRST, before anything it might touch goes away.
    // A leaked interval would keep sweeping (and keep the process alive) after
    // the daemon was supposed to be gone — the leak pin asserts this flag, not a
    // stopwatch.
    this.stopReaper();
    // Shutdown settles EVERY queued waiter with a named cause before the
    // browser goes away. Never `this.waiters = []` (a silent drop: the parked
    // acquire() promises had no reject, so the awaiting HTTP handlers never
    // answered and their sockets kept server.close() waiting forever).
    this.settleAllWaiters(`${POOL_REFUSAL_CODES.pool_closed}(daemon shutdown)`);
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