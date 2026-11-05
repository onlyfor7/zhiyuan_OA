# 迭代 9b · 工单 05：prod 发布窗口（部署会话）

**依赖：** 工单 04 通过　**硬规则：** 一切 prod compose 命令必须带 `--env-file .env.production`

## 范围（做）

1. **双镜像重建**（`DOCKER_BUILDKIT=0`，server 含 9b 新端点与种子变更必须 `--no-cache`）→ `up -d`（不删卷、不清会话）。
2. **迁移自动重放**：server 启动迁移，核验 `drizzle.__drizzle_migrations` 含 0010（company_profile/org_units 树化/users 三列）。
3. **种子同步**（`SEED_PROFILE=full`，幂等）：组织根更名「因诺智元」生效（兼容行就地改名）、users 工号/职位/入职回填、company_profile 默认行 insert-if-absent（不覆盖运行期编辑）。
4. **验证**（prod :8080 实测）：三服务 healthy；`SELECT name FROM org_units WHERE parent_id IS NULL` = 因诺智元；users 工号非空计数=22；梁奇烽登录问候卡显示「合伙人」；治理组「组织管理」三页可达；旧名「示例律师事务所」在 org_units 0 命中。
5. 实录写入交接记录。

**完成动作：** STATUS 更新转「待验收」。
