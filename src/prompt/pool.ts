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
  /* GOAL 156 A#2 — the per-slot BUSY WATCHDOG bound and the seams the three
     derivations below read. These are CODE-level seams (constructor options),
     deliberately NOT `UI2API_*` knobs: this repo machine-pins its knob table
     (`AGENTS.md` + `test/ci-contract-knob-cites.test.ts`), and a new knob costs
     a documented row, while a documented-but-unread knob also fails. The three
     numbers below are DERIVED from `requestTimeoutMs` / `max` so they cannot
     drift apart; these options exist so a hermetic test can shrink them to
     milliseconds without touching the real 300s request deadline. */
  requestTimeoutMs?: number;
  busyWatchdogMs?: number;
  perSiteMax?: number;
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
 * GOAL 156 — the request deadline, and the three bounds DERIVED from it.
 *
 * A#2 MEASURED: `sweep()` skipped every busy worker (`if (w.busy) continue`) and
 * nothing else read `busySince`, so one driver hang — an unbounded
 * `page.evaluate` that never returns, so `driver.ask()` never settles and
 * `pool.release()` is never reached — cost the slot FOREVER. Measured
 * `busyMs` 282s → 333s → 1569s across two wedge events, and the pool SHRANK 4
 * → 2 during the first: the capacity loss is permanent, not transient. A
 * THROW cannot leak a slot (release runs in a `finally`); only a HANG can, and
 * the request-timeout `Promise.race` in http.ts cannot cancel the driver, so
 * nothing else in the process noticed.
 *
 * `DEFAULT_REQUEST_TIMEOUT_MS` is duplicated from http.ts ON PURPOSE at the
 * moment, because http.ts imports this module (importing it back would be a
 * cycle). It is the SAME number http.ts uses, and it is exported so http.ts can
 * import it from here instead of re-typing it (see the cross-slice report).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/** The daemon's aggregate per-request deadline, as the pool can see it. */
function resolveRequestTimeoutMs(explicit?: number): number {
  if (Number.isFinite(explicit) && (explicit as number) > 0) return Math.floor(explicit as number);
  const raw = Number(process.env.UI2API_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * GOAL 156 A#2 — the BUSY WATCHDOG: how long a page may hold a slot in flight
 * before the sweep reclaims it.
 *
 * POLICY: `floor(requestTimeout * 0.75)` — 225s at the 300s default.
 *   - STRICTLY BELOW the request deadline, so the wedge is caught BEFORE the
 *     client is told `request_timeout`: by the time the pool gives the slot
 *     back, the lost request is ONE request, not the pool's remaining lifetime.
 *   - ABOVE the worst LEGITIMATE occupancy, which http.ts measures as page.goto
 *     60s + the profile's captureMs (packaged max 120s) = ~180s, plus one
 *     realProfileOnly browser respawn. 225s leaves ~45s of headroom over a
 *     legitimate 180s round-trip, so a slow-but-alive page is never killed —
 *     the watchdog only ever fires on a page that has already stopped making
 *     progress.
 *
 * It is derived, never a second hand-typed number: raise
 * `UI2API_REQUEST_TIMEOUT_MS` and the watchdog moves with it.
 */
function deriveBusyWatchdogMs(requestTimeoutMs: number, explicit?: number): number {
  if (Number.isFinite(explicit) && (explicit as number) > 0) return Math.floor(explicit as number);
  return Math.max(1, Math.floor(requestTimeoutMs * 0.75));
}

/**
 * GOAL 156 — the per-site RESERVATION.
 *
 * B MEASURED: `max` is a GLOBAL ceiling with no per-site reservation and the
 * `perSite` map is REPORTING-ONLY, so four wedged workers for one site consumed
 * the whole pool and turned "4 broken sites" into "22 of 22 unanswerable".
 *
 * POLICY: one site may hold at most `max - 1` slots — **at least one slot is
 * always reservable by a different site**. The smallest honest reservation (1)
 * rather than half the pool, because the failure it must prevent is TOTAL
 * cross-site starvation, and a half-pool reservation would halve throughput for
 * every single-site workload (the common case) to defend against a case the
 * watchdog already bounds: with the watchdog in place one site cannot hold a
 * wedge for long anyway, so the reservation only has to survive the burst.
 * `max(1, …)` keeps `max = 1` working (one page, no reservation possible).
 *
 * Derived from `max`, not a knob: the knob table is machine-pinned, and a knob
 * an operator can set to 0 would turn the fairness off silently.
 */
function derivePerSiteMax(max: number, explicit?: number): number {
  if (Number.isFinite(explicit) && (explicit as number) > 0) return Math.floor(explicit as number);
  return Math.max(1, max - 1);
}

/**
 * GOAL 156 — the queue deadline, kept STRICTLY BELOW the request deadline.
 *
 * The old pair was two independent numbers: `waiterTimeoutMs` 240s against a
 * 300s request timeout, so the queue could not out-refuse the work it waits for
 * only by luck of the literals. Both are now derived from the same
 * `requestTimeout`: the default stays 240s at the 300s default (80% of it), and
 * ANY override — constructor option or `UI2API_POOL_WAITER_TIMEOUT_MS` — is
 * clamped down to 80% of the request deadline, so the relation holds by
 * construction under an operator's env too. `0` keeps meaning "no per-waiter
 * deadline" (the opt-out GOAL 83's tests use), because a disabled axis is not
 * a violated relation.
 */
/* GOAL 156 A#2 — how long the watchdog waits for a wedged driver's `close()`
   before giving up on it and moving on. Short and fixed: the page is already
   out of the pool (the slot is returned), so this only bounds how long one dead
   page delays the REST of the sweep, and a long wait would make the reaper look
   hung on exactly the pages it exists to rescue. */
const WATCHDOG_CLOSE_GRACE_MS = 5_000;

function deriveWaiterTimeoutMs(requestTimeoutMs: number, requested: number): number {
  const ceiling = Math.max(1, Math.floor(requestTimeoutMs * 0.8));
  if (requested <= 0) return 0;
  return Math.min(requested, ceiling);
}

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
  /* GOAL 156 A#2 — the busy watchdog took this page back while its request was
     still in flight. The late `release()` from the abandoned request must then
     be a no-op for the pool (the page is gone; re-draining or re-queueing it
     would double-count capacity and hand a closed page to a waiter). */
  reclaimed?: boolean;
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
  /* GOAL 156 A#2 — the BUSY WATCHDOG's own measurements, reported SEPARATELY
     from the idle-page liveness numbers above so the two are never conflated:
     `evicted` counts IDLE dead pages, this counts in-flight pages reclaimed
     after exceeding the busy bound. A sweep that reclaimed a wedged worker and
     found no dead idle page reads evicted:0 + wedgedReclaimed:1, which is the
     truth. Additive: every existing field keeps its meaning. */
  wedgedReclaimed: number;
  /* Which sites a reclaimed page was serving, so the report names the site whose
     driver hung rather than only counting it. */
  wedgedSites: string[];
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
  /* GOAL 156 — the bounds /status must be readable against, so a wedged pool is
     diagnosable without a debugger: the busy watchdog (how long a page may hold
     a slot) and the per-site reservation (how many slots one site may hold) and
     the request deadline both numbers come from. Additive. */
  busyWatchdogMs: number;
  perSiteMax: number;
  requestTimeoutMs: number;
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

/**
 * Minimum idle interval between requests, per site, in ms.
 *
 * `UI2API_SITE_MIN_INTERVAL_MS` is a JSON object keyed by site id, so an operator can
 * tune a site without a code change: `{"kimi":4000,"deepseek":4000}`. A site that is
 * absent falls back to `UI2API_DEFAULT_MIN_INTERVAL_MS`, which is NOT zero — a default
 * of zero would mean "no limit unless configured", and the whole point is that the safe
 * behaviour is the default behaviour.
 */
export function siteRateLimitMs(siteId: string): number {
  const raw = process.env.UI2API_SITE_MIN_INTERVAL_MS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const v = Number(parsed[siteId]);
      if (Number.isFinite(v) && v >= 0) return v;
    } catch {
      /* malformed config must not disable the limit — fall through to the default */
    }
  }
  const dflt = Number(process.env.UI2API_DEFAULT_MIN_INTERVAL_MS);
  return Number.isFinite(dflt) && dflt >= 0 ? dflt : 1_500;
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
  /* GOAL 156 (B): the SAME reservation, broken down per site. `spawning` alone
     is a global count, so a burst of concurrent acquires for ONE site could
     reserve every slot in the pool between them while each of them still saw
     that site holding none — see `siteWorkerCount`. */
  private spawningBySite = new Map<string, number>();
  private waiters: PoolWaiter[] = [];
  private readonly min: number;
  private readonly max: number;
  private readonly maxWaiters: number;
  private readonly waiterTimeoutMs: number;
  /* GOAL 156 — the three derived bounds, resolved ONCE in the constructor so a
     running pool's policy cannot change under a request (and so /status reports
     exactly the numbers acquire() and sweep() enforce). */
  private readonly requestTimeoutMs: number;
  private readonly busyWatchdogMs: number;
  private readonly perSiteMax: number;
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
    // GOAL 156: the request deadline first — the waiter deadline is clamped
    // against it, so the ORDER of these three lines is the invariant.
    this.requestTimeoutMs = resolveRequestTimeoutMs(opts.requestTimeoutMs);
    this.busyWatchdogMs = deriveBusyWatchdogMs(this.requestTimeoutMs, opts.busyWatchdogMs);
    this.perSiteMax = derivePerSiteMax(this.max, opts.perSiteMax);
    this.waiterTimeoutMs = deriveWaiterTimeoutMs(
      this.requestTimeoutMs,
      Math.max(0, opts.waiterTimeoutMs ?? envCount("UI2API_POOL_WAITER_TIMEOUT_MS", DEFAULT_WAITER_TIMEOUT_MS))
    );
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
    // GOAL 156 (B): also bounded by the per-site reservation. `acquire()` past a
    // site's cap PARKS instead of spawning, and a parked acquire does not throw
    // — so a loop bounded only by `this.max` would park here forever and hang
    // daemon startup (`http.ts` awaits `pool.warm()`). The cap is the real
    // ceiling for a single-site warm-up, which is all this ever is.
    for (let i = 0; i < Math.min(needed, this.perSiteMax); i++) {
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

  /* GOAL 156 (B) — how many slots this site currently HOLDS: its materialised
     pages (idle + busy) PLUS the slots it has RESERVED for spawns still in
     flight.

     Busy pages are counted on purpose: the whole failure is a site whose
     requests are wedged IN FLIGHT, so counting only idle pages would let a
     hung site keep adding capacity forever.

     The RESERVED slots are counted because `acquire()` is not `async` on
     purpose (see its pacing note), so every one of a burst of concurrent
     acquires for one site runs the capacity decision in the SAME synchronous
     turn — before ANY of them has materialised a page. MEASURED, this was the
     defect the cap existed to prevent: at max=4, perSiteMax=3, six concurrent
     `acquire("gemini")` calls each saw `siteWorkerCount("gemini") === 0`
     (nothing had spawned yet), so all four passed the per-site gate and took
     the WHOLE global ceiling between them. A different site arriving in that
     window then read `workers.length + spawning === max` and was parked, which
     is precisely the cross-site head-of-line blocking GOAL 156 set out to
     remove. A slot a site is ABOUT to hold is a slot it holds: the reservation
     is the per-site count, and the global ceiling is then reached from other
     sites rather than exhausted by one. */
  private siteWorkerCount(siteId: string): number {
    return (
      this.workers.filter((w) => w.profileId === siteId).length + (this.spawningBySite.get(siteId) ?? 0)
    );
  }

  /** Take/give back a spawn reservation for `siteId`, tracking the global total. */
  private reserveSpawn(siteId: string): void {
    this.spawning++;
    this.spawningBySite.set(siteId, (this.spawningBySite.get(siteId) ?? 0) + 1);
  }

  private releaseSpawnReservation(siteId: string): void {
    const held = this.spawningBySite.get(siteId) ?? 0;
    if (held <= 0) return;
    this.spawningBySite.set(siteId, held - 1);
    this.spawning--;
  }

  // Borrow a ready page for `siteId`, creating + warming one on demand (subject
  // to `max`); past capacity, wait for the next released page. An explicit
  // `account` (identity-keyed vault account, "default" = legacy) gets a
  // dedicated worker instead of a pooled page, so warm pages keep the default
  // account and per-account requests never pick up the wrong session.
  /**
   * ROUND N+107 — PER-SITE RATE LIMITING. The operator's requirement: kimi and
   * deepseek have lower limits, and nothing managed the request rate.
   *
   * This is the single most account-protective thing missing from the surface.
   * The whole premise of this project is that the traffic is indistinguishable
   * from a person's, and a person cannot send a chat message every 200ms from
   * twelve parallel agents. An agent integrating against /v1 is exactly the kind
   * of caller that WOULD, and the failure it causes is not a 429 — it is a
   * challenge on a real logged-in account, which is the one outcome this project
   * cannot recover from. Throttling here is cheaper than a ban by an enormous
   * margin.
   *
   * A slot being FREE is not permission to send. Before handing a worker out we
   * wait until this site has been idle for its own minimum interval, so the
   * cadence is per-SITE rather than per-pool: three agents on three different
   * sites never wait on each other, and five agents on the SAME site are paced
   * as one person typing.
   *
   * Limits are per-site because a site that tolerates bursts and one that does
   * not must not be given the same number. The default is deliberately
   * conservative, and a site with a known tighter limit is configured rather
   * than special-cased in code.
   */
  private async paceSite(siteId: string): Promise<void> {
    const limit = siteRateLimitMs(siteId);
    if (limit <= 0) return;
    for (;;) {
      const last = this.lastSendBySite.get(siteId) ?? 0;
      const waitFor = last + limit - Date.now();
      if (waitFor <= 0) {
        this.lastSendBySite.set(siteId, Date.now());
        return;
      }
      // Bounded: a pacing wait must never become a hung request. If the caller
      // is already gone by the time the wait ends, it simply proceeds — the
      // alternative is a deadlock between a timer and a client that walked away.
      await new Promise((r) => setTimeout(r, Math.min(waitFor, 5_000)));
    }
  }
  private readonly lastSendBySite = new Map<string, number>();

  /** `paceSite` as a plain promise step, for use inside a `.then()` chain. */
  private paced(siteId: string): Promise<void> {
    return this.paceSite(siteId);
  }

  /**
   * Borrow a ready page for `siteId`.
   *
   * NOT `async` on purpose (see the pacing note below): every step up to and
   * including QUEUE REGISTRATION must run in ONE SYNCHRONOUS TURN, so a caller
   * that asks for a page and immediately reads `queued` sees the truth.
   */
  acquire(siteId: string, account?: string, internal = false): Promise<PoolWorker> {
    if (account && account !== "default") {
      return (internal ? Promise.resolve() : this.paced(siteId)).then(() => this.spawn(siteId, account)).then((w) => {
        this.markBusy(w);
        return w;
      });
    }
    const existing = this.workers.find((w) => w.profileId === siteId && !w.busy);
    if (existing) {
      this.markBusy(existing);
      return Promise.resolve(existing);
    }
    /* NOTE — pacing scope, decided deliberately (the GOAL 156 lesson).
       `paceSite` gates the SPAWN branch below ONLY. It used to be the FIRST
       statement of `acquire()`, which made every capacity/queue decision happen
       one microtask LATER than the caller asked for it, and that broke the
       GOAL 83/87 queue contract in a way nothing had measured: a caller that
       calls `acquire()` and reads `queued` in the same turn saw 0 for a request
       that was already parked, and a second request's "is the queue full?" check
       ran after the first waiter's own 400ms deadline had already vacated the
       queue — so a genuinely saturated pool answered `pool_queue_timeout`
       instead of `pool_saturated`. MEASURED at default pacing (1500ms).

       Spawning a NEW page is the one branch that actually puts a browser on a
       site, so that is the one branch the site floor paces. Idle-page reuse and
       queue registration are bookkeeping on pages that already exist, and
       neither sends anything to the site — gating them buys no anti-bot
       property and costs the queue's visibility. The floor is still honoured on
       every request that genuinely starts a page. */
    // Atomic ceiling (GOAL 103): the reservation is taken BEFORE the await and
    // released in `finally`, so a failed spawn cannot leak a slot and deadlock
    // the pool.
    //
    // GOAL 156 (B) — the per-site RESERVATION, checked on the spawn branch only.
    // A page that is IDLE for this site was already found above, so this only
    // ever refuses to ADD capacity to a site that already holds its share. A
    // site at its cap falls through to the bounded queue below, so its request
    // parks (and is refused with a named cause at the waiter deadline) rather
    // than taking a slot that belongs to another site. This is what makes a
    // wedged site degrade to ITSELF: the reserve stays reachable by everyone
    // else even while this site is mid-storm.
    if (this.workers.length + this.spawning < this.max && this.siteWorkerCount(siteId) < this.perSiteMax) {
      this.reserveSpawn(siteId);
      // A failed spawn must not leak a slot (GOAL 103), on EITHER counter: the
      // global one and the per-site one, or a site that kept failing to warm
      // would stay at its cap forever with nothing holding it.
      let reserved = true;
      const release = (): void => {
        if (!reserved) return;
        reserved = false;
        this.releaseSpawnReservation(siteId);
      };
      return (internal ? Promise.resolve() : this.paced(siteId))
        .then(() => this.spawn(siteId))
        .then((w) => {
          this.workers.push(w);
          // The page is now a real worker, so the reservation must be given
          // back BEFORE it is counted as held: `siteWorkerCount` adds the
          // reservation to the materialised pages, and leaving it set for one
          // tick would double-count this slot against the site's own cap.
          release();
          this.markBusy(w);
          return w;
        })
        .finally(release);
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
  /**
   * ROUND N+104 — ONE REQUEST PER TAB: the slot is closed when the work is done.
   *
   * The operator's requirement, and it is the fix for three separate problems at
   * once: "the chrome must close the tab after it did what it intended, and the
   * pool only means the capacity we have — start and end one work at a time, a
   * full open/close of one site in one slot."
   *
   * What was wrong: the pool treated "warm" as "keep the page". A released page
   * kept its tab, its live conversation, its document title, and whatever toggles
   * the previous caller had flipped, and the next request was handed that
   * residue. Measured: a request unrelated to weather came back carrying
   * `"title":"Weather in Paris"` from the PRIOR conversation. The code could not
   * know that state, so it re-issued Playwright instructions into it and produced
   * answers that looked confident and belonged to somebody else.
   *
   * What is right: a slot is a CAPACITY, not a cache. The browser connection and
   * the session are what stay warm — those are the expensive parts and they are
   * what the anti-bot posture depends on. The TAB is per-request: opened, used,
   * closed. That makes the page state deterministic by construction rather than by
   * a hand-maintained list of things to clear, and it stops the tabs, contexts and
   * renderers from accumulating for the lifetime of a long-lived Chrome.
   *
   * The cost is one navigation per request, which is real, and it is the price
   * for "the next request starts from a state this code actually understands".
   */
  async release(worker: PoolWorker): Promise<void> {
    // GOAL 156 A#2: the LATE release of a request the watchdog already took
    // back. The page is out of the pool and its driver is closing; draining it
    // again would hand a dead page to a waiter and double-count the slot.
    if (worker.reclaimed) {
      worker.busy = false;
      worker.busySince = undefined;
      return;
    }
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
    // ROUND N+104 — the tab is per-request; the slot survives. Close the PAGE,
    // keep the BROWSER, so the next request in this slot opens clean while the
    // warm connection and session — the parts that are expensive and that the
    // anti-bot posture depends on — stay exactly as they were.
    // Guarded, because `release` runs on the error path too: a driver without
    // the method (an older variant, a test double) must not make release THROW,
    // or the slot is never drained and the queue stalls behind it. Failing to
    // close a tab is a leak we can observe; throwing here is a hang we cannot.
    try {
      await worker.driver.discardPage?.();
    } catch {
      /* a wedged tab is the next request's problem, and getPage() rebuilds */
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

  /**
   * `internal` (the third `acquire` argument) marks a POOL-INTERNAL re-acquire:
   * `drain()` handing a just-discarded slot's work to a fresh page.
   *
   * Such a hand-off is deliberately NOT paced. It starts no new traffic to the
   * site — the same slot that was just in use is being re-issued to a request
   * that is ALREADY parked, so the site floor buys no anti-bot property here.
   * Pacing it instead DELAYS SETTLEMENT: MEASURED, `drain()`'s re-acquire sat
   * behind the 1500ms site floor, so the waiter it was supposed to settle with a
   * named cause did not settle for the whole floor, and GOAL 83's
   * "drain() settles a queued waiter" pin went red on a wall clock (1000ms)
   * while the pool was doing nothing wrong.
   */
  private drain(siteId: string): void {
    const waiting = this.waiters.shift();
    if (!waiting || waiting.settled) return;
    // A page was discarded: serve the head waiter with a fresh one. GOAL 83:
    // BOTH outcomes settle the waiter — success hands it the page, failure
    // rejects it with the NAMED cause. The old `() => undefined` rejection
    // handler dropped the error on the floor and left the request pending
    // forever; if the re-acquire itself parks, the waiter's own queue deadline
    // still applies, so nothing stays unbounded.
    void this.acquire(siteId, undefined, true).then(
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

  /**
   * GOAL 156 A#2 — the BUSY WATCHDOG, and the only thing that makes a pool
   * survive a hang.
   *
   * A THROW cannot leak a slot: `release()` runs from the caller's `finally`.
   * A HANG does: `driver.ask()` never settles, so `release()` is never reached,
   * and the ONLY thing that could notice was the reaper — which explicitly
   * skipped busy pages ("in use: never evicted mid-request"). Measured: a busy
   * page's age climbed 282s → 333s → 1569s across two wedge events while the
   * pool shrank 4 → 2, i.e. the capacity loss was PERMANENT, and the
   * request-timeout `Promise.race` in http.ts could not help because a race
   * sends a 504, it does not cancel the driver.
   *
   * So: a page busy longer than `busyWatchdogMs` (derived from the request
   * deadline, see `deriveBusyWatchdogMs`) is taken BACK. Honest about what that
   * means: the in-flight request is still hung and will still fail — we are not
   * cancelling it, nothing in Node can — but its slot is returned to the pool,
   * so the wedge costs exactly ONE request instead of the pool's remaining
   * lifetime. The page is closed best-effort: `close()` on a driver stuck in
   * `page.evaluate` can hang too, so it is AWAITED WITH A BOUND and the sweep
   * continues either way rather than parking the whole reaper behind one
   * wedged page.
   *
   * `reclaimed` is stamped on the worker so the abandoned request's LATE
   * `release()` cannot double-count: by then the page is out of `this.workers`
   * and closing it again would hand a dead page to a waiter.
   */
  private async reclaimWedgedWorkers(now = Date.now()): Promise<{ count: number; sites: string[] }> {
    const wedged = this.workers.filter(
      (w) => w.busy && typeof w.busySince === "number" && now - w.busySince > this.busyWatchdogMs
    );
    if (wedged.length === 0) return { count: 0, sites: [] };
    const sites: string[] = [];
    for (const w of wedged) {
      w.reclaimed = true;
      w.busy = false;
      w.busySince = undefined;
      w.health = "dead";
      w.checkedAt = new Date().toISOString();
      this.workers = this.workers.filter((x) => x !== w);
      if (!sites.includes(w.profileId)) sites.push(w.profileId);
      // Bounded: a close() that never returns must not park the reaper. The
      // page is already out of the pool, so the slot is returned REGARDLESS of
      // how this resolves.
      await Promise.race([
        Promise.resolve(w.driver.close()).catch(() => undefined),
        new Promise((r) => setTimeout(r, Math.min(this.busyWatchdogMs, WATCHDOG_CLOSE_GRACE_MS))),
      ]);
      // A parked request for this site can now use the returned capacity.
      this.drain(w.profileId);
    }
    return { count: wedged.length, sites };
  }

  /* GOAL 87 — ONE liveness sweep, and the numbers it measured.

     Before this existed there was no reaper anywhere in src/prompt/: the only
     liveness check for a page was isWorkerUsable() inside release(), so a page
     that died while IDLE kept reporting warm/idle (an ARRAY ENTRY, not a live
     page) until the next request happened to touch it. A health-checker
     polling /status therefore never learned anything.

     Rules that keep it honest:
       - an IDLE page that is merely busy is never evicted for being busy (it is
         mid-request; killing it would fail work that is actually running) —
         EXCEPT past the GOAL 156 busy watchdog bound, which is the one case
         where "mid-request" has stopped being a reason to keep it,
       - the sweep NEVER spawns a browser: a timer launching Chrome would be
         fabricated traffic. It re-warms only when the honest probe says the
         browser is up (the dead-page case), and records the refusal otherwise,
       - every count in the report is measured here, so "the reaper ran and
         found nothing wrong" is a checkable claim rather than silence. */
  async sweep(): Promise<SweepReport> {
    const checkedAt = new Date().toISOString();
    if (this.sweeping) {
      const busy: SweepReport = { checkedAt, checked: 0, evicted: 0, respawned: 0, respawnFailed: 0, sites: [], note: "a sweep is already running", wedgedReclaimed: 0, wedgedSites: [] };
      return busy;
    }
    this.sweeping = true;
    try {
      const sites: string[] = [];
      let checked = 0;
      let evicted = 0;
      /* GOAL 156 A#2 — the BUSY WATCHDOG, run FIRST so a wedged slot is
         returned before anything else in this sweep is considered. */
      const wedgedReclaimed = await this.reclaimWedgedWorkers();
      const wedgedSites = wedgedReclaimed.sites;
      for (const w of [...this.workers]) {
        if (w.busy) continue; // in use: never evicted mid-request (the watchdog above owns that case)
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
        // GOAL 156 (B): a re-warm must obey the same per-site reservation acquire()
        // does. Past the cap `acquire()` PARKS rather than throwing, and a parked
        // acquire awaited HERE would park the whole reaper behind it — so the
        // sweep declines and records the refusal instead.
        if (this.siteWorkerCount(siteId) >= this.perSiteMax) {
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
      const wedgedNote =
        wedgedReclaimed.count === 0
          ? ""
          : ` reclaimed ${wedgedReclaimed.count} WEDGED in-flight page(s) busy > ${this.busyWatchdogMs}ms for [${wedgedReclaimed.sites.join(", ")}] (their request was hung; the slot is returned and the page closed)`;
      const report: SweepReport = {
        checkedAt,
        checked,
        evicted,
        respawned,
        respawnFailed,
        sites,
        wedgedReclaimed: wedgedReclaimed.count,
        wedgedSites: wedgedReclaimed.sites,
        note:
          wedgedNote +
          (evicted === 0
            ? `swept ${checked} idle page(s), none dead`
            : `evicted ${evicted} dead idle page(s) for [${sites.join(", ")}]; respawned ${respawned}, failed ${respawnFailed}${probe.state === "up" ? "" : ` (browser is ${probe.state}: left to the next request to spawn)`}`),
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
      busyWatchdogMs: this.busyWatchdogMs,
      perSiteMax: this.perSiteMax,
      requestTimeoutMs: this.requestTimeoutMs,
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