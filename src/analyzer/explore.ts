import { type Browser, type Page } from "playwright";
import { INSTRUMENT_SRC } from "./instrument.js";
import { launchBrowser } from "../runtime/browser.js";
import type { ActionMap, MethodCall, DomInteraction } from "../types.js";
import { buildActionMap } from "../mapper/build.js";

export interface AnalyseOptions {
  root?: string; // explicit window root to wrap, e.g. "App"
  outDir?: string; // where sites/<host>/ is written
  llm?: boolean; // use LLM for action naming when enabled
}

function toSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function parseParams(src: string): string[] {
  const m = src.match(/\(([^)]*)\)/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().split(/[=:/]/)[0].trim())
    .filter(Boolean);
}

function sampleFor(name: string): unknown {
  if (/prompt|message|text|query|input|content/i.test(name)) return "test prompt";
  if (/model/i.test(name)) return "default";
  if (/count|limit|max|page|offset|index|id/i.test(name)) return 1;
  if (/enabled|active|flag|debug|verbose/i.test(name)) return true;
  return "test";
}

function inferType(v: unknown): "string" | "number" | "boolean" | "object" {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (v && typeof v === "object") return "object";
  return "string";
}

async function discoverRoots(page: Page, explicit?: string): Promise<string[]> {
  if (explicit) return [explicit];
  return page.evaluate(() => {
    const black = new Set([
      "window", "self", "globalThis", "top", "parent", "frames",
      "localStorage", "sessionStorage", "document", "history", "location",
      "navigator", "screen", "console", "Math", "Date", "JSON", "Object",
      "Array", "Promise", "fetch", "__ui2api",
    ]);
    const found: string[] = [];
    for (const k of Object.getOwnPropertyNames(window as any)) {
      if (black.has(k)) continue;
      try {
        const v = (window as any)[k];
        if (v && typeof v === "object") {
          const props = Object.getOwnPropertyNames(v);
          const fns = props.filter((p) => typeof v[p] === "function");
          if (fns.length >= 1 && fns.length >= props.length * 0.5)
            found.push(k);
        }
      } catch (e) {}
    }
    // Prefer UI2API/App marked roots first.
    found.sort((a, b) => {
      const score = (s: string) => (s === "UI2API" ? 0 : s === "App" ? 1 : 2);
      return score(a) - score(b);
    });
    return found;
  });
}

// Heuristic DOM exploration: discovers actions on sites that do NOT expose a
// window.<root> by clicking/submitting interactive controls and recording the
// network calls each interaction triggers (correlated by call id in the page).
async function exploreDom(page: Page, url: string): Promise<DomInteraction[]> {
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

const MAX_ATTEMPTS = 3;

export async function analyse(url: string, opts: AnalyseOptions = {}): Promise<ActionMap> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const browser: Browser = await launchBrowser();
    let crashed = false;
    browser.on("disconnected", () => {
      crashed = true;
    });
    try {
      const page = await browser.newPage();
      await page.addInitScript(INSTRUMENT_SRC);
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(400);

    const roots = await discoverRoots(page, opts.root);
    const methodCalls: MethodCall[] = [];

    for (const rootName of roots) {
      // Capture original method sources BEFORE wrapping (wrapping would hide params).
      const sources: Record<string, string> = await page.evaluate((rn: string) => {
        const obj = (window as any)[rn];
        const out: Record<string, string> = {};
        if (obj && typeof obj === "object") {
          for (const k of Object.getOwnPropertyNames(obj))
            if (typeof obj[k] === "function") out[k] = obj[k].toString();
        }
        return out;
      }, rootName);

      await page.evaluate((rn) => {
        const obj = (window as any)[rn];
        if (obj && typeof obj === "object") (window as any).__ui2api_wrapRoot(obj, rn);
      }, rootName);

      const methods = Object.keys(sources);

      for (const method of methods) {
        const src: string = sources[method];
        const params = parseParams(src);
        const sampleArgs = params.map(sampleFor);
        let jsReturn: any = null;
        let error: string | null = null;
        try {
          jsReturn = await page.evaluate(
            async (a: any) => {
              const root = (window as any)[a[0]];
              return await root[a[1]](...(a[2] as unknown[]));
            },
            [rootName, method, sampleArgs]
          );
        } catch (e: any) {
          error = String(e);
        }
        const captures: any[] = await page.evaluate(() =>
          (window as any).__ui2api.captures.slice()
        );
        // Latest js-function capture for this method.
        const jf = [...captures]
          .reverse()
          .find((c) => c.kind === "js-function" && c.function === `${rootName}.${method}`);
        const callId = jf ? jf.callId : null;
        const net = captures.find(
          (c) => c.kind === "network" && c.callId === callId && !c.error
        );
        methodCalls.push({
          target: `${rootName}.${method}`,
          method,
          params,
          sampleArgs,
          jsFunctionCapture: jf,
          jsReturnCapture: { returnPreview: jsReturn, error },
          networkCapture: net || null,
        });
      }
    }

    const host = new URL(url).host;
    const authRequired = await page.evaluate(() => {
      const pwd = document.querySelector("input[type=password]");
      return !!pwd;
    });

    const domActions = await exploreDom(page, url);
    const map = await buildActionMap(host, url, methodCalls, domActions, authRequired, opts.llm);
    if (crashed) throw new Error("browser crashed during analysis");
    return map;
  } catch (e) {
    lastErr = e;
    if (attempt < MAX_ATTEMPTS) {
      console.error(
        `[ui2api] analyze attempt ${attempt} failed (${e instanceof Error ? e.message : e}); retrying...`
      );
      continue;
    }
    throw e;
  } finally {
    if (!crashed) await browser.close().catch(() => {});
  }
  }
  throw lastErr instanceof Error ? lastErr : new Error("analyze failed");
}
