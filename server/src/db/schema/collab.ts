import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  actionItemStatusEnum,
  attendanceStatusEnum,
  confidentialityLevelEnum,
  meetingStatusEnum,
  meetingTypeEnum,
  minutesStatusEnum,
  participantRoleEnum,
  segmentTypeEnum,
  travelEventActionEnum,
  travelStatusEnum,
} from "./enums";
import { fileVersions } from "./files";
import { users } from "./org";
import { projects } from "./business";
import { tasks } from "./governance";
import { approvalInstances } from "./governance";

/** 通用审计四件套字段（arch/01 §2） */
const auditFour = {
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
};

/* ===== arch/05 §2.1 会议域 ===== */

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    type: meetingTypeEnum("type").notNull(),
    subject: text("subject").notNull(),
    agenda: text("agenda"),
    startAt: timestamp("start_at", { withTimezone: true, mode: "string" }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true, mode: "string" }).notNull(),
    location: text("location"),
    onlineUrl: text("online_url"),
    organizerId: uuid("organizer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    recorderId: uuid("recorder_id").references(() => users.id, { onDelete: "restrict" }),
    confidentialityLevel: confidentialityLevelEnum("confidentiality_level").notNull().default("internal"),
    status: meetingStatusEnum("status").notNull().default("planned"),
    minutesStatus: minutesStatusEnum("minutes_status").notNull().default("pending_draft"),
    cancelReason: text("cancel_reason"),
    actualStartAt: timestamp("actual_start_at", { withTimezone: true, mode: "string" }),
    actualEndAt: timestamp("actual_end_at", { withTimezone: true, mode: "string" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    check("meetings_time_check", sql`"end_at" > "start_at"`),
    index("meetings_project_id_idx").on(t.projectId),
    index("meetings_status_idx").on(t.status),
  ],
);

/**
 * 会议参与人（含外部最小信息，不建账号不赋权）。
 * 二态：user_id 与 external_name 恰一非空（check）。
 */
export const meetingParticipants = pgTable(
  "meeting_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
    externalName: text("external_name"),
    externalOrg: text("external_org"),
    role: participantRoleEnum("role").notNull().default("required"),
    attendance: attendanceStatusEnum("attendance").notNull().default("planned"),
    notifyContact: text("notify_contact"),
  },
  (t) => [
    check(
      "meeting_participants_duality_check",
      sql`(("user_id" is not null and "external_name" is null) or ("user_id" is null and "external_name" is not null))`,
    ),
    // 同一会议同一内部用户不重复报名（部分索引；外部参与人按姓名不唯一约束）
    uniqueIndex("meeting_participants_user_unique").on(t.meetingId, t.userId).where(sql`user_id is not null`),
    index("meeting_participants_meeting_id_idx").on(t.meetingId),
  ],
);

/** 会议纪要版本链（unique(meeting_id, version_no)；确认后本行只读，修改产新版本，arch/05 §2.1） */
export const meetingMinutes = pgTable(
  "meeting_minutes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "restrict" }),
    versionNo: integer("version_no").notNull(),
    body: text("body").notNull(),
    disagreements: text("disagreements"),
    risks: text("risks"),
    recorderId: uuid("recorder_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    confirmerId: uuid("confirmer_id").references(() => users.id, { onDelete: "restrict" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
    fileVersionId: uuid("file_version_id").references(() => fileVersions.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [unique("meeting_minutes_version_unique").on(t.meetingId, t.versionNo)],
);

/** 会议行动项（open → converted 不可逆；任务状态以 tasks 为准不复制，arch/05 §3） */
export const meetingActionItems = pgTable(
  "meeting_action_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "restrict" }),
    minutesVersionId: uuid("minutes_version_id").references(() => meetingMinutes.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    dueDate: date("due_date").notNull(),
    deliverable: text("deliverable"),
    checkpoint: text("checkpoint"),
    status: actionItemStatusEnum("status").notNull().default("open"),
    convertedTaskId: uuid("converted_task_id").references(() => tasks.id, { onDelete: "restrict" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [index("meeting_action_items_meeting_id_idx").on(t.meetingId)],
);

/* ===== arch/05 §2.1 出差域 ===== */

export const travelRequests = pgTable(
  "travel_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    applicantId: uuid("applicant_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    destination: text("destination").notNull(),
    startOn: date("start_on").notNull(),
    endOn: date("end_on").notNull(),
    /** 仅提示用途，绝不写预算台账（TRV-004） */
    estimatedCostCents: bigint("estimated_cost_cents", { mode: "number" }),
    borrow: boolean("borrow").notNull().default(false),
    borrowAmountCents: bigint("borrow_amount_cents", { mode: "number" }),
    status: travelStatusEnum("status").notNull().default("draft"),
    approvalInstanceId: uuid("approval_instance_id").references(() => approvalInstances.id, { onDelete: "restrict" }),
    completionSummary: text("completion_summary"),
    actualCostNote: text("actual_cost_note"),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    ...auditFour,
    rowVersion: integer("row_version").notNull().default(0),
  },
  (t) => [
    index("travel_requests_project_id_idx").on(t.projectId),
    index("travel_requests_applicant_id_idx").on(t.applicantId),
    index("travel_requests_status_idx").on(t.status),
  ],
);

/** 出差分段行程（同单内 seq 顺序 start_at 不得倒挂由 API 校验；全 FK RESTRICT） */
export const travelSegments = pgTable(
  "travel_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    travelRequestId: uuid("travel_request_id")
      .notNull()
      .references(() => travelRequests.id, { onDelete: "restrict" }),
    seq: integer("seq").notNull(),
    type: segmentTypeEnum("type").notNull(),
    startAt: timestamp("start_at", { withTimezone: true, mode: "string" }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true, mode: "string" }).notNull(),
    fromPlace: text("from_place"),
    toPlace: text("to_place"),
    description: text("description"),
    linkedMeetingId: uuid("linked_meeting_id").references(() => meetings.id, { onDelete: "restrict" }),
    linkedTaskId: uuid("linked_task_id").references(() => tasks.id, { onDelete: "restrict" }),
  },
  (t) => [index("travel_segments_travel_request_id_idx").on(t.travelRequestId)],
);

/** 出差事件流（只追加；关键字段变更历史以此为准，arch/05 §2.1） */
export const travelEvents = pgTable(
  "travel_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    travelRequestId: uuid("travel_request_id")
      .notNull()
      .references(() => travelRequests.id, { onDelete: "restrict" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    action: travelEventActionEnum("action").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("travel_events_travel_request_id_idx").on(t.travelRequestId)],
);
