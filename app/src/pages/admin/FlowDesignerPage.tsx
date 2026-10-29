import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
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
import { GitBranch, History, Rocket } from "lucide-react";

import {
  useFlow,
  useFlowList,
  useFlowMutations,
  useFlowValidate,
  useFlowVersions,
  type FlowDefinitionInput,
} from "../../api/flow";
import { businessCodeOf, type RouterOutputs } from "../../lib/trpc";
import { newIdempotencyKey, rootErrorMessage } from "../../lib/form";
import {
  APPROVER_KIND_LABEL,
  CONDITION_FIELD_WHITELIST,
  FLOW_BIZ_BINDINGS,
  GLOBAL_ROLE_LABEL,
} from "../../lib/labels";

/* —— definition_json 冻结结构（arch/09 §3.1） —— */
interface DesignerNode {
  id: string;
  type: "start" | "end" | "approval" | "condition";
  label: string;
  approver?: { kind: "role" | "user" | "initiator_manager" | "project_manager"; role?: string; userId?: string };
  countersign?: "any" | "all";
  expr?: { field: string; op: string; value: number | string };
}
interface DesignerEdge {
  from: string;
  to: string;
  when?: boolean;
}

type FlowNodeData = { label: string; detail: string; def: DesignerNode };
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
const nodeTypes = { start: BaseNode, end: BaseNode, approval: BaseNode, condition: BaseNode };

function nodeDetail(def: DesignerNode): string {
  if (def.type === "approval") {
    const a = def.approver;
    const who = a
      ? a.kind === "role"
        ? GLOBAL_ROLE_LABEL[a.role ?? ""] ?? a.role ?? "—"
        : a.kind === "user"
          ? "指定用户"
          : APPROVER_KIND_LABEL[a.kind]
      : "未设置";
    return `${who} · 会签 ${def.countersign === "all" ? "全员" : "任一"}`;
  }
  if (def.type === "condition" && def.expr) return `${def.expr.field} ${def.expr.op} ${def.expr.value}`;
  return "";
}

function toDesigner(definition: unknown): { nodes: DesignerNode[]; edges: DesignerEdge[] } {
  const def = (definition ?? { nodes: [], edges: [] }) as { nodes: DesignerNode[]; edges: DesignerEdge[] };
  return { nodes: def.nodes ?? [], edges: def.edges ?? [] };
}

function toFlowState(designer: { nodes: DesignerNode[]; edges: DesignerEdge[] }) {
  const nodes: FlowNode[] = designer.nodes.map((def, i) => ({
    id: def.id,
    type: def.type,
    position:
      def.type === "start"
        ? { x: 0, y: 120 }
        : def.type === "end"
          ? { x: 640, y: 120 }
          : { x: 220 + (i % 3) * 40, y: 20 + (i % 3) * 90 },
    data: { label: def.label, detail: nodeDetail(def), def },
  }));
  const edges: Edge[] = designer.edges.map((e, i) => ({
    id: `e-${i}`,
    source: e.from,
    target: e.to,
    label: e.when === undefined ? undefined : e.when ? "是" : "否",
  }));
  return { nodes, edges };
}

function fromFlowState(nodes: FlowNode[], edges: Edge[]): FlowDefinitionInput {
  return {
    nodes: nodes.map((n) => n.data.def),
    edges: edges.map((e) => ({
      from: e.source,
      to: e.target,
      when: e.label === "是" ? true : e.label === "否" ? false : undefined,
    })),
  } as FlowDefinitionInput;
}

type FlowRow = RouterOutputs["flow"]["getById"];

/** /admin/flows/:id 审批流设计器（真实 flow.*；保存=草稿 updateDraft，发布=publish 服务端强校验） */
export default function FlowDesignerPage() {
  const { flowId } = useParams();
  const isNew = flowId === "new";
  const flow = useFlow(isNew ? null : (flowId ?? null));
  const flows = useFlowList();

  if (!isNew && flow.isPending) return <p className="list-note">正在加载流程…</p>;
  if (!isNew && flow.isError) throw flow.error;
  if (isNew && flows.isError) throw flows.error;

  return <DesignerEditor key={flow.data?.id ?? "new"} isNew={isNew} flow={flow.data ?? null} />;
}

function initialCanvas(isNew: boolean, flow: FlowRow | null) {
  if (isNew || !flow) {
    // 合法最小骨架（服务端结构校验要求 start 可达 end）：start → 审批(partner) → end
    const start: DesignerNode = { id: "start", type: "start", label: "发起" };
    const approval: DesignerNode = { id: "n1", type: "approval", label: "审批节点 1", approver: { kind: "role", role: "partner" }, countersign: "any" };
    const end: DesignerNode = { id: "end", type: "end", label: "完成" };
    return toFlowState({
      nodes: [start, approval, end],
      edges: [
        { from: "start", to: "n1" },
        { from: "n1", to: "end" },
      ],
    });
  }
  return toFlowState(toDesigner(flow.definitionJson));
}

function DesignerEditor({ isNew, flow }: { isNew: boolean; flow: FlowRow | null }) {
  const navigate = useNavigate();
  const mutations = useFlowMutations();
  const validate = useFlowValidate();
  const [initial] = useState(() => initialCanvas(isNew, flow));
  const [nodes, setNodes] = useState<FlowNode[]>(initial.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [draftMeta, setDraftMeta] = useState({ name: "", scope: "global" as "global" | "project", bizBinding: "generic_request" });

  const versions = useFlowVersions(versionsOpen ? (flow?.name ?? null) : null);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    [],
  );
  const onConnect = useCallback(
    (conn: Connection) => setEdges((es) => addEdge(conn, es)),
    [],
  );

  const addNode = (type: "approval" | "condition") => {
    const seq = nodes.length + 1;
    const def: DesignerNode =
      type === "approval"
        ? { id: `n${Date.now() % 100000}`, type: "approval", label: `审批节点 ${seq}`, approver: { kind: "project_manager" }, countersign: "any" }
        : { id: `c${Date.now() % 100000}`, type: "condition", label: `条件 ${seq}`, expr: { field: "amount_cents", op: ">=", value: 5000000 } };
    setNodes((ns) => [
      ...ns,
      { id: def.id, type, position: { x: 240 + (seq % 3) * 60, y: 40 + (seq % 4) * 80 }, data: { label: def.label, detail: nodeDetail(def), def } },
    ]);
    setSelectedId(def.id);
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const definition = useMemo(() => fromFlowState(nodes, edges), [nodes, edges]);

  const patchSelected = (patch: Partial<DesignerNode>) => {
    if (!selected) return;
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== selected.id) return n;
        const def = { ...n.data.def, ...patch };
        return { ...n, data: { label: patch.label ?? n.data.label, detail: nodeDetail(def), def } };
      }),
    );
  };

  const runValidate = async (): Promise<string[]> => {
    const result = await validate(definition);
    setServerErrors(result.errors);
    return result.errors;
  };

  const saveDraft = () => {
    setError(null);
    setNotice(null);
    if (isNew) {
      mutations.createDraft.mutate(
        {
          name: draftMeta.name.trim(),
          scope: draftMeta.scope,
          bizBinding: draftMeta.bizBinding,
          definitionJson: definition,
        },
        {
          onSuccess: (r) => navigate(`/admin/flows/${r.id}`, { replace: true }),
          onError: (err) => setError(rootErrorMessage(err)),
        },
      );
      return;
    }
    if (!flow) return;
    mutations.updateDraft.mutate(
      { id: flow.id, rowVersion: flow.rowVersion, definitionJson: definition },
      {
        onSuccess: () => setNotice("草稿已保存（服务端结构校验通过）。"),
        onError: (err) => {
          if (businessCodeOf(err) === "VALIDATION_FAILED") {
            setError(rootErrorMessage(err));
          } else {
            setError(rootErrorMessage(err));
          }
        },
      },
    );
  };

  const publish = async () => {
    setError(null);
    setNotice(null);
    const errors = await runValidate();
    if (errors.length > 0) return;
    if (isNew || !flow) {
      setError("请先保存草稿再发布。");
      return;
    }
    mutations.publish.mutate(
      { id: flow.id, idempotencyKey: newIdempotencyKey() },
      {
        onSuccess: (r) => setNotice(r.published ? "流程已发布并生效。" : "该版本已是启用状态（幂等重放）。"),
        onError: (err) => setError(rootErrorMessage(err)),
      },
    );
  };

  const f = flow;

  return (
    <div className="screen designer-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">FLOW DESIGNER</span>
          <h1>
            <GitBranch size={20} style={{ verticalAlign: "-3px" }} /> {isNew ? "新建流程" : f?.name}
            {!isNew && f ? <span className="badge badge-health-normal">V{f.versionNo} · {f.enabled ? "启用中" : "草稿"}</span> : null}
          </h1>
          <p>
            {isNew
              ? "创建草稿后进入设计器保存/发布。"
              : `绑定业务：${FLOW_BIZ_BINDINGS.find(([v]) => v === f?.bizBinding)?.[1] ?? f?.bizBinding} · 输出编译为既有引擎步骤。`}
          </p>
        </div>
        <div className="title-actions">
          <Link to="/admin" className="secondary-action">
            返回列表
          </Link>
          {!isNew && f ? (
            <button
              className="secondary-action"
              disabled={mutations.disable.isPending || !f.enabled}
              onClick={() => {
                setError(null);
                mutations.disable.mutate(
                  { id: f.id, rowVersion: f.rowVersion },
                  { onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}
            >
              停用
            </button>
          ) : null}
          {!isNew && f ? (
            <button className="secondary-action" onClick={() => setVersionsOpen((v) => !v)}>
              <History size={15} />
              版本
            </button>
          ) : null}
          <button className="secondary-action" onClick={() => void runValidate()}>
            校验
          </button>
          <button className="secondary-action" onClick={saveDraft} disabled={mutations.updateDraft.isPending || mutations.createDraft.isPending}>
            保存草稿
          </button>
          <button className="primary-action" onClick={() => void publish()} disabled={mutations.publish.isPending}>
            <Rocket size={15} />
            发布流程
          </button>
        </div>
      </div>

      {isNew ? (
        <div className="owner-line" style={{ maxWidth: 720, marginTop: 14 }}>
          <label className="form-field">
            <span>流程名称 *</span>
            <input value={draftMeta.name} onChange={(e) => setDraftMeta((p) => ({ ...p, name: e.target.value }))} />
          </label>
          <label className="form-field">
            <span>范围</span>
            <select
              value={draftMeta.scope}
              onChange={(e) => setDraftMeta((p) => ({ ...p, scope: e.target.value as "global" | "project" }))}
            >
              <option value="global">全局</option>
              <option value="project">项目</option>
            </select>
          </label>
          <label className="form-field">
            <span>绑定业务 *</span>
            <select
              value={draftMeta.bizBinding}
              onChange={(e) => setDraftMeta((p) => ({ ...p, bizBinding: e.target.value }))}
            >
              {FLOW_BIZ_BINDINGS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="context-note" role="status">
          {notice}
        </p>
      ) : null}
      {serverErrors.length > 0 ? (
        <div className="validation-panel">
          <span className="section-label">校验未通过（服务端 flow.validate 原文）</span>
          {serverErrors.map((err) => (
            <p className="check-line fail" key={err} role="alert">
              <span aria-hidden="true">✕</span>
              <strong>未通过</strong>
              <small>{err}</small>
            </p>
          ))}
        </div>
      ) : null}
      {versionsOpen && versions.data ? (
        <div className="validation-panel">
          <span className="section-label">版本历史（{f?.name}）</span>
          {versions.data.map((v) => (
            <p className="check-line" key={v.id}>
              <strong>V{v.versionNo}</strong>
              <small>
                {v.enabled ? "启用中" : "未启用"} · {v.updatedAt.slice(0, 16).replace("T", " ")}
              </small>
            </p>
          ))}
        </div>
      ) : null}

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
          <p className="context-note">点击添加节点；拖拽移动；右侧圆点拉线连接；选中节点在右侧面板编辑。</p>
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
                <input value={selected.data.def.label} onChange={(e) => patchSelected({ label: e.target.value })} />
              </label>
              {selected.data.def.type === "approval" ? (
                <>
                  <label className="form-field">
                    <span>审批人来源</span>
                    <select
                      value={selected.data.def.approver?.kind ?? "project_manager"}
                      onChange={(e) => {
                        const kind = e.target.value as DesignerNode["approver"] extends { kind: infer K } ? K : never;
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
                        onChange={(e) => patchSelected({ approver: { kind: "role", role: e.target.value } })}
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
                      <span>指定用户 ID</span>
                      <input
                        value={selected.data.def.approver.userId ?? ""}
                        onChange={(e) => patchSelected({ approver: { kind: "user", userId: e.target.value } })}
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
                        {[">=", "<=", ">", "<", "==", "!="].map((op) => (
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
                  <p className="context-note">条件出边需「是/否」双边齐备（边标签标记分支）。</p>
                </>
              ) : null}
              {selected.data.def.type === "start" || selected.data.def.type === "end" ? (
                <p className="context-note">start/end 固定节点唯一（服务端校验）。</p>
              ) : null}
            </div>
          ) : (
            <p className="context-note">选中画布节点以编辑属性。</p>
          )}
        </aside>
      </div>
    </div>
  );
}
