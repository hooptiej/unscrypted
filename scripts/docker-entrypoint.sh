#!/bin/sh
# unscrypted container entrypoint (#45): start as root only long enough to make the bind-mounted
# folders belong to the unprivileged `node` user (uid 1000), then run the app as that user.
# Everything the app starts (the admin pane, the dashboard, go2rtc, every ffmpeg) inherits it.
#
# Why not just `USER node` in the Dockerfile: an install upgraded from the root-only releases has
# ./config and ./data owned by root, and only root can hand them over. This does it once, safely,
# and on every later start it finds nothing to change and just drops privileges.
#
# What it does, in order:
#   1. BACK UP the HAP pairing folder (data/persist) before the first ownership change. Losing the
#      pairing means every camera has to be re-added in Apple Home, so nothing else comes first.
#   2. chown config + data (only the files that are wrong; never across a mount boundary) to node.
#   3. CHECK, as node, that the folders are writable and every pairing file is readable and none
#      went missing. Any failure stops the container with a plain-words reason (never a quiet start).
#   4. Make the secrets readable by node's group (it can't chown a read-only mount; it says so).
#   5. exec the app as node, with permission to listen on ports below 1024 (the dashboard on :80).
#
# Already running unprivileged (compose `user:`)? Then it can only check, and says what to fix.

set -eu

say()  { printf '[entrypoint] %s\n' "$*"; }
warn() { printf '[entrypoint] WARN: %s\n' "$*" >&2; }
die()  { printf '[entrypoint] ERROR: %s\n' "$*" >&2; exit 1; }

APP_USER=node
CONFIG_DIR=$(dirname "${UNSCRYPTED_CONFIG:-/config/config.json}")
PERSIST_DIR=${UNSCRYPTED_PERSIST_DIR:-/data/persist}
DATA_DIR=$(dirname "$PERSIST_DIR")
KEY_DIR=$(dirname "${UNSCRYPTED_ADMIN_KEY_FILE:-/data/admin-session.key}")
DASH_DIR=${UNSCRYPTED_DASH_DIR:-/data/dash}
SECRETS_DIR=$(dirname "${UNSCRYPTED_ADMIN_PASSWORD_FILE:-/run/secrets/admin_password}")
RUNTIME_DIR=${UNSCRYPTED_RUNTIME_DIR:-/tmp/unscrypted}
# The folders the app writes to, each listed once.
WRITABLE_DIRS=
for d in "$CONFIG_DIR" "$DATA_DIR" "$KEY_DIR" "$DASH_DIR"; do
  case " $WRITABLE_DIRS " in *" $d "*) ;; *) WRITABLE_DIRS="$WRITABLE_DIRS $d" ;; esac
done

APP_UID=$(id -u "$APP_USER" 2>/dev/null) || die "the image has no '$APP_USER' user, so the app can't be run unprivileged. Rebuild the image from this repo's Dockerfile."
APP_GID=$(id -g "$APP_USER")
export HOME=/home/$APP_USER

HOST_FIX="On the host, in the folder with docker-compose.yml, run: sudo chown -R $APP_UID:$APP_GID config data   (then start the container again). The pairing keys in data/persist are untouched; don't delete them."

# ---- already unprivileged: check only ------------------------------------------------------
if [ "$(id -u)" != "0" ]; then
  for d in $WRITABLE_DIRS; do
    [ -d "$d" ] || continue
    [ -w "$d" ] || die "this container runs as uid $(id -u), which can't write to $d, so the pairing and settings couldn't be saved. Nothing was changed. $HOST_FIX"
  done
  exec "$@"
fi

command -v setpriv >/dev/null 2>&1 || die "setpriv (from util-linux) is missing from this image, so the app can't drop to the '$APP_USER' user. Rebuild the image from this repo's Dockerfile."

run_as() { setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups "$@"; }

# One file under $1 (same filesystem only) that the app user doesn't own, or nothing.
wrong_owner() { find "$1" -xdev \( ! -uid "$APP_UID" -o ! -gid "$APP_GID" \) -print -quit 2>/dev/null; }

# ---- 1. back up the pairing before touching ownership --------------------------------------
PERSIST_FILES=
if [ -d "$PERSIST_DIR" ]; then
  PERSIST_FILES=$(find "$PERSIST_DIR" -type f | wc -l)
  if [ -n "$(wrong_owner "$PERSIST_DIR")" ]; then
    EARLIER=
    for b in "$PERSIST_DIR".pre-nonroot-*; do [ -e "$b" ] && EARLIER=$b; done
    if [ -n "$EARLIER" ]; then
      say "the pairing folder $PERSIST_DIR still needs its ownership changed; a backup from the first attempt ($EARLIER) already exists, not making another."
    else
      BACKUP="$PERSIST_DIR.pre-nonroot-$(date +%Y%m%d-%H%M%S)"
      say "the pairing folder $PERSIST_DIR is owned by someone else; backing it up to $BACKUP before changing anything."
      if ! cp -a "$PERSIST_DIR" "$BACKUP"; then
        rm -rf "$BACKUP"
        die "couldn't back up the pairing folder $PERSIST_DIR to $BACKUP (disk full or not writable?). Nothing was changed and the app was NOT started, so the pairing is safe. Free some space, or copy the folder by hand, then start again."
      fi
      [ "$(find "$BACKUP" -type f | wc -l)" = "$PERSIST_FILES" ] ||
        die "the pairing backup $BACKUP doesn't have the same number of files as $PERSIST_DIR ($PERSIST_FILES). Nothing was changed and the app was NOT started. Check the disk, then start again."
      say "pairing backed up ($PERSIST_FILES files) to $BACKUP."
    fi
  fi
fi

# ---- 2. hand the writable folders to the app user ------------------------------------------
CHOWN_FAILED=
for d in $WRITABLE_DIRS; do
  mkdir -p "$d"
  if [ -n "$(wrong_owner "$d")" ]; then
    say "changing the owner of the files in $d to $APP_USER ($APP_UID:$APP_GID)."
    # Only the files that are wrong, and -h so a symlink is never followed out of the folder.
    if ! find "$d" -xdev \( ! -uid "$APP_UID" -o ! -gid "$APP_GID" \) -exec chown -h "$APP_UID:$APP_GID" {} +; then
      CHOWN_FAILED="$CHOWN_FAILED $d"
      warn "couldn't change the owner of everything in $d (a filesystem that refuses chown, such as some network shares?)."
    fi
  fi
done

# ---- 3. check, as the app user, that it can really use them --------------------------------
for d in $WRITABLE_DIRS; do
  probe="$d/.unscrypted-write-test.$$"
  run_as sh -c 'touch "$1" && rm -f "$1"' sh "$probe" 2>/dev/null ||
    die "the app user ($APP_USER, uid $APP_UID) can't write to $d, so the pairing and settings couldn't be saved.${CHOWN_FAILED:+ Changing the owner failed for:$CHOWN_FAILED.} Nothing was lost and the app was NOT started. $HOST_FIX"
done
if [ -d "$PERSIST_DIR" ]; then
  UNREADABLE=$(run_as find "$PERSIST_DIR" -type f ! -readable -print 2>/dev/null | head -n 3 || true)
  [ -z "$UNREADABLE" ] ||
    die "the app user can't read these pairing files: $UNREADABLE. The app was NOT started, because starting without the pairing would make Home treat this as a new bridge. $HOST_FIX"
  NOW=$(find "$PERSIST_DIR" -type f | wc -l)
  [ "$NOW" = "$PERSIST_FILES" ] ||
    die "the pairing folder $PERSIST_DIR had $PERSIST_FILES files before and has $NOW now. The app was NOT started. Restore from the newest $PERSIST_DIR.pre-nonroot-* backup if files are missing."
fi

# The scratch folder (go2rtc's generated config lives here); /tmp survives a plain `docker restart`.
mkdir -p "$RUNTIME_DIR"
chown -R "$APP_UID:$APP_GID" "$RUNTIME_DIR" 2>/dev/null || warn "couldn't hand $RUNTIME_DIR to $APP_USER; the video server's config may not be writable."

# ---- 4. secrets: readable by the app, owner untouched --------------------------------------
# Files stay owned by whoever made them (so the host user can still read and replace them); the
# app user gets read access through its group. A read-only mount can't be changed: say how to fix it.
if [ -d "$SECRETS_DIR" ]; then
  run_as test -x "$SECRETS_DIR" 2>/dev/null || { chgrp "$APP_GID" "$SECRETS_DIR" 2>/dev/null && chmod g+x "$SECRETS_DIR" 2>/dev/null; } || true
  for f in "$SECRETS_DIR"/*; do
    [ -f "$f" ] || continue
    run_as test -r "$f" 2>/dev/null && continue
    if chgrp "$APP_GID" "$f" 2>/dev/null && chmod g+r "$f" 2>/dev/null && run_as test -r "$f" 2>/dev/null; then
      say "made secret file $f readable by the app (group read; its owner is unchanged)."
    else
      warn "the app can't read $f and this container couldn't fix it (is ./secrets mounted read-only?). Whatever uses that secret (the admin pane's sign-in, the Constructicon fonts, the new-build pulse) will report it as missing. On the host run: sudo chgrp $APP_GID secrets/$(basename "$f") && sudo chmod g+r secrets/$(basename "$f")"
    fi
  done
fi

# ---- 5. drop privileges and run ------------------------------------------------------------
# net_bind_service lets the app listen below port 1024 (the dashboard on its own address at :80).
# It is an ambient capability, so it reaches node and its children but nothing else. If this
# container wasn't given it, ports 1024 and up still work and the dashboard says so if it needs more.
CAPS="--inh-caps=+net_bind_service --ambient-caps=+net_bind_service"
if ! run_as $CAPS true 2>/dev/null; then
  warn "couldn't give the app permission to listen on ports below 1024 (this container doesn't have NET_BIND_SERVICE). Ports 1024 and up work as normal; if UNSCRYPTED_DASH_PORT is 80, add 'cap_add: [NET_BIND_SERVICE]' to the compose service or pick a higher port."
  CAPS=""
fi
say "running as $APP_USER ($APP_UID:$APP_GID): $*"
# shellcheck disable=SC2086  # $CAPS is two separate options on purpose
exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups $CAPS "$@"
