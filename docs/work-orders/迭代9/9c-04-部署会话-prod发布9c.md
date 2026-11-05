# 迭代 9c · 工单 04：prod 发布窗口（部署会话）

**依赖：** 工单 03 架构验收通过　**硬规则：** 一切 prod compose 命令带 `--env-file .env.production`

1. 双镜像重建（server `--no-cache`）→ `up -d`（不删卷、不清会话）。
2. 迁移重放核验（新 crm_* 6 表+clients 加列+5 枚举）。
3. 种子同步（`SEED_PROFILE=full` 幂等）：演示线索/商机/合同/跟进就位。
4. 验证：三服务 healthy；客户组页面 SPA 200（线索池/客户列表/商机/合同）；王宝茁登录见客户组（crm.read）；member 菜单不见客户组（角色过滤）；存量收款登记不挂合同兼容。
5. 实录写入交接记录。

**完成动作：** STATUS 更新转「待验收」。
