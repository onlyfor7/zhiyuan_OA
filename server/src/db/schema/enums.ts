import { pgEnum } from "drizzle-orm/pg-core";

import {
  ACCESS_GRANT_SCOPE_TYPE,
  ACCESS_GRANT_STATUS,
  APPROVAL_INSTANCE_STATUS,
  APPROVAL_STEP_STATUS,
  CHANGE_LEVEL,
  CHANGE_REQUEST_STATUS,
  CHECK_ITEM_STATUS,
  CONFIDENTIALITY_LEVEL,
  COUNTERSIGN_RULE,
  DECISION_STATUS,
  DELIVERABLE_STATUS,
  MILESTONE_STATUS,
  PLAN_ITEM_TYPE,
  PLAN_VERSION_KIND,
  PLAN_VERSION_STATUS,
  PROJECT_HEALTH_STATUS,
  PROJECT_LIFECYCLE_STATUS,
  QUALITY_EVENT_ACTION,
  QUALITY_ISSUE_STATUS,
  QUALITY_SEVERITY,
  STAGE_STATUS,
  TASK_STATUS,
  USER_STATUS,
  WEEKLY_REPORT_STATUS,
} from "@lexflow/shared";

/** 迭代 0 需要的枚举用 pgEnum（arch/01 §2 裁定）；其余状态机枚举随业务迭代落地 */

export const userStatusEnum = pgEnum("user_status", USER_STATUS);

export const confidentialityLevelEnum = pgEnum("confidentiality_level", CONFIDENTIALITY_LEVEL);

export const projectLifecycleStatusEnum = pgEnum("project_lifecycle_status", PROJECT_LIFECYCLE_STATUS);

export const projectHealthStatusEnum = pgEnum("project_health_status", PROJECT_HEALTH_STATUS);

export const accessGrantStatusEnum = pgEnum("access_grant_status", ACCESS_GRANT_STATUS);

export const accessGrantScopeTypeEnum = pgEnum("access_grant_scope_type", ACCESS_GRANT_SCOPE_TYPE);

/** 迭代 1 治理域枚举（arch/04 §2.11 冻结） */

export const stageStatusEnum = pgEnum("stage_status", STAGE_STATUS);

export const milestoneStatusEnum = pgEnum("milestone_status", MILESTONE_STATUS);

export const taskStatusEnum = pgEnum("task_status", TASK_STATUS);

export const deliverableStatusEnum = pgEnum("deliverable_status", DELIVERABLE_STATUS);

export const planVersionKindEnum = pgEnum("plan_version_kind", PLAN_VERSION_KIND);

export const planVersionStatusEnum = pgEnum("plan_version_status", PLAN_VERSION_STATUS);

export const planItemTypeEnum = pgEnum("plan_item_type", PLAN_ITEM_TYPE);

export const changeLevelEnum = pgEnum("change_level", CHANGE_LEVEL);

export const changeRequestStatusEnum = pgEnum("change_request_status", CHANGE_REQUEST_STATUS);

export const qualitySeverityEnum = pgEnum("quality_severity", QUALITY_SEVERITY);

export const qualityIssueStatusEnum = pgEnum("quality_issue_status", QUALITY_ISSUE_STATUS);

export const qualityEventActionEnum = pgEnum("quality_event_action", QUALITY_EVENT_ACTION);

export const checkItemStatusEnum = pgEnum("check_item_status", CHECK_ITEM_STATUS);

export const decisionStatusEnum = pgEnum("decision_status", DECISION_STATUS);

export const weeklyReportStatusEnum = pgEnum("weekly_report_status", WEEKLY_REPORT_STATUS);

export const approvalInstanceStatusEnum = pgEnum("approval_instance_status", APPROVAL_INSTANCE_STATUS);

export const approvalStepStatusEnum = pgEnum("approval_step_status", APPROVAL_STEP_STATUS);

export const countersignRuleEnum = pgEnum("countersign_rule", COUNTERSIGN_RULE);
