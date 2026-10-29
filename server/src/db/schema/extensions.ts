import { sql } from "drizzle-orm";
import {
  bigint,
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

import { flowScopeEnum, genericRequestStatusEnum, receiptStatusEnum } from "./enums";
import { fileVersions } from "./files";
import { users } from "./org";
import { clients, projects } from "./business";
import { approvalInstances } from "./governance";
/** 通用审计四件套字段（arch/01 §2） */
const auditFour = {
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
};

/**
 * 客户收款登记台账（arch/09 §2）。
 * 只做登记：registered 金额不可编辑；更正 = void（理由必填+审计）+ 新登记；void 不删行。
 * 项目实收 = Σ registered − Σ voided（原额）。
 */
export const paymentReceipts = pgTable(
  "payment_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    /** 写入时按项目冗余客户，报表口径一致（arch/09 §2） */
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    receivedOn: date("received_on").notNull(),
    referenceNo: text("reference_no").notNull(),
    payerName: text("payer_name"),
    note: text("note"),
    attachmentFileVersionId: uuid("attachment_file_version_id").references(() => fileVersions.id, { onDelete: "restrict" }),
    /** R6（arch/00 §3.7）：创建类幂等——同键重放返回首次登记，列可空（历史行/外部登记无键） */
    idempotencyKey: text("idempotency_key"),
    status: receiptStatusEnum("status").notNull().default("registered"),
    voidReason: text("void_reason"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "restrict" }),
    voidedAt: timestamp("voided_at", { withTimezone: true, mode: "string" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    check("payment_receipts_amount_positive", sql`"amount_cents" > 0`),
    uniqueIndex("payment_receipts_idempotency_key_unique").on(t.idempotencyKey),
    index("payment_receipts_project_id_idx").on(t.projectId),
    index("payment_receipts_client_id_idx").on(t.clientId),
    index("payment_receipts_received_on_idx").on(t.receivedOn),
  ],
);

/**
 * 审批流定义（arch/09 §3.1：可视化设计器的落点，编译为既有引擎步骤，不另建引擎）。
 * definition_json 冻结结构：nodes(start/end/approval/condition) + edges(when 条件分支)。
 */
export const flowDefinitions = pgTable(
  "flow_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    scope: flowScopeEnum("scope").notNull().default("global"),
    bizBinding: text("biz_binding").notNull(),
    /** 项目绑定（02b 裁定）：project scope 流程绑定项目；null = 该 scope 全部项目 */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    versionNo: integer("version_no").notNull(),
    definitionJson: jsonb("definition_json").$type<Record<string, unknown>>().notNull(),
    enabled: boolean("enabled").notNull().default(false),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    unique("flow_definitions_name_version_unique").on(t.name, t.versionNo),
    // 每 (biz_binding, 项目) 组合恰一 enabled（02b：项目绑定优先于 global 的解析归 03b）
    uniqueIndex("flow_definitions_enabled_unique")
      .on(
        t.bizBinding,
        sql`coalesce(${t.projectId}, '00000000-0000-0000-0000-000000000000')`,
      )
      .where(sql`enabled = true`),
    index("flow_definitions_biz_binding_idx").on(t.bizBinding),
  ],
);

/** 通用申请单（arch/09 §3.2：固定核心字段，不做自由表单设计器；走引擎 biz_type='generic_request'） */
export const genericRequests = pgTable(
  "generic_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    requestType: text("request_type").notNull(),
    title: text("title").notNull(),
    reason: text("reason").notNull(),
    startOn: date("start_on"),
    endOn: date("end_on"),
    amountCents: bigint("amount_cents", { mode: "number" }),
    attachmentFileVersionId: uuid("attachment_file_version_id").references(() => fileVersions.id, { onDelete: "restrict" }),
    applicantId: uuid("applicant_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: genericRequestStatusEnum("status").notNull().default("draft"),
    approvalInstanceId: uuid("approval_instance_id").references(() => approvalInstances.id, { onDelete: "restrict" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    index("generic_requests_applicant_id_idx").on(t.applicantId),
    index("generic_requests_request_type_idx").on(t.requestType),
    index("generic_requests_status_idx").on(t.status),
  ],
);
