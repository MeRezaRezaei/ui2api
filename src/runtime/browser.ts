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

// Build the Playwright launch options. By default this uses the bundled
// Chromium. Opt-in env vars let a user reuse their REAL installed Chrome and
// logged-in profile (for analyzing sites they're authenticated to):
//   UI2API_CHROME=1          -> use the system Chrome (channel: "chrome")
//   UI2API_CHROME_PATH=...   -> explicit Chrome/Chromium executable path
//   UI2API_USER_DATA_DIR=... -> reuse an existing Chrome user-data dir (cookies/session)
// Overrides (passed programmatically) take precedence over env.
export function buildLaunchOptions(overrides: LaunchOpts = {}): Record<string, unknown> {
  const opts: Record<string, unknown> = { args: LAUNCH_ARGS };
  if (overrides.channel ?? (process.env.UI2API_CHROME && process.env.UI2API_CHROME !== "0")) opts.channel = "chrome";
  if (overrides.executablePath ?? process.env.UI2API_CHROME_PATH) opts.executablePath = overrides.executablePath ?? process.env.UI2API_CHROME_PATH;
  if (overrides.userDataDir ?? process.env.UI2API_USER_DATA_DIR) opts.userDataDir = overrides.userDataDir ?? process.env.UI2API_USER_DATA_DIR;
  if (overrides.headless !== undefined) opts.headless = overrides.headless;
  return opts;
}

export interface LaunchOpts {
  channel?: string;
  executablePath?: string;
  userDataDir?: string;
  headless?: boolean;
}

// Launch Chromium, retrying if the process dies before it is usable. This hides
// the intermittent "Target page, context or browser has been closed" crashes
// that otherwise make analyze/serve flaky.
export async function launchBrowser(retries = 3, overrides: LaunchOpts = {}): Promise<Browser> {
  const launchOpts = buildLaunchOptions(overrides);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const browser = await chromium.launch(launchOpts as any);
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

// A host taken from an untrusted action-map must never be able to escape the
// sites directory via path separators or "..". Allow only hostname-safe chars.
export function sanitizeHost(host: string): string {
  const cleaned = String(host || "").replace(/[^a-zA-Z0-9._:\-[\]]/g, "");
  return cleaned || "unknown";
}

// Default sites root (where analyzed maps + sessions live).
export function defaultSitesDir(): string {
  return resolve(process.cwd(), "sites");
}

// Resolve the path where a site's session cookies are stored
// (sites/<host>/.session/cookies.json). `outDir` is the sites root.
export function sessionPath(outDir: string, host: string): string {
  return resolve(outDir, sanitizeHost(host), ".session", "cookies.json");
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
