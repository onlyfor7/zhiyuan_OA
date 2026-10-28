# 迭代 5 · 工单 03b：修正 vite base 致生产深链白屏（前端会话 · 微工单）

**依赖：** 无（P0 修复，立即执行）　**产出分支建议：** `iter5/frontend-base-fix`

## 背景（架构复核实录）

生产栈（http://localhost:8080）深链白屏已证实：`app/vite.config.ts` 的 `base: './'` 使构建产物以相对路径 `./assets/...` 引用资产；多级路径（如 `/projects/:id/overview`、`/meetings/:id`）下浏览器把资产解析到 `/projects/xxx/assets/...`，nginx SPA 回退返回 HTML（Content-Type: text/html）顶替 JS → React 无法挂载 → 白屏。违反基线 §5.3「详情直链、刷新恢复」硬性要求。

## 范围（做）

1. `app/vite.config.ts`：`base: './'` 改 `base: '/'`（绝对路径）。如该配置有其他相对路径依赖（截图基线、E2E 断言），一并修正。
2. 验证：dev（vite :3000）深链无回归；`npm run build` 产物 index.html 资产引用为 `/assets/...` 绝对路径。
3. 质量门：typecheck/lint/build/test（app 23 不回归）。

## 不做

不动 nginx/compose（部署棒重建镜像）；不动业务代码。

**完成动作：** 更新 STATUS.md（本单转待验收）+ 交接记录。
