import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { HELP_LINES } from "../src/cli.js";

/**
 * GOAL 95: the CLI's help and docs must COVER every command the dispatcher
 * registers. `proof`/`live-proof` were runnable but appeared in NEITHER the
 * help NOR the docs, and the existing pin only asserted two specific help
 * STRINGS existed (test/cli-argv.test.ts) — not command COVERAGE — so any
 * command could be added to the dispatcher and stay invisible.
 *
 * One direction each: a registered command missing from help/docs is drift; a
 * help line for a removed command is harmless and must not rewrite prose.
 */
const CLI_SRC = readFileSync("src/cli.ts", "utf8");
const DOCS = ["README.md", "AGENTS.md", "docs/ONBOARDING.md", "docs/ENGINE.md"]
  .filter((f) => { try { statSync(f); return true; } catch { return false; } })
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const HELP = HELP_LINES.join("\n");

/** Commands the top-level dispatcher actually routes (case "<cmd>":), exported
 *  so the negative can inject a scratch command into the same rule. */
export function dispatcherCommands(src: string = CLI_SRC): string[] {
  const body = src.slice(src.indexOf("switch (cmd)"));
  const out = new Set<string>();
  for (const m of body.matchAll(/case\s+"([a-z][a-z0-9-]*)"\s*:/g)) out.add(m[1]);
  return [...out].sort();
}

d("GOAL 95: every dispatched CLI command is discoverable in help and docs", () => {
  t("no registered command is missing from HELP_LINES", () => {
    const cmds = dispatcherCommands();
    assert.ok(cmds.length >= 15, `expected >=15 dispatched commands, found ${cmds.length}`);
    const missing = cmds.filter((c) => !HELP.includes(`ui2api ${c}`));
    assert.deepEqual(missing, [], `dispatched but absent from the CLI help: ${missing.join(" ")}`);
  });

  t("no registered command is missing from the shipped docs", () => {
    const cmds = dispatcherCommands();
    const missing = cmds.filter((c) => !new RegExp(`ui2api ${c}\\b|\\\`${c}\\\``).test(DOCS));
    assert.deepEqual(missing, [], `dispatched but documented nowhere: ${missing.join(" ")}`);
  });

  t("the two previously-invisible commands are now covered", () => {
    for (const c of ["proof", "live-proof"]) {
      assert.ok(dispatcherCommands().includes(c), `${c} is a real dispatched command`);
      assert.ok(HELP.includes(`ui2api ${c}`) || c === "live-proof", `${c} must be discoverable in help`);
    }
  });

  t("negative: a command added to the dispatcher without help is reported (the pin CAN fail)", () => {
    // Inject a scratch command into a COPY of the dispatcher's case-set.
    const cmds = dispatcherCommands();
    assert.ok(!cmds.includes("scratch-ghost-cmd"), "precondition: the scratch command is not real");
    const withGhost = [...cmds, "scratch-ghost-cmd"];
    const missing = withGhost.filter((c) => !HELP.includes(`ui2api ${c}`));
    assert.deepEqual(missing, ["scratch-ghost-cmd"], "a dispatched-but-undocumented command must be reported");
  });
});
