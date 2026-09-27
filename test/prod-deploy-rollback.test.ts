import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * GOAL: `scripts/ops/deploy.sh` admitted, in its own words, that it had no
 * rollback ("the previous release is NOT restored automatically"), and its
 * health signal was `curl -fsS .../health >/dev/null` against an endpoint that
 * answered a LITERAL `ok: true`. Two measured frictions in one file:
 *
 *   1. a deploy that installs a bad release and fails its health check leaves
 *      the BROKEN tree live and turns the pipeline red — the operator ends up
 *      worse than before the push;
 *   2. the only signal was a constant, so the health poll could not fail.
 *
 * This gate is PURE STATIC TEXT analysis of deploy.sh — no systemd, no root, no
 * /opt, no real deploy — so it runs on CI. It pins:
 *   - a rollback path that is REACHABLE from the health-failure branch, bounded
 *     in time, loud, and safe when there was no previous release;
 *   - that the restore can never touch the captured-session vault;
 *   - FOUR distinct health failures (refused connection, non-2xx, unparseable
 *     body, `ok !== true`), not one curl exit code;
 *   - a nonzero exit on failure;
 *   - a real served surface (registry/models/vault), because a service that
 *     answers `ok:true` with zero accounts is exactly the broken deploy this
 *     script exists to catch.
 *
 * Every guarantee is proven by a MUTATION RED: mutate the real text, assert the
 * checker then REFUSES it. A gate that cannot go red is a gate nobody reads.
 */

const DEPLOY_SH = fileURLToPath(new URL("../scripts/ops/deploy.sh", import.meta.url));
const realText = readFileSync(DEPLOY_SH, "utf8");

type Violation = { id: string; why: string };

/** Every gate the real deploy.sh must satisfy. Returns [] when clean. */
function checkDeploy(text: string): Violation[] {
  const v: Violation[] = [];
  const has = (re: RegExp) => re.test(text);
  const need = (id: string, why: string, ok: boolean) => {
    if (!ok) v.push({ id, why });
  };

  // --- the script still has its own invariants (no regression) --------------
  need("set-euo-pipefail", "the `set -euo pipefail` guard is gone", has(/set -euo pipefail/));
  need("fail-exits-nonzero", "`fail()` must still exit nonzero", has(/fail\(\)\s*\{[^}]*exit 1/));
  need("stage-data-exclusion", "the stage rsync lost its `data/` exclusion", has(/rsync -a --delete[\s\S]{0,400}?--exclude 'data\/' --exclude '\/data'/));
  need("vault-absence-assertion", "the `$TARGET_DIR/data` absence assertion is gone", has(/\[\[ -e "\$TARGET_DIR\/data" \]\]/));
  need("build-before-switch", "the build must still gate the restart (dist/cli.js assertion)", has(/\[\[ -f "\$TARGET_DIR\/dist\/cli\.js" \]\]/));

  // --- 1. a rollback path exists -------------------------------------------
  need("rollback-fn-exists", "no `rollback()` function exists in deploy.sh", has(/rollback\(\)\s*\{/));
  need("rollback-point-captured", "the previous release is not preserved before the swap (no ROLLBACK_DIR copy)", has(/ROLLBACK_DIR=/));
  need("rollback-point-flagged", "PRESERVED is never set, so a first-ever deploy cannot be distinguished from a rollback", has(/PRESERVED=1/));

  // bounded: the restore must not be able to loop forever
  need("rollback-bounded", "the restore has no bound (no --timeout on its rsync)", has(/rsync -a --delete --exclude 'data\/' --exclude '\/data' --timeout="\$RSYNC_TIMEOUT"/));
  need("rollback-health-bounded", "the post-restore health re-check is not a bounded attempt count", has(/wait_healthy "\$RESTORE_HEALTH_ATTEMPTS" "\$HEALTH_INTERVAL"/));

  // loud: a silent rollback is worse than none
  need("rollback-loud-ok", "a successful rollback does not announce itself on stderr", has(/loud "ROLLBACK OK:/));
  need("rollback-loud-unproven", "a restored-but-unproven rollback is not announced", has(/loud "ROLLBACK UNPROVEN:/));
  need("rollback-loud-failed", "a failed rollback is not announced", has(/loud "ROLLBACK FAILED:/));
  need("rollback-loud-still-live", "the script never says the BROKEN release is still live", has(/THE BROKEN RELEASE IS STILL LIVE/));

  // safe when there was no previous release
  need("rollback-no-previous-safe", "no `PRESERVED`-ne-1 branch: a first-ever deploy would restore garbage or die silently", has(/if \[\[ "\$PRESERVED" -ne 1 \]\]; then[\s\S]{0,400}?ROLLBACK IMPOSSIBLE/));

  // --- 2. the rollback is REACHABLE from the health-failure branch ----------
  const failBranches = [...text.matchAll(/if \[\[ "\$ok" -ne 1 \]\]; then[\s\S]*?\n {2}fi\n/g)].map((m) => m[0]);
  need("health-failure-branch-found", "the health-failure branch (`if [[ \"$ok\" -ne 1 ]]`) is gone", failBranches.length > 0);
  need("health-failure-rolls-back", "a health failure does NOT roll back to a DEFINED rollback() (a call with no implementation is not a rollback)", has(/rollback\(\)\s*\{/) && failBranches.some((b) => /rollback "/.test(b)));
  need("health-failure-exits-nonzero", "a health failure does not exit nonzero", failBranches.some((b) => /fail "/.test(b)));

  // the surface branch must roll back too (an empty registry is a broken deploy)
  const surfaceBranch = text.match(/if ! assert_surface; then[\s\S]*?\n {2}fi\n/)?.[0] ?? "";
  need("surface-failure-rolls-back", "an empty /registry or /v1/models does not roll back", has(/rollback\(\)\s*\{/) && /rollback "/.test(surfaceBranch));
  need("surface-failure-exits-nonzero", "an empty /registry or /v1/models does not exit nonzero", /fail "/.test(surfaceBranch));

  // --- 3. the restore can never touch the vault -----------------------------
  // EVERY rsync in the file must carry the data/ exclusion (stage, preserve, restore)
  const rsyncs = [...text.matchAll(/rsync -a[\s\S]*?"\$?[A-Z_]*(TARGET_DIR|ROLLBACK_TMP)?"?\/\"/g)].map((m) => m[0]);
  need("rsync-count", "no rsync found to audit", rsyncs.length >= 3);
  need("every-rsync-excludes-vault", "an rsync does not exclude `data/` (a copy that could carry the vault)", rsyncs.length > 0 && rsyncs.every((r) => /--exclude 'data\/'/.test(r) && /--exclude '\/data'/.test(r)));
  need("restore-checks-vault-absence", "the restore does not re-assert that `$TARGET_DIR/data` is absent", /rsync -a --delete --exclude 'data\/'[\s\S]{0,400}?\[\[ -e "\$TARGET_DIR\/data" \]\]/.test(text));
  need("preserve-refuses-vault-copy", "the preserved rollback point is not asserted to be vault-free", /ROLLBACK_TMP\/data/.test(text));

  // The health signal is not "does the file mention a probe" — it is what the
  // probe BODY actually inspects. Extract the bodies and gate INSIDE them, so
  // gutting the probe is caught even when the helper text survives elsewhere.
  const probeBody = text.match(/health_probe_once\(\) \{[\s\S]*?\n\}\n/)?.[0] ?? "";
  const okBody = text.match(/json_ok_is_true\(\) \{[\s\S]*?\n\}\n/)?.[0] ?? "";
  const surfaceBody = text.match(/assert_surface\(\) \{[\s\S]*?\n\}\n/)?.[0] ?? "";

  // --- 4. FOUR distinct health failure cases --------------------------------
  // (a) connection refused / timeout — a curl that cannot connect yields 000
  need("case-refused-connection", "the health probe does not distinguish a refused connection/timeout (no 000 default, no status read)", /http_probe \/health/.test(probeBody) && /HTTP \$HTTP_CODE/.test(probeBody) && has(/\|\| code="000"/));
  // (b) non-2xx
  need("case-non-2xx", "the health probe does not treat a non-2xx status as a failure", /if \[\[ ! "\$HTTP_CODE" =~ \^2\[0-9\]\[0-9\]\$ \]\]; then/.test(probeBody));
  // (c) unparseable body
  need("case-unparseable", "no distinct handling for an unparseable /health body", /json_ok_is_true/.test(probeBody) && /JSON\.parse\(fs\.readFileSync[\s\S]{0,200}?catch \{ process\.exit\(3\); \}/.test(okBody));
  // (d) parsed but ok !== true
  need("case-ok-not-true", "no distinct handling for a parsed body whose ok is not true", /json_ok_is_true/.test(probeBody) && /process\.exit\(d && d\.ok === true \? 0 : 4\)/.test(okBody));
  // the poll must be time-bounded, and must not be a bare curl whose status is discarded
  need("poll-bounded", "the health poll has no --max-time bound", /--max-time/.test(probeBody) || has(/curl -sS --max-time 3 -o "\$HTTP_BODY_FILE" -w '%\{http_code\}'/));
  need("poll-inspects-status", "the health poll discards the HTTP status (bare curl >/dev/null with nothing inspected)", /http_probe/.test(probeBody) && /-w '%\{http_code\}'/.test(text) && /health_probe_once; then ok=1; break; fi/.test(text));

  // --- 5. the served surface is asserted, not just the process -------------
  need("registry-counted", "the /registry package count is not asserted nonzero", /\[\[ -z "\$n" \|\| "\$n" -lt 1 \]\]; then\n {4}loud " {2}\/registry reports/.test(surfaceBody));
  need("models-counted", "the /v1/models count is not asserted nonzero", /\(Array\.isArray\(d\.data\) \? d\.data : \[\]\)\.length/.test(surfaceBody));
  need("accounts-probed", "the vault is never probed with /accounts?site=", has(/\/accounts\?site=\$site/));
  need("accounts-chat-site", "no chat site is derived from the served surface to probe accounts with", has(/CHAT_SITE_ID="\$\(json_string/));
  // logged out (WARN) vs vault unreachable (FATAL) must NOT be the same verdict
  need("logged-out-is-a-warning", "a readable-but-empty vault is not a WARNING (it would fail deploys for a logout, which is not a deploy defect)", has(/say " {2}WARN vault: \$site has 0 stored accounts/));
  need("vault-unreachable-is-fatal", "an unreadable/unparseable vault is not FATAL (the exact bug: health ok, zero accounts, no signal)", has(/FATAL: the vault is UNREACHABLE/));

  return v;
}

function violationIds(text: string): string[] {
  return checkDeploy(text).map((x) => x.id);
}

// --- mutations: each guarantee must be able to go RED -----------------------

/** Delete the whole `rollback() { ... }` function body. */
function mutationDeleteRollback(text: string): string {
  return text.replace(/\nrollback\(\) \{[\s\S]*?\n\}\n/, "\n");
}

/** Reduce the health poll to a bare curl whose status is thrown away. */
function mutationBareCurlHealth(text: string): string {
  const gutted = text.replace(
    /health_probe_once\(\) \{[\s\S]*?\n\}\n/,
    'health_probe_once() {\n  curl -sS --max-time 3 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1\n}\n'
  );
  return gutted.replaceAll(
    'if health_probe_once; then ok=1; break; fi',
    'if health_probe_once; then ok=1; break; fi'
  );
}

/** Stop treating a refused connection (curl's nonzero exit) as 000. */
function mutationRefusedBecomesSuccess(text: string): string {
  return text.replaceAll('|| code="000"', '|| code="200"');
}

/** Stop treating a non-2xx status as a failure. */
function mutationIgnoreStatusCode(text: string): string {
  return text.replaceAll(
    'if [[ ! "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then',
    'if false; then'
  );
}

/** Stop treating an unparseable body as a failure. */
function mutationTolerateUnparseable(text: string): string {
  return text.replaceAll(
    'catch { process.exit(3); }',
    'catch { process.exit(0); }'
  );
}

/** Stop treating `ok !== true` as a failure (the literal-ok bug returns). */
function mutationIgnoreOkField(text: string): string {
  return text.replaceAll(
    'process.exit(d && d.ok === true ? 0 : 4);',
    'process.exit(0);'
  );
}

/** Remove the data/ exclusion from the RESTORE copy only. */
function mutationVaultLeaksIntoRestore(text: string): string {
  return text.replaceAll(
    "rsync -a --delete --exclude 'data/' --exclude '/data' --timeout=\"$RSYNC_TIMEOUT\"",
    "rsync -a --delete --timeout=\"$RSYNC_TIMEOUT\""
  );
}

/** A health failure that rolls back but still exits 0 (green pipeline, dead service). */
function mutationSuccessExitOnHealthFailure(text: string): string {
  return text.replaceAll(
    'rollback "the new release never became healthy"\n    fail "deploy FAILED and was ROLLED BACK to the previous release; exit nonzero on purpose"',
    'rollback "the new release never became healthy"'
  );
}

/** Empty registry is no longer fatal. */
function mutationTolerateEmptyRegistry(text: string): string {
  return text.replaceAll(
    'if [[ -z "$n" || "$n" -lt 1 ]]; then\n    loud "  /registry reports',
    'if false; then\n    loud "  /registry reports'
  );
}

/** Zero accounts becomes a hard failure (a logout would block every deploy). */
function mutationLogoutIsFatal(text: string): string {
  return text.replaceAll(
    'say "  WARN vault: $site has 0 stored accounts',
    'loud "  FATAL vault: $site has 0 stored accounts'
  );
}

const MUTATIONS: { id: string; mutate: (t: string) => string; expect: string[] }[] = [
  { id: "rollback block deleted", mutate: mutationDeleteRollback, expect: ["rollback-fn-exists", "rollback-loud-ok", "health-failure-rolls-back"] },
  { id: "health poll reduced to a bare curl >/dev/null", mutate: mutationBareCurlHealth, expect: ["poll-inspects-status", "case-refused-connection", "case-non-2xx", "case-unparseable", "case-ok-not-true"] },
  { id: "connection refused no longer 000", mutate: mutationRefusedBecomesSuccess, expect: ["case-refused-connection"] },
  { id: "non-2xx status no longer a failure", mutate: mutationIgnoreStatusCode, expect: ["case-non-2xx"] },
  { id: "unparseable body tolerated", mutate: mutationTolerateUnparseable, expect: ["case-unparseable"] },
  { id: "ok !== true tolerated", mutate: mutationIgnoreOkField, expect: ["case-ok-not-true"] },
  { id: "data/ exclusion removed from the restore", mutate: mutationVaultLeaksIntoRestore, expect: ["every-rsync-excludes-vault", "restore-checks-vault-absence"] },
  { id: "health failure exits 0", mutate: mutationSuccessExitOnHealthFailure, expect: ["health-failure-exits-nonzero"] },
  { id: "empty /registry tolerated", mutate: mutationTolerateEmptyRegistry, expect: ["registry-counted"] },
  { id: "logged out treated as fatal", mutate: mutationLogoutIsFatal, expect: ["logged-out-is-a-warning"] },
];

// A single mutation can be run RAW (unasserted) so CI/humans can see the real
// red output:  DEPLOY_MUTATION=health-poll node --test test/prod-deploy-rollback.test.ts
const RAW = process.env.DEPLOY_MUTATION;

d("deploy.sh: rollback + a meaningful health signal", () => {
  if (RAW) {
    const hit = MUTATIONS.find((m) => m.id === RAW);
    assert.ok(hit, `unknown DEPLOY_MUTATION=${RAW}`);
    const mutated = hit.mutate(realText);
    assert.notEqual(mutated, realText, `mutation "${RAW}" did not change the text — it is a no-op and proves nothing`);
    const found = checkDeploy(mutated);
    assert.deepEqual(found, [], `MUTATION RED: "${RAW}" should have been caught, and was: ${JSON.stringify(found)}`);
    return;
  }

  t("the real deploy.sh satisfies every gate", () => {
    assert.deepEqual(checkDeploy(realText), []);
  });

  for (const m of MUTATIONS) {
    t(`MUTATION RED — ${m.id}`, () => {
      const mutated = m.mutate(realText);
      assert.notEqual(mutated, realText, `mutation "${m.id}" was a no-op: it cannot prove anything`);
      const ids = new Set(violationIds(mutated));
      for (const want of m.expect) {
        assert.ok(
          ids.has(want),
          `mutation "${m.id}" was NOT caught by gate "${want}" — got [${[...ids].join(", ")}]`
        );
      }
    });
  }
});
