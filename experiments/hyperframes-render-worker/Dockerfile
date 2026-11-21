# Development-only render worker. Run it only through scripts/run-worker.mjs, which applies
# the isolation flags; the image alone does not isolate the network or limit resources.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

ARG FFMPEG_RELEASE=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-02-28-12-59
ARG FFMPEG_BUILD=ffmpeg-n8.0.1-66-g27b8d1a017
ARG FFMPEG_SHA256=26d2ecd0cefba99f9d1ea92252a3a4f743a58df4c1c3cf9f8bbaaa40b1fca5b0
ARG CHROME_VERSION=152.0.7977.30
ARG CHROME_SHA256=1b150320178ecabe39726bcf3198ebb896ba2b7a07d870db1710914c42d55221

ENV HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1 HYPERFRAMES_SKIP_SKILLS=1 NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json ./
COPY docker/ ./docker/

# One layer, so the download tools removed at the end are really gone from the image.
# Removes every CLI command the worker does not use, then the tools a compromised render could
# use to reach out or install anything. Nothing after this step can download.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils unzip fontconfig fonts-dejavu-core \
      libgbm1 libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 \
      libcups2 libasound2 libpangocairo-1.0-0 libxshmfence1 libxkbcommon0 libx11-6 libxext6 libxcb1 \
    && curl -fsSL -o /tmp/ffmpeg.tar.xz "$FFMPEG_RELEASE/$FFMPEG_BUILD-linux64-gpl-8.0.tar.xz" \
    && echo "$FFMPEG_SHA256  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /usr/local/bin --strip-components=2 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe' \
    && rm /tmp/ffmpeg.tar.xz \
    && npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
    && curl -fsSL -o /tmp/chrome.zip "https://storage.googleapis.com/chrome-for-testing-public/$CHROME_VERSION/linux64/chrome-headless-shell-linux64.zip" \
    && echo "$CHROME_SHA256  /tmp/chrome.zip" | sha256sum -c - \
    && mkdir -p /opt/chrome && unzip -q /tmp/chrome.zip -d /opt/chrome && rm /tmp/chrome.zip \
    && ln -s /opt/chrome/chrome-headless-shell-linux64/chrome-headless-shell /usr/local/bin/chrome-headless-shell \
    && if ldd /usr/local/bin/chrome-headless-shell | grep "not found"; then exit 1; fi \
    && node docker/harden-image.mjs \
    && apt-get purge -y --auto-remove curl xz-utils unzip \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt /root/.npm /root/.cache /tmp/* \
              /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
              /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin renderer

# Owned by root and not writable by the renderer user.
COPY src/ ./src/
COPY templates/ ./templates/

USER 10001:10001
ENTRYPOINT ["node", "/app/src/main.mjs"]
