import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, X } from "lucide-react";
import { CONFIDENTIALITY_LEVEL } from "@lexflow/shared";

import { useClientList, useMatterList } from "../api/reference";
import { useCreateProject, useProjectTemplates } from "../api/project";
import { useMe } from "../api/auth";
import { rootErrorMessage } from "../lib/form";
import { CONFIDENTIALITY_LABEL } from "../lib/labels";
import type { RouterOutputs } from "../lib/trpc";

type Template = RouterOutputs["project"]["listTemplates"][number];

/** v1.2 冻结语义：project.create 要求 project.manage（partner/sysadmin） */
function useCanCreateProject(): boolean {
  const me = useMe();
  const roles = me.data?.globalRoles ?? [];
  return roles.includes("partner") || roles.includes("sysadmin");
}

function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  template: Template;
  selected: boolean;
  onSelect: () => void;
}) {
  const structure = (template.structureJson ?? {}) as {
    stages?: { name: string; seq: number }[];
    checkItems?: { name: string }[];
  };
  return (
    <button className={`template-card ${selected ? "selected" : ""}`} onClick={onSelect}>
      <strong>{template.name}</strong>
      <p>{template.description}</p>
      <small>
        {(structure.stages ?? []).map((s) => s.name).join(" → ") || "无阶段"}
        {structure.checkItems?.length ? ` · 检查项 ${structure.checkItems.length}` : ""}
      </small>
    </button>
  );
}

/** 项目创建页：模板 + 客户/事项级联选择 + 必填表单；权限门按角色降级（arch/02 §4.1 v1.2） */
export default function ProjectCreatePage() {
  const navigate = useNavigate();
  const me = useMe();
  const templates = useProjectTemplates();
  const create = useCreateProject();
  const canCreate = useCanCreateProject();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [confidentiality, setConfidentiality] = useState<"internal">("internal");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [clientKeyword, setClientKeyword] = useState("");
  const [clientId, setClientId] = useState("");
  const [matterKeyword, setMatterKeyword] = useState("");
  const [matterId, setMatterId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const clients = useClientList(clientKeyword);
  const matters = useMatterList(matterKeyword, clientId || undefined);

  if (templates.isPending || me.isPending) return <p className="list-note">正在加载…</p>;
  if (templates.isError) throw templates.error;
  if (me.isError) throw me.error;

  // 角色降级：无 project.manage 权限（partner/sysadmin）时不渲染表单（pm 直连服务端会 404，属预期）
  if (!canCreate) {
    return (
      <div className="screen project-create-screen">
        <div className="screen-heading">
          <div>
            <span className="eyebrow">NEW PROJECT</span>
            <h1>创建项目</h1>
          </div>
        </div>
        <div className="pending-box">
          <p className="context-note">
            当前账号（{me.data.user.name}）无立项权限：project.create 要求 partner 或系统管理员角色
            （arch/02 §4.1 v1.2 冻结语义）。立项权归属属律所确认项（§18）。如需立项请联系合伙人或系统管理员。
          </p>
        </div>
        <div className="drawer-actions" style={{ justifyContent: "flex-start", marginTop: 16 }}>
          <button className="secondary-action" onClick={() => navigate("/projects")}>
            返回项目列表
          </button>
        </div>
      </div>
    );
  }

  const canSubmit = templateId && name.trim() && startDate && matterId;

  return (
    <div className="screen project-create-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">NEW PROJECT</span>
          <h1>创建项目</h1>
          <p>选择模板后自动生成阶段、基线计划、检查清单与十一档案目录（A1）。</p>
        </div>
        <button className="secondary-action" onClick={() => navigate("/projects")}>
          <X size={15} />
          取消
        </button>
      </div>
      <section className="template-grid">
        {templates.data.map((t) => (
          <TemplateCard key={t.id} template={t} selected={templateId === t.id} onSelect={() => setTemplateId(t.id)} />
        ))}
      </section>
      <section className="create-form">
        <label className="form-field">
          <span>项目名称 *</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：某某公司合同纠纷代理·一审" />
        </label>
        <div className="owner-line">
          <label className="form-field">
            <span>项目类型</span>
            <input value={type} onChange={(e) => setType(e.target.value)} placeholder="如：诉讼 / 常法 / 并购" />
          </label>
          <label className="form-field">
            <span>密级 *</span>
            <select value={confidentiality} onChange={(e) => setConfidentiality(e.target.value as "internal")}>
              {CONFIDENTIALITY_LEVEL.map((c) => (
                <option key={c} value={c}>
                  {CONFIDENTIALITY_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>开始日期 *</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
        </div>
        <div className="owner-line">
          <label className="form-field">
            <span>客户 *</span>
            <div className="user-picker">
              <div className="inline-search">
                <input
                  value={clientKeyword}
                  placeholder="搜索客户名称或编号"
                  aria-label="搜索客户"
                  onChange={(e) => setClientKeyword(e.target.value)}
                />
              </div>
              <select
                value={clientId}
                aria-label="选择客户"
                onChange={(e) => {
                  setClientId(e.target.value);
                  setMatterId("");
                }}
              >
                <option value="">选择客户</option>
                {(clients.data?.items ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.code}
                  </option>
                ))}
              </select>
            </div>
          </label>
          <label className="form-field">
            <span>所属事项 *{clientId ? "（已按客户过滤）" : ""}</span>
            <div className="user-picker">
              <div className="inline-search">
                <input
                  value={matterKeyword}
                  placeholder="搜索事项名称或编号"
                  aria-label="搜索事项"
                  onChange={(e) => setMatterKeyword(e.target.value)}
                />
              </div>
              <select
                value={matterId}
                aria-label="选择事项"
                onChange={(e) => setMatterId(e.target.value)}
              >
                <option value="">选择事项</option>
                {(matters.data?.items ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.code}
                    {m.clientName ? `（${m.clientName}）` : ""}
                  </option>
                ))}
              </select>
            </div>
          </label>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="primary-action"
          disabled={!canSubmit || create.isPending}
          onClick={() => {
            setError(null);
            create.mutate(
              {
                templateId: templateId!,
                matterId,
                name: name.trim(),
                type: type.trim() || undefined,
                confidentialityLevel: confidentiality,
                startDate,
              },
              {
                onSuccess: (result) => navigate(`/projects/${result.id}/overview`),
                onError: (err) => setError(rootErrorMessage(err)),
              },
            );
          }}
        >
          {create.isPending ? "创建中…" : "创建项目"}
          <ArrowRight size={16} />
        </button>
        <p className="context-note" style={{ marginTop: 10 }}>
          创建成功后将直接进入项目空间；创建人自动成为项目负责人成员。
        </p>
      </section>
    </div>
  );
}
