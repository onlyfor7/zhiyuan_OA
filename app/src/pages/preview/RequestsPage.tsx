import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowRight, ChevronRight, Plus } from "lucide-react";

import { PreviewNote } from "./PreviewNote";
import {
  previewRequestTypeLabel,
  previewRequests,
  yuan,
  type PreviewRequest,
} from "./preview-data";

/** /preview/requests 通用申请单（固定核心字段，不做自由表单设计器） */
export default function RequestsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <div className="screen preview-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">GENERIC REQUEST</span>
          <h1>通用申请单</h1>
          <p>请假/采购/用章等通用审批的承载对象（走统一引擎，全局流程）。</p>
        </div>
        <button className="primary-action" onClick={() => setCreateOpen((v) => !v)}>
          <Plus size={15} />
          发起申请
        </button>
      </div>
      {createOpen ? <RequestCreateForm onClose={() => setCreateOpen(false)} /> : null}
      <div className="report-list">
        {previewRequests.map((r) => (
          <Link className="report-row" key={r.id} to={`/preview/requests/${r.id}`}>
            <div>
              <strong>
                <span className="badge badge-minutes-pending_confirm">
                  {previewRequestTypeLabel[r.requestType]}
                </span>{" "}
                {r.title}
              </strong>
              <small>
                {r.code} · 申请人 {r.applicant} · 提交 {r.submittedAt}
                {r.amountCents != null ? ` · 金额 ${yuan(r.amountCents)} 元` : ""}
              </small>
            </div>
            <StatusBadge status={r.status} />
            <span className="text-action">
              审批进度
              <ChevronRight size={14} />
            </span>
          </Link>
        ))}
      </div>
      <PreviewNote>申请单提交时引擎按绑定流程解析条件并展开步骤；详情页节点图标注当前位置。</PreviewNote>
    </div>
  );
}

function StatusBadge({ status }: { status: PreviewRequest["status"] }) {
  const label: Record<string, string> = {
    draft: "草稿",
    pending_approval: "审批中",
    approved: "已通过",
    rejected: "已驳回",
    withdrawn: "已撤回",
  };
  return (
    <span
      className={`badge badge-travel-${
        status === "approved" ? "approved" : status === "rejected" ? "rejected" : "pending_approval"
      }`}
    >
      {label[status]}
    </span>
  );
}

function RequestCreateForm({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState("leave");
  return (
    <div className="grant-apply-form">
      <div className="section-heading">
        <div>
          <span className="section-label">NEW REQUEST</span>
          <h2>发起申请（固定核心字段）</h2>
        </div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="owner-line">
        <label className="form-field">
          <span>申请类型 *</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(previewRequestTypeLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field span-2">
          <span>标题 *</span>
          <input placeholder="一句话说明申请事项" />
        </label>
      </div>
      <label className="form-field">
        <span>申请理由 *</span>
        <textarea rows={3} />
      </label>
      <div className="owner-line">
        <label className="form-field">
          <span>开始日期{type === "leave" ? " *" : ""}</span>
          <input type="date" />
        </label>
        <label className="form-field">
          <span>结束日期{type === "leave" ? " *" : ""}</span>
          <input type="date" />
        </label>
        <label className="form-field">
          <span>金额（元，{type === "procurement" ? "必填" : "选填"}）</span>
          <input type="number" min="0" step="0.01" />
        </label>
      </div>
      <label className="form-field">
        <span>附件（受控上传，继承申请权限）</span>
        <input type="file" />
      </label>
      <PreviewNote>固定核心字段：标题/理由/起止/金额/附件——不做自由表单设计器（arch/09 §3.2 裁定）。</PreviewNote>
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onClose}>
          取消
        </button>
        <button
          className="primary-action"
          onClick={() => window.alert("原型预览：界面为静态示意，操作不会被提交。")}
        >
          提交申请
          <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

/** 详情页：审批进度节点图（当前位置高亮） */
export function RequestDetailPage() {
  const { id } = useParams();
  const request = previewRequests.find((r) => r.id === id) ?? previewRequests[0];
  return (
    <div className="screen preview-screen">
      <div className="project-title-row">
        <div>
          <div className="breadcrumb">
            <Link to="/preview/requests">通用申请</Link>
            <ChevronRight size={13} />
            <span>{request.code}</span>
          </div>
          <h1>
            <span className="badge badge-minutes-pending_confirm">
              {previewRequestTypeLabel[request.requestType]}
            </span>{" "}
            {request.title}
          </h1>
          <p>
            申请人 {request.applicant} · 提交 {request.submittedAt}
            {request.startOn ? ` · ${request.startOn} ~ ${request.endOn}` : ""}
            {request.amountCents != null ? ` · 金额 ${yuan(request.amountCents)} 元` : ""}
          </p>
        </div>
        <StatusBadge status={request.status} />
      </div>
      <div className="issue-section">
        <span>申请理由</span>
        <p>{request.reason}</p>
      </div>
      <section className="progress-graph-section">
        <span className="section-label">APPROVAL PROGRESS · 审批进度节点图（当前位置高亮）</span>
        <div className="progress-graph">
          {request.progress.map((step, i) => (
            <div className="progress-step-wrap" key={step.nodeId}>
              <div className={`progress-step state-${step.state}`}>
                {step.state === "done" ? "✓" : step.state === "rejected" ? "✕" : step.state === "current" ? "●" : "○"}
                <strong>{step.label}</strong>
                <small>
                  {step.actor ? `${step.actor}` : ""}
                  {step.comment ? ` · ${step.comment}` : ""}
                </small>
              </div>
              {i < request.progress.length - 1 ? <i className="progress-link" aria-hidden="true" /> : null}
            </div>
          ))}
        </div>
        <PreviewNote>
          节点图与流程定义一致：条件节点按表单快照求值结果走「是/否」分支；当前位置由引擎 currentStepSeq 映射。
        </PreviewNote>
      </section>
    </div>
  );
}
