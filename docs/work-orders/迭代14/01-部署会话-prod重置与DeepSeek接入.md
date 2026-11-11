# 迭代 14 · 工单 01：prod 数据重置窗口 + DeepSeek 接入（部署会话）

**依赖：** 工单 00　**硬规则：** compose 全程 `--env-file .env.production`；提前通知用户会重登

## 范围

1. **prod 数据重置窗口**（清 e2e 自增殖与走查残留）：
   - `down -v` → `up -d` → 迁移重放 → 种子 `SEED_PROFILE=full`（22 用户+五项目+CRM/财务演示数据回到干净基线）；
   - 核验：projects=5、users=22、approval 残留=0、e2e 痕迹（「验收客户-/迭代7验收mw-/E2E-」前缀）三表 0 命中。
2. **DeepSeek 接入**（用户提供 `deepseek api.txt`，工作区根目录；**key 不回显不入库 git**）：
   - 迁移种子完成后：以 sysadmin 会话调 `ai.config.set`（provider_url=https://api.deepseek.com、api_key=<文件值>、model=deepseek-chat、enabled=true）；
   - `ai.config.testConnection` 实测真模型返回（latency+ok=true）；ai.chat 实弹一句中文问答验证真模型通路；
   - 处置后建议用户删除/移走该 txt（明文 key 不宜留工作区）——交接记录提醒。
3. 实录写入交接记录（重置前后计数对比+联通延迟）。

**完成动作：** STATUS 更新转「待验收」。
