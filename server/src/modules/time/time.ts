import { and, desc, eq, ne, sql } from "drizzle-orm";

import { CONFIG_KEY, ERROR_CODE, type TimeActivityType } from "@lexflow/shared";

import { approvalInstances, meetings, projects, systemConfig, timeEntries, timesheetPeriods, travelRequests, travelSegments, users } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { requireProjectRead } from "../../services/access";
import * as engine from "../../services/approval/engine";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { nowIso } from "../governance/util";

/**
 * 工时填报域 service（arch/07 §3/§4/§6）。
 * 红线：整数分钟；单日 >24h 跨周期合并阻止；预填/复制只产草稿不计统计；
 * approved/locked 明细只读；unlock 专门授权+理由+审计。
 */

const DAY_MINUTES = 24 * 60;

export function mondayOf(date: Date): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function validationConfig(db: DbOrTx): Promise<{
  dailyMaxMinutes: number;
  regularThresholdMinutes: number;
}> {
  const [row] = await db
    .select({ valueJson: systemConfig.valueJson })
    .from(systemConfig)
    .where(eq(systemConfig.key, CONFIG_KEY.TIMESHEET_VALIDATION))
    .limit(1);
  const value = (row?.valueJson ?? {}) as { dailyMaxMinutes?: number; regularThresholdMinutes?: number };
  return {
    dailyMaxMinutes: value.dailyMaxMinutes ?? DAY_MINUTES,
    regularThresholdMinutes: value.regularThresholdMinutes ?? 540,
  };
}

async function loadPeriod(db: DbOrTx, periodId: string) {
  const [period] = await db.select().from(timesheetPeriods).where(eq(timesheetPeriods.id, periodId)).limit(1);
  if (!period) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "工时周期不存在或无权访问");
  return period;
}

/** 本人周期（他人周期经统计/审批入口访问，不走此处） */
async function requireOwnEditable(user: SessionUser, period: typeof timesheetPeriods.$inferSelect): Promise<void> {
  if (period.userId !== user.id) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅本人可填报");
  }
  if (period.status !== "draft" && period.status !== "returned") {
    throw new BusinessError(
      period.status === "locked" ? ERROR_CODE.PERIOD_LOCKED : ERROR_CODE.STATE_CONFLICT,
      period.status === "locked" ? "周期已锁定，明细只读" : "仅草稿/已退回周期可编辑（批准后明细只读）",
    );
  }
}

/** 取（或自动建）目标 draft 周期：periodId 缺省=本周 */
export async function ensureDraftPeriod(db: DbOrTx, user: SessionUser, periodId?: string) {
  if (periodId) {
    const period = await loadPeriod(db, periodId);
    await requireOwnEditable(user, period);
    return period;
  }
  const start = mondayOf(new Date());
  const existing = await db
    .select()
    .from(timesheetPeriods)
    .where(and(eq(timesheetPeriods.userId, user.id), eq(timesheetPeriods.periodStart, fmt(start))))
    .limit(1);
  if (existing[0]) {
    if (existing[0].status !== "draft" && existing[0].status !== "returned") {
      throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "本周周期已提交/锁定，不可预填");
    }
    return existing[0];
  }
  const code = await nextCode("TS", db);
  const [created] = await db
    .insert(timesheetPeriods)
    .values({
      code,
      userId: user.id,
      periodType: "weekly",
      periodStart: fmt(start),
      periodEnd: fmt(new Date(start.getTime() + 6 * 86_400_000)),
      status: "draft",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!created) throw new Error("周期插入失败");
  return created;
}

export interface TimeEntryInput {
  projectId?: string | null;
  taskId?: string | null;
  meetingId?: string | null;
  travelId?: string | null;
  activityType: TimeActivityType;
  workDate: string;
  durationMinutes: number;
  description?: string;
  billable?: boolean;
}

/** 结构校验（整数分钟 >0；非项目活动限制；逐行项目可见性） */
async function validateEntryShapes(
  db: DbOrTx,
  user: SessionUser,
  entries: TimeEntryInput[],
): Promise<void> {
  for (const entry of entries) {
    if (!Number.isInteger(entry.durationMinutes) || entry.durationMinutes <= 0) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "工时必须为整数分钟且 >0（禁止浮点小时）", {
        entries: [`${entry.workDate} 分钟数非法`],
      });
    }
    if (!entry.projectId && entry.activityType !== "internal_admin" && entry.activityType !== "other") {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "非项目工作活动类型必须为 internal_admin/other", {
        entries: [`${entry.workDate} 活动类型非法`],
      });
    }
    if (entry.projectId) {
      await requireProjectRead(db, user, entry.projectId); // 逐行鉴权
    }
  }
}

/** §4.1 全量校验：阻止项（24h 跨周期合并）+ 警告项（超阈值/缺说明/同任务同日重复） */
export async function validatePeriodEntries(
  db: DbOrTx,
  user: SessionUser,
  period: typeof timesheetPeriods.$inferSelect,
  candidateEntries: Array<Pick<typeof timeEntries.$inferSelect, "workDate" | "durationMinutes" | "description" | "taskId">>,
): Promise<{ blockers: string[]; warnings: string[] }> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const config = await validationConfig(db);

  // 24h 跨周期合并：候选集 + 本周期之外既有明细，按 work_date 分组
  const byDate = new Map<string, number>();
  for (const entry of candidateEntries) {
    byDate.set(entry.workDate, (byDate.get(entry.workDate) ?? 0) + entry.durationMinutes);
  }
  const otherEntries = await db
    .select({ workDate: timeEntries.workDate, durationMinutes: timeEntries.durationMinutes })
    .from(timeEntries)
    .innerJoin(timesheetPeriods, eq(timesheetPeriods.id, timeEntries.periodId))
    .where(and(eq(timeEntries.userId, user.id), ne(timeEntries.periodId, period.id)));
  for (const entry of otherEntries) {
    byDate.set(entry.workDate, (byDate.get(entry.workDate) ?? 0) + entry.durationMinutes);
  }
  for (const [date, total] of byDate) {
    if (total > config.dailyMaxMinutes) {
      blockers.push(`${date} 单日合计 ${total} 分钟超过 ${config.dailyMaxMinutes}（跨周期合并计算，禁止绕过）`);
    } else if (total > config.regularThresholdMinutes) {
      warnings.push(`${date} 单日 ${total} 分钟超过常规阈值 ${config.regularThresholdMinutes}`);
    }
  }

  // 缺说明警告
  const missing = candidateEntries.filter((e) => !e.description?.trim()).map((e) => e.workDate);
  if (missing.length > 0) warnings.push(`缺说明：${[...new Set(missing)].join("、")}`);

  // 同任务同日多条（无时刻列，重叠按同任务同日重复启发式，STATUS 留坑）
  const dupTask = new Map<string, number>();
  for (const e of candidateEntries) {
    if (e.taskId) {
      const key = `${e.taskId}:${e.workDate}`;
      dupTask.set(key, (dupTask.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of dupTask) {
    if (n > 1) warnings.push(`同任务同日多条（疑似重叠）：${key}`);
  }

  return { blockers, warnings };
}

/** 覆盖式保存草稿（draft/returned；整体替换本周期明细；幂等键去抖） */
export async function saveEntries(
  db: DbOrTx,
  user: SessionUser,
  input: { periodId: string; entries: TimeEntryInput[]; idempotencyKey: string },
) {
  const period = await loadPeriod(db, input.periodId);
  await requireOwnEditable(user, period);
  await validateEntryShapes(db, user, input.entries);

  const candidates = input.entries.map((e) => ({
    workDate: e.workDate,
    durationMinutes: e.durationMinutes,
    description: e.description ?? "",
    taskId: e.taskId ?? null,
  }));
  const { blockers } = await validatePeriodEntries(db, user, period, candidates);
  if (blockers.length > 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "校验未通过", { blockers });
  }

  await db.delete(timeEntries).where(eq(timeEntries.periodId, period.id));
  for (const entry of input.entries) {
    await db.insert(timeEntries).values({
      periodId: period.id,
      userId: user.id,
      projectId: entry.projectId ?? null,
      taskId: entry.taskId ?? null,
      meetingId: entry.meetingId ?? null,
      travelId: entry.travelId ?? null,
      activityType: entry.activityType,
      workDate: entry.workDate,
      durationMinutes: entry.durationMinutes,
      description: entry.description ?? "",
      billable: entry.billable ?? true,
      source: "manual",
      createdBy: user.id,
      updatedBy: user.id,
    });
  }
  const total = input.entries.reduce((sum, e) => sum + e.durationMinutes, 0);
  await db
    .update(timesheetPeriods)
    .set({ updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${timesheetPeriods.rowVersion} + 1` })
    .where(eq(timesheetPeriods.id, period.id));
  return { periodId: period.id, entryCount: input.entries.length, totalMinutes: total };
}

export async function myPeriod(db: DbOrTx, user: SessionUser, input: { periodStart?: string }) {
  const start = input.periodStart ?? fmt(mondayOf(new Date()));
  let period: typeof timesheetPeriods.$inferSelect | undefined = (
    await db
      .select()
      .from(timesheetPeriods)
      .where(and(eq(timesheetPeriods.userId, user.id), eq(timesheetPeriods.periodStart, start)))
      .limit(1)
  )[0];
  if (!period) {
    // 目标周无周期则按该周自动建 draft（填报入口；加性语义，不影响契约字段）
    const monday = mondayOf(new Date(`${start}T00:00:00Z`));
    const code = await nextCode("TS", db);
    const [created] = await db
      .insert(timesheetPeriods)
      .values({
        code,
        userId: user.id,
        periodType: "weekly",
        periodStart: start,
        periodEnd: fmt(new Date(monday.getTime() + 6 * 86_400_000)),
        status: "draft",
        createdBy: user.id,
        updatedBy: user.id,
      })
      .returning();
    if (created) period = created;
  }
  if (!period) return { period: null, entries: [] as unknown[] };
  const entries = await db.select().from(timeEntries).where(eq(timeEntries.periodId, period.id)).orderBy(timeEntries.workDate);
  return { period, entries };
}

/** §4.2 审批人解析：pm 角色→partner（不自审）；否则周期内分钟数最多项目的 manager；无项目明细→配置默认 */
async function resolveApprover(db: DbOrTx, user: SessionUser, periodId: string): Promise<string> {
  if (user.globalRoles.includes("project_manager")) {
    const partners = await db
      .select({ userId: users.id })
      .from(users)
      .innerJoin(sql`user_roles`, sql`user_roles.user_id = ${users.id}`)
      .where(sql`user_roles.role_key = 'partner' and ${users.status} = 'active'`)
      .limit(1);
    if (!partners[0]) throw new BusinessError(ERROR_CODE.SELF_APPROVAL_BLOCKED, "无可用管理层审批人（申请人不得自审）");
    return partners[0].userId;
  }
  const rows = await db
    .select({ projectId: timeEntries.projectId, minutes: sql<number>`sum(${timeEntries.durationMinutes})::int` })
    .from(timeEntries)
    .where(and(eq(timeEntries.periodId, periodId), sql`${timeEntries.projectId} is not null`))
    .groupBy(timeEntries.projectId)
    .orderBy(desc(sql`sum(${timeEntries.durationMinutes})`))
    .limit(1);
  if (rows[0]?.projectId) {
    const [project] = await db.select({ managerId: projects.managerId }).from(projects).where(eq(projects.id, rows[0].projectId)).limit(1);
    if (project?.managerId) return project.managerId;
  }
  const [configRow] = await db
    .select({ valueJson: systemConfig.valueJson })
    .from(systemConfig)
    .where(eq(systemConfig.key, CONFIG_KEY.TIMESHEET_DEFAULT_APPROVER))
    .limit(1);
  const email = (configRow?.valueJson as { approverEmail?: string } | undefined)?.approverEmail;
  if (email) {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (u) return u.id;
  }
  throw new BusinessError(ERROR_CODE.POLICY_NOT_FOUND, "无法解析工时审批人（无项目明细且未配置默认审批人）");
}

export async function validatePeriod(db: DbOrTx, user: SessionUser, periodId: string) {
  const period = await loadPeriod(db, periodId);
  if (period.userId !== user.id && !user.globalRoles.includes("partner")) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅本人可校验");
  }
  const entries = await db.select().from(timeEntries).where(eq(timeEntries.periodId, period.id));
  const result = await validatePeriodEntries(db, user, period, entries);
  return { periodId: period.id, status: period.status, totalMinutes: entries.reduce((s, e) => s + e.durationMinutes, 0), ...result };
}

export async function submitPeriod(db: DbOrTx, user: SessionUser, input: { periodId: string; idempotencyKey: string }) {
  const period = await loadPeriod(db, input.periodId);
  await requireOwnEditable(user, period);
  const entries = await db.select().from(timeEntries).where(eq(timeEntries.periodId, period.id));
  if (entries.length === 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "周期无明细，不可提交", { entries: ["周期无明细"] });

  const { blockers, warnings } = await validatePeriodEntries(db, user, period, entries);
  if (blockers.length > 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "校验未通过，禁止提交", { blockers });
  }

  const approverId = await resolveApprover(db, user, period.id);
  if (approverId === user.id) {
    throw new BusinessError(ERROR_CODE.SELF_APPROVAL_BLOCKED, "申请人不得自审工时周期");
  }
  await db
    .update(timesheetPeriods)
    .set({ status: "pending_approval", approverId, submittedAt: nowIso(), updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${timesheetPeriods.rowVersion} + 1` })
    .where(and(eq(timesheetPeriods.id, period.id), sql`${timesheetPeriods.status} in ('draft','returned')`));

  const instance = await engine.submit(db, {
    bizType: "timesheet",
    bizId: period.id,
    applicantId: user.id,
    formSnapshot: {
      periodCode: period.code,
      totalMinutes: entries.reduce((s, e) => s + e.durationMinutes, 0),
      checks: { warnings },
    },
    idempotencyKey: input.idempotencyKey,
    runtimeApproverId: approverId,
  });
  return { period, instance, warnings };
}

export async function withdrawPeriod(db: DbOrTx, user: SessionUser, input: { periodId: string; rowVersion: number }) {
  const period = await loadPeriod(db, input.periodId);
  if (period.userId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅本人可撤回");
  if (period.status !== "pending_approval") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅待审批周期可撤回");
  const [instance] = await db
    .select()
    .from(approvalInstances)
    .where(and(eq(approvalInstances.bizType, "timesheet"), eq(approvalInstances.bizId, period.id), eq(approvalInstances.status, "pending")))
    .limit(1);
  if (!instance) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "周期无进行中的审批实例");
  const updated = await db
    .update(timesheetPeriods)
    .set({ updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${timesheetPeriods.rowVersion} + 1` })
    .where(and(eq(timesheetPeriods.id, period.id), eq(timesheetPeriods.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  const withdrawn = await engine.withdraw(db, { instanceId: instance.id, actorId: user.id });
  return { period: updated[0], instance: withdrawn };
}

/* ===== 预填与复制（只产草稿、不计统计：draft 周期天然排除于 approved+locked 口径） ===== */

export async function prefillFromMeeting(
  db: DbOrTx,
  user: SessionUser,
  input: { meetingId: string; periodId?: string },
) {
  const [meeting] = await db.select().from(meetings).where(eq(meetings.id, input.meetingId)).limit(1);
  if (!meeting) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "会议不存在或无权访问");
  if (meeting.status === "cancelled") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已取消会议不产生工时预填");
  }
  const period = await ensureDraftPeriod(db, user, input.periodId);
  const start = new Date(meeting.actualStartAt ?? meeting.startAt).getTime();
  const end = new Date(meeting.actualEndAt ?? meeting.endAt).getTime();
  const minutes = Math.max(1, Math.round((end - start) / 60_000));
  const workDate = fmt(new Date(start + 8 * 3_600_000)); // Asia/Shanghai 业务日

  // 幂等去重：meeting + user + date
  const existing = await db
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.meetingId, meeting.id),
        eq(timeEntries.userId, user.id),
        eq(timeEntries.workDate, workDate),
        eq(timeEntries.source, "prefill_meeting"),
      ),
    )
    .limit(1);
  if (existing[0]) return { periodId: period.id, created: 0, skipped: 1 };

  await db.insert(timeEntries).values({
    periodId: period.id,
    userId: user.id,
    projectId: meeting.projectId,
    meetingId: meeting.id,
    activityType: "meeting",
    workDate,
    durationMinutes: minutes,
    description: `会议预填：${meeting.subject}`,
    billable: true,
    source: "prefill_meeting",
    createdBy: user.id,
    updatedBy: user.id,
  });
  return { periodId: period.id, created: 1, skipped: 0 };
}

export async function prefillFromTravel(
  db: DbOrTx,
  user: SessionUser,
  input: { travelId: string; periodId?: string },
) {
  const [travel] = await db.select().from(travelRequests).where(eq(travelRequests.id, input.travelId)).limit(1);
  if (!travel) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "出差不存在或无权访问");
  if (travel.status === "cancelled" || travel.status === "rejected") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已取消/已驳回出差不产生工时预填");
  }
  const period = await ensureDraftPeriod(db, user, input.periodId);

  // 按分段日期每日建议分钟数（Asia/Shanghai 切日，绝不按 24h）
  const dayMs = 86_400_000;
  const tzOffsetMs = 8 * 3_600_000;
  const dayOf = (ms: number) => Math.floor((ms + tzOffsetMs) / dayMs);
  const dayStartOf = (idx: number) => idx * dayMs - tzOffsetMs;
  const segments = await db.select().from(travelSegments).where(eq(travelSegments.travelRequestId, travel.id)).orderBy(travelSegments.seq);
  const perDay = new Map<number, number>();
  for (const segment of segments) {
    const s = new Date(segment.startAt).getTime();
    const e = new Date(segment.endAt).getTime();
    for (let day = dayOf(s); day <= dayOf(e - 1); day++) {
      const overlap = Math.max(0, Math.round((Math.min(e, dayStartOf(day + 1)) - Math.max(s, dayStartOf(day))) / 60_000));
      perDay.set(day, (perDay.get(day) ?? 0) + overlap);
    }
  }

  let created = 0;
  let skipped = 0;
  for (const [day, minutes] of [...perDay.entries()].sort((a, b) => a[0] - b[0])) {
    if (minutes <= 0) continue;
    const workDate = fmt(new Date(dayStartOf(day) + tzOffsetMs));
    const existing = await db
      .select({ id: timeEntries.id })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.travelId, travel.id),
          eq(timeEntries.userId, user.id),
          eq(timeEntries.workDate, workDate),
          eq(timeEntries.source, "prefill_travel"),
        ),
      )
      .limit(1);
    if (existing[0]) {
      skipped += 1;
      continue;
    }
    await db.insert(timeEntries).values({
      periodId: period.id,
      userId: user.id,
      projectId: travel.projectId,
      travelId: travel.id,
      activityType: "travel",
      workDate,
      durationMinutes: minutes,
      description: `出差预填：${travel.destination}`,
      billable: true,
      source: "prefill_travel",
      createdBy: user.id,
      updatedBy: user.id,
    });
    created += 1;
  }
  return { periodId: period.id, created, skipped };
}

/** 复制草稿：fromDate 当日明细复制为 toDate 的 copy 源草稿（目标周须为本人 draft 周期） */
export async function copyDay(db: DbOrTx, user: SessionUser, input: { fromDate: string; toDate: string }) {
  const source = await db
    .select()
    .from(timeEntries)
    .innerJoin(timesheetPeriods, eq(timesheetPeriods.id, timeEntries.periodId))
    .where(and(eq(timeEntries.userId, user.id), eq(timeEntries.workDate, input.fromDate)))
    .orderBy(timeEntries.createdAt);
  if (source.length === 0) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "当日无明细可复制");
  const monday = mondayOf(new Date(`${input.toDate}T00:00:00Z`));
  const [target] = await db
    .select()
    .from(timesheetPeriods)
    .where(and(eq(timesheetPeriods.userId, user.id), eq(timesheetPeriods.periodStart, fmt(monday))))
    .limit(1);
  if (!target) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "目标周无周期（预填/复制前请先建立或让系统自动创建）");
  await requireOwnEditable(user, target);

  let created = 0;
  for (const row of source) {
    const entry = row.time_entries;
    await db.insert(timeEntries).values({
      periodId: target.id,
      userId: user.id,
      projectId: entry.projectId,
      taskId: entry.taskId,
      meetingId: null,
      travelId: null,
      activityType: entry.activityType,
      workDate: input.toDate,
      durationMinutes: entry.durationMinutes,
      description: entry.description,
      billable: entry.billable,
      source: "copy",
      createdBy: user.id,
      updatedBy: user.id,
    });
    created += 1;
  }
  return { periodId: target.id, created };
}

/* ===== 锁定/解锁（TIM-007） ===== */

/** time.lock：partner 全局可锁；或明细项目之一的 manager（pm 对项目成员） */
export async function lockPeriod(db: DbOrTx, user: SessionUser, input: { periodId: string; reason?: string }) {
  const period = await loadPeriod(db, input.periodId);
  if (period.status !== "approved") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅已批准周期可锁定");
  const allowed = await canLockTime(db, user, period);
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "无工时锁定权限");
  const [updated] = await db
    .update(timesheetPeriods)
    .set({
      status: "locked",
      lockedAt: nowIso(),
      lockedBy: user.id,
      lockReason: input.reason?.trim() || null,
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${timesheetPeriods.rowVersion} + 1`,
    })
    .where(and(eq(timesheetPeriods.id, period.id), eq(timesheetPeriods.status, "approved")))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "周期状态已变化");
  return updated;
}

async function canLockTime(db: DbOrTx, user: SessionUser, period: typeof timesheetPeriods.$inferSelect): Promise<boolean> {
  if (user.globalRoles.includes("partner")) return true;
  const rows = await db
    .select({ projectId: timeEntries.projectId })
    .from(timeEntries)
    .where(and(eq(timeEntries.periodId, period.id), sql`${timeEntries.projectId} is not null`))
    .groupBy(timeEntries.projectId);
  for (const row of rows) {
    if (row.projectId && user.projectRoles.get(row.projectId) === "manager") return true;
  }
  return false;
}

/** time.unlock 专门授权（partner/sysadmin）+ 理由 + 审计（显式 audit 行，叠加变更类中间件） */
export async function unlockPeriod(db: DbOrTx, user: SessionUser, input: { periodId: string; reason: string }, ip: string | null, sessionId: string | null) {
  const granted = user.globalRoles.includes("partner") || user.globalRoles.includes("sysadmin");
  if (!granted) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "无工时解锁授权（time.unlock 专门授权）");
  if (!input.reason?.trim()) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "解锁必须填写理由", { reason: ["解锁必须填写理由"] });
  }
  const period = await loadPeriod(db, input.periodId);
  if (period.status !== "locked") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅已锁定周期可解锁");
  const [updated] = await db
    .update(timesheetPeriods)
    .set({
      status: "approved", // 解锁回已批准（明细只读口径延续，arch/07 §3）
      lockReason: `${period.lockReason ?? ""}｜解锁：${input.reason.trim()}`.slice(0, 2000),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${timesheetPeriods.rowVersion} + 1`,
    })
    .where(and(eq(timesheetPeriods.id, period.id), eq(timesheetPeriods.status, "locked")))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "周期状态已变化");
  const { recordAudit } = await import("../../services/audit");
  await recordAudit(db, {
    actorId: user.id,
    sessionId,
    action: "time.unlock",
    targetType: "timesheet_period",
    targetId: period.id,
    result: "success",
    afterJson: { reason: input.reason.trim(), periodCode: period.code },
    ip,
  });
  return updated;
}
