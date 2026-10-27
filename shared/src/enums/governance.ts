/** 迭代 1 项目治理域枚举（arch/04 §2.11，冻结） */

export const STAGE_STATUS = ["pending", "active", "done"] as const;
export type StageStatus = (typeof STAGE_STATUS)[number];

export const MILESTONE_STATUS = ["pending", "reached", "missed"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUS)[number];

export const TASK_STATUS = ["pending", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

export const DELIVERABLE_STATUS = ["pending", "delivered", "accepted"] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUS)[number];

export const PLAN_VERSION_KIND = ["baseline", "change"] as const;
export type PlanVersionKind = (typeof PLAN_VERSION_KIND)[number];

export const PLAN_VERSION_STATUS = ["active", "superseded"] as const;
export type PlanVersionStatus = (typeof PLAN_VERSION_STATUS)[number];

export const PLAN_ITEM_TYPE = ["stage", "milestone", "task"] as const;
export type PlanItemType = (typeof PLAN_ITEM_TYPE)[number];

export const CHANGE_LEVEL = ["normal", "key"] as const;
export type ChangeLevel = (typeof CHANGE_LEVEL)[number];

export const CHANGE_REQUEST_STATUS = ["draft", "pending_approval", "approved", "rejected", "withdrawn"] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUS)[number];

export const QUALITY_SEVERITY = ["critical", "severe", "major", "minor"] as const;
export type QualitySeverity = (typeof QUALITY_SEVERITY)[number];

export const QUALITY_ISSUE_STATUS = ["open", "handling", "pending_review", "closed"] as const;
export type QualityIssueStatus = (typeof QUALITY_ISSUE_STATUS)[number];

/** 质量事件动作（quality_issue_events 只追加，arch/04 §2.5） */
export const QUALITY_EVENT_ACTION = [
  "create",
  "assign",
  "handle_submit",
  "review_pass",
  "review_return",
  "reopen",
] as const;
export type QualityEventAction = (typeof QUALITY_EVENT_ACTION)[number];

export const CHECK_ITEM_STATUS = ["pending", "passed", "failed", "waived"] as const;
export type CheckItemStatus = (typeof CHECK_ITEM_STATUS)[number];

export const DECISION_STATUS = ["draft", "deciding", "decided", "verified"] as const;
export type DecisionStatus = (typeof DECISION_STATUS)[number];

export const WEEKLY_REPORT_STATUS = ["draft", "confirmed", "archived"] as const;
export type WeeklyReportStatus = (typeof WEEKLY_REPORT_STATUS)[number];

export const APPROVAL_STEP_STATUS = ["pending", "approved", "rejected", "transferred", "skipped"] as const;
export type ApprovalStepStatus = (typeof APPROVAL_STEP_STATUS)[number];

export const COUNTERSIGN_RULE = ["any", "all"] as const;
export type CountersignRule = (typeof COUNTERSIGN_RULE)[number];
