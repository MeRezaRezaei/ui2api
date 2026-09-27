#!/usr/bin/env bash
# Install the three ui2api systemd units and enable them. Idempotent.
#
# Separate from provision-ui2api-user.sh on purpose: that script creates the USER
# and the Chrome PROFILE (touching credentials), this one only installs UNITS
# and points them at /opt/ui2api. A deploy needs the second; it must never need
# the first.
#
# Usage:  sudo ./scripts/ops/install-services.sh [--no-start]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_SRC="$REPO_DIR/scripts/ops/units"
UNIT_DIR=/etc/systemd/system
DO_START=1
[[ "${1:-}" == "--no-start" ]] && DO_START=0

say() { printf '[services] %s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
id -u ui2api >/dev/null 2>&1 || { echo "user ui2api missing — run scripts/ops/provision-ui2api-user.sh first" >&2; exit 1; }
[[ -d "$UNIT_SRC" ]] || { echo "no unit files at $UNIT_SRC" >&2; exit 1; }

for u in ui2api-xvfb ui2api-chrome ui2api-api; do
  install -m 0644 "$UNIT_SRC/$u.service" "$UNIT_DIR/$u.service"
  say "installed $u.service"
done

systemctl daemon-reload
systemctl enable ui2api-xvfb ui2api-chrome ui2api-api >/dev/null 2>&1 \
  && say "enabled all three at boot" || say "could not enable (container?) — start them manually"

if [[ "$DO_START" -eq 1 ]]; then
  systemctl restart ui2api-xvfb  2>/dev/null && say "started ui2api-xvfb"  || say "xvfb not started here"
  systemctl restart ui2api-chrome 2>/dev/null && say "started ui2api-chrome" || say "chrome not started here"
  say "run scripts/ops/deploy.sh to install the code and start ui2api-api"
fi
say "done"
