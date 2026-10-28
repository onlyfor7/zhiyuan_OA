import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { timeActivityTypeEnum, timeEntrySourceEnum, timesheetStatusEnum } from "./enums";
import { users } from "./org";
import { projects } from "./business";
import { meetings, travelRequests } from "./collab";
import { tasks } from "./governance";

/** 通用审计四件套字段（arch/01 §2） */
const auditFour = {
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
};

/** 工时周期（arch/07 §2；unique(user_id, period_start)；approver 提交时按 §4.2 解析） */
export const timesheetPeriods = pgTable(
  "timesheet_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    periodType: text("period_type").notNull().default("weekly"),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    status: timesheetStatusEnum("status").notNull().default("draft"),
    approverId: uuid("approver_id").references(() => users.id, { onDelete: "restrict" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    returnedNote: text("returned_note"),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
    lockedBy: uuid("locked_by").references(() => users.id, { onDelete: "restrict" }),
    lockReason: text("lock_reason"),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    unique("timesheet_periods_user_start_unique").on(t.userId, t.periodStart),
    index("timesheet_periods_user_id_idx").on(t.userId),
    index("timesheet_periods_status_idx").on(t.status),
  ],
);

/**
 * 工时明细（arch/07 §2）。
 * duration_minutes 整数分钟 >0（禁止浮点小时）；project_id 可空但此时活动类型必须为 internal_admin/other。
 */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    periodId: uuid("period_id")
      .notNull()
      .references(() => timesheetPeriods.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    meetingId: uuid("meeting_id").references(() => meetings.id, { onDelete: "restrict" }),
    travelId: uuid("travel_id").references(() => travelRequests.id, { onDelete: "restrict" }),
    activityType: timeActivityTypeEnum("activity_type").notNull(),
    workDate: date("work_date").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    /**
     * 时刻列（arch/07 §4.1 v1.1 收口项，评估结论=加列）：自午夜分钟数，可空。
     * 两行均填时重叠判定可升级为精确判定；缺省仍走原启发式（单日 >540min 警告）。
     * 校验：0<=start<=1439、1<=end<=1440、成对出现时 end>start（DB check 强制）。
     */
    startMinute: integer("start_minute"),
    endMinute: integer("end_minute"),
    description: text("description").notNull().default(""),
    billable: boolean("billable").notNull().default(true),
    source: timeEntrySourceEnum("source").notNull().default("manual"),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    check("time_entries_duration_positive", sql`"duration_minutes" > 0`),
    check("time_entries_start_minute_check", sql`"start_minute" is null or ("start_minute" >= 0 and "start_minute" <= 1439)`),
    check("time_entries_end_minute_check", sql`"end_minute" is null or ("end_minute" >= 1 and "end_minute" <= 1440)`),
    check(
      "time_entries_minute_order_check",
      sql`"start_minute" is null or "end_minute" is null or "end_minute" > "start_minute"`,
    ),
    check(
      "time_entries_nonproject_activity_check",
      sql`("project_id" is not null or "activity_type" in ('internal_admin', 'other'))`,
    ),
    index("time_entries_user_work_date_idx").on(t.userId, t.workDate),
    index("time_entries_project_work_date_idx").on(t.projectId, t.workDate),
    index("time_entries_period_id_idx").on(t.periodId),
  ],
);
