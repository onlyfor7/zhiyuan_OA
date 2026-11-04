/** 迭代 9a 原型导航树（arch/12 §2.1 功能树逐字；demo=原型内演示目标） */

export type DemoTarget =
  | { kind: "t-c" }        // T-C 驾驶舱三行固定 grid 样例
  | { kind: "t-a" }        // T-A 列表工作台样例（表内滚动+固定分页）
  | { kind: "forms" }      // 表单四范式样例页
  | { kind: "token" }      // 密度 token 表
  | { kind: "micro" }      // 微交互 M1–M7 样例页
  | { kind: "placeholder"; domain: string; note: string }; // 新域/既有页占位卡

export interface NavLeaf {
  route: string;
  name: string;
  desc: string;
  roles?: string[];
  demo: DemoTarget;
}
export interface NavSection {
  name: string;
  items: NavLeaf[];
  /** 角色白名单（作用于整个二级分组）；缺省全角色 */
  roles?: string[];
}
export interface NavGroup {
  key: string;
  label: string;
  sections: NavSection[];
  /** 角色白名单（作用于整个一级组）；缺省全角色 */
  roles?: string[];
}

export const NAV_TREE: NavGroup[] = [
  { key: "overview", label: "总览", sections: [
    { name: "", items: [
      { route: "/cockpit", name: "驾驶舱", desc: "固定三行 grid：问候+指标带 / 脉搏+待办 / 治理与快捷入口", demo: { kind: "t-c" } },
      { route: "/workbench", name: "我的工作台", desc: "我的待办与通知聚合（沿用既有）", demo: { kind: "placeholder", domain: "总览", note: "既有 /workbench 页，9a 全量接入时套 T-C 模板。" } },
      { route: "/notifications", name: "通知中心", desc: "按类型分组折叠 + 展开更多", demo: { kind: "placeholder", domain: "总览", note: "既有 /notifications 页（G7 分组折叠已落地）。" } },
      { route: "/search", name: "全局搜索", desc: "分组结果 + 每类 ≤5", demo: { kind: "placeholder", domain: "总览", note: "既有 /search 页（O1 分组已落地）。" } },
    ] },
  ] },
  { key: "crm", label: "客户", roles: ["sysadmin", "partner", "finance", "project_manager", "quality_lead", "archivist"], sections: [
    { name: "线索与商机", items: [
      { route: "/crm/leads", name: "线索池", desc: "T-A：筛选+表格+行尾浮现动作；新建线索 F1", demo: { kind: "placeholder", domain: "CRM 域（9c）", note: "线索 lead→转化→客户+商机；状态机 new→contacted→qualified→converted/disqualified。" } },
      { route: "/crm/opportunities", name: "商机管理", desc: "T-A 表格/看板切换，拖拽改阶段", demo: { kind: "placeholder", domain: "CRM 域（9c）", note: "阶段机 initial→needs→proposal→negotiation→won/lost；赢单挂合同。" } },
      { route: "/crm/followups", name: "跟进记录", desc: "多态跟进时间线", demo: { kind: "placeholder", domain: "CRM 域（9c）", note: "跟进记录挂线索/商机/客户多态 target。" } },
    ] },
    { name: "客户与合同", items: [
      { route: "/crm/customers", name: "客户列表", desc: "T-A：级别徽标+在管项目数+合同额+应收余额", demo: { kind: "placeholder", domain: "CRM 域（9c）", note: "既有 clients 被吸收为 CRM 客户；详情 T-B 六页签。" } },
      { route: "/crm/customers/:id", name: "客户详情", desc: "T-B：概况/联系人/商机/合同/项目/往来文件", demo: { kind: "placeholder", domain: "CRM 域（9c）", note: "客户详情六页签，既有 clients/matters 语义并入。" } },
      { route: "/crm/contracts", name: "合同管理", desc: "T-A+行内回款进度条；详情 F2 抽屉含付款计划行", demo: { kind: "placeholder", domain: "CRM 域（9c）", note: "合同 draft→active→completed/terminated；付款计划与收款台账勾稽。" } },
    ] },
  ] },
  { key: "project", label: "项目", sections: [
    { name: "", items: [
      { route: "/projects", name: "项目全周期", desc: "T-A 列表工作台（模板迁移样例）", demo: { kind: "t-a" } },
      { route: "/projects/new", name: "新建项目", desc: "F4 分步 Stepper：基本→模板→成员→预算", demo: { kind: "forms" } },
      { route: "/projects/templates", name: "项目模板", desc: "模板库管理", demo: { kind: "placeholder", domain: "项目域（既有）", note: "既有 /admin 模板页签，迁入项目模板入口。" } },
      { route: "/projects/:id", name: "项目空间", desc: "T-B 详情页签：14 页签沿用", demo: { kind: "placeholder", domain: "项目域（既有）", note: "项目空间 14 页签套 T-B 模板，页签体内滚动。" } },
    ] },
  ] },
  { key: "collab", label: "协同", sections: [
    { name: "会议与出差", items: [
      { route: "/meetings", name: "会议", desc: "会议中心（既有）", demo: { kind: "placeholder", domain: "协同域（既有）", note: "既有 /meetings 列表套 T-A。" } },
      { route: "/travel", name: "出差", desc: "出差中心（既有）", demo: { kind: "placeholder", domain: "协同域（既有）", note: "既有 /travel 列表套 T-A。" } },
    ] },
    { name: "审议与质量", items: [
      { route: "/approvals", name: "审批中心", desc: "待我审批 + 我申请的（既有）", demo: { kind: "placeholder", domain: "协同域（既有）", note: "既有 /approvals 套 T-A 变体。" } },
      { route: "/decisions", name: "决策", desc: "决策中心（既有）", demo: { kind: "placeholder", domain: "协同域（既有）", note: "既有 /decisions 套 T-A。" } },
      { route: "/quality", name: "质量", desc: "质量中心（既有）", demo: { kind: "placeholder", domain: "协同域（既有）", note: "既有 /quality 套 T-A。" } },
      { route: "/projects/:id/reports", name: "周报", desc: "项目空间页签入口 + 汇总", demo: { kind: "placeholder", domain: "协同域（既有）", note: "周报为项目空间页签，入口在协同组。" } },
    ] },
  ] },
  { key: "ops", label: "经营", sections: [
    { name: "预算与费用", items: [
      { route: "/operations/budget", name: "预算经费", desc: "预算与经费（既有）", demo: { kind: "placeholder", domain: "经营域（既有）", note: "既有预算经费页套 T-A。" } },
      { route: "/operations/expenses", name: "费用报销", desc: "费用中心；新建报销 F2 抽屉样例", demo: { kind: "forms" } },
      { route: "/operations/funding", name: "经费申请", desc: "经费申请链（既有）", demo: { kind: "placeholder", domain: "经营域（既有）", note: "既有经费申请套 T-A。" } },
    ] },
    { name: "收款与核算", items: [
      { route: "/operations/receipts", name: "收款台账", desc: "收款登记/冲正（既有，被应收勾稽增强）", demo: { kind: "t-a" } },
      { route: "/fin/receivables", name: "应收管理", desc: "T-A：账龄分桶徽标+行内登记收款", roles: ["sysadmin", "partner", "finance", "project_manager"], demo: { kind: "placeholder", domain: "财务核算域（9d）", note: "应收单 open/partial/settled；账龄 0-30/31-60/61-90/90+ 分桶。" } },
      { route: "/fin/invoices", name: "发票管理", desc: "开具发票 F2 抽屉；红冲=voided+冲正行", roles: ["sysadmin", "partner", "finance"], demo: { kind: "placeholder", domain: "财务核算域（9d）", note: "发票 draft→issued→sent/voided；抬头引用公司信息。" } },
      { route: "/fin/project-costing", name: "项目核算", desc: "T-C：收入三块/成本三块/毛利横条", roles: ["sysadmin", "partner", "finance", "project_manager"], demo: { kind: "placeholder", domain: "财务核算域（9d）", note: "毛利=已回款−直接成本−人力成本（工时×成本率），公式冻结 §7.3。" } },
    ] },
    { name: "工时", items: [
      { route: "/operations/time", name: "工时中心", desc: "页级批量填报保留+快速填报 F1", demo: { kind: "placeholder", domain: "经营域（既有）", note: "既有工时中心保留页级；新增「快速填报」F1 弹窗入口。" } },
    ] },
  ] },
  { key: "reports", label: "报表", roles: ["sysadmin", "partner", "finance", "project_manager", "quality_lead", "archivist"], sections: [
    { name: "报表目录", items: [
      { route: "/reports", name: "报表工作台", desc: "T-C：左目录树+右侧说明卡；预定义目录+导出", demo: { kind: "placeholder", domain: "报表中心（9e）", note: "一期=预定义报表目录+筛选+导出（D2：自由 BI 二期评估）。" } },
    ] },
    { name: "项目类", items: [
      { route: "/reports/project-health", name: "项目健康度汇总", desc: "健康度矩阵+延期分布", demo: { kind: "placeholder", domain: "报表中心（9e）", note: "口径引用台账聚合服务，禁页面自写公式。" } },
      { route: "/reports/project-delay", name: "项目进度与延期", desc: "延期明细+恢复检查点", demo: { kind: "placeholder", domain: "报表中心（9e）", note: "延期口径与既有延期治理一致。" } },
      { route: "/reports/project-cost", name: "项目收支核算表", desc: "收入/成本/毛利三栏", demo: { kind: "placeholder", domain: "报表中心（9e）", note: "与项目核算公式勾稽（§7.3）。" } },
    ] },
    { name: "财务类", items: [
      { route: "/reports/ar-aging", name: "收款账龄分析", desc: "账龄分桶+客户维度", demo: { kind: "placeholder", domain: "报表中心（9e）", note: "应收账龄分桶口径。" } },
      { route: "/reports/expense-category", name: "费用类别分析", desc: "类别 8 值分布", demo: { kind: "placeholder", domain: "报表中心（9e）", note: "费用类别沿用共享枚举。" } },
      { route: "/reports/monthly-cash", name: "月度收支汇总", desc: "月度收/支/净额趋势", demo: { kind: "placeholder", domain: "报表中心（9e）", note: "收支=收款净额+费用核销口径。" } },
    ] },
    { name: "人事工时类", items: [
      { route: "/reports/time-summary", name: "工时汇总", desc: "按人/项目/部门三视角", demo: { kind: "placeholder", domain: "报表中心（9e）", note: "视角切换同口径。" } },
      { route: "/reports/utilization", name: "利用率分析", desc: "人员利用率（成本率折算）", demo: { kind: "placeholder", domain: "报表中心（9e）", note: "人力成本=批准工时×fin_cost_rates。" } },
    ] },
    { name: "客户类", items: [
      { route: "/reports/opportunity-funnel", name: "商机漏斗", desc: "五阶段转化", demo: { kind: "placeholder", domain: "报表中心（9e）", note: "阶段机口径（9c 落地后出数）。" } },
      { route: "/reports/customer-contribution", name: "客户贡献排行", desc: "贡献=合同额/回款", demo: { kind: "placeholder", domain: "报表中心（9e）", note: "CRM 客户贡献口径。" } },
    ] },
  ] },
  { key: "office", label: "办公", sections: [
    { name: "", items: [
      { route: "/requests", name: "我的申请单", desc: "请假/用章/通用申请；自选审批人沿用", demo: { kind: "t-a" } },
      { route: "/requests/:id", name: "申请单详情", desc: "流程节点图进度", demo: { kind: "placeholder", domain: "办公域（既有）", note: "既有申请单详情含 flowProgress 节点图。" } },
    ] },
  ] },
  { key: "gov", label: "治理", sections: [
    { name: "档案与审计", items: [
      { route: "/archive", name: "档案总库", desc: "档案中心（既有）", demo: { kind: "placeholder", domain: "治理域（既有）", note: "既有 /archive 套 T-A。" } },
      { route: "/audit", name: "权限审计", desc: "审计日志（既有）", roles: ["sysadmin", "partner"], demo: { kind: "placeholder", domain: "治理域（既有）", note: "既有 /audit 套 T-A。" } },
    ] },
    { name: "组织管理", roles: ["sysadmin"], items: [
      { route: "/admin/org/company", name: "公司信息", desc: "单记录：开票抬头/合同水印引用", demo: { kind: "placeholder", domain: "基础信息维护（9b）", note: "名称/信用代码/开户行；发票抬头引用源。" } },
      { route: "/admin/org/units", name: "部门维护", desc: "T-D：部门树+右侧详情", demo: { kind: "placeholder", domain: "基础信息维护（9b）", note: "org_units 树化（parent_id/sort）。" } },
      { route: "/admin/org/members", name: "员工信息", desc: "T-A：员工名录；新建/编辑 F3 多页签", demo: { kind: "placeholder", domain: "基础信息维护（9b）", note: "users 增 position/employee_no/joined_at。" } },
    ] },
    { name: "系统配置", roles: ["sysadmin"], items: [
      { route: "/admin", name: "审批流中心", desc: "系统级+项目内两区（既有）", demo: { kind: "placeholder", domain: "治理域（既有）", note: "既有 /admin 审批流页签（两区已落地）。" } },
      { route: "/admin/templates", name: "项目模板", desc: "模板库", demo: { kind: "placeholder", domain: "治理域（既有）", note: "既有模板页签。" } },
      { route: "/admin/codes", name: "编号与字典", desc: "编号规则+字典", demo: { kind: "placeholder", domain: "治理域（既有）", note: "既有编号规则页签。" } },
      { route: "/admin/params", name: "系统参数", desc: "白名单配置键", demo: { kind: "placeholder", domain: "治理域（既有）", note: "既有系统参数页签。" } },
    ] },
  ] },
];

export const PERSONA_LABEL: Record<string, string> = { sysadmin: "系统管理员", partner: "合伙人", member: "项目成员" };
