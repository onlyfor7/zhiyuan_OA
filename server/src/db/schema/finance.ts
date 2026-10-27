import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  budgetStatusEnum,
  expenseCategoryEnum,
  expenseStatusEnum,
  fundingUsageStatusEnum,
  ledgerEntryTypeEnum,
} from "./enums";
import { fileVersions } from "./files";
import { users } from "./org";
import { projects } from "./business";
import { approvalInstances } from "./governance";
import { meetings, travelRequests } from "./collab";

/** 通用审计四件套字段（arch/01 §2） */
const auditFour = {
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
};

/* ===== arch/06 §2 预算 ===== */

export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    versionNo: integer("version_no").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    currency: text("currency").notNull().default("CNY"),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
    description: text("description"),
    status: budgetStatusEnum("status").notNull().default("draft"),
    approvalInstanceId: uuid("approval_instance_id").references(() => approvalInstances.id, { onDelete: "restrict" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    unique("budgets_project_version_unique").on(t.projectId, t.versionNo),
    // 每项目恰一个 active（arch/06 §2）
    uniqueIndex("budgets_active_unique").on(t.projectId).where(sql`status = 'active'`),
    index("budgets_project_id_idx").on(t.projectId),
  ],
);

/** 预算类别额度（可选：无类别行 = 只控总额，统计不得误判为零预算，arch/06 §2） */
export const budgetCategories = pgTable(
  "budget_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "restrict" }),
    category: expenseCategoryEnum("category").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  },
  (t) => [unique("budget_categories_budget_category_unique").on(t.budgetId, t.category)],
);

/* ===== arch/06 §2 经费申请（审批态与使用态分离） ===== */

export const fundingRequests = pgTable(
  "funding_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    applicantId: uuid("applicant_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    purpose: text("purpose").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    expectedUseDate: date("expected_use_date"),
    recipientInfo: text("recipient_info"),
    sourceMeetingId: uuid("source_meeting_id").references(() => meetings.id, { onDelete: "restrict" }),
    sourceTravelId: uuid("source_travel_id").references(() => travelRequests.id, { onDelete: "restrict" }),
    /** 审批态（引擎驱动，arch/06 §2 定为 text）：draft/pending_approval/approved/rejected */
    approvalStatus: text("approval_status").notNull().default("draft"),
    usageStatus: fundingUsageStatusEnum("usage_status").notNull().default("unused"),
    approvalInstanceId: uuid("approval_instance_id").references(() => approvalInstances.id, { onDelete: "restrict" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    closeNote: text("close_note"),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    check("funding_requests_amount_positive", sql`"amount_cents" > 0`),
    index("funding_requests_project_id_idx").on(t.projectId),
    index("funding_requests_applicant_id_idx").on(t.applicantId),
  ],
);

/* ===== arch/06 §2 费用报销（单头无 project_id，明细级归属 EXP-001） ===== */

export const expenseReports = pgTable(
  "expense_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    applicantId: uuid("applicant_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    isCrossProject: boolean("is_cross_project").notNull().default(false),
    travelId: uuid("travel_id").references(() => travelRequests.id, { onDelete: "restrict" }),
    meetingId: uuid("meeting_id").references(() => meetings.id, { onDelete: "restrict" }),
    /** 服务端由明细计算，前端传入忽略（arch/06 §2） */
    totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
    status: expenseStatusEnum("status").notNull().default("draft"),
    approvalInstanceId: uuid("approval_instance_id").references(() => approvalInstances.id, { onDelete: "restrict" }),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "string" }),
    paidBy: uuid("paid_by").references(() => users.id, { onDelete: "restrict" }),
    paymentRef: text("payment_ref"),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    index("expense_reports_applicant_id_idx").on(t.applicantId),
    index("expense_reports_status_idx").on(t.status),
  ],
);

export const expenseItems = pgTable(
  "expense_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expenseReportId: uuid("expense_report_id")
      .notNull()
      .references(() => expenseReports.id, { onDelete: "restrict" }),
    /** 明细级项目归属：跨项目报销逐行鉴权（EXP-001） */
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    fundingRequestId: uuid("funding_request_id").references(() => fundingRequests.id, { onDelete: "restrict" }),
    date: date("date").notNull(),
    category: expenseCategoryEnum("category").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    description: text("description").notNull(),
    payee: text("payee"),
    receiptNo: text("receipt_no"),
    receiptFileVersionId: uuid("receipt_file_version_id").references(() => fileVersions.id, { onDelete: "restrict" }),
    /** 写入时按 expense.receipt_rules 类别规则计算 */
    receiptSatisfied: boolean("receipt_satisfied").notNull().default(false),
    ...auditFour,
  },
  (t) => [
    check("expense_items_amount_positive", sql`"amount_cents" > 0`),
    index("expense_items_report_id_idx").on(t.expenseReportId),
    index("expense_items_project_id_idx").on(t.projectId),
  ],
);

/* ===== arch/06 §2 预算台账（只追加；幂等键唯一；arch/01 §4 六类分录） ===== */

export const budgetLedger = pgTable(
  "budget_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    budgetVersionId: uuid("budget_version_id").references(() => budgets.id, { onDelete: "restrict" }),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id"),
    entryType: ledgerEntryTypeEnum("entry_type").notNull(),
    reservedDeltaCents: bigint("reserved_delta_cents", { mode: "number" }).notNull().default(0),
    actualDeltaCents: bigint("actual_delta_cents", { mode: "number" }).notNull().default(0),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    /** entryType:sourceId:seq（arch/06 §4.1），唯一约束兜底防重复记账 */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    index("budget_ledger_project_id_idx").on(t.projectId),
    index("budget_ledger_budget_version_id_idx").on(t.budgetVersionId),
    index("budget_ledger_entry_type_idx").on(t.entryType),
  ],
);

/** 报销调整单（已支付记录更正唯一通道，EXP-009；走引擎审批） */
export const expenseAdjustments = pgTable(
  "expense_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expenseReportId: uuid("expense_report_id")
      .notNull()
      .references(() => expenseReports.id, { onDelete: "restrict" }),
    code: text("code"),
    deltaCents: bigint("delta_cents", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    approvalInstanceId: uuid("approval_instance_id").references(() => approvalInstances.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("pending_approval"),
    ...auditFour,
  },
  (t) => [index("expense_adjustments_report_id_idx").on(t.expenseReportId)],
);
