# syntax=docker/dockerfile:1
# 目標平台是 linux/amd64（Cloud Run）。Apple Silicon 本機建置要加 --platform linux/amd64。
ARG NODE_VERSION=26-slim

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# 不執行套件的 install script：slim 映像沒有編譯工具，建置也用不到。
RUN npm ci --ignore-scripts

FROM node:${NODE_VERSION} AS build
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION} AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8080
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# data/ 只給沒有設定 Cloud Storage 的本機檔案儲存用（映像冒煙測試）
RUN mkdir -p data && chown node:node /app /app/data
USER node
EXPOSE 8080
CMD ["node", "server.js"]
