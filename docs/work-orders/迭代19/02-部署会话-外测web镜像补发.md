# 迭代 19 · 工单 02：19-01 外测 web 镜像补发（部署会话）

**目标：** 将 `iter19/frontend-crypto-compat@0c22213` 的 randomUUID 兼容修复发布到外测 `http://182.92.206.62:8080`，消除 HTTP 非安全上下文下相关表单崩溃。
**边界：** 只重建/发布 web 镜像；不改代码，不动 server/postgres，不清库，不覆盖 `.env.production` 与 AI 配置。

## 执行步骤

1. **预检与备份**
   - SSH 复核三服务与磁盘；记录当前 web 镜像摘要；
   - `/opt/lexflow/backups/iter19-02-pre-<timestamp>/` 留存 compose/env 副本与 web 镜像摘要；如需数据库备份沿用现有日备，不做额外迁移预期。
2. **本机构建 web 镜像**
   - 基线 `iter19/frontend-crypto-compat@0c22213`；
   - `DOCKER_BUILDKIT=0`，web 镜像 `--no-cache`；
   - 记录本地 digest。
3. **分发与起栈**
   - `docker save` → scp → 远端 `docker load`，digest 两端一致；
   - prod compose 一律 `--env-file .env.production`；
   - `up -d --no-deps web`，只重建 web；
   - 等待 healthy；迁移行数保持 16 行零漂移（本棒无后端变更）。
4. **外网冒烟（只读，不替代 19-03）**
   - `/health` 与首页 200；
   - sysadmin 登录、`auth.me`、`crm.summary` 可达；
   - 确认新静态资产已加载（文件名 hash 变化或 cache 响应合理）；
   - 不执行业务写动作；randomUUID 场景复验归 19-03 测试。
5. **回滚预案**
   - 保留旧 web 镜像；异常时切回旧镜像并记录。

## 完成动作

- STATUS 19-02 转「待验收」+ 交接记录置顶；
- 提交前缀 `[部署]`；
- 架构验收后下发 19-03：测试会话在普通 Chrome（无 insecure-origin flag）复验相关入口并复拍手册受影响截图。
