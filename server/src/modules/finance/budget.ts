import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE, type ExpenseCategory } from "@lexflow/shared";

import { budgets, budgetCategories, budgetLedger } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { aggregateProject } from "../../services/ledger/record";
import * as engine from "../../services/approval/engine";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "../governance/util";

/**
 * 预算域 service（arch/06 §3/§7）：create/submit/withdraw/adjust/close；
 * 生效与调整经引擎 biz_type='budget'，通过同事务写 BUDGET_ACTIVATED/ADJUSTED marker。
 * 财务摘要权限：项目负责人（project.manage）/partner/finance（arch/06 §7）。
 */

export function canFinanceSummary(user: SessionUser, projectId: string): boolean {
  return (
    user.projectRoles.get(projectId) === "manager" ||
    user.globalRoles.includes("partner") ||
    user.globalRoles.includes("finance")
  );
}

export async function requireFinanceSummary(db: DbOrTx, user: SessionUser, projectId: string): Promise<void> {
  void db;
  if (!canFinanceSummary(user, projectId)) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权访问");
  }
}

export interface CreateBudgetInput {
  projectId: string;
  periodStart: string;
  periodEnd: string;
  totalCents: number;
  description?: string;
  categories?: Array<{ category: ExpenseCategory; amountCents: number }>;
}

export async function createBudget(
  db: DbOrTx,
  user: SessionUser,
  input: CreateBudgetInput,
): Promise<{ id: string; code: string }> {
  await requireFinanceSummary(db, user, input.projectId);
  if (input.periodEnd < input.periodStart) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "期间结束日不能早于开始日", {
      periodEnd: ["期间结束日不能早于开始日"],
    });
  }
  if (input.totalCents <= 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "预算总额须为正整数（分）", {
      totalCents: ["预算总额须为正整数（分）"],
    });
  }
  const [maxVersion] = await db
    .select({ max: sql<number>`coalesce(max(${budgets.versionNo}), 0)` })
    .from(budgets)
    .where(eq(budgets.projectId, input.projectId));
  const code = await nextCode("BUD", db);
  const [budget] = await db
    .insert(budgets)
    .values({
      projectId: input.projectId,
      code,
      versionNo: Number(maxVersion.max) + 1,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      totalCents: input.totalCents,
      description: input.description ?? null,
      status: "draft",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: budgets.id, code: budgets.code });
  if (!budget) throw new Error("预算插入失败");
  for (const category of input.categories ?? []) {
    if (category.amountCents <= 0) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "类别额度须为正整数（分）", {
        categories: [`${category.category} 额度非法`],
      });
    }
    await db.insert(budgetCategories).values({
      budgetId: budget.id,
      category: category.category,
      amountCents: category.amountCents,
    });
  }
  return budget;
}

async function loadBudget(db: DbOrTx, id: string) {
  const [budget] = await db.select().from(budgets).where(eq(budgets.id, id)).limit(1);
  if (!budget) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "预算不存在或无权访问");
  return budget;
}

export async function submitBudget(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number; idempotencyKey: string }) {
  const budget = await loadBudget(db, input.id);
  await requireFinanceSummary(db, user, budget.projectId);
  if (budget.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可提交");
  const updated = await db
    .update(budgets)
    .set({ status: "pending_approval", updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${budgets.rowVersion} + 1` })
    .where(and(eq(budgets.id, input.id), eq(budgets.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  const instance = await engine.submit(db, {
    bizType: "budget",
    bizId: budget.id,
    projectId: budget.projectId,
    applicantId: user.id,
    formSnapshot: { budgetCode: budget.code, versionNo: budget.versionNo },
    idempotencyKey: input.idempotencyKey,
  });
  await db.update(budgets).set({ approvalInstanceId: instance.id }).where(eq(budgets.id, budget.id));
  return { budget: updated[0], instance };
}

export async function withdrawBudget(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number }) {
  const budget = await loadBudget(db, input.id);
  await requireFinanceSummary(db, user, budget.projectId);
  if (budget.status !== "pending_approval" || !budget.approvalInstanceId) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅审批中的预算可撤回");
  }
  const updated = await db
    .update(budgets)
    .set({ updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${budgets.rowVersion} + 1` })
    .where(and(eq(budgets.id, input.id), eq(budgets.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  const instance = await engine.withdraw(db, { instanceId: budget.approvalInstanceId, actorId: user.id });
  return { budget: updated[0], instance };
}

/** 调整：产新 draft 版本（总额=delta、类别复制）并立即送审；通过后旧版 superseded + BUDGET_ADJUSTED */
export async function adjustBudget(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; deltaCents: number; reason: string; idempotencyKey: string },
) {
  const base = await loadBudget(db, input.id);
  await requireFinanceSummary(db, user, base.projectId);
  if (base.status !== "active") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅生效中预算可调整");
  if (input.deltaCents === 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "调整额不能为 0", { deltaCents: ["调整额不能为 0"] });
  }
  if (base.totalCents + input.deltaCents <= 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "调整后总额须为正", { deltaCents: ["调整后总额须为正"] });
  }
  if (!input.reason.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "调整须填原因", { reason: ["调整须填原因"] });

  const [maxVersion] = await db
    .select({ max: sql<number>`coalesce(max(${budgets.versionNo}), 0)` })
    .from(budgets)
    .where(eq(budgets.projectId, base.projectId));
  const code = await nextCode("BUD", db);
  const categories = await db.select().from(budgetCategories).where(eq(budgetCategories.budgetId, base.id));
  const [draft] = await db
    .insert(budgets)
    .values({
      projectId: base.projectId,
      code,
      versionNo: Number(maxVersion.max) + 1,
      periodStart: base.periodStart,
      periodEnd: base.periodEnd,
      totalCents: base.totalCents + input.deltaCents,
      description: `调整 ${input.deltaCents > 0 ? "+" : ""}${input.deltaCents} 分：${input.reason.trim()}（基线 ${base.code} V${base.versionNo}）`,
      status: "pending_approval",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!draft) throw new Error("调整版本插入失败");
  for (const category of categories) {
    await db.insert(budgetCategories).values({
      budgetId: draft.id,
      category: category.category,
      amountCents: category.amountCents,
    });
  }
  const instance = await engine.submit(db, {
    bizType: "budget",
    bizId: draft.id,
    projectId: base.projectId,
    applicantId: user.id,
    formSnapshot: { budgetCode: draft.code, versionNo: draft.versionNo, adjustOf: base.id },
    idempotencyKey: input.idempotencyKey,
  });
  await db.update(budgets).set({ approvalInstanceId: instance.id }).where(eq(budgets.id, draft.id));
  return { budget: draft, instance };
}

export async function closeBudget(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number }) {
  const budget = await loadBudget(db, input.id);
  await requireFinanceSummary(db, user, budget.projectId);
  if (budget.status !== "active") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅生效中预算可关闭");
  const [updated] = await db
    .update(budgets)
    .set({ status: "closed", updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${budgets.rowVersion} + 1` })
    .where(and(eq(budgets.id, input.id), eq(budgets.status, "active"), eq(budgets.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  return updated;
}

export async function getBudgetById(db: DbOrTx, user: SessionUser, id: string) {
  const budget = await loadBudget(db, id);
  await requireFinanceSummary(db, user, budget.projectId);
  const categories = await db.select().from(budgetCategories).where(eq(budgetCategories.budgetId, id));
  const aggregate = await aggregateProject(db, budget.projectId);
  return { ...budget, categories, aggregate };
}

export async function listBudgets(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId?: string; cursor?: string; limit: number },
) {
  const conditions: (SQL | undefined)[] = [];
  if (input.projectId) {
    await requireFinanceSummary(db, user, input.projectId);
    conditions.push(eq(budgets.projectId, input.projectId));
  } else if (canFinanceSummaryAny(user)) {
    // 全量：不限项目（partner/finance 跨项目视角）
  } else {
    conditions.push(
      sql`${budgets.projectId} IN (
        SELECT project_id FROM project_members WHERE user_id = ${user.id} AND project_role = 'manager'
      )`,
    );
  }
  conditions.push(cursorCondition(input.cursor, budgets.createdAt, budgets.id));
  const rows = await db
    .select()
    .from(budgets)
    .where(and(...conditions))
    .orderBy(desc(budgets.createdAt), desc(budgets.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

function canFinanceSummaryAny(user: SessionUser): boolean {
  return user.globalRoles.includes("partner") || user.globalRoles.includes("finance");
}

export async function ledgerDetail(
  db: DbOrTx,
  user: SessionUser,
  input: { budgetId?: string; projectId?: string; cursor?: string; limit: number },
) {
  const conditions: (SQL | undefined)[] = [];
  if (input.budgetId) {
    const [budget] = await db.select().from(budgets).where(eq(budgets.id, input.budgetId)).limit(1);
    if (!budget) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "预算不存在或无权访问");
    await requireFinanceSummary(db, user, budget.projectId);
    conditions.push(eq(budgetLedger.budgetVersionId, input.budgetId));
  } else if (input.projectId) {
    await requireFinanceSummary(db, user, input.projectId);
    conditions.push(eq(budgetLedger.projectId, input.projectId));
  } else {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "budgetId 与 projectId 至少提供一个", {
      projectId: ["budgetId 与 projectId 至少提供一个"],
    });
  }
  conditions.push(cursorCondition(input.cursor, budgetLedger.createdAt, budgetLedger.id));
  const rows = await db
    .select()
    .from(budgetLedger)
    .where(and(...conditions))
    .orderBy(desc(budgetLedger.occurredAt), desc(budgetLedger.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
