#!/usr/bin/env bash
# unscrypted #107: one-command deploy for a checkout on a Docker host (prod or test), at parity with
# Constructicon/groundskeeper. It USES the checkout's `origin` remote (a read-only SSH deploy key;
# see README/docs) — it never configures credentials itself.
#
# Run from inside the checkout, or from anywhere (it cd's to its own parent):
#   ./scripts/deploy.sh                 fetch+reset origin/main, back up pairing, build this version, up
#   ./scripts/deploy.sh --no-snapshot   skip the pre-deploy pairing backup
#   ./scripts/deploy.sh --rebuild       build even if the image tag already exists
#   ./scripts/deploy.sh --rollback VER  run unscrypted:VER again (no git, no build)
#   ./scripts/deploy.sh --backup-plan   say what the pre-deploy backup would do; change nothing
#   ./scripts/deploy.sh -h
#
# The VERSION is package.json's "version". The image is unscrypted:<version> (prod) or
# unscrypted:<version>-test (test); which one is picked from COMPOSE_FILE in .env. Prod refuses to
# run if that image tag already exists — bump "version" in package.json for a new release (rollback
# = run the prior tag with --rollback).
#
# ⚠ HEADS UP (prod): rebuilding RESTARTS the HomeKit bridge — a few seconds of "No Response" in the
# Home app, and any in-progress recording stops. Batch dashboard-only changes. The test instance has
# HomeKit off, so a test deploy is safe.
#
# PRE-DEPLOY BACKUP (prod): copies HAP pairing state (data/persist) to data/persist.predeploy-<ts>
# so a rollback can restore pairing without re-adding cameras; newest $BACKUP_KEEP kept.
#
# DASHBOARD PULSE (optional, never fatal): if .env sets UNSCRYPTED_PULSE_URL,
# UNSCRYPTED_PULSE_TOKEN_FILE and a light id (UNSCRYPTED_PULSE_LIGHT prod / UNSCRYPTED_PULSE_LIGHT_TEST
# test), a successful deploy POSTs a build pulse. Unset = skipped. Nothing house-specific is in this
# file; it all comes from .env.

set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_KEEP=10
SNAPSHOT=1
REBUILD=""
ROLLBACK=""
BACKUP_PLAN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-snapshot|--no-backup) SNAPSHOT="" ;;
    --rebuild) REBUILD=1 ;;
    --backup-plan) BACKUP_PLAN=1 ;;
    --rollback)
      shift; ROLLBACK="${1:-}"
      if [ -z "$ROLLBACK" ]; then echo "--rollback needs a version, e.g. --rollback 0.1.14 (see: docker image ls unscrypted)" >&2; exit 2; fi ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

# --- Docker access: DOCKER is `docker` or `sudo docker`. A missing piece stops with the fix.
DOCKER=(docker)
detect_docker() {
  local err
  command -v docker >/dev/null 2>&1 || { echo "deploy.sh: 'docker' isn't installed or on PATH. Install Docker Engine + the Compose plugin, then retry." >&2; exit 1; }
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker); echo "Docker: using 'sudo docker' ($(id -un) can't use the socket directly)."
  else
    echo "deploy.sh: can't reach the Docker daemon as $(id -un) or with sudo. Start Docker (or fix docker-group/sudo access) and retry." >&2
    exit 1
  fi
  if ! err="$("${DOCKER[@]}" compose version 2>&1)"; then
    echo "deploy.sh needs Docker Compose v2 ('docker compose'); it failed: $err" >&2
    echo "Install the Compose plugin (apt install docker-compose-plugin, or https://docs.docker.com/compose/install/linux/) and retry." >&2
    exit 1
  fi
}

ENV_FILE=".env"
envget() { [ -f "$ENV_FILE" ] || return 0; sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
require_env() {
  [ -f "$ENV_FILE" ] || { echo "deploy.sh: no .env in $PWD. Copy .env.example and set UNSCRYPTED_VERSION (and any install values), then retry." >&2; exit 1; }
}

pkg_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1; }
is_test_mode() { case "$(envget COMPOSE_FILE)" in *compose.test.yml*|*docker-compose.test.yml*) return 0 ;; *) return 1 ;; esac; }
# HomeKit is off on the test instance and wherever .env sets UNSCRYPTED_HAP=off.
hap_on() { if is_test_mode; then return 1; fi; case "$(envget UNSCRYPTED_HAP)" in off|false|0) return 1 ;; *) return 0 ;; esac; }
image_tag() { local v="$1"; if is_test_mode; then printf '%s-test' "$v"; else printf '%s' "$v"; fi; }

set_env_version() {
  local v="$1"; [ -f "$ENV_FILE" ] || return 0
  if grep -q '^UNSCRYPTED_VERSION=' "$ENV_FILE"; then sed -i "s/^UNSCRYPTED_VERSION=.*/UNSCRYPTED_VERSION=$v/" "$ENV_FILE"; else printf 'UNSCRYPTED_VERSION=%s\n' "$v" >> "$ENV_FILE"; fi
}

# Write one KEY=VALUE into .env (replace if present, append if not). For the build stamp vars, which
# docker-compose's build.args read from .env — `sudo docker compose` would otherwise not see them in
# this script's environment. Mirrors set_env_version.
set_env_kv() {
  local k="$1" v="$2"; [ -f "$ENV_FILE" ] || return 0
  if grep -q "^$k=" "$ENV_FILE"; then sed -i "s/^$k=.*/$k=$v/" "$ENV_FILE"; else printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"; fi
}

# Build stamp (#102): the git short sha the build is cut from and today's UTC date, into .env so the
# compose build.args bake them into the image. A detached/odd git state still gives a usable sha or
# an empty one (the image then shows "source"); never fatal.
set_env_build() {
  local sha date
  sha="$(git rev-parse --short HEAD 2>/dev/null || true)"
  date="$(date -u +%Y-%m-%d)"
  set_env_kv UNSCRYPTED_BUILD_SHA "$sha"
  set_env_kv UNSCRYPTED_BUILD_DATE "$date"
  echo "Build stamp: sha ${sha:-<none>}, date $date (baked into the image)."
}

# --- files the container owns (#45) --------------------------------------------------------------
# The container runs as its own unprivileged user (uid 1000), so data/ and secrets/ belong to it, not
# to whoever runs this script. Copying or removing them tries the plain command first and then `sudo`;
# if neither works the step stops with the reason instead of carrying on without it.
as_owner() {
  "$@" 2>/dev/null && return 0
  if command -v sudo >/dev/null 2>&1 && sudo -n "$@"; then return 0; fi
  echo "deploy.sh: '$*' failed, with and without sudo. data/ and secrets/ belong to the container's user (uid 1000); run this as a user with sudo, or fix with: sudo chown -R 1000:1000 data" >&2
  return 1
}

# --- pre-deploy pairing backup (prod only; test's data is disposable) ---------------------------
do_backup() {
  [ -n "$SNAPSHOT" ] || { echo "Pre-deploy backup: skipped (--no-snapshot)."; return 0; }
  if is_test_mode; then echo "Pre-deploy backup: skipped (test instance; its data is disposable)."; return 0; fi
  if [ ! -d data/persist ]; then echo "Pre-deploy backup: no data/persist yet (first deploy?), nothing to back up."; return 0; fi
  local name="persist.predeploy-$(date +%Y%m%d-%H%M%S)"
  as_owner cp -a data/persist "data/$name" || exit 1
  echo "Pre-deploy backup: HAP pairing copied to data/$name (restore: stop, replace data/persist with it, start)."
  ls -1dt data/persist.predeploy-* 2>/dev/null | tail -n "+$((BACKUP_KEEP + 1))" \
    | while IFS= read -r old; do as_owner rm -rf "$old" && echo "  pruned $old"; done
}

pulse_dashboard() {
  local url token_file light build note token
  url="$(envget UNSCRYPTED_PULSE_URL)"; token_file="$(envget UNSCRYPTED_PULSE_TOKEN_FILE)"
  if is_test_mode; then light="$(envget UNSCRYPTED_PULSE_LIGHT_TEST)"; else light="$(envget UNSCRYPTED_PULSE_LIGHT)"; fi
  if [ -z "$url" ] || [ -z "$token_file" ] || [ -z "$light" ]; then
    echo "Dashboard pulse: skipped (set UNSCRYPTED_PULSE_URL, UNSCRYPTED_PULSE_TOKEN_FILE and UNSCRYPTED_PULSE_LIGHT[_TEST] in .env to enable)."
    return 0
  fi
  # The token file is mounted into the container, so it may belong to the container's user: try sudo.
  token="$(cat "$token_file" 2>/dev/null || sudo -n cat "$token_file" 2>/dev/null || true)"
  if [ -z "$token" ]; then echo "Dashboard pulse: skipped (token file $token_file not readable, with or without sudo)." >&2; return 0; fi
  build="$1"; note="${2:-unscrypted deploy}"
  if curl -fsS -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
       -d "{\"on\": true, \"build\": \"$build\", \"note\": \"$note\"}" "$url/api/pulse/$light" >/dev/null 2>&1; then
    echo "Dashboard pulse: lit '$light' (build $build)."
  else
    echo "Dashboard pulse: POST to $url/api/pulse/$light failed (deploy still succeeded)." >&2
  fi
}

report_running() {
  local name; name="$(envget UNSCRYPTED_CONTAINER)"; [ -n "$name" ] || { is_test_mode && name="unscrypted-test" || name="unscrypted"; }
  echo "Running:"
  "${DOCKER[@]}" ps --filter "name=^/${name}$" --format '  {{.Image}}  {{.Status}}' || true
}

# =================================================================================================
detect_docker
require_env

# Rollback: run an existing image tag again (restarts HomeKit on prod).
if [ -n "$ROLLBACK" ]; then
  TAG="$(image_tag "$ROLLBACK")"
  if ! "${DOCKER[@]}" image inspect "unscrypted:$TAG" >/dev/null 2>&1; then
    echo "No image unscrypted:$TAG on this host. Available:" >&2
    "${DOCKER[@]}" image ls unscrypted --format '  {{.Tag}}  ({{.CreatedSince}})' >&2
    exit 1
  fi
  hap_on && echo "⚠ Rolling back prod — the HomeKit bridge will restart (a few seconds of 'No Response')."
  [ -n "$SNAPSHOT" ] && do_backup
  set_env_version "$ROLLBACK"
  echo "Rolling back to unscrypted:$TAG (HAP pairing is in data/persist; a forward DB/pairing migration may need the pre-deploy backup)."
  "${DOCKER[@]}" compose up -d
  sleep 3; report_running
  exit 0
fi

git rev-parse --git-dir >/dev/null 2>&1 || { echo "deploy.sh: $PWD is not a git checkout; can't fetch and build. Nothing changed." >&2; exit 1; }

if [ -n "$BACKUP_PLAN" ]; then
  if is_test_mode; then echo "Pre-deploy backup plan: skipped (test instance)."; else
    echo "Pre-deploy backup plan: copy data/persist -> data/persist.predeploy-<ts> (newest $BACKUP_KEEP kept)."; fi
  exit 0
fi

echo "Fetching origin/main (and tags)..."
git fetch origin --tags
before="$(git rev-parse HEAD)"; after="$(git rev-parse origin/main)"
if [ "$before" = "$after" ]; then echo "Already at origin/main ($(git rev-parse --short HEAD))."; else
  echo "Resetting $(git rev-parse --short "$before") -> $(git rev-parse --short "$after")..."
  git reset --hard origin/main
fi

VERSION="$(pkg_version)"
[ -n "$VERSION" ] || { echo "deploy.sh: couldn't read \"version\" from package.json. Nothing changed." >&2; exit 1; }
TAG="$(image_tag "$VERSION")"

# The image IS the version. Refuse to overwrite an existing tag (bump package.json for a new release).
if "${DOCKER[@]}" image inspect "unscrypted:$TAG" >/dev/null 2>&1 && [ -z "$REBUILD" ]; then
  echo "deploy.sh: unscrypted:$TAG already exists on this host, so this release is already built." >&2
  echo "  Bump \"version\" in package.json (currently $VERSION) for a new release, then deploy; or --rebuild to" >&2
  echo "  overwrite it (overwriting breaks 'rollback = run the prior tag'). Nothing was changed." >&2
  exit 1
fi

do_backup
set_env_version "$VERSION"
set_env_build
if hap_on; then
  echo "⚠ Building + recreating PROD — the HomeKit bridge restarts now (a few seconds of 'No Response', recording stops)."
fi
echo "Building + starting unscrypted:$TAG..."
"${DOCKER[@]}" compose up -d --build
sleep 3; report_running
pulse_dashboard "$VERSION" "unscrypted $TAG deployed"
