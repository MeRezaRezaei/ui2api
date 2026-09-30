import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRequestedAccount } from "../src/cli.js";
import {
  capabilitiesPath,
  listAccounts,
  saveAccountSnapshot,
  saveCapabilities,
  slugifyIdentity,
  type ProfileSnapshot,
} from "../src/runtime/session-store.js";

/**
 * GOAL 118: `ui2api profile capabilities <site> --account <X>` resolved the
 * account with a bare `accounts.find(...) ?? accounts[0]`, so an unmatched `X`
 * silently drove the FIRST vault account — it probed, wrote
 * `capabilities.json` for the WRONG account, printed `saved ->`, and exited 0.
 *
 * MEASURED before the fix:
 *   npx tsx src/cli.ts profile capabilities gemini --account nobody@example.com
 *   -> full live fingerprint, "ok": true, then
 *      saved -> .../data/sessions/gemini.google.com/osbulk/capabilities.json
 *      EXIT=0        (the requested account appears nowhere)
 *
 * The daemon already refuses this exactly (src/prompt/http.ts). One key space,
 * or the write gate and the read gate disagree about who "account" means.
 */

/** The repo root, resolved from THIS file's own location — never from cwd. A
 *  cwd-relative `readFileSync("src/cli.ts")` happens to work only because the
 *  runner's working directory is the repo root; resolve() from import.meta.url
 *  is the property, not the coincidence. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CLI_RAW = readFileSync(resolve(REPO, "src/cli.ts"), "utf8");
// strip comments: the GOAL 118 fix NAMES the old `?? accounts[0]` shape in its
// explanatory comment, so a raw-source scan would match the very prose that
// documents the fix. A pin must forbid the CALL, not the word about it.
const CLI = CLI_RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const HTTP = readFileSync(resolve(REPO, "src/prompt/http.ts"), "utf8");
const HOST = "gemini.google.com";
const ACCOUNTS = [
  { identity: "osbulk", slug: "osbulk" },
  { identity: "merezarezaei@gmail.com", slug: "merezarezaei-at-gmail-com" },
];

/** The account whose stored fingerprint the GOAL 118 bug overwrote. It is the
 *  FIRST row of the vault, so the pre-fix `?? accounts[0]` fallback selected
 *  exactly this file — which is what makes "the refusal wrote nothing" a real
 *  assertion and not a formality. */
const VICTIM_IDENTITY = "osbulk";
const OTHER_IDENTITY = "merezarezaei@gmail.com";

function fakeSnapshot(identity: string): ProfileSnapshot {
  return {
    version: 1,
    host: HOST,
    origin: `https://${HOST}`,
    capturedAt: "2026-09-27T00:00:00.000Z",
    // A non-anonymous session (the GOAL 49 write gate refuses zero-cookie,
    // zero-localStorage snapshots), so both rows are USABLE accounts.
    cookies: [{ name: "SID", value: `fixture-${slugifyIdentity(identity)}`, domain: HOST, path: "/", expires: -1 }],
    localStorage: [["fixture", identity]],
    sessionStorage: [],
    indexedDB: [],
  };
}

/**
 * A vault THIS TEST OWNS: two real accounts (written through the runtime's own
 * write seam, so `listAccounts` returns exactly what it would return for a
 * real capture) plus one real stored `capabilities.json` — the artifact the
 * defect overwrote for the wrong account.
 *
 * The previous version of this pin read the OPERATOR'S vault through a
 * RELATIVE literal, `data/sessions/gemini.google.com/osbulk/capabilities.json`.
 * `data/` is gitignored, so on a clean CI checkout that file does not exist —
 * the test took its "skipped" branch and asserted `assert.ok(true)`, i.e. it
 * silently degraded into a green pin that measured nothing. Worse, on a box
 * where the operator HAD captured an `osbulk` account it read (and mtime-
 * compared) real credentials' directory. The honest form is a vault the test
 * creates, so the assertion is about the CODE and holds identically on any box.
 */
function tempVault(): { dir: string; sitesDir: string; victim: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "u2a-acct-vault-"));
  const sitesDir = join(dir, "vault");
  saveAccountSnapshot(sitesDir, HOST, VICTIM_IDENTITY, fakeSnapshot(VICTIM_IDENTITY), { source: "import" });
  saveAccountSnapshot(sitesDir, HOST, OTHER_IDENTITY, fakeSnapshot(OTHER_IDENTITY), { source: "import" });
  const victim = capabilitiesPath(sitesDir, HOST, slugifyIdentity(VICTIM_IDENTITY));
  // A real fingerprint, written through the real write seam.
  saveCapabilities(sitesDir, HOST, slugifyIdentity(VICTIM_IDENTITY), { probedAt: "2026-09-27T00:00:00.000Z", marker: "the-real-stored-fingerprint" });
  return { dir, sitesDir, victim, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Run the REAL CLI in a child process and report its exit status + combined
 * output, never throwing on a nonzero exit (a refusal IS the expected result
 * here). Bounded by an explicit `timeout` per the GOAL 102 rule — a hung
 * child must be a named failure, not a silent file-level drop.
 *
 * `process.execPath` + the tsx loader is used rather than the `tsx` shim, so
 * this does not depend on a PATH entry or an npx resolution on the runner.
 */
function runCli(args: string[]): { status: number; output: string } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(REPO, "src/cli.ts"), ...args],
    { cwd: REPO, encoding: "utf8", timeout: 120_000 },
  );
  if (r.error) throw r.error;
  return { status: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

d("GOAL 118: an account reference resolves EXACTLY, or is refused by name", () => {
  t("an exact identity hit resolves", () => {
    const got = resolveRequestedAccount(ACCOUNTS, "osbulk", HOST);
    assert.equal(got.identity, "osbulk");
  });

  t("an exact slug hit resolves", () => {
    const got = resolveRequestedAccount(ACCOUNTS, "merezarezaei-at-gmail-com", HOST);
    assert.equal(got.identity, "merezarezaei@gmail.com");
  });

  t("an UNKNOWN account is refused, naming the account, the host and the slugs", () => {
    assert.throws(
      () => resolveRequestedAccount(ACCOUNTS, "nobody@example.com", HOST),
      (e: Error) =>
        e.message.includes('"nobody@example.com"') &&
        e.message.includes(`"${HOST}"`) &&
        e.message.includes("osbulk") &&
        e.message.includes("merezarezaei-at-gmail-com"),
      "the refusal must name the account, the host and every available slug",
    );
  });

  t("the daemon and the CLI now DELIBERATELY diverge, and the pin says which way and why", () => {
    // GOAL 162 split these two on purpose, so this pin records the split rather
    // than asserting an agreement that no longer exists (and must not be
    // re-faked to make a gate green):
    //
    //   THE DAEMON (`src/prompt/http.ts`) is a CONSUMER surface. Its refusal is
    //   the roster-free projection (`consumerAccountRefusal`): it names the
    //   account the caller asked for, says retrying will not help, and names the
    //   ONE route that lists valid ids — and nothing else. The roster it used to
    //   append was a real leak: on a loopback socket reachable by any local
    //   process, one wrong guess answered with the identity of every other
    //   stored session on that host.
    //
    //   THE CLI (`src/cli.ts`) is an OPERATOR surface, run by the person who
    //   owns the machine and the vault. Listing the slugs there is what the
    //   operator is being asked for — it is the answer to "which one did I
    //   mean?" — and it discloses nothing to a caller who has no access to it.
    //   Narrowing the operator's own tooling would be a convenience change, not
    //   a leak fix, so it was deliberately left alone.
    //
    // BOTH still refuse, and both still name the account the caller sent.
    const httpSrc = HTTP;
    assert.doesNotMatch(
      httpSrc,
      /available: \[\$\{[^}]*\.map\(/,
      "the daemon enumerates the roster again — the consumer surface must never hand a caller the vault's other identities",
    );
    assert.match(httpSrc, /consumerAccountRefusal\(account, host\)/, "the daemon's refusal must come from the roster-free projection");

    let cliMsg = "";
    try {
      resolveRequestedAccount(ACCOUNTS, "nope", HOST);
    } catch (e) {
      cliMsg = (e as Error).message;
    }
    assert.match(cliMsg, /^no stored account "[^"]+" for "[^"]+"; available: \[/, "the OPERATOR-facing CLI keeps its roster");
    assert.match(cliMsg, /"nope"/, "the CLI must still name the account the operator asked for");
  });

  t("the first-account default survives, but ONLY when no account was requested", () => {
    const got = resolveRequestedAccount(ACCOUNTS, undefined, HOST);
    assert.equal(got.identity, "osbulk", "with no --account the first stored account is still the default");
    // ...and it must be ANNOUNCED, not silent
    assert.match(CLI_RAW, /no --account given; using the first stored account/, "the default choice must be named in output");
  });

  t("the silent first-account fallback is GONE from the source", () => {
    assert.ok(
      !/\?\?\s*accounts\[0\]/.test(CLI),
      "the unguarded `?? accounts[0]` fallback must not remain — that is the defect",
    );
  });

  t("negative: the OLD resolution is required to be the failure (mutation proof)", () => {
    const oldResolve = (accounts: typeof ACCOUNTS, requested?: string) =>
      accounts.find((a) => a.identity === requested || a.slug === requested) ?? accounts[0]!;
    // precondition: the old code silently served the WRONG account
    assert.equal(oldResolve(ACCOUNTS, "nobody@example.com").identity, "osbulk",
      "precondition: the old rule returned the first account for an unknown request");
    // and the new rule refuses instead
    assert.throws(() => resolveRequestedAccount(ACCOUNTS, "nobody@example.com", HOST));
  });

  t("MEASURED (real CLI, hermetic vault): an unknown --account exits 1, names itself, and leaves the other account's stored fingerprint byte- and mtime-identical", () => {
    const { sitesDir, victim, cleanup } = tempVault();
    try {
      // The vault this test just built is a REAL, populated vault: both rows are
      // usable accounts, so the refusal below is the ACCOUNT resolution
      // refusing — not the earlier "no identity-keyed accounts" bail-out. If
      // this read an operator vault instead, that branch would fire whenever
      // the box had no capture, which is exactly the silent-skip this replaces.
      const stored = listAccounts(sitesDir, HOST);
      assert.equal(stored.length, 2, "the fixture vault must hold both accounts, or the refusal below proves nothing");
      for (const row of stored) {
        assert.equal(row.usable, true, `fixture account ${row.slug} must be usable: ${row.reason ?? ""}`);
      }

      // The pin is NOT vacuous: the victim file is the one the pre-fix fallback
      // would have written (it is the FIRST row), and it is stamped with a
      // known past mtime, so ANY rewrite moves it to "now" and the comparison
      // below can fail. The two lines this replaces were `assert.ok(true,
      // "skipped…")` and `assert.equal(before, before)` — neither of which can
      // fail, which is why they are gone rather than kept.
      assert.equal(
        resolveRequestedAccount(stored, undefined, HOST).slug,
        slugifyIdentity(VICTIM_IDENTITY),
        "precondition: the account the pre-fix fallback chose IS the victim whose fingerprint is at risk",
      );
      const SENTINEL = new Date("2020-01-02T03:04:05.000Z");
      utimesSync(victim, SENTINEL, SENTINEL);
      const before = statSync(victim).mtimeMs;
      assert.equal(before, SENTINEL.getTime(), "precondition: the sentinel mtime was really applied to the stored fingerprint");
      const bytes = readFileSync(victim, "utf8");

      // THE REAL COMMAND, not the pure resolver. The in-process
      // `resolveRequestedAccount` call the previous version made was a THROW
      // with no write path reachable, so "the file is unchanged" was true by
      // construction — it measured nothing about the defect, which happened in
      // `cmdProfileCapabilities` AFTER the resolver returned. Driving the
      // actual CLI is what makes the mtime/bytes comparison falsifiable: the
      // command that used to print `saved ->` and exit 0 now runs, and the
      // fingerprint must survive it untouched.
      //
      // It stays hermetic because --data-dir points the command at the fixture
      // vault, and it never reaches a browser: the refusal is thrown at
      // cli.ts:1263, before probeAccountCapabilities()'s launchBrowser at
      // cli.ts:1291. A regression that let the fall-through through would
      // attempt a real browser launch — visible as this test going red, not as
      // a silent pass.
      const cli = runCli(["profile", "capabilities", "gemini", "--account", "nobody@example.com", "--data-dir", sitesDir]);

      assert.equal(cli.status, 1, `a refused account must exit nonzero; stdout/stderr was: ${cli.output}`);
      assert.doesNotMatch(cli.output, /saved ->/, "the command must never claim it saved a fingerprint it refused to attribute");
      assert.match(cli.output, /no stored account "nobody@example\.com" for "gemini\.google\.com"/, "the refusal must fire and name both sides");
      assert.match(cli.output, new RegExp(slugifyIdentity(VICTIM_IDENTITY)), "and must name the account that was NOT silently used");

      assert.equal(statSync(victim).mtimeMs, before, "a refused account must not rewrite another account's fingerprint");
      assert.equal(readFileSync(victim, "utf8"), bytes, "...and must not touch its bytes either (mtime alone can miss a same-ms write)");

      // The complement, so the pin cannot pass by refusing EVERYTHING: the
      // account that IS stored still resolves, to itself.
      assert.equal(
        resolveRequestedAccount(stored, slugifyIdentity(OTHER_IDENTITY), HOST).identity,
        OTHER_IDENTITY,
        "a stored account must still resolve — the guard is exactness, not a blanket refusal",
      );
    } finally {
      cleanup();
    }
  });
});
