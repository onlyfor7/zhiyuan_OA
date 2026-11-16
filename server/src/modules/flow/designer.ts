import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { customFormDefs, flowDefinitions } from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { can } from "../../services/access";
import { recordAudit } from "../../services/audit";
import { assertFlowPublishable, validateFlowStructure } from "../../services/approval/flow";
import { isFlowV2Def, validateFlowStructureV2 } from "../../services/approval/flow-v2";

/** 保存校验双读分发（20-02）：schemaVersion=2 走 v2 结构校验，否则 v1；
 *  custom_form 绑定流允许 form.<fieldKey> 条件字段与 form_contact 审批人（带表单字段集） */
async function validateFlowStructureDispatch(db: DbOrTx, raw: unknown, bizBinding: string): Promise<void> {
  if (!isFlowV2Def(raw)) {
    validateFlowStructure(raw);
    return;
  }
  if (bizBinding.startsWith("custom_form:")) {
    const code = bizBinding.slice("custom_form:".length);
    const [form] = await db.select({ formSchema: customFormDefs.formSchema }).from(customFormDefs).where(eq(customFormDefs.code, code)).limit(1);
    const keys = ((form?.formSchema as { fields?: Array<{ key?: string }> } | undefined)?.fields ?? []).map((f) => f.key ?? "");
    validateFlowStructureV2(raw, { allowFormFields: true, formFieldKeys: keys });
    return;
  }
  validateFlowStructureV2(raw);
}
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

type FlowRow = typeof flowDefinitions.$inferSelect;

export async function listFlows(db: DbOrTx, user: SessionUser) {
  await requireFlowAdmin(db, user);
  const rows = await db.select().from(flowDefinitions).orderBy(flowDefinitions.bizBinding, desc(flowDefinitions.versionNo));
  // G5：/admin 列表分「系统级 / 项目内」两区（前端按 byScope 分区展示）
  // 20-02 §4：固定组「业务审批」+ 自定义表单各组（按 custom_form_defs.group_name 聚合）
  const cfRows = await db.select({ code: customFormDefs.code, groupName: customFormDefs.groupName }).from(customFormDefs);
  const groupByCode = new Map(cfRows.map((r) => [r.code, r.groupName || "通用"]));
  const groupOf = (r: (typeof rows)[number]): string => {
    if (!r.bizBinding.startsWith("custom_form:")) return "业务审批";
    const code = r.bizBinding.slice("custom_form:".length);
    return groupByCode.get(code) ?? "通用";
  };
  const byGroupMap = new Map<string, typeof rows>();
  for (const r of rows) {
    const g = groupOf(r);
    byGroupMap.set(g, [...(byGroupMap.get(g) ?? []), r]);
  }
  return {
    items: rows,
    byScope: {
      system: rows.filter((r) => r.scope === "global"),
      project: rows.filter((r) => r.scope === "project"),
    },
    byGroup: [...byGroupMap.entries()].map(([groupName, items]) => ({ groupName, items })),
  };
}

/** 复制为新草稿（20-02 §4）：深拷贝 definitionJson、版本号新起；custom_form 绑定流须走 forms 复制语义 */
export async function duplicateFlowAsDraft(db: DbOrTx, user: SessionUser, input: { id: string }, ip: string | null, sessionId: string | null) {
  await requireFlowAdmin(db, user);
  const [row] = await db.select().from(flowDefinitions).where(eq(flowDefinitions.id, input.id)).limit(1);
  if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "流程不存在或无权访问");
  if (row.bizBinding.startsWith("custom_form:")) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "表单绑定流程请复制表单（1:1 绑定不可独立复制）", { id: ["表单流程不可复制"] });
  }
  const draft = await insertFlowDraftRow(db, user.id, {
    name: `${row.name} 副本`,
    scope: row.scope as "global" | "project",
    bizBinding: row.bizBinding,
    projectId: row.projectId,
    definitionJson: JSON.parse(JSON.stringify(row.definitionJson)) as Record<string, unknown>,
  });
  await recordAudit(db, { actorId: user.id, sessionId, action: "flow.duplicateAsDraft", targetType: "flow_definition", targetId: draft.id, result: "success", afterJson: { fromId: row.id, name: draft.name }, ip });
  return draft;
}

/** 删除流程（20-02 §4）：仅草稿（未启用）；表单绑定流走 forms.delete */
export async function deleteFlowDraft(db: DbOrTx, user: SessionUser, input: { id: string }, ip: string | null, sessionId: string | null) {
  await requireFlowAdmin(db, user);
  const [row] = await db.select().from(flowDefinitions).where(eq(flowDefinitions.id, input.id)).limit(1);
  if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "流程不存在或无权访问");
  if (row.enabled) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿（未启用）流程可删除");
  if (row.bizBinding.startsWith("custom_form:")) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "表单绑定流程请删除表单（1:1 绑定）", { id: ["表单流程不可独立删除"] });
  }
  await db.delete(flowDefinitions).where(eq(flowDefinitions.id, row.id));
  await recordAudit(db, { actorId: user.id, sessionId, action: "flow.deleteDraft", targetType: "flow_definition", targetId: row.id, result: "success", beforeJson: { name: row.name, bizBinding: row.bizBinding }, ip });
  return { id: row.id, deleted: true as const };
}

export async function getFlowById(db: DbOrTx, user: SessionUser, id: string) {
  await requireFlowAdmin(db, user);
  const [row] = await db.select().from(flowDefinitions).where(eq(flowDefinitions.id, id)).limit(1);
  if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "流程不存在或无权访问");
  return row;
}

/* ===== 行级原语（系统级与项目级入口共用；权限门由调用方把守） ===== */

export async function insertFlowDraftRow(
  db: DbOrTx,
  actorId: string,
  input: { name: string; scope: "global" | "project"; bizBinding: string; projectId?: string | null; definitionJson: Record<string, unknown> },
): Promise<FlowRow> {
  await validateFlowStructureDispatch(db, input.definitionJson, input.bizBinding); // FLOW_INVALID（400，v1/v2 双读）
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
      projectId: input.scope === "project" ? (input.projectId ?? null) : null,
      versionNo: Number(maxVersion.max) + 1,
      definitionJson: input.definitionJson,
      enabled: false,
      createdBy: actorId,
      updatedBy: actorId,
    })
    .returning();
  if (!row) throw new Error("流程插入失败");
  return row;
}

export async function publishFlowRow(
  db: DbOrTx,
  actorId: string,
  row: FlowRow,
  idempotencyKey: string,
): Promise<{ flow: FlowRow; published: boolean }> {
  void idempotencyKey; // 行 enabled 态即幂等语义（已启用重放 published=false）
  if (row.enabled) return { flow: row, published: false }; // 幂等重放
  await validateFlowStructureDispatch(db, row.definitionJson, row.bizBinding);
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
    return ["__runtime__"]; // initiator_manager / initiator_choice 运行时解析，发布只校验结构
  };
  await assertFlowPublishable(globalDb, row.definitionJson, resolveKind, row.bizBinding);

  // R7 修复：每 (biz_binding, 项目) 恰一 enabled（部分唯一索引）——发布先释放同 binding 同 scope
  // 的全部启用流程（含「xxx 默认流程」，否则唯一索引 23505 → 500）；按 name 释放会让
  // 新名自定义流与默认流双启用冲突。停用自定义流后无启用流程 → 引擎回退 approval_policies（默认语义）。
  await db
    .update(flowDefinitions)
    .set({ enabled: false, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(flowDefinitions.bizBinding, row.bizBinding),
        eq(flowDefinitions.enabled, true),
        row.projectId ? eq(flowDefinitions.projectId, row.projectId) : isNull(flowDefinitions.projectId),
      ),
    );
  const [published] = await db
    .update(flowDefinitions)
    .set({ enabled: true, updatedBy: actorId, updatedAt: new Date().toISOString(), rowVersion: sql`${flowDefinitions.rowVersion} + 1` })
    .where(and(eq(flowDefinitions.id, row.id), eq(flowDefinitions.enabled, false)))
    .returning();
  if (!published) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "流程状态已变化");
  return { flow: published, published: true as const };
}

export async function disableFlowRow(db: DbOrTx, actorId: string, id: string, rowVersion: number): Promise<FlowRow> {
  const [updated] = await db
    .update(flowDefinitions)
    .set({ enabled: false, updatedBy: actorId, updatedAt: new Date().toISOString(), rowVersion: sql`${flowDefinitions.rowVersion} + 1` })
    .where(and(eq(flowDefinitions.id, id), eq(flowDefinitions.enabled, true), eq(flowDefinitions.rowVersion, rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "流程未启用或数据已被他人修改");
  return updated;
}

/* ===== 系统级入口（/admin；sysadmin/partner） ===== */

export async function createFlowDraft(
  db: DbOrTx,
  user: SessionUser,
  input: { name: string; scope: "global" | "project"; bizBinding: string; projectId?: string | null; definitionJson: Record<string, unknown> },
) {
  await requireFlowAdmin(db, user);
  return insertFlowDraftRow(db, user.id, input);
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
  if (input.definitionJson) {
    const [row] = await db.select({ bizBinding: flowDefinitions.bizBinding }).from(flowDefinitions).where(eq(flowDefinitions.id, input.id)).limit(1);
    await validateFlowStructureDispatch(db, input.definitionJson, row?.bizBinding ?? "");
  }
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
  return publishFlowRow(db, user.id, row, input.idempotencyKey);
}

export async function disableFlow(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number }) {
  await requireFlowAdmin(db, user);
  return disableFlowRow(db, user.id, input.id, input.rowVersion);
}

export async function flowVersions(db: DbOrTx, user: SessionUser, name: string) {
  await requireFlowAdmin(db, user);
  return db.select().from(flowDefinitions).where(eq(flowDefinitions.name, name)).orderBy(desc(flowDefinitions.versionNo));
}
