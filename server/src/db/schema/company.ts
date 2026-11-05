import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./org";

/**
 * 公司信息（单记录表，arch/12 §9）：发票抬头与合同水印引用。
 * 部分唯一索引强制全表至多一行。
 */
export const companyProfile = pgTable(
  "company_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    creditCode: text("credit_code").notNull().default(""),
    address: text("address").notNull().default(""),
    phone: text("phone").notNull().default(""),
    bankName: text("bank_name").notNull().default(""),
    bankAccount: text("bank_account").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    rowVersion: integer("row_version").notNull().default(0),
  },
  () => [uniqueIndex("company_profile_single_record").on(sql`(true)`)],
);
