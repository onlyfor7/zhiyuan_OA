import { and, desc, eq, sql } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { flowDefinitions } from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { can } from "../../services/access";
import { assertFlowPublishable, validateFlowStructure } from "../../services/approval/flow";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/** 审批流设计器域（arch/09 §3.3）：draft/publish/disable/versions；sysadmin/partner；发布前服务端强制校验 */

async function requireFlowAdmin(db: DbOrTx, user: SessionUser): Promise<void> {
  const allowed =
    user.globalRoles.includes("sysadmin") ||
    user.globalRoles.includes("partner") ||
    (await can(db, user, "admin.config", { type: "project", projectId: "" }));
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "无流程管理权限");
}

export async function listFlows(db: DbOrTx, user: SessionUser) {
  await requireFlowAdmin(db, user);
  return db.select().from(flowDefinitions).orderBy(flowDefinitions.bizBinding, desc(flowDefinitions.versionNo));
}

export async function getFlowById(db: DbOrTx, user: SessionUser, id: string) {
  await requireFlowAdmin(db, user);
  const [row] = await db.select().from(flowDefinitions).where(eq(flowDefinitions.id, id)).limit(1);
  if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "流程不存在或无权访问");
  return row;
}

export async function createFlowDraft(
  db: DbOrTx,
  user: SessionUser,
  input: { name: string; scope: "global" | "project"; bizBinding: string; definitionJson: Record<string, unknown> },
) {
  await requireFlowAdmin(db, user);
  validateFlowStructure(input.definitionJson); // FLOW_INVALID（400）
  const [maxVersion] = await db
    .select({ max: sql<number>`coalesce(max(${flowDefinitions.versionNo}), 0)` })
    .from(flowDefinitions)
    .where(eq(flowDefinitions.name, input.name));
  const [row] = await db
    .insert(flowDefinitions)
    .values({
      name: input.name,
      scope: input.scope,
      bizBinding: input.bizBinding,
      versionNo: Number(maxVersion.max) + 1,
      definitionJson: input.definitionJson,
      enabled: false,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!row) throw new Error("流程插入失败");
  return row;
}

export async function updateFlowDraft(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; name?: string; definitionJson?: Record<string, unknown> },
) {
  await requireFlowAdmin(db, user);
  const [row] = await db.select().from(flowDefinitions).where(eq(flowDefinitions.id, input.id)).limit(1);
  if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "流程不存在或无权访问");
  if (row.enabled) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已发布流程不可修改（须先停用再产新版本）");
  if (input.definitionJson) validateFlowStructure(input.definitionJson);
  const [updated] = await db
    .update(flowDefinitions)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.definitionJson !== undefined ? { definitionJson: input.definitionJson } : {}),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${flowDefinitions.rowVersion} + 1`,
    })
    .where(and(eq(flowDefinitions.id, input.id), eq(flowDefinitions.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  return updated;
}

export async function publishFlow(db: DbOrTx, user: SessionUser, input: { id: string; idempotencyKey: string }) {
  await requireFlowAdmin(db, user);
  const [row] = await db.select().from(flowDefinitions).where(eq(flowDefinitions.id, input.id)).limit(1);
  if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "流程不存在或无权访问");
  if (row.enabled) return { flow: row, published: false as const }; // 幂等重放
  validateFlowStructure(row.definitionJson);
  // 发布语义校验：全部可达审批节点可解析（角色零用户 → FLOW_UNPUBLISHABLE）
  const { db: globalDb } = await import("../../db/client");
  const resolveKind = async (kind: string, role: string | null, userId: string | null): Promise<string[]> => {
    if (kind === "user") return userId ? [userId] : [];
    if (kind === "role") {
      const { userRoles, users } = await import("../../db/schema");
      const rows = await globalDb
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(and(eq(userRoles.roleKey, role!), eq(users.status, "active")));
      return rows.map((r) => r.userId);
    }
    if (kind === "project_manager") {
      const projects = (await import("../../db/schema")).projects;
      const projRows = await globalDb.select({ managerId: projects.managerId }).from(projects).limit(1);
      return projRows[0] ? [projRows[0].managerId] : [];
    }
    return ["__runtime__"]; // initiator_manager 运行时解析，发布只校验结构
  };
  await assertFlowPublishable(globalDb, row.definitionJson, resolveKind);

  // 每 name 恰一个 enabled：先释放同 name 旧版本（部分唯一索引）
  await db
    .update(flowDefinitions)
    .set({ enabled: false, updatedAt: new Date().toISOString() })
    .where(and(eq(flowDefinitions.name, row.name), eq(flowDefinitions.enabled, true)));
  const [published] = await db
    .update(flowDefinitions)
    .set({ enabled: true, updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${flowDefinitions.rowVersion} + 1` })
    .where(and(eq(flowDefinitions.id, row.id), eq(flowDefinitions.enabled, false)))
    .returning();
  if (!published) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "流程状态已变化");
  return { flow: published, published: true as const };
}

export async function disableFlow(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number }) {
  await requireFlowAdmin(db, user);
  const [updated] = await db
    .update(flowDefinitions)
    .set({ enabled: false, updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${flowDefinitions.rowVersion} + 1` })
    .where(and(eq(flowDefinitions.id, input.id), eq(flowDefinitions.enabled, true), eq(flowDefinitions.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "流程未启用或数据已被他人修改");
  return updated;
}

export async function flowVersions(db: DbOrTx, user: SessionUser, name: string) {
  await requireFlowAdmin(db, user);
  return db.select().from(flowDefinitions).where(eq(flowDefinitions.name, name)).orderBy(desc(flowDefinitions.versionNo));
}
