# syntax=docker/dockerfile:1
# @lexflow/app 生产镜像（arch/08 §5）：vite build 静态产物 + nginx 服务与反向代理。
# 构建上下文为仓库根（docker-compose.prod.yml 指定）。
# 注意：app 的 tsc 经 tsconfig paths 引用 server 源码类型（AppRouter），构建阶段需 server 工作区在场。

FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY app/package.json app/
RUN npm ci --workspace @lexflow/shared --workspace @lexflow/server --workspace @lexflow/app
COPY shared/ shared/
COPY server/ server/
COPY app/ app/
RUN npm run build -w @lexflow/app

FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/app/dist /usr/share/nginx/html
COPY app/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
