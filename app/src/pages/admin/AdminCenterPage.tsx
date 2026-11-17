import { useState } from "react";
import { toast } from "sonner";
import { Link } from "react-router";
import { GitBranch, Plus, ShieldCheck } from "lucide-react";

import { useAdminConfig, useAdminMutations } from "../../api/admin";
import { useMe } from "../../api/auth";
import { useClientList, useMatterList } from "../../api/reference";
import { useProjectTemplates } from "../../api/project";
import { useFlowList, useFlowMutations } from "../../api/flow";
import { useFormList } from "../../api/forms";
import { HelpIcon } from "../../components/HelpIcon";
import { FormDialog } from "../../components/FormDialog";
import AiConfigTab from "./AiConfigTab";
import { rootErrorMessage } from "../../lib/form";
import DataCorrectTab from "./DataCorrectTab";
import { CONFIDENTIALITY_LABEL } from "../../lib/labels";
import { CONFIG_KEY } from "@lexflow/shared";

const TABS = [
  ["clients", "客户与事项"],
  ["templates", "项目模板"],
  ["flows", "审批流"],
  ["params", "系统参数"],
  ["codes", "编号规则"],
  ["ai-config", "AI 配置"],
  ["data-correct", "数据纠正"],
] as const;

/** 白名单参数键（CONFIG_KEY 全量展示；编辑逐个 get/set） */
const PARAM_KEYS = Object.values(CONFIG_KEY);

/** /admin 配置中心（真实 admin.*；sysadmin 专属，其余角色权限说明门） */
export default function AdminCenterPage() {
  const me = useMe();
  const isSysadmin = (me.data?.globalRoles ?? []).includes("sysadmin");
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("clients");

  if (me.isPending) return <p className="list-note">正在加载…</p>;
  if (me.isError) throw me.error;

  if (!isSysadmin) {
    return (
      <div className="screen admin-screen">
        <div className="screen-heading">
          <div>
            <span className="eyebrow">ADMIN CENTER</span>
            <h1>系统配置中心</h1>
          </div>
        </div>
        <div className="pending-box">
          <p className="context-note">
            你暂无配置中心权限（仅系统管理员角色可访问，arch/09 §4.1）；sysadmin 管配置但不获得业务内容权。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen admin-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">ADMIN CENTER</span>
          <h1 aria-label="系统配置中心">
            系统配置中心
            <HelpIcon pageKey="admin-center" />
          </h1>
          <p>用户/组织、客户/事项、模板、审批流、参数与编号规则。</p>
        </div>
      </div>
      <div className="audit-tabs space-tabs preview-tabs">
        {TABS.map(([key, label]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "clients" ? <ClientsTab /> : null}
      {tab === "templates" ? <TemplatesTab /> : null}
      {tab === "flows" ? <FlowsTab /> : null}
      {tab === "params" ? <ParamsTab /> : null}
      {tab === "codes" ? <CodesTab /> : null}
      {tab === "ai-config" ? <AiConfigTab /> : null}
      {tab === "data-correct" ? <DataCorrectTab /> : null}
    </div>
  );
}

function ClientsTab() {
  const clients = useClientList("");
  const matters = useMatterList("");
  const mutations = useAdminMutations();
  const [clientName, setClientName] = useState("");
  const [level, setLevel] = useState("internal");
  const [matterClient, setMatterClient] = useState("");
  const [matterName, setMatterName] = useState("");
  const [matterType, setMatterType] = useState("");
  const [clientOpen, setClientOpen] = useState(false);
  const [matterOpen, setMatterOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (clients.isPending || matters.isPending) return <p className="list-note">正在加载…</p>;
  if (clients.isError) throw clients.error;
  if (matters.isError) throw matters.error;

  return (
    <div className="preview-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">客户/事项（元数据管理；停用后从参照端点消失）</span>
        <button className="primary-action" onClick={() => setClientOpen(true)}>
          <Plus size={15} />
          创建客户
        </button>
        <button className="primary-action" onClick={() => setMatterOpen(true)}>
          <Plus size={15} />
          创建事项
        </button>
      </div>
      {clientOpen ? (
        <FormDialog title="创建客户" eyebrow="ADMIN · 创建走弹窗" onClose={() => setClientOpen(false)}>
          <div className="owner-line">
            <label className="form-field">
              <span>新建客户名 *</span>
              <input value={clientName} onChange={(e) => setClientName(e.target.value)} />
            </label>
            <label className="form-field">
              <span>密级</span>
              <select value={level} onChange={(e) => setLevel(e.target.value)}>
                {Object.entries(CONFIDENTIALITY_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primary-action"
              style={{ alignSelf: "end" }}
              disabled={!clientName.trim() || mutations.createClient.isPending}
              onClick={() => {
                setError(null);
                mutations.createClient.mutate(
                  { name: clientName.trim(), confidentialityLevel: level as never },
                  {
                    onSuccess: () => {
                      setClientName("");
                      setClientOpen(false);
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              创建客户
            </button>
          </div>
        </FormDialog>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="grant-table">
        <div className="grant-head">
          <span>客户</span>
          <span />
        </div>
        {clients.data.items.map((c) => (
          <div className="grant-row" key={c.id}>
            <div>
              <strong>{c.name}</strong>
              <small>{c.code}</small>
            </div>
            <button
              className="text-action"
              onClick={() =>
                mutations.setClientDisabled.mutate({ clientId: c.id, disabled: true }, { onError: (err) => setError(rootErrorMessage(err)) })
              }
            >
              停用
            </button>
          </div>
        ))}
      </div>
      {matterOpen ? (
        <FormDialog title="创建事项" eyebrow="ADMIN · 创建走弹窗" onClose={() => setMatterOpen(false)}>
          <div className="owner-line">
            <label className="form-field">
              <span>所属客户 *</span>
              <select value={matterClient} onChange={(e) => setMatterClient(e.target.value)}>
                <option value="">选择客户</option>
                {clients.data.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span>事项名 *</span>
              <input value={matterName} onChange={(e) => setMatterName(e.target.value)} />
            </label>
            <label className="form-field">
              <span>类型</span>
              <input value={matterType} onChange={(e) => setMatterType(e.target.value)} placeholder="诉讼/非诉/常法" />
            </label>
            <button
              className="primary-action"
              style={{ alignSelf: "end" }}
              disabled={!matterClient || !matterName.trim() || mutations.createMatter.isPending}
              onClick={() => {
                setError(null);
                mutations.createMatter.mutate(
                  { clientId: matterClient, name: matterName.trim(), type: matterType.trim() || undefined },
                  {
                    onSuccess: () => {
                      setMatterName("");
                      setMatterType("");
                      setMatterOpen(false);
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              创建事项
            </button>
          </div>
        </FormDialog>
      ) : null}
      <div className="grant-table">
        <div className="grant-head">
          <span>事项</span>
          <span>客户</span>
          <span />
        </div>
        {matters.data.items.map((m) => (
          <div className="grant-row" key={m.id}>
            <div>
              <strong>{m.name}</strong>
              <small>{m.code}</small>
            </div>
            <span>{m.clientName}</span>
            <button
              className="text-action"
              onClick={() =>
                mutations.setMatterDisabled.mutate({ matterId: m.id, disabled: true }, { onError: (err) => setError(rootErrorMessage(err)) })
              }
            >
              停用
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const TEMPLATE_SKELETON = {
  stages: [
    { seq: 1, name: "阶段一：启动" },
    { seq: 2, name: "阶段二：执行" },
  ],
  tasks: [{ name: "示例任务", stageSeq: 1, offsetDays: 0, durationDays: 5 }],
  checkItems: [{ name: "示例检查项", required: true, stageSeq: 2 }],
};

function TemplatesTab() {
  const templates = useProjectTemplates();
  const mutations = useAdminMutations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [structureText, setStructureText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState("");
  const [cDesc, setCDesc] = useState("");
  const [cStructure, setCStructure] = useState(() => JSON.stringify(TEMPLATE_SKELETON, null, 2));

  if (templates.isPending) return <p className="list-note">正在加载模板…</p>;
  if (templates.isError) throw templates.error;
  const selected = templates.data.find((t) => t.id === selectedId) ?? templates.data[0];

  return (
    <div className="preview-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">模板 structure_json 保存时服务端校验（stages 为 name+seq 数组且必填；tasks/checkItems 同族）</span>
        <button className="primary-action" onClick={() => setCreateOpen((v) => !v)}>
          <Plus size={15} />
          新建模板
        </button>
      </div>
      {createOpen ? (
        <FormDialog title="新建模板" eyebrow="PROJECT TEMPLATE · 创建走弹窗" onClose={() => setCreateOpen(false)} wide>
          <p className="context-note">创建后可在下方编辑 structure（服务端校验 stages 为 name+seq 数组）。</p>
          <div className="owner-line">
            <label className="form-field">
              <span>模板名称 *</span>
              <input value={cName} onChange={(e) => setCName(e.target.value)} />
            </label>
            <label className="form-field span-2">
              <span>描述</span>
              <input value={cDesc} onChange={(e) => setCDesc(e.target.value)} />
            </label>
          </div>
          <textarea
            className="template-json"
            rows={10}
            value={cStructure}
            onChange={(e) => setCStructure(e.target.value)}
            aria-label="新建模板 structure"
          />
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button
              className="primary-action"
              disabled={!cName.trim() || mutations.createTemplate.isPending}
              onClick={() => {
                setError(null);
                setNotice(null);
                let parsed: unknown;
                try {
                  parsed = JSON.parse(cStructure);
                } catch {
                  setError("JSON 解析失败，请检查格式。");
                  return;
                }
                mutations.createTemplate.mutate(
                  { name: cName.trim(), description: cDesc.trim() || undefined, structure: parsed as never },
                  {
                    onSuccess: (row) => {
                      setNotice(`模板「${row.name}」已创建。`);
                      setCreateOpen(false);
                      setCName("");
                      setCDesc("");
                      setCStructure(JSON.stringify(TEMPLATE_SKELETON, null, 2));
                      setSelectedId(row.id);
                      setStructureText(JSON.stringify(row.structureJson, null, 2));
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              创建模板（服务端校验）
            </button>
          </div>
        </FormDialog>
      ) : null}
      {notice ? (
        <p className="context-note" role="status">
          {notice}
        </p>
      ) : null}
      <div className="template-grid">
        {templates.data.map((t) => (
          <button
            key={t.id}
            className={`template-card ${selected?.id === t.id ? "selected" : ""}`}
            onClick={() => {
              setSelectedId(t.id);
              setStructureText(JSON.stringify(t.structureJson, null, 2));
            }}
          >
            <strong>{t.name}</strong>
            <p>{t.description}</p>
          </button>
        ))}
      </div>
      {selected ? (
        <section className="grant-apply-form" style={{ marginTop: 16 }}>
          <div className="section-heading">
            <div>
              <span className="section-label">STRUCTURE_JSON · 编辑态</span>
              <h2>{selected.name}</h2>
            </div>
            <button
              className="primary-action"
              disabled={mutations.updateTemplate.isPending}
              onClick={() => {
                setError(null);
                let parsed: unknown;
                try {
                  parsed = JSON.parse(structureText);
                } catch {
                  setError("JSON 解析失败，请检查格式。");
                  return;
                }
                mutations.updateTemplate.mutate(
                  { id: selected.id, name: selected.name, description: selected.description ?? undefined, structureJson: parsed as never },
                  { onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}
            >
              保存模板（服务端校验）
            </button>
          </div>
          <textarea
            className="template-json"
            rows={12}
            value={structureText || JSON.stringify(selected.structureJson, null, 2)}
            onChange={(e) => setStructureText(e.target.value)}
            aria-label="structureJson"
          />
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function FlowRow({ f, onToggle, onDuplicate, onDelete }: { f: { id: string; name: string; versionNo: number; enabled: boolean; bizBinding: string; updatedAt: string; rowVersion: number }; onToggle: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const draft = !f.enabled;
  return (
    <div className="report-row">
      <Link to={`/admin/flows/${f.id}`} style={{ display: "contents", color: "inherit" }}>
        <div>
          <strong>
            <GitBranch size={14} style={{ verticalAlign: "-2px" }} /> {f.name}
            <span className={`badge ${f.enabled ? "badge-health-normal" : "badge-minutes-pending_confirm"}`}>
              V{f.versionNo} · {f.enabled ? "启用中" : "草稿"}
            </span>
          </strong>
          <small>
            绑定业务：{f.bizBinding} · 更新 {f.updatedAt.slice(0, 16).replace("T", " ")}
          </small>
        </div>
      </Link>
      <span className="p9a-row-actions">
        <Link className="text-action" to={`/admin/flows/${f.id}`}>编辑</Link>
        <button type="button" className="text-action" onClick={onToggle}>{f.enabled ? "停用" : "启停"}</button>
        <button type="button" className="text-action" onClick={onDuplicate}>复制为新草稿</button>
        {draft ? <button type="button" className="text-action" onClick={onDelete}>删除</button> : null}
      </span>
    </div>
  );
}

/** G5：/admin 审批流列表分「系统级 / 项目内」两区（flow.list byScope 分区） */
/** 审批流分组列表（arch/14 §11）：固定组「业务审批」+ 自定义表单各组；行操作=编辑/启停/复制草稿/删除（仅草稿） */
function FlowsTab() {
  const flows = useFlowList();
  const flowMut = useFlowMutations();
  const formList = useFormList();
  const [error, setError] = useState<string | null>(null);
  if (flows.isPending || formList.isPending) return <p className="list-note">正在加载流程…</p>;
  if (flows.isError) throw flows.error;
  if (formList.isError) throw formList.error;
  const items = flows.data.items;
  const byGroup = (flows.data as { byGroup?: Array<{ groupName: string; items: typeof items }> }).byGroup
    ?? [{ groupName: "业务审批", items: items.filter((f) => !f.bizBinding.startsWith("custom_form:")) }];
  const projectCount = items.filter((f) => f.scope === "project").length;
  return (
    <div className="preview-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">分组=固定「业务审批」+自定义表单组（arch/14 §11）；行操作含复制草稿/删除（仅草稿）；项目内流程在项目空间管理（{projectCount}）</span>
        <div className="row-ops">
          <Link to="/admin/flows/new?kind=custom" className="primary-action">
            <Plus size={15} />
            新建自定义审批
          </Link>
          <Link to="/admin/flows/new?kind=biz" className="secondary-action">
            <Plus size={15} />
            新建业务流程
          </Link>
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {byGroup.map((g) => (
        <section key={g.groupName} style={{ marginBottom: 14 }}>
          <span className="section-label">{g.groupName}（{g.items.length}）</span>
          <div className="report-list">
            {g.items.map((f) => (
              <FlowRow
                key={f.id}
                f={f}
                onToggle={() => {
                  setError(null);
                  flowMut.disable.mutate(
                    { id: f.id, rowVersion: f.rowVersion },
                    { onSuccess: () => toast.success(f.enabled ? "已停用" : "已启用（草稿件发布请进向导）"), onError: (e) => setError(rootErrorMessage(e)) },
                  );
                }}
                onDuplicate={() => {
                  setError(null);
                  flowMut.duplicateAsDraft.mutate({ id: f.id }, { onSuccess: () => toast.success("已复制为新草稿"), onError: (e) => setError(rootErrorMessage(e)) });
                }}
                onDelete={() => {
                  setError(null);
                  flowMut.deleteDraft.mutate({ id: f.id }, { onSuccess: () => toast.success("草稿已删除"), onError: (e) => setError(rootErrorMessage(e)) });
                }}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ParamsTab() {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const config = useAdminConfig(selectedKey, true);
  const mutations = useAdminMutations();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="preview-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">白名单配置键（setConfig 前后值审计）</span>
      </div>
      <div className="type-chips quality-toolbar" style={{ paddingTop: 0 }}>
        {PARAM_KEYS.map((key) => (
          <button
            key={key}
            className={selectedKey === key ? "tool-toggle active" : "tool-toggle"}
            onClick={() => {
              setSelectedKey(key);
              setDraft("");
            }}
          >
            {key}
          </button>
        ))}
      </div>
      {config.isPending ? <p className="list-note">正在加载配置…</p> : null}
      {config.isError ? <p className="form-error">配置读取失败。</p> : null}
      {config.data ? (
        <section className="grant-apply-form">
          <div className="section-heading">
            <div>
              <span className="section-label">{config.data.key}</span>
              <h2>当前值</h2>
            </div>
          </div>
          <pre className="params-pre">{JSON.stringify(config.data.valueJson, null, 2)}</pre>
          <label className="form-field">
            <span>新值（JSON 对象）*</span>
            <textarea
              rows={4}
              value={draft}
              placeholder='{"dailyMaxMinutes":1440}'
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="primary-action"
            disabled={!draft.trim() || mutations.setConfig.isPending}
            onClick={() => {
              setError(null);
              let parsed: Record<string, unknown>;
              try {
                parsed = JSON.parse(draft) as Record<string, unknown>;
              } catch {
                setError("JSON 解析失败。");
                return;
              }
              mutations.setConfig.mutate(
                { key: config.data.key, value: parsed },
                {
                  onSuccess: () => setDraft(""),
                  onError: (err) => setError(rootErrorMessage(err)),
                },
              );
            }}
          >
            保存配置
          </button>
        </section>
      ) : null}
    </div>
  );
}

function CodesTab() {
  return (
    <div className="preview-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">
          <ShieldCheck size={14} style={{ verticalAlign: "-2px" }} /> 编号规则注册表（只读；前缀由架构基线注册表裁定）
        </span>
      </div>
      <p className="context-note">前缀注册表：MTG/TRV/BUD/FND/EXP/TS/APR/LED/PRJ/TSK/QLT/DEC/RPT/CLT/MTR/CHG/STG/MLS/DLV/RCV/REQ。格式：前缀-年份-五位序号。</p>
    </div>
  );
}
