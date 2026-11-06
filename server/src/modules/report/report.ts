import { and, eq, gte, lt, lte, ne, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import {
  budgetLedger,
  clients,
  crmContracts,
  crmOpportunities,
  expenseItems,
  expenseReports,
  finReceivables,
  orgUnits,
  paymentReceipts,
  projects,
  stages,
  tasks,
  users,
} from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { can, projectScopeFilter } from "../../services/access";
import { recordAudit } from "../../services/audit";
import { computeProjectCosting, listProjectCostings } from "../../services/fin/costing";
import { computeAging } from "../fin/fin";
import { canReadCrm, canSeeCrmAmounts } from "../crm/crm";
import { statsByProject, statsByUser } from "../time/stats";
import { saveUpload } from "../../services/file/service";
import { signDownloadToken } from "../../services/file/tokens";
import { CONFIG_KEY } from "@lexflow/shared";
import { systemConfig } from "../../db/schema";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * 报表中心（arch/12 §8/§11）：九张一期报表统一 {columns,rows,summaryCards}；
 * 口径只调 services 既有聚合（fin costing/台账/工时 stats/CRM 口径），禁止自写业务公式；
 * 行级按各数据域既有口径过滤（member 本人口径/partner 全局穿透）；
 * 导出走既有文件管道（file_objects source=report + HMAC 下载令牌 + 审计同事务）。
 */

export interface ReportFilter {
  from?: string;
  to?: string;
  projectId?: string;
  customerId?: string;
  orgUnitId?: string;
  view?: "person" | "project" | "department";
}

export interface ReportResult {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
  summaryCards: Array<{ key: string; label: string; value: number | string }>;
}

function notFound(): BusinessError {
  return new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "报表不存在或无权访问");
}

async function requireReportRead(db: DbOrTx, user: SessionUser): Promise<void> {
  const allowed = await can(db, user, "report.read", { type: "project", projectId: "" });
  if (!allowed) throw notFound();
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ===== 1. 项目健康度汇总（状态×健康度矩阵） ===== */

export async function reportProjectHealth(db: DbOrTx, user: SessionUser, f: ReportFilter): Promise<ReportResult> {
  await requireReportRead(db, user);
  const conditions: (SQL | undefined)[] = [reportProjectScope(user)];
  if (f.projectId) conditions.push(eq(projects.id, f.projectId));
  const rows = await db
    .select({ lifecycle: projects.lifecycleStatus, health: projects.healthStatus, n: sql<number>`count(*)::int` })
    .from(projects)
    .where(and(...conditions))
    .groupBy(projects.lifecycleStatus, projects.healthStatus);
  const lifecycles = ["preparing", "in_progress", "closed"];
  const healths = ["normal", "warning", "at_risk"];
  const count = (lc: string, h: string) => rows.find((r) => r.lifecycle === lc && r.health === h)?.n ?? 0;
  return {
    columns: [
      { key: "lifecycleStatus", label: "生命周期" },
      ...healths.map((h) => ({ key: h, label: h === "normal" ? "正常" : h === "warning" ? "预警" : "风险" })),
      { key: "total", label: "合计" },
    ],
    rows: lifecycles.map((lc) => ({
      lifecycleStatus: lc,
      ...Object.fromEntries(healths.map((h) => [h, count(lc, h)])),
      total: healths.reduce((s, h) => s + count(lc, h), 0),
    })),
    summaryCards: [
      { key: "total", label: "项目总数", value: rows.reduce((s, r) => s + r.n, 0) },
      { key: "warning", label: "预警", value: rows.filter((r) => r.health === "warning").reduce((s, r) => s + r.n, 0) },
      { key: "at_risk", label: "风险", value: rows.filter((r) => r.health === "at_risk").reduce((s, r) => s + r.n, 0) },
    ],
  };
}

/* ===== 2. 项目进度与延期明细 ===== */

export async function reportProjectDelay(db: DbOrTx, user: SessionUser, f: ReportFilter): Promise<ReportResult> {
  await requireReportRead(db, user);
  const today = todayStr();
  const conditions: (SQL | undefined)[] = [reportProjectScope(user)];
  if (f.projectId) conditions.push(eq(projects.id, f.projectId));
  const list = await db
    .select({ id: projects.id, code: projects.code, name: projects.name })
    .from(projects)
    .where(and(...conditions))
    .orderBy(projects.code);
  const rows = [];
  for (const p of list) {
    const [stageAgg] = await db
      .select({
        delayed: sql<number>`(count(*) filter (where ${stages.plannedEnd} < ${today} and ${stages.status} <> 'done'))::int`,
        maxDelay: sql<number>`coalesce(max((${today}::date - ${stages.plannedEnd})) filter (where ${stages.plannedEnd} < ${today} and ${stages.status} <> 'done'), 0)::int`,
      })
      .from(stages)
      .where(eq(stages.projectId, p.id));
    const [taskAgg] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.projectId, p.id), lt(tasks.plannedEnd, today), ne(tasks.status, "done"), ne(tasks.status, "cancelled")));
    rows.push({
      code: p.code,
      name: p.name,
      delayedStages: stageAgg?.delayed ?? 0,
      maxDelayDays: stageAgg?.maxDelay ?? 0,
      overdueTasks: taskAgg?.n ?? 0,
    });
  }
  rows.sort((a, b) => b.maxDelayDays - a.maxDelayDays || b.overdueTasks - a.overdueTasks);
  return {
    columns: [
      { key: "code", label: "项目编号" },
      { key: "name", label: "项目名称" },
      { key: "delayedStages", label: "延期阶段数" },
      { key: "maxDelayDays", label: "最大延期（天）" },
      { key: "overdueTasks", label: "逾期任务数" },
    ],
    rows,
    summaryCards: [
      { key: "projects", label: "项目数", value: rows.length },
      { key: "delayedStages", label: "延期阶段合计", value: rows.reduce((s, r) => s + (r.delayedStages as number), 0) },
      { key: "overdueTasks", label: "逾期任务合计", value: rows.reduce((s, r) => s + (r.overdueTasks as number), 0) },
    ],
  };
}

/* ===== 3. 项目收支核算表（直接调 9d costing 函数，禁自写公式） ===== */

export async function reportProjectCosting(db: DbOrTx, user: SessionUser, f: ReportFilter): Promise<ReportResult> {
  await requireReportRead(db, user);
  let items = await listProjectCostings(db);
  if (f.projectId) items = items.filter((c) => c.projectId === f.projectId);
  if (!canReadMoney(user)) {
    const visible = new Set(
      (await db.select({ id: projects.id }).from(projects).where(reportProjectScope(user))).map((p) => p.id),
    );
    items = items.filter((c) => visible.has(c.projectId));
  }
  void computeProjectCosting; // 单项目口径同函数（get 路径复用）
  const sum = (k: keyof (typeof items)[number]) => items.reduce((s, r) => s + (r[k] as number), 0);
  return {
    columns: [
      { key: "code", label: "项目编号" },
      { key: "name", label: "项目名称" },
      { key: "revenueCents", label: "收入（签约口径）" },
      { key: "receivedCents", label: "已回款（净额）" },
      { key: "arBalanceCents", label: "应收余额" },
      { key: "directCostCents", label: "直接成本" },
      { key: "laborCostCents", label: "人力成本" },
      { key: "grossMarginCents", label: "毛利（回款口径）" },
      { key: "grossMarginOnContractCents", label: "毛利（签约口径）" },
    ],
    rows: items.map((c) => ({ ...c })),
    summaryCards: [
      { key: "revenue", label: "收入合计", value: sum("revenueCents") },
      { key: "received", label: "已回款合计", value: sum("receivedCents") },
      { key: "ar", label: "应收余额合计", value: sum("arBalanceCents") },
      { key: "margin", label: "毛利合计（回款口径）", value: sum("grossMarginCents") },
    ],
  };
}

/* ===== 4. 收款账龄分析（复用 fin.computeAging 口径；客户维度） ===== */

function canReadMoney(user: SessionUser): boolean {
  return (
    user.globalRoles.includes("finance") ||
    user.globalRoles.includes("partner") ||
    user.globalRoles.includes("project_manager")
  );
}

/** 报表项目范围：finance/partner/PM 全量（域口径）；member 按项目可见集 */
function reportProjectScope(user: SessionUser): SQL {
  if (canReadMoney(user)) return sql`true`;
  return projectScopeFilter(user);
}

export async function reportReceivableAging(db: DbOrTx, user: SessionUser, f: ReportFilter): Promise<ReportResult> {
  await requireReportRead(db, user);
  if (!canReadMoney(user)) {
    return { columns: [], rows: [], summaryCards: [{ key: "note", label: "口径", value: "无财务可见权" }] };
  }
  const grace = Number(
    (
      await db.select().from(systemConfig).where(eq(systemConfig.key, CONFIG_KEY.FIN_AR_OVERDUE_GRACE_DAYS)).limit(1)
    )[0]?.valueJson as { days?: number } | undefined
  ) || 7;
  const conditions: (SQL | undefined)[] = [];
  if (f.customerId) conditions.push(eq(finReceivables.customerId, f.customerId));
  const list = await db
    .select({ receivable: finReceivables, customerName: clients.name })
    .from(finReceivables)
    .innerJoin(clients, eq(clients.id, finReceivables.customerId))
    .where(and(...conditions));
  const byCustomer = new Map<string, { name: string; buckets: Record<string, number>; total: number; overdue: number }>();
  for (const { receivable: r, customerName } of list) {
    const aging = computeAging(r.dueDate, grace);
    const entry = byCustomer.get(r.customerId) ?? { name: customerName, buckets: { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 }, total: 0, overdue: 0 };
    entry.total += r.amountCents;
    if (aging.agingBucket) {
      entry.buckets[aging.agingBucket] += r.amountCents;
      entry.overdue += r.amountCents;
    }
    byCustomer.set(r.customerId, entry);
  }
  const rows = [...byCustomer.entries()].map(([customerId, v]) => ({ customerId, customer: v.name, ...v.buckets, total: v.total, overdueTotal: v.overdue }));
  rows.sort((a, b) => (b.overdueTotal as number) - (a.overdueTotal as number));
  return {
    columns: [
      { key: "customer", label: "客户" },
      { key: "0-30", label: "0-30 天" },
      { key: "31-60", label: "31-60 天" },
      { key: "61-90", label: "61-90 天" },
      { key: "90+", label: "90+ 天" },
      { key: "total", label: "应收合计" },
      { key: "overdueTotal", label: "逾期合计" },
    ],
    rows,
    summaryCards: [
      { key: "total", label: "应收总额", value: rows.reduce((s, r) => s + (r.total as number), 0) },
      { key: "overdue", label: "逾期总额", value: rows.reduce((s, r) => s + (r.overdueTotal as number), 0) },
    ],
  };
}

/* ===== 5. 费用类别分析（类别×月度；member 本人口径） ===== */

export async function reportExpenseCategory(db: DbOrTx, user: SessionUser, f: ReportFilter): Promise<ReportResult> {
  await requireReportRead(db, user);
  const from = f.from ?? addDays(todayStr(), -180);
  const to = f.to ?? todayStr();
  const memberOwn = !canReadMoney(user);
  const visibility: SQL = memberOwn
    ? eq(expenseReports.applicantId, user.id)
    : sql`true`; // finance/partner/PM 全量（费用域口径：partner 穿透、finance 全量）
  const rows = await db
    .select({
      category: expenseItems.category,
      month: sql<string>`to_char(${expenseItems.date}, 'YYYY-MM')`,
      total: sql<number>`coalesce(sum(${expenseItems.amountCents}), 0)::float8`,
      count: sql<number>`count(*)::int`,
    })
    .from(expenseItems)
    .innerJoin(expenseReports, eq(expenseItems.expenseReportId, expenseReports.id))
    .where(
      and(
        visibility,
        gte(expenseItems.date, from),
        lte(expenseItems.date, to),
        sql`${expenseReports.status} IN ('approved_pending_payment', 'paid')`,
      ),
    )
    .groupBy(expenseItems.category, sql`to_char(${expenseItems.date}, 'YYYY-MM')`)
    .orderBy(expenseItems.category);
  const byCategory = new Map<string, { months: Record<string, number>; total: number; count: number }>();
  for (const r of rows) {
    const entry = byCategory.get(r.category) ?? { months: {}, total: 0, count: 0 };
    entry.months[r.month] = (entry.months[r.month] ?? 0) + r.total;
    entry.total += r.total;
    entry.count += r.count;
    byCategory.set(r.category, entry);
  }
  const months = [...new Set(rows.map((r) => r.month))].sort();
  return {
    columns: [
      { key: "category", label: "费用类别" },
      ...months.map((m) => ({ key: m, label: m })),
      { key: "total", label: "合计" },
      { key: "count", label: "笔数" },
    ],
    rows: [...byCategory.entries()].map(([category, v]) => ({
      category,
      ...Object.fromEntries(months.map((m) => [m, v.months[m] ?? 0])),
      total: v.total,
      count: v.count,
    })),
    summaryCards: [
      { key: "total", label: "费用合计", value: rows.reduce((s, r) => s + r.total, 0) },
      { key: "count", label: "笔数", value: rows.reduce((s, r) => s + r.count, 0) },
    ],
  };
}

/* ===== 6. 月度收支汇总（收=registered 收款；支=EXPENSE_RECOGNIZED 实际额；净额） ===== */

export async function reportMonthlyCashflow(db: DbOrTx, user: SessionUser, f: ReportFilter): Promise<ReportResult> {
  await requireReportRead(db, user);
  if (!canReadMoney(user)) {
    return { columns: [], rows: [], summaryCards: [{ key: "note", label: "口径", value: "无财务可见权" }] };
  }
  const from = f.from ?? addDays(todayStr(), -180);
  const to = f.to ?? todayStr();
  const scopeProject = f.projectId ? eq(paymentReceipts.projectId, f.projectId) : undefined;
  const receiptRows = await db
    .select({ month: sql<string>`to_char(${paymentReceipts.receivedOn}, 'YYYY-MM')`, total: sql<number>`coalesce(sum(${paymentReceipts.amountCents}), 0)::float8` })
    .from(paymentReceipts)
    .where(and(eq(paymentReceipts.status, "registered"), gte(paymentReceipts.receivedOn, from), lte(paymentReceipts.receivedOn, to), scopeProject))
    .groupBy(sql`to_char(${paymentReceipts.receivedOn}, 'YYYY-MM')`);
  const ledgerProject = f.projectId ? eq(budgetLedger.projectId, f.projectId) : undefined;
  const spendRows = await db
    .select({ month: sql<string>`to_char(${budgetLedger.occurredAt}, 'YYYY-MM')`, total: sql<number>`coalesce(sum(${budgetLedger.actualDeltaCents}), 0)::float8` })
    .from(budgetLedger)
    .where(and(eq(budgetLedger.entryType, "EXPENSE_RECOGNIZED" as never), gte(budgetLedger.occurredAt, `${from}T00:00:00Z`), lte(budgetLedger.occurredAt, `${to}T23:59:59Z`), ledgerProject))
    .groupBy(sql`to_char(${budgetLedger.occurredAt}, 'YYYY-MM')`);
  const months = [...new Set([...receiptRows.map((r) => r.month), ...spendRows.map((r) => r.month)])].sort();
  const inMap = new Map(receiptRows.map((r) => [r.month, r.total]));
  const outMap = new Map(spendRows.map((r) => [r.month, r.total]));
  return {
    columns: [
      { key: "month", label: "月份" },
      { key: "income", label: "收（回款）" },
      { key: "expense", label: "支（确认实际）" },
      { key: "net", label: "净额" },
    ],
    rows: months.map((m) => {
      const income = inMap.get(m) ?? 0;
      const expense = outMap.get(m) ?? 0;
      return { month: m, income, expense, net: income - expense };
    }),
    summaryCards: [
      { key: "income", label: "收合计", value: months.reduce((s, m) => s + (inMap.get(m) ?? 0), 0) },
      { key: "expense", label: "支合计", value: months.reduce((s, m) => s + (outMap.get(m) ?? 0), 0) },
      { key: "net", label: "净额合计", value: months.reduce((s, m) => s + ((inMap.get(m) ?? 0) - (outMap.get(m) ?? 0)), 0) },
    ],
  };
}

/* ===== 7. 工时汇总（人/项目/部门三视角；复用 time stats 口径） ===== */

export async function reportTimeSummary(
  db: DbOrTx,
  user: SessionUser,
  f: ReportFilter & { view: "person" | "project" | "department" },
): Promise<ReportResult> {
  await requireReportRead(db, user);
  const base = { from: f.from, to: f.to, projectId: f.projectId, scopeAll: canReadMoney(user) };
  const person = await statsByUser(db, user, base);
  const toMinutes = (items: Array<{ minutes?: number; totalMinutes?: number }>) =>
    items.reduce((s, r) => s + (r.minutes ?? r.totalMinutes ?? 0), 0);
  if (f.view === "person") {
    const rows = person.items.map((r) => ({ name: r.name ?? r.key, minutes: r.minutes ?? 0 }));
    rows.sort((a, b) => b.minutes - a.minutes);
    return {
      columns: [
        { key: "name", label: "姓名" },
        { key: "minutes", label: "有效工时（分钟）" },
      ],
      rows,
      summaryCards: [{ key: "total", label: "合计分钟", value: toMinutes(person.items as never) }],
    };
  }
  if (f.view === "project") {
    const byProject = await statsByProject(db, user, { from: f.from, to: f.to });
    const rows = byProject.items.map((r) => ({ project: r.name ?? r.key, minutes: r.minutes ?? 0 }));
    rows.sort((a, b) => b.minutes - a.minutes);
    return {
      columns: [
        { key: "project", label: "项目" },
        { key: "minutes", label: "有效工时（分钟）" },
      ],
      rows,
      summaryCards: [{ key: "total", label: "合计分钟", value: toMinutes(byProject.items as never) }],
    };
  }
  // department：人视角按部门归并
  const unitByUser = new Map((await db.select({ id: users.id, unitId: users.orgUnitId }).from(users)).map((u) => [u.id, u.unitId]));
  const unitNames = new Map((await db.select({ id: orgUnits.id, name: orgUnits.name }).from(orgUnits)).map((u) => [u.id, u.name]));
  const byUnit = new Map<string, number>();
  for (const r of person.items) {
    const unitId = unitByUser.get(r.key ?? "") ?? null;
    const name = unitId ? (unitNames.get(unitId) ?? "未分配") : "未分配";
    byUnit.set(name, (byUnit.get(name) ?? 0) + (r.minutes ?? 0));
  }
  const rows = [...byUnit.entries()].map(([department, minutes]) => ({ department, minutes }));
  rows.sort((a, b) => b.minutes - a.minutes);
  return {
    columns: [
      { key: "department", label: "部门" },
      { key: "minutes", label: "有效工时（分钟）" },
    ],
    rows,
    summaryCards: [{ key: "total", label: "合计分钟", value: rows.reduce((s, r) => s + r.minutes, 0) }],
  };
}

/* ===== 8. 人员利用率（批准+锁定工时 / 可用工时=工作日×8h） ===== */

export async function reportUtilization(db: DbOrTx, user: SessionUser, f: ReportFilter): Promise<ReportResult> {
  void f.projectId;
  await requireReportRead(db, user);
  const from = f.from ?? addDays(todayStr(), -29);
  const to = f.to ?? todayStr();
  const person = await statsByUser(db, user, { from, to, projectId: f.projectId, scopeAll: canReadMoney(user) });
  let workdays = 0;
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) workdays++;
  }
  const available = workdays * 480;
  const rows = person.items.map((r) => {
    const minutes = r.minutes ?? 0;
    return { name: r.name ?? r.key, minutes, availableMinutes: available, utilization: available > 0 ? Math.round((minutes / available) * 1000) / 10 : 0 };
  });
  rows.sort((a, b) => b.utilization - a.utilization);
  return {
    columns: [
      { key: "name", label: "姓名" },
      { key: "minutes", label: "批准工时（分钟）" },
      { key: "availableMinutes", label: "可用工时（分钟）" },
      { key: "utilization", label: "利用率（%）" },
    ],
    rows,
    summaryCards: [
      { key: "avg", label: "平均利用率（%）", value: rows.length ? Math.round((rows.reduce((s, r) => s + r.utilization, 0) / rows.length) * 10) / 10 : 0 },
    ],
  };
}

/* ===== 9. 商机漏斗（阶段×数量×金额；CRM 口径：无 crm.read → 空；金额对无 fin.read 剔除） ===== */

export async function reportOpportunityFunnel(db: DbOrTx, user: SessionUser, f: ReportFilter): Promise<ReportResult> {
  await requireReportRead(db, user);
  const showAmount = canSeeCrmAmounts(user);
  if (!canReadCrm(user)) {
    return { columns: [], rows: [], summaryCards: [{ key: "note", label: "口径", value: "无 CRM 可见权" }] };
  }
  const conditions: (SQL | undefined)[] = [];
  if (f.customerId) conditions.push(eq(crmOpportunities.customerId, f.customerId));
  if (f.from) conditions.push(gte(crmOpportunities.createdAt, `${f.from}T00:00:00Z`));
  if (f.to) conditions.push(lte(crmOpportunities.createdAt, `${f.to}T23:59:59Z`));
  const rows = await db
    .select({
      stage: crmOpportunities.stage,
      count: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${crmOpportunities.expectedAmountCents}), 0)::float8`,
    })
    .from(crmOpportunities)
    .where(and(...conditions))
    .groupBy(crmOpportunities.stage);
  const order = ["initial", "needs", "proposal", "negotiation", "won", "lost"];
  const label: Record<string, string> = { initial: "初步", needs: "需求", proposal: "方案", negotiation: "谈判", won: "赢单", lost: "输单" };
  const sorted = order.map((s) => ({ stage: s, count: rows.find((r) => r.stage === s)?.count ?? 0, amount: rows.find((r) => r.stage === s)?.amount ?? 0 }));
  return {
    columns: [
      { key: "stage", label: "阶段" },
      { key: "count", label: "数量" },
      ...(showAmount ? [{ key: "amount", label: "预计金额（分）" }] : []),
    ],
    rows: sorted.map((r) => ({ stage: label[r.stage] ?? r.stage, count: r.count, ...(showAmount ? { amount: r.amount } : {}) })),
    summaryCards: [
      { key: "open", label: "进行中商机", value: sorted.filter((r) => !["won", "lost"].includes(r.stage)).reduce((s, r) => s + r.count, 0) },
      { key: "won", label: "赢单", value: sorted.find((r) => r.stage === "won")?.count ?? 0 },
      ...(showAmount ? [{ key: "openAmount", label: "进行中金额（分）", value: sorted.filter((r) => !["won", "lost"].includes(r.stage)).reduce((s, r) => s + r.amount, 0) }] : []),
    ],
  };
}

/* ===== 10. 客户贡献排行（合同额/回款额 Top；CRM 口径同漏斗） ===== */

export async function reportCustomerContribution(db: DbOrTx, user: SessionUser, f: ReportFilter): Promise<ReportResult> {
  await requireReportRead(db, user);
  void f; // 客户贡献暂不按区间过滤（合同额/回款额为累计口径）
  const showAmount = canSeeCrmAmounts(user);
  if (!canReadCrm(user)) {
    return { columns: [], rows: [], summaryCards: [{ key: "note", label: "口径", value: "无 CRM 可见权" }] };
  }
  const contractRows = await db
    .select({ customerId: crmContracts.customerId, sum: sql<number>`coalesce(sum(${crmContracts.amountCents}) filter (where ${crmContracts.status} <> 'terminated'), 0)::float8` })
    .from(crmContracts)
    .groupBy(crmContracts.customerId);
  const receiptRows = await db
    .select({
      clientId: paymentReceipts.clientId,
      net: sql<number>`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'registered'), 0)::float8
        - coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'voided'), 0)::float8`,
    })
    .from(paymentReceipts)
    .groupBy(paymentReceipts.clientId);
  const receiptsByClient = new Map(receiptRows.map((r) => [r.clientId, r.net]));
  const names = new Map((await db.select({ id: clients.id, name: clients.name }).from(clients)).map((c) => [c.id, c.name]));
  const rows = contractRows.map((r) => ({
    customerId: r.customerId,
    customer: names.get(r.customerId) ?? r.customerId,
    contractSum: r.sum,
    receivedSum: receiptsByClient.get(r.customerId) ?? 0,
  }));
  rows.sort((a, b) => b.contractSum - a.contractSum);
  const top = rows.slice(0, 10);
  return {
    columns: [
      { key: "customer", label: "客户" },
      ...(showAmount ? [
        { key: "contractSum", label: "合同额（分）" },
        { key: "receivedSum", label: "回款额（净额，分）" },
      ] : []),
    ],
    rows: top.map((r) => ({ customer: r.customer, ...(showAmount ? { contractSum: r.contractSum, receivedSum: r.receivedSum } : {}) })),
    summaryCards: showAmount
      ? [
          { key: "contractSum", label: "Top10 合同额", value: top.reduce((s, r) => s + r.contractSum, 0) },
          { key: "receivedSum", label: "Top10 回款额", value: top.reduce((s, r) => s + r.receivedSum, 0) },
        ]
      : [],
  };
}

/* ===== 导出：CSV → file_objects(source=report) + HMAC 下载令牌 + 审计同事务 ===== */

export const REPORT_BUILDERS: Record<string, (db: DbOrTx, user: SessionUser, f: ReportFilter) => Promise<ReportResult>> = {
  project_health: reportProjectHealth,
  project_delay: reportProjectDelay,
  project_costing: reportProjectCosting,
  receivable_aging: reportReceivableAging,
  expense_category: reportExpenseCategory,
  monthly_cashflow: reportMonthlyCashflow,
  time_summary: (db, user, f) => reportTimeSummary(db, user, { ...f, view: f.view ?? "person" }),
  utilization: reportUtilization,
  opportunity_funnel: reportOpportunityFunnel,
  customer_contribution: reportCustomerContribution,
};

export async function runReport(db: DbOrTx, user: SessionUser, key: string, filter: ReportFilter): Promise<ReportResult> {
  const builder = REPORT_BUILDERS[key];
  if (!builder) throw notFound();
  return builder(db, user, filter);
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

export async function exportReportCsv(
  db: DbOrTx,
  user: SessionUser,
  input: { key: string; filter: ReportFilter; idempotencyKey?: string | null },
  ip: string | null,
  sessionId: string | null,
) {
  const allowed = await can(db, user, "report.export", { type: "project", projectId: "" });
  if (!allowed) throw notFound();
  const result = await runReport(db, user, input.key, input.filter);
  const header = result.columns.map((c) => csvEscape(c.label)).join(",");
  const lines = result.rows.map((r) => result.columns.map((c) => csvEscape(r[c.key])).join(","));
  const csv = `﻿${header}\n${lines.join("\n")}`;
  const filename = `report-${input.key}-${todayStr().replace(/-/g, "")}.csv`;
  const saved = await saveUpload(db, {
    data: new TextEncoder().encode(csv),
    filename,
    declaredMime: "text/csv",
    sourceType: "report",
    sourceId: null, // file_objects.source_id 为 uuid 列；报表 key 溯源走审计行快照（afterJson.key/filter）
    businessDate: todayStr(),
    uploadedBy: user.id,
    ip,
    sessionId,
    idempotencyKey: input.idempotencyKey ?? null,
  });
  const token = signDownloadToken(saved.fileVersionId);
  await recordAudit(db, {
    actorId: user.id,
    sessionId,
    action: "report.export",
    targetType: "report",
    targetId: null, // audit_events.target_id 为 uuid 列；报表 key 与筛选快照走 afterJson
    result: "success",
    afterJson: { key: input.key, filter: input.filter, rows: result.rows.length, fileVersionId: saved.fileVersionId },
    ip,
  });
  return {
    key: input.key,
    rowCount: result.rows.length,
    fileObjectId: saved.fileObjectId,
    fileVersionId: saved.fileVersionId,
    downloadPath: `/files/${saved.fileVersionId}/download?token=${token}`,
  };
}
