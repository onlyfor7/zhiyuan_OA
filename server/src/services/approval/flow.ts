import { and, desc, eq } from "drizzle-orm";

import { ERROR_CODE, FLOW_APPROVER_KIND, FLOW_CONDITION_FIELDS, FLOW_NODE_TYPE } from "@lexflow/shared";

import { flowDefinitions } from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import type { DbOrTx } from "../../trpc/context";

/**
 * 流程编译器（arch/09 §3.1）：flow_definitions（enabled）→ 条件按表单快照求值
 * → 展开为引擎步骤；policy_snapshot 存流程版本+解析步骤。既有 approval_policies
 * 为无自定义流程时的回退（E4 零回归）。设计器校验：结构问题 FLOW_INVALID(400)，
 * 发布语义问题 FLOW_UNPUBLISHABLE(412)。
 */

export interface FlowNode {
  id: string;
  type: (typeof FLOW_NODE_TYPE)[number];
  label?: string;
  approver?: { kind: (typeof FLOW_APPROVER_KIND)[number]; role?: string; userId?: string };
  countersign?: "any" | "all";
  expr?: { field: string; op: string; value: unknown };
}

export interface FlowEdge {
  from: string;
  to: string;
  when?: boolean;
}

export interface FlowDefinition {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const OPS = [">=", "<=", ">", "<", "==", "!="] as const;

function asDefinition(raw: unknown): FlowDefinition {
  const def = raw as FlowDefinition;
  if (!def || !Array.isArray(def.nodes) || !Array.isArray(def.edges)) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "definition_json 须含 nodes[] 与 edges[]", {
      definitionJson: ["definition_json 须含 nodes[] 与 edges[]"],
    });
  }
  return def;
}

/* ===== 设计器校验（保存时 FLOW_INVALID；发布时 FLOW_UNPUBLISHABLE） ===== */

export function validateFlowStructure(raw: unknown): FlowDefinition {
  const def = asDefinition(raw);
  const invalid = (msg: string, field = "definitionJson") =>
    new BusinessError(ERROR_CODE.VALIDATION_FAILED, `流程定义非法：${msg}`, { [field]: [msg] });

  const ids = new Set<string>();
  for (const node of def.nodes) {
    if (!node.id || ids.has(node.id)) throw invalid(`节点 id 缺失或重复：${node.id}`);
    ids.add(node.id);
    if (!FLOW_NODE_TYPE.includes(node.type)) throw invalid(`未知节点类型：${node.type}`);
    if (node.type === "approval") {
      const kind = node.approver?.kind;
      if (!kind || !FLOW_APPROVER_KIND.includes(kind)) throw invalid(`审批节点 ${node.id} 的 approver.kind 非法`);
      if (kind === "role" && !node.approver?.role) throw invalid(`审批节点 ${node.id} 缺少 role`);
      if (kind === "user" && !node.approver?.userId) throw invalid(`审批节点 ${node.id} 缺少 userId`);
    }
    if (node.type === "condition") {
      const expr = node.expr;
      if (!expr || !FLOW_CONDITION_FIELDS.includes(expr.field as never)) {
        throw invalid(`条件节点 ${node.id} 字段须在白名单：${FLOW_CONDITION_FIELDS.join("/")}`);
      }
      if (!OPS.includes(expr.op as never)) throw invalid(`条件节点 ${node.id} 操作符非法：${expr.op}`);
    }
  }
  const starts = def.nodes.filter((n) => n.type === "start");
  const ends = def.nodes.filter((n) => n.type === "end");
  if (starts.length !== 1) throw invalid("start 节点必须恰好一个");
  if (ends.length !== 1) throw invalid("end 节点必须恰好一个");

  for (const edge of def.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw invalid(`边引用未知节点：${edge.from}→${edge.to}`);
    const fromNode = def.nodes.find((n) => n.id === edge.from)!;
    const toNode = def.nodes.find((n) => n.id === edge.to)!;
    if (fromNode.type === "end") throw invalid("end 节点不能有出边");
    if (toNode.type === "start") throw invalid("start 不能有入边");
    if (fromNode.type === "condition") {
      if (typeof edge.when !== "boolean") throw invalid(`条件节点 ${edge.from} 的出边必须显式 when:true/false`);
    } else if (edge.when !== undefined) {
      throw invalid(`非条件节点 ${edge.from} 的出边不得携带 when`);
    }
  }
  // 条件双边齐备
  for (const node of def.nodes.filter((n) => n.type === "condition")) {
    const outs = def.edges.filter((e) => e.from === node.id);
    if (!outs.some((e) => e.when === true) || !outs.some((e) => e.when === false)) {
      throw invalid(`条件节点 ${node.id} 分支须双边齐备（when:true 与 when:false）`);
    }
  }
  // 环检测（DFS 三色）
  const adjacency = new Map<string, string[]>();
  for (const e of def.edges) {
    adjacency.set(e.from, [...(adjacency.get(e.from) ?? []), e.to]);
  }
  const color = new Map<string, 0 | 1 | 2>();
  const dfs = (id: string): void => {
    color.set(id, 1);
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) throw invalid("流程存在环");
      if (c === 0) dfs(next);
    }
    color.set(id, 2);
  };
  dfs(starts[0].id);
  // 悬空：不可达 from start 或到不了 end
  const reachable = new Set<string>();
  const walk = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const next of adjacency.get(id) ?? []) walk(next);
  };
  walk(starts[0].id);
  for (const node of def.nodes) {
    if (!reachable.has(node.id)) throw invalid(`悬空节点（start 不可达）：${node.id}`);
  }
  const canReachEnd = (id: string, seen = new Set<string>()): boolean => {
    if (id === ends[0].id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (adjacency.get(id) ?? []).some((next) => canReachEnd(next, seen));
  };
  for (const node of def.nodes) {
    if (node.type !== "end" && !canReachEnd(node.id)) throw invalid(`悬空节点（到不了 end）：${node.id}`);
  }
  return def;
}

/* ===== 条件求值与编译 ===== */

function evalCondition(expr: FlowNode["expr"], snapshot: Record<string, unknown>): boolean {
  if (!expr) return false;
  const actual = snapshot[expr.field];
  const expected = expr.value;
  if (typeof expected === "number") {
    const a = Number(actual);
    if (!Number.isFinite(a)) return false;
    switch (expr.op) {
      case ">=": return a >= expected;
      case "<=": return a <= expected;
      case ">": return a > expected;
      case "<": return a < expected;
      case "==": return a === expected;
      case "!=": return a !== expected;
      default: return false;
    }
  }
  switch (expr.op) {
    case "==": return actual === expected;
    case "!=": return actual !== expected;
    default: return false;
  }
}

export interface CompiledApproval {
  nodeId: string;
  label: string;
  kind: string;
  role: string | null;
  userId: string | null;
  countersign: "any" | "all";
  conditionTrace: Array<{ nodeId: string; field: string; op: string; value: unknown; result: boolean }>;
}

export interface CompileResult {
  steps: CompiledApproval[];
}

/**
 * 编译：从 start 沿边推进；条件节点按表单快照求值选 when 分支；
 * exploreBoth=true（发布校验）时对条件取双分支收集全部可达审批节点。
 */
export function compileFlow(
  raw: unknown,
  formSnapshot: Record<string, unknown>,
  exploreBoth = false,
): CompileResult {
  const def = validateFlowStructure(raw);
  const nodeById = new Map(def.nodes.map((n) => [n.id, n]));
  const start = def.nodes.find((n) => n.type === "start")!;
  const steps: CompiledApproval[] = [];
  const traceByNode = new Map<string, CompiledApproval["conditionTrace"]>();
  const visited = new Set<string>();

  const visit = (nodeId: string, trace: CompiledApproval["conditionTrace"]): void => {
    if (visited.has(`${nodeId}:${JSON.stringify(trace)}`)) return;
    const node = nodeById.get(nodeId)!;
    if (node.type === "end") return;
    if (node.type === "approval") {
      steps.push({
        nodeId: node.id,
        label: node.label ?? node.id,
        kind: node.approver!.kind,
        role: node.approver!.role ?? null,
        userId: node.approver!.userId ?? null,
        countersign: node.countersign ?? "any",
        conditionTrace: trace,
      });
      traceByNode.set(node.id, trace);
    }
    const outs = def.edges.filter((e) => e.from === nodeId);
    if (node.type === "condition") {
      const result = evalCondition(node.expr, formSnapshot);
      const nextTrace = [
        ...trace,
        { nodeId: node.id, field: node.expr!.field, op: node.expr!.op, value: node.expr!.value, result },
      ];
      for (const edge of outs) {
        if (edge.when === result || exploreBoth) visit(edge.to, nextTrace);
      }
      return;
    }
    for (const edge of outs) visit(edge.to, trace);
  };
  visit(start.id, []);
  void traceByNode;
  return { steps };
}

/* ===== 流程定义查询 ===== */

export async function findEnabledFlow(
  db: DbOrTx,
  bizType: string,
  _projectId: string | null,
): Promise<{ id: string; name: string; versionNo: number; definitionJson: Record<string, unknown>; scope: string } | null> {
  // 注：flow_definitions 无 project_id 绑定列（数据棒 0007 未含），project scope 暂无法绑定到具体项目——
  // 登记偏差待裁定；当前 enabled 流程一律按 global 生效（同 biz_binding 仅一条 enabled，索引保证）。
  void _projectId;
  const rows = await db
    .select()
    .from(flowDefinitions)
    .where(and(eq(flowDefinitions.bizBinding, bizType), eq(flowDefinitions.enabled, true)))
    .orderBy(desc(flowDefinitions.versionNo))
    .limit(1);
  return rows[0] ?? null;
}

/** 发布前语义校验：全部可达审批节点可解析（角色零活跃用户 → FLOW_UNPUBLISHABLE） */
export async function assertFlowPublishable(
  db: DbOrTx,
  raw: unknown,
  resolveKind: (kind: string, role: string | null, userId: string | null) => Promise<string[]>,
): Promise<void> {
  void db;
  let def: FlowDefinition;
  try {
    def = validateFlowStructure(raw);
  } catch (error) {
    if (error instanceof BusinessError) {
      throw new BusinessError(ERROR_CODE.FLOW_UNPUBLISHABLE, `流程不可发布：${error.message}`);
    }
    throw error;
  }
  const compiled = compileFlow(def, {}, true);
  for (const step of compiled.steps) {
    const candidates = await resolveKind(step.kind, step.role, step.userId);
    if (candidates.length === 0) {
      throw new BusinessError(
        ERROR_CODE.FLOW_UNPUBLISHABLE,
        `流程不可发布：节点「${step.label}」审批人解析为空（角色零活跃用户或无对应人员）`,
      );
    }
  }
}
