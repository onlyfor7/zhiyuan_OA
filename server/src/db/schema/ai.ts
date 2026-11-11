import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./org";

/**
 * AI 用量事件（arch/12 §17.6）：ai.chat 每调用必记——
 * MockProvider 按 chars/4 估算，真实提供方取 usage 字段；种子零数据。
 */
export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    capability: text("capability").notNull().default(""),
    model: text("model").notNull().default(""),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("ai_usage_events_user_created_idx").on(t.userId, t.createdAt)],
);
