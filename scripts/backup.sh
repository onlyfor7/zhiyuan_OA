#!/usr/bin/env bash
# LexFlow 生产备份（arch/08 §5）：pg_dump 全库 + storage 打包 + 校验清单。
# 用法：bash scripts/backup.sh [备份根目录，默认 ./backups]
# 目标栈：docker-compose.prod.yml（容器名 lexflow-prod-postgres / lexflow-prod-server）。
set -euo pipefail
# Git Bash/MSYS 会把容器内 POSIX 路径（/data/storage 等）改写为 Windows 路径，禁止参数路径转换
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

BACKUP_ROOT="${1:-./backups}"
PG_CONTAINER="${PG_CONTAINER:-lexflow-prod-postgres}"
SERVER_CONTAINER="${SERVER_CONTAINER:-lexflow-prod-server}"

# 账号/库名：优先取 .env.production，其次环境变量，兜底 lexflow
if [ -f .env.production ]; then set -a; . ./.env.production; set +a; fi
PGUSER="${POSTGRES_USER:-lexflow}"
PGDB="${POSTGRES_DB:-lexflow}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$TS"
mkdir -p "$DEST"

echo "[backup] 目标目录：$DEST"
echo "[backup] 数据库：$PGUSER@$PG_CONTAINER/$PGDB"

# 1) 数据库：pg_dump 自定义格式（压缩），经 stdout 落宿主
docker exec "$PG_CONTAINER" pg_dump -U "$PGUSER" -d "$PGDB" --format=custom > "$DEST/db.dump"
echo "[backup] db.dump 完成（$(wc -c < "$DEST/db.dump") 字节）"

# 2) 文件存储：server 容器内打包 STORAGE_DIR
docker exec "$SERVER_CONTAINER" tar czf - -C /data/storage . > "$DEST/storage.tar.gz"
echo "[backup] storage.tar.gz 完成（$(wc -c < "$DEST/storage.tar.gz") 字节）"

# 3) 校验清单（恢复后比对基线）：台账/审计/文件版本行数 + sha256 抽样
psql_q() { docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -tA -F $'\t' -c "$1"; }
{
  echo "BACKUP_AT=$TS"
  echo "POSTGRES_DB=$PGDB"
  echo "LEDGER_COUNT=$(psql_q 'SELECT count(*) FROM budget_ledger')"
  echo "AUDIT_COUNT=$(psql_q 'SELECT count(*) FROM audit_events')"
  echo "FILE_VERSION_COUNT=$(psql_q 'SELECT count(*) FROM file_versions')"
} > "$DEST/manifest.txt"
# 抽样（至多 20 个有物理文件的版本）：fileVersionId ⇥ storage_key ⇥ sha256（DB 登记值）。
# 种子演示数据存在「仅有 DB 行、无物理文件」的版本（种子不写 storage），探测存在性后再入样，
# 缺失行数记入 manifest 的 DB_ONLY_FILE_VERSIONS（如实口径，恢复校验只针对有物理文件的样本）。
: > "$DEST/sha256-sample.tsv"
DB_ONLY=0
while IFS=$'\t' read -r fvId storageKey dbSha; do
  [ -n "${fvId:-}" ] || continue
  if docker exec "$SERVER_CONTAINER" test -f "/data/storage/$storageKey"; then
    printf '%s\t%s\t%s\n' "$fvId" "$storageKey" "$dbSha" >> "$DEST/sha256-sample.tsv"
  else
    DB_ONLY=$((DB_ONLY + 1))
  fi
done < <(psql_q 'SELECT id, storage_key, sha256 FROM file_versions ORDER BY uploaded_at, id LIMIT 20')
echo "DB_ONLY_FILE_VERSIONS=$DB_ONLY" >> "$DEST/manifest.txt"
echo "[backup] manifest：$(tr '\n' ' ' < "$DEST/manifest.txt")"
echo "[backup] sha256 抽样 $(wc -l < "$DEST/sha256-sample.tsv") 条（另有 $DB_ONLY 条仅 DB 行无物理文件，不计入抽样）"
echo "[backup] 完成：$DEST"
