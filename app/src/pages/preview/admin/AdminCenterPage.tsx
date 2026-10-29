import { useState } from "react";
import { Link } from "react-router";
import { GitBranch, Plus, ShieldCheck } from "lucide-react";

import { PreviewNote } from "../PreviewNote";
import {
  previewClients,
  previewCodeRules,
  previewConfigs,
  previewFlows,
  previewMatters,
  previewOrgUnits,
  previewConfidentialityOptions,
  previewRoleOptions,
  previewTemplates,
  previewUsers,
} from "../preview-data";
import { CONFIDENTIALITY_LABEL } from "../../../lib/labels";

const TABS = [
  ["users", "用户与组织"],
  ["clients", "客户与事项"],
  ["templates", "项目模板"],
  ["flows", "审批流"],
  ["params", "系统参数"],
  ["codes", "编号规则"],
] as const;

/** /preview/admin 配置中心六页签（arch/09 §4；sysadmin 视角高保真示意） */
export default function AdminCenterPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("users");
  return (
    <div className="screen preview-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">ADMIN CENTER</span>
          <h1>系统配置中心</h1>
          <p>用户/组织、客户/事项、模板、审批流、参数与编号规则（sysadmin 专属，管配置不获得业务内容权）。</p>
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

/** 原型纪律：所有「提交类」动作只给明示的预览提示，绝不假成功 */
function previewOnlyNotice() {
  window.alert("原型预览：界面为静态示意，操作不会被提交。");
}

function UsersTab() {
  const [showCreate, setShowCreate] = useState(false);
  return (
    <div className="preview-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">用户列表（停用即时失效；创建用户为初始随机口令 + 首次登录强制改密）</span>
        <button className="primary-action" onClick={() => setShowCreate((v) => !v)}>
          <Plus size={15} />
          创建用户
        </button>
      </div>
      {showCreate ? (
        <div className="grant-apply-form">
          <div className="owner-line">
            <label className="form-field">
              <span>姓名 *</span>
              <input placeholder="如：钱安" />
            </label>
            <label className="form-field">
              <span>邮箱 *</span>
              <input placeholder="name@lexflow.demo" />
            </label>
            <label className="form-field">
              <span>部门 *</span>
              <select defaultValue={previewOrgUnits[0]}>
                {previewOrgUnits.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-field">
            <span>全局角色 *（可多选）</span>
            <div className="check-grid">
              {previewRoleOptions.map(([value, label]) => (
                <label className="check-field compact" key={value}>
                  <input type="checkbox" />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="form-field">
            <span>授权密级上限</span>
            <div className="check-grid">
              {previewConfidentialityOptions.map(([value, label]) => (
                <label className="check-field compact" key={value}>
                  <input type="radio" name="cap" defaultChecked={value === "internal"} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <PreviewNote>创建成功后系统生成初始随机口令并要求首次登录改密（示意）。</PreviewNote>
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setShowCreate(false)}>
              取消
            </button>
            <button className="primary-action" onClick={previewOnlyNotice}>
              创建用户
            </button>
          </div>
        </div>
      ) : null}
      <div className="grant-table">
        <div className="grant-head">
          <span>用户</span>
          <span>部门</span>
          <span>全局角色</span>
          <span>密级上限</span>
          <span>状态</span>
          <span />
        </div>
        {previewUsers.map((u) => (
          <div className={`grant-row ${u.status === "disabled" ? "revoked" : ""}`} key={u.id}>
            <div>
              <span className="mini-avatar">{u.name.slice(0, 1)}</span>
              <span>
                <strong>{u.name}</strong>
                <small>{u.email}</small>
              </span>
            </div>
            <span>{u.orgUnit}</span>
            <span>
              {u.globalRoles
                .map((r) => previewRoleOptions.find(([v]) => v === r)?.[1] ?? r)
                .join("、")}
            </span>
            <span>{CONFIDENTIALITY_LABEL[u.confidentialityCap as never] ?? u.confidentialityCap}</span>
            <span className={u.status === "active" ? "grant-status" : "log-denied"}>
              {u.status === "active" ? "在职" : "已停用"}
            </span>
            <button className="text-action" onClick={previewOnlyNotice}>
              {u.status === "active" ? "停用" : "启用"}
            </button>
          </div>
        ))}
      </div>
      <PreviewNote>示意：角色勾选即 assignRole/unassignRole（服务端鉴权+审计）；停用=全部会话立即失效。</PreviewNote>
    </div>
  );
}

function ClientsTab() {
  return (
    <div className="preview-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">客户（元数据管理，不含业务内容）</span>
        <button className="primary-action" onClick={previewOnlyNotice}>
          <Plus size={15} />
          新建客户
        </button>
      </div>
      <div className="grant-table">
        <div className="grant-head">
          <span>客户</span>
          <span>密级</span>
          <span>事项数</span>
          <span>状态</span>
          <span />
        </div>
        {previewClients.map((c) => (
          <div className={`grant-row ${c.status === "disabled" ? "revoked" : ""}`} key={c.id}>
            <div>
              <strong>{c.name}</strong>
              <small>{c.code}</small>
            </div>
            <span>{CONFIDENTIALITY_LABEL[c.confidentialityLevel as never]}</span>
            <span>{c.matterCount}</span>
            <span className={c.status === "active" ? "grant-status" : "log-denied"}>
              {c.status === "active" ? "正常" : "已停用"}
            </span>
            <button className="text-action" onClick={previewOnlyNotice}>
              编辑
            </button>
          </div>
        ))}
      </div>
      <div className="quality-toolbar" style={{ marginTop: 22 }}>
        <span className="toolbar-hint">事项（code 唯一；建后立即可用于立项）</span>
        <button className="primary-action" onClick={previewOnlyNotice}>
          <Plus size={15} />
          新建事项
        </button>
      </div>
      <div className="grant-table">
        <div className="grant-head">
          <span>事项</span>
          <span>客户</span>
          <span>类型</span>
          <span>密级</span>
          <span />
        </div>
        {previewMatters.map((m) => (
          <div className="grant-row" key={m.id}>
            <div>
              <strong>{m.name}</strong>
              <small>{m.code}</small>
            </div>
            <span>{m.clientName}</span>
            <span>{m.type}</span>
            <span>{CONFIDENTIALITY_LABEL[m.confidentialityLevel as never]}</span>
            <button className="text-action" onClick={previewOnlyNotice}>
              编辑
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplatesTab() {
  const [selectedId, setSelectedId] = useState(previewTemplates[0].id);
  const tpl = previewTemplates.find((t) => t.id === selectedId) ?? previewTemplates[0];
  return (
    <div className="preview-tab-body">
      <div className="template-grid">
        {previewTemplates.map((t) => (
          <button
            key={t.id}
            className={`template-card ${t.id === selectedId ? "selected" : ""}`}
            onClick={() => setSelectedId(t.id)}
          >
            <strong>{t.name}</strong>
            <p>{t.description}</p>
          </button>
        ))}
      </div>
      <section className="grant-apply-form" style={{ marginTop: 16 }}>
        <div className="section-heading">
          <div>
            <span className="section-label">STRUCTURE_JSON · 编辑态</span>
            <h2>{tpl.name}</h2>
          </div>
          <button className="primary-action" onClick={previewOnlyNotice}>
            保存模板
          </button>
        </div>
        <div className="owner-line">
          <div className="form-field">
            <span>阶段（名称 + 默认天数）</span>
            {tpl.stages.map((s, i) => (
              <div className="measure-row" key={i}>
                <input defaultValue={s.name} aria-label="阶段名称" />
                <input type="number" defaultValue={s.days} aria-label="默认天数" min="1" />
                <button className="icon-button" aria-label="删除阶段" onClick={previewOnlyNotice}>
                  ×
                </button>
              </div>
            ))}
            <button className="secondary-action" onClick={previewOnlyNotice}>
              添加阶段
            </button>
          </div>
          <div className="form-field">
            <span>检查项</span>
            {tpl.checkItems.map((c, i) => (
              <div className="category-row" key={i}>
                <label className="check-field compact">
                  <input type="checkbox" defaultChecked={c.required} />
                  必查
                </label>
                <input defaultValue={c.name} aria-label="检查项名称" style={{ flex: 1 }} />
              </div>
            ))}
            <button className="secondary-action" onClick={previewOnlyNotice}>
              添加检查项
            </button>
          </div>
        </div>
        <PreviewNote>structure_json 保存时服务端校验（阶段名非空、天数为正整数）。</PreviewNote>
      </section>
    </div>
  );
}

function FlowsTab() {
  return (
    <div className="preview-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">流程定义（每名称恰一个启用版本；既有种子策略将迁移为默认流程）</span>
        <Link to="/preview/admin/flows/new" className="primary-action">
          <Plus size={15} />
          新建流程
        </Link>
      </div>
      <div className="report-list">
        {previewFlows.map((f) => (
          <Link className="report-row" key={f.id} to={`/preview/admin/flows/${f.id}`}>
            <div>
              <strong>
                <GitBranch size={14} style={{ verticalAlign: "-2px" }} /> {f.name}
                <span className="badge badge-health-normal">V{f.versionNo} · 启用中</span>
              </strong>
              <small>
                绑定业务：{f.bizBinding} · 范围：{f.scope === "global" ? "全局" : "项目"} · 更新 {f.updatedAt}
              </small>
            </div>
            <span className="text-action">打开设计器</span>
          </Link>
        ))}
      </div>
      <PreviewNote>
        设计器输出编译为既有引擎步骤（不另建引擎）；无自定义流程的业务使用默认流程，既有审批不回归。
      </PreviewNote>
    </div>
  );
}

function ParamsTab() {
  return (
    <div className="preview-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">白名单配置键（setConfig 前后值审计；阈值改配置即生效）</span>
      </div>
      <div className="grant-table">
        <div className="grant-head">
          <span>配置键</span>
          <span>说明</span>
          <span>当前值（JSON）</span>
          <span />
        </div>
        {previewConfigs.map((c) => (
          <div className="grant-row params-row" key={c.key}>
            <div>
              <strong>{c.key}</strong>
              <small>{c.label}</small>
            </div>
            <span className="muted-label">{c.note}</span>
            <span className="mono params-value">{c.valueJson}</span>
            <button className="text-action" onClick={previewOnlyNotice}>
              修改
            </button>
          </div>
        ))}
      </div>
      <PreviewNote>
        通用申请类型等取值可在配置中扩充；类别默认值以配置种子为准（arch/07 裁定口径一致）。
      </PreviewNote>
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
      <div className="code-rule-grid">
        {previewCodeRules.map(([prefix, name]) => (
          <div className="code-rule" key={prefix}>
            <span className="mono">{prefix}</span>
            <strong>{name}</strong>
          </div>
        ))}
      </div>
      <PreviewNote>格式：前缀-年份-五位序号（如 RCV-2026-00001），由服务端序列表事务内生成。</PreviewNote>
    </div>
  );
}
