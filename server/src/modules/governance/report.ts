import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { archiveDirectories, archiveLinks, changeRequests, decisions, expenseReports, projects, qualityIssues, tasks, users, weeklyReports } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { can, requireProjectMember, requireProjectRead } from "../../services/access";
import { notify } from "../../modules/notify";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "./util";

/**
 * 周报域 service（arch/04 §5 report.* + §2.7）：
 * generateDraft 真实聚合本周任务/质量/决策/延期；confirm 固定版本（幂等）；
 * 已确认后再改 = 同期间 version_no+1 新 draft；archive 只读 + archive_links 目录 06。
 */

const REPORT_DIR_KEY = "06_周报与月报";

function notFound(): BusinessError {
  return new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "周报不存在或无权访问");
}

async function loadVisible(db: DbOrTx, user: SessionUser, id: string) {
  const [report] = await db.select().from(weeklyReports).where(eq(weeklyReports.id, id)).limit(1);
  if (!report) throw notFound();
  await requireProjectRead(db, user, report.projectId);
  return report;
}

async function requireReportManager(db: DbOrTx, user: SessionUser, projectId: string): Promise<void> {
  const manage = await can(db, user, "project.manage", { type: "project", projectId });
  if (!manage) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅项目负责人可管理周报");
  }
}

/** 真实聚合（arch/04 §2.7：本周完成任务/质量事件/决策/延期） */
async function aggregateContent(
  db: DbOrTx,
  projectId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Record<string, unknown>> {
  const doneTasks = await db
    .select({ code: tasks.code, title: tasks.title })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.status, "done"),
        sql`${tasks.completedAt}::date BETWEEN ${periodStart}::date AND ${periodEnd}::date`,
      ),
    );
  const openTasks = await db
    .select({ code: tasks.code, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), sql`${tasks.status} in ('pending', 'in_progress')`))
    .limit(10);
  const quality = await db
    .select({ code: qualityIssues.code, title: qualityIssues.title, status: qualityIssues.status })
    .from(qualityIssues)
    .where(and(eq(qualityIssues.projectId, projectId), sql`${qualityIssues.status} <> 'closed'`))
    .limit(10);
  const decided = await db
    .select({ code: changeRequests.code, title: changeRequests.title, status: changeRequests.status })
    .from(changeRequests)
    .where(
      and(
        eq(changeRequests.projectId, projectId),
        sql`${changeRequests.decidedAt}::date BETWEEN ${periodStart}::date AND ${periodEnd}::date`,
      ),
    );
  const decisionRows = await db
    .select({ code: decisions.code, title: decisions.title, status: decisions.status })
    .from(decisions)
    .where(eq(decisions.projectId, projectId))
    .limit(10);

  // 本周费用节（arch/06 §8：本周已批准报销额/笔数，来源可溯）
  const approvedExpenses = await db
    .select({ code: expenseReports.code, totalCents: expenseReports.totalCents })
    .from(expenseReports)
    .where(
      and(
        sql`exists (SELECT 1 FROM expense_items ei WHERE ei.expense_report_id = ${expenseReports.id} AND ei.project_id = ${projectId})`,
        sql`${expenseReports.status} in ('approved_pending_payment', 'paid')`,
        sql`${expenseReports.updatedAt}::date BETWEEN ${periodStart}::date AND ${periodEnd}::date`,
      ),
    )
    .groupBy(expenseReports.id, expenseReports.code, expenseReports.totalCents);
  const expenseAmount = approvedExpenses.reduce((sum, e) => sum + Number(e.totalCents), 0);
  const expensesSection =
    approvedExpenses.length > 0
      ? `本周已批准报销 ${approvedExpenses.length} 笔，合计 ${expenseAmount} 分（${approvedExpenses.map((e) => e.code).join("、")}）。`
      : "本周无已批准报销。";

  // 工时节（arch/07 §6/§7：本周已批准按人员/活动类型汇总 + 待审批单列；同一聚合口径）
  const { aggregateTime } = await import("../time/stats");
  const [timeByPerson, timeByActivity, timePending] = await Promise.all([
    aggregateTime(db, {
      from: periodStart,
      to: periodEnd,
      statuses: ["approved", "locked"],
      groupBy: "user",
      scopeProjects: sql`${projects.id} = ${projectId}`,
    }),
    aggregateTime(db, {
      from: periodStart,
      to: periodEnd,
      statuses: ["approved", "locked"],
      groupBy: "activity",
      scopeProjects: sql`${projects.id} = ${projectId}`,
    }),
    aggregateTime(db, {
      from: periodStart,
      to: periodEnd,
      statuses: ["pending_approval"],
      groupBy: "user",
      scopeProjects: sql`${projects.id} = ${projectId}`,
    }),
  ]);
  const userNames = new Map(
    (await db.select({ id: users.id, name: users.name }).from(users)).map((u) => [u.id, u.name]),
  );
  const fmtTime = (items: typeof timeByPerson.items) =>
    items.length === 0
      ? "无"
      : items.map((i) => `${userNames.get(i.key ?? "") ?? i.key}:${i.minutes}分钟`).join("；");
  const timeSection =
    `已批准工时（有效口径）：${timeByPerson.items.reduce((s, i) => s + i.minutes, 0)} 分钟。` +
    `按人员：${fmtTime(timeByPerson.items)}。按活动：${timeByActivity.items.map((i) => `${i.key}:${i.minutes}分钟`).join("；")}。` +
    `待审批单列：${timePending.items.reduce((s, i) => s + i.minutes, 0)} 分钟（${fmtTime(timePending.items)}）。`;

  return {
    progress: doneTasks.length
      ? `本周完成任务：${doneTasks.map((t) => t.title).join("；")}`
      : "本周无完成任务。",
    tasks: openTasks.length
      ? `进行中/待处理：${openTasks.map((t) => `${t.title}(${t.code})`).join("；")}`
      : "无未完成任务。",
    quality: quality.length
      ? `未关闭质量问题：${quality.map((q) => `${q.title}[${q.status}]`).join("；")}`
      : "无未关闭质量问题。",
    decisions: [
      ...decided.map((c) => `延期申请 ${c.code}：${c.title} → ${c.status}`),
      ...decisionRows.map((d) => `决策 ${d.code}：${d.title}[${d.status}]`),
    ].join("；") || "本周无决策事项。",
    risks: quality.some((q) => q.status === "pending_review") ? "存在待复核质量问题，需关注。" : "",
    next_week: "",
    expenses: expensesSection,
    time: timeSection,
  };
}

export async function generateDraft(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId: string; periodStart: string; periodEnd: string },
) {
  await requireProjectMember(db, user, input.projectId);
  await requireReportManager(db, user, input.projectId);
  if (input.periodEnd < input.periodStart) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "期间结束日不能早于开始日", {
      periodEnd: ["期间结束日不能早于开始日"],
    });
  }
  const content = await aggregateContent(db, input.projectId, input.periodStart, input.periodEnd);
  const [maxVersion] = await db
    .select({ max: sql<number>`coalesce(max(${weeklyReports.versionNo}), 0)` })
    .from(weeklyReports)
    .where(
      and(
        eq(weeklyReports.projectId, input.projectId),
        eq(weeklyReports.periodStart, input.periodStart),
      ),
    );
  const versionNo = Number(maxVersion.max) + 1;
  const code = await nextCode("RPT", db);
  const [draft] = await db
    .insert(weeklyReports)
    .values({
      projectId: input.projectId,
      code,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      versionNo,
      status: "draft",
      content,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!draft) throw new Error("周报插入失败");

  await notify(db, {
    eventType: "report_draft_ready",
    recipientId: user.id,
    sourceType: "report",
    sourceId: draft.id,
    payload: { code: draft.code, periodStart: input.periodStart, periodEnd: input.periodEnd },
  });
  return draft;
}

export interface UpdateDraftInput {
  id: string;
  rowVersion: number;
  content: Record<string, unknown>;
}

export async function updateDraft(db: DbOrTx, user: SessionUser, input: UpdateDraftInput) {
  const report = await loadVisible(db, user, input.id);
  await requireReportManager(db, user, report.projectId);
  const now = nowIso();

  if (report.status === "archived") {
    throw new BusinessError(ERROR_CODE.ARCHIVED_READONLY, "已归档周报只读");
  }
  if (report.status === "confirmed") {
    // 已确认后再改 = 同期间 version_no+1 新 draft，旧版本不动（arch/04 §2.7）
    const code = await nextCode("RPT", db);
    const [draft] = await db
      .insert(weeklyReports)
      .values({
        projectId: report.projectId,
        code,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        versionNo: report.versionNo + 1,
        status: "draft",
        content: input.content,
        createdBy: user.id,
        updatedBy: user.id,
      })
      .returning();
    if (!draft) throw new Error("周报新版本插入失败");
    return draft;
  }

  const [updated] = await db
    .update(weeklyReports)
    .set({
      content: input.content,
      updatedBy: user.id,
      updatedAt: now,
      rowVersion: sql`${weeklyReports.rowVersion} + 1`,
    })
    .where(and(eq(weeklyReports.id, input.id), eq(weeklyReports.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  }
  return updated;
}

export async function confirmReport(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; idempotencyKey?: string },
) {
  const report = await loadVisible(db, user, input.id);
  await requireReportManager(db, user, report.projectId);
  const now = nowIso();
  // 幂等：条件更新（并发/重试双击只生效一次，重复 confirm 返回当前对象）
  const [updated] = await db
    .update(weeklyReports)
    .set({
      status: "confirmed",
      confirmedBy: user.id,
      confirmedAt: now,
      updatedBy: user.id,
      updatedAt: now,
      rowVersion: sql`${weeklyReports.rowVersion} + 1`,
    })
    .where(
      and(
        eq(weeklyReports.id, input.id),
        eq(weeklyReports.status, "draft"),
        eq(weeklyReports.rowVersion, input.rowVersion),
      ),
    )
    .returning();
  if (!updated) {
    const [current] = await db.select().from(weeklyReports).where(eq(weeklyReports.id, input.id)).limit(1);
    if (current?.status === "confirmed") return current; // 幂等重放：返回首次结果
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  }
  return updated;
}

export async function archiveReport(db: DbOrTx, user: SessionUser, id: string) {
  const report = await loadVisible(db, user, id);
  await requireReportManager(db, user, report.projectId);
  if (report.status !== "confirmed") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅已确认周报可归档");
  }
  const now = nowIso();
  const [updated] = await db
    .update(weeklyReports)
    .set({ status: "archived", archivedAt: now, updatedBy: user.id, updatedAt: now })
    .where(and(eq(weeklyReports.id, id), eq(weeklyReports.status, "confirmed")))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "周报状态已变化");

  // 归档登记：archive_links 目录 06（source_type='report' 二态报告链接，arch/04 §2.7/§2.8）
  const directory = await db
    .select({ id: archiveDirectories.id })
    .from(archiveDirectories)
    .where(
      and(
        eq(archiveDirectories.projectId, report.projectId),
        eq(archiveDirectories.dirKey, REPORT_DIR_KEY),
      ),
    )
    .limit(1);
  if (directory[0]) {
    await db
      .insert(archiveLinks)
      .values({
        projectId: report.projectId,
        directoryId: directory[0].id,
        fileVersionId: null,
        sourceType: "report",
        sourceId: report.id,
        businessDate: report.periodEnd,
        createdBy: user.id,
      })
      .onConflictDoNothing();
  }
  return updated;
}

export async function listReports(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId: string; cursor?: string; limit: number },
) {
  await requireProjectRead(db, user, input.projectId);
  const conditions: (SQL | undefined)[] = [eq(weeklyReports.projectId, input.projectId)];
  conditions.push(cursorCondition(input.cursor, weeklyReports.createdAt, weeklyReports.id));
  const rows = await db
    .select()
    .from(weeklyReports)
    .where(and(...conditions))
    .orderBy(desc(weeklyReports.createdAt), desc(weeklyReports.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function getReport(db: DbOrTx, user: SessionUser, id: string) {
  return loadVisible(db, user, id);
}
