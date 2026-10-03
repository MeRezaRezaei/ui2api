#!/usr/bin/env bash
# Provision the ui2api point of use, and make it always-on.
#
# THE MODEL (see docs/CHROME_POINT_OF_USE.md): ui2api drives the Chrome of a
# DEDICATED Linux user, not the operator's interactive browser — Chrome refuses
# to let another process attach to a browser a person is using, and refuses
# --remote-debugging-port on a live profile. The dedicated user's Chrome works
# fine, headless included, so the ONLY required setup is that this user's Chrome
# info exists. Writing the Chrome info into that user IS the integration.
#
# This script makes that reproducible on a fresh box, and registers the three
# long-lived services with systemd so they survive a reboot:
#   1. ui2api-xvfb.service    the virtual display (without it the daemon is
#                             silently headless-degraded, and headless is what
#                             gets challenged)
#   2. ui2api-chrome.service  the ONE persistent Chrome (CDP on 127.0.0.1:9222)
#   3. ui2api-api.service     promptd — the HTTP API other programs call
#
# IT DOES NOT DEFINE THOSE UNITS. There is exactly one definition of them, in
# scripts/ops/units/, and exactly one installer that reads it from there,
# scripts/ops/install-services.sh. This script DELEGATES. See the systemd block
# below for why that is a correctness rule and not a style preference.
#
# IDEMPOTENT by construction: it creates what is missing, never overwrites an
# existing profile or a live session, and is safe to re-run.
#
# Usage:  sudo ./scripts/ops/provision-ui2api-user.sh [--no-systemd]
set -euo pipefail

# CHROME_USER allows a THROWAWAY user for testing the script without touching the
# real point of use. UI2API_CHROME_USER is the production knob.
CHROME_USER="${CHROME_USER:-${UI2API_CHROME_USER:-ui2api}}"
CHROME_DIR=".config/ui2api-chrome"
# DAEMON_PORT / XVFB_DISPLAY / API_PORT are MESSAGE-ONLY locals. MEASURED: the
# install path is install-services.sh, which copies scripts/ops/units/*.service
# verbatim (`install -m 0644`, no sed/envsubst/template anywhere), and the shipped
# units hardcode CDP :9222, promptd :9797 and DISPLAY=:99. Exporting
# UI2API_DAEMON_PORT / UI2API_PROMPTD_PORT / UI2API_XVFB_DISPLAY to this script
# therefore changes NOTHING that gets installed — which is also why these must
# never be interpolated into a sentence that describes what was installed. To
# move a value, edit the unit in scripts/ops/units/ and re-run
# scripts/ops/install-services.sh.
DAEMON_PORT="${UI2API_DAEMON_PORT:-9222}"
XVFB_DISPLAY="${UI2API_XVFB_DISPLAY:-99}"
API_PORT="${UI2API_PROMPTD_PORT:-9797}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DO_SYSTEMD=1
[[ "${1:-}" == "--no-systemd" ]] && DO_SYSTEMD=0

say() { printf '[provision] %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[provision] must run as root (creates a system user + systemd units): sudo $0 $*" >&2
  exit 1
fi

# ---------------------------------------------------------------- the user ----
if id -u "$CHROME_USER" >/dev/null 2>&1; then
  say "user $CHROME_USER exists (uid $(id -u "$CHROME_USER")) — not recreating"
else
  say "creating system user $CHROME_USER"
  if have useradd; then
    useradd --create-home --shell /bin/bash "$CHROME_USER"
  else
    adduser -D "$CHROME_USER"
  fi
fi
USER_HOME="$(getent passwd "$CHROME_USER" | cut -d: -f6)"
# SAFETY: an empty home would turn every path below into "/.config/...", i.e.
# writing at the FILESYSTEM ROOT. Refuse rather than create that.
if [[ -z "$USER_HOME" || "$USER_HOME" != /* ]]; then
  echo "[provision] refusing: no absolute home for '$CHROME_USER' (got '${USER_HOME}')" >&2
  echo "[provision] an empty home would create paths under / — aborting." >&2
  exit 1
fi
# MEASURED: an ABSOLUTE-but-nonexistent home (e.g. nobody -> /nonexistent) passed
# the "is it absolute" test and the script then created /nonexistent/.config/...
# The home must EXIST and be a directory, or we are writing outside the user's
# own space.
if [[ ! -d "$USER_HOME" ]]; then
  echo "[provision] refusing: home '$USER_HOME' for '$CHROME_USER' is not an existing directory" >&2
  echo "[provision] this account cannot own a Chrome profile — pick a real user." >&2
  exit 1
fi
say "home: $USER_HOME"

# ------------------------------------------------------- the profile dirs ----
# Create the Chrome profile DIRECTORY with the right ownership, but never touch
# its contents: a live session is the whole point of the dedicated user.
install -d -m 700 -o "$CHROME_USER" -g "$CHROME_USER" "$USER_HOME/$CHROME_DIR"
install -d -m 700 -o "$CHROME_USER" -g "$CHROME_USER" "$USER_HOME/.config/ui2api"
# A real Chrome profile is not an empty dir: seed the marker Chrome looks for, so
# the resolver recognises the profile without a browser ever having run.
if [[ ! -e "$USER_HOME/$CHROME_DIR/Default" ]]; then
  install -d -m 700 -o "$CHROME_USER" -g "$CHROME_USER" "$USER_HOME/$CHROME_DIR/Default"
  say "seeded $CHROME_DIR/Default (profile marker)"
else
  say "$CHROME_DIR/Default exists — leaving the live profile untouched"
fi

# ------------------------------------------------------- the Chrome binary ----
CHROME_BIN=""
for c in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
  [[ -x "$c" ]] && { CHROME_BIN="$c"; break; }
done
[[ -n "$CHROME_BIN" ]] || { echo "[provision] no Chrome/Chromium binary found — install one first" >&2; exit 1; }
say "chrome: $CHROME_BIN ($("$CHROME_BIN" --version 2>/dev/null | head -1))"

# ----------------------------------------------------------------- systemd ----
# DELEGATE. This script does not write a unit file, ever.
#
# WHY THE INLINE HEREDOCS ARE GONE (measured, not stylistic). This block used to
# `cat > "$UNIT_DIR/ui2api-api.service" <<EOF` its OWN copy of all three units,
# and that copy's api unit ran
#     ExecStart=/usr/bin/env npx tsx $REPO_DIR/src/cli.ts promptd
# — the daemon executing out of a GIT CHECKOUT. docs/DEPLOY.md step 1 is exactly
# this script, so a new operator following the documented first-time bootstrap
# SILENTLY REVERTED the service to the git-checkout daemon: the precise
# stale-daemon failure scripts/ops/deploy.sh exists to eliminate,
# reintroduced by the script the docs tell you to run FIRST. Two definitions of
# one unit is not redundancy, it is a coin flip, and the wrong side of it is a
# daemon serving code nobody deployed. The one definition now lives in
# scripts/ops/units/ and is installed only by scripts/ops/install-services.sh.
# test/prod-bootstrap-single-source.test.ts gates both halves of that.
if [[ "$DO_SYSTEMD" -eq 1 ]] && have systemctl; then
  UNIT_SRC="$REPO_DIR/scripts/ops/units"
  INSTALL_SERVICES="$REPO_DIR/scripts/ops/install-services.sh"

  if [[ ! -d "$UNIT_SRC" ]]; then
    echo "[provision] refusing: no unit definitions at $UNIT_SRC" >&2
    echo "[provision] the units live there and nowhere else; this script will not" >&2
    echo "[provision] synthesise them. Restore the directory (git checkout) and re-run." >&2
    exit 1
  fi
  if [[ ! -f "$INSTALL_SERVICES" ]]; then
    echo "[provision] refusing: no installer at $INSTALL_SERVICES" >&2
    echo "[provision] that installer is the only thing that reads $UNIT_SRC." >&2
    exit 1
  fi

  # HONEST NOTE ON $CHROME_USER. The shipped units are NOT parameterized by it.
  # ui2api-api.service hardcodes User=ui2api, ports 9222/9797, DISPLAY=:99 and
  # UI2API_CHROME_USER=ui2api; install-services.sh hardcodes `id -u ui2api`. So
  # delegating installs the PRODUCTION units regardless of what CHROME_USER is
  # here. That is the right outcome — a throwaway test user must not be able to
  # rewrite the real point of use — but it is not silent, and a reader who set
  # CHROME_USER expecting the units to follow must be told so out loud rather
  # than discovering it from a unit running as somebody else.
  if [[ "$CHROME_USER" != "ui2api" ]]; then
    say "CHROME_USER=$CHROME_USER is a THROWAWAY test user."
    say "the shipped units are NOT parameterized by it: they hardcode User=ui2api, CDP :9222, promptd :9797, DISPLAY=:99."
    say "your requested values are NOT applied — UI2API_DAEMON_PORT=$DAEMON_PORT, UI2API_PROMPTD_PORT=$API_PORT, UI2API_XVFB_DISPLAY=$XVFB_DISPLAY are read here for reporting only. install-services.sh copies the units verbatim, so :9222/:9797/:99 are what land. To move one, edit scripts/ops/units/*.service and re-run scripts/ops/install-services.sh."
    say "delegating installs the PRODUCTION units for 'ui2api' — that is intended, and the test user is NOT what ends up serving."
  fi

  # install-services.sh is itself idempotent (install -m 0644 + enable + restart),
  # so calling it on every run is safe and re-running converges rather than
  # accumulates. It is invoked as a script (not sourced) so its `set -euo
  # pipefail` and its own root check apply to it, not to this shell.
  say "installing the three units from $UNIT_SRC via install-services.sh (the single installer)"
  bash "$INSTALL_SERVICES"
  say "units installed from $UNIT_SRC — this script wrote no unit file"
  say "ui2api-api runs the DEPLOYED tree (/opt/ui2api/dist/cli.js); run scripts/ops/deploy.sh to ship the code and start it"
else
  say "skipping systemd (--no-systemd, or systemctl unavailable) — no units installed, and this script never writes one"
fi

# ------------------------------------------------------------------ report ----
say "--- verify ---"
sudo -u "$CHROME_USER" -H npx tsx "$REPO_DIR/src/cli.ts" chrome status 2>/dev/null || true
say "provisioning complete. To log in without copying your profile: xhost + , then run"
say "  sudo -u $CHROME_USER -H $CHROME_BIN --user-data-dir=$USER_HOME/$CHROME_DIR"
say "and log in by hand; the credentials are ingested by the normal profile path."
