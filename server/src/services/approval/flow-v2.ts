import {
  ERROR_CODE,
  FLOW_APPROVER_KIND,
  FLOW_APPROVER_KIND_V2,
  FLOW_CONDITION_FIELDS,
  FLOW_NODE_OPS_DEFAULTS,
  FLOW_NODE_TYPE_V2,
  FLOW_V2_LIMITS,
  SAME_AS_INITIATOR,
  type FlowNodeOps,
  type SameAsInitiator,
} from "@lexflow/shared";

import { BusinessError } from "../../lib/errors";
import { FLOW_CONDITION_OP_BY_FIELD as V1_OP_BY_FIELD, type CompiledApproval } from "./flow";

/**
 * 编译器 v2（arch/14 §3；迭代 20 工单 §1）：竖向有序数组流程定义。
 * - validateFlowStructureV2：保存时结构校验（FLOW_INVALID 400，字段级落位）；
 * - compileFlowV2：按表单快照逐分支求值、第一命中进入（else 兜底），exploreBoth=发布全分支展开；
 * - v2 步骤为 v1 CompiledApproval 超集（approvalType/ops/sameAsInitiator/fieldPerms/chainLevel 透传）。
 */

export interface FlowV2ChoiceScope {
  mode: "all" | "roles" | "users";
  roleKeys?: string[];
  userIds?: string[];
}

export interface FlowV2ApproverRef {
  kind: string;
  role?: string;
  userId?: string;
  /** manager_chain：沿提交人 manager_id 向上级数（1-10） */
  levels?: number;
  /** form_contact：人员控件 fieldKey（仅 custom_form:* 流程） */
  fieldKey?: string;
  /** initiator_choice 增强：选择范围（缺省=all 全员，兼容 v1） */
  scope?: FlowV2ChoiceScope;
}

export type FlowV2ApprovalType = "manual" | "auto_pass" | "auto_reject";

export interface FlowV2FieldPerm {
  read?: boolean;
  edit?: boolean;
  hidden?: boolean;
}

export interface FlowV2ApprovalNode {
  type: "approval";
  name: string;
  approvalType: FlowV2ApprovalType;
  approver: FlowV2ApproverRef;
  countersign: "any" | "all";
  sameAsInitiator: SameAsInitiator;
  ops: FlowNodeOps;
  /** 表单权限矩阵（arch/14 §9；edit 本期不落运行时=P2，设计器可存） */
  fieldPerms?: Record<string, FlowV2FieldPerm>;
}

export interface FlowV2ConditionExpr {
  field: string;
  op: string;
  value: unknown;
}

export interface FlowV2ConditionBranch {
  name: string;
  expr?: FlowV2ConditionExpr;
  nodes: FlowV2Node[];
}

export interface FlowV2ConditionNode {
  type: "condition";
  branches: FlowV2ConditionBranch[];
}

export interface FlowV2CcNode {
  type: "cc";
  name: string;
  receivers: FlowV2ApproverRef[];
}

export type FlowV2Node = FlowV2ApprovalNode | FlowV2ConditionNode | FlowV2CcNode;

export interface FlowV2Settings {
  allowWithdrawPending: boolean;
  dedupeApprover: "once" | "always";
  titleTemplate: string | null;
  summaryFieldKeys: string[];
}

export interface FlowV2Definition {
  schemaVersion: 2;
  settings: FlowV2Settings;
  nodes: FlowV2Node[];
  /** 提交时抄送（O-20-5-8：基础信息配置；→ ccEvent afterStepIndex=0 提交即触发） */
  submitCc?: FlowV2ApproverRef[];
  /** 完成抄送（→ ccEvent afterStepIndex=总步数，终审 approved 后触发，与 02b G5 同路） */
  endCc?: FlowV2ApproverRef[];
}

export interface CompiledStepV2 extends CompiledApproval {
  approvalType: FlowV2ApprovalType;
  sameAsInitiator: SameAsInitiator;
  ops: FlowNodeOps;
  fieldPerms?: Record<string, FlowV2FieldPerm>;
  /** manager_chain 展开后的级次（1=直属上级） */
  chainLevel?: number;
  /** initiator_choice 选择范围（提交时校验自选人在范围内） */
  choiceScope?: FlowV2ChoiceScope;
  /** form_contact 的字段 key（提交时从 form_snapshot 取人员） */
  fieldKey?: string;
}

/** 抄送事件：afterStepIndex=触发点（0=提交时；k=第 k 个审批步骤通过后） */
export interface CcEventV2 {
  nodeId: string;
  name: string;
  receivers: FlowV2ApproverRef[];
  afterStepIndex: number;
}

export interface CompileResultV2 {
  steps: CompiledStepV2[];
  ccEvents: CcEventV2[];
  settings: FlowV2Settings;
}

const ALL_APPROVER_KINDS = [...FLOW_APPROVER_KIND, ...FLOW_APPROVER_KIND_V2] as const;

export function isFlowV2Def(raw: unknown): raw is FlowV2Definition {
  return (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as { schemaVersion?: unknown }).schemaVersion === 2
  );
}

const LEGACY_OP: Record<string, string> = { ">=": "gte", "<=": "lte", "==": "eq", ">": "gt", "<": "lt", "!=": "ne" };

export interface ValidateV2Options {
  /** 自定义表单流程：条件字段允许 form.<fieldKey>（固定业务表单走 FLOW_CONDITION_FIELDS 白名单） */
  allowFormFields?: boolean;
  /** 自定义表单字段 key 集（提供时 form.<key> 须命中） */
  formFieldKeys?: string[];
}

export function validateFlowStructureV2(raw: unknown, opts: ValidateV2Options = {}): FlowV2Definition {
  const invalid = (msg: string, field = "definitionJson") =>
    new BusinessError(ERROR_CODE.VALIDATION_FAILED, `流程定义非法：${msg}`, { [field]: [msg] });

  if (!isFlowV2Def(raw)) throw invalid("schemaVersion 须为 2");
  const def = raw;
  if (!Array.isArray(def.nodes)) throw invalid("nodes 须为有序数组");

  const settings: FlowV2Settings = {
    allowWithdrawPending: def.settings?.allowWithdrawPending ?? true,
    dedupeApprover: def.settings?.dedupeApprover === "always" ? "always" : "once",
    titleTemplate: def.settings?.titleTemplate ?? null,
    summaryFieldKeys: Array.isArray(def.settings?.summaryFieldKeys)
      ? (def.settings!.summaryFieldKeys as string[])
      : [],
  };
  const normalized: FlowV2Definition = { schemaVersion: 2, settings, nodes: def.nodes };

  let totalNodes = 0;

  const validateOps = (nodeId: string, rawOps: unknown): FlowNodeOps => {
    const o = (rawOps ?? {}) as Partial<FlowNodeOps>;
    if (o.returnBack !== undefined && !["none", "prev", "initiator"].includes(o.returnBack)) {
      throw invalid(`节点 ${nodeId} 的 ops.returnBack 非法（none/prev/initiator）`);
    }
    return { ...FLOW_NODE_OPS_DEFAULTS, ...o, returnBack: o.returnBack ?? "none" };
  };

  const validateApprover = (nodeId: string, approver: unknown, forCc: boolean): FlowV2ApproverRef => {
    const a = approver as FlowV2ApproverRef;
    if (!a || typeof a !== "object" || !ALL_APPROVER_KINDS.includes(a.kind as never)) {
      throw invalid(`节点 ${nodeId} 的 approver.kind 非法：${(a as FlowV2ApproverRef | null)?.kind}`);
    }
    const kind = a.kind;
    if (kind === "role" && !a.role?.trim()) throw invalid(`节点 ${nodeId}（role）缺少 role`);
    if (kind === "user" && !a.userId) throw invalid(`节点 ${nodeId}（user）缺少 userId`);
    if (kind === "manager_chain") {
      const levels = a.levels;
      if (typeof levels !== "number" || !Number.isInteger(levels) || levels < 1 || levels > 10) {
        throw invalid(`节点 ${nodeId}（manager_chain）levels 须为 1-10 整数`);
      }
    }
    if (kind === "form_contact") {
      if (!opts.allowFormFields) throw invalid(`节点 ${nodeId}（form_contact）仅自定义表单流程可用`);
      if (!a.fieldKey?.trim()) throw invalid(`节点 ${nodeId}（form_contact）fieldKey 非空`);
      if (opts.formFieldKeys && !opts.formFieldKeys.includes(a.fieldKey)) {
        throw invalid(`节点 ${nodeId}（form_contact）fieldKey 不在表单字段集：${a.fieldKey}`);
      }
    }
    if (kind === "initiator_choice" && a.scope) {
      const s = a.scope;
      if (!["all", "roles", "users"].includes(s.mode)) throw invalid(`节点 ${nodeId} 选择范围 mode 非法`);
      if (s.mode === "roles" && (!Array.isArray(s.roleKeys) || s.roleKeys.length === 0)) {
        throw invalid(`节点 ${nodeId} 选择范围 roles 须给 roleKeys`);
      }
      if (s.mode === "users" && (!Array.isArray(s.userIds) || s.userIds.length === 0)) {
        throw invalid(`节点 ${nodeId} 选择范围 users 须给 userIds`);
      }
    }
    void forCc;
    return a;
  };

  const validateExpr = (nodeId: string, expr: FlowV2ConditionExpr): FlowV2ConditionExpr => {
    if (!expr || typeof expr !== "object") throw invalid(`条件节点 ${nodeId} 分支缺少 expr`);
    const field = expr.field;
    const isFormField = typeof field === "string" && field.startsWith("form.");
    if (isFormField) {
      if (!opts.allowFormFields) {
        throw invalid(`条件节点 ${nodeId} 字段须在白名单：${FLOW_CONDITION_FIELDS.join("/")}`);
      }
      const key = field.slice(5);
      if (!key.trim()) throw invalid(`条件节点 ${nodeId} form. 字段 key 为空`);
      if (opts.formFieldKeys && !opts.formFieldKeys.includes(key)) {
        throw invalid(`条件节点 ${nodeId} form 字段不在表单字段集：${key}`);
      }
    } else if (!FLOW_CONDITION_FIELDS.includes(field as never)) {
      throw invalid(`条件节点 ${nodeId} 字段须在白名单：${FLOW_CONDITION_FIELDS.join("/")}`);
    }
    const op = LEGACY_OP[expr.op] ?? expr.op;
    if (!isFormField) {
      const allowed: readonly string[] | undefined = V1_OP_BY_FIELD[field];
      if (!allowed || !allowed.includes(op)) {
        throw invalid(`条件节点 ${nodeId}（${field}）操作符 ${expr.op} 非法：该字段允许 ${(allowed ?? []).join("/")}`);
      }
    }
    const value = expr.value;
    const isConfigRef =
      value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as { $config?: unknown }).$config === "string";
    if (isConfigRef) {
      if (!(value as { $config: string }).$config.trim()) throw invalid(`条件节点 ${nodeId} 的 $config 键为空`);
    } else if (op === "between") {
      if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== "number")) {
        throw invalid(`条件节点 ${nodeId}（${field}）between 值须为 [下限, 上限] 数字二元组`);
      }
    } else if (op === "in") {
      if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string")) {
        throw invalid(`条件节点 ${nodeId}（${field}）in 值须为非空字符串数组`);
      }
    } else if (typeof value === "number" || field === "amount_cents") {
      if (typeof value !== "number") throw invalid(`条件节点 ${nodeId}（${field}）值须为数字`);
    } else if (typeof value !== "string" && typeof value !== "boolean") {
      throw invalid(`条件节点 ${nodeId}（${field}）值须为字符串/布尔`);
    }
    return { field, op, value };
  };

  const walk = (nodes: FlowV2Node[], depth: number, path: string): FlowV2Node[] => {
    if (depth > FLOW_V2_LIMITS.maxConditionDepth) {
      throw invalid(`条件嵌套深度超过 ${FLOW_V2_LIMITS.maxConditionDepth} 层`);
    }
    totalNodes += nodes.length;
    if (totalNodes > FLOW_V2_LIMITS.maxNodes) {
      throw invalid(`流程节点总数超过 ${FLOW_V2_LIMITS.maxNodes}`);
    }
    return nodes.map((node, i) => {
      const nodeId = `${path}n${i}`;
      if (!node || typeof node !== "object" || !FLOW_NODE_TYPE_V2.includes(node.type as never)) {
        throw invalid(`未知节点类型：${(node as FlowV2Node | null)?.type}（${nodeId}）`);
      }
      if (node.type === "approval") {
        if (!node.name?.trim()) throw invalid(`审批节点 ${nodeId} 名称必填`);
        if (!["manual", "auto_pass", "auto_reject"].includes(node.approvalType)) {
          throw invalid(`审批节点 ${nodeId} approvalType 非法`);
        }
        const countersign = node.countersign === "all" ? "all" : "any";
        const sameAsInitiator = SAME_AS_INITIATOR.includes(node.sameAsInitiator as never)
          ? node.sameAsInitiator
          : "skip";
        return {
          type: "approval",
          name: node.name.trim(),
          approvalType: node.approvalType,
          approver: validateApprover(nodeId, node.approver, false),
          countersign,
          sameAsInitiator,
          ops: validateOps(nodeId, node.ops),
          ...(node.fieldPerms ? { fieldPerms: node.fieldPerms } : {}),
        } as FlowV2ApprovalNode;
      }
      if (node.type === "cc") {
        if (!node.name?.trim()) throw invalid(`抄送节点 ${nodeId} 名称必填`);
        if (!Array.isArray(node.receivers) || node.receivers.length === 0) {
          throw invalid(`抄送节点 ${nodeId} receivers 非空`);
        }
        return {
          type: "cc",
          name: node.name.trim(),
          receivers: node.receivers.map((r, j) => validateApprover(`${nodeId}.r${j}`, r, true)),
        } as FlowV2CcNode;
      }
      // condition
      if (!Array.isArray(node.branches) || node.branches.length < 2) {
        throw invalid(`条件节点 ${nodeId} 分支数须 ≥2`);
      }
      const branches = node.branches.map((b, j) => {
        if (!b || typeof b !== "object") throw invalid(`条件节点 ${nodeId} 分支 ${j} 非法`);
        if (!b.name?.trim()) throw invalid(`条件节点 ${nodeId} 分支 ${j} 名称必填`);
        const isElse = b.expr === undefined || b.expr === null;
        if (isElse && j !== node.branches.length - 1) {
          throw invalid(`条件节点 ${nodeId} 的 else（缺省 expr）分支必须最后`);
        }
        if (!isElse && j === node.branches.length - 1 && node.branches.some((x, k) => (x.expr === undefined || x.expr === null) && k !== node.branches.length - 1)) {
          throw invalid(`条件节点 ${nodeId} 的 else 分支必须最后`);
        }
        return {
          name: b.name.trim(),
          ...(isElse ? {} : { expr: validateExpr(`${nodeId}.b${j}`, b.expr as FlowV2ConditionExpr) }),
          nodes: walk(b.nodes ?? [], depth + 1, `${nodeId}.b${j}.`),
        };
      });
      const elseCount = branches.filter((b) => b.expr === undefined).length;
      if (elseCount > 1) throw invalid(`条件节点 ${nodeId} else 分支至多一条`);
      return { type: "condition", branches } as FlowV2ConditionNode;
    });
  };

  normalized.nodes = walk(def.nodes, 1, "");
  if (totalNodes > FLOW_V2_LIMITS.maxNodes) throw invalid(`流程节点总数超过 ${FLOW_V2_LIMITS.maxNodes}`);
  // O-20-5-8：submitCc/endCc 按审批人策略校验（同 cc receivers 规则）
  const validateCcList = (key: "submitCc" | "endCc"): FlowV2ApproverRef[] => {
    const raw = (def as unknown as Record<string, unknown>)[key];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw invalid(`${key} 须为数组`);
    return raw.map((r, i) => validateApprover(`${key}.r${i}`, r, true));
  };
  normalized.submitCc = validateCcList("submitCc");
  normalized.endCc = validateCcList("endCc");
  return normalized;
}

/* ===== 编译 ===== */

function evalExpr(
  expr: FlowV2ConditionExpr,
  snapshot: Record<string, unknown>,
  resolveConfig?: (key: string) => unknown,
): boolean {
  const resolveExpected = (value: unknown): unknown => {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as { $config?: unknown }).$config === "string") {
      const resolved = resolveConfig?.((value as { $config: string }).$config);
      return resolved === undefined ? 5000000 : resolved;
    }
    return value;
  };
  const actual = snapshot[expr.field];
  const expected = resolveExpected(expr.value);
  const a = Number(actual);
  const numeric = Number.isFinite(a);
  switch (expr.op) {
    case "gte":
      return numeric && typeof expected === "number" && a >= expected;
    case "lte":
      return numeric && typeof expected === "number" && a <= expected;
    case "gt":
      return numeric && typeof expected === "number" && a > expected;
    case "lt":
      return numeric && typeof expected === "number" && a < expected;
    case "between": {
      if (!numeric || !Array.isArray(expected) || expected.length !== 2) return false;
      const [lo, hi] = expected.map(Number);
      return Number.isFinite(lo) && Number.isFinite(hi) && a >= lo && a <= hi;
    }
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "contains":
      return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    default:
      return false;
  }
}

/**
 * 编译 v2：顺序遍历；condition 按快照逐分支求值、第一命中进入（else 兜底）；
 * exploreBoth=true（发布校验）全分支展开；cc → ccEvents（不产步骤）；manager_chain 逐级展开为独立步骤。
 */
export function compileFlowV2(
  raw: unknown,
  formSnapshot: Record<string, unknown>,
  exploreBoth = false,
  resolveConfig?: (key: string) => unknown,
  opts: ValidateV2Options = {},
): CompileResultV2 {
  const def = validateFlowStructureV2(raw, opts);
  const steps: CompiledStepV2[] = [];
  const ccEvents: CcEventV2[] = [];
  const nodeIdCounter = { n: 0 };
  const nextNodeId = () => `v2n${nodeIdCounter.n++}`;

  const walk = (nodes: FlowV2Node[], trace: CompiledStepV2["conditionTrace"]): void => {
    for (const node of nodes) {
      if (node.type === "approval") {
        const nodeId = nextNodeId();
        const base = {
          nodeId,
          label: node.name,
          kind: node.approver.kind,
          role: node.approver.role ?? null,
          userId: node.approver.userId ?? null,
          countersign: node.countersign,
          conditionTrace: trace,
          approvalType: node.approvalType,
          sameAsInitiator: node.sameAsInitiator,
          ops: node.ops,
          ...(node.fieldPerms ? { fieldPerms: node.fieldPerms } : {}),
          ...(node.approver.scope ? { choiceScope: node.approver.scope } : {}),
          ...(node.approver.fieldKey ? { fieldKey: node.approver.fieldKey } : {}),
        };
        if (node.approver.kind === "manager_chain") {
          for (let level = 1; level <= (node.approver.levels ?? 1); level++) {
            steps.push({ ...base, chainLevel: level });
          }
        } else {
          steps.push(base);
        }
      } else if (node.type === "cc") {
        ccEvents.push({ nodeId: nextNodeId(), name: node.name, receivers: node.receivers, afterStepIndex: steps.length });
      } else {
        const nodeId = nextNodeId();
        let entered = false;
        for (let i = 0; i < node.branches.length; i++) {
          const branch = node.branches[i];
          const isElse = branch.expr === undefined;
          const result = isElse ? true : evalExpr(branch.expr!, formSnapshot, resolveConfig);
          if (!isElse) {
            trace.push({ nodeId, field: branch.expr!.field, op: branch.expr!.op, value: branch.expr!.value, result });
          }
          if (result && !entered) {
            entered = true;
            walk(branch.nodes, [...trace]);
            if (!exploreBoth) break;
          } else if (exploreBoth) {
            walk(branch.nodes, [...trace]);
          }
          if (!exploreBoth && entered) break;
        }
      }
    }
  };
  walk(def.nodes, []);
  // O-20-5-8：submitCc/endCc 编译为 ccEvent（复用 cc 通道：notify+emitEvent+审计+ccRecipients）
  if (def.submitCc && def.submitCc.length > 0) {
    ccEvents.push({ nodeId: "submitCc", name: "提交抄送", receivers: def.submitCc, afterStepIndex: 0 });
  }
  if (def.endCc && def.endCc.length > 0) {
    ccEvents.push({ nodeId: "endCc", name: "完成抄送", receivers: def.endCc, afterStepIndex: steps.length });
  }
  return { steps, ccEvents, settings: def.settings };
}

/** 双读分发：按 schemaVersion 分派 v1（validateFlowStructure 由调用点处理）/v2；供保存/发布校验统一入口 */
export function validateFlowStructureAny(raw: unknown, opts: ValidateV2Options = {}): { version: 1 | 2 } {
  if (isFlowV2Def(raw)) {
    validateFlowStructureV2(raw, opts);
    return { version: 2 };
  }
  return { version: 1 };
}
