# 迭代 9c · 工单 01：CRM 数据建模与种子（数据会话）

**依赖：** 工单 00　**产出分支建议：** `iter9c/data-crm`

## 范围（arch/12 §6.2/§10 逐字）

1. **新表 6 张**：`crm_leads`（LD- 编号、source、status 状态机、owner_id、converted_*）、`crm_contacts`（customer FK、is_primary）、`crm_opportunities`（OPP-、customer FK、stage 阶段机、expected_amount_cents、win_rate、owner_id、won_contract_id）、`crm_contracts`（CTR-、opportunity FK、customer、matter?、amount_cents、signed_at、status 状态机）、`crm_contract_payment_plans`（contract FK、seq、due_date、amount_cents、status、receipt_id?）、`crm_followups`（多态 target lead/opportunity/customer）。
2. **`clients` 加列**：level、industry、address、owner_id、source_lead_id?（迁移回填默认）。
3. **枚举 5 个**（pgEnum+shared）：lead_status（new/contacted/qualified/converted/disqualified）、opportunity_stage（initial/needs/proposal/negotiation/won/lost）、contract_status（draft/active/completed/terminated）、payment_plan_status（unpaid/partial/paid）、followup 目标类型。
4. **编号前缀**注册 LD/OPP/CTR（arch/00 §3.5 登记）。
5. **种子**（full 档）：2 线索（1 new、1 qualified 挂梁奇烽 owner）、五客户补 level/industry、2 商机（比博思特客户 proposal 阶段挂王宝茁、GD 客户 won→合同）、1 合同（CTR 激活含 2 行付款计划）、3 跟进记录；minimal 档仅枚举/前缀/客户加列。

## 验收

迁移重放干净库全建；db:seed×2 幂等；新表约束（多态 target check、计划行唯一 seq）用例；计数断言连带更新；根 typecheck/测试全绿。

**完成动作：** STATUS 工单行+交接记录。
