import { useState } from "react";
import { Link } from "react-router";
import { GitBranch, Plus, ShieldCheck } from "lucide-react";

import { useAdminConfig, useAdminMutations, useAdminUsers } from "../../api/admin";
import { useMe } from "../../api/auth";
import { useClientList, useMatterList } from "../../api/reference";
import { useProjectTemplates } from "../../api/project";
import { useFlowList } from "../../api/flow";
import { useRail } from "../../components/shell-rail";
import { rootErrorMessage } from "../../lib/form";
import { CONFIDENTIALITY_LABEL, GLOBAL_ROLE_LABEL } from "../../lib/labels";
import { CONFIG_KEY } from "@lexflow/shared";

const TABS = [
  ["users", "用户与组织"],
  ["clients", "客户与事项"],
  ["templates", "项目模板"],
  ["flows", "审批流"],
  ["params", "系统参数"],
  ["codes", "编号规则"],
] as const;

/** 白名单参数键（CONFIG_KEY 全量展示；编辑逐个 get/set） */
const PARAM_KEYS = Object.values(CONFIG_KEY);

function AdminRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">ADMIN</span>
        <h2>配置中心</h2>
      </div>
      <div className="context-section">
        <div className="section-label">SEPARATION</div>
        <h2>管配置 ≠ 内容权</h2>
        <p className="context-note">sysadmin 管理组织/角色/参数/流程，但不因此获得法律业务内容权（arch/03 §4.5）。全部写操作服务端鉴权+审计。</p>
      </div>
      <div className="assurance">
        <ShieldCheck size={16} />
        <span>创建用户的初始口令仅展示一次，须立即转交。</span>
      </div>
    </aside>
  );
}

/** /admin 配置中心（真实 admin.*；sysadmin 专属，其余角色权限说明门） */
export default function AdminCenterPage() {
  useRail(AdminRail);
  const me = useMe();
  const isSysadmin = (me.data?.globalRoles ?? []).includes("sysadmin");
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("users");

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
          <h1>系统配置中心</h1>
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
      {tab === "users" ? <UsersTab /> : null}
      {tab === "clients" ? <ClientsTab /> : null}
      {tab === "templates" ? <TemplatesTab /> : null}
      {tab === "flows" ? <FlowsTab /> : null}
      {tab === "params" ? <ParamsTab /> : null}
      {tab === "codes" ? <CodesTab /> : null}
    </div>
  );
}

function UsersTab() {
  const users = useAdminUsers(true);
  const mutations = useAdminMutations();
  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roleKey, setRoleKey] = useState("member");
  const [created, setCreated] = useState<{ email: string; initialPassword: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (users.isPending) return <p className="list-note">正在加载用户…</p>;
  if (users.isError) throw users.error;

  return (
    <div className="preview-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">角色列展示当前角色（userList.roles，arch 裁定 04b-②）；× 移除该角色，下方选择器授予；停用=全部会话立即失效</span>
        <button className="primary-action" onClick={() => setShowCreate((v) => !v)}>
          <Plus size={15} />
          创建用户
        </button>
      </div>
      {created ? (
        <div className="pending-box">
          <p className="context-note">
            用户 <strong>{created.email}</strong> 已创建。初始口令（仅显示一次）：
            <code className="mono"> {created.initialPassword}</code> —— 请立即转交并要求首次登录改密。
          </p>
          <button className="text-action" onClick={() => setCreated(null)}>
            我已保存，关闭
          </button>
        </div>
      ) : null}
      {showCreate ? (
        <div className="grant-apply-form">
          <div className="owner-line">
            <label className="form-field">
              <span>姓名 *</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="form-field">
              <span>邮箱 *</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="form-field">
              <span>初始角色 *</span>
              <select value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
                {Object.entries(GLOBAL_ROLE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setShowCreate(false)}>
              取消
            </button>
            <button
              className="primary-action"
              disabled={!email.trim() || !name.trim() || mutations.createUser.isPending}
              onClick={() => {
                setError(null);
                mutations.createUser.mutate(
                  { email: email.trim(), name: name.trim(), roleKey },
                  {
                    onSuccess: (r) => {
                      setCreated({ email: r.email, initialPassword: r.initialPassword });
                      setShowCreate(false);
                      setEmail("");
                      setName("");
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              创建（初始随机口令）
            </button>
          </div>
        </div>
      ) : null}
      <div className="grant-table">
        <div className="grant-head">
          <span>用户</span>
          <span>部门</span>
          <span>角色</span>
          <span>角色操作</span>
          <span>状态</span>
          <span />
        </div>
        {users.data.map((u) => (
          <div className={`grant-row ${u.status === "disabled" ? "revoked" : ""}`} key={u.id}>
            <div>
              <span className="mini-avatar">{u.name.slice(0, 1)}</span>
              <span>
                <strong>{u.name}</strong>
                <small>{u.email}</small>
              </span>
            </div>
            <span>{u.orgUnitName ?? "—"}</span>
            <span className="role-chips">
              {u.roles.length === 0
                ? "—"
                : u.roles.map((r) => (
                    <button
                      key={r}
                      className="role-chip"
                      title={`移除角色：${GLOBAL_ROLE_LABEL[r] ?? r}`}
                      disabled={mutations.unassignRole.isPending}
                      onClick={() => {
                        setError(null);
                        mutations.unassignRole.mutate({ userId: u.id, roleKey: r }, { onError: (err) => setError(rootErrorMessage(err)) });
                      }}
                    >
                      {GLOBAL_ROLE_LABEL[r] ?? r} ×
                    </button>
                  ))}
            </span>
            <RoleOps userId={u.id} onError={(msg) => setError(msg)} />
            <span className={u.status === "active" ? "grant-status" : "log-denied"}>
              {u.status === "active" ? "在职" : "已停用"}
            </span>
            <button
              className="text-action"
              disabled={u.status === "disabled" ? mutations.enableUser.isPending : mutations.disableUser.isPending}
              onClick={() => {
                setError(null);
                const fn = u.status === "disabled" ? mutations.enableUser : mutations.disableUser;
                fn.mutate({ userId: u.id }, { onError: (err) => setError(rootErrorMessage(err)) });
              }}
            >
              {u.status === "active" ? "停用" : "启用"}
            </button>
          </div>
        ))}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function RoleOps({ userId, onError }: { userId: string; onError: (msg: string) => void }) {
  const mutations = useAdminMutations();
  const [roleKey, setRoleKey] = useState("member");
  return (
    <span className="revoke-inline">
      <select value={roleKey} aria-label="角色" onChange={(e) => setRoleKey(e.target.value)}>
        {Object.entries(GLOBAL_ROLE_LABEL).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <button
        className="secondary-action"
        disabled={mutations.assignRole.isPending || mutations.unassignRole.isPending}
        onClick={() =>
          mutations.assignRole.mutate({ userId, roleKey }, { onError: (err) => onError(rootErrorMessage(err)) })
        }
      >
        授予
      </button>
      <button
        className="secondary-action"
        disabled={mutations.assignRole.isPending || mutations.unassignRole.isPending}
        onClick={() =>
          mutations.unassignRole.mutate({ userId, roleKey }, { onError: (err) => onError(rootErrorMessage(err)) })
        }
      >
        移除
      </button>
    </span>
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
  const [error, setError] = useState<string | null>(null);

  if (clients.isPending || matters.isPending) return <p className="list-note">正在加载…</p>;
  if (clients.isError) throw clients.error;
  if (matters.isError) throw matters.error;

  return (
    <div className="preview-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">客户/事项（元数据管理；停用后从参照端点消失）</span>
      </div>
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
                onSuccess: () => setClientName(""),
                onError: (err) => setError(rootErrorMessage(err)),
              },
            );
          }}
        >
          创建客户
        </button>
      </div>
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
      <div className="owner-line" style={{ marginTop: 22 }}>
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
                },
                onError: (err) => setError(rootErrorMessage(err)),
              },
            );
          }}
        >
          创建事项
        </button>
      </div>
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
        <section className="grant-apply-form" style={{ marginTop: 12 }}>
          <div className="section-heading">
            <div>
              <span className="section-label">NEW TEMPLATE</span>
              <h2>新建模板（创建后可在下方继续编辑结构）</h2>
            </div>
          </div>
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
        </section>
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

function FlowsTab() {
  const flows = useFlowList();
  if (flows.isPending) return <p className="list-note">正在加载流程…</p>;
  if (flows.isError) throw flows.error;
  return (
    <div className="preview-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">流程定义（同名称恰一个启用版本；既有种子策略已迁移为默认流程）</span>
        <Link to="/admin/flows/new" className="primary-action">
          <Plus size={15} />
          新建流程
        </Link>
      </div>
      <div className="report-list">
        {flows.data.map((f) => (
          <Link className="report-row" key={f.id} to={`/admin/flows/${f.id}`}>
            <div>
              <strong>
                <GitBranch size={14} style={{ verticalAlign: "-2px" }} /> {f.name}
                <span className={`badge ${f.enabled ? "badge-health-normal" : ""}`}>
                  V{f.versionNo} · {f.enabled ? "启用中" : "草稿"}
                </span>
              </strong>
              <small>
                绑定业务：{f.bizBinding} · 范围：{f.scope}
                {f.projectId ? ` · 项目 ${f.projectId.slice(0, 8)}` : ""} · 更新 {f.updatedAt.slice(0, 16).replace("T", " ")}
              </small>
            </div>
            <span className="text-action">打开设计器</span>
          </Link>
        ))}
      </div>
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
