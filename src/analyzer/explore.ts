import { chromium, type Browser, type Page } from "playwright";
import { INSTRUMENT_SRC } from "./instrument.js";
import type { ActionMap, MethodCall } from "../types.js";
import { buildActionMap } from "../mapper/build.js";

export interface AnalyseOptions {
  root?: string; // explicit window root to wrap, e.g. "App"
  outDir?: string; // where sites/<host>/ is written
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

export async function analyse(url: string, opts: AnalyseOptions = {}): Promise<ActionMap> {
  const browser: Browser = await chromium.launch({ args: ["--no-sandbox"] });
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

    const map = await buildActionMap(host, url, methodCalls, authRequired);
    return map;
  } finally {
    await browser.close();
  }
}
