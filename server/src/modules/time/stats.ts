import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { projects, timeEntries, timesheetPeriods, users } from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { projectScopeFilter } from "../../services/access";
import { recordAudit } from "../../services/audit";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { nowIso } from "../governance/util";

/**
 * 工时统计（arch/07 §4.6/§6）：唯一聚合函数 aggregateTime——
 * 驾驶舱、周报、工时中心、项目空间读同一函数，同名指标全站同数（TIM-008/009）。
 * 口径：有效工时 = approved + locked（默认 statuses）；草稿/待审批/已退回单列，不混入；
 * 预填/复制源明细随周期状态计入口径（draft 周期不计）。
 */

export type TimeGroupBy = "user" | "project" | "task" | "activity";

export const EFFECTIVE_SCOPE = "有效工时 = approved + locked；draft/pending_approval/returned 单列；预填与复制草稿随周期状态计入（draft 周期不计）";

export interface TimeAggregateRow {
  key: string | null;
  minutes: number;
  entryCount: number;
}

/** 唯一聚合函数：全站工时统计的唯一入口（红线 D7 同名同数） */
export async function aggregateTime(
  db: DbOrTx,
  input: {
    from?: string;
    to?: string;
    statuses?: string[];
    groupBy: TimeGroupBy;
    /** 限定用户（mySummary/本人范围） */
    userId?: string;
    /** 限定项目集合 SQL（角色范围）；缺省=成员可见范围 */
    scopeProjects?: SQL;
  },
): Promise<{ items: TimeAggregateRow[]; asOf: string; statusScope: string }> {
  const statuses = input.statuses ?? ["approved", "locked"];
  const conditions: (SQL | undefined)[] = [sql`${timesheetPeriods.status} in (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})`];
  if (input.from) conditions.push(gte(timeEntries.workDate, input.from));
  if (input.to) conditions.push(lte(timeEntries.workDate, input.to));
  if (input.userId) conditions.push(eq(timeEntries.userId, input.userId));
  if (input.scopeProjects) {
    conditions.push(sql`${timeEntries.projectId} in (select id from projects where ${input.scopeProjects})`);
  }

  const groupColumn =
    input.groupBy === "user"
      ? timeEntries.userId
      : input.groupBy === "project"
        ? timeEntries.projectId
        : input.groupBy === "task"
          ? timeEntries.taskId
          : timeEntries.activityType;

  const rows = await db
    .select({
      key: groupColumn,
      minutes: sql<number>`sum(${timeEntries.durationMinutes})::int`,
      entryCount: sql<number>`count(*)::int`,
    })
    .from(timeEntries)
    .innerJoin(timesheetPeriods, eq(timesheetPeriods.id, timeEntries.periodId))
    .where(and(...conditions))
    .groupBy(groupColumn)
    .orderBy(desc(sql`sum(${timeEntries.durationMinutes})`));

  return { items: rows.map((r) => ({ key: r.key, minutes: Number(r.minutes), entryCount: Number(r.entryCount) })), asOf: nowIso(), statusScope: EFFECTIVE_SCOPE };
}

/** 统计可见性：partner/finance 全局；项目成员按可见范围（scopeProjects 过滤保证不越界）；viewer 等无成员关系者拒 */
async function requireStatsAccess(db: DbOrTx, user: SessionUser, projectId?: string): Promise<void> {
  void db;
  if (user.globalRoles.includes("partner") || user.globalRoles.includes("finance")) return;
  if (projectId && user.projectRoles.has(projectId)) return;
  if (!projectId && user.projectRoles.size > 0) return;
  throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "无工时统计权限");
}

export async function statsByUser(
  db: DbOrTx,
  user: SessionUser,
  input: { from?: string; to?: string; statuses?: string[]; projectId?: string; scopeAll?: boolean },
) {
  await requireStatsAccess(db, user, input.projectId);
  const result = await aggregateTime(db, {
    ...input,
    groupBy: "user",
    scopeProjects: input.projectId
      ? sql`${projects.id} = ${input.projectId}`
      : input.scopeAll
        ? sql`true`
        : projectScopeFilter(user),
  });
  const names = new Map((await db.select({ id: users.id, name: users.name }).from(users)).map((u) => [u.id, u.name]));
  return { ...result, items: result.items.map((r) => ({ ...r, name: names.get(r.key ?? "") ?? null })) };
}

export async function statsByProject(db: DbOrTx, user: SessionUser, input: { from?: string; to?: string; statuses?: string[]; scopeAll?: boolean }) {
  await requireStatsAccess(db, user);
  const result = await aggregateTime(db, { ...input, groupBy: "project", scopeProjects: input.scopeAll ? sql`true` : projectScopeFilter(user) });
  const names = new Map((await db.select({ id: projects.id, name: projects.name }).from(projects)).map((p) => [p.id, p.name]));
  return { ...result, items: result.items.map((r) => ({ ...r, name: names.get(r.key ?? "") ?? "非项目工作" })) };
}

export async function statsByTask(db: DbOrTx, user: SessionUser, input: { from?: string; to?: string; statuses?: string[]; projectId?: string }) {
  await requireStatsAccess(db, user, input.projectId);
  return aggregateTime(db, {
    ...input,
    groupBy: "task",
    scopeProjects: input.projectId ? sql`${projects.id} = ${input.projectId}` : projectScopeFilter(user),
  });
}

export async function statsByActivity(db: DbOrTx, user: SessionUser, input: { from?: string; to?: string; statuses?: string[]; projectId?: string }) {
  await requireStatsAccess(db, user, input.projectId);
  return aggregateTime(db, {
    ...input,
    groupBy: "activity",
    scopeProjects: input.projectId ? sql`${projects.id} = ${input.projectId}` : projectScopeFilter(user),
  });
}

/** 本人各状态分钟数 + 缺口（工作日无明细的天数） */
export async function mySummary(db: DbOrTx, user: SessionUser, input: { from?: string; to?: string }) {
  const from = input.from ?? new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const to = input.to ?? new Date().toISOString().slice(0, 10);

  const byStatus = async (statuses: string[]) => {
    const result = await aggregateTime(db, { from, to, statuses, groupBy: "user", userId: user.id });
    return result.items[0]?.minutes ?? 0;
  };
  const [approvedLocked, pending, draft, returned] = await Promise.all([
    byStatus(["approved", "locked"]),
    byStatus(["pending_approval"]),
    byStatus(["draft"]),
    byStatus(["returned"]),
  ]);

  // 缺口：区间内周一至周五无明细的天数（不计未来日期）
  const entries = await db
    .select({ workDate: timeEntries.workDate })
    .from(timeEntries)
    .where(and(eq(timeEntries.userId, user.id), gte(timeEntries.workDate, from), lte(timeEntries.workDate, to)))
    .groupBy(timeEntries.workDate);
  const covered = new Set(entries.map((e) => e.workDate));
  const gapDates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const today = new Date().toISOString().slice(0, 10);
  while (cursor.getTime() <= end.getTime()) {
    const day = cursor.toISOString().slice(0, 10);
    const dow = cursor.getUTCDay();
    if (day <= today && dow !== 0 && dow !== 6 && !covered.has(day)) gapDates.push(day);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    asOf: nowIso(),
    statusScope: EFFECTIVE_SCOPE,
    range: { from, to },
    minutes: { approvedAndLocked: approvedLocked, pendingApproval: pending, draft, returned },
    gapDates,
  };
}

/** 导出 CSV（继承字段权限：无费率/人力成本列，TIM-010 关闭；审计） */
export async function exportCsv(
  db: DbOrTx,
  user: SessionUser,
  input: { from?: string; to?: string; statuses?: string[]; projectId?: string },
  ip: string | null,
  sessionId: string | null,
) {
  await requireStatsAccess(db, user, input.projectId);
  const scope = input.projectId ? sql`${projects.id} = ${input.projectId}` : projectScopeFilter(user);
  const conditions: (SQL | undefined)[] = [
    sql`${timesheetPeriods.status} in (${sql.join((input.statuses ?? ["approved", "locked"]).map((s) => sql`${s}`), sql`, `)})`,
    sql`${timeEntries.projectId} is not null and ${timeEntries.projectId} in (select id from projects where ${scope})`,
  ];
  if (input.from) conditions.push(gte(timeEntries.workDate, input.from));
  if (input.to) conditions.push(lte(timeEntries.workDate, input.to));
  const rows = await db
    .select({
      code: timesheetPeriods.code,
      userId: timeEntries.userId,
      projectId: timeEntries.projectId,
      activityType: timeEntries.activityType,
      workDate: timeEntries.workDate,
      minutes: timeEntries.durationMinutes,
      description: timeEntries.description,
      source: timeEntries.source,
      status: timesheetPeriods.status,
    })
    .from(timeEntries)
    .innerJoin(timesheetPeriods, eq(timesheetPeriods.id, timeEntries.periodId))
    .where(and(...conditions))
    .orderBy(timeEntries.workDate, timesheetPeriods.code);
  const header = "周期,用户,项目,活动类型,日期,分钟,说明,来源,周期状态";
  const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = `﻿${header}\n${rows.map((r) => [r.code, r.userId, r.projectId, r.activityType, r.workDate, r.minutes, r.description, r.source, r.status].map(escape).join(",")).join("\n")}`;
  await recordAudit(db, {
    actorId: user.id,
    sessionId,
    action: "export.run",
    targetType: "time_entry",
    targetId: input.projectId ?? null,
    result: "success",
    afterJson: { rows: rows.length, filters: input },
    ip,
  });
  return { csv, rowCount: rows.length, asOf: nowIso(), statusScope: EFFECTIVE_SCOPE };
}
