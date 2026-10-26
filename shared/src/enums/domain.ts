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

/** 公共来源类型（arch/02 §5，冻结） */
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
] as const;
export type SourceType = (typeof SOURCE_TYPE)[number];

/** 审批动作（arch/03 §6.6：提交/撤回/通过/驳回/转交/代理/会签） */
export const APPROVAL_ACTION = ["submit", "approve", "reject", "withdraw", "transfer", "delegate", "countersign"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTION)[number];

/** 工时活动类型（需求基线 TIM-002） */
export const TIME_ACTIVITY_TYPE = [
  "professional_work",
  "meeting",
  "travel",
  "quality_review",
  "internal_admin",
  "other",
] as const;
export type TimeActivityType = (typeof TIME_ACTIVITY_TYPE)[number];

/** 通知事件类型（需求基线 NTF-101；取值待架构会话确认） */
export const NOTIFICATION_EVENT_TYPE = [
  "meeting_starting",
  "minutes_overdue",
  "action_item_due",
  "travel_approval",
  "travel_return_expense",
  "budget_exceeded",
  "timesheet_gap",
  "grant_expiring",
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPE)[number];

/** 项目成员角色（项目内 ABAC 输入；取值待业务迭代细化） */
export const PROJECT_ROLE = ["manager", "key_member", "member"] as const;
export type ProjectRole = (typeof PROJECT_ROLE)[number];
