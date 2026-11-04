# 迭代 8 · 工单 06：partner 全局只读可见 + 临时探针清理（后端会话 · 微工单）

**依赖：** 工单 05 通过（迭代 8 已收口）　**产出分支建议：** `iter8/server-partner-visibility`

**背景（用户裁定，2026-11-03）：** 梁奇烽为所合伙人、最高领导一把手，**可以看到任何项目**。工单 05 发现的「梁奇烽项目列表为空」由此定性：不是种子缺成员行，而是 partner 角色缺少全局可见性。**本工单不改种子、不加 project_members 行**（一把手不是具体项目的成员）。

## 冻结修订（架构已登记 STATUS 契约冻结记录）

- arch/03 §2.2 v1.1：**partner 全局只读可见**——`project.read` 与 `archive.read`（文件下载/预览）对 partner 全项目放行，与既有 `audit.read`（arch/03 §3 已含 partner）同级；密级不限制 partner 查阅。
- **边界不变**：`project.manage` 仍仅项目内 manager；审批/创建/编辑等一切写操作按各域既有规则——partner 看得到 ≠ 管得了。

## 范围（做）

1. **access 服务**（`server/src/services/access/index.ts`）：
   - `can(PROJECT_READ)`：`user.globalRoles.includes("partner")` → true（project 资源）；
   - `projectScopeFilter()`：partner 返回恒真条件（保持 SQL 级，不得查出后内存过滤）；
   - `canReadFile()`：partner → true（与 audit.read 同等待遇）。
2. **前端小修**（随本棒）：项目空间头部 `myRole` 为 null 且全局角色含 partner 时显示「我的角色：合伙人」（`ProjectSpacePage.tsx:75` 现状为 null 即不显示）。
3. **测试**：
   - 新增 api 用例：partner（liangqifeng）`project.list` 返回全部 5 项目；对佳力奇（C 项目，非成员）`project.getById` 200；partner 下载非成员项目文件放行；**对照组**：member（管晨）越权仍同形 404、viewer（何静）不扩散；
   - e2e 同步：iter8-acceptance 中「梁奇烽空列表/EmptyGuide」断言改为 5 项目可见；其余名单迁移断言不受影响（既有改走 sunhaoxiang/wangjiayu 的用例保持不动）。
4. **临时探针清理**：删除 `e2e/probe-i8.cjs`、`e2e/probe-i8b.cjs`、`e2e/probe-i8c.cjs`（未跟踪临时文件）。
5. **prod 残留清理**：prod 库 1 条未发布「探针-kind」草稿流程（工单 05 留痕），定位后删除该行（仅限未发布草稿，勿动启用中流程）。
6. **prod 发布（不删卷、不重置、会话不清）**：server 代码变更 → 按部署手册新规 `DOCKER_BUILDKIT=0 docker build --no-cache` 重建 server 镜像 → `up -d` 复起（sessions 在库，用户不被踢出）。

## 验收（逐条执行）

1. `npm run test -w @lexflow/server` 全绿（既有 230 零回归 + 新增用例）。
2. 根 `npm run typecheck` + `npm run build` exit 0；根 `npm run test` 253+ 全绿。
3. e2e：iter8-acceptance 全绿；e2e-01~16 不回归。
4. prod :8080 实测：梁奇烽登录 → 项目列表 5 个全部可见 → 进入佳力奇（非成员项目）空间 200、头部显示「合伙人」；王宝茁仍 2 个、管晨仍 1 个（不回归）；member 越权 404 同形不回归。
5. prod 三服务 healthy；探针草稿流已删；git 无 probe-i8* 残留。

**完成动作：** 更新 STATUS.md 工单 06 行 + 交接记录（新条目置顶）。
