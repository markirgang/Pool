#!/bin/bash
# Full-screen pool app on the Pi's touchscreen. Started from the labwc
# autostart that kiosk-mode.sh installs; relaunches Chromium if it exits.

POOL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${POOL_PORT:-2490}"
PROFILE="$HOME/.config/pool-kiosk"
LOCK="${XDG_RUNTIME_DIR:-/tmp}/pool-kiosk.lock"

exec 9>"$LOCK"
flock -n 9 || exit 0

token() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("auth", {}).get("kiosk_token", ""))' \
    "$POOL_DIR/config.local.json" 2>/dev/null
}

until curl -sf -o /dev/null "http://localhost:$PORT/api/status"; do
  sleep 2
done

while true; do
  # Stop Chromium offering to "restore pages" after a power cut.
  prefs="$PROFILE/Default/Preferences"
  if [ -f "$prefs" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$prefs"
  fi

  url="http://localhost:$PORT/?kiosk=1"
  t="$(token)"
  [ -n "$t" ] && url="http://localhost:$PORT/kiosk?token=$t"

  chromium \
    --kiosk \
    --user-data-dir="$PROFILE" \
    --ozone-platform=wayland \
    --enable-wayland-ime \
    --touch-events=enabled \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --disable-features=TranslateUI,OverscrollHistoryNavigation \
    --autoplay-policy=no-user-gesture-required \
    --no-first-run \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --password-store=basic \
    --check-for-update-interval=31536000 \
    "$url"
  sleep 3
done
