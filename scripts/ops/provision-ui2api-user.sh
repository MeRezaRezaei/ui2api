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
# This script makes that reproducible on a fresh box, and registers both
# long-lived services with systemd so they survive a reboot:
#   1. ui2api-chrome.service  the ONE persistent Chrome (CDP on 127.0.0.1:9222)
#   2. ui2api-api.service     promptd — the HTTP API other programs call
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
if [[ "$DO_SYSTEMD" -eq 1 ]] && have systemctl; then
  UNIT_DIR="/etc/systemd/system"

  # The VIRTUAL DISPLAY. MEASURED: headless is what gets us blocked — the same
  # site answers ERR_CHALLENGE headless and returns a real DOM-read answer
  # headed on Xvfb. So the display is a first-class service, not a convenience.
  cat > "$UNIT_DIR/ui2api-xvfb.service" <<EOF
[Unit]
Description=ui2api virtual display (Xvfb :99) — a headed Chrome needs a real X display
Before=ui2api-chrome.service

[Service]
Type=simple
User=$CHROME_USER
Group=$CHROME_USER
ExecStart=/usr/bin/Xvfb :$XVFB_DISPLAY -screen 0 1920x1080x24 -nolisten tcp
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  # The ONE persistent Chrome, HEADED, on that display. Started once; every
  # request ATTACHES over CDP.
  # Restart=on-failure only — a clean stop must NOT resurrect it, or `chrome stop`
  # would be undone by systemd a second later.
  cat > "$UNIT_DIR/ui2api-chrome.service" <<EOF
[Unit]
Description=ui2api persistent Chrome (the point of use for the $CHROME_USER user)
Documentation=file://$REPO_DIR/docs/CHROME_POINT_OF_USE.md
After=ui2api-xvfb.service
Requires=ui2api-xvfb.service

[Service]
Type=simple
User=$CHROME_USER
Group=$CHROME_USER
Environment=HOME=$USER_HOME
Environment=UI2API_CHROME_USER=$CHROME_USER
Environment=UI2API_DAEMON_PORT=$DAEMON_PORT
Environment=DISPLAY=:$XVFB_DISPLAY
ExecStart=$CHROME_BIN \\
  --no-first-run --no-default-browser-check \\
  --disable-background-networking --disable-component-update \\
  --mute-audio --disable-hang-monitor \\
  --disable-v8-idle-tasks --disable-background-timer-throttling \\
  --disable-renderer-backgrounding \\
  --remote-debugging-port=$DAEMON_PORT --remote-debugging-address=127.0.0.1 \\
  --user-data-dir=$USER_HOME/$CHROME_DIR \\
  about:blank
Restart=on-failure
RestartSec=3
# One instance per profile is a CHROME rule, not ours: let systemd's stop win.
KillMode=mixed
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=false

[Install]
WantedBy=multi-user.target
EOF

  # The API other programs call. Loopback only: the daemon binds 127.0.0.1 by
  # design (the package inventory and any token are not LAN-visible).
  cat > "$UNIT_DIR/ui2api-api.service" <<EOF
[Unit]
Description=ui2api API (promptd) — OpenAI-compatible + capability endpoints
Documentation=file://$REPO_DIR/README.md
After=network-online.target ui2api-chrome.service
Wants=ui2api-chrome.service

[Service]
Type=simple
User=$CHROME_USER
Group=$CHROME_USER
WorkingDirectory=$REPO_DIR
Environment=HOME=$USER_HOME
Environment=UI2API_CHROME_USER=$CHROME_USER
Environment=UI2API_PROMPTD_PORT=$API_PORT
Environment=UI2API_ATTACH_PORT=$DAEMON_PORT
Environment=UI2API_HEADED=1
Environment=DISPLAY=:$XVFB_DISPLAY
Environment=NODE_ENV=production
ExecStart=/usr/bin/env npx tsx $REPO_DIR/src/cli.ts promptd
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
# The browser pool needs a real HOME for the profile; PrivateTmp would hide it.
PrivateTmp=false

[Install]
WantedBy=multi-user.target
EOF

  say "wrote ui2api-xvfb.service, ui2api-chrome.service and ui2api-api.service"
  systemctl daemon-reload
  systemctl enable ui2api-xvfb.service ui2api-chrome.service ui2api-api.service >/dev/null 2>&1 \
    && say "enabled both units at boot" || say "could not enable (container?) — start them manually"
  systemctl restart ui2api-chrome.service 2>/dev/null && say "started ui2api-chrome" || say "chrome unit not started here"
  systemctl restart ui2api-api.service 2>/dev/null && say "started ui2api-api" || say "api unit not started here"
else
  say "skipping systemd (--no-systemd, or systemctl unavailable)"
fi

# ------------------------------------------------------------------ report ----
say "--- verify ---"
sudo -u "$CHROME_USER" -H npx tsx "$REPO_DIR/src/cli.ts" chrome status 2>/dev/null || true
say "provisioning complete. To log in without copying your profile: xhost + , then run"
say "  sudo -u $CHROME_USER -H $CHROME_BIN --user-data-dir=$USER_HOME/$CHROME_DIR"
say "and log in by hand; the credentials are ingested by the normal profile path."
