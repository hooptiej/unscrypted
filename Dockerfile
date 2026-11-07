# unscrypted — HomeKit camera bridge
#
# Stable, deployable image: app code is baked in, deps and base are pinned
# (no :latest), ffmpeg is included. Config + HAP pairing state are bind-mounted
# at runtime (see docker-compose.yml). Host networking is required for HomeKit
# mDNS discovery.

# Base image, pinned by tag AND digest (#6), used by both stages so they can't drift apart. The
# digest is the multi-arch index digest of the tag, so a rebuild pulls the exact same bytes even if
# the tag is re-pushed. To bump: pick the new tag, then read its index digest with
#   docker buildx imagetools inspect node:<tag>        (the "Digest:" line)
# or, without Docker, the Docker-Content-Digest header of the Docker Hub manifest (token from
# auth.docker.io, then HEAD registry-1.docker.io/v2/library/node/manifests/<tag> with the OCI index
# Accept header). Re-check the ffmpeg pin below whenever the Debian release changes.
ARG NODE_IMAGE=node:22.11.0-bookworm-slim@sha256:f035ba7ffee18f67200e2eb8018e0f13c954ec16338f264940f701997e3c12da

# ---- build stage -----------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# Install deps against the lockfile for a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

# Build TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies for the runtime copy.
RUN npm prune --omit=dev

# ---- runtime stage ---------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# ffmpeg is required for live view, snapshots and recording. fonts-dejavu-core
# supplies the font for drawtext on the "camera unavailable" placeholder (#64).
# ffmpeg is pinned to an exact Debian bookworm version (#6); its libav* libraries come from the same
# source package and follow it at the matching version. Debian drops a superseded version from the
# mirror after a security/point update, so this build then FAILS loudly ("Version ... was not
# found") rather than quietly installing something else. To bump: read the current version with
#   docker run --rm <base image> sh -c 'apt-get update -qq && apt-cache policy ffmpeg'
# or https://qa.debian.org/madison.php?package=ffmpeg&s=bookworm,bookworm-security&text=on
ARG FFMPEG_VERSION=7:5.1.9-0+deb12u1
RUN apt-get update \
    && apt-get install -y --no-install-recommends "ffmpeg=${FFMPEG_VERSION}" fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV UNSCRYPTED_CONFIG=/config/config.json
ENV UNSCRYPTED_PERSIST_DIR=/data/persist

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Build stamp (#102): the git short sha the image was built from and the UTC build date, passed in
# as build args by scripts/deploy.sh (and docker-compose's build.args). The release version comes
# from package.json, so it needs no arg. Written to /app/BUILD as one line "<sha> <date>", which the
# app reads at runtime (src/version.ts). Empty args are fine: a plain build writes a blank line and
# the app falls back to "source". Never fails the build.
ARG UNSCRYPTED_BUILD_SHA=
ARG UNSCRYPTED_BUILD_DATE=
RUN printf '%s %s\n' "${UNSCRYPTED_BUILD_SHA}" "${UNSCRYPTED_BUILD_DATE}" > /app/BUILD

# ---- go2rtc (feed checks and previews in the admin pane, and the dashboard's live tiles).
# Pinned version + checksum, never latest. The checksum is the release asset's SHA-256 as
# published by GitHub for v1.9.14 (and re-hashed independently). ADD --checksum fails the build on
# any mismatch. (Re-applied from f68c95c on the old lineage; the 0.1.x trunk never baked it.)
ARG GO2RTC_VERSION=1.9.14
ARG GO2RTC_SHA256=32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6
ADD --checksum=sha256:${GO2RTC_SHA256} \
    https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_amd64 /usr/local/bin/go2rtc
RUN chmod 0755 /usr/local/bin/go2rtc \
    && /usr/local/bin/go2rtc -version | grep -F "go2rtc version ${GO2RTC_VERSION} "

# The admin pane's and dashboard's pages, scripts and styles (the servers read <dist>/../web/*).
COPY web ./web

ENV UNSCRYPTED_GO2RTC_BIN=/usr/local/bin/go2rtc \
    UNSCRYPTED_ADMIN_PORT=8190 \
    UNSCRYPTED_GO2RTC_API_PORT=1986 \
    UNSCRYPTED_RUNTIME_DIR=/tmp/unscrypted \
    UNSCRYPTED_ADMIN_PASSWORD_FILE=/run/secrets/admin_password \
    UNSCRYPTED_ADMIN_KEY_FILE=/data/admin-session.key \
    UNSCRYPTED_DASH_PORT=8180 \
    UNSCRYPTED_DASH_DIR=/data/dash

# Config (/config) and HAP pairing state (/data/persist) live outside the image as bind
# mounts (see docker-compose.yml). No VOLUME line on purpose: an anonymous volume at /config
# is where the pairing keys got trapped (#4), and a compose down would have dropped them.

# HAP server port (also set in config.bridge.port). With host networking this is
# informational; mDNS uses the host network directly.
EXPOSE 51826/tcp
# Admin pane (go2rtc's API stays on 127.0.0.1 and is reached only through the pane).
EXPOSE 8190/tcp
# The open, watch-only dashboard (the living-room display).
EXPOSE 8180/tcp

# Covers the admin pane only. Unhealthy restarts nothing, so the HomeKit bridge is never touched by it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.UNSCRYPTED_ADMIN_PORT||8190)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Non-root (#45). The entrypoint starts as root only to hand ./config and ./data (bind mounts,
# root-owned on installs from the earlier releases) to the base image's unprivileged `node` user
# (uid 1000), after backing up the HAP pairing; it then drops to that user, with permission to
# listen below port 1024 (the dashboard on :80), and runs the CMD. The admin pane, the dashboard,
# go2rtc and every ffmpeg all run as `node`. setpriv ships in util-linux, which the base image
# already has; the RUN line fails the build if it ever doesn't.
COPY scripts/docker-entrypoint.sh /usr/local/bin/unscrypted-entrypoint
RUN chmod 0755 /usr/local/bin/unscrypted-entrypoint \
    && setpriv --version \
    && id node | grep -F "uid=1000(node) gid=1000(node)"

ENTRYPOINT ["/usr/local/bin/unscrypted-entrypoint"]
CMD ["node", "dist/index.js"]
