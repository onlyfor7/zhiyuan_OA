# 专项工单：git 远端仓库挂载与全量首次推送（git 版本同步会话）

- **来源：** 用户指令（2026-11-18）——系统作为代码仓库用 git 管理，上传 GitHub 私有仓库，配套文档便于其他开发者协作，后续任务基于最新 git 代码迭代
- **执行会话：** git 版本同步会话（用户会单独开启；凭据由用户直接给你，不经过架构会话）
- **commit 前缀：** `[部署]`

## §0 前置状态（架构会话已完成，勿重复劳动）

- `main` 主干已快进到 `754b887`（全量系统代码+文档，迭代 20 收口形态）
- `.gitignore` 已加固：`.env*`、`deepseek api.txt`、`*-cred.txt`、`server/storage/`、`backups/`、`e2e/probe-*.cjs`、`e2e/tmp-*.cjs` 永不入库
- `README.md`（开发者上手+文档地图）、`docs/开发环境.md`、`docs/部署手册.md` 已就位
- 敏感内容已扫描：tracked 文件中无密钥/凭据明文；演示口令 Demo@2026 属既定公开口径（仅外测演示环境）
- 本地 103 个 `iter*` 分支=完整演进历史，用户裁定**全量推送**

## §1 向用户索取（对话中直接要）

1. GitHub 私有空仓库地址（`https://github.com/<账号>/<仓库>.git` 或 `git@github.com:...`）——提醒：建库时不要勾选初始化 README/.gitignore/License；**若远端非空，停下报用户，不硬推**
2. 凭据：HTTPS PAT（`repo` 权限）或确认本机 SSH key 已配好（`ssh -T git@github.com`）

## §2 执行步骤

```bash
# 1. 凭据临时使用（HTTPS 场景）：先以无凭据地址加 remote，push 时经环境变量注入，不落任何文件
git remote add origin <仓库地址>
git remote -v   # 确认

# 2. 推送主干
git push -u origin main

# 3. 全量推送迭代分支（103 个 iter/* 分支）
git push origin 'refs/heads/iter*:refs/heads/iter*'

# 4. 校验（本地与远端一致）
git ls-remote origin | wc -l        # 应为 104（main+103）
git rev-parse main
# 请用户在 GitHub 网页确认 main 最新提交=754b887（或届时实际 HEAD）

# 5. 凭据清理（必须）：若 push 过程将 token 写进了 remote URL，立即还原为干净地址
git remote set-url origin <不含凭据的仓库地址>
# 并提醒用户在 GitHub 后台轮换/吊销本次使用的 token
```

## §3 纪律

- 凭据**不入库、不写进任何文件、不回显在文档与 STATUS**（引用时一律写「凭据由用户直接提供」）
- 不 force-push、不删任何本地分支、不改任何历史
- 推送失败（网络/权限/非空仓库）→ 如实记录报错，不 retry 硬闯，回执用户与架构

## §4 推送成功后的文档收尾（本工单范围内）

1. `README.md` 顶部加「远端仓库」一节：clone 地址、默认分支 main、日常同步工作流（`git pull --ff-only` + 任务分支 push）
2. `docs/开发环境.md` 补一节「git 远端与同步」：同上口径
3. `docs/STATUS.md`：专项工单状态表本行转「待验收」+ 交接记录置顶（远端地址可写，凭据不写）
4. 提交：`[部署] git 远端挂载与首次全量推送完成`

## §5 验收

架构会话复核：`git ls-remote` 分支数、远端 main 提交与本地一致、README/开发环境同步节在位、无凭据痕迹（grep remote URL 与文档）→ 转「通过」。
