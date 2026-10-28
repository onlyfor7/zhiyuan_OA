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
 * 孤儿文件清理（arch/08 §6；R5 修复拆两端点）：
 * storageOrphans=dry-run（query 只读）；storageOrphansPurge=mutation 实删。sysadmin 限定；均写审计。
 */

async function orphanKeys(db: DbOrTx): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(storageRoot);
  } catch {
    files = [];
  }
  const candidates = files.filter((f) => !f.includes(".tmp-") && f.includes("."));
  const rows = await db.select({ storageKey: fileVersions.storageKey }).from(fileVersions);
  const referenced = new Set(rows.map((r) => r.storageKey));
  return candidates.filter((name) => !referenced.has(name)).sort();
}

function requireSysadmin(user: SessionUser): void {
  if (!user.globalRoles.includes("sysadmin")) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅系统管理员可执行存储清理");
  }
}

export interface StorageOrphanResult {
  dryRun: boolean;
  orphans: string[];
  deleted: string[];
  storageRoot: string;
}

export async function storageOrphansDryRun(db: DbOrTx, user: SessionUser, ip: string | null, sessionId: string | null): Promise<StorageOrphanResult> {
  requireSysadmin(user);
  const orphans = await orphanKeys(db);
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

export async function storageOrphansPurge(db: DbOrTx, user: SessionUser, ip: string | null, sessionId: string | null): Promise<StorageOrphanResult> {
  requireSysadmin(user);
  const orphans = await orphanKeys(db);
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
    action: "admin.storageOrphansPurge",
    targetType: "file_object",
    targetId: null,
    result: failed.length > 0 ? "failure" : "success",
    afterJson: { deleted: deleted.length, failed, names: deleted },
    ip,
  });
  return { dryRun: false, orphans, deleted, storageRoot };
}
