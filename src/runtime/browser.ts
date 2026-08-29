import { chromium, type Browser } from "playwright";
import { resolve, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

// Hardened launch args that keep headless Chromium stable across environments
// (containers/CI especially), where the default launch can crash intermittently.
export const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-software-rasterizer",
];

// Launch Chromium, retrying if the process dies before it is usable. This hides
// the intermittent "Target page, context or browser has been closed" crashes
// that otherwise make analyze/serve flaky.
export async function launchBrowser(retries = 3): Promise<Browser> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const browser = await chromium.launch({ args: LAUNCH_ARGS });
      let usable = true;
      const lost = new Promise<never>((_, reject) => {
        browser.on("disconnected", () => {
          usable = false;
          reject(new Error("browser disconnected during launch"));
        });
      });
      await Promise.race([browser.newPage().then((p) => p.close()), lost]);
      if (usable) return browser;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("failed to launch browser");
}

// --- M7: cookie session capture for cookie-gated sites ---

// Resolve the path where a site's session cookies are stored
// (sites/<host>/.session/cookies.json). `outDir` is the sites root.
export function sessionPath(outDir: string, host: string): string {
  return resolve(outDir, host, ".session", "cookies.json");
}

// Persist cookies (array of Playwright cookie objects) to disk. Creates the
// .session directory as needed. Cookies are gitignored by convention.
export function saveCookies(path: string, cookies: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cookies, null, 2));
}

// Load previously saved cookies, or [] if none exist / unreadable. Never throws.
export function loadCookies(path: string): any[] {
  try {
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [];
  }
}
