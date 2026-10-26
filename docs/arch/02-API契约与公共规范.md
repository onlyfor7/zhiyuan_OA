# 架构基线 02 · API 契约与公共规范

**裁定方：** 架构会话　**状态：** 迭代 0 部分已冻结；业务域契约随各迭代冻结并记录于 STATUS.md
**原则：** 前后端只对本文与 `shared/` 包编码。契约变更只能由架构会话修订本文；私自加字段、改语义视为返工。

---

## 1. tRPC 组织规范

- 命名空间按业务域：`auth / user / project / task / meeting / travel / budget / funding / expense / time / quality / decision / archive / approval / notification / audit / dashboard / report / admin / search`。
- 每个域一个 router 文件（`server/src/trpc/routers/<domain>.ts`），业务逻辑在 `modules/` service 层，router 只做：鉴权 → 入参校验 → 调 service → 返回。service 层不感知 HTTP/tRPC。
- 所有 procedure 使用统一中间件链：`logging → session → rbac(按需) → audit(变更类)`。

## 2. 过程命名与形态约定

| 模式 | 命名 | 输入 | 输出 |
|---|---|---|---|
| 列表 | `<domain>.list` | `{ cursor?, limit(≤100, 默认20), filters…, sort? }` | `{ items[], nextCursor: string|null }` —— 游标分页，禁止 offset 大页 |
| 详情 | `<domain>.getById` | `{ id }` | 对象或 `NOT_FOUND`（含无权限，见 arch/03 §5） |
| 创建 | `<domain>.create` | 业务字段 + `idempotencyKey` | 完整对象 |
| 更新 | `<domain>.update` | `{ id, row_version, …patch }` | 更新后对象（`row_version+1`） |
| 状态动作 | `<domain>.submit / .approve / .reject / .withdraw / .close / .lock / .unlock …` | `{ id, row_version, idempotencyKey, …动作参数 }` | 更新后对象 |
| 删除 | `<domain>.discard` | `{ id, row_version, reason? }` | `{ ok: true }` —— 仅草稿态可用 |

规则：
- **状态不得通过 `update` 直接改**；每个状态迁移是独立命名动作，服务端校验状态机（arch/01 §3）。
- 创建/动作类 mutation 必须幂等（arch/00 §3.7）。
- 金额字段一律 `amountCents: number(整数)`；工时 `durationMinutes: number(整数)`；时间一律 ISO 8601 字符串。
- 列表与统计必须服务端过滤权限；统计接口返回 `{ value, asOf, statusScope }` 口径说明，同名指标全站同数（基线 §12.3）。

## 3. 共享包（shared/）内容清单

| 模块 | 内容 |
|---|---|
| `enums/` | 全部状态机枚举（arch/01 §3 全部状态值）、角色 key、会议类型、费用类别、活动类型、台账分录类型、审批动作、密级、通知事件类型 |
| `constants.ts` | 编号前缀表、基线 §18 默认配置的**配置键名**（默认值在 DB 种子，代码引用键名） |
| `errors.ts` | 业务错误码常量（见 §6） |
| `types/` | 跨端 DTO（仅契约需要的；实体全量类型以 server drizzle schema 为准，经 router 输出推断共享给前端） |

前端类型来源优先级：tRPC 推断（`AppRouter` 类型）> shared DTO。**禁止前端自行重新定义已存在的后端类型。**

## 4. 迭代 0 冻结契约（前后端按此并行开发）

```text
auth.login      { email, password } → { user: { id, email, name }, mustChangePassword? }
auth.logout     {} → { ok: true }
auth.me         {} → { user: { id, email, name, orgUnit }, globalRoles: string[],
                       projects: { id, name, code, projectRole }[] } | UNAUTHORIZED

project.list    { cursor?, limit?, filters: { lifecycle?, health?, keyword? } }
                → { items: ProjectSummary[], nextCursor }      -- 已按权限过滤
project.getById { id } → ProjectDetail | NOT_FOUND              -- 无权限同形

user.listProjectMembers { projectId } → { userId, name, projectRole }[]  -- 需项目可见权

-- 文件（Hono 原生路由，非 tRPC）
POST   /files/upload            multipart: file, sourceType, sourceId, businessDate?
                                → { fileVersionId, fileObjectId, sha256, sizeBytes }
GET    /files/:fileVersionId/download?token=   → 二进制流（鉴权：session 或 ≤15min 短期 token）
GET    /files/:fileVersionId/preview           → 同上，Content-Disposition: inline
```

`ProjectSummary`（迭代 0）`{ id, code, name, clientName, matterName, managerName, lifecycleStatus, healthStatus, confidentialityLevel, updatedAt }`；`ProjectDetail` = Summary + `{ memberCount, myRole }`。
> 迭代 0 的统计字段（预算/工时等）不出现在契约中；前端相应区域按 arch/工单要求显示「未接入」，不得造数。

## 5. 通知与审批的通用关联

- 任务、行动项、审批、通知、审计一律 `source_type`（枚举：`meeting/travel/funding/expense/time_entry/change_request/quality_issue/decision/plan/budget/access_grant/report`）+ `source_id`。
- 待办中心（迭代 1）查询这些公共表的并集视图，不各模块自建待办。

## 6. 错误码（`shared/errors.ts` 常量 + tRPC code 映射）

| 业务错误码 | tRPC code | 语义 |
|---|---|---|
| `AUTH_REQUIRED` | UNAUTHORIZED | 未登录/会话失效 |
| `ACCESS_DENIED_OR_GONE` | NOT_FOUND | 详情/直链的无权限统一形态（不泄露存在性） |
| `VALIDATION_FAILED` | BAD_REQUEST | zod 字段错误，cause 带字段映射 |
| `STATE_CONFLICT` | CONFLICT | row_version 不匹配或状态机不允许的迁移 |
| `DUPLICATE_SUBMIT` | CONFLICT | 幂等键命中但负载不同（重放同负载应返回首次结果，不报错） |
| `SELF_APPROVAL_BLOCKED` | FORBIDDEN | 申请人不得自审 |
| `BUDGET_EXCEEDED` | CONFLICT | 策略为禁止时的超预算 |
| `DUPLICATE_RECEIPT` | CONFLICT | 重复票据命中（带原报销定位信息） |
| `PERIOD_LOCKED` | FORBIDDEN | 工时周期已锁定 |
| `ARCHIVED_READONLY` | FORBIDDEN | 已归档只读 |
| `INTERNAL` | INTERNAL_SERVER_ERROR | 兜底，无堆栈，带 requestId |

## 7. 审计中间件规范（迭代 0 落地）

- 所有变更类 mutation 自动写 `audit_events`：actor、action（procedure 名）、target、result、before/after（更新类）、ip、session_id。
- 查询类中**敏感读取**（文件下载、导出、授权查看）也要审计——由 service 显式调用 `audit.record()`。
- 审计写入与业务写入同事务；审计表只追加。

## 8. 前端数据层规范（迭代 0 落地）

- 唯一入口：`app/src/lib/trpc.ts` 创建 tRPC client + React Query client；业务组件只允许调 hooks，不直接 fetch。
- 每域一个 hooks 文件 `app/src/api/<domain>.ts`；mutation 成功后失效相应 query key；错误统一映射到表单字段/页面级错误态。
- 401 → 跳登录页（保留回跳地址）；`ACCESS_DENIED_OR_GONE` → 统一 403/404 页面；`STATE_CONFLICT` → 保留输入 + 提示刷新。
- 表单：react-hook-form + zod（shared schema 优先复用）；提交期间防重复点击；mutation 携带 `idempotencyKey`（表单挂载时生成）。
- 允许用 localStorage 的只有：列宽、主题、最近筛选等界面偏好（基线 §1.3）。
