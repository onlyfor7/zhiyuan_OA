/** 迭代 7 新 IA 导航配置（arch/10 §1.1 逐字）与路由分组命中 */

export interface TopNavItem {
  to: string;
  label: string;
  /** 子串命中即视为该组当前（组内高亮） */
  match?: string;
  /** 角色白名单；缺省全角色可见 */
  roles?: string[];
}
export interface TopNavGroup {
  key: string;
  label: string;
  items: TopNavItem[];
}

/** member/viewer 不见收款台账（其余角色可见，服务端仍同形 404 兜底） */
export const RECEIPTS_ROLES = ["sysadmin", "partner", "project_manager", "quality_lead", "finance", "archivist"];

export function buildNavGroups(ganttTo: string): TopNavGroup[] {
  return [
    { key: "overview", label: "总览", items: [
      { to: "/cockpit", label: "驾驶舱", match: "/cockpit" },
      { to: "/workbench", label: "我的工作台", match: "/workbench" },
    ] },
    { key: "project", label: "项目", items: [
      { to: "/projects", label: "项目全周期", match: "/projects" },
      { to: ganttTo, label: "甘特计划", match: "/plan" },
    ] },
    { key: "collab", label: "协同", items: [
      { to: "/meetings", label: "会议中心", match: "/meetings" },
      { to: "/travel", label: "出差中心", match: "/travel" },
      { to: "/requests", label: "申请单", match: "/requests" },
    ] },
    { key: "ops", label: "经营", items: [
      { to: "/operations/time", label: "工时中心", match: "/operations/time" },
      { to: "/operations/budget", label: "预算管理", match: "/operations/budget" },
      { to: "/operations/expenses", label: "费用中心", match: "/operations/expenses" },
      { to: "/operations/receipts", label: "收款台账", match: "/operations/receipts", roles: RECEIPTS_ROLES },
      { to: "/approvals", label: "审批中心", match: "/approvals" },
    ] },
    { key: "gov", label: "治理", items: [
      { to: "/quality", label: "质量中心", match: "/quality" },
      { to: "/decisions", label: "决策中心", match: "/decisions" },
      { to: "/archive", label: "档案中心", match: "/archive" },
      { to: "/audit", label: "权限审计", match: "/audit", roles: ["sysadmin", "partner"] },
    ] },
  ];
}

export function activeGroupKey(pathname: string): string | null {
  if (pathname.startsWith("/cockpit") || pathname.startsWith("/workbench")) return "overview";
  if (pathname.startsWith("/projects")) return "project";
  if (pathname.startsWith("/meetings") || pathname.startsWith("/travel") || pathname.startsWith("/requests")) return "collab";
  if (pathname.startsWith("/operations") || pathname.startsWith("/approvals") || pathname.startsWith("/expenses")) return "ops";
  if (["/quality", "/decisions", "/archive", "/audit"].some((p) => pathname.startsWith(p))) return "gov";
  return null;
}
