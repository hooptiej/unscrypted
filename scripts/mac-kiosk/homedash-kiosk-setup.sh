#!/bin/bash
# homedash-kiosk-setup.sh: one file, run it once on the living-room Mac.
# (Built from homedash-kiosk.sh and install.sh in this folder; keep them in step.)
#
#   bash homedash-kiosk-setup.sh              install: dashboard opens fullscreen now and at every login
#   bash homedash-kiosk-setup.sh settings     also make the Mac recover itself (asks for your password)
#   bash homedash-kiosk-setup.sh uninstall    stop it and remove it
#
#   HOMEDASH_URL=http://... HOMEDASH_WAIT=180 bash homedash-kiosk-setup.sh   bake other settings in
#   (default http://homedash.local, wait 180 s then open anyway)
#
# What install does: writes the launcher into ~/Library/Application Support/homedash-kiosk/ and a
# LaunchAgent that runs it at login and relaunches it if the browser crashes. Nothing else is touched.
# The browser runs in its own never-signed-in profile with sync disabled, so nothing it does
# can reach your other machines.
set -eu

LABEL="com.hooptiej.homedash-kiosk"
DEST="$HOME/Library/Application Support/homedash-kiosk"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
MODE="${1:-install}"
URL="${HOMEDASH_URL:-http://homedash.local}"
WAIT="${HOMEDASH_WAIT:-180}"

# Stop the running copy, if there is one. "Not loaded" is the only failure that's fine here.
stop_agent() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$LABEL"
  fi
}

case "$MODE" in
uninstall)
  stop_agent
  rm -f "$PLIST"
  echo "Removed the LaunchAgent. (Left $DEST in place; delete it by hand if you want.)"
  exit 0
  ;;
settings)
  echo "Making this Mac recover on its own. You will be asked for your password once."
  sudo pmset -a autorestart 1 sleep 0 displaysleep 0
  defaults -currentHost write com.apple.screensaver idleTime 0
  echo
  echo "Done: restarts after a power failure, never sleeps, no screen saver."
  echo "Still by hand: System Settings > Users & Groups > 'Automatically log in as' (this user),"
  echo "and Focus / Do Not Disturb on, so update pop-ups don't land on the display."
  exit 0
  ;;
install) ;;
*)
  echo "usage: bash $0 [install|settings|uninstall]" >&2
  exit 64
  ;;
esac

mkdir -p "$DEST" "$HOME/Library/LaunchAgents"

# ---- the launcher ---------------------------------------------------------------------------
cat > "$DEST/homedash-kiosk.sh" <<'KIOSK_EOF'
#!/bin/bash
# homedash-kiosk.sh: open the dashboard fullscreen on the living-room Mac and keep it that way.
#
# Run by a LaunchAgent at login (see install.sh). Safe to run by hand for testing.
#   HOMEDASH_URL      address to show (default http://homedash.local)
#   HOMEDASH_WAIT     seconds to wait for the dashboard to answer before opening it anyway
#                     (default 180; 0 = wait forever)
#   HOMEDASH_BROWSER  browser binary to use instead of the first Chromium-family one found
set -u

URL="${HOMEDASH_URL:-http://homedash.local}"
WAIT="${HOMEDASH_WAIT:-180}"
PROFILE="$HOME/Library/Application Support/homedash-kiosk/browser-profile"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') homedash-kiosk: $*"; }

case "$WAIT" in
  ''|*[!0-9]*) log "HOMEDASH_WAIT='$WAIT' isn't a whole number of seconds; waiting 180 s instead."; WAIT=180 ;;
esac

# The browser: HOMEDASH_BROWSER if set, else the first Chromium-family browser that is installed.
BROWSER=""
if [ -n "${HOMEDASH_BROWSER:-}" ]; then
  if [ ! -x "$HOMEDASH_BROWSER" ]; then
    log "HOMEDASH_BROWSER=$HOMEDASH_BROWSER isn't an executable file. Fix or unset it in the LaunchAgent." >&2
    exit 78   # configuration error; launchd will not hammer on it
  fi
  BROWSER="$HOMEDASH_BROWSER"
else
  for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
    bin="/Applications/$app.app/Contents/MacOS/$app"
    if [ -x "$bin" ]; then BROWSER="$bin"; break; fi
  done
fi
if [ -z "$BROWSER" ]; then
  log "no Chrome, Edge, Brave or Chromium found in /Applications (or set HOMEDASH_BROWSER)." >&2
  exit 78
fi

# After a power cut the NAS can come up after this Mac. Wait until the dashboard answers, so we don't
# open a browser onto an error page that nobody reloads. But never wait silently or forever: say what
# the probe sees every 30 s, and after HOMEDASH_WAIT seconds open the browser anyway (homedash#24:
# a probe that can never succeed must not hold the display hostage).
log "showing $URL with $BROWSER; waiting up to ${WAIT}s for $URL/healthz (0 = forever)."
waited=0
last_report=-30
while :; do
  if err="$(/usr/bin/curl -fsS -m 3 -o /dev/null "$URL/healthz" 2>&1)"; then
    log "the dashboard answered after ${waited}s; opening it."
    break
  fi
  if [ $((waited - last_report)) -ge 30 ]; then
    log "still waiting after ${waited}s; the probe saw: ${err:-no answer}"
    last_report=$waited
  fi
  if [ "$WAIT" -gt 0 ] && [ "$waited" -ge "$WAIT" ]; then
    log "gave up waiting after ${WAIT}s (last: ${err:-no answer}). Opening the browser anyway."
    log "If the name never resolves here (background launchd jobs can't always resolve .local names), set HOMEDASH_URL to the dashboard's IP, e.g. http://10.0.1.248, in the LaunchAgent."
    break
  fi
  sleep 5
  waited=$((waited + 5))
done

mkdir -p "$PROFILE"

# Keep the Mac and the display awake for as long as this process (the browser, after exec) lives.
/usr/bin/caffeinate -dimsu -w $$ &

# --disable-sync: this profile is never signed in, and sync is switched off outright, so nothing the
# display does (history, tabs, settings) can reach the owner's other machines.
#
# exec: the browser becomes this process, so launchd sees a browser crash as a non-zero exit and
# restarts us, while a deliberate quit (exit 0) is left alone.
exec "$BROWSER" \
  --kiosk \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --disable-sync \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --autoplay-policy=no-user-gesture-required \
  --overscroll-history-navigation=0 \
  "$URL"
KIOSK_EOF
chmod +x "$DEST/homedash-kiosk.sh"

# ---- the LaunchAgent ------------------------------------------------------------------------
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DEST/homedash-kiosk.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOMEDASH_URL</key>
    <string>$URL</string>
    <key>HOMEDASH_WAIT</key>
    <string>$WAIT</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$DEST/kiosk.log</string>
  <key>StandardErrorPath</key>
  <string>$DEST/kiosk.log</string>
</dict>
</plist>
EOF

# ---- (re)load it ----------------------------------------------------------------------------
stop_agent
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed, showing $URL. The dashboard should open fullscreen now, and again at every login."
echo "Log: $DEST/kiosk.log"
echo
echo "Next, run:  bash $0 settings   (so it also survives a power cut), then turn on"
echo "System Settings > Users & Groups > 'Automatically log in as' for this user."
