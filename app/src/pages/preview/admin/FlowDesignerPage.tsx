import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowRight, GitBranch, Rocket } from "lucide-react";

import { PreviewNote } from "../PreviewNote";
import {
  APPROVER_KIND_LABEL,
  CONDITION_FIELD_WHITELIST,
  FLOW_BIZ_BINDINGS,
  previewFlows,
  type ApproverKind,
  type FlowEdgeDef,
  type FlowNodeDef,
} from "../preview-data";
import { GLOBAL_ROLE_LABEL } from "../../../lib/labels";

/* —— 节点渲染（冻结四类：start/end/approval/condition，arch/09 §3.1） —— */

type FlowNodeData = { label: string; detail: string; def: FlowNodeDef };
type FlowNode = Node<FlowNodeData, "start" | "end" | "approval" | "condition">;

function BaseNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <div className={`flow-node node-${data.def.type} ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <strong>{data.label}</strong>
      <small>{data.detail}</small>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = {
  start: BaseNode,
  end: BaseNode,
  approval: BaseNode,
  condition: BaseNode,
};

function toFlowState(definition: { nodes: FlowNodeDef[]; edges: FlowEdgeDef[] }) {
  const ys: Record<string, number> = { start: 40, end: 40, approval: 0, condition: 0 };
  const nodes: FlowNode[] = definition.nodes.map((def, i) => ({
    id: def.id,
    type: def.type,
    position: { x: def.type === "start" ? 0 : def.type === "end" ? 640 : 220 + i * 40, y: def.type === "start" || def.type === "end" ? 120 : 20 + (i % 3) * 90 },
    data: { label: def.label, detail: nodeDetail(def), def },
  }));
  void ys;
  const edges: Edge[] = definition.edges.map((e, i) => ({
    id: `e-${i}`,
    source: e.from,
    target: e.to,
    label: e.when === undefined ? undefined : e.when ? "是" : "否",
    animated: false,
  }));
  return { nodes, edges };
}

function nodeDetail(def: FlowNodeDef): string {
  if (def.type === "approval") {
    const approver = def.approver;
    const who = approver
      ? approver.kind === "role"
        ? GLOBAL_ROLE_LABEL[approver.role ?? ""] ?? approver.role
        : approver.kind === "user"
          ? "指定用户"
          : APPROVER_KIND_LABEL[approver.kind]
      : "未设置";
    return `${who} · 会签 ${def.countersign === "all" ? "全员" : "任一"}`;
  }
  if (def.type === "condition" && def.expr) {
    return `${def.expr.field} ${def.expr.op} ${def.expr.value}`;
  }
  return "";
}

/** 服务端冻结校验的高保真呈现：环/悬空/start-end 唯一/条件双边/自审风险 */
function validate(defs: FlowNodeDef[], edges: FlowEdgeDef[]): string[] {
  const errors: string[] = [];
  const byId = new Map(defs.map((d) => [d.id, d]));
  const starts = defs.filter((d) => d.type === "start");
  const ends = defs.filter((d) => d.type === "end");
  if (starts.length !== 1) errors.push("start 节点必须恰好一个");
  if (ends.length !== 1) errors.push("end 节点必须恰好一个");
  // 环检测（DFS）
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  const visiting = new Set<string>();
  const done = new Set<string>();
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (done.has(id)) return false;
    visiting.add(id);
    for (const next of adj.get(id) ?? []) if (byId.has(next) && dfs(next)) return true;
    visiting.delete(id);
    done.add(id);
    return false;
  };
  for (const d of defs) if (!done.has(d.id) && dfs(d.id)) errors.push("存在环形路径（环检测未通过）");
  // 悬空：不可达 / 到不了 end
  if (starts.length === 1 && ends.length === 1) {
    const reach = new Set<string>();
    const walk = (id: string) => {
      if (reach.has(id)) return;
      reach.add(id);
      for (const next of adj.get(id) ?? []) walk(next);
    };
    walk(starts[0].id);
    for (const d of defs) if (!reach.has(d.id)) errors.push(`悬空节点：${d.label} 不可从 start 到达`);
    const reverse = new Map<string, string[]>();
    for (const e of edges) reverse.set(e.to, [...(reverse.get(e.to) ?? []), e.from]);
    const back = new Set<string>();
    const rwalk = (id: string) => {
      if (back.has(id)) return;
      back.add(id);
      for (const prev of reverse.get(id) ?? []) rwalk(prev);
    };
    rwalk(ends[0].id);
    for (const d of defs) if (!back.has(d.id)) errors.push(`悬空节点：${d.label} 无法到达 end`);
  }
  // 条件双边
  for (const d of defs.filter((x) => x.type === "condition")) {
    const outs = edges.filter((e) => e.from === d.id);
    const hasTrue = outs.some((e) => e.when === true);
    const hasFalse = outs.some((e) => e.when === false);
    if (!hasTrue || !hasFalse) errors.push(`条件节点「${d.label}」分支未双边齐备（是/否 各需一条出边）`);
    if (!d.expr || !d.expr.field) errors.push(`条件节点「${d.label}」缺少表达式`);
  }
  // 自审风险：审批人解析为空提示
  for (const d of defs.filter((x) => x.type === "approval")) {
    if (!d.approver) errors.push(`审批节点「${d.label}」未设置审批人（发布将阻断）`);
  }
  return [...new Set(errors)];
}

/** /preview/admin/flows/:id 审批流设计器（@xyflow/react 评估见交接记录） */
export default function FlowDesignerPage() {
  const { id } = useParams();
  const base = previewFlows.find((f) => f.id === id) ?? previewFlows[0];
  const initial = useMemo(() => toFlowState(base.definition), [base]);
  const [nodes, setNodes] = useState<FlowNode[]>(initial.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [published, setPublished] = useState(false);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    [],
  );
  const onConnect = useCallback(
    (conn: Connection) =>
      setEdges((es) =>
        addEdge(
          {
            ...conn,
            label: conn.sourceHandle === undefined && hasConditionSource(conn.source, es) ? "是" : undefined,
          },
          es,
        ),
      ),
    [],
  );
  void onEdgesChange;

  const addNode = (type: "approval" | "condition") => {
    const seq = nodes.length + 1;
    const def: FlowNodeDef =
      type === "approval"
        ? {
            id: `n${Date.now() % 10000}`,
            type: "approval",
            label: `审批节点 ${seq}`,
            approver: { kind: "project_manager" },
            countersign: "any",
          }
        : { id: `c${Date.now() % 10000}`, type: "condition", label: `条件 ${seq}`, expr: { field: "amount_cents", op: ">=", value: 5000000 } };
    const node: FlowNode = {
      id: def.id,
      type,
      position: { x: 240 + (seq % 3) * 60, y: 40 + (seq % 4) * 80 },
      data: { label: def.label, detail: nodeDetail(def), def },
    };
    setNodes((ns) => [...ns, node]);
    setSelectedId(def.id);
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const defs = nodes.map((n) => n.data.def);
  const edgeDefs: FlowEdgeDef[] = edges.map((e) => ({
    from: e.source,
    to: e.target,
    when: e.label === "是" ? true : e.label === "否" ? false : undefined,
  }));
  const errors = validate(defs, edgeDefs);

  const patchSelected = (patch: Partial<FlowNodeDef>) => {
    if (!selected) return;
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== selected.id) return n;
        const def = { ...n.data.def, ...patch };
        return { ...n, data: { label: patch.label ?? n.data.label, detail: nodeDetail(def), def } };
      }),
    );
  };

  const publish = () => {
    if (errors.length > 0) return;
    setPublished(true);
  };

  return (
    <div className="screen preview-screen designer-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">FLOW DESIGNER</span>
          <h1>
            <GitBranch size={20} style={{ verticalAlign: "-3px" }} /> {base.name}
            <span className="badge badge-health-normal">V{base.versionNo}</span>
          </h1>
          <p>
            绑定业务：{FLOW_BIZ_BINDINGS.find(([v]) => v === base.bizBinding)?.[1] ?? base.bizBinding} ·
            输出编译为既有引擎步骤（条件在提交时按表单快照求值）。
          </p>
        </div>
        <div className="title-actions">
          <Link to="/preview/admin" className="secondary-action">
            返回列表
          </Link>
          <button className="primary-action" disabled={errors.length > 0} onClick={publish} title={errors.length > 0 ? "存在校验错误，不可发布" : ""}>
            <Rocket size={15} />
            发布流程
          </button>
        </div>
      </div>
      <div className="designer-layout">
        <aside className="designer-palette">
          <span className="section-label">节点面板</span>
          <button className="palette-node" onClick={() => addNode("approval")}>
            <strong>＋ 审批节点</strong>
            <small>审批人（角色/用户/上级/负责人）+ 会签</small>
          </button>
          <button className="palette-node condition" onClick={() => addNode("condition")}>
            <strong>＋ 条件节点</strong>
            <small>字段白名单表达式 · 是/否 双边分支</small>
          </button>
          <PreviewNote>从左侧点击添加节点；拖拽移动；从节点右侧圆点拉线连接；选中节点可在右侧面板编辑。</PreviewNote>
        </aside>
        <div className="designer-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            fitView
            colorMode="light"
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside className="designer-props">
          <span className="section-label">属性面板</span>
          {selected ? (
            <div className="props-form">
              <label className="form-field">
                <span>节点名称 *</span>
                <input
                  value={selected.data.def.label}
                  onChange={(e) => patchSelected({ label: e.target.value })}
                />
              </label>
              {selected.data.def.type === "approval" ? (
                <>
                  <label className="form-field">
                    <span>审批人来源</span>
                    <select
                      value={selected.data.def.approver?.kind ?? "project_manager"}
                      onChange={(e) => {
                        const kind = e.target.value as ApproverKind;
                        patchSelected({
                          approver:
                            kind === "role"
                              ? { kind, role: "partner" }
                              : kind === "user"
                                ? { kind, userId: "" }
                                : { kind },
                        });
                      }}
                    >
                      {Object.entries(APPROVER_KIND_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selected.data.def.approver?.kind === "role" ? (
                    <label className="form-field">
                      <span>角色</span>
                      <select
                        value={selected.data.def.approver.role ?? "partner"}
                        onChange={(e) =>
                          patchSelected({ approver: { kind: "role", role: e.target.value } })
                        }
                      >
                        {Object.entries(GLOBAL_ROLE_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {selected.data.def.approver?.kind === "user" ? (
                    <label className="form-field">
                      <span>指定用户</span>
                      <input
                        placeholder="用户 ID（示意）"
                        value={selected.data.def.approver.userId ?? ""}
                        onChange={(e) =>
                          patchSelected({ approver: { kind: "user", userId: e.target.value } })
                        }
                      />
                    </label>
                  ) : null}
                  <label className="form-field">
                    <span>会签规则</span>
                    <select
                      value={selected.data.def.countersign ?? "any"}
                      onChange={(e) => patchSelected({ countersign: e.target.value as "any" | "all" })}
                    >
                      <option value="any">任一通过</option>
                      <option value="all">全员会签</option>
                    </select>
                  </label>
                </>
              ) : null}
              {selected.data.def.type === "condition" ? (
                <>
                  <label className="form-field">
                    <span>条件字段（白名单）</span>
                    <select
                      value={selected.data.def.expr?.field ?? "amount_cents"}
                      onChange={(e) =>
                        patchSelected({
                          expr: {
                            field: e.target.value,
                            op: selected.data.def.expr?.op ?? ">=",
                            value: selected.data.def.expr?.value ?? 0,
                          },
                        })
                      }
                    >
                      {CONDITION_FIELD_WHITELIST.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="owner-line">
                    <label className="form-field">
                      <span>比较符</span>
                      <select
                        value={selected.data.def.expr?.op ?? ">="}
                        onChange={(e) =>
                          patchSelected({
                            expr: {
                              field: selected.data.def.expr?.field ?? "amount_cents",
                              op: e.target.value,
                              value: selected.data.def.expr?.value ?? 0,
                            },
                          })
                        }
                      >
                        {[">=", ">", "=", "<", "<="].map((op) => (
                          <option key={op}>{op}</option>
                        ))}
                      </select>
                    </label>
                    <label className="form-field">
                      <span>阈值</span>
                      <input
                        type="number"
                        value={Number(selected.data.def.expr?.value ?? 0)}
                        onChange={(e) =>
                          patchSelected({
                            expr: {
                              field: selected.data.def.expr?.field ?? "amount_cents",
                              op: selected.data.def.expr?.op ?? ">=",
                              value: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                  <PreviewNote>条件出边需「是/否」双边齐备（连线标签在连线上标记）。</PreviewNote>
                </>
              ) : null}
              {selected.data.def.type === "start" || selected.data.def.type === "end" ? (
                <PreviewNote>start/end 为固定节点，不可增删（唯一性由校验保证）。</PreviewNote>
              ) : null}
            </div>
          ) : (
            <PreviewNote>选中画布节点以编辑属性。</PreviewNote>
          )}
          <div className="validation-panel">
            <span className="section-label">校验（保存时服务端强制）</span>
            {errors.length === 0 ? (
              <p className="check-line pass">
                <ArrowRight size={14} />
                <strong>校验通过</strong>
                <small>环/悬空/条件双边/自审检查均通过</small>
              </p>
            ) : (
              errors.map((err) => (
                <p className="check-line fail" key={err} role="alert">
                  <span aria-hidden="true">✕</span>
                  <strong>未通过</strong>
                  <small>{err}</small>
                </p>
              ))
            )}
            {published ? (
              <PreviewNote>已校验通过：原型预览不执行真实发布（发布将走 publish 接口+幂等键）。</PreviewNote>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

function hasConditionSource(source: string, edges: Edge[]): boolean {
  return edges.some((e) => e.source === source);
}
