import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { customFormStatusEnum } from "./enums";
import { users } from "./org";
import { flowDefinitions } from "./extensions";

/**
 * 自定义表单定义（arch/14 §4.1）：四步向导「表单设计」落点，1:1 绑定流程（bizBinding=custom_form:<code>）。
 */
export const customFormDefs = pgTable(
  "custom_form_defs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** CF-YYYY-NNNNN，走 next_code 序列（arch/14 §5） */
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** 图标 key（允许 NULL） */
    icon: text("icon"),
    groupName: text("group_name").notNull().default("通用"),
    /** 谁可以提交：{mode:"all"|"roles"|"users", roleKeys?: string[], userIds?: string[]} */
    visibility: jsonb("visibility").$type<Record<string, unknown>>().notNull(),
    /** {fields: FormFieldDef[]}（shared 类型；服务端按此校验 payload——20-02 落地） */
    formSchema: jsonb("form_schema").$type<Record<string, unknown>>().notNull(),
    formVersion: integer("form_version").notNull().default(1),
    /** 1:1 绑定流程（部分唯一索引：null 不占用） */
    flowId: uuid("flow_id").references(() => flowDefinitions.id, { onDelete: "restrict" }),
    status: customFormStatusEnum("status").notNull().default("draft"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    uniqueIndex("custom_form_defs_flow_id_unique").on(t.flowId).where(sql`flow_id is not null`),
    index("custom_form_defs_status_idx").on(t.status),
    index("custom_form_defs_group_name_idx").on(t.groupName),
  ],
);
