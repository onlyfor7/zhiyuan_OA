/**
 * v1→v2 流程定义迁移纯函数（arch/14 §3/§12；迭代 20 工单 §6.1）。
 * v1：nodes+edges 自由图（start/end/approval/condition，condition 以 when true/false 双边出边表达分支）。
 * v2：竖向有序数组（schemaVersion=2），condition 为 branches[]（expr 缺省的最后一条=else）。
 * 无法机械迁移的形态不硬转——抛 FlowMigrateAnomaly，anomalies 列入脚本回执。
 */
import { FLOW_NODE_OPS_DEFAULTS, type FlowNodeOps, type SameAsInitiator } from "@lexflow/shared";

export interface FlowApproverRefV1 {
  kind: string;
  role?: string;
  userId?: string;
  levels?: number;
  fieldKey?: string;
}

export interface FlowV1Node {
  id: string;
  type: "start" | "end" | "approval" | "condition" | "cc";
  label?: string;
  approver?: FlowApproverRefV1;
  countersign?: string;
  expr?: Record<string, unknown>;
  receivers?: FlowApproverRefV1[];
}

export interface FlowV1Edge {
  from: string;
  to: string;
  when?: boolean;
}

export interface FlowV1Definition {
  nodes: FlowV1Node[];
  edges: FlowV1Edge[];
}

export interface FlowV2ApprovalNode {
  type: "approval";
  name: string;
  approvalType: "manual" | "auto_pass" | "auto_reject";
  approver: FlowApproverRefV1;
  countersign: string;
  sameAsInitiator: SameAsInitiator;
  ops: FlowNodeOps;
}

export interface FlowV2ConditionBranch {
  name: string;
  expr?: Record<string, unknown>;
  nodes: FlowV2Node[];
}

export interface FlowV2ConditionNode {
  type: "condition";
  branches: FlowV2ConditionBranch[];
}

export interface FlowV2CcNode {
  type: "cc";
  name: string;
  receivers: FlowApproverRefV1[];
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
}

export class FlowMigrateAnomaly extends Error {
  readonly anomalies: string[];
  constructor(anomalies: string[]) {
    super(`流程定义无法机械迁移 v1→v2：${anomalies.join("；")}`);
    this.name = "FlowMigrateAnomaly";
    this.anomalies = anomalies;
  }
}

const DEFAULT_SETTINGS: FlowV2Settings = {
  allowWithdrawPending: true,
  dedupeApprover: "once",
  titleTemplate: null,
  summaryFieldKeys: [],
};

export function migrateFlowV1toV2(def: FlowV1Definition): FlowV2Definition {
  const anomalies: string[] = [];
  const nodeById = new Map<string, FlowV1Node>();
  for (const node of def.nodes ?? []) {
    if (nodeById.has(node.id)) anomalies.push(`节点 id 重复：${node.id}`);
    nodeById.set(node.id, node);
  }
  const starts = (def.nodes ?? []).filter((n) => n.type === "start");
  const ends = (def.nodes ?? []).filter((n) => n.type === "end");
  if (starts.length !== 1) anomalies.push(`start 节点数=${starts.length}（须恰 1）`);
  if (ends.length < 1) anomalies.push("缺少 end 节点");

  // 环检测（DFS 三色标记）
  const color = new Map<string, number>();
  const visit = (id: string, trail: string[]): void => {
    const c = color.get(id) ?? 0;
    if (c === 1) {
      anomalies.push(`存在环：${[...trail, id].join("→")}`);
      return;
    }
    if (c === 2) return;
    color.set(id, 1);
    for (const e of (def.edges ?? []).filter((e) => e.from === id)) visit(e.to, [...trail, id]);
    color.set(id, 2);
  };
  if (starts[0]) visit(starts[0].id, []);

  // 出边结构校验
  for (const node of def.nodes ?? []) {
    const outs = (def.edges ?? []).filter((e) => e.from === node.id);
    if (node.type === "condition") {
      const hasTrue = outs.some((e) => e.when === true);
      const hasFalse = outs.some((e) => e.when === false);
      if (!hasTrue || !hasFalse) anomalies.push(`条件节点 ${node.id} 双边分支不齐（true=${hasTrue} false=${hasFalse}）`);
      if (outs.length !== 2) anomalies.push(`条件节点 ${node.id} 出边数=${outs.length}（须恰 2）`);
      if (!node.expr || typeof node.expr.field !== "string") anomalies.push(`条件节点 ${node.id} 缺少 expr.field`);
    } else if (node.type !== "end") {
      const plain = outs.filter((e) => e.when === undefined);
      if (plain.length !== 1) anomalies.push(`节点 ${node.id}（${node.type}）普通出边数=${plain.length}（须恰 1）`);
    }
  }

  // 可达性
  const reachable = new Set<string>();
  const bfs = (from: string): void => {
    const queue = [from];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const e of (def.edges ?? []).filter((e) => e.from === id)) queue.push(e.to);
    }
  };
  if (starts[0]) bfs(starts[0].id);
  for (const node of def.nodes ?? []) {
    if (!reachable.has(node.id)) anomalies.push(`节点 ${node.id} 不可达`);
  }

  if (anomalies.length > 0) throw new FlowMigrateAnomaly(anomalies);

  const inDegree = new Map<string, number>();
  for (const e of def.edges ?? []) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);

  const nextOf = (id: string): string | undefined =>
    (def.edges ?? []).find((e) => e.from === id && e.when === undefined)?.to;

  /** 两分支汇合点：从 a、b 分别 BFS 可达集，取交集中深度和最小者（end 恒可达） */
  const findJoin = (a: string, b: string): string => {
    const depth = (from: string): Map<string, number> => {
      const m = new Map<string, number>([[from, 0]]);
      const queue = [from];
      while (queue.length > 0) {
        const id = queue.shift()!;
        for (const e of (def.edges ?? []).filter((e) => e.from === id)) {
          if (!m.has(e.to)) {
            m.set(e.to, m.get(id)! + 1);
            queue.push(e.to);
          }
        }
      }
      return m;
    };
    const da = depth(a);
    const db = depth(b);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [id, depthA] of da) {
      const depthB = db.get(id);
      if (depthB === undefined) continue;
      const score = depthA + depthB;
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best ?? "end";
  };

  const convertApproval = (node: FlowV1Node): FlowV2ApprovalNode => ({
    type: "approval",
    name: node.label ?? "",
    approvalType: "manual",
    approver: node.approver ?? { kind: "role", role: "partner" },
    countersign: node.countersign ?? "any",
    sameAsInitiator: "skip",
    ops: { ...FLOW_NODE_OPS_DEFAULTS },
  });

  const convertCondition = (node: FlowV1Node): { v2: FlowV2ConditionNode; join: string } => {
    const trueEdge = (def.edges ?? []).find((e) => e.from === node.id && e.when === true)!;
    const falseEdge = (def.edges ?? []).find((e) => e.from === node.id && e.when === false)!;
    const join = findJoin(trueEdge.to, falseEdge.to);
    const trueSeq = buildSeq(trueEdge.to, new Set([join]));
    const falseSeq = buildSeq(falseEdge.to, new Set([join]));
    return {
      v2: {
        type: "condition",
        branches: [
          { name: node.label ?? "满足条件", expr: node.expr, nodes: trueSeq },
          { name: "其他情况", nodes: falseSeq },
        ],
      },
      join,
    };
  };

  /** 从 startId 起构建 v2 有序序列；遇 stop 集/end/多入度汇合点停止（汇合点归外层上下文） */
  function buildSeq(startId: string, stop: Set<string>): FlowV2Node[] {
    const seq: FlowV2Node[] = [];
    let cur: string | undefined = startId;
    const guard = new Set<string>();
    while (cur && cur !== "end" && !stop.has(cur)) {
      if (guard.has(cur)) throw new FlowMigrateAnomaly([`构建序列时遇环：${cur}`]);
      guard.add(cur);
      const node = nodeById.get(cur);
      if (!node) throw new FlowMigrateAnomaly([`节点缺失：${cur}`]);
      if ((inDegree.get(cur) ?? 0) > 1 && seq.length > 0) break; // 汇合点
      if (node.type === "approval") {
        seq.push(convertApproval(node));
        cur = nextOf(cur);
      } else if (node.type === "cc") {
        seq.push({ type: "cc", name: node.label ?? "抄送", receivers: node.receivers ?? [] });
        cur = nextOf(cur);
      } else if (node.type === "condition") {
        const { v2, join } = convertCondition(node);
        seq.push(v2);
        cur = join === "end" ? "end" : join;
        // join 节点若多入度（双分支汇入），由外层继续展开一次
        if (cur !== "end" && nodeById.has(cur)) {
          // 汇合点继续参与主序列
          continue;
        }
      } else if (node.type === "start") {
        cur = nextOf(cur);
      } else {
        break;
      }
    }
    return seq;
  }

  const nodes = buildSeq(starts[0].id, new Set());
  return { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS }, nodes };
}
