import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import {
  decisions,
  expenseItems,
  expenseReports,
  fileObjects,
  fileVersions,
  fundingRequests,
  meetings,
  projects,
  qualityIssues,
  tasks,
  timeEntries,
  timesheetPeriods,
  travelRequests,
  weeklyReports,
} from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { projectScopeFilter } from "../../services/access";
import { canFinanceSummary } from "../finance/budget";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * 全局搜索（arch/07 §5 逐字）：十类对象；SQL 级权限过滤先于组装；
 * 无权限对象整体不可见（不返回标题/编号外任何信息）；金额按财务可见权；
 * 命中计数按可见集合；搜索不逐条审计（导出才审计）。
 */

export type SearchType =
  | "project"
  | "task"
  | "meeting"
  | "travel"
  | "funding"
  | "expense"
  | "decision"
  | "quality_issue"
  | "weekly_report"
  | "time_entry"
  | "document";

const ALL_TYPES: SearchType[] = [
  "project",
  "task",
  "meeting",
  "travel",
  "funding",
  "expense",
  "decision",
  "quality_issue",
  "weekly_report",
  "time_entry",
  "document",
];

export interface SearchHit {
  type: SearchType;
  id: string;
  code: string | null;
  title: string;
  snippet?: string;
  projectId?: string | null;
  deepLink: string;
  /** 仅当用户对该对象有财务可见权时返回（E2E-11） */
  amountCents?: number;
}

const PER_TYPE_LIMIT = 8;

function like(keyword: string): string {
  const escaped = keyword.replace(/[\\%_]/g, (m) => `\\${m}`);
  return `%${escaped}%`;
}

function memberProjects(user: SessionUser): SQL {
  return sql`${projects.id} IN (SELECT project_id FROM project_members WHERE user_id = ${user.id})`;
}

function participantMeetings(user: SessionUser): SQL {
  return sql`exists (SELECT 1 FROM meeting_participants mp WHERE mp.meeting_id = ${meetings.id} AND mp.user_id = ${user.id})`;
}

export async function searchQuery(
  db: DbOrTx,
  user: SessionUser,
  input: { q: string; types?: SearchType[]; cursor?: string; limit?: number },
): Promise<{ items: SearchHit[]; nextCursor: string | null; totalByType: Partial<Record<SearchType, number>> }> {
  const q = input.q.trim();
  if (!q) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "搜索关键词必填", { q: ["搜索关键词必填"] });
  const types = (input.types?.length ? input.types : ALL_TYPES).filter((t) => ALL_TYPES.includes(t));
  const limit = Math.min(input.limit ?? PER_TYPE_LIMIT, 20);
  const offset = input.cursor ? Number(Buffer.from(input.cursor, "base64url").toString("utf8")) || 0 : 0;

  const hits: SearchHit[] = [];
  const totalByType: Partial<Record<SearchType, number>> = {};
  const kw = like(q);

  for (const type of types) {
    const rows = await searchByType(db, user, type, kw, limit + 1, offset);
    totalByType[type] = rows.total;
    for (const hit of rows.items) hits.push(hit);
  }

  hits.sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""));
  const page = hits.slice(0, limit);
  const anyMore = Object.values(totalByType).some((t) => (t ?? 0) > offset + limit);
  return {
    items: page,
    nextCursor: anyMore ? Buffer.from(String(offset + limit), "utf8").toString("base64url") : null,
    totalByType,
  };
}

async function searchByType(
  db: DbOrTx,
  user: SessionUser,
  type: SearchType,
  kw: string,
  take: number,
  offset: number,
): Promise<{ items: SearchHit[]; total: number }> {
  const projectVisible = memberProjects(user);
  const financeOf = async (projectId: string | null | undefined): Promise<boolean> =>
    !!projectId && canFinanceSummary(user, projectId);

  switch (type) {
    case "project": {
      // 可见 = 成员 ∪ grant（SQL 级 scope 过滤先于组装，arch/03 §5）
      const where = and(
        projectScopeFilter(user),
        or(ilike(projects.name, kw), ilike(projects.code, kw)),
      );
      const [rows, count] = await Promise.all([
        db.select().from(projects).where(where).orderBy(desc(projects.updatedAt)).limit(take).offset(offset),
        db.select({ n: sql<number>`count(*)::int` }).from(projects).where(where),
      ]);
      return {
        total: count[0].n,
        items: rows.map((p) => ({
          type,
          id: p.id,
          code: p.code,
          title: p.name,
          projectId: p.id,
          deepLink: `/projects/${p.id}`,
        })),
      };
    }
    case "task": {
      const where = and(
        sql`${tasks.projectId} IN (SELECT id FROM projects WHERE ${projectVisible})`,
        or(ilike(tasks.title, kw), ilike(tasks.code, kw)),
      );
      const [rows, count] = await Promise.all([
        db.select().from(tasks).where(where).orderBy(desc(tasks.updatedAt)).limit(take).offset(offset),
        db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(where),
      ]);
      return {
        total: count[0].n,
        items: rows.map((t) => ({
          type,
          id: t.id,
          code: t.code,
          title: t.title,
          projectId: t.projectId,
          deepLink: `/projects/${t.projectId}/plan?task=${t.id}`,
        })),
      };
    }
    case "meeting": {
      const where = and(
        or(
          sql`${meetings.projectId} IN (SELECT id FROM projects WHERE ${projectVisible})`,
          participantMeetings(user),
        ),
        or(ilike(meetings.subject, kw), ilike(meetings.code, kw)),
      );
      const [rows, count] = await Promise.all([
        db.select().from(meetings).where(where).orderBy(desc(meetings.startAt)).limit(take).offset(offset),
        db.select({ n: sql<number>`count(*)::int` }).from(meetings).where(where),
      ]);
      return {
        total: count[0].n,
        items: rows.map((m) => ({
          type,
          id: m.id,
          code: m.code,
          title: m.subject,
          projectId: m.projectId,
          deepLink: `/projects/${m.projectId}/meetings?meeting=${m.id}`,
        })),
      };
    }
    case "travel": {
      const where = and(
        or(
          eq(travelRequests.applicantId, user.id),
          sql`${travelRequests.projectId} IN (SELECT id FROM projects WHERE ${projectVisible})`,
          user.globalRoles.includes("finance") ? sql`true` : sql`false`,
        ),
        or(ilike(travelRequests.reason, kw), ilike(travelRequests.destination, kw), ilike(travelRequests.code, kw)),
      );
      const [rows, count] = await Promise.all([
        db.select().from(travelRequests).where(where).orderBy(desc(travelRequests.createdAt)).limit(take).offset(offset),
        db.select({ n: sql<number>`count(*)::int` }).from(travelRequests).where(where),
      ]);
      const items: SearchHit[] = [];
      for (const r of rows) {
        items.push({
          type,
          id: r.id,
          code: r.code,
          title: `${r.destination}·${r.reason}`,
          projectId: r.projectId,
          deepLink: `/operations/travel?travel=${r.id}`,
          ...(r.projectId && (await financeOf(r.projectId)) ? { amountCents: r.estimatedCostCents ?? undefined } : {}),
        });
      }
      return { total: count[0].n, items };
    }
    case "funding": {
      const where = and(
        or(
          eq(fundingRequests.applicantId, user.id),
          sql`${fundingRequests.projectId} IN (SELECT id FROM projects WHERE ${projectVisible})`,
          user.globalRoles.includes("finance") ? sql`true` : sql`false`,
        ),
        or(ilike(fundingRequests.purpose, kw), ilike(fundingRequests.code, kw)),
      );
      const [rows, count] = await Promise.all([
        db.select().from(fundingRequests).where(where).orderBy(desc(fundingRequests.createdAt)).limit(take).offset(offset),
        db.select({ n: sql<number>`count(*)::int` }).from(fundingRequests).where(where),
      ]);
      const items: SearchHit[] = [];
      for (const r of rows) {
        items.push({
          type,
          id: r.id,
          code: r.code,
          title: r.purpose,
          projectId: r.projectId,
          deepLink: `/projects/${r.projectId}/funding?funding=${r.id}`,
          ...(r.projectId && (await financeOf(r.projectId)) ? { amountCents: r.amountCents } : {}),
        });
      }
      return { total: count[0].n, items };
    }
    case "expense": {
      const where = and(
        or(
          eq(expenseReports.applicantId, user.id),
          sql`exists (SELECT 1 FROM expense_items ei WHERE ei.expense_report_id = ${expenseReports.id} AND ei.project_id IN (SELECT id FROM projects WHERE ${projectVisible}))`,
          user.globalRoles.includes("finance") ? sql`true` : sql`false`,
        ),
        or(ilike(expenseReports.reason, kw), ilike(expenseReports.code, kw)),
      );
      const [rows, count] = await Promise.all([
        db.select().from(expenseReports).where(where).orderBy(desc(expenseReports.createdAt)).limit(take).offset(offset),
        db.select({ n: sql<number>`count(*)::int` }).from(expenseReports).where(where),
      ]);
      const items: SearchHit[] = [];
      for (const r of rows) {
        const [item] = await db.select({ projectId: expenseItems.projectId }).from(expenseItems).where(eq(expenseItems.expenseReportId, r.id)).limit(1);
        items.push({
          type,
          id: r.id,
          code: r.code,
          title: r.reason,
          projectId: item?.projectId ?? null,
          deepLink: `/operations/expense?expense=${r.id}`,
          ...(item?.projectId && (await financeOf(item.projectId)) ? { amountCents: r.totalCents } : {}),
        });
      }
      return { total: count[0].n, items };
    }
    case "decision": {
      const where = and(
        sql`${decisions.projectId} IN (SELECT id FROM projects WHERE ${projectVisible})`,
        or(ilike(decisions.title, kw), ilike(decisions.code, kw)),
      );
      const [rows, count] = await Promise.all([
        db.select().from(decisions).where(where).orderBy(desc(decisions.createdAt)).limit(take).offset(offset),
        db.select({ n: sql<number>`count(*)::int` }).from(decisions).where(where),
      ]);
      return {
        total: count[0].n,
        items: rows.map((d) => ({
          type,
          id: d.id,
          code: d.code,
          title: d.title,
          projectId: d.projectId,
          deepLink: `/projects/${d.projectId}/decisions?decision=${d.id}`,
        })),
      };
    }
    case "quality_issue": {
      const where = and(
        sql`${qualityIssues.projectId} IN (SELECT id FROM projects WHERE ${projectVisible})`,
        or(ilike(qualityIssues.title, kw), ilike(qualityIssues.code, kw)),
      );
      const [rows, count] = await Promise.all([
        db.select().from(qualityIssues).where(where).orderBy(desc(qualityIssues.createdAt)).limit(take).offset(offset),
        db.select({ n: sql<number>`count(*)::int` }).from(qualityIssues).where(where),
      ]);
      return {
        total: count[0].n,
        items: rows.map((x) => ({
          type,
          id: x.id,
          code: x.code,
          title: x.title,
          projectId: x.projectId,
          deepLink: `/projects/${x.projectId}/quality?issue=${x.id}`,
        })),
      };
    }
    case "weekly_report": {
      const where = and(
        sql`${weeklyReports.projectId} IN (SELECT id FROM projects WHERE ${projectVisible})`,
        or(ilike(weeklyReports.code, kw), sql`${weeklyReports.content}->>'progress' ilike ${kw}`),
      );
      const [rows, count] = await Promise.all([
        db.select().from(weeklyReports).where(where).orderBy(desc(weeklyReports.createdAt)).limit(take).offset(offset),
        db.select({ n: sql<number>`count(*)::int` }).from(weeklyReports).where(where),
      ]);
      return {
        total: count[0].n,
        items: rows.map((r) => ({
          type,
          id: r.id,
          code: r.code,
          title: `周报 ${r.periodStart}~${r.periodEnd}`,
          projectId: r.projectId,
          deepLink: `/projects/${r.projectId}/reports?report=${r.id}`,
        })),
      };
    }
    case "time_entry": {
      // 仅本人（arch/07 §5）；无金额字段
      const where = and(
        eq(timeEntries.userId, user.id),
        sql`${timeEntries.description} ilike ${kw}`,
      );
      const [rows, count] = await Promise.all([
        db
          .select({ entry: timeEntries, periodCode: timesheetPeriods.code })
          .from(timeEntries)
          .innerJoin(timesheetPeriods, eq(timesheetPeriods.id, timeEntries.periodId))
          .where(where)
          .orderBy(desc(timeEntries.workDate))
          .limit(take)
          .offset(offset),
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(timeEntries)
          .innerJoin(timesheetPeriods, eq(timesheetPeriods.id, timeEntries.periodId))
          .where(where),
      ]);
      return {
        total: count[0].n,
        items: rows.map((r) => ({
          type,
          id: r.entry.id,
          code: r.periodCode,
          title: r.entry.description || "（无说明）",
          projectId: r.entry.projectId,
          deepLink: `/operations/time?period=${r.entry.periodId}&entry=${r.entry.id}`,
        })),
      };
    }
    case "document": {
      // file_objects 名称：上传人本人 / 来源项目成员 / grant（canReadFile 口径简化复用：此处 SQL 级）
      const where = and(
        or(
          eq(fileObjects.createdBy, user.id),
          sql`${fileObjects.sourceType} = 'project' AND ${fileObjects.sourceId} IN (SELECT project_id FROM project_members WHERE user_id = ${user.id})`,
          sql`exists (SELECT 1 FROM file_versions fv2 WHERE fv2.file_object_id = ${fileObjects.id} AND exists (
            SELECT 1 FROM expense_items ei WHERE ei.receipt_file_version_id = fv2.id
            AND (ei.project_id IN (SELECT project_id FROM project_members WHERE user_id = ${user.id}))
          ))`,
        ),
        sql`${fileObjects.id}::text ilike ${kw} OR exists (
          SELECT 1 FROM file_versions fv3 WHERE fv3.file_object_id = ${fileObjects.id} AND fv3.storage_key ilike ${kw}
        )`,
      );
      const [rows, count] = await Promise.all([
        db.select().from(fileObjects).where(where).orderBy(desc(fileObjects.createdAt)).limit(take).offset(offset),
        db.select({ n: sql<number>`count(*)::int` }).from(fileObjects).where(where),
      ]);
      const items: SearchHit[] = [];
      for (const f of rows) {
        const [version] = await db
          .select({ storageKey: fileVersions.storageKey })
          .from(fileVersions)
          .where(eq(fileVersions.fileObjectId, f.id))
          .orderBy(desc(fileVersions.uploadedAt))
          .limit(1);
        items.push({
          type,
          id: f.id,
          code: null,
          title: version?.storageKey.split("/").pop() ?? "文件",
          projectId: f.sourceType === "project" ? f.sourceId : null,
          deepLink: f.currentVersionId ? `/files/${f.currentVersionId}/preview` : "#",
        });
      }
      return { total: count[0].n, items };
    }
  }
  return { items: [], total: 0 };
}
