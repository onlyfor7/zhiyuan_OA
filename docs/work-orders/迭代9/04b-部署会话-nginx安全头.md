# 迭代 9a · 工单 04b：prod nginx 静态壳安全头补齐（部署会话 · 微工单）

**依赖：** 工单 04 通过　**契约：** arch/12 §14.4

**背景：** 04 的安全头四件（X-Frame-Options/nosniff/Referrer-Policy/CSP）覆盖 server 响应面（/trpc、/files，已实测在 prod 生效）；但 SPA 静态壳（`/`、`/assets/*`）由 nginx 直出，尚不带四件。

## 范围（做）

1. web 镜像 nginx 配置（`app/nginx*.conf` 或 Dockerfile 同目录配置）：对静态壳响应加
   - `X-Frame-Options: DENY`
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy: same-origin`
   - `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:`（与 server 侧完全一致，避免双标）
2. `DOCKER_BUILDKIT=0` 重建 web 镜像复起（**一切 prod compose 命令必须带 `--env-file .env.production`**——新硬规则）。
3. 验证：`curl -sI http://localhost:8080/` 四件在响应；`/assets/index-*.js` 同样带头；页面正常打开（CSP 不阻断自身资源）；三服务 healthy。

**验收：** 架构会话 prod 实测。完成更新 STATUS + 交接记录。
