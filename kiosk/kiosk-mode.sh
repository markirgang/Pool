#!/bin/bash
# Switch the Pi between booting into the pool app full-screen ("on") and the
# normal Raspberry Pi desktop ("off"). Takes effect immediately.
#
#   kiosk/kiosk-mode.sh on [now]|exit|off|status
#
# "on" takes effect at the next boot; "on now" also switches the screen over
# straight away. "exit" closes the kiosk and shows the desktop now but still
# boots into the kiosk next time (the app's Exit Kiosk button runs this).
# "off" stops booting into the kiosk.
#
# From kiosk mode, plug in a keyboard and press Ctrl+Alt+T for a terminal.

KIOSK_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTOSTART="$HOME/.config/labwc/autostart"
MARKER="# pool-kiosk"

is_on() { grep -qs "^$MARKER" "$AUTOSTART"; }

stop_kiosk() {
  pkill -f "$KIOSK_DIR/pool-kiosk.sh"
  pkill -f 'chromium.*pool-kiosk'
}

show_desktop() {
  if [ -n "$WAYLAND_DISPLAY" ]; then
    pgrep -f wf-panel-pi >/dev/null || setsid /usr/bin/lwrespawn /usr/bin/wf-panel-pi >/dev/null 2>&1 < /dev/null &
    pgrep -f pcmanfm-pi >/dev/null || setsid /usr/bin/lwrespawn /usr/bin/pcmanfm-pi >/dev/null 2>&1 < /dev/null &
  fi
}

desktop_icon() {
  mkdir -p "$HOME/Desktop"
  cat > "$HOME/Desktop/pool-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pool Touchscreen
Comment=Open the pool app full-screen and start it at every boot
Exec=$KIOSK_DIR/kiosk-mode.sh on now
Icon=applications-internet
Terminal=false
EOF
  chmod +x "$HOME/Desktop/pool-kiosk.desktop"
}

case "${1:-status}" in
  on)
    # Give the screen its own sign-in (guest by default) if it has none yet.
    python3 - "$KIOSK_DIR/../config.local.json" <<'PY'
import json, os, secrets, sys
path = sys.argv[1]
try:
    with open(path) as fh:
        data = json.load(fh)
except (OSError, ValueError):
    data = {}
auth = data.setdefault("auth", {})
if not auth.get("kiosk_token"):
    auth["kiosk_token"] = secrets.token_urlsafe(32)
    auth.setdefault("kiosk_user", "guest")
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with open(fd, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
    print("Created a touchscreen sign-in; restart the pool server to use it:")
    print("  systemctl --user restart pool.service")
PY
    mkdir -p "$(dirname "$AUTOSTART")"
    if [ -f "$AUTOSTART" ] && ! is_on; then
      cp "$AUTOSTART" "$AUTOSTART.before-kiosk"
    fi
    {
      echo "$MARKER (installed by $KIOSK_DIR/kiosk-mode.sh; run it with 'off' to undo)"
      echo "/usr/bin/kanshi &"
      echo "/usr/bin/lxsession-xdg-autostart"
      echo "$KIOSK_DIR/pool-kiosk.sh &"
    } > "$AUTOSTART"
    if [ "$2" = "now" ] && [ -n "$WAYLAND_DISPLAY" ]; then
      # pool-kiosk.sh hides the taskbar and desktop itself.
      setsid "$KIOSK_DIR/pool-kiosk.sh" >/dev/null 2>&1 < /dev/null &
    fi
    desktop_icon
    echo "Kiosk mode on: the Pi boots straight into the pool app."
    ;;
  off)
    if is_on; then
      rm -f "$AUTOSTART"
      [ -f "$AUTOSTART.before-kiosk" ] && mv "$AUTOSTART.before-kiosk" "$AUTOSTART"
    fi
    stop_kiosk
    show_desktop
    desktop_icon
    echo "Kiosk mode off: the Pi boots to the normal desktop."
    ;;
  exit)
    stop_kiosk
    show_desktop
    desktop_icon
    echo "Left kiosk mode for now; the Pi still boots into the pool app."
    ;;
  status)
    if is_on; then echo "Kiosk mode is on"; else echo "Kiosk mode is off"; fi
    ;;
  *)
    echo "Usage: $0 on [now]|exit|off|status" >&2
    exit 1
    ;;
esac
