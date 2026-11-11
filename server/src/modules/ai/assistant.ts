import { and, desc, eq, gte, ne, or, sql } from "drizzle-orm";

import {
  approvalInstances,
  approvalSteps,
  clients,
  expenseReports,
  finReceivables,
  meetings,
  projects,
  tasks,
  timesheetPeriods,
  users,
} from "../../db/schema";
import { projectScopeFilter } from "../../services/access";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * 小元内置提醒服务（arch/12 §19.3）：ai.assistant.feed 聚合当前用户六类提醒——
 * 待办审批/会议临近（30 分钟内）/任务临期（24h）与逾期/工时未填报（本周）/报销待处理/回款临期逾期。
 * 权限按既有口径 SQL 级不放大；回款类按 fin.read 口径（无权限者该类不出现）；只读不审计。
 * 条目 {type, icon(§4.4 注册表域), title, sourceLabel, link, urgency(warn/danger)}，danger 优先+计数汇总。
 */

export interface FeedItem {
  type: "approval" | "meeting" | "task" | "timesheet" | "expense" | "receivable";
  /** §4.4 图标注册表域：approval/meeting/task/time/expense/finance */
  icon: "approval" | "meeting" | "task" | "time" | "expense" | "finance";
  title: string;
  sourceLabel: string;
  link: string;
  urgency: "warn" | "danger";
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** fin.read 口径（与报表域一致）：finance/partner/项目负责人 */
function canReadFin(user: SessionUser): boolean {
  return (
    user.globalRoles.includes("finance") ||
    user.globalRoles.includes("partner") ||
    user.globalRoles.includes("project_manager")
  );
}

export async function assistantFeed(db: DbOrTx, user: SessionUser) {
  const items: FeedItem[] = [];
  const nowIso = new Date().toISOString();
  const today = todayStr();

  // ① 待办审批：待我审批（steps 已落地 approverId=本人，同 listMine 口径）
  {
    const rows = await db
      .select({ instance: approvalInstances, applicantName: users.name })
      .from(approvalSteps)
      .innerJoin(approvalInstances, eq(approvalInstances.id, approvalSteps.instanceId))
      .innerJoin(users, eq(users.id, approvalInstances.applicantId))
      .where(
        and(
          eq(approvalSteps.approverId, user.id),
          eq(approvalSteps.status, "pending"),
          eq(approvalInstances.status, "pending"),
        ),
      )
      .orderBy(desc(approvalInstances.submittedAt))
      .limit(10);
    const bizLabel: Record<string, string> = {
      expense: "报销", expense_adjustment: "费用调整", travel: "出差", travel_change: "差旅变更",
      funding: "经费", timesheet: "工时", generic_request: "申请单", change_request: "延期", access_grant: "授权", budget: "预算",
    };
    for (const r of rows) {
      items.push({
        type: "approval",
        icon: "approval",
        title: `${bizLabel[r.instance.bizType] ?? r.instance.bizType} ${r.instance.code} 待审批`,
        sourceLabel: r.applicantName,
        link: `/approvals?instance=${r.instance.id}`,
        urgency: "warn",
      });
    }
  }

  // ② 会议临近：30 分钟内开始（参会人 ∪ 项目成员，SQL 级可见口径）
  {
    const visibility = or(
      sql`exists (SELECT 1 FROM meeting_participants mp WHERE mp.meeting_id = ${meetings.id} AND mp.user_id = ${user.id})`,
      sql`${meetings.projectId} IN (SELECT id FROM projects WHERE ${projectScopeFilter(user)})`,
    );
    const rows = await db
      .select({ meeting: meetings, projectName: projects.name })
      .from(meetings)
      .leftJoin(projects, eq(projects.id, meetings.projectId))
      .where(
        and(
          eq(meetings.status, "planned"),
          gte(meetings.startAt, nowIso),
          sql`${meetings.startAt} <= ${new Date(Date.now() + 30 * 60 * 1000).toISOString()}`,
          visibility,
        ),
      )
      .orderBy(meetings.startAt)
      .limit(10);
    for (const r of rows) {
      items.push({
        type: "meeting",
        icon: "meeting",
        title: `会议「${r.meeting.subject}」${r.meeting.startAt.slice(11, 16)} 开始`,
        sourceLabel: r.projectName ?? "非项目会议",
        link: r.meeting.projectId
          ? `/projects/${r.meeting.projectId}/meetings?meeting=${r.meeting.id}`
          : `/meetings/${r.meeting.id}`,
        urgency: "warn",
      });
    }
  }

  // ③ 任务临期（24h 内到期）与逾期（ assignedTo 本人 ∪ 项目可见集 ）
  {
    const rows = await db
      .select({ task: tasks, projectName: projects.name })
      .from(tasks)
      .leftJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          sql`${tasks.projectId} IN (SELECT id FROM projects WHERE ${projectScopeFilter(user)})`,
          ne(tasks.status, "done"),
          ne(tasks.status, "cancelled"),
          sql`(${tasks.assigneeId} = ${user.id} OR ${tasks.assigneeId} IS NULL)`,
          // 临期窗口：日期粒度下「24h 内到期」= 计划截止不晚于明天（逾期=早于今天）
          sql`${tasks.plannedEnd} <= ${addDays(today, 1)}`,
        ),
      )
      .orderBy(tasks.plannedEnd)
      .limit(10);
    for (const r of rows) {
      const overdue = r.task.plannedEnd < today;
      items.push({
        type: "task",
        icon: "task",
        title: overdue ? `任务「${r.task.title}」已逾期（计划 ${r.task.plannedEnd}）` : `任务「${r.task.title}」24h 内到期`,
        sourceLabel: r.projectName ?? "",
        link: `/projects/${r.task.projectId}/plan?task=${r.task.id}`,
        urgency: overdue ? "danger" : "warn",
      });
    }
  }

  // ④ 工时未填报：本周周期 draft/returned（或本周无周期行）
  {
    const monday = (() => {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
    const [period] = await db
      .select()
      .from(timesheetPeriods)
      .where(and(eq(timesheetPeriods.userId, user.id), eq(timesheetPeriods.periodStart, monday)))
      .limit(1);
    const needsFill = !period || period.status === "draft" || period.status === "returned";
    if (needsFill) {
      items.push({
        type: "timesheet",
        icon: "time",
        title: period ? `本周工时未提交（${period.status === "returned" ? "被退回待重报" : "草稿"}）` : "本周工时未填报",
        sourceLabel: `${monday} 起本周`,
        link: "/operations/time",
        urgency: period?.status === "returned" ? "danger" : "warn",
      });
    }
  }

  // ⑤ 报销待处理：本人 rejected（danger 被退回）/ draft 有明细未提交（warn 草稿待提交）
  {
    const rows = await db
      .select()
      .from(expenseReports)
      .where(and(eq(expenseReports.applicantId, user.id), sql`${expenseReports.status} IN ('rejected', 'draft')`))
      .orderBy(desc(expenseReports.updatedAt))
      .limit(10);
    for (const r of rows) {
      if (r.status === "rejected") {
        items.push({
          type: "expense",
          icon: "expense",
          title: `报销 ${r.code} 被退回，需修改重提`,
          sourceLabel: r.reason,
          link: `/operations/expense?expense=${r.id}`,
          urgency: "danger",
        });
      } else {
        items.push({
          type: "expense",
          icon: "expense",
          title: `报销草稿 ${r.code} 待提交`,
          sourceLabel: r.reason,
          link: `/operations/expense?expense=${r.id}`,
          urgency: "warn",
        });
      }
    }
  }

  // ⑥ 回款临期/逾期（fin.read 口径——无权限者该类不出现）：应收未结 且 7 天内到期/已逾期
  if (canReadFin(user)) {
    const grace = 7;
    const rows = await db
      .select({ receivable: finReceivables, customerName: clients.name })
      .from(finReceivables)
      .innerJoin(clients, eq(clients.id, finReceivables.customerId))
      .where(
        and(
          ne(finReceivables.status, "settled"),
          sql`${finReceivables.dueDate} <= ${addDays(today, grace)}`,
        ),
      )
      .orderBy(finReceivables.dueDate)
      .limit(10);
    for (const r of rows) {
      const overdue = r.receivable.dueDate < today;
      items.push({
        type: "receivable",
        icon: "finance",
        title: overdue
          ? `应收 ${r.receivable.code} 已逾期（${r.receivable.dueDate} 到期）`
          : `应收 ${r.receivable.code} ${Math.floor((new Date(`${r.receivable.dueDate}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000)} 天内到期`,
        sourceLabel: r.customerName,
        link: "/fin/receivables",
        urgency: overdue ? "danger" : "warn",
      });
    }
  }

  // danger 优先 + 计数汇总
  items.sort((a, b) => (a.urgency === b.urgency ? 0 : a.urgency === "danger" ? -1 : 1));
  const counts = {
    total: items.length,
    danger: items.filter((i) => i.urgency === "danger").length,
    warn: items.filter((i) => i.urgency === "warn").length,
    byType: Object.fromEntries(
      (["approval", "meeting", "task", "timesheet", "expense", "receivable"] as const).map((t) => [
        t,
        items.filter((i) => i.type === t).length,
      ]),
    ),
  };
  return { items, counts };
}
