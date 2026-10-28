#!/usr/bin/env bash
# LexFlow 生产恢复 + 校验（arch/08 §5）：
#   删库重建 → pg_restore → storage 还原 → 校验（台账/审计行数比对 manifest、文件 sha256 抽样重算）。
# 用法：bash scripts/restore.sh <备份目录> [--yes] [--no-restart]
#   --yes         跳过交互确认（演练/自动化用）
#   --no-restart  恢复后不重启 server 容器（默认重启以断开旧连接池，启动时迁移幂等重放）
set -euo pipefail
# Git Bash/MSYS 会把容器内 POSIX 路径（/data/storage 等）改写为 Windows 路径，禁止参数路径转换
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

SRC=""
CONFIRM=""
NO_RESTART=""
for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRM="--yes" ;;
    --no-restart) NO_RESTART="--no-restart" ;;
    *) [ -z "$SRC" ] && SRC="$arg" ;;
  esac
done
if [ -z "$SRC" ] || [ ! -f "$SRC/db.dump" ] || [ ! -f "$SRC/manifest.txt" ]; then
  echo "用法：bash scripts/restore.sh <备份目录> [--yes] [--no-restart]" >&2
  exit 2
fi

PG_CONTAINER="${PG_CONTAINER:-lexflow-prod-postgres}"
SERVER_CONTAINER="${SERVER_CONTAINER:-lexflow-prod-server}"
if [ -f .env.production ]; then set -a; . ./.env.production; set +a; fi
PGUSER="${POSTGRES_USER:-lexflow}"
PGDB="${POSTGRES_DB:-lexflow}"

# shellcheck disable=SC1090
. "$SRC/manifest.txt"
echo "[restore] 备份：$SRC（$BACKUP_AT，库 $POSTGRES_DB）"
echo "[restore] 基线：LEDGER=$LEDGER_COUNT AUDIT=$AUDIT_COUNT FILE_VERSION=$FILE_VERSION_COUNT"

if [ "$CONFIRM" != "--yes" ]; then
  echo "!! 将删除并重建数据库 $PGDB、清空 server 存储卷后还原。确认请输入 yes：" >&2
  read -r ans; [ "$ans" = "yes" ] || { echo "已取消"; exit 1; }
fi

# 1) 删库重建 + pg_restore
echo "[restore] 删除并重建数据库 $PGDB ..."
docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d postgres -c "DROP DATABASE IF EXISTS $PGDB WITH (FORCE)" >/dev/null
docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d postgres -c "CREATE DATABASE $PGDB" >/dev/null
docker exec -i "$PG_CONTAINER" pg_restore -U "$PGUSER" -d "$PGDB" --no-owner --no-privileges < "$SRC/db.dump"
echo "[restore] 数据库还原完成"

# 2) storage 还原
if [ -f "$SRC/storage.tar.gz" ]; then
  echo "[restore] 清空并还原 storage ..."
  docker exec "$SERVER_CONTAINER" sh -c 'find /data/storage -mindepth 1 -delete'
  docker exec -i "$SERVER_CONTAINER" tar xzf - -C /data/storage < "$SRC/storage.tar.gz"
  echo "[restore] storage 还原完成"
else
  echo "[restore] 备份内无 storage.tar.gz，跳过"
fi

# 3) 校验：行数比对
FAIL=0
check_count() {
  local label="$1" table="$2" expect="$3" actual
  actual="$(docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -tA -c "SELECT count(*) FROM $table")"
  if [ "$actual" = "$expect" ]; then
    echo "[verify] $label 行数 $actual == 基线 $expect ✓"
  else
    echo "[verify] $label 行数 $actual != 基线 $expect ✗" >&2; FAIL=1
  fi
}
check_count "budget_ledger(台账)" budget_ledger "$LEDGER_COUNT"
check_count "audit_events(审计)" audit_events "$AUDIT_COUNT"
check_count "file_versions(文件版本)" file_versions "$FILE_VERSION_COUNT"

# 4) 校验：sha256 抽样（DB 登记值 vs 存储文件重算）
SAMPLE="$SRC/sha256-sample.tsv"
CHECKED=0
if [ -s "$SAMPLE" ]; then
  while IFS=$'\t' read -r fvId storageKey dbSha; do
    [ -n "${fvId:-}" ] || continue
    actualSha="$(docker exec "$SERVER_CONTAINER" sha256sum "/data/storage/$storageKey" 2>/dev/null | cut -d' ' -f1 || true)"
    dbShaNow="$(docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -tA -c "SELECT sha256 FROM file_versions WHERE id='$fvId'")"
    if [ -z "$actualSha" ]; then
      echo "[verify] sha256 $fvId 存储文件缺失 ✗" >&2; FAIL=1
    elif [ "$actualSha" != "$dbSha" ] || [ "$dbShaNow" != "$dbSha" ]; then
      echo "[verify] sha256 $fvId 不一致（备份=$dbSha 库=$dbShaNow 文件=$actualSha）✗" >&2; FAIL=1
    else
      CHECKED=$((CHECKED + 1))
    fi
  done < "$SAMPLE"
  echo "[verify] sha256 抽样 $CHECKED 条一致 ✓"
else
  echo "[verify] 无文件版本可抽样（0 条），跳过（如实记录）"
fi

# 5) 重启 server（断开旧连接池；启动时迁移幂等重放）
if [ "$NO_RESTART" != "--no-restart" ] && docker ps --format '{{.Names}}' | grep -qx "$SERVER_CONTAINER"; then
  echo "[restore] 重启 $SERVER_CONTAINER ..."
  docker restart "$SERVER_CONTAINER" >/dev/null
  for i in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$SERVER_CONTAINER" 2>/dev/null)" = "healthy" ] && break
    sleep 2
  done
  echo "[restore] server 健康态：$(docker inspect -f '{{.State.Health.Status}}' "$SERVER_CONTAINER")"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "[restore] 校验未通过" >&2; exit 1
fi
echo "[restore] 恢复与校验全部通过"
