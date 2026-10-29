import { and, desc, eq, gte, isNull, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import {
  approvalInstances,
  approvalSteps,
  auditEvents,
  budgets,
  budgetLedger,
  decisions,
  expenseReports,
  fundingRequests,
  meetingMinutes,
  meetings,
  notifications,
  paymentReceipts,
  projects,
  qualityIssues,
  tasks,
  timeEntries,
  timesheetPeriods,
  travelRequests,
} from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { can, projectScopeFilter } from "../../services/access";
import { sweepActionItems, sweepTimesheets } from "../../modules/collab/sweeps";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "./util";

/**
 * 查询域 service（arch/04 §5 approval/notification/todo/dashboard/audit）。
 * 全部按权限范围 SQL 级过滤（arch/03 §5）。
 */

/* ===== approval ===== */

export async function listMineApprovals(
  db: DbOrTx,
  user: SessionUser,
  input: { cursor?: string; limit: number },
) {
  const conditions: (SQL | undefined)[] = [
    eq(approvalSteps.approverId, user.id),
    eq(approvalSteps.status, "pending"),
    eq(approvalInstances.status, "pending"),
  ];
  conditions.push(cursorCondition(input.cursor, approvalInstances.submittedAt, approvalInstances.id));
  const rows = await db
    .select({ step: approvalSteps, instance: approvalInstances })
    .from(approvalSteps)
    .innerJoin(approvalInstances, eq(approvalInstances.id, approvalSteps.instanceId))
    .where(and(...conditions))
    .orderBy(desc(approvalInstances.submittedAt), desc(approvalInstances.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      step: { seq: r.step.seq, countersign: r.step.countersign, actedAt: r.step.actedAt },
      instance: {
        id: r.instance.id,
        code: r.instance.code,
        bizType: r.instance.bizType,
        bizId: r.instance.bizId,
        projectId: r.instance.projectId,
        currentStepSeq: r.instance.currentStepSeq,
        status: r.instance.status,
        submittedAt: r.instance.submittedAt,
      },
    })),
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor(last.instance.submittedAt, last.instance.id)
        : null,
  };
}

export async function listMineApplied(
  db: DbOrTx,
  user: SessionUser,
  input: { cursor?: string; limit: number },
) {
  const conditions: (SQL | undefined)[] = [eq(approvalInstances.applicantId, user.id)];
  conditions.push(cursorCondition(input.cursor, approvalInstances.submittedAt, approvalInstances.id));
  const rows = await db
    .select()
    .from(approvalInstances)
    .where(and(...conditions))
    .orderBy(desc(approvalInstances.submittedAt), desc(approvalInstances.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor:
      rows.length > input.limit && last ? encodeCursor(last.submittedAt, last.id) : null,
  };
}

export async function getApprovalById(db: DbOrTx, user: SessionUser, id: string) {
  const [instance] = await db.select().from(approvalInstances).where(eq(approvalInstances.id, id)).limit(1);
  if (!instance) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "审批不存在或无权访问");
  const isApprover = await db
    .select({ id: approvalSteps.id })
    .from(approvalSteps)
    .where(and(eq(approvalSteps.instanceId, id), eq(approvalSteps.approverId, user.id)))
    .limit(1);
  const allowed =
    instance.applicantId === user.id ||
    isApprover.length > 0 ||
    user.globalRoles.includes("partner") ||
    user.globalRoles.includes("sysadmin");
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "审批不存在或无权访问");
  const steps = await db
    .select()
    .from(approvalSteps)
    .where(eq(approvalSteps.instanceId, id))
    .orderBy(approvalSteps.seq);
  // 流程节点图进度（arch/09 §3.3）：自定义流程实例附 compiledSteps 映射
  const snapshot = instance.policySnapshot as { flowName?: string; flowVersion?: number; compiledSteps?: Array<{ nodeId: string; label: string; conditionTrace: unknown[] }> } | null;
  let flowProgress: {
    flowName: string;
    flowVersion: number | null;
    currentNodeLabel: string | null;
    nodes: Array<{ label: string; status: string; conditionTrace: unknown[] }>;
  } | null = null;
  if (snapshot?.flowName && Array.isArray(snapshot.compiledSteps)) {
    const seqByIndex = new Map(snapshot.compiledSteps.map((_, idx) => [idx + 1, snapshot.compiledSteps![idx]]));
    flowProgress = {
      flowName: snapshot.flowName,
      flowVersion: snapshot.flowVersion ?? null,
      currentNodeLabel: null,
      nodes: steps.map((step) => ({
        label: seqByIndex.get(step.seq)?.label ?? `子步 ${step.seq}`,
        status: step.status,
        conditionTrace: seqByIndex.get(step.seq)?.conditionTrace ?? [],
      })),
    };
    const current = steps.find((s) => s.seq === instance.currentStepSeq);
    if (current) flowProgress.currentNodeLabel = seqByIndex.get(current.seq)?.label ?? null;
  }
  return { ...instance, steps, flowProgress };
}

/* ===== notification ===== */

export async function listMineNotifications(
  db: DbOrTx,
  user: SessionUser,
  input: { cursor?: string; unreadOnly?: boolean; limit: number },
) {
  const conditions: (SQL | undefined)[] = [eq(notifications.recipientId, user.id)];
  if (input.unreadOnly) conditions.push(isNull(notifications.readAt));
  conditions.push(cursorCondition(input.cursor, notifications.createdAt, notifications.id));
  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function unreadCount(db: DbOrTx, user: SessionUser) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.recipientId, user.id), isNull(notifications.readAt)));
  return { count: row.n };
}

export async function markRead(db: DbOrTx, user: SessionUser, ids: string[]) {
  await db
    .update(notifications)
    .set({ readAt: nowIso() })
    .where(
      and(
        eq(notifications.recipientId, user.id),
        sql`${notifications.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
      ),
    );
  return { ok: true as const };
}

export async function markHandled(db: DbOrTx, user: SessionUser, ids: string[]) {
  await db
    .update(notifications)
    .set({ handledAt: nowIso() })
    .where(
      and(
        eq(notifications.recipientId, user.id),
        sql`${notifications.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
      ),
    );
  return { ok: true as const };
}

/* ===== todo.mine（统一并集，arch/04 §5） ===== */

export async function todoMine(db: DbOrTx, user: SessionUser) {
  await sweepActionItems(db, user); // 查询时判定+写入（action_item_due）
  await sweepTimesheets(db, user); // timesheet_gap：缺口/审批积压
  const today = nowIso().slice(0, 10);
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

  const myTasks = await db
    .select({
      id: tasks.id,
      code: tasks.code,
      title: tasks.title,
      projectId: tasks.projectId,
      plannedEnd: tasks.plannedEnd,
      status: tasks.status,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.assigneeId, user.id),
        sql`${tasks.status} in ('pending', 'in_progress')`,
        sql`${tasks.projectId} IN (SELECT project_id FROM project_members WHERE user_id = ${user.id})`,
      ),
    )
    .limit(50);

  const myApprovals = await db
    .select({
      id: approvalInstances.id,
      code: approvalInstances.code,
      bizType: approvalInstances.bizType,
      projectId: approvalInstances.projectId,
      submittedAt: approvalInstances.submittedAt,
    })
    .from(approvalSteps)
    .innerJoin(approvalInstances, eq(approvalInstances.id, approvalSteps.instanceId))
    .where(
      and(
        eq(approvalSteps.approverId, user.id),
        eq(approvalSteps.status, "pending"),
        eq(approvalInstances.status, "pending"),
      ),
    )
    .limit(50);

  const myReviews = await db
    .select({
      id: qualityIssues.id,
      code: qualityIssues.code,
      title: qualityIssues.title,
      projectId: qualityIssues.projectId,
    })
    .from(qualityIssues)
    .where(and(eq(qualityIssues.reviewerId, user.id), eq(qualityIssues.status, "pending_review")))
    .limit(50);

  const reportsToConfirm = await db
    .select({
      id: projects.id,
      code: sql<string>`'WEEKLY'`.as("code"),
      title: sql<string>`'本周报待确认'`.as("title"),
      projectId: projects.id,
    })
    .from(projects)
    .where(
      and(
        eq(projects.managerId, user.id),
        eq(projects.lifecycleStatus, "in_progress"),
        sql`NOT EXISTS (
          SELECT 1 FROM weekly_reports wr
          WHERE wr.project_id = ${projects.id}
            AND wr.period_start >= date_trunc('week', current_date)::date
        )`,
      ),
    )
    .limit(20);

  // 待我整理纪要：记录人=我，会议已结束且纪要 pending_draft
  const minutesToDraft = await db
    .select({
      id: meetings.id,
      code: meetings.code,
      title: meetings.subject,
      projectId: meetings.projectId,
    })
    .from(meetings)
    .where(
      and(
        eq(meetings.recorderId, user.id),
        eq(meetings.status, "completed"),
        eq(meetings.minutesStatus, "pending_draft"),
      ),
    )
    .limit(20);

  // 待我确认纪要：确认人=我，pending_confirm（分钟行 confirmer_id=me 且未确认）
  const minutesToConfirm = await db
    .select({
      id: meetings.id,
      code: meetings.code,
      title: meetings.subject,
      projectId: meetings.projectId,
    })
    .from(meetings)
    .innerJoin(
      meetingMinutes,
      and(eq(meetingMinutes.meetingId, meetings.id), sql`${meetingMinutes.confirmedAt} is null`),
    )
    .where(and(eq(meetings.minutesStatus, "pending_confirm"), eq(meetingMinutes.confirmerId, user.id)))
    .limit(20);

  // 我的申请状态卡（arch/06 §8：funding/expense mine 摘要）
  const myFundings = await db
    .select({ id: fundingRequests.id, code: fundingRequests.code, status: fundingRequests.approvalStatus, amountCents: fundingRequests.amountCents })
    .from(fundingRequests)
    .where(eq(fundingRequests.applicantId, user.id))
    .orderBy(desc(fundingRequests.createdAt))
    .limit(5);
  const myExpenses = await db
    .select({ id: expenseReports.id, code: expenseReports.code, status: expenseReports.status, totalCents: expenseReports.totalCents })
    .from(expenseReports)
    .where(eq(expenseReports.applicantId, user.id))
    .orderBy(desc(expenseReports.createdAt))
    .limit(5);

  // 待提交工时：本人 draft/returned 周期有明细未提交
  const timeToSubmit = await db
    .select({ id: timesheetPeriods.id, code: timesheetPeriods.code, status: timesheetPeriods.status })
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, user.id),
        sql`${timesheetPeriods.status} in ('draft', 'returned')`,
        sql`exists (SELECT 1 FROM time_entries te WHERE te.period_id = ${timesheetPeriods.id})`,
      ),
    )
    .limit(10);
  // 待我审工时：approver=我 且 pending
  const timeToApprove = await db
    .select({ id: timesheetPeriods.id, code: timesheetPeriods.code })
    .from(timesheetPeriods)
    .where(and(eq(timesheetPeriods.approverId, user.id), eq(timesheetPeriods.status, "pending_approval")))
    .limit(20);

  const grantsToHandle = await db
    .select({
      id: approvalInstances.id,
      code: approvalInstances.code,
      bizType: approvalInstances.bizType,
      projectId: approvalInstances.projectId,
      submittedAt: approvalInstances.submittedAt,
    })
    .from(approvalSteps)
    .innerJoin(approvalInstances, eq(approvalInstances.id, approvalSteps.instanceId))
    .where(
      and(
        eq(approvalSteps.approverId, user.id),
        eq(approvalSteps.status, "pending"),
        eq(approvalInstances.status, "pending"),
        eq(approvalInstances.bizType, "access_grant"),
      ),
    )
    .limit(50);

  const items = [
    ...myTasks.map((t) => ({
      kind: "task" as const,
      id: t.id,
      code: t.code,
      title: t.title,
      projectId: t.projectId,
      dueDate: t.plannedEnd,
      overdue: t.plannedEnd < today,
      dueSoon: t.plannedEnd >= today && t.plannedEnd <= soon,
    })),
    ...myApprovals.map((a) => ({
      kind: "approval" as const,
      id: a.id,
      code: a.code,
      title: a.bizType === "change_request" ? "待审批：延期申请" : "待审批：档案授权",
      projectId: a.projectId,
      submittedAt: a.submittedAt,
    })),
    ...myReviews.map((r) => ({
      kind: "quality_review" as const,
      id: r.id,
      code: r.code,
      title: `待复核：${r.title}`,
      projectId: r.projectId,
    })),
    ...reportsToConfirm.map((r) => ({
      kind: "report_confirm" as const,
      id: r.id,
      code: "WEEKLY",
      title: r.title,
      projectId: r.projectId,
    })),
    ...minutesToDraft.map((m) => ({
      kind: "minutes_draft" as const,
      id: m.id,
      code: m.code,
      title: `待整理纪要：${m.title}`,
      projectId: m.projectId,
    })),
    ...minutesToConfirm.map((m) => ({
      kind: "minutes_confirm" as const,
      id: m.id,
      code: m.code,
      title: `待确认纪要：${m.title}`,
      projectId: m.projectId,
    })),
    ...myFundings.map((f) => ({
      kind: "funding_mine" as const,
      id: f.id,
      code: f.code,
      title: `我的经费申请 ${f.code}（${f.status}）`,
      projectId: null,
      amountCents: f.amountCents,
    })),
    ...myExpenses.map((e) => ({
      kind: "expense_mine" as const,
      id: e.id,
      code: e.code,
      title: `我的报销 ${e.code}（${e.status}）`,
      projectId: null,
      amountCents: e.totalCents,
    })),
    ...timeToSubmit.map((p) => ({
      kind: "time_submit" as const,
      id: p.id,
      code: p.code,
      title: `待提交工时：${p.code}（${p.status === "returned" ? "已退回待修改" : "草稿"}）`,
      projectId: null,
    })),
    ...timeToApprove.map((p) => ({
      kind: "time_approve" as const,
      id: p.id,
      code: p.code,
      title: `待我审工时：${p.code}`,
      projectId: null,
    })),
    ...grantsToHandle.map((g) => ({
      kind: "grant_handle" as const,
      id: g.id,
      code: g.code,
      title: "待处理：档案授权申请",
      projectId: g.projectId,
      submittedAt: g.submittedAt,
    })),
  ];

  // 处理后消失由各业务动作改变状态自然达成；这里按紧急度排序
  const rank = (item: (typeof items)[number]) =>
    item.kind === "task" && "overdue" in item && item.overdue ? 0 : 1;
  items.sort((a, b) => rank(a) - rank(b));
  return { items, nextCursor: null as string | null };
}

/* ===== dashboard.summary ===== */

export async function dashboardSummary(db: DbOrTx, user: SessionUser) {
  const scope = projectScopeFilter(user);

  const [pulse] = await db
    .select({
      total: sql<number>`count(*)::int`,
      preparing: sql<number>`count(*) filter (where ${projects.lifecycleStatus} = 'preparing')::int`,
      inProgress: sql<number>`count(*) filter (where ${projects.lifecycleStatus} = 'in_progress')::int`,
      closed: sql<number>`count(*) filter (where ${projects.lifecycleStatus} = 'closed')::int`,
      atRisk: sql<number>`count(*) filter (where ${projects.healthStatus} = 'at_risk')::int`,
      warning: sql<number>`count(*) filter (where ${projects.healthStatus} = 'warning')::int`,
    })
    .from(projects)
    .where(scope);

  const [pendingApprovals] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(approvalSteps)
    .innerJoin(approvalInstances, eq(approvalInstances.id, approvalSteps.instanceId))
    .where(
      and(
        eq(approvalSteps.approverId, user.id),
        eq(approvalSteps.status, "pending"),
        eq(approvalInstances.status, "pending"),
      ),
    );

  const [pendingDecisions] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(decisions)
    .where(
      and(
        eq(decisions.status, "deciding"),
        sql`${decisions.projectId} IN (SELECT id FROM projects WHERE ${scope})`,
      ),
    );

  const [blockingQuality] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(qualityIssues)
    .where(
      and(
        eq(qualityIssues.isBlocking, true),
        sql`${qualityIssues.projectId} IN (SELECT id FROM projects WHERE ${scope})`,
      ),
    );

  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
  weekStart.setUTCHours(0, 0, 0, 0);
  const [weeklyMeetings] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(meetings)
    .where(
      and(
        gte(meetings.startAt, weekStart.toISOString()),
        sql`${meetings.projectId} IN (SELECT id FROM projects WHERE ${scope})`,
      ),
    );
  const [traveling] = await db
    .select({ n: sql<number>`count(distinct ${travelRequests.applicantId})::int` })
    .from(travelRequests)
    .where(
      and(
        eq(travelRequests.status, "in_progress"),
        sql`${travelRequests.projectId} IN (SELECT id FROM projects WHERE ${scope})`,
      ),
    );

  // 时间卡（arch/07 §6：本周已批准/待审批工时，有效口径 approved+locked；周起点复用上方 weekStart）
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const timeRows = await db
    .select({
      status: timesheetPeriods.status,
      minutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)::int`,
    })
    .from(timeEntries)
    .innerJoin(timesheetPeriods, eq(timesheetPeriods.id, timeEntries.periodId))
    .where(
      and(
        gte(timeEntries.workDate, weekStartStr),
        sql`(${timeEntries.projectId} is null OR ${timeEntries.projectId} IN (SELECT id FROM projects WHERE ${scope}))`,
      ),
    )
    .groupBy(timesheetPeriods.status);
  const minutesByStatus = new Map(timeRows.map((r) => [r.status, Number(r.minutes)]));
  const timeCard = {
    weekStart: weekStartStr,
    approvedMinutes: (minutesByStatus.get("approved") ?? 0) + (minutesByStatus.get("locked") ?? 0),
    pendingMinutes: minutesByStatus.get("pending_approval") ?? 0,
  };

  // 收款卡（arch/09 §2：角色范围过滤；finance/partner 可见）
  let receiptsSummary: { registeredCents: number; voidedCents: number; netCents: number } | null = null;
  if (user.globalRoles.includes("finance") || user.globalRoles.includes("partner")) {
    const receiptRow = await db
      .select({
        registered: sql<number>`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'registered'), 0)::float8`,
        voided: sql<number>`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'voided'), 0)::float8`,
      })
      .from(paymentReceipts)
      .where(
        user.globalRoles.includes("finance")
          ? sql`true` // finance 处理职责：全量（与 expense list 同口径）
          : sql`${paymentReceipts.projectId} IN (SELECT id FROM projects WHERE ${scope})`,
      );
    receiptsSummary = {
      registeredCents: Number(receiptRow[0].registered),
      voidedCents: Number(receiptRow[0].voided),
      netCents: Number(receiptRow[0].registered) - Number(receiptRow[0].voided),
    };
  }

  // 财务摘要（arch/06 §8：角色过滤，成员不见）
  let financeSummary: { effectiveBudgetCents: number; actualCents: number; reservedCents: number } | null = null;
  if (user.globalRoles.includes("partner") || user.globalRoles.includes("finance")) {
    const finRows = await db
      .select({ effective: sql<number>`coalesce(sum(${budgets.totalCents}), 0)::bigint` })
      .from(budgets)
      .where(and(eq(budgets.status, "active"), sql`${budgets.projectId} IN (SELECT id FROM projects WHERE ${scope})`));
    const ledRows = await db
      .select({
        reserved: sql<number>`coalesce(sum(${budgetLedger.reservedDeltaCents}), 0)::bigint`,
        actual: sql<number>`coalesce(sum(${budgetLedger.actualDeltaCents}), 0)::bigint`,
      })
      .from(budgetLedger)
      .where(sql`${budgetLedger.projectId} IN (SELECT id FROM projects WHERE ${scope})`);
    financeSummary = {
      effectiveBudgetCents: Number(finRows[0].effective),
      reservedCents: Number(ledRows[0].reserved),
      actualCents: Number(ledRows[0].actual),
    };
  }

  return {
    asOf: nowIso(),
    projects: pulse,
    pendingApprovals: pendingApprovals.n,
    pendingDecisions: pendingDecisions.n,
    blockingQuality: blockingQuality.n,
    weeklyMeetings: weeklyMeetings.n,
    travelingCount: traveling.n,
    financeSummary,
    receiptsSummary,
    timeCard,
  };
}

/* ===== audit.list（audit.read 动作授权，arch/03 §3） ===== */

export async function auditList(
  db: DbOrTx,
  user: SessionUser,
  input: {
    cursor?: string;
    limit: number;
    actorId?: string;
    targetType?: string;
    action?: string;
    from?: string;
    to?: string;
  },
) {
  const allowed = await can(db, user, "audit.read", { type: "project", projectId: "" });
  if (!allowed) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "无审计查阅权限");
  }
  const conditions: (SQL | undefined)[] = [];
  if (input.actorId) conditions.push(eq(auditEvents.actorId, input.actorId));
  if (input.targetType) conditions.push(eq(auditEvents.targetType, input.targetType));
  if (input.action) conditions.push(eq(auditEvents.action, input.action));
  if (input.from) conditions.push(sql`${auditEvents.createdAt} >= ${input.from}`);
  if (input.to) conditions.push(sql`${auditEvents.createdAt} <= ${input.to}`);
  conditions.push(cursorCondition(input.cursor, auditEvents.createdAt, auditEvents.id));

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
