import type { DomainKey } from "../../lib/icons";
import { REPORT_META_BY_KEY } from "../../pages/reports/meta";

/**
 * 路由 → 工作区页签元数据（arch/12 §15：路由级开签、同路由复用激活不重复开）。
 * 有序规则：先特殊后通配；项目空间全子路径归一签（内部 14 页签嵌套不动）。
 */

export interface TabMeta {
  key: string;
  title: string;
  domain: DomainKey;
  /** 标题由页面数据回填（项目空间=项目名），路由切换不覆盖 */
  dynamicTitle?: boolean;
}

const R = (pattern: RegExp, key: string, title: string, domain: DomainKey, dynamicTitle = false): [RegExp, TabMeta] => [
  pattern,
  dynamicTitle ? { key, title, domain, dynamicTitle } : { key, title, domain },
];

const RULES: Array<[RegExp, TabMeta]> = [
  [/^\/(cockpit)?$/, { key: "cockpit", title: "驾驶舱", domain: "home" }],
  R(/^\/workbench$/, "workbench", "我的工作台", "notification"),
  R(/^\/approvals$/, "approvals", "审批中心", "approval"),
  R(/^\/admin\/flows\/[^/]+$/, "flow-designer", "审批流设计器", "settings"),
  R(/^\/flows\/p\/[^/]+\/[^/]+$/, "flow-designer-p", "项目流程设计器", "settings"),
  R(/^\/admin\/org\/company$/, "org-company", "公司信息", "org"),
  R(/^\/admin\/org\/units$/, "org-units", "部门维护", "org"),
  R(/^\/admin\/org\/members$/, "org-members", "员工信息", "org"),
  R(/^\/admin$/, "admin", "配置中心", "settings"),
  [/^\/requests\/([^/]+)$/, { key: "request-detail", title: "申请单详情", domain: "approval" }],
  R(/^\/requests$/, "requests", "通用申请单", "approval"),
  R(/^\/settings$/, "settings", "设置", "settings"),
  R(/^\/notifications$/, "notifications", "通知中心", "notification"),
  R(/^\/crm\/leads$/, "crm-leads", "线索池", "lead"),
  [/^\/crm\/customers\/([^/]+)$/, { key: "customer-detail", title: "客户详情", domain: "customer" }],
  R(/^\/crm\/customers$/, "crm-customers", "客户列表", "customer"),
  R(/^\/crm\/opportunities$/, "crm-opportunities", "商机管理", "opportunity"),
  R(/^\/crm\/contracts$/, "crm-contracts", "合同管理", "contract"),
  R(/^\/crm\/followups$/, "crm-followups", "跟进记录", "customer"),
  R(/^\/fin\/receivables$/, "fin-receivables", "应收管理", "finance"),
  R(/^\/fin\/invoices$/, "fin-invoices", "发票管理", "finance"),
  R(/^\/fin\/project-costing$/, "fin-costing", "项目核算", "finance"),
  [/^\/reports\/([^/]+)$/, { key: "report-detail", title: "报表", domain: "report" }],
  R(/^\/reports$/, "reports", "报表工作台", "report"),
  R(/^\/operations\/receipts$/, "receipts", "收款台账", "finance"),
  R(/^\/operations\/budget$/, "budget", "预算经费", "finance"),
  R(/^\/operations\/expenses$/, "expenses", "费用中心", "expense"),
  [/^\/operations\/funding\/([^/]+)$/, { key: "funding-detail", title: "经费申请详情", domain: "finance" }],
  R(/^\/operations\/funding\/new$/, "funding-new", "经费申请", "finance"),
  R(/^\/operations\/time$/, "time", "工时中心", "time"),
  R(/^\/projects\/new$/, "project-new", "新建项目", "project"),
  [/^\/projects\/([^/]+)(?:\/.*)?$/, { key: "project-space", title: "项目空间", domain: "project", dynamicTitle: true }],
  R(/^\/projects$/, "projects", "项目全周期", "project"),
  R(/^\/search$/, "search", "全局搜索", "report"),
  R(/^\/coming-soon$/, "coming-soon", "即将上线", "settings"),
  R(/^\/meetings\/new$/, "meeting-new", "新建会议", "meeting"),
  [/^\/meetings\/([^/]+)$/, { key: "meeting-detail", title: "会议详情", domain: "meeting" }],
  R(/^\/meetings$/, "meetings", "会议中心", "meeting"),
  R(/^\/travel\/new$/, "travel-new", "新建出差", "travel"),
  [/^\/travel\/([^/]+)$/, { key: "travel-detail", title: "出差详情", domain: "travel" }],
  R(/^\/travel$/, "travel", "出差中心", "travel"),
  R(/^\/quality$/, "quality", "质量中心", "quality"),
  R(/^\/decisions\/new$/, "decision-new", "新建决策单", "decision"),
  R(/^\/decisions$/, "decisions", "决策中心", "decision"),
  R(/^\/archive$/, "archive", "档案中心", "archive"),
  R(/^\/audit$/, "audit", "审计日志", "archive"),
  R(/^\/expenses\/new$/, "expense-new", "新建报销", "expense"),
  [/^\/expenses\/([^/]+)$/, { key: "expense-detail", title: "报销详情", domain: "expense" }],
];

/** 通配兜底：未登记路由按路径开签（保证任何 /* 页面都有签可挂） */
const FALLBACK: TabMeta = { key: "fallback", title: "页面", domain: "settings" };

export function tabMeta(pathname: string): TabMeta {
  for (const [pattern, meta] of RULES) {
    if (pattern.test(pathname)) {
      if (meta.key === "report-detail") {
        const key = pathname.split("/")[2] ?? "";
        const m = REPORT_META_BY_KEY.get(key as never);
        return { key: `report:${key}`, title: m?.title ?? "报表", domain: "report" };
      }
      if (meta.key === "project-space") {
        const id = pathname.split("/")[2] ?? "";
        return { key: `project:${id}`, title: "项目空间", domain: "project", dynamicTitle: true };
      }
      if (meta.key === "request-detail") {
        const id = pathname.split("/")[2] ?? "";
        return { key: `request:${id}`, title: "申请单详情", domain: "approval" };
      }
      if (meta.key === "meeting-detail") return { ...meta, key: `meeting:${pathname.split("/")[2]}` };
      if (meta.key === "travel-detail") return { ...meta, key: `travel:${pathname.split("/")[2]}` };
      if (meta.key === "funding-detail") return { ...meta, key: `funding:${pathname.split("/")[2]}` };
      if (meta.key === "expense-detail") return { ...meta, key: `expense:${pathname.split("/")[2]}` };
      if (meta.key === "customer-detail") return { ...meta, key: `customer:${pathname.split("/")[2]}` };
      return meta;
    }
  }
  return { ...FALLBACK, key: `page:${pathname}` };
}
