import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./org";
import { sessions } from "./org";

/**
 * 审计事件（arch/01 §1）：只追加，无 update/delete 路径（arch/00 §3.9）。
 * ORM 层不提供本表的 update/delete 方法（drizzle 默认全量 CRUD，调用方自律 + 后续可用 DB 角色权限加固）。
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id"),
    result: text("result").notNull(),
    beforeJson: jsonb("before_json").$type<Record<string, unknown> | null>(),
    afterJson: jsonb("after_json").$type<Record<string, unknown> | null>(),
    ip: text("ip"),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("audit_events_actor_created_at_idx").on(t.actorId, t.createdAt)],
);
