import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE, type QualityEventAction, type QualitySeverity } from "@lexflow/shared";

import { qualityCheckItems, qualityIssueEvents, qualityIssues, users } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { requireProjectMember, requireProjectRead } from "../../services/access";
import { notify } from "../../modules/notify";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "./util";

/**
 * 质量域 service（arch/04 §5 quality.* + §2.5）：
 * assign/submitHandling/review/reopen 全动作写 quality_issue_events（同事务）；
 * severe/critical 处理人≠复核人（SELF_REVIEW_BLOCKED）；is_blocking 写入时维护；
 * 退回必须 note。
 */

const SEVERE_UP: readonly string[] = ["critical", "severe"];

function notFound(): BusinessError {
  return new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "质量问题不存在或无权访问");
}

async function loadVisible(db: DbOrTx, user: SessionUser, issueId: string) {
  const [issue] = await db.select().from(qualityIssues).where(eq(qualityIssues.id, issueId)).limit(1);
  if (!issue) throw notFound();
  await requireProjectRead(db, user, issue.projectId);
  return issue;
}

async function recordEvent(
  db: DbOrTx,
  issueId: string,
  actorId: string,
  action: QualityEventAction,
  note?: string | null,
): Promise<void> {
  await db.insert(qualityIssueEvents).values({ issueId, actorId, action, note: note ?? null });
}

/** is_blocking = severity∈(critical,severe) 且 status≠closed（写入时维护） */
function blockingFlag(severity: string, status: string): boolean {
  return SEVERE_UP.includes(severity) && status !== "closed";
}

export interface CreateIssueInput {
  projectId: string;
  title: string;
  description: string;
  severity: QualitySeverity;
  handlerId?: string;
  reviewerId?: string;
}

export async function createIssue(
  db: DbOrTx,
  user: SessionUser,
  input: CreateIssueInput,
): Promise<{ id: string; code: string }> {
  await requireProjectMember(db, user, input.projectId);
  const code = await nextCode("QLT", db);
  const [issue] = await db
    .insert(qualityIssues)
    .values({
      projectId: input.projectId,
      code,
      title: input.title,
      description: input.description,
      severity: input.severity,
      status: "open",
      reporterId: user.id,
      handlerId: input.handlerId ?? null,
      reviewerId: input.reviewerId ?? null,
      isBlocking: blockingFlag(input.severity, "open"),
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: qualityIssues.id, code: qualityIssues.code });
  if (!issue) throw new Error("质量问题插入失败");
  await recordEvent(db, issue.id, user.id, "create", "登记质量问题");
  return issue;
}

export async function updateIssue(
  db: DbOrTx,
  user: SessionUser,
  input: {
    id: string;
    rowVersion: number;
    title?: string;
    description?: string;
    severity?: QualitySeverity;
    rootCause?: string | null;
  },
): Promise<void> {
  const issue = await loadVisible(db, user, input.id);
  if (issue.status === "closed") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已关闭问题不可修改");
  }
  const severity = input.severity ?? issue.severity;
  const updated = await db
    .update(qualityIssues)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      ...(input.rootCause !== undefined ? { rootCause: input.rootCause } : {}),
      isBlocking: blockingFlag(severity, issue.status),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${qualityIssues.rowVersion} + 1`,
    })
    .where(and(eq(qualityIssues.id, input.id), eq(qualityIssues.rowVersion, input.rowVersion)))
    .returning({ id: qualityIssues.id });
  if (!updated[0]) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  }
}

export async function assignIssue(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; handlerId: string; reviewerId: string },
): Promise<void> {
  const issue = await loadVisible(db, user, input.id);
  if (issue.status === "closed") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已关闭问题不可指派");
  }
  const [updated] = await db
    .update(qualityIssues)
    .set({
      handlerId: input.handlerId,
      reviewerId: input.reviewerId,
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${qualityIssues.rowVersion} + 1`,
    })
    .where(eq(qualityIssues.id, input.id))
    .returning();
  if (!updated) throw notFound();
  await recordEvent(db, issue.id, user.id, "assign", `指派处理/复核：${input.handlerId}/${input.reviewerId}`);
}

export async function submitHandling(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; note: string },
): Promise<void> {
  const issue = await loadVisible(db, user, input.id);
  if (issue.handlerId !== user.id) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅处理人可提交处理结果");
  }
  if (issue.status !== "open" && issue.status !== "handling") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "当前状态不可提交处理");
  }
  if (!input.note?.trim()) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "处理说明必填", { note: ["处理说明必填"] });
  }
  await db
    .update(qualityIssues)
    .set({ status: "pending_review", updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${qualityIssues.rowVersion} + 1` })
    .where(eq(qualityIssues.id, issue.id));
  await recordEvent(db, issue.id, user.id, "handle_submit", input.note);
}

export async function reviewIssue(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; action: "pass" | "return"; comment?: string },
): Promise<void> {
  const issue = await loadVisible(db, user, input.id);
  if (issue.status !== "pending_review") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅待复核状态可复核");
  }
  if (issue.reviewerId !== user.id) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅复核人可复核");
  }
  // 处理与复核分离（arch/04 §2.5 硬规则）
  if (SEVERE_UP.includes(issue.severity) && issue.handlerId === user.id) {
    throw new BusinessError(ERROR_CODE.SELF_REVIEW_BLOCKED, "严重问题处理人与复核人必须不同");
  }
  if (input.action === "return" && !input.comment?.trim()) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "退回必须填写意见", {
      comment: ["退回必须填写意见"],
    });
  }
  const now = nowIso();
  if (input.action === "pass") {
    await db
      .update(qualityIssues)
      .set({
        status: "closed",
        isBlocking: false,
        closedAt: now,
        updatedBy: user.id,
        updatedAt: now,
        rowVersion: sql`${qualityIssues.rowVersion} + 1`,
      })
      .where(eq(qualityIssues.id, issue.id));
    await recordEvent(db, issue.id, user.id, "review_pass", input.comment ?? null);
  } else {
    await db
      .update(qualityIssues)
      .set({
        status: "handling",
        updatedBy: user.id,
        updatedAt: now,
        rowVersion: sql`${qualityIssues.rowVersion} + 1`,
      })
      .where(eq(qualityIssues.id, issue.id));
    await recordEvent(db, issue.id, user.id, "review_return", input.comment ?? null);
    if (issue.handlerId) {
      await notify(db, {
        eventType: "quality_returned",
        recipientId: issue.handlerId,
        sourceType: "quality_issue",
        sourceId: issue.id,
        payload: { code: issue.code, title: issue.title },
      });
    }
  }
}

export async function reopenIssue(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; note: string },
): Promise<void> {
  const issue = await loadVisible(db, user, input.id);
  if (issue.status !== "closed") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅已关闭问题可重开");
  }
  if (!input.note?.trim()) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "重开必须填写说明", { note: ["重开必须填写说明"] });
  }
  await db
    .update(qualityIssues)
    .set({
      status: "handling",
      isBlocking: blockingFlag(issue.severity, "handling"),
      closedAt: null,
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${qualityIssues.rowVersion} + 1`,
    })
    .where(eq(qualityIssues.id, issue.id));
  await recordEvent(db, issue.id, user.id, "reopen", input.note);
}

export async function listIssues(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId?: string; status?: string; severity?: string; cursor?: string; limit: number },
) {
  const conditions: (SQL | undefined)[] = [];
  if (input.projectId) {
    await requireProjectRead(db, user, input.projectId);
    conditions.push(eq(qualityIssues.projectId, input.projectId));
  } else {
    conditions.push(
      sql`${qualityIssues.projectId} IN (SELECT project_id FROM project_members WHERE user_id = ${user.id})`,
    );
  }
  if (input.status) conditions.push(eq(qualityIssues.status, input.status as "open"));
  if (input.severity) conditions.push(eq(qualityIssues.severity, input.severity as QualitySeverity));
  conditions.push(cursorCondition(input.cursor, qualityIssues.createdAt, qualityIssues.id));

  const rows = await db
    .select({ issue: qualityIssues, handlerName: users.name })
    .from(qualityIssues)
    .leftJoin(users, eq(users.id, qualityIssues.handlerId))
    .where(and(...conditions))
    .orderBy(desc(qualityIssues.createdAt), desc(qualityIssues.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ ...r.issue, handlerName: r.handlerName })),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.issue.createdAt, last.issue.id) : null,
  };
}

export async function getIssue(db: DbOrTx, user: SessionUser, id: string) {
  const issue = await loadVisible(db, user, id);
  const events = await db
    .select()
    .from(qualityIssueEvents)
    .where(eq(qualityIssueEvents.issueId, id))
    .orderBy(qualityIssueEvents.createdAt);
  const handler = issue.handlerId
    ? (await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, issue.handlerId)).limit(1))[0] ?? null
    : null;
  const reviewer = issue.reviewerId
    ? (await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, issue.reviewerId)).limit(1))[0] ?? null
    : null;
  return { ...issue, handler, reviewer, events };
}

export async function checklist(db: DbOrTx, user: SessionUser, projectId: string) {
  await requireProjectRead(db, user, projectId);
  return db
    .select()
    .from(qualityCheckItems)
    .where(eq(qualityCheckItems.projectId, projectId))
    .orderBy(qualityCheckItems.name);
}

export async function checkItem(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; status: "pending" | "passed" | "failed" | "waived" },
) {
  const [item] = await db.select().from(qualityCheckItems).where(eq(qualityCheckItems.id, input.id)).limit(1);
  if (!item) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "检查项不存在");
  await requireProjectRead(db, user, item.projectId);
  const [updated] = await db
    .update(qualityCheckItems)
    .set({
      status: input.status,
      checkedBy: input.status === "pending" ? null : user.id,
      checkedAt: input.status === "pending" ? null : nowIso(),
      updatedBy: user.id,
      updatedAt: nowIso(),
    })
    .where(eq(qualityCheckItems.id, input.id))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "检查项不存在");
  return updated;
}
