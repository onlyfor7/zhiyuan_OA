import { useState } from "react";
import { GitBranch, Plus } from "lucide-react";

import { useProjectFlowMutations, useProjectFlows } from "../../api/project";
import { FormDialog } from "../../components/FormDialog";
import { newIdempotencyKey, rootErrorMessage } from "../../lib/form";
import { useSpaceParams } from "./space-context";

/** 项目内流程允许绑定的基础业务表单（G5 白名单，与服务端一致） */
const BINDINGS: Array<[string, string]> = [
  ["travel", "出差申请"],
  ["travel_change", "出差变更"],
  ["change_request", "延期/变更申请"],
  ["funding", "经费申请"],
  ["expense", "费用报销"],
  ["expense_adjustment", "报销调整"],
  ["timesheet", "工时周期"],
];

const DEFAULT_DEF = () => ({
  nodes: [
    { id: "start", type: "start", label: "发起" },
    { id: "n1", type: "approval", label: "项目负责人审批", approver: { kind: "project_manager" }, countersign: "any" },
    { id: "end", type: "end", label: "完成" },
  ],
  edges: [
    { from: "start", to: "n1" },
    { from: "n1", to: "end" },
  ],
});

/** G5：项目空间「审批流」页签——列项目内流程 + 新建草稿→发布/停用（负责人可见入口，服务端强制） */
export default function FlowsTab() {
  const { projectId } = useSpaceParams();
  const flows = useProjectFlows(projectId);
  const mutations = useProjectFlowMutations(projectId);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [binding, setBinding] = useState("travel");
  const [error, setError] = useState<string | null>(null);

  if (flows.isPending) return <p className="list-note">正在加载项目内流程…</p>;
  if (flows.isError) throw flows.error;

  return (
    <div className="space-tab-body">
      <div className="section-heading">
        <div>
          <span className="section-label">PROJECT FLOWS</span>
          <h2>项目内审批流（{flows.data.length}）</h2>
        </div>
        <button className="primary-action" onClick={() => setCreateOpen(true)}>
          <Plus size={15} />
          新建项目流程
        </button>
      </div>
      <p className="context-note">
        项目内流程仅绑定基础业务表单（白名单），发布后对该项目同类单据优先于系统级默认流生效（引擎项目 scope 优先）。
      </p>
      <div className="report-list">
        {flows.data.length === 0 ? (
          <div className="empty-state">
            <strong>暂无项目内流程</strong>
            <p>点击「新建项目流程」创建草稿并发布；未配置时项目单据走系统级默认流程。</p>
          </div>
        ) : (
          flows.data.map((f) => (
            <div className="report-row" key={f.id}>
              <div>
                <strong>
                  <GitBranch size={14} style={{ verticalAlign: "-2px" }} /> {f.name}
                  <span className={`badge ${f.enabled ? "badge-health-normal" : ""}`}>
                    V{f.versionNo} · {f.enabled ? "启用中" : "草稿"}
                  </span>
                </strong>
                <small>
                  绑定业务：{BINDINGS.find(([k]) => k === f.bizBinding)?.[1] ?? f.bizBinding} · 更新{" "}
                  {f.updatedAt.slice(0, 16).replace("T", " ")}
                </small>
              </div>
              <div className="row-ops">
                {f.enabled ? (
                  <button
                    className="secondary-action"
                    disabled={mutations.disable.isPending}
                    onClick={() => {
                      setError(null);
                      mutations.disable.mutate(
                        { projectId, id: f.id, rowVersion: f.rowVersion },
                        { onError: (err) => setError(rootErrorMessage(err)) },
                      );
                    }}
                  >
                    停用
                  </button>
                ) : (
                  <button
                    className="primary-action"
                    disabled={mutations.publish.isPending}
                    onClick={() => {
                      setError(null);
                      mutations.publish.mutate(
                        { projectId, id: f.id, idempotencyKey: newIdempotencyKey() },
                        {
                          onSuccess: () => setError(null),
                          onError: (err) => setError(rootErrorMessage(err)),
                        },
                      );
                    }}
                  >
                    发布
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {createOpen ? (
        <FormDialog title="新建项目流程" eyebrow="PROJECT FLOW · 创建走弹窗" onClose={() => setCreateOpen(false)}>
          <label className="form-field">
            <span>流程名称 *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="form-field">
            <span>绑定业务 *（白名单）</span>
            <select value={binding} onChange={(e) => setBinding(e.target.value)}>
              {BINDINGS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p className="context-note">草稿内置「发起→项目负责人审批→完成」骨架；发布后对绑定业务的项目单据生效。</p>
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button
              className="primary-action"
              disabled={!name.trim() || mutations.createDraft.isPending}
              onClick={() => {
                setError(null);
                mutations.createDraft.mutate(
                  { projectId, name: name.trim(), bizBinding: binding, definitionJson: DEFAULT_DEF() },
                  {
                    onSuccess: () => {
                      setCreateOpen(false);
                      setName("");
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              创建草稿
            </button>
          </div>
        </FormDialog>
      ) : null}
    </div>
  );
}
