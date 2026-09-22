#!/bin/bash
# Corrected launcher: long-lived headed Chrome AS the ui2api OS user (verbatim 1495/1897,
# docs/verbatim.md 1115: "Long-lived Chrome as ui2api user, debug port 9222").
# Never the `me` user's Chrome, never :20/:10 displays.
set -u
XVFB_DISPLAY=":99"
START_XVFB="${1:-yes}"
if [ "$START_XVFB" = "yes" ]; then
  sudo -n -u ui2api /usr/bin/Xvfb "$XVFB_DISPLAY" -screen 0 1600x1000x24 -nolisten tcp &
  sleep 1.5
fi
sudo -n -u ui2api env DISPLAY="$XVFB_DISPLAY" \
  /usr/bin/google-chrome \
  --user-data-dir=/home/ui2api/.config/google-chrome \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check \
  --disable-features=Translate,MediaRouter \
  about:blank
