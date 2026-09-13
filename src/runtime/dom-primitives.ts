// Shared DOM primitives behind every ui2api execution context. A single
// implementation backs both createContext (generated servers / hub) and the
// ChatDriver (AI-site prompting), so the send flow behaves identically
// everywhere: paste -> Enter (the SITE's own JS runs) -> awaitAnswer reads the
// streamed response off the page like the event bus it is.

export interface DomPrimitives {
  click(selector: string): Promise<string | void>;
  type(selector: string, text: string): Promise<string | void>;
  waitFor(selector: string, timeoutMs?: number): Promise<string | void>;
  extract(expr: string): Promise<unknown>;
  // JS-level primitives — keyboard/paste events, not mouse simulation.
  paste(selector: string, text: string): Promise<unknown>;
  press(selector: string | null, keys: string[]): Promise<unknown>;
  capture(selector: string, untilMs?: number): Promise<unknown>;
  // Stable-wait read for streamed answers: poll until the text stops growing for
  // `stableMs` (or the budget expires). Returns the longest text seen + why it
  // stopped, so a caller can distinguish "finished streaming" from "timed out".
  awaitAnswer(
    selector: string,
    opts?: { timeoutMs?: number; stableMs?: number; pollMs?: number }
  ): Promise<{
    text: string;
    chunkCount: number;
    url: string;
    title: string;
    doneReason: "stable" | "timeout" | "empty";
  }>;
  status(selector?: string): Promise<unknown>;
}

export function makeDomPrimitives(getPage: () => Promise<any>): DomPrimitives {
  const pageFn = async (): Promise<any> => getPage();

  return {
    async click(sel) {
      await (await pageFn()).locator(sel).first().click({ timeout: 5000 });
    },
    async type(sel, text) {
      await (await pageFn()).locator(sel).first().fill(text);
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
    // Drive the site's own JS by playing the exact keyboard/paste events a real
    // user would send, then read the event-bus chunks the site streams. No mouse.
    async paste(sel, text) {
      const p = await pageFn();
      await p.locator(sel).first().focus();
      await p.keyboard.insertText(String(text));
      await p.evaluate(
        ({ sel, payload }: { sel: string; payload: string }) => {
          const el = document.querySelector(sel);
          if (!(el instanceof HTMLElement)) return false;
          const dt = new DataTransfer();
          dt.setData("text/plain", payload);
          el.dispatchEvent(
            new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })
          );
          return true;
        },
        { sel, payload: String(text) }
      );
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
    async awaitAnswer(selector, opts = {}) {
      const p = await pageFn();
      const { timeoutMs = 30000, stableMs = 1800, pollMs = 400 } = opts;
      const t0 = Date.now();
      let last = "";
      let lastChange = 0;
      let maxText = "";
      let chunkCount = 0;
      let doneReason: "stable" | "timeout" | "empty" = "timeout";
      // Poll from the Node side: each read is a tiny anonymous leaf evaluation
      // (no named functions — esbuild's __name helper is invalid inside a page).
      while (Date.now() - t0 < timeoutMs) {
        const cur = (await p.evaluate((sel: string) => {
          const els = document.querySelectorAll(sel);
          let best = "";
          for (const el of els) {
            const t = (el as HTMLElement).innerText ?? "";
            if (t.length > best.length) best = t;
          }
          return (best || "").trim();
        }, selector)) as string;
        chunkCount++;
        if (cur.length > maxText.length) maxText = cur;
        if (cur !== last) {
          last = cur;
          lastChange = Date.now();
        } else if (cur && Date.now() - lastChange >= stableMs) {
          doneReason = "stable";
          break;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      const text = maxText.trim();
      if (doneReason === "timeout" && !text) doneReason = "empty";
      const meta = (await p.evaluate(() => ({ url: location.href, title: document.title }))) as { url: string; title: string };
      return { text, chunkCount, url: meta.url, title: meta.title, doneReason };
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