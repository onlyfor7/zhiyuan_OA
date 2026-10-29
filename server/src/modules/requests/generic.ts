import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { genericRequests } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import * as engine from "../../services/approval/engine";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "../governance/util";

/**
 * 通用申请单（arch/09 §3.2）：固定核心字段；走引擎 biz_type='generic_request'（global scope 流程）。
 */

async function validRequestType(db: DbOrTx, requestType: string): Promise<void> {
  const { systemConfig } = await import("../../db/schema");
  const { CONFIG_KEY } = await import("@lexflow/shared");
  const [row] = await db
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, CONFIG_KEY.GENERIC_REQUEST_TYPES))
    .limit(1);
  const raw = (row?.valueJson as { types?: unknown } | undefined)?.types;
  const fallback = ["leave", "procurement", "seal", "other"];
  // 兼容两种配置形状：["leave",…] 或 [{key,name},…]（种子为后者）
  const types: string[] = Array.isArray(raw)
    ? raw.map((t) => (typeof t === "string" ? t : ((t as { key?: string }).key ?? ""))).filter(Boolean)
    : fallback;
  if (!types.includes(requestType)) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "申请类型非法（可在系统参数扩充）", {
      requestType: [`可选：${types.join("/")}`],
    });
  }
}

export async function createRequest(
  db: DbOrTx,
  user: SessionUser,
  input: {
    requestType: string;
    title: string;
    reason: string;
    startOn?: string;
    endOn?: string;
    amountCents?: number | null;
    attachmentFileVersionId?: string;
  },
) {
  await validRequestType(db, input.requestType);
  if (!input.title.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "标题必填", { title: ["标题必填"] });
  if (!input.reason.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "事由必填", { reason: ["事由必填"] });
  const code = await nextCode("REQ", db);
  const [row] = await db
    .insert(genericRequests)
    .values({
      code,
      requestType: input.requestType,
      title: input.title,
      reason: input.reason,
      startOn: input.startOn ?? null,
      endOn: input.endOn ?? null,
      amountCents: input.amountCents ?? null,
      attachmentFileVersionId: input.attachmentFileVersionId ?? null,
      applicantId: user.id,
      status: "draft",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!row) throw new Error("申请单插入失败");
  return row;
}

export async function updateRequest(
  db: DbOrTx,
  user: SessionUser,
  input: {
    id: string;
    rowVersion: number;
    requestType?: string;
    title?: string;
    reason?: string;
    startOn?: string | null;
    endOn?: string | null;
    amountCents?: number | null;
    attachmentFileVersionId?: string | null;
  },
): Promise<void> {
  const [row] = await db.select().from(genericRequests).where(eq(genericRequests.id, input.id)).limit(1);
  if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "申请单不存在或无权访问");
  if (row.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可修改");
  if (row.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可修改");
  if (input.requestType) await validRequestType(db, input.requestType);
  const updated = await db
    .update(genericRequests)
    .set({
      ...(input.requestType !== undefined ? { requestType: input.requestType } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.startOn !== undefined ? { startOn: input.startOn } : {}),
      ...(input.endOn !== undefined ? { endOn: input.endOn } : {}),
      ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
      ...(input.attachmentFileVersionId !== undefined ? { attachmentFileVersionId: input.attachmentFileVersionId } : {}),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${genericRequests.rowVersion} + 1`,
    })
    .where(and(eq(genericRequests.id, input.id), eq(genericRequests.rowVersion, input.rowVersion)))
    .returning({ id: genericRequests.id });
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
}

export async function submitRequest(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number; idempotencyKey: string }) {
  const [row] = await db.select().from(genericRequests).where(eq(genericRequests.id, input.id)).limit(1);
  if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "申请单不存在或无权访问");
  if (row.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可提交");
  if (row.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可提交");
  const updated = await db
    .update(genericRequests)
    .set({ status: "pending_approval", updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${genericRequests.rowVersion} + 1` })
    .where(and(eq(genericRequests.id, input.id), eq(genericRequests.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  const instance = await engine.submit(db, {
    bizType: "generic_request",
    bizId: row.id,
    applicantId: user.id,
    formSnapshot: {
      request_type: row.requestType,
      amount_cents: row.amountCents,
      title: row.title,
    },
    idempotencyKey: input.idempotencyKey,
  });
  await db.update(genericRequests).set({ approvalInstanceId: instance.id }).where(eq(genericRequests.id, row.id));
  return { request: updated[0], instance };
}

export async function withdrawRequest(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number }) {
  const [row] = await db.select().from(genericRequests).where(eq(genericRequests.id, input.id)).limit(1);
  if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "申请单不存在或无权访问");
  if (row.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可撤回");
  if (row.status !== "pending_approval" || !row.approvalInstanceId) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅审批中的申请可撤回");
  }
  const updated = await db
    .update(genericRequests)
    .set({ updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${genericRequests.rowVersion} + 1` })
    .where(and(eq(genericRequests.id, input.id), eq(genericRequests.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  const instance = await engine.withdraw(db, { instanceId: row.approvalInstanceId, actorId: user.id });
  return { request: updated[0], instance };
}

export async function getRequestById(db: DbOrTx, user: SessionUser, id: string) {
  const [row] = await db.select().from(genericRequests).where(eq(genericRequests.id, id)).limit(1);
  if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "申请单不存在或无权访问");
  const visible =
    row.applicantId === user.id ||
    user.globalRoles.includes("partner") ||
    user.globalRoles.includes("sysadmin") ||
    (row.approvalInstanceId !== null);
  if (!visible) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "申请单不存在或无权访问");
  return row;
}

export async function listRequests(
  db: DbOrTx,
  user: SessionUser,
  input: { mine?: boolean; requestType?: string; status?: string; cursor?: string; limit: number },
) {
  const conditions: (SQL | undefined)[] = [];
  if (input.mine) {
    conditions.push(eq(genericRequests.applicantId, user.id));
  } else if (user.globalRoles.includes("partner") || user.globalRoles.includes("sysadmin")) {
    // 全量
  } else {
    conditions.push(eq(genericRequests.applicantId, user.id)); // 非管理角色仅见本人
  }
  if (input.requestType) conditions.push(eq(genericRequests.requestType, input.requestType));
  if (input.status) conditions.push(eq(genericRequests.status, input.status as "draft"));
  conditions.push(cursorCondition(input.cursor, genericRequests.createdAt, genericRequests.id));
  const rows = await db
    .select()
    .from(genericRequests)
    .where(and(...conditions))
    .orderBy(desc(genericRequests.createdAt), desc(genericRequests.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
