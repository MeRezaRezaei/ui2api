// Capability probe — "capability reflection": learn what THIS account can
// actually do on a chat site, from what the site itself shows us. The site's
// model picker lists only the models the account can pick; the plan badge
// states the tier; upgrade/limit banners appear when a prompt hits a
// restriction. So we observe -> store -> watch -> report.
//
// Honest-unknown posture (mirrors kimi_model_list): we NEVER fabricate a
// catalog. When a dimension is unreadable we say method:"unknown" / ok:false
// with a reason, so callers can distinguish "we don't know" from "free plan".
//
// Selectors rot like composer selectors — re-tune via profile capability
// block or a JSON override (--profile FILE), never by guessing in code.
import type { ChatSiteProfile } from "../profile/profile.js";

// --- Pure logic (unit-tested, no browser) ---

export interface RestrictionMarker {
  kind: string;
  /** Case-insensitive substring patterns (JSON-safe, no RegExp literals). */
  patterns: string[];
}

export interface RestrictionHit {
  kind: string;
  matched: string;
}

/** Case-insensitive substring matching over the page's visible text. */
export function matchRestrictionMarkers(
  text: string | undefined | null,
  markers: RestrictionMarker[] | undefined
): RestrictionHit[] {
  if (!text || !markers?.length) return [];
  const lower = text.toLowerCase();
  const hits: RestrictionHit[] = [];
  for (const m of markers) {
    for (const p of m.patterns) {
      if (lower.includes(p.toLowerCase())) {
        hits.push({ kind: m.kind, matched: p });
        break; // one hit per marker kind
      }
    }
  }
  return hits;
}

export interface TierObserved {
  value: string | null;
  method: "dom" | "declared" | "unknown";
}

export interface ModelObserved {
  id: string;
  name: string;
  selected?: boolean;
  tier?: string;
}

/** A toggle-driven site ability (e.g. DeepSeek's DeepThink/Search). */
export interface AbilityToggle {
  id: string;
  label: string;
  on: boolean;
  present: boolean;
}

export interface CapabilityReport {
  site: string;
  host: string;
  account: string;
  observedAt: string;
  tier: TierObserved;
  models: ModelObserved[];
  modelsMethod: "wire" | "dom" | "declared" | "none";
  restrictions: RestrictionHit[];
  /** Toggle-driven abilities observed on the composer (method:"dom" when read). */
  abilities?: AbilityToggle[];
  abilitiesMethod?: "dom" | "unknown";
  ok: boolean;
  reason?: string;
}

export function buildReport(input: {
  site: string;
  host: string;
  account: string;
  tier: TierObserved;
  models: ModelObserved[];
  modelsMethod: CapabilityReport["modelsMethod"];
  restrictions?: RestrictionHit[];
  abilities?: AbilityToggle[];
  abilitiesMethod?: CapabilityReport["abilitiesMethod"];
  reason?: string;
}): CapabilityReport {
  const restrictions = input.restrictions ?? [];
  const abilities = input.abilities ?? [];
  const abilitiesMethod = input.abilitiesMethod ?? "unknown";
  const ok =
    input.tier.method !== "unknown" ||
    input.models.length > 0 ||
    input.modelsMethod !== "none" ||
    abilities.some((a) => a.present);
  return {
    site: input.site,
    host: input.host,
    account: input.account,
    observedAt: new Date().toISOString(),
    tier: input.tier,
    models: input.models,
    modelsMethod: input.modelsMethod,
    restrictions,
    ...(abilities.length ? { abilities, abilitiesMethod } : {}),
    ok,
    ...(ok ? {} : { reason: input.reason ?? "nothing readable with the current probe selectors" }),
  };
}

/** Build the unavailable-model error — the explicit answer to "someone has Pro, some don't". */
export function modelUnavailableError(model: string, observed: string[]): string {
  return `model "${model}" not available on this account (observed: [${observed.join(", ")}])`;
}

// --- Profile capabilities (declarative, JSON-safe) ---

export interface ProfileCapability {
  tierSelectors?: string[];
  pickerOpen?: string[];
  pickerOption?: string[];
  restrictionMarkers?: RestrictionMarker[];
  /**
   * Toggle-driven abilities — composer switches that reveal what THIS account
   * can do (DeepSeek's "DeepThink"/"Search", ...). Each entry names the toggle
   * and how to read its on/off state. Ground:
   *   selector      — container for one or more toggles (e.g. ".ds-toggle-button")
   *   label         — case-insensitive substring matching the toggle text
   *   selectedClass — class that marks the toggle as active (optional)
   */
  abilityToggles?: Array<{
    id: string;
    selector: string;
    label: string;
    selectedClass?: string;
  }>;
}

export function profileCapability(profile: ChatSiteProfile): ProfileCapability {
  return profile.capability ?? {};
}

// --- Live probe (browser-backed; best-effort, never throws for read failures) ---

export interface ProbePageLike {
  url(): string;
  title(): Promise<string>;
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  locator(sel: string): {
    first(): {
      waitFor(opts: { state: "visible"; timeout: number }): Promise<unknown>;
      click(opts?: { timeout: number }): Promise<unknown>;
    };
    count(): Promise<number>;
  };
  evaluate<R = unknown>(fn: () => R): Promise<R>;
  evaluate<R, Arg>(fn: (arg: Arg) => R, arg: Arg): Promise<R>;
}

const cleanText = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 120);

/**
 * Probe the live page for the account's capability fingerprint. Best-effort:
 * every read is guarded; anything unreadable becomes method:"unknown".
 * `modelsFromWire` lets a profile plug a grounded wire catalog (gemini otAQ7b)
 * instead of the DOM picker.
 */
export async function probeCapabilities(opts: {
  profile: ChatSiteProfile;
  page: ProbePageLike;
  account: string;
  modelsFromWire?: () => Promise<ModelObserved[] | null>;
}): Promise<CapabilityReport> {
  const cap = profileCapability(opts.profile);
  const host = hostFromUrl(opts.profile.url);
  const report: CapabilityReport = {
    site: opts.profile.id,
    host,
    account: opts.account,
    observedAt: new Date().toISOString(),
    tier: { value: null, method: "unknown" },
    models: [],
    modelsMethod: "none",
    restrictions: [],
    ok: false,
  };

  // 1. Tier — first visible selector's text.
  for (const sel of cap.tierSelectors ?? []) {
    try {
      const loc = opts.page.locator(sel).first();
      await loc.waitFor({ state: "visible", timeout: 6000 });
      const text = await opts.page.evaluate((s: string) => {
        const el = document.querySelector(s);
        return el ? (el as HTMLElement).innerText : "";
      }, sel);
      if (text?.trim()) {
        report.tier = { value: cleanText(text), method: "dom" };
        break;
      }
    } catch {
      // selector absent/not visible — try next
    }
  }
  if (!report.tier.value) report.tier = { value: null, method: "unknown" };

  // 2. Models — grounded wire catalog first, then DOM picker.
  if (opts.modelsFromWire) {
    try {
      const wire = await opts.modelsFromWire();
      if (wire && wire.length > 0) {
        report.models = wire;
        report.modelsMethod = "wire";
      }
    } catch {
      // wire read failed — fall through to DOM picker
    }
  }
  if (report.modelsMethod === "none" && cap.pickerOption?.length) {
    try {
      // Open the picker if a trigger is declared.
      if (cap.pickerOpen?.length) {
        const trigger = cap.pickerOpen[0];
        const loc = opts.page.locator(trigger).first();
        await loc.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
        await loc.click({ timeout: 3000 }).catch(() => {});
        await opts.page.waitForTimeout(1500);
      }
      const options = await opts.page.evaluate((sels: string[]) => {
        const out: Array<{ id: string; name: string; selected?: boolean }> = [];
        const seen = new Set<string>();
        for (const sel of sels) {
          for (const el of document.querySelectorAll(sel)) {
            const name = ((el as HTMLElement).innerText || "").trim().split("\n")[0];
            if (!name || name.length > 80) continue;
            const id =
              (el as HTMLElement).getAttribute?.("data-model-id") ||
              (el as HTMLElement).getAttribute?.("data-value") ||
              (el as HTMLElement).id ||
              name;
            if (!seen.has(id)) {
              seen.add(id);
              const selected =
                (el as HTMLElement).getAttribute?.("aria-selected") === "true" ||
                /selected|checked|active/i.test((el as HTMLElement).className?.toString() ?? "");
              out.push({ id, name, ...(selected ? { selected: true } : {}) });
            }
          }
        }
        return out.slice(0, 24);
      }, cap.pickerOption);
      if (options.length > 0) {
        report.models = options;
        report.modelsMethod = "dom";
      }
    } catch {
      // picker unreadable — stays "none"
    }
  }

  // 2b. Toggle-driven abilities (e.g. DeepSeek DeepThink/Search) — switches
  //     that reveal account-specific capabilities. Each read is guarded.
  const abilityToggles = cap.abilityToggles ?? [];
  if (abilityToggles.length) {
    try {
      const reads = await opts.page.evaluate((toggles) => {
        return toggles.map((t) => {
          const els = [...document.querySelectorAll(t.selector)];
          const el = els.find((e) =>
            ((e as HTMLElement).innerText || "").toLowerCase().includes(t.label.toLowerCase())
          );
          if (!el) return { id: t.id, present: false, on: false };
          const cls = ((el as HTMLElement).className || "").toString();
          const aria = el.getAttribute?.("aria-pressed");
          return {
            id: t.id,
            present: true,
            on: t.selectedClass ? cls.includes(t.selectedClass) : aria === "true",
          };
        });
      }, abilityToggles as Array<{ id: string; selector: string; label: string; selectedClass?: string }>);
      const abilities: AbilityToggle[] = reads
        .map((r, i) => ({ label: abilityToggles[i]?.label ?? r.id, on: r.on, present: r.present, id: r.id }))
        .slice(0, 12);
      if (abilities.some((a) => a.present)) {
        report.abilities = abilities;
        report.abilitiesMethod = "dom";
      }
    } catch {
      // toggle read failed — abilities stay absent
    }
  }

  // 3. Restrictions — scan visible text once.
  if (cap.restrictionMarkers?.length) {
    try {
      const text = await opts.page.evaluate(() => (document.body?.innerText ?? "").slice(0, 40000));
      report.restrictions = matchRestrictionMarkers(text, cap.restrictionMarkers);
    } catch {
      // page gone — restrictions stay []
    }
  }

  report.ok =
    report.tier.method !== "unknown" ||
    report.models.length > 0 ||
    report.modelsMethod !== "none" ||
    (report.abilities?.some((a) => a.present) ?? false);
  if (!report.ok) report.reason = "nothing readable with the current probe selectors";
  return report;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}