#!/bin/bash
# Switch the Pi between booting into the pool app full-screen ("on") and the
# normal Raspberry Pi desktop ("off"). Takes effect immediately.
#
#   kiosk/kiosk-mode.sh on [now]|off|status
#
# "on" takes effect at the next boot; "on now" also switches the screen over
# straight away.
#
# From kiosk mode, plug in a keyboard and press Ctrl+Alt+T for a terminal.

KIOSK_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTOSTART="$HOME/.config/labwc/autostart"
MARKER="# pool-kiosk"

is_on() { grep -qs "^$MARKER" "$AUTOSTART"; }

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
      pkill -f 'lwrespawn /usr/bin/(wf-panel-pi|pcmanfm-pi)'
      pkill -f wf-panel-pi
      pkill -f pcmanfm-pi
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
    pkill -f "$KIOSK_DIR/pool-kiosk.sh"
    pkill -f 'chromium.*pool-kiosk'
    if [ -n "$WAYLAND_DISPLAY" ]; then
      pgrep -f wf-panel-pi >/dev/null || setsid /usr/bin/lwrespawn /usr/bin/wf-panel-pi >/dev/null 2>&1 < /dev/null &
      pgrep -f pcmanfm-pi >/dev/null || setsid /usr/bin/lwrespawn /usr/bin/pcmanfm-pi >/dev/null 2>&1 < /dev/null &
    fi
    desktop_icon
    echo "Kiosk mode off: the Pi boots to the normal desktop."
    ;;
  status)
    if is_on; then echo "Kiosk mode is on"; else echo "Kiosk mode is off"; fi
    ;;
  *)
    echo "Usage: $0 on [now]|off|status" >&2
    exit 1
    ;;
esac
