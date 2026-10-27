import { and, desc, eq, gte, isNotNull, lte, ne, sql, type SQL } from "drizzle-orm";

import { CONFIG_KEY, ERROR_CODE, type ExpenseCategory } from "@lexflow/shared";

import {
  budgetLedger,
  expenseAdjustments,
  expenseItems,
  expenseReports,
  fileVersions,
  fundingRequests,
  meetings,
  systemConfig,
  travelRequests,
} from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { requireProjectRead } from "../../services/access";
import { aggregateProject, overBudgetMessage } from "../../services/ledger/record";
import * as engine from "../../services/approval/engine";
import { recordAudit } from "../../services/audit";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor, nowIso } from "../governance/util";
import { canFinanceSummary } from "./budget";

/**
 * 费用域 service（arch/06 §5/§7）：合计服务端计算、跨项目明细逐行鉴权、
 * 提交五检查项+重复票据三因子、markPaid（finance）、调整单走引擎、统计与导出。
 */

export interface ExpenseItemInput {
  projectId: string;
  fundingRequestId?: string;
  date: string;
  category: ExpenseCategory;
  amountCents: number;
  description: string;
  payee?: string;
  receiptNo?: string;
  receiptFileVersionId?: string;
}

async function loadReport(db: DbOrTx, id: string) {
  const [report] = await db.select().from(expenseReports).where(eq(expenseReports.id, id)).limit(1);
  if (!report) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "报销单不存在或无权访问");
  return report;
}

/** 可见性：申请人 / 明细项目成员 / 财务摘要角色（arch/06 §7） */
async function requireReportVisible(db: DbOrTx, user: SessionUser, report: typeof expenseReports.$inferSelect) {
  if (report.applicantId === user.id || user.globalRoles.includes("finance")) return;
  const items = await db
    .select({ projectId: expenseItems.projectId })
    .from(expenseItems)
    .where(eq(expenseItems.expenseReportId, report.id))
    .limit(1);
  if (items[0] && canFinanceSummary(user, items[0].projectId)) return;
  if (items.some((i) => user.projectRoles.has(i.projectId))) return;
  throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "报销单不存在或无权访问");
}

/** 票据规则：byCategory[category].required（配置化；默认不要求） */
async function receiptRequired(db: DbOrTx, category: string): Promise<boolean> {
  const [row] = await db
    .select({ valueJson: systemConfig.valueJson })
    .from(systemConfig)
    .where(eq(systemConfig.key, CONFIG_KEY.EXPENSE_RECEIPT_RULES))
    .limit(1);
  const rules = (row?.valueJson ?? {}) as { byCategory?: Record<string, { required?: boolean }> };
  return rules.byCategory?.[category]?.required === true;
}

async function itemReceiptSha(db: DbOrTx, fileVersionId: string | null): Promise<string | null> {
  if (!fileVersionId) return null;
  const [row] = await db
    .select({ sha256: fileVersions.sha256 })
    .from(fileVersions)
    .where(eq(fileVersions.id, fileVersionId))
    .limit(1);
  return row?.sha256 ?? null;
}

/** 明细写入（校验+票据满足度计算）；合计由调用方服务端求和 */
async function insertItems(
  db: DbOrTx,
  user: SessionUser,
  reportId: string,
  items: ExpenseItemInput[],
): Promise<number> {
  let total = 0;
  for (const item of items) {
    await requireProjectRead(db, user, item.projectId); // 跨项目逐行鉴权（EXP-001）
    if (item.amountCents <= 0) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "明细金额须为正整数（分）", {
        items: [`${item.description} 金额非法`],
      });
    }
    if (!item.description.trim()) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "明细说明必填", { items: ["明细说明必填"] });
    }
    if (item.fundingRequestId) {
      const [funding] = await db
        .select()
        .from(fundingRequests)
        .where(eq(fundingRequests.id, item.fundingRequestId))
        .limit(1);
      if (!funding || funding.projectId !== item.projectId || funding.approvalStatus !== "approved") {
        throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "关联经费不存在、未获批或不属于该项目", {
          items: [`${item.description} 关联经费非法`],
        });
      }
    }
    const required = await receiptRequired(db, item.category);
    const receiptSatisfied = required ? !!item.receiptFileVersionId : true;
    await db.insert(expenseItems).values({
      expenseReportId: reportId,
      projectId: item.projectId,
      fundingRequestId: item.fundingRequestId ?? null,
      date: item.date,
      category: item.category,
      amountCents: item.amountCents,
      description: item.description,
      payee: item.payee ?? null,
      receiptNo: item.receiptNo ?? null,
      receiptFileVersionId: item.receiptFileVersionId ?? null,
      receiptSatisfied,
      createdBy: user.id,
      updatedBy: user.id,
    });
    total += item.amountCents;
  }
  return total;
}

export interface CreateExpenseInput {
  reason: string;
  items: ExpenseItemInput[];
  isCrossProject?: boolean;
  travelId?: string;
  meetingId?: string;
}

export async function createExpense(
  db: DbOrTx,
  user: SessionUser,
  input: CreateExpenseInput,
): Promise<{ id: string; code: string; totalCents: number }> {
  if (!input.reason.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "事由必填", { reason: ["事由必填"] });
  if (input.items.length === 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "至少一条明细", { items: ["至少一条明细"] });
  const code = await nextCode("EXP", db);
  // 合计服务端计算：前端传入任何合计值均被忽略（红线）
  const [report] = await db
    .insert(expenseReports)
    .values({
      code,
      applicantId: user.id,
      reason: input.reason,
      isCrossProject: input.isCrossProject ?? new Set(input.items.map((i) => i.projectId)).size > 1,
      travelId: input.travelId ?? null,
      meetingId: input.meetingId ?? null,
      totalCents: 0,
      status: "draft",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: expenseReports.id, code: expenseReports.code });
  if (!report) throw new Error("报销单插入失败");
  const total = await insertItems(db, user, report.id, input.items);
  await db.update(expenseReports).set({ totalCents: total }).where(eq(expenseReports.id, report.id));
  return { id: report.id, code: report.code, totalCents: total };
}

export async function updateExpense(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; reason?: string; items?: ExpenseItemInput[] },
) {
  const report = await loadReport(db, input.id);
  if (report.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可修改");
  if (report.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可修改（已提交须撤回）");
  let total = report.totalCents;
  if (input.items) {
    await db.delete(expenseItems).where(eq(expenseItems.expenseReportId, report.id));
    total = await insertItems(db, user, report.id, input.items);
  }
  const [updated] = await db
    .update(expenseReports)
    .set({
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      totalCents: total, // 合计始终服务端口径
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${expenseReports.rowVersion} + 1`,
    })
    .where(and(eq(expenseReports.id, input.id), eq(expenseReports.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  return updated;
}

export async function addItem(db: DbOrTx, user: SessionUser, input: { id: string; item: ExpenseItemInput }) {
  const report = await loadReport(db, input.id);
  if (report.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可修改");
  if (report.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可添加明细");
  const added = await insertItems(db, user, report.id, [input.item]);
  const [updated] = await db
    .update(expenseReports)
    .set({ totalCents: sql`${expenseReports.totalCents} + ${added}`, updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${expenseReports.rowVersion} + 1` })
    .where(eq(expenseReports.id, report.id))
    .returning();
  return updated;
}

export async function removeItem(db: DbOrTx, user: SessionUser, input: { id: string; itemId: string }) {
  const report = await loadReport(db, input.id);
  if (report.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可修改");
  if (report.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可移除明细");
  const [item] = await db.select().from(expenseItems).where(eq(expenseItems.id, input.itemId)).limit(1);
  if (!item || item.expenseReportId !== report.id) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "明细不存在");
  }
  await db.delete(expenseItems).where(eq(expenseItems.id, item.id));
  const [updated] = await db
    .update(expenseReports)
    .set({ totalCents: sql`${expenseReports.totalCents} - ${item.amountCents}`, updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${expenseReports.rowVersion} + 1` })
    .where(eq(expenseReports.id, report.id))
    .returning();
  return updated;
}

/** 票据附件继承费用权限（申请人/项目成员/财务） */
export async function attachReceipt(
  db: DbOrTx,
  user: SessionUser,
  input: { itemId: string; fileVersionId: string },
) {
  const [item] = await db.select().from(expenseItems).where(eq(expenseItems.id, input.itemId)).limit(1);
  if (!item) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "明细不存在");
  const report = await loadReport(db, item.expenseReportId);
  await requireReportVisible(db, user, report);
  const [version] = await db.select().from(fileVersions).where(eq(fileVersions.id, input.fileVersionId)).limit(1);
  if (!version) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "文件版本不存在");
  const required = await receiptRequired(db, item.category);
  const [updated] = await db
    .update(expenseItems)
    .set({ receiptFileVersionId: input.fileVersionId, receiptSatisfied: required ? true : true, updatedBy: user.id, updatedAt: nowIso() })
    .where(eq(expenseItems.id, item.id))
    .returning();
  return updated;
}

/* ===== §5 检查项 + 重复票据 ===== */

export interface SubmitCheck {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * 重复票据命中规则（arch 修复规格 R1，EXP-005）：
 * （receipt_no 相同 && 金额相同）——主因子，票据号+金额即拦（一方无文件同样命中）；
 * 或（sha256 非空 && sha 相同 && 金额相同）——辅因子，同文件内容即拦（号码可不同）。
 * 不依赖文件名。
 */
async function findDuplicateReceipt(
  db: DbOrTx,
  reportId: string,
  item: { receiptNo: string | null; amountCents: number; receiptFileVersionId: string | null },
): Promise<{ code: string; id: string } | null> {
  const sha = await itemReceiptSha(db, item.receiptFileVersionId);
  const candidates = await db
    .select({
      reportId: expenseItems.expenseReportId,
      receiptNo: expenseItems.receiptNo,
      amountCents: expenseItems.amountCents,
      receiptFileVersionId: expenseItems.receiptFileVersionId,
      reportCode: expenseReports.code,
      reportStatus: expenseReports.status,
    })
    .from(expenseItems)
    .innerJoin(expenseReports, eq(expenseReports.id, expenseItems.expenseReportId))
    .where(
      and(
        ne(expenseItems.expenseReportId, reportId),
        ne(expenseReports.status, "rejected"),
        ne(expenseReports.status, "draft"),
        // 候选须可能命中：票据号相同，或（本项有 sha 且候选有票据文件可供 sha 比对）
        item.receiptNo
          ? sql`(${expenseItems.receiptNo} = ${item.receiptNo} OR ${expenseItems.receiptFileVersionId} is not null)`
          : isNotNull(expenseItems.receiptFileVersionId),
      ),
    );
  for (const candidate of candidates) {
    if (candidate.amountCents !== item.amountCents) continue;
    const candidateSha = await itemReceiptSha(db, candidate.receiptFileVersionId);
    const noAmountHit = item.receiptNo !== null && candidate.receiptNo === item.receiptNo;
    const shaHit = sha !== null && candidateSha !== null && candidateSha === sha;
    if (noAmountHit || shaHit) {
      return { code: candidate.reportCode, id: candidate.reportId };
    }
  }
  return null;
}

async function insufficientPolicy(db: DbOrTx, projectId: string): Promise<"block" | "escalate"> {
  const [row] = await db
    .select({ valueJson: systemConfig.valueJson })
    .from(systemConfig)
    .where(eq(systemConfig.key, CONFIG_KEY.BUDGET_INSUFFICIENT_POLICY))
    .limit(1);
  const value = (row?.valueJson ?? {}) as { default?: string; byProject?: Record<string, string> };
  return (value.byProject?.[projectId] ?? value.default ?? "escalate") === "block" ? "block" : "escalate";
}

/** 提交前检查项（预算充足/经费余额/票据完整/关联存在/重复票据），随审批快照保存 */
async function runSubmitChecks(db: DbOrTx, report: typeof expenseReports.$inferSelect): Promise<SubmitCheck[]> {
  const items = await db.select().from(expenseItems).where(eq(expenseItems.expenseReportId, report.id));
  const checks: SubmitCheck[] = [];

  // 预算充足性（按明细项目分组预测）
  const byProject = new Map<string, number>();
  for (const item of items) {
    byProject.set(item.projectId, (byProject.get(item.projectId) ?? 0) + item.amountCents);
  }
  let budgetPass = true;
  const budgetDetails: string[] = [];
  let predictedOverProject: string | null = null;
  for (const [projectId, amount] of byProject) {
    const agg = await aggregateProject(db, projectId);
    if (agg.hasBudget && agg.availableCents - amount < 0) {
      budgetPass = false;
      predictedOverProject = projectId;
      budgetDetails.push(`${projectId.slice(0, 8)}… 可用 ${agg.availableCents} < 申报 ${amount}`);
    }
  }
  checks.push({
    name: "budget_sufficiency",
    pass: budgetPass,
    detail: budgetPass ? "各项目预算充足" : `预算不足：${budgetDetails.join("；")}`,
  });

  // 经费余额充足性
  let fundingPass = true;
  const fundingDetails: string[] = [];
  const byFunding = new Map<string, number>();
  for (const item of items) {
    if (item.fundingRequestId) {
      byFunding.set(item.fundingRequestId, (byFunding.get(item.fundingRequestId) ?? 0) + item.amountCents);
    }
  }
  for (const [fundingId, amount] of byFunding) {
    const [net] = await db
      .select({ net: sql<number>`coalesce(sum(${budgetLedger.reservedDeltaCents}), 0)::bigint` })
      .from(budgetLedger)
      .where(and(eq(budgetLedger.sourceType, "funding"), eq(budgetLedger.sourceId, fundingId)));
    const remaining = Number(net.net);
    if (remaining < amount) {
      fundingPass = false;
      fundingDetails.push(`${fundingId.slice(0, 8)}… 余额 ${remaining} < 申报 ${amount}`);
    }
  }
  checks.push({
    name: "funding_sufficiency",
    pass: fundingPass,
    detail: fundingPass ? "经费余额充足" : `经费余额不足：${fundingDetails.join("；")}`,
  });

  // 票据完整性（类别规则）
  const receiptFailures = items.filter((i) => !i.receiptSatisfied).map((i) => i.description);
  checks.push({
    name: "receipt_completeness",
    pass: receiptFailures.length === 0,
    detail: receiptFailures.length === 0 ? "票据齐备" : `缺票据：${receiptFailures.join("；")}`,
  });

  // 出差/会议关联存在性
  const linkDetails: string[] = [];
  if (report.travelId) {
    const [travel] = await db
      .select({ id: travelRequests.id })
      .from(travelRequests)
      .where(eq(travelRequests.id, report.travelId))
      .limit(1);
    if (!travel) linkDetails.push("关联出差不存在");
  }
  if (report.meetingId) {
    const [meeting] = await db
      .select({ id: meetings.id })
      .from(meetings)
      .where(eq(meetings.id, report.meetingId))
      .limit(1);
    if (!meeting) linkDetails.push("关联会议不存在");
  }
  checks.push({
    name: "link_validity",
    pass: linkDetails.length === 0,
    detail: linkDetails.length === 0 ? "关联校验通过" : linkDetails.join("；"),
  });

  // 重复票据（三因子）
  let duplicatePass = true;
  let duplicateDetail = "无重复票据";
  for (const item of items) {
    const hit = await findDuplicateReceipt(db, report.id, item);
    if (hit) {
      duplicatePass = false;
      duplicateDetail = `明细「${item.description}」票据重复，原报销 ${hit.code}`;
      break;
    }
  }
  checks.push({ name: "duplicate_receipt", pass: duplicatePass, detail: duplicateDetail });

  void predictedOverProject;
  return checks;
}

export async function submitExpense(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; idempotencyKey: string },
) {
  const report = await loadReport(db, input.id);
  if (report.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可提交");
  if (report.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿可提交");
  const items = await db.select().from(expenseItems).where(eq(expenseItems.expenseReportId, report.id));
  if (items.length === 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "缺少明细", { items: ["缺少明细"] });

  // 重复票据硬阻止（DUPLICATE_RECEIPT + 原报销定位）
  for (const item of items) {
    const hit = await findDuplicateReceipt(db, report.id, item);
    if (hit) {
      throw new BusinessError(
        ERROR_CODE.DUPLICATE_RECEIPT,
        `重复票据：明细「${item.description}」与原报销 ${hit.code} 冲突（receipt_no+金额+sha256 三因子命中）`,
        { items: [`票据重复，原报销 ${hit.code}`] },
        { originalReportCode: hit.code, originalReportId: hit.id, receiptNo: item.receiptNo },
      );
    }
  }

  const checks = await runSubmitChecks(db, report);

  // 超预算 escalate：提交时追加管理层步骤（block 策略在核销实检拦截，提交放行待审）
  const byProject = new Map<string, number>();
  for (const item of items) byProject.set(item.projectId, (byProject.get(item.projectId) ?? 0) + item.amountCents);
  const extraStepRoles: string[] = [];
  for (const [projectId, amount] of byProject) {
    const agg = await aggregateProject(db, projectId);
    if (agg.hasBudget && agg.availableCents - amount < 0 && (await insufficientPolicy(db, projectId)) === "escalate") {
      extraStepRoles.push("partner");
      checks.push({
        name: "over_budget_escalate",
        pass: true,
        detail: overBudgetMessage({ ...agg, availableCents: agg.availableCents - amount }),
      });
    }
  }

  const updated = await db
    .update(expenseReports)
    .set({ status: "pending_approval", updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${expenseReports.rowVersion} + 1` })
    .where(and(eq(expenseReports.id, input.id), eq(expenseReports.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");

  const instance = await engine.submit(db, {
    bizType: "expense",
    bizId: report.id,
    // 单头无 project_id（EXP-001）：审批项目上下文取首明细归属项目
    projectId: items[0]?.projectId ?? null,
    applicantId: user.id,
    formSnapshot: {
      expenseCode: report.code,
      totalCents: updated[0].totalCents,
      checks,
    },
    idempotencyKey: input.idempotencyKey,
    extraStepRoles,
  });
  await db.update(expenseReports).set({ approvalInstanceId: instance.id }).where(eq(expenseReports.id, report.id));
  return { report: updated[0], instance, checks };
}

export async function withdrawExpense(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number }) {
  const report = await loadReport(db, input.id);
  if (report.applicantId !== user.id) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可撤回");
  if (report.status !== "pending_approval" || !report.approvalInstanceId) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅审批中的报销可撤回");
  }
  const updated = await db
    .update(expenseReports)
    .set({ updatedBy: user.id, updatedAt: nowIso(), rowVersion: sql`${expenseReports.rowVersion} + 1` })
    .where(and(eq(expenseReports.id, input.id), eq(expenseReports.rowVersion, input.rowVersion)))
    .returning();
  if (!updated[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  const instance = await engine.withdraw(db, { instanceId: report.approvalInstanceId, actorId: user.id });
  return { report: updated[0], instance };
}

/** 支付登记（finance 专属；paid 不可编辑；幂等） */
export async function markPaid(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; paymentRef: string; idempotencyKey: string },
) {
  if (!user.globalRoles.includes("finance")) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅财务角色可登记支付");
  }
  const report = await loadReport(db, input.id);
  if (report.status === "paid") {
    const [current] = await db.select().from(expenseReports).where(eq(expenseReports.id, report.id)).limit(1);
    return { report: current, replayed: true as const }; // 幂等重放
  }
  if (report.status !== "approved_pending_payment") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅待支付报销可登记支付");
  }
  if (!input.paymentRef.trim()) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "支付参考号必填", { paymentRef: ["支付参考号必填"] });
  }
  const now = nowIso();
  const [updated] = await db
    .update(expenseReports)
    .set({
      status: "paid",
      paidAt: now, // 支付日期=服务端时间
      paidBy: user.id,
      paymentRef: input.paymentRef.trim(),
      updatedBy: user.id,
      updatedAt: now,
      rowVersion: sql`${expenseReports.rowVersion} + 1`,
    })
    .where(and(eq(expenseReports.id, input.id), eq(expenseReports.status, "approved_pending_payment")))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "报销状态已变化");
  return { report: updated, replayed: false as const };
}

/** 调整单（paid 更正唯一通道）：deltaCents 可负，走引擎 expense_adjustment [finance, partner] */
export async function adjustCreate(
  db: DbOrTx,
  user: SessionUser,
  input: { expenseId: string; deltaCents: number; reason: string; idempotencyKey: string },
) {
  const report = await loadReport(db, input.expenseId);
  if (report.status !== "paid") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅已支付报销可发起调整（更正唯一通道）");
  }
  if (input.deltaCents === 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "调整额不能为 0", { deltaCents: ["调整额不能为 0"] });
  if (!input.reason.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "调整须填原因", { reason: ["调整须填原因"] });
  const [adjustment] = await db
    .insert(expenseAdjustments)
    .values({
      expenseReportId: report.id,
      code: report.code, // 复用 EXP 前缀定位（arch/06 §2：code? 不强制）
      deltaCents: input.deltaCents,
      reason: input.reason.trim(),
      status: "pending_approval",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!adjustment) throw new Error("调整单插入失败");
  const firstItem = await db.select().from(expenseItems).where(eq(expenseItems.expenseReportId, report.id)).limit(1);
  const instance = await engine.submit(db, {
    bizType: "expense_adjustment",
    bizId: adjustment.id,
    projectId: firstItem[0]?.projectId ?? null,
    applicantId: user.id,
    formSnapshot: { expenseCode: report.code, deltaCents: input.deltaCents, reason: input.reason.trim() },
    idempotencyKey: input.idempotencyKey,
  });
  await db.update(expenseAdjustments).set({ approvalInstanceId: instance.id }).where(eq(expenseAdjustments.id, adjustment.id));
  return { adjustment, instance };
}

export async function getExpenseById(db: DbOrTx, user: SessionUser, id: string) {
  const report = await loadReport(db, id);
  await requireReportVisible(db, user, report);
  const items = await db.select().from(expenseItems).where(eq(expenseItems.expenseReportId, id));
  const adjustments = await db.select().from(expenseAdjustments).where(eq(expenseAdjustments.expenseReportId, id));
  return { ...report, items, adjustments };
}

export async function listExpenses(
  db: DbOrTx,
  user: SessionUser,
  input: {
    projectId?: string;
    mine?: boolean;
    status?: string;
    category?: string;
    dateFrom?: string;
    dateTo?: string;
    cursor?: string;
    limit: number;
  },
) {
  const conditions: (SQL | undefined)[] = [];
  if (input.projectId) {
    await requireProjectRead(db, user, input.projectId);
    conditions.push(
      sql`${expenseReports.id} IN (SELECT expense_report_id FROM expense_items WHERE project_id = ${input.projectId})`,
    );
  } else if (input.mine) {
    conditions.push(eq(expenseReports.applicantId, user.id));
  } else if (user.globalRoles.includes("finance") || user.globalRoles.includes("partner")) {
    // 财务/管理层工作台视角：全量（费用处理职责；法律内容权不因此扩散，E2E-12）
  } else {
    conditions.push(
      sql`${expenseReports.id} IN (
        SELECT expense_report_id FROM expense_items
        WHERE project_id IN (SELECT project_id FROM project_members WHERE user_id = ${user.id})
      )`,
    );
  }
  if (input.status) conditions.push(eq(expenseReports.status, input.status as "draft"));
  if (input.category) {
    conditions.push(
      sql`exists (SELECT 1 FROM expense_items ei WHERE ei.expense_report_id = ${expenseReports.id} AND ei.category = ${input.category})`,
    );
  }
  if (input.dateFrom) conditions.push(gte(expenseReports.createdAt, input.dateFrom));
  if (input.dateTo) conditions.push(lte(expenseReports.createdAt, `${input.dateTo}T23:59:59.999Z`));
  conditions.push(cursorCondition(input.cursor, expenseReports.createdAt, expenseReports.id));
  const rows = await db
    .select()
    .from(expenseReports)
    .where(and(...conditions))
    .orderBy(desc(expenseReports.createdAt), desc(expenseReports.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/* ===== 统计与导出（§4.5 口径：asOf + statusScope 标注） ===== */

const STATUS_SCOPE = "approved_and_paid（实际支出口径：EXPENSE_RECOGNIZED + EXPENSE_ADJUSTED 净额；已支付不重复计）";

export async function statsByProject(db: DbOrTx, user: SessionUser, input: { projectId: string; from?: string; to?: string }) {
  // 费用汇总默认仅 pm（本项目）/partner/finance 可见（arch/06 §7；成员只见本人 mine）
  if (!canFinanceSummary(user, input.projectId)) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "无财务汇总权限");
  }
  const agg = await aggregateProject(db, input.projectId);
  const [breakdown] = await db
    .select({
      recognized: sql<number>`coalesce(sum(${budgetLedger.actualDeltaCents}) filter (where ${budgetLedger.entryType} = 'EXPENSE_RECOGNIZED'), 0)::bigint`,
      adjusted: sql<number>`coalesce(sum(${budgetLedger.actualDeltaCents}) filter (where ${budgetLedger.entryType} = 'EXPENSE_ADJUSTED'), 0)::bigint`,
    })
    .from(budgetLedger)
    .where(eq(budgetLedger.projectId, input.projectId));
  return {
    asOf: nowIso(),
    statusScope: STATUS_SCOPE,
    projectId: input.projectId,
    effectiveBudgetCents: agg.effectiveBudgetCents,
    reservedCents: agg.reservedCents,
    actualCents: agg.actualCents,
    availableCents: agg.availableCents,
    executionRate: agg.executionRate,
    recognizedCents: Number(breakdown.recognized),
    adjustedCents: Number(breakdown.adjusted),
    hasBudget: agg.hasBudget,
  };
}

export async function statsByCategory(db: DbOrTx, user: SessionUser, input: { projectId: string }) {
  // 费用汇总默认仅 pm（本项目）/partner/finance 可见（arch/06 §7；成员只见本人 mine）
  if (!canFinanceSummary(user, input.projectId)) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "无财务汇总权限");
  }
  const rows = await db
    .select({
      category: expenseItems.category,
      total: sql<number>`sum(${expenseItems.amountCents})::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(expenseItems)
    .innerJoin(expenseReports, eq(expenseReports.id, expenseItems.expenseReportId))
    .where(
      and(
        eq(expenseItems.projectId, input.projectId),
        sql`${expenseReports.status} in ('approved_pending_payment', 'paid')`,
      ),
    )
    .groupBy(expenseItems.category);
  return { asOf: nowIso(), statusScope: STATUS_SCOPE, items: rows };
}

export async function statsByPerson(db: DbOrTx, user: SessionUser, input: { projectId: string }) {
  // 费用汇总默认仅 pm（本项目）/partner/finance 可见（arch/06 §7；成员只见本人 mine）
  if (!canFinanceSummary(user, input.projectId)) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "无财务汇总权限");
  }
  const rows = await db
    .select({
      applicantId: expenseReports.applicantId,
      total: sql<number>`sum(${expenseReports.totalCents})::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(expenseItems)
    .innerJoin(expenseReports, eq(expenseReports.id, expenseItems.expenseReportId))
    .where(
      and(
        eq(expenseItems.projectId, input.projectId),
        sql`${expenseReports.status} in ('approved_pending_payment', 'paid')`,
      ),
    )
    .groupBy(expenseReports.applicantId);
  return { asOf: nowIso(), statusScope: STATUS_SCOPE, items: rows };
}

/** 导出 CSV（服务端生成、权限过滤、audit 导出事件） */
export async function exportCsv(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId?: string; status?: string },
  ip: string | null,
  sessionId: string | null,
) {
  if (!user.globalRoles.includes("finance") && !user.globalRoles.includes("partner")) {
    // 项目负责人导出本人项目
    if (!input.projectId || !canFinanceSummary(user, input.projectId)) {
      throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "无导出权限");
    }
  }
  const conditions: (SQL | undefined)[] = [];
  if (input.projectId) conditions.push(eq(expenseItems.projectId, input.projectId));
  if (input.status) conditions.push(eq(expenseReports.status, input.status as "draft"));
  const rows = await db
    .select({
      code: expenseReports.code,
      reason: expenseReports.reason,
      status: expenseReports.status,
      totalCents: expenseReports.totalCents,
      applicantId: expenseReports.applicantId,
      projectId: expenseItems.projectId,
      category: expenseItems.category,
      amountCents: expenseItems.amountCents,
      date: expenseItems.date,
      description: expenseItems.description,
      receiptNo: expenseItems.receiptNo,
    })
    .from(expenseItems)
    .innerJoin(expenseReports, eq(expenseReports.id, expenseItems.expenseReportId))
    .where(and(...conditions))
    .orderBy(expenseReports.code, expenseItems.date);
  const header = "报销单,事由,状态,合计(分),申请人,项目,类别,明细金额(分),日期,说明,票据号";
  const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [r.code, r.reason, r.status, r.totalCents, r.applicantId, r.projectId, r.category, r.amountCents, r.date, r.description, r.receiptNo]
      .map(escape)
      .join(","),
  );
  const csv = `﻿${header}\n${lines.join("\n")}`;
  await recordAudit(db, {
    actorId: user.id,
    sessionId,
    action: "export.run",
    targetType: "expense",
    targetId: input.projectId ?? null,
    result: "success",
    afterJson: { rows: rows.length, filters: input },
    ip,
  });
  return { csv, rowCount: rows.length, asOf: nowIso(), statusScope: STATUS_SCOPE };
}
