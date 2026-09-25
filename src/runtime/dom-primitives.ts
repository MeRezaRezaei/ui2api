// Shared DOM primitives behind every ui2api execution context. A single
// implementation backs both createContext (generated servers / hub) and the
// ChatDriver (AI-site prompting), so the send flow behaves identically
// everywhere: paste -> Enter (the SITE's own JS runs) -> awaitAnswer reads the
// streamed response off the page like the event bus it is.

import { execJsFunction, type JsCallResult } from "./js-exec.js";

export interface DomPrimitives {
  click(selector: string): Promise<string | void>;
  type(selector: string, text: string): Promise<string | void>;
  waitFor(selector: string, timeoutMs?: number): Promise<string | void>;
  extract(expr: string): Promise<unknown>;
  // JS-function-indexed call (verbatim 2026-09-20T10:01): invoke a captured
  // window.<root>.<method>(...) directly in the page instead of mouse/keyboard.
  jsCall(
    rootName: string,
    method: string,
    args?: unknown[],
    opts?: { reloadAfterSuccess?: boolean }
  ): Promise<JsCallResult>;
  // JS-level primitives — keyboard/paste events, not mouse simulation.
  paste(selector: string, text: string): Promise<unknown>;
  press(selector: string | null, keys: string[]): Promise<unknown>;
  capture(selector: string, untilMs?: number): Promise<unknown>;
  // Stable-wait read for streamed answers: poll until the FRESH text (elements
  // that did not exist in the pre-ask baseline) stops growing for `stableMs`
  // (or the budget expires). GOAL 46: an optional per-ask FRESHNESS BASELINE
  // (the pre-ask answer region — captured before the prompt was sent) makes the
  // read require growth from a NEW element; a warm pooled page's previous
  // answer is never judged "stable" and never echoed. The returned doneReason
  // distinguishes "stable" (the fresh text stopped growing), "timeout" (grew
  // but never settled), "empty" (nothing fresh ever appeared) and "stale"
  // (only the pre-existing answer was present — the region never changed from
  // the baseline; the text field is "" in that case, never the old echo).
  awaitAnswer(
    selector: string,
    opts?: { timeoutMs?: number; stableMs?: number; pollMs?: number },
    baseline?: AnswerRegionRead
  ): Promise<{
    text: string;
    chunkCount: number;
    url: string;
    title: string;
    doneReason: AnswerDoneReason;
  }>;
  // Read the current answer region: every selector-matching element's trimmed
  // innerText (DOM order) + the longest — the per-ask freshness baseline and
  // the newChat reset signal both come from this.
  readAnswerRegion(selector: string): Promise<AnswerRegionRead>;
  status(selector?: string): Promise<unknown>;
}

// --- Answer-readback freshness core (GOAL 46 stale-echo guard) --------------
// The daemon pool reuses warm pages across prompts (pool.ts:139/acquire,
// http.ts:396 newChat defaults false) and chat pages keep every answer bubble
// mounted, so a naive longest-element read goes "stable" on the PREVIOUS
// prompt's static answer and returns it as the current one — plausible success
// on the wrong thing, no error, no hint. The core below is PURE and
// browser-free: the browser loop feeds it reads, unit tests inject fixture
// reads without a browser. A "fresh" element is one that did not exist in the
// pre-ask baseline (beyond the baseline's element count, or whose text was not
// present in the baseline region) — judgement runs on the fresh text, never on
// the pre-ask longest.

export interface AnswerRegionRead {
  /** Longest matching element's trimmed innerText (never used for the verdict —
   *  kept so callers see the region as a browser would). */
  text: string;
  /** Every matching element's trimmed innerText in DOM order (the region set). */
  elementTexts: string[];
}

export interface AnswerBaseline {
  elementTexts: string[];
  maxText: string;
}

export type AnswerDoneReason = "stable" | "timeout" | "empty" | "stale";

export interface AnswerPollState {
  last: string;
  lastChange: number;
  maxFresh: string;
  chunkCount: number;
  madeProgress: boolean;
  doneReason: AnswerDoneReason;
}

/** Snapshot the pre-ask region into a freshness baseline. */
export function snapshotBaseline(region: AnswerRegionRead): AnswerBaseline {
  return { elementTexts: region.elementTexts, maxText: region.text };
}

/**
 * Pure freshness reducer: given a poll read + the pre-ask baseline, split the
 * region into the FRESH text (elements that did not exist before the ask) and
 * whether the region changed at all. The fresh text is the longest element
 * text among new elements — when the site mounted a new (empty) bubble that
 * streams, the fresh text grows; when only the old answer is present, fresh is
 * "" and changed is false, so the caller never goes "stable" on the old echo.
 */
export function freshRegion(
  region: AnswerRegionRead,
  baseline: AnswerBaseline
): { fresh: string; changed: boolean } {
  const baseTexts = new Set(baseline.elementTexts);
  let fresh = "";
  for (let i = 0; i < region.elementTexts.length; i++) {
    const t = region.elementTexts[i];
    // New by position (beyond the pre-ask count — chat pages append bubbles)
    // or new by content (text the pre-ask region never had — covers in-place
    // container reuse and mid-stream restarts).
    const isNew = i >= baseline.elementTexts.length || !baseTexts.has(t);
    if (isNew && t.length > fresh.length) fresh = t;
  }
  const changed =
    region.elementTexts.length !== baseline.elementTexts.length ||
    region.text !== baseline.maxText;
  return { fresh: fresh.trim(), changed };
}

export function initAnswerPollState(nowMs: number): AnswerPollState {
  return { last: "", lastChange: nowMs, maxFresh: "", chunkCount: 0, madeProgress: false, doneReason: "timeout" };
}

/**
 * One poll step of the freshness-aware awaitAnswer state machine (pure). The
 * loop below calls this with each browser read; tests call it with injected
 * fixture reads. Returns the next state; `doneReason` flips to "stable" the
 * moment the fresh text has been unchanged for `stableMs`.
 */
export function stepAnswerPoll(
  state: AnswerPollState,
  region: AnswerRegionRead,
  baseline: AnswerBaseline,
  nowMs: number,
  stableMs: number
): AnswerPollState {
  const { fresh, changed } = freshRegion(region, baseline);
  const next: AnswerPollState = {
    ...state,
    chunkCount: state.chunkCount + 1,
  };
  if (changed && !state.madeProgress) {
    // First evidence the ask produced something: start judging on the fresh
    // text. Until this fires, the read is EXACTLY the pre-ask region (the old
    // answer) — it must never initialize stability.
    next.madeProgress = true;
    next.last = fresh;
    next.lastChange = nowMs;
    next.maxFresh = fresh;
    return next;
  }
  if (!state.madeProgress) return next;
  if (fresh.length > state.maxFresh.length) next.maxFresh = fresh;
  if (fresh !== state.last) {
    next.last = fresh;
    next.lastChange = nowMs;
  } else if (fresh && nowMs - state.lastChange >= stableMs) {
    next.doneReason = "stable";
  }
  return next;
}

/**
 * The full freshness-aware awaitAnswer loop over an injected read function —
 * the same loop the browser path runs, so fixture tests (no browser) exercise
 * the production verdict logic verbatim. Returns the fresh text seen (never
 * the baseline's text), the number of polls, and an honest doneReason:
 * "stable" / "timeout" / "empty" / "stale" (see the interface comment).
 */
export async function awaitAnswerFromReads(
  read: () => Promise<AnswerRegionRead>,
  opts: { timeoutMs?: number; stableMs?: number; pollMs?: number } = {},
  baseline?: AnswerRegionRead
): Promise<{ text: string; chunkCount: number; doneReason: AnswerDoneReason }> {
  const { timeoutMs = 30000, stableMs = 1800, pollMs = 400 } = opts;
  const t0 = Date.now();
  const base = snapshotBaseline(baseline ?? (await read()));
  let state = initAnswerPollState(t0);
  let stable = false;
  while (!stable && Date.now() - t0 < timeoutMs) {
    const region = await read();
    state = stepAnswerPoll(state, region, base, Date.now(), stableMs);
    stable = state.doneReason === "stable";
    if (!stable) await new Promise((r) => setTimeout(r, pollMs));
  }
  const text = state.maxFresh.trim();
  let doneReason = state.doneReason;
  if (doneReason === "timeout" && !text) {
    // Nothing fresh ever appeared: "stale" means pre-existing content (the old
    // answer) was present the whole time and the read never changed — the true
    // stale-echo signal, reported honestly instead of echoing that content;
    // a baseline that was already empty is a plain "empty" (no answer at all).
    doneReason = state.madeProgress ? "empty" : base.maxText ? "stale" : "empty";
  }
  return { text, chunkCount: state.chunkCount, doneReason };
}

export function makeDomPrimitives(getPage: () => Promise<any>): DomPrimitives {
  const pageFn = async (): Promise<any> => getPage();

  return {
    async click(sel) {
      await (await pageFn()).locator(sel).first().click({ timeout: 5000 });
    },
    async type(sel, text) {
      // Trusted input: `keyboard.insertText` fires real, isTrusted input events
      // (CDP Input.insertText), unlike Playwright's fill() which sets the value
      // via one synthetic JS assignment + a fabricated input event. For React
      // composers this is both closer to a human paste AND immune to the
      // "value set in one shot" detections. Same speed on CDP.
      const p = await pageFn();
      const loc = p.locator(sel).first();
      await loc.focus();
      await p.keyboard.insertText(String(text));
    },
    async waitFor(sel, timeoutMs = 5000) {
      await (await pageFn()).locator(sel).first().waitFor({ timeout: timeoutMs });
    },
    async extract(expr) {
      const p = await pageFn();
      const m = expr.trim().match(/^(text|attr|json)\s+(\S+)(?:\s+(\S+))?$/);
      if (!m) return (await p.evaluate(() => document.body.innerText)) as string;
      const [, kind, sel, arg] = m;
      return p.evaluate(
        ({ sel, kind, arg }: { sel: string; kind: string; arg?: string }) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (!el) return null;
          if (kind === "text" || kind === "json") return el.innerText;
          if (kind === "attr") return el.getAttribute(arg as string);
          return null;
        },
        { sel, kind, arg }
      );
    },
    // JS-function-indexed call: run the site's OWN function by name instead of
    // driving the DOM with mouse/keyboard. The verbatim's second execution mode.
    async jsCall(rootName, method, args, opts = {}) {
      const p = await pageFn();
      return execJsFunction(
        async () => p,
        { root: rootName, method, params: [], sampleArgs: args ?? [] },
        { args: args ?? [], reloadAfterSuccess: opts.reloadAfterSuccess }
      );
    },
    // Drive the site's own JS by playing the exact keyboard/paste events a real
    // user would send, then read the event-bus chunks the site streams. No mouse.
    // The paste is REAL: write the text to the OS clipboard, then press Ctrl+V so
    // the browser synthesizes a trusted paste event with real clipboardData.
    // (Previously this fabricated a ClipboardEvent with isTrusted:false and
    // pre-inserted the text — a trivially detectable sequence. Real Ctrl+V is
    // indistinguishable from a human paste.)
    async paste(sel, text) {
      const p = await pageFn();
      const loc = p.locator(sel).first();
      await loc.focus();
      try {
        // Grant clipboard-write at the current origin so the browser lets us
        // write the OS clipboard, then send the real keyboard shortcut.
        await loc.press("ControlOrMeta+A");
        await p.evaluate(async (payload: string) => {
          // clipboard-write is granted at context level by Playwright's
          // grantPermissions when the run is configured for it; without a grant
          // the write silently rejects and we fall back to insertText below.
          await navigator.clipboard.writeText(payload);
        }, String(text));
        await p.keyboard.press("ControlOrMeta+V");
      } catch {
        // No clipboard grant: fall back to trusted insertText (still a real
        // input sequence, just without the literal paste event).
        await p.keyboard.insertText(String(text));
      }
      return { insertedChars: String(text).length };
    },
    async press(sel, keys) {
      const p = await pageFn();
      if (sel) await p.locator(sel).first().focus();
      for (const k of keys) await p.keyboard.press(k);
      return { pressed: keys };
    },
    async capture(sel, untilMs = 4000) {
      const p = await pageFn();
      return p.evaluate(
        async ({ sel, budgetMs }: { sel: string; budgetMs: number }) => {
          const target = document.querySelector(sel) as HTMLElement | null;
          if (!target) throw new Error(`capture: selector not found: ${sel}`);
          const chunks: Array<{ t: number; text: string; delta?: string }> = [];
          const seen = new Map<Text, number>();
          const mo = new MutationObserver((muts) => {
            for (const m of muts) {
              const node = m.type === "characterData" ? m.target : null;
              if (node instanceof Text) seen.set(node, node.textContent?.length ?? 0);
            }
            const text = target.innerText;
            chunks.push({ t: Date.now(), text: text.slice(0, 400) });
          });
          mo.observe(target, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
          const t0 = Date.now();
          while (Date.now() - t0 < budgetMs) await new Promise((r) => setTimeout(r, 120));
          mo.disconnect();
          for (let i = 1; i < chunks.length; i++) chunks[i].delta = chunks[i].text.slice(chunks[i - 1].text.length);
          return {
            text: target.innerText,
            chunks,
            chunkCount: chunks.length,
            url: location.href,
            title: document.title,
            readyState: document.readyState,
          };
        },
        { sel, budgetMs: untilMs }
      );
    },
    // Read the answer region (every matching element's trimmed innerText + the
    // longest) — the per-ask freshness baseline and the newChat reset signal.
    async readAnswerRegion(selector) {
      const p = await pageFn();
      return readAnswerRegionFromPage(p, selector);
    },
    async awaitAnswer(selector, opts = {}, baseline) {
      const p = await pageFn();
      const read = (): Promise<AnswerRegionRead> => readAnswerRegionFromPage(p, selector);
      // Per-ask FRESHNESS BASELINE (GOAL 46): when the caller (ChatDriver)
      // captured the pre-ask region before composing, require growth from a NEW
      // element; without one, snapshot at entry — either way the pre-existing
      // answer can never be judged "stable" or echoed. Poll from the Node side:
      // each read is a tiny anonymous leaf evaluation (no named functions —
      // esbuild's __name helper is invalid inside a page).
      const res = await awaitAnswerFromReads(read, opts, baseline);
      const meta = (await p.evaluate(() => ({ url: location.href, title: document.title }))) as { url: string; title: string };
      return { ...res, url: meta.url, title: meta.title };
    },
    async status(sel) {
      const p = await pageFn();
      return p.evaluate(
        ({ sel }: { sel?: string }) => {
          const target = sel ? (document.querySelector(sel) as HTMLElement | null) : null;
          return {
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            bodyTextLength: (document.body?.innerText ?? "").length,
            targetText: target ? target.innerText.slice(0, 200) : undefined,
          };
        },
        { sel }
      );
    },
  };
}

/** In-page answer-region read shared by readAnswerRegion/awaitAnswer
 *  (anonymous leaf function — no named helpers inside the page). */
async function readAnswerRegionFromPage(p: any, selector: string): Promise<AnswerRegionRead> {
  return (await p.evaluate((sel: string) => {
    const els = document.querySelectorAll(sel);
    const list: string[] = [];
    let best = "";
    for (const el of els) {
      const t = ((el as HTMLElement).innerText ?? "").trim();
      list.push(t);
      if (t.length > best.length) best = t;
    }
    return { text: best, elementTexts: list };
  }, selector)) as AnswerRegionRead;
}