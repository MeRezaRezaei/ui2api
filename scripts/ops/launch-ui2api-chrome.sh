#!/bin/bash
# Corrected launcher: long-lived headed Chrome AS the ui2api OS user (verbatim 1495/1897,
# .brain/verbatim.md 1115: "Long-lived Chrome as ui2api user, debug port 9222").
# Never the `me` user's Chrome, never :20/:10 displays.
set -u
# Parametrized: the OS user to run Chrome as, and the profile dir to use.
# Defaults keep a working headless-box setup without hardcoding a username.
RUN_AS="${UI2API_OS_USER:-ui2api}"
CHROME_PROFILE_DIR="${UI2API_USER_DATA_DIR:-/tmp/ui2api-chrome-profile}"
XVFB_DISPLAY=":99"
START_XVFB="${1:-yes}"
if [ "$START_XVFB" = "yes" ]; then
  sudo -n -u "$RUN_AS" /usr/bin/Xvfb "$XVFB_DISPLAY" -screen 0 1600x1000x24 -nolisten tcp &
  sleep 1.5
fi
sudo -n -u "$RUN_AS" env DISPLAY="$XVFB_DISPLAY" \
  /usr/bin/google-chrome \
  --user-data-dir="$CHROME_PROFILE_DIR" \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check \
  --disable-features=Translate,MediaRouter \
  about:blank
