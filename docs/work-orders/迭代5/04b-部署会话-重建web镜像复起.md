# 迭代 5 · 工单 04b：重建 web 镜像并复起生产栈（部署会话 · 微工单）

**依赖：** 工单 03b 通过（前端 base 修正合入）　**产出分支建议：** `iter5/deploy-rebuild`

## 范围（做）

1. 拉取 03b 合入后的代码，重建 web 镜像（`docker build` 等效路径，沿用本机 buildkit 规避方案），`docker compose -f docker-compose.prod.yml up -d` 复起。
2. 验证产物 index.html 资产为绝对路径 `/assets/...`。
3. 冒烟：三服务 healthy；首页 200；登录正常。
4. 交接记录写重建实录（镜像 hash、起栈时间）。

## 不做

不改 compose/配置；不重灌种子（沿用现有演示数据）。

**完成动作：** 更新 STATUS.md + 交接记录。
