/**
 * 迭代 6 原型棒静态示意数据（arch/09 结构对齐；仅 /preview/* 使用，非真实数据）。
 * 每页经 PreviewShell 固定徽标「原型预览 · 数据为静态示意」明示。
 */

export const PREVIEW_BADGE = "原型预览 · 数据为静态示意";

/* —— B 域：用户与组织 —— */
export interface PreviewUser {
  id: string;
  name: string;
  email: string;
  orgUnit: string;
  globalRoles: string[];
  confidentialityCap: string;
  status: "active" | "disabled";
}
export const previewUsers: PreviewUser[] = [
  { id: "u-pm", name: "陈立", email: "pm@lexflow.demo", orgUnit: "诉讼业务部", globalRoles: ["project_manager"], confidentialityCap: "confidential", status: "active" },
  { id: "u-member", name: "林海", email: "member@lexflow.demo", orgUnit: "诉讼业务部", globalRoles: ["member"], confidentialityCap: "internal", status: "active" },
  { id: "u-partner", name: "周远", email: "partner@lexflow.demo", orgUnit: "管委会", globalRoles: ["partner"], confidentialityCap: "secret", status: "active" },
  { id: "u-finance", name: "赵敏", email: "finance@lexflow.demo", orgUnit: "财务运营部", globalRoles: ["finance"], confidentialityCap: "internal", status: "active" },
  { id: "u-archivist", name: "郑楠", email: "archivist@lexflow.demo", orgUnit: "综合管理部", globalRoles: ["archivist"], confidentialityCap: "internal", status: "active" },
  { id: "u-sysadmin", name: "马悦", email: "mayue@lexflow.demo", orgUnit: "综合管理部", globalRoles: ["sysadmin"], confidentialityCap: "internal", status: "active" },
  { id: "u-old", name: "刘畅", email: "liuchang@lexflow.demo", orgUnit: "诉讼业务部", globalRoles: ["member"], confidentialityCap: "internal", status: "disabled" },
];

export const previewOrgUnits = ["管委会", "诉讼业务部", "非诉业务部", "财务运营部", "综合管理部"];
export const previewRoleOptions = [
  ["partner", "合伙人"],
  ["project_manager", "项目负责人"],
  ["member", "项目成员"],
  ["quality_lead", "质量负责人"],
  ["finance", "财务"],
  ["archivist", "档案管理员"],
  ["sysadmin", "系统管理员"],
  ["viewer", "只读查阅人"],
] as const;
export const previewConfidentialityOptions = [
  ["public", "公开"],
  ["internal", "内部"],
  ["confidential", "保密"],
  ["secret", "严格"],
] as const;

/* —— B 域：客户与事项 —— */
export interface PreviewClient {
  id: string;
  code: string;
  name: string;
  confidentialityLevel: string;
  status: "active" | "disabled";
  matterCount: number;
}
export interface PreviewMatter {
  id: string;
  code: string;
  clientName: string;
  name: string;
  type: string;
  confidentialityLevel: string;
}
export const previewClients: PreviewClient[] = [
  { id: "c-1", code: "CLT-2026-00001", name: "华宸贸易有限公司", confidentialityLevel: "internal", status: "active", matterCount: 2 },
  { id: "c-2", code: "CLT-2026-00002", name: "星澜科技有限公司", confidentialityLevel: "confidential", status: "active", matterCount: 1 },
  { id: "c-3", code: "CLT-2026-00003", name: "云启控股集团有限公司", confidentialityLevel: "secret", status: "active", matterCount: 0 },
  { id: "c-4", code: "CLT-2026-00004", name: "恒润建设发展有限公司", confidentialityLevel: "internal", status: "disabled", matterCount: 1 },
];
export const previewMatters: PreviewMatter[] = [
  { id: "m-1", code: "MTR-2026-00001", clientName: "华宸贸易有限公司", name: "华宸贸易合同纠纷", type: "诉讼", confidentialityLevel: "internal" },
  { id: "m-2", code: "MTR-2026-00002", clientName: "华宸贸易有限公司", name: "华宸贸易合同·执行阶段", type: "执行", confidentialityLevel: "internal" },
  { id: "m-3", code: "MTR-2026-00003", clientName: "星澜科技有限公司", name: "星澜科技常年法律顾问", type: "常年法律顾问", confidentialityLevel: "confidential" },
  { id: "m-4", code: "MTR-2026-00004", clientName: "恒润建设发展有限公司", name: "恒润工程款争议", type: "诉讼", confidentialityLevel: "internal" },
];

/* —— B 域：项目模板（structure_json 编辑态） —— */
export interface PreviewTemplate {
  id: string;
  name: string;
  description: string;
  stages: { name: string; days: number }[];
  checkItems: { name: string; required: boolean }[];
}
export const previewTemplates: PreviewTemplate[] = [
  {
    id: "t-1",
    name: "诉讼案件标准模板",
    description: "一审/二审诉讼案件的标准阶段与检查项。",
    stages: [
      { name: "立案与证据收集", days: 30 },
      { name: "庭前准备", days: 21 },
      { name: "庭审", days: 7 },
      { name: "判决与执行", days: 21 },
    ],
    checkItems: [
      { name: "委托手续与利益冲突检索完成", required: true },
      { name: "证据清单与原件核对完成", required: true },
      { name: "出庭人员安排确认", required: false },
    ],
  },
  {
    id: "t-2",
    name: "常年法律顾问模板",
    description: "常法服务两阶段结构。",
    stages: [
      { name: "顾问需求梳理", days: 14 },
      { name: "日常服务执行", days: 120 },
    ],
    checkItems: [{ name: "服务范围确认书签署", required: true }],
  },
];

/* —— F 域：审批流定义（definition_json 冻结结构） —— */
export type FlowNodeType = "start" | "end" | "approval" | "condition";
export type ApproverKind = "role" | "user" | "initiator_manager" | "project_manager";
export interface FlowNodeDef {
  id: string;
  type: FlowNodeType;
  label: string;
  approver?: { kind: ApproverKind; role?: string; userId?: string };
  countersign?: "any" | "all";
  expr?: { field: string; op: string; value: number | string };
}
export interface FlowEdgeDef {
  from: string;
  to: string;
  when?: boolean;
}
export interface PreviewFlow {
  id: string;
  name: string;
  scope: "global" | "project";
  bizBinding: string;
  versionNo: number;
  enabled: boolean;
  updatedAt: string;
  definition: { nodes: FlowNodeDef[]; edges: FlowEdgeDef[] };
}
export const previewFlows: PreviewFlow[] = [
  {
    id: "flow-1",
    name: "费用报销默认流程",
    scope: "global",
    bizBinding: "expense",
    versionNo: 2,
    enabled: true,
    updatedAt: "2026-10-28 14:20",
    definition: {
      nodes: [
        { id: "start", type: "start", label: "发起" },
        { id: "n1", type: "approval", label: "项目负责人审批", approver: { kind: "project_manager" }, countersign: "any" },
        { id: "n2", type: "condition", label: "金额 ≥ 5 万", expr: { field: "amount_cents", op: ">=", value: 5000000 } },
        { id: "n3", type: "approval", label: "财务复核", approver: { kind: "role", role: "finance" }, countersign: "any" },
        { id: "end", type: "end", label: "完成" },
      ],
      edges: [
        { from: "start", to: "n1" },
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3", when: true },
        { from: "n2", to: "end", when: false },
        { from: "n3", to: "end" },
      ],
    },
  },
  {
    id: "flow-2",
    name: "通用申请单流程",
    scope: "global",
    bizBinding: "generic_request",
    versionNo: 1,
    enabled: true,
    updatedAt: "2026-10-28 09:12",
    definition: {
      nodes: [
        { id: "start", type: "start", label: "发起" },
        { id: "n1", type: "approval", label: "部门负责人审批", approver: { kind: "initiator_manager" }, countersign: "any" },
        { id: "n2", type: "condition", label: "申请类型 = 采购", expr: { field: "request_type", op: "=", value: "procurement" } },
        { id: "n3", type: "approval", label: "管理层会签", approver: { kind: "role", role: "partner" }, countersign: "all" },
        { id: "end", type: "end", label: "完成" },
      ],
      edges: [
        { from: "start", to: "n1" },
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3", when: true },
        { from: "n2", to: "end", when: false },
        { from: "n3", to: "end" },
      ],
    },
  },
  {
    id: "flow-3",
    name: "出差申请默认流程",
    scope: "global",
    bizBinding: "travel",
    versionNo: 3,
    enabled: true,
    updatedAt: "2026-10-27 17:45",
    definition: {
      nodes: [
        { id: "start", type: "start", label: "发起" },
        { id: "n1", type: "approval", label: "项目负责人审批", approver: { kind: "project_manager" }, countersign: "any" },
        { id: "end", type: "end", label: "完成" },
      ],
      edges: [
        { from: "start", to: "n1" },
        { from: "n1", to: "end" },
      ],
    },
  },
];

export const FLOW_BIZ_BINDINGS = [
  ["expense", "费用报销"],
  ["generic_request", "通用申请单"],
  ["travel", "出差申请"],
  ["travel_change", "出差变更"],
  ["funding", "经费申请"],
  ["expense_adjustment", "报销调整"],
  ["budget", "预算"],
  ["change_request", "延期申请"],
  ["access_grant", "档案授权"],
  ["timesheet", "工时周期"],
] as const;
export const APPROVER_KIND_LABEL: Record<ApproverKind, string> = {
  role: "全局角色",
  user: "指定用户",
  initiator_manager: "发起人的上级",
  project_manager: "项目负责人",
};
export const CONDITION_FIELD_WHITELIST = [
  ["amount_cents", "金额（分）"],
  ["confidentiality", "密级"],
  ["level", "级别"],
  ["borrow", "借款"],
  ["request_type", "申请类型"],
] as const;

/* —— B 域：系统参数（白名单键示意） —— */
export interface PreviewConfig {
  key: string;
  label: string;
  valueJson: string;
  note: string;
}
export const previewConfigs: PreviewConfig[] = [
  { key: "approval.amount_thresholds", label: "审批金额阈值", valueJson: '{ "fundingManagementReviewCents": 5000000, "travelManagementReviewCents": 5000000 }', note: "达到阈值升管理层审批" },
  { key: "expense.receipt_rules", label: "票据要求规则", valueJson: '{ "requiredCategories": ["transport", "accommodation"], "duplicateBlock": true }', note: "重复票据阻止" },
  { key: "timesheet.validation", label: "工时校验规则", valueJson: '{ "dailyMaxMinutes": 1440, "regularThresholdMinutes": 600 }', note: "单日 24h 阻止/超 10h 警告" },
  { key: "meeting.minutes_deadline_business_days", label: "纪要期限（工作日）", valueJson: "2", note: "会议结束后整理期限" },
  { key: "generic_request.types", label: "通用申请类型", valueJson: '[ "leave", "procurement", "seal", "other" ]', note: "可扩充" },
];

/* —— B 域：编号规则（只读） —— */
export const previewCodeRules = [
  ["MTG", "会议"], ["TRV", "出差"], ["BUD", "预算"], ["FND", "经费"], ["EXP", "费用"],
  ["TS", "工时"], ["APR", "审批"], ["LED", "台账"], ["PRJ", "项目"], ["TSK", "任务"],
  ["QLT", "质量"], ["DEC", "决策"], ["RPT", "周报"], ["CLT", "客户"], ["MTR", "事项"],
  ["CHG", "延期"], ["STG", "阶段"], ["MLS", "里程碑"], ["DLV", "交付物"], ["RCV", "收款"], ["REQ", "通用申请"],
];

/* —— F 域：通用申请单 —— */
export interface PreviewRequest {
  id: string;
  code: string;
  requestType: "leave" | "procurement" | "seal" | "other";
  title: string;
  reason: string;
  startOn: string | null;
  endOn: string | null;
  amountCents: number | null;
  applicant: string;
  status: "draft" | "pending_approval" | "approved" | "rejected" | "withdrawn";
  currentNodeId: string;
  submittedAt: string;
  progress: { nodeId: string; label: string; state: "done" | "current" | "pending" | "rejected"; comment?: string; actor?: string }[];
}
export const previewRequestTypeLabel: Record<string, string> = {
  leave: "请假", procurement: "采购", seal: "用章", other: "其他",
};
export const previewRequests: PreviewRequest[] = [
  {
    id: "req-1",
    code: "REQ-2026-00001",
    requestType: "procurement",
    title: "采购证据扫描仪一台",
    reason: "证据数字化需要，预算内 3,800 元。",
    startOn: null,
    endOn: null,
    amountCents: 380000,
    applicant: "林海",
    status: "pending_approval",
    currentNodeId: "n3",
    submittedAt: "2026-10-28 10:24",
    progress: [
      { nodeId: "start", label: "发起", state: "done", actor: "林海" },
      { nodeId: "n1", label: "部门负责人审批", state: "done", actor: "陈立", comment: "同意，属部门必要设备。" },
      { nodeId: "n2", label: "条件：类型=采购", state: "done" },
      { nodeId: "n3", label: "管理层会签（全员）", state: "current" },
      { nodeId: "end", label: "完成", state: "pending" },
    ],
  },
  {
    id: "req-2",
    code: "REQ-2026-00002",
    requestType: "leave",
    title: "年假 2 天",
    reason: "家中有事，申请 11 月 3-4 日年假。",
    startOn: "2026-11-03",
    endOn: "2026-11-04",
    amountCents: null,
    applicant: "林海",
    status: "approved",
    currentNodeId: "end",
    submittedAt: "2026-10-27 09:02",
    progress: [
      { nodeId: "start", label: "发起", state: "done", actor: "林海" },
      { nodeId: "n1", label: "部门负责人审批", state: "done", actor: "陈立", comment: "同意。" },
      { nodeId: "n2", label: "条件：类型=采购", state: "done" },
      { nodeId: "n3", label: "管理层会签（全员）", state: "done", comment: "非采购类型跳过会签" },
      { nodeId: "end", label: "完成", state: "done" },
    ],
  },
];

/* —— R 域：收款登记 —— */
export interface PreviewReceipt {
  id: string;
  code: string;
  projectName: string;
  clientName: string;
  amountCents: number;
  receivedOn: string;
  referenceNo: string;
  payerName: string | null;
  note: string | null;
  status: "registered" | "voided";
  voidReason: string | null;
}
export const previewReceipts: PreviewReceipt[] = [
  { id: "rcv-1", code: "RCV-2026-00001", projectName: "华宸贸易合同纠纷代理·一审", clientName: "华宸贸易有限公司", amountCents: 5000000, receivedOn: "2026-10-20", referenceNo: "BK20261020001", payerName: "华宸贸易有限公司", note: "首期律师费", status: "registered", voidReason: null },
  { id: "rcv-2", code: "RCV-2026-00002", projectName: "华宸贸易合同纠纷代理·一审", clientName: "华宸贸易有限公司", amountCents: 5000000, receivedOn: "2026-11-02", referenceNo: "BK20261102007", payerName: "华宸贸易有限公司", note: "二期律师费", status: "registered", voidReason: null },
  { id: "rcv-3", code: "RCV-2026-00003", projectName: "星澜科技常年法律顾问服务", clientName: "星澜科技有限公司", amountCents: 12000000, receivedOn: "2026-10-15", referenceNo: "BK20261015012", payerName: "星澜科技有限公司", note: "年度顾问费 Q4", status: "registered", voidReason: null },
  { id: "rcv-4", code: "RCV-2026-00004", projectName: "华宸贸易合同纠纷代理·一审", clientName: "华宸贸易有限公司", amountCents: 3000000, receivedOn: "2026-10-18", referenceNo: "BK20261018003", payerName: null, note: "金额录入有误", status: "voided", voidReason: "重复登记，作废后以 RCV-2026-00001 为准" },
];
export const previewReceiptProjects = ["华宸贸易合同纠纷代理·一审", "星澜科技常年法律顾问服务"];

export function yuan(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
