import { Fragment, useState } from "react";
import { Trash2 } from "lucide-react";

import type { FormFieldDef, SameAsInitiator } from "@lexflow/shared";
import { FLOW_CONDITION_FIELDS, FLOW_CONDITION_FIELD_TYPES, FLOW_CONDITION_OPERATORS, FLOW_V2_LIMITS } from "@lexflow/shared";
import { GLOBAL_ROLE_LABEL } from "../../lib/labels";
import { UserPicker } from "../../components/UserPicker";
import {
  approverSummary, conditionDepth, countNodes, defaultApproval, defaultCc, defaultCondition, exprSummary,
  insertAt, removeNodeById, updateNodeById,
  type V2ConditionNode, type V2Def, type V2Expr, type V2Node,
} from "./v2-model";

/**
 * ③ 流程设计步（arch/14 §5，飞书式竖向画布）：
 * 提交卡（摘要=谁可提交）→〔＋〕→节点卡→〔＋〕→…→结束卡（可配结束抄送）；
 * 条件分支=横向分支列（列头=分支名+条件摘要，末列恒「其他情况」，可增删/调序，嵌套≤3 层）；
 * 点卡→右侧节点抽屉（审批/条件分支/抄送）；保存=结构校验 400 逐字段落位，发布=412 语义。
 */

type Path = number[];

const KIND_LABEL: Record<string, string> = {
  role: "全局角色",
  user: "指定成员",
  initiator_manager: "提交人直属上级",
  project_manager: "项目负责人",
  initiator_choice: "提交人自选（全员）",
  initiator_self: "提交人本人",
  dept_head: "提交人部门负责人",
  manager_chain: "连续多级上级",
  form_contact: "表单内联系人",
};

const NODE_COLOR: Record<V2Node["type"], string> = { approval: "#f59e0b", cc: "#3b82f6", condition: "#8b7ec8" };
/** 固定业务表单（generic_request）fieldPerms 白名单（arch/14 §9） */
const BIZ_FORM_FIELDS: Array<{ key: string; label: string }> = [
  { key: "title", label: "标题" },
  { key: "reason", label: "事由" },
  { key: "amount", label: "金额" },
  { key: "startOn", label: "开始日期" },
  { key: "endOn", label: "结束日期" },
  { key: "attachment", label: "附件" },
];

function updateAtPath(def: V2Def, path: Path, fn: (nodes: V2Node[]) => V2Node[]): V2Def {
  const walk = (nodes: V2Node[], p: Path): V2Node[] => {
    if (p.length === 0) return fn(nodes);
    const [i, ...rest] = p;
    return nodes.map((n, ni) => {
      if (ni !== i) return n;
      if (rest.length > 0 && n.type === "condition") {
        const bIdx = rest[0];
        return { ...n, branches: n.branches.map((b, bi) => (bi === bIdx ? { ...b, nodes: walk(b.nodes, rest.slice(1)) } : b)) };
      }
      if (rest.length === 0) return n;
      return n;
    });
  };
  return { ...def, nodes: walk(def.nodes, path) };
}

export function FlowDesignStep({ def, bizBinding, formFields, isCustomForm, onChange }: { def: V2Def; bizBinding: string; formFields: FormFieldDef[]; isCustomForm: boolean; onChange: (d: V2Def) => void }) {
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [insertAtPath, setInsertAtPath] = useState<{ path: Path; index: number } | null>(null);
  const drawerNode = findNode(def.nodes, drawerId);

  const addNode = (type: V2Node["type"]) => {
    if (!insertAtPath) return;
    if (countNodes(def.nodes) >= FLOW_V2_LIMITS.maxNodes) return;
    const node = type === "approval" ? defaultApproval() : type === "cc" ? defaultCc() : defaultCondition();
    if (type === "condition" && conditionDepth(def.nodes) >= FLOW_V2_LIMITS.maxConditionDepth) return;
    onChange(updateAtPath(def, insertAtPath.path, (ns) => insertAt(ns, insertAtPath.index, node)));
    setInsertAtPath(null);
    if (type !== "condition") setDrawerId(node.id);
  };

  return (
    <div className="fw-flowdesign">
      <div className="vflow-scroll">
        <div className="vflow-lane">
          {/* 提交卡（固定头） */}
          <div className="vf-card vf-submit">
            <div className="vf-bar" style={{ background: "#16a34a" }} />
            <div className="vf-body">
              <strong>提交</strong>
              <small>谁可以提交：{bizBinding.startsWith("custom_form:") ? "见基础信息可见性" : "按流程绑定业务"}</small>
            </div>
          </div>
          <NodeSeq
            nodes={def.nodes}
            path={[]}
            depth={0}
            onSeq={(path, fn) => onChange(updateAtPath(def, path, fn))}
            onOpen={setDrawerId}
            onInsert={(path, index) => setInsertAtPath({ path, index })}
          />
          {/* 结束卡（固定尾，可配结束抄送） */}
          <div className="vf-card vf-end">
            <div className="vf-bar" style={{ background: "#64748b" }} />
            <div className="vf-body">
              <strong>结束</strong>
              <small>
                结束抄送：{def.endCc.length === 0 ? "无" : def.endCc.map((r) => KIND_LABEL[r.kind]).join("、")}
                <button type="button" className="text-action" style={{ marginLeft: 6 }} onClick={() => {
                  const kind = window.prompt("结束抄送接收人类型（role/user/initiator_manager/dept_head），逗号分隔可多个", "role");
                  if (!kind) return;
                  onChange({ ...def, endCc: [...def.endCc, { kind: kind.split(",")[0].trim() }] });
                }}>＋抄送</button>
                {def.endCc.length > 0 ? (
                  <button type="button" className="text-action" onClick={() => onChange({ ...def, endCc: def.endCc.slice(0, -1) })}>清空</button>
                ) : null}
              </small>
            </div>
          </div>
          <p className="context-note" style={{ textAlign: "center" }}>
            节点 {countNodes(def.nodes)}/{FLOW_V2_LIMITS.maxNodes} · 条件嵌套 {conditionDepth(def.nodes)}/{FLOW_V2_LIMITS.maxConditionDepth} 层
          </p>
        </div>
      </div>

      {insertAtPath ? (
        <div className="vf-insert-menu" role="menu">
          <button type="button" onClick={() => addNode("approval")}>＋ 审批</button>
          <button type="button" onClick={() => addNode("condition")}>＋ 条件分支</button>
          <button type="button" onClick={() => addNode("cc")}>＋ 抄送</button>
          <button type="button" className="text-action" onClick={() => setInsertAtPath(null)}>取消</button>
        </div>
      ) : null}

      {drawerNode ? (
        <NodeDrawer
          node={drawerNode}
          bizBinding={bizBinding}
          formFields={formFields}
          isCustomForm={isCustomForm}
          onClose={() => setDrawerId(null)}
          onChange={(n) => onChange({ ...def, nodes: updateNodeById(def.nodes, n.id, () => n) })}
        />
      ) : null}
    </div>
  );
}

function findNode(nodes: V2Node[], id: string | null): V2Node | null {
  if (!id) return null;
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === "condition") {
      for (const b of n.branches) {
        const f = findNode(b.nodes, id);
        if (f) return f;
      }
    }
  }
  return null;
}

function NodeSeq({ nodes, path, depth, onSeq, onOpen, onInsert }: {
  nodes: V2Node[];
  path: Path;
  depth: number;
  onSeq: (path: Path, fn: (ns: V2Node[]) => V2Node[]) => void;
  onOpen: (id: string) => void;
  onInsert: (path: Path, index: number) => void;
}) {
  return (
    <>
      <InsertBtn onClick={() => onInsert(path, 0)} />
      {nodes.map((node, i) => (
        <Fragment key={node.id}>
          <NodeCard node={node} onOpen={() => onOpen(node.id)} onDelete={() => onSeq(path, (ns) => removeNodeById(ns, node.id))} />
          {node.type === "condition" ? (
            <BranchRow
              node={node}
              path={[...path, i]}
              depth={depth + 1}
              onSeq={onSeq}
              onOpen={onOpen}
              onInsert={onInsert}
            />
          ) : null}
          <InsertBtn onClick={() => onInsert(path, i + 1)} />
        </Fragment>
      ))}
    </>
  );
}

function InsertBtn({ onClick }: { onClick: () => void }) {
  return (
    <div className="vf-insert">
      <button type="button" aria-label="插入节点" onClick={onClick}>＋</button>
    </div>
  );
}

function nodeName(node: V2Node): string {
  return node.type === "condition" ? "条件分支" : node.name;
}

function NodeCard({ node, onOpen, onDelete }: { node: V2Node; onOpen: () => void; onDelete: () => void }) {
  const summary =
    node.type === "approval"
      ? `${node.approvalType === "manual" ? approverSummary(node.approver, (k) => GLOBAL_ROLE_LABEL[k] ?? k) : node.approvalType === "auto_pass" ? "自动通过" : "自动拒绝"}${node.approvalType === "manual" ? ` · 会签 ${node.countersign === "all" ? "全部" : "任一"}` : ""}`
      : node.type === "cc"
        ? `抄送：${node.receivers.map((r) => KIND_LABEL[r.kind]).join("、") || "未配置"}`
        : `${node.branches.length} 分支（含其他情况）`;
  return (
    <div className="vf-card" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}>
      <div className="vf-bar" style={{ background: NODE_COLOR[node.type] }} />
      <div className="vf-body">
        <strong>{nodeName(node)}</strong>
        <small>{summary}</small>
      </div>
      <span className="p9a-row-actions" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="icon-button" aria-label="删除节点" onClick={onDelete}><Trash2 size={13} /></button>
      </span>
    </div>
  );
}

/** 条件分支横向列（else 恒最后；列内继续竖排） */
function BranchRow({ node, path, depth, onSeq, onOpen, onInsert }: {
  node: V2ConditionNode;
  path: Path;
  depth: number;
  onSeq: (path: Path, fn: (ns: V2Node[]) => V2Node[]) => void;
  onOpen: (id: string) => void;
  onInsert: (path: Path, index: number) => void;
}) {
  const patchNode = (p: Partial<V2ConditionNode>) => onSeq(path.slice(0, -1), (ns) => updateNodeById(ns, node.id, (n) => ({ ...(n as V2ConditionNode), ...p })));
  const reorder = (from: number, to: number) => {
    const branches = [...node.branches];
    const nonElse = branches.filter((b) => b.expr !== null || b === branches[branches.length - 1]);
    void nonElse;
    const [moved] = branches.splice(from, 1);
    branches.splice(to, 0, moved);
    const elseBranch = branches.find((b) => b.expr === null);
    const others = branches.filter((b) => b.expr !== null);
    patchNode({ branches: [...others, ...(elseBranch ? [elseBranch] : [])] });
  };
  return (
    <div className="vf-branches" style={{ ["--depth" as never]: depth }}>
      {node.branches.map((b, bi) => {
        const isElse = b.expr === null;
        return (
          <div key={bi} className={`vf-branch ${isElse ? "else" : ""}`}>
            <div className="vf-branch-head">
              <strong>{b.name}</strong>
              <small>{isElse ? "其他情况" : exprSummary(b.expr)}</small>
              <span className="p9a-row-actions">
                {!isElse ? (
                  <>
                    <button type="button" className="text-action" disabled={bi === 0} onClick={() => reorder(bi, bi - 1)}>←</button>
                    <button type="button" className="text-action" disabled={bi >= node.branches.length - 2} onClick={() => reorder(bi, bi + 1)}>→</button>
                    <button type="button" className="text-action" onClick={() => patchNode({ branches: node.branches.filter((_, i) => i !== bi) })}>删</button>
                  </>
                ) : null}
              </span>
            </div>
            <NodeSeq nodes={b.nodes} path={[...path, bi]} depth={depth} onSeq={onSeq} onOpen={onOpen} onInsert={onInsert} />
          </div>
        );
      })}
      {node.branches.length < 8 ? (
        <button type="button" className="secondary-action vf-branch-add" onClick={() => {
          const n = node.branches.length;
          patchNode({ branches: [...node.branches.slice(0, -1), { name: `分支 ${n}`, expr: null, nodes: [] }, node.branches[node.branches.length - 1]] });
        }}>＋ 分支</button>
      ) : null}
    </div>
  );
}

/** 节点抽屉：审批/条件分支/抄送（右侧滑出） */
function NodeDrawer({ node, bizBinding, formFields, isCustomForm, onChange, onClose }: {
  node: V2Node;
  bizBinding: string;
  isCustomForm: boolean;
  formFields: FormFieldDef[];
  onChange: (n: V2Node) => void;
  onClose: () => void;
}) {
  return (
    <aside className="fw-node-drawer" role="dialog" aria-label={`节点配置 · ${nodeName(node)}`}>
      <div className="drawer-head">
        <div>
          <span className="section-label">NODE · {node.type === "approval" ? "审批" : node.type === "cc" ? "抄送" : "条件分支"}</span>
          <h2>{nodeName(node)}</h2>
        </div>
        <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>×</button>
      </div>
      {node.type === "approval" ? <ApprovalDrawer node={node} bizBinding={bizBinding} formFields={formFields} isCustomForm={isCustomForm} onChange={onChange} /> : null}
      {node.type === "cc" ? <CcDrawer node={node} onChange={onChange} /> : null}
      {node.type === "condition" ? <ConditionDrawer node={node} bizBinding={bizBinding} formFields={formFields} isCustomForm={isCustomForm} onChange={onChange} /> : null}
    </aside>
  );
}

function ApprovalDrawer({ node, bizBinding, formFields, isCustomForm, onChange }: { node: V2Node; bizBinding: string; formFields: FormFieldDef[]; isCustomForm: boolean; onChange: (n: V2Node) => void }) {
  if (node.type !== "approval") return null;
  const patch = (p: Partial<Extract<V2Node, { type: "approval" }>>) => onChange({ ...node, ...p });
  const personFields = formFields.filter((f) => f.control === "person");
  const isCustom = isCustomForm || bizBinding.startsWith("custom_form:");
  const permFields = isCustom ? formFields.map((f) => ({ key: f.key, label: f.label })) : BIZ_FORM_FIELDS;
  return (
    <div className="fw-drawer-body">
      <label className="form-field"><span>节点名称 *</span>
        <input value={node.name} onChange={(e) => patch({ name: e.target.value })} /></label>
      <label className="form-field"><span>审批类型</span>
        <select value={node.approvalType} onChange={(e) => patch({ approvalType: e.target.value as never })}>
          <option value="manual">人工审批</option>
          <option value="auto_pass">自动通过</option>
          <option value="auto_reject">自动拒绝</option>
        </select></label>
      {node.approvalType === "manual" ? (
        <>
          <label className="form-field"><span>审批人策略</span>
            <select value={node.approver.kind} onChange={(e) => patch({ approver: { kind: e.target.value } })}>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select></label>
          {node.approver.kind === "role" ? (
            <label className="form-field"><span>角色</span>
              <select value={node.approver.role ?? ""} onChange={(e) => patch({ approver: { ...node.approver, role: e.target.value } })}>
                <option value="">请选择</option>
                {Object.entries(GLOBAL_ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></label>
          ) : null}
          {node.approver.kind === "user" ? (
            <div className="form-field"><span>指定成员</span>
              <UserPicker value={node.approver.userId ?? ""} onChange={(v) => patch({ approver: { ...node.approver, userId: v } })} /></div>
          ) : null}
          {node.approver.kind === "manager_chain" ? (
            <label className="form-field"><span>连续级数（1-10）</span>
              <input type="number" min={1} max={10} value={node.approver.levels ?? 1} onChange={(e) => patch({ approver: { ...node.approver, levels: Math.max(1, Math.min(10, Number(e.target.value))) } })} /></label>
          ) : null}
          {node.approver.kind === "form_contact" ? (
            <label className="form-field"><span>人员控件字段（仅自定义表单）</span>
              <select value={node.approver.fieldKey ?? ""} onChange={(e) => patch({ approver: { ...node.approver, fieldKey: e.target.value } })}>
                <option value="">请选择</option>
                {personFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
              {personFields.length === 0 ? <em className="ux-err">当前表单无人员控件，请先在表单设计步添加。</em> : null}</label>
          ) : null}
          <div className="owner-line">
            <label className="form-field"><span>会签</span>
              <select value={node.countersign} onChange={(e) => patch({ countersign: e.target.value as "any" | "all" })}>
                <option value="any">任一通过</option>
                <option value="all">全部通过</option>
              </select></label>
            <label className="form-field"><span>审批人=提交人时</span>
              <select value={node.sameAsInitiator} onChange={(e) => patch({ sameAsInitiator: e.target.value as SameAsInitiator })}>
                <option value="skip">剔除提交人（默认，空则 403）</option>
                <option value="self">允许本人自审</option>
                <option value="to_manager">替换为直属上级</option>
                <option value="to_dept_head">替换为部门负责人</option>
              </select></label>
          </div>
          <span className="section-label">操作权限</span>
          <label className="check-field">
            <input type="checkbox" checked={node.ops.transfer} onChange={(e) => patch({ ops: { ...node.ops, transfer: e.target.checked } })} />
            允许转交
          </label>
          <label className="form-field"><span>退回</span>
            <select value={node.ops.returnBack} onChange={(e) => patch({ ops: { ...node.ops, returnBack: e.target.value as never } })}>
              <option value="none">不允许退回</option>
              <option value="prev">退回上一步</option>
              <option value="initiator">退回提交人</option>
            </select></label>
          <label className="check-field">
            <input type="checkbox" checked={node.ops.requireCommentOnReject} onChange={(e) => patch({ ops: { ...node.ops, requireCommentOnReject: e.target.checked } })} />
            驳回必填意见
          </label>
          <label className="check-field">
            <input type="checkbox" checked={node.ops.requireCommentOnApprove} onChange={(e) => patch({ ops: { ...node.ops, requireCommentOnApprove: e.target.checked } })} />
            通过必填意见
          </label>
        </>
      ) : null}
      <span className="section-label">表单权限矩阵（{isCustom ? "自定义表单=全字段" : "固定业务表单=白名单字段"}）</span>
      <div className="fw-perm-grid">
        {permFields.map((f) => {
          const cur = node.fieldPerms?.[f.key] ?? "read";
          return (
            <div key={f.key} className="fw-perm-row">
              <span>{f.label}</span>
              <label><input type="radio" checked={cur === "read"} onChange={() => patch({ fieldPerms: { ...node.fieldPerms, [f.key]: "read" } })} /> 只读</label>
              <label><input type="radio" checked={cur === "hidden"} onChange={() => patch({ fieldPerms: { ...node.fieldPerms, [f.key]: "hidden" } })} /> 隐藏</label>
              <label className="fw-perm-edit" title={isCustom ? "edit 语义 P2（防业务一致性破坏）" : "固定表单 edit 列置灰（arch/14 §9 P2）"}>
                <input type="radio" disabled /> 可编辑（P2）
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CcDrawer({ node, onChange }: { node: V2Node; onChange: (n: V2Node) => void }) {
  if (node.type !== "cc") return null;
  const patch = (p: Partial<Extract<V2Node, { type: "cc" }>>) => onChange({ ...node, ...p });
  return (
    <div className="fw-drawer-body">
      <label className="form-field"><span>节点名称 *</span>
        <input value={node.name} onChange={(e) => patch({ name: e.target.value })} /></label>
      <span className="section-label">接收人策略（角色 / 指定成员 / 直属上级 / 部门负责人）</span>
      {node.receivers.map((r, i) => (
        <div key={i} className="owner-line fw-cc-receiver">
          <select value={r.kind} onChange={(e) => {
            const next = [...node.receivers];
            next[i] = { kind: e.target.value };
            patch({ receivers: next });
          }}>
            {["role", "user", "initiator_manager", "dept_head"].map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          {r.kind === "role" ? (
            <select value={r.role ?? ""} onChange={(e) => { const next = [...node.receivers]; next[i] = { ...r, role: e.target.value }; patch({ receivers: next }); }}>
              <option value="">角色</option>
              {Object.entries(GLOBAL_ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          ) : null}
          {r.kind === "user" ? (
            <UserPicker value={r.userId ?? ""} onChange={(v) => { const next = [...node.receivers]; next[i] = { ...r, userId: v }; patch({ receivers: next }); }} placeholder="搜索成员" />
          ) : null}
          <button type="button" className="icon-button" aria-label="删除接收人" onClick={() => patch({ receivers: node.receivers.filter((_, x) => x !== i) })}><Trash2 size={13} /></button>
        </div>
      ))}
      <button type="button" className="secondary-action" onClick={() => patch({ receivers: [...node.receivers, { kind: "role", role: "sysadmin" }] })}>＋ 添加接收人</button>
    </div>
  );
}

function ConditionDrawer({ node, bizBinding, formFields, isCustomForm, onChange }: { node: V2Node; bizBinding: string; formFields: FormFieldDef[]; isCustomForm: boolean; onChange: (n: V2Node) => void }) {
  if (node.type !== "condition") return null;
  const patch = (p: Partial<Extract<V2Node, { type: "condition" }>>) => onChange({ ...node, ...p });
  const isCustom = isCustomForm || bizBinding.startsWith("custom_form:");
  const fieldOptions = [
    ...FLOW_CONDITION_FIELDS.map((f) => ({ value: f, label: f, type: FLOW_CONDITION_FIELD_TYPES[f as never] })),
    // 自定义表单：payload 键以 form.<key> 入快照（提交链路），条件字段白名单放行
    ...(isCustom
      ? formFields.map((f) => ({
          value: `form.${f.key}`,
          label: `form.${f.key}（${f.label}）`,
          type: (f.control === "money" || f.control === "number" ? "number" : "text") as "text" | "number",
        }))
      : []),
  ];
  return (
    <div className="fw-drawer-body">
      <span className="section-label">分支编辑（「其他情况」恒最后，缺省条件=其他）</span>
      {node.branches.map((b, bi) => {
        const isElse = b.expr === null && bi === node.branches.length - 1;
        return (
          <div key={bi} className="fw-branch-edit">
            <div className="owner-line">
              <label className="form-field"><span>分支名 *</span>
                <input value={b.name} onChange={(e) => {
                  const branches = node.branches.map((x, i) => (i === bi ? { ...x, name: e.target.value } : x));
                  patch({ branches });
                }} /></label>
              {!isElse ? (
                <label className="form-field"><span>条件字段</span>
                  <select value={b.expr?.field ?? ""} onChange={(e) => {
                    const field = e.target.value;
                    const type = (fieldOptions.find((o) => o.value === field)?.type ?? "text") as "text" | "number";
                    const op = type === "number" ? "gte" : "eq";
                    const branches = node.branches.map((x, i) => (i === bi ? { ...x, expr: { field, op, value: type === "number" ? 0 : "" } as V2Expr } : x));
                    patch({ branches });
                  }}>
                    <option value="">请选择</option>
                    {fieldOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select></label>
              ) : <span className="badge">其他情况（else）</span>}
            </div>
            {!isElse && b.expr ? (
              <div className="owner-line">
                <label className="form-field"><span>操作符</span>
                  <select value={b.expr.op} onChange={(e) => {
                    const branches = node.branches.map((x, i) => (i === bi ? { ...x, expr: { ...(x.expr as V2Expr), op: e.target.value } } : x));
                    patch({ branches });
                  }}>
                    {(FLOW_CONDITION_OPERATORS as Record<string, readonly string[]>)[fieldOptions.find((o) => o.value === b.expr?.field)?.type ?? "text"].map((op) => (
                      <option key={op} value={op}>{op}</option>
                    ))}
                  </select></label>
                <label className="form-field"><span>值（支持 $config.xxx 引用）</span>
                  <input value={String(b.expr.value ?? "")} onChange={(e) => {
                    const raw = e.target.value;
                    const value = raw.startsWith("$config.") ? raw : Number.isNaN(Number(raw)) || raw === "" ? raw : Number(raw);
                    const branches = node.branches.map((x, i) => (i === bi ? { ...x, expr: { ...(x.expr as V2Expr), value } } : x));
                    patch({ branches });
                  }} /></label>
              </div>
            ) : null}
          </div>
        );
      })}
      <p className="context-note">
        分支增删/调序在画布列头操作；条件字段含固定白名单（amount_cents/confidentiality/level/borrow/request_type）。
        自定义表单的条件字段走 form.&lt;key&gt;（编译层白名单已放行）。
      </p>
    </div>
  );
}
