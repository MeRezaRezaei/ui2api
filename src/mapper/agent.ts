import type { Page } from "playwright";
import type { DomInteraction } from "../types.js";
import { llmEnabled, llmProposeTasks } from "./llm.js";

export interface AgentOptions {
  llm?: boolean;
  maxTasks?: number;
}

// Heuristic DOM exploration: discovers actions on sites that do NOT expose a
// window.<root> by clicking/submitting interactive controls and recording the
// network calls each interaction triggers (correlated by call id in the page).
// This is the same logic that previously lived in exploreDom(). It is kept
// intact so the offline behavior (and the `search` fixture button) is unchanged.
async function heuristicExplore(page: any, url: string): Promise<DomInteraction[]> {
  const els = await page.evaluate(() => {
    const out: { selector: string; label: string; domKind: string; fields: string[] }[] = [];
    const nodes = document.querySelectorAll(
      'button:not([type="submit"]), [role="button"], input[type="button"], form'
    );
    for (const el of Array.from(nodes)) {
      const selector = ((node: any): string => {
        if (!node || !node.tagName) return "";
        const parts: string[] = [];
        let e = node;
        for (let i = 0; i < 5 && e && e.nodeType === 1; i++) {
          let s = e.tagName.toLowerCase();
          if (e.id) s += "#" + e.id;
          else if (e.className && typeof e.className === "string" && e.className.trim())
            s += "." + e.className.trim().split(/\s+/)[0];
          parts.unshift(s);
          e = e.parentElement;
        }
        return parts.join(">");
      })(el);
      const label = (
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        (el.textContent || "").trim() ||
        (el as any).id ||
        ""
      ).slice(0, 80);
      const fields: string[] = [];
      if ((el as any).tagName === "FORM") {
        for (const n of Array.from((el as any).querySelectorAll("input[name],select[name],textarea[name]"))) {
          const nm = (n as any).name;
          if (nm) fields.push(nm);
        }
      }
      out.push({ selector, label, domKind: (el as any).tagName === "FORM" ? "submit" : "click", fields });
    }
    return out;
  });

  const interactions: DomInteraction[] = [];
  for (const el of els) {
    if (!el.selector) continue;
    try {
      if (el.domKind === "submit") {
        await page.evaluate((s: string) => {
          const form = document.querySelector(s) as any;
          if (!form) return;
          for (const inp of Array.from(form.querySelectorAll("input,textarea,select")) as any[]) {
            if (inp.type === "submit" || inp.type === "button") continue;
            if (inp.name || inp.id) {
              const nm = inp.name || inp.id;
              inp.value = /q|query|search|prompt|text|input|message/i.test(nm) ? "test query" : "1";
            }
          }
          if (form.requestSubmit) form.requestSubmit();
          else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        }, el.selector);
      } else {
        await page.click(el.selector);
      }
    } catch (e) {
      continue;
    }
    await page.waitForTimeout(250);
    const caps: any[] = await page.evaluate(() => (window as any).__ui2api.captures.slice());
    const domEvt = [...caps].reverse().find((c) => c.kind === "dom-event" && c.selector === el.selector);
    if (!domEvt) continue;
    const net = caps.find((c) => c.kind === "network" && c.callId === domEvt.callId && !c.error);
    interactions.push({
      selector: el.selector,
      label: el.label,
      domKind: el.domKind as "click" | "submit",
      fields: el.fields,
      network: net ? { method: net.method || "GET", url: net.url, requestBody: net.requestBody } : null,
      verified: !!net,
    });
    // If a click navigated away, return to the analyzed URL so later interactions run.
    if (el.domKind !== "submit" && page.url() !== url) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      } catch (e) {}
    }
  }
  return interactions;
}

// Match a natural-language task to one of the discovered controls by keyword
// overlap. Returns the matching control, or null if nothing plausible matches.
function matchControl(task: string, controls: DomInteraction[]): DomInteraction | null {
  const t = task.toLowerCase();
  let best: DomInteraction | null = null;
  let bestScore = 0;
  for (const c of controls) {
    const hay = `${c.label} ${c.selector} ${c.fields.join(" ")}`.toLowerCase();
    const tokens = t.split(/[^a-z0-9]+/).filter((x) => x.length > 2);
    let score = 0;
    for (const tok of tokens) if (hay.includes(tok)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore > 0 ? best : null;
}

// Execute one proposed task against its matched control and record the captures.
// Any failure is swallowed — the LLM branch must never affect heuristic results.
async function runTask(
  page: any,
  url: string,
  task: string,
  control: DomInteraction,
  out: DomInteraction[]
): Promise<void> {
  const seen = new Set(out.map((i) => i.selector + "|" + i.domKind));
  if (seen.has(control.selector + "|" + control.domKind)) return;
  try {
    if (control.domKind === "submit") {
      await page.evaluate((s: string) => {
        const form = document.querySelector(s) as any;
        if (!form) return;
        for (const inp of Array.from(form.querySelectorAll("input,textarea,select")) as any[]) {
          if (inp.type === "submit" || inp.type === "button") continue;
          if (inp.name || inp.id) {
            const nm = inp.name || inp.id;
            inp.value = /q|query|search|prompt|text|input|message/i.test(nm) ? "test query" : "1";
          }
        }
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      }, control.selector);
    } else {
      await page.click(control.selector);
    }
    await page.waitForTimeout(250);
    const caps: any[] = await page.evaluate(() => (window as any).__ui2api.captures.slice());
    const domEvt = [...caps].reverse().find((c) => c.kind === "dom-event" && c.selector === control.selector);
    if (!domEvt) return;
    const net = caps.find((c) => c.kind === "network" && c.callId === domEvt.callId && !c.error);
    out.push({
      selector: control.selector,
      label: control.label,
      domKind: control.domKind,
      fields: control.fields,
      network: net ? { method: net.method || "GET", url: net.url, requestBody: net.requestBody } : null,
      verified: !!net,
    });
    if (control.domKind !== "submit" && page.url() !== url) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      } catch (e) {}
    }
  } catch (e) {
    // Swallow: LLM task failures must never break analysis.
  }
}

// Drives the page to discover actions. With llm disabled, performs heuristic
// exploration (click buttons / submit forms) — equivalent to current exploreDom.
// With llm enabled, also asks the LLM to propose natural-language tasks and
// executes the ones it can map to page controls, recording captures.
// The LLM branch is fully additive and never changes heuristic results.
export async function runMapperAgent(
  page: any,
  url: string,
  opts: AgentOptions = {}
): Promise<DomInteraction[]> {
  const interactions = await heuristicExplore(page, url);

  if (opts.llm && llmEnabled()) {
    try {
      const controls = interactions.map((i) => `${i.label} (${i.selector})`);
      const tasks = await llmProposeTasks(controls, url);
      const max = opts.maxTasks ?? 3;
      for (const task of tasks.slice(0, max)) {
        const control = matchControl(String(task), interactions);
        if (control) await runTask(page, url, String(task), control, interactions);
      }
    } catch (e) {
      // Never break analysis if the LLM branch misbehaves.
    }
  }

  return interactions;
}
