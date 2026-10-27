/** 业务域枚举（arch/01 §4、arch/02 §3/§5、arch/03 §6、需求基线 TIM-002/NTF-101） */

/** budget_ledger 分录类型（arch/01 §4，冻结） */
export const LEDGER_ENTRY_TYPE = [
  "BUDGET_ACTIVATED",
  "BUDGET_ADJUSTED",
  "FUNDING_RESERVED",
  "FUNDING_RELEASED",
  "EXPENSE_RECOGNIZED",
  "EXPENSE_ADJUSTED",
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPE)[number];

/** 公共来源类型（arch/02 §5，冻结；"project" 为 2026-10-26 v1.1 架构增补：文件等对象可直接挂载项目） */
export const SOURCE_TYPE = [
  "meeting",
  "travel",
  "funding",
  "expense",
  "time_entry",
  "change_request",
  "quality_issue",
  "decision",
  "plan",
  "budget",
  "access_grant",
  "report",
  "project",
] as const;
export type SourceType = (typeof SOURCE_TYPE)[number];

/** 审批动作（arch/03 §6.6：提交/撤回/通过/驳回/转交/代理/会签） */
export const APPROVAL_ACTION = ["submit", "approve", "reject", "withdraw", "transfer", "delegate", "countersign"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTION)[number];

/** 工时活动类型（需求基线 TIM-002；arch/02 §3.1 v1.1 冻结六值） */
export const TIME_ACTIVITY_TYPE = [
  "professional_work",
  "meeting",
  "travel",
  "quality_review",
  "internal_admin",
  "other",
] as const;
export type TimeActivityType = (typeof TIME_ACTIVITY_TYPE)[number];

/** 工时明细来源（arch/07 §2：预填/复制一律草稿态，不计有效工时） */
export const TIME_ENTRY_SOURCE = ["manual", "prefill_meeting", "prefill_travel", "copy"] as const;
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCE)[number];

/** 通知事件类型（需求基线 §12.2，arch/02 §3.1 v1.1 冻结；arch/04 §6 增补 7 值；arch/05 §6 增补 1 值） */
export const NOTIFICATION_EVENT_TYPE = [
  "meeting_starting",
  "minutes_overdue",
  "action_item_due",
  "travel_approval",
  "travel_return_expense",
  "budget_exceeded",
  "timesheet_gap",
  "grant_expiring",
  "approval_pending",
  "approval_result",
  "task_due_soon",
  "task_overdue",
  "quality_returned",
  "decision_required",
  "report_draft_ready",
  "minutes_pending_confirm",
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPE)[number];

/** 项目成员角色（项目内 ABAC 输入；取值待业务迭代细化） */
export const PROJECT_ROLE = ["manager", "key_member", "member"] as const;
export type ProjectRole = (typeof PROJECT_ROLE)[number];

/** 会议类型（arch/02 §3.1 v1.1 冻结 5 值；管理端可扩充，键名不得改） */
export const MEETING_TYPE = ["project", "client", "quality_review", "weekly", "decision"] as const;
export type MeetingType = (typeof MEETING_TYPE)[number];

/** 费用类别（arch/02 §3.1 v1.1 冻结 8 值；管理端可扩充，键名不得改） */
export const EXPENSE_CATEGORY = [
  "transport",
  "accommodation",
  "meals",
  "meeting",
  "materials",
  "translation",
  "notarization",
  "travel_other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORY)[number];
