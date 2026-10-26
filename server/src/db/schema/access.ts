import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { accessGrantScopeTypeEnum, accessGrantStatusEnum } from "./enums";
import { users } from "./org";

/** 临时授权（AccessGrant；状态机 arch/01 §3，生命周期 arch/03 §7） */
export const accessGrants = pgTable(
  "access_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    granteeId: uuid("grantee_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    scopeType: accessGrantScopeTypeEnum("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    actions: text("actions").array().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "restrict" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "restrict" }),
    revokeReason: text("revoke_reason"),
    status: accessGrantStatusEnum("status").notNull().default("pending_approval"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    index("access_grants_grantee_status_idx").on(t.granteeId, t.status),
    index("access_grants_scope_idx").on(t.scopeType, t.scopeId),
  ],
);
