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
# deleted, and never overwritten by a deploy. The service reaches it through
# UI2API_DATA_DIR, which is set in the unit, NOT in this script.
#
# Usage:  sudo ./scripts/ops/deploy.sh [--repo DIR] [--target DIR] [--no-restart]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# ROUND N+99: this used to read a UI2API_DEPLOY_DIR knob. Removed: the unit
# already pins WorkingDirectory and the ExecStart path, so nothing at runtime needed
# it, and `--target` is how you point the script somewhere else. A knob that shipped
# code reads and no documented row explains is a knob nobody can reason about --
# the env-knob table gate caught it on pipeline 299.
TARGET_DIR="/opt/ui2api"
CHROME_USER="${UI2API_CHROME_USER:-ui2api}"
API_PORT="${UI2API_PROMPTD_PORT:-9797}"
DO_RESTART=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_DIR="$2"; shift 2 ;;
    --target) TARGET_DIR="$2"; shift 2 ;;
    --no-restart) DO_RESTART=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] FATAL: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail "must run as root (systemctl + chown)"
id -u "$CHROME_USER" >/dev/null 2>&1 || fail "user $CHROME_USER does not exist"
[[ -f "$REPO_DIR/package.json" ]] || fail "no package.json in $REPO_DIR — bad --repo?"

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
# The deploy is only successful if the API answers. A green exit with a dead
# service is the exact failure this script exists to prevent, so the check is
# part of the exit status, not a log line.
if [[ "$DO_RESTART" -eq 1 ]]; then
  say "waiting for GET /health on 127.0.0.1:$API_PORT"
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [[ "$ok" -ne 1 ]]; then
    say "health check FAILED — last journal lines:"
    journalctl -u ui2api-api.service -n 30 --no-pager 2>/dev/null || true
    fail "the service did not become healthy; the previous release is NOT restored automatically — check the journal above"
  fi
  say "health OK: $(curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/health" 2>/dev/null | head -c 200)"
fi

say "deployed $REPO_DIR -> $TARGET_DIR (commit $(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown))"
