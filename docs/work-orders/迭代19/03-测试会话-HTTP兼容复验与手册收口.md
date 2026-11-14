# 迭代 19 · 工单 03：HTTP 兼容复验与手册收口（测试会话）

**依赖：** 19-02 外测 web 补发通过。
**目标：** 在普通 Chrome、无 `--unsafely-treat-insecure-origin-as-secure` 的外测 HTTP 环境复验 D-MAN-4 已修复，并复拍受影响手册截图后收口手册专项。
**基线：** `iter19/frontend-crypto-compat@48e5467`
**边界：** 只改 e2e/手册/截图/manifest/STATUS；不改 app/server/部署。不得使用 Chrome insecure-origin flag。

## 范围

1. **外测 HTTP 场景复验**
   - 程序化确认普通 Chrome 下 `isSecureContext=false`，页面不再因 `crypto.randomUUID` 崩溃；
   - 覆盖入口：线索转化、新建商机、报销新建、出差新建、工时中心、会议参与人、计划模拟调整；
   - 每个入口至少打开一次并截图关键成功状态；不提交业务数据，或提交后按业务终态自清。

2. **手册受影响截图复拍**
   - 至少重拍 `03-03-lead-convert.png` 与 `04-14-archive.png`；
   - 若复验中发现其他失败页，同步替换；
   - 更新 manifest 采集时间，保持链接完整性。

3. **回归**
   - 根 `typecheck/build/db:migrate/test` 全绿；
   - 复跑手册链接完整性校验；
   - 复跑相关 app 单测与必要的 iter18 T5 路径（不扩大范围）。

4. **收口**
   - D-MAN-4 转已修复关闭；
   - 手册专项重新转「待验收」；
   - 交接记录写明普通 Chrome 复验结果、替换截图、链接校验与遗留。

## 完成动作

- STATUS 19-03 转「待验收」；
- 提交前缀 `[测试]`；
- 架构验收通过后关闭迭代 19 与手册专项。
