#!/usr/bin/env bash
# restart-policy.sh — a real, runnable supervisor check for ui2api-api.
#
# WHY THIS EXISTS
#   Measured across five restarts of ui2api-api: NRestarts=0. Every restart so
#   far was deliberate, so `Restart=always` / `RestartSec=5` — the policy that is
#   supposed to rescue a crashed service — has never actually fired. Nobody knows
#   it works, because nothing has ever needed it.
#
#   And the failure it would need to catch is SILENT. With the vault owned by the
#   wrong user, the service answered GET /health -> ok:true and served /v1/models
#   with 22 models for 23 minutes while every chat site failed with
#   "requires sign-in". A process that is running and answering is NOT a process
#   that is working, and nothing told the difference.
#
# SO THIS CHECKS MEANINGFUL STATE, NOT A CONSTANT:
#   1. /health                       — the process is up and answering at all
#   2. /registry   (packages count)  — the package surface is actually visible
#   3. /v1/models  (model count)     — the chat surface is actually served
#   4. /accounts?site=<chat site>    — THE VAULT IS READABLE (usable accounts)
# Probe 4 is the one the measured incident needed and health did not catch.
#
# THREE STATES, said out loud, not collapsed into ok/not-ok:
#   healthy               — every probe passed
#   degraded-but-serving  — the process answers, but the meaningful surface is
#                           broken (e.g. health 200 but no usable account)
#   dead                  — the process does not answer / the unit is not active
#   crash-looping         — reported as its own signal: NRestarts climbing.
#                           A service that restarts repeatedly is a DIFFERENT
#                           problem from a service that is merely wrong, and
#                           restarting again will not fix it.
#
# DRY RUN BY DEFAULT. Same rule as tightenVaultModes, for the same reason: a
# supervisor that mutates on inspection is not a supervisor. --apply is the
# explicit opt-in that lets it restart the unit.
#
# Every probe is individually bounded and so is the whole run. Exit codes:
#   0 healthy
#   3 degraded-but-serving
#   4 dead
#   5 crash-looping (NRestarts at/over --max-restarts)
#   2 usage error / tooling problem
#   124 the whole-run timeout tripped (a hang is a NAMED failure, not a shrug)

set -uo pipefail

SERVICE="${UI2API_SERVICE:-ui2api-api}"
BASE_URL="${UI2API_BASE_URL:-http://127.0.0.1:9797}"
# The chat site whose vault is read. gemini is a packaged chat site, so a
# readable vault is the difference between "22 models that all fail" and real
# service.
VAULT_SITE="${UI2API_VAULT_SITE:-gemini}"
PROBE_TIMEOUT="${UI2API_PROBE_TIMEOUT:-8}"
RUN_TIMEOUT="${UI2API_RUN_TIMEOUT:-90}"
MIN_PACKAGES="${UI2API_MIN_PACKAGES:-1}"
MIN_MODELS="${UI2API_MIN_MODELS:-1}"
MAX_RESTARTS="${UI2API_MAX_RESTARTS:-3}"
BODY_CAP_BYTES="${UI2API_BODY_CAP_BYTES:-20000000}"

# The caller's ORIGINAL argv, replayed verbatim into the bounded inner pass so
# the mode the operator asked for is never re-derived by this wrapper.
CALLER_ARGS=("$@")
APPLY=0
APPLY_FLAG="--dry-run"
MODE="dry-run"
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; APPLY_FLAG="--apply"; MODE="apply"; shift ;;
    --dry-run) APPLY=0; MODE="dry-run"; shift ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --vault-site) VAULT_SITE="${2:-}"; shift 2 ;;
    --max-restarts) MAX_RESTARTS="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "FATAL: curl is required" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "FATAL: node is required" >&2; exit 2; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# The whole run is bounded: re-enter this script once under `timeout`, guarded by
# a flag so the inner pass does not re-wrap itself. This is the outer guard on a
# hang — a hang is a NAMED failure (exit 124), not a shrug.
if [ -z "${UI2API_RESTART_POLICY_BOUNDED:-}" ]; then
  timeout -k 5 "$RUN_TIMEOUT" env \
      SERVICE="$SERVICE" BASE_URL="$BASE_URL" VAULT_SITE="$VAULT_SITE" \
      PROBE_TIMEOUT="$PROBE_TIMEOUT" RUN_TIMEOUT="$RUN_TIMEOUT" \
      MIN_PACKAGES="$MIN_PACKAGES" MIN_MODELS="$MIN_MODELS" \
      MAX_RESTARTS="$MAX_RESTARTS" BODY_CAP_BYTES="$BODY_CAP_BYTES" \
      UI2API_RESTART_POLICY_BOUNDED=1 \
      bash "$0" ${CALLER_ARGS[@]+"${CALLER_ARGS[@]}"}
  rc=$?
  if [ "$rc" = 124 ]; then
    echo "FATAL: whole-run timeout (${RUN_TIMEOUT}s) tripped — a hang is a named failure" >&2
  fi
  exit "$rc"
fi

# ---------------------------------------------------------------- helpers
# probe <name> <path> -> writes the body to $WORKDIR/<name>.json, echoes the
# http code; nonzero exit means the transport failed or the body is unusable.
probe() {
  local name="$1" path="$2" code
  code="$(curl -sS --max-time "$PROBE_TIMEOUT" --max-filesize "$BODY_CAP_BYTES" \
      -o "$WORKDIR/$name.json" -w '%{http_code}' "$BASE_URL$path" 2>"$WORKDIR/$name.err")"
  local rc=$?
  if [ "$rc" != 0 ]; then
    echo "$name: TRANSPORT-FAIL (curl rc=$rc: $(tr -d '\n' < "$WORKDIR/$name.err" | head -c 160))"
    return 1
  fi
  echo "$name: http=$code"
  [ "$code" = "200" ] || return 1
  return 0
}

# jsoncount <name> <js-expression-on-`d`> -> echoes a number, or nothing on error
jsoncount() {
  node -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = (new Function("d", "return (" + process.argv[2] + ");"))(d);
    if (v === undefined || v === null) process.exit(3);
    console.log(typeof v === "number" ? v : String(v).length);
  ' "$WORKDIR/$1.json" "$2" 2>/dev/null | sed -e 's/\x1b\[[0-9;]*m//g'
}

say() { printf '%s\n' "$*"; }
RESULT_HEALTH="skip"; RESULT_REGISTRY="skip"; RESULT_MODELS="skip"; RESULT_VAULT="skip"
FAILURES=0
note_fail() { FAILURES=$((FAILURES + 1)); }

# ------------------------------------------------------------- NRestarts
# A service that keeps restarting is a different problem from a service that is
# merely wrong, and restarting it again does not fix that. Read the counter
# systemd itself keeps.
NRESTARTS="unknown"
if command -v systemctl >/dev/null 2>&1; then
  n="$(timeout -k 2 "$PROBE_TIMEOUT" systemctl show "$SERVICE" -p NRestarts --value 2>/dev/null)"
  [ -n "$n" ] && NRESTARTS="$n"
  u="$(timeout -k 2 "$PROBE_TIMEOUT" systemctl is-active "$SERVICE" 2>/dev/null)"
  UNIT_STATE="${u:-unknown}"
else
  UNIT_STATE="no-systemctl"
fi
say "unit: $SERVICE is-active=$UNIT_STATE NRestarts=$NRESTARTS (mode=$MODE)"

CRASH_LOOP=0
if [ "$NRESTARTS" != "unknown" ] && [ "$NRESTARTS" -ge "$MAX_RESTARTS" ] 2>/dev/null; then
  CRASH_LOOP=1
  say "CRASH-LOOP: NRestarts=$NRESTARTS >= max=$MAX_RESTARTS — restarting again will NOT fix this; report it instead"
fi

# ------------------------------------------------------------------ probes
say ""
say "== probes (each bounded at ${PROBE_TIMEOUT}s) =="

if probe health /health; then
  ok="$(jsoncount health 'd && d.ok === true ? 1 : 0')"
  if [ "${ok:-0}" = "1" ]; then RESULT_HEALTH="ok"; say "  health: ok:true"
  else RESULT_HEALTH="bad"; note_fail; say "  health: reachable but ok!=true"; fi
else
  RESULT_HEALTH="fail"; note_fail
fi

if probe registry /registry; then
  n="$(jsoncount registry 'Array.isArray(d.packages) ? d.packages.length : -1')"
  if [ -n "$n" ] && [ "$n" -ge "$MIN_PACKAGES" ] 2>/dev/null; then
    RESULT_REGISTRY="ok ($n packages)"; say "  registry: $n packages (min $MIN_PACKAGES)"
  else
    RESULT_REGISTRY="empty"; note_fail; say "  registry: ${n:-unreadable} packages — expected >= $MIN_PACKAGES"
  fi
else
  RESULT_REGISTRY="fail"; note_fail
fi

if probe models /v1/models; then
  n="$(jsoncount models 'Array.isArray(d.data) ? d.data.length : -1')"
  if [ -n "$n" ] && [ "$n" -ge "$MIN_MODELS" ] 2>/dev/null; then
    RESULT_MODELS="ok ($n models)"; say "  models: $n models (min $MIN_MODELS)"
  else
    RESULT_MODELS="empty"; note_fail; say "  models: ${n:-unreadable} models — expected >= $MIN_MODELS"
  fi
else
  RESULT_MODELS="fail"; note_fail
fi

# THE VAULT PROBE. /health being 200 while this is empty is precisely the
# measured 23-minute silent failure. Removing this line must fail the gate.
if probe vault "/accounts?site=$VAULT_SITE"; then
  n="$(jsoncount vault 'Array.isArray(d.accounts) ? d.accounts.filter(a => a && (a.usable === true)).length : -1')"
  if [ -n "$n" ] && [ "$n" -ge 1 ] 2>/dev/null; then
    RESULT_VAULT="ok ($n usable accounts)"; say "  vault: $n usable account(s) for $VAULT_SITE"
  else
    RESULT_VAULT="unreadable"; note_fail
    say "  vault: NO usable account for $VAULT_SITE — serving a surface that will fail every site"
  fi
else
  RESULT_VAULT="fail"; note_fail
fi

# ----------------------------------------------------------------- verdict
say ""
say "== verdict =="
say "  health   : $RESULT_HEALTH"
say "  registry : $RESULT_REGISTRY"
say "  models   : $RESULT_MODELS"
say "  vault    : $RESULT_VAULT"

VERDICT="healthy"
RC=0
if [ "$CRASH_LOOP" = 1 ]; then
  VERDICT="crash-looping"; RC=5
elif [ "$RESULT_HEALTH" = "fail" ] || [ "$UNIT_STATE" != "active" ]; then
  VERDICT="dead"; RC=4
elif [ "$FAILURES" -gt 0 ]; then
  VERDICT="degraded-but-serving"; RC=3
fi
say "  VERDICT: $VERDICT"

# ------------------------------------------------------------------- action
if [ "$VERDICT" = "healthy" ]; then
  say "  action: none needed (mode=$MODE)"
elif [ "$APPLY" = 1 ]; then
  say "  action: --apply given -> restarting $SERVICE"
  if [ "$CRASH_LOOP" = 1 ]; then
    say "  action: SKIPPED — a crash-looping service is not fixed by another restart; fix the cause first"
  elif command -v systemctl >/dev/null 2>&1; then
    if timeout -k 5 30 sudo -n systemctl restart "$SERVICE" 2>&1; then
      say "  action: restart issued; re-run this script to confirm"
    else
      say "  action: restart FAILED (nonzero from systemctl)"
      RC=$(( RC == 0 ? 1 : RC ))
    fi
  else
    say "  action: cannot restart — systemctl unavailable"
  fi
else
  say "  action: DRY RUN — nothing was restarted. Re-run with --apply to act."
fi

exit "$RC"
