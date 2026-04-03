FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

FROM opensuse/tumbleweed:latest
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
    which \
  && zypper clean --all

RUN useradd --create-home --shell /bin/bash linuxbrew \
  && mkdir -p /home/linuxbrew/.linuxbrew \
  && chown -R linuxbrew:linuxbrew /home/linuxbrew

RUN su - linuxbrew -c 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

RUN printf '#!/bin/sh\nexec sudo -u linuxbrew -H /home/linuxbrew/.linuxbrew/bin/brew "$@"\n' > /usr/local/bin/brew \
  && chmod 0755 /usr/local/bin/brew

ENV PATH="/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

CMD ["node", "dist/subagent/worker.js"]
