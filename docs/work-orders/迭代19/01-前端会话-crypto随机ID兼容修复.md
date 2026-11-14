# 迭代 19 · 工单 01：外测 HTTP 环境 randomUUID 兼容修复（前端会话）

**触发：** 手册专项 D-MAN-4。外测 `http://182.92.206.62:8080` 为 HTTP+IP 非安全上下文，部分浏览器不提供 `crypto.randomUUID()`，点击线索「转化」等入口会出现 `TypeError: crypto.randomUUID is not a function` 并落入错误边界。
**基线：** `iter18/test-acceptance@94bccc3`
**产出分支建议：** `iter19/frontend-crypto-compat`
**边界：** 只改 `app/` 与完成时 STATUS；不改 server/schema/迁移/e2e/部署，不动外测 prod。修复后另行发布与复验。

## 范围

1. 在 `app/src/lib/form.ts` 建立唯一客户端 ID 生成入口（沿用 `newIdempotencyKey` 或新增 `newClientKey` 并统一调用）：
   - 优先 `globalThis.crypto.randomUUID()`；
   - 若不可用但 `crypto.getRandomValues` 可用，用 16 字节随机数构造 RFC4122 v4 UUID（设置 version/variant 位）；
   - 两者都不可用时再使用带进程内计数器+时间戳的最后兜底，禁止只依赖 `Math.random()`；
   - 返回值仍满足现有 uuid zod 校验格式。
2. 替换全部直接调用点，目标 `crypto.randomUUID()` 全局清零。当前已知：
   - `app/src/lib/form.ts`
   - `app/src/pages/crm/lead-drawer.tsx`
   - `app/src/pages/crm/OpportunitiesPage.tsx`
   - `app/src/pages/ExpenseNewPage.tsx`
   - `app/src/pages/TimeCenterPage.tsx`
   - `app/src/pages/TravelNewPage.tsx`
   - `app/src/pages/project/SimulatePanel.tsx`
   - `app/src/components/participant-utils.ts`（2 处）
3. 不改变服务端幂等语义；客户端仅改变 ID 生成兼容性。

## 测试与走查

- app 单元测试：
  - 原生 randomUUID 可用时优先使用；
  - `randomUUID` 缺失但 `getRandomValues` 可用时生成合法 UUID v4；
  - 连续生成 1000 个无重复；
  - 最后兜底不抛错且格式合法。
- 根质量门：`typecheck / build / db:migrate / test` 全绿。
- 外测复验在后续部署工单执行；本棒可先用普通 Chrome（不得使用 `--unsafely-treat-insecure-origin-as-secure`）访问 HTTP 外测或本地非 localhost 等价环境，确认线索转化/新建商机/报销/出差/工时/计划模拟/会议参与人入口不再崩溃。

## 完成动作

- STATUS 19-01 转「待验收」+ 交接记录置顶，写明替换点数量、测试与外测无 flag 验证结果；
- 提交前缀 `[前端]`；
- 验收通过后发布 19-02 外测 web 补发，再由测试会话复拍手册受影响截图并收口专项。
