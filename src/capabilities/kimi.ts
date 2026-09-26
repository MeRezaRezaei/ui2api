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
//                              never half-implemented here. Selectors VERIFIED
//                              2026-09-19 against the "next" UI revision:
//                              a.next-sidebar-history-item__link href
//                              /chat/<uuid>?chat_enter_method=history.
//   kimi_model_list         -> dynamic read of the model picker (VERIFIED
//                              2026-09-19): [data-testid="model-select-trigger"]
//                              opens a panel of button.model-item rows; the
//                              picked model carries a "checked" class.
//   kimi_web_search         -> flips the REAL composer web-search toggle
//                              (VERIFIED 2026-09-19): [data-testid="toolkit-trigger-btn"]
//                              opens the toolkit panel, then
//                              button.toolkit-item[role="menuitem"]:has-text("Web Search")
//                              toggles the search switch (state key selectSearch),
//                              feeding kimi.chat.v1.Tool{type:TOOL_TYPE_SEARCH=1,
//                              search{force}} on the next ChatService.Chat send.
//   kimi_file_upload        -> attaches a file through the REAL UI
//                              (VERIFIED 2026-09-19): toolkit panel "Add files &
//                              images" is a <label class="toolkit-item"> wrapping
//                              the composer's file input; Playwright's
//                              filechooser drives it so the site's own JS uploads
//                              (multipart POST notilo.kimi.com/apiv2-files/
//                              file/upload + GetFileParseProgress tracking).
//   kimi_long_context       -> drives the REAL composer context-length picker
//                              (MEASURED LIVE 2026-09-23): the model panel
//                              [data-testid="model-select-trigger"] renders
//                              button[data-testid="model-context-length-item"]
//                              (class effort-item) ONLY when the selected model
//                              carries contextLengthOptions (K3 family; the
//                              Instant speed model has none); clicking it opens
//                              a submenu of
//                              button[data-testid="model-context-length-option"]
//                              carrying data-context-length=<ContextLength enum>
//                              (5=L "Standard" default, 6=XL "Extra Long").
//                              Selecting "Extra Long" on a non-Max account shows
//                              the measured upgrade gate ("Extra Long / Available
//                              to subscribers on the Max plan or higher / Cancel /
//                              Upgrade") — the long option is plan-gated, and the
//                              runner reports that honestly instead of an ok.
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
import { resolvedHeadless, launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { attachPayload, attachRefusal, validateAttachRequest } from "../runtime/file-attach.js";
import { injectSnapshot, loadAccountSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { ChatDriver } from "../prompt/driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface KimiCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
}

export interface KimiCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  rpcNote?: string;
  note?: string;
}

// GOAL 88: what kimi_file_upload may hand the composer. Kimi's own accept list
// was not measured, so the gate holds to the signature-verified set (images +
// pdf + office packages). A text payload has no magic signature and is refused
// by name — that class (.env, id_rsa, credentials) is the exfiltration target.
const KIMI_ATTACH_ACCEPT = [
  "image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
].join(",");

/**
 * GOAL 115: how long the composer's file input is given to render its
 * attachment chip before the upload is called unconfirmed. Named so the
 * refusal message can say the real wait the runner performed.
 */
const KIMI_FILE_UPLOAD_CHIP_WAIT_MS = 3600;

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return resolvedHeadless();
}

export class KimiCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;
  private readonly account?: string;

  constructor(private readonly profile: ChatSiteProfile, opts: KimiCapabilityOptions = {}) {
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
      let snap: ReturnType<typeof loadSnapshot> | null = null;
      if (this.account && this.account !== "default") {
        // Identity-keyed account vault (data/sessions/<host>/<slug>/): load the
        // requested identity's snapshot and inject IT — never a silent fallback
        // to the legacy default identity.
        snap = loadAccountSnapshot(this.dataDir, host, this.account);
        if (!snap) {
          throw new Error(
            `no stored session for ${this.profile.id} account "${this.account}" on ${host} — capture it ` +
              `first (ui2api profile capture <url> --login) or omit account for the legacy default snapshot`
          );
        }
      } else {
        snap = loadSnapshot(snapshotPath(this.dataDir, host));
      }
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
        return this.webSearch(args);
      case "kimi_file_upload":
        return this.fileUpload(args);
      case "kimi_long_context":
        return this.longContext(args);
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
    // The "next" UI renders the sidebar history after hydration — a readyState
    // wait is NOT enough; wait for the actual conversation link nodes.
    await page
      .waitForSelector("a.next-sidebar-history-item__link, a[href^='/chat/']", { timeout: 15000 })
      .catch(() => {});
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
        const seen = new Set<string>();
        // VERIFIED 2026-09-19 ("next" UI): a.next-sidebar-history-item__link
        // carries href /chat/<uuid>?chat_enter_method=history; the generic
        // a[href^='/chat/'] also matches each one — both queried + deduped.
        for (const a of document.querySelectorAll(
          "a.next-sidebar-history-item__link, a[href^='/chat/']"
        )) {
          const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
          const id = href.replace("/chat/", "").split(/[?&]/)[0];
          if (!id || nav.has("/chat/" + id)) continue;
          if (/\d/.test(id) === false && id.includes("/")) continue;
          if (seen.has(id)) continue;
          seen.add(id);
          const text = ((a as HTMLElement).innerText || "").trim();
          out.push({ id, title: text || id });
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

  // --- kimi_model_list: dynamic read of the model picker (VERIFIED 2026-09-19) ---
  // [data-testid="model-select-trigger"] (the composer's "Instant / High" chip)
  // opens a panel of button.model-item rows (name on the first line, description
  // below); the active model carries class "checked". Wire RPC underneath is
  // GetAvailableModels (kimi.gateway.chat.v1) — DOM is the honest live surface.
  private async modelList(): Promise<KimiCapabilityResult> {
    const page = await this.openPage();
    await page.waitForSelector('[data-testid="model-select-trigger"]', { timeout: 15000 }).catch(() => {});
    try {
      await page.click('[data-testid="model-select-trigger"]', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(900);
      const models = await page.evaluate(() => {
        const out: Array<{ id: string; name: string; selected: boolean }> = [];
        const seen = new Set<string>();
        for (const el of document.querySelectorAll("button.model-item")) {
          const text = ((el as HTMLElement).innerText || "").trim();
          const name = text.split("\n")[0].trim();
          if (name && !seen.has(name)) {
            seen.add(name);
            out.push({ id: name, name, selected: (el as HTMLElement).className.includes("checked") });
          }
        }
        return out.slice(0, 25);
      });
      await page.keyboard.press("Escape").catch(() => {});
      if (models.length === 0) {
        return {
          capability: "kimi_model_list",
          ok: false,
          method: "dom.model-picker",
          data: undefined,
          error:
            "model picker rendered no button.model-item rows on this load (picker state or hydration timing) — retry; wire RPC GetAvailableModels needs a live wire capture",
        };
      }
      return {
        capability: "kimi_model_list",
        ok: true,
        method: "dom.model-picker",
        data: models,
        rpcNote: undefined,
      };
    } catch (e) {
      return this.fail("kimi_model_list", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- kimi_web_search: flip the REAL composer web-search toggle (VERIFIED) ---
  private async webSearch(args: Record<string, unknown>): Promise<KimiCapabilityResult> {
    const page = await this.openPage();
    await page.waitForSelector('[data-testid="toolkit-trigger-btn"]', { timeout: 15000 }).catch(() => {});
    try {
      const target = page.locator('button.toolkit-item').filter({ hasText: "Web Search" }).first();
      await openToolkitItem(page, target);
      await itemReady(page, target);
      await target.click();
      await page.waitForTimeout(800);
      const state = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button.toolkit-item")].find(
          (b) => ((b as HTMLElement).innerText || "").trim() === "Web Search"
        ) as HTMLElement | null;
        // composer-area search chip / active switch, if the UI exposes one
        const chip = document.querySelector(
          '[data-testid*="web-search"], [class*="web-search"][class*="active"], [class*="web-search"][class*="checked"], [class*="toolkit-item"][class*="checked"], [class*="toolkit-item"][class*="active"]'
        ) as HTMLElement | null;
        return {
          btnClass: btn ? (btn.className as string).toString().slice(0, 80) : null,
          chipText: chip ? (chip.innerText || "").trim().slice(0, 40) : null,
          chipClass: chip ? (chip.className as string).toString().slice(0, 80) : null,
        };
      });
      return {
        capability: "kimi_web_search",
        ok: true,
        method: "dom.toolkit-toggle",
        data: { toggled: "Web Search", state },
        note: "flips composer web-search switch (state key selectSearch) — feeds kimi.chat.v1.Tool{type:TOOL_TYPE_SEARCH=1, search{force}} on the next ChatService.Chat send",
      };
    } catch (e) {
      return this.fail("kimi_web_search", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- kimi_file_upload: attach a file through the REAL file input (VERIFIED) ---
  //
  // GOAL 88: the payload goes through the SHARED attach gate
  // (src/runtime/file-attach.ts) BEFORE the browser opens. It used to be
  // `String(args.path ?? args.filePath)` straight into setInputFiles, i.e. the
  // capability could read and upload ANY local file the daemon could reach. The
  // accept list is the signature-verified set (images + pdf + office packages);
  // a text/json payload has no magic signature and is refused by name, which is
  // exactly the class (.env, id_rsa, credentials) that must never be attachable.
  private async fileUpload(args: Record<string, unknown>): Promise<KimiCapabilityResult> {
    const attach = validateAttachRequest(args, { siteId: "kimi", accept: KIMI_ATTACH_ACCEPT });
    if (!attach.ok) {
      const refusal = attachRefusal(attach, "kimi_file_upload");
      return {
        capability: refusal.capability,
        ok: false,
        data: { code: refusal.code, rule: attach.code, message: refusal.message },
        method: "dom.input.setFiles",
        error: `[${refusal.code}] ${refusal.message} (GOAL 88 attach gate, src/runtime/file-attach.ts — refused before any browser launched)`,
      };
    }
    const payload = attachPayload(attach);
    const page = await this.openPage();
    await page.waitForSelector('[data-testid="toolkit-trigger-btn"]', { timeout: 15000 }).catch(() => {});
    try {
      const attachBtn = page.locator('label.toolkit-item').filter({ hasText: "Add files & images" }).first();
      await openToolkitItem(page, attachBtn);
      await itemReady(page, attachBtn);
      // The "Add files & images" label wraps a hidden <input class="hidden-input">
      // (charset input). setInputFiles sets the value AND fires the change event,
      // so the site's own JS performs the multipart upload — no synthetic XHR.
      // The GATED bytes go over in memory (vetted name + SNIFFED mimeType).
      const fileInput = attachBtn.locator('input[type="file"]');
      await fileInput.setInputFiles(payload);
      await page.waitForTimeout(1800);
      await page.waitForTimeout(1800);
      const attached = await page.evaluate(() => {
        const chip = document.querySelector(
          '[data-testid="file-preview"], [class*="file-preview"], [class*="file-item"], [class*="attachment"], [class*="upload-file"]'
        ) as HTMLElement | null;
        return chip ? (chip.innerText || "").trim().slice(0, 60) : null;
      });
      // GOAL 115: the verdict is the CHIP READ-BACK, not "we handed the bytes to
      // setInputFiles". This used to be a literal ok:true, so a payload the site
      // silently refused (still uploading, filtered mime, signed-out shell) read
      // as a success to any consumer. A rendered attachment chip is the
      // post-condition; its absence is a NAMED refusal.
      if (!attached) {
        return {
          capability: "kimi_file_upload",
          ok: false,
          method: "dom.input.setFiles",
          data: { file: payload.name, attached: null },
          error:
            `no attachment chip rendered after setInputFiles (measured: the composer's file-preview/file-item/attachment element is absent ${KIMI_FILE_UPLOAD_CHIP_WAIT_MS}ms after the change event) — the site accepted the input but never confirmed the attachment; nothing was uploaded by this call`,
        };
      }
      return {
        capability: "kimi_file_upload",
        ok: true,
        method: "dom.input.setFiles",
        data: { file: payload.name, attached, verified: false },
        note:
          "the site's own JS performs the multipart POST to notilo.kimi.com/apiv2-files/file/upload (FileService.Upload) + GetFileParseProgress tracking. " +
          "HONESTY (GOAL 115): ok:true here means the attachment chip was READ BACK off the page — an accepted INPUT plus the site's own confirmation chip. " +
          "It is NOT a live round-trip claim: the model's answer actually carrying the file is unproven, so verified:false stands.",
      };
    } catch (e) {
      return this.fail("kimi_file_upload", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- kimi_long_context: drive the REAL composer context-length picker ---
  // The long-context UI IS the model panel's "Context length" row (MEASURED LIVE
  // 2026-09-23 against the account vault): the row exists only for models whose
  // contextLengthOptions is non-empty (K3 family; the Instant speed model has
  // none). Option rows carry data-context-length=<kimi.common.v1.ContextLength
  // enum> (5=L "Standard" default, 6=XL "Extra Long"); selecting "Extra Long"
  // on a non-Max account opens the measured upgrade gate ("Extra Long / Available
  // to subscribers on the Max plan or higher / Cancel / Upgrade"), so the runner
  // reports the gate honestly instead of a fabricated ok:true. The selection
  // feeds state key selectContextLength → ChatRequestOptions.context_length on
  // the next ChatService.Chat send (same stream as normal chat).
  private async longContext(args: Record<string, unknown>): Promise<KimiCapabilityResult> {
    const page = await this.openPage();
    await page.waitForSelector('[data-testid="model-select-trigger"]', { timeout: 15000 }).catch(() => {});
    const reopenPanel = async (): Promise<void> => {
      await page.click('[data-testid="model-select-trigger"]', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(900);
    };
    try {
      await reopenPanel();
      // The picker row only renders for a model with contextLengthOptions; if the
      // current model (e.g. "Instant") has none, select the flagship K3 Chat &
      // Agent so the real user path reaches the picker.
      let hasPicker = await page.locator('[data-testid="model-context-length-item"]').isVisible().catch(() => false);
      if (!hasPicker) {
        const k3 = page.locator('button.model-item').filter({ hasText: "K3 Chat & Agent" }).first();
        if ((await k3.count()) > 0) {
          await k3.click({ timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(1000);
          await reopenPanel();
          hasPicker = await page.locator('[data-testid="model-context-length-item"]').isVisible().catch(() => false);
        }
      }
      if (!hasPicker) {
        return {
          capability: "kimi_long_context",
          ok: false,
          method: "dom.context-length-picker",
          data: undefined,
          error:
            "no model with a context-length picker is selected and K3 Chat & Agent is unavailable on this account — contextLengthOptions is empty for the selected model (measured live 2026-09-23: 'Instant' renders no picker row)",
        };
      }
      // Open the option submenu: the picker row is a menu item with
      // data-close-on-select=false; its options live in a sibling popup of
      // button[data-testid="model-context-length-option"].
      await page
        .locator('[data-testid="model-context-length-item"]')
        .click({ timeout: 8000 })
        .catch(() => {});
      await page.waitForSelector('button[data-testid="model-context-length-option"]', { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(300);
      const picker = await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>("button[data-testid='model-context-length-item']");
        const options = Array.from(
          document.querySelectorAll<HTMLElement>("button[data-testid='model-context-length-option']")
        );
        return {
          current: row ? (row.innerText || "").replace(/\s+/g, " ").trim().replace(/^Context length\s*/, "") : null,
          options: options.map((el) => {
            const txt = (el.innerText || "").replace(/\s+/g, " ").trim();
            return {
              name: (txt.match(/^([^\n·]+)/)?.[1] ?? txt.slice(0, 40)).slice(0, 40),
              contextLength: Number(el.getAttribute("data-context-length")) || 0,
              selected: el.getAttribute("aria-checked") === "true",
              desc: txt.slice(0, 140),
            };
          }),
        };
      });
      // Target enum: 6=XL "Extra Long" (the long-context option), 5=L "Standard".
      const wantLong = args.longContext !== false;
      const wantValue = typeof args.length === "number" ? args.length : wantLong ? 6 : 5;
      const target = picker.options.find((o) => o.contextLength === wantValue);
      if (!target) {
        return {
          capability: "kimi_long_context",
          ok: false,
          method: "dom.context-length-picker",
          data: picker,
          error:
            `context length enum ${wantValue} is not offered by the selected model — ` +
            `measured options: ${picker.options.map((o) => `${o.name}(enum ${o.contextLength})`).join(", ") || "(none)"}`,
        };
      }
      if (target.selected) {
        return {
          capability: "kimi_long_context",
          ok: true,
          method: "dom.context-length-picker",
          data: { ...picker, applied: target.name, contextLengthApplied: true },
          note: "already the active context length — feeds ChatRequestOptions.context_length on the next ChatService.Chat send",
        };
      }
      await page
        .locator(`button[data-testid="model-context-length-option"][data-context-length="${wantValue}"]`)
        .click({ timeout: 8000 })
        .catch(() => {});
      await page.waitForTimeout(1400);
      // Measure whether the site answered with the real toggle or a plan gate.
      // The measured plan-gate renders `div[data-testid="confirm-dialog"]` under
      // `div.modal-mask` (no role=dialog) with body text "Available to
      // subscribers on the Max plan or higher / Cancel / Upgrade" — scan both
      // the dialog containers and the body so a gate can never be silently
      // mistaken for an applied toggle.
      const gate = await page.evaluate(() => {
        const markers = [/subscribers on the/i, /plan or higher/i, /^Upgrade$/im];
        const dialogs = Array.from(
          document.querySelectorAll<HTMLElement>("[role='dialog'], [data-testid='confirm-dialog'], [class*='modal'], [class*='dialog']")
        ).map((el) => (el.innerText || "").replace(/\s+/g, " ").trim());
        const hit = dialogs.find((t) => /subscribers on the|plan or higher/i.test(t));
        if (hit) return hit.slice(0, 240);
        const text = document.body.innerText;
        const m = text.match(/[^\n]*subscribers on the[^\n]*/i);
        return m ? m[0].replace(/\s+/g, " ").trim().slice(0, 240) : null;
      });
      if (gate) {
        return {
          capability: "kimi_long_context",
          ok: false,
          method: "dom.context-length-picker",
          data: { ...picker, gate },
          error:
            `context-length option "${target.name}" (ContextLength enum ${wantValue}) is plan-gated on this account — ` +
            `measured upgrade gate: "${gate}" (2026-09-23); available options: ${picker.options.map((o) => o.name).join(", ")}`,
        };
      }
      const applied = await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>("button[data-testid='model-context-length-item']");
        return row ? (row.innerText || "").replace(/\s+/g, " ").trim() : null;
      });
      if (!applied || !applied.includes(target.name)) {
        return {
          capability: "kimi_long_context",
          ok: false,
          method: "dom.context-length-picker",
          data: { ...picker, applied },
          error:
            `clicking context length "${target.name}" (enum ${wantValue}) did not change the selection and no plan gate was measured — picker read-back: ${applied ?? "(row gone)"} (measured 2026-09-23)`,
        };
      }
      return {
        capability: "kimi_long_context",
        ok: true,
        method: "dom.context-length-picker",
        data: { ...picker, applied, contextLengthApplied: true },
        note:
          "sets ChatRequestOptions.context_length (kimi.common.v1.ContextLength enum) — option rows carry data-context-length=<enum> and feed the selectContextLength state into the ChatService.Chat stream",
      };
    } catch (e) {
      return this.fail("kimi_long_context", e);
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

// The Kimi "next" app boots its event wiring lazily: a click on the toolkit
// trigger BEFORE boot completes is silently dropped (verified 2026-09-19 — the
// same cold-boot behaviour as Tencent Hy Studio). Poll: while the target menu
// row is not visible we (re)open the toolkit panel and keep checking up to 15s,
// so the wait is deterministic (bounded by app boot) rather than a fixed sleep.
async function openToolkitItem(page: Page, target: import("playwright").Locator): Promise<void> {
  const t0 = Date.now();
  let visible = await target.isVisible().catch(() => false);
  while (!visible && Date.now() - t0 < 15000) {
    // If the panel isn't showing ANY row, (re)open it — a pre-boot click was
    // dropped, so this is idempotent: opening when already open is a no-op toggle.
    const anyRow = await page
      .locator('button.toolkit-item, label.toolkit-item')
      .first()
      .isVisible()
      .catch(() => false);
    if (!anyRow) {
      await page.click('[data-testid="toolkit-trigger-btn"]', { timeout: 4000 }).catch(() => {});
    }
    await page.waitForTimeout(700);
    visible = await target.isVisible().catch(() => false);
  }
}

async function itemReady(page: Page, target: import("playwright").Locator): Promise<void> {
  const ok = await target.isVisible().catch(() => false);
  if (!ok) throw new Error(`toolkit target not visible after boot settle: ${await target.evaluate((el) => (el as HTMLElement).innerText).catch(() => "?")}`);
}