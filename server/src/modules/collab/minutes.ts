import { and, asc, desc, eq, sql } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { decisions, meetingActionItems, meetingMinutes, meetingParticipants, meetings, tasks } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { requireProjectRead } from "../../services/access";
import { notify } from "../../modules/notify";
import { linkMaterialFiles, linkSourceByDirKey } from "../governance/archive";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { nowIso } from "../governance/util";
import { requireMeetingVisible } from "./meeting";

/**
 * 会议纪要版本链 + 行动项 + 分歧转决策（arch/05 §3/§4/§5）。
 * 确认后本行只读，修改产新版本（版本链，B2）；行动项转换同事务与幂等（§4.2）。
 */

const DIR_09 = "09_会议纪要与协同";

async function currentDraftVersion(db: DbOrTx, meetingId: string) {
  return db
    .select()
    .from(meetingMinutes)
    .where(eq(meetingMinutes.meetingId, meetingId))
    .orderBy(desc(meetingMinutes.versionNo))
    .limit(1);
}

/** 整理纪要：pending_draft 态编辑当前草稿；confirmed 后修改产新版本（旧版本不动） */
export async function saveMinutesDraft(
  db: DbOrTx,
  user: SessionUser,
  input: {
    meetingId: string;
    body: string;
    disagreements?: string | null;
    risks?: string | null;
    rowVersion?: number;
  },
) {
  const meeting = await requireMeetingVisible(db, user, input.meetingId);
  await requireProjectRead(db, user, meeting.projectId);
  if (meeting.status === "cancelled") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已取消会议不可整理纪要");
  }
  const latest = (await currentDraftVersion(db, input.meetingId))[0];
  const now = nowIso();

  if (latest && latest.confirmedAt === null) {
    // 编辑当前未确认草稿（纪要版本行无乐观锁列，会议行 row_version 在提交/确认时维护）
    const updated = await db
      .update(meetingMinutes)
      .set({
        body: input.body,
        disagreements: input.disagreements ?? null,
        risks: input.risks ?? null,
        recorderId: user.id,
      })
      .where(eq(meetingMinutes.id, latest.id))
      .returning();
    if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "纪要版本已变化");
    await db
      .update(meetings)
      .set({ minutesStatus: "pending_draft", updatedBy: user.id, updatedAt: now })
      .where(eq(meetings.id, input.meetingId));
    return updated[0];
  }

  // confirmed（或首个草稿）：产新版本，版本链不覆盖
  const versionNo = (latest?.versionNo ?? 0) + 1;
  const [draft] = await db
    .insert(meetingMinutes)
    .values({
      meetingId: input.meetingId,
      versionNo,
      body: input.body,
      disagreements: input.disagreements ?? null,
      risks: input.risks ?? null,
      recorderId: user.id,
      createdBy: user.id,
    })
    .returning();
  if (!draft) throw new Error("纪要插入失败");
  await db
    .update(meetings)
    .set({ minutesStatus: "pending_draft", updatedBy: user.id, updatedAt: now, rowVersion: sql`${meetings.rowVersion} + 1` })
    .where(eq(meetings.id, input.meetingId));
  return draft;
}

/** 提交确认：草稿 → pending_confirm，指定确认人并通知（minutes_pending_confirm） */
export async function submitMinutesConfirm(
  db: DbOrTx,
  user: SessionUser,
  input: { meetingId: string; versionNo: number; confirmerId: string },
) {
  const meeting = await requireMeetingVisible(db, user, input.meetingId);
  await requireProjectRead(db, user, meeting.projectId);
  const [minutes] = await db
    .select()
    .from(meetingMinutes)
    .where(and(eq(meetingMinutes.meetingId, input.meetingId), eq(meetingMinutes.versionNo, input.versionNo)))
    .limit(1);
  if (!minutes || minutes.confirmedAt !== null) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "纪要版本不存在或已确认");
  }
  const updated = await db
    .update(meetingMinutes)
    .set({ confirmerId: input.confirmerId })
    .where(and(eq(meetingMinutes.id, minutes.id), sql`${meetingMinutes.confirmedAt} is null`))
    .returning();
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "纪要状态已变化");
  await db
    .update(meetings)
    .set({ minutesStatus: "pending_confirm", updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${meetings.rowVersion} + 1` })
    .where(eq(meetings.id, input.meetingId));
  await notify(db, {
    eventType: "minutes_pending_confirm",
    recipientId: input.confirmerId,
    sourceType: "meeting",
    sourceId: input.meetingId,
    payload: { meetingCode: meeting.code, versionNo: input.versionNo },
  });
  return updated[0];
}

/**
 * 纪要确认（arch/05 §4.1 关键事务）：确认+版本固定+归档 09（纪要来源对+材料文件）
 * +确认人/记录人通知+审计，同一事务完成；幂等（条件更新，重放返回现状）。
 */
export async function confirmMinutes(
  db: DbOrTx,
  user: SessionUser,
  input: { meetingId: string; versionNo: number; idempotencyKey: string },
) {
  const meeting = await requireMeetingVisible(db, user, input.meetingId);
  const [minutes] = await db
    .select()
    .from(meetingMinutes)
    .where(and(eq(meetingMinutes.meetingId, input.meetingId), eq(meetingMinutes.versionNo, input.versionNo)))
    .limit(1);
  if (!minutes) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "纪要版本不存在");
  if (minutes.confirmerId !== user.id) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅指定确认人可确认纪要");
  }
  const now = nowIso();
  const [confirmed] = await db
    .update(meetingMinutes)
    .set({ confirmedAt: now, confirmerId: user.id })
    .where(
      and(
        eq(meetingMinutes.id, minutes.id),
        sql`${meetingMinutes.confirmedAt} is null`,
      ),
    )
    .returning();
  if (!confirmed) {
    // 幂等重放：已确认则返回现状
    const [current] = await db
      .select()
      .from(meetingMinutes)
      .where(eq(meetingMinutes.id, minutes.id))
      .limit(1);
    return { minutes: current, meeting, replayed: true as const };
  }
  await db
    .update(meetings)
    .set({ minutesStatus: "confirmed", updatedBy: user.id, updatedAt: now, rowVersion: sql`${meetings.rowVersion} + 1` })
    .where(eq(meetings.id, input.meetingId));

  // 自动归档 09：纪要来源对 + 全部材料文件（同一文件不重复存储，唯一约束去重）
  await linkSourceByDirKey(db, {
    projectId: meeting.projectId,
    dirKey: DIR_09,
    sourceType: "meeting",
    sourceId: meeting.id,
    createdBy: user.id,
  });
  await linkMaterialFiles(db, {
    projectId: meeting.projectId,
    dirKey: DIR_09,
    sourceType: "meeting",
    sourceId: meeting.id,
    createdBy: user.id,
  });

  // 通知记录人与组织者（confirmed 语义：复用 minutes_pending_confirm 事件类型携带 confirmed 负载）
  const notifyTargets = new Set<string>([minutes.recorderId, meeting.organizerId]);
  for (const recipientId of notifyTargets) {
    await notify(db, {
      eventType: "minutes_pending_confirm",
      recipientId,
      sourceType: "meeting",
      sourceId: meeting.id,
      payload: { confirmed: true, versionNo: input.versionNo, code: meeting.code },
    });
  }
  return { minutes: confirmed, meeting, replayed: false as const };
}

export async function listMinutesVersions(db: DbOrTx, user: SessionUser, meetingId: string) {
  await requireMeetingVisible(db, user, meetingId);
  return db
    .select()
    .from(meetingMinutes)
    .where(eq(meetingMinutes.meetingId, meetingId))
    .orderBy(asc(meetingMinutes.versionNo));
}

/* ===== 行动项（§4.2：转换同事务、双向定位、任务状态单源 join） ===== */

export async function addActionItem(
  db: DbOrTx,
  user: SessionUser,
  input: {
    meetingId: string;
    minutesVersionId?: string;
    title: string;
    ownerId: string;
    dueDate: string;
    deliverable?: string;
    checkpoint?: string;
  },
) {
  const meeting = await requireMeetingVisible(db, user, input.meetingId);
  await requireProjectRead(db, user, meeting.projectId);
  const [item] = await db
    .insert(meetingActionItems)
    .values({
      meetingId: input.meetingId,
      minutesVersionId: input.minutesVersionId ?? null,
      title: input.title,
      ownerId: input.ownerId,
      dueDate: input.dueDate,
      deliverable: input.deliverable ?? null,
      checkpoint: input.checkpoint ?? null,
      status: "open",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!item) throw new Error("行动项插入失败");
  return item;
}

export async function convertActionItem(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; idempotencyKey: string },
) {
  const [item] = await db.select().from(meetingActionItems).where(eq(meetingActionItems.id, input.id)).limit(1);
  if (!item) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "行动项不存在");
  const meeting = await requireMeetingVisible(db, user, item.meetingId);
  await requireProjectRead(db, user, meeting.projectId);

  // 幂等：已转换 → 返回既有任务（重复转换被拦截，B3）
  if (item.status === "converted" && item.convertedTaskId) {
    const [existing] = await db.select().from(tasks).where(eq(tasks.id, item.convertedTaskId)).limit(1);
    return { task: existing, actionItem: item, replayed: true as const };
  }

  const now = nowIso();
  const taskCode = await nextCode("TSK", db);
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: meeting.projectId,
      code: taskCode,
      title: item.title,
      assigneeId: item.ownerId,
      plannedStart: item.dueDate,
      plannedEnd: item.dueDate,
      status: "pending",
      sourceType: "meeting",
      sourceId: item.id,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!task) throw new Error("任务插入失败");

  const updated = await db
    .update(meetingActionItems)
    .set({ status: "converted", convertedTaskId: task.id, updatedBy: user.id, updatedAt: now, rowVersion: sql`${meetingActionItems.rowVersion} + 1` })
    .where(and(eq(meetingActionItems.id, item.id), eq(meetingActionItems.status, "open")))
    .returning();
  if (!updated[0]) {
    // 并发转换：回滚本事务（任务不残留）
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "该行动项已被转换");
  }
  return { task, actionItem: updated[0], replayed: false as const };
}

export async function listActionItems(db: DbOrTx, user: SessionUser, meetingId: string) {
  await requireMeetingVisible(db, user, meetingId);
  return db
    .select({
      item: meetingActionItems,
      taskStatus: tasks.status,
      taskCode: tasks.code,
      taskId: tasks.id,
    })
    .from(meetingActionItems)
    .leftJoin(tasks, eq(tasks.id, meetingActionItems.convertedTaskId))
    .where(eq(meetingActionItems.meetingId, meetingId))
    .orderBy(asc(meetingActionItems.createdAt));
}

/* ===== 分歧转决策（§4.3：带入会议与纪要版本上下文） ===== */

export async function escalateToDecision(
  db: DbOrTx,
  user: SessionUser,
  input: { meetingId: string; minutesVersionId?: string; title: string; context: string },
) {
  const meeting = await requireMeetingVisible(db, user, input.meetingId);
  await requireProjectRead(db, user, meeting.projectId);
  let context = input.context;
  if (input.minutesVersionId) {
    const [version] = await db
      .select()
      .from(meetingMinutes)
      .where(and(eq(meetingMinutes.id, input.minutesVersionId), eq(meetingMinutes.meetingId, input.meetingId)))
      .limit(1);
    if (version) {
      context = `${context}\n\n〔会议上下文〕${meeting.code}《${meeting.subject}》纪要 V${version.versionNo}；分歧记录：${version.disagreements ?? "（无）"}`;
    }
  }
  const code = await nextCode("DEC", db);
  const [decision] = await db
    .insert(decisions)
    .values({
      projectId: meeting.projectId,
      code,
      title: input.title,
      context,
      sourceType: "meeting",
      sourceId: meeting.id,
      status: "draft",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: decisions.id, code: decisions.code });
  if (!decision) throw new Error("决策插入失败");
  return decision;
}

/* ===== 工时预填建议（MTG-010：只算不存，取消/无需纪要返回 null） ===== */

export async function meetingTimePrefill(db: DbOrTx, user: SessionUser, meetingId: string) {
  const meeting = await requireMeetingVisible(db, user, meetingId);
  if (meeting.status === "cancelled" || meeting.minutesStatus === "none_required") {
    return null;
  }
  const start = new Date(meeting.actualStartAt ?? meeting.startAt).getTime();
  const end = new Date(meeting.actualEndAt ?? meeting.endAt).getTime();
  const minutes = Math.max(0, Math.round((end - start) / 60_000));
  const attendees = await db
    .select({ userId: meetingParticipants.userId })
    .from(meetingParticipants)
    .where(and(eq(meetingParticipants.meetingId, meetingId), eq(meetingParticipants.attendance, "attended"), sql`${meetingParticipants.userId} is not null`));
  return {
    minutes,
    projectId: meeting.projectId,
    attendeeUserIds: attendees.map((a) => a.userId!).filter(Boolean),
  };
}
