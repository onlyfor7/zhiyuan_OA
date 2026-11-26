# 因诺智元业务管理平台（LexFlow）

律所/专业服务机构的业务管理平台：CRM（线索→商机→立项）、项目全周期（计划甘特/任务/会议/出差/预算/经费/费用/工时/质量/决策/周报/档案）、协同审批（飞书式四步向导+自定义表单+竖向流程设计器）、经营财务（收款/应收/发票/项目核算）、报表中心、组织与系统治理、AI 助手「小元」。

## 技术栈与仓库结构

npm workspaces 单仓：

| 目录 | 包 | 说明 |
|---|---|---|
| `app/` | `@lexflow/app` | 前端：React 19 + Vite 7 + TanStack Query + tRPC client |
| `server/` | `@lexflow/server` | 服务端：Hono + tRPC v11 + Drizzle ORM + PostgreSQL 16（zod 全量校验、scrypt 口令、服务端会话） |
| `shared/` | `@lexflow/shared` | 前后端共享：枚举/状态机/常量/错误码/权限动作 |
| `e2e/` | — | Playwright 端到端规格与采集脚本 |
| `docs/` | — | 全部协作文档（见下「文档地图」） |
| `docker/`、`docker-compose.yml` | — | 本地 Postgres 16（宿主端口 **15432** → 容器 5432） |

## 快速开始

前置：Node ≥ 20、Docker（含 compose 插件）、Git。

```bash
cp .env.example .env        # 按需改 SESSION_SECRET
docker compose up -d        # Postgres 16（lexflow + lexflow_test 两库）
npm install                 # workspaces 单一根 lockfile
npm run db:migrate          # 迁移（drizzle）
npm run db:seed             # 种子（幂等，可重复执行）
npm run dev                 # server :3001 + app :3000 并行
```

打开 http://localhost:3000 ，演示账号与口令见 `docs/系统操作手册_超级详细版.md` 角色速查篇（仅演示环境有效）。

## 常用命令（质量门）

```bash
npm run typecheck           # 类型检查（app+server）
npm run build               # 构建
npm test                    # 全量测试（server vitest + app vitest）
npm run db:migrate -w @lexflow/server
npm run db:seed -w @lexflow/server        # SEED_PROFILE=minimal|full
npm run db:migrate:flow-v2 -w @lexflow/server  # 流程定义 v1→v2 数据迁移（幂等，仅存量 v1 时需要）
```

e2e：`npx playwright test -c e2e/playwright.config.ts`（规格在 `e2e/specs/`，默认打 dev :3000；探针类 `e2e/probe-*.cjs` 不入库、本地复跑）。

## 分支与协作约定

- `main` 为唯一主干（受保护语义）：任何改动经工单/任务分支合入，禁止直接推 main。
- 任务分支命名：`<领域>/<简述>`（如 `iter21/server-request-rv`）；commit 前缀 `[数据]/[后端]/[前端]/[测试]/[部署]/[架构]`。
- **禁止入库**：`.env`、任何凭据/密钥、`deepseek api.txt`、`*-cred.txt`、`server/storage/`（上传文件）、`backups/`、`e2e/probe-*.cjs`（见 `.gitignore`）。
- 数据库迁移**只追加不改写**（`server/drizzle/` 时间序）；`shared/` 只增不改（改需架构评审）。
- 金额一律分存储（`bigint *_cents`），禁用浮点；编号走 `next_code` 序列。

## 文档地图（docs/）

| 文档 | 用途 |
|---|---|
| `docs/开发环境.md` | 环境从零启动细节（端口裁定/库初始化） |
| `docs/部署手册.md` | 外测/生产部署流程（镜像构建/迁移/备份回滚） |
| `docs/系统功能手册_超级详细版.md` | 功能说明书：14 角色/全模块/状态机/权限矩阵 |
| `docs/系统操作手册_超级详细版.md` | 操作说明书：分步操作+每步截图（150+ 张） |
| `docs/arch/` | 架构基线 00–14（冻结契约，变更须评审） |
| `docs/work-orders/` | 工单协议与历史工单（多会话协作模式） |
| `docs/STATUS.md` | 项目协调看板：迭代状态/偏差仲裁/交接记录 |
| `docs/测试报告/` | 各迭代验收报告 |

## 外测环境

`http://182.92.206.62:8080`（部署流程见 `docs/部署手册.md`；数据为外部测试真实使用数据，**严禁清库/重置/裸 SQL**）。

## 许可

企业内部代码，未授权外传。
