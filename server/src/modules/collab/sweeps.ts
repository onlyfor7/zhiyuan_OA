import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { CONFIG_KEY } from "@lexflow/shared";

import {
  meetingActionItems,
  timeEntries,
  timesheetPeriods,
  meetingParticipants,
  meetings,
  projects,
  systemConfig,
  travelRequests,
} from "../../db/schema";
import { notify } from "../../modules/notify";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * 查询时判定 + 写入的通知（arch/05 §6）：
 * meeting_starting（开始前 30 分钟，聚合键=会议+日）、minutes_overdue（结束+配置期限，
 * 记录人 → 超期升级项目负责人）、travel_return_expense 超期升级、action_item_due（临期/逾期升级）。
 * 全部 ON CONFLICT DO NOTHING 幂等；由 list/getById/todo.mine 触发。
 */

const MINUTES = 60_000;

function businessDaysElapsed(fromMs: number, toMs: number): number {
  // 工作日流逝数（周一至周五），跨日会议按结束日起算
  let count = 0;
  const cursor = new Date(fromMs);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(toMs);
  end.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() < end.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

async function minutesDeadline(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ valueJson: systemConfig.valueJson })
    .from(systemConfig)
    .where(eq(systemConfig.key, CONFIG_KEY.MEETING_MINUTES_DEADLINE))
    .limit(1);
  const value = row?.valueJson as { defaultBusinessDays?: number } | undefined;
  return value?.defaultBusinessDays ?? 2;
}

async function visibleProjectIds(db: DbOrTx, user: SessionUser): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      sql`${projects.id} IN (SELECT project_id FROM project_members WHERE user_id = ${user.id})`,
    );
  return rows.map((r) => r.id);
}

/** 会议相关扫描（list/getById 调用） */
export async function sweepMeetings(db: DbOrTx, user: SessionUser): Promise<void> {
  const projectIds = await visibleProjectIds(db, user);
  const participantMeetingIds = (
    await db
      .select({ meetingId: meetingParticipants.meetingId })
      .from(meetingParticipants)
      .where(eq(meetingParticipants.userId, user.id))
  ).map((r) => r.meetingId);
  const scope: string[] = [...projectIds, ...participantMeetingIds];
  if (scope.length === 0) return;

  const nowMs = Date.now();
  // 直接按两组范围取数（drizzle inArray 空数组不安全，分开查后按 id 去重）
  const byId = new Map<string, typeof meetings.$inferSelect>();
  for (const row of projectIds.length > 0
    ? await db.select().from(meetings).where(inArray(meetings.projectId, projectIds))
    : []) {
    byId.set(row.id, row);
  }
  for (const row of participantMeetingIds.length > 0
    ? await db.select().from(meetings).where(inArray(meetings.id, participantMeetingIds))
    : []) {
    byId.set(row.id, row);
  }
  const rows = [...byId.values()];

  const deadline = await minutesDeadline(db);
  for (const meeting of rows) {
    // meeting_starting：planned 且 30 分钟内开始
    if (meeting.status === "planned") {
      const startMs = new Date(meeting.startAt).getTime();
      if (startMs >= nowMs && startMs - nowMs <= 30 * MINUTES) {
        const required = await db
          .select({ userId: meetingParticipants.userId })
          .from(meetingParticipants)
          .where(
            and(
              eq(meetingParticipants.meetingId, meeting.id),
              eq(meetingParticipants.role, "required"),
              sql`${meetingParticipants.userId} is not null`,
            ),
          );
        for (const p of required) {
          await notify(db, {
            eventType: "meeting_starting",
            recipientId: p.userId!,
            sourceType: "meeting",
            sourceId: meeting.id,
            payload: { code: meeting.code, subject: meeting.subject, startAt: meeting.startAt },
          });
        }
      }
    }
    // minutes_overdue：已结束、纪要未确认、工作日超配置期限；2 倍期限升级负责人
    if (meeting.status === "completed" && meeting.minutesStatus !== "confirmed" && meeting.minutesStatus !== "none_required") {
      const endMs = new Date(meeting.actualEndAt ?? meeting.endAt).getTime();
      const elapsed = businessDaysElapsed(endMs, nowMs);
      if (elapsed > deadline && meeting.recorderId) {
        await notify(db, {
          eventType: "minutes_overdue",
          recipientId: meeting.recorderId,
          sourceType: "meeting",
          sourceId: meeting.id,
          payload: { code: meeting.code, elapsedBusinessDays: elapsed, deadline },
        });
      }
      if (elapsed > deadline * 2) {
        const [project] = await db
          .select({ managerId: projects.managerId })
          .from(projects)
          .where(eq(projects.id, meeting.projectId))
          .limit(1);
        if (project?.managerId) {
          await notify(db, {
            eventType: "minutes_overdue",
            recipientId: project.managerId,
            sourceType: "meeting",
            sourceId: meeting.id,
            payload: { code: meeting.code, escalated: true, elapsedBusinessDays: elapsed },
          });
        }
      }
    }
  }
}

/** 出差相关扫描：返回报销提醒超期升级（完成后 6 天未闭环 → 项目负责人，一次） */
export async function sweepTravels(db: DbOrTx, user: SessionUser): Promise<void> {
  const projectIds = await visibleProjectIds(db, user);
  if (projectIds.length === 0) return;
  const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
  const overdue = await db
    .select({ travel: travelRequests, managerId: projects.managerId })
    .from(travelRequests)
    .innerJoin(projects, eq(projects.id, travelRequests.projectId))
    .where(
      and(
        inArray(travelRequests.projectId, projectIds),
        eq(travelRequests.status, "completed"),
        lt(travelRequests.completedAt, sixDaysAgo),
      ),
    );
  for (const row of overdue) {
    if (row.managerId && row.managerId !== row.travel.applicantId) {
      await notify(db, {
        eventType: "travel_return_expense",
        recipientId: row.managerId,
        sourceType: "travel",
        sourceId: row.travel.id,
        payload: { code: row.travel.code, escalated: true, note: "出差完成超 6 天未闭环" },
        aggregateKey: `travel_return_expense:${row.travel.id}:escalate:once`,
      });
    }
  }
}

/** 工时缺口/审批积压（arch/07 §7：timesheet_gap；锁定期临近仍有 draft/returned → 填报人；pending>48h → 审批人） */
export async function sweepTimesheets(db: DbOrTx, user: SessionUser): Promise<void> {
  void user;
  const nowMs = Date.now();
  const soonMs = nowMs + 2 * 86_400_000;
  const staleMs = nowMs - 48 * 3600_000;
  const fmtIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  const gaps = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        sql`${timesheetPeriods.status} in ('draft', 'returned')`,
        sql`${timesheetPeriods.periodEnd} <= ${fmtIso(soonMs)}`,
      ),
    )
    .limit(100);
  for (const period of gaps) {
    const count = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(timeEntries)
      .where(eq(timeEntries.periodId, period.id));
    if (Number(count[0].n) === 0) continue;
    await notify(db, {
      eventType: "timesheet_gap",
      recipientId: period.userId,
      sourceType: "time_entry",
      sourceId: period.id,
      payload: { periodCode: period.code, periodEnd: period.periodEnd, status: period.status },
    });
  }

  const backlog = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.status, "pending_approval"),
        sql`${timesheetPeriods.submittedAt} < ${new Date(staleMs).toISOString()}`,
        sql`${timesheetPeriods.approverId} is not null`,
      ),
    )
    .limit(100);
  for (const period of backlog) {
    if (!period.approverId) continue;
    await notify(db, {
      eventType: "timesheet_gap",
      recipientId: period.approverId,
      sourceType: "time_entry",
      sourceId: period.id,
      payload: { periodCode: period.code, submittedAt: period.submittedAt, backlog: true },
    });
  }
}

/** 行动项临期/逾期提醒（todo.mine 调用）：到期前 2 天与逾期当日，逾期升级项目负责人 */
export async function sweepActionItems(db: DbOrTx, user: SessionUser): Promise<void> {
  const projectIds = await visibleProjectIds(db, user);
  if (projectIds.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const items = await db
    .select({ item: meetingActionItems, managerId: projects.managerId })
    .from(meetingActionItems)
    .innerJoin(meetings, eq(meetings.id, meetingActionItems.meetingId))
    .innerJoin(projects, eq(projects.id, meetings.projectId))
    .where(and(eq(meetingActionItems.status, "open"), inArray(meetings.projectId, projectIds)));
  for (const row of items) {
    if (row.item.dueDate <= soon && row.item.dueDate >= today) {
      await notify(db, {
        eventType: "action_item_due",
        recipientId: row.item.ownerId,
        sourceType: "meeting",
        sourceId: row.item.meetingId,
        payload: { actionItemId: row.item.id, title: row.item.title, dueDate: row.item.dueDate },
      });
    }
    if (row.item.dueDate < today) {
      await notify(db, {
        eventType: "action_item_due",
        recipientId: row.item.ownerId,
        sourceType: "meeting",
        sourceId: row.item.meetingId,
        payload: { actionItemId: row.item.id, title: row.item.title, overdue: true },
      });
      if (row.managerId) {
        await notify(db, {
          eventType: "action_item_due",
          recipientId: row.managerId,
          sourceType: "meeting",
          sourceId: row.item.meetingId,
          payload: { actionItemId: row.item.id, title: row.item.title, escalated: true },
        });
      }
    }
  }
}
