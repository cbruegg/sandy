FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.json eslint.config.mjs knip.json ./
RUN bun install --frozen-lockfile

COPY src ./src
RUN bun run build

FROM docker:28-cli AS docker-cli

FROM oven/bun:1 AS runtime-base
WORKDIR /app

COPY --from=build /app/dist ./dist

FROM runtime-base AS main-agent-runtime
ARG SANDY_IMAGE_REGISTRY=""
ARG SANDY_IMAGE_VERSION=""
ENV SANDY_IMAGE_REGISTRY="${SANDY_IMAGE_REGISTRY}"
ENV SANDY_IMAGE_VERSION="${SANDY_IMAGE_VERSION}"
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
CMD ["bun", "dist/index.js"]

FROM runtime-base AS mcp-proxy-runtime
CMD ["bun", "dist/mcp/sidecar.js"]

FROM opensuse/tumbleweed:latest AS worker-runtime
WORKDIR /workspace

RUN zypper --non-interactive refresh \
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
    nodejs \
    npm \
    procps \
    shadow \
    sudo \
    tar \
    unzip \
    which \
  && zypper clean --all

RUN curl -fsSL https://bun.sh/install | bash

RUN useradd --create-home --shell /bin/bash linuxbrew \
  && mkdir -p /home/linuxbrew/.linuxbrew \
  && chown -R linuxbrew:linuxbrew /home/linuxbrew

RUN su - linuxbrew -c 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

RUN printf '#!/bin/sh\nexec sudo -u linuxbrew -H /home/linuxbrew/.linuxbrew/bin/brew "$@"\n' > /usr/local/bin/brew \
  && chmod 0755 /usr/local/bin/brew

ENV BUN_INSTALL="/root/.bun"
ENV PATH="${BUN_INSTALL}/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

COPY --from=build /app/dist ./dist

CMD ["bun", "dist/subagent/worker.js"]
