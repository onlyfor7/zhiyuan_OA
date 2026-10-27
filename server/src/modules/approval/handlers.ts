import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { CONFIG_KEY } from "@lexflow/shared";

import {
  accessGrants,
  budgets,
  budgetLedger,
  changeRequests,
  expenseAdjustments,
  expenseItems,
  expenseReports,
  fundingRequests,
  milestones,
  planItems,
  planVersions,
  projects,
  stages,
  systemConfig,
  tasks,
  travelEvents,
  travelRequests,
  userRoles,
} from "../../db/schema";
import { recordLedger, aggregateProject, isOverBudget, overBudgetMessage } from "../../services/ledger/record";
import { linkMaterialFiles } from "../governance/archive";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import type { DbOrTx } from "../../trpc/context";
import { registerHandler, type ApprovalInstanceRow } from "../../services/approval/engine";
import { notify } from "../../modules/notify";

/**
 * 审批引擎业务处理器（arch/04 §4 registerHandler 契约）：
 * change_request（延期：终审通过同事务生成新计划版本 + live 同步 + 恢复任务）、
 * access_grant（档案授权：active / revoked）。
 * 全部在引擎事务内执行；任何一步失败 → 整体回滚（无部分写入）。
 */

interface TargetItem {
  ref_id: string;
  item_type: "stage" | "milestone" | "task";
  original_start: string;
  original_end: string;
  new_start: string;
  new_end: string;
}

function asTargets(raw: unknown): TargetItem[] {
  return (raw as TargetItem[]) ?? [];
}

/* ===== change_request ===== */

export function registerChangeRequestHandler(): void {
  registerHandler("change_request", {
    async onApproved(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      const rows = await tx
        .select()
        .from(changeRequests)
        .where(eq(changeRequests.id, instance.bizId))
        .limit(1);
      const cr = rows[0];
      if (!cr) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "延期申请不存在");
      if (cr.status !== "pending_approval") {
        throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "延期申请状态不允许审批通过落地");
      }

      const targets = asTargets(cr.targetItems);
      if (targets.length === 0) {
        throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "延期申请缺少目标计划项");
      }

      // ① 旧 active 版本先 superseded（部分唯一索引：先释放 active 位再插新版本）
      const activeVersions = await tx
        .select()
        .from(planVersions)
        .where(and(eq(planVersions.projectId, cr.projectId), eq(planVersions.status, "active")));
      const oldActive = activeVersions[0];
      if (!oldActive) {
        throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "项目无 active 计划版本");
      }
      await tx
        .update(planVersions)
        .set({ status: "superseded", updatedAt: new Date().toISOString() })
        .where(eq(planVersions.id, oldActive.id));

      // ② 新计划版本（arch/04 §2.3：每项目恰一个 active；v(n+1)，kind=change）
      const maxVersion = await tx
        .select({ max: sql<number>`coalesce(max(${planVersions.versionNo}), 0)` })
        .from(planVersions)
        .where(eq(planVersions.projectId, cr.projectId));
      const newVersionNo = Number(maxVersion[0].max) + 1;
      const [newVersion] = await tx
        .insert(planVersions)
        .values({
          projectId: cr.projectId,
          versionNo: newVersionNo,
          kind: "change",
          status: "active",
          sourceChangeRequestId: cr.id,
          notes: `延期审批通过生成（${cr.code}）`,
          createdBy: instance.applicantId,
          updatedBy: instance.applicantId,
        })
        .returning();
      if (!newVersion) throw new Error("计划版本插入失败");

      // ③ 新版本 items：复制旧版本全量 items，目标项日期替换；依赖重映射到新 item id。
      // 先一次性生成全部新 id（PLN-I1：items 只写不改，插入即终稿，绝无 UPDATE）。
      const oldItems = await tx
        .select()
        .from(planItems)
        .where(eq(planItems.planVersionId, oldActive.id))
        .orderBy(asc(planItems.seq));
      const targetByRef = new Map(targets.map((t) => [t.ref_id, t]));
      const idMap = new Map<string, string>();
      for (const item of oldItems) {
        idMap.set(item.id, randomUUID());
      }
      for (const item of oldItems) {
        const target = targetByRef.get(item.refId);
        await tx.insert(planItems).values({
          id: idMap.get(item.id),
          planVersionId: newVersion.id,
          itemType: item.itemType,
          refId: item.refId,
          name: item.name, // 版本时点快照名（arch/04 §2.3 v1.1：复制旧版快照，不重新取名）
          plannedStart: target ? target.new_start : item.plannedStart,
          plannedEnd: target ? target.new_end : item.plannedEnd,
          seq: item.seq,
          dependsOn: item.dependsOn.map((dep) => idMap.get(dep) ?? dep),
          createdBy: instance.applicantId,
        });
      }

      // ④ live planned_* 同步（延期是唯一合法的 planned_* 变更入口，arch/04 §2.3）
      const byType = {
        stage: targets.filter((t) => t.item_type === "stage"),
        milestone: targets.filter((t) => t.item_type === "milestone"),
        task: targets.filter((t) => t.item_type === "task"),
      };
      for (const t of byType.stage) {
        await tx
          .update(stages)
          .set({ plannedStart: t.new_start, plannedEnd: t.new_end, updatedAt: new Date().toISOString() })
          .where(eq(stages.id, t.ref_id));
      }
      for (const t of byType.milestone) {
        await tx
          .update(milestones)
          .set({ plannedDate: t.new_start, updatedAt: new Date().toISOString() })
          .where(eq(milestones.id, t.ref_id));
      }
      for (const t of byType.task) {
        await tx
          .update(tasks)
          .set({ plannedStart: t.new_start, plannedEnd: t.new_end, updatedAt: new Date().toISOString() })
          .where(eq(tasks.id, t.ref_id));
      }

      // ⑤ 恢复措施生成任务（source_type='change_request'，arch/04 §2.4）
      const measures = (cr.recoveryMeasures as Array<{ measure: string; owner_id: string; checkpoint_date: string }>) ?? [];
      for (const m of measures) {
        const code = await nextCode("TSK", tx);
        await tx.insert(tasks).values({
          projectId: cr.projectId,
          code,
          title: `恢复措施：${m.measure}`,
          assigneeId: m.owner_id,
          plannedStart: m.checkpoint_date,
          plannedEnd: m.checkpoint_date,
          status: "pending",
          sourceType: "change_request",
          sourceId: cr.id,
          createdBy: instance.applicantId,
          updatedBy: instance.applicantId,
        });
        await notify(tx, {
          eventType: "task_due_soon",
          recipientId: m.owner_id,
          sourceType: "change_request",
          sourceId: cr.id,
          payload: { changeRequestCode: cr.code, measure: m.measure, checkpointDate: m.checkpoint_date },
        });
      }

      // ⑥ 申请单终态
      await tx
        .update(changeRequests)
        .set({
          status: "approved",
          decidedAt: new Date().toISOString(),
          resultingPlanVersionId: newVersion.id,
          rowVersion: cr.rowVersion + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(changeRequests.id, cr.id));
    },

    async onRejected(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(changeRequests)
        .set({ status: "rejected", decidedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(and(eq(changeRequests.id, instance.bizId), eq(changeRequests.status, "pending_approval")));
    },

    async onWithdrawn(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(changeRequests)
        .set({ status: "draft", updatedAt: new Date().toISOString() })
        .where(and(eq(changeRequests.id, instance.bizId), eq(changeRequests.status, "pending_approval")));
    },
  });
}

/* ===== access_grant ===== */

export function registerAccessGrantHandler(): void {
  registerHandler("access_grant", {
    async onApproved(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      const rows = await tx
        .select()
        .from(accessGrants)
        .where(eq(accessGrants.id, instance.bizId))
        .limit(1);
      const grant = rows[0];
      if (!grant) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "授权不存在");
      if (grant.status !== "pending_approval") {
        throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "授权状态不允许审批通过落地");
      }
      await tx
        .update(accessGrants)
        .set({ status: "active", updatedAt: new Date().toISOString() })
        .where(eq(accessGrants.id, grant.id));
      await notify(tx, {
        eventType: "approval_result",
        recipientId: grant.granteeId,
        sourceType: "access_grant",
        sourceId: grant.id,
        payload: { result: "approved", scopeType: grant.scopeType, scopeId: grant.scopeId },
      });
    },

    async onRejected(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      // arch/01 §3 v1.1：授权状态机含 rejected——驳回落 rejected（不留 revoke_* 痕迹）
      await tx
        .update(accessGrants)
        .set({ status: "rejected", updatedAt: new Date().toISOString() })
        .where(and(eq(accessGrants.id, instance.bizId), eq(accessGrants.status, "pending_approval")));
    },

    async onWithdrawn(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(accessGrants)
        .set({
          status: "revoked",
          revokedAt: new Date().toISOString(),
          revokeReason: "申请人撤回",
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(accessGrants.id, instance.bizId), eq(accessGrants.status, "pending_approval")));
    },
  });
}

/* ===== travel / travel_change（arch/05 §4：通过不写任何预算占用，TRV-004） ===== */

interface TravelChangePayload {
  changes: Record<string, unknown>;
  before: Record<string, unknown>;
}

export function registerTravelHandlers(): void {
  registerHandler("travel", {
    async onApproved(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      const rows = await tx
        .select()
        .from(travelRequests)
        .where(eq(travelRequests.id, instance.bizId))
        .limit(1);
      const travel = rows[0];
      if (!travel) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "出差申请不存在");
      if (travel.status !== "pending_approval") {
        throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "出差状态不允许审批通过落地");
      }
      await tx
        .update(travelRequests)
        .set({ status: "approved", updatedAt: new Date().toISOString(), rowVersion: sql`${travelRequests.rowVersion} + 1` })
        .where(eq(travelRequests.id, travel.id));
      await tx.insert(travelEvents).values({
        travelRequestId: travel.id,
        actorId: instance.applicantId,
        action: "approve",
      });
      await notify(tx, {
        eventType: "travel_approval",
        recipientId: travel.applicantId,
        sourceType: "travel",
        sourceId: travel.id,
        payload: { result: "approved", code: travel.code },
      });
    },
    async onRejected(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(travelRequests)
        .set({ status: "rejected", updatedAt: new Date().toISOString() })
        .where(and(eq(travelRequests.id, instance.bizId), eq(travelRequests.status, "pending_approval")));
      await tx.insert(travelEvents).values({
        travelRequestId: instance.bizId,
        actorId: instance.applicantId,
        action: "reject",
      });
      await notify(tx, {
        eventType: "travel_approval",
        recipientId: instance.applicantId,
        sourceType: "travel",
        sourceId: instance.bizId,
        payload: { result: "rejected" },
      });
    },
    async onWithdrawn(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(travelRequests)
        .set({ status: "draft", updatedAt: new Date().toISOString() })
        .where(and(eq(travelRequests.id, instance.bizId), eq(travelRequests.status, "pending_approval")));
      await tx.insert(travelEvents).values({
        travelRequestId: instance.bizId,
        actorId: instance.applicantId,
        action: "withdraw",
      });
    },
  });

  registerHandler("travel_change", {
    async onApproved(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      const rows = await tx
        .select()
        .from(travelRequests)
        .where(eq(travelRequests.id, instance.bizId))
        .limit(1);
      const travel = rows[0];
      if (!travel) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "出差申请不存在");
      if (travel.status !== "approved" && travel.status !== "in_progress") {
        throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅 approved/in_progress 可应用变更");
      }
      const payload = (instance.formSnapshot.changePayload ?? null) as TravelChangePayload | null;
      const changes = payload?.changes ?? {};
      await tx
        .update(travelRequests)
        .set({
          ...(changes.destination !== undefined ? { destination: String(changes.destination) } : {}),
          ...(changes.startOn !== undefined ? { startOn: String(changes.startOn) } : {}),
          ...(changes.endOn !== undefined ? { endOn: String(changes.endOn) } : {}),
          ...(changes.estimatedCostCents !== undefined
            ? { estimatedCostCents: Number(changes.estimatedCostCents) }
            : {}),
          updatedAt: new Date().toISOString(),
          rowVersion: sql`${travelRequests.rowVersion} + 1`,
        })
        .where(eq(travelRequests.id, travel.id));
      await tx.insert(travelEvents).values({
        travelRequestId: travel.id,
        actorId: instance.applicantId,
        action: "change_approved",
        payloadJson: (payload ?? null) as Record<string, unknown> | null,
      });
    },
    async onRejected(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      // 驳回原状不动（arch/05 §4.6），仅事件由引擎审计留痕
      void instance;
    },
    async onWithdrawn(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      void instance;
    },
  });
}

/* ===== 迭代 3 财务域（arch/06 §4：核销同事务/无双扣/幂等；台账唯一写入者） ===== */

export function registerFinanceHandlers(): void {
  registerHandler("budget", {
    async onApproved(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      const rows = await tx.select().from(budgets).where(eq(budgets.id, instance.bizId)).limit(1);
      const budget = rows[0];
      if (!budget) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "预算不存在");
      if (budget.status !== "pending_approval") {
        throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "预算状态不允许审批通过落地");
      }
      // 每项目恰一个 active：先 supersede 旧版再激活新版（部分唯一索引）
      await tx
        .update(budgets)
        .set({ status: "superseded", updatedAt: new Date().toISOString() })
        .where(and(eq(budgets.projectId, budget.projectId), eq(budgets.status, "active")));
      await tx
        .update(budgets)
        .set({ status: "active", updatedBy: instance.applicantId, updatedAt: new Date().toISOString(), rowVersion: sql`${budgets.rowVersion} + 1` })
        .where(eq(budgets.id, budget.id));
      // marker 分录（deltas 0/0；有效预算以 budgets 表 active 版本为准，arch/01 §4 口径）
      await recordLedger(tx, {
        projectId: budget.projectId,
        budgetVersionId: budget.id,
        sourceType: "budget",
        sourceId: budget.id,
        entryType: instance.formSnapshot.adjustOf ? "BUDGET_ADJUSTED" : "BUDGET_ACTIVATED",
        seq: 0,
      });
    },
    async onRejected(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(budgets)
        .set({ status: "draft", updatedAt: new Date().toISOString() })
        .where(and(eq(budgets.id, instance.bizId), eq(budgets.status, "pending_approval")));
    },
    async onWithdrawn(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(budgets)
        .set({ status: "draft", updatedAt: new Date().toISOString() })
        .where(and(eq(budgets.id, instance.bizId), eq(budgets.status, "pending_approval")));
    },
  });

  registerHandler("funding", {
    async onApproved(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      const rows = await tx.select().from(fundingRequests).where(eq(fundingRequests.id, instance.bizId)).limit(1);
      const funding = rows[0];
      if (!funding) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "经费申请不存在");
      if (funding.approvalStatus !== "pending_approval") {
        throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "经费状态不允许审批通过落地");
      }
      // §4.2：usage 不动；FUNDING_RESERVED 只写一次（幂等键兜底重放）
      await tx
        .update(fundingRequests)
        .set({ approvalStatus: "approved", updatedBy: instance.applicantId, updatedAt: new Date().toISOString(), rowVersion: sql`${fundingRequests.rowVersion} + 1` })
        .where(eq(fundingRequests.id, funding.id));
      await recordLedger(tx, {
        projectId: funding.projectId,
        sourceType: "funding",
        sourceId: funding.id,
        entryType: "FUNDING_RESERVED",
        reservedDeltaCents: funding.amountCents,
        seq: 0,
      });
      // 归档 11 目录（经费获批）：仅材料文件（fv 非空来源对合法；纯来源对受二态约束限制，STATUS 登记待放宽）
      await linkMaterialFiles(tx, {
        projectId: funding.projectId,
        dirKey: "11_预算与经费",
        sourceType: "funding",
        sourceId: funding.id,
        createdBy: instance.applicantId,
      });
    },
    async onRejected(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(fundingRequests)
        .set({ approvalStatus: "rejected", updatedAt: new Date().toISOString() })
        .where(and(eq(fundingRequests.id, instance.bizId), eq(fundingRequests.approvalStatus, "pending_approval")));
    },
    async onWithdrawn(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(fundingRequests)
        .set({ approvalStatus: "draft", updatedAt: new Date().toISOString() })
        .where(and(eq(fundingRequests.id, instance.bizId), eq(fundingRequests.approvalStatus, "pending_approval")));
    },
  });

  registerHandler("expense", {
    async onApproved(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      const rows = await tx.select().from(expenseReports).where(eq(expenseReports.id, instance.bizId)).limit(1);
      const report = rows[0];
      if (!report) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "报销单不存在");
      if (report.status !== "pending_approval") {
        throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "报销状态不允许审批通过落地");
      }

      // §4.3 核销事务（同事务；超额进实际；无双扣）
      const items = await tx.select().from(expenseItems).where(eq(expenseItems.expenseReportId, report.id));
      const byFunding = new Map<string, typeof items>();
      for (const item of items) {
        if (!item.fundingRequestId) continue;
        const list = byFunding.get(item.fundingRequestId) ?? [];
        list.push(item);
        byFunding.set(item.fundingRequestId, list);
      }
      let releaseSeq = 1;
      let recognizeSeq = 0;
      for (const [fundingId, fundingItems] of byFunding) {
        const [funding] = await tx.select().from(fundingRequests).where(eq(fundingRequests.id, fundingId)).limit(1);
        if (!funding || funding.approvalStatus !== "approved") {
          throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "关联经费不存在或未获批");
        }
        const [reserved] = await tx
          .select({ net: sql<number>`coalesce(sum(${budgetLedger.reservedDeltaCents}), 0)::bigint` })
          .from(budgetLedger)
          .where(and(eq(budgetLedger.sourceType, "funding"), eq(budgetLedger.sourceId, fundingId)));
        let remaining = Number(reserved.net); // 净占用余额（幂等重算，禁止双扣的余额来源）
        for (const item of fundingItems) {
          const release = Math.min(item.amountCents, Math.max(0, remaining)); // 核销额 ≤ 剩余占用
          remaining -= release;
          if (release > 0) {
            await recordLedger(tx, {
              projectId: item.projectId,
              sourceType: "funding",
              sourceId: fundingId,
              entryType: "FUNDING_RELEASED",
              reservedDeltaCents: -release,
              seq: releaseSeq++,
            });
          }
          // 批准额全部进实际（超出原占用部分仍记实际支出；禁止双扣 = released 与 recognized 不重复扣同一金额）
          await recordLedger(tx, {
            projectId: item.projectId,
            sourceType: "expense",
            sourceId: report.id,
            entryType: "EXPENSE_RECOGNIZED",
            actualDeltaCents: item.amountCents,
            seq: recognizeSeq++,
          });
        }
      }
      const linkedIds = new Set([...byFunding.values()].flat().map((i) => i.id));
      for (const item of items) {
        if (linkedIds.has(item.id)) continue;
        await recordLedger(tx, {
          projectId: item.projectId,
          sourceType: "expense",
          sourceId: report.id,
          entryType: "EXPENSE_RECOGNIZED",
          actualDeltaCents: item.amountCents,
          seq: recognizeSeq++,
        });
      }

      // 超预算检查（§4.4：block → 整事务回滚拒绝；escalate 提交时已追加管理层步骤，此处放行并通知）
      const projectIds = [...new Set(items.map((i) => i.projectId))];
      for (const projectId of projectIds) {
        const agg = await aggregateProject(tx, projectId);
        if (isOverBudget(agg)) {
          const policy = await budgetPolicy(tx, projectId);
          if (policy === "block") {
            throw new BusinessError(ERROR_CODE.BUDGET_EXCEEDED, overBudgetMessage(agg), undefined, {
              projectId,
              availableCents: agg.availableCents,
            });
          }
          await notifyBudgetExceeded(tx, projectId, report, agg);
        }
      }

      await tx
        .update(expenseReports)
        .set({ status: "approved_pending_payment", updatedBy: instance.applicantId, updatedAt: new Date().toISOString(), rowVersion: sql`${expenseReports.rowVersion} + 1` })
        .where(eq(expenseReports.id, report.id));

      // 归档 10 目录（报销获批，含票据文件）
      const firstProject = items[0]?.projectId ?? null;
      if (firstProject) {
        // 费用归档 10：票据/材料文件（纯来源对受二态约束限制，STATUS 登记待放宽）
        await linkMaterialFiles(tx, {
          projectId: firstProject,
          dirKey: "10_出差与费用",
          sourceType: "expense",
          sourceId: report.id,
          createdBy: instance.applicantId,
        });
      }
    },
    async onRejected(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(expenseReports)
        .set({ status: "rejected", updatedAt: new Date().toISOString() })
        .where(and(eq(expenseReports.id, instance.bizId), eq(expenseReports.status, "pending_approval")));
    },
    async onWithdrawn(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(expenseReports)
        .set({ status: "draft", updatedAt: new Date().toISOString() })
        .where(and(eq(expenseReports.id, instance.bizId), eq(expenseReports.status, "pending_approval")));
    },
  });

  registerHandler("expense_adjustment", {
    async onApproved(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      const rows = await tx.select().from(expenseAdjustments).where(eq(expenseAdjustments.id, instance.bizId)).limit(1);
      const adjustment = rows[0];
      if (!adjustment) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "调整单不存在");
      if (adjustment.status !== "pending_approval") {
        throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "调整单状态不允许审批通过落地");
      }
      await tx
        .update(expenseAdjustments)
        .set({ status: "approved", updatedAt: new Date().toISOString() })
        .where(eq(expenseAdjustments.id, adjustment.id));
      const [report] = await tx.select().from(expenseReports).where(eq(expenseReports.id, adjustment.expenseReportId)).limit(1);
      if (!report) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "报销单不存在");
      const [item] = await tx.select().from(expenseItems).where(eq(expenseItems.expenseReportId, report.id)).limit(1);
      await recordLedger(tx, {
        projectId: item?.projectId ?? instance.projectId ?? instance.applicantId,
        sourceType: "expense_adjustment",
        sourceId: adjustment.id,
        entryType: "EXPENSE_ADJUSTED",
        actualDeltaCents: adjustment.deltaCents,
        seq: 0,
      });
    },
    async onRejected(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(expenseAdjustments)
        .set({ status: "rejected", updatedAt: new Date().toISOString() })
        .where(and(eq(expenseAdjustments.id, instance.bizId), eq(expenseAdjustments.status, "pending_approval")));
    },
    async onWithdrawn(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
      await tx
        .update(expenseAdjustments)
        .set({ status: "rejected", updatedAt: new Date().toISOString() })
        .where(and(eq(expenseAdjustments.id, instance.bizId), eq(expenseAdjustments.status, "pending_approval")));
    },
  });
}

/** 超预算策略读取（budget.insufficient_policy，默认 escalate；byProject 可覆盖） */
async function budgetPolicy(db: DbOrTx, projectId: string): Promise<"block" | "escalate"> {
  const [row] = await db
    .select({ valueJson: systemConfig.valueJson })
    .from(systemConfig)
    .where(eq(systemConfig.key, CONFIG_KEY.BUDGET_INSUFFICIENT_POLICY))
    .limit(1);
  const value = (row?.valueJson ?? {}) as { default?: string; byProject?: Record<string, string> };
  const hit = value.byProject?.[projectId] ?? value.default ?? "escalate";
  return hit === "block" ? "block" : "escalate";
}

/** 超预算通知（budget_exceeded：pm + finance） */
async function notifyBudgetExceeded(
  db: DbOrTx,
  projectId: string,
  report: { id: string; code: string },
  agg: { availableCents: number },
): Promise<void> {
  const [project] = await db.select({ managerId: projects.managerId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const targets = new Set<string>();
  if (project?.managerId) targets.add(project.managerId);
  const financeUsers = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(eq(userRoles.roleKey, "finance"));
  for (const f of financeUsers) targets.add(f.userId);
  for (const recipientId of targets) {
    await notify(db, {
      eventType: "budget_exceeded",
      recipientId,
      sourceType: "expense",
      sourceId: report.id,
      payload: { expenseCode: report.code, availableCents: agg.availableCents },
    });
  }
}

/** 引擎处理器注册入口（server 启动与测试 setup 各调用一次，幂等覆盖） */
export function registerApprovalHandlers(): void {
  registerChangeRequestHandler();
  registerAccessGrantHandler();
  registerTravelHandlers();
  registerFinanceHandlers();
}
