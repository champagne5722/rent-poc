# syntax=docker/dockerfile:1
# 只支援 linux/amd64：Cloud Run 跑 amd64，Litestream 的 checksum 也只對應這個架構。
# Apple Silicon 本機建置要加 --platform linux/amd64。
ARG NODE_VERSION=26-slim

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:${NODE_VERSION} AS build
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION} AS litestream
ADD --checksum=sha256:d3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea \
  https://github.com/benbjohnson/litestream/releases/download/v0.5.18/litestream-0.5.18-linux-x86_64.tar.gz \
  /tmp/litestream.tar.gz
RUN mkdir /tmp/litestream \
  && tar -xzf /tmp/litestream.tar.gz -C /tmp/litestream \
  && find /tmp/litestream -type f -name litestream -exec install -m 0755 {} /usr/local/bin/litestream \;

FROM node:${NODE_VERSION} AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8080
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node deploy/entrypoint.mjs ./deploy/entrypoint.mjs
RUN mkdir -p data && chown node:node /app /app/data
USER node
EXPOSE 8080
CMD ["node", "deploy/entrypoint.mjs"]
