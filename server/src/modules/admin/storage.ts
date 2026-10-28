import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { ERROR_CODE } from "@lexflow/shared";

import { fileVersions } from "../../db/schema";
import { storageRoot } from "../../env";
import { BusinessError } from "../../lib/errors";
import { recordAudit } from "../../services/audit";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * 孤儿文件清理（arch/08 §6）：storage 中无 file_versions 引用的物理对象。
 * dry-run 返回清单；confirm 实删；sysadmin 限定；dry-run 与实删均写审计。
 */

export interface StorageOrphanResult {
  dryRun: boolean;
  orphans: string[];
  deleted: string[];
  storageRoot: string;
}

export async function storageOrphans(
  db: DbOrTx,
  user: SessionUser,
  input: { confirm?: boolean },
  ip: string | null,
  sessionId: string | null,
): Promise<StorageOrphanResult> {
  if (!user.globalRoles.includes("sysadmin")) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅系统管理员可执行存储清理");
  }

  let files: string[];
  try {
    files = await readdir(storageRoot);
  } catch {
    files = [];
  }
  const candidates = files.filter((f) => !f.includes(".tmp-") && f.includes("."));

  // 无引用 = storage_key 不在 file_versions 中（SQL 级比对）
  const rows = await db.select({ storageKey: fileVersions.storageKey }).from(fileVersions);
  const referenced = new Set(rows.map((r) => r.storageKey));
  const orphans = candidates.filter((name) => !referenced.has(name)).sort();

  if (!input.confirm) {
    await recordAudit(db, {
      actorId: user.id,
      sessionId,
      action: "admin.storageOrphans",
      targetType: "file_object",
      targetId: null,
      result: "success",
      afterJson: { dryRun: true, count: orphans.length, orphans },
      ip,
    });
    return { dryRun: true, orphans, deleted: [], storageRoot };
  }

  const deleted: string[] = [];
  const failed: string[] = [];
  for (const name of orphans) {
    try {
      await unlink(join(storageRoot, name));
      deleted.push(name);
    } catch {
      failed.push(name);
    }
  }
  await recordAudit(db, {
    actorId: user.id,
    sessionId,
    action: "admin.storageOrphans",
    targetType: "file_object",
    targetId: null,
    result: failed.length > 0 ? "failure" : "success",
    afterJson: { dryRun: false, deleted: deleted.length, failed, names: deleted },
    ip,
  });
  return { dryRun: false, orphans, deleted, storageRoot };
}
