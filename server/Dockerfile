# syntax=docker/dockerfile:1
# @lexflow/server 生产镜像（arch/08 §5）：esbuild 单文件产物 + 仅 external 运行时依赖（pg）。
# 构建上下文为仓库根（docker-compose.prod.yml 指定）。

FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
RUN npm ci --workspace @lexflow/shared --workspace @lexflow/server
COPY shared/ shared/
COPY server/ server/
RUN npm run build -w @lexflow/server

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# 运行时仅需要 esbuild external 的 pg；type=module 使 dist/*.js 按 ESM 加载
RUN printf '{"name":"lexflow-server-runtime","private":true,"type":"module","dependencies":{"pg":"^8.23.1"}}' > package.json \
  && npm install --omit=dev \
  && npm cache clean --force
COPY --from=build /repo/server/dist ./dist
COPY --from=build /repo/server/drizzle ./drizzle
EXPOSE 3001
# 启动即执行迁移（幂等重放），再拉起服务；策略见 docs/部署手册.md
CMD ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
