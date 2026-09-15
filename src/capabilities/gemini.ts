// Gemini capability runner — exposes Gemini's full JS-visible surface as typed
// callable capabilities over the SAME browser + session machinery as ChatDriver.
//
// Capability dispatch:
//   gemini_chat             -> ChatDriver UI path (proven; real stream, search
//                              toggle is a `tools` item inside StreamGenerate)
//   gemini_list_conversations -> batchexecute ListConversations (RPC), fallback
//                              to reading the sidebar DOM (always current)
//   gemini_model_list       -> read the model picker state (DOM / WIZ_global_data)
//   gemini_search_toggle    -> toggles the composer Search / Web-access switch
//                              in the UI (UpdateToolPermission equivalent)
//
// All RPC calls run inside the logged-in page (page.evaluate + fetch) so the
// request carries the real session cookies + XSRF token; nothing synthetic.
//
// ===== Live wire findings — compact batchexecute IDs (2026-09-15, verified
// ===== by replaying the UI's own bootstrap payloads on a live page) =====
//   aPya6c = ListConversations       (payload [] -> [hasMore,totalCount,[convs]])
//   otAQ7b = bootstrap/config catalog(payload [] -> model defs + grounding/
//                                   composer "sources" picker entries:
//                                   Search=id 1, Gmail=3, Drive=4, Chat=12;
//                                   the Search source is what "Google Search"
//                                   grounding maps to, sent via StreamGenerate)
//   K4WWud = client location lookup  (payload [[0],["en-US"]] -> [city, consent
//                                   label, false, null, maps/vt tile url])
//   ozz5Z  = per-entitlement status  (payload [[[null,"1",<id>],null,1],...] ->
//                                   echoes rows with trailing 1 -> 0 = not
//                                   entitled; ids incl. 447,448,702,961,960,
//                                   1062,1240,1237,1238,1239,1241)
//   o30O0e = person profile request  (real payload [["me"],[[["person.photo",
//                                   "person.name","person.email"]],null,[1,7]]];
//                                   reply null in non-personalized sessions)
//   L5adhe = popup/notification state upsert
//                                   (payload [<104+ null flags>, [[key]]] with
//                                   key = current_popup_id / popup_zs_visits_
//                                   cooldown / last_selected_mode_id_on_web;
//                                   null reply — fire-and-forget pref write)
//   sJBwce = session/telemetry write (real payload [[1,2]]; null + [3] reply)
//   GPRiHf / maGuAc ([1],[2]) / CNgdBe ([1|2,["en-US"],0]) / I4z33b =
//                                   state/pref writes — null reply (void)
//   cYRIkd(["en-US"]) / whPPme(["en-US",null,[4]]) / ku4Jyf([...]) -> [] (reads)
//   Te6DCf = discovery/landing content ([[ "en-US"],[1,2]] -> ~18 KB feature cards)
//   These void RPCs carry no data-bearing response; none merit a capability.
//
// ===== Conversation CRUD compact IDs: NOT pinned =====
//   A live New-chat click fires NO batchexecute in this UI revision — the
//   conversation is created lazily on the first StreamGenerate. The account that
//   the shipped snapshot signs into currently renders a signed-out SSR leaf with
//   0 conversations, so rename/delete could not be exercised to capture their
//   compact IDs. DO NOT fabricate:
//   TODO: re-capture a signed-in session, then New chat -> first send to catch
//   the create RPC; open a row kebab ("More options") -> Rename / Delete to
//   catch their compact IDs. v1 full paths already known from the bundle:
//   CreateConversation, MutateConversation, UpdateChat, DeleteConversation,
//   BranchConversation, UpdateConversation, ListConversationTurns,
//   GetConversationTurn.
import { launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { ChatDriver } from "../prompt/driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";
import { callGeminiRpc } from "./gemini-rpc.js";

export interface GeminiCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
}

export interface GeminiCapabilityResult {
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

export class GeminiCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: GeminiCapabilityOptions = {}) {
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

  async run(capability: string, args: Record<string, unknown> = {}): Promise<GeminiCapabilityResult> {
    switch (capability) {
      case "gemini_chat":
        return this.chat(args);
      case "gemini_list_conversations":
        return this.listConversations(args);
      case "gemini_model_list":
        return this.modelList();
      case "gemini_search_toggle":
        return this.searchToggle(args);
      default:
        return { capability, ok: false, data: undefined, error: `unknown gemini capability: ${capability}` };
    }
  }

  // --- gemini_chat: the UI path (proven live) ---
  private async chat(args: Record<string, unknown>): Promise<GeminiCapabilityResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) return this.fail("gemini_chat", "prompt is required");
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
        capability: "gemini_chat",
        ok: true,
        data: { answer: r.answer, chunkCount: r.chunkCount, doneReason: r.doneReason, url: r.url, title: r.title },
      };
    } finally {
      // Only tear down what we own; an externally-supplied browser (pool) stays.
      if (this.ownsBrowser) await driver.close().catch(() => {});
    }
  }

  // --- gemini_list_conversations: RPC first, DOM fallback ---
  private async listConversations(args: Record<string, unknown>): Promise<GeminiCapabilityResult> {
    const page = await this.openPage();
    await waitForDomain(page, 3000);
    // Search support: /BardFrontendService.SearchConversations with a query.
    const query = String(args.query ?? "").trim();
    // Compact descriptor IDs pinned from live capture (2026-09-15, build
    // boq_assistant-bard-web-server_20260914.08_p0) — see header comment for
    // the full decode:
    //   aPya6c = ListConversations   (body [] → [hasMore, totalCount, [conversations]])
    //   sJBwce = session/telemetry write (void — null + [3]/[7] reply)
    //   otAQ7b = bootstrap/config    (model defs, schema IDs, grounding sources)
    // Search stays on the v1 full path — its compact ID was not observed live.
    const method = query ? "/BardFrontendService.SearchConversations" : "aPya6c";
    try {
      const payload = query ? [[null, [null, query, null, null, [], null, null, null, null, null, [], null]]] : [];
      const rpc = await callGeminiRpc(page, { method, payload, timeoutMs: 15000 });
      if (rpc.ok && rpc.data != null) {
        // ListConversations returns [hasMore, totalCount, [conversations]] —
        // normalize into a stable API shape while keeping the raw payload.
        const d = rpc.data as unknown;
        const shape: { hasMore?: boolean; totalCount?: number; conversations: unknown[]; raw: unknown } = {
          raw: d,
          conversations: [],
        };
        if (Array.isArray(d) && (d.length === 0 || d[0] === false || d[0] === true)) {
          shape.hasMore = d[0] === true;
          if (typeof d[1] === "number") shape.totalCount = d[1];
          if (Array.isArray(d[2])) shape.conversations = d[2] as unknown[];
        }
        return {
          capability: "gemini_list_conversations",
          ok: true,
          method,
          data: shape,
          latencyMs: rpc.latencyMs,
        };
      }
      // RPC envelope failed or returned no payload (ListConversations proto is
      // version-fragile — needs a live-capture of the UI's own call to pin the
      // field layout). Fall back to the sidebar DOM, which always reflects the
      // current session.
      const rpcNote = rpc.error
        ? rpc.error
        : "rpc accepted but returned null payload (proto layout unverified) — falling back to DOM";
      const dom = await page.evaluate(() => {
        const out: Array<{ id: string; title: string }> = [];
        for (const a of document.querySelectorAll("a[href^='/app/']")) {
          const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
          const id = href.replace("/app/", "").split(/[?&]/)[0];
          const text = ((a as HTMLElement).innerText || "").trim();
          if (id && !out.some((x) => x.id === id)) out.push({ id, title: text || id });
        }
        return out.slice(0, 20);
      });
      return {
        capability: "gemini_list_conversations",
        ok: true,
        method: "dom.sidebar",
        data: { conversations: dom, via: "dom-sidebar", rpcNote },
      };
    } catch (e) {
      return this.fail("gemini_list_conversations", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- gemini_model_list: read picker state from the live page ---
  private async modelList(): Promise<GeminiCapabilityResult> {
    const page = await this.openPage();
    await waitForDomain(page, 3000);
    try {
      // Try otAQ7b (bootstrap/config RPC, compact ID from live capture) first —
      // it returns the full model catalog with schema IDs, display names,
      // feature flags, and payment tiers. Fall back to DOM if RPC unavailable.
      const rpc = await callGeminiRpc(page as any, { method: "otAQ7b", payload: [] });
      if (rpc.ok && rpc.data) {
        // Response payload is a JSON string: [6, [hasPaid?, null, paidEnabled],
        // true, null, null, null, ...models, 1016, [[schemaId, displayName,
        // tagline, [permissionFlags...], 1, null, [modelHashes], ...
        // displayName3p6, visibleName, tagline2, ...]]]
        const raw = typeof rpc.data === "string" ? rpc.data : JSON.stringify(rpc.data);
        try {
          const parsed = JSON.parse(raw);
          // Models live in the last entry's nested array after the flag block.
          // Extract by scanning for sub-arrays with [schemaId, displayName, tagline] shape.
          const models: Array<{ id: string; name: string; tagline: string }> = [];
          const scan = (obj: unknown): void => {
            if (!Array.isArray(obj)) return;
            // Real model entry: [schemaId, displayName, tagline, [flags...],
            // 1, null, [modelHashes...], ...]. False positives are the nested
            // modelHashes arrays — all-hex names with NO 4th array element.
            if (
              obj.length >= 4 &&
              typeof obj[0] === "string" &&
              typeof obj[1] === "string" &&
              typeof obj[2] === "string" &&
              obj[0].length > 6 &&
              (Array.isArray(obj[3]) || !/^[0-9a-f]{10,}$/i.test(obj[1]))
            ) {
              models.push({ id: obj[0], name: obj[1], tagline: obj[2] });
            }
            for (const el of obj) scan(el);
          };
          scan(parsed);
          if (models.length > 0) return { capability: "gemini_model_list", ok: true, method: "rpc.otAQ7b", data: models };
        } catch { /* fall through to DOM */ }
      }
      // DOM fallback: read the model picker state (always-current).
      const models = await page.evaluate(() => {
        const out: Array<{ id: string; name: string; selected: boolean }> = [];
        const seen = new Set<string>();
        for (const el of document.querySelectorAll('[data-test-id*="model"], [data-model-id], [class*="model-picker"] li, [class*="model-picker"] [role="option"]')) {
          const name = ((el as HTMLElement).innerText || "").trim().split("\n")[0];
          const id = (el as HTMLElement).getAttribute("data-model-id") ?? name;
          if (name && !seen.has(id)) {
            seen.add(id);
            const selected = Boolean(el.getAttribute("aria-selected") === "true" || (el as HTMLElement).className.includes("selected"));
            out.push({ id, name, selected });
          }
        }
        let flags: Record<string, string> = {};
        try {
          const wiz = (window as unknown as { WIZ_global_data?: Record<string, unknown> }).WIZ_global_data;
          if (wiz) flags = Object.fromEntries(
            Object.entries(wiz)
              .filter(([k]) => /^1bc6b5d98741cd3d|^1a43ad63cc8a7f9a|^a74ec8485b3b5ce4|^9d8ca3786ebdfbea|^e6fa609c3fa255c0|^797f3d0293f288ad/.test(k))
              .map(([k, v]) => [k, String(v).slice(0, 80)])
          );
        } catch { /* shell flags absent */ }
        return { models: out.slice(0, 25), wizModelFlags: flags };
      });
      return { capability: "gemini_model_list", ok: true, method: "dom.picker", data: models };
    } catch (e) {
      return this.fail("gemini_model_list", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- gemini_search_toggle: the composer Web-access / Search switch ---
  // Verdict (2026-09-15 live probe): this UI revision has NO standalone search
  // toggle button in the composer — the composer toolbar is only "Upload &
  // tools" + "Dictate". "Google Search" grounding is enabled via the composer
  // extensions/"sources" picker (otAQ7b source entries: Search=1, Gmail=3,
  // Drive=4, Chat=12) and rides the StreamGenerate tools field, so a signed-in
  // session normally exposes it as a menuitemcheckbox labelled "Search".
  // Keep a best-effort toggle AND cover the sources-picker checkbox.
  private async searchToggle(args: Record<string, unknown>): Promise<GeminiCapabilityResult> {
    const page = await this.openPage();
    await waitForDomain(page, 4000);
    try {
      const enable = args.enable !== false;
      const toggled = await page.evaluate((wantOn: boolean) => {
        // The search/web-access switch: find the toggle button by aria-label or
        // role, click it when its current state differs from `wantOn`.
        const labels = ["search", "web access", "google search", "use google search", "search on the web"];
        const btn = Array.from(document.querySelectorAll("button, [role='switch'], [role='checkbox'], [role='menuitemcheckbox']")).find((b) => {
          const t = ((b as HTMLElement).innerText || (b as HTMLElement).getAttribute("aria-label") || "").toLowerCase();
          return labels.some((l) => t.includes(l));
        });
        if (!btn) return { ok: false, reason: "no search toggle found — this UI revision has no standalone switch; set grounding via the composer 'sources' picker or the StreamGenerate tools field" };
        const currentlyOn = (btn as HTMLElement).getAttribute("aria-checked") === "true" || (btn as HTMLElement).className.includes("active") || (btn as HTMLElement).className.includes("checked");
        if (currentlyOn !== wantOn) {
          (btn as HTMLElement).click();
          return { ok: true, clicked: true, now: wantOn };
        }
        return { ok: true, clicked: false, now: wantOn };
      }, enable);
      return { capability: "gemini_search_toggle", ok: Boolean(toggled?.ok), data: toggled, method: "dom.composer-toggle" };
    } catch (e) {
      return this.fail("gemini_search_toggle", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  private fail(capability: string, e: unknown): GeminiCapabilityResult {
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

// Let the SPA settle past domcontentloaded; Gemini's sidebar/picker render after
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