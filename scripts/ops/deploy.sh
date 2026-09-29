#!/usr/bin/env bash
# ui2api deploy — install the current tree to /opt/ui2api and restart the service.
#
# WHY THIS EXISTS. The service used to run `npx tsx $REPO/src/cli.ts promptd`
# straight out of a git checkout, which is fine for one person poking at it and
# wrong for a deployed thing:
#
#   - the working tree is edited constantly, so a half-written file can be
#     executed mid-commit (the "stale daemon" class of bug this project keeps
#     hitting: a daemon predating new routes 404s them while /registry still
#     looks live);
#   - `tsx` compiles TypeScript on every start, so a slow start is also a
#     fragile one;
#   - the checkout is owned by a human, and the service must run as `ui2api`.
#
# So the running service points at /opt/ui2api, which only this script writes.
# The deploy is therefore idempotent, atomic-ish (build BEFORE the swap), and
# every step is loud.
#
# WHAT IT NEVER TOUCHES — `data/`. That is the captured-session vault: real
# login state for a real account. It is never synced, never moved, never
# deleted, and never overwritten by a deploy, and — new — the ROLLBACK copy
# carries the same `data/` exclusion and the same absence assertion, so a
# restore can never move the vault either. The service reaches it through
# UI2API_DATA_DIR, which is set in the unit, NOT in this script.
#
# Usage:  sudo ./scripts/ops/deploy.sh [--repo DIR] [--target DIR] [--no-restart]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# ROUND N+99: this target used to be overridable by an environment knob. Removed.
# The unit already pins WorkingDirectory and the ExecStart path, so nothing at
# runtime needed it, and `--target` is how you point the script somewhere else.
# The env-knob table gate caught it on pipeline 299 -- and then caught the FIX too,
# because that gate scans file TEXT, so even a comment naming the old knob reads as
# "shipped code reads this". The name is not repeated here for that reason.
TARGET_DIR="/opt/ui2api"
CHROME_USER="${UI2API_CHROME_USER:-ui2api}"
API_PORT="${UI2API_PROMPTD_PORT:-9797}"
DO_RESTART=1

# The rollback point sits BESIDE the target, never inside it, so a restore can
# never rsync a previous release into itself and never ships as part of a deploy.
ROLLBACK_DIR="${DEPLOY_ROLLBACK_DIR:-${TARGET_DIR}.rollback}"
ROLLBACK_TMP="${ROLLBACK_DIR}.tmp"
# Bounded everywhere. A rollback that can loop is an outage that never ends.
HEALTH_ATTEMPTS=30
HEALTH_INTERVAL=2
RESTORE_HEALTH_ATTEMPTS=10
RSYNC_TIMEOUT=120
# The restore REBUILDS (see `rollback`), so the rollback's install+build is
# bounded on its own clock. Generous enough for a cold `npm ci` on a slow box
# (the stage path is unbounded today and stays that way), but it is a ceiling,
# not an open-ended wait: a hung restore is a NAMED outcome, reported loudly.
RESTORE_BUILD_TIMEOUT=900
RESTORE_BUILD_KILL_GRACE=15

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_DIR="$2"; shift 2 ;;
    --target) TARGET_DIR="$2"; shift 2 ;;
    --no-restart) DO_RESTART=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '[deploy] %s\n' "$*"; }
loud() { printf '[deploy] %s\n' "$*" >&2; }
fail() { printf '[deploy] FATAL: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail "must run as root (systemctl + chown)"
id -u "$CHROME_USER" >/dev/null 2>&1 || fail "user $CHROME_USER does not exist"
[[ -f "$REPO_DIR/package.json" ]] || fail "no package.json in $REPO_DIR — bad --repo?"

# --- the build identity stamp -------------------------------------------------
# WHY THIS IS HERE. `npm run build` writes `dist/runtime/build-info.json` from
# `git rev-parse HEAD`, so the daemon can name the build that is answering
# (`GET /status`). The deploy stages the repo with `--exclude '.git/'` and builds
# INSIDE the target, and the target has no `.git` (MEASURED: no /opt/ui2api/.git).
# So the stamp the target's own build writes carries `commit: null` — honest, and
# useless: exactly the "a plausible-looking service nobody can name" defect the
# stamp exists to close. The commit IS knowable at the only place that still has
# it: this script, which runs from the repo checkout.
#
# THE RULE, which is the whole design: **a wrong stamp is worse than no stamp.**
# Only a real full 40-hex commit is ever written. If the commit cannot be
# resolved, the stamp is DELETED, so the resolver falls through to its `unknown`
# step with its named reason. Never a placeholder, never the previous release's
# commit, never a literal that merely looks like one — this project's core
# property is that nothing it reports is invented, and a fabricated build id is
# the same lie in a different field.
#
# $1 = the tree to stamp (its dist/). $2 = the commit, or empty = unresolvable.
# $3 = "true" | "false" | "null" (the tree that commit was measured from).
write_build_stamp() {
  local target="$1" commit="${2:-}" dirty="${3:-null}" stamp="$1/dist/runtime/build-info.json"
  # 40-hex is NOT enough on its own: git's "null oid" is 40 zeros, and it is a
  # sentinel for "no object", not a commit. A stamp carrying it would be a
  # placeholder wearing a commit's shape — refused here, at the only seam that
  # can refuse it.
  if [[ ! "$commit" =~ ^[0-9a-f]{40}$ || "$commit" =~ ^0{40}$ ]]; then
    rm -f "$stamp"
    say "build stamp: commit '${commit:-<unresolved>}' is not a resolvable commit — NO stamp written; the service will report identity=unknown with its named reason (honest, and better than a stamp naming the wrong build)"
    return 0
  fi
  mkdir -p "$(dirname "$stamp")"
  printf '{\n  "commit": "%s",\n  "builtAt": "%s",\n  "dirty": %s\n}\n' \
    "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$dirty" > "$stamp" \
    || { rm -f "$stamp"; say "build stamp: could not write $stamp — removed again (no stamp is better than a partial one)"; return 0; }
  chown "$CHROME_USER:$CHROME_USER" "$stamp" 2>/dev/null || true
  say "build stamp: $stamp <- $commit (dirty=$dirty)"
}

# The identity of the tree currently INSTALLED at the target, read from its own
# stamp before the preserve rsync (which excludes dist/, so this is the last
# chance to see it). Used by the rollback so a restored release is stamped with
# ITS OWN commit rather than with the deploy that just failed. Empty when the
# live release carries no stamp — and then the rollback deliberately writes none.
PREV_COMMIT=""
PREV_DIRTY="null"
read_installed_identity() {
  local stamp="$1"
  # Reset first: a call that finds nothing must not leave a PREV_COMMIT from an
  # earlier call standing, or the stamp written later would be a stale value
  # that merely looks resolved.
  PREV_COMMIT=""
  PREV_DIRTY="null"
  [[ -f "$stamp" ]] || return 0
  PREV_COMMIT="$(node -e '
    const fs = require("fs");
    let d;
    try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
    const c = d && typeof d.commit === "string" ? d.commit.trim() : "";
    if (!/^[0-9a-f]{40}$/.test(c)) process.exit(0);
    process.stdout.write(c);
  ' "$stamp" 2>/dev/null || true)"
  PREV_DIRTY="$(node -e '
    const fs = require("fs");
    let d;
    try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
    if (typeof d.dirty === "boolean") process.stdout.write(d.dirty ? "true" : "false");
  ' "$stamp" 2>/dev/null || true)"
  PREV_DIRTY="${PREV_DIRTY:-null}"
}

# --- 0. preserve the release we are about to overwrite ------------------------
# A health failure has to be able to put the previous release back, so the live
# tree is copied aside BEFORE the rsync. Same excludes as the deploy rsync — in
# particular `data/` — so the rollback point can never carry the vault.
PRESERVED=0
if [[ -f "$TARGET_DIR/package.json" ]]; then
  # The identity of what is LIVE right now, captured BEFORE the preserve rsync
  # (which excludes dist/, so the live stamp is about to disappear). This is the
  # only place the previous release's real commit can still be read; the restore
  # rebuilds a tree with no `.git`, so without this a rollback would end up
  # reporting `unknown` — or, worse, the failed deploy's commit.
  read_installed_identity "$TARGET_DIR/dist/runtime/build-info.json"
  if [[ -n "$PREV_COMMIT" ]]; then
    say "live release identity: $PREV_COMMIT (kept for the rollback stamp)"
  else
    say "live release carries NO resolvable build stamp — a rollback of it will be stamped with NOTHING (honest unknown, never the failed deploy's commit)"
  fi
  say "preserving the current release: $TARGET_DIR -> $ROLLBACK_DIR (the rollback point)"
  rm -rf "$ROLLBACK_TMP"
  mkdir -p "$ROLLBACK_TMP"
  if ! rsync -a --delete \
      --exclude 'data/' --exclude '/data' \
      --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' \
      --exclude '.brain/' --exclude 'sites/' --exclude '.agents/' --exclude '.opencode/' \
      --exclude 'graphify-out/' \
      --timeout="$RSYNC_TIMEOUT" \
      "$TARGET_DIR/" "$ROLLBACK_TMP/"; then
    rm -rf "$ROLLBACK_TMP"
    fail "could not preserve the current release — refusing to deploy (a deploy with no rollback point is the failure this guards)"
  fi
  if [[ -e "$ROLLBACK_TMP/data" ]]; then
    rm -rf "$ROLLBACK_TMP"
    fail "the preserved release contains a data/ dir — a rollback point must NEVER carry the vault"
  fi
  rm -rf "$ROLLBACK_DIR"
  mv "$ROLLBACK_TMP" "$ROLLBACK_DIR"
  PRESERVED=1
  say "rollback point ready at $ROLLBACK_DIR (vault excluded, asserted)"
else
  say "no previous release at $TARGET_DIR — a failed health check will have NOTHING to roll back to (this is reported loudly, not silently)"
fi

# --- http helpers -------------------------------------------------------------
# `curl -fsS ... >/dev/null` is NOT a health signal: a literal `ok:true` body
# passes whether or not the service can do anything. So every probe below keeps
# the STATUS CODE and the BODY, and a failure is: refused connection (000),
# any non-2xx, an unparseable body, or a parsed `ok !== true`.
# Each call is bounded by --max-time, so a hung service fails instead of hanging.
http_probe() {
  # $1 = path. Sets HTTP_CODE and HTTP_BODY_FILE.
  local code
  HTTP_BODY_FILE="$(mktemp)"
  code="$(curl -sS --max-time 3 -o "$HTTP_BODY_FILE" -w '%{http_code}' \
    "http://127.0.0.1:$API_PORT$1" 2>/dev/null)" || code="000"
  [[ -n "$code" ]] || code="000"
  HTTP_CODE="$code"
}

http_is_2xx() { [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; }

# Count a JSON array at a JS expression; prints the number, or nothing (exit!=0)
# when the body does not parse or the shape is absent. Never guesses a number.
json_count() {
  node -e '
    const fs = require("fs");
    let d;
    try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch { process.exit(3); }
    const v = (new Function("d", "return (" + process.argv[2] + ")"))(d);
    if (typeof v !== "number" || !Number.isFinite(v)) process.exit(4);
    process.stdout.write(String(v));
  ' "$1" "$2" 2>/dev/null
}

json_string() {
  node -e '
    const fs = require("fs");
    let d;
    try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch { process.exit(3); }
    const v = (new Function("d", "return (" + process.argv[2] + ")"))(d);
    if (typeof v !== "string" || !v) process.exit(4);
    process.stdout.write(v);
  ' "$1" "$2" 2>/dev/null
}

json_ok_is_true() {
  node -e '
    const fs = require("fs");
    let d;
    try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch { process.exit(3); }
    process.exit(d && d.ok === true ? 0 : 4);
  ' "$1" 2>/dev/null
}


# --- health: /health must be a REAL signal ------------------------------------
health_probe_once() {
  http_probe /health
  if [[ ! "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then
    say "  /health -> HTTP $HTTP_CODE — FAILURE (000 = connection refused or timeout)"
    rm -f "$HTTP_BODY_FILE"
    return 1
  fi
  if ! json_ok_is_true "$HTTP_BODY_FILE"; then
    say "  /health -> HTTP 200 but the body is not a JSON {\"ok\":true} — FAILURE (unparseable body, or ok !== true)"
    rm -f "$HTTP_BODY_FILE"
    return 1
  fi
  say "  /health -> HTTP 200, JSON, ok:true"
  rm -f "$HTTP_BODY_FILE"
  return 0
}

wait_healthy() {
  # $1 = attempts, $2 = interval seconds. Bounded, single loop, no recursion.
  local attempts="$1" interval="$2"
  for _ in $(seq 1 "$attempts"); do
    if health_probe_once; then return 0; fi
    sleep "$interval"
  done
  return 1
}

# --- the served surface must be real, not just alive --------------------------
# `health ok` with an empty /registry and an unreadable vault is the exact broken
# deploy this script exists to catch, so the surface is asserted too. NONZERO
# counts are fatal; a zero-account vault is only a warning (see below).
assert_surface() {
  local n
  http_probe /registry
  if ! http_is_2xx; then
    loud "  /registry -> HTTP $HTTP_CODE — FAILURE (the service is not serving the package surface)"
    rm -f "$HTTP_BODY_FILE"; return 1
  fi
  n="$(json_count "$HTTP_BODY_FILE" "(Array.isArray(d.packages) ? d.packages : []).length")" || n=""
  rm -f "$HTTP_BODY_FILE"
  if [[ -z "$n" || "$n" -lt 1 ]]; then
    loud "  /registry reports ${n:-unparseable} packages — FAILURE (expected at least 1; an empty registry is a broken deploy, not a healthy one)"
    return 1
  fi
  say "  /registry: $n package(s)"

  http_probe /v1/models
  if ! http_is_2xx; then
    loud "  /v1/models -> HTTP $HTTP_CODE — FAILURE (the OpenAI-compatible chat surface is not being served)"
    rm -f "$HTTP_BODY_FILE"; return 1
  fi
  n="$(json_count "$HTTP_BODY_FILE" "(Array.isArray(d.data) ? d.data : []).length")" || n=""
  CHAT_SITE_ID="$(json_string "$HTTP_BODY_FILE" "(d.data && d.data[0] && d.data[0].id) || ''")" || CHAT_SITE_ID=""
  rm -f "$HTTP_BODY_FILE"
  if [[ -z "$n" || "$n" -lt 1 ]]; then
    loud "  /v1/models reports ${n:-unparseable} models — FAILURE (expected at least 1)"
    return 1
  fi
  say "  /v1/models: $n model(s)"
  return 0
}

# The vault check. Two OPPOSITE problems share a symptom ("no accounts"), so they
# are never treated the same:
#
#   * vault UNREACHABLE  — /accounts errors (000 / 5xx), or answers with a body
#     that is not a JSON `accounts` array. The service cannot read its own
#     session store: a real defect, and FATAL, because every capability that
#     replays a login would fail at run time.
#   * NOT LOGGED IN      — /accounts answers 200 with a real, well-formed
#     `accounts` array that happens to be empty. The vault is demonstrably
#     READABLE; the operator is simply signed out. That is a WARNING, never a
#     deploy failure — a logout is not something a deploy can or should fix.
# The discriminator is the response's parseability, not the count.
warn_accounts() {
  local site="$CHAT_SITE_ID" n
  if [[ -z "$site" ]]; then
    say "  WARN vault: no chat site id to probe (empty /v1/models) — cannot check accounts; this is already fatal above"
    return 0
  fi
  http_probe "/accounts?site=$site"
  if ! http_is_2xx; then
    loud "  /accounts?site=$site -> HTTP $HTTP_CODE — FATAL: the vault is UNREACHABLE (this is NOT a logout; the service cannot read its session store)"
    rm -f "$HTTP_BODY_FILE"; return 1
  fi
  # -1 = parsed JSON but no `accounts` array (wrong shape -> not a logout).
  # empty output = the body did not parse at all -> also not a logout.
  n="$(json_count "$HTTP_BODY_FILE" "(Array.isArray(d.accounts) ? d.accounts.length : -1)")" || n=""
  rm -f "$HTTP_BODY_FILE"
  if [[ -z "$n" || "$n" == "-1" ]]; then
    loud "  /accounts?site=$site answered 2xx without a usable JSON accounts array (${n:-unparseable body}) — FATAL: the vault is UNREACHABLE, which is NOT a logout"
    return 1
  fi
  if [[ "$n" -lt 1 ]]; then
    say "  WARN vault: $site has 0 stored accounts and the vault IS readable — you are logged OUT (not a deploy defect; re-run 'ui2api profile add-all' or 'profile capture' to log back in)"
    return 0
  fi
  say "  vault: $n stored account(s) for $site"
  return 0
}

# --- rollback -----------------------------------------------------------------
# WHY THE RESTORE REBUILDS. The rollback point is a BARE SOURCE TREE: the
# preserve rsync excludes `dist/` and `node_modules/` (they are machine-specific
# and not worth copying — the same excludes the deploy rsync uses). So a restore
# that ONLY copied it back produced a tree with no `node_modules/` and no
# `dist/cli.js`, and the restart it immediately performs would launch a service
# that cannot start. "Restored, still broken" is the worst outcome a rollback can
# have: it looks like recovery. So the restore runs the SAME install+build the
# stage path runs, before the restart, bounded on its own clock, and loud.
#
# WHY IT CANNOT LOOP. Everything below is a straight line, run ONCE: one mv
# aside, one rsync restore, one bounded build, one bounded health re-check. There
# is no loop construct and no call back into `rollback` (or into this script), so
# there is no edge by which the restore can re-enter itself. The only loop in this
# script (`wait_healthy`) is bounded and terminal — it returns 1, it does not call
# anything. A failed rebuild does NOT retry and does NOT restore again: it reports
# FAILED and returns 1.
rollback() {
  local reason="$1" rc=0
  loud "ROLLBACK: $reason"
  if [[ "$PRESERVED" -ne 1 ]]; then
    loud "ROLLBACK IMPOSSIBLE: there was no previous release to preserve (nothing installed at $TARGET_DIR when this deploy started)."
    loud "THE BROKEN RELEASE IS STILL LIVE. Do not trust this service until it is fixed by hand."
    return 0
  fi
  rm -rf "${TARGET_DIR}.broken"
  mv "$TARGET_DIR" "${TARGET_DIR}.broken" || {
    loud "ROLLBACK FAILED: could not move the broken tree aside; nothing was changed."
    return 1
  }
  mkdir -p "$TARGET_DIR"
  if ! rsync -a --delete --exclude 'data/' --exclude '/data' --timeout="$RSYNC_TIMEOUT" \
      "$ROLLBACK_DIR/" "$TARGET_DIR/"; then
    loud "ROLLBACK FAILED: could not copy the previous release back. The broken tree is at ${TARGET_DIR}.broken and the rollback point is at $ROLLBACK_DIR — restore by hand."
    return 1
  fi
  if [[ -e "$TARGET_DIR/data" ]]; then
    loud "ROLLBACK REFUSED TO FINISH: $TARGET_DIR/data appeared during the restore — leaving the broken tree at ${TARGET_DIR}.broken for inspection."
    return 1
  fi
  chown -R "$CHROME_USER:$CHROME_USER" "$TARGET_DIR"

  # The rebuild. Same install+build the stage path runs, as the same user, in the
  # restored tree, BEFORE anything is pointed at it. Bounded by
  # RESTORE_BUILD_TIMEOUT; run exactly once. A non-zero result here is a FAILED
  # restore, not a reason to try again.
  say "ROLLBACK: rebuilding the restored release (npm ci + npm run build as $CHROME_USER, bounded at ${RESTORE_BUILD_TIMEOUT}s) — the rollback point is a bare source tree (dist/ and node_modules/ are never copied)"
  # `|| rc=$?` (not a bare call then `rc=$?`): under `set -e` a failing build
  # would abort the script before the exit code could be read and reported. This
  # way the failure is CAPTURED and named below instead of killing the rollback.
  timeout -k "$RESTORE_BUILD_KILL_GRACE" "$RESTORE_BUILD_TIMEOUT" \
    sudo -u "$CHROME_USER" -H bash -lc "cd '$TARGET_DIR' && npm ci --no-audit --no-fund && npm run build" \
    || rc=$?
  if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
    loud "ROLLBACK FAILED: the restore rebuild was KILLED after ${RESTORE_BUILD_TIMEOUT}s (timeout) — the previous release could not be rebuilt. Broken tree at ${TARGET_DIR}.broken, source at $ROLLBACK_DIR. NOT restarting a half-built tree."
    return 1
  fi
  if [[ "$rc" -ne 0 ]]; then
    loud "ROLLBACK FAILED: the restore rebuild FAILED (npm ci/build exit $rc) — the previous release is restored as SOURCE but has no working build. Broken tree at ${TARGET_DIR}.broken, source at $ROLLBACK_DIR. NOT restarting a half-built tree."
    return 1
  fi
  if [[ ! -f "$TARGET_DIR/dist/cli.js" ]]; then
    loud "ROLLBACK FAILED: the restore rebuild produced no $TARGET_DIR/dist/cli.js — the previous release cannot be served. Broken tree at ${TARGET_DIR}.broken, source at $ROLLBACK_DIR."
    return 1
  fi
  # Re-assert the vault AFTER the build: `npm ci` is the one step in the restore
  # that writes into the tree from the network, and it must not be able to leave a
  # `data/` behind either.
  if [[ -e "$TARGET_DIR/data" ]]; then
    loud "ROLLBACK REFUSED TO FINISH: $TARGET_DIR/data appeared during the restore rebuild — leaving the broken tree at ${TARGET_DIR}.broken for inspection."
    return 1
  fi
  say "ROLLBACK: rebuild OK (dist/cli.js present, vault still absent)"

  # Stamp the restored tree with the RESTORED release's own commit — read from
  # the live stamp before the preserve rsync, not from the repo (whose HEAD is
  # the deploy that just failed, i.e. the build we are rolling back FROM). After
  # the rebuild, before the restart, for the same reason the stage path stamps
  # there. When the previous release carried no resolvable stamp, NOTHING is
  # written and the restored service reports `unknown` — never the failed
  # deploy's commit, and never a placeholder.
  write_build_stamp "$TARGET_DIR" "$PREV_COMMIT" "$PREV_DIRTY"

  say "previous release restored AND rebuilt from $ROLLBACK_DIR; restarting the service on it"
  if systemctl list-unit-files ui2api-api.service >/dev/null 2>&1 \
     && systemctl cat ui2api-api.service >/dev/null 2>&1; then
    systemctl restart ui2api-api.service \
      || loud "ROLLBACK WARNING: the restart of the previous release FAILED — read the journal before trusting the service."
  fi
  if wait_healthy "$RESTORE_HEALTH_ATTEMPTS" "$HEALTH_INTERVAL"; then
    loud "ROLLBACK OK: the previous release is rebuilt, live and answering again (broken tree kept at ${TARGET_DIR}.broken for diagnosis). The deploy that just failed is REVERTED."
  else
    loud "ROLLBACK UNPROVEN: the previous release is restored and rebuilt but did not answer /health within $((RESTORE_HEALTH_ATTEMPTS * HEALTH_INTERVAL))s — read the journal; the service is NOT known-good."
  fi
  return 0
}

# --- 1. stage the code -------------------------------------------------------
# `data/` is excluded in every form it can appear as: the real dir, a trailing
# slash, and the .gitignore'd path. Getting this wrong would ship a developer's
# captured credentials into an install dir, so the exclusion is asserted below
# rather than trusted.
say "staging $REPO_DIR -> $TARGET_DIR"
mkdir -p "$TARGET_DIR"
rsync -a --delete \
  --exclude 'data/' --exclude '/data' \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' \
  --exclude '.brain/' --exclude 'sites/' --exclude '.agents/' --exclude '.opencode/' \
  --exclude 'graphify-out/' \
  "$REPO_DIR/" "$TARGET_DIR/"

if [[ -e "$TARGET_DIR/data" ]]; then
  fail "$TARGET_DIR/data exists — a deploy must never create or replace the vault"
fi
say "staged; vault is NOT in the target (asserted)"

# --- 2. install + build, as the service user ---------------------------------
# Build BEFORE the service is pointed at the new tree, so a compile error fails
# the deploy instead of leaving a service that starts and serves nothing.
say "npm ci + build as $CHROME_USER"
chown -R "$CHROME_USER:$CHROME_USER" "$TARGET_DIR"
sudo -u "$CHROME_USER" -H bash -lc "cd '$TARGET_DIR' && npm ci --no-audit --no-fund && npm run build" \
  || fail "install/build failed — the service was NOT restarted and still serves the previous release"

[[ -f "$TARGET_DIR/dist/cli.js" ]] || fail "dist/cli.js missing after build"

# The vault is re-asserted AFTER the build, not only before the rsync: `npm ci`
# is the one step in the deploy that writes into the tree from the network, and
# it must not be able to leave a `data/` behind either. Symmetric with the
# post-build assertion in `rollback()`.
if [[ -e "$TARGET_DIR/data" ]]; then
  fail "$TARGET_DIR/data appeared during the install/build — a deploy must never create or replace the vault"
fi
say "build OK (dist/cli.js present, vault still absent)"

# The build stamp, written AFTER the build that produced dist/ and BEFORE the
# restart, so the service can only ever start on a tree whose stamp already
# describes it. It is derived from the REPO (which has `.git`), not from the
# target (which does not) — see `write_build_stamp` for the rules.
DEPLOY_COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)"
# A sha the repository cannot vouch for is not a build identity. Verified, not
# assumed: `rev-parse HEAD` can name an object that was pruned or never existed.
if [[ -n "$DEPLOY_COMMIT" ]] && ! git -C "$REPO_DIR" cat-file -e "${DEPLOY_COMMIT}^{commit}" 2>/dev/null; then
  say "HEAD ($DEPLOY_COMMIT) is not a commit object in $REPO_DIR — treating the build identity as UNRESOLVED (no stamp will be written)"
  DEPLOY_COMMIT=""
fi
if [[ -n "$DEPLOY_COMMIT" ]]; then
  if [[ -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null || true)" ]]; then
    DEPLOY_DIRTY=true
  else
    DEPLOY_DIRTY=false
  fi
else
  DEPLOY_DIRTY=null
fi
write_build_stamp "$TARGET_DIR" "$DEPLOY_COMMIT" "$DEPLOY_DIRTY"

# --- 3. restart --------------------------------------------------------------
if [[ "$DO_RESTART" -eq 1 ]]; then
  if systemctl list-unit-files ui2api-api.service >/dev/null 2>&1 \
     && systemctl cat ui2api-api.service >/dev/null 2>&1; then
    say "restarting ui2api-api.service"
    systemctl restart ui2api-api.service
  else
    say "ui2api-api.service not installed — skipping restart (run scripts/ops/provision-ui2api-user.sh first)"
  fi
else
  say "--no-restart: leaving the running service alone"
fi

# --- 4. health check ---------------------------------------------------------
# The deploy is only successful if the API answers AND serves. A green exit with
# a dead service — or with a service that answers `ok:true` and has nothing
# behind it — is the exact failure this script exists to prevent, so the check
# is part of the exit status, not a log line, and a failure ROLLS BACK.
if [[ "$DO_RESTART" -eq 1 ]]; then
  say "health gate: /health must be 2xx AND parse as JSON with ok:true (connection refused, any non-2xx, an unparseable body and ok!==true all FAIL)"
  ok=0
  for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if health_probe_once; then ok=1; break; fi
    sleep "$HEALTH_INTERVAL"
  done
  if [[ "$ok" -ne 1 ]]; then
    say "health check FAILED — last journal lines:"
    journalctl -u ui2api-api.service -n 30 --no-pager 2>/dev/null || true
    rollback "the new release never became healthy"
    fail "deploy FAILED and was ROLLED BACK to the previous release; exit nonzero on purpose"
  fi
  say "health OK"
  if ! assert_surface; then
    say "surface check FAILED — last journal lines:"
    journalctl -u ui2api-api.service -n 30 --no-pager 2>/dev/null || true
    rollback "the new release is alive but serves an empty/incorrect surface"
    fail "deploy FAILED and was ROLLED BACK to the previous release; exit nonzero on purpose"
  fi
  if ! warn_accounts; then
    say "vault check FAILED — last journal lines:"
    journalctl -u ui2api-api.service -n 30 --no-pager 2>/dev/null || true
    rollback "the new release cannot read the session vault"
    fail "deploy FAILED and was ROLLED BACK to the previous release; exit nonzero on purpose"
  fi
  say "surface OK: registry + /v1/models serve real entries, vault readable"
fi

say "deployed $REPO_DIR -> $TARGET_DIR (commit $(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown))"
