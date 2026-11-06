import { PERMISSION, ERROR_CODE, type AccessGrantScopeType } from "@lexflow/shared";
import { and, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";

import { accessGrants, expenseItems, expenseReports, fileObjects, fileVersions, projects } from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * 权限服务（arch/03 §2/§3/§5）。
 * 迭代 0 实现 project.read、archive.read（文件）、admin.config；
 * 迭代 1 增补：audit.read（sysadmin/archivist/partner）、project.manage（项目内 manager 角色）。
 * 迭代 8（arch/03 §2.2 v1.1）：partner 全局只读（project.read/archive.read 放行），写操作经 requireProjectMember 守边界。
 * 其余已注册动作一律默认拒绝（false），随业务迭代扩充。
 * 列表用 SQL 级过滤（projectScopeFilter），禁止查出后内存过滤。
 */

/** 有效授权：status=active 且未撤销、未到期（arch/03 §2.5；到期即时失效，查询时判定） */
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
      // arch/03 §2.2 v1.1（迭代8 用户裁定）：partner 全局只读可见（看得到 ≠ 管得了；写操作另有成员门）
      if (user.globalRoles.includes("partner")) return true;
      if (user.projectRoles.has(resource.projectId)) return true;
      return hasActiveGrant(db, user.id, "project", resource.projectId, action);
    }
    case PERMISSION.PROJECT_MANAGE: {
      if (resource.type !== "project") return false;
      return user.projectRoles.get(resource.projectId) === "manager";
    }
    case PERMISSION.ARCHIVE_READ: {
      if (resource.type !== "file") return false;
      return canReadFile(db, user, resource.fileObjectId);
    }
    case PERMISSION.ADMIN_CONFIG: {
      return user.globalRoles.includes("sysadmin");
    }
    case PERMISSION.AUDIT_READ: {
      // arch/03 §3：sysadmin / archivist / partner 可查阅审计
      return (
        user.globalRoles.includes("sysadmin") ||
        user.globalRoles.includes("archivist") ||
        user.globalRoles.includes("partner")
      );
    }
    case "org.manage": {
      // arch/12 §11：组织管理=sysadmin 写；partner 只读穿透在 org 服务层判定（requireOrgRead）
      return user.globalRoles.includes("sysadmin");
    }
    case "report.read":
    case "report.export": {
      // arch/12 §11：报表读/导出=登录全员，行级按各数据域既有口径过滤（service 层）；导出走审计
      return true;
    }
    case "crm.read": {
      // arch/12 §11：partner 全局只读穿透 + finance + 项目负责人；owner 本人在服务层放行
      return (
        user.globalRoles.includes("partner") ||
        user.globalRoles.includes("finance") ||
        user.globalRoles.includes("project_manager")
      );
    }
    case "fin.read": {
      // arch/12 §11：fin.read=finance/partner/项目负责人（costing 本项目 manager 在 service 层另放行）
      return (
        user.globalRoles.includes("finance") ||
        user.globalRoles.includes("partner") ||
        user.globalRoles.includes("project_manager")
      );
    }
    case "fin.manage": {
      // arch/12 §11：fin.manage=finance/partner
      return user.globalRoles.includes("finance") || user.globalRoles.includes("partner");
    }
    case "crm.manage": {
      // arch/12 §11：crm.manage=partner/owner（owner 校验在服务层按记录判定）
      return user.globalRoles.includes("partner") || user.globalRoles.includes("project_manager");
    }
    default:
      // 已注册动作未实现判定路径 → 默认拒绝（arch/03 §3）
      return false;
  }
}

export async function requireProjectRead(db: DbOrTx, user: SessionUser, projectId: string): Promise<void> {
  const allowed = await can(db, user, PERMISSION.PROJECT_READ, { type: "project", projectId });
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权访问");
}

/* ===== 组织域门（arch/12 §9/§11：org.manage=sysadmin 写；partner 只读穿透；其余同形 404） ===== */

export async function requireOrgManage(db: DbOrTx, user: SessionUser): Promise<void> {
  const allowed = await can(db, user, "org.manage", { type: "project", projectId: "" });
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "组织信息不存在或无权访问");
}

export function canReadOrg(user: SessionUser): boolean {
  return user.globalRoles.includes("sysadmin") || user.globalRoles.includes("partner");
}

export async function requireOrgRead(db: DbOrTx, user: SessionUser): Promise<void> {
  if (!canReadOrg(user)) {
    void db;
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "组织信息不存在或无权访问");
  }
}

/**
 * 项目成员门（写操作专用，arch/03 §2.2 v1.1 边界）：成员 ∪ 有效授权——不含 partner 全局只读。
 * project.read 自迭代 8 起对 partner 全局放行（读），凡以「可读」兼作「可写」门槛的创建/编辑/提交
 * 路径一律改用本门，保证 partner 看得到 ≠ 管得了。
 */
export async function requireProjectMember(db: DbOrTx, user: SessionUser, projectId: string): Promise<void> {
  const member =
    user.projectRoles.has(projectId) ||
    (await hasActiveGrant(db, user.id, "project", projectId, PERMISSION.PROJECT_READ));
  if (!member) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权访问");
}

/**
 * 文件读取（archive.read）：
 * 上传人本人 ∨ 来源项目成员（经 file_objects.source_*，arch/04 §2.1 落地）∨ 有效 AccessGrant（file 范围
 * 精确到文件 / project 范围覆盖来源项目；到期与撤销即时失效，arch/03 §7）。
 */
export async function canReadFile(
  db: DbOrTx,
  user: SessionUser,
  fileObjectId: string,
): Promise<boolean> {
  const rows = await db
    .select({
      createdBy: fileObjects.createdBy,
      sourceType: fileObjects.sourceType,
      sourceId: fileObjects.sourceId,
    })
    .from(fileObjects)
    .where(eq(fileObjects.id, fileObjectId))
    .limit(1);
  const fileObject = rows[0];
  if (!fileObject) return false;
  if (fileObject.createdBy === user.id) return true;
  // arch/03 §2.2 v1.1：partner 全局只读（含文件下载/预览），与 audit.read 同级
  if (user.globalRoles.includes("partner")) return true;

  if (fileObject.sourceType === "project" && fileObject.sourceId) {
    if (user.projectRoles.has(fileObject.sourceId)) return true;
    if (await hasActiveGrant(db, user.id, "project", fileObject.sourceId, PERMISSION.ARCHIVE_READ)) {
      return true;
    }
  }
  // 费用票据分支（arch/06 §7：继承费用权限——申请人/财务/明细项目成员；不扩散法律内容权）
  if (fileObject.sourceType === "expense" && fileObject.sourceId) {
    if (user.globalRoles.includes("finance")) return true;
    const hit = await db
      .select({
        applicantId: expenseReports.applicantId,
        itemProjectId: expenseItems.projectId,
      })
      .from(expenseItems)
      .innerJoin(fileVersions, eq(fileVersions.id, expenseItems.receiptFileVersionId))
      .innerJoin(expenseReports, eq(expenseReports.id, expenseItems.expenseReportId))
      .where(eq(fileVersions.fileObjectId, fileObjectId))
      .limit(1);
    if (hit[0]) {
      if (hit[0].applicantId === user.id) return true;
      if (user.projectRoles.has(hit[0].itemProjectId)) return true;
    }
  }
  return hasActiveGrant(db, user.id, "file", fileObjectId, PERMISSION.ARCHIVE_READ);
}

/**
 * 项目可见范围（SQL 条件，供列表/搜索直接拼 where）：
 * 本人是成员的项目 ∪ 有效授权（active、未过期、含 project.read）的项目（arch/03 §2）；
 * arch/03 §2.2 v1.1：partner 恒真（全局只读可见，SQL 级放行不内存过滤）。
 */
export function projectScopeFilter(user: SessionUser): SQL {
  if (user.globalRoles.includes("partner")) return sql`true`;
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
