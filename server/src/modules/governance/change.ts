import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { changeRequests, planItems, planVersions } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { requireProjectRead } from "../../services/access";
import * as engine from "../../services/approval/engine";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "./util";

/**
 * 延期申请域 service（arch/04 §5 change.* + §2.4）：
 * create/update（draft）/submit（校验+引擎）/withdraw；approve/reject 统一走 approval.act。
 * 通过后的版本生成与 live 同步在引擎 handler（modules/approval/handlers.ts）同事务完成。
 */

export interface ChangeTargetItem {
  ref_id: string;
  item_type: "stage" | "milestone" | "task";
  new_start: string;
  new_end: string;
}

export interface RecoveryMeasure {
  measure: string;
  owner_id: string;
  checkpoint_date: string;
}

export interface CreateChangeInput {
  projectId: string;
  title: string;
  level: "normal" | "key";
  targetItems: ChangeTargetItem[];
  reason: string;
  impact: string;
  recoveryMeasures: RecoveryMeasure[];
}

/** 捕获当前计划原日期（active 版本 items），生成 target_items 快照 */
async function snapshotTargets(
  db: DbOrTx,
  projectId: string,
  items: ChangeTargetItem[],
): Promise<Array<ChangeTargetItem & { original_start: string; original_end: string }>> {
  const active = await db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.projectId, projectId), eq(planVersions.status, "active")))
    .limit(1);
  if (!active[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "项目无 active 计划版本");
  const planRows = await db
    .select()
    .from(planItems)
    .where(eq(planItems.planVersionId, active[0].id));
  const byRef = new Map(planRows.map((r) => [`${r.itemType}:${r.refId}`, r]));
  return items.map((item) => {
    const row = byRef.get(`${item.item_type}:${item.ref_id}`);
    if (!row) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "目标计划项不存在", {
        targetItems: [`${item.item_type}/${item.ref_id} 不在当前计划中`],
      });
    }
    return {
      ...item,
      // 里程碑只有计划日（planned_date 落 planned_start），original_end 同值
      original_start: row.plannedStart,
      original_end: item.item_type === "milestone" ? row.plannedStart : row.plannedEnd,
    };
  });
}

export async function createChange(
  db: DbOrTx,
  user: SessionUser,
  input: CreateChangeInput,
): Promise<{ id: string; code: string }> {
  await requireProjectRead(db, user, input.projectId);
  const targetItems = await snapshotTargets(db, input.projectId, input.targetItems);
  const code = await nextCode("CHG", db);
  const [cr] = await db
    .insert(changeRequests)
    .values({
      projectId: input.projectId,
      code,
      title: input.title,
      level: input.level,
      targetItems: targetItems as unknown as Array<Record<string, unknown>>,
      reason: input.reason,
      impact: input.impact,
      recoveryMeasures: input.recoveryMeasures as unknown as Array<Record<string, unknown>>,
      status: "draft",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: changeRequests.id, code: changeRequests.code });
  if (!cr) throw new Error("延期申请插入失败");
  return cr;
}

export async function updateChange(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number } & Partial<Omit<CreateChangeInput, "projectId">>,
): Promise<void> {
  const [cr] = await db.select().from(changeRequests).where(eq(changeRequests.id, input.id)).limit(1);
  if (!cr) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "延期申请不存在或无权访问");
  await requireProjectRead(db, user, cr.projectId);
  if (cr.status !== "draft") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可修改（已提交申请须撤回后修改）");
  }
  if (cr.createdBy !== user.id) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可修改");
  }
  const targetItems = input.targetItems
    ? await snapshotTargets(db, cr.projectId, input.targetItems)
    : undefined;
  const updated = await db
    .update(changeRequests)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(targetItems ? { targetItems: targetItems as unknown as Array<Record<string, unknown>> } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.impact !== undefined ? { impact: input.impact } : {}),
      ...(input.recoveryMeasures
        ? { recoveryMeasures: input.recoveryMeasures as unknown as Array<Record<string, unknown>> }
        : {}),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${changeRequests.rowVersion} + 1`,
    })
    .where(and(eq(changeRequests.id, input.id), eq(changeRequests.rowVersion, input.rowVersion)))
    .returning({ id: changeRequests.id });
  if (!updated[0]) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  }
}

/** 提交前校验（arch/04 §2.4 服务端校验） */
async function validateForSubmit(
  db: DbOrTx,
  cr: typeof changeRequests.$inferSelect,
): Promise<void> {
  if (!cr.reason?.trim() || !cr.impact?.trim() || (cr.recoveryMeasures as unknown[]).length === 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "延期申请须填写原因、影响与恢复措施", {
      reason: [!cr.reason?.trim() ? "须填写书面原因" : ""],
      impact: [!cr.impact?.trim() ? "须填写影响说明" : ""],
      recoveryMeasures: [(cr.recoveryMeasures as unknown[]).length === 0 ? "至少一条恢复措施" : ""],
    });
  }
  // target_items 原日期与当前计划一致（防篡改：以 live/active 当前值复核）
  const active = await db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.projectId, cr.projectId), eq(planVersions.status, "active")))
    .limit(1);
  if (!active[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "项目无 active 计划版本");
  const planRows = await db
    .select()
    .from(planItems)
    .where(eq(planItems.planVersionId, active[0].id));
  const byRef = new Map(planRows.map((r) => [`${r.itemType}:${r.refId}`, r]));
  for (const raw of cr.targetItems as Array<Record<string, unknown>>) {
    const item = raw as { ref_id: string; item_type: "stage" | "milestone" | "task"; original_start: string; original_end: string };
    const row = byRef.get(`${item.item_type}:${item.ref_id}`);
    if (!row) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "目标计划项已不在当前计划中，请撤回修改", {
        targetItems: [`${item.item_type}/${item.ref_id} 已失效`],
      });
    }
    const currentStart = row.plannedStart;
    const currentEnd = item.item_type === "milestone" ? row.plannedStart : row.plannedEnd;
    if (currentStart !== item.original_start || currentEnd !== item.original_end) {
      throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "目标项原日期与当前计划不一致（计划已变更），请刷新后重新提交");
    }
  }
}

export async function submitChange(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; idempotencyKey: string },
) {
  const [cr] = await db.select().from(changeRequests).where(eq(changeRequests.id, input.id)).limit(1);
  if (!cr) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "延期申请不存在或无权访问");
  await requireProjectRead(db, user, cr.projectId);
  if (cr.createdBy !== user.id) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可提交");
  }
  if (cr.status !== "draft") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可提交");
  }
  await validateForSubmit(db, cr);

  const updated = await db
    .update(changeRequests)
    .set({
      status: "pending_approval",
      submittedAt: nowIso(),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${changeRequests.rowVersion} + 1`,
    })
    .where(and(eq(changeRequests.id, input.id), eq(changeRequests.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  }

  // 提交与审批实例创建同事务（engine.submit 幂等：同键返回原实例）
  const instance = await engine.submit(db, {
    bizType: "change_request",
    bizId: cr.id,
    projectId: cr.projectId,
    applicantId: user.id,
    formSnapshot: { level: cr.level, changeRequestCode: cr.code },
    idempotencyKey: input.idempotencyKey,
  });
  await db
    .update(changeRequests)
    .set({ approvalInstanceId: instance.id, updatedAt: nowIso() })
    .where(eq(changeRequests.id, cr.id));
  return { changeRequest: updated[0], instance };
}

export async function withdrawChange(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number },
) {
  const [cr] = await db.select().from(changeRequests).where(eq(changeRequests.id, input.id)).limit(1);
  if (!cr) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "延期申请不存在或无权访问");
  await requireProjectRead(db, user, cr.projectId);
  if (cr.status !== "pending_approval") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅审批中的申请可撤回");
  }
  if (!cr.approvalInstanceId) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "申请缺少审批实例");
  }
  const updated = await db
    .update(changeRequests)
    .set({ updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${changeRequests.rowVersion} + 1` })
    .where(and(eq(changeRequests.id, input.id), eq(changeRequests.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  }
  const instance = await engine.withdraw(db, { instanceId: cr.approvalInstanceId, actorId: user.id });
  return { changeRequest: updated[0], instance };
}

export async function listChanges(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId?: string; status?: string; cursor?: string; limit: number },
) {
  const conditions: (SQL | undefined)[] = [];
  if (input.projectId) {
    await requireProjectRead(db, user, input.projectId);
    conditions.push(eq(changeRequests.projectId, input.projectId));
  } else {
    // 全量列表按可见项目过滤（SQL 级）
    conditions.push(
      sql`${changeRequests.projectId} IN (SELECT project_id FROM project_members WHERE user_id = ${user.id})`,
    );
  }
  if (input.status) conditions.push(eq(changeRequests.status, input.status as "draft"));
  conditions.push(cursorCondition(input.cursor, changeRequests.createdAt, changeRequests.id));

  const rows = await db
    .select()
    .from(changeRequests)
    .where(and(...conditions))
    .orderBy(desc(changeRequests.createdAt), desc(changeRequests.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function getChange(db: DbOrTx, user: SessionUser, id: string) {
  const [cr] = await db.select().from(changeRequests).where(eq(changeRequests.id, id)).limit(1);
  if (!cr) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "延期申请不存在或无权访问");
  await requireProjectRead(db, user, cr.projectId);
  return cr;
}
