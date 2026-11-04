# 迭代 8 · 工单 06b：server api 套件偶发失败修稳（后端会话 · 微工单）

**依赖：** 工单 06 通过　**产出分支建议：** `iter8/server-partner-visibility`（续用）

**背景（架构验收实测，F2）：** 06 验收期根全量测试 3 跑 1 红——`tests/api/partner-visibility.test.ts`「写边界（06 打回扩展）」用例失败一次；同文件单跑 5/5 绿、其后全量复跑全绿。套件配置 `fileParallelism: false`（文件顺序执行）且每文件 `migrateFresh()+runSeed()` 重建测试库，理论上确定，仍现非确定红。**产品行为已由架构独立证实无缺陷**（diff 核验 16 写门 + prod 实弹 4 类写 404 + 事务回滚无残留），本工单纯修测试稳定性。

## 范围（做）

1. **取证优先**：连跑根/server 全量 ≥6 轮（或循环至复现 ≥2 次），拿到失败断言原文——禁止未复现就改代码。架构后台已有一组连跑结果可索（主会话 wire 日志 bash-6mjihj1v）。
2. **定位方向（供参考，不限定）**：
   - 该用例为全套件最长文件之一（单跑 3.1s），`Promise.all` 并发 17 条写 404 + 5 条 member 写通对照，涉 `next_code` 并发、`meeting_participants` 直查 DB 时序、`quality.checklist` 首项假设；
   - 或套件级：前序文件遗留状态（config 改动未还原、流程 disable、会话/连接池残留）在长用例放大；
   - 或 `migrateFresh` 与应用连接池竞态（app 单例持旧连接）。
3. **修稳**：按定位结果修——用例自身问题就改用例（显式造数不假设、并发改串行、DB 直查加等待/重试），套件问题就修 helpers/顺序。修复后连跑 ≥6 轮全绿为证。
4. **验收**：`npm run test -w @lexflow/server` 连跑 6 轮全绿 + 根 `npm run test` 全绿 + typecheck/build exit 0。

**注意：** 不得通过删除/弱化断言来「修绿」；partner 写 404 逐条断言与 member 写通对照必须保留。

**完成动作：** 更新 STATUS.md 工单 06b 行 + 交接记录（新条目置顶），附失败断言原文与根因。
