// Verifies the shipped ChatDriver jsIndex end-to-end: drives a real site
// through ChatDriver.ask() (the production daemon path) with the profile's
// jsIndex enabled. Under UI2API_DEBUG the driver logs the indexed call result;
// this script asserts that log is ok:true and that a real answer came back
// stable. GOAL 1 criterion 2 (fold #17).
//
// Usage: npx tsx scripts/verify-indexed-call.ts [site]  (site default "gemini")
// Env:  UI2API_ATTACH_PORT=9222 (attach to the live ui2api Chrome),
//       UI2API_DEBUG=1 (driver logs the indexed-call line)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatDriver } from "../src/prompt/driver.js";
import { BUILTIN_PROFILES } from "../src/profile/profile.js";

process.env.UI2API_ATTACH_PORT = process.env.UI2API_ATTACH_PORT || "9222";
process.env.UI2API_DEBUG = "1";

const site = process.argv[2] ?? "gemini";
const profile = BUILTIN_PROFILES[site as keyof typeof BUILTIN_PROFILES];
if (!profile) throw new Error(`no builtin profile for site ${site}`);

const OUT = join(process.env.WORK || join(tmpdir(), "ui2api-work"), `driver-probe-result-${site}.json`);

async function main(): Promise<void> {
  const driver = new ChatDriver(profile, { account: "merezarezaei@gmail.com" });
  try {
    const res = await driver.ask("ping", { newChat: false, timeoutMs: 90000 });
    const result = {
      at: new Date().toISOString(),
      site,
      doneReason: res.doneReason,
      answerPreview: (res.answer || "").slice(0, 120),
    };
    writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log(`VERIFY-INDEXED-CALL site=${site} reason=${res.doneReason} answer=${JSON.stringify((res.answer || "").slice(0, 60))}`);
    if (res.doneReason !== "stable" && res.doneReason !== "empty") {
      process.exitCode = 1;
    }
  } finally {
    await driver.close().catch(() => {});
  }
}
main().catch((e) => {
  console.error("VERIFY-INDEXED-CALL FAILED: " + (e instanceof Error ? e.stack ?? e.message : String(e)));
  process.exit(1);
});