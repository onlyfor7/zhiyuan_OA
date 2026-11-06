import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { invoiceStatusEnum, receivableStatusEnum } from "./enums";
import { users } from "./org";
import { clients } from "./business";
import { crmContracts, crmContractPaymentPlans } from "./crm";

/** 通用审计四件套字段（arch/01 §2） */
const auditFour = {
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
};

/**
 * 应收单（arch/12 §7.2：AR-；逾期为查询口径计算列不落库——账龄分桶 0-30/31-60/61-90/90+ 由视图/查询算）。
 * 来源：合同激活或付款计划到期自动生成（source 标记）。
 */
export const finReceivables = pgTable(
  "fin_receivables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => crmContracts.id, { onDelete: "restrict" }),
    planId: uuid("plan_id").references(() => crmContractPaymentPlans.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    dueDate: date("due_date").notNull(),
    status: receivableStatusEnum("status").notNull().default("open"),
    source: text("source").notNull().default(""),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    index("fin_receivables_contract_id_idx").on(t.contractId),
    index("fin_receivables_customer_id_idx").on(t.customerId),
    index("fin_receivables_due_date_idx").on(t.dueDate),
  ],
);

/** 发票（arch/12 §7.2：INV-；状态机 draft→issued→sent / voided〔红冲=voided+冲正行〕；tax_rate 为百分比整数） */
export const finInvoices = pgTable(
  "fin_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    contractId: uuid("contract_id").references(() => crmContracts.id, { onDelete: "restrict" }),
    receivableId: uuid("receivable_id").references(() => finReceivables.id, { onDelete: "restrict" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    taxRate: integer("tax_rate").notNull().default(0),
    status: invoiceStatusEnum("status").notNull().default("draft"),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "string" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    index("fin_invoices_customer_id_idx").on(t.customerId),
    index("fin_invoices_receivable_id_idx").on(t.receivableId),
  ],
);

/**
 * 工时成本率（arch/12 §7.2：user_id/role 二选一——按人价或按角色价；partner/finance 可维护，member 不可见金额）。
 */
export const finCostRates = pgTable(
  "fin_cost_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
    role: text("role"),
    hourlyRateCents: bigint("hourly_rate_cents", { mode: "number" }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    ...auditFour,
  },
  (t) => [
    check(
      "fin_cost_rates_duality_check",
      sql`(("user_id" is null and "role" is not null) or ("user_id" is not null and "role" is null))`,
    ),
    index("fin_cost_rates_user_id_idx").on(t.userId),
  ],
);
