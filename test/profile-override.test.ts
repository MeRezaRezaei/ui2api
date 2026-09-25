import { strict as assert } from "node:assert";
import { describe, it, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveProfile,
  resolveProfileWithOverride,
  resolvePackagedProfile,
  resolvePackagedProfileFile,
} from "../src/profile/profile.js";

// GOAL 47 pins for the --profile FILE override seam: the override file runs the
// SAME GOAL-32 truth gate packaged profiles pass for /registry surfacing
// (isParseableSelector + isChatShapedProfile) plus an explicit send shape
// check, and every failure is LOUD at load, naming the file + the exact
// offending field/entry. All node-only — no browser, no network, no driver.

function clearEnv() {
  delete process.env.UI2API_AI_SITE;
}

function writeOverride(dir: string, name: string, body: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(body));
  return file;
}

describe("profile override seam (GOAL 47 truth gate)", () => {
  afterEach(clearEnv);

  const dirs: string[] = [];
  function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "u2a-override-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("(a) typo'd override key fails LOUD at load — no silent drop", () => {
    const file = writeOverride(tmpDir(), "typo-composr.json", { id: "gemini", composr: ["#x"] });
    assert.throws(
      () => resolveProfile(file),
      (e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        return (
          m.includes(file) &&
          /unknown key "composr"/.test(m) &&
          /typo of "composer"\?/.test(m)
        );
      }
    );
  });

  it("non-typo extra keys stay carried (packaged metadata class — not a typo of a real field)", () => {
    const file = writeOverride(tmpDir(), "metadata-key.json", {
      id: "gemini",
      selectorNotes: ["unused metadata"],
    });
    const p = resolveProfile(file);
    assert.equal(p.id, "gemini");
    assert.deepEqual(p.composer, [
      'div[contenteditable="true"][role="textbox"]',
      ".ql-editor",
      "textarea",
    ]);
  });

  it("(b) wrong-typed string composer fails LOUD, naming the field and the value", () => {
    const file = writeOverride(tmpDir(), "string-composer.json", {
      id: "gemini",
      composer: "#custom",
    });
    assert.throws(
      () => resolveProfile(file),
      (e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        return (
          m.includes(file) &&
          /composer\[0\]/.test(m) &&
          m.includes('"#custom"') &&
          /is not a runnable selector/.test(m) &&
          /expected a string\[\] of CSS selectors/.test(m)
        );
      }
    );
  });

  it("(c) prose answer entry fails LOUD, naming the exact array index (t3chat class)", () => {
    // The genuine class that "passed the old arrays gate and threw a CSS
    // SyntaxError at send time" (t3chat note, GOAL 32): prose rows carrying
    // CSS-breaking punctuation (";" / "(") — the engine parser rejects them.
    const file = writeOverride(tmpDir(), "prose-answer.json", {
      id: "gemini",
      answer: ["UNVERIFIED-SCAFFOLD — no DOM class proven; confirm on first live capture"],
    });
    assert.throws(
      () => resolveProfile(file),
      (e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        return (
          m.includes(file) &&
          /answer\[0\]/.test(m) &&
          m.includes('"UNVERIFIED-SCAFFOLD — no DOM class proven; confirm on first live capture"') &&
          /is not a runnable selector/.test(m)
        );
      }
    );
  });

  it("(d) wrong-typed send (bare string) fails LOUD — never a silent Enter-press fallback", () => {
    const file = writeOverride(tmpDir(), "string-send.json", { id: "gemini", send: "#send" });
    assert.throws(
      () => resolveProfile(file),
      (e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        return (
          m.includes(file) &&
          /send must be a SendStrategy object/.test(m) &&
          m.includes('"#send"')
        );
      }
    );
  });

  it("(d) wrong-typed send ([]) fails LOUD, naming the file", () => {
    const file = writeOverride(tmpDir(), "array-send.json", { id: "gemini", send: [] });
    assert.throws(
      () => resolveProfile(file),
      (e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        return m.includes(file) && /send must be a SendStrategy object/.test(m) && m.includes("[]");
      }
    );
  });

  it("(e) thin-slice partial override with valid selectors still resolves and inherits the builtin", () => {
    const file = writeOverride(tmpDir(), "thin-slice.json", { id: "gemini", composer: ["#custom-composer"] });
    const p = resolveProfile(file);
    assert.equal(p.id, "gemini");
    assert.deepEqual(p.composer, ["#custom-composer"]);
    // Unspecified fields fall back to the gemini built-in — the merged profile
    // passes the gate because the inherited selectors/url/send are valid.
    assert.ok(Array.isArray(p.answer) && p.answer.length > 0);
    assert.equal(p.send.kind, "keyEnter");
    assert.ok(p.url.startsWith("https://"));
  });

  it("(f) packaged path unchanged: non-chat capability packages still resolve permissively", () => {
    // /registry + /capability/<id> build their surface from packaged
    // profile.json — capability-only packages (empty composer/answer) keep
    // resolving through the packaged seam…
    const youtube = resolvePackagedProfile("youtube");
    assert.ok(youtube && youtube.id === "youtube" && Array.isArray(youtube.composer));
    assert.ok(resolvePackagedProfile("gmail")?.id === "gmail");
    // …and the http.ts packaged-JSON fallback seam (same permissive loader)…
    assert.equal(resolvePackagedProfileFile("capabilities/youtube/profile.json").id, "youtube");
    assert.equal(resolvePackagedProfileFile("capabilities/tinycms/profile.json").id, "tinycms");
    // …while chat-shaped packaged profiles resolve to the same driveable shape.
    const deepseek = resolvePackagedProfile("deepseek");
    assert.ok(deepseek && deepseek.composer.length > 0 && deepseek.answer.length > 0);
    // The user override seam (--profile FILE) is the STRICT one: the same
    // packaged file path through resolveProfile is refused when it is not a
    // driveable chat profile — a prompt can never aim at a capability surface.
    assert.throws(
      () => resolveProfile("capabilities/youtube/profile.json"),
      /is not a driveable chat profile/
    );
  });

  it("(g) GOAL 57: capability-block gate on the override seam — wrong-typed restrictionMarkers/picker/toggle entries refuse LOUD naming file + field, absent capability + well-typed GOAL 55 shape pass", () => {
    // GOAL 56 put the capability shape gate on the packaged seam; the override
    // seam (--profile FILE / UI2API_AI_SITE) accepts `capability` as a key but
    // never validated it — a string restrictionMarkers merged into a builtin
    // profile and then crashed matchRestrictionMarkers's for…of at answer time.
    const dir = mkdtempSync(join(tmpdir(), "u2a-goal57-"));
    try {
      const base = { id: "gemini" };

      let f = writeOverride(dir, "g1.json", { ...base, capability: { restrictionMarkers: "rate limit" } });
      assert.throws(() => resolveProfile(f), /capability\.restrictionMarkers must be an array/, "string restrictionMarkers must refuse");

      f = writeOverride(dir, "g2.json", { ...base, capability: { restrictionMarkers: [{ kind: "premium", patterns: ["x"] }] } });
      assert.throws(() => resolveProfile(f), /restrictionMarkers\[0\]\.kind must be "upgrade" \| "limit" \| "login"/, "bogus kind must refuse");

      f = writeOverride(dir, "g3.json", { ...base, capability: { restrictionMarkers: [{ kind: "limit", patterns: [] }] } });
      assert.throws(() => resolveProfile(f), /restrictionMarkers\[0\]\.patterns must be a non-empty string\[\]/, "empty patterns must refuse");

      f = writeOverride(dir, "g4.json", { ...base, capability: { pickerOption: "button" } });
      assert.throws(() => resolveProfile(f), /capability\.pickerOption must be a string\[\]/, "scalar pickerOption must refuse");

      f = writeOverride(dir, "g5.json", { ...base, capability: { tierSelectors: ["not a selector (prose)"] } });
      assert.throws(() => resolveProfile(f), /capability\.tierSelectors\[0\].*not a runnable selector/, "prose tierSelectors must refuse");

      f = writeOverride(dir, "g6.json", { ...base, capability: { abilityToggles: [{ selector: "button", label: "Web" }] } });
      assert.throws(() => resolveProfile(f), /abilityToggles\[0\]\.id must be a non-empty string/, "toggle without id must refuse");

      f = writeOverride(dir, "g7.json", { ...base, capability: "nope" });
      assert.throws(() => resolveProfile(f), /capability must be an object/, "scalar capability must refuse");

      // Absent capability + well-typed GOAL 55 shape still resolve.
      f = writeOverride(dir, "g8.json", { ...base, dismiss: ["button.close"] });
      assert.equal(resolveProfile(f).id, "gemini", "absent capability passes");
      f = writeOverride(dir, "g9.json", {
        ...base,
        capability: {
          restrictionMarkers: [{ kind: "limit", patterns: ["rate limit"] }],
          pickerOption: ["button.model"],
          abilityToggles: [{ id: "web", selector: "button[data-toggle]", label: "Web" }],
        },
      });
      assert.equal(resolveProfile(f).id, "gemini", "well-typed GOAL 55 capability override passes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // GOAL 62 (2026-09-25): --site X --profile FILE never silently drops the
  // tuning document. The old `flags.site ?? flags.profile` discarded the file
  // entirely when both were given (PROVEN: --site gemini + tune.json with
  // deepseek selectors resolved plain gemini). resolveProfileWithOverride
  // enforces id AGREEMENT: a file whose id mismatches the requested site fails
  // LOUD naming both sides; absent file.id tunes the requested site.
  it("GOAL62(a): --site + --profile with a MISMATCHED file id refuses LOUD naming both sides", () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-goal62-"));
    try {
      const tune = join(dir, "mismatch.json");
      writeFileSync(tune, JSON.stringify({ id: "deepseek", composer: ["textarea[data-sentinel]"] }));
      assert.throws(
        () => resolveProfileWithOverride("gemini", tune),
        /profile file .* id "deepseek" does not match --site gemini/,
        "mismatched file id must fail LOUD (never a silent wrong-site tune)"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GOAL62(b): --site + --profile with a MATCHED file id applies the file's fields over the site base", () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-goal62-"));
    try {
      const tune = join(dir, "match.json");
      writeFileSync(tune, JSON.stringify({ id: "gemini", composer: ["textarea[data-sentinel]"] }));
      const p = resolveProfileWithOverride("gemini", tune);
      assert.equal(p.id, "gemini");
      assert.equal(p.composer?.[0], "textarea[data-sentinel]", "file composer applies (the document is a tuning, not a site picker)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GOAL62(c): absent file.id tunes the requested site; --profile alone keeps file-id-picks-base semantics", () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-goal62-"));
    try {
      const tuning = join(dir, "tuning.json");
      writeFileSync(tuning, JSON.stringify({ composer: ["input[data-x]"] }));
      const p = resolveProfileWithOverride("gemini", tuning);
      assert.equal(p.id, "gemini", "absent id = tuning the requested site");
      assert.equal(p.composer?.[0], "input[data-x]");

      const standalone = join(dir, "standalone.json");
      writeFileSync(standalone, JSON.stringify({ id: "kimi", composer: ["textarea[data-k]"] }));
      const p2 = resolveProfile(standalone);
      assert.equal(p2.id, "kimi", "--profile alone: file id picks the base (unchanged)");
      assert.equal(p2.composer?.[0], "textarea[data-k]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});