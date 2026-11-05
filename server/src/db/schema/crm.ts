import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import {
  contractStatusEnum,
  followupTargetTypeEnum,
  leadStatusEnum,
  opportunityStageEnum,
  paymentPlanStatusEnum,
} from "./enums";
import { users } from "./org";
import { clients, matters } from "./business";
import { paymentReceipts } from "./extensions";

/** 通用审计四件套字段（arch/01 §2） */
const auditFour = {
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
};

/** 线索（arch/12 §6.2：new→contacted→qualified→converted / disqualified〔原因必填〕） */
export const crmLeads = pgTable(
  "crm_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    source: text("source").notNull().default(""),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    status: leadStatusEnum("status").notNull().default("new"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "restrict" }),
    disqualifiedReason: text("disqualified_reason"),
    convertedCustomerId: uuid("converted_customer_id").references((): AnyPgColumn => clients.id, {
      onDelete: "restrict",
    }),
    convertedOpportunityId: uuid("converted_opportunity_id").references(
      (): AnyPgColumn => crmOpportunities.id,
      { onDelete: "restrict" },
    ),
    convertedAt: timestamp("converted_at", { withTimezone: true, mode: "string" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    index("crm_leads_status_idx").on(t.status),
    index("crm_leads_owner_id_idx").on(t.ownerId),
  ],
);

/** 客户联系人（arch/12 §6.2） */
export const crmContacts = pgTable(
  "crm_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    title: text("title"),
    phone: text("phone"),
    email: text("email"),
    isPrimary: boolean("is_primary").notNull().default(false),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [index("crm_contacts_customer_id_idx").on(t.customerId)],
);

/** 商机（arch/12 §6.2：initial→needs→proposal→negotiation→won / lost；won 必挂合同） */
export const crmOpportunities = pgTable(
  "crm_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    stage: opportunityStageEnum("stage").notNull().default("initial"),
    expectedAmountCents: bigint("expected_amount_cents", { mode: "number" }),
    winRate: integer("win_rate"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "restrict" }),
    wonContractId: uuid("won_contract_id").references((): AnyPgColumn => crmContracts.id, {
      onDelete: "restrict",
    }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    index("crm_opportunities_customer_id_idx").on(t.customerId),
    index("crm_opportunities_stage_idx").on(t.stage),
  ],
);

/** 合同（arch/12 §6.2：draft→active→completed / terminated） */
export const crmContracts = pgTable(
  "crm_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => crmOpportunities.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    matterId: uuid("matter_id").references(() => matters.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true, mode: "string" }),
    status: contractStatusEnum("status").notNull().default("draft"),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    index("crm_contracts_customer_id_idx").on(t.customerId),
    index("crm_contracts_opportunity_id_idx").on(t.opportunityId),
  ],
);

/** 合同付款计划（arch/12 §6.2：unique(contract_id, seq)；与收款台账勾稽由 9d/服务端核销写回） */
export const crmContractPaymentPlans = pgTable(
  "crm_contract_payment_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => crmContracts.id, { onDelete: "restrict" }),
    seq: integer("seq").notNull(),
    dueDate: date("due_date").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    status: paymentPlanStatusEnum("status").notNull().default("unpaid"),
    receiptId: uuid("receipt_id").references(() => paymentReceipts.id, { onDelete: "restrict" }),
    ...auditFour,
  },
  (t) => [
    unique("crm_contract_payment_plans_contract_seq_unique").on(t.contractId, t.seq),
    index("crm_contract_payment_plans_contract_id_idx").on(t.contractId),
  ],
);

/** 跟进记录（arch/12 §6.2：多态 target=lead/opportunity/customer，check 强制） */
export const crmFollowups = pgTable(
  "crm_followups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetType: followupTargetTypeEnum("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    content: text("content").notNull(),
    nextAt: timestamp("next_at", { withTimezone: true, mode: "string" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("crm_followups_target_idx").on(t.targetType, t.targetId)],
);
