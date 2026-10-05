import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildRegistryPackages,
  capabilityInputSchema,
  bareCapabilityId,
  defaultChatSurface,
  listInstalledPackageIds,
  resolveDataDir,
  validManifestCapability,
  readModelVerification,
  honestPackageStatus,
  chatSurfaceStatus,
} from "../src/prompt/registry.js";
import { listAccounts } from "../src/runtime/session-store.js";
import { resolvePackagedProfile } from "../src/profile/profile.js";

/** True when the real on-box vault file exists for the host (data/sessions/ is gitignored). */
function vaultPresent(host: string): boolean {
  return existsSync(join(resolveDataDir(), "sessions", host, "accounts.json"));
}

describe("prompt registry", () => {
  // GOAL 139: this assertion INVERTED, deliberately, and the reason matters.
  //
  // It used to assert that `thinking` and `search` appear as boolean args
  // because the manifest description mentions them. That was the registry
  // advertising capabilities the daemon CANNOT HONOR: measured across every
  // runner in src/capabilities/, `args.thinking`, `args.search` and
  // `args.new_chat` have ZERO reads. A consumer generating a client from this
  // schema would offer a toggle that silently does nothing.
  //
  // Keying a schema on description PROSE is guessing by another name. The way to
  // declare a toggle is the package's own `inputSchema` (derived from the runner
  // that reads it), so the contract follows the implementation.
  it("derives a chat tool schema with prompt required and NO unimplemented toggles", () => {
    const s = capabilityInputSchema(
      "deepseek",
      "deepseek_chat",
      "ui-path",
      "composer + thinking toggle + search toggle on the wire"
    );
    assert.equal(s.type, "object");
    assert.deepEqual(s.required, ["prompt"]);
    assert.ok(s.properties.prompt);
    assert.ok(s.properties.newChat, "newChat is read by the runners, so it is advertised");
    assert.ok(
      !s.properties.thinking && !s.properties.search,
      "a toggle no runner reads must NOT be advertised — that is a promise the daemon cannot keep"
    );
  });

  it("derives toggle and read schemas for non-chat capabilities", () => {
    const toggle = capabilityInputSchema("deepseek", "deepseek_web_search", "ui-path", "flip Search");
    assert.equal(toggle.required.length, 0);
    assert.ok(toggle.properties.state);
    const read = capabilityInputSchema("deepseek", "deepseek_list_conversations", "ui-path", "sidebar");
    assert.ok(read.properties.limit, "read capabilities expose a limit hint");
  });

  it("strips the site prefix from capability ids for tool names", () => {
    assert.equal(bareCapabilityId("deepseek", "deepseek_chat"), "chat");
    assert.equal(bareCapabilityId("deepseek", "deepseek_list_conversations"), "list_conversations");
    assert.equal(bareCapabilityId("kimi", "model_list"), "model_list");
    // Hyphenated site, underscore-prefixed capability ids (tencent-aistudio).
    assert.equal(bareCapabilityId("tencent-aistudio", "tencent_aistudio_chat"), "chat");
  });

  it("builds registry packages from installed capability packages (served sites only)", () => {
    const packages = buildRegistryPackages();
    const surfaceIds = new Set(defaultChatSurface().map((e) => e.id));
    // The MEASURED gate, read from the same record the registry build reads.
    const answerableIds = new Set(readModelVerification().answers);
    assert.ok(Array.isArray(packages));
    // ALL-33 regression: every installed package with a packaged profile is
    // listed — /registry IS the package registry; hiding packages is not the
    // fix, the chat field's truth is (GOAL 34).
    assert.equal(
      packages.length,
      listInstalledPackageIds().length,
      "registry must list every installed package (all-33 stays listed)"
    );
    for (const pkg of packages) {
      // (a) chat-surface ids keep the chat claim (chat.model === id);
      // (b) everything else carries NO chat claim at all — status/tools/
      //     accounts are kept, chat is not advertised for /v1-unservable ids.
      // Three states, not two (GOAL 159). /registry is the CATALOGUE, so a
      // package is never hidden from it; what changes is the chat PROMISE.
      //   advertised  → `chat` present, `chat` === id  (measured answering)
      //   withheld    → NO `chat` key + `chatWithheld` naming class and reason
      //   not on the surface → no `chat` key and nothing to say (GOAL 34)
      if (surfaceIds.has(pkg.id) && answerableIds.has(pkg.id)) {
        assert.equal(pkg.chat?.model, pkg.id, `${pkg.id}: an advertised chat id must carry chat.model === id`);
        assert.equal(pkg.chatWithheld, undefined, `${pkg.id}: advertised AND withheld at once — the catalogue contradicts itself`);
      } else if (surfaceIds.has(pkg.id)) {
        assert.equal(pkg.chat, undefined, `${pkg.id}: addressable but not measured answering — the chat claim must be withheld`);
        assert.ok(
          pkg.chatWithheld !== undefined && pkg.chatWithheld.reason.trim().length > 0,
          `${pkg.id}: the chat claim is withheld with no named reason — the catalogue cannot explain its own omission`,
        );
      } else {
        assert.equal(pkg.chat, undefined, `${pkg.id}: non-servable package must NOT claim chat (GOAL 34)`);
        // The WIRE shape is what consumers read: the emitted JSON has no chat
        // key at all — consumers key on pkg.chat?.model and must treat absence
        // as "no chat" (never materialize a chat provider for it).
        const wire = JSON.parse(JSON.stringify(pkg)) as { chat?: unknown };
        assert.ok(!("chat" in wire), `${pkg.id}: emitted registry package must not carry a chat key`);
      }
      assert.equal(typeof pkg.name, "string");
      assert.ok(Array.isArray(pkg.tools));
      assert.equal(typeof pkg.status, "string");
      for (const tool of pkg.tools) {
        assert.ok(tool.name.startsWith(`${pkg.id}_`), `tool ${tool.name} namespaced by site`);
        assert.equal(typeof tool.id, "string", `tool ${tool.name} carries raw daemon capability id`);
        assert.equal(tool.inputSchema.type, "object");
        // The map contract distinguishes the two work types — driving the site's
        // own real UI (ui-path) versus calling the site's own JS function
        // (js-function) — and carries the reload policy so every language map
        // reflects "after each successful action the only thing we need to do
        // is to refresh the page".
        assert.ok(tool.workType === "ui-path" || tool.workType === "js-function");
        assert.equal(tool.reloadAfterSuccess, true);
      }
    }
  });

  it("registry chat.model set == /v1 servable surface (same gate, no hardcoded id list)", () => {
    const packages = buildRegistryPackages();
    // The gate the daemon actually serves from: the default promptd path builds
    // its /v1 profilesById allow-list from defaultChatProfiles() ==
    // defaultChatSurface() (http.ts), and openai.ts profileById() refuses
    // anything outside it with 404 unknown_model. No hardcoded 23/10 here —
    // the parity is derived from the same gate both sides use.
    const surfaceIds = new Set(defaultChatSurface().map((e) => e.id));
    const installed = new Set(listInstalledPackageIds());
    const byId = new Map(packages.map((p) => [p.id, p]));
    // direction 1: every registry chat claim is /v1-servable AND measured
    // answering. Both, not either — the chat key is a PROMISE, and a claim the
    // measurement record does not back is the claim GOAL 159 withdrew.
    const answerable = new Set(readModelVerification().answers);
    for (const pkg of packages) {
      if (pkg.chat) {
        assert.ok(surfaceIds.has(pkg.id), `${pkg.id}: registry chat claim must be on the /v1 servable surface`);
        assert.ok(
          answerable.has(pkg.id),
          `${pkg.id}: registry advertises a chat claim the measurement record does not call ANSWERS — a consumer would build a provider that cannot answer`,
        );
        assert.equal(pkg.chat.model, pkg.id, `${pkg.id}: chat.model must be the site id /v1 accepts`);
      }
    }
    // direction 2: every MEASURED-answering id that is an installed package
    // carries the registry chat claim — a promised model is never left
    // chat-less. A servable-but-unmeasured id carries NO claim and a NAMED
    // `chatWithheld` instead, which direction 3 checks.
    for (const id of surfaceIds) {
      if (installed.has(id) && answerable.has(id)) {
        const pkg = byId.get(id);
        assert.ok(pkg, `${id}: a measured-answering surfaced id must be listed on /registry`);
        assert.ok(pkg.chat && pkg.chat.model === id, `${id}: a measured-answering id must carry chat.model on /registry`);
      }
    }
    // direction 3: an installed servable id that is NOT measured answering is
    // withheld in WORDS, never silently dropped — the catalogue must be able to
    // explain its own omission.
    const withheldIds = [...surfaceIds].filter((id) => installed.has(id) && !answerable.has(id));
    assert.ok(withheldIds.length > 0, "anti-vacuity: expected installed chat ids the record does not call ANSWERS");
    for (const id of withheldIds) {
      const pkg = byId.get(id);
      assert.ok(pkg, `${id}: withheld from the chat promise but also missing from /registry`);
      assert.equal(pkg.chat, undefined, `${id}: not measured answering, so the chat claim must be withheld`);
      assert.ok(
        pkg.chatWithheld && pkg.chatWithheld.reason.trim().length > 20,
        `${id}: the withheld chat claim carries no named reason`,
      );
    }
  });

  it("refuses chat claims for exactly the /v1-unservable packages (GOAL 34 named 10, GOAL 147 added 1)", () => {
    const packages = buildRegistryPackages();
    const surfaceIds = new Set(defaultChatSurface().map((e) => e.id));
    const refused = listInstalledPackageIds().filter((id) => !surfaceIds.has(id)).sort();
    // The 11 ids named here (derived above from the gate for the general rule;
    // this literal pin forces a conscious test+docs update the day any of them
    // becomes driveable via url/selectors + a live round-trip).
    //
    // GOAL 147: `google-ai-search` joined this list because the BUILTIN loop of
    // defaultChatSurface() used to admit the whole catalog unconditionally,
    // skipping the isDriveableChatProfile gate the packaged loop already ran.
    // Its profile is composer-less (isChatShapedProfile: not a chat shape), its
    // manifest declares no `*_chat` capability, and its runner is a
    // loginGated short-circuit with no chat implementation — so /v1/models was
    // advertising a chat model with no chat tool behind it.
    assert.deepEqual(refused, [
      "adapta",
      "araprat",
      "chatglm",
      "conol",
      "doubao",
      "gmail",
      "google-ai-search",
      "tinycms",
      "xiaomimimo",
      "youtube",
      "zenmux",
    ]);
    for (const id of refused) {
      const pkg = packages.find((p) => p.id === id);
      assert.ok(pkg, `${id}: refused id must still be LISTED on /registry (hiding is not the fix)`);
      assert.equal(pkg.chat, undefined, `${id}: refused id carries no chat claim`);
      assert.ok(Array.isArray(pkg.tools), `${id}: refused id keeps its tools`);
    }
  });

  it("exposes a machine-checkable verified record (false or full {since,evidence,via})", () => {
    const packages = buildRegistryPackages();
    // Every package carries the field; a truthy value is always a full record.
    for (const pkg of packages) {
      assert.ok("verified" in pkg, `${pkg.id}: registry package must carry a verified field`);
      if (pkg.verified !== false) {
        assert.equal(typeof pkg.verified.since, "string");
        assert.equal(typeof pkg.verified.evidence, "string");
        assert.equal(typeof pkg.verified.via, "string");
        assert.ok(pkg.verified.since.length > 0 && pkg.verified.evidence.length > 0 && pkg.verified.via.length > 0, `${pkg.id}: verified record must be non-empty`);
      }
    }
    // The live-verified packages from folds #5/#6 (and earlier) must be marked.
    const byId = new Map(packages.map((p) => [p.id, p]));
    for (const id of ["deepseek", "kimi", "gemini"]) {
      const p = byId.get(id);
      assert.ok(p, `expected package ${id} in registry`);
      assert.notEqual(p!.verified, false, `${id} should carry a verified record (live round-trip recorded)`);
    }
    // A scaffold-only package with no metadata stays unverified.
    const unver = packages.filter((p) => p.verified === false);
    assert.ok(unver.length > 0, "some packages are honestly NOT verified");
  });

  // ── STATUS PROVENANCE: an EARNED `verified` must be BACKED by a record ──────
  //
  // MEASURED defect: `buildRegistryPackages()` read `metadata.json`'s `status`
  // as a bare string and republished it verbatim, so a package could CLAIM
  // `status: "verified"` with no `verified` record behind it. `/registry` is the
  // ONLY info source an external consumer has and it publishes `status` right
  // next to the `verified` RECEIPT field, so an unearned claim was
  // indistinguishable on the wire from an earned one — a fabricated capability
  // claim. The same file's `packageStatusOf()` (what `/sites` reads) had always
  // required the record, so the two surfaces gave opposite answers for one
  // package, and the dishonest one was the one every consumer reads.
  //
  // The fixture half is what pins the RULE, on the exported resolver that
  // `buildRegistryPackages()` itself calls (so a fixture cannot pass while the
  // registry does something else). The corpus half is what pins the BLAST
  // RADIUS: it fails the day a REAL package grows an unearned `verified`, which
  // is the exact drift class this gate exists for.
  it("an unearned `verified` status degrades to `unverified-candidate` (no record -> no earned claim)", () => {
    // The hostile fixture: claims the earned classification and carries nothing.
    const liar = honestPackageStatus({ status: "verified" });
    assert.equal(liar.status, "unverified-candidate", "status:'verified' with NO record must not be published as earned");
    assert.equal(liar.verified, false, "…and no receipt is invented for it");

    // A record that is present but incomplete is the same defect in a subtler
    // shape, so every field the RegistryVerified shape names is exercised.
    for (const bad of [
      { since: "2026-09-19", evidence: "proof 13965" }, // no `via`
      { since: "2026-09-19", via: "headed Xvfb" }, // no `evidence`
      { evidence: "proof 13965", via: "headed Xvfb" }, // no `since`
      { since: "", evidence: "proof 13965", via: "headed Xvfb" }, // empty is not a record
      { since: "   ", evidence: "proof 13965", via: "headed Xvfb" },
      { since: 2026, evidence: "proof 13965", via: "headed Xvfb" }, // wrong type
      true, // the boolean a manifest is allowed to write
      "verified", // a bare string
      null,
    ]) {
      const r = honestPackageStatus({ status: "verified", verified: bad });
      assert.equal(r.status, "unverified-candidate", `incomplete record ${JSON.stringify(bad)} must not buy an earned status`);
      assert.equal(r.verified, false, `incomplete record ${JSON.stringify(bad)} must not be published as a receipt`);
    }

    // A GENUINELY verified package still passes: the gate is not "demote all".
    const real = honestPackageStatus({
      status: "verified",
      verified: { since: "2026-09-19", evidence: "proof PASS 13965", via: "headed Chrome on Xvfb :99 replaying a session.lock.json capture", scope: "chat" },
    });
    assert.equal(real.status, "verified", "a complete record MUST still surface as `verified` — otherwise the gate is an over-correction");
    assert.ok(real.verified !== false, "the receipt is published alongside the claim it backs");
    assert.equal(real.verified.since, "2026-09-19", "the date is the disclosure a consumer branches on, so it survives");
    assert.ok(real.verified.evidence.length > 0 && real.verified.via.length > 0, "…and it is complete");

    // An honest LIMITATION is not an earned claim, so gating it would hide a
    // blocker behind a softer word — `dormant`/`dead-end` must pass through.
    assert.equal(honestPackageStatus({ status: "dormant" }).status, "dormant");
    assert.equal(honestPackageStatus({ status: "dead-end" }).status, "dead-end");
    // Operator strings that assert nothing are not the earned class either.
    assert.equal(honestPackageStatus({ status: "active" }).status, "active");
    assert.equal(honestPackageStatus({ status: "scaffold" }).status, "scaffold");
    // Absent / malformed metadata is the scaffold case, unchanged.
    assert.equal(honestPackageStatus({}).status, "unknown");
    assert.equal(honestPackageStatus(null).status, "unknown");
    assert.equal(honestPackageStatus("nonsense").status, "unknown");
  });

  it("BLAST RADIUS: no shipped package publishes an unearned `verified` (corpus-wide invariant, not a snapshot)", () => {
    const packages = buildRegistryPackages();
    // The invariant, stated over the REAL corpus. Deliberately NOT a snapshot of
    // today's statuses: a future package legitimately gaining a verified record
    // must keep `verified`, and a future package falsely claiming it must fail
    // here. Only the earned-claim/receipt disagreement is fatal.
    for (const pkg of packages) {
      if (pkg.status === "verified") {
        assert.notEqual(pkg.verified, false, `${pkg.id}: publishes status "verified" with NO verification record — an unearned claim`);
      }
      // And the converse, so the gate cannot be "fixed" by demoting everything:
      // a real receipt still has to be readable off the wire.
      if (pkg.verified !== false) {
        assert.ok(pkg.verified.since.length > 0, `${pkg.id}: a published receipt must carry its date`);
      }
    }
    // The gate must not have demoted the genuinely-verified corpus: the packages
    // whose `metadata.json` carries a complete record keep it. Derived, never
    // hardcoded, so the count cannot rot when a package is added.
    const withRecord = packages.filter((p) => p.verified !== false);
    assert.ok(withRecord.length > 0, "some shipped packages carry a real verification record and must keep it");

    // CROSS-SURFACE AGREEMENT. The defect was two surfaces reading ONE package
    // and disagreeing: `/registry` republished the declared string while
    // `/sites` (via `packageStatusOf`) required the record. Pinning the
    // agreement is what stops that from returning — derived from disk, over
    // every installed id, so it cannot rot when the corpus changes.
    //
    // HONEST LIMIT of this whole file, stated rather than hidden: because NO
    // shipped package ever claimed `status: "verified"`, the corpus invariant
    // above cannot tell a resolver that is consulted from one that is bypassed
    // at the call site — a future edit could re-introduce the raw string read
    // and stay green here. The fixture half pins the RULE; this half pins that
    // the two consumers of one file never diverge. Closing the remaining gap
    // needs `buildRegistryPackages()` to be drivable against a fixture package,
    // and the package root is resolved from `import.meta.url` with no override,
    // so it would mean a new env knob — out of scope for a status-provenance
    // fix, and noted rather than faked.
    const byId = new Map(packages.map((p) => [p.id, p]));
    for (const id of listInstalledPackageIds()) {
      const served = chatSurfaceStatus(id);
      const published = byId.get(id);
      if (!published) continue; // url-less / no packaged profile: /registry does not list it
      // `/sites` reports a CHAT-surface class (builtin, unverified-candidate,
      // dormant, dead-end, verified); `/registry` reports the package's own
      // declared status. They are different vocabularies by design, so the
      // invariant is narrower and exact: an EARNED claim on one surface with no
      // record behind it is a lie, and a record on one surface with no earned
      // claim on the other is a contradiction.
      if (served === "verified") {
        assert.notEqual(published.verified, false, `${id}: /sites says verified but /registry publishes no verification record`);
      }
    }
  });

  it("exposes per-package stored accounts consistent with GET /accounts (vault on disk)", (t) => {
    const packages = buildRegistryPackages();
    const dataDir = resolveDataDir();
    const byId = new Map(packages.map((p) => [p.id, p]));
    for (const pkg of packages) {
      const profile = resolvePackagedProfile(pkg.id);
      if (profile?.url) {
        // url-ful package -> accounts is a REAL array (possibly []), exactly
        // what the vault returns for the SAME host GET /accounts?site= serves
        // (http.ts derives it as new URL(profile.url).host — not manifest url).
        const host = new URL(profile.url).host;
        assert.ok(Array.isArray(pkg.accounts), `${pkg.id}: url-ful package must carry an accounts array`);
        assert.deepEqual(
          pkg.accounts,
          listAccounts(dataDir, host),
          `${pkg.id}: accounts must match the on-disk vault for ${host}`
        );
      } else {
        // url-less package -> field ABSENT (undefined), never an empty array.
        assert.equal(pkg.accounts, undefined, `${pkg.id}: url-less package must omit accounts`);
      }
    }
    // On-box vault today: deepseek + gemini each hold a stored identity; the
    // registry surfaces it. Empty-vault honesty ([]) is exercised by the loop
    // for url-ful hosts with no accounts.json on this box (e.g. kimi's profile
    // host www.kimi.com has none — even though manifest says www.kimi.ai).
    const deepseek = byId.get("deepseek");
    if (!vaultPresent("chat.deepseek.com")) {
      t.skip("no vault for chat.deepseek.com (data/ is gitignored — clean checkout has none) — skipping deepseek vault assert");
    } else {
      assert.ok(deepseek && Array.isArray(deepseek.accounts) && deepseek.accounts.length > 0, "deepseek: stored vault account listed in registry");
    }
    const gemini = byId.get("gemini");
    if (!vaultPresent("gemini.google.com")) {
      t.skip("no vault for gemini.google.com (data/ is gitignored — clean checkout has none) — skipping gemini vault assert");
    } else {
      assert.ok(gemini && Array.isArray(gemini.accounts) && gemini.accounts.length > 0, "gemini: stored vault account listed in registry");
    }
    // url-less fixtures keep the field STRICTLY absent.
    assert.equal(byId.get("chatglm")?.accounts, undefined, "chatglm: no url => no accounts field");
    assert.equal(byId.get("tinycms")?.accounts, undefined, "tinycms: no url => no accounts field");
  });

  // GOAL 61 (2026-09-25): crash-proof registry build — a malformed installed
  // manifest capability entry must never 500 the whole /registry. The filter
  // is the read-seam twin of GOAL 58/59/60 (refuse malformed storage, never
  // crash); malformed entries are EXCLUDED, well-formed entries untouched.
  it("GOAL61(a): validManifestCapability refuses null/primitive/id-less entries, accepts well-formed", () => {
    for (const bad of [null, "garbage", {}, { method: "ui-path" }, { id: "" }, { id: 42 }, { id: "  " }, []]) {
      assert.equal(validManifestCapability(bad), false, `refused: ${JSON.stringify(bad)}`);
    }
    const good = { id: "chat", method: "js-function", description: "d" };
    assert.equal(validManifestCapability(good), true, "well-formed capability entry accepted");
  });

  it("GOAL61(b): the pre-filter map CRASHES on a malformed entry; the filtered map skips it", () => {
    // Typed `unknown[]` on purpose: these are the SHAPE OF THE INPUT the guard
    // exists for — capability entries parsed out of a manifest on disk, i.e.
    // untrusted values of unknown type, which is exactly what the production
    // signature accepts (`c: unknown`). Declaring the literal as its inferred
    // union (`null | {method} | {id}`) instead MISREPRESENTS the fixture: a
    // hostile entry is not statically known to be an object, and TS then cannot
    // apply the `x is ManifestCapability & {id: string}` predicate to the union,
    // silently falls back to the non-narrowing `filter` overload, and leaves
    // `c` possibly-null in the consumer. That is a property of the FIXTURE's
    // declaration, not of the guard: the guard is a real type predicate and it
    // narrows `unknown` correctly (src/prompt/registry.ts:633 filters a
    // `ManifestCapability[]` the same way).
    const malicious: unknown[] = [null, { method: "ui-path" }, { id: "chat", description: "ok" }];
    // The unguarded mapping today's registry used BEFORE GOAL 61:
    const bare = (siteId: string, capabilityId: string): string =>
      capabilityId.startsWith(`${siteId}_`) ? capabilityId.slice(siteId.length + 1) : capabilityId;
    assert.throws(
      () => malicious.map((c: any) => ({ name: bare("site", c.id), id: c.id })),
      TypeError,
      "pre-GOAL-61 mapping throws on a null capability entry (the /registry 500)"
    );
    const safe = malicious.filter(validManifestCapability).map((c) => ({ name: bare("site", c.id), id: c.id }));
    assert.deepEqual(safe, [{ name: "chat", id: "chat" }], "filtered map skips malformed entries, keeps well-formed");
  });

  it("GOAL61(c): real registry still builds every installed package, all tool ids are string ids", () => {
    const packages = buildRegistryPackages(); // must NOT throw
    assert.equal(
      packages.length,
      listInstalledPackageIds().length,
      "ALL-33 stay listed — per-entry filter never drops a package (GOAL 34 all-33 contract)"
    );
    for (const pkg of packages) {
      for (const tool of pkg.tools ?? []) {
        assert.equal(typeof tool.id, "string");
        assert.ok(tool.id.length > 0, `${pkg.id}: tool id non-empty`);
      }
    }
  });
});