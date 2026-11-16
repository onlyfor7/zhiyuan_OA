import { and, desc, eq, gte, isNull, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import {
  accessGrants,
  approvalInstances,
  approvalSteps,
  auditEvents,
  budgets,
  budgetLedger,
  changeRequests,
  decisions,
  expenseAdjustments,
  expenseItems,
  expenseReports,
  fundingRequests,
  genericRequests,
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
  travelSegments,
  users,
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
  const names = await approvalNameMaps(db, page.map((r) => r.instance));
  return {
    items: page.map((r) => ({
      step: { seq: r.step.seq, countersign: r.step.countersign, actedAt: r.step.actedAt },
      instance: {
        id: r.instance.id,
        code: r.instance.code,
        bizType: r.instance.bizType,
        bizId: r.instance.bizId,
        projectId: r.instance.projectId,
        projectName: r.instance.projectId ? (names.projects.get(r.instance.projectId) ?? null) : null,
        applicantName: names.applicants.get(r.instance.applicantId) ?? null,
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

/** 审批列表/详情名称映射：项目名+申请人名（arch/12 §16.2：禁 uuid 截断直出） */
async function approvalNameMaps(
  db: DbOrTx,
  instances: Array<{ projectId: string | null; applicantId: string }>,
): Promise<{ projects: Map<string, string>; applicants: Map<string, string> }> {
  const projectIds = [...new Set(instances.map((i) => i.projectId).filter((x): x is string => !!x))];
  const applicantIds = [...new Set(instances.map((i) => i.applicantId))];
  const projectRows = projectIds.length
    ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(sql`${projects.id} IN (${sql.join(projectIds.map((x) => sql`${x}`), sql`, `)})`)
    : [];
  const applicantRows = applicantIds.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(sql`${users.id} IN (${sql.join(applicantIds.map((x) => sql`${x}`), sql`, `)})`)
    : [];
  return {
    projects: new Map(projectRows.map((r) => [r.id, r.name])),
    applicants: new Map(applicantRows.map((r) => [r.id, r.name])),
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
  const names = await approvalNameMaps(db, page);
  return {
    items: page.map((r) => ({
      ...r,
      projectName: r.projectId ? (names.projects.get(r.projectId) ?? null) : null,
      applicantName: names.applicants.get(r.applicantId) ?? null,
    })),
    nextCursor:
      rows.length > input.limit && last ? encodeCursor(last.submittedAt, last.id) : null,
  };
}


/** 20-02：cc 接收人只读可见（policy_snapshot.ccRecipients）+ 表单权限矩阵过滤（arch/14 §8/§9） */
function ccRecipientsOf(instance: { policySnapshot: unknown }): string[] {
  const snap = (instance.policySnapshot ?? {}) as { ccRecipients?: string[] };
  return Array.isArray(snap.ccRecipients) ? snap.ccRecipients : [];
}

async function viewerFieldPerms(
  db: DbOrTx,
  instance: { id: string; policySnapshot: unknown; currentStepSeq: number; status: string },
  userId: string,
): Promise<Record<string, { read?: boolean; edit?: boolean; hidden?: boolean }> | null> {
  if (instance.status !== "pending") return null;
  const [step] = await db
    .select({ seq: approvalSteps.seq })
    .from(approvalSteps)
    .where(and(eq(approvalSteps.instanceId, instance.id), eq(approvalSteps.status, "pending"), eq(approvalSteps.approverId, userId)))
    .orderBy(approvalSteps.seq)
    .limit(1);
  if (!step) return null;
  const meta = (instance.policySnapshot as { stepMeta?: Record<string, { fieldPerms?: Record<string, { read?: boolean; edit?: boolean; hidden?: boolean }> }> }).stepMeta?.[String(step.seq)];
  return meta?.fieldPerms ?? null;
}

function filterSnapshotByFieldPerms(
  snapshot: Record<string, unknown>,
  fieldPerms: Record<string, { read?: boolean; edit?: boolean; hidden?: boolean }> | null,
): Record<string, unknown> {
  if (!fieldPerms) return snapshot;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    const perm = fieldPerms[key] ?? fieldPerms[key.replace(/^form\./, "")];
    if (perm?.hidden === true) continue; // hidden 字段不进序列化
    out[key] = value; // read 只读；edit 本期不落运行时（P2，arch/14 §9）
  }
  return out;
}

export async function getApprovalById(db: DbOrTx, user: SessionUser, id: string) {
  const [instance] = await db.select().from(approvalInstances).where(eq(approvalInstances.id, id)).limit(1);
  if (!instance) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "审批不存在或无权访问");
  const isApprover = await db
    .select({ id: approvalSteps.id })
    .from(approvalSteps)
    .where(and(eq(approvalSteps.instanceId, id), eq(approvalSteps.approverId, user.id)))
    .limit(1);
  const isCcRecipient = ccRecipientsOf(instance).includes(user.id);
  const allowed =
    instance.applicantId === user.id ||
    isApprover.length > 0 ||
    isCcRecipient ||
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
  const perms = await viewerFieldPerms(db, instance, user.id);
  const filteredInstance = perms ? { ...instance, formSnapshot: filterSnapshotByFieldPerms(instance.formSnapshot, perms) } : instance;
  return { ...filteredInstance, viewerRole: isCcRecipient && instance.applicantId !== user.id && isApprover.length === 0 ? ("cc" as const) : undefined, steps, flowProgress };
}

/* ===== approval.detail（arch/12 §16.2：审批中心业务详情聚合） ===== */

/**
 * 审批详情聚合：通用字段（名称映射禁 uuid）+ 按 biz_type 业务快照。
 * 权限=申请人 ∪ 当前步骤审批人（approverId 或角色成员，与 approval.act 同口径）；其余同形 404。
 */
export async function getApprovalDetail(db: DbOrTx, user: SessionUser, id: string) {
  const [instance] = await db.select().from(approvalInstances).where(eq(approvalInstances.id, id)).limit(1);
  if (!instance) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "审批不存在或无权访问");

  const currentSteps = await db
    .select()
    .from(approvalSteps)
    .where(and(eq(approvalSteps.instanceId, id), eq(approvalSteps.status, "pending")))
    .orderBy(approvalSteps.seq);
  const isCurrentApprover =
    instance.status === "pending" &&
    (await Promise.all(
      currentSteps.map(async (step) => {
        if (step.approverId === user.id) return true;
        if (!step.approverRole) return false;
        const { resolveRoleCandidates } = await import("../../services/approval/engine");
        return (await resolveRoleCandidates(db, step.approverRole, instance.projectId)).includes(user.id);
      }),
    )).some(Boolean);
  const isCcRecipient = ccRecipientsOf(instance).includes(user.id);
  if (instance.applicantId !== user.id && !isCurrentApprover && !isCcRecipient) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "审批不存在或无权访问");
  }

  const names = await approvalNameMaps(db, [instance]);
  const perms = await viewerFieldPerms(db, instance, user.id);
  const filteredFormSnapshot = filterSnapshotByFieldPerms(instance.formSnapshot, perms);
  const snapshot = await buildBizSnapshot(db, instance.bizType, instance.bizId, filteredFormSnapshot);
  return {
    id: instance.id,
    code: instance.code,
    bizType: instance.bizType,
    bizId: instance.bizId,
    status: instance.status,
    submittedAt: instance.submittedAt,
    currentStepSeq: instance.currentStepSeq,
    projectName: instance.projectId ? (names.projects.get(instance.projectId) ?? null) : null,
    applicantName: names.applicants.get(instance.applicantId) ?? null,
    steps: currentSteps.map((s) => ({ seq: s.seq, status: s.status, approverId: s.approverId })),
    snapshot,
  };
}

/** 业务快照按 biz_type 分派（形状随棒测试钉住；实体缺失返回 null 字段而非 500） */
async function buildBizSnapshot(
  db: DbOrTx,
  bizType: string,
  bizId: string,
  formSnapshot: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (bizType) {
    case "expense": {
      const [report] = await db.select().from(expenseReports).where(eq(expenseReports.id, bizId)).limit(1);
      if (!report) return { kind: bizType };
      const items = await db
        .select({
          category: expenseItems.category,
          date: expenseItems.date,
          amountCents: expenseItems.amountCents,
          description: expenseItems.description,
          projectId: expenseItems.projectId,
        })
        .from(expenseItems)
        .where(eq(expenseItems.expenseReportId, bizId))
        .orderBy(expenseItems.date);
      const projectIds = [...new Set(items.map((i) => i.projectId).filter((x): x is string => !!x))];
      const projectRows = projectIds.length
        ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(sql`${projects.id} IN (${sql.join(projectIds.map((x) => sql`${x}`), sql`, `)})`)
        : [];
      const projectNames = new Map(projectRows.map((r) => [r.id, r.name]));
      return {
        kind: "expense",
        reason: report.reason,
        reportCode: report.code,
        totalCents: report.totalCents,
        itemCount: items.length,
        items: items.map((i) => ({
          category: i.category,
          date: i.date,
          amountCents: i.amountCents,
          description: i.description,
          projectName: i.projectId ? (projectNames.get(i.projectId) ?? null) : null,
        })),
      };
    }
    case "expense_adjustment": {
      const [adj] = await db.select().from(expenseAdjustments).where(eq(expenseAdjustments.id, bizId)).limit(1);
      if (!adj) return { kind: bizType };
      const [report] = adj.expenseReportId
        ? await db.select({ code: expenseReports.code, reason: expenseReports.reason }).from(expenseReports).where(eq(expenseReports.id, adj.expenseReportId)).limit(1)
        : [];
      return {
        kind: "expense_adjustment",
        deltaCents: adj.deltaCents,
        reason: adj.reason,
        sourceReportCode: report?.code ?? null,
        sourceReportReason: report?.reason ?? null,
      };
    }
    case "funding": {
      const [funding] = await db.select().from(fundingRequests).where(eq(fundingRequests.id, bizId)).limit(1);
      if (!funding) return { kind: bizType };
      return {
        kind: "funding",
        code: funding.code,
        purpose: funding.purpose,
        amountCents: funding.amountCents,
        expectedUseDate: funding.expectedUseDate,
        recipientInfo: funding.recipientInfo,
        usageStatus: funding.usageStatus,
      };
    }
    case "travel": {
      const [travel] = await db.select().from(travelRequests).where(eq(travelRequests.id, bizId)).limit(1);
      if (!travel) return { kind: bizType };
      const segments = await db
        .select()
        .from(travelSegments)
        .where(eq(travelSegments.travelRequestId, bizId))
        .orderBy(travelSegments.seq);
      return {
        kind: "travel",
        code: travel.code,
        reason: travel.reason,
        destination: travel.destination,
        startOn: travel.startOn,
        endOn: travel.endOn,
        borrow: travel.borrow,
        borrowAmountCents: travel.borrowAmountCents,
        estimatedCostCents: travel.estimatedCostCents,
        segments: segments.map((s) => ({
          seq: s.seq,
          type: s.type,
          startAt: s.startAt,
          endAt: s.endAt,
          fromPlace: s.fromPlace,
          toPlace: s.toPlace,
        })),
      };
    }
    case "travel_change": {
      // 引擎快照形态：{ changePayload: { changes, before } } + reason（submitTravelChange 落库口径）
      const snap = formSnapshot as { reason?: string; changes?: Record<string, unknown>; changePayload?: { changes?: Record<string, unknown> } };
      const [travel] = await db.select().from(travelRequests).where(eq(travelRequests.id, bizId)).limit(1);
      return {
        kind: "travel_change",
        reason: snap.reason ?? null,
        changes: snap.changePayload?.changes ?? snap.changes ?? {},
        travel: travel
          ? {
              code: travel.code,
              reason: travel.reason,
              destination: travel.destination,
              startOn: travel.startOn,
              endOn: travel.endOn,
            }
          : null,
      };
    }
    case "generic_request": {
      const [req] = await db.select().from(genericRequests).where(eq(genericRequests.id, bizId)).limit(1);
      if (!req) return { kind: bizType };
      return {
        kind: "generic_request",
        code: req.code,
        requestType: req.requestType,
        title: req.title,
        reason: req.reason,
        startOn: req.startOn,
        endOn: req.endOn,
        amountCents: req.amountCents,
      };
    }
    case "timesheet": {
      const [period] = await db.select().from(timesheetPeriods).where(eq(timesheetPeriods.id, bizId)).limit(1);
      if (!period) return { kind: bizType };
      const entries = await db
        .select({
          workDate: timeEntries.workDate,
          durationMinutes: timeEntries.durationMinutes,
          description: timeEntries.description,
          activityType: timeEntries.activityType,
          projectId: timeEntries.projectId,
        })
        .from(timeEntries)
        .where(eq(timeEntries.periodId, bizId))
        .orderBy(timeEntries.workDate);
      const projectIds = [...new Set(entries.map((e) => e.projectId).filter((x): x is string => !!x))];
      const projectRows = projectIds.length
        ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(sql`${projects.id} IN (${sql.join(projectIds.map((x) => sql`${x}`), sql`, `)})`)
        : [];
      const projectNames = new Map(projectRows.map((r) => [r.id, r.name]));
      const totalMinutes = entries.reduce((sum, e) => sum + e.durationMinutes, 0);
      return {
        kind: "timesheet",
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        periodStatus: period.status,
        totalMinutes,
        totalHours: Math.round((totalMinutes / 60) * 100) / 100,
        entries: entries.map((e) => ({
          workDate: e.workDate,
          durationMinutes: e.durationMinutes,
          activityType: e.activityType,
          description: e.description,
          projectName: e.projectId ? (projectNames.get(e.projectId) ?? null) : null,
        })),
      };
    }
    case "change_request": {
      const [cr] = await db.select().from(changeRequests).where(eq(changeRequests.id, bizId)).limit(1);
      if (!cr) return { kind: bizType };
      return {
        kind: "change_request",
        code: cr.code,
        title: cr.title,
        reason: cr.reason,
        impact: cr.impact,
      };
    }
    case "access_grant": {
      const [grant] = await db.select().from(accessGrants).where(eq(accessGrants.id, bizId)).limit(1);
      if (!grant) return { kind: bizType };
      return {
        kind: "access_grant",
        scopeType: grant.scopeType,
        scopeId: grant.scopeId,
        actions: grant.actions,
        expiresAt: grant.expiresAt,
        grantStatus: grant.status,
      };
    }
    case "budget": {
      const [budget] = await db.select().from(budgets).where(eq(budgets.id, bizId)).limit(1);
      if (!budget) return { kind: bizType };
      return {
        kind: "budget",
        totalCents: budget.totalCents,
        currency: budget.currency,
        budgetStatus: budget.status,
      };
    }
    default:
      return { kind: bizType };
  }
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
