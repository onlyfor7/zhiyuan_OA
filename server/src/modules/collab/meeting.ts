import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import {
  decisions,
  fileObjects,
  fileVersions,
  meetingActionItems,
  meetingMinutes,
  meetingParticipants,
  meetings,
  tasks,
} from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { requireProjectMember, requireProjectRead } from "../../services/access";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "../governance/util";

/**
 * 会议域 service（arch/05 §3/§4/§5）。
 * 关键事务：纪要确认（确认+版本固定+归档 09+通知+审计同事务，§4.1）、
 * 行动项转任务（source 链+converted 回填+幂等，§4.2）、分歧转决策（§4.3）。
 * 权限：项目成员或参会人可见；参会人≠成员时仅可见该会议；外部参与人不建账号不赋权。
 */

export interface ParticipantInput {
  userId?: string;
  externalName?: string;
  externalOrg?: string;
  role?: "required" | "optional";
}

async function loadMeeting(db: DbOrTx, meetingId: string) {
  const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  if (!meeting) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "会议不存在或无权访问");
  return meeting;
}

async function isParticipant(db: DbOrTx, meetingId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: meetingParticipants.id })
    .from(meetingParticipants)
    .where(and(eq(meetingParticipants.meetingId, meetingId), eq(meetingParticipants.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** 可见性：项目成员 ∨ 参会人（参会人≠成员时仅可见该会议） */
export async function canSeeMeeting(db: DbOrTx, user: SessionUser, meetingId: string): Promise<boolean> {
  const meeting = await loadMeeting(db, meetingId);
  if (user.projectRoles.has(meeting.projectId)) return true;
  return isParticipant(db, meetingId, user.id);
}

export async function requireMeetingVisible(db: DbOrTx, user: SessionUser, meetingId: string) {
  const meeting = await loadMeeting(db, meetingId);
  const visible = (await canSeeMeeting(db, user, meetingId)) as boolean;
  if (!visible) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "会议不存在或无权访问");
  }
  return meeting;
}

/** 变更权：项目成员（参会人不可改会议） */
async function requireMeetingManage(db: DbOrTx, user: SessionUser, meetingId: string) {
  const meeting = await loadMeeting(db, meetingId);
  // 写门（06 打回修复）：成员∪有效授权；partner 全局只读不放行
  await requireProjectMember(db, user, meeting.projectId);
  return meeting;
}

/* ===== 查询 ===== */

export interface ListMeetingsInput {
  projectId?: string;
  mine?: boolean;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  cursor?: string;
  limit: number;
}

export async function listMeetings(db: DbOrTx, user: SessionUser, input: ListMeetingsInput) {
  const conditions: (SQL | undefined)[] = [];
  if (input.projectId) {
    await requireProjectRead(db, user, input.projectId);
    conditions.push(eq(meetings.projectId, input.projectId));
  } else if (input.mine) {
    // 我组织的/参会的/记录的（含非成员会议）
    conditions.push(
      sql`${meetings.id} IN (
        SELECT meeting_id FROM meeting_participants WHERE user_id = ${user.id}
        UNION SELECT id FROM meetings WHERE organizer_id = ${user.id} OR recorder_id = ${user.id}
      )`,
    );
  } else {
    // 全量：成员项目 ∪ 我参会的
    conditions.push(
      sql`(${meetings.projectId} IN (SELECT project_id FROM project_members WHERE user_id = ${user.id})
        OR ${meetings.id} IN (SELECT meeting_id FROM meeting_participants WHERE user_id = ${user.id}))`,
    );
  }
  if (input.dateFrom) conditions.push(gte(meetings.startAt, input.dateFrom));
  if (input.dateTo) conditions.push(lte(meetings.startAt, `${input.dateTo}T23:59:59.999Z`));
  if (input.status) conditions.push(eq(meetings.status, input.status as "planned"));
  conditions.push(cursorCondition(input.cursor, meetings.createdAt, meetings.id));

  const rows = await db
    .select({ meeting: meetings, organizerName: sql<string>`(SELECT name FROM users WHERE id = ${meetings.organizerId})` })
    .from(meetings)
    .where(and(...conditions))
    .orderBy(desc(meetings.startAt), desc(meetings.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ ...r.meeting, organizerName: r.organizerName })),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.meeting.createdAt, last.meeting.id) : null,
  };
}

export async function getMeetingById(db: DbOrTx, user: SessionUser, meetingId: string) {
  const meeting = await requireMeetingVisible(db, user, meetingId);
  const participants = await db
    .select({
      id: meetingParticipants.id,
      userId: meetingParticipants.userId,
      externalName: meetingParticipants.externalName,
      externalOrg: meetingParticipants.externalOrg,
      role: meetingParticipants.role,
      attendance: meetingParticipants.attendance,
      notifyContact: meetingParticipants.notifyContact,
      userName: sql<string | null>`(SELECT name FROM users WHERE id = ${meetingParticipants.userId})`,
    })
    .from(meetingParticipants)
    .where(eq(meetingParticipants.meetingId, meetingId))
    .orderBy(asc(meetingParticipants.role), asc(meetingParticipants.id));
  const minutesVersions = await db
    .select()
    .from(meetingMinutes)
    .where(eq(meetingMinutes.meetingId, meetingId))
    .orderBy(asc(meetingMinutes.versionNo));
  const actionItems = await db
    .select({
      item: meetingActionItems,
      taskStatus: tasks.status,
      taskCode: tasks.code,
    })
    .from(meetingActionItems)
    .leftJoin(tasks, eq(tasks.id, meetingActionItems.convertedTaskId))
    .where(eq(meetingActionItems.meetingId, meetingId))
    .orderBy(asc(meetingActionItems.createdAt));
  const linkedDecisions = await db
    .select({ id: decisions.id, code: decisions.code, title: decisions.title, status: decisions.status })
    .from(decisions)
    .where(and(eq(decisions.sourceType, "meeting"), eq(decisions.sourceId, meetingId)));
  const materials = await db
    .select({
      fileVersionId: fileVersions.id,
      storageKey: fileVersions.storageKey,
      mimeType: fileVersions.mimeType,
      sizeBytes: fileVersions.sizeBytes,
      sha256: fileVersions.sha256,
      uploadedAt: fileVersions.uploadedAt,
    })
    .from(fileObjects)
    .innerJoin(fileVersions, eq(fileVersions.fileObjectId, fileObjects.id))
    .where(and(eq(fileObjects.sourceType, "meeting"), eq(fileObjects.sourceId, meetingId)))
    .orderBy(asc(fileVersions.uploadedAt));
  return {
    ...meeting,
    participants,
    minutesVersions,
    actionItems: actionItems.map((r) => ({ ...r.item, taskStatus: r.taskStatus, taskCode: r.taskCode })),
    linkedDecisions,
    materials: materials.map((m) => ({ ...m, name: m.storageKey.split("/").pop() })),
  };
}

/* ===== 创建/更新/流转 ===== */

const TYPE_DEFAULT_AGENDA: Record<string, string> = {
  project: "1. 项目进展同步\n2. 风险与问题\n3. 下阶段安排",
  client: "1. 客户服务事项沟通\n2. 需求确认\n3. 后续行动项",
  quality_review: "1. 质量检查项复核\n2. 问题分级与指派\n3. 整改时限确认",
  weekly: "1. 本周完成\n2. 下周计划\n3. 阻塞事项",
  decision: "1. 方案陈述\n2. 意见收集\n3. 结论与检查点",
};

export interface CreateMeetingInput {
  projectId: string;
  type: "project" | "client" | "quality_review" | "weekly" | "decision";
  subject: string;
  agenda?: string;
  startAt: string;
  endAt: string;
  location?: string;
  onlineUrl?: string;
  recorderId?: string;
  minutesRequired?: boolean;
  participants: ParticipantInput[];
}

function validateMeetingTimes(startAt: string, endAt: string): void {
  if (Number.isNaN(Date.parse(startAt)) || Number.isNaN(Date.parse(endAt))) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "时间格式须为 ISO 8601", {
      startAt: ["时间格式须为 ISO 8601"],
    });
  }
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "结束时间必须晚于开始时间", {
      endAt: ["结束时间必须晚于开始时间"],
    });
  }
}

async function insertParticipants(
  db: DbOrTx,
  meetingId: string,
  participants: ParticipantInput[],
  organizerId: string,
): Promise<void> {
  for (const p of participants) {
    const hasUser = !!p.userId;
    const hasExternal = !!p.externalName?.trim();
    if (hasUser === hasExternal) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "参与人须为内部用户或外部姓名恰一", {
        participants: ["userId 与 externalName 恰一非空"],
      });
    }
    await db.insert(meetingParticipants).values({
      meetingId,
      userId: p.userId ?? null,
      externalName: hasExternal ? p.externalName!.trim() : null,
      externalOrg: p.externalOrg?.trim() || null,
      role: p.role ?? "required",
    });
  }
  // 组织者默认参会（缺省时）
  const organizerIncluded = participants.some((p) => p.userId === organizerId);
  if (!organizerIncluded) {
    await db.insert(meetingParticipants).values({ meetingId, userId: organizerId, role: "required" });
  }
}

export async function createMeeting(
  db: DbOrTx,
  user: SessionUser,
  input: CreateMeetingInput,
): Promise<{ id: string; code: string }> {
  await requireProjectMember(db, user, input.projectId);
  validateMeetingTimes(input.startAt, input.endAt);
  if (input.participants.length === 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "至少一名参与人", {
      participants: ["至少一名参与人"],
    });
  }
  const code = await nextCode("MTG", db);
  const [meeting] = await db
    .insert(meetings)
    .values({
      projectId: input.projectId,
      code,
      type: input.type,
      subject: input.subject,
      agenda: input.agenda?.trim() || TYPE_DEFAULT_AGENDA[input.type] || null,
      startAt: input.startAt,
      endAt: input.endAt,
      location: input.location?.trim() || null,
      onlineUrl: input.onlineUrl?.trim() || null,
      organizerId: user.id,
      recorderId: input.recorderId ?? null,
      minutesStatus: input.minutesRequired === false ? "none_required" : "pending_draft",
      status: "planned",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: meetings.id, code: meetings.code });
  if (!meeting) throw new Error("会议插入失败");
  await insertParticipants(db, meeting.id, input.participants, user.id);
  return meeting;
}

export async function updateMeeting(
  db: DbOrTx,
  user: SessionUser,
  input: {
    id: string;
    rowVersion: number;
    subject?: string;
    agenda?: string;
    startAt?: string;
    endAt?: string;
    location?: string | null;
    onlineUrl?: string | null;
    participants?: ParticipantInput[];
  },
): Promise<void> {
  const meeting = await requireMeetingManage(db, user, input.id);
  if (meeting.status !== "planned") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅 planned 态可修改会议");
  }
  const startAt = input.startAt ?? meeting.startAt;
  const endAt = input.endAt ?? meeting.endAt;
  validateMeetingTimes(startAt, endAt);
  const updated = await db
    .update(meetings)
    .set({
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.agenda !== undefined ? { agenda: input.agenda } : {}),
      startAt,
      endAt,
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.onlineUrl !== undefined ? { onlineUrl: input.onlineUrl } : {}),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${meetings.rowVersion} + 1`,
    })
    .where(and(eq(meetings.id, input.id), eq(meetings.rowVersion, input.rowVersion)))
    .returning({ id: meetings.id });
  if (!updated[0]) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  }
  if (input.participants) {
    await db.delete(meetingParticipants).where(eq(meetingParticipants.meetingId, input.id));
    await insertParticipants(db, input.id, input.participants, meeting.organizerId);
  }
}

export async function transitionMeeting(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; action: "complete" | "cancel"; reason?: string; actualStartAt?: string; actualEndAt?: string },
) {
  const meeting = await requireMeetingManage(db, user, input.id);
  const now = nowIso();
  if (input.action === "complete") {
    if (meeting.status !== "planned") {
      throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅 planned 会议可标记完成");
    }
    const [updated] = await db
      .update(meetings)
      .set({
        status: "completed",
        actualStartAt: input.actualStartAt ?? meeting.startAt,
        actualEndAt: input.actualEndAt ?? meeting.endAt,
        updatedBy: user.id,
        updatedAt: now,
        rowVersion: sql`${meetings.rowVersion} + 1`,
      })
      .where(and(eq(meetings.id, input.id), eq(meetings.status, "planned")))
      .returning();
    if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "会议状态已变化");
    return updated;
  }
  // cancel：必填 reason；无工时建议、不产归档（arch/05 §3）
  if (!input.reason?.trim()) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "取消会议必须填写原因", {
      reason: ["取消会议必须填写原因"],
    });
  }
  if (meeting.status !== "planned") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅 planned 会议可取消");
  }
  const [updated] = await db
    .update(meetings)
    .set({
      status: "cancelled",
      cancelReason: input.reason.trim(),
      updatedBy: user.id,
      updatedAt: now,
      rowVersion: sql`${meetings.rowVersion} + 1`,
    })
    .where(and(eq(meetings.id, input.id), eq(meetings.status, "planned")))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "会议状态已变化");
  return updated;
}

export async function recordAttendance(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; entries: Array<{ participantId: string; attendance: "planned" | "attended" | "absent" | "excused" }> },
) {
  await requireMeetingManage(db, user, input.id);
  for (const entry of input.entries) {
    await db
      .update(meetingParticipants)
      .set({ attendance: entry.attendance })
      .where(and(eq(meetingParticipants.id, entry.participantId), eq(meetingParticipants.meetingId, input.id)));
  }
  return { ok: true as const };
}
