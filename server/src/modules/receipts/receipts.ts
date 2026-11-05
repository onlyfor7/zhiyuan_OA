import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { clients, paymentReceipts, projects } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError, pgErrorCode } from "../../lib/errors";
import { can, projectScopeFilter } from "../../services/access";
import { recordAudit } from "../../services/audit";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "../governance/util";

/**
 * 收款登记台账（arch/09 §2）：登记/作废冲正不删行；口径 = Σ registered − Σ voided（原额）；
 * 权限：finance 写、partner 范围读、pm 本项目读、member/viewer 不可见。
 */

async function requireReceiptRead(db: DbOrTx, user: SessionUser, projectId: string): Promise<void> {
  if (user.globalRoles.includes("finance") || user.globalRoles.includes("partner")) return;
  if (user.projectRoles.get(projectId) === "manager") return;
  if (await can(db, user, "project.manage", { type: "project", projectId })) return;
  throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "收款不存在或无权访问");
}

async function requireFinance(user: SessionUser): Promise<void> {
  if (!user.globalRoles.includes("finance")) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅财务可登记/作废收款");
  }
}

export async function createReceipt(
  db: DbOrTx,
  user: SessionUser,
  input: {
    projectId: string;
    amountCents: number;
    receivedOn: string;
    referenceNo?: string;
    payerName?: string;
    note?: string;
    attachmentFileVersionId?: string;
    idempotencyKey: string;
    /** arch/12 §6.3 回款勾稽：可选挂合同付款计划行（须与 planId 同给；同事务写回计划状态） */
    contractId?: string;
    planId?: string;
  },
  ip: string | null = null,
  sessionId: string | null = null,
) {
  await requireFinance(user);
  // finance 登记收款不因此获得项目内容权：仅校验项目存在（存在性校验，非 project.read）
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在");
  if (input.amountCents <= 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "金额须为正整数（分）", { amountCents: ["金额须为正整数（分）"] });
  }
  if (!input.referenceNo?.trim()) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "参考号（银行回单/流水号）必填", { referenceNo: ["参考号必填"] });
  }
  if ((input.contractId && !input.planId) || (!input.contractId && input.planId)) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "合同与付款计划行须同时提供", { planId: ["合同与付款计划行须同时提供"] });
  }
  // client_id 按项目冗余（事项→客户）
  const [projRow] = await db
    .select({ matterClientId: sql<string | null>`(SELECT c.client_id FROM matters c WHERE c.id = ${projects.matterId})` })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!projRow?.matterClientId) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "项目缺客户归属", { projectId: ["项目缺客户归属"] });
  const clientId: string = projRow.matterClientId;
  // R6 幂等（arch/00 §3.7）：同键重放返回首次登记（先查后插，唯一约束兜并发）
  if (input.idempotencyKey) {
    const [dup] = await db
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (dup) return dup;
  }
  const code = await nextCode("RCV", db);
  try {
    const [receipt] = await db
      .insert(paymentReceipts)
      .values({
        code,
        projectId: input.projectId,
        clientId,
        amountCents: input.amountCents,
        receivedOn: input.receivedOn,
        referenceNo: input.referenceNo.trim(),
        payerName: input.payerName ?? null,
        note: input.note ?? null,
        attachmentFileVersionId: input.attachmentFileVersionId ?? null,
        idempotencyKey: input.idempotencyKey,
        status: "registered",
        createdBy: user.id,
        updatedBy: user.id,
      })
      .returning();
    if (!receipt) throw new Error("收款插入失败");
    // arch/12 §6.3 回款勾稽：挂合同付款计划行 → 同事务写回计划状态（unpaid/partial/paid）与 receipt_id 挂点
    if (input.planId) {
      const { linkReceiptToPlan } = await import("../crm/crm");
      await linkReceiptToPlan(db, user, {
        receiptId: receipt.id,
        planId: input.planId,
        contractId: input.contractId,
        receiptAmountCents: input.amountCents,
      }, ip, sessionId);
    }
    return receipt;
  } catch (error) {
    // 并发同键兜底：唯一约束命中 → 返回首次登记
    if (input.idempotencyKey && pgErrorCode(error) === "23505") {
      const [dup] = await db
        .select()
        .from(paymentReceipts)
        .where(eq(paymentReceipts.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (dup) return dup;
    }
    throw error;
  }
}

export async function voidReceipt(db: DbOrTx, user: SessionUser, input: { id: string; reason: string; rowVersion: number }, ip: string | null = null, sessionId: string | null = null) {
  await requireFinance(user);
  if (!input.reason.trim()) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "作废必须填写理由", { reason: ["作废必须填写理由"] });
  }
  const [receipt] = await db.select().from(paymentReceipts).where(eq(paymentReceipts.id, input.id)).limit(1);
  if (!receipt) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "收款不存在或无权访问");
  const [updated] = await db
    .update(paymentReceipts)
    .set({
      status: "voided",
      voidReason: input.reason.trim(),
      voidedBy: user.id,
      voidedAt: nowIso(),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${paymentReceipts.rowVersion} + 1`,
    })
    .where(and(eq(paymentReceipts.id, input.id), eq(paymentReceipts.status, "registered"), eq(paymentReceipts.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "收款状态已变化（仅 registered 可作废，金额不可编辑）");
  // arch/12 §6.3 回款勾稽回写：作废冲正清计划行 receipt_id + 状态复位 unpaid
  const { unlinkReceiptFromPlan } = await import("../crm/crm");
  await unlinkReceiptFromPlan(db, { receiptId: receipt.id }, ip, sessionId);
  await recordAudit(db, {
    actorId: user.id,
    sessionId: null,
    action: "receipt.void",
    targetType: "payment_receipt",
    targetId: receipt.id,
    result: "success",
    afterJson: { code: receipt.code, amountCents: receipt.amountCents, reason: input.reason.trim() },
    ip: null,
  });
  return updated;
}

export async function getReceipt(db: DbOrTx, user: SessionUser, id: string) {
  const [receipt] = await db.select().from(paymentReceipts).where(eq(paymentReceipts.id, id)).limit(1);
  if (!receipt) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "收款不存在或无权访问");
  await requireReceiptRead(db, user, receipt.projectId);
  return receipt;
}

export async function listReceipts(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId?: string; clientId?: string; from?: string; to?: string; cursor?: string; limit: number },
) {
  const conditions: (SQL | undefined)[] = [];
  if (input.projectId) {
    // R1：与 getById 同口径——无财务可见权角色（member/viewer 等）统一同形 404（arch/03 §5）
    await requireReceiptRead(db, user, input.projectId);
    conditions.push(eq(paymentReceipts.projectId, input.projectId));
  } else if (user.globalRoles.includes("finance")) {
    // finance 全量（处理职责）
  } else if (user.globalRoles.includes("partner")) {
    conditions.push(sql`${paymentReceipts.projectId} IN (SELECT id FROM projects WHERE ${projectScopeFilter(user)})`);
  } else {
    // R1 修复：member 等普通成员不再走 projectRoles>0 分支泄漏金额——同形 404
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "收款不存在或无权访问");
  }
  if (input.clientId) conditions.push(eq(paymentReceipts.clientId, input.clientId));
  if (input.from) conditions.push(gte(paymentReceipts.receivedOn, input.from));
  if (input.to) conditions.push(lte(paymentReceipts.receivedOn, input.to));
  conditions.push(cursorCondition(input.cursor, paymentReceipts.createdAt, paymentReceipts.id));
  const rows = await db
    .select()
    .from(paymentReceipts)
    .where(and(...conditions))
    .orderBy(desc(paymentReceipts.receivedOn), desc(paymentReceipts.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export type ReceiptSummaryBy = "project" | "client" | "period";

/** 口径：实收 = Σ registered − Σ voided（原额），作废冲正不删行 */
export async function summaryReceipts(
  db: DbOrTx,
  user: SessionUser,
  input: { by: ReceiptSummaryBy; from?: string; to?: string },
) {
  // R1：汇总含跨项目金额——仅 finance/partner 可见（member/viewer/pm 无跨项目财务权，同形 404）
  if (!(user.globalRoles.includes("finance") || user.globalRoles.includes("partner"))) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "收款汇总不存在或无权访问");
  }
  const groupColumn =
    input.by === "project" ? paymentReceipts.projectId : input.by === "client" ? paymentReceipts.clientId : paymentReceipts.receivedOn;
  const conditions: (SQL | undefined)[] = [];
  if (user.globalRoles.includes("finance")) {
    // 全量
  } else {
    conditions.push(sql`${paymentReceipts.projectId} IN (SELECT id FROM projects WHERE ${projectScopeFilter(user)})`);
  }
  if (input.from) conditions.push(gte(paymentReceipts.receivedOn, input.from));
  if (input.to) conditions.push(lte(paymentReceipts.receivedOn, input.to));
  const rows = await db
    .select({
      key: groupColumn,
      registeredCents: sql<number>`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'registered'), 0)::float8`,
      voidedCents: sql<number>`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'voided'), 0)::float8`,
      count: sql<number>`count(*)::int`,
    })
    .from(paymentReceipts)
    .where(and(...conditions))
    .groupBy(groupColumn)
    .orderBy(desc(sql`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'registered'), 0)`));
  const names = new Map<string, string>();
  if (input.by === "project") {
    for (const p of await db.select({ id: projects.id, name: projects.name }).from(projects)) names.set(p.id, p.name);
  } else if (input.by === "client") {
    for (const c of await db.select({ id: clients.id, name: clients.name }).from(clients)) names.set(c.id, c.name);
  }
  return {
    asOf: nowIso(),
    scope: "实收 = Σ registered − Σ voided（原额）；更正走作废+新登记，不删行",
    items: rows.map((r) => ({
      key: r.key,
      name: input.by === "period" ? String(r.key) : (names.get(String(r.key)) ?? null),
      registeredCents: Number(r.registeredCents),
      voidedCents: Number(r.voidedCents),
      netCents: Number(r.registeredCents) - Number(r.voidedCents),
      count: Number(r.count),
    })),
  };
}

export async function exportCsv(db: DbOrTx, user: SessionUser, input: { from?: string; to?: string }, ip: string | null, sessionId: string | null) {
  if (!user.globalRoles.includes("finance") && !user.globalRoles.includes("partner")) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "无导出权限");
  }
  const conditions: (SQL | undefined)[] = [];
  if (!user.globalRoles.includes("finance")) {
    conditions.push(sql`${paymentReceipts.projectId} IN (SELECT id FROM projects WHERE ${projectScopeFilter(user)})`);
  }
  if (input.from) conditions.push(gte(paymentReceipts.receivedOn, input.from));
  if (input.to) conditions.push(lte(paymentReceipts.receivedOn, input.to));
  const rows = await db
    .select({
      code: paymentReceipts.code,
      projectId: paymentReceipts.projectId,
      clientId: paymentReceipts.clientId,
      amountCents: paymentReceipts.amountCents,
      receivedOn: paymentReceipts.receivedOn,
      referenceNo: paymentReceipts.referenceNo,
      payerName: paymentReceipts.payerName,
      status: paymentReceipts.status,
      voidReason: paymentReceipts.voidReason,
    })
    .from(paymentReceipts)
    .where(and(...conditions))
    .orderBy(paymentReceipts.receivedOn, paymentReceipts.code);
  const header = "收款编号,项目,客户,金额(分),到账日,参考号,付款方,状态,作废理由";
  const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = `﻿${header}\n${rows.map((r) => [r.code, r.projectId, r.clientId, r.amountCents, r.receivedOn, r.referenceNo, r.payerName, r.status, r.voidReason].map(escape).join(",")).join("\n")}`;
  await recordAudit(db, {
    actorId: user.id,
    sessionId,
    action: "export.run",
    targetType: "payment_receipt",
    targetId: null,
    result: "success",
    afterJson: { rows: rows.length },
    ip,
  });
  return { csv, rowCount: rows.length, asOf: nowIso() };
}

/** 收款登记表单项目下拉（arch 裁定 04b-①）：finance/partner 参照级清单，无业务内容；其他角色同形 404 */
export async function projectOptions(db: DbOrTx, user: SessionUser) {
  if (!(user.globalRoles.includes("finance") || user.globalRoles.includes("partner"))) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "收款不存在或无权访问");
  }
  return db
    .select({ id: projects.id, code: projects.code, name: projects.name })
    .from(projects)
    .orderBy(projects.code);
}
