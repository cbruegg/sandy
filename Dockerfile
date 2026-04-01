FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

CMD ["node", "dist/subagent/worker.js"]
