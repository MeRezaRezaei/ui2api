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
    opts?: { timeoutMs?: number; stableMs?: number; pollMs?: number; nonAnswerSelector?: string },
    baseline?: AnswerRegionRead
  ): Promise<{
    text: string;
    chunkCount: number;
    url: string;
    title: string;
    doneReason: AnswerDoneReason;
    nonAnswer?: { text: string; selector: string };
  }>;
  // Read the current answer region: every selector-matching element's trimmed
  // innerText (DOM order) + the longest — the per-ask freshness baseline and
  // the newChat reset signal both come from this. `nonAnswerSelector` names the
  // per-site elements that are NOT the answer (thinking/reasoning/status
  // regions); elements matching it are excluded from the candidate set.
  readAnswerRegion(selector: string, nonAnswerSelector?: string): Promise<AnswerRegionRead>;
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

// --- GOAL 160: the ANSWER-SHAPE gate ---------------------------------------
// The freshness core above judges WHERE the text came from (a new element),
// never WHAT it is. A status region ("Cooking…"), a thinking block, or a
// pre-answer placeholder is a NEW element, so it goes "stable" and is served
// as the answer — HTTP 200, plausible prose, no error. That is the class this
// gate exists to kill.
//
// The predicate is ELEMENT-STRUCTURAL, never a guess about English prose: the
// per-site profile declares the elements that are not the answer
// (`capability.nonAnswerSelectors`) and the site itself marks them. A site that
// declares nothing is judged exactly as before — the gate never invents a
// signal, so a profile with no declaration cannot regress into a false
// refusal. A refusal always names WHICH declared signal fired.

/** Named refusals the readback seam can end with (GOAL 160). */
export type NonAnswerReason = "non-answer-region";

export interface NonAnswerVerdict {
  /** True when the settled text is real answer text. */
  answerShaped: boolean;
  /** Set only when `answerShaped` is false. */
  reason?: NonAnswerReason;
  /** The declared selector that matched — the evidence for the refusal. */
  matchedSelector?: string;
  /** The refused text, kept for the refusal message so a reader can see WHAT
   *  was wrong. It is never returned as the answer. */
  refusedText?: string;
}

/**
 * Decide whether settled readback text is answer text.
 *
 * `readNonAnswerMatches` is the evidence the caller collected in-page: for each
 * declared non-answer selector, the text of the elements it matched. When the
 * settled text IS one of those (exactly, or as the leading text of a region the
 * non-answer element fully contains) the read landed on a non-answer region.
 */
export function judgeAnswerShape(
  settledText: string,
  readNonAnswerMatches: Array<{ selector: string; texts: string[] }>
): NonAnswerVerdict {
  const t = settledText.trim();
  if (!t) return { answerShaped: true };
  for (const m of readNonAnswerMatches) {
    for (const raw of m.texts) {
      const n = (raw ?? "").trim();
      if (!n) continue;
      if (n === t) return { answerShaped: false, reason: "non-answer-region", matchedSelector: m.selector, refusedText: t };
      // The non-answer element's own text sits at the head of a larger region
      // that also contains real answer text — the status line plus the answer
      // in one container. The head match is the signal that the container
      // opened with a non-answer region; only the prefix is judged, so an
      // answer that merely repeats a status word later is not refused.
      if (t.length > n.length && t.startsWith(n)) {
        return { answerShaped: false, reason: "non-answer-region", matchedSelector: m.selector, refusedText: t };
      }
    }
  }
  return { answerShaped: true };
}

export interface AnswerRegionRead {
  /** Longest matching element's trimmed innerText (never used for the verdict —
   *  kept so callers see the region as a browser would). */
  text: string;
  /** Every matching element's trimmed innerText in DOM order (the region set). */
  elementTexts: string[];
  /** GOAL 160: texts of the elements the profile DECLARED as non-answer
   *  (thinking/reasoning/status regions). Collected in the same page read, and
   *  already excluded from `elementTexts` — they are evidence, not candidates. */
  nonAnswerMatches?: Array<{ selector: string; texts: string[] }>;
}

export interface AnswerBaseline {
  elementTexts: string[];
  maxText: string;
}

export type AnswerDoneReason = "stable" | "timeout" | "empty" | "stale" | "non-answer";

// GOAL 160: `"non-answer"` means the readback settled on a region the profile
// DECLARED non-answer (a status/thinking element) and no answer-shaped text
// ever appeared. It is a distinct member rather than `"empty"` because the
// caller needs to act differently: "the page rendered something and it was the
// wrong thing" is a selector/profile defect to re-tune, while "empty" is the
// page not answering at all.

export interface AnswerPollState {
  last: string;
  lastChange: number;
  maxFresh: string;
  chunkCount: number;
  madeProgress: boolean;
  doneReason: AnswerDoneReason;
  /** GOAL 160: the freshest text seen in a DECLARED non-answer region, and the
   *  selector that produced it — the evidence for a "non-answer" verdict. */
  nonAnswerFresh: string;
  nonAnswerSelector: string;
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
): { fresh: string; changed: boolean; nonAnswer: { text: string; selector: string } | null } {
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
  // GOAL 160: the longest NEW text in a declared non-answer region. Judged
  // against the baseline the same way, so a status line that was already on the
  // page before the ask is not evidence.
  let nonAnswer: { text: string; selector: string } | null = null;
  for (const m of region.nonAnswerMatches ?? []) {
    for (const raw of m.texts) {
      const t = (raw ?? "").trim();
      if (!t) continue;
      if (baseline.elementTexts.includes(t) || baseline.maxText === t) continue;
      if (!nonAnswer || t.length > nonAnswer.text.length) nonAnswer = { text: t, selector: m.selector };
    }
  }
  return { fresh: fresh.trim(), changed, nonAnswer };
}

export function initAnswerPollState(nowMs: number): AnswerPollState {
  return { last: "", lastChange: nowMs, maxFresh: "", chunkCount: 0, madeProgress: false, doneReason: "timeout", nonAnswerFresh: "", nonAnswerSelector: "" };
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
  const { fresh, changed, nonAnswer } = freshRegion(region, baseline);
  const next: AnswerPollState = {
    ...state,
    chunkCount: state.chunkCount + 1,
  };
  if (nonAnswer && nonAnswer.text.length > state.nonAnswerFresh.length) {
    next.nonAnswerFresh = nonAnswer.text;
    next.nonAnswerSelector = nonAnswer.selector;
  }
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
 * GOAL 156 - "BOUND THE READ, NOT THE LOOP".
 *
 * Bounding only the `while` clock does NOT bound the ask: the awaited `read()`
 * is `readAnswerRegionFromPage(p, selector)` -> `page.evaluate(...)`, an RPC to
 * the browser's CDP endpoint, and nothing in src/ sets a Playwright default
 * timeout (`setDefaultTimeout` has zero hits). One read that never returns
 * therefore parked the loop forever; `driver.ask()` never settled, so
 * `pool.release()` was never reached (the release-on-THROW paths are fine - a
 * hang cannot throw) and the pool slot was lost PERMANENTLY (measured live:
 * busyMs 282s -> 333s -> 1569s, pool 4 -> 2). `UI2API_REQUEST_TIMEOUT_MS` is
 * only a `Promise.race` on the HTTP response, so it turned a visible hang into
 * silent permanent slot loss.
 *
 * So every read is raced against the REMAINING budget. A read that does not
 * come back inside it ends the ask with the last text we actually READ (never
 * text we did not read - a fabricated answer is forbidden) and the existing
 * honest "timeout" verdict, whose documented meaning already covers this
 * exactly: "grew but never settled". The return contract
 * `{ text, chunkCount, doneReason }` and the `AnswerDoneReason` union are
 * UNCHANGED on purpose - the type can express "we ran out of budget before the
 * fresh text settled", so no new member is invented (and no `doneReason`
 * consumer in src/ or test/ has to change). Note for a follow-up: under this
 * union the caller cannot tell an unresponsive CDP from a merely slow stream;
 * widening the union is a deliberate, consumer-routed change, not a local one.
 *
 * GOAL 160 did that widening deliberately, to the consumer: `AnswerDoneReason`
 * gained `"non-answer"`, because the caller genuinely must distinguish "the page
 * rendered a status region and we read it" from "the page rendered nothing at
 * all". Only the driver (`src/prompt/driver.ts`) and its readback tests consume
 * this union, so the widening is contained. The returned object also gained an
 * OPTIONAL `nonAnswer` evidence field, present only when a declared non-answer
 * region was actually seen.
 *
 * HAZARD REASONING - an abandoned read resolving late:
 *   A timed-out read is settled ONCE. The `settled` latch drops the late
 *   `.then` callback's value on the floor: it is never fed to `stepAnswerPoll`,
 *   so it can never mutate `state`, `state.maxFresh`, or the returned `text` of
 *   this ask. And `base` is snapshotted exactly once, at entry, from a value
 *   this call awaited BEFORE the loop started - so no late read can write into
 *   a SUBSEQUENT ask's freshness baseline either, because the next ask builds
 *   its own `base` from its own first read; nothing is shared between calls
 *   (no module-level mutable state on this path). The only residue is the
 *   browser-side `page.evaluate` still running; the loop stops issuing further
 *   reads the moment one times out (it breaks, it does not re-poll), so at most
 *   ONE read per ask is ever abandoned.
 */
export async function awaitAnswerFromReads(
  read: () => Promise<AnswerRegionRead>,
  opts: { timeoutMs?: number; stableMs?: number; pollMs?: number } = {},
  baseline?: AnswerRegionRead
): Promise<{
  text: string;
  chunkCount: number;
  doneReason: AnswerDoneReason;
  nonAnswer?: { text: string; selector: string };
}> {
  const { timeoutMs = 30000, stableMs = 1800, pollMs = 400 } = opts;
  const t0 = Date.now();

  // One bounded read. `null` means "did not come back inside the remaining
  // budget". A REJECTION is not swallowed - it propagates exactly as before,
  // so an honest page/target error is never laundered into a "timeout".
  const readBounded = (): Promise<AnswerRegionRead | null> => {
    const remaining = timeoutMs - (Date.now() - t0);
    if (remaining <= 0) return Promise.resolve(null);
    return new Promise<AnswerRegionRead | null>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, remaining);
      read().then(
        (r) => {
          if (settled) return; // late arrival after our deadline - dropped
          settled = true;
          clearTimeout(timer);
          resolve(r);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  };

  // The freshness baseline is the stale-echo guard. If it cannot be read there
  // is no honest verdict available: an EMPTY baseline would make the previous
  // answer's elements count as "fresh" and get served as this prompt's answer -
  // the exact fabrication class this guard exists to prevent. Refuse loudly.
  const baseRegion = baseline ?? (await readBounded());
  if (!baseRegion) {
    throw new Error(
      `answer-read-timeout: could not read the pre-ask answer region within ${timeoutMs}ms - ` +
        `no freshness baseline, so the previous answer could not be told apart from this one. ` +
        `(the page read never returned; the browser/CDP endpoint is unresponsive)`
    );
  }
  const base = snapshotBaseline(baseRegion);

  let state = initAnswerPollState(t0);
  let stable = false;
  while (!stable && Date.now() - t0 < timeoutMs) {
    const region = await readBounded();
    // The read itself timed out -> end the ask NOW with the last text we really
    // read. Do not keep polling: every further read is unbounded work against a
    // page that has already stopped answering.
    if (!region) break;
    state = stepAnswerPoll(state, region, base, Date.now(), stableMs);
    stable = state.doneReason === "stable";
    if (!stable) await new Promise((r) => setTimeout(r, pollMs));
  }
  const text = state.maxFresh.trim();
  let doneReason = state.doneReason;
  // GOAL 160: the answer-shape gate. When the read settled on a region the
  // profile declared NON-answer and no answer-shaped text ever grew, the
  // settled text is not the answer and must not be served as one. The declared
  // text is returned as EVIDENCE, never as the answer.
  if (doneReason !== "stable" && !text && state.nonAnswerFresh) {
    doneReason = "non-answer";
  }
  if (doneReason === "timeout" && !text) {
    // Nothing fresh ever appeared: "stale" means pre-existing content (the old
    // answer) was present the whole time and the read never changed - the true
    // stale-echo signal, reported honestly instead of echoing that content;
    // a baseline that is already empty is a plain "empty" (no answer at all).
    doneReason = state.madeProgress ? "empty" : base.maxText ? "stale" : "empty";
  }
  return {
    text,
    chunkCount: state.chunkCount,
    doneReason,
    ...(state.nonAnswerFresh
      ? { nonAnswer: { text: state.nonAnswerFresh, selector: state.nonAnswerSelector } }
      : {}),
  };
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
    async readAnswerRegion(selector, nonAnswerSelector) {
      const p = await pageFn();
      return readAnswerRegionFromPage(p, selector, nonAnswerSelector);
    },
    async awaitAnswer(selector, opts = {}, baseline) {
      const p = await pageFn();
      const read = (): Promise<AnswerRegionRead> =>
        readAnswerRegionFromPage(p, selector, opts.nonAnswerSelector);
      // Per-ask FRESHNESS BASELINE (GOAL 46): when the caller (ChatDriver)
      // captured the pre-ask region before composing, require growth from a NEW
      // element; without one, snapshot at entry — either way the pre-existing
      // answer can never be judged "stable" or echoed. Poll from the Node side:
      // each read is a tiny anonymous leaf evaluation (no named functions —
      // esbuild's __name helper is invalid inside a page).
      const res = await awaitAnswerFromReads(read, opts, baseline);
      // Same unbound-read hazard as the poll reads (GOAL 156): this trailing
      // `p.evaluate` is another unbounded CDP RPC, and it runs AFTER the loop
      // has already produced its answer — a hang here would lose the pool slot
      // for an answer we already hold. It is pure metadata, so it is bounded
      // and degrades to empty strings rather than taking the whole ask down.
      const metaCapMs = Math.max(500, Math.min(opts.timeoutMs ?? 30000, 5000));
      const meta = (await Promise.race([
        p.evaluate(() => ({ url: location.href, title: document.title })),
        new Promise<{ url: string; title: string }>((r) =>
          setTimeout(() => r({ url: "", title: "" }), metaCapMs)
        ),
      ])) as { url: string; title: string };
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
 *  (anonymous leaf function — no named helpers inside the page).
 *
 *  GOAL 160: `nonAnswerSelector` is the profile's DECLARED set of elements that
 *  are not the answer (thinking/reasoning/status regions). Matching elements are
 *  removed from the candidate set — so a status region can never win the
 *  longest-element read in the first place — and their text is returned
 *  separately as the evidence a `"non-answer"` refusal names. Excluding them
 *  (rather than filtering the text afterwards) is the selector-precision fix:
 *  the answer selector can no longer be widened back onto a status node without
 *  the profile having declared that node non-answer. */
async function readAnswerRegionFromPage(
  p: any,
  selector: string,
  nonAnswerSelector?: string
): Promise<AnswerRegionRead> {
  return (await p.evaluate(
    ({ sel, nonSel }: { sel: string; nonSel?: string }) => {
      const excluded = new Set<Element>();
      const nonAnswerMatches: Array<{ selector: string; texts: string[] }> = [];
      if (nonSel) {
        for (const part of nonSel.split(",").map((s) => s.trim()).filter(Boolean)) {
          const texts: string[] = [];
          for (const el of document.querySelectorAll(part)) {
            excluded.add(el);
            const t = ((el as HTMLElement).innerText ?? "").trim();
            if (t) texts.push(t);
          }
          if (texts.length) nonAnswerMatches.push({ selector: part, texts });
        }
      }
      const els = document.querySelectorAll(sel);
      const list: string[] = [];
      let best = "";
      for (const el of els) {
        if (excluded.has(el)) continue;
        const t = ((el as HTMLElement).innerText ?? "").trim();
        list.push(t);
        if (t.length > best.length) best = t;
      }
      return { text: best, elementTexts: list, nonAnswerMatches };
    },
    { sel: selector, nonSel: nonAnswerSelector }
  )) as AnswerRegionRead;
}