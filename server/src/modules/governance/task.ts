import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { milestones, projectMembers, stages, tasks, users } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { emitEvent } from "../../lib/events";
import { assertProjectNotClosed, requireProjectMember, requireProjectRead } from "../../services/access";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "./util";

/**
 * 任务域 service（arch/04 §5 task.*）：全 CRUD + transition/assign。
 * 硬约束：无任何 planned_* 直改入口（PLN-I1，arch/04 §2.3）。
 */

function notFound(): BusinessError {
  return new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "任务不存在或无权访问");
}

async function loadVisible(db: DbOrTx, user: SessionUser, taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) throw notFound();
  await requireProjectRead(db, user, task.projectId);
  return task;
}

export interface ListTasksInput {
  projectId?: string;
  mine?: boolean;
  status?: string;
  stageId?: string;
  cursor?: string;
  limit: number;
}

export async function listTasks(db: DbOrTx, user: SessionUser, input: ListTasksInput) {
  const conditions: (SQL | undefined)[] = [];
  if (input.projectId) {
    await requireProjectRead(db, user, input.projectId);
    conditions.push(eq(tasks.projectId, input.projectId));
  } else if (input.mine) {
    conditions.push(eq(tasks.assigneeId, user.id));
    // 跨项目「我的任务」按可见范围过滤（SQL 级，arch/03 §5）
    conditions.push(
      sql`${tasks.projectId} IN (SELECT project_id FROM project_members WHERE user_id = ${user.id})`,
    );
  } else {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "projectId 与 mine 至少提供一个", {
      projectId: ["projectId 与 mine 至少提供一个"],
    });
  }
  if (input.status) conditions.push(eq(tasks.status, input.status as "pending"));
  if (input.stageId) conditions.push(eq(tasks.stageId, input.stageId));
  conditions.push(cursorCondition(input.cursor, tasks.createdAt, tasks.id));

  const rows = await db
    .select({
      task: tasks,
      assigneeName: users.name,
      stageName: stages.name,
      milestoneName: milestones.name,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .leftJoin(stages, eq(stages.id, tasks.stageId))
    .leftJoin(milestones, eq(milestones.id, tasks.milestoneId))
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ task, assigneeName, stageName, milestoneName }) => ({
      ...task,
      assigneeName,
      stageName,
      milestoneName,
      dueSoon:
        task.status !== "done" &&
        task.status !== "cancelled" &&
        task.plannedEnd >= nowIso().slice(0, 10) &&
        task.plannedEnd <= new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
      overdue:
        task.status !== "done" &&
        task.status !== "cancelled" &&
        task.plannedEnd < nowIso().slice(0, 10),
    })),
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor(last.task.createdAt, last.task.id)
        : null,
  };
}

export async function getTask(db: DbOrTx, user: SessionUser, taskId: string) {
  const task = await loadVisible(db, user, taskId);
  const [assignee] = task.assigneeId
    ? await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, task.assigneeId)).limit(1)
    : [null];
  return { ...task, assignee };
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  stageId?: string;
  milestoneId?: string;
  assigneeId?: string;
  plannedStart: string;
  plannedEnd: string;
}

export async function createTask(
  db: DbOrTx,
  user: SessionUser,
  input: CreateTaskInput,
): Promise<{ id: string; code: string }> {
  await requireProjectMember(db, user, input.projectId); // 成员即可建任务（arch/03 §3 本人业务创建）
  await assertProjectNotClosed(db, input.projectId); // arch/13 §5.4：closed 项目阻断新增
  if (input.plannedEnd < input.plannedStart) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "计划完成日不能早于开始日", {
      plannedEnd: ["计划完成日不能早于开始日"],
    });
  }
  const code = await nextCode("TSK", db);
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: input.projectId,
      stageId: input.stageId ?? null,
      milestoneId: input.milestoneId ?? null,
      code,
      title: input.title,
      description: input.description ?? null,
      assigneeId: input.assigneeId ?? null,
      plannedStart: input.plannedStart,
      plannedEnd: input.plannedEnd,
      status: "pending",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: tasks.id, code: tasks.code });
  if (!task) throw new Error("任务插入失败");
  // 小元提醒实时化（§20.3）：临期任务（截止不晚于明天）——指派人 feed 出现「任务临期」条目
  if (input.assigneeId) {
    const tomorrow = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    if (new Date(`${input.plannedEnd}T00:00:00Z`).getTime() <= tomorrow.getTime()) {
      emitEvent({ type: "assistant.feed", userId: input.assigneeId, reason: "task_near" });
    }
  }
  return task;
}

export interface UpdateTaskInput {
  id: string;
  rowVersion: number;
  title?: string;
  description?: string | null;
  stageId?: string | null;
  milestoneId?: string | null;
  assigneeId?: string | null;
}

export async function updateTask(db: DbOrTx, user: SessionUser, input: UpdateTaskInput): Promise<void> {
  const task = await loadVisible(db, user, input.id);
  await requireProjectMember(db, user, task.projectId);
  const updated = await db
    .update(tasks)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
      ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${tasks.rowVersion} + 1`,
    })
    .where(and(eq(tasks.id, input.id), eq(tasks.rowVersion, input.rowVersion)))
    .returning({ id: tasks.id });
  if (!updated[0]) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  }
}

export async function transitionTask(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; action: string; rowVersion: number },
) {
  const task = await loadVisible(db, user, input.id);
  await requireProjectMember(db, user, task.projectId);
  const now = nowIso();
  const patch: Record<string, unknown> = { updatedBy: user.id, updatedAt: now };

  switch (input.action) {
    case "start":
      if (task.status !== "pending") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅待处理任务可开始");
      patch.status = "in_progress";
      patch.actualStart = now;
      break;
    case "complete":
      if (task.status !== "in_progress") {
        throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅进行中任务可完成");
      }
      patch.status = "done";
      patch.actualEnd = now;
      patch.completedAt = now;
      break;
    case "cancel":
      if (task.status !== "pending" && task.status !== "in_progress") {
        throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅未完成任务可取消");
      }
      patch.status = "cancelled";
      break;
    case "reopen":
      if (task.status !== "done") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅已完成任务可重开");
      patch.status = "pending";
      patch.actualEnd = null;
      patch.completedAt = null;
      break;
    default:
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "非法的任务动作", {
        action: ["仅支持 start/complete/cancel/reopen"],
      });
  }

  const [updated] = await db
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, input.id), eq(tasks.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  return updated;
}

export async function assignTask(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; assigneeId: string },
) {
  const task = await loadVisible(db, user, input.id);
  await requireProjectMember(db, user, task.projectId);
  // 负责人必须是项目成员
  const member = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, task.projectId), eq(projectMembers.userId, input.assigneeId)))
    .limit(1);
  if (!member[0]) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "负责人必须是项目成员", {
      assigneeId: ["负责人必须是项目成员"],
    });
  }
  const [updated] = await db
    .update(tasks)
    .set({ assigneeId: input.assigneeId, updatedBy: user.id, updatedAt: nowIso() })
    .where(eq(tasks.id, input.id))
    .returning();
  if (!updated) throw notFound();
  return updated;
}
