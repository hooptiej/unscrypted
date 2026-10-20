#!/bin/bash
# install.sh: install (or remove) the homedash kiosk LaunchAgent for the current user.
#   ./install.sh            install and start it
#   ./install.sh uninstall  stop it and remove it
#
# The LaunchAgent carries the launcher's settings, so set them here to bake them in:
#   HOMEDASH_URL=http://homedash.local HOMEDASH_WAIT=180 ./install.sh
set -eu

LABEL="com.hooptiej.homedash-kiosk"
DEST="$HOME/Library/Application Support/homedash-kiosk"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HERE="$(cd "$(dirname "$0")" && pwd)"
DOMAIN="gui/$(id -u)"
URL="${HOMEDASH_URL:-http://homedash.local}"
WAIT="${HOMEDASH_WAIT:-180}"

# Stop the running copy, if there is one. "Not loaded" is the only failure that's fine here.
stop_agent() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$LABEL"
  fi
}

if [ "${1:-}" = "uninstall" ]; then
  stop_agent
  rm -f "$PLIST"
  echo "Removed the LaunchAgent. (Left $DEST in place; delete it by hand if you want.)"
  exit 0
fi

mkdir -p "$DEST" "$HOME/Library/LaunchAgents"
cp "$HERE/homedash-kiosk.sh" "$DEST/homedash-kiosk.sh"
chmod +x "$DEST/homedash-kiosk.sh"

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

# (re)load it
stop_agent
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed, showing $URL. The dashboard should open fullscreen now, and again at every login."
echo "Log: $DEST/kiosk.log"
echo "Still to do by hand (see README.md): automatic login, restart after power failure, no sleep."
