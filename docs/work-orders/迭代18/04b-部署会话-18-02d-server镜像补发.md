# 迭代 18 · 工单 04b：18-02d server 镜像外测补发（部署会话）

**触发：** 18-05 复验在 dev 已证明 18-02d 修复成立，但外测 `182.92.206.62:8080` 仍运行旧 server 镜像，`admin.correctRecord object:"user"` 在生产侧仍 500。
**目标：** 将含 `5a6c684` 修复的 server 镜像发布到外测服务器；不重建 web、不动 postgres。
**发布基线：** `iter18/test-acceptance@6e2ecb9`（已包含 18-02d 与 18-05 复验适配）
**边界：** 只重建/发布 server 镜像；不改代码、不改 schema/迁移/种子、不清库、不覆盖远端 `.env.production` 或 AI 配置。

## 执行步骤

1. **预检与备份**
   - SSH 复核三服务状态、磁盘、8080；
   - 在 `/opt/lexflow/backups/iter18-04b-pre-<timestamp>/` 留存 pg_dump、uploads 归档、compose/env 副本、当前 server 镜像摘要；
   - 备份不可读则停止。

2. **本地构建 server 镜像**
   - 以 `iter18/test-acceptance@6e2ecb9` 为基线；
   - `DOCKER_BUILDKIT=0`，server 镜像必须 `--no-cache`；
   - 记录本地 digest。

3. **分发与起栈**
   - `docker save` → scp → 远端 `docker load`；
   - 远端 digest 与本地一致；
   - prod compose 一律 `--env-file .env.production`；
   - 只重建 server 服务，web/postgres 不动；
   - 等待 healthy；迁移应为 16 行零漂移（0014/0015 已在 18-04 落位，本棒不应新增迁移）。

4. **冒烟（不替代 18-05 prod T5）**
   - `/health` 200；
   - sysadmin 登录 200；
   - 不执行业务纠正写动作；只确认进程与基础接口可用；
   - 记录旧 server 镜像保留位置/ID，回滚预案可执行。

## 完成动作

- STATUS 18-04b 转「待验收」+ 交接记录置顶，写明备份、digest、迁移零漂移、服务健康和冒烟；
- 提交前缀 `[部署]`；
- 架构验收后下发 18-05 prod T5 复跑指令。
