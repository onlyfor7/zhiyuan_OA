import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";

import { CONFIG_KEY, ERROR_CODE } from "@lexflow/shared";

import {
  clients,
  companyProfile,
  crmContractPaymentPlans,
  crmContracts,
  finCostRates,
  finInvoices,
  finReceivables,
  paymentReceipts,
  systemConfig,
} from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { can } from "../../services/access";
import { recordAudit } from "../../services/audit";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor } from "../governance/util";

/**
 * 财务核算域（arch/12 §7）：应收（账龄分桶 computed + 自动生成幂等 + 收款勾稽写回）、
 * 发票（开具联动/红冲冲正行）、成本率（fin.manage）、项目核算（口径在 services/fin/costing 唯一处）。
 * 权限：fin.read=finance/partner/项目负责人（costing 本项目 manager 放行）；fin.manage=finance/partner；
 * member 财务域 404 同形（本人费用端点既有语义不破）。
 */

function notFound(): BusinessError {
  return new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "财务核算记录不存在或无权访问");
}

export async function requireFinRead(db: DbOrTx, user: SessionUser): Promise<void> {
  const allowed = await can(db, user, "fin.read", { type: "project", projectId: "" });
  if (!allowed) throw notFound();
}

export async function requireFinManage(db: DbOrTx, user: SessionUser): Promise<void> {
  const allowed = await can(db, user, "fin.manage", { type: "project", projectId: "" });
  if (!allowed) throw notFound();
}

async function readConfig<T>(db: DbOrTx, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(systemConfig).where(eq(systemConfig.key, key)).limit(1);
  return (row?.valueJson as T | undefined) ?? fallback;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ===== 应收 ===== */

export interface ReceivableItem {
  id: string;
  code: string;
  contractId: string;
  planId: string | null;
  customerId: string;
  customerName: string;
  amountCents: number;
  dueDate: string;
  status: string;
  source: string;
  rowVersion: number;
  /** computed（逾期不落库，arch/12 §7.2）：账龄分桶 0-30/31-60/61-90/90+；未到期 bucket=null */
  overdueDays: number | null;
  agingBucket: "0-30" | "31-60" | "61-90" | "90+" | null;
}

export function computeAging(dueDate: string, graceDays: number): { overdueDays: number | null; agingBucket: ReceivableItem["agingBucket"] } {
  const due = new Date(`${dueDate}T00:00:00Z`).getTime();
  const days = Math.floor((Date.now() - due) / 86_400_000);
  const overdueDays = days > graceDays ? days : null;
  if (overdueDays === null) return { overdueDays: null, agingBucket: null };
  if (days <= 30) return { overdueDays: days, agingBucket: "0-30" };
  if (days <= 60) return { overdueDays: days, agingBucket: "31-60" };
  if (days <= 90) return { overdueDays: days, agingBucket: "61-90" };
  return { overdueDays: days, agingBucket: "90+" };
}

export async function listReceivables(
  db: DbOrTx,
  user: SessionUser,
  input: { cursor?: string; limit: number; status?: string; customerId?: string },
) {
  await requireFinRead(db, user);
  const grace = Number((await readConfig<{ days?: number }>(db, CONFIG_KEY.FIN_AR_OVERDUE_GRACE_DAYS, { days: 7 })).days ?? 7);
  const conditions: (SQL | undefined)[] = [];
  if (input.status) conditions.push(eq(finReceivables.status, input.status as never));
  if (input.customerId) conditions.push(eq(finReceivables.customerId, input.customerId));
  conditions.push(cursorCondition(input.cursor, finReceivables.createdAt, finReceivables.id));
  const rows = await db
    .select({ receivable: finReceivables, customerName: clients.name })
    .from(finReceivables)
    .innerJoin(clients, eq(clients.id, finReceivables.customerId))
    .where(and(...conditions))
    .orderBy(asc(finReceivables.dueDate), desc(finReceivables.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const items: ReceivableItem[] = page.map(({ receivable: r, customerName }) => {
    const aging = computeAging(r.dueDate, grace);
    return {
      id: r.id, code: r.code, contractId: r.contractId, planId: r.planId,
      customerId: r.customerId, customerName, amountCents: r.amountCents,
      dueDate: r.dueDate, status: r.status, source: r.source, rowVersion: r.rowVersion,
      ...aging,
    };
  });
  return {
    items,
    graceDays: grace,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.receivable.createdAt, last.receivable.id) : null,
  };
}

/**
 * 应收自动生成（arch/12 §7.2，读 fin.ar.auto_generate 双开关；幂等：已存在应收的计划/合同跳过）。
 * 手工触发=全量扫描；与合同激活/计划到期的自动触发共用本函数（同事务由调用方承载）。
 */
export async function generateReceivables(db: DbOrTx, user: SessionUser, ip: string | null, sessionId: string | null) {
  await requireFinRead(db, user);
  const cfg = await readConfig<{ on_contract_active?: boolean; on_plan_due?: boolean }>(
    db,
    CONFIG_KEY.FIN_AR_AUTO_GENERATE,
    { on_contract_active: true, on_plan_due: true },
  );
  const today = todayStr();
  const existing = await db.select({ planId: finReceivables.planId, contractId: finReceivables.contractId }).from(finReceivables);
  const plansWithAr = new Set(existing.map((r) => r.planId).filter(Boolean));
  const contractsWithAr = new Set(existing.filter((r) => r.planId === null).map((r) => r.contractId));
  let created = 0;

  if (cfg.on_contract_active) {
    const activeContracts = await db
      .select()
      .from(crmContracts)
      .where(and(eq(crmContracts.status, "active"), sql`${crmContracts.matterId} IS NOT NULL`));
    for (const c of activeContracts) {
      if (contractsWithAr.has(c.id)) continue;
      await db.insert(finReceivables).values({
        code: await nextCode("AR", db),
        contractId: c.id,
        planId: null,
        customerId: c.customerId,
        amountCents: c.amountCents,
        dueDate: (c.signedAt ?? new Date().toISOString()).slice(0, 10),
        status: "open",
        source: "contract_active",
        createdBy: user.id,
        updatedBy: user.id,
      });
      created++;
    }
  }
  if (cfg.on_plan_due) {
    const duePlans = await db
      .select({ plan: crmContractPaymentPlans, contract: crmContracts })
      .from(crmContractPaymentPlans)
      .innerJoin(crmContracts, eq(crmContractPaymentPlans.contractId, crmContracts.id))
      .where(and(eq(crmContracts.status, "active"), sql`${crmContractPaymentPlans.dueDate} <= ${today}`));
    for (const { plan, contract } of duePlans) {
      if (plansWithAr.has(plan.id)) continue;
      await db.insert(finReceivables).values({
        code: await nextCode("AR", db),
        contractId: contract.id,
        planId: plan.id,
        customerId: contract.customerId,
        amountCents: plan.amountCents,
        dueDate: plan.dueDate,
        status: "open",
        source: "payment_plan",
        createdBy: user.id,
        updatedBy: user.id,
      });
      created++;
    }
  }
  await recordAudit(db, { actorId: user.id, sessionId, action: "fin.receivables.generate", targetType: "fin_receivable", targetId: null, result: "success", afterJson: { created }, ip });
  return { created };
}

/** 收款勾稽写回（与 9c 计划行写回同一事务链，由 crm.linkReceiptToPlan 调用）：重算应收状态 open/partial/settled */
export async function recomputeReceivableForPlan(db: DbOrTx, planId: string): Promise<void> {
  const [ar] = await db.select().from(finReceivables).where(eq(finReceivables.planId, planId)).limit(1);
  if (!ar) return;
  const [plan] = await db.select().from(crmContractPaymentPlans).where(eq(crmContractPaymentPlans.id, planId)).limit(1);
  const linked = plan?.receiptId
    ? await db
        .select({ amount: paymentReceipts.amountCents, status: paymentReceipts.status })
        .from(paymentReceipts)
        .where(eq(paymentReceipts.id, plan.receiptId))
        .limit(1)
    : [];
  const received = linked[0]?.status === "registered" ? linked[0].amount : 0;
  const status = received >= ar.amountCents ? "settled" : received > 0 ? "partial" : "open";
  if (status !== ar.status) {
    await db
      .update(finReceivables)
      .set({ status, updatedAt: new Date().toISOString(), rowVersion: sql`${finReceivables.rowVersion} + 1` })
      .where(eq(finReceivables.id, ar.id));
  }
}

/* ===== 发票 ===== */

async function loadInvoice(db: DbOrTx, id: string) {
  const [row] = await db.select().from(finInvoices).where(eq(finInvoices.id, id)).limit(1);
  if (!row) throw notFound();
  return row;
}

async function companyHeader(db: DbOrTx) {
  const [row] = await db.select().from(companyProfile).limit(1);
  return row ? { name: row.name, creditCode: row.creditCode } : null;
}

export async function listInvoices(
  db: DbOrTx,
  user: SessionUser,
  input: { cursor?: string; limit: number; status?: string; customerId?: string },
) {
  await requireFinRead(db, user);
  const conditions: (SQL | undefined)[] = [];
  if (input.status) conditions.push(eq(finInvoices.status, input.status as never));
  if (input.customerId) conditions.push(eq(finInvoices.customerId, input.customerId));
  conditions.push(cursorCondition(input.cursor, finInvoices.createdAt, finInvoices.id));
  const rows = await db
    .select()
    .from(finInvoices)
    .where(and(...conditions))
    .orderBy(desc(finInvoices.createdAt), desc(finInvoices.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/** 开具/起草发票：可联动应收带出金额（显式传 amountCents 优先，否则取应收额）；税率默认读 fin.invoice.default_tax_rate；抬头取 company_profile */
export async function createInvoice(
  db: DbOrTx,
  user: SessionUser,
  input: { customerId: string; contractId?: string | null; receivableId?: string | null; amountCents?: number; taxRate?: number },
  ip: string | null,
  sessionId: string | null,
) {
  await requireFinManage(db, user);
  const [customer] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, input.customerId)).limit(1);
  if (!customer) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "客户不存在", { customerId: ["客户不存在"] });
  let amountCents = input.amountCents ?? null;
  if (input.receivableId) {
    const [ar] = await db.select().from(finReceivables).where(eq(finReceivables.id, input.receivableId)).limit(1);
    if (!ar) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "应收不存在", { receivableId: ["应收不存在"] });
    amountCents ??= ar.amountCents;
  }
  if (!amountCents || amountCents <= 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "金额须为正整数（分）", { amountCents: ["金额须为正整数（分）"] });
  }
  const taxRate = input.taxRate ?? Number((await readConfig<{ percent?: number }>(db, CONFIG_KEY.FIN_INVOICE_DEFAULT_TAX_RATE, { percent: 0 })).percent ?? 0);
  const code = await nextCode("INV", db);
  const [row] = await db
    .insert(finInvoices)
    .values({
      code,
      customerId: input.customerId,
      contractId: input.contractId ?? null,
      receivableId: input.receivableId ?? null,
      amountCents,
      taxRate,
      status: "draft",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!row) throw new Error("发票插入失败");
  await recordAudit(db, { actorId: user.id, sessionId, action: "fin.invoices.create", targetType: "fin_invoice", targetId: row.id, result: "success", afterJson: { code, amountCents }, ip });
  return { invoice: row, company: await companyHeader(db) };
}

export async function issueInvoice(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number }, ip: string | null, sessionId: string | null) {
  await requireFinManage(db, user);
  const before = await loadInvoice(db, input.id);
  if (before.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可开具");
  const [updated] = await db
    .update(finInvoices)
    .set({ status: "issued", issuedAt: new Date().toISOString(), updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${finInvoices.rowVersion} + 1` })
    .where(and(eq(finInvoices.id, input.id), eq(finInvoices.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "发票已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "fin.invoices.issue", targetType: "fin_invoice", targetId: input.id, result: "success", afterJson: { issuedAt: updated.issuedAt }, ip });
  return { invoice: updated, company: await companyHeader(db) };
}

export async function markInvoiceSent(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number }, ip: string | null, sessionId: string | null) {
  await requireFinManage(db, user);
  const before = await loadInvoice(db, input.id);
  if (before.status !== "issued") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅已开具发票可登记寄送");
  const [updated] = await db
    .update(finInvoices)
    .set({ status: "sent", updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${finInvoices.rowVersion} + 1` })
    .where(and(eq(finInvoices.id, input.id), eq(finInvoices.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "发票已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "fin.invoices.markSent", targetType: "fin_invoice", targetId: input.id, result: "success", afterJson: { status: "sent" }, ip });
  return updated;
}

/** 红冲：issued/sent → voided + 冲正行（负数金额、同税率、voided）；draft 直接 voided 无冲正行 */
export async function voidInvoice(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number; reason: string }, ip: string | null, sessionId: string | null) {
  await requireFinManage(db, user);
  const before = await loadInvoice(db, input.id);
  if (before.status === "voided") return { invoice: before, reversal: null, replayed: true as const };
  if (!input.reason.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "红冲原因必填", { reason: ["红冲原因必填"] });
  const [updated] = await db
    .update(finInvoices)
    .set({ status: "voided", updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${finInvoices.rowVersion} + 1` })
    .where(and(eq(finInvoices.id, input.id), eq(finInvoices.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "发票已被他人修改，请刷新后重试");
  let reversal = null;
  if (before.status === "issued" || before.status === "sent") {
    const code = await nextCode("INV", db);
    const [row] = await db
      .insert(finInvoices)
      .values({
        code,
        customerId: before.customerId,
        contractId: before.contractId,
        receivableId: before.receivableId,
        amountCents: -before.amountCents,
        taxRate: before.taxRate,
        status: "voided",
        issuedAt: new Date().toISOString(),
        createdBy: user.id,
        updatedBy: user.id,
      })
      .returning();
    reversal = row ?? null;
  }
  await recordAudit(db, { actorId: user.id, sessionId, action: "fin.invoices.void", targetType: "fin_invoice", targetId: input.id, result: "success", afterJson: { reason: input.reason.trim(), reversalId: reversal?.id ?? null }, ip });
  return { invoice: updated, reversal, replayed: false as const };
}

/* ===== 成本率 ===== */

export async function listCostRates(db: DbOrTx, user: SessionUser) {
  await requireFinRead(db, user);
  const rows = await db.select().from(finCostRates).orderBy(asc(finCostRates.effectiveFrom), asc(finCostRates.role));
  return rows;
}

/** 按人/按角色成本率 upsert（同人同生效日或同角色同生效日已存在则更新；fin.manage 门） */
export async function upsertCostRate(
  db: DbOrTx,
  user: SessionUser,
  input: { userId?: string | null; role?: string | null; hourlyRateCents: number; effectiveFrom: string },
  ip: string | null,
  sessionId: string | null,
) {
  await requireFinManage(db, user);
  if ((input.userId && input.role) || (!input.userId && !input.role)) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "按人价与按角色价二选一", { role: ["按人价与按角色价二选一"] });
  }
  if (input.hourlyRateCents <= 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "成本率须为正整数（分/时）", { hourlyRateCents: ["成本率须为正整数（分/时）"] });
  const conditions = [
    eq(finCostRates.effectiveFrom, input.effectiveFrom),
    input.userId ? eq(finCostRates.userId, input.userId) : eq(finCostRates.role, input.role!),
  ];
  const [existing] = await db
    .select()
    .from(finCostRates)
    .where(and(...conditions))
    .limit(1);
  let row;
  if (existing) {
    [row] = await db
      .update(finCostRates)
      .set({ hourlyRateCents: input.hourlyRateCents, updatedBy: user.id, updatedAt: new Date().toISOString() })
      .where(eq(finCostRates.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(finCostRates)
      .values({
        userId: input.userId ?? null,
        role: input.role ?? null,
        hourlyRateCents: input.hourlyRateCents,
        effectiveFrom: input.effectiveFrom,
        createdBy: user.id,
        updatedBy: user.id,
      })
      .returning();
  }
  if (!row) throw new Error("成本率写入失败");
  await recordAudit(db, { actorId: user.id, sessionId, action: "fin.costRates.upsert", targetType: "fin_cost_rate", targetId: row.id, result: "success", afterJson: { userId: row.userId, role: row.role, hourlyRateCents: row.hourlyRateCents }, ip });
  return row;
}
