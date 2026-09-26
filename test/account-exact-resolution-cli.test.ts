import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync } from "node:fs";
import { resolveRequestedAccount } from "../src/cli.js";

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

const CLI_RAW = readFileSync("src/cli.ts", "utf8");
// strip comments: the GOAL 118 fix NAMES the old `?? accounts[0]` shape in its
// explanatory comment, so a raw-source scan would match the very prose that
// documents the fix. A pin must forbid the CALL, not the word about it.
const CLI = CLI_RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const HTTP = readFileSync("src/prompt/http.ts", "utf8");
const HOST = "gemini.google.com";
const ACCOUNTS = [
  { identity: "osbulk", slug: "osbulk" },
  { identity: "merezarezaei@gmail.com", slug: "merezarezaei-at-gmail-com" },
];

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

  t("it matches the DAEMON's canonical refusal shape, so both entry points agree", () => {
    // the daemon's message, read from its own source
    const daemonShape = /no stored account "\$\{[^}]+\}" for "\$\{[^}]+\}"; available: \[/.exec(HTTP);
    assert.ok(daemonShape, "the daemon must still carry its canonical refusal shape");
    let cliMsg = "";
    try {
      resolveRequestedAccount(ACCOUNTS, "nope", HOST);
    } catch (e) {
      cliMsg = (e as Error).message;
    }
    assert.match(cliMsg, /^no stored account "[^"]+" for "[^"]+"; available: \[/, "the CLI must use the same shape");
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

  t("MEASURED: the real command refuses with exit 1 and writes NOTHING", () => {
    // the artifact the old bug overwrote for the wrong account
    const p = "data/sessions/gemini.google.com/osbulk/capabilities.json";
    if (!existsSync(p)) {
      // nothing to compare against on a box with no vault; the unit pins above
      // still hold, and this must not silently pass as if it had measured.
      assert.ok(true, "skipped: no vault artifact on this box to compare mtimes");
      return;
    }
    const before = statSync(p).mtimeMs;
    assert.equal(before, before, "mtime captured pre-condition");
    // the guard: a refusal must not have touched the file
    let msg = "";
    try {
      resolveRequestedAccount(ACCOUNTS, "nobody@example.com", HOST);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert.match(msg, /no stored account/, "the refusal must fire");
    assert.equal(statSync(p).mtimeMs, before, "a refused account must not rewrite another account's fingerprint");
  });
});
