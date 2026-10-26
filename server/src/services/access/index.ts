import { PERMISSION, type AccessGrantScopeType } from "@lexflow/shared";
import { and, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";

import { accessGrants, fileObjects, fileVersions, projects } from "../../db/schema";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * 权限服务（arch/03 §2/§3/§5）。
 * 迭代 0 只实现 project.read、archive.read（文件）、admin.config 三条判定路径；
 * 其余已注册动作一律默认拒绝（false），随业务迭代扩充。
 * 列表用 SQL 级过滤（projectScopeFilter），禁止查出后内存过滤。
 */

/** 有效授权：status=active 且未撤销、未到期（arch/03 §2.5；到期即时失效） */
const GRANT_NOT_EXPIRED = or(
  isNull(accessGrants.expiresAt),
  gt(accessGrants.expiresAt, new Date().toISOString()),
);

async function hasActiveGrant(
  db: DbOrTx,
  userId: string,
  scopeType: AccessGrantScopeType,
  scopeId: string,
  action: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: accessGrants.id })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.granteeId, userId),
        eq(accessGrants.scopeType, scopeType),
        eq(accessGrants.scopeId, scopeId),
        eq(accessGrants.status, "active"),
        sql`${accessGrants.actions} @> ARRAY[${action}]::text[]`,
        GRANT_NOT_EXPIRED,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export type Resource =
  | { type: "project"; projectId: string }
  | { type: "file"; fileObjectId: string };

/** 判定入口：service 层统一调用（arch/03 §2） */
export async function can(
  db: DbOrTx,
  user: SessionUser,
  action: string,
  resource: Resource,
): Promise<boolean> {
  switch (action) {
    case PERMISSION.PROJECT_READ: {
      if (resource.type !== "project") return false;
      if (user.projectRoles.has(resource.projectId)) return true;
      return hasActiveGrant(db, user.id, "project", resource.projectId, action);
    }
    case PERMISSION.ARCHIVE_READ: {
      if (resource.type !== "file") return false;
      return canReadFile(db, user, resource.fileObjectId);
    }
    case PERMISSION.ADMIN_CONFIG: {
      return user.globalRoles.includes("sysadmin");
    }
    default:
      // 已注册动作未实现判定路径 → 默认拒绝（arch/03 §3）
      return false;
  }
}

/**
 * 文件读取（archive.read）：上传人本人，或持有效 file 范围授权。
 * 注意：file_objects 的业务来源（source_type/source_id）待迭代 1 文件域建链，
 * 届时此处补「来源项目成员放行」分支（STATUS.md 留坑）。
 */
export async function canReadFile(
  db: DbOrTx,
  user: SessionUser,
  fileObjectId: string,
): Promise<boolean> {
  const rows = await db
    .select({ createdBy: fileObjects.createdBy })
    .from(fileObjects)
    .where(eq(fileObjects.id, fileObjectId))
    .limit(1);
  const fileObject = rows[0];
  if (!fileObject) return false;
  if (fileObject.createdBy === user.id) return true;
  return hasActiveGrant(db, user.id, "file", fileObjectId, PERMISSION.ARCHIVE_READ);
}

/**
 * 项目可见范围（SQL 条件，供列表/搜索直接拼 where）：
 * 本人是成员的项目 ∪ 有效授权（active、未过期、含 project.read）的项目（arch/03 §2）。
 */
export function projectScopeFilter(user: SessionUser): SQL {
  return sql`(${projects.id} IN (
      SELECT project_id FROM project_members WHERE user_id = ${user.id}
    ) OR ${projects.id} IN (
      SELECT scope_id FROM access_grants
      WHERE grantee_id = ${user.id}
        AND status = 'active'
        AND scope_type = 'project'
        AND (expires_at IS NULL OR expires_at > now())
        AND actions @> ARRAY[${PERMISSION.PROJECT_READ}]::text[]
    ))`;
}

/**
 * 文件版本归属读取（无权限与不存在须同形 404，由调用方统一处理）：
 * 版本存在时返回其逻辑文件 id，供 canReadFile 判定。
 */
export async function findFileVersion(
  db: DbOrTx,
  fileVersionId: string,
): Promise<{ fileObjectId: string; storageKey: string } | null> {
  const rows = await db
    .select({
      fileObjectId: fileVersions.fileObjectId,
      storageKey: fileVersions.storageKey,
    })
    .from(fileVersions)
    .where(eq(fileVersions.id, fileVersionId))
    .limit(1);
  return rows[0] ?? null;
}
