import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { budgetLedger, expenseItems, expenseReports, fundingRequests } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { assertProjectNotClosed, requireProjectMember, requireProjectRead } from "../../services/access";
import { recordLedger } from "../../services/ledger/record";
import * as engine from "../../services/approval/engine";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "../governance/util";
import { canFinanceSummary } from "./budget";

/**
 * 经费域 service（arch/06 §3/§7）：create/update/submit/withdraw/close/releaseUnused；
 * 审批态与使用态分离；占用/释放/核销全部由台账重算（五公式）。
 */

async function loadFunding(db: DbOrTx, id: string) {
  const [funding] = await db.select().from(fundingRequests).where(eq(fundingRequests.id, id)).limit(1);
  if (!funding) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "经费申请不存在或无权访问");
  return funding;
}

async function requireFundingVisible(db: DbOrTx, user: SessionUser, funding: typeof fundingRequests.$inferSelect) {
  void db;
  const visible =
    funding.applicantId === user.id ||
    user.projectRoles.has(funding.projectId) ||
    canFinanceSummary(user, funding.projectId);
  if (!visible) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "经费申请不存在或无权访问");
}

export interface CreateFundingInput {
  projectId: string;
  purpose: string;
  amountCents: number;
  expectedUseDate?: string;
  recipientInfo?: string;
  sourceMeetingId?: string;
  sourceTravelId?: string;
}

export async function createFunding(
  db: DbOrTx,
  user: SessionUser,
  input: CreateFundingInput,
): Promise<{ id: string; code: string }> {
  await requireProjectMember(db, user, input.projectId);
  await assertProjectNotClosed(db, input.projectId); // arch/13 §5.4：closed 项目阻断新增
  if (!input.purpose.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "用途必填", { purpose: ["用途必填"] });
  if (input.amountCents <= 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "金额须为正整数（分）", { amountCents: ["金额须为正整数（分）"] });
  const code = await nextCode("FND", db);
  const [funding] = await db
    .insert(fundingRequests)
    .values({
      projectId: input.projectId,
      code,
      applicantId: user.id,
      purpose: input.purpose,
      amountCents: input.amountCents,
      expectedUseDate: input.expectedUseDate ?? null,
      recipientInfo: input.recipientInfo ?? null,
      sourceMeetingId: input.sourceMeetingId ?? null,
      sourceTravelId: input.sourceTravelId ?? null,
      approvalStatus: "draft",
      usageStatus: "unused",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: fundingRequests.id, code: fundingRequests.code });
  if (!funding) throw new Error("经费申请插入失败");
  return funding;
}

export async function updateFunding(
  db: DbOrTx,
  user: SessionUser,
  input: {
    id: string;
    rowVersion: number;
    purpose?: string;
    amountCents?: number;
    expectedUseDate?: string | null;
    recipientInfo?: string | null;
  },
): Promise<void> {
  const funding = await loadFunding(db, input.id);
  await requireFundingVisible(db, user, funding);
  if (funding.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可修改");
  if (funding.approvalStatus !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可修改");
  const amount = input.amountCents ?? funding.amountCents;
  if (amount <= 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "金额须为正整数（分）", { amountCents: ["金额须为正整数（分）"] });
  const updated = await db
    .update(fundingRequests)
    .set({
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.amountCents !== undefined ? { amountCents: amount } : {}),
      ...(input.expectedUseDate !== undefined ? { expectedUseDate: input.expectedUseDate } : {}),
      ...(input.recipientInfo !== undefined ? { recipientInfo: input.recipientInfo } : {}),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${fundingRequests.rowVersion} + 1`,
    })
    .where(and(eq(fundingRequests.id, input.id), eq(fundingRequests.rowVersion, input.rowVersion)))
    .returning({ id: fundingRequests.id });
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
}

export async function submitFunding(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number; idempotencyKey: string }) {
  const funding = await loadFunding(db, input.id);
  await requireFundingVisible(db, user, funding);
  if (funding.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可提交");
  if (funding.approvalStatus !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可提交");
  const updated = await db
    .update(fundingRequests)
    .set({ approvalStatus: "pending_approval", updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${fundingRequests.rowVersion} + 1` })
    .where(and(eq(fundingRequests.id, input.id), eq(fundingRequests.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  const instance = await engine.submit(db, {
    bizType: "funding",
    bizId: funding.id,
    projectId: funding.projectId,
    applicantId: user.id,
    formSnapshot: { amount_cents: funding.amountCents, fundingCode: funding.code },
    idempotencyKey: input.idempotencyKey,
  });
  await db.update(fundingRequests).set({ approvalInstanceId: instance.id }).where(eq(fundingRequests.id, funding.id));
  return { funding: updated[0], instance };
}

export async function withdrawFunding(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number }) {
  const funding = await loadFunding(db, input.id);
  if (funding.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可撤回");
  if (funding.approvalStatus !== "pending_approval" || !funding.approvalInstanceId) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅审批中的申请可撤回");
  }
  const updated = await db
    .update(fundingRequests)
    .set({ updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${fundingRequests.rowVersion} + 1` })
    .where(and(eq(fundingRequests.id, input.id), eq(fundingRequests.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  const instance = await engine.withdraw(db, { instanceId: funding.approvalInstanceId, actorId: user.id });
  return { funding: updated[0], instance };
}

/** 经费净占用余额（台账重算：FUNDING_RESERVED 净额） */
async function fundingRemaining(db: DbOrTx, fundingId: string): Promise<number> {
  const [row] = await db
    .select({ net: sql<number>`coalesce(sum(${budgetLedger.reservedDeltaCents}), 0)::bigint` })
    .from(budgetLedger)
    .where(and(eq(budgetLedger.sourceType, "funding"), eq(budgetLedger.sourceId, fundingId)));
  return Number(row.net);
}

/** 关闭检查项：未决报销阻断；未用额度先释放（台账依据） */
export async function closeFunding(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number; note: string }) {
  const funding = await loadFunding(db, input.id);
  await requireFundingVisible(db, user, funding);
  if (funding.approvalStatus !== "approved") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅获批经费可关闭");
  if (funding.usageStatus === "closed") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "经费已关闭");
  if (!input.note.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "关闭须填写说明", { note: ["关闭须填写说明"] });

  const pendingExpenses = await db
    .select({ id: expenseReports.id })
    .from(expenseItems)
    .innerJoin(expenseReports, eq(expenseReports.id, expenseItems.expenseReportId))
    .where(
      and(eq(expenseItems.fundingRequestId, funding.id), eq(expenseReports.status, "pending_approval")),
    )
    .limit(1);
  if (pendingExpenses.length > 0) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "存在未决报销（审批中），不得关闭经费");
  }

  const remaining = await fundingRemaining(db, funding.id);
  if (remaining > 0) {
    // R4：键 FUNDING_RELEASED:<fundingId>:close（业务事件维度；重放被幂等层吞掉）
    await recordLedger(db, {
      projectId: funding.projectId,
      sourceType: "funding",
      sourceId: funding.id,
      entryType: "FUNDING_RELEASED",
      reservedDeltaCents: -remaining,
      seq: "close",
    });
  }
  const [updated] = await db
    .update(fundingRequests)
    .set({
      usageStatus: "closed",
      closedAt: nowIso(),
      closeNote: input.note.trim(),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${fundingRequests.rowVersion} + 1`,
    })
    .where(and(eq(fundingRequests.id, input.id), eq(fundingRequests.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  return updated;
}

/** 释放未用额度（独立动作；写 OFF 后 usage=written_off） */
export async function releaseUnusedFunding(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number }) {
  const funding = await loadFunding(db, input.id);
  await requireFundingVisible(db, user, funding);
  if (funding.approvalStatus !== "approved") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅获批经费可释放");
  if (funding.usageStatus === "closed" || funding.usageStatus === "written_off") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "经费已关闭或已核销，无可释放额度");
  }
  const remaining = await fundingRemaining(db, funding.id);
  if (remaining <= 0) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "无未使用额度");
  // R4：键 FUNDING_RELEASED:<fundingId>:releaseUnused（业务事件维度；前置校验已拦重复调用，重放双保险）
  await recordLedger(db, {
    projectId: funding.projectId,
    sourceType: "funding",
    sourceId: funding.id,
    entryType: "FUNDING_RELEASED",
    reservedDeltaCents: -remaining,
    seq: "releaseUnused",
  });
  const [updated] = await db
    .update(fundingRequests)
    .set({ usageStatus: "written_off", updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${fundingRequests.rowVersion} + 1` })
    .where(and(eq(fundingRequests.id, input.id), eq(fundingRequests.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  return updated;
}

export async function getFundingById(db: DbOrTx, user: SessionUser, id: string) {
  const funding = await loadFunding(db, id);
  await requireFundingVisible(db, user, funding);
  const remaining = await fundingRemaining(db, funding.id);
  const [linked] = await db
    .select({ total: sql<number>`coalesce(sum(${expenseItems.amountCents}), 0)::bigint` })
    .from(expenseItems)
    .where(eq(expenseItems.fundingRequestId, funding.id));
  return {
    ...funding,
    figures: {
      approvedCents: funding.approvalStatus === "approved" ? funding.amountCents : 0,
      linkedCents: Number(linked.total),
      releasedCents: funding.amountCents - remaining, // 已释放=已核销+关闭释放
      remainingCents: Math.max(0, remaining),
    },
  };
}

export async function listFundings(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId?: string; mine?: boolean; status?: string; cursor?: string; limit: number },
) {
  const conditions: (SQL | undefined)[] = [];
  if (input.projectId) {
    await requireProjectRead(db, user, input.projectId);
    conditions.push(eq(fundingRequests.projectId, input.projectId));
  } else if (input.mine) {
    conditions.push(eq(fundingRequests.applicantId, user.id));
  } else {
    conditions.push(
      sql`${fundingRequests.projectId} IN (SELECT project_id FROM project_members WHERE user_id = ${user.id})`,
    );
  }
  if (input.status) conditions.push(eq(fundingRequests.approvalStatus, input.status));
  conditions.push(cursorCondition(input.cursor, fundingRequests.createdAt, fundingRequests.id));
  const rows = await db
    .select()
    .from(fundingRequests)
    .where(and(...conditions))
    .orderBy(desc(fundingRequests.createdAt), desc(fundingRequests.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
