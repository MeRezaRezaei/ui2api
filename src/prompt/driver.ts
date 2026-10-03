// ChatDriver — the "use AI sites for doing prompts" engine. One instance = one
// browser page against one chat site profile. It reuses the same browser launch
// + session-cookie machinery as the rest of ui2api (real Chrome + profile when
// configured, zero-config fallback otherwise) and the same DOM primitives, so a
// prompt behaves exactly like a human typing it: paste + Enter runs the site's
// own JS, and the streamed answer is read off the page's event bus.
import { resolvedHeadless, launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { makeDomPrimitives, type DomPrimitives, type AnswerRegionRead } from "../runtime/dom-primitives.js";
import { injectSnapshot, loadAccountSnapshotVerdict, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { matchRestrictionMarkers, type RestrictionHit } from "../runtime/capability-probe.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface PromptOptions {
  newChat?: boolean;
  timeoutMs?: number;
  stableMs?: number;
  /** Request a specific model (id/name). Verified against the account's
   *  observed model list; errors explicitly when unavailable. */
  model?: string;
}

export interface PromptResult {
  answer: string;
  chunkCount: number;
  doneReason: "stable" | "timeout" | "empty" | "restricted";
  url: string;
  title: string;
  /** Source citations for query-driven sites (e.g. Google AI Mode), when any. */
  citations?: string[];
  /** In-band restriction hits (upgrade wall, plan limit, login gate...). */
  restrictions?: RestrictionHit[];
  /** Current selected model when readable. */
  model?: string;
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (truncated at ${n} chars)` : s;
}

/** A model picker row as the pure matcher sees it. */
export interface PickerRow {
  /** First line of the row's innerText (the display name). */
  text: string;
  /** data-model-id / data-value / element id — present only when it differs from the text. */
  id?: string;
}

/**
 * Pure, browser-free model-row matching used by ChatDriver.selectModel — pick
 * WHICH row a "select model X" click must target. Order (per the selectModel
 * contract: exact match first, substring demoted to LAST resort):
 *   1. exact: first-line text === target — a prefix-sharing row ("Gemini Pro")
 *      NEVER wins over the exact row ("Gemini");
 *   2. attr-id: the row's data-model-id/data-value/id === target — decisive
 *      when a row's id differs from its displayed name and the target is the id;
 *   3. substring LAST resort: case-insensitive text contains target — this is
 *      exactly the OLD locator.filter({ hasText }).first() behavior, which can
 *      click a prefix-sharing WRONG row (both rows contain "Gemini"), which is
 *      why it is the fallback, never the default.
 * Returns the index of the row to click, or null when no row matches at all.
 */
export function pickModelRowIndex(rows: PickerRow[], target: string): number | null {
  if (rows.length === 0) return null;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].text === target) return i;
  }
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i].id;
    if (id !== undefined && id !== rows[i].text && id === target) return i;
  }
  const tl = target.toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].text.toLowerCase().includes(tl)) return i;
  }
  return null;
}

/**
 * Pure, browser-free newChat reset verification (GOAL 46 stale-echo guard) —
 * injected signal seam so tests can exercise the verdict without a browser. A
 * reset is verified when EITHER signal is observable: the answer region emptied
 * (every mounted answer bubble gone) or the composer cleared. `null` = signal
 * not readable; false = honest no-reset — the caller must refuse to compose
 * into the still-mounted page (the per-ask readback baseline would also catch
 * the echo, but refusing up front is the loud, never-silent path).
 */
export interface NewChatResetSignals {
  answerRegionEmpty: boolean | null;
  composerEmpty: boolean | null;
}

export function newChatResetVerified(signals: NewChatResetSignals): boolean {
  return signals.answerRegionEmpty === true || signals.composerEmpty === true;
}

/**
 * How often the consent-wall wait re-reads the overlay's visibility.
 *
 * Short enough that a wall rendering at t=200ms is observed at t=200ms rather
 * than at the ceiling; long enough that 18 visibility reads over an 1800ms
 * ceiling is noise next to one round trip to a chat site. It does NOT change
 * the no-wall cost, which is bounded by the ceiling either way.
 */
export const CONSENT_WALL_POLL_MS = 100;

/**
 * The consent-wall wait — the ONE blind wait in the send path that may safely
 * become a bounded poll. Injected signal seam so the timing is measurable
 * without a browser or a real clock (same idiom as `newChatResetVerified`).
 *
 * The contract, and the reason this differs from `preComposeDelayMs`:
 *   - Acting on the wall means "click the site's own accept button, dwell
 *     settleMs, re-send". It can never dispatch the PROMPT sooner, because the
 *     prompt's own send happens before this wait and is untouched.
 *   - The wait may only END EARLY on the wall being OBSERVED VISIBLE, and only
 *     while the probe is honest. `isVisible` throwing is read as "not visible"
 *     (an unreadable signal is never a licence to skip the ceiling).
 *   - The CEILING IS A CEILING. A wall that never appears consumes the full
 *     `ceilingMs` and not one millisecond more: the last sleep is clamped to the
 *     remaining budget, so this can shave dead time but can never add to it.
 */
export interface ConsentWallSignals {
  /**
   * Is the site's own accept affordance visible RIGHT NOW?
   *
   * It takes the REMAINING BUDGET and must not exceed it. That parameter is the
   * whole reason the ceiling holds: the loop's deadline check happens before the
   * next read, but a read that starts with 200ms left would still overrun by its
   * own timeout if the probe were unbounded. Handing the remaining budget to the
   * probe is what makes "never more than the ceiling" true rather than aspirational
   * — measured, not assumed: with an unbounded 700ms probe the ceiling was
   * overshot to 2300ms against 1800ms, which is a REGRESSION against the flat
   * 1800ms wait this replaces.
   */
  isVisible: (budgetMs: number) => Promise<boolean>;
  /** Sleep for `ms` (virtual clock in tests). */
  sleep: (ms: number) => Promise<void>;
  /** Current reading of the clock in ms (virtual clock in tests). */
  now: () => number;
}

export interface ConsentWallVerdict {
  /** The wall was OBSERVED visible within the ceiling. */
  visible: boolean;
  /** Virtual ms actually spent waiting — never more than the ceiling. */
  waitedMs: number;
  /** How many visibility reads were spent getting here. */
  polls: number;
}

export async function awaitConsentWall(
  ceilingMs: number,
  signals: ConsentWallSignals,
  pollMs: number = CONSENT_WALL_POLL_MS,
): Promise<ConsentWallVerdict> {
  const startedAt = signals.now();
  const deadline = startedAt + Math.max(0, ceilingMs);
  let polls = 0;

  // ONE read happens unconditionally, even at a zero ceiling, because a wall that
  // is ALREADY visible costs nothing to observe and must not be missed. The flat
  // wait this replaces also read once, so skipping it would be a behaviour change
  // dressed as an optimisation.
  polls += 1;
  const firstBudget = Math.max(0, deadline - signals.now());
  if (await signals.isVisible(firstBudget).catch(() => false)) {
    return { visible: true, waitedMs: signals.now() - startedAt, polls };
  }

  for (;;) {
    // The deadline is checked BEFORE a read, not after: a read is the only thing
    // in this loop that costs real time, so discovering we are out of budget only
    // once the read has been paid for is exactly what overshot the ceiling.
    const remaining = deadline - signals.now();
    if (remaining <= 0) {
      return { visible: false, waitedMs: signals.now() - startedAt, polls };
    }
    await signals.sleep(Math.min(pollMs, remaining));
    polls += 1;
    const budget = Math.max(0, deadline - signals.now());
    if (await signals.isVisible(budget).catch(() => false)) {
      return { visible: true, waitedMs: signals.now() - startedAt, polls };
    }
  }
}

export interface ChatDriverOptions {
  /* Reuse an externally-owned browser (the daemon pool's). When set, close()
     only tears down this driver's context+page, never the browser. */
  browser?: Browser;
  /* Use the browser's existing default context (the attached user browser's
     logged-in session) instead of a fresh incognito context. Light-mode
     image/font/media blocking is skipped: routes can only attach at context
     creation, and the user's standing browser must keep its own look. */
  defaultContext?: boolean;
  dataDir?: string;
  /* Identity-keyed account to drive (email or vault slug). Defaults to the
     legacy single-account snapshot; pass "default" explicitly for it. */
  account?: string;
}

/**
 * GOAL 114: the readback had NO echo guard. When the answer selector also matches
 * the USER's own prompt bubble — true for the real builtin profiles `copilot`
 * (`[data-message-type="text"]`), `huggingchat` (`[data-testid="message"]`) and
 * the builtin `[class*="message"]` at src/profile/profile.ts:425 — a fresh
 * element appears at send time, and if the real answer is SHORTER than the
 * prompt the driver returned the user's own prompt verbatim as
 * `doneReason:"stable"`. MEASURED through the real reducer before the fix.
 *
 * The verdict is deliberately narrow: it fires on a VERBATIM/near-verbatim echo
 * of the sent text, not on mere shared vocabulary, so a site whose genuine
 * answer legitimately repeats a phrase from the prompt is still servable.
 */
export function isPromptEcho(answer: string, sent: string): boolean {
  const a = answer.trim();
  const p = sent.trim();
  if (!a || !p) return false;
  if (a === p) return true;
  // long prompts echoed inside a slightly larger region still count
  if (p.length >= 40 && (a.includes(p) || p.includes(a))) return true;
  return false;
}

export class ChatDriver {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private defaultContext: boolean;
  private page?: Page;
  private dom: DomPrimitives;
  private readonly dataDir: string;
  private readonly account?: string;

  constructor(
    private readonly profile: ChatSiteProfile,
    { browser, defaultContext = false, dataDir = resolveDataDir(), account }: ChatDriverOptions = {}
  ) {
    this.dataDir = dataDir;
    this.account = account;
    this.browser = browser;
    this.ownsBrowser = !browser;
    this.defaultContext = defaultContext;
    this.dom = makeDomPrimitives(() => this.getPage());
  }

  // Bounded liveness probe for the current page. A stand-by page can die while
  // idle; a dead page must be read as a transient crash (rebuild/retry) rather
  // than a changed site UI.
  private async pageAlive(ms = 5000): Promise<boolean> {
    if (!this.page) return false;
    return Promise.race([
      this.page.evaluate(() => 1).then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
  }

  /**
   * ROUND N+104 — drop the TAB, keep the BROWSER.
   *
   * The pool calls this when a request finishes. The page (and with it the
   * conversation, the document title, and any toggles the caller flipped) goes
   * away; the browser, its context and its injected session stay, because those
   * are the expensive parts and the reason a long-lived Chrome exists.
   *
   * Closing a page is a network round trip to the browser, so it is BOUNDED — a
   * hung close must not become a hung request, and a close that throws leaves the
   * driver with no page, which `getPage()` rebuilds on the next acquire.
   */
  async discardPage(): Promise<void> {
    const page = this.page;
    this.page = undefined;
    if (!page) return;
    try {
      await page.close({ runBeforeUnload: false });
    } catch {
      /* the browser is already gone or the tab is wedged; getPage() rebuilds */
    }
  }

  private async getPage(): Promise<Page> {
    if (this.page) {
      // A stand-by page can die (or wedge) while idle; probe it with a hard
      // bound so a corpse is rebuilt, never served as a fake "no composer".
      if (await this.pageAlive()) return this.page;
      this.page = undefined;
    }
    // A browser can die between spawn and context/page setup (CDP socket lingers
    // a moment); drop the corpse and relaunch rather than 500ing the request.
    let lastErr = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.browser && !this.browser.isConnected()) this.browser = undefined;
      if (!this.browser) {
        this.browser = await launchBrowser(3, { headless: headlessDefault() });
        this.ownsBrowser = true;
      }
      try {
        const usingDefaultContext = this.defaultContext && this.browser.contexts().length > 0;
        // Real-profile and headful modes inherit the user's actual viewport so the
        // fingerprinted screen dimensions match what the site's own JS sees in the
        // user's browser (audit item #6). Synthetic viewport is only for the
        // headless-only fallback where no real user is watching.
        const isInheritingViewport = usingDefaultContext || usingUserChrome() || !headlessDefault();
        const context = usingDefaultContext
          ? this.browser.contexts()[0]
          : await this.browser.newContext({
              viewport: isInheritingViewport
                ? null
                : { width: lightMode() ? 1024 : 1280, height: lightMode() ? 700 : 900 },
            });
        // Light mode (default): drop images/fonts/media so the page loads in a
        // fraction of the memory — chat UIs are text; this keeps headless Chrome
        // alive on memory-starved hosts and cuts load time dramatically. Skipped
        // for an existing (user's-attached) context, whose look we must not change,
        // and for real-profile/headed modes where resource blocking would leave
        // tell-tale empty boxes the site's own analytics can see (audit item #5).
        if (!usingDefaultContext && lightMode() && !usingUserChrome() && headlessDefault()) {
          await context.route("**/*", (route) => {
            const t = route.request().resourceType();
            if (t === "image" || t === "font" || t === "media") return route.abort();
            return route.continue();
          });
        }
        // Reuse the site's captured session: a full profile snapshot (cookies +
        // localStorage + sessionStorage + IndexedDB) when one exists, else the
        // legacy cookie file. The snapshot makes the fresh incognito context
        // indistinguishable from the user's logged-in session — so Gemini et al.
        // persist chat history into the real account.
          const host = new URL(this.profile.url).host;
          if (!usingDefaultContext) {
          // GOAL 124: a REQUESTED account that cannot be loaded REFUSES BY
          // NAME. The old code asked loadAccountSnapshot for a bare `null` and,
          // on null, fell through to the legacy cookie file and then to no
          // session at all — a refused (unknown / missing / corrupt /
          // wrong-shaped) account silently became an ANONYMOUS run that still
          // answered ok:true. Only the un-requested path may be anonymous.
          if (this.account && this.account !== "default") {
            const verdict = loadAccountSnapshotVerdict(this.dataDir, host, this.account);
            if (!verdict.snapshot) {
              const why = verdict.status === "shape-invalid" ? `shape-invalid: ${verdict.detail ?? "unknown field"}` : verdict.status;
              throw new Error(
                `no stored session for ${this.profile.id} account "${this.account}" on ${host} (${why}) — capture it ` +
                  `first (ui2api profile capture <url> --login) or omit account for the legacy default snapshot`
              );
            }
            await injectSnapshot(context, verdict.snapshot);
          } else {
            // No account requested: the legacy flat snapshot, else the legacy
            // cookie file, else an honest ANONYMOUS run (duckduckgo et al.).
            const snap = loadSnapshot(snapshotPath(this.dataDir, host));
            if (snap) {
              await injectSnapshot(context, snap);
            } else {
              const cookies = loadCookies(sessionPath(this.dataDir, host));
              if (cookies.length > 0) await context.addCookies(cookies as never[]);
            }
          }
        }
        this.page = await context.newPage();
        await this.page.goto(this.profile.url, { waitUntil: "domcontentloaded", timeout: 60000 });
        return this.page;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (!/Target page|context or browser has been closed|Execution context was destroyed/i.test(lastErr)) throw e;
        if (this.ownsBrowser) {
          try {
            await this.browser?.close().catch(() => {});
          } catch {
            // browser already gone
          }
        }
        this.browser = undefined;
      }
    }
    throw new Error(lastErr);
  }

  async start(): Promise<void> {
    await this.getPage();
  }

  // Pick the first selector that actually becomes visible on the page (profiles
  // carry a few candidate selectors because chat UIs rename classes constantly).
  // Each candidate gets a bounded wait: chat shells (e.g. Gemini) redirect from
  // the bare host to /app and only then hydrate the composer, so a snap
  // isVisible() at domcontentloaded can miss it. First candidate to become
  // visible wins; the per-call timeout keeps other callers unaffected.
  private async firstVisible(selectors: string[]): Promise<string | null> {
    for (const sel of selectors) {
      try {
        const loc = this.page!.locator(sel).first();
        await loc.waitFor({ state: "visible", timeout: 15000 });
        return sel;
      } catch {
        // selector syntax error, element absent, or it never became visible —
        // try the next candidate
      }
    }
    return null;
  }

  private async dismissOverlays(): Promise<void> {
    for (const sel of this.profile.dismiss ?? []) {
      try {
        const loc = this.page!.locator(sel).first();
        if (await loc.isVisible({ timeout: 300 })) await loc.click({ timeout: 1500 });
      } catch {
        // overlay already gone — fine
      }
    }
  }

  // GOAL 46 — verify a newChat click actually reset the conversation: the
  // answer region emptied or the composer cleared (the profile's own selectors
  // are the signals). Bounded re-poll for slow resets; an unverified reset is a
  // LOUD failure — never compose into the previous conversation and then
  // read the old answer back as the new one (the readback baseline would also
  // catch it, but the failure here is caught before any typing happens).
  private async verifyNewChatReset(): Promise<void> {
    const signals: NewChatResetSignals = { answerRegionEmpty: null, composerEmpty: null };
    const checks: string[] = [];
    const answerSel = this.profile.answer.join(", ") || "body";
    const deadline = Date.now() + 3000;
    for (;;) {
      // Signal 1: the answer region emptied (every mounted answer bubble gone).
      try {
        const region = await this.dom.readAnswerRegion(answerSel);
        signals.answerRegionEmpty = region.elementTexts.every((t) => !t.trim());
        const mounted = region.elementTexts.filter((t) => t.trim()).length;
        if (!signals.answerRegionEmpty && mounted > 0) checks.push(`answer region still shows ${mounted} mounted answer(s)`);
      } catch {
        signals.answerRegionEmpty = null;
      }
      // Signal 2: the composer cleared (input value or contenteditable text).
      if (this.profile.composer.length) {
        try {
          const p = await this.page!;
          const sel = this.profile.composer[0];
          const loc = p.locator(sel).first();
          const value = await loc.inputValue().catch(() => "");
          const inner = (value || ((await loc.evaluate("(el) => (el && el.innerText || '').trim()").catch(() => "")) as string)).trim();
          signals.composerEmpty = !inner;
          if (!signals.composerEmpty) checks.push(`composer still contains ${inner.length} char(s)`);
        } catch {
          signals.composerEmpty = null;
        }
      }
      if (newChatResetVerified(signals)) return;
      if (Date.now() >= deadline) break;
      await this.page!.waitForTimeout(250);
    }
    const detail =
      checks.length > 0 ? checks.join("; ") : "no reset signal readable (answer region and composer both unreadable after the click)";
    throw new Error(
      `newChat reset not verified on ${this.profile.id}: after clicking "${this.profile.newChat}" — ${detail}; ` +
        `refusing to compose into a non-reset page (stale-echo guard, GOAL 46)`
    );
  }

  // JS-function-indexed probe (verbatim 2026-09-20T10:01): when the profile
  // ships a live-captured index, call window.<root>.<method> in the page and
  // report ok/error honestly. reloadAfterSuccess implements the verbatim rule —
  // after a successful indexed call the page is refreshed so the server's view
  // of us is whole again before any DOM-driven work. No index = silent no-op
  // (the UI path stays the default everywhere).
  private async probeJsIndex(): Promise<void> {
    const idx = this.profile.jsIndex;
    if (!idx) return;
    // Bounded readiness: the site's own root+method only exist after the SPA
    // boots. Standalone proofs waited for boot; the driver probes right after
    // domcontentloaded, so wait (max ~15s, poll every 500ms) for the function
    // to actually exist. Never fabricated: if the root never appears, the call
    // is honestly reported as failed and the DOM path takes over.
    const deadline = Date.now() + 15000;
    for (;;) {
      const ready = await this.page!
        .evaluate(
          ({ root, method }: { root: string; method: string }) => {
            try {
              const o = (window as unknown as Record<string, unknown>)[root];
              return !!(o && typeof (o as Record<string, unknown>)[method] === "function");
            } catch {
              return false;
            }
          },
          { root: idx.root, method: idx.method }
        )
        .catch(() => false);
      if (ready || Date.now() >= deadline) break;
      await this.page!.waitForTimeout(500);
    }
    const res = await this.dom.jsCall(idx.root, idx.method, idx.args, {
      reloadAfterSuccess: true,
    });
    if (process.env.UI2API_DEBUG) {
      console.info(
        `[ui2api] indexed call ${idx.root}.${idx.method}: ${res.ok ? "ok" : "failed"} ${res.error ?? ""} (${res.networkHits.length} network hit(s))`
      );
    }
  }

  async ask(prompt: string, opts: PromptOptions = {}): Promise<PromptResult> {
    const text = String(prompt ?? "").trim();
    if (!text) throw new Error("prompt must not be empty");
    // Sandboxed Chromium occasionally dies mid-run on constrained hosts
    // ("Target page/context/browser has been closed"). Retry with a fresh
    // browser rather than failing the caller.
    const transient = /Target page|context or browser has been closed|Execution context was destroyed/i;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.askOnce(text, opts);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (transient.test(msg) && attempt < 3) {
          await this.close();
          continue;
        }
        throw e;
      }
    }
    throw new Error("unreachable");
  }

  private async askOnce(prompt: string, opts: PromptOptions): Promise<PromptResult> {
    const text = String(prompt ?? "").trim();
    if (!text) throw new Error("prompt must not be empty");
    await this.getPage();
    if (opts.newChat && this.profile.newChat) {
      try {
        await this.dom.click(this.profile.newChat);
        // Random 600–1300ms pause to match a human's post-click dwell time
        // (audit item #4 — page-visible deterministic waits are trivially fingerprinted).
        await this.page!.waitForTimeout(600 + Math.floor(Math.random() * 700));
        // GOAL 46 — verify the conversation actually reset (answer region
        // emptied / composer cleared). A click that did not reset must FAIL
        // loudly, never silently compose into the previous conversation and
        // then read the old answer back as the new one.
        await this.verifyNewChatReset();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("newChat reset not verified")) throw e;
        // no new-chat affordance clickable on this profile/revision — continue
        // in-page; the per-ask readback baseline (below) guarantees no stale
        // echo either way.
      }
    }
    await this.dismissOverlays();
    // JS-function-indexed entry (verbatim 2026-09-20T10:01): when the profile
    // carries a live-captured window.<root>.<method> for this site, probe it
    // first — the site's own function answers with its own session. Honest:
    // only fires when a capture shipped the index; ok:false is reported, never
    // fabricated as success. Profiles without a jsIndex keep the UI path.
    await this.probeJsIndex();
    // Model selection (capability reflection): when a specific model is
    // requested, verify it against the account's observed model list and
    // select it — or fail loudly instead of silently prompting on the wrong
    // model. This is the direct answer to "someone has Pro, some don't".
    if (opts.model) {
      await this.selectModel(opts.model);
    }
    const composer = this.profile.urlTemplate ? null : await this.firstVisible(this.profile.composer);
    if (!composer && !this.profile.urlTemplate) {
      if (!(await this.pageAlive())) {
        // page died mid-read — retried on a fresh browser, not reported as rot
        throw new Error("page died reading the composer — Target page, context or browser has been closed");
      }
      let title = "", url = "";
      try { title = await this.page!.title(); url = await this.page!.url(); } catch { /* page gone */ }
      throw new Error(
        `no composer found on ${this.profile.id} (${this.profile.url}) — the site UI may have changed. ` +
          `Tune ${this.profile.id} in src/profile/profile.ts or ship a JSON override (--profile FILE). ` +
          `Page title: ${title}, url: ${url}`
      );
    }
    // GOAL 46 — per-ask FRESHNESS BASELINE: snapshot the answer region BEFORE
    // the prompt is sent so awaitAnswer requires growth from a NEW element.
    // Without this, a warm pooled page (newChat defaults false; pool.ts:139
    // reuses idle workers) carries the previous prompt's static answer and
    // awaitAnswer's longest-element read would go "stable" on it, returning
    // prompt A's text as prompt B's answer — plausible success, wrong thing.
    const answerSel = this.profile.answer.join(", ") || "body";
    // GOAL 160 ANSWER-SHAPE: the profile's DECLARED non-answer regions (a
    // status / thinking / reasoning element). They are excluded from the answer
    // candidate set in the page read, and if the read settles on one of them and
    // nothing answer-shaped ever grew, the ask refuses with the named
    // doneReason "non-answer" instead of serving that text as the answer.
    const nonAnswerSel = (this.profile.capability?.nonAnswerSelectors ?? []).join(", ");
    let baseline: AnswerRegionRead | undefined;
    try {
      baseline = await this.dom.readAnswerRegion(answerSel, nonAnswerSel || undefined);
    } catch {
      baseline = undefined; // unreadable region — awaitAnswer snapshots at entry
    }
    // Send the prompt the way the site's own JS expects it. AI chat composers
    // (Copilot/ChatGPT/Claude) are controlled React inputs: `type` sets the
    // value in one shot (Playwright fill semantics) so the element does not
    // detach on every keystroke, then Enter fires the site's own send handler.
    // Query-driven capability sites (Google AI Mode) skip composer typing
    // entirely: the prompt goes in the URL ({q} = URL-encoded query), the
    // site's own JS renders answer + citations on the single loaded page.
    if (this.profile.urlTemplate) {
      const target = this.profile.urlTemplate.replace("{q}", encodeURIComponent(text));
      await this.page!.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
      // The SSR'd AI answer + citations arrive inside the page's init data; let
      // the site's own scripts finish hydrating, then read the streamed render.
      await this.page!.waitForTimeout(150 + Math.floor(Math.random() * 250));
    } else {
      // Cold-boot protection: some SPAs show the composer before the app can
      // actually dispatch a send (Tencent Hy Studio drops the Enter silently).
      // Dwell the site's own example prompts the way a human would.
      if (this.profile.preComposeDelayMs) {
        await this.page!.waitForTimeout(Math.round(this.profile.preComposeDelayMs + Math.random() * 600));
      }
      if (this.profile.send.kind === "click") {
        const sendSel = this.profile.send.selector;
        if (!sendSel) throw new Error(`${this.profile.id}: send.kind "click" requires a selector`);
        await this.dom.type(composer!, text);
        // Random 50–200ms gate between the last input event and the click — a real
        // human's eye-to-mouse travel time (audit item #7).
        await this.page!.waitForTimeout(50 + Math.floor(Math.random() * 150));
        await this.dom.click(sendSel);
      } else {
        await this.dom.type(composer!, text);
        await this.page!.waitForTimeout(50 + Math.floor(Math.random() * 150));
        await this.dom.press(composer, ["Enter"]);
      }
      // First-send consent wall (anonymous sites, live-verified on duck.ai):
      // the first send surfaces the site's own "Continue" overlay instead of
      // dispatching — acknowledging that button and pressing send again runs
      // the REAL send through the site's own JS. The wall's JS stays in charge;
      // this only answers the site's prompt, exactly like the user would.
      if (!this.profile.urlTemplate && this.profile.consentWall?.accept) {
        const wall = this.profile.consentWall;
        const accept = this.page!.locator(wall.accept).first();
        // Poll for the site's OWN overlay at a short interval and proceed the
        // moment it is actually visible, up to the SAME ceiling the blind wait
        // used. Safe where the pre-compose dwell is not: this runs AFTER the
        // prompt was dispatched, so acting on it can only mean "acknowledge and
        // re-send" — it can never send the prompt earlier than we already do.
        // The click + settleMs that follow are unchanged, so the site's own
        // post-accept re-arm window is the same as before.
        const { visible: wallVisible } = await awaitConsentWall(wall.waitMs ?? 1800, {
          isVisible: (budgetMs) => accept.isVisible({ timeout: budgetMs }).catch(() => false),
          sleep: (ms) => this.page!.waitForTimeout(ms),
          now: () => Date.now(),
        });
        if (wallVisible) {
          await accept.click({ timeout: 3000 }).catch(() => undefined);
          await this.page!.waitForTimeout(wall.settleMs ?? 900);
          if (this.profile.send.kind === "click" && this.profile.send.selector) {
            await this.dom.click(this.profile.send.selector);
          } else {
            await this.dom.press(composer, ["Enter"]);
          }
        }
      }
    }
    // Read the streamed answer off the page: stop when the FRESH text stops
    // growing — the read is judged against the pre-ask baseline (GOAL 46), so
    // the previous conversation's static answer can never be judged stable or
    // echoed back.
    const observed = await this.dom.awaitAnswer(
      answerSel,
      {
        timeoutMs: opts.timeoutMs ?? this.profile.captureMs,
        stableMs: opts.stableMs ?? this.profile.stableMs,
        ...(nonAnswerSel ? { nonAnswerSelector: nonAnswerSel } : {}),
      },
      baseline
    );
    const answer = (observed.text ?? "").trim();
    const doneReason = observed.doneReason;
    if (doneReason === "non-answer") {
      // GOAL 160: the read settled on an element this profile DECLARED
      // non-answer (a status region, a thinking block, a pre-answer
      // placeholder) and no answer-shaped text ever grew. Serving that text
      // would be a 200 carrying a plausible-looking non-answer into a caller's
      // context as fact, which is the class this gate exists to kill. Refuse
      // with the evidence, exactly as the stale-echo and answer-echo guards
      // below refuse: never a partial answer, never a fabrication.
      throw new Error(
        `answer-not-an-answer on ${this.profile.id}: the readback settled on a region this profile ` +
          `declares NON-answer and no answer-shaped text ever appeared, so the request is refused ` +
          `rather than answered with a status line (read ${JSON.stringify(observed.nonAnswer?.selector)}, ` +
          `text ${JSON.stringify(observed.nonAnswer?.text)} — never returned as the answer). ` +
          `Re-tune the profile: narrow \`answer\` to the real answer container and/or add the status/thinking ` +
          `element to \`capability.nonAnswerSelectors\`.`
      );
    }
    if (doneReason === "stale") {
      // Honest verdict, never the old echo: the region NEVER changed from the
      // pre-ask baseline — the previous answer stayed mounted the whole time
      // and no new element grew. Refuse loudly instead of returning prompt
      // A's text as prompt B's answer (the GOAL-45 fidelity class).
      throw new Error(
        `no fresh answer appeared on ${this.profile.id} within ${opts.timeoutMs ?? this.profile.captureMs}ms — ` +
          `the region never changed from the per-ask baseline (previous answer still mounted; stale-echo guard, GOAL 46). ` +
          (this.profile.newChat
            ? `A newChat reset was requested but did not verifiably clear the conversation — send newChat:true (resets are verified) or check the ${this.profile.newChat} selector.`
            : `This profile has no newChat affordance — send newChat:true or reset the conversation before asking again.`)
      );
    }
    // GOAL 114: refuse a prompt echo BEFORE it can be served as an answer. This
    // is a NAMED refusal, not a silent truncation and not a `stable` success.
    if (isPromptEcho(answer, prompt)) {
      throw new Error(
        `answer-echo on ${this.profile.id}: the answer region returned the sent prompt verbatim — ` +
          `the answer selector matches the USER bubble, so nothing was actually read back ` +
          `(sent ${prompt.trim().length} chars, got back ${answer.length} chars, identical). ` +
          `Re-tune the profile's answer selector so it excludes the user's own message.`
      );
    }
    // Capability reflection, L2 (in-band): scan the page for restriction
    // markers (upgrade walls, plan limits, login gates). When a marker hits we
    // say so explicitly — a caller can fall back to another site/model instead
    // of receiving a blind "empty" or a wall's text as the "answer".
    const restrictions = await this.readRestrictions();
    if (!answer) {
      if (restrictions.length > 0) {
        return {
          answer: "",
          chunkCount: 0,
          doneReason: "restricted",
          url: observed.url,
          title: observed.title,
          restrictions,
          ...(await this.readModel().then((m) => (m ? { model: m } : {}))),
        };
      }
      throw new Error(
        `no answer appeared on ${this.profile.id} within ${opts.timeoutMs ?? this.profile.captureMs}ms. ` +
          (this.profile.loginRequired
            ? `This site requires sign-in. ${this.profile.loginHint}.`
            : "The page may be behind a consent wall — tune the profile's `dismiss` selectors.")
      );
    }
    // Query-driven sites (Google AI Mode): gather the source citations that
    // rendered alongside the answer so the caller gets {answer, citations[]}
    // instead of a bare text blob.
    let citations: string[] = [];
    if (this.profile.urlTemplate && this.profile.citations?.length) {
      try {
        citations = (await this.page!.evaluate((sels: string[]) => {
          const seen = new Set<string>();
          const out: string[] = [];
          for (const sel of sels) {
            for (const a of document.querySelectorAll(sel)) {
              const href = (a as HTMLAnchorElement).href;
              const t = ((a as HTMLAnchorElement).innerText || href || "").trim();
              if (href && !seen.has(href)) {
                seen.add(href);
                out.push(t ? `${t} — ${href}` : href);
              }
            }
          }
          return out;
        }, this.profile.citations)) as string[];
        // Cap an unruly citation list; prefer "title — url" or just url.
        citations = citations.slice(0, 12).map((c) => c.slice(0, 300));
      } catch {
        // citations are best-effort — the answer itself is the contract
      }
    }
    return {
      answer: cap(answer, 60000),
      chunkCount: observed.chunkCount,
      doneReason,
      url: observed.url,
      title: observed.title,
      ...(citations.length ? { citations } : {}),
      ...(restrictions.length ? { restrictions } : {}),
      ...(await this.readModel().then((m) => (m ? { model: m } : {}))),
    };
  }

  // --- Capability reflection helpers (L2 watch + L3 select) ---

  /** Scan the page's visible text for the profile's restriction markers. */
  private async readRestrictions(): Promise<RestrictionHit[]> {
    const markers = this.profile.capability?.restrictionMarkers;
    if (!markers?.length) return [];
    try {
      const text = await this.page!.evaluate(() => (document.body?.innerText ?? "").slice(0, 40000));
      return matchRestrictionMarkers(text, markers);
    } catch {
      return [];
    }
  }

  /** Best-effort: current selected model name from the picker options. */
  private async readModel(): Promise<string | null> {
    const opts = this.profile.capability?.pickerOption;
    if (!opts?.length) return null;
    try {
      return await this.page!.evaluate((sels: string[]) => {
        for (const sel of sels) {
          for (const el of document.querySelectorAll(sel)) {
            const selected =
              (el as HTMLElement).getAttribute?.("aria-selected") === "true" ||
              /selected|checked|active/i.test((el as HTMLElement).className?.toString() ?? "");
            if (selected) {
              const name = ((el as HTMLElement).innerText || "").trim().split("\n")[0];
              if (name) return name.slice(0, 80);
            }
          }
        }
        return null;
      }, opts) as string | null;
    } catch {
      return null;
    }
  }

  /**
   * Model selection: require `model` to be in the account's observed list,
   * open the picker and click it, then verify it took. Errors explicitly when
   * the account lacks the model (e.g. Pro-only model on a free plan) — the
   * caller can then fall back, never a silent wrong-model prompt.
   */
  private async selectModel(model: string): Promise<void> {
    const cap = this.profile.capability;
    const needters = cap?.pickerOpen?.length || cap?.pickerOption?.length;
    if (!needters) {
      throw new Error(`${this.profile.id}: model selection requested but the profile has no picker selectors`);
    }
    // Open the picker FIRST — the option rows only exist inside the open
    // overlay (per verified gemini DOM: cdk-overlay-pane), so reading them
    // before opening always yields an empty observed list.
    if (cap?.pickerOpen?.length) {
      try {
        const trigger = cap.pickerOpen[0];
        const loc = this.page!.locator(trigger).first();
        await loc.waitFor({ state: "visible", timeout: 8000 });
        await loc.click({ timeout: 4000 });
        await this.page!.waitForTimeout(1500);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`${this.profile.id}: could not open the model picker (${msg})`);
      }
    }
    const observed = await this.readObservedModels();
    const want = model.toLowerCase();
    const found = observed.find((m) => m.id.toLowerCase() === want || m.name.toLowerCase() === want);
    if (!found) {
      throw new Error(
        `model "${model}" not available on this account (observed: [${observed.map((m) => m.id).join(", ")}])`
      );
    }
    try {
      const target = found.id !== found.name ? found.id : found.name;
      // Click the matching option row. WHICH row is decided by the pure
      // pickModelRowIndex matcher (exact first-line → attr-id → substring
      // LAST resort) — never a blind substring hasText .first() click: with
      // observed ["Gemini Pro", "Gemini"] and a "Gemini" request, substring +
      // DOM order would click "Gemini Pro" and the prompt would silently run
      // on the wrong model.
      let clicked = false;
      for (const sel of cap?.pickerOption ?? []) {
        try {
          const rows = (await this.page!.locator(sel).evaluateAll((els: Element[]) =>
            els.map((el) => {
              const elt = el as HTMLElement;
              const text = (elt.innerText || "").trim().split("\n")[0].trim();
              const id = elt.getAttribute?.("data-model-id") || elt.getAttribute?.("data-value") || elt.id || text;
              return { text, id: id !== text ? id : undefined } as PickerRow;
            })
          )) as PickerRow[];
          const idx = pickModelRowIndex(rows, target);
          if (idx !== null) {
            await this.page!.locator(sel).nth(idx).click({ timeout: 4000 });
            clicked = true;
            break;
          }
        } catch {
          // try next selector
        }
      }
      if (!clicked) {
        // Fallback: the same three-step match over every selector's DOM rows
        // (pickModelRowIndex's semantics, mirrored in-page). The returned
        // boolean is HONORED: false = no row matched at all → loud failure,
        // never a silent proceed (the old code discarded this return value).
        const ok = await this.page!.evaluate(
          ([selList, tgt]) => {
            const rows: Array<{ text: string; id?: string }> = [];
            const els: Element[] = [];
            for (const sel of selList) {
              for (const el of document.querySelectorAll(sel)) {
                const elt = el as HTMLElement;
                const text = (elt.innerText || "").trim().split("\n")[0].trim();
                const id = elt.getAttribute?.("data-model-id") || elt.getAttribute?.("data-value") || elt.id || text;
                rows.push({ text, id: id !== text ? id : undefined });
                els.push(el);
              }
            }
            for (let i = 0; i < rows.length; i++) if (rows[i].text === tgt) { (els[i] as HTMLElement).click(); return true; }
            for (let i = 0; i < rows.length; i++) if (rows[i].id !== undefined && rows[i].id !== rows[i].text && rows[i].id === tgt) { (els[i] as HTMLElement).click(); return true; }
            const tl = tgt.toLowerCase();
            for (let i = 0; i < rows.length; i++) if (rows[i].text.toLowerCase().includes(tl)) { (els[i] as HTMLElement).click(); return true; }
            return false;
          },
          [cap?.pickerOption ?? [], target] as [string[], string]
        );
        if (!ok) throw new Error(`model "${model}" did not take — no picker row matched`);
        clicked = true;
      }
      await this.page!.waitForTimeout(500);
      // Verify it took (the documented contract — "then verify it took" — now
      // implemented HERE): re-scan the picker rows for a selected-state marker
      // (aria-selected="true" / checked / active class, via readModel()). A
      // DIFFERENT selected row means the click did not take — throw loudly,
      // never prompt on the wrong model. When the site exposes NO observable
      // selected-state (readModel() stays null), the exact-row click + no
      // exception stands: there is no signal to verify against, and the click
      // already targeted the exact row.
      const deadline = Date.now() + 1500;
      let current: string | null = null;
      for (;;) {
        current = await this.readModel();
        if (current === found.name || current !== null || Date.now() >= deadline) break;
        await this.page!.waitForTimeout(150);
      }
      if (current !== null && current !== found.name) {
        throw new Error(`model "${model}" did not take (still on "${current}")`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${this.profile.id}: failed to select model "${model}" — ${msg}`);
    }
  }

  /** Observed model list: DOM picker options (id/name), best-effort. */
  private async readObservedModels(): Promise<Array<{ id: string; name: string }>> {
    const opts = this.profile.capability?.pickerOption;
    if (!opts?.length) return [];
    try {
      return (await this.page!.evaluate((sels: string[]) => {
        const out: Array<{ id: string; name: string }> = [];
        const seen = new Set<string>();
        for (const sel of sels) {
          for (const el of document.querySelectorAll(sel)) {
            const name = ((el as HTMLElement).innerText || "").trim().split("\n")[0];
            if (!name || name.length > 80 || seen.has(name)) continue;
            seen.add(name);
            const id =
              (el as HTMLElement).getAttribute?.("data-model-id") ||
              (el as HTMLElement).getAttribute?.("data-value") ||
              (el as HTMLElement).id ||
              name;
            out.push({ id, name });
          }
        }
        return out.slice(0, 24);
      }, opts)) as Array<{ id: string; name: string }>;
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.defaultContext) {
      // The attached user browser's shared context must stay alive — only the
      // worker's own tab (this driver's page) is closed.
      try {
        await this.page?.close();
      } catch {
        // page already gone
      }
    } else {
      try {
        await this.page?.context()?.close();
      } catch {
        // context already gone
      }
    }
    if (this.ownsBrowser) {
      try {
        await this.browser?.close();
      } catch {
        // browser already gone
      }
    }
    this.page = undefined;
    this.browser = undefined;
  }
}

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return resolvedHeadless();
}

function lightMode(): boolean {
  return process.env.UI2API_LIGHT !== "0";
}