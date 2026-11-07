import { EXPENSE_CATEGORY_LABEL, LIFECYCLE_LABEL } from "../../lib/labels";
import { formatHours } from "../../lib/labels";
import { formatYuan } from "../../api/reference";
import type { ReportKey } from "../../api/reports";
import type { DomainKey } from "../../lib/icons";

/**
 * 报表中心目录（arch/12 §8.2 一期目录 + 9e-01 后端十 key 逐字对应）。
 * 口径只在 server services 一处——前端仅渲染 {columns,rows,summaryCards}，零自写公式。
 */

export type ReportCategory = "project" | "finance" | "time" | "customer";

export const REPORT_CATEGORIES: Array<{ key: ReportCategory; label: string; icon: DomainKey; desc: string }> = [
  { key: "project", label: "项目类", icon: "project", desc: "健康度矩阵 / 延期明细 / 收支核算" },
  { key: "finance", label: "财务类", icon: "finance", desc: "收款账龄 / 费用类别 / 月度收支" },
  { key: "time", label: "工时类", icon: "time", desc: "工时三视角 / 人员利用率" },
  { key: "customer", label: "客户类", icon: "customer", desc: "商机漏斗 / 客户贡献排行" },
];

export interface ReportMeta {
  key: ReportKey;
  title: string;
  eyebrow: string;
  desc: string;
  category: ReportCategory;
  /** 筛选条控件（日期区间/项目/客户/部门/三视角页签） */
  filters: { fromTo?: boolean; project?: boolean; customer?: boolean; orgUnit?: boolean; view?: boolean };
  /** 迷你图形态 */
  mini: "none" | "cashflow" | "funnel" | "hbars";
  /** 迷你图取值列（hbars：数值列 key） */
  miniValueKey?: string;
  /** 列头/指标卡文案映射（§4.6：分钟→小时显示等） */
  label?: (raw: string) => string;
  /** 单元格渲染 */
  cell: (key: string, value: unknown) => string;
  /** summaryCards 值渲染 */
  summary: (key: string, value: number | string) => string;
}

const num = (v: unknown) => (typeof v === "number" ? v.toLocaleString("zh-CN") : String(v ?? "—"));
const money = (v: unknown) => (typeof v === "number" ? `${formatYuan(v)} 元` : "—");
const raw = (v: unknown) => String(v ?? "—");
/** 分→元（报表列以分返回，label 标「（分）」者） */
const cents = money;
const pct = (v: unknown) => (typeof v === "number" ? `${v}%` : "—");

/** 金额列 key 集合（出参以分计） */
const moneyKeys = (...keys: string[]) => new Set(keys);

const COSTING_MONEY = moneyKeys(
  "revenueCents", "receivedCents", "arBalanceCents", "directCostCents", "laborCostCents",
  "grossMarginCents", "grossMarginOnContractCents",
);
const AGING_MONEY = moneyKeys("0-30", "31-60", "61-90", "90+", "total", "overdueTotal");
const CASHFLOW_MONEY = moneyKeys("income", "expense", "net");
const FUNNEL_MONEY = moneyKeys("amount");
const CONTRIB_MONEY = moneyKeys("contractSum", "receivedSum");
const EXPENSE_MONEY = (key: string) => /^\d{4}-\d{2}$/.test(key) || key === "total";

export const REPORT_META: Array<ReportMeta> = [
  {
    key: "project_health",
    title: "项目健康度汇总",
    eyebrow: "REPORTS · PROJECT HEALTH",
    desc: "生命周期×健康度矩阵（状态×健康 count 聚合）；预警/风险项目一眼定位。",
    category: "project",
    filters: { project: true },
    mini: "none",
    cell: (k, v) => (k === "lifecycleStatus" ? (LIFECYCLE_LABEL[v as keyof typeof LIFECYCLE_LABEL] ?? raw(v)) : num(v)),
    summary: (k, v) => num(v) + (k === "total" ? " 个" : " 个"),
  },
  {
    key: "project_delay",
    title: "项目进度与延期明细",
    eyebrow: "REPORTS · PROJECT DELAY",
    desc: "按项目列出延期阶段数/最大延期天数/逾期任务数（plan 实际轨口径），按延期降序。",
    category: "project",
    filters: { project: true },
    mini: "none",
    cell: (k, v) => (k === "maxDelayDays" && typeof v === "number" && v > 0 ? `${v} 天` : num(v)),
    summary: (k, v) => `${num(v)}${k === "projects" ? " 个" : ""}`,
  },
  {
    key: "project_costing",
    title: "项目收支核算表",
    eyebrow: "REPORTS · PROJECT COSTING",
    desc: "收入（签约）/已回款（净额）/应收余额/直接成本/人力成本/毛利双口径——直调 9d costing 同一函数，禁自写公式。",
    category: "project",
    filters: { project: true },
    mini: "none",
    cell: (k, v) => (COSTING_MONEY.has(k) ? cents(v) : raw(v)),
    summary: (k, v) => (["revenue", "received", "ar", "margin"].includes(k) ? cents(v) : num(v)),
  },
  {
    key: "receivable_aging",
    title: "收款账龄分析",
    eyebrow: "REPORTS · RECEIVABLE AGING",
    desc: "客户×四桶账龄（0-30/31-60/61-90/90+，宽限 7 天同 fin 配置）色阶表；逾期合计降序。",
    category: "finance",
    filters: { customer: true },
    mini: "none",
    cell: (k, v) => (AGING_MONEY.has(k) ? cents(v) : raw(v)),
    summary: (k, v) => (["total", "overdue"].includes(k) ? cents(v) : num(v)),
  },
  {
    key: "expense_category",
    title: "费用类别分析",
    eyebrow: "REPORTS · EXPENSE CATEGORY",
    desc: "费用类别×月度交叉表（approved_pending_payment+paid 口径）；member=本人口径。",
    category: "finance",
    filters: { fromTo: true },
    mini: "none",
    cell: (k, v) => (k === "category" ? (EXPENSE_CATEGORY_LABEL[v as string] ?? raw(v)) : EXPENSE_MONEY(k) ? cents(v) : num(v)),
    summary: (k, v) => (k === "total" ? cents(v) : num(v)),
  },
  {
    key: "monthly_cashflow",
    title: "月度收支汇总",
    eyebrow: "REPORTS · MONTHLY CASHFLOW",
    desc: "收=registered 回款、支=EXPENSE_RECOGNIZED 确认实际额、净额=收−支（台账同源口径）。",
    category: "finance",
    filters: { fromTo: true, project: true },
    mini: "cashflow",
    cell: (k, v) => (CASHFLOW_MONEY.has(k) ? cents(v) : raw(v)),
    summary: (k, v) => (["income", "expense", "net"].includes(k) ? cents(v) : num(v)),
  },
  {
    key: "time_summary",
    title: "工时汇总",
    eyebrow: "REPORTS · TIME SUMMARY",
    desc: "有效工时三视角页签切换：按人/按项目/按部门（复用 time.stats 口径，finance/partner 全量覆盖）。",
    category: "time",
    filters: { fromTo: true, project: true, view: true },
    mini: "hbars",
    miniValueKey: "minutes",
    label: (l) => l.replace(/（分钟）$/, "（小时）").replace("合计分钟", "合计工时"),
    cell: (k, v) => (k === "minutes" ? formatHours(Number(v)) : num(v)),
    summary: (_k, v) => formatHours(Number(v)),
  },
  {
    key: "utilization",
    title: "人员利用率",
    eyebrow: "REPORTS · UTILIZATION",
    desc: "批准+锁定工时 ÷ 可用工时（工作日×8h）；近 30 天默认区间。",
    category: "time",
    filters: { fromTo: true, project: true, orgUnit: true },
    mini: "hbars",
    miniValueKey: "utilization",
    label: (l) => l.replace(/（分钟）$/, "（小时）"),
    cell: (k, v) => (k === "utilization" ? pct(v) : k === "minutes" || k === "availableMinutes" ? formatHours(Number(v)) : num(v)),
    summary: (k, v) => (k === "avg" ? pct(v) : num(v)),
  },
  {
    key: "opportunity_funnel",
    title: "商机漏斗",
    eyebrow: "REPORTS · OPPORTUNITY FUNNEL",
    desc: "六阶段横向漏斗条（初步→需求→方案→谈判→赢单→输单）；金额列对无 fin.read 自动缺席。",
    category: "customer",
    filters: { fromTo: true, customer: true },
    mini: "funnel",
    miniValueKey: "count",
    cell: (k, v) => (FUNNEL_MONEY.has(k) ? cents(v) : num(v)),
    summary: (k, v) => (["openAmount"].includes(k) ? cents(v) : num(v)),
  },
  {
    key: "customer_contribution",
    title: "客户贡献排行",
    eyebrow: "REPORTS · CUSTOMER CONTRIBUTION",
    desc: "合同额/回款额（净额）Top10 排行；累计口径不按区间过滤。",
    category: "customer",
    filters: {},
    mini: "hbars",
    miniValueKey: "contractSum",
    cell: (k, v) => (CONTRIB_MONEY.has(k) ? cents(v) : raw(v)),
    summary: (k, v) => (["contractSum", "receivedSum"].includes(k) ? cents(v) : num(v)),
  },
];

export const REPORT_META_BY_KEY = new Map(REPORT_META.map((m) => [m.key, m]));
