import type {
  AccessGrantStatus,
  ApprovalStepStatus,
  ChangeLevel,
  ChangeRequestStatus,
  CheckItemStatus,
  ConfidentialityLevel,
  DecisionStatus,
  MilestoneStatus,
  PlanItemType,
  PlanVersionKind,
  ProjectHealthStatus,
  ProjectLifecycleStatus,
  QualityIssueStatus,
  QualitySeverity,
  StageStatus,
  TaskStatus,
  WeeklyReportStatus,
} from "@lexflow/shared";

/** 枚举 → 中文展示标签（展示层映射；N2：key_member 已补） */

export const LIFECYCLE_LABEL: Record<ProjectLifecycleStatus, string> = {
  preparing: "筹备中",
  in_progress: "进行中",
  closed: "已结项",
};

export const HEALTH_LABEL: Record<ProjectHealthStatus, string> = {
  normal: "正常",
  warning: "预警",
  at_risk: "风险",
};

export const CONFIDENTIALITY_LABEL: Record<ConfidentialityLevel, string> = {
  public: "公开",
  internal: "内部",
  confidential: "保密",
  secret: "严格",
};

export const PROJECT_ROLE_LABEL: Record<string, string> = {
  manager: "项目负责人",
  member: "项目成员",
  key_member: "关键成员",
};

export const GLOBAL_ROLE_LABEL: Record<string, string> = {
  partner: "合伙人",
  project_manager: "项目负责人",
  member: "项目成员",
  quality_lead: "质量负责人",
  finance: "财务",
  archivist: "档案管理员",
  sysadmin: "系统管理员",
  viewer: "只读查阅人",
};

export const STAGE_STATUS_LABEL: Record<StageStatus, string> = {
  pending: "未开始",
  active: "进行中",
  done: "已完成",
};

export const MILESTONE_STATUS_LABEL: Record<MilestoneStatus, string> = {
  pending: "未到达",
  reached: "已到达",
  missed: "已错过",
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "待开始",
  in_progress: "进行中",
  done: "已完成",
  cancelled: "已取消",
};

export const PLAN_ITEM_TYPE_LABEL: Record<PlanItemType, string> = {
  stage: "阶段",
  milestone: "里程碑",
  task: "任务",
};

export const PLAN_VERSION_KIND_LABEL: Record<PlanVersionKind, string> = {
  baseline: "基线",
  change: "变更",
};

export const CHANGE_LEVEL_LABEL: Record<ChangeLevel, string> = {
  normal: "一般延期",
  key: "重大延期",
};

export const CHANGE_STATUS_LABEL: Record<ChangeRequestStatus, string> = {
  draft: "草稿",
  pending_approval: "审批中",
  approved: "已通过",
  rejected: "已驳回",
  withdrawn: "已撤回",
};

export const QUALITY_SEVERITY_LABEL: Record<QualitySeverity, string> = {
  critical: "致命",
  severe: "严重",
  major: "一般",
  minor: "建议",
};

export const QUALITY_STATUS_LABEL: Record<QualityIssueStatus, string> = {
  open: "待处理",
  handling: "处理中",
  pending_review: "待复核",
  closed: "已关闭",
};

export const CHECK_ITEM_STATUS_LABEL: Record<CheckItemStatus, string> = {
  pending: "待检查",
  passed: "已通过",
  failed: "未通过",
  waived: "已豁免",
};

export const DECISION_STATUS_LABEL: Record<DecisionStatus, string> = {
  draft: "草稿",
  deciding: "决策中",
  decided: "已决定",
  verified: "已验证",
};

export const DECISION_OPTION_LABEL: Record<string, string> = {
  delay: "延期保质量",
  add_staff: "增加资源",
  scope_reduce: "缩减范围",
  phased_delivery: "分阶段交付",
  risk_accept: "风险接受",
  other: "其他",
};

export const REPORT_STATUS_LABEL: Record<WeeklyReportStatus, string> = {
  draft: "草稿",
  confirmed: "已确认",
  archived: "已归档",
};

export const GRANT_STATUS_LABEL: Record<AccessGrantStatus, string> = {
  pending_approval: "审批中",
  active: "有效",
  expired: "已到期",
  revoked: "已撤销",
  rejected: "已驳回", // arch/01 §3 v1.1：grant 驳回改落 rejected（迭代 2 枚举落地，数据会话补标签）
};

export const APPROVAL_STEP_STATUS_LABEL: Record<ApprovalStepStatus, string> = {
  pending: "待审批",
  approved: "已通过",
  rejected: "已驳回",
  transferred: "已转交",
  skipped: "已跳过",
};

export const APPROVAL_BIZ_LABEL: Record<string, string> = {
  change_request: "延期申请",
  access_grant: "档案授权",
};

export const TODO_KIND_LABEL: Record<string, string> = {
  task: "任务",
  approval: "审批",
  quality_review: "质量复核",
  report_confirm: "周报确认",
  grant_handle: "授权处理",
  minutes_draft: "待写纪要",
  minutes_confirm: "待确认纪要",
};

export const QUALITY_EVENT_LABEL: Record<string, string> = {
  create: "登记",
  assign: "分派",
  handle_submit: "提交处理",
  review_pass: "复核通过",
  review_return: "复核退回",
  reopen: "重开",
};

/* —— 迭代 2 会议/出差域标签（arch/05） —— */

export const MEETING_TYPE_LABEL: Record<string, string> = {
  project: "项目会议",
  client: "客户会议",
  quality_review: "质量复核会",
  weekly: "项目周会",
  decision: "决策会",
};

export const MEETING_STATUS_LABEL: Record<string, string> = {
  planned: "已计划",
  completed: "已完成",
  cancelled: "已取消",
};

export const MINUTES_STATUS_LABEL: Record<string, string> = {
  none_required: "无需纪要",
  pending_draft: "待整理",
  pending_confirm: "待确认",
  confirmed: "已确认",
};

export const TRAVEL_STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  pending_approval: "审批中",
  approved: "已批准",
  rejected: "已驳回",
  in_progress: "出差中",
  completed: "已完成",
  closed: "已关闭",
  cancelled: "已取消",
};

export const SEGMENT_TYPE_LABEL: Record<string, string> = {
  transport: "交通",
  accommodation: "住宿",
  client_site: "客户现场",
  other: "其他",
};

export const TRAVEL_EVENT_LABEL: Record<string, string> = {
  create: "创建",
  submit: "提交审批",
  approve: "审批通过",
  reject: "审批驳回",
  withdraw: "撤回",
  change_submit: "变更提交",
  change_approved: "变更通过",
  depart: "出发",
  complete: "完成",
  close: "关闭",
  cancel: "取消",
};

export const ATTENDANCE_LABEL: Record<string, string> = {
  planned: "未记录",
  attended: "出席",
  absent: "缺席",
  excused: "请假",
};
