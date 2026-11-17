import type { CustomFormSchema, FlowApproverRef, FlowNodeOps, FormFieldDef, SameAsInitiator } from "@lexflow/shared";
import { FLOW_NODE_OPS_DEFAULTS } from "@lexflow/shared";

/**
 * 流程定义 v2 前端模型与构造器（arch/14 §3）：竖向序列表（有序数组即流程序）。
 * 提交/结束为首尾固定语义节点，不进 nodes；条件分支横向列渲染，else 恒最后。
 */

export interface V2Expr {
  field: string;
  op: string;
  value: unknown;
}

export interface V2ApprovalNode {
  type: "approval";
  id: string;
  name: string;
  approvalType: "manual" | "auto_pass" | "auto_reject";
  approver: FlowApproverRef;
  countersign: "any" | "all";
  sameAsInitiator: SameAsInitiator;
  ops: FlowNodeOps;
  /** 节点×字段 {read|hidden}（自定义表单=全字段；固定业务表单=白名单字段） */
  fieldPerms?: Record<string, "read" | "hidden">;
}

export interface V2CcNode {
  type: "cc";
  id: string;
  name: string;
  receivers: FlowApproverRef[];
}

export interface V2Branch {
  name: string;
  expr: V2Expr | null;
  nodes: V2Node[];
}

export interface V2ConditionNode {
  type: "condition";
  id: string;
  branches: V2Branch[];
}

export type V2Node = V2ApprovalNode | V2CcNode | V2ConditionNode;

export interface V2Settings {
  allowWithdrawPending: boolean;
  dedupeApprover: "once" | "always";
  titleTemplate: string | null;
  summaryFieldKeys: string[];
}

export interface V2Def {
  schemaVersion: 2;
  settings: V2Settings;
  nodes: V2Node[];
  /** 提交时抄送（基础信息配置） */
  submitCc: FlowApproverRef[];
  /** 结束抄送（结束卡配置） */
  endCc: FlowApproverRef[];
}

let seq = 0;
export function v2Id(): string {
  seq += 1;
  return `n${Date.now().toString(36)}${seq.toString(36)}`;
}

export const defaultApproval = (): V2ApprovalNode => ({
  type: "approval",
  id: v2Id(),
  name: "审批",
  approvalType: "manual",
  approver: { kind: "initiator_manager" },
  countersign: "any",
  sameAsInitiator: "skip",
  ops: { ...FLOW_NODE_OPS_DEFAULTS },
});

export const defaultCc = (): V2CcNode => ({
  type: "cc",
  id: v2Id(),
  name: "抄送",
  receivers: [{ kind: "role", role: "sysadmin" }],
});

export const defaultCondition = (): V2ConditionNode => ({
  type: "condition",
  id: v2Id(),
  branches: [
    { name: "分支 1", expr: null, nodes: [] },
    { name: "其他情况", expr: null, nodes: [] },
  ],
});

export const defaultV2Def = (): V2Def => ({
  schemaVersion: 2,
  settings: { allowWithdrawPending: true, dedupeApprover: "once", titleTemplate: null, summaryFieldKeys: [] },
  nodes: [defaultApproval()],
  submitCc: [],
  endCc: [],
});

/** v1 定义（旧数据/项目流兜底）判定：非对象或无 schemaVersion=2 */
export function isV2Def(d: unknown): d is V2Def {
  return typeof d === "object" && d !== null && (d as { schemaVersion?: number }).schemaVersion === 2;
}

export function countNodes(nodes: V2Node[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1;
    if (node.type === "condition") {
      for (const b of node.branches) n += countNodes(b.nodes);
    }
  }
  return n;
}

export function conditionDepth(nodes: V2Node[], depth = 0): number {
  let max = depth;
  for (const node of nodes) {
    if (node.type === "condition") {
      max = Math.max(max, depth + 1);
      for (const b of node.branches) max = Math.max(max, conditionDepth(b.nodes, depth + 1));
    }
  }
  return max;
}

/** 节点摘要（卡面副标题） */
export function approverSummary(ref: FlowApproverRef, roleLabel?: (k: string) => string): string {
  switch (ref.kind) {
    case "role": return `角色：${roleLabel?.(ref.role ?? "") ?? (ref.role || "—")}`;
    case "user": return "指定成员";
    case "initiator_manager": return "提交人直属上级";
    case "project_manager": return "项目负责人";
    case "initiator_choice": return "提交人自选（全员）";
    case "initiator_self": return "提交人本人";
    case "dept_head": return "提交人部门负责人";
    case "manager_chain": return `连续 ${ref.levels ?? 1} 级上级`;
    case "form_contact": return `表单联系人（${ref.fieldKey || "未选字段"}）`;
    default: return ref.kind;
  }
}

export function exprSummary(expr: V2Expr | null): string {
  if (!expr) return "其他情况";
  return `${expr.field} ${expr.op} ${JSON.stringify(expr.value)}`;
}

/** 客户端结构预检（服务端 validateFlowStructureV2 前置；返回字段级错误 map） */
export function validateV2(def: V2Def, formFields: FormFieldDef[]): Record<string, string> {
  const errs: Record<string, string> = {};
  if (countNodes(def.nodes) > 100) errs.__root = "节点总数超过 100 上限";
  if (conditionDepth(def.nodes) > 3) errs.__root = "条件分支嵌套超过 3 层";
  const walk = (nodes: V2Node[], path: string) => {
    nodes.forEach((node, i) => {
      const p = `${path}.${i}`;
      if (node.type === "approval") {
        if (!node.name.trim()) errs[`${p}.name`] = "节点名称必填";
        if (node.approvalType === "manual") {
          if (!node.approver?.kind) errs[`${p}.approver`] = "请选择审批人策略";
          if (node.approver.kind === "manager_chain" && (!node.approver.levels || node.approver.levels < 1 || node.approver.levels > 10))
            errs[`${p}.approver`] = "级数须 1-10";
          if (node.approver.kind === "form_contact" && (!node.approver.fieldKey || !formFields.some((f) => f.key === node.approver.fieldKey && f.control === "person")))
            errs[`${p}.approver`] = "请选择人员控件字段";
          if (node.approver.kind === "user" && !node.approver.userId) errs[`${p}.approver`] = "请选择成员";
          if (node.approver.kind === "role" && !node.approver.role) errs[`${p}.approver`] = "请选择角色";
        }
      }
      if (node.type === "cc") {
        if (!node.receivers.length) errs[`${p}.receivers`] = "抄送接收人必填";
      }
      if (node.type === "condition") {
        if (node.branches.length < 2) errs[`${p}.branches`] = "条件分支至少 2 条";
        const elseIdx = node.branches.findIndex((b) => b.expr === null);
        if (elseIdx !== node.branches.length - 1) errs[`${p}.branches`] = "「其他情况」分支必须位于最后";
        node.branches.forEach((b, bi) => {
          if (b.expr === null && bi !== node.branches.length - 1) errs[`${p}.branches`] = "仅最后一条可为「其他情况」";
          if (!b.name.trim()) errs[`${p}.branches.${bi}.name`] = "分支名必填";
          if (b.expr !== null && (!b.expr.field || !b.expr.op)) errs[`${p}.branches.${bi}.expr`] = "条件表达式不完整";
          walk(b.nodes, `${p}.branches.${bi}`);
        });
      }
    });
  };
  walk(def.nodes, "nodes");
  return errs;
}

/** 不可变更新：按 id 定位并替换节点（含递归分支） */
export function updateNodeById(nodes: V2Node[], id: string, patch: (n: V2Node) => V2Node): V2Node[] {
  return nodes.map((n) => {
    if (n.id === id) return patch(n);
    if (n.type === "condition") {
      return { ...n, branches: n.branches.map((b) => ({ ...b, nodes: updateNodeById(b.nodes, id, patch) })) };
    }
    return n;
  });
}

export function removeNodeById(nodes: V2Node[], id: string): V2Node[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => (n.type === "condition" ? { ...n, branches: n.branches.map((b) => ({ ...b, nodes: removeNodeById(b.nodes, id) })) } : n));
}

export function insertAt(nodes: V2Node[], index: number, node: V2Node): V2Node[] {
  return [...nodes.slice(0, index), node, ...nodes.slice(index)];
}

/** 序列化前剔除运行时辅助字段（保持定义干净） */
export function serializeDef(def: V2Def): Record<string, unknown> {
  return JSON.parse(JSON.stringify(def)) as Record<string, unknown>;
}

export type { CustomFormSchema, FormFieldDef };
