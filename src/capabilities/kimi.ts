// Kimi capability runner — exposes Kimi's JS-visible surface as typed callable
// capabilities over the SAME browser + session machinery as ChatDriver.
//
// Capability dispatch:
//   kimi_chat               -> ChatDriver UI path (proven; the site's own JS
//                              drives the ChatService.Chat server-stream)
//   kimi_list_conversations -> sidebar/history DOM on the live page FIRST,
//                              with an honest rpcNote: the true wire API is
//                              ChatService.ListChats over Connect protobuf
//                              (notilo.kimi.com/apiv2 + localStorage
//                              access_token Bearer + x-msh-shield-data blackbox)
//                              and is future work pending a wire capture —
//                              never half-implemented here.
//   kimi_model_list         -> best-effort read of the model picker (DOM),
//                              only when the picker state is straightforward;
//                              otherwise an honest ok:false.
//
// NOT built: kimi_chat_direct (the ChatService.Chat Connect/protobuf stream is
// untested — no live wire capture yet; encoding proto frames without replaying
// the UI's own payloads would be fabrication. When a signed-in session is
// captured and the UI's own ChatRPC payloads are observed, it can be added as
// an in-page fetch mirroring src/capabilities/gemini-rpc.ts).
//
// Auth facts (VERIFIED from bundle token-CrFSxcOs.js, see CAPABILITIES.md):
// localStorage keys access_token / refresh_token / msh_user_id; the token is
// replayed as 'Authorization: Bearer <access_token>' against the Connect host
// https://notilo.kimi.com/apiv2. All in-page work runs in the logged-in page,
// so nothing synthetic ever leaves the browser.
//
// Anti-bot: TrustDecision (同盾) blackbox (x-msh-shield-data) + VolcanoEngine
// analytics ride every RPC — driving the site's own UI (ChatDriver) is the only
// posture that keeps the session alive; the DOM paths below never re-send it.
import { launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { ChatDriver } from "../prompt/driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface KimiCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
}

export interface KimiCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
}

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

export class KimiCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: KimiCapabilityOptions = {}) {
    this.browser = opts.browser;
    this.ownsBrowser = !opts.browser;
    this.dataDir = opts.dataDir ?? resolveDataDir();
    this.headless = opts.headless ?? headlessDefault();
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.browser = await launchBrowser(3, { headless: this.headless });
    this.ownsBrowser = true;
    return this.browser;
  }

  // Open a fresh incognito context with the captured session injected (same as
  // ChatDriver.getPage), pointed at the profile's landing page, and return the
  // page. `usingUserChrome()` users skip injection (their real profile already
  // carries the session).
  private async openPage(): Promise<Page> {
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
      const snap = loadSnapshot(snapshotPath(this.dataDir, host));
      if (snap) {
        await injectSnapshot(context, snap);
      } else {
        const cookies = loadCookies(sessionPath(this.dataDir, host));
        if (cookies.length > 0) await context.addCookies(cookies as never[]);
      }
    }
    const page = await context.newPage();
    await page.goto(this.profile.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    return page;
  }

  async run(capability: string, args: Record<string, unknown> = {}): Promise<KimiCapabilityResult> {
    switch (capability) {
      case "kimi_chat":
        return this.chat(args);
      case "kimi_list_conversations":
        return this.listConversations(args);
      case "kimi_model_list":
        return this.modelList();
      case "kimi_web_search":
        return {
          capability: "kimi_web_search",
          ok: false,
          data: undefined,
          error:
            "kimi_web_search flips the composer web-search switch (state key selectSearch) so the answer is grounded by live search; feeds kimi.chat.v1.Tool{type:TOOL_TYPE_SEARCH=1, search{force}} on ChatService.Chat — but the toggle DOM selectors are UNVERIFIED candidates (inventory proves selectSearch in bundles, no live DOM class); confirm on first live capture",
        };
      case "kimi_file_upload":
        return {
          capability: "kimi_file_upload",
          ok: false,
          data: undefined,
          error:
            "kimi_file_upload is a wire-first REST multipart POST to https://notilo.kimi.com/apiv2-files/file/upload (FileService.Upload, kimi.gateway.file.v1) with parse tracking via GetFileParseProgress + ListChatFiles — but the multipart field name, response envelope, and composer attach UI selector are all UNVERIFIED; endpoint and auth grounded from JS-bundle inventory, confirm on first live capture",
        };
      case "kimi_long_context":
        return {
          capability: "kimi_long_context",
          ok: false,
          data: undefined,
          error:
            "kimi_long_context sets ChatRequestOptions.context_length (kimi.common.v1.ContextLength enum) on the existing ChatService.Chat stream — the composer length picker is driven by state key selectContextLength, but exact ContextLength enum codes and the toggle DOM selector are UNVERIFIED; confirm on first live capture",
        };
      default:
        return { capability, ok: false, data: undefined, error: `unknown kimi capability: ${capability}` };
    }
  }

  // --- kimi_chat: the UI path (proven live), like gemini_chat ---
  private async chat(args: Record<string, unknown>): Promise<KimiCapabilityResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) return this.fail("kimi_chat", "prompt is required");
    const driver = new ChatDriver(this.profile, {
      browser: this.browser,
      dataDir: this.dataDir,
    });
    try {
      const r = await driver.ask(prompt, {
        newChat: Boolean(args.newChat),
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
      });
      return {
        capability: "kimi_chat",
        ok: true,
        data: { answer: r.answer, chunkCount: r.chunkCount, doneReason: r.doneReason, url: r.url, title: r.title },
      };
    } finally {
      // Only tear down what we own; an externally-supplied browser (pool) stays.
      if (this.ownsBrowser) await driver.close().catch(() => {});
    }
  }

  // --- kimi_list_conversations: sidebar/history DOM FIRST, honest rpcNote ---
  // The inventory proves the wire API (kimi.gateway.chat.v1.ChatService.ListChats
  // over Connect protobuf at notilo.kimi.com/apiv2) and the routes /chat/:id,
  // /chat/history, but there is NO captured session to replay the UI's own
  // ListChats framing yet. Encoding a Connect/protobuf body without observed
  // payloads would be fabrication — so DOM is the current implementation and the
  // note below states exactly what the RPC would need.
  private async listConversations(args: Record<string, unknown>): Promise<KimiCapabilityResult> {
    const page = await this.openPage();
    await waitForDomain(page, 3000);
    const query = String(args.query ?? "").trim();
    const rpcNote =
      "wire RPC (kimi.gateway.chat.v1.ChatService.ListChats over Connect protobuf, notilo.kimi.com/apiv2, " +
      "localStorage access_token Bearer + x-msh-shield-data) is future work pending wire capture — " +
      "DOM sidebar reflects the current session" +
      (query ? "; query filter not available on the DOM path — full list returned" : "");
    try {
      const dom = await page.evaluate(() => {
        // Sidebar / history conversation links on the live page: /chat/<id>
        // routes per the router bundle (/chat/:id, /chat/history, ...).
        // Navigation chrome is excluded (static routes are not conversations).
        const nav = new Set(["/chat", "/chat/history", "/chat/provisional", "/chat/record/prefill"]);
        const out: Array<{ id: string; title: string }> = [];
        for (const a of document.querySelectorAll("a[href^='/chat/']")) {
          const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
          const id = href.replace("/chat/", "").split(/[?&]/)[0];
          if (!id || nav.has("/chat/" + id)) continue;
          if (/\d/.test(id) === false && id.includes("/")) continue;
          const text = ((a as HTMLElement).innerText || "").trim();
          if (!out.some((x) => x.id === id)) out.push({ id, title: text || id });
        }
        return out.slice(0, 20);
      });
      return {
        capability: "kimi_list_conversations",
        ok: true,
        method: "dom.sidebar",
        data: { conversations: dom, via: "dom.sidebar", rpcNote },
      };
    } catch (e) {
      return this.fail("kimi_list_conversations", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- kimi_model_list: read the model picker state, only when straightforward ---
  // Selectors are UNVERIFIED candidates (inventory proves a model picker via the
  // `selectModelEntry` state key + GetAvailableModels RPC, but no DOM class) —
  // confirm on first live capture. If nothing picker-like renders, return an
  // honest ok:false instead of guessing a catalog.
  private async modelList(): Promise<KimiCapabilityResult> {
    const page = await this.openPage();
    await waitForDomain(page, 3000);
    try {
      const models = await page.evaluate(() => {
        const out: Array<{ id: string; name: string; selected: boolean }> = [];
        const seen = new Set<string>();
        // unverified — model picker DOM candidates; inventory names the state
        // key (selectModelEntry) but no class. confirm on first live capture.
        for (const el of document.querySelectorAll(
          '[class*="model-picker"] [role="option"], [class*="model-picker"] li, [class*="model"] [role="option"], [data-model-id], [class*="model-item"]'
        )) {
          const name = ((el as HTMLElement).innerText || "").trim().split("\n")[0];
          const id = (el as HTMLElement).getAttribute("data-model-id") ?? name;
          if (name && !seen.has(id)) {
            seen.add(id);
            const selected = Boolean(
              (el as HTMLElement).getAttribute("aria-selected") === "true" ||
                (el as HTMLElement).className.includes("selected") ||
                (el as HTMLElement).className.includes("active")
            );
            out.push({ id, name, selected });
          }
        }
        return out.slice(0, 25);
      });
      if (models.length === 0) {
        return {
          capability: "kimi_model_list",
          ok: false,
          method: "dom.picker",
          data: undefined,
          error:
            "model picker not straightforward on this render — selectors unverified (inventory proves the picker via selectModelEntry state + GetAvailableModels RPC but no DOM class); confirm on first live capture",
        };
      }
      return { capability: "kimi_model_list", ok: true, method: "dom.picker", data: models };
    } catch (e) {
      return this.fail("kimi_model_list", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  private fail(capability: string, e: unknown): KimiCapabilityResult {
    return { capability, ok: false, data: undefined, error: e instanceof Error ? e.message : String(e) };
  }

  private async teardownPage(page: Page): Promise<void> {
    try {
      await page.context()?.close();
    } catch {
      // already gone
    }
    // Browser is only ours when the caller didn't hand one in.
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

// Let the SPA settle past domcontentloaded; Kimi's sidebar renders after
// hydration, not at document load.
async function waitForDomain(page: Page, ms: number): Promise<void> {
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < ms) {
      const ready = await page.evaluate(() => document.readyState).catch(() => "missing");
      if (ready === "complete") break;
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch {
    // page gone mid-wait — caller will get its own evaluate error
  }
}