import { and, asc, eq, sql } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { milestones, planItems, planVersions, stages, tasks } from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { requireProjectRead } from "../../services/access";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { dayString, nowIso } from "./util";

/**
 * 计划域 service（arch/04 §5 plan.*）：
 * versions/current/versionGet（PLN-I1：items 只读）、simulate（只算不写）、
 * transitionStage/transitionMilestone（live 状态机）。planned_* 无任何直改入口。
 */

export async function listVersions(db: DbOrTx, user: SessionUser, projectId: string) {
  await requireProjectRead(db, user, projectId);
  return db
    .select({
      id: planVersions.id,
      versionNo: planVersions.versionNo,
      kind: planVersions.kind,
      status: planVersions.status,
      sourceChangeRequestId: planVersions.sourceChangeRequestId,
      notes: planVersions.notes,
      createdAt: planVersions.createdAt,
    })
    .from(planVersions)
    .where(eq(planVersions.projectId, projectId))
    .orderBy(asc(planVersions.versionNo));
}

export async function getVersion(db: DbOrTx, user: SessionUser, versionId: string) {
  const [version] = await db.select().from(planVersions).where(eq(planVersions.id, versionId)).limit(1);
  if (!version) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "计划版本不存在或无权访问");
  await requireProjectRead(db, user, version.projectId);
  const items = await db
    .select()
    .from(planItems)
    .where(eq(planItems.planVersionId, versionId))
    .orderBy(asc(planItems.seq));
  return { ...version, items };
}

export async function currentVersion(db: DbOrTx, user: SessionUser, projectId: string) {
  await requireProjectRead(db, user, projectId);
  const [version] = await db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.projectId, projectId), eq(planVersions.status, "active")))
    .limit(1);
  if (!version) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目无 active 计划版本");
  const items = await db
    .select()
    .from(planItems)
    .where(eq(planItems.planVersionId, version.id))
    .orderBy(asc(planItems.seq));

  // live 三轨并列（arch/04 §5 plan.current v1.1）：甘特实际轨取 live actual_*，不取快照
  const liveStages = await db
    .select()
    .from(stages)
    .where(eq(stages.projectId, projectId))
    .orderBy(asc(stages.seq));
  const liveMilestones = await db
    .select()
    .from(milestones)
    .where(eq(milestones.projectId, projectId))
    .orderBy(asc(milestones.seq));
  const liveTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.code));

  return { ...version, items, stages: liveStages, milestones: liveMilestones, tasks: liveTasks };
}

/* ===== simulate（只算不写） ===== */

export interface Adjustment {
  ref_id: string;
  item_type: "stage" | "milestone" | "task";
  new_start: string;
  new_end: string;
}

interface SimItem {
  id: string;
  refId: string;
  itemType: string;
  plannedStart: string;
  plannedEnd: string;
  dependsOn: string[];
}

/** 依赖级联：调整项的下游（depends_on 闭包）按前序延期差同步顺移 */
export async function simulate(
  db: DbOrTx,
  user: SessionUser,
  projectId: string,
  adjustments: Adjustment[],
) {
  await requireProjectRead(db, user, projectId);
  const active = await db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.projectId, projectId), eq(planVersions.status, "active")))
    .limit(1);
  if (!active[0]) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目无 active 计划版本");
  const rows = await db
    .select()
    .from(planItems)
    .where(eq(planItems.planVersionId, active[0].id))
    .orderBy(asc(planItems.seq));

  const byId = new Map<string, SimItem>(rows.map((r) => [r.id, { ...r }]));
  const adjusted = new Map<string, { start: string; end: string }>();
  for (const adj of adjustments) {
    const item = rows.find((r) => r.refId === adj.ref_id && r.itemType === adj.item_type);
    if (!item) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "调整目标不在当前计划中", {
        adjustments: [`${adj.item_type}/${adj.ref_id} 不在 active 计划中`],
      });
    }
    adjusted.set(item.id, { start: adj.new_start, end: adj.new_end });
  }

  // 级联：对每条 item 计算模拟日期（原日期 + 前序依赖的最大顺移差）
  const deltaMs = (from: string, to: string) => new Date(to).getTime() - new Date(from).getTime();
  const result = new Map<string, { start: string; end: string; cascaded: boolean }>();
  const visit = (item: SimItem, visiting: Set<string>): { start: string; end: string; cascaded: boolean } => {
    const cached = result.get(item.id);
    if (cached) return cached;
    if (visiting.has(item.id)) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "计划依赖存在环，无法模拟");
    }
    visiting.add(item.id);
    let shiftMs = 0;
    for (const depId of item.dependsOn) {
      const dep = byId.get(depId);
      if (!dep) continue;
      const depSim = adjusted.has(depId)
        ? { end: adjusted.get(depId)!.end }
        : visit(dep, visiting);
      const depEnd = depSim.end;
      // 若依赖被顺移，本项同步顺移相同差值
      const depOrig = dep.plannedEnd;
      if (depEnd !== depOrig) {
        shiftMs = Math.max(shiftMs, deltaMs(depOrig, depEnd));
      }
    }
    visiting.delete(item.id);
    const own = adjusted.get(item.id);
    const baseStart = own?.start ?? item.plannedStart;
    const baseEnd = own?.end ?? item.plannedEnd;
    const shifted = shiftMs > 0 && !own
      ? {
          start: new Date(new Date(baseStart).getTime() + shiftMs).toISOString().slice(0, 10),
          end: new Date(new Date(baseEnd).getTime() + shiftMs).toISOString().slice(0, 10),
        }
      : { start: baseStart, end: baseEnd };
    const value = { ...shifted, cascaded: shiftMs > 0 && !own };
    result.set(item.id, value);
    return value;
  };
  for (const item of rows) visit(item, new Set());

  const simulatedItems = rows.map((item) => ({
    id: item.id,
    refId: item.refId,
    itemType: item.itemType,
    name: item.name,
    originalStart: item.plannedStart,
    originalEnd: item.plannedEnd,
    simulatedStart: result.get(item.id)!.start,
    simulatedEnd: result.get(item.id)!.end,
    cascaded: result.get(item.id)!.cascaded,
    dependsOn: item.dependsOn,
    seq: item.seq,
  }));

  // 关键路径影响：项目计划完成日（全 item planned_end 最大者）前移/后移量
  const endOf = (d: string) => new Date(d).getTime();
  const originalProjectEnd = rows.length
    ? rows.reduce((max, r) => Math.max(max, endOf(r.plannedEnd)), 0)
    : 0;
  const simulatedProjectEnd = rows.length
    ? simulatedItems.reduce((max, r) => Math.max(max, endOf(r.simulatedEnd)), 0)
    : 0;

  return {
    projectId,
    versionId: active[0].id,
    items: simulatedItems,
    projectEndOriginal: new Date(originalProjectEnd).toISOString().slice(0, 10),
    projectEndSimulated: new Date(simulatedProjectEnd).toISOString().slice(0, 10),
    projectEndDeltaDays: Math.round((simulatedProjectEnd - originalProjectEnd) / 86_400_000),
    appliedCount: adjustments.length,
  };
}

/* ===== live 状态机（arch/04 §3） ===== */

export async function transitionStage(
  db: DbOrTx,
  user: SessionUser,
  stageId: string,
  action: string,
) {
  const [stage] = await db.select().from(stages).where(eq(stages.id, stageId)).limit(1);
  if (!stage) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "阶段不存在或无权访问");
  await requireProjectRead(db, user, stage.projectId);

  const today = dayString();
  const updates: Record<string, unknown> = { updatedBy: user.id, updatedAt: nowIso() };
  if (action === "start") {
    if (stage.status !== "pending") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅待开始阶段可启动");
    updates.status = "active";
    updates.actualStart = today;
  } else if (action === "done") {
    if (stage.status !== "active") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅进行中阶段可完成");
    updates.status = "done";
    updates.actualEnd = today;
  } else {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "非法的阶段动作", { action: ["仅支持 start/done"] });
  }
  const [updated] = await db
    .update(stages)
    .set(updates)
    .where(and(eq(stages.id, stageId), eq(stages.status, stage.status)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "阶段状态已变化，请刷新");

  // 有未完成任务时 done 仅警告不阻断（arch/04 §3 stage 行）
  let openTaskWarning: string | null = null;
  if (action === "done") {
    const open = await db
      .select({ code: tasks.code })
      .from(tasks)
      .where(and(eq(tasks.stageId, stageId), sql`${tasks.status} in ('pending', 'in_progress')`))
      .limit(5);
    if (open.length > 0) {
      openTaskWarning = `阶段下仍有未完成任务：${open.map((t) => t.code).join("；")}`;
    }
  }
  return { stage: updated, warning: openTaskWarning };
}

export async function transitionMilestone(
  db: DbOrTx,
  user: SessionUser,
  milestoneId: string,
  action: string,
) {
  const [milestone] = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, milestoneId))
    .limit(1);
  if (!milestone) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "里程碑不存在或无权访问");
  }
  await requireProjectRead(db, user, milestone.projectId);

  if (action !== "reach" && action !== "miss") {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "非法的里程碑动作", {
      action: ["仅支持 reach/miss"],
    });
  }
  if (milestone.status !== "pending") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅待到达里程碑可标记");
  }
  const [updated] = await db
    .update(milestones)
    .set({
      status: action === "reach" ? "reached" : "missed",
      actualDate: dayString(),
      updatedBy: user.id,
      updatedAt: nowIso(),
    })
    .where(and(eq(milestones.id, milestoneId), eq(milestones.status, "pending")))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "里程碑状态已变化，请刷新");
  return updated;
}
