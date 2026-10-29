import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { confidentialityLevelEnum, projectHealthStatusEnum, projectLifecycleStatusEnum } from "./enums";
import { users } from "./org";

/** 客户（arch/09 §4.2：停用落到行，status=active/disabled；非删除） */
export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  confidentialityLevel: confidentialityLevelEnum("confidentiality_level").notNull().default("internal"),
  status: text("status").notNull().default("active"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  rowVersion: integer("row_version").notNull().default(0),
});

/** 事项/案件（arch/01 §1；status=active/disabled，停用到行） */
export const matters = pgTable("matters", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  type: text("type").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  rowVersion: integer("row_version").notNull().default(0),
});

/** 项目（arch/01 §1 迭代 0 最小集；生命周期与健康度分离，arch/01 §3） */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    matterId: uuid("matter_id")
      .notNull()
      .references(() => matters.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    type: text("type").notNull().default(""),
    managerId: uuid("manager_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    confidentialityLevel: confidentialityLevelEnum("confidentiality_level").notNull().default("internal"),
    lifecycleStatus: projectLifecycleStatusEnum("lifecycle_status").notNull().default("preparing"),
    healthStatus: projectHealthStatusEnum("health_status").notNull().default("normal"),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    index("projects_matter_id_idx").on(t.matterId),
    index("projects_manager_id_idx").on(t.managerId),
    index("projects_lifecycle_status_idx").on(t.lifecycleStatus),
  ],
);

/** 项目成员，PK(project_id, user_id)；项目内角色是 ABAC 关键输入（arch/03 §2） */
export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    projectRole: text("project_role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("project_members_user_id_idx").on(t.userId),
  ],
);
