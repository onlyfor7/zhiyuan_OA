import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { approvalInstances, approvalPolicies, approvalSteps, orgUnits, projects, systemConfig, userRoles, users } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import type { DbOrTx } from "../../trpc/context";
import { notify } from "../../modules/notify";
import { emitEvent } from "../../lib/events";
import { compileFlow, findEnabledFlow, resolveConfigValue, v2OptsForBinding } from "./flow";
import { compileFlowV2, isFlowV2Def, type CcEventV2, type CompiledStepV2, type FlowV2Settings } from "./flow-v2";
import { recordAudit } from "../audit";

/**
 * 统一审批引擎（arch/04 §4 接口逐字；arch/03 §6：唯一审批实现，禁止各模块自建）。
 * 所有函数在业务事务内调用（tx 由调用方经 db.transaction 传递）。
 *
 * 步骤序号编排：策略第 i 步解析出唯一候选人 → seq=i；
 * countersign=all 且多候选人 → 展开为 seq=i*1000+j（j=1..N），组键=floor(seq/1000)。
 */

export type BizType = "change_request" | "access_grant" | "travel" | "travel_change" | "budget" | "funding" | "expense" | "expense_adjustment" | "timesheet" | "generic_request";

export interface ApprovalInstanceRow {
  id: string;
  code: string;
  bizType: string;
  bizId: string;
  projectId: string | null;
  applicantId: string;
  currentStepSeq: number;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  idempotencyKey: string;
  formSnapshot: Record<string, unknown>;
  /** 20-02：v2 步骤元数据/抄送事件/设置存于 policy_snapshot（无步骤结构加列，兼容在途实例） */
  policySnapshot: unknown;
}

export interface ApprovalHandlers {
  onApproved(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void>;
  onRejected(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void>;
  onWithdrawn(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void>;
  /** 20-02 退回提交人：业务单回草稿语义（arch/14 §7 returnBack=initiator） */
  onReturned?(tx: DbOrTx, instance: ApprovalInstanceRow): Promise<void>;
}

const handlers = new Map<string, ApprovalHandlers>();

/** 20-02：custom_form:* 实例复用 generic_request 业务处理器（业务回写语义同源） */
function handlerFor(bizType: string): ApprovalHandlers | undefined {
  return handlers.get(bizType) ?? (bizType.startsWith("custom_form:") ? handlers.get("generic_request") : undefined);
}

/** 注册业务处理器；返回反注册函数（恢复前一个注册项，测试可临时替换） */
export function registerHandler(bizType: string, h: ApprovalHandlers): () => void {
  const previous = handlers.get(bizType);
  handlers.set(bizType, h);
  return () => {
    if (handlers.get(bizType) !== h) return;
    if (previous) {
      handlers.set(bizType, previous);
    } else {
      handlers.delete(bizType);
    }
  };
}

/** biz_type → 通知 source_type（travel_change 归属 travel；notifications.source_type 为 text 无枚举约束） */
function bizSourceType(bizType: string): string {
  if (bizType === "change_request") return "change_request";
  if (bizType === "travel" || bizType === "travel_change") return "travel";
  if (bizType === "budget") return "budget";
  if (bizType === "funding") return "funding";
  if (bizType === "expense" || bizType === "expense_adjustment") return "expense";
  if (bizType === "timesheet") return "time_entry";
  if (bizType === "generic_request") return "generic_request";
  if (bizType.startsWith("custom_form:")) return "generic_request";
  return "access_grant";
}
function groupKey(seq: number): number {
  return seq >= 1000 ? Math.floor(seq / 1000) : seq;
}

/* ===== 策略解析（arch/04 §2.9） ===== */

interface PolicyRow {
  id: string;
  bizType: string;
  priority: number;
  matchJson: Record<string, unknown>;
  stepsJson: Array<Record<string, unknown>>;
  enabled: boolean;
  description: string;
}

function matchPolicy(policy: PolicyRow, snapshot: Record<string, unknown>): boolean {
  return Object.entries(policy.matchJson).every(([key, expected]) => {
    // min_ 前缀键按 ≥ 匹配（金额阈值类策略，arch/05 §7 出差预计费用阈值）
    if (key.startsWith("min_")) {
      const actual = Number(snapshot[key.slice(4)]);
      return Number.isFinite(actual) && actual >= Number(expected);
    }
    return snapshot[key] === expected;
  });
}

async function resolvePolicy(
  db: DbOrTx,
  bizType: string,
  formSnapshot: Record<string, unknown>,
): Promise<PolicyRow> {
  const policies = await db
    .select()
    .from(approvalPolicies)
    .where(eq(approvalPolicies.bizType, bizType))
    .orderBy(asc(approvalPolicies.priority));
  const hit = (policies as PolicyRow[]).find((p) => p.enabled !== false && matchPolicy(p, formSnapshot));
  if (!hit) {
    throw new BusinessError(ERROR_CODE.POLICY_NOT_FOUND, `审批策略无命中（biz_type=${bizType}）`);
  }
  return hit;
}

/** 角色落地为具体人：project_manager → 项目 manager_id；全局角色 → 该角色全部用户（arch/04 §2.9） */
export async function resolveRoleCandidates(
  db: DbOrTx,
  role: string,
  projectId: string | null,
): Promise<string[]> {
  if (role === "project_manager" && projectId === "__global_pm_pool__") {
    // 全局范围流程的 project_manager 解析：全部 pm 全局角色用户（通用申请单等无项目上下文）
    const rows = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(userRoles.roleKey, "project_manager"), eq(users.status, "active")));
    return rows.map((r) => r.userId);
  }
  if (role === "project_manager") {
    if (!projectId) return [];
    const rows = await db
      .select({ managerId: projects.managerId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return rows[0] ? [rows[0].managerId] : [];
  }
  const rows = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.roleKey, role), eq(users.status, "active")));
  return rows.map((r) => r.userId);
}

interface ResolvedStep {
  seq: number;
  countersign: "any" | "all";
  candidates: string[];
  approverRole: string | null;
}

async function resolveSteps(
  db: DbOrTx,
  policy: PolicyRow,
  projectId: string | null,
  applicantId: string,
  runtimeApproverId?: string,
): Promise<ResolvedStep[]> {
  const steps: ResolvedStep[] = [];
  for (let i = 0; i < policy.stepsJson.length; i++) {
    const def = policy.stepsJson[i];
    const countersign = (def.countersign as "any" | "all" | undefined) ?? "any";
    const approverRole = typeof def.approver_role === "string" ? def.approver_role : null;
    let candidates: string[] = [];
    if (def.runtime_resolve === true) {
      // arch/07 §4.2：工时周期审批人运行时解析（调用方落 approver_id，职责分离在解析处保证）
      if (!runtimeApproverId) {
        throw new BusinessError(ERROR_CODE.POLICY_NOT_FOUND, "策略要求运行时解析审批人，但未提供 runtimeApproverId");
      }
      candidates = [runtimeApproverId];
    } else if (typeof def.approver_id === "string") {
      candidates = [def.approver_id];
    } else if (approverRole) {
      candidates = await resolveRoleCandidates(db, approverRole, projectId);
    }
    // 自审跳过（arch/04 §2.9）：步骤解析出申请人本人 → 剔除
    candidates = candidates.filter((id) => id !== applicantId);
    if (candidates.length === 0) {
      throw new BusinessError(
        ERROR_CODE.SELF_APPROVAL_BLOCKED,
        `审批步骤 ${i + 1} 无可用审批人（申请人本人不可自审，策略配置错误）`,
      );
    }
    if (countersign === "all" && candidates.length > 1) {
      candidates.forEach((candidate, j) => {
        // 会签子步精确到人：清空角色，防止同角色其他成员代审他人子步
        steps.push({ seq: (i + 1) * 1000 + (j + 1), countersign: "all", candidates: [candidate], approverRole: null });
      });
    } else {
      steps.push({ seq: i + 1, countersign, candidates, approverRole });
    }
  }
  return steps;
}

/* ===== 接口（arch/04 §4 逐字） ===== */

export interface SubmitInput {
  /** 20-02：自定义表单走 `custom_form:<code>`（findEnabledFlow 按绑定命中） */
  bizType: BizType | (string & {});
  bizId: string;
  projectId?: string | null;
  applicantId: string;
  formSnapshot: Record<string, unknown>;
  idempotencyKey: string;
  /** 超预算 escalate 等场景追加的管理层步骤（arch/06 §4.4；加性参数，不影响既有调用） */
  extraStepRoles?: string[];
  /** 策略占位 runtime_resolve 时的运行时审批人（arch/07 §4.2 工时周期：pm→partner / 主项目 manager / 配置默认） */
  runtimeApproverId?: string;
}

export async function submit(db: DbOrTx, input: SubmitInput): Promise<ApprovalInstanceRow> {
  // 幂等键冲突 → 返回原实例（arch/04 §4）
  const dup = await db
    .select()
    .from(approvalInstances)
    .where(eq(approvalInstances.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (dup[0]) return dup[0] as ApprovalInstanceRow;

  // 流程编译器优先（arch/09 §3.1）：enabled flow_definitions → 条件按表单快照求值展开步骤；
  // 无自定义流程回退 approval_policies（E4 既有 biz_type 零回归）
  const flow = await findEnabledFlow(db, input.bizType, input.projectId ?? null);
  if (flow && isFlowV2Def(flow.definitionJson)) {
    return submitWithV2Flow(db, input, flow);
  }
  let policySnapshot: Record<string, unknown>;
  let steps: ResolvedStep[];
  if (flow) {
    // 金额键名归一：travel 等快照用 estimated_cost_cents，流程条件白名单为 amount_cents（arch/09 §3.1）
    const evalSnapshot = {
      ...input.formSnapshot,
      amount_cents: input.formSnapshot.amount_cents ?? input.formSnapshot.estimated_cost_cents ?? null,
    };
    // R8（§18）：默认流程条件值含 $config 引用（approval.amount_thresholds.*）——编译期从 system_config 求值
    const configRows = await db.select().from(systemConfig);
    const compiled = compileFlow(flow.definitionJson, evalSnapshot, false, (key) => resolveConfigValue(configRows, key));
    steps = [];
    for (let i = 0; i < compiled.steps.length; i++) {
      const node = compiled.steps[i];
      let candidates: string[] = [];
      if (node.kind === "role") {
        if (node.role === "project_manager" && !input.projectId) {
          // 全局范围流程（generic_request 等无项目上下文）：project_manager 解析为全部 pm 角色用户
          candidates = await resolveRoleCandidates(db, "project_manager", "__global_pm_pool__");
        } else {
          candidates = await resolveRoleCandidates(db, node.role!, input.projectId ?? null);
        }
      } else if (node.kind === "user") {
        candidates = node.userId ? [node.userId] : [];
      } else if (node.kind === "initiator_manager") {
        candidates = input.runtimeApproverId ? [input.runtimeApproverId] : [];
      } else if (node.kind === "initiator_choice") {
        // G3（arch/11）：发起人指定审批人——从表单快照 chosenApproverId 读取，落具体人
        const chosen = input.formSnapshot.chosenApproverId;
        if (typeof chosen !== "string" || !chosen.trim()) {
          throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "该流程节点要求发起人指定审批人", {
            chosenApproverId: ["请选择审批人"],
          });
        }
        if (chosen === input.applicantId) {
          throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "指定审批人不能为发起人本人", {
            chosenApproverId: ["指定审批人不能为发起人本人"],
          });
        }
        const [chosenUser] = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, chosen), eq(users.status, "active")))
          .limit(1);
        if (!chosenUser) {
          throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "指定审批人不存在或已停用", {
            chosenApproverId: ["指定审批人不存在或已停用"],
          });
        }
        candidates = [chosen];
      } else if (node.kind === "project_manager") {
        candidates = input.projectId ? await resolveRoleCandidates(db, "project_manager", input.projectId) : [];
      }
      candidates = candidates.filter((id) => id !== input.applicantId);
      if (candidates.length === 0) {
        throw new BusinessError(
          ERROR_CODE.SELF_APPROVAL_BLOCKED,
          `流程节点「${node.label}」无可用审批人（申请人本人不可自审）`,
        );
      }
      if (node.countersign === "all" && candidates.length > 1) {
        candidates.forEach((candidate, j) => {
          steps.push({ seq: (i + 1) * 1000 + (j + 1), countersign: "all", candidates: [candidate], approverRole: null });
        });
      } else {
        steps.push({
          seq: i + 1,
          countersign: node.countersign,
          candidates,
          // role 存角色名；project_manager/initiator_manager 存 kind 供成员校验与前端识别；user 置空（精确到人）
          approverRole: node.kind === "role" ? node.role : node.kind === "user" ? null : node.kind,
        });
      }
    }
    policySnapshot = {
      flowId: flow.id,
      flowName: flow.name,
      flowVersion: flow.versionNo,
      compiledSteps: compiled.steps,
    };
  } else {
    const policy = await resolvePolicy(db, input.bizType, input.formSnapshot);
    steps = await resolveSteps(db, policy, input.projectId ?? null, input.applicantId, input.runtimeApproverId);
    policySnapshot = {
      policyId: policy.id,
      bizType: policy.bizType,
      matchJson: policy.matchJson,
      stepsJson: policy.stepsJson,
      description: policy.description,
    };
  }
  // escalate：在策略步骤之后追加管理层步骤（原因已写入 formSnapshot）
  for (const role of input.extraStepRoles ?? []) {
    const candidates = (await resolveRoleCandidates(db, role, input.projectId ?? null)).filter(
      (id) => id !== input.applicantId,
    );
    if (candidates.length === 0) {
      throw new BusinessError(
        ERROR_CODE.SELF_APPROVAL_BLOCKED,
        `追加步骤（${role}）无可用审批人（申请人本人不可自审）`,
      );
    }
    steps.push({ seq: steps.length + 1, countersign: "any", candidates, approverRole: role });
  }
  const code = await nextCode("APR", db);

  const [instance] = await db
    .insert(approvalInstances)
    .values({
      code,
      bizType: input.bizType,
      bizId: input.bizId,
      projectId: input.projectId ?? null,
      applicantId: input.applicantId,
      formSnapshot: input.formSnapshot,
      policySnapshot,
      currentStepSeq: steps[0].seq,
      status: "pending",
      idempotencyKey: input.idempotencyKey,
    })
    .returning();
  if (!instance) throw new Error("审批实例插入失败");

  for (const step of steps) {
    await db.insert(approvalSteps).values({
      instanceId: instance.id,
      seq: step.seq,
      approverId: step.candidates[0],
      approverRole: step.approverRole,
      countersign: step.countersign,
      status: "pending",
    });
  }

  // 通知当前步骤审批人（arch/04 §6 approval_pending）；SSE 待办+小元提醒事件（arch/12 §20.3）
  const firstGroup = groupKey(steps[0].seq);
  for (const step of steps.filter((s) => groupKey(s.seq) === firstGroup)) {
    await notify(db, {
      eventType: "approval_pending",
      recipientId: step.candidates[0],
      sourceType: bizSourceType(input.bizType),
      sourceId: input.bizId,
      payload: { approvalInstanceId: instance.id, code: instance.code },
    });
    emitEvent({ type: "approval.todo", userId: step.candidates[0], instanceId: instance.id, code: instance.code, bizType: input.bizType });
    emitEvent({ type: "assistant.feed", userId: step.candidates[0], reason: "approval_pending" });
  }

  return instance as ApprovalInstanceRow;
}

export interface ActInput {
  instanceId: string;
  stepSeq: number;
  actorId: string;
  /** 20-02 退回（arch/14 §7）：节点 ops.returnBack≠none 时可用 */
  action: "approve" | "reject" | "transfer" | "return";
  comment?: string | null;
  transferTo?: string | null;
  /** N4（arch/05 §9）：审批动作幂等键；同键重放返回现状 200，异键重放已处理步骤 409 */
  idempotencyKey?: string | null;
}

export interface ActResult {
  instance: ApprovalInstanceRow;
  /** 本动作是否为本次生效（并发/重试时 false 表示命中已处理，返回现状） */
  applied: boolean;
}

/** N4：该幂等键是否已落在本实例任一步骤（重读库，供重放判定；判定时点值而非请求开始时点） */
async function wasKeyActed(db: DbOrTx, instanceId: string, key: string | null | undefined): Promise<boolean> {
  if (!key) return false;
  const rows = await db
    .select({ id: approvalSteps.id })
    .from(approvalSteps)
    .where(and(eq(approvalSteps.instanceId, instanceId), eq(approvalSteps.actedIdempotencyKey, key)))
    .limit(1);
  return rows.length > 0;
}

/** 有域专属终态事件的业务类型：引擎不再发通用 approval_result（arch 裁定 2026-10-27） */
const BIZ_WITH_DOMAIN_RESULT_EVENT = new Set(["travel", "travel_change"]);
export async function act(db: DbOrTx, input: ActInput): Promise<ActResult> {
  const instance = await loadInstance(db, input.instanceId);
  // N4 重放短路（arch/04 §4 v1.2）：该 key 已落在本实例任一步骤 → 200 applied=false。
  // 先于终态/当前步校验：覆盖「步骤已推进后的同键顺序重放」与「并发同键双击败者」。
  if (await wasKeyActed(db, instance.id, input.idempotencyKey)) {
    return { instance, applied: false };
  }
  if (instance.status !== "pending") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "审批实例已终态，不可再操作");
  }
  if (groupKey(instance.currentStepSeq) !== groupKey(input.stepSeq)) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "该步骤不是当前审批步骤");
  }

  const stepRows = await db
    .select()
    .from(approvalSteps)
    .where(and(eq(approvalSteps.instanceId, instance.id), eq(approvalSteps.seq, input.stepSeq)))
    .limit(1);
  const step = stepRows[0];
  if (!step) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "审批步骤不存在");

  // 审批人校验：该行审批人或其角色成员（角色在 submit 时已落地为候选人集合）
  const approverOk =
    step.approverId === input.actorId ||
    (step.approverRole !== null &&
      (await resolveRoleCandidates(db, step.approverRole, instance.projectId)).includes(input.actorId));
  if (!approverOk) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "审批步骤不存在或无权操作");
  }

  const now = new Date().toISOString();

  if (input.action === "transfer") {
    if (!input.transferTo) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "转交必须指定接收人", {
        transferTo: ["转交必须指定接收人"],
      });
    }
    const updated = await db
      .update(approvalSteps)
      .set({
        approverId: input.transferTo,
        delegatedFrom: step.approverId,
        actedBy: input.actorId,
        actedAt: now,
        actedIdempotencyKey: input.idempotencyKey ?? null,
      })
      .where(and(eq(approvalSteps.id, step.id), eq(approvalSteps.status, "pending")))
      .returning();
    if (updated.length === 0) return replayOrConflict(db, step.id, input, instance); // N4：重读再判，同键 200，异键 409
    return { instance, applied: true };
  }

  const meta = stepMetaOf(instance, input.stepSeq);
  if (input.action === "reject" && meta?.ops.requireCommentOnReject !== false && (!input.comment || input.comment.trim() === "")) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "驳回必须填写理由", {
      comment: ["驳回必须填写理由"],
    });
  }
  if (input.action === "approve" && meta?.ops.requireCommentOnApprove === true && (!input.comment || input.comment.trim() === "")) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "通过必须填写意见（节点要求）", {
      comment: ["通过必须填写意见（节点要求）"],
    });
  }
  // 20-02 退回（arch/14 §7）：节点 ops.returnBack≠none 时可用；prev=回拨上一审批步 / initiator=退回提交人
  if (input.action === "return") {
    const mode = meta?.ops.returnBack ?? "none";
    if (mode === "none") {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "该节点未开启退回", { action: ["该节点未开启退回"] });
    }
    const now0 = new Date().toISOString();
    if (mode === "prev") {
      const [prevStep] = await db
        .select()
        .from(approvalSteps)
        .where(and(eq(approvalSteps.instanceId, instance.id), eq(approvalSteps.status, "approved"), sql`${approvalSteps.seq} < ${step.seq}`))
        .orderBy(desc(approvalSteps.seq))
        .limit(1);
      if (!prevStep) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "无上一审批步可退回");
      await db
        .update(approvalSteps)
        .set({ status: "skipped", comment: `[returned] ${input.comment ?? ""}`.trim(), actedBy: input.actorId, actedAt: now0, actedIdempotencyKey: input.idempotencyKey ?? null })
        .where(and(eq(approvalSteps.id, step.id), eq(approvalSteps.status, "pending")));
      await db
        .update(approvalSteps)
        .set({ status: "pending", actedBy: null, actedAt: null, actedIdempotencyKey: null, comment: null })
        .where(eq(approvalSteps.id, prevStep.id));
      await db.update(approvalInstances).set({ currentStepSeq: prevStep.seq, updatedAt: now0 }).where(eq(approvalInstances.id, instance.id));
      if (prevStep.approverId) {
        await notify(db, { eventType: "approval_pending", recipientId: prevStep.approverId, sourceType: bizSourceType(instance.bizType), sourceId: instance.bizId, payload: { approvalInstanceId: instance.id, code: instance.code, returned: true } });
      }
      await recordAudit(db, { actorId: input.actorId, sessionId: null, action: "approval.return", targetType: "approval_instance", targetId: instance.id, result: "success", afterJson: { mode: "prev", fromSeq: step.seq, toSeq: prevStep.seq }, ip: null });
      return { instance: await loadInstance(db, instance.id), applied: true };
    }
    // initiator：业务单回草稿（onReturned 钩子）；实例置 withdrawn 并留痕（枚举无 returned，audit 区分）
    await db
      .update(approvalSteps)
      .set({ status: "skipped", comment: `[returned_to_initiator] ${input.comment ?? ""}`.trim(), actedBy: input.actorId, actedAt: now0, actedIdempotencyKey: input.idempotencyKey ?? null })
      .where(and(eq(approvalSteps.id, step.id), eq(approvalSteps.status, "pending")));
    await finalize(db, instance, "withdrawn");
    const returnedHandler = handlerFor(instance.bizType);
    if (returnedHandler?.onReturned) await returnedHandler.onReturned(db, instance);
    await recordAudit(db, { actorId: input.actorId, sessionId: null, action: "approval.return", targetType: "approval_instance", targetId: instance.id, result: "success", afterJson: { mode: "initiator", fromSeq: step.seq }, ip: null });
    return { instance: await loadInstance(db, instance.id), applied: true };
  }

  // 条件更新（并发/重试安全；N4：同键重放返回现状 200，异键重放已处理步骤 409）
  const acted = await db
    .update(approvalSteps)
    .set({
      status: input.action === "approve" ? "approved" : "rejected",
      actedBy: input.actorId,
      comment: input.comment ?? null,
      actedAt: now,
      actedIdempotencyKey: input.idempotencyKey ?? null,
    })
    .where(and(eq(approvalSteps.id, step.id), eq(approvalSteps.status, "pending")))
    .returning({ id: approvalSteps.id });
  if (acted.length === 0) {
    return replayOrConflict(db, step.id, input, instance);
  }

  if (input.action === "reject") {
    await finalize(db, instance, "rejected");
    const handler = handlerFor(instance.bizType);
    if (handler) await handler.onRejected(db, instance);
    emitEvent({ type: "assistant.feed", userId: instance.applicantId, reason: "approval_result" });
    return { instance: await loadInstance(db, instance.id), applied: true };
  }

  // approve：同组还有未决 → 停留；否则推进或终审
  const groupPending = await db
    .select({ id: approvalSteps.id })
    .from(approvalSteps)
    .where(
      and(
        eq(approvalSteps.instanceId, instance.id),
        eq(approvalSteps.status, "pending"),
        sql`(floor(${approvalSteps.seq} / 1000) = ${groupKey(instance.currentStepSeq)} OR ${approvalSteps.seq} = ${instance.currentStepSeq})`,
      ),
    );
  if (groupPending.length > 0) {
    return { instance, applied: true };
  }

  const nextPending = await db
    .select({ seq: approvalSteps.seq })
    .from(approvalSteps)
    .where(
      and(
        eq(approvalSteps.instanceId, instance.id),
        eq(approvalSteps.status, "pending"),
        gt(approvalSteps.seq, instance.currentStepSeq),
      ),
    )
    .orderBy(asc(approvalSteps.seq))
    .limit(1);

  if (nextPending[0]) {
    await db
      .update(approvalInstances)
      .set({ currentStepSeq: nextPending[0].seq, updatedAt: now })
      .where(eq(approvalInstances.id, instance.id));
    // 20-02：去重 once + 抄送触发 + auto_pass/auto_reject 到步级联
    {
      const fresh = await loadInstance(db, instance.id);
      const passedCount = Object.keys(v2Snapshot(fresh).stepMeta ?? {}).filter((k) => Number(k) <= nextPending[0].seq).length;
      await postAdvanceV2(db, fresh as ApprovalInstanceRow, step.approverId, passedCount);
      await autoCascadeV2(db, (await loadInstance(db, instance.id)) as ApprovalInstanceRow);
    }
    // 通知下一组审批人
    const groupSteps = await db
      .select()
      .from(approvalSteps)
      .where(
        and(
          eq(approvalSteps.instanceId, instance.id),
          eq(approvalSteps.status, "pending"),
          sql`(floor(${approvalSteps.seq} / 1000) = ${groupKey(nextPending[0].seq)} OR ${approvalSteps.seq} = ${nextPending[0].seq})`,
        ),
      );
    for (const s of groupSteps) {
      if (s.approverId) {
        await notify(db, {
          eventType: "approval_pending",
          recipientId: s.approverId,
          sourceType: bizSourceType(instance.bizType),
          sourceId: instance.bizId,
          payload: { approvalInstanceId: instance.id, code: instance.code },
        });
        emitEvent({ type: "approval.todo", userId: s.approverId, instanceId: instance.id, code: instance.code, bizType: instance.bizType });
        emitEvent({ type: "assistant.feed", userId: s.approverId, reason: "approval_pending" });
      }
    }
    return { instance: await loadInstance(db, instance.id), applied: true };
  }

  // 20-02 终审：补发剩余抄送（afterStepIndex ≤ 总步数）
  {
    const fresh = await loadInstance(db, instance.id);
    const total = Object.keys(v2Snapshot(fresh).stepMeta ?? {}).length;
    await postAdvanceV2(db, fresh as ApprovalInstanceRow, step.approverId, total);
  }
  // 终审通过 → 同事务调用业务处理器（arch/04 §4）
  await finalize(db, instance, "approved");
  const handler = handlerFor(instance.bizType);
  if (handler) await handler.onApproved(db, instance);
  if (!BIZ_WITH_DOMAIN_RESULT_EVENT.has(instance.bizType)) {
    // 域专属终态事件由业务 handler 发送（如 travel_approval）；引擎只发无专属事件的业务
    await notify(db, {
      eventType: "approval_result",
      recipientId: instance.applicantId,
      sourceType: bizSourceType(instance.bizType),
      sourceId: instance.bizId,
      payload: { approvalInstanceId: instance.id, result: "approved" },
    });
  }
  emitEvent({ type: "assistant.feed", userId: instance.applicantId, reason: "approval_result" });
  return { instance: await loadInstance(db, instance.id), applied: true };
}

export interface WithdrawInput {
  instanceId: string;
  actorId: string;
}

export async function withdraw(db: DbOrTx, input: WithdrawInput): Promise<ApprovalInstanceRow> {
  const instance = await loadInstance(db, input.instanceId);
  if (instance.status !== "pending") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅进行中的审批可撤回");
  }
  if (instance.applicantId !== input.actorId) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "仅申请人可撤回");
  }
  await finalize(db, instance, "withdrawn");
  // 剩余 pending 步骤置 skipped（终态语义清晰）
  await db
    .update(approvalSteps)
    .set({ status: "skipped" })
    .where(and(eq(approvalSteps.instanceId, instance.id), eq(approvalSteps.status, "pending")));
  const handler = handlers.get(instance.bizType);
  if (handler) await handler.onWithdrawn(db, instance);
  return loadInstance(db, instance.id);
}

async function replayOrConflict(
  db: DbOrTx,
  stepId: string,
  input: ActInput,
  instance: ApprovalInstanceRow,
): Promise<ActResult> {
  // N4：条件更新影响 0 行 → 重读步骤行（判定时点值），并按「该 key 是否已落在本实例任一步骤」裁决：
  // 已处理过（含并发同键双击败者）→ 200 applied=false；从未见过该 key 且步骤已处理 → 409。
  const fresh = await db
    .select({ actedIdempotencyKey: approvalSteps.actedIdempotencyKey })
    .from(approvalSteps)
    .where(eq(approvalSteps.id, stepId))
    .limit(1);
  const current = await loadInstance(db, input.instanceId);
  if (input.idempotencyKey && (fresh[0]?.actedIdempotencyKey === input.idempotencyKey)) {
    return { instance: current, applied: false };
  }
  if (await wasKeyActed(db, instance.id, input.idempotencyKey)) {
    return { instance: current, applied: false };
  }
  throw new BusinessError(
    ERROR_CODE.STATE_CONFLICT,
    "该审批步骤已被处理（异键重放或并发冲突）",
  );
}

async function finalize(
  db: DbOrTx,
  instance: ApprovalInstanceRow,
  status: "approved" | "rejected" | "withdrawn",
): Promise<void> {
  // 条件更新防并发双终态（arch/03 §6.5、arch/04 §3）
  const updated = await db
    .update(approvalInstances)
    .set({ status, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(and(eq(approvalInstances.id, instance.id), eq(approvalInstances.status, "pending")))
    .returning({ id: approvalInstances.id });
  if (updated.length === 0) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "审批实例已终态（并发操作）");
  }
}

async function loadInstance(db: DbOrTx, instanceId: string): Promise<ApprovalInstanceRow> {
  const rows = await db
    .select()
    .from(approvalInstances)
    .where(eq(approvalInstances.id, instanceId))
    .limit(1);
  if (!rows[0]) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "审批实例不存在或无权访问");
  return rows[0] as ApprovalInstanceRow;
}

/* ===== 20-02 引擎运行时扩展（arch/14 §6/§7/§8/§9/§10；v2 流程定义） ===== */

interface StepMetaV2 {
  nodeId: string;
  label: string;
  approvalType: "manual" | "auto_pass" | "auto_reject";
  ops: { transfer: boolean; returnBack: "none" | "prev" | "initiator"; requireCommentOnReject: boolean; requireCommentOnApprove: boolean };
  sameAsInitiator: string;
  fieldPerms?: Record<string, { read?: boolean; edit?: boolean; hidden?: boolean }>;
}

interface V2Snapshot {
  stepMeta?: Record<string, StepMetaV2>;
  ccEvents?: CcEventV2[];
  ccFired?: string[];
  ccRecipients?: string[];
  settings?: FlowV2Settings;
  compiledSteps?: Array<{ nodeId: string; label: string; conditionTrace: unknown[] }>;
}

function v2Snapshot(instance: { policySnapshot: unknown }): V2Snapshot {
  return (instance.policySnapshot ?? {}) as V2Snapshot;
}

function stepMetaOf(instance: { policySnapshot: unknown }, seq: number): StepMetaV2 | undefined {
  return v2Snapshot(instance).stepMeta?.[String(seq)];
}

/** 提交人直属上级 */
async function managerOf(db: DbOrTx, userId: string): Promise<string | null> {
  const [r] = await db.select({ managerId: users.managerId }).from(users).where(eq(users.id, userId)).limit(1);
  return r?.managerId ?? null;
}

/** 提交人所在部门负责人（0017 leader_id；无负责人→调用方如实报错） */
async function deptHeadOf(db: DbOrTx, userId: string): Promise<string | null> {
  const [r] = await db
    .select({ leaderId: orgUnits.leaderId })
    .from(users)
    .innerJoin(orgUnits, eq(orgUnits.id, users.orgUnitId))
    .where(eq(users.id, userId))
    .limit(1);
  return r?.leaderId ?? null;
}

/** v2 审批人解析（arch/14 §6）：返回候选人；manager_chain 链不足返回 []（调用方提前终止） */
async function resolveApproverV2(
  db: DbOrTx,
  cs: CompiledStepV2,
  input: SubmitInput,
  bizBinding: string,
): Promise<string[]> {
  const kind = cs.kind;
  if (kind === "role") return resolveRoleCandidates(db, cs.role ?? "", input.projectId ?? null);
  if (kind === "user") return cs.userId ? [cs.userId] : [];
  if (kind === "project_manager") {
    if (input.projectId) return resolveRoleCandidates(db, "project_manager", input.projectId);
    return resolveRoleCandidates(db, "project_manager", "__global_pm_pool__");
  }
  if (kind === "initiator_manager") {
    if (input.runtimeApproverId) return [input.runtimeApproverId];
    const m = await managerOf(db, input.applicantId);
    return m ? [m] : [];
  }
  if (kind === "initiator_choice") {
    const chosen = input.formSnapshot.chosenApproverId;
    if (typeof chosen !== "string" || !chosen.trim()) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "该流程节点要求发起人指定审批人", { chosenApproverId: ["请选择审批人"] });
    }
    if (chosen === input.applicantId) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "指定审批人不能为发起人本人", { chosenApproverId: ["指定审批人不能为发起人本人"] });
    }
    const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, chosen), eq(users.status, "active"))).limit(1);
    if (!u) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "指定审批人不存在或已停用", { chosenApproverId: ["指定审批人不存在或已停用"] });
    if (cs.choiceScope) {
      const scope = cs.choiceScope;
      if (scope.mode === "roles") {
        const rows = await db.select({ roleKey: userRoles.roleKey }).from(userRoles).where(eq(userRoles.userId, chosen));
        if (!rows.some((r) => scope.roleKeys?.includes(r.roleKey))) {
          throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "指定审批人不在选择范围（角色）内", { chosenApproverId: ["指定审批人不在选择范围内"] });
        }
      } else if (scope.mode === "users" && !scope.userIds?.includes(chosen)) {
        throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "指定审批人不在选择范围（成员）内", { chosenApproverId: ["指定审批人不在选择范围内"] });
      }
    }
    return [chosen];
  }
  if (kind === "initiator_self") return [input.applicantId];
  if (kind === "dept_head") {
    const head = await deptHeadOf(db, input.applicantId);
    if (!head) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "提交人所在部门未配置负责人（dept_head 无法解析）", {
        approver: ["请管理员在组织架构维护部门负责人（org_units.leader_id）"],
      });
    }
    return [head];
  }
  if (kind === "manager_chain") {
    const level = cs.chainLevel ?? 1;
    let cur = await managerOf(db, input.applicantId);
    for (let i = 1; i < level && cur; i++) cur = await managerOf(db, cur);
    return cur ? [cur] : [];
  }
  if (kind === "form_contact") {
    if (!bizBinding.startsWith("custom_form:")) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "form_contact 审批人仅自定义表单流程可用", { approver: ["form_contact 仅 custom_form:* 可用"] });
    }
    const fieldKey = (cs as unknown as { fieldKey?: string }).fieldKey;
    const v = input.formSnapshot[`form.${fieldKey ?? ""}`];
    if (typeof v !== "string" || !v.trim()) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, `表单内联系人字段为空：form.${fieldKey ?? ""}`, {
        [`form.${fieldKey ?? ""}`]: ["人员控件未选择"],
      });
    }
    return [v];
  }
  return [];
}

/** sameAsInitiator 四态（arch/14 §6）：返回 {candidates, skipStep} */
async function applySameAsInitiator(
  db: DbOrTx,
  cs: CompiledStepV2,
  input: SubmitInput,
  candidates: string[],
): Promise<{ candidates: string[]; skipStep: boolean }> {
  if (!candidates.includes(input.applicantId)) return { candidates, skipStep: false };
  switch (cs.sameAsInitiator) {
    case "self":
      return { candidates, skipStep: false };
    case "skip":
      // 与默认一致：剔除申请人本人；若剔除后为空，由调用方按自审禁止红线拒绝（arch/03，G-20-2-2 登记）
      return { candidates: candidates.filter((c) => c !== input.applicantId), skipStep: false };
    case "to_manager": {
      const m = await managerOf(db, input.applicantId);
      if (!m) {
        throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, `节点「${cs.label}」sameAsInitiator=to_manager 但提交人未配置直属上级`);
      }
      return { candidates: [...new Set(candidates.filter((c) => c !== input.applicantId).concat(m))], skipStep: false };
    }
    case "to_dept_head": {
      const head = await deptHeadOf(db, input.applicantId);
      if (!head) {
        throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, `节点「${cs.label}」sameAsInitiator=to_dept_head 但提交人所在部门未配置负责人`);
      }
      return { candidates: [...new Set(candidates.filter((c) => c !== input.applicantId).concat(head))], skipStep: false };
    }
    default:
      return { candidates, skipStep: false };
  }
}

/** 抄送触发：解析接收人 → notify + emitEvent + 审计；ccFired/ccRecipients 记入 policySnapshot */
async function fireCcEvent(
  db: DbOrTx,
  instance: ApprovalInstanceRow,
  event: CcEventV2,
  projectId: string | null,
): Promise<void> {
  const recipients = new Set<string>();
  for (const r of event.receivers) {
    let ids: string[] = [];
    if (r.kind === "role") ids = await resolveRoleCandidates(db, r.role ?? "", projectId);
    else if (r.kind === "user" && r.userId) ids = [r.userId];
    else if (r.kind === "initiator_manager") {
      const m = await managerOf(db, instance.applicantId);
      ids = m ? [m] : [];
    } else if (r.kind === "project_manager") {
      ids = projectId ? await resolveRoleCandidates(db, "project_manager", projectId) : await resolveRoleCandidates(db, "project_manager", "__global_pm_pool__");
    } else if (r.kind === "initiator_self") ids = [instance.applicantId];
    else if (r.kind === "dept_head") {
      const head = await deptHeadOf(db, instance.applicantId);
      ids = head ? [head] : [];
    }
    for (const id of ids) recipients.add(id);
  }
  const list = [...recipients].filter(Boolean);
  for (const uid of list) {
    await notify(db, {
      eventType: "approval_cc",
      recipientId: uid,
      sourceType: bizSourceType(instance.bizType),
      sourceId: instance.bizId,
      payload: { approvalInstanceId: instance.id, code: instance.code, ccNodeName: event.name },
    });
  }
  const snap = v2Snapshot(instance);
  await recordAudit(db, {
    actorId: null,
    sessionId: null,
    action: "approval.cc",
    targetType: "approval_instance",
    targetId: instance.id,
    result: "success",
    afterJson: { ccNode: event.name, nodeId: event.nodeId, recipients: list },
    ip: null,
  });
  snap.ccFired = [...(snap.ccFired ?? []), event.nodeId];
  snap.ccRecipients = [...new Set([...(snap.ccRecipients ?? []), ...list])];
  await db
    .update(approvalInstances)
    .set({ policySnapshot: instance.policySnapshot as Record<string, unknown>, updatedAt: new Date().toISOString() })
    .where(eq(approvalInstances.id, instance.id));
}

/** 到步后处理：去重 once（同审批人后续 pending 步自动 skipped 留痕 dedupe）+ 抄送触发 */
async function postAdvanceV2(
  db: DbOrTx,
  instance: ApprovalInstanceRow,
  passedStepApproverId: string | null,
  passedStepCount: number,
): Promise<void> {
  const snap = v2Snapshot(instance);
  if (snap.settings?.dedupeApprover === "once" && passedStepApproverId) {
    const later = await db
      .select()
      .from(approvalSteps)
      .where(and(eq(approvalSteps.instanceId, instance.id), eq(approvalSteps.status, "pending"), eq(approvalSteps.approverId, passedStepApproverId)));
    for (const st of later) {
      await db
        .update(approvalSteps)
        .set({ status: "skipped", comment: "dedupe: 同审批人前面步骤已批准", actedAt: new Date().toISOString() })
        .where(and(eq(approvalSteps.id, st.id), eq(approvalSteps.status, "pending")));
    }
  }
  for (const ev of snap.ccEvents ?? []) {
    if ((snap.ccFired ?? []).includes(ev.nodeId)) continue;
    if (ev.afterStepIndex <= passedStepCount) await fireCcEvent(db, instance, ev, instance.projectId);
  }
}

/** auto_pass/auto_reject 级联：到步即系统落（actedBy=NULL/comment=auto）；auto_reject 走拒绝链 */
async function autoCascadeV2(db: DbOrTx, instance: ApprovalInstanceRow): Promise<void> {
  for (;;) {
    const snap = v2Snapshot(instance);
    const meta = stepMetaOf(instance, instance.currentStepSeq);
    if (!meta || meta.approvalType === "manual") return;
    const [step] = await db
      .select()
      .from(approvalSteps)
      .where(and(eq(approvalSteps.instanceId, instance.id), eq(approvalSteps.seq, instance.currentStepSeq)))
      .limit(1);
    if (!step || step.status !== "pending") return;
    const now = new Date().toISOString();
    if (meta.approvalType === "auto_reject") {
      await db
        .update(approvalSteps)
        .set({ status: "rejected", comment: "auto", actedAt: now })
        .where(and(eq(approvalSteps.id, step.id), eq(approvalSteps.status, "pending")));
      await recordAudit(db, {
        actorId: null, sessionId: null, action: "approval.auto", targetType: "approval_instance", targetId: instance.id,
        result: "success", afterJson: { stepSeq: step.seq, type: "auto_reject" },
        ip: null,
      });
      await finalize(db, instance, "rejected");
      const handler = handlerFor(instance.bizType);
      if (handler) await handler.onRejected(db, instance);
      return;
    }
    await db
      .update(approvalSteps)
      .set({ status: "approved", comment: "auto", actedAt: now })
      .where(and(eq(approvalSteps.id, step.id), eq(approvalSteps.status, "pending")));
    await recordAudit(db, {
      actorId: null, sessionId: null, action: "approval.auto", targetType: "approval_instance", targetId: instance.id,
      result: "success", afterJson: { stepSeq: step.seq, type: "auto_pass" },
      ip: null,
    });
    const next = await db
      .select({ seq: approvalSteps.seq })
      .from(approvalSteps)
      .where(and(eq(approvalSteps.instanceId, instance.id), eq(approvalSteps.status, "pending"), gt(approvalSteps.seq, instance.currentStepSeq)))
      .orderBy(asc(approvalSteps.seq))
      .limit(1);
    if (!next[0]) {
      await finalize(db, instance, "approved");
      const handler = handlerFor(instance.bizType);
      if (handler) await handler.onApproved(db, instance);
      return;
    }
    await db.update(approvalInstances).set({ currentStepSeq: next[0].seq, updatedAt: now }).where(eq(approvalInstances.id, instance.id));
    instance.currentStepSeq = next[0].seq;
    await postAdvanceV2(db, instance, step.approverId, Object.keys(snap.stepMeta ?? {}).filter((k) => Number(k) <= next[0].seq).length);
  }
}

/** v2 提交流程：编译→逐 step 解析（新策略/sameAsInitiator）→ 步骤落地 → 首组通知 → 提交时抄送 → auto 级联 */
async function submitWithV2Flow(
  db: DbOrTx,
  input: SubmitInput,
  flow: { id: string; name: string; versionNo: number; definitionJson: Record<string, unknown>; bizBinding?: string },
): Promise<ApprovalInstanceRow> {
  const evalSnapshot = {
    ...input.formSnapshot,
    amount_cents: input.formSnapshot.amount_cents ?? input.formSnapshot.estimated_cost_cents ?? null,
  };
  const configRows = await db.select().from(systemConfig);
  const compiled = compileFlowV2(flow.definitionJson, evalSnapshot, false, (key) => resolveConfigValue(configRows, key), await v2OptsForBinding(db, flow.bizBinding ?? input.bizType));

  interface Planned {
    countersign: "any" | "all";
    candidates: string[];
    approverRole: string | null;
    skipped: boolean;
    meta: StepMetaV2;
  }
  const planned: Planned[] = [];
  for (const cs of compiled.steps) {
    let candidates = await resolveApproverV2(db, cs, input, flow.bizBinding ?? input.bizType);
    if (candidates.length === 0 && cs.kind === "manager_chain") continue; // 链不足提前终止
    const same = await applySameAsInitiator(db, cs, input, candidates);
    candidates = same.candidates;
    if (!same.skipStep && cs.sameAsInitiator !== "self") {
      // 自审禁止（arch/03）：剔除申请人本人；self 语义显式保留
      candidates = candidates.filter((c) => c !== input.applicantId);
    }
    if (candidates.length === 0 && !same.skipStep) {
      throw new BusinessError(ERROR_CODE.SELF_APPROVAL_BLOCKED, `流程节点「${cs.label}」无可用审批人（申请人本人不可自审）`);
    }
    planned.push({
      countersign: cs.countersign,
      candidates,
      approverRole: cs.kind === "role" ? (cs.role ?? "") : cs.kind === "user" ? null : cs.kind,
      skipped: same.skipStep,
      meta: {
        nodeId: cs.nodeId,
        label: cs.label,
        approvalType: cs.approvalType,
        ops: cs.ops,
        sameAsInitiator: cs.sameAsInitiator,
        ...(cs.fieldPerms ? { fieldPerms: cs.fieldPerms } : {}),
      },
    });
  }
  // 超预算 escalate 等追加管理层步骤（arch/06 §4.4；与 v1 同语义：角色解析、剔除申请人、空则拒绝）
  for (const role of input.extraStepRoles ?? []) {
    const candidates = (await resolveRoleCandidates(db, role, input.projectId ?? null)).filter((c) => c !== input.applicantId);
    if (candidates.length === 0) {
      throw new BusinessError(ERROR_CODE.SELF_APPROVAL_BLOCKED, `追加步骤（${role}）无可用审批人（申请人本人不可自审）`);
    }
    planned.push({
      countersign: "any",
      candidates,
      approverRole: role,
      skipped: false,
      meta: {
        nodeId: "escalate",
        label: `追加审批（${role}）`,
        approvalType: "manual",
        ops: { transfer: true, returnBack: "none", requireCommentOnReject: true, requireCommentOnApprove: false },
        sameAsInitiator: "skip",
      },
    });
  }
  if (planned.length === 0) {
    throw new BusinessError(ERROR_CODE.SELF_APPROVAL_BLOCKED, "流程无可用审批步骤");
  }

  const code = await nextCode("APR", db);
  const stepMeta: Record<string, StepMetaV2> = {};
  interface StepRow {
    seq: number;
    approverId: string | null;
    approverRole: string | null;
    countersign: "any" | "all";
    status: "pending" | "skipped";
    comment: string | null;
  }
  const stepRows: StepRow[] = [];
  let i = 0;
  for (const p of planned) {
    i++;
    if (p.skipped || p.candidates.length === 0) {
      stepRows.push({ seq: i, approverId: p.candidates[0] ?? null, approverRole: p.approverRole, countersign: p.countersign, status: "skipped", comment: "same_as_initiator:skip" });
      stepMeta[String(i)] = p.meta;
      continue;
    }
    const finalCandidates = p.candidates;
    if (finalCandidates.length > 1 && p.countersign === "all") {
      finalCandidates.forEach((cand, j) => {
        const seq = i * 1000 + (j + 1);
        // 会签子步角色置空（同 v1）：他人子步无权代审（carryover-n4 钉住）
        stepRows.push({ seq, approverId: cand, approverRole: null, countersign: "all", status: "pending", comment: null });
        stepMeta[String(seq)] = p.meta;
      });
    } else {
      stepRows.push({ seq: i, approverId: finalCandidates[0], approverRole: p.approverRole, countersign: p.countersign, status: "pending", comment: null });
      stepMeta[String(i)] = p.meta;
    }
  }
  const firstSeq = stepRows[0].seq;

  const [instance] = await db
    .insert(approvalInstances)
    .values({
      code,
      bizType: input.bizType,
      bizId: input.bizId,
      projectId: input.projectId ?? null,
      applicantId: input.applicantId,
      formSnapshot: input.formSnapshot,
      policySnapshot: {
        flowId: flow.id,
        flowName: flow.name,
        flowVersion: flow.versionNo,
        compiledSteps: compiled.steps,
        stepMeta,
        ccEvents: compiled.ccEvents,
        ccFired: [],
        ccRecipients: [],
        settings: compiled.settings,
      },
      currentStepSeq: firstSeq,
      status: "pending",
      idempotencyKey: input.idempotencyKey,
    })
    .returning();
  if (!instance) throw new Error("审批实例插入失败");

  for (const row of stepRows) {
    await db.insert(approvalSteps).values({
      instanceId: instance.id,
      seq: row.seq,
      approverId: row.approverId,
      approverRole: row.approverRole,
      countersign: row.countersign,
      status: row.status,
      ...(row.comment ? { comment: row.comment } : {}),
    });
  }

  const firstGroup = groupKey(firstSeq);
  for (const row of stepRows.filter((r) => groupKey(r.seq) === firstGroup && r.status === "pending")) {
    if (!row.approverId) continue;
    await notify(db, {
      eventType: "approval_pending",
      recipientId: row.approverId,
      sourceType: bizSourceType(input.bizType),
      sourceId: input.bizId,
      payload: { approvalInstanceId: instance.id, code },
    });
    emitEvent({ type: "approval.todo", userId: row.approverId, instanceId: instance.id, code, bizType: input.bizType });
    emitEvent({ type: "assistant.feed", userId: row.approverId, reason: "approval_pending" });
  }
  for (const ev of compiled.ccEvents.filter((e) => e.afterStepIndex === 0)) {
    await fireCcEvent(db, instance as ApprovalInstanceRow, ev, input.projectId ?? null);
  }
  await autoCascadeV2(db, instance as ApprovalInstanceRow);
  return (await loadInstance(db, instance.id)) as ApprovalInstanceRow;
}
