import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import {
  accessGrants,
  changeRequests,
  milestones,
  planItems,
  planVersions,
  stages,
  tasks,
} from "../../db/schema";
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
      // 状态机无 rejected 态：pending_approval 被拒 → revoked（留 revoke_reason，STATUS 留坑待架构确认）
      await tx
        .update(accessGrants)
        .set({
          status: "revoked",
          revokedAt: new Date().toISOString(),
          revokeReason: "审批驳回",
          updatedAt: new Date().toISOString(),
        })
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

/** 引擎处理器注册入口（server 启动与测试 setup 各调用一次，幂等覆盖） */
export function registerApprovalHandlers(): void {
  registerChangeRequestHandler();
  registerAccessGrantHandler();
}
