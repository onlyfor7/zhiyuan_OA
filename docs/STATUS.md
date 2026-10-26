# STATUS · 项目协调看板

**维护规则：** 执行会话更新自己工单行 + 交接记录；架构会话更新冻结记录、仲裁与迭代状态。
**协议：** `docs/work-orders/README.md`　**基线：** `律所业务管理平台_Kimi_Code开发需求基线_v2.0.md`

## 当前迭代

**迭代 0 · 全栈地基与原型重构**（未开始）

## 迭代总览

| 迭代 | 内容 | 状态 | 验收通过日期 |
|---|---|---|---|
| 0 | 全栈地基与原型重构 | 未开始 | — |
| 1 | 项目治理真实闭环 | 未开始 | — |
| 2 | 会议与出差垂直闭环 | 未开始 | — |
| 3 | 预算、经费与费用垂直闭环 | 未开始 | — |
| 4 | 工时与统一经营视图 | 未开始 | — |
| 5 | 系统验收 | 未开始 | — |

## 契约冻结记录

| 日期 | 文件 | 版本 | 说明 |
|---|---|---|---|
| 2026-10-26 | docs/arch/00 技术基线与目录结构 | v1.0 | 栈、目录、横切铁律、认证/文件/错误 |
| 2026-10-26 | docs/arch/01 数据模型与状态机 | v1.0 | 迭代 0 十五表、状态机、台账口径 |
| 2026-10-26 | docs/arch/02 API契约与公共规范 | v1.0 | 迭代 0 契约（auth/project/files）冻结 |
| 2026-10-26 | docs/arch/03 权限与审批模型 | v1.0 | 角色、矩阵、无泄露策略、审批引擎设计 |

## 迭代 0 工单状态

| 工单 | 会话 | 状态 | 认领人 | 日期 | 备注 |
|---|---|---|---|---|---|
| 00 总览 | — | 已发布 | 架构 | 2026-10-26 | — |
| 01 开发环境与仓库骨架 | 部署 | 待验收 | 部署会话 | 2026-10-26 | 全项目阻塞点，最先启动；5432 被占已裁定：lexflow 用 15432（见交接记录） |
| 02 地基数据建模与种子 | 数据 | 未认领 | | | 依赖 01 |
| 03 服务端地基 | 后端 | 未认领 | | | 依赖 01，联调依赖 02 |
| 04 前端壳重构 | 前端 | 未认领 | | | 依赖 01，按冻结契约可并行 |
| 05 测试设施与验收 | 测试 | 未认领 | | | 收口单，设施可先行 |

## 偏差与仲裁

| 日期 | 会话 | 事项 | 架构裁定 | 状态 |
|---|---|---|---|---|
| — | — | — | — | — |

## 交接记录（新条目置顶，格式：日期｜会话｜工单｜内容）

- 2026-10-26｜部署｜01｜端口冲突已裁定（项目方用户决策，替代架构裁定）：jtl-postgres 保持运行，lexflow 的 Postgres 宿主映射改为 `15432:5432`。已落地：`docker-compose.yml` 端口 15432:5432；`.env.example` 与本地 `.env`（未入库）的 `DATABASE_URL`/`DATABASE_URL_TEST` 端口改 15432；`docs/开发环境.md` 端口与连接串说明同步。复验：`docker compose up -d` 容器 healthy（pg_isready），宿主 TCP 15432 连通，容器内 psql 验证 `lexflow` 与 `lexflow_test` 均 `select 1` 成功（命名卷数据保留，init 未重跑但两库仍在）。commit `0b93dc4 [部署] Postgres 宿主端口裁定改为 15432`。前条交接记录中"5432 待决策"一项以此条为准、关闭。注意：工单原文与 arch/00 §2 目录注释写的 5432:5432 与本裁定存在偏差，已在 STATUS 留痕；其他会话（02/03/05）连接数据库一律用 `localhost:15432`。
- 2026-10-26｜部署｜01｜完成仓库骨架与 Postgres 环境，状态转「待验收」。做了什么：`git init`（分支 main，3 个 `[部署]` 前缀 commit）；按 arch/00 §2 创建根 `package.json`（workspaces: app/server/shared，内容逐字照抄基线代码块）与 `tsconfig.base.json`（strict/moduleResolution:bundler/target:ES2022/paths→shared）；`shared/`（@lexflow/shared，main: src/index.ts，peer zod ^4，空 barrel + tsconfig）；`server/`（@lexflow/server，dev/typecheck/test/db:generate/db:migrate/db:seed 六个 echo 占位脚本 + tsconfig，无业务文件）；`app/` 改名 @lexflow/app、加 `typecheck: tsc -b --noEmit`、删除 `app/package-lock.json`；根 `docker-compose.yml`（postgres:16、POSTGRES_USER=lexflow、POSTGRES_PASSWORD 取自 .env、5432:5432、命名卷 lexflow-pgdata、pg_isready healthcheck、`docker/postgres/init/` 首启建 `lexflow_test`）；`.env.example`（工单 6 键 + compose 所需的 POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB，值与 DATABASE_URL 一致）；新建 `docs/开发环境.md`（根无 README.md，按工单走备选）；生成 `.env`（32 字节随机 SESSION_SECRET，已被 .gitignore 拦挡未入库）。怎么验证：根 `npm install` 成功（479 包，exit 0，`npm query .workspace` 确认三 workspace）；根 `npm run typecheck` 通过（app `tsc -b --noEmit` 无错误 + server 占位 echo）；`docker compose up -d` 容器 healthy（pg_isready），容器内 `psql "postgres://lexflow:lexflow_dev@localhost:5432/lexflow"` 与 `.../lexflow_test` 各 `select 1` 成功，`docker compose config` 校验通过；`git log --oneline` 3 个规范前缀 commit。留的坑（需人工决策）：**本机宿主机 5432 已被其他项目容器 `jtl-postgres`（Up 13h healthy）占用**，规范端口 5432:5432 当前无法绑定。验证时临时改用 15432:5432 完成全部数据库验证后已把 compose 恢复为工单规定的 5432:5432，并 `docker compose down`（命名卷 `kimi_agent__lexflow-pgdata` 保留，两库已初始化，后续 `up` 不会重跑 init 但库已存在）。后续在本机执行 `docker compose up -d` 前，需先停用 jtl-postgres，或经架构会话裁定改映射端口（连带改 .env.example 的 DATABASE_URL 端口）；另本机无 psql 客户端，验收脚本里的 psql 命令需用 `docker exec lexflow-postgres psql ...` 替代。
- 2026-10-26｜架构｜全部｜迭代 0 架构基线与工单发布。启动顺序：01 → 02 ∥ 03 ∥ 04 → 05。
