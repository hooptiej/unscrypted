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

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Config (/config) and HAP pairing state (/data/persist) live outside the image as bind
# mounts (see docker-compose.yml). No VOLUME line on purpose: an anonymous volume at /config
# is where the pairing keys got trapped (#4), and a compose down would have dropped them.

# HAP server port (also set in config.bridge.port). With host networking this is
# informational; mDNS uses the host network directly.
EXPOSE 51826/tcp

CMD ["node", "dist/index.js"]
