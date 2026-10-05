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

/* GOAL 178 — the outcome of ONE boot warm, carrying the REAL cause of a failed
 * page open instead of an inference about it.
 *
 * WHY THIS EXISTS: `warm()` absorbed a per-page failure with `catch { break }`,
 * so its rejection never reached `http.ts` and NO error message existed to
 * report. GOAL 176 made the outcome visible on /status + /health, but composed
 * its `reason` from the pool's state read AFTER the attempt (idle pages + the
 * pool's liveness probe + attach mode) — so a real EACCES on the profile, a
 * missing Chrome binary and a refused attach port all read identically as
 * "cold pool / attach mode". This type is the measurement GOAL 176 had to infer.
 *
 * `site` is a single string, not a list, and that is HONEST rather than
 * premature: `warm()` warms exactly ONE site by construction (the default
 * profile, else the first configured one), so a list here would always hold one
 * element and would advertise a generality the method does not have. */
export type WarmOutcome = {
  /** The site the warm targeted; "" when there was no target at all. */
  site: string;
  /** Page-open attempts actually made — bounded by `min(needed, perSiteMax)`. */
  attempts: number;
  /** Attempts that opened a page and released it cleanly. */
  opened: number;
  /** Attempts that threw. */
  failed: number;
  /**
   * THE REAL CAUSE of the first failure, VERBATIM from the thrown error
   * (`Error.message`, or `String(e)` for a non-Error throw) — null when no
   * attempt failed. Never a summary, never a guess: this is what the throw
   * itself said, so an EACCES stays an EACCES.
   */
  reason: string | null;
};

/** A warm that measured nothing: no configured profile to warm. */
function noWarmOutcome(): WarmOutcome {
  return { site: "", attempts: 0, opened: 0, failed: 0, reason: null };
}

export interface BrowserProbe {
  state: BrowserLiveness;
  /* The named reason, always present: why this state and not another one. */
  reason: string;
  checkedAt: string;
}

/* GOAL 87 — per-worker health as last MEASURED. "unprobed" is the honest
   default: a page is only "live" after a real probe, and "dead" only after a
   probe failed (or the reaper evicted it).

   GOAL 171 — what each value PROVES, per worker, about that worker's OWN page:
     - "live"     — the driver's own page answered a CDP round-trip just now.
                    Nothing else can set it: not the context, not another
                    worker's page. This is the only value a consumer may read as
                    "this worker can serve".
     - "dead"     — the own page has a probe surface and did not answer within
                    the bound, or there is no page at all. MEASURED, so the
                    reaper may evict it.
     - "unprobed" — the handle exposes no own-page probe surface, so liveness
                    was NOT measured. It keeps its slot (evicting on an
                    unmeasured handle would be the same fabrication pointed the
                    other way) and is excluded from `warmLive`. */
export type WorkerHealth = "live" | "dead" | "unprobed";

export interface PoolWorker {
  /* GOAL 172 — STABLE, POOL-LOCAL identity, assigned once when the page is
   * created and never reused. This is the field that makes /status decidable:
   * without it, two reads of `workers[]` cannot be joined, so a health claim
   * cannot be tracked to a page, and nothing in the report can be matched
   * against a CDP target list. Assigned by the pool, so ids are unique within a
   * pool but mean nothing across pools or processes — and that is stated rather
   * than implied, because a number that looks globally unique would invite
   * exactly the cross-process comparison it cannot support. */
  id: number;
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
  /* GOAL 172 — a STABLE identity for this pool slot, assigned once at spawn and
   * never reused. Without it the workers array is undecidable: entries can be
   * reordered, evicted and respawned between two /status reads, so "the worker
   * that said live" cannot be tied to anything a second later, and nothing in
   * this report can be cross-referenced against a CDP target list. A respawn is
   * a NEW page, so it gets a new id — reusing one would claim continuity that
   * does not exist. */
  id: number;
  /* The page's own URL, which is the field an operator can actually match
   * against `curl localhost:9222/json`. Null when it cannot be read, never a
   * guess: an unreadable URL is a fact about the reader, not about the page. */
  pageUrl: string | null;
  busy: boolean;
  /* How long this page has been busy, measured from busySince. null whenever
   * the page is idle — a null is a fact, a 0 would be a guess. */
  busyMs: number | null;
  /* The identity-keyed account in flight, or null for the pool's shared default
   * session (a warm page carries the legacy account — null says exactly that). */
  account: string | null;
  health: WorkerHealth;
  checkedAt: string | null;
  /* GOAL 172 — ms since that health was MEASURED, or null when never measured.
   * `checkedAt` alone is a timestamp no reader has to interpret; this is the
   * arithmetic, so a 4-minute-old `live` is visibly four minutes old. */
  healthAgeMs: number | null;
  /* GOAL 172 — true when the health claim is OLDER than one health interval, so
   * it describes the past rather than the present. This is what stops a stale
   * `live` from reading as a current one.
   *
   * MEASURED, and the reason it matters: the sweep skips BUSY workers entirely
   * (`if (w.busy) continue`) so a page mid-request is never re-probed. Its
   * `health` and `checkedAt` therefore age without bound for the length of the
   * request, and /status reported that stale value with nothing marking it as
   * stale. The sweep skipping busy pages is CORRECT — evicting a page out from
   * under an in-flight request would be worse — so the fix is to make the age
   * visible, not to probe a page that must not be touched. */
  healthStale: boolean;
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
  /* GOAL 172 — monotonic, never reused. See PoolWorker.id for why the id is
   * minted at spawn and what it deliberately does NOT claim (it is pool-local,
   * so it must never be compared across pools or processes). */
  private nextWorkerId = 0;
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
  //
  // GOAL 178: it now RETURNS the outcome (it never threw and never will — see
  // the catch below) so `http.ts` can report the REAL cause instead of inferring
  // one from pool state read afterwards.
  async warm(): Promise<WarmOutcome> {
  const target = this.opts.profiles.some((p) => p.id === this.defaultProfile)
    ? this.defaultProfile
    : this.opts.profiles[0]?.id ?? "";
  if (!target) return noWarmOutcome();
  const needed = this.min - this.idleCount(target);
  // GOAL 156 (B): also bounded by the per-site reservation. `acquire()` past a
  // site's cap PARKS instead of spawning, and a parked acquire does not throw
  // — so a loop bounded only by `this.max` would park here forever and hang
  // daemon startup (`http.ts` awaits `pool.warm()`). The cap is the real
  // ceiling for a single-site warm-up, which is all this ever is.
  const ceiling = Math.min(needed, this.perSiteMax);
  const out: WarmOutcome = { site: target, attempts: 0, opened: 0, failed: 0, reason: null };
  for (let i = 0; i < ceiling; i++) {
    out.attempts++;
    try {
      const w = await this.acquire(target);
      await this.release(w);
      out.opened++;
    } catch (e) {
      // GOAL 156 (B) / GOAL 178 — THE CATCH IS LOAD-BEARING AND MUST SURVIVE.
      // It is what stops a boot warm from marching on past one dead site: the
      // GOAL-156 wedge class, where a single unbounded page open held a pool
      // slot forever (4.77h) and turned one wedged site into a whole-service
      // outage. The `break` below is the bound; removing it re-dispatch-free but
      // still re-attempts the same dead site `ceiling` times.
      //
      // GOAL 178 changed ONLY THE DISCARD, never the control flow: the cause is
      // captured into the returned outcome and the loop breaks EXACTLY as
      // before. `warm()` still never rejects — a daemon that cannot warm must
      // still start (a request opens its own page on demand), which is the
      // GOAL-176 failure mode this whole block exists to preserve.
      out.failed++;
      out.reason = e instanceof Error ? e.message : String(e);
      break;
    }
  }
  return out;
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
        /* GOAL 172 — the id is minted HERE, at page creation, and nowhere else.
         * Minting it at the point of reporting instead would be wrong: the array
         * can be reordered between reads, so an index-derived id would silently
         * change identity when a slot is evicted. `++this.nextWorkerId` is
         * monotonic and never reused, so a respawn is visibly a different page
         * rather than a re-indexed one. */
        return { id: ++this.nextWorkerId, profileId: siteId, driver, busy: false, dedicated };
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
      /* GOAL 240 — THE DROPPED IDLE WORKERS WERE NEVER TORN DOWN.
       *
       * `this.workers = []` used to be the whole eviction, and every OTHER
       * eviction in this file closes what it drops: the spawn-failure path
       * (:911), the measured-dead paths (:1049, :1056), the busy watchdog
       * (:1183), the sweep (:1289) and `close()` (:1444) all call
       * `driver.close()`. This one did not, so an IDLE worker's page was left
       * open with nothing left that could ever reach it: `drainWorker` is gated
       * on `this.workers.includes(worker)` (:1077) and `close()`/the sweep now
       * iterate an empty array. In attach mode that page is a tab in the
       * OPERATOR'S OWN Chrome, and it stays there for the life of that browser.
       * A BUSY dropped worker was never the visible symptom, because its own
       * later `release()` reaches `discardPage()` (:1069) — which is exactly
       * why this rotted unnoticed. And `/status` reported `0` workers the whole
       * time, so the pool respawned to `max` on top of the orphans.
       *
       * WHY ONLY THE IDLE ONES. Closing a BUSY worker here would be a NEW and
       * much worse defect: `restartBrowser()` runs from the spawn-failure path
       * (:915), which can fire while an unrelated request is mid-flight on
       * another page, and closing that page kills a live request out from under
       * its caller. A busy dropped worker already self-cleans — `release()`
       * tears its page down — and its slot is already excluded from the pool by
       * the `includes` gate, so nothing is handed out twice. So the busy case is
       * deliberately left alone: close what cannot self-clean, not what can.
       *
       * SAFE IN ATTACH MODE, and that is the reason it is not `this.browser`
       * above: `ChatDriver.close()` (src/prompt/driver.ts:960) closes the PAGE
       * alone when `defaultContext` is set — the shared context of an attached
       * browser is never touched — and reaches for `this.browser` only under
       * `ownsBrowser`, which is false for a pool driver (the pool always passes
       * a browser, driver.ts:242) and becomes true only for a browser the DRIVER
       * itself launched at driver.ts:295, which is never the operator's. The
       * attach gate at :936 is untouched by this change.
       *
       * Each close is guarded and the loop does not abort on one failure: a
       * wedged tab is one orphan, and the tabs after it would be orphans too if
       * the first throw ended the sweep. Same shape as `close()` (:1444). */
      const dropped = this.workers;
      this.workers = [];
      for (const w of dropped) {
        if (w.busy) continue; // in use: its own release() still tears this page down
        try {
          await w.driver.close();
        } catch {
          /* tab already gone */
        }
      }
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
    /* GOAL 239 — THE PAGE STAYS BUSY FOR THE WHOLE OF RELEASE.
     *
     * What was wrong: `worker.busy = false` was cleared HERE, at the TOP, and
     * `release()` then went on to await two things — `isWorkerUsable(worker)`
     * (bounded at WORKER_PROBE_TIMEOUT_MS, 5s) and `driver.discardPage()`.
     * That left a window of up to 5s in which the page was ADVERTISED IDLE
     * while the pool was still mid-teardown on it. MEASURED consequence: a
     * concurrent `acquire()` for the same site matched `!w.busy` at the reuse
     * scan, took the SAME object, and then the original `release()` finished
     * and called `discardPage()` on it — under that second request — while also
     * handing the same object to a queued waiter through `drainWorker`. Two
     * requests on one tab, which is precisely the residue ROUND N+104 forbids.
     * Parallel same-site agents are the documented common case, so the window
     * was not a corner: it was the normal path.
     *
     * The fix is to hold the flag and release it in ONE place, at the end.
     *
     * It cannot leak, which is the only way this trade could be worse: the
     * clearing lives in a `finally`, so a THROW anywhere in the probe, the
     * close, the discard or the drain still hands the slot back rather than
     * starving the pool with a page stuck busy forever. `keepInPool` is what
     * keeps that `finally` honest: a page that has just been removed from
     * `this.workers` (dedicated, or measured-dead) must NOT be handed to a
     * waiter by `drainWorker` — the same reason the `reclaimed` guard above
     * exists. `keepInPool` is set as the LAST statement of the surviving path,
     * so anything that throws before it drains nothing and leaks nothing.
     *
     * The `busySince` stamp is REFRESHED rather than left at the request's
     * start: the busy watchdog (`reclaimWedgedWorkers`) takes a page busy
     * longer than `busyWatchdogMs` back out of the pool, and the age it should
     * measure from here on is the age of the RELEASE, not of the request that
     * already finished. And because holding the flag makes that reclaim window
     * real, `drainWorker` is gated on the page still BEING in the pool — a
     * sweep that reclaims a slow release stamps `reclaimed` and removes it, and
     * handing that page to a waiter is the dead-page handoff the guard above
     * was written to prevent. */
    worker.busySince = Date.now();
    let keepInPool = false;
    try {
      if (worker.dedicated) {
        this.workers = this.workers.filter((w) => w !== worker);
        await worker.driver.close();
        return;
      }
      const usable = await isWorkerUsable(worker);
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
      keepInPool = true;
    } finally {
      worker.busy = false;
      worker.busySince = undefined;
      if (keepInPool && !worker.reclaimed && this.workers.includes(worker)) {
        this.drainWorker(worker);
      }
    }
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
        if (w.busy) continue; // in use: never probed or evicted mid-request (the watchdog above owns that case)
        checked++;
        const usable = await isWorkerUsable(w);
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
      workers: this.workers.map((w) => {
        /* GOAL 172 — the age of this worker's health claim, computed here rather
         * than left to the reader. `stale` is measured against the pool's own
         * health interval, because a value older than the interval between
         * measurements describes the past, not the page. */
        const checkedMs = w.checkedAt ? Date.parse(w.checkedAt) : NaN;
        const ageMs = Number.isNaN(checkedMs) ? null : Math.max(0, now - checkedMs);
        return {
          id: w.id,
          site: w.profileId,
          /* Best-effort and explicitly nullable. A page that has navigated to
           * about:blank, or a driver with no readable page, yields null rather
           * than a plausible-looking string. */
          pageUrl: readPageUrl(w),
          busy: w.busy,
          // null when idle — a measured "not busy" is a fact, a 0 would be a guess.
          busyMs: w.busy && typeof w.busySince === "number" ? Math.max(0, now - w.busySince) : null,
          account: w.dedicated?.account ?? null,
          health: w.health ?? "unprobed",
          checkedAt: w.checkedAt ?? null,
          healthAgeMs: ageMs,
          healthStale: ageMs === null ? true : ageMs > this.reaperMs,
          dedicated: Boolean(w.dedicated),
        };
      }),
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

/* How long this worker's own page gets to answer the round-trip below. A page
   that cannot answer inside this bound is not slow, it is unreachable, and an
   unbounded wait would let one wedged page wedge the whole reaper sweep.

   GOAL 170 — the number's justification status, which was previously UNSTATED.

   It was chosen to match `pageAlive(ms = 5000)` in `src/prompt/driver.ts`. That
   is a CONSISTENCY argument, and it was presented as if it were a correctness
   one. Recorded honestly, as measured on this box on 2026-09-30:

     `page.evaluate(() => 1)` round-trip, 10 samples per page over 4 real CDP
     pages (the pages the pool was actually holding, plus the other pages in the
     shared context):
       about:blank                            86.2, 2.7, 3.2, 2.5, 2.6, 2.5,
                                              2.5, 2.5, 2.4, 2.4   (n=10)
       claude.ai/login (sign-out wall)        32.4, 4.2, 2.5, 2.5, 2.6, 2.6,
                                              3.7, 2.9, 2.8, 2.7   (n=10)
       kimi.ai                                24.0, 2.6, 7.2, 6.0, 4.0, 3.2,
                                              3.6, 2.5, 2.7, 2.9   (n=10)
       venice.ai/chat/agent/E3nQ9oY (POOL)    7.0, 3.1, 2.9, 3.1, 3.3, 2.5,
                                              2.3, 2.5, 4.3, 5.5   (n=10)

     Worst observed sample: 86.2 ms (a cold first evaluate on a target). Steady
     state 2.3–7.2 ms. Highest: 86.2 ms. NOTHING approached 5 000 ms; the margin
     to the bound is ~58x on the worst sample.

   What that MEANS, and what it does NOT:

     - PARTIALLY JUSTIFIED. No measurement contradicts the bound, and the
       eviction cost the goal worried about — a merely-slow page evicted from the
       warm pool — was NOT observed: 0 evictions attributable to probe timeout in
       that window, 40/40 evaluates answered, 0 errors.
     - NOT FULLY JUSTIFIED, and deliberately not overclaimed here. The sample is
       THIN and it is the wrong shape for a guarantee: ONE pool-held site page
       (venice), 10 idle samples each, on a warm browser, with no BUSY page
       sampled and no breadth across the 22 chat models. A page under active
       request — the only state where an eviction would actually cost capacity —
       was never measured. A busy page is also the one state the sweep is
       explicitly forbidden from evicting (the busy watchdog owns that case), so
       the exposure is smaller than it looks, but it is not zero and it is
       UNMEASURED, not measured-and-fine.

   So: the number STAYS at 5 000 (nothing measured argues for raising it, and
   the cap exists to stop one wedged page wedging the sweep), but it is recorded
   here as a CONSISTENCY-MATCHED bound with partial, thin, idle-page evidence —
   NOT as a validated one. Anyone tightening or raising this should re-measure on
   a BUSY pool across several sites first; the raw sample above is the baseline
   to compare against. */
const WORKER_PROBE_TIMEOUT_MS = 5_000;

/* GOAL 169 — what a worker's health has to be MEASURED against.

   The previous check performed a real round-trip and then DISCARDED its answer
   (`await ...evaluate(() => 1).catch(() => {})`, the resolved value unused),
   and returned `_closed === false && pages().length > 0`. Both of those are
   facts about the CONTEXT OBJECT, not about the page's CDP target: a page whose
   target has been closed still leaves a context that reports itself open and
   still lists the stale page entry. So `live` was, in practice, the claim "this
   driver was not closed" wearing the name of a connection check.

   That is exactly the defect GOAL 157 named one layer up, and it was MEASURED on
   2026-09-30: `/status` reported a v0 worker `health:"live"` while CDP listed 17
   targets and none on v0.app, and the request behind it timed out with a named
   502.

   `live` now means what it says — the driver's OWN page answered a round-trip
   over CDP just now. The probe was already being paid for on every sweep and
   every release; this makes its answer count instead of discarding it, so the
   check costs exactly what it always cost and is true. It is not a louder
   check: no new field, no new probe, no extra work, only the existing
   measurement is finally read. A page that cannot be reached is not live.

   GOAL 170 — TWO RESIDUALS IN THIS FIX, both measured live on 2026-09-30 and
   both still open (this fix was NOT yet deployed when they were observed; see
   the audit file for the pipeline evidence).

   (a) THE FALLBACK CANDIDATE SET WEAKENS THE FIX. `candidates` is
       `[page, ...ctx.pages()]` and the probe is the FIRST entry that has an
       `evaluate`. All pool workers share ONE context (measured: 1 context, 4
       pages — about:blank, claude.ai, www.kimi.ai, venice.ai), so
       `ctx.pages()` is the WHOLE browser's page list. A worker whose own page is
       blank, wrong, or unproven can therefore be declared `live` because a
       NEIGHBOUR's page answered for it. This is provable from the code alone
       and is not hypothetical.

       Observed live: the pool reported two workers, `venice` and `copilot`,
       both `health:"live"` on 12/12 samples over ~58 s, while CDP listed NO
       copilot target at all in any sample. The only unattributed page in the
       context was `about:blank`, which answers `evaluate` in 2.4 ms — so the
       round-trip can be answered by a page that is not the site. The finding
       that GOAL 169 was written against (v0, `live` with no v0 tab) has now
       been reproduced on a different site, and it reproduces in the same shape.

       (b) NOT PROVEN AT ALL: that the new probe reports `dead` for that case. That
       requires the new build, and (a) predicts it would still report `live`.
       Treat "a vanished target now reads dead" as UNPROVEN, not as delivered.

   GOAL 171 — (a) IS NOW CLOSED, AND THE RESOLUTION IS ATTRIBUTION.

   The answer to the question GOAL 171 asked — "when the driver's own page cannot
   answer, is a neighbour's page an acceptable proxy?" — is NO, and the reason is
   already in this file: `probeBrowser()` refuses to read a `contexts()` COUNT as
   liveness because Playwright serves a cached list after a disconnect, and it
   reports "unknown" rather than "up" when there is no liveness surface at all. A
   second worker-health check that accepts a SHARED context's page as evidence
   about a page it does not own is that same error in a different hat, and it was
   measured doing exactly what the error predicts: 12/12 samples of
   `copilot=live` with no copilot target in CDP, the unattributed `about:blank`
   answering in 2.4 ms. The alternative — accept the proxy and rename the claim —
   was rejected because the consumers of this field make a routing decision from
   it, and a field that can be green while the worker holds nothing is the GOAL
   157 defect one layer down, not a documentation problem.

   So the probe asks ONE object: the driver's OWN page. There is no candidate
   list, and `ctx.pages()` is no longer consulted for the answer at all.

   Two things that were previously conflated are now three states, and the third
   is the honest one:

     - the own page has a probe surface and ANSWERS  → "live"   (attributed)
     - the own page has a probe surface and does not → "dead"   (measured)
     - the own page carries NO probe surface at all → "unprobed"

   The third case is a driver handle that exposes only a context, not a page. It
   is NOT reported "live" (nothing was measured, so nothing may be claimed) and it
   is NOT reported "dead" either — evicting a worker because we could not ask it
   is the same fabrication in the opposite direction, and it would cost real
   capacity. It keeps its slot, reports "unprobed" (a value this file has carried
   since GOAL 87 precisely for "not measured"), and is excluded from `warmLive`,
   which counts only pages a probe PROVED live. The GOAL 87 comment on
   `WorkerHealth` already says it: a page is only "live" after a real probe.

   The two shared-context facts the old tail also checked (`_closed`,
   `pages().length`) are gone, and deliberately: both are facts about the
   SHARED browser, not about this worker's page, so they could only ever
   contradict the worker's own answer, never support it. An own-page round-trip
   that resolves is strictly stronger evidence than either.

   The measured consequence, and the honest limit: a page whose CDP target is
   gone now reads `dead`, and a worker holding nothing can no longer be `live`.
   A handle with no probe surface is now VISIBLY unprobed instead of silently
   borrowing a neighbour's answer — which is a strictly smaller lie, and the
   only one this file is allowed to tell. */
/* GOAL 172 — the page URL, or null. This is the field an operator can actually
 * match against `curl -s localhost:<port>/json`, which is what makes the health
 * claim cross-referenceable rather than merely assertable.
 *
 * NULL IS A REAL ANSWER and the distinction is deliberate: a page parked on
 * about:blank, a driver exposing no page, and a page whose url() throws all
 * yield null, because "I could not read it" and "it is blank" are different
 * facts and conflating them is the class of error this whole report is trying
 * to stop making. A previous session's central finding was that a stale
 * `health:"live"` on a page that had already navigated away is exactly this
 * mistake wearing a green badge — so the URL that would have disproved it was
 * not in the report at all. */
function readPageUrl(w: PoolWorker): string | null {
  try {
    const page = (w.driver as unknown as { page?: { url?: () => unknown } }).page;
    if (!page || typeof page.url !== "function") return null;
    const u = page.url();
    return typeof u === "string" && u.length > 0 ? u : null;
  } catch {
    return null;
  }
}

async function probeWorkerHealth(w: PoolWorker): Promise<WorkerHealth> {
  try {
    const page: Page | undefined = (w.driver as unknown as { page?: Page }).page;
    if (!page) return "dead";
    if (typeof (page as Page).evaluate !== "function") return "unprobed";
    const answered = await Promise.race([
      page.evaluate(() => 1).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), WORKER_PROBE_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    return answered ? "live" : "dead";
  } catch {
    return "unprobed";
  }
}

/* `isWorkerUsable` keeps its name and its boolean contract for the two callers
   ("must this worker keep its slot?"), and RECORDS the measured verdict on the
   worker as it goes — a boolean cannot carry "measured dead" apart from "not
   probeable", and the difference is exactly what a reader of /status needs. */
async function isWorkerUsable(w: PoolWorker): Promise<boolean> {
  const health = await probeWorkerHealth(w);
  w.health = health;
  return health !== "dead";
}