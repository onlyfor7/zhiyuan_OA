import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  approvalInstanceStatusEnum,
  approvalStepStatusEnum,
  changeLevelEnum,
  changeRequestStatusEnum,
  checkItemStatusEnum,
  countersignRuleEnum,
  decisionStatusEnum,
  deliverableStatusEnum,
  milestoneStatusEnum,
  planItemTypeEnum,
  planVersionKindEnum,
  planVersionStatusEnum,
  qualityIssueStatusEnum,
  qualitySeverityEnum,
  qualityEventActionEnum,
  stageStatusEnum,
  taskStatusEnum,
  weeklyReportStatusEnum,
} from "./enums";
import { fileVersions } from "./files";
import { users } from "./org";
import { projects } from "./business";

/** 通用审计四件套字段（arch/01 §2） */
const auditFour = {
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
};

/* ===== arch/04 §2.2 项目结构 ===== */

export const stages = pgTable(
  "stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    seq: integer("seq").notNull(),
    plannedStart: date("planned_start").notNull(),
    plannedEnd: date("planned_end").notNull(),
    actualStart: date("actual_start"),
    actualEnd: date("actual_end"),
    status: stageStatusEnum("status").notNull().default("pending"),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [index("stages_project_id_idx").on(t.projectId)],
);

export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    stageId: uuid("stage_id").references(() => stages.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    seq: integer("seq").notNull(),
    plannedDate: date("planned_date").notNull(),
    actualDate: date("actual_date"),
    status: milestoneStatusEnum("status").notNull().default("pending"),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    index("milestones_project_id_idx").on(t.projectId),
    index("milestones_stage_id_idx").on(t.stageId),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    stageId: uuid("stage_id").references(() => stages.id, { onDelete: "restrict" }),
    milestoneId: uuid("milestone_id").references(() => milestones.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    title: text("title").notNull(),
    description: text("description"),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "restrict" }),
    plannedStart: date("planned_start").notNull(),
    plannedEnd: date("planned_end").notNull(),
    actualStart: timestamp("actual_start", { withTimezone: true, mode: "string" }),
    actualEnd: timestamp("actual_end", { withTimezone: true, mode: "string" }),
    status: taskStatusEnum("status").notNull().default("pending"),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    index("tasks_project_id_idx").on(t.projectId),
    index("tasks_assignee_id_idx").on(t.assigneeId),
    index("tasks_status_idx").on(t.status),
  ],
);

export const deliverables = pgTable(
  "deliverables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    milestoneId: uuid("milestone_id").references(() => milestones.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    required: boolean("required").notNull().default(true),
    status: deliverableStatusEnum("status").notNull().default("pending"),
    fileVersionId: uuid("file_version_id").references(() => fileVersions.id, { onDelete: "restrict" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "string" }),
    deliveredBy: uuid("delivered_by").references(() => users.id, { onDelete: "restrict" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [index("deliverables_project_id_idx").on(t.projectId)],
);

/* ===== arch/04 §2.3 计划版本（PLN-I1：items 只写不改） ===== */

export const planVersions = pgTable(
  "plan_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    versionNo: integer("version_no").notNull(),
    kind: planVersionKindEnum("kind").notNull(),
    status: planVersionStatusEnum("status").notNull().default("active"),
    sourceChangeRequestId: uuid("source_change_request_id").references((): AnyPgColumn => changeRequests.id, {
      onDelete: "restrict",
    }),
    notes: text("notes"),
    ...auditFour,
  },
  (t) => [
    unique("plan_versions_project_version_unique").on(t.projectId, t.versionNo),
    // 每项目恰一个 active（arch/04 §2.3）
    uniqueIndex("plan_versions_active_unique").on(t.projectId).where(sql`status = 'active'`),
  ],
);

export const planItems = pgTable(
  "plan_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => planVersions.id, { onDelete: "restrict" }),
    itemType: planItemTypeEnum("item_type").notNull(),
    refId: uuid("ref_id").notNull(),
    /** 版本时点快照名（arch/04 §2.3 v1.1：改名不改历史版本显示；存量行由 0002 迁移回填） */
    name: text("name").notNull(),
    plannedStart: date("planned_start").notNull(),
    plannedEnd: date("planned_end").notNull(),
    seq: integer("seq").notNull(),
    dependsOn: uuid("depends_on").array().notNull().default([]),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("plan_items_plan_version_id_idx").on(t.planVersionId)],
);

/* ===== arch/04 §2.4 延期申请（CHG） ===== */

export const changeRequests = pgTable(
  "change_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    title: text("title").notNull(),
    targetItems: jsonb("target_items").$type<Array<Record<string, unknown>>>().notNull(),
    reason: text("reason").notNull(),
    impact: text("impact").notNull(),
    recoveryMeasures: jsonb("recovery_measures").$type<Array<Record<string, unknown>>>().notNull(),
    level: changeLevelEnum("level").notNull().default("normal"),
    status: changeRequestStatusEnum("status").notNull().default("draft"),
    approvalInstanceId: uuid("approval_instance_id").references(() => approvalInstances.id, {
      onDelete: "restrict",
    }),
    resultingPlanVersionId: uuid("resulting_plan_version_id").references((): AnyPgColumn => planVersions.id, {
      onDelete: "restrict",
    }),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [index("change_requests_project_id_idx").on(t.projectId)],
);

/* ===== arch/04 §2.5 质量（QLT） ===== */

export const qualityIssues = pgTable(
  "quality_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    severity: qualitySeverityEnum("severity").notNull(),
    status: qualityIssueStatusEnum("status").notNull().default("open"),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    handlerId: uuid("handler_id").references(() => users.id, { onDelete: "restrict" }),
    reviewerId: uuid("reviewer_id").references(() => users.id, { onDelete: "restrict" }),
    rootCause: text("root_cause"),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    isBlocking: boolean("is_blocking").notNull().default(false),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [index("quality_issues_project_id_idx").on(t.projectId)],
);

/** 质量事件流（只追加；处理与复核历史以此为准，arch/04 §2.5） */
export const qualityIssueEvents = pgTable(
  "quality_issue_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => qualityIssues.id, { onDelete: "restrict" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "restrict" }),
    action: qualityEventActionEnum("action").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("quality_issue_events_issue_id_idx").on(t.issueId)],
);

export const qualityCheckItems = pgTable(
  "quality_check_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    stageId: uuid("stage_id").references(() => stages.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    required: boolean("required").notNull().default(true),
    status: checkItemStatusEnum("status").notNull().default("pending"),
    checkedBy: uuid("checked_by").references(() => users.id, { onDelete: "restrict" }),
    checkedAt: timestamp("checked_at", { withTimezone: true, mode: "string" }),
    ...auditFour,
  },
  (t) => [index("quality_check_items_project_id_idx").on(t.projectId)],
);

/* ===== arch/04 §2.6 决策（DEC） ===== */

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    title: text("title").notNull(),
    context: text("context").notNull(),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    options: jsonb("options").$type<Array<Record<string, unknown>>>().notNull().default([]),
    pmOpinion: text("pm_opinion"),
    qualityOpinion: text("quality_opinion"),
    finalOption: text("final_option"),
    finalReason: text("final_reason"),
    conditions: text("conditions"),
    checkpoints: jsonb("checkpoints").$type<Array<Record<string, unknown>> | null>(),
    status: decisionStatusEnum("status").notNull().default("draft"),
    deciderId: uuid("decider_id").references(() => users.id, { onDelete: "restrict" }),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    verificationNote: text("verification_note"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    verifiedBy: uuid("verified_by").references(() => users.id, { onDelete: "restrict" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [index("decisions_project_id_idx").on(t.projectId)],
);

/* ===== arch/04 §2.7 周报（ARH） ===== */

export const weeklyReports = pgTable(
  "weekly_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    versionNo: integer("version_no").notNull().default(1),
    status: weeklyReportStatusEnum("status").notNull().default("draft"),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "restrict" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    unique("weekly_reports_period_version_unique").on(t.projectId, t.periodStart, t.versionNo),
  ],
);

/* ===== arch/04 §2.8 档案（DOC/SHR） ===== */

export const archiveDirectories = pgTable(
  "archive_directories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    dirKey: text("dir_key").notNull(),
    name: text("name").notNull(),
    seq: integer("seq").notNull(),
  },
  (t) => [unique("archive_directories_project_key_unique").on(t.projectId, t.dirKey)],
);

/**
 * 档案归集链接（arch/04 §2.8；arch/05 §2.2 放宽 meeting/travel；arch/07 §2 再放宽 funding/expense）。
 * 二态：文件链接（file_version_id 非空 + 非 report 来源对）
 * 或结构化对象链接（fv 空 + 来源对 source_type ∈ report/meeting/travel/funding/expense）。
 */
export const archiveLinks = pgTable(
  "archive_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    directoryId: uuid("directory_id")
      .notNull()
      .references(() => archiveDirectories.id, { onDelete: "restrict" }),
    fileVersionId: uuid("file_version_id").references(() => fileVersions.id, { onDelete: "restrict" }),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    businessDate: date("business_date"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "archive_links_duality_check",
      sql`(("file_version_id" is not null and "source_type" is not null and "source_type" <> 'report' and "source_id" is not null)
        or ("file_version_id" is null and "source_type" in ('report', 'meeting', 'travel', 'funding', 'expense') and "source_id" is not null))`,
    ),
    // 文件链接唯一（部分索引）；报告链接唯一（directory_id, source_type, source_id）
    uniqueIndex("archive_links_file_unique").on(t.directoryId, t.fileVersionId).where(sql`file_version_id is not null`),
    unique("archive_links_source_unique").on(t.directoryId, t.sourceType, t.sourceId),
    index("archive_links_directory_id_idx").on(t.directoryId),
  ],
);

/* ===== arch/04 §2.9 审批引擎（唯一审批实现） ===== */

export const approvalInstances = pgTable(
  "approval_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    bizType: text("biz_type").notNull(),
    bizId: uuid("biz_id").notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    applicantId: uuid("applicant_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    formSnapshot: jsonb("form_snapshot").$type<Record<string, unknown>>().notNull(),
    policySnapshot: jsonb("policy_snapshot").$type<Record<string, unknown>>().notNull(),
    currentStepSeq: integer("current_step_seq").notNull().default(1),
    status: approvalInstanceStatusEnum("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [index("approval_instances_applicant_id_idx").on(t.applicantId)],
);

export const approvalSteps = pgTable(
  "approval_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => approvalInstances.id, { onDelete: "restrict" }),
    seq: integer("seq").notNull(),
    approverId: uuid("approver_id").references(() => users.id, { onDelete: "restrict" }),
    approverRole: text("approver_role"),
    countersign: countersignRuleEnum("countersign").notNull().default("any"),
    status: approvalStepStatusEnum("status").notNull().default("pending"),
    actedBy: uuid("acted_by").references(() => users.id, { onDelete: "restrict" }),
    comment: text("comment"),
    actedAt: timestamp("acted_at", { withTimezone: true, mode: "string" }),
    /** N4（arch/04 §4 v1.2）：act 幂等键消费列，同键重放 200+applied=false、异键 409 */
    actedIdempotencyKey: text("acted_idempotency_key"),
    delegatedFrom: uuid("delegated_from").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [unique("approval_steps_instance_seq_unique").on(t.instanceId, t.seq)],
);

export const approvalPolicies = pgTable(
  "approval_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bizType: text("biz_type").notNull(),
    priority: integer("priority").notNull().default(100),
    matchJson: jsonb("match_json").$type<Record<string, unknown>>().notNull(),
    stepsJson: jsonb("steps_json").$type<Array<Record<string, unknown>>>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    description: text("description").notNull().default(""),
    ...auditFour,
  },
  (t) => [index("approval_policies_biz_type_idx").on(t.bizType)],
);

/* ===== arch/04 §2.10 模板 ===== */

export const projectTemplates = pgTable(
  "project_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    description: text("description").notNull().default(""),
    structureJson: jsonb("structure_json").$type<Record<string, unknown>>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    ...auditFour,
  },
);
