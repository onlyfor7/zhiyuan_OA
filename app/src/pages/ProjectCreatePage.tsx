import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, X } from "lucide-react";

import { useProjectTemplates } from "../api/project";
import { CONFIDENTIALITY_LABEL } from "../lib/labels";
import { CONFIDENTIALITY_LEVEL } from "@lexflow/shared";
import type { RouterOutputs } from "../lib/trpc";

type Template = RouterOutputs["project"]["listTemplates"][number];

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

/** 项目创建页：模板 + 必填表单（事项选择缺 matter.list 契约，已登记 STATUS 待裁定，补齐前暂停提交） */
export default function ProjectCreatePage() {
  const navigate = useNavigate();
  const templates = useProjectTemplates();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [confidentiality, setConfidentiality] = useState<"internal">("internal");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));

  if (templates.isPending) return <p className="list-note">正在加载项目模板…</p>;
  if (templates.isError) throw templates.error;

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
        <div className="form-field pending-contract">
          <span>所属事项 *</span>
          <div className="pending-box">
            <p className="context-note">
              事项选择需要只读契约 matter.list（当前冻结契约 arch/04 §5 未含），已在 STATUS「偏差与仲裁」登记待架构裁定。
              补齐前创建入口暂停提交，避免猜测或硬编码事项标识。
            </p>
          </div>
        </div>
        <button
          className="primary-action"
          disabled
          title="待 matter.list 契约补齐后开放"
        >
          创建项目（待事项契约）
          <ArrowRight size={16} />
        </button>
      </section>
    </div>
  );
}
