/** arch/01 §3 全部状态机取值（冻结；DB pgEnum 随对应迭代落地，此处先共享常量） */

export const MEETING_STATUS = ["planned", "completed", "cancelled"] as const;
export type MeetingStatus = (typeof MEETING_STATUS)[number];

export const MEETING_MINUTES_STATUS = ["none_required", "pending_draft", "pending_confirm", "confirmed"] as const;
export type MeetingMinutesStatus = (typeof MEETING_MINUTES_STATUS)[number];

export const TRAVEL_STATUS = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "in_progress",
  "completed",
  "closed",
  "cancelled",
] as const;
export type TravelStatus = (typeof TRAVEL_STATUS)[number];

/** 预算：draft → pending_approval → active → closed；调整产新 active 版本、旧版 superseded（arch/06 §2/§3） */
export const BUDGET_STATUS = ["draft", "pending_approval", "active", "superseded", "closed"] as const;
export type BudgetStatus = (typeof BUDGET_STATUS)[number];

/** 经费申请两态分离：审批态与使用态 */
export const FUNDING_APPROVAL_STATUS = ["draft", "pending_approval", "approved", "rejected"] as const;
export type FundingApprovalStatus = (typeof FUNDING_APPROVAL_STATUS)[number];

export const FUNDING_USAGE_STATUS = ["unused", "partially_used", "written_off", "closed"] as const;
export type FundingUsageStatus = (typeof FUNDING_USAGE_STATUS)[number];

export const EXPENSE_STATUS = [
  "draft",
  "pending_approval",
  "rejected",
  "approved_pending_payment",
  "paid",
] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUS)[number];

export const TIMESHEET_PERIOD_STATUS = ["draft", "pending_approval", "approved", "returned", "locked"] as const;
export type TimesheetPeriodStatus = (typeof TIMESHEET_PERIOD_STATUS)[number];

export const APPROVAL_INSTANCE_STATUS = ["pending", "approved", "rejected", "withdrawn"] as const;
export type ApprovalInstanceStatus = (typeof APPROVAL_INSTANCE_STATUS)[number];
