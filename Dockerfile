# Build the Bun bundles once so both runtime images can reuse them.
FROM oven/bun:1 AS build
WORKDIR /app

ARG SANDY_BUILD_GIT_REVISION
ARG SANDY_BUILD_IMAGE_REGISTRY
ARG SANDY_BUILD_GITHUB_REPOSITORY
ARG SANDY_BUILD_UPDATE_RELEASE_TAG

COPY package.json bun.lock tsconfig.json eslint.config.mjs knip.json ./
RUN bun install --frozen-lockfile

COPY scripts ./scripts
COPY src ./src
RUN set --; \
    if [ -n "$SANDY_BUILD_GIT_REVISION" ]; then set -- "$@" --define "SANDY_BUILD_GIT_REVISION='$SANDY_BUILD_GIT_REVISION'"; fi; \
    if [ -n "$SANDY_BUILD_IMAGE_REGISTRY" ]; then set -- "$@" --define "SANDY_BUILD_IMAGE_REGISTRY='$SANDY_BUILD_IMAGE_REGISTRY'"; fi; \
    if [ -n "$SANDY_BUILD_GITHUB_REPOSITORY" ]; then set -- "$@" --define "SANDY_BUILD_GITHUB_REPOSITORY='$SANDY_BUILD_GITHUB_REPOSITORY'"; fi; \
    if [ -n "$SANDY_BUILD_UPDATE_RELEASE_TAG" ]; then set -- "$@" --define "SANDY_BUILD_UPDATE_RELEASE_TAG='$SANDY_BUILD_UPDATE_RELEASE_TAG'"; fi; \
    bun run build:ci-bundle -- "$@"

# Shared Bun runtime layer for host-side TypeScript entrypoints.
FROM oven/bun:1 AS runtime-base
WORKDIR /app

COPY --from=build /app/dist ./dist

# Host-side MCP proxy sidecar runtime.
FROM runtime-base AS mcp-proxy-runtime
CMD ["bun", "dist/entrypoint-mcp-proxy.js"]

# HTTP proxy runtime built on mitmproxy.
# Use a glibc-based Python image so arm64 can consume mitmproxy's prebuilt wheels
# instead of trying to compile mitmproxy-rs from source on musl.
FROM python:3.14-slim AS http-proxy-runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir mitmproxy
COPY scripts/http-proxy-addon.py /app/http-proxy-addon.py
COPY scripts/http-proxy-supervisor.py /app/http-proxy-supervisor.py
COPY scripts/http-proxy-entrypoint.sh /usr/local/bin/sandy-http-proxy
RUN chmod 0755 /usr/local/bin/sandy-http-proxy
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sandy-http-proxy"]

# Dedicated network guard runtime that owns the worker's network namespace.
FROM opensuse/tumbleweed:latest AS network-guard-runtime
WORKDIR /app

RUN install -d /etc/zypp/zypp.conf.d \
  && printf '[main]\ndownload.max_silent_tries = 5\n' > /etc/zypp/zypp.conf.d/99-sandy-ci-retries.conf

RUN zypper --non-interactive refresh \
  && zypper --non-interactive dist-upgrade \
  && zypper --non-interactive install --no-recommends \
    gawk \
    grep \
    iproute2 \
    iptables \
  && zypper clean --all

COPY scripts/network-guard-entrypoint.sh /usr/local/bin/sandy-network-guard
RUN chmod 0755 /usr/local/bin/sandy-network-guard

ENTRYPOINT ["/usr/local/bin/sandy-network-guard"]

# Rootful worker runtime used for Codex task execution.
FROM opensuse/tumbleweed:latest AS worker-runtime
WORKDIR /workspace

RUN install -d /etc/zypp/zypp.conf.d \
  && printf '[main]\ndownload.max_silent_tries = 5\n' > /etc/zypp/zypp.conf.d/99-sandy-ci-retries.conf

RUN zypper --non-interactive refresh \
  && zypper --non-interactive dist-upgrade \
  && zypper --non-interactive install --no-recommends \
    ca-certificates \
    curl \
    file \
    findutils \
    gawk \
    gcc \
    gcc-c++ \
    git \
    gzip \
    make \
    nodejs24 \
    npm24 \
    procps \
    shadow \
    sudo \
    tar \
    unzip \
    which \
    ripgrep \
  && zypper clean --all

RUN curl -fsSL https://bun.sh/install | bash

RUN useradd --create-home --shell /bin/bash linuxbrew \
  && mkdir -p /home/linuxbrew/.linuxbrew \
  && chown -R linuxbrew:linuxbrew /home/linuxbrew

RUN su - linuxbrew -c 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

RUN printf '#!/bin/sh\nexec sudo -u linuxbrew -H /home/linuxbrew/.linuxbrew/bin/brew "$@"\n' > /usr/local/bin/brew \
  && chmod 0755 /usr/local/bin/brew

ENV BUN_INSTALL="/root/.bun"
# Keep this PATH in sync with scripts/worker-entrypoint.sh so worker startup
# and later shells see the same toolchain locations, including login shells
# via /etc/profile.local generated below.
ENV PATH="${BUN_INSTALL}/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

COPY --from=build /app/dist ./dist
COPY scripts/worker-entrypoint.sh /usr/local/bin/sandy-worker-entrypoint
COPY scripts/http-proxy-exec.sh /usr/local/bin/sandy-http-proxy-exec
RUN printf '#!/bin/sh\nexport PATH="%s"\n' "$PATH" > /etc/profile.local \
  && chmod 0755 /usr/local/bin/sandy-worker-entrypoint /usr/local/bin/sandy-http-proxy-exec /etc/profile.local

ENTRYPOINT ["/usr/local/bin/sandy-worker-entrypoint"]
