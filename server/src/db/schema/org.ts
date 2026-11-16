import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { userStatusEnum } from "./enums";

/** 组织树（arch/01 §1；arch/12 §9 树化：parent_id 自引用 FK + sort 调序） */
export const orgUnits = pgTable(
  "org_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => orgUnits.id, { onDelete: "restrict" }),
    sort: integer("sort").notNull().default(0),
    /** 部门负责人（arch/14 §6 dept_head/to_dept_head；0017 追加可空列；无负责人→提交/发布如实报错） */
    leaderId: uuid("leader_id").references((): AnyPgColumn => orgUnits.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("org_units_parent_id_idx").on(t.parentId), index("org_units_leader_id_idx").on(t.leaderId)],
);

/** 用户（arch/01 §1；external_id 预留 SSO，arch/00 §4；arch/12 §9 增 position/employee_no/joined_at） */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: userStatusEnum("status").notNull().default("active"),
    externalId: text("external_id"),
    /** 首登强制改密标记落到行（arch/09 §4.2 裁定；替代 auth.must_change_password 临时配置键） */
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    orgUnitId: uuid("org_unit_id").references(() => orgUnits.id, { onDelete: "restrict" }),
    /** 岗位（arch/12 §9 员工信息维护：合伙人/项目负责人/财务主管/档案管理员/项目工程师…） */
    position: text("position").notNull().default(""),
    /** 工号（YN-001 序列；可空保持唯一，多行 null 不冲突） */
    employeeNo: text("employee_no").unique(),
    joinedAt: date("joined_at"),
    /** 直属主管（arch/13 §3.2：主管关系是权限数据；自引用 FK，DB 层仅禁自引用，多级成环由服务端校验） */
    managerId: uuid("manager_id").references((): AnyPgColumn => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    index("users_org_unit_id_idx").on(t.orgUnitId),
    index("users_status_idx").on(t.status),
    index("users_manager_id_idx").on(t.managerId),
    check("users_manager_not_self", sql`${t.managerId} is null or ${t.managerId} <> ${t.id}`),
  ],
);

/** 全局角色（arch/03 §1，8 角色种子） */
export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
});

/** 全局角色分配，PK(user_id, role_key)（arch/01 §1） */
export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    roleKey: text("role_key")
      .notNull()
      .references(() => roles.key, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleKey] })],
);

/** 服务端会话（arch/01 §1、arch/00 §4：token 散列、可撤销） */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);
