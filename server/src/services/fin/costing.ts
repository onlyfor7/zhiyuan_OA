import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import {
  budgetLedger,
  crmContractPaymentPlans,
  crmContracts,
  crmOpportunities,
  expenseItems,
  finReceivables,
  finCostRates,
  paymentReceipts,
  projects,
  timeEntries,
  timesheetPeriods,
  userRoles,
} from "../../db/schema";
import type { DbOrTx } from "../../trpc/context";

/**
 * 项目核算聚合（arch/12 §7.3 冻结公式，唯一实现处——报表域复用本函数，禁止另写口径）：
 * - 项目收入 = Σ合同额（签约口径，terminated 不计）
 * - 已回款 = Σ收款 registered − Σ收款 voided（净额）
 * - 应收余额 = Σ应收未结剩余（应收额 − 经计划行挂钩的 registered 回款）
 * - 直接成本 = Σ台账 EXPENSE_RECOGNIZED（确认实际唯一入口：费用核销与经费支出同源，取一次不双计）
 * - 人力成本 = Σ（批准+锁定工时）× 成本率（按人价优先，否则按角色价；无率计 0）
 * - 毛利双口径：回款口径 = 已回款 − 直接 − 人力；签约口径 = 收入 − 直接 − 人力
 */

export interface ProjectCosting {
  projectId: string;
  code: string;
  name: string;
  revenueCents: number;
  receivedCents: number;
  arBalanceCents: number;
  directCostCents: number;
  laborCostCents: number;
  grossMarginCents: number;
  grossMarginOnContractCents: number;
  /** 成本分段（arch/13 §5.5，加性字段不删既有）：total=presales+delivery=直接成本（不双计） */
  presalesCostCents: number;
  deliveryCostCents: number;
  totalCostCents: number;
}

export async function computeProjectCosting(db: DbOrTx, projectId: string): Promise<ProjectCosting | null> {
  const [project] = await db
    .select({ id: projects.id, code: projects.code, name: projects.name, matterId: projects.matterId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;

  // 收入：合同额（签约口径，本事项下非 terminated）
  const contractRows = await db
    .select({ amount: crmContracts.amountCents })
    .from(crmContracts)
    .where(and(eq(crmContracts.matterId, project.matterId), ne(crmContracts.status, "terminated")));
  const revenueCents = contractRows.reduce((s, r) => s + r.amount, 0);

  // 已回款：registered − voided 净额（本项目）
  const receiptAgg = await db
    .select({
      registered: sql<number>`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'registered'), 0)::float8`,
      voided: sql<number>`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'voided'), 0)::float8`,
    })
    .from(paymentReceipts)
    .where(eq(paymentReceipts.projectId, projectId));
  const receivedCents = Number(receiptAgg[0]?.registered ?? 0) - Number(receiptAgg[0]?.voided ?? 0);

  // 应收余额：本事项合同下非 settled 应收的剩余额（应收额 − 挂钩 registered 回款；应收→计划行→收款链）
  const receivableRows = await db
    .select({
      amount: finReceivables.amountCents,
      linked: sql<number>`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'registered'), 0)::float8`,
    })
    .from(finReceivables)
    .innerJoin(crmContracts, eq(finReceivables.contractId, crmContracts.id))
    .leftJoin(crmContractPaymentPlans, eq(crmContractPaymentPlans.id, finReceivables.planId))
    .leftJoin(paymentReceipts, eq(paymentReceipts.id, crmContractPaymentPlans.receiptId))
    .where(and(eq(crmContracts.matterId, project.matterId), ne(finReceivables.status, "settled")))
    .groupBy(finReceivables.id, finReceivables.amountCents);
  const arBalanceCents = receivableRows.reduce((s, r) => s + Math.max(0, r.amount - Number(r.linked ?? 0)), 0);

  // 直接成本：台账 EXPENSE_RECOGNIZED 实际额（确认实际唯一入口）
  const directAgg = await db
    .select({ s: sql<number>`coalesce(sum(${budgetLedger.actualDeltaCents}), 0)::float8` })
    .from(budgetLedger)
    .where(and(eq(budgetLedger.projectId, projectId), eq(budgetLedger.entryType, "EXPENSE_RECOGNIZED")));
  const directCostCents = Number(directAgg[0]?.s ?? 0);

  // 成本分段（arch/13 §5.5 统一业务公式）：
  // - 无激活合同（含开放与已关闭商机）：有效费用全部计售前；
  // - 有激活合同：费用明细业务发生日期早于合同激活业务日期=售前；同日及以后=交付；
  // - 非商机来源存量项目：沿用既有口径（全部计交付，售前=0）；
  // 日期取 expense_items.date（台账幂等键 EXPENSE_RECOGNIZED:{reportId}:{itemId} 第三段=明细 id），
  // 非费用台账行（经费支出等）回退台账 occurred_at。
  const [oppLink] = await db
    .select({ id: crmOpportunities.id })
    .from(crmOpportunities)
    .where(eq(crmOpportunities.projectId, projectId))
    .limit(1);
  const [active] = await db
    .select({ signedAt: crmContracts.signedAt })
    .from(crmContracts)
    .where(and(eq(crmContracts.matterId, project.matterId), eq(crmContracts.status, "active")))
    .orderBy(asc(crmContracts.signedAt))
    .limit(1);
  let presalesCostCents = 0;
  let deliveryCostCents = 0;
  if (!oppLink) {
    deliveryCostCents = directCostCents; // 存量非商机项目：既有口径
  } else if (!active?.signedAt) {
    presalesCostCents = directCostCents; // 无激活合同：全部售前（含 lost）
  } else {
    const cut = active.signedAt.slice(0, 10);
    const splitRows = await db
      .select({
        d: sql<string>`coalesce(${expenseItems.date}::text, ${budgetLedger.occurredAt}::text)`,
        s: sql<number>`coalesce(sum(${budgetLedger.actualDeltaCents}), 0)::float8`,
      })
      .from(budgetLedger)
      .leftJoin(
        expenseItems,
        sql`${budgetLedger.sourceType} = 'expense' AND ${expenseItems.id} = split_part(${budgetLedger.idempotencyKey}, ':', 3)::uuid`,
      )
      .where(and(eq(budgetLedger.projectId, projectId), eq(budgetLedger.entryType, "EXPENSE_RECOGNIZED")))
      .groupBy(sql`coalesce(${expenseItems.date}::text, ${budgetLedger.occurredAt}::text)`);
    for (const r of splitRows) {
      if ((r.d ?? "").slice(0, 10) < cut) presalesCostCents += r.s;
      else deliveryCostCents += r.s;
    }
  }
  const totalCostCents = presalesCostCents + deliveryCostCents; // = directCostCents（不重记不双算）

  // 人力成本：批准+锁定工时 × 成本率（按人价优先，其次按角色价）
  const entries = await db
    .select({ userId: timeEntries.userId, minutes: timeEntries.durationMinutes })
    .from(timeEntries)
    .innerJoin(timesheetPeriods, eq(timeEntries.periodId, timesheetPeriods.id))
    .where(
      and(
        eq(timeEntries.projectId, projectId),
        inArray(timesheetPeriods.status, ["approved", "locked"]),
      ),
    );
  let laborCostCents = 0;
  if (entries.length > 0) {
    const userIds = [...new Set(entries.map((e) => e.userId))];
    const rates = await db.select().from(finCostRates);
    const roleRows = await db.select().from(userRoles).where(inArray(userRoles.userId, userIds));
    const roleByUser = new Map(roleRows.map((r) => [r.userId, r.roleKey]));
    const byUser = new Map(rates.filter((r) => r.userId).map((r) => [r.userId as string, r.hourlyRateCents]));
    const byRole = new Map(rates.filter((r) => r.role).map((r) => [r.role as string, r.hourlyRateCents]));
    for (const e of entries) {
      const rate = byUser.get(e.userId) ?? byRole.get(roleByUser.get(e.userId) ?? "") ?? 0;
      laborCostCents += Math.round((e.minutes / 60) * rate);
    }
  }

  const grossMarginCents = receivedCents - directCostCents - laborCostCents;
  const grossMarginOnContractCents = revenueCents - directCostCents - laborCostCents;
  return {
    projectId: project.id,
    code: project.code,
    name: project.name,
    revenueCents,
    receivedCents,
    arBalanceCents,
    directCostCents,
    laborCostCents,
    grossMarginCents,
    grossMarginOnContractCents,
    presalesCostCents,
    deliveryCostCents,
    totalCostCents,
  };
}

/** 全项目核算列表（轻量逐项目聚合；报表域同口径复用） */
export async function listProjectCostings(db: DbOrTx): Promise<ProjectCosting[]> {
  const all = await db.select({ id: projects.id }).from(projects).orderBy(projects.code);
  const out: ProjectCosting[] = [];
  for (const p of all) {
    const costing = await computeProjectCosting(db, p.id);
    if (costing) out.push(costing);
  }
  return out;
}
