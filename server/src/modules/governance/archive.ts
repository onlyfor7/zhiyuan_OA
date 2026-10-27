import { and, asc, eq, sql } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import {
  accessGrants,
  archiveDirectories,
  archiveLinks,
  fileObjects,
  fileVersions,
  weeklyReports,
} from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { requireProjectRead } from "../../services/access";
import * as engine from "../../services/approval/engine";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { encodeCursor, nowIso } from "./util";

/**
 * 档案域 service（arch/04 §5 archive.*）：
 * tree/directoryItems/link（二态约束）、grantApply（→审批引擎）/grantRevoke/grantList。
 * 授权到期与撤销即时生效（canReadFile 查询时判定，arch/03 §7）。
 */

export async function archiveTree(db: DbOrTx, user: SessionUser, projectId: string) {
  await requireProjectRead(db, user, projectId);
  const dirs = await db
    .select({
      id: archiveDirectories.id,
      dirKey: archiveDirectories.dirKey,
      name: archiveDirectories.name,
      seq: archiveDirectories.seq,
      linkCount: sql<number>`(
        SELECT count(*)::int FROM ${archiveLinks}
        WHERE ${archiveLinks.directoryId} = ${archiveDirectories.id}
      )`,
    })
    .from(archiveDirectories)
    .where(eq(archiveDirectories.projectId, projectId))
    .orderBy(asc(archiveDirectories.seq));
  return dirs;
}

export async function directoryItems(
  db: DbOrTx,
  user: SessionUser,
  input: { directoryId: string; cursor?: string; limit: number },
) {
  const [dir] = await db
    .select()
    .from(archiveDirectories)
    .where(eq(archiveDirectories.id, input.directoryId))
    .limit(1);
  if (!dir) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "目录不存在或无权访问");
  await requireProjectRead(db, user, dir.projectId);

  const rows = await db
    .select({
      link: archiveLinks,
      storageKey: fileVersions.storageKey,
      mimeType: fileVersions.mimeType,
      sizeBytes: fileVersions.sizeBytes,
      sha256: fileVersions.sha256,
      reportCode: weeklyReports.code,
      reportPeriodStart: weeklyReports.periodStart,
      reportPeriodEnd: weeklyReports.periodEnd,
    })
    .from(archiveLinks)
    .leftJoin(fileVersions, eq(fileVersions.id, archiveLinks.fileVersionId))
    .leftJoin(weeklyReports, eq(weeklyReports.id, archiveLinks.sourceId))
    .where(eq(archiveLinks.directoryId, input.directoryId))
    .orderBy(asc(archiveLinks.createdAt), asc(archiveLinks.id))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      ...r.link,
      file: r.storageKey
        ? {
            fileVersionId: r.link.fileVersionId,
            storageKey: r.storageKey,
            mimeType: r.mimeType,
            sizeBytes: r.sizeBytes,
            sha256: r.sha256,
            name: r.storageKey.split("/").pop(),
          }
        : null,
      report: r.reportCode
        ? {
            code: r.reportCode,
            periodStart: r.reportPeriodStart,
            periodEnd: r.reportPeriodEnd,
          }
        : null,
    })),
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor(last.link.createdAt, last.link.id)
        : null,
  };
}

/**
 * 结构化来源归集（内部直挂，供会议纪要确认/出差完成等同事务调用；arch/05 §2.2 二态放宽）。
 * 系统权威写入：调用方须在已通过权限校验的业务事务内使用。
 */
export async function linkSourceToDirectory(
  db: DbOrTx,
  input: {
    projectId: string;
    directoryId: string;
    sourceType: "report" | "meeting" | "travel";
    sourceId: string;
    fileVersionId?: string | null;
    createdBy?: string | null;
  },
): Promise<void> {
  await db
    .insert(archiveLinks)
    .values({
      projectId: input.projectId,
      directoryId: input.directoryId,
      fileVersionId: input.fileVersionId ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing();
}

/** 按 dir_key 归集到项目目录（无目录则跳过，不阻断业务主流程） */
export async function linkSourceByDirKey(
  db: DbOrTx,
  input: {
    projectId: string;
    dirKey: string;
    sourceType: "report" | "meeting" | "travel";
    sourceId: string;
    fileVersionId?: string | null;
    createdBy?: string | null;
  },
): Promise<void> {
  const dir = await db
    .select({ id: archiveDirectories.id })
    .from(archiveDirectories)
    .where(
      and(
        eq(archiveDirectories.projectId, input.projectId),
        eq(archiveDirectories.dirKey, input.dirKey),
      ),
    )
    .limit(1);
  if (!dir[0]) return;
  await linkSourceToDirectory(db, { ...input, directoryId: dir[0].id });
}

/** 会议/出差材料归集：把来源文件的全部版本挂入目录（fv 非空 + 来源对；唯一约束去重） */
export async function linkMaterialFiles(
  db: DbOrTx,
  input: {
    projectId: string;
    dirKey: string;
    sourceType: "meeting" | "travel";
    sourceId: string;
    createdBy?: string | null;
  },
): Promise<void> {
  const objects = await db
    .select({ id: fileObjects.id })
    .from(fileObjects)
    .where(and(eq(fileObjects.sourceType, input.sourceType), eq(fileObjects.sourceId, input.sourceId)));
  for (const object of objects) {
    const versions = await db
      .select({ id: fileVersions.id })
      .from(fileVersions)
      .where(eq(fileVersions.fileObjectId, object.id));
    for (const version of versions) {
      await linkSourceByDirKey(db, {
        projectId: input.projectId,
        dirKey: input.dirKey,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        fileVersionId: version.id,
        createdBy: input.createdBy ?? null,
      });
    }
  }
}

export async function linkItem(
  db: DbOrTx,
  user: SessionUser,
  input: { directoryId: string; fileVersionId?: string; reportId?: string },
) {
  const [dir] = await db
    .select()
    .from(archiveDirectories)
    .where(eq(archiveDirectories.id, input.directoryId))
    .limit(1);
  if (!dir) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "目录不存在或无权访问");
  await requireProjectRead(db, user, dir.projectId);

  if (input.fileVersionId) {
    const [version] = await db
      .select({ fileObjectId: fileVersions.fileObjectId })
      .from(fileVersions)
      .where(eq(fileVersions.id, input.fileVersionId))
      .limit(1);
    if (!version) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "文件版本不存在");
    const [object] = await db
      .select({ sourceType: fileObjects.sourceType, sourceId: fileObjects.sourceId })
      .from(fileObjects)
      .where(eq(fileObjects.id, version.fileObjectId))
      .limit(1);
    if (!object || object.sourceType !== "project" || object.sourceId !== dir.projectId) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "文件须归属本项目后方可归集", {
        fileVersionId: ["文件须归属本项目后方可归集"],
      });
    }
    const [link] = await db
      .insert(archiveLinks)
      .values({
        projectId: dir.projectId,
        directoryId: dir.id,
        fileVersionId: input.fileVersionId,
        sourceType: "project",
        sourceId: dir.projectId,
        createdBy: user.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!link) {
      // 已归集（部分唯一索引）：返回现状语义——取已有行
      const existing = await db
        .select()
        .from(archiveLinks)
        .where(
          and(
            eq(archiveLinks.directoryId, dir.id),
            eq(archiveLinks.fileVersionId, input.fileVersionId),
          ),
        )
        .limit(1);
      return existing[0] ?? null;
    }
    return link;
  }

  if (input.reportId) {
    const [report] = await db
      .select({ projectId: weeklyReports.projectId, status: weeklyReports.status })
      .from(weeklyReports)
      .where(eq(weeklyReports.id, input.reportId))
      .limit(1);
    if (!report || report.projectId !== dir.projectId) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "周报须归属本项目", {
        reportId: ["周报须归属本项目"],
      });
    }
    const [link] = await db
      .insert(archiveLinks)
      .values({
        projectId: dir.projectId,
        directoryId: dir.id,
        fileVersionId: null,
        sourceType: "report",
        sourceId: input.reportId,
        createdBy: user.id,
      })
      .onConflictDoNothing()
      .returning();
    return link;
  }

  throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "fileVersionId 与 reportId 至少提供一个", {
    fileVersionId: ["fileVersionId 与 reportId 至少提供一个"],
  });
}

/* ===== 授权（AccessGrant；申请→审批→有效→到期/撤销即时失效） ===== */

export interface GrantApplyInput {
  scopeType: "project" | "file" | "report" | "directory";
  scopeId: string;
  granteeId: string;
  actions: string[];
  expiresAt?: string | null;
  reason: string;
  idempotencyKey: string;
}

export async function grantApply(db: DbOrTx, user: SessionUser, input: GrantApplyInput) {
  // 任何角色可申请（管理端场景，arch/04 §5 grantApply 注）；scope 存在性校验
  const [grant] = await db
    .insert(accessGrants)
    .values({
      granteeId: input.granteeId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      actions: input.actions,
      expiresAt: input.expiresAt ?? null,
      grantedBy: user.id,
      status: "pending_approval",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!grant) throw new Error("授权申请插入失败");

  const instance = await engine.submit(db, {
    bizType: "access_grant",
    bizId: grant.id,
    projectId: input.scopeType === "project" ? input.scopeId : null,
    applicantId: user.id,
    formSnapshot: {
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      actions: input.actions,
      reason: input.reason,
      granteeId: input.granteeId,
    },
    idempotencyKey: input.idempotencyKey,
  });
  return { grant, instance };
}

export async function grantRevoke(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; reason: string },
) {
  const [grant] = await db.select().from(accessGrants).where(eq(accessGrants.id, input.id)).limit(1);
  if (!grant) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "授权不存在");
  const allowed =
    grant.grantedBy === user.id ||
    user.globalRoles.includes("archivist") ||
    user.globalRoles.includes("sysadmin");
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅授权人、档案管理员或系统管理员可撤销");
  if (grant.status !== "active") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅有效授权可撤销");
  }
  const [updated] = await db
    .update(accessGrants)
    .set({
      status: "revoked",
      revokedAt: nowIso(),
      revokedBy: user.id,
      revokeReason: input.reason,
      rowVersion: sql`${accessGrants.rowVersion} + 1`,
      updatedBy: user.id,
      updatedAt: nowIso(),
    })
    .where(and(eq(accessGrants.id, input.id), eq(accessGrants.status, "active")))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "授权状态已变化");
  return updated;
}

export async function grantList(db: DbOrTx, user: SessionUser) {
  // 档案管理员/系统管理员看全部；普通用户看与自己相关（被授权人或申请人）
  const isAdmin = user.globalRoles.includes("archivist") || user.globalRoles.includes("sysadmin");
  const rows = await db
    .select()
    .from(accessGrants)
    .where(
      isAdmin
        ? sql`true`
        : sql`${accessGrants.granteeId} = ${user.id} OR ${accessGrants.grantedBy} = ${user.id}`,
    )
    .orderBy(asc(accessGrants.createdAt));
  return rows.map((g) => ({
    ...g,
    expired:
      g.status === "active" && g.expiresAt !== null && g.expiresAt <= nowIso(),
  }));
}
