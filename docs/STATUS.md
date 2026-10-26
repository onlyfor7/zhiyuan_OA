# STATUS · 项目协调看板

**维护规则：** 执行会话更新自己工单行 + 交接记录；架构会话更新冻结记录、仲裁与迭代状态。
**协议：** `docs/work-orders/README.md`　**基线：** `律所业务管理平台_Kimi_Code开发需求基线_v2.0.md`

## 当前迭代

**迭代 0 · 全栈地基与原型重构**（进行中）

## 迭代总览

| 迭代 | 内容 | 状态 | 验收通过日期 |
|---|---|---|---|
| 0 | 全栈地基与原型重构 | 进行中 | — |
| 1 | 项目治理真实闭环 | 未开始 | — |
| 2 | 会议与出差垂直闭环 | 未开始 | — |
| 3 | 预算、经费与费用垂直闭环 | 未开始 | — |
| 4 | 工时与统一经营视图 | 未开始 | — |
| 5 | 系统验收 | 未开始 | — |

## 契约冻结记录

| 日期 | 文件 | 版本 | 说明 |
|---|---|---|---|
| 2026-10-26 | docs/arch/00 技术基线与目录结构 | v1.0 | 栈、目录、横切铁律、认证/文件/错误 |
| 2026-10-26 | docs/arch/01 数据模型与状态机 | v1.0 | 迭代 0 十六表、状态机、台账口径 |
| 2026-10-26 | docs/arch/02 API契约与公共规范 | v1.0 | 迭代 0 契约（auth/project/files）冻结 |
| 2026-10-26 | docs/arch/03 权限与审批模型 | v1.0 | 角色、矩阵、无泄露策略、审批引擎设计 |
| 2026-10-26 | docs/arch/00 §3.5 | v1.1 | 编号前缀注册表增补 CLT（客户）/ MTR（事项） |
| 2026-10-26 | docs/arch/01 §2 | v1.1 | 密级四级冻结：public < internal < confidential < secret |
| 2026-10-26 | docs/arch/02 §3.1 | v1.1 | 会议类型 5 值、费用类别 8 值默认集冻结（迭代 2/3 由数据会话补入 shared） |

## 迭代 0 工单状态

| 工单 | 会话 | 状态 | 认领人 | 日期 | 备注 |
|---|---|---|---|---|---|
| 00 总览 | — | 已发布 | 架构 | 2026-10-26 | — |
| 01 开发环境与仓库骨架 | 部署 | **通过** | 部署会话 | 2026-10-26 | 架构会话已验收（验收证据见交接记录置顶条）；端口裁定 15432 已吸收进基线 |
| 02 地基数据建模与种子 | 数据 | **通过** | 数据会话 | 2026-10-26 | 架构会话已验收；4 项偏差全部裁定关闭（见偏差与仲裁） |
| 03 服务端地基 | 后端 | **待验收** | 后端会话 | 2026-10-26 | 串行第 2 棒，已交付（含 2 项待裁定偏差，见偏差与仲裁） |
| 04 前端壳重构 | 前端 | 未认领 | | | 串行第 3 棒，待 03 通过 |
| 05 测试设施与验收 | 测试 | 未认领 | | | 收口单，待 02/03/04 通过 |

## 偏差与仲裁

| 日期 | 会话 | 事项 | 架构裁定 | 状态 |
|---|---|---|---|---|
| 2026-10-26 | 部署 | Postgres 宿主端口 5432 被 jtl-postgres 占用，按用户裁定改用 15432；部署会话留痕称与工单 01 及 arch/00 §2 存在文字偏差 | 接受裁定。核查后 arch/00~03 无任何 5432 硬编码，冻结基线无需修订；工单 01 原文两处已改为 15432 并加裁定说明。后续会话连接数据库一律 `localhost:15432` | 已关闭 |
| 2026-10-26 | 数据 | 工单 02 写「15 张表」，但 arch/01 §1 迭代 0 清单实际列 16 张（含 notifications）。数据会话按冻结表清单落实 16 张 | **裁定：以 16 张为准。** 数据会话做法正确；工单 02 计数文字错误已修订，冻结记录同步更正 | 已关闭 |
| 2026-10-26 | 数据 | arch/01 要求 clients/matters 持唯一 code，但 arch/00 §3.5 编号前缀注册表无客户/事项前缀。数据会话暂补 CLT/MTR 进 shared/constants.ts 注册表并用于种子 | **裁定：接受 CLT/MTR**，正式增补进 arch/00 §3.5（v1.1）；constants.ts 注释已同步为正式状态 | 已关闭 |
| 2026-10-26 | 数据 | 密级枚举具体取值各基线未冻结。数据会话采用 public/internal/confidential/secret 四级（pgEnum confidentiality_level） | **裁定：冻结该四级取值**（public < internal < confidential < secret 逐级升高），已写入 arch/01 §2（v1.1）；shared 注释已同步 | 已关闭 |
| 2026-10-26 | 数据 | arch/02 §3 要求 shared/enums 含会议类型、费用类别，但任何基线未冻结其取值。数据会话未发明，留待裁定后补 | **裁定：默认集已冻结**——会议类型 5 值、费用类别 8 值（arch/02 §3.1 v1.1）；迭代 2/3 建表时由数据会话补入 shared/enums 与 DB，届时无需再裁定 | 已关闭 |
| 2026-10-26 | 后端 | arch/00 §4「登出删除服务端会话」与 arch/01 §6（audit_events.session_id → sessions 外键 ON DELETE RESTRICT）冲突：审计行持续引用会话，物理删除在存在任何审计引用时必失败（实测 logout 500 FK 违例）。后端临时按「登出=expires_at 立即过期」实现，行为等效满足验收场景 4（会话即刻不可用），sessions 表残留过期行 | 待架构裁定。候选：a) 维持立即过期+未来清理任务（推荐，审计留痕完整）；b) 去除 audit_events.session_id 外键（应用层引用），恢复物理删除。c) 登出审计不写 session_id（仅解近渴，历史审计引用仍会挡删除）。裁定前维持临时实现 | 待裁定 |
| 2026-10-26 | 后端 | arch/02 §5 冻结的 SOURCE_TYPE 无 `project` 取值，但迭代 0 文件上传契约（arch/02 §4）需直接挂载项目（验收场景 3），且 file 表无 source 列、来源只能经上传参数表达。后端临时在 upload 端点接受 SOURCE_TYPE ∪ {project}（仅入口校验与审计 jsonb，不触碰 DB 枚举） | 待架构裁定。建议：将 `project` 增补进 SOURCE_TYPE（shared 改需架构会话），或迭代 1 由 archive_links 承接项目维度文件挂接后收紧校验。裁定前维持临时实现 | 待裁定 |

## 交接记录（新条目置顶，格式：日期｜会话｜工单｜内容）

- 2026-10-26｜后端｜03｜**工单 03 完成，转待验收。**做了什么：① server 依赖 `hono@4.13 / @hono/node-server@2.1 / @hono/trpc-server@0.4.2 / @trpc/server@11.19`（zod 复用）；② `src/env.ts` zod 全量校验（DATABASE_URL/SESSION_SECRET/STORAGE_DIR/PORT=3001/SESSION_TTL_HOURS=8/FILE_MAX_MB=20，STORAGE_DIR 解析绝对路径）；③ 认证 `modules/auth/`：login 复用 `lib/password.ts` scrypt（失败统一「邮箱或密码错误」）、会话=sessions 表存 token sha256、cookie `lexflow_session`（HttpOnly/SameSite=Lax/Path=/，经 tRPC `resHeaders` 下发——@hono/trpc-server 不透传 Hono 上下文头）、账号 disabled 或过期立即 AUTH_REQUIRED；logout 与 me 按契约；④ 权限 `services/access/`：`can(user,action,resource)` 实现 project.read/archive.read（文件）/admin.config 三路径，其余默认拒绝；`projectScopeFilter(user)` 返回 SQL 片段（成员 ∪ 有效未过期授权）直接拼 where，SQL 级过滤；⑤ 审计 `services/audit/record()` + 变更类中间件自动写 audit_events：成功走事务同事务，失败走全局池独立提交（tRPC v11 中间件 next() 返回 {ok} 结果不抛错，事务中间件对 !ok 显式抛错触发回滚）；⑥ routers 按 arch/02 §4 逐字：`auth.login/logout/me`、`project.list`（游标分页 keyset updated_at+id、filters lifecycle/health/keyword）、`project.getById`（无权限 ACCESS_DENIED_OR_GONE）、`user.listProjectMembers`；⑦ 文件路由 `routes/files.ts`：upload（白名单 pdf/png/jpg/jpeg/docx/xlsx/zip + 20MB + sha256 + storage_key=uuid.扩展名服务端生成防穿越 + 同事务审计）、download/preview（session 或 ≤15min 令牌、一令一文件、无权限与不存在同形 404、Cache-Control: private, no-store、敏感读取显式审计）；⑧ 统一错误 `lib/errors.ts`：BusinessError 映射冻结错误码，zod→VALIDATION_FAILED 带 fieldErrors，兜底 INTERNAL 无堆栈带 requestId，形状 `{message,code,data:{businessCode,requestId,fieldErrors?}}` 前后端一致；⑨ 测试 `tests/api/` 19 用例（env-setup 锁测试库+临时存储；登录/登出/me 全流程、两账号 list 范围不同、member 直取 C 同形 404、越权下载拒绝、审计行、停用即失效、令牌篡改即拒、白名单/超限校验）。怎么验证（逐条照工单验收命令）：`npm run test -w @lexflow/server` 24/24 绿（含工单 02 数据测试 5）✓；`npm run dev -w @lexflow/server` 启动 /health 200 ✓；curl 手测 dev 库：登录→me→project.list、multipart 上传→下载 sha256 两端一致、member 越权 404 同形、匿名 401、不存在 404 同形、错误口令统一提示✓；根 `npm run typecheck` 双 workspace exit 0✓。**给前端的关键路径**：AppRouter 导出在 `server/src/trpc/routers/index.ts`（`export type AppRouter = typeof appRouter`）；错误形状如上（401 跳登录、NOT_FOUND 形态 data.businessCode=ACCESS_DENIED_OR_GONE→403/404 页、fieldErrors 映射表单）；tRPC v11 query 仅接受 GET（标准 client 自动处理，勿手写 POST 查 query）；文件下载/预览直链 `GET /files/:fileVersionId/download|preview?token=`，令牌签发 `server/src/services/file/tokens.ts` `signDownloadToken(fileVersionId)`（HMAC-SHA256/SESSION_SECRET，payload=fileVersionId.exp，当前无对外签发端点——迭代 1 按 AccessGrant 流程暴露，前端暂用 cookie 方式即可）。**留坑/待办**：⑴ 两项偏差待架构裁定（登出立即过期方案 vs 物理删除 FK 冲突；SOURCE_TYPE 增补 project 或迭代 1 由 archive_links 承接），见「偏差与仲裁」末两行；⑵ file_objects 业务来源未建链（迭代 1 文件域），故项目成员暂不能读他人上传文件——当前判定=上传人本人+file 范围有效授权，迭代 1 须补「来源项目成员放行」分支（canReadFile 已留注释位）；⑶ 密级 ABAC 第三级（对象密级≤主体授权密级）迭代 0 无主体密级数据源，未实现，arch/03 §2.3 钩子预留；⑷ audit_events 只追加仍为应用层自律（recordAudit 仅 insert，无 update/delete 路径），DB 角色加固仍留部署/后端后续评估（承数据会话）；⑸ 上传落盘在事务提交前，DB 失败会留孤儿文件（开发存储可容忍，迭代 1 文件域可补清理）；⑹ 会话 cookie Max-Age 与 SESSION_TTL_HOURS 一致，会话续期策略（滑动续期）未定，当前为固定时长。提交：`iter0/server-foundation` 分支 `[后端]` 前缀 commit（随本条同入）。
- 2026-10-26｜架构｜02｜**工单 02 验收通过，4 项偏差全部裁定关闭。** 复核：DB `\dt` 16 表齐备；vitest 5/5 绿（干净库迁移重放、种子幂等+验收布局、next_code 并发 20 无重号）；种子布局正确（pm@→PRJ-2026-00001/00002，member@→仅 00001，00003 对二者隔离）；根 typecheck exit 0；schema/shared 与冻结基线一致。裁定落地：①表数以 16 为准，工单文字已更正；②CLT/MTR 接受并入 arch/00 §3.5 v1.1；③密级四级冻结入 arch/01 §2 v1.1；④会议类型 5 值/费用类别 8 值默认集冻结入 arch/02 §3.1 v1.1，迭代 2/3 由数据会话补入 shared。**解锁工单 03（后端会话）**——注意：口令散列复用 `server/src/lib/password.ts`；dev 库已含种子可直接联调。遗留跟踪（不阻塞）：npm audit 4 moderate（vitest/esbuild 链，迭代 5 前评估）；audit_events DB 层写权限加固转后端/部署评估；测试库每次 DROP 重建为既定设计。
- 2026-10-26｜数据｜02｜**工单 02 完成，转待验收。**做了什么：① server workspace 依赖（drizzle-orm/pg/zod + drizzle-kit/tsx/vitest/@types/pg dev，另声明 "@lexflow/shared": "\*" workspace 依赖）；② `server/drizzle.config.ts` + `server/src/db/client.ts`（连接池读 DATABASE_URL，进程未注入时从根 .env 兜底，小函数在 `server/src/db/env.ts`，全量 env 校验仍属工单 03）+ `server/src/lib/password.ts`（**scrypt 口令散列函数位置，后端会话复用**：`hashPassword`/`verifyPassword`，格式 `scrypt$N$r$p$salt$hash`，node:crypto 无原生依赖）；③ arch/01 §1 迭代 0 全部 **16** 张表（工单原文与 STATUS 冻结记录写「15」，实际清单 16 张含 notifications，按冻结清单落实，已登记偏差）：通用字段含 row_version 与审计四件套、6 个 pgEnum（用户状态/密级/项目生命周期/健康度/授权状态/授权范围）、全部 FK 显式 `ON DELETE RESTRICT`、`code`/`token_hash`/`storage_key`/sha256 等索引约束按 arch/01 §6；④ `server/src/db/code.ts` `next_code(prefix)` 单语句 `INSERT ... ON CONFLICT DO UPDATE next_value+1 RETURNING`，可传 tx，并发安全；⑤ 首个迁移 `server/drizzle/0000_iter0-foundation.sql`（drizzle-kit generate 产出，按时间序追加、禁改已提交迁移）；⑥ shared/src：enums（arch/01 §3 全量状态机 + 角色 key/密级/台账分录/source_type/审批动作/工时活动类型/通知事件类型）、constants（编号前缀表 + §18 配置键 12 个）、errors（arch/02 §6 全量错误码）、permissions（arch/03 §3 全量 28 动作注册表）；⑦ 种子 `server/src/db/seed/index.ts`（事务内全 upsert 幂等：1 律所+3 部门、8 角色、12 用户口令统一 Demo@2026（scrypt）、2 客户、2 事项、3 项目——**pm@lexflow.demo 负责 PRJ-A/B、member@lexflow.demo 仅 A 成员、C 对二者不可见（验收场景 1/2 布局）**，code_sequences 水位对齐防 next_code 撞号）；⑧ system_config 写入需求基线 §18 全部 12 项默认配置（键在 shared/constants.ts CONFIG_KEY，值 JSON，不落硬编码）；⑨ 测试 `server/tests/db/`（vitest）：干净 lexflow_test 重放迁移 16 表齐备+重复迁移幂等、next_code 并发 20 无重号、种子二次执行行数不变+布局断言+口令散列校验。怎么验证（逐条照工单验收命令）：`npm run db:migrate`✓；`npm run db:seed` 连跑两次无重复行（dev 库累计 3 次行数不变：users 12/roles 8/org 4/members 8/cfg 12）✓；`DATABASE_URL=$DATABASE_URL_TEST npm run db:migrate`✓；`npm run test -w @lexflow/server` 3 文件 5 用例全绿✓；`psql \dt` 16 张业务表（容器内 `docker exec lexflow-postgres psql ...`，宿主无 psql）✓；`npm run typecheck` 根级 exit 0✓。提交：分支 `iter0/data-foundation`，commit `be4bdc1 [数据] 工单02：迭代0十六表地基schema、迁移、next_code、种子与数据层测试`。**留坑/待办**：⑴ 4 项偏差已登记「偏差与仲裁」待架构裁定（16 vs 15 表数、CLT/MTR 前缀、密级取值、会议/费用类别枚举未发明）；⑵ npm audit 4 个 moderate（vitest/esbuild 依赖链，未处理）；⑶ STATUS.md 与 docs/work-orders 下架构会话串行模式修订（共 7 个 docs 文件）本会话未提交，与本次 STATUS 更新同在工作区——docs 提交归架构会话；⑷ dev 库已含种子数据，工单 03 后端会话可直接对真实库联调；⑸ audit_events ORM 层无 update/delete 调用路径（应用层自律），DB 角色权限加固留给部署/后端会话评估；⑹ 测试库 lexflow_test 每次跑测试会 DROP SCHEMA 重建（含 drizzle 簿记 schema），勿存放手工数据。
- 2026-10-26｜架构｜全部｜**执行模式调整：并行改串行。** 因同一项目目录下会话只能串行执行，迭代 0 执行链定为 02（数据）→ 03（后端）→ 04（前端）→ 05（测试收口），任何时刻仅一个工单「进行中」，上一棒验收通过才解锁下一棒；此前「02/03/04 并行」的安排作废。工单 00 总览、工单 02~05 依赖行、README 协议均已同步修订。**当前解锁：工单 02（数据会话）。**
- 2026-10-26｜架构｜01｜**工单 01 验收通过。** 逐项核验：git 6 个规范前缀 commit 且工作区干净；根 package.json 与 arch/00 §2 逐字一致；tsconfig.base.json 符合规范；shared/server 骨架正确（占位脚本指向责任工单）；app 已改名 @lexflow/app、旧 lockfile 已删、根 `npm install` 479 包 workspaces 解析正常、根 `npm run typecheck` 通过；docker-compose 端口 15432:5432、healthcheck、命名卷、`docker/postgres/init` 建 lexflow_test；容器 healthy，宿主 TCP 15432 连通，lexflow/lexflow_test 双库可连；.env 未入库。端口偏差已在「偏差与仲裁」关闭。**解锁工单 02/03/04**，启动顺序：数据 02 与后端 03、前端 04 并行。

- 2026-10-26｜部署｜01｜端口冲突已裁定（项目方用户决策，替代架构裁定）：jtl-postgres 保持运行，lexflow 的 Postgres 宿主映射改为 `15432:5432`。已落地：`docker-compose.yml` 端口 15432:5432；`.env.example` 与本地 `.env`（未入库）的 `DATABASE_URL`/`DATABASE_URL_TEST` 端口改 15432；`docs/开发环境.md` 端口与连接串说明同步。复验：`docker compose up -d` 容器 healthy（pg_isready），宿主 TCP 15432 连通，容器内 psql 验证 `lexflow` 与 `lexflow_test` 均 `select 1` 成功（命名卷数据保留，init 未重跑但两库仍在）。commit `0b93dc4 [部署] Postgres 宿主端口裁定改为 15432`。前条交接记录中"5432 待决策"一项以此条为准、关闭。注意：工单原文与 arch/00 §2 目录注释写的 5432:5432 与本裁定存在偏差，已在 STATUS 留痕；其他会话（02/03/05）连接数据库一律用 `localhost:15432`。
- 2026-10-26｜部署｜01｜完成仓库骨架与 Postgres 环境，状态转「待验收」。做了什么：`git init`（分支 main，3 个 `[部署]` 前缀 commit）；按 arch/00 §2 创建根 `package.json`（workspaces: app/server/shared，内容逐字照抄基线代码块）与 `tsconfig.base.json`（strict/moduleResolution:bundler/target:ES2022/paths→shared）；`shared/`（@lexflow/shared，main: src/index.ts，peer zod ^4，空 barrel + tsconfig）；`server/`（@lexflow/server，dev/typecheck/test/db:generate/db:migrate/db:seed 六个 echo 占位脚本 + tsconfig，无业务文件）；`app/` 改名 @lexflow/app、加 `typecheck: tsc -b --noEmit`、删除 `app/package-lock.json`；根 `docker-compose.yml`（postgres:16、POSTGRES_USER=lexflow、POSTGRES_PASSWORD 取自 .env、5432:5432、命名卷 lexflow-pgdata、pg_isready healthcheck、`docker/postgres/init/` 首启建 `lexflow_test`）；`.env.example`（工单 6 键 + compose 所需的 POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB，值与 DATABASE_URL 一致）；新建 `docs/开发环境.md`（根无 README.md，按工单走备选）；生成 `.env`（32 字节随机 SESSION_SECRET，已被 .gitignore 拦挡未入库）。怎么验证：根 `npm install` 成功（479 包，exit 0，`npm query .workspace` 确认三 workspace）；根 `npm run typecheck` 通过（app `tsc -b --noEmit` 无错误 + server 占位 echo）；`docker compose up -d` 容器 healthy（pg_isready），容器内 `psql "postgres://lexflow:lexflow_dev@localhost:5432/lexflow"` 与 `.../lexflow_test` 各 `select 1` 成功，`docker compose config` 校验通过；`git log --oneline` 3 个规范前缀 commit。留的坑（需人工决策）：**本机宿主机 5432 已被其他项目容器 `jtl-postgres`（Up 13h healthy）占用**，规范端口 5432:5432 当前无法绑定。验证时临时改用 15432:5432 完成全部数据库验证后已把 compose 恢复为工单规定的 5432:5432，并 `docker compose down`（命名卷 `kimi_agent__lexflow-pgdata` 保留，两库已初始化，后续 `up` 不会重跑 init 但库已存在）。后续在本机执行 `docker compose up -d` 前，需先停用 jtl-postgres，或经架构会话裁定改映射端口（连带改 .env.example 的 DATABASE_URL 端口）；另本机无 psql 客户端，验收脚本里的 psql 命令需用 `docker exec lexflow-postgres psql ...` 替代。
- 2026-10-26｜架构｜全部｜迭代 0 架构基线与工单发布。启动顺序：01 → 02 ∥ 03 ∥ 04 → 05。
