/** 迭代 9a 新 IA 导航树（arch/12 §2.1 逐字；级联气泡 §2.2）；占位项走 /coming-soon */

export interface NavLeaf {
  to: string;
  label: string;
  desc: string;
  /** 角色白名单；缺省全角色可见 */
  roles?: string[];
  /** §5 v2.1：创建类默认弹窗化——点叶子开弹窗（to 保留为深链直达）；缺省=导航 */
  dialog?: "funding-new";
}
export interface NavSection {
  name: string;
  items: NavLeaf[];
  /** 角色白名单（作用于整个二级分组） */
  roles?: string[];
}
export interface NavGroup {
  key: string;
  label: string;
  sections: NavSection[];
  roles?: string[];
}

/** CRM 域可见角色（arch/13 §3.1/§4：销售线六角色+partner/sysadmin；member/viewer/finance(合同前汇总口径) 等不渲染客户组明细入口）
 *  finance 合同激活后明细走合同链（fin 域），不进 CRM 列表；project_manager 全局短路由已收回。 */
const CRM_ROLES = ["sales", "sales_manager", "presales", "operations", "regional_vp", "ceo", "partner", "sysadmin"];

const CS = (domain: string, title: string, sub?: string) =>
  `/coming-soon?domain=${domain}&title=${encodeURIComponent(title)}${sub ? `&sub=${encodeURIComponent(sub)}` : ""}`;

export const NAV_TREE: NavGroup[] = [
  { key: "overview", label: "总览", sections: [
    { name: "", items: [
      { to: "/cockpit", label: "驾驶舱", desc: "2×2 四象限：问候日程卡/快捷入口/项目脉搏/待办清单" },
      { to: "/workbench", label: "我的工作台", desc: "我的待办与通知聚合" },
      { to: "/notifications", label: "通知中心", desc: "按类型分组折叠 + 展开更多" },
      { to: "/search", label: "全局搜索", desc: "分组结果 + 每类 ≤5" },
    ] },
  ] },
  { key: "crm", label: "客户", roles: CRM_ROLES, sections: [
    { name: "线索与商机", items: [
      { to: "/crm/leads", label: "线索池", desc: "T-A：筛选+表格+行尾动作；新建线索 F1" },
      { to: "/crm/opportunities", label: "商机管理", desc: "T-A 表格/看板切换，拖拽改阶段" },
      { to: "/crm/followups", label: "跟进记录", desc: "多态跟进时间线" },
    ] },
    { name: "客户与合同", items: [
      { to: "/crm/customers", label: "客户列表", desc: "T-A：级别徽标+在管项目数+合同额+应收余额" },
      { to: "/crm/customers", label: "客户详情", desc: "T-B：概况/联系人/商机/合同/项目/往来文件" },
      { to: "/crm/contracts", label: "合同管理", desc: "T-A+行内回款进度条；详情 F2 抽屉含付款计划" },
    ] },
  ] },
  { key: "project", label: "项目", sections: [
    { name: "", items: [
      { to: "/projects", label: "项目全周期", desc: "T-A 列表工作台" },
      { to: "/projects/new", label: "新建项目", desc: "F4 分步 Stepper" },
      { to: CS("project", "项目模板", "既有 /admin 模板页签迁入"), label: "项目模板", desc: "模板库管理" },
      { to: "/projects", label: "项目空间", desc: "T-B：14 页签沿用" },
    ] },
  ] },
  { key: "collab", label: "协同", sections: [
    { name: "会议与出差", items: [
      { to: "/meetings", label: "会议", desc: "会议中心" },
      { to: "/travel", label: "出差", desc: "出差中心" },
    ] },
    { name: "审议与质量", items: [
      { to: "/approvals", label: "审批中心", desc: "待我审批 + 我申请的" },
      { to: "/decisions", label: "决策", desc: "决策中心" },
      { to: "/quality", label: "质量", desc: "质量中心" },
      { to: CS("report", "周报"), label: "周报", desc: "项目空间页签入口 + 汇总" },
    ] },
  ] },
  { key: "ops", label: "经营", sections: [
    { name: "预算与费用", items: [
      { to: "/operations/budget", label: "预算经费", desc: "预算与经费" },
      { to: "/operations/expenses", label: "费用报销", desc: "费用中心；新建报销 F2 抽屉" },
      { to: "/operations/funding/new", label: "经费申请", desc: "经费申请链（默认弹窗，深链可直达）", dialog: "funding-new" },
    ] },
    { name: "收款与核算", items: [
      { to: "/operations/receipts", label: "收款台账", desc: "收款登记/冲正", roles: ["sysadmin", "partner", "project_manager", "quality_lead", "finance", "archivist"] }, // 9a-03 验收修复：迭代 8 RECEIPTS_ROLES 过滤在 9a 导航重写中丢失（红线：角色过滤不渲染）
      { to: "/fin/receivables", label: "应收管理", desc: "T-A：账龄分桶徽标+行内登记收款", roles: ["partner", "finance", "project_manager"] }, // 9d-03：fin.read=finance/partner/PM（member/sysadmin 服务端同形 404，入口按角色过滤）
      { to: "/fin/invoices", label: "发票管理", desc: "开具发票 F2 抽屉；红冲=voided+冲正", roles: ["partner", "finance", "project_manager"] },
      { to: "/fin/project-costing", label: "项目核算", desc: "T-C：收入三块/成本三块/毛利横条", roles: ["partner", "finance", "project_manager"] },
    ] },
    { name: "工时", items: [
      { to: "/operations/time", label: "工时中心", desc: "页级批量填报 + 快速填报 F1" },
    ] },
  ] },
  { key: "reports", label: "报表", sections: [ // 9e-02：report.read=登录全员（member 本人口径/空集域由服务端同形状返回），组不设角色过滤
    { name: "报表目录", items: [
      { to: "/reports", label: "报表工作台", desc: "T-C：四类目录树+说明卡（一期十张）" },
    ] },
    { name: "项目类", items: [
      { to: "/reports/project_health", label: "项目健康度汇总", desc: "健康度矩阵+延期分布" },
      { to: "/reports/project_delay", label: "项目进度与延期", desc: "延期明细+恢复检查点" },
      { to: "/reports/project_costing", label: "项目收支核算表", desc: "收入/成本/毛利三栏" },
    ] },
    { name: "财务类", items: [
      { to: "/reports/receivable_aging", label: "收款账龄分析", desc: "账龄分桶色阶+客户维度" },
      { to: "/reports/expense_category", label: "费用类别分析", desc: "类别 8 值×月度交叉" },
      { to: "/reports/monthly_cashflow", label: "月度收支汇总", desc: "月度收/支/净额趋势" },
    ] },
    { name: "人事工时类", items: [
      { to: "/reports/time_summary", label: "工时汇总", desc: "按人/项目/部门三视角页签" },
      { to: "/reports/utilization", label: "利用率分析", desc: "人员利用率（工作日×8h）" },
    ] },
    { name: "客户类", items: [
      { to: "/reports/opportunity_funnel", label: "商机漏斗", desc: "六阶段横向漏斗条" },
      { to: "/reports/customer_contribution", label: "客户贡献排行", desc: "贡献=合同额/回款 Top10" },
    ] },
  ] },
  { key: "office", label: "办公", sections: [
    { name: "", items: [
      { to: "/requests", label: "我的申请单", desc: "请假/用章/通用申请；自选审批人" },
      { to: "/requests", label: "申请单详情", desc: "流程节点图进度" },
    ] },
  ] },
  { key: "gov", label: "治理", sections: [
    { name: "档案与审计", items: [
      { to: "/archive", label: "档案总库", desc: "档案中心" },
      { to: "/audit", label: "权限审计", desc: "审计日志", roles: ["sysadmin", "partner"] },
    ] },
    { name: "组织管理", roles: ["sysadmin"], items: [
      { to: "/admin/org/company", label: "公司信息", desc: "单记录：开票抬头引用" },
      { to: "/admin/org/units", label: "部门维护", desc: "T-D：部门树+右侧详情" },
      { to: "/admin/org/members", label: "员工信息", desc: "T-A：员工名录；新建/编辑 F3" },
    ] },
    { name: "系统配置", roles: ["sysadmin"], items: [
      { to: "/admin", label: "审批流中心", desc: "系统级+项目内两区" },
      { to: CS("settings", "项目模板", "既有 /admin 模板页签"), label: "项目模板", desc: "模板库" },
      { to: CS("settings", "编号与字典", "既有 /admin 编号规则页签"), label: "编号与字典", desc: "编号规则+字典" },
      { to: CS("settings", "系统参数", "既有 /admin 系统参数页签"), label: "系统参数", desc: "白名单配置键" },
    ] },
  ] },
];

export function activeGroupKey(pathname: string): string | null {
  if (pathname.startsWith("/cockpit") || pathname.startsWith("/workbench") || pathname.startsWith("/notifications") || pathname.startsWith("/search")) return "overview";
  if (pathname.startsWith("/coming-soon") && pathname.includes("domain=lead")) return "crm";
  if (pathname.startsWith("/projects")) return "project";
  if (["/meetings", "/travel", "/approvals", "/decisions", "/quality"].some((p) => pathname.startsWith(p))) return "collab";
  if (pathname.startsWith("/operations") || pathname.startsWith("/receipts")) return "ops";
  if (pathname.startsWith("/coming-soon") && pathname.includes("domain=report")) return "reports";
  if (pathname.startsWith("/requests")) return "office";
  if (["/archive", "/audit", "/admin", "/settings"].some((p) => pathname.startsWith(p)) || (pathname.startsWith("/coming-soon") && (pathname.includes("domain=org") || pathname.includes("domain=settings")))) return "gov";
  if (pathname.startsWith("/coming-soon")) return "reports";
  return null;
}

/**
 * §19.2 系统级功能页本地角色判定：菜单叶子（to 精确匹配，静态传入）的可见性语义
 * 与 CascadeNav 过滤一致——组/分段/叶子各级有 roles 时须至少命中其一；无 roles 级不限制。
 * 返回 true=可访问；false=无权限（路由层渲染 NoAccessPage「没有访问权限」）。
 */
export function canAccessMenuPath(to: string, globalRoles: string[]): boolean {
  for (const g of NAV_TREE) {
    for (const s of g.sections) {
      for (const i of s.items) {
        if (i.to !== to || i.to.startsWith("/coming-soon")) continue;
        const levels: (string[] | undefined)[] = [g.roles, s.roles, i.roles];
        return levels.every((rs) => !rs || rs.some((r) => globalRoles.includes(r)));
      }
    }
  }
  return true; // 菜单外路径不做本地判定（业务对象由服务端同形 404 把关）
}
