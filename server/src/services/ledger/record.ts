import { and, eq, sql } from "drizzle-orm";

import { budgetLedger, budgets } from "../../db/schema";
import { nextCode } from "../../db/code";
import type { DbOrTx } from "../../trpc/context";

/**
 * 预算台账唯一写入者（arch/06 §4.1 红线）：budget_ledger 只追加，
 * 全库只允许经本服务写入；幂等键 `entryType:sourceId:seq` 唯一约束兜底，
 * 重试/重放返回已存在分录，绝不重复记账。
 */

export type LedgerEntryType =
  | "BUDGET_ACTIVATED"
  | "BUDGET_ADJUSTED"
  | "FUNDING_RESERVED"
  | "FUNDING_RELEASED"
  | "EXPENSE_RECOGNIZED"
  | "EXPENSE_ADJUSTED";

export interface LedgerEntryInput {
  projectId: string;
  budgetVersionId?: string | null;
  sourceType: string;
  sourceId: string;
  entryType: LedgerEntryType;
  reservedDeltaCents?: number;
  actualDeltaCents?: number;
  /** 同一来源多笔分录的序号（默认 0）；幂等键 = entryType:sourceId:seq */
  seq?: number;
}

export interface LedgerEntry {
  id: string;
  code: string;
  idempotencyKey: string;
}

export async function recordLedger(db: DbOrTx, input: LedgerEntryInput): Promise<LedgerEntry> {
  const key = `${input.entryType}:${input.sourceId}:${input.seq ?? 0}`;
  const dup = await db
    .select({ id: budgetLedger.id, code: budgetLedger.code, idempotencyKey: budgetLedger.idempotencyKey })
    .from(budgetLedger)
    .where(eq(budgetLedger.idempotencyKey, key))
    .limit(1);
  if (dup[0]) return dup[0]; // 重放返回已存在分录（不重复记账）

  const code = await nextCode("LED", db);
  try {
    const [inserted] = await db
      .insert(budgetLedger)
      .values({
        code,
        projectId: input.projectId,
        budgetVersionId: input.budgetVersionId ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        entryType: input.entryType,
        reservedDeltaCents: input.reservedDeltaCents ?? 0,
        actualDeltaCents: input.actualDeltaCents ?? 0,
        idempotencyKey: key,
      })
      .returning({ id: budgetLedger.id, code: budgetLedger.code, idempotencyKey: budgetLedger.idempotencyKey });
    if (!inserted) throw new Error("台账分录插入失败");
    return inserted;
  } catch (error) {
    // 并发兜底：唯一约束命中 → 返回已存在分录
    if ((error as { code?: string }).code === "23505") {
      const raced = await db
        .select({ id: budgetLedger.id, code: budgetLedger.code, idempotencyKey: budgetLedger.idempotencyKey })
        .from(budgetLedger)
        .where(eq(budgetLedger.idempotencyKey, key))
        .limit(1);
      if (raced[0]) return raced[0];
    }
    throw error;
  }
}

/* ===== 五公式聚合（arch/01 §4 冻结口径；marker 分录 deltas 0/0 不参与） ===== */

export interface BudgetAggregate {
  hasBudget: boolean;
  budgetId: string | null;
  budgetCode: string | null;
  effectiveBudgetCents: number;
  reservedCents: number;
  actualCents: number;
  availableCents: number;
  /** 执行率（实际支出 ÷ 有效预算）；无预算为 null */
  executionRate: number | null;
}

export async function aggregateProject(db: DbOrTx, projectId: string): Promise<BudgetAggregate> {
  const [active] = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.projectId, projectId), eq(budgets.status, "active")))
    .limit(1);

  const [sums] = await db
    .select({
      reserved: sql<number>`coalesce(sum(${budgetLedger.reservedDeltaCents}), 0)::bigint`,
      actual: sql<number>`coalesce(sum(${budgetLedger.actualDeltaCents}), 0)::bigint`,
    })
    .from(budgetLedger)
    .where(eq(budgetLedger.projectId, projectId));

  const effective = active?.totalCents ?? 0;
  const reserved = Number(sums.reserved);
  const actual = Number(sums.actual);
  const available = effective - reserved - actual;
  return {
    hasBudget: !!active,
    budgetId: active?.id ?? null,
    budgetCode: active?.code ?? null,
    effectiveBudgetCents: effective,
    reservedCents: reserved,
    actualCents: actual,
    availableCents: available,
    executionRate: active && effective > 0 ? actual / effective : null,
  };
}

/** 项目是否将超预算（提交类动作的预检与核销后的实检共用） */
export function isOverBudget(agg: BudgetAggregate): boolean {
  return agg.hasBudget && agg.availableCents < 0;
}

export function overBudgetMessage(agg: BudgetAggregate): string {
  return `超预算：有效预算 ${agg.effectiveBudgetCents} 分，已占用 ${agg.reservedCents} 分，实际支出 ${agg.actualCents} 分，可用 ${agg.availableCents} 分`;
}

