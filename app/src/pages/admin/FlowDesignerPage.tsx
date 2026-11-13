import { useCallback, useEffect, useMemo, useState } from "react";

import { AI_FLOW_DRAFT_KEY } from "../../components/ai/ai-actions";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  reconnectEdge,
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
import { useProjectFlowMutations, useProjectFlows } from "../../api/project";
import { businessCodeOf, type RouterOutputs } from "../../lib/trpc";
import { FLOW_CONDITION_FIELD_TYPES } from "@lexflow/shared";
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
  approver?: { kind: "role" | "user" | "initiator_manager" | "initiator_choice" | "project_manager"; role?: string; userId?: string };
  countersign?: "any" | "all";
  expr?: { field: string; op: string; value: number | string | number[] };
}

/** 旧符号归一（arch/11 G4：存量 >=→gte、==→eq 等，后端编译层双形态兼容） */
const LEGACY_OPS: Record<string, string> = { ">=": "gte", "<=": "lte", ">": "gt", "<": "lt", "==": "eq", "!=": "ne" };
function normalizeOp(op: string): string {
  return LEGACY_OPS[op] ?? op;
}

const FIELD_TYPE = FLOW_CONDITION_FIELD_TYPES as unknown as Record<string, "text" | "number">;
const NUMBER_OPS: Array<[string, string]> = [["gte", "≥"], ["lte", "≤"], ["between", "介于"]];
const TEXT_OPS: Array<[string, string]> = [["eq", "等于"], ["contains", "包含"]];
/** 布尔/枚举字段给固定取值下拉 */
const FIELD_VALUE_OPTIONS: Record<string, Array<[string, string]>> = {
  borrow: [["true", "是（借款）"], ["false", "否"]],
  confidentiality: [["public", "公开"], ["internal", "内部"], ["confidential", "保密"], ["secret", "秘密"]],
};
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
  return {
    nodes: (def.nodes ?? []).map((n) =>
      n.type === "condition" && n.expr ? { ...n, expr: { ...n.expr, op: normalizeOp(n.expr.op) } } : n,
    ),
    edges: def.edges ?? [],
  };
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
    // G4：宽热区（易选中）+ 可聚焦删除 + 端点可重连
    interactionWidth: 24,
    focusable: true,
    reconnectable: true,
    style: { strokeWidth: 2 },
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
type ProjectFlowRow = RouterOutputs["project"]["flows"]["list"][number];

/** §20.2 项目级复用：项目流程设计器上下文（保存走 project.flows.updateDraft，发布同系统级强校验） */
interface ProjectDesignerCtx {
  projectId: string;
  flow: ProjectFlowRow;
}

/**
 * /admin/flows/:flowId 系统级设计器；/flows/p/:projectId/:flowId 项目级复用（同一 DesignerEditor，
 * 保存=updateDraft/发布=publish，均为服务端结构校验+乐观锁，§20.2 告别 JSON 骨架重建）。
 */
export default function FlowDesignerPage() {
  const { flowId, projectId } = useParams();
  const isNew = flowId === "new";
  const flow = useFlow(isNew || projectId ? null : (flowId ?? null));
  const flows = useFlowList();
  const projectFlows = useProjectFlows(projectId ?? null);

  if (projectId) {
    if (projectFlows.isPending) return <p className="list-note">正在加载项目内流程…</p>;
    if (projectFlows.isError) throw projectFlows.error;
    const pf = projectFlows.data.find((f) => f.id === flowId) ?? null;
    if (!pf) return <Navigate to={`/projects/${projectId}/flows`} replace />;
    return <DesignerEditor key={pf.id} isNew={false} flow={null} projectCtx={{ projectId, flow: pf }} />;
  }

  if (!isNew && flow.isPending) return <p className="list-note">正在加载流程…</p>;
  if (!isNew && flow.isError) throw flow.error;
  if (isNew && flows.isError) throw flows.error;

  return <DesignerEditor key={flow.data?.id ?? "new"} isNew={isNew} flow={flow.data ?? null} projectCtx={null} />;
}

function initialCanvas(isNew: boolean, definitionJson: unknown) {
  if (isNew || !definitionJson) {
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
  return toFlowState(toDesigner(definitionJson));
}

function DesignerEditor({ isNew, flow, projectCtx }: { isNew: boolean; flow: FlowRow | null; projectCtx: ProjectDesignerCtx | null }) {
  const navigate = useNavigate();
  const mutations = useFlowMutations();
  const projectMutations = useProjectFlowMutations(projectCtx?.projectId ?? "");
  const validate = useFlowValidate();
  /** §20.2 项目级草稿：画布/保存/发布全走项目上下文（activeFlow=项目草稿优先） */
  const pf = projectCtx?.flow ?? null;
  const activeFlow = (pf ?? flow) as FlowRow | null;
  // §17.2 A4：小元 DSL 草稿优先于默认骨架（用户校验后发布）。
  // D-14-4-1 验收即修：草稿消费从 useState initializer 移至 mount effect——React 19 StrictMode
  // 双挂载下 initializer 首跑消费+移除后，重跑读到空存储回落默认骨架致预填丢失（dev 形态实证）。
  const [initial] = useState(() => ({ ...initialCanvas(isNew, pf?.definitionJson ?? flow?.definitionJson ?? null), __fromAi: false }));
  const [nodes, setNodes] = useState<FlowNode[]>(initial.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 小元草稿一次性消费：effect 应用+移除（StrictMode 双 setup 二次空转） */
    const raw = sessionStorage.getItem(AI_FLOW_DRAFT_KEY);
    if (raw) {
      try {
        const ai = JSON.parse(raw) as { definitionJson?: { nodes?: unknown[]; edges?: unknown[] } } | null;
        if (ai && Array.isArray(ai.definitionJson?.nodes) && ai.definitionJson.nodes.length > 0) {
          const st = toFlowState(toDesigner(ai.definitionJson));
          setNodes(st.nodes);
          setEdges(st.edges);
          setNotice("小元 DSL 草稿已预填画布——请校验后保存/发布。");
        }
      } catch { /* 草稿形态损坏则忽略，回落默认骨架 */ }
      sessionStorage.removeItem(AI_FLOW_DRAFT_KEY);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
     
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [draftMeta, setDraftMeta] = useState({ name: "", scope: "global" as "global" | "project", bizBinding: "generic_request" });

  const versions = useFlowVersions(versionsOpen && !projectCtx ? (flow?.name ?? null) : null);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    [],
  );
  const onConnect = useCallback(
    (conn: Connection) => setEdges((es) => addEdge({ ...conn, interactionWidth: 24, focusable: true, reconnectable: true, style: { strokeWidth: 2 } }, es)),
    [],
  );
  // G4：从端点重连（拖动既有连线端点到新节点）
  const onReconnect = useCallback((oldEdge: Edge, conn: Connection) => {
    setEdges((es) => reconnectEdge(oldEdge, conn, es));
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [propsOpen, setPropsOpen] = useState(true);

  const addNode = (type: "approval" | "condition") => {
    const seq = nodes.length + 1;
    const def: DesignerNode =
      type === "approval"
        ? { id: `n${Date.now() % 100000}`, type: "approval", label: `审批节点 ${seq}`, approver: { kind: "project_manager" }, countersign: "any" }
        : { id: `c${Date.now() % 100000}`, type: "condition", label: `条件 ${seq}`, expr: { field: "amount_cents", op: "gte", value: 5000000 } };
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
    if (projectCtx && pf) {
      projectMutations.updateDraft.mutate(
        { projectId: projectCtx.projectId, id: pf.id, rowVersion: pf.rowVersion, definitionJson: definition },
        {
          onSuccess: () => setNotice("草稿已保存（项目级·服务端结构校验通过）。"),
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
    if (isNew || (!projectCtx && !flow)) {
      setError("请先保存草稿再发布。");
      return;
    }
    if (projectCtx && pf) {
      projectMutations.publish.mutate(
        { projectId: projectCtx.projectId, id: pf.id, idempotencyKey: newIdempotencyKey() },
        {
          onSuccess: (r) => setNotice(r.published ? "项目流程已发布并生效。" : "该版本已是启用状态（幂等重放）。"),
          onError: (err) => setError(rootErrorMessage(err)),
        },
      );
      return;
    }
    if (!flow) return;
    mutations.publish.mutate(
      { id: flow.id, idempotencyKey: newIdempotencyKey() },
      {
        onSuccess: (r) => setNotice(r.published ? "流程已发布并生效。" : "该版本已是启用状态（幂等重放）。"),
        onError: (err) => setError(rootErrorMessage(err)),
      },
    );
  };

  const f = activeFlow;

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
              : `绑定业务：${FLOW_BIZ_BINDINGS.find(([v]) => v === f?.bizBinding)?.[1] ?? f?.bizBinding} · ${projectCtx ? "项目级流程（scope 优先于系统默认）" : "输出编译为既有引擎步骤"}。`}
          </p>
        </div>
        <div className="title-actions">
          <Link to={projectCtx ? `/projects/${projectCtx.projectId}/flows` : "/admin"} className="secondary-action">
            返回列表
          </Link>
          {!isNew && f && !projectCtx ? (
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
          {!isNew && f && !projectCtx ? (
            <button className="secondary-action" onClick={() => setVersionsOpen((v) => !v)}>
              <History size={15} />
              版本
            </button>
          ) : null}
          <button className="secondary-action" onClick={() => void runValidate()}>
            校验
          </button>
          <button
            className="secondary-action"
            onClick={saveDraft}
            disabled={mutations.updateDraft.isPending || mutations.createDraft.isPending || projectMutations.updateDraft.isPending}
          >
            保存草稿
          </button>
          <button
            className="primary-action"
            onClick={() => void publish()}
            disabled={mutations.publish.isPending || projectMutations.publish.isPending}
          >
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
        <aside className={`designer-palette ${paletteOpen ? "" : "collapsed"}`}>
          <button className="panel-collapse" aria-label={paletteOpen ? "折叠节点面板" : "展开节点面板"} onClick={() => setPaletteOpen((v) => !v)}>
            {paletteOpen ? "«" : "»"}
          </button>
          {paletteOpen ? (
            <>
          <span className="section-label">节点面板</span>
          <button className="palette-node" onClick={() => addNode("approval")}>
            <strong>＋ 审批节点</strong>
            <small>审批人（角色/用户/上级/负责人）+ 会签</small>
          </button>
          <button className="palette-node condition" onClick={() => addNode("condition")}>
            <strong>＋ 条件节点</strong>
            <small>字段白名单表达式 · 是/否 双边分支</small>
          </button>
          <p className="context-note">点击添加节点；拖拽移动；右侧圆点拉线/拖端点重连；连线宽热区可选中（Backspace 删除）；选中节点在右侧面板编辑。</p>
            </>
          ) : null}
        </aside>
        <div className="designer-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onReconnect={onReconnect}
            onEdgeClick={(_, edge) => setEdges((es) => es.map((e) => ({ ...e, selected: e.id === edge.id })))}
            deleteKeyCode={["Backspace", "Delete"]}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            fitView
            colorMode="light"
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside className={`designer-props ${propsOpen ? "" : "collapsed"}`}>
          <button className="panel-collapse" aria-label={propsOpen ? "折叠属性面板" : "展开属性面板"} onClick={() => setPropsOpen((v) => !v)}>
            {propsOpen ? "»" : "«"}
          </button>
          {propsOpen ? (
            <>
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
                      onChange={(e) => {
                        // G4：字段类型联动——切字段重置操作符与取值形态
                        const field = e.target.value;
                        const kind = FIELD_TYPE[field] ?? "number";
                        patchSelected({
                          expr: {
                            field,
                            op: kind === "number" ? "gte" : "eq",
                            value: kind === "number" ? 0 : "",
                          },
                        });
                      }}
                    >
                      {CONDITION_FIELD_WHITELIST.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {(() => {
                    const field = selected.data.def.expr?.field ?? "amount_cents";
                    const kind = FIELD_TYPE[field] ?? "number";
                    const op = selected.data.def.expr?.op ?? (kind === "number" ? "gte" : "eq");
                    const value = selected.data.def.expr?.value;
                    const valueOptions = FIELD_VALUE_OPTIONS[field];
                    return (
                      <>
                        <div className="owner-line">
                          <label className="form-field">
                            <span>操作符{kind === "number" ? "（数值）" : "（文本）"}</span>
                            <select
                              value={op}
                              onChange={(e) =>
                                patchSelected({
                                  expr: {
                                    field,
                                    op: e.target.value,
                                    value: e.target.value === "between" ? [0, 0] : valueOptions ? valueOptions[0][0] : kind === "number" ? 0 : "",
                                  },
                                })
                              }
                            >
                              {(kind === "number" ? NUMBER_OPS : TEXT_OPS).map(([o, label]) => (
                                <option key={o} value={o}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </label>
                          {op === "between" ? (
                            <>
                              <label className="form-field">
                                <span>下限</span>
                                <input
                                  type="number"
                                  value={Array.isArray(value) ? value[0] : 0}
                                  onChange={(e) =>
                                    patchSelected({
                                      expr: { field, op, value: [Number(e.target.value), Array.isArray(value) ? value[1] : 0] },
                                    })
                                  }
                                />
                              </label>
                              <label className="form-field">
                                <span>上限</span>
                                <input
                                  type="number"
                                  value={Array.isArray(value) ? value[1] : 0}
                                  onChange={(e) =>
                                    patchSelected({
                                      expr: { field, op, value: [Array.isArray(value) ? value[0] : 0, Number(e.target.value)] },
                                    })
                                  }
                                />
                              </label>
                            </>
                          ) : valueOptions ? (
                            <label className="form-field">
                              <span>取值</span>
                              <select
                                value={String(value ?? valueOptions[0][0])}
                                onChange={(e) => patchSelected({ expr: { field, op, value: e.target.value } })}
                              >
                                {valueOptions.map(([v, label]) => (
                                  <option key={v} value={v}>
                                    {label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : (
                            <label className="form-field">
                              <span>{kind === "number" ? "阈值" : "文本值"}</span>
                              <input
                                type={kind === "number" ? "number" : "text"}
                                value={kind === "number" ? Number(value ?? 0) : String(value ?? "")}
                                onChange={(e) =>
                                  patchSelected({
                                    expr: { field, op, value: kind === "number" ? Number(e.target.value) : e.target.value },
                                  })
                                }
                              />
                            </label>
                          )}
                        </div>
                        <p className="context-note">
                          {kind === "number"
                            ? "数值字段：比较符 + 阈值（between 为区间二元组）。"
                            : "文本字段：等于/包含；布尔与密级字段给固定取值下拉。"}
                          条件出边需「是/否」双边齐备（边标签标记分支）。
                        </p>
                      </>
                    );
                  })()}
                </>
              ) : null}
              {selected.data.def.type === "start" || selected.data.def.type === "end" ? (
                <p className="context-note">start/end 固定节点唯一（服务端校验）。</p>
              ) : null}
            </div>
          ) : (
            <p className="context-note">选中画布节点以编辑属性。</p>
          )}
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
