import { strict as assert } from "node:assert";
import { describe, it, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveProfile,
  resolvePackagedProfile,
  resolvePackagedProfileFile,
  isDriveableChatProfile,
} from "../src/profile/profile.js";
import {
  defaultChatSurface,
  buildRegistryPackages,
} from "../src/prompt/registry.js";

// GOAL 48 pins for the packaged-profile RUNNING seam: the installed
// capabilities/<site>/profile.json that http.ts's /capability fallbacks and
// the CLI packaged branch actually run now passes the SAME truth-gate class
// as the GOAL-47 override seam — wrong-typed composer/answer/send and
// per-entry unparseable selectors fail LOUD at load, naming the file + the
// exact offending field/entry, never a late duckduckgo-style
// `answer.join`/`composer[0]` TypeError inside a runner. The 33-profile
// audit's well-typed absent/null/empty/host-keyed-object forms pass. All
// node-only — no browser, no network, no driver.

const CAPABILITIES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "capabilities");

function clearEnv() {
  delete process.env.UI2API_AI_SITE;
}

function writeJson(root: string, rel: string, body: unknown): string {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
  return file;
}

describe("packaged-profile running seam (GOAL 48 gate)", () => {
  afterEach(clearEnv);

  const dirs: string[] = [];
  function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "u2a-packaged-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("(a) malformed packaged file through the /capability fallback seam fails LOUD — composer string naming the file + entry (the GOAL-47 message shape)", () => {
    // The GOAL 48 fixture shape: id=poe, composer "textarea" string, send
    // "keyEnter", answer a prose string — resolvePackagedProfileFile is the
    // exact loader http.ts's :1011-1016 packaged-JSON fallbacks call.
    const file = writeJson(tmpDir(), "malformed/profile.json", {
      id: "poe",
      name: "Poe",
      url: "https://poe.com",
      composer: "textarea",
      send: "keyEnter",
      answer: "here is a prose answer string",
    });
    assert.throws(
      () => resolvePackagedProfileFile(file),
      (e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        return (
          m.includes(file) &&
          /composer\[0\]/.test(m) &&
          m.includes('"textarea"') &&
          /is not a runnable selector/.test(m) &&
          /expected a string\[\] of CSS selectors/.test(m)
        );
      }
    );
  });

  it("(b) prose answer + string send in a packaged file also fail LOUD, naming the exact field/entry", () => {
    const answerFile = writeJson(tmpDir(), "prose-answer/profile.json", {
      id: "poe",
      url: "https://poe.com",
      composer: ["textarea"],
      send: { kind: "keyEnter" },
      answer: "UNVERIFIED-SCAFFOLD — no DOM class proven; confirm on first live capture",
    });
    assert.throws(
      () => resolvePackagedProfileFile(answerFile),
      (e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        return (
          m.includes(answerFile) &&
          /answer\[0\]/.test(m) &&
          m.includes('"UNVERIFIED-SCAFFOLD — no DOM class proven; confirm on first live capture"') &&
          /is not a runnable selector/.test(m)
        );
      }
    );
    // Wrong-typed send — never a silent Enter-press fallback.
    const sendFile = writeJson(tmpDir(), "string-send/profile.json", {
      id: "poe",
      url: "https://poe.com",
      composer: ["textarea"],
      send: "keyEnter",
      answer: ["[class*='answer']"],
    });
    assert.throws(
      () => resolvePackagedProfileFile(sendFile),
      (e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        return (
          m.includes(sendFile) &&
          /send must be a SendStrategy object/.test(m) &&
          m.includes('"keyEnter"')
        );
      }
    );
  });

  it("(c) capability-only regression: empty/absent/null/object forms still resolve permissively through the gated loader", () => {
    // The GOAL 47 pins (:151-161) stay on the (strict) override seam unused
    // here — these re-pin the PACKAGED seam through the now-gated loader:
    // well-typed empty composer/answer (youtube/gmail/tinycms), null send
    // (tinycms), absent composer+send (doubao), host-keyed object composer/
    // answer (chatglm), null composer/answer (adapta) all pass the gate.
    const youtube = resolvePackagedProfileFile("capabilities/youtube/profile.json");
    assert.equal(youtube.id, "youtube");
    assert.deepEqual(youtube.composer, []);
    const gmail = resolvePackagedProfileFile("capabilities/gmail/profile.json");
    assert.equal(gmail.id, "gmail");
    const tinycms = resolvePackagedProfileFile("capabilities/tinycms/profile.json");
    assert.equal(tinycms.id, "tinycms");
    assert.equal(tinycms.send as unknown, null); // null send — absent form, passes
    const doubao = resolvePackagedProfileFile("capabilities/doubao/profile.json");
    assert.equal(doubao.id, "doubao");
    assert.equal(doubao.send as unknown, undefined); // no send key at all — passes
    const chatglm = resolvePackagedProfileFile("capabilities/chatglm/profile.json");
    assert.equal(chatglm.id, "chatglm");
    // host-keyed object composer/answer ({"chatglm.cn": [...], "chat.z.ai": [...]})
    // — the well-typed object form the audit allows — passes the gate.
    assert.ok(
      typeof chatglm.composer === "object" && chatglm.composer !== null && !Array.isArray(chatglm.composer),
      "chatglm composer must stay the object form"
    );
    const adapta = resolvePackagedProfileFile("capabilities/adapta/profile.json");
    assert.equal(adapta.id, "adapta");
    // Real chat shapes keep resolving to the same driveable shape.
    const deepseek = resolvePackagedProfile("deepseek");
    assert.ok(deepseek && deepseek.composer.length > 0 && deepseek.answer.length > 0);
    const ddg = resolvePackagedProfile("duckduckgo");
    assert.ok(ddg && ddg.composer.length === 4 && ddg.answer.length === 1);
  });

  it("(d) CLI packaged branch: resolveProfile(<malformed-packaged-id>) fails LOUD pre-driver with the named file + field", () => {
    // A test-only packaged dir under src/capabilities/ (the src-layout
    // candidate packagedProfilePath also searches; manifest.json-less so no
    // other suite consumer lists it as an installed package).
    const repoRoot = dirname(dirname(CAPABILITIES_DIR));
    const fixtureRel = "src/capabilities/u2a-goal48-malformed/profile.json";
    const fixture = join(repoRoot, fixtureRel);
    writeJson(repoRoot, fixtureRel, {
      id: "u2a-goal48-malformed",
      name: "Malformed fixture",
      url: "https://example.com",
      composer: "textarea",
      send: "keyEnter",
      answer: "prose",
    });
    try {
      const m = (() => {
        try {
          resolveProfile("u2a-goal48-malformed");
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      })();
      assert.ok(m, "expected a loud throw from resolveProfile on the malformed packaged id");
      assert.ok(m.includes(fixture), `names the file: ${m}`);
      assert.ok(/composer\[0\]/.test(m) && m.includes('"textarea"'), `names the field/entry: ${m}`);
      assert.ok(/is not a runnable selector/.test(m), `GOAL-47 message shape: ${m}`);
    } finally {
      rmSync(dirname(fixture), { recursive: true, force: true });
    }
    // The well-formed packaged chat id still resolves through the same branch
    // (poe's real packaged profile is a valid chat shape).
    assert.equal(resolveProfile("poe").id, "poe");
  });

  it("(e) 33-profile audit: every capabilities/*/profile.json passes the gate — /registry + chat surface membership stays byte-deterministic", () => {
    // EVERY installed packaged profile must resolve through the now-gated
    // loader (before GOAL 48 all 33 resolved permissively; a gate false-
    // positive would drop a package from /registry's packages[] — the audit
    // walks the same dir the registry enumerates).
    const profiles = readdirSync(CAPABILITIES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(CAPABILITIES_DIR, d.name, "profile.json")))
      .map((d) => d.name)
      .sort();
    assert.equal(profiles.length, 33, `expected the 33 packaged profiles, got ${profiles.length}`);
    for (const id of profiles) {
      const path = join(CAPABILITIES_DIR, id, "profile.json");
      let p;
      try {
        p = resolvePackagedProfileFile(path);
      } catch (e) {
        assert.fail(`${id}: packaged profile fails the GOAL 48 gate — ${e instanceof Error ? e.message : String(e)}`);
      }
      assert.equal(p.id, id, `${id}: packaged id matches the dir name`);
      // The /registry path (resolvePackagedProfile) must likewise never drop
      // a real package to null — malformed-only exclusion.
      assert.ok(resolvePackagedProfile(id), `${id}: /registry path must resolve`);
    }
    // Chat-surface membership: every packaged id defaultChatSurface() surfaces
    // is one of the 33 and is driveable — the gate must not have flipped it.
    for (const entry of defaultChatSurface()) {
      if (!entry.packaged) continue;
      assert.ok(profiles.includes(entry.id), `${entry.id}: chat-surface packaged id must be on disk`);
      assert.ok(isDriveableChatProfile(entry.profile), `${entry.id}: chat-surface entry stays driveable`);
    }
    // /registry package count: all driveable chat packages + capability-only
    // packages carry honest status/tools; the surface builds without throwing.
    const reg = buildRegistryPackages();
    assert.ok(Array.isArray(reg) && reg.length > 0);
    for (const pkg of reg) {
      if (pkg.chat) assert.ok(defaultChatSurface().some((e) => e.id === pkg.id), `${pkg.id}: registry chat claims only surfaced ids`);
    }
    // The gate is NOT a no-op: the same malformed shapes the audit walk above
    // would refuse are refused (sanity against a validator that passes everything).
    const junk = writeJson(tmpDir(), "junk/profile.json", {
      id: "junk",
      composer: 42,
      send: [],
      answer: { host: 7 },
    });
    assert.throws(() => resolvePackagedProfileFile(junk), /composer\[0\]/);
  });
});