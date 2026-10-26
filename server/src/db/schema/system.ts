import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./org";

/** 业务配置（arch/01 §1；键值 + JSON，默认值由种子写入需求基线 §18，arch/00 §7） */
export const systemConfig = pgTable("system_config", {
  key: text("key").primaryKey(),
  valueJson: jsonb("value_json").$type<Record<string, unknown>>().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

/** 业务编号序列表（arch/01 §1；事务内自增见 server/src/db/code.ts） */
export const codeSequences = pgTable(
  "code_sequences",
  {
    prefix: text("prefix").notNull(),
    year: integer("year").notNull(),
    nextValue: integer("next_value").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.prefix, t.year] })],
);

/** 通知（arch/01 §1 迭代 0 建表，写入逻辑随业务迭代启用） */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id"),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown> | null>(),
    readAt: timestamp("read_at", { withTimezone: true, mode: "string" }),
    handledAt: timestamp("handled_at", { withTimezone: true, mode: "string" }),
    aggregateKey: text("aggregate_key"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("notifications_recipient_read_at_idx").on(t.recipientId, t.readAt)],
);
