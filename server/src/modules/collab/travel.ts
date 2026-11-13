import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import {
  approvalInstances,
  fileObjects,
  fileVersions,
  travelEvents,
  travelRequests,
  travelSegments,
} from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { assertProjectNotClosed, can, requireProjectMember, requireProjectRead } from "../../services/access";
import * as engine from "../../services/approval/engine";
import { notify } from "../../modules/notify";
import { linkMaterialFiles, linkSourceByDirKey } from "../governance/archive";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "../governance/util";

/**
 * 出差域 service（arch/05 §3/§4/§5）。
 * 铁律：estimated_cost_cents 纯提示绝不写台账（TRV-004）；完成 ≠ 费用批准；
 * 变更重审走引擎 biz_type='travel_change'，通过同事务应用并 events 留前后值。
 */

const DIR_10 = "10_出差与费用";

export interface SegmentInput {
  seq: number;
  type: "transport" | "accommodation" | "client_site" | "other";
  startAt: string;
  endAt: string;
  fromPlace?: string;
  toPlace?: string;
  description?: string;
  linkedMeetingId?: string;
  linkedTaskId?: string;
}

function validateSegments(segments: SegmentInput[]): void {
  if (segments.length === 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "至少一段行程", {
      segments: ["至少一段行程"],
    });
  }
  const sorted = segments.slice().sort((a, b) => a.seq - b.seq);
  sorted.forEach((s, idx) => {
    if (s.seq !== idx + 1) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "分段 seq 须从 1 连续递增", {
        segments: ["分段 seq 须从 1 连续递增"],
      });
    }
    if (Number.isNaN(Date.parse(s.startAt)) || Number.isNaN(Date.parse(s.endAt)) || new Date(s.endAt).getTime() <= new Date(s.startAt).getTime()) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "分段内时间倒挂（end 须晚于 start）", {
        segments: [`seq=${s.seq} 时间倒挂`],
      });
    }
    if (idx > 0 && new Date(s.startAt).getTime() < new Date(sorted[idx - 1].endAt).getTime()) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "分段间时间倒挂（按 seq 顺序）", {
        segments: [`seq=${s.seq} 早于上一段结束`],
      });
    }
  });
}

async function loadTravel(db: DbOrTx, travelId: string) {
  const [travel] = await db.select().from(travelRequests).where(eq(travelRequests.id, travelId)).limit(1);
  if (!travel) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "出差申请不存在或无权访问");
  return travel;
}

/** 可见性：申请人/项目成员；财务角色见必要信息（列表摘要）；审批人经 approval 域查看 */
async function requireTravelVisible(db: DbOrTx, user: SessionUser, travelId: string) {
  const travel = await loadTravel(db, travelId);
  const manage = await can(db, user, "project.manage", { type: "project", projectId: travel.projectId });
  const visible =
    travel.applicantId === user.id ||
    user.projectRoles.has(travel.projectId) ||
    manage ||
    user.globalRoles.includes("finance");
  if (!visible) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "出差申请不存在或无权访问");
  }
  return travel;
}

async function insertSegments(db: DbOrTx, travelId: string, segments: SegmentInput[]): Promise<void> {
  for (const s of segments) {
    await db.insert(travelSegments).values({
      travelRequestId: travelId,
      seq: s.seq,
      type: s.type,
      startAt: s.startAt,
      endAt: s.endAt,
      fromPlace: s.fromPlace ?? null,
      toPlace: s.toPlace ?? null,
      description: s.description ?? null,
      linkedMeetingId: s.linkedMeetingId ?? null,
      linkedTaskId: s.linkedTaskId ?? null,
    });
  }
}

function recordEvent(
  db: DbOrTx,
  travelId: string,
  actorId: string,
  action: "create" | "submit" | "change_submit" | "depart" | "complete" | "close" | "cancel",
  payloadJson?: Record<string, unknown>,
): Promise<unknown> {
  return db.insert(travelEvents).values({ travelRequestId: travelId, actorId, action, payloadJson: payloadJson ?? null });
}

/* ===== 查询 ===== */

export interface ListTravelInput {
  projectId?: string;
  mine?: boolean;
  status?: string;
  cursor?: string;
  limit: number;
}

export async function listTravels(db: DbOrTx, user: SessionUser, input: ListTravelInput) {
  const conditions: (SQL | undefined)[] = [];
  if (input.projectId) {
    await requireProjectRead(db, user, input.projectId);
    conditions.push(eq(travelRequests.projectId, input.projectId));
  } else if (input.mine) {
    conditions.push(eq(travelRequests.applicantId, user.id));
  } else {
    conditions.push(
      sql`${travelRequests.projectId} IN (SELECT project_id FROM project_members WHERE user_id = ${user.id})`,
    );
  }
  if (input.status) conditions.push(eq(travelRequests.status, input.status as "draft"));
  conditions.push(cursorCondition(input.cursor, travelRequests.createdAt, travelRequests.id));
  const rows = await db
    .select()
    .from(travelRequests)
    .where(and(...conditions))
    .orderBy(desc(travelRequests.createdAt), desc(travelRequests.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((t) => ({
      ...t,
      // 财务必要信息之外不扩散成本明细的展示口径由前端控制；此处全字段输出（成员/财务/申请人范围）
    })),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function getTravelById(db: DbOrTx, user: SessionUser, travelId: string) {
  const travel = await requireTravelVisible(db, user, travelId);
  const segments = await db
    .select()
    .from(travelSegments)
    .where(eq(travelSegments.travelRequestId, travelId))
    .orderBy(travelSegments.seq);
  const events = await db
    .select()
    .from(travelEvents)
    .where(eq(travelEvents.travelRequestId, travelId))
    .orderBy(travelEvents.createdAt);
  const [instance] = travel.approvalInstanceId
    ? await db.select().from(approvalInstances).where(eq(approvalInstances.id, travel.approvalInstanceId)).limit(1)
    : [null];
  const materials = await db
    .select({
      fileVersionId: fileVersions.id,
      storageKey: fileVersions.storageKey,
      mimeType: fileVersions.mimeType,
      sizeBytes: fileVersions.sizeBytes,
      sha256: fileVersions.sha256,
      uploadedAt: fileVersions.uploadedAt,
    })
    .from(fileObjects)
    .innerJoin(fileVersions, eq(fileVersions.fileObjectId, fileObjects.id))
    .where(and(eq(fileObjects.sourceType, "travel"), eq(fileObjects.sourceId, travelId)))
    .orderBy(fileVersions.uploadedAt);
  return {
    ...travel,
    segments,
    events,
    approvalInstance: instance,
    materials: materials.map((m) => ({ ...m, name: m.storageKey.split("/").pop() })),
  };
}

/* ===== 创建/更新/提交 ===== */

export interface CreateTravelInput {
  projectId: string;
  reason: string;
  destination: string;
  startOn: string;
  endOn: string;
  estimatedCostCents?: number | null;
  borrow?: boolean;
  borrowAmountCents?: number | null;
  segments: SegmentInput[];
}

function validateTravelFields(input: {
  reason: string;
  destination: string;
  startOn: string;
  endOn: string;
  borrow?: boolean;
  borrowAmountCents?: number | null;
}): void {
  if (!input.reason.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "出差事由必填", { reason: ["出差事由必填"] });
  if (!input.destination.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "目的地必填", { destination: ["目的地必填"] });
  if (input.endOn < input.startOn) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "结束日期不能早于开始日期", { endOn: ["结束日期不能早于开始日期"] });
  }
  if (input.borrow && (!input.borrowAmountCents || input.borrowAmountCents <= 0)) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "借款出差须填写借款金额", { borrowAmountCents: ["借款金额须为正整数（分）"] });
  }
}

export async function createTravel(
  db: DbOrTx,
  user: SessionUser,
  input: CreateTravelInput,
): Promise<{ id: string; code: string }> {
  await requireProjectMember(db, user, input.projectId);
  await assertProjectNotClosed(db, input.projectId); // arch/13 §5.4：closed 项目阻断新增
  validateTravelFields(input);
  validateSegments(input.segments);
  const code = await nextCode("TRV", db);
  const [travel] = await db
    .insert(travelRequests)
    .values({
      projectId: input.projectId,
      code,
      applicantId: user.id,
      reason: input.reason,
      destination: input.destination,
      startOn: input.startOn,
      endOn: input.endOn,
      estimatedCostCents: input.estimatedCostCents ?? null,
      borrow: input.borrow ?? false,
      borrowAmountCents: input.borrowAmountCents ?? null,
      status: "draft",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: travelRequests.id, code: travelRequests.code });
  if (!travel) throw new Error("出差申请插入失败");
  await insertSegments(db, travel.id, input.segments);
  await recordEvent(db, travel.id, user.id, "create");
  return travel;
}

export async function updateTravel(
  db: DbOrTx,
  user: SessionUser,
  input: {
    id: string;
    rowVersion: number;
    reason?: string;
    destination?: string;
    startOn?: string;
    endOn?: string;
    estimatedCostCents?: number | null;
    borrow?: boolean;
    borrowAmountCents?: number | null;
    segments?: SegmentInput[];
  },
): Promise<void> {
  const travel = await requireTravelVisible(db, user, input.id);
  if (travel.applicantId !== user.id) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可修改");
  }
  if (travel.status !== "draft") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可修改（已提交申请须撤回）");
  }
  validateTravelFields({
    reason: input.reason ?? travel.reason,
    destination: input.destination ?? travel.destination,
    startOn: input.startOn ?? travel.startOn,
    endOn: input.endOn ?? travel.endOn,
    borrow: input.borrow ?? travel.borrow,
    borrowAmountCents: input.borrowAmountCents ?? travel.borrowAmountCents,
  });
  if (input.segments) validateSegments(input.segments);
  const updated = await db
    .update(travelRequests)
    .set({
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.destination !== undefined ? { destination: input.destination } : {}),
      ...(input.startOn !== undefined ? { startOn: input.startOn } : {}),
      ...(input.endOn !== undefined ? { endOn: input.endOn } : {}),
      ...(input.estimatedCostCents !== undefined ? { estimatedCostCents: input.estimatedCostCents } : {}),
      ...(input.borrow !== undefined ? { borrow: input.borrow } : {}),
      ...(input.borrowAmountCents !== undefined ? { borrowAmountCents: input.borrowAmountCents } : {}),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${travelRequests.rowVersion} + 1`,
    })
    .where(and(eq(travelRequests.id, input.id), eq(travelRequests.rowVersion, input.rowVersion)))
    .returning({ id: travelRequests.id });
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  if (input.segments) {
    await db.delete(travelSegments).where(eq(travelSegments.travelRequestId, input.id));
    await insertSegments(db, input.id, input.segments);
  }
}

export async function submitTravel(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; idempotencyKey: string },
) {
  const travel = await requireTravelVisible(db, user, input.id);
  if (travel.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可提交");
  if (travel.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可提交");
  const segments = await db.select().from(travelSegments).where(eq(travelSegments.travelRequestId, travel.id)).limit(1);
  if (segments.length === 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "缺少行程分段", { segments: ["缺少行程分段"] });

  const updated = await db
    .update(travelRequests)
    .set({ status: "pending_approval", updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${travelRequests.rowVersion} + 1` })
    .where(and(eq(travelRequests.id, input.id), eq(travelRequests.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");

  const instance = await engine.submit(db, {
    bizType: "travel",
    bizId: travel.id,
    projectId: travel.projectId,
    applicantId: user.id,
    formSnapshot: { borrow: travel.borrow, estimated_cost_cents: travel.estimatedCostCents },
    idempotencyKey: input.idempotencyKey,
  });
  await db
    .update(travelRequests)
    .set({ approvalInstanceId: instance.id, updatedAt: nowIso() })
    .where(eq(travelRequests.id, travel.id));
  await recordEvent(db, travel.id, user.id, "submit");
  return { travel: updated[0], instance };
}

export async function withdrawTravel(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number },
) {
  const travel = await requireTravelVisible(db, user, input.id);
  if (travel.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可撤回");
  if (travel.status !== "pending_approval") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅审批中的申请可撤回");
  if (!travel.approvalInstanceId) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "申请缺少审批实例");
  const updated = await db
    .update(travelRequests)
    .set({ updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${travelRequests.rowVersion} + 1` })
    .where(and(eq(travelRequests.id, input.id), eq(travelRequests.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  const instance = await engine.withdraw(db, { instanceId: travel.approvalInstanceId, actorId: user.id });
  return { travel: updated[0], instance };
}

/* ===== 状态机流转 ===== */

export async function transitionTravel(
  db: DbOrTx,
  user: SessionUser,
  input: {
    id: string;
    action: "depart" | "complete" | "close" | "cancel";
    rowVersion: number;
    completionSummary?: string;
    actualCostNote?: string;
    reason?: string;
  },
) {
  const travel = await requireTravelVisible(db, user, input.id);
  const now = nowIso();

  if (input.action === "depart") {
    if (travel.status !== "approved") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅已批准出差可出发");
    const [updated] = await db
      .update(travelRequests)
      .set({ status: "in_progress", updatedBy: user.id, updatedAt: now, rowVersion: sql`${travelRequests.rowVersion} + 1` })
      .where(and(eq(travelRequests.id, input.id), eq(travelRequests.status, "approved"), eq(travelRequests.rowVersion, input.rowVersion)))
      .returning();
    if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
    await recordEvent(db, travel.id, user.id, "depart");
    return updated;
  }

  if (input.action === "complete") {
    if (travel.status !== "in_progress") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅出差中可完成");
    if (!input.completionSummary?.trim()) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "完成须填写实际行程/结果摘要", {
        completionSummary: ["完成须填写实际行程/结果摘要"],
      });
    }
    const [updated] = await db
      .update(travelRequests)
      .set({
        status: "completed",
        completionSummary: input.completionSummary.trim(),
        actualCostNote: input.actualCostNote?.trim() || null,
        completedAt: now,
        updatedBy: user.id,
        updatedAt: now,
        rowVersion: sql`${travelRequests.rowVersion} + 1`,
      })
      .where(and(eq(travelRequests.id, input.id), eq(travelRequests.status, "in_progress"), eq(travelRequests.rowVersion, input.rowVersion)))
      .returning();
    if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
    await recordEvent(db, travel.id, user.id, "complete");
    // 归档 10：申请材料来源对 + 材料文件（不产任何费用记录，TRV-004/§4.5）
    await linkSourceByDirKey(db, { projectId: travel.projectId, dirKey: DIR_10, sourceType: "travel", sourceId: travel.id, createdBy: user.id });
    await linkMaterialFiles(db, { projectId: travel.projectId, dirKey: DIR_10, sourceType: "travel", sourceId: travel.id, createdBy: user.id });
    // 返回报销提醒（迭代 3 承接报销判断；本迭代完成后即提醒一次）
    await notify(db, {
      eventType: "travel_return_expense",
      recipientId: travel.applicantId,
      sourceType: "travel",
      sourceId: travel.id,
      payload: { code: travel.code, note: "出差已完成，请提交差旅费用报销（费用模块迭代 3 承接）" },
      aggregateKey: `travel_return_expense:${travel.id}:once`,
    });
    return updated;
  }

  if (input.action === "close") {
    if (travel.status !== "completed") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅已完成出差可关闭");
    const [updated] = await db
      .update(travelRequests)
      .set({ status: "closed", updatedBy: user.id, updatedAt: now, rowVersion: sql`${travelRequests.rowVersion} + 1` })
      .where(and(eq(travelRequests.id, input.id), eq(travelRequests.status, "completed"), eq(travelRequests.rowVersion, input.rowVersion)))
      .returning();
    if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
    await recordEvent(db, travel.id, user.id, "close");
    return updated;
  }

  // cancel：approved → cancelled（留痕）
  if (travel.status !== "approved") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅已批准出差可取消");
  if (!input.reason?.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "取消须填写原因", { reason: ["取消须填写原因"] });
  const [updated] = await db
    .update(travelRequests)
    .set({ status: "cancelled", updatedBy: user.id, updatedAt: now, rowVersion: sql`${travelRequests.rowVersion} + 1` })
    .where(and(eq(travelRequests.id, input.id), eq(travelRequests.status, "approved"), eq(travelRequests.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  await recordEvent(db, travel.id, user.id, "cancel", { reason: input.reason.trim() });
  return updated;
}

/* ===== 变更重审（§4.6：approved/in_progress 关键字段变更 → 引擎 travel_change → 通过同事务应用） ===== */

const CHANGEABLE_FIELDS = ["destination", "startOn", "endOn", "estimatedCostCents"] as const;

export async function submitTravelChange(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; changes: Record<string, unknown>; reason: string; idempotencyKey: string },
) {
  const travel = await requireTravelVisible(db, user, input.id);
  if (travel.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可发起变更");
  if (travel.status !== "approved" && travel.status !== "in_progress") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅 approved/in_progress 可申请变更");
  }
  const changes: Record<string, unknown> = {};
  for (const key of CHANGEABLE_FIELDS) {
    if (input.changes[key] !== undefined) changes[key] = input.changes[key];
  }
  if (Object.keys(changes).length === 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "无可变更的关键字段（日期/目的地/预计费用）", {
      changes: ["仅支持 destination/startOn/endOn/estimatedCostCents"],
    });
  }
  if (!input.reason.trim()) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "变更须填写原因", { reason: ["变更须填写原因"] });
  }
  const before = {
    destination: travel.destination,
    startOn: travel.startOn,
    endOn: travel.endOn,
    estimatedCostCents: travel.estimatedCostCents,
  };
  await recordEvent(db, travel.id, user.id, "change_submit", { changes, reason: input.reason.trim(), before });

  const instance = await engine.submit(db, {
    bizType: "travel_change",
    bizId: travel.id,
    projectId: travel.projectId,
    applicantId: user.id,
    formSnapshot: { changePayload: { changes, before } },
    idempotencyKey: input.idempotencyKey,
  });
  return { travel, instance };
}

/* ===== 工时预填建议（TRV-007：按分段日期给每日建议分钟数，绝不按 24h，只算不存） ===== */

export async function travelTimePrefill(db: DbOrTx, user: SessionUser, travelId: string) {
  const travel = await requireTravelVisible(db, user, travelId);
  if (travel.status === "cancelled" || travel.status === "rejected") return null;
  const segments = await db
    .select()
    .from(travelSegments)
    .where(eq(travelSegments.travelRequestId, travelId))
    .orderBy(travelSegments.seq);

  // 按 Asia/Shanghai 日历日切分（arch/00 §3.3：跨日不按日期字符串算时长）
  const dayMs = 86_400_000;
  const tzOffsetMs = 8 * 3_600_000; // Asia/Shanghai 固定 +08:00（无 DST）
  const dayOf = (ms: number) => Math.floor((ms + tzOffsetMs) / dayMs);
  const dayStartOf = (dayIndex: number) => dayIndex * dayMs - tzOffsetMs;

  const perDay = new Map<number, number>();
  for (const segment of segments) {
    const start = new Date(segment.startAt).getTime();
    const end = new Date(segment.endAt).getTime();
    for (let day = dayOf(start); day <= dayOf(end - 1); day++) {
      const overlapStart = Math.max(start, dayStartOf(day));
      const overlapEnd = Math.min(end, dayStartOf(day + 1));
      const minutes = Math.max(0, Math.round((overlapEnd - overlapStart) / 60_000));
      perDay.set(day, (perDay.get(day) ?? 0) + minutes);
    }
  }
  const days = [...perDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, minutes]) => ({
      date: new Date(dayStartOf(day) + tzOffsetMs).toISOString().slice(0, 10),
      minutes,
    }))
    .filter((d) => d.minutes > 0);
  return { projectId: travel.projectId, days };
}
