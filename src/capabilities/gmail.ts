// Gmail capability runner — exposes mail.google.com's buttons and abilities
// as typed callable capabilities over the SAME browser + session machinery as
// every other ui2api site (and ChatDriver).
//
// GOAL 19 — the user's flagship adoption pitch ("as working with gmail agent
// without paying for google ai plan", .brain/verbatim.md:313). NOT an AI chat
// site: there is no composer→answer chat surface here — the surface is the
// user's own inbox driven through gmail's own UI (read / list / open / search /
// send).
//
// HONESTY CONTRACT (GOAL 19, measured 2026-09-23):
//   mail.google.com is 100% behind the Google auth wall. Static wire analysis
//   (no browser, no login probe) measured that EVERY path 301/302s to
//   accounts.google.com/ServiceLogin with content-length:0 — no SPA shell, no
//   JS bundles, no selectors are statically observable. So:
//     - every selector below is a KNOWN-STABLE Gmail surface name, explicitly
//       DOM-UNVERIFIED (re-tuned against a real session on first capture);
//     - every call first checks what the session ACTUALLY rendered: if the
//       page redirected to accounts.google.com (or shows a sign-in wall), the
//       runner returns HONEST ok:false with the measured auth-wall reason + the
//       two-step unblock — NEVER a fabricated inbox, NEVER a fabricated read;
//     - gmail_send (a real mutation) is login-gated by design and can only
//       fire when the site's own logged-in composer is measurably on screen.
//
// Google auth cookies are browser/app-bound (the same class as youtube posting
// / gemini account surfaces): portable snapshot replay into ephemeral contexts
// may still render anonymous — the runner's wall-check catches that too. The
// reliable seam is the user's OWN real Chrome attached with mail.google.com
// signed in (UI2API_ATTACH_PORT=9222).
import { resolvedHeadless, launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { sameOrigin } from "../runtime/ssrf.js";
import {
  injectSnapshot,
  listAccounts,
  loadAccountSnapshot,
  loadSnapshot,
  snapshotPath,
} from "../runtime/session-store.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface GmailCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
  /** External browser pool handle — reserved for daemon integration. */
  pool?: Browser;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
}

export interface GmailCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  /** Honesty marker: every selector is an unverified known-stable Gmail surface candidate. */
  domUnverified?: string;
  /** Honest login-gated short-circuit marker (send / missing session). */
  loginGated?: boolean;
  /** Human note about the mechanism / posture. */
  note?: string;
}

const DOM_UNVERIFIED_NOTE =
  "dom-unverified: mail.google.com is 100% auth-walled statically (GOAL 19 wire measurement 2026-09-23: " +
  "every path 302s to accounts.google.com/ServiceLogin) — selectors are KNOWN-STABLE Gmail surface names, " +
  "re-tune against a real session on first capture";

const AUTH_WALL_NOTE =
  "auth-walled: this session did not render a logged-in mail.google.com inbox (the site itself redirected to " +
  "accounts.google.com). Google cookies are app-bound, so portable replay can render anonymous. Unblock: (1) sign " +
  "into mail.google.com in your real Chrome, (2) attach it (google-chrome --remote-debugging-port=9222, then " +
  "UI2API_ATTACH_PORT=9222) or run `ui2api profile add-all --known` / `profile capture https://mail.google.com " +
  "--login` and re-drive the capability. NEVER fabricated.";

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return resolvedHeadless();
}

/**
 * GOAL 101: the sent-state read-back used to be
 *   /sent|message sent/i.test(body) || !/Send\b/.test(body)
 * which is a TAUTOLOGY over real Gmail DOM — Gmail's own nav carries a "Sent"
 * label, and "the word Send is absent" is satisfied by a blank page, a re-render
 * and a FAILED send alike. It returned true for every input measured, so
 * gmail_send could report an irreversible send it never proved.
 *
 * An honest predicate must require POSITIVE evidence of a real confirmation and
 * must never treat absence as success. There is no live-verified Gmail
 * confirmation selector in this project (Google ships app-bound cookies), so the
 * only truthful state is a refusal until one is observed — which is exactly what
 * capabilities/gmail/manifest.json already promises.
 */
export function gmailSendConfirmed(opts: {
  /** Real confirmation text, e.g. a scoped toast/row — NOT the whole page body. */
  confirmationText?: string;
  /** True when the compose window is gone AND a send error is visible. */
  sendFailed?: boolean;
  /** True when Gmail is not signed in / the page is an error page. */
  loggedOut?: boolean;
}): boolean {
  if (opts.loggedOut) return false;
  if (opts.sendFailed) return false;
  const text = (opts.confirmationText ?? "").trim();
  if (!text) return false;
  // A real, specific confirmation phrase — never a body-wide /sent/i, which the
  // nav label alone satisfies.
  return /^(message sent|sent message|your message was sent)\b/i.test(text);
}

/** The honest, named refusal used until a live round-trip proves a real send. */
export const GMAIL_SEND_UNVERIFIED =
  "gmail_send is login-gated: no live round-trip has ever read a real sent-confirmation off the page " +
  "(Google app-bound cookies), so a send is NEVER reported as done. Re-verify with a signed-in session before trusting it.";

export class GmailCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;
  private readonly account?: string;

  constructor(private readonly profile: ChatSiteProfile, opts: GmailCapabilityOptions = {}) {
    this.browser = opts.browser;
    this.ownsBrowser = !opts.browser;
    this.dataDir = opts.dataDir ?? resolveDataDir();
    this.headless = opts.headless ?? headlessDefault();
    this.account = opts.account;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.browser = await launchBrowser(3, { headless: this.headless });
    this.ownsBrowser = true;
    return this.browser;
  }

  // Open a fresh context with the OPTIONAL captured session injected. The SAME
  // session-resolution ladder as every other runner (vault account → legacy
  // flat snapshot → legacy cookie file). Gmail REQUIRES a session that
  // measurably replays as logged-in — the auth-wall check on every capability
  // is the honest referee.
  private async openPage(url: string): Promise<Page> {
    if (!sameOrigin(url, this.profile.url)) {
      throw new Error(
        `SSRF guard: refusing to navigate ${url} — origin pinning serves only ${new URL(this.profile.url).host}, never arbitrary URLs`
      );
    }
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: usingUserChrome() || !this.headless ? null : { width: 1280, height: 900 },
    });
    if (!usingUserChrome() && this.headless) {
      await context.route("**/*", (route) => {
        const t = route.request().resourceType();
        if (t === "image" || t === "font" || t === "media") return route.abort();
        return route.continue();
      });
    }
    const host = new URL(this.profile.url).host;
    if (!usingUserChrome()) {
      const hosts = [host, host.replace(/^www\./, "")];
      let snap: ReturnType<typeof loadSnapshot> | null = null;
      if (this.account && this.account !== "default") {
        // A specific identity was asked for: load THAT snapshot or fail loudly —
        // never a silent fallback to a different stored account.
        for (const h of hosts) {
          snap = loadAccountSnapshot(this.dataDir, h, this.account);
          if (snap) break;
        }
        if (!snap) {
          throw new Error(
            `no stored session for ${this.profile.id} account "${this.account}" on ${host} — capture it ` +
              `first (ui2api profile capture <url> --login) or omit account for the legacy default snapshot`
          );
        }
      } else {
        for (const h of hosts) {
          // GOAL 124: skip rows the GOAL 89 reconciliation marked unusable —
          // an anonymous / corrupt / missing first row must not drive the
          // request (cross-account bleed). No usable row at all still means the
          // honest anonymous path below, not an error.
          const accounts = listAccounts(this.dataDir, h).filter((a) => a.usable !== false);
          if (accounts.length > 0) {
            snap = loadAccountSnapshot(this.dataDir, h, accounts[0].identity ?? accounts[0].slug);
            if (snap) break;
          }
        }
        snap ??= loadSnapshot(snapshotPath(this.dataDir, host));
      }
      if (snap) {
        await injectSnapshot(context, snap);
      } else {
        const cookies = loadCookies(sessionPath(this.dataDir, host));
        if (cookies.length > 0) await context.addCookies(cookies as never[]);
      }
    }
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    return page;
  }

  async run(capability: string, args: Record<string, unknown> = {}): Promise<GmailCapabilityResult> {
    switch (capability) {
      case "gmail_read_inbox":
        return this.readInbox(args);
      case "gmail_list_threads":
        return this.listThreads(args);
      case "gmail_open_thread":
        return this.openThread(args);
      case "gmail_search":
        return this.search(args);
      case "gmail_send":
        return this.send(args);
      default:
        return { capability, ok: false, data: undefined, error: `unknown gmail capability: ${capability}` };
    }
  }

  // Honest auth-wall referee: did the page actually land on a logged-in
  // mail.google.com render, or did the site itself send the session to
  // accounts.google.com? Every Gmail capability runs through this before
  // touching any selectors.
  private async assertLoggedIn(page: Page): Promise<{ ok: true } | { ok: false; reason: string }> {
    const url = page.url();
    if (!/^https:\/\/mail\.google\.com\//.test(url)) {
      return {
        ok: false,
        reason:
          `session rendered at ${url.replace(/\?.*$/, "")} — NOT mail.google.com (the site redirected to the sign-in ` +
          `wall, so this session is NOT a logged-in Gmail session)`,
      };
    }
    const hasApp = await page.evaluate(() => {
      // Any marker that this is Gmail's own app shell, not a wall: the
      // compose affordance or the conversation-list host. DOM-UNVERIFIED —
      // checked live at runtime exactly as a human would see it.
      return Boolean(
        document.querySelector("div[gh='cm'], .T-I.J-J5-Ji.T-I-KE, button, input[aria-label*='mail'], table[role='presentation'], [role='main']")
      );
    });
    if (!hasApp) {
      return { ok: false, reason: "landed on mail.google.com but no app shell rendered (logged-out or degraded)" };
    }
    return { ok: true };
  }

  // Page-side extraction of the conversation-list rows — one evaluate body, no
  // named closures (the swc/esbuild __name crash rule from duckduckgo).
  // Selectors are known-stable Gmail surface names (DOM-UNVERIFIED per GOAL 19);
  // each field is re-read from whatever the live session actually rendered.
  private async extractRows(page: Page, max: number) {
    return page.evaluate((limit: number) => {
      const out: Array<{
        id?: string;
        subject?: string;
        sender?: string;
        snippet?: string;
        dateTag?: string;
        unread?: boolean;
      }> = [];
      const rows = document.querySelectorAll("tr.zA, tr[role='row'], [role='grid'] [role='row']");
      for (const tr of rows) {
        const a = tr.querySelector("a[href*='#'], a[href*='/mail/u/']") as HTMLAnchorElement | null;
        const href = a?.getAttribute("href") ?? "";
        const id = href.split("#").pop() ?? undefined;
        const subj = tr.querySelector(".y6, [class*='subject']") as HTMLElement | null;
        const send = tr.querySelector(".bog, [role='link']") as HTMLElement | null;
        const snip = tr.querySelector(".y2, [class*='snippet']") as HTMLElement | null;
        const dateEl = tr.querySelector("td.xW, .xW, [class*='date']") as HTMLElement | null;
        const dateTag =
          (dateEl?.querySelector("time")?.getAttribute("title") as string | null) ??
          (dateEl?.textContent ?? "").replace(/\s+/g, " ").trim() ??
          undefined;
        const cls = (tr as HTMLElement).className ?? "";
        out.push({
          id: id && id ? id.split("/").pop() : undefined,
          subject: subj?.textContent?.replace(/\s+/g, " ").trim() || undefined,
          sender: send?.textContent?.replace(/\s+/g, " ").trim() || undefined,
          snippet: snip?.textContent?.replace(/\s+/g, " ").trim() || undefined,
          dateTag,
          unread: /\bzE\b/.test(cls),
        });
        if (out.length >= limit) break;
      }
      return out;
    }, max);
  }

  // --- gmail_read_inbox: open the inbox, read the rendered conversation rows.
  private async readInbox(args: Record<string, unknown>): Promise<GmailCapabilityResult> {
    const max = typeof args.max === "number" && args.max > 0 ? Math.min(args.max, 50) : 25;
    const started = Date.now();
    let page: Page | undefined;
    try {
      page = await this.openPage("https://mail.google.com/mail/u/0/");
      const auth = await this.assertLoggedIn(page);
      if (!auth.ok) {
        return this.authWall("gmail_read_inbox", auth.reason, started);
      }
      await page.waitForSelector("tr.zA, [role='grid'] [role='row']", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const rows = await this.extractRows(page, max);
      return {
        capability: "gmail_read_inbox",
        ok: rows.length > 0,
        method: "dom.inbox-rows",
        latencyMs: Date.now() - started,
        data: { view: "inbox", count: rows.length, rows },
        domUnverified: DOM_UNVERIFIED_NOTE,
        error: rows.length === 0 ? "no conversation rows rendered (empty inbox or selector rot — re-tune against the live session)" : undefined,
        note: rows.length > 0 ? "row read straight off gmail's own rendered inbox in the session" : undefined,
      };
    } catch (e) {
      return this.fail("gmail_read_inbox", e, started);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- gmail_list_threads: navigate the site's own hash route, read the rows.
  private async listThreads(args: Record<string, unknown>): Promise<GmailCapabilityResult> {
    const rawView = String(args.view ?? args.label ?? "").trim();
    const view = rawView ? rawView.replace(/^#/, "") : "inbox";
    const max = typeof args.max === "number" && args.max > 0 ? Math.min(args.max, 50) : 25;
    const started = Date.now();
    let page: Page | undefined;
    try {
      const fragment = view.startsWith("label/") || view.startsWith("search/") ? view : `inbox${view !== "inbox" ? "/" + encodeURIComponent(view) : ""}`;
      page = await this.openPage(`https://mail.google.com/mail/u/0/#${fragment}`);
      const auth = await this.assertLoggedIn(page);
      if (!auth.ok) {
        return this.authWall("gmail_list_threads", auth.reason, started);
      }
      await page.waitForSelector("tr.zA, [role='grid'] [role='row']", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const rows = await this.extractRows(page, max);
      return {
        capability: "gmail_list_threads",
        ok: rows.length > 0,
        method: "dom.hash-route-rows",
        latencyMs: Date.now() - started,
        data: { view, count: rows.length, rows },
        domUnverified: DOM_UNVERIFIED_NOTE,
        error: undefined,
        note: rows.length > 0 ? `"${view}" rendered ${rows.length} rows off gmail's own UI` : `gmail rendered 0 rows for "${view}" (empty view, or selector rot)`,
      };
    } catch (e) {
      return this.fail("gmail_list_threads", e, started);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- gmail_open_thread: click the site's own row, read the opened thread.
  private async openThread(args: Record<string, unknown>): Promise<GmailCapabilityResult> {
    const started = Date.now();
    let page: Page | undefined;
    try {
      const q = String(args.subject ?? args.query ?? "").trim();
      page = await this.openPage(q ? `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(q)}` : "https://mail.google.com/mail/u/0/");
      const auth = await this.assertLoggedIn(page);
      if (!auth.ok) {
        return this.authWall("gmail_open_thread", auth.reason, started);
      }
      await page.waitForSelector("tr.zA, [role='grid'] [role='row']", { timeout: 20000 }).catch(() => {});
      const clicked = await page.evaluate(() => {
        const row = document.querySelector("tr.zA, [role='grid'] [role='row']") as HTMLElement | null;
        if (!row) return false;
        const link = (row.querySelector("a[href*='#']") as HTMLElement | null) ?? row;
        link.click();
        return true;
      });
      if (!clicked) {
        return {
          capability: "gmail_open_thread",
          ok: false,
          method: "dom.open-row",
          latencyMs: Date.now() - started,
          data: undefined,
          error: "no conversation row to open (empty view or selector rot)",
          domUnverified: DOM_UNVERIFIED_NOTE,
        };
      }
      await page.waitForTimeout(2500);
      const thread = await page.evaluate(() => {
        const subj = document.querySelector("h2.hP, .hP, [class*='subject']") as HTMLElement | null;
        const from = document.querySelector(".gD, [class*='from' i] span, [email]") as HTMLElement | null;
        const date = document.querySelector(".g3, [class*='date']") as HTMLElement | null;
        const body = document.querySelector(".a3s.aXjCH, .a3s, [role='main'] .y2") as HTMLElement | null;
        return {
          subject: subj?.textContent?.replace(/\s+/g, " ").trim() || undefined,
          from: from?.getAttribute("email") || from?.textContent?.replace(/\s+/g, " ").trim() || undefined,
          date: date?.textContent?.replace(/\s+/g, " ").trim() || undefined,
          bodyPreview: (body?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 4000) || undefined,
        };
      });
      return {
        capability: "gmail_open_thread",
        ok: Boolean(thread.subject || thread.bodyPreview),
        method: "dom.open-row + read-pane",
        latencyMs: Date.now() - started,
        data: { ...thread, openedUrl: page.url() },
        domUnverified: DOM_UNVERIFIED_NOTE,
        error: !thread.subject && !thread.bodyPreview ? "row clicked but the message pane rendered no content (login lost or selector rot)" : undefined,
        note: thread.subject ? "opened via a real click on gmail's own row; content read off the rendered pane" : undefined,
      };
    } catch (e) {
      return this.fail("gmail_open_thread", e, started);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- gmail_search: type into the site's own search box, Enter, read results.
  private async search(args: Record<string, unknown>): Promise<GmailCapabilityResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { capability: "gmail_search", ok: false, data: undefined, error: "query is required" };
    }
    const max = typeof args.max === "number" && args.max > 0 ? Math.min(args.max, 50) : 25;
    const started = Date.now();
    let page: Page | undefined;
    try {
      page = await this.openPage("https://mail.google.com/mail/u/0/");
      const auth = await this.assertLoggedIn(page);
      if (!auth.ok) {
        return this.authWall("gmail_search", auth.reason, started);
      }
      const typed = await page.evaluate((q: string) => {
        const box = document.querySelector("input[aria-label='Search mail'], input[name='q']") as HTMLInputElement | null;
        if (!box) return false;
        box.focus();
        return true;
      }, query);
      if (!typed) {
        return {
          capability: "gmail_search",
          ok: false,
          method: "dom.search-box",
          latencyMs: Date.now() - started,
          data: { query },
          error: "search box not found (DOM-UNVERIFIED selector — re-tune against the live session)",
          domUnverified: DOM_UNVERIFIED_NOTE,
        };
      }
      // Real keystrokes + Enter: gmail's own JS runs the search.
      const box = page.locator("input[aria-label='Search mail'], input[name='q']").first();
      await box.pressSequentially(query, { delay: 20 });
      await box.press("Enter");
      await page.waitForTimeout(3000);
      await page.waitForSelector("tr.zA, [role='grid'] [role='row']", { timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const rows = await this.extractRows(page, max);
      return {
        capability: "gmail_search",
        ok: rows.length > 0,
        method: "dom.search-type-enter + rows",
        latencyMs: Date.now() - started,
        data: { query, count: rows.length, rows },
        domUnverified: DOM_UNVERIFIED_NOTE,
        error: undefined,
        note: rows.length > 0 ? `search '${query}' ran through gmail's own box; ${rows.length} rows read` : `gmail rendered 0 results for '${query}' (empty result, or selector rot)`,
      };
    } catch (e) {
      return this.fail("gmail_search", e, started);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- gmail_send: compose through the site's own composer. MUTATION +
  // login-gated by design: only fires when the site's own logged-in composer is
  // measurably on screen; otherwise honest ok:false loginGated:true. NEVER a
  // fabricated send.
  private async send(args: Record<string, unknown>): Promise<GmailCapabilityResult> {
    const to = String(args.to ?? "").trim();
    const subject = String(args.subject ?? "").trim();
    const body = String(args.body ?? "").trim();
    if (!to) return { capability: "gmail_send", ok: false, data: undefined, error: "to (recipient email) is required" };
    const started = Date.now();
    let page: Page | undefined;
    try {
      page = await this.openPage("https://mail.google.com/mail/u/0/");
      const auth = await this.assertLoggedIn(page);
      if (!auth.ok) {
        return this.authWall("gmail_send", auth.reason, started);
      }
      const compose = page.evaluate(() => {
        const btn = document.querySelector("div[gh='cm'], .T-I.J-J5-Ji.T-I-KE, button[aria-label^='Compose']") as HTMLElement | null;
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!(await compose)) {
        return {
          capability: "gmail_send",
          ok: false,
          data: undefined,
          method: "dom.compose",
          latencyMs: Date.now() - started,
          error: "compose affordance not found — the session may be logged out after all (DOM-UNVERIFIED selector)",
          loginGated: true,
          domUnverified: DOM_UNVERIFIED_NOTE,
        };
      }
      await page.waitForTimeout(2500);
      const fields = await page.evaluate(() => {
        const toField = document.querySelector("input[name='to'], input[aria-label='To recipients'], textarea[name='to']") as HTMLElement | null;
        const subjField = document.querySelector("input[name='subjectbox']") as HTMLElement | null;
        const bodyField = document.querySelector("div[aria-label='Message Body'][contenteditable='true'], [role='textbox'] [contenteditable='true']") as HTMLElement | null;
        return Boolean(toField) && Boolean(bodyField);
      });
      if (!fields) {
        return {
          capability: "gmail_send",
          ok: false,
          data: undefined,
          method: "dom.composer-fields",
          latencyMs: Date.now() - started,
          error: "compose window opened but to/body fields not found (DOM-UNVERIFIED selectors — re-tune against the live session)",
          loginGated: true,
          domUnverified: DOM_UNVERIFIED_NOTE,
        };
      }
      await page.locator("input[name='to'], input[aria-label='To recipients'], textarea[name='to']").first().fill(to);
      if (subject) {
        await page.locator("input[name='subjectbox']").first().fill(subject);
      }
      await page.locator("div[aria-label='Message Body'][contenteditable='true'], [role='textbox'] [contenteditable='true']").first().click();
      await page.locator("div[aria-label='Message Body'][contenteditable='true'], [role='textbox'] [contenteditable='true']").first().pressSequentially(body || " ");
      await page.waitForTimeout(800);
      const sendBtn = page.locator("div[role='button'][gh='send'], [gh='send'], button[aria-label^='Send']").first();
      const sendVisible = await sendBtn.isVisible().catch(() => false);
      if (!sendVisible) {
        return {
          capability: "gmail_send",
          ok: false,
          data: undefined,
          method: "dom.send-button",
          latencyMs: Date.now() - started,
          error: "composer filled but the site's own Send button was not in view (DOM-UNVERIFIED selector)",
          loginGated: true,
          domUnverified: DOM_UNVERIFIED_NOTE,
        };
      }
      await sendBtn.click();
      // Read back: does the page show a sent-state (row leaves the composer,
      // a sent confirmation appears)?
      await page.waitForTimeout(3500);
      // GOAL 101: read back from a SCOPED confirmation element, and treat a
      // logged-out page or a visible send error as failure. Absence of the word
      // "Send" is NOT success.
      const readback = await page.evaluate(() => {
        const body = document.body.innerText ?? "";
        const scope: HTMLElement | null =
          document.querySelector('[role="alert"], [role="status"], .vh-notification, [data-toast]') ??
          document.querySelector("main");
        return {
          confirmationText: (scope?.innerText ?? "").trim(),
          sendFailed: /send failed|failed to send|draft not sent|message not sent/i.test(body),
          loggedOut: /sign in|log in|accounts\.google\.com\/ServiceLogin/i.test(body) && !/inbox/i.test(body),
        };
      });
      const sent = gmailSendConfirmed(readback);
      return {
        capability: "gmail_send",
        ok: sent,
        method: "dom.compose-send",
        latencyMs: Date.now() - started,
        data: { to, subject: subject || undefined, sent },
        loginGated: !sent,
        domUnverified: DOM_UNVERIFIED_NOTE,
        error: sent ? undefined : GMAIL_SEND_UNVERIFIED,
        note: sent ? "composed + sent through gmail's own composer; sent-state read back off the page" : undefined,
      };
    } catch (e) {
      return this.fail("gmail_send", e, started);
    } finally {
      await this.teardownPage(page);
    }
  }

  // Honest auth-wall outcome — the measured blocker, never a fabricated read.
  private authWall(capability: string, reason: string, started: number): GmailCapabilityResult {
    return {
      capability,
      ok: false,
      data: undefined,
      method: "auth-wall-detect",
      latencyMs: Date.now() - started,
      error: `${AUTH_WALL_NOTE} ${reason}`,
      loginGated: true,
      domUnverified: DOM_UNVERIFIED_NOTE,
    };
  }

  private fail(capability: string, e: unknown, started: number): GmailCapabilityResult {
    return {
      capability,
      ok: false,
      data: undefined,
      latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
      domUnverified: DOM_UNVERIFIED_NOTE,
    };
  }

  private async teardownPage(page?: Page): Promise<void> {
    try {
      await page?.context()?.close();
    } catch {
      // already gone
    }
    if (this.ownsBrowser) {
      try {
        await this.browser?.close().catch(() => {});
      } catch {
        // gone
      }
      this.browser = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.ownsBrowser) {
      try {
        await this.browser?.close().catch(() => {});
      } catch {
        // gone
      }
    }
    this.browser = undefined;
  }
}