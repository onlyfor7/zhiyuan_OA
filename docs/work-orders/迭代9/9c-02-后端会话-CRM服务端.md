# 迭代 9c · 工单 02：CRM 服务端（后端会话）

**依赖：** 工单 01 通过　**产出分支建议：** `iter9c/server-crm`

## 范围

1. **权限**（arch/12 §11）：注册 `crm.read`（partner 全局只读穿透 + finance + 项目负责人 + owner 本人 + 有效授权）与 `crm.manage`（owner/partner）；member 默认 404 同形；金额字段对无 fin.read 者响应剔除（R1 沿用）。
2. **线索**：`crm.leads.list/create/update/disqualify/convert`——convert=事务内（建/选客户 + 建商机 + 线索置 converted 写回 id），幂等键防重。
3. **客户**：`crm.customers.list/getById`（详情聚合：概况+联系人+商机+合同+项目+往来文件+跟进时间线六区数据）、`crm.customers.update`、`crm.contacts.create/update/delete`。
4. **商机**：`crm.opportunities.list/create/update/setStage`（看板拖拽走 setStage，审计）/`markWon`——won 必须挂合同（同事务建合同 draft→active 可选）/`markLost`（原因必填）。
5. **合同**：`crm.contracts.list/getById/create/update/activate/terminate`、`crm.paymentPlans.upsert`（行编辑同事务）。
6. **回款勾稽**：`receipts.create/void` 增强——可选挂 contractId+planId：登记同事务更新计划行状态（unpaid/partial/paid）与合同累计回款；作废冲正回写；不挂合同维持原语义（兼容存量）。
7. **跟进**：`crm.followups.list/create`（多态校验目标存在性）。

## 验收

转化/赢单/勾稽事务三链路用例（含回滚与幂等重放）；权限三探针+金额剔除；根四道门全绿；e2e 不回归。

**完成动作：** STATUS 工单行+交接记录。
