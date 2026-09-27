import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CHROME_SYSTEM_PATHS,
  CHROME_CHROMIUM_PATHS,
  resolveChromeExec,
  userChromeLaunchArgs,
} from "../src/runtime/browser.js";
import { stopChromeDaemon, DAEMON_STATE_ENV, type ChromeDaemonState } from "../src/runtime/chrome-daemon.js";
import { isKnownSiteHost } from "../src/runtime/profile-scan.js";
import { siteHostCatalog, defaultChatSurface, chatSurfaceStatus, buildRegistryPackages } from "../src/prompt/registry.js";
import { firstContentLine } from "../src/prompt/smoke.js";

/**
 * THE MAPPINGS THAT WERE HAND-TYPED WHERE A DERIVATION WAS AVAILABLE.
 *
 * Each test below pins one change in this fold, and each states which half of
 * the split it protects: the KEY SET became derived, the VALUES stayed typed.
 * That split is the whole discipline — a published contract (an env-knob name a
 * user types, a wire code, a path a consumer writes, a tool name OmniRoute
 * registers) is NOT rot, and re-deriving it would break a consumer instead of
 * fixing a bug. What rots is the *set of keys* a human has to remember to keep
 * in step with code that already knows the answer.
 *
 * Nothing here launches a browser, starts a daemon, or writes outside a temp dir.
 */

const DAEMON_SRC = readFileSync("src/runtime/chrome-daemon.ts", "utf8");
const XHOST_SRC = readFileSync("src/runtime/xhost-capture.ts", "utf8");

test("the daemon's Chrome ladder is the SEAM's ladder, not a fourth typed copy", () => {
  // MEASURED drift this closes: the daemon's private list was
  // [stable, google-chrome, chromium, chromium-browser] while the seam's was
  // [stable, google-chrome, /opt/google/chrome/chrome, <playwright cache>]. On
  // this box `/opt/google/chrome/chrome` EXISTS and `/usr/bin/chromium*` do not,
  // so `ui2api requirements` — which folds the seam's ladder — reported Chrome
  // READY while `ui2api chrome start`, the actual point of use, answered "no
  // Chrome executable found". Two commands an operator runs back to back,
  // contradicting each other, because one of them typed its own list.
  assert.doesNotMatch(
    DAEMON_SRC,
    /["'`]\/usr\/bin\/google-chrome|["'`]\/opt\/google\/chrome|["'`]\/usr\/bin\/chromium/,
    "chrome-daemon.ts must not type a Chrome path again — it reads the seam's CHROME_SYSTEM_PATHS / CHROME_CHROMIUM_PATHS",
  );
  assert.match(DAEMON_SRC, /CHROME_SYSTEM_PATHS/, "the daemon must read the seam's system ladder");
  assert.match(DAEMON_SRC, /CHROME_CHROMIUM_PATHS/, "and the seam's chromium ladder");
  // the seam's own resolution is UNCHANGED by this: system paths, then the
  // Playwright cache. Chromium is deliberately not in it.
  assert.doesNotMatch(
    CHROME_SYSTEM_PATHS.join(" "),
    /chromium/,
    "the seam's system ladder must stay Chrome-only — the cache is its chromium fallback",
  );
});

test("the seam's ladder order is real-Chrome-before-Chromium, stated once", () => {
  // ORDER is policy (a human decision), but it must not be re-typed per caller,
  // so it is pinned here where the single list lives. Real Chrome first: the
  // whole project exists to be indistinguishable from the user's own browser.
  const system = CHROME_SYSTEM_PATHS;
  assert.ok(system.includes("/usr/bin/google-chrome-stable"), "the stable channel is the first choice");
  const optIdx = system.indexOf("/opt/google/chrome/chrome");
  assert.ok(optIdx > 0, "the packaged /opt install is a real-Chrome path and must be in the system ladder");
  for (const c of CHROME_CHROMIUM_PATHS) {
    assert.ok(
      !system.includes(c),
      `${c} is Chromium, not Chrome — it must not outrank a real Chrome in the system ladder`,
    );
  }
  // explicit UI2API_CHROME_PATH still wins over everything (published knob name)
  const explicit = join(tmpdir(), "ui2api-derivation-probe-chrome");
  writeFileSync(explicit, "#!/bin/sh\n", { mode: 0o755 });
  try {
    assert.equal(resolveChromeExec({ executablePath: explicit }), explicit, "an explicit path wins the ladder");
  } finally {
    rmSync(explicit, { force: true });
  }
});

test("the assisted-login browser derives its whole option bag from the seam", () => {
  // `launchHeadedChromeForLogin` is a declared launch exception (Playwright's
  // launch() rejects userDataDir, so a persistent context is the only form that
  // hands the owner's real profile to a window a human logs into). Being an
  // exception must not mean being a private browser: its arg list, its
  // `channel: "chrome"` decision and its UI2API_CHROME_PATH override were typed
  // a second time, so this window could carry a different fingerprint from every
  // other launcher in the project. It now reads buildLaunchOptions.
  assert.doesNotMatch(
    XHOST_SRC,
    /--window-size/,
    "xhost-capture.ts must not carry its own window-size literal — that is userChromeLaunchArgs()'s contract",
  );
  assert.match(XHOST_SRC, /buildLaunchOptions\(/, "the launch options must come from the seam's buildLaunchOptions");
  assert.match(
    XHOST_SRC,
    /headless:\s*false/,
    "and headless:false stays FORCED here — an invisible window is not a login, and resolvedHeadless must never answer for this flow",
  );
  // and the derived arg list is the real-browser one: no sandbox/gpu tell
  const args = userChromeLaunchArgs("chrome");
  assert.deepEqual(args, ["--window-size=1280,800"], "the user-Chrome flag set is a fingerprint contract; it changed shape");
  for (const tell of ["--no-sandbox", "--disable-gpu", "--disable-blink-features"]) {
    assert.ok(!args.includes(tell), `${tell} changes the user's own browser fingerprint and must never reach it`);
  }
});

test("the bulk-login scanner recognises EVERY host in the derived site catalog", () => {
  // The drift this closes, measured before the change: the hand-typed 31-host
  // list was missing 10 real sites — www.kimi.ai, aistudio.tencent.ai (the
  // live-verified Tencent chat surface), duck.ai (the full-surface-verified
  // DuckDuckGo package), youtube.com, mail.google.com, v0.app, www.aparat.com,
  // adapta.app, app.innerai.com, zenmux.com. An operator running the one-command
  // bulk login on a box whose cookies live under www.kimi.ai saw a host with no
  // [KNOWN] marker, i.e. the command the README leads with looked empty.
  const catalog = siteHostCatalog();
  assert.ok(catalog.length > 20, `the derived catalog should be substantial, got ${catalog.length}`);
  const unrecognised = catalog.filter((h) => !isKnownSiteHost(h));
  assert.deepEqual(
    unrecognised,
    [],
    `these are real sites the scanner will mark [UNKNOWN]: ${unrecognised.join(", ")}`,
  );

  // THE MONOTONE GATE — the whole 31-host list as it stood BEFORE the derivation,
  // frozen here as a record, not as a mapping to maintain. Every one of them must
  // still be recognised. This is the assertion that matters: a "just derive it"
  // rewrite is allowed to ADD hosts, never to drop one, because a dropped host
  // silently hides a real captured session from the bulk-login command.
  // It earns its keep: it is what caught `notion.so`, `doubao.com` and
  // `blackbox.ai` — the catalog names their `www.` forms, and `isKnownHost`
  // matches a SUBDOMAIN of a known host but never the reverse, so the three apex
  // domains had quietly become [UNKNOWN].
  const FROZEN_PRE_DERIVATION_HOSTS = [
    "gemini.google.com", "chatgpt.com", "claude.ai", "copilot.microsoft.com", "www.kimi.com",
    "yuanbao.tencent.com", "huggingface.co", "www.perplexity.ai", "www.google.com", "poe.com",
    "deepseek.com", "venice.ai", "grok.com", "aistudio.google.com", "chat.deepseek.com", "doubao.com",
    "duckduckgo.com", "v0.dev", "notion.so", "manus.im", "chatglm.cn", "aistudio.xiaomimimo.com",
    "conol.ai", "t3.chat", "codex.openai.com", "copilot.cloud.microsoft", "blackbox.ai",
    "www.aigcbest.top", "inner-ai.com", "tencent.com", "chatglm.com",
  ];
  assert.equal(FROZEN_PRE_DERIVATION_HOSTS.length, 31, "the frozen record must be the complete pre-change list");
  const lost = FROZEN_PRE_DERIVATION_HOSTS.filter((h) => !isKnownSiteHost(h));
  assert.deepEqual(
    lost,
    [],
    `the derivation LOST hosts the hand-typed list knew — every one of these is a real captured session ` +
      `the bulk-login command will now skip: ${lost.join(", ")}`,
  );

  // the specific sites the drift report named, so a regression names them
  for (const h of ["www.kimi.ai", "aistudio.tencent.ai", "duck.ai", "youtube.com", "mail.google.com"]) {
    assert.ok(isKnownSiteHost(h), `${h} is a real installed/builtin site and must be [KNOWN]`);
  }
  // suffix matching still holds: a subdomain of a known host is ours
  assert.ok(isKnownSiteHost("api.duck.ai"), "a subdomain of a known host stays known");
  assert.equal(isKnownSiteHost("random-site.com"), false, "an unrelated host must still read as unknown");
});

test("`chrome stop` refuses a browser it ADOPTED — the guard that could never fire", () => {
  // MEASURED DEAD GUARD, now closed. The predicate was
  // `if (state.user === "me" && !opts.force)`. `state.user` is only ever written
  // from resolveChromeOwner().user, which resolves to "ui2api" or
  // UI2API_CHROME_USER — never the literal "me" in the production
  // configuration, so the veto was unreachable. And adoption DELIBERATELY writes
  // state for a browser it did not start, under that same user name, so `stop`
  // would SIGTERM the operator's own Chrome: the exact outcome the function's own
  // docstring promises against. The fact that distinguishes the two paths is now
  // recorded as `origin`.
  const dir = mkdtempSync(join(tmpdir(), "u2a-daemon-guard-"));
  const statePath = join(dir, "chrome-daemon.json");
  const realStateEnv = process.env[DAEMON_STATE_ENV];
  process.env[DAEMON_STATE_ENV] = statePath;
  // pid 2^22 is above every default pid_max, so a signal attempt is guaranteed
  // to fail loudly rather than hit a real process.
  const deadPid = 4194303;
  const base = {
    port: 9222,
    pid: deadPid,
    user: "ui2api",
    profile: "/tmp/whatever",
    startedAt: new Date().toISOString(),
  };
  try {
    const write = (st: ChromeDaemonState) => writeFileSync(statePath, JSON.stringify(st, null, 2), { mode: 0o600 });

    write({ ...base, origin: "adopted" });
    const adopted = stopChromeDaemon({ dataDir: dir });
    assert.equal(adopted.stopped, false, "an ADOPTED browser must not be stopped");
    assert.match(adopted.note, /refusing to stop/, "and the refusal must be named");
    assert.match(adopted.note, /ADOPTED/, "and say WHY (adopted, not started by us)");
    assert.doesNotMatch(adopted.note, /could not signal/, "it must refuse BEFORE signalling — the old bug signalled first");

    // a legacy state file (written by an older build, no origin) cannot prove
    // provenance, so it refuses too — unknown is not "ours"
    write(base);
    const unknown = stopChromeDaemon({ dataDir: dir });
    assert.equal(unknown.stopped, false, "a state with no recorded provenance must not be stopped blind");
    assert.match(unknown.note, /no spawn provenance/, "and must say that is why");

    // the positive case: a daemon WE spawned is still stoppable, and the attempt
    // really is made (the pid does not exist, so the note is the signal failure)
    write({ ...base, origin: "spawned" });
    const spawned = stopChromeDaemon({ dataDir: dir });
    assert.match(spawned.note, /could not signal/, "a SPAWNED daemon must still be signalled — the guard must not be a blanket refusal");

    // and --force is still the operator's escape hatch
    write({ ...base, origin: "adopted" });
    const forced = stopChromeDaemon({ dataDir: dir, force: true });
    assert.match(forced.note, /could not signal/, "--force must still reach the signal");
  } finally {
    if (realStateEnv === undefined) delete process.env[DAEMON_STATE_ENV];
    else process.env[DAEMON_STATE_ENV] = realStateEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one resolver decides a surfaced chat id's status — the surface and /sites cannot disagree", () => {
  // Two implementations of one fact, disagreeing on 4 of 22 ids: a builtin entry
  // hard-coded `status: "builtin"` while `chatSurfaceStatus()` — the function
  // /sites, `prompt --sites` and `requirements` actually call — reported the
  // packaged record. MEASURED: gemini, kimi, deepseek and tencent-aistudio each
  // had a real metadata.verified record and still said "builtin" on the surface.
  const surface = defaultChatSurface();
  assert.ok(surface.length > 0, "the chat surface must not be empty — if this passes, the gate is vacuous");
  const wrong = surface
    .filter((e) => e.status !== chatSurfaceStatus(e.id))
    .map((e) => `${e.id}: surface says "${e.status}", the resolver says "${chatSurfaceStatus(e.id)}"`);
  assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
  // and no surfaced id may claim a state it is not (dormant/dead-end are excluded
  // from the surface precisely so a consumer never reads one as driveable)
  for (const e of surface) {
    assert.ok(
      ["verified", "unverified-candidate", "builtin"].includes(e.status),
      `${e.id}: surfaced status must be honest (got "${e.status}")`,
    );
  }
});

test("every SERVED tool declares its args — the guessing schema map stays a last resort", () => {
  // `capabilityInputSchema` falls back to four hand-written regex branches when a
  // package declares no `inputSchema`. MEASURED: 161/161 capabilities across the
  // 33 installed packages declare one, so every branch is UNREACHABLE today. Dead
  // code that reads as a live contract is the dangerous kind: the moment a
  // package ships without a declaration, one of those regexes decides what 100+
  // consumers believe the arguments are — and the map has already been wrong once
  // (it advertised `new_chat` where every runner reads `newChat`).
  //
  // This reads the SERVED registry, not a re-derivation of the manifest walk, so
  // it measures exactly what a consumer receives.
  const packages = buildRegistryPackages();
  assert.ok(packages.length > 0, "the registry must not be empty — if this passes, the gate is vacuous");
  const guessed: string[] = [];
  let tools = 0;
  for (const pkg of packages) {
    for (const tool of pkg.tools ?? []) {
      tools++;
      if (tool.argsDeclared === false) guessed.push(`${pkg.id}/${tool.name}`);
    }
  }
  assert.ok(tools > 100, `expected the whole installed surface, saw ${tools} tools`);
  assert.deepEqual(
    guessed,
    [],
    `these served tools have a GUESSED schema (a regex decided a consumer's arguments): ${guessed.join(", ")}. ` +
      `Declare inputSchema in the manifest (see GOAL 139) — do not let a regex name a consumer's arguments.`,
  );
});

test("every served tool name carries EXACTLY ONE site prefix", () => {
  // The contract registry.ts documents: tools are named "<site>_<capability>",
  // because the capability id already carries the site prefix, and a consumer
  // (OmniRoute) prefixes its own namespace. `bareCapabilityId` enforces the
  // hyphen and underscore forms.
  //
  // MEASURED: exactly one package breaks it —
  // capabilities/google-ai-search/manifest.json declares the capability id
  // `google_ai_mode_search`, whose underscore form is `google_ai_search_`, so the
  // served name is "google-ai-search_google_ai_mode_search" with the site
  // doubled. EXECUTION is unaffected (the runner switches on the raw id), and
  // renaming a PUBLISHED tool name is a breaking change for a consumer that
  // already registers it — so this is POLICY, pinned with a named exception
  // rather than silently fixed. The point of the gate is that the NEXT violation
  // fails LOUD instead of joining the pile.
  const KNOWN_POLICY_EXCEPTIONS: Record<string, string> = {
    "google-ai-search_google_ai_mode_search":
      "capabilities/google-ai-search declares the id `google_ai_mode_search`, which matches neither prefix form. " +
      "The name is PUBLISHED (a consumer may already register it) and the runner reads the raw id, so execution " +
      "is unaffected. Renaming it is a breaking change — decide it with a consumer, not silently.",
  };
  const offenders: string[] = [];
  const live = new Set<string>();
  for (const pkg of buildRegistryPackages()) {
    for (const tool of pkg.tools ?? []) {
      live.add(tool.name);
      if (!KNOWN_POLICY_EXCEPTIONS[tool.name]) continue;
      continue; // declared exception, reported below as still-live
    }
  }
  // names are `${siteId}_${bareCapabilityId(siteId, c.id)}`; a violation is a name
  // that still carries the site prefix after the site prefix has been stripped,
  // i.e. the bare id did not lose it.
  for (const pkg of buildRegistryPackages()) {
    for (const tool of pkg.tools ?? []) {
      const expectedPrefixes = [`${pkg.id}_`, `${pkg.id.replace(/-/g, "_")}_`];
      const hasPrefix = expectedPrefixes.some((p) => tool.id.startsWith(p));
      if (!hasPrefix && !KNOWN_POLICY_EXCEPTIONS[tool.name]) {
        offenders.push(`${tool.name} (capability id "${tool.id}" carries no site prefix)`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `tool names that break the "<site>_<capability>" contract: ${offenders.join(", ")}. ` +
      `Either fix the manifest's capability id, or add a KNOWN_POLICY_EXCEPTIONS row saying why not.`,
  );
  // the declared exception must still be the only one — a stale exception is rot too
  const stale = Object.keys(KNOWN_POLICY_EXCEPTIONS).filter((n) => !live.has(n));
  assert.deepEqual(stale, [], `these policy exceptions no longer exist: ${stale.join(", ")}`);
});

test("the smoke's chrome-stripping heuristic matches the runner it claims to mirror", () => {
  // `firstContentLine` decides what the smoke PRINTS as the answer. It used to
  // add a length cap the duckduckgo runner does not have, so a model chip longer
  // than 40 chars was stripped by the runner and KEPT by the smoke — the smoke
  // then printed `smoke OK: "<the chip>"` and exited 0. A green verdict on chrome
  // instead of an answer is a forged pass, which is worse than a named failure.
  // The runner's predicate is at src/capabilities/duckduckgo.ts:288-292.
  const chip = "a-really-long-active-model-chip-name-that-exceeds-forty-characters-easily";
  const raw = `${chip}\n\nThe actual answer.`;
  assert.equal(firstContentLine(raw), "The actual answer.", "a long chip is chrome and must be skipped, not printed as the answer");
  // and the ordinary short-chip case is unchanged
  assert.equal(firstContentLine("GPT-5.6 Luna\n\nPONG"), "PONG", "the live-verified short-chip case still resolves");
  // a single line with no terminator is NOT chrome: nothing follows it
  assert.equal(firstContentLine("just one line"), "just one line", "a lone unterminated line is the answer, not chrome");
  // empty input stays empty — the smoke's own non-empty gate is what reports it
  assert.equal(firstContentLine(""), "", "no answer reads as no answer, never as a fabricated one");
  // a first line that ENDS in punctuation is the answer
  assert.equal(firstContentLine("What is 2+2?\nAnd also this"), "What is 2+2?", "a punctuated first line is the model's own sentence");
});
