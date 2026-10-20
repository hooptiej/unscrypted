# unscrypted — HomeKit camera bridge
#
# Stable, deployable image: app code is baked in, deps and base are pinned
# (no :latest), ffmpeg is included. Config + HAP pairing state are bind-mounted
# at runtime (see docker-compose.yml). Host networking is required for HomeKit
# mDNS discovery.

# ---- build stage -----------------------------------------------------------
FROM node:22.11.0-bookworm-slim AS build
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
FROM node:22.11.0-bookworm-slim AS runtime
WORKDIR /app

# ffmpeg is required for live view, snapshots and recording.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV UNSCRYPTED_CONFIG=/config/config.json
ENV UNSCRYPTED_PERSIST_DIR=/data/persist

# ---- go2rtc (feed checks and previews in the admin pane). Pinned version + checksum, never latest.
# The checksum is the release asset's SHA-256 as published by GitHub for v1.9.14 (and re-hashed on
# the NAS). ADD --checksum fails the build on any mismatch.
ARG GO2RTC_VERSION=1.9.14
ARG GO2RTC_SHA256=32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6
ADD --checksum=sha256:${GO2RTC_SHA256} \
    https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_amd64 /usr/local/bin/go2rtc
RUN chmod 0755 /usr/local/bin/go2rtc \
    && /usr/local/bin/go2rtc -version | grep -F "go2rtc version ${GO2RTC_VERSION} "

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The admin pane's page, script and styles (the server reads <dist>/../web/admin).
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

CMD ["node", "dist/index.js"]
