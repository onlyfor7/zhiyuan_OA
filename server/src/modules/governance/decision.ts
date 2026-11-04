import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { decisions, tasks, userRoles, users } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { can, requireProjectMember, requireProjectRead } from "../../services/access";
import { notify } from "../../modules/notify";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "./util";

/**
 * 决策域 service（arch/04 §5 decision.* + §2.6）：
 * submitOpinions 按角色各写各的；decide 四必填+双意见齐备+检查点生成任务；
 * verify 回写可溯。不走审批引擎（自有流程，arch/04 §4）。
 */

export interface DecisionOption {
  key: string;
  summary: string;
  impact: string;
  risk: string;
}

export interface Checkpoint {
  point: string;
  date: string;
  owner_id: string;
}

function notFound(): BusinessError {
  return new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "决策不存在或无权访问");
}

async function loadVisible(db: DbOrTx, user: SessionUser, id: string) {
  const [decision] = await db.select().from(decisions).where(eq(decisions.id, id)).limit(1);
  if (!decision) throw notFound();
  await requireProjectRead(db, user, decision.projectId);
  return decision;
}

export interface CreateDecisionInput {
  projectId: string;
  title: string;
  context: string;
  options: DecisionOption[];
}

export async function createDecision(
  db: DbOrTx,
  user: SessionUser,
  input: CreateDecisionInput,
): Promise<{ id: string; code: string }> {
  await requireProjectMember(db, user, input.projectId);
  const code = await nextCode("DEC", db);
  const [decision] = await db
    .insert(decisions)
    .values({
      projectId: input.projectId,
      code,
      title: input.title,
      context: input.context,
      options: input.options as unknown as Array<Record<string, unknown>>,
      status: "draft",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: decisions.id, code: decisions.code });
  if (!decision) throw new Error("决策插入失败");
  return decision;
}

export async function updateDecision(
  db: DbOrTx,
  user: SessionUser,
  input: {
    id: string;
    rowVersion: number;
    title?: string;
    context?: string;
    options?: DecisionOption[];
  },
): Promise<void> {
  const decision = await loadVisible(db, user, input.id);
  await requireProjectMember(db, user, decision.projectId);
  if (decision.status !== "draft") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可修改（决策进入流程后不可改）");
  }
  const updated = await db
    .update(decisions)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(input.options !== undefined
        ? { options: input.options as unknown as Array<Record<string, unknown>> }
        : {}),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${decisions.rowVersion} + 1`,
    })
    .where(and(eq(decisions.id, input.id), eq(decisions.rowVersion, input.rowVersion)))
    .returning({ id: decisions.id });
  if (!updated[0]) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  }
}

/** 按角色各写各的：pm 角色 → pm_opinion；quality_lead → quality_opinion */
export async function submitOpinions(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; pmOpinion?: string; qualityOpinion?: string },
) {
  const decision = await loadVisible(db, user, input.id);
  await requireProjectMember(db, user, decision.projectId);
  if (decision.status !== "draft" && decision.status !== "deciding") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "当前状态不可提交意见");
  }
  const patch: Record<string, unknown> = { updatedBy: user.id, updatedAt: nowIso() };
  if (input.pmOpinion !== undefined) {
    if (!user.globalRoles.includes("project_manager")) {
      throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅项目负责人角色可提交项目负责人意见");
    }
    patch.pmOpinion = input.pmOpinion;
  }
  if (input.qualityOpinion !== undefined) {
    if (!user.globalRoles.includes("quality_lead")) {
      throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅质量负责人角色可提交质量意见");
    }
    patch.qualityOpinion = input.qualityOpinion;
  }
  const enteringDeciding = decision.status === "draft";
  if (enteringDeciding) patch.status = "deciding";
  patch.rowVersion = sql`${decisions.rowVersion} + 1`;

  const [updated] = await db.update(decisions).set(patch).where(eq(decisions.id, input.id)).returning();
  if (!updated) throw notFound();

  if (enteringDeciding) {
    // decision_required → 决策人（项目负责人/管理层，arch/04 §6）
    const targets = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(sql`${userRoles.roleKey} in ('project_manager', 'partner') and ${users.status} = 'active'`);
    for (const t of targets) {
      await notify(db, {
        eventType: "decision_required",
        recipientId: t.userId,
        sourceType: "decision",
        sourceId: decision.id,
        payload: { code: decision.code, title: decision.title },
      });
    }
  }
  return updated;
}

export async function decide(
  db: DbOrTx,
  user: SessionUser,
  input: {
    id: string;
    finalOption: string;
    finalReason: string;
    conditions: string;
    checkpoints: Checkpoint[];
    rowVersion: number;
  },
) {
  const decision = await loadVisible(db, user, input.id);
  await requireProjectMember(db, user, decision.projectId);
  const manage = await can(db, user, "project.manage", { type: "project", projectId: decision.projectId });
  if (!manage && !user.globalRoles.includes("partner")) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅项目负责人或管理层可作出决定");
  }
  if (decision.status !== "deciding") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "决策须处于 deciding 状态");
  }
  // 四必填 + 双意见齐备（arch/04 §2.6 硬规则）
  const fieldErrors: Record<string, string[]> = {};
  if (!input.finalOption?.trim()) fieldErrors.finalOption = ["必须选择最终方案"];
  if (!input.finalReason?.trim()) fieldErrors.finalReason = ["必须填写决定理由"];
  if (!input.conditions?.trim()) fieldErrors.conditions = ["必须填写附加条件"];
  if (!input.checkpoints || input.checkpoints.length === 0) {
    fieldErrors.checkpoints = ["至少一个检查点"];
  }
  if (!decision.pmOpinion?.trim()) fieldErrors.pmOpinion = ["项目负责人意见缺失"];
  if (!decision.qualityOpinion?.trim()) fieldErrors.qualityOpinion = ["质量负责人意见缺失"];
  if (Object.keys(fieldErrors).length > 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "决定信息不完整（四必填+双意见）", fieldErrors);
  }

  const now = nowIso();
  const [updated] = await db
    .update(decisions)
    .set({
      status: "decided",
      finalOption: input.finalOption,
      finalReason: input.finalReason,
      conditions: input.conditions,
      checkpoints: input.checkpoints as unknown as Array<Record<string, unknown>>,
      deciderId: user.id,
      decidedAt: now,
      updatedBy: user.id,
      updatedAt: now,
      rowVersion: sql`${decisions.rowVersion} + 1`,
    })
    .where(and(eq(decisions.id, input.id), eq(decisions.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  }

  // 检查点生成任务（source_type='decision'，arch/04 §2.6）
  for (const cp of input.checkpoints) {
    const code = await nextCode("TSK", db);
    await db.insert(tasks).values({
      projectId: decision.projectId,
      code,
      title: `决策检查点：${cp.point}`,
      assigneeId: cp.owner_id,
      plannedStart: cp.date,
      plannedEnd: cp.date,
      status: "pending",
      sourceType: "decision",
      sourceId: decision.id,
      createdBy: user.id,
      updatedBy: user.id,
    });
  }
  return updated;
}

export async function verifyDecision(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; note: string },
) {
  const decision = await loadVisible(db, user, input.id);
  await requireProjectMember(db, user, decision.projectId);
  if (decision.status !== "decided") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅已决定决策可验证（verify 必须 decided 之后）");
  }
  if (!input.note?.trim()) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "验证说明必填", { note: ["验证说明必填"] });
  }
  const now = nowIso();
  const [updated] = await db
    .update(decisions)
    .set({
      status: "verified",
      verificationNote: input.note,
      verifiedAt: now,
      verifiedBy: user.id,
      updatedBy: user.id,
      updatedAt: now,
      rowVersion: sql`${decisions.rowVersion} + 1`,
    })
    .where(eq(decisions.id, input.id))
    .returning();
  if (!updated) throw notFound();
  return updated;
}

export async function listDecisions(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId?: string; status?: string; cursor?: string; limit: number },
) {
  const conditions: (SQL | undefined)[] = [];
  if (input.projectId) {
    await requireProjectRead(db, user, input.projectId);
    conditions.push(eq(decisions.projectId, input.projectId));
  } else {
    conditions.push(
      sql`${decisions.projectId} IN (SELECT project_id FROM project_members WHERE user_id = ${user.id})`,
    );
  }
  if (input.status) conditions.push(eq(decisions.status, input.status as "draft"));
  conditions.push(cursorCondition(input.cursor, decisions.createdAt, decisions.id));

  const rows = await db
    .select()
    .from(decisions)
    .where(and(...conditions))
    .orderBy(desc(decisions.createdAt), desc(decisions.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function getDecision(db: DbOrTx, user: SessionUser, id: string) {
  return loadVisible(db, user, id);
}
