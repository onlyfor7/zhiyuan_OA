# 迭代 17 · 工单 02：项目流编辑端点+SSE 底座+参照端点+命名裁定（后端会话）

**依赖：** 工单 01 通过　**产出分支建议：** `iter17/server-realtime`

## 范围（arch/12 §20.2/20.3/20.4 部分）

1. **§20.2**：新增 `project.flows.updateDraft`（负责人门，编辑本项目草稿 definitionJson/name，审计同事务，状态守卫仅草稿可改）。
2. **§20.3 SSE 底座**：新端点 `GET /events`（SSE 流，会话 cookie 鉴权）；进程内事件总线——业务写同事务后发事件（新通知/审批待办/小元新提醒条目）；心跳 25s 防代理断；**单进程形态，多实例换 PG LISTEN/NOTIFY 留坑注释**。
3. **§20.4 后端部分**：`project.financeOptions`（finance/partner 项目参照清单，最小字段）+ member 费用类别口径统一为**本人口径 200**（报销类别分析本人可见，与工时本人口径一致）+ reports/report 命名裁定（注释注明分层，不迁代码）。
4. 用例：updateDraft 权限/守卫/审计+SSE 连接与事件到达（事务发事件实证）+financeOptions 权限+费用类别口径翻转。

## 验收

根四道门全绿（F3 独占）；e2e 不回归。

**完成动作：** STATUS 工单行+交接记录。
