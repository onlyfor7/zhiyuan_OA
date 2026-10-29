# 迭代 6 · 工单 09b：补 travel_change 默认审批流（数据会话 · 微工单）

**依赖：** 工单 09 通过（穷尽测试发现）　**产出分支建议：** `iter6/data-travel-change-flow`

## 背景（架构裁定）

穷尽测试实测：干净系统（minimal/重灌）上 travel_change 无默认流程 → 出差变更提交 412。根因：迭代 6 工单 02 策略迁移把 13 条 approval_policies 转 8 条默认流程时漏了 travel_change（等价用例未覆盖该 biz_type）。

## 范围（做）

1. 种子补 `travel_change 默认流程`（[project_manager]，与迭代 2 策略语义一致），full/minimal 双档。
2. **等价性用例补强**：逐个 biz_type 断言「每个引擎接入的 biz_type 恰有 ≥1 条 enabled 默认流程」（含 travel_change/generic_request）——防再漏。
3. dev/prod 存量库补齐：dev 幂等重跑 seed；prod 当前已有（测试会话现场建的那条），种子需检测共存不冲突（按 name+enabled 幂等）。

## 验收

```bash
npm run test -w @lexflow/server && npm run typecheck && npm run db:seed && npm run db:seed
```

**完成动作：** 更新 STATUS.md + 交接记录。
