import { useState } from "react";
import { BackButton } from "../components/feedback";
import { HelpIcon } from "../components/HelpIcon";
import { Link, useParams } from "react-router";
import { ArrowRight, ChevronRight, Plus } from "lucide-react";

import { useApproval } from "../api/approval";
import { useRequest, useRequestList, useRequestMutations, useRequestTypes } from "../api/generic-request";
import { useForm, useFormPublicList } from "../api/forms";
import type { FormFieldDef } from "@lexflow/shared";
import { FormFieldControl, FormReadonlyView, type FormPayload } from "./flows/form-render";
import { useMe } from "../api/auth";
import { newIdempotencyKey, rootErrorMessage } from "../lib/form";
import { ListSkeleton } from "../components/feedback";
import { toast } from "sonner";
import "../lib/form";
import { formatYuan } from "../api/reference";
import { FlowProgressGraph } from "../components/FlowProgressGraph";
import { stepFlagsFrom } from "../lib/flow-step-flags";
import { FormDialog } from "../components/FormDialog";
import { UserPicker } from "../components/UserPicker";

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  pending_approval: "审批中",
  approved: "已通过",
  rejected: "已驳回",
  withdrawn: "已撤回",
};

/** /requests 通用申请单（真实 genericRequest.*） */
export default function RequestsPage() {
  const me = useMe();
  const isPrivileged = (me.data?.globalRoles ?? []).includes("partner") || (me.data?.globalRoles ?? []).includes("sysadmin");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [typeFilter, setTypeFilter] = useState("");
  const [limit, setLimit] = useState(20);
  const list = useRequestList({ ...(scope === "mine" || !isPrivileged ? { mine: true } : {}), limit });
  const types = useRequestTypes();
  const typeItems = types.data?.items ?? [];
  const typeLabel = (key: string) => typeItems.find((i) => i.key === key)?.label ?? key;
  const [createOpen, setCreateOpen] = useState(false);

  if (list.isPending) return <ListSkeleton rows={5} />;
  if (list.isError) throw list.error;
  const items = list.data.items.filter((r) => !typeFilter || r.requestType === typeFilter);

  return (
    <div className="screen requests-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">GENERIC REQUEST</span>
          <h1 aria-label="通用申请单">
            通用申请单
            <HelpIcon pageKey="requests" />
          </h1>
          <p>请假/采购/用章等通用审批（统一引擎 + 自定义流程节点图）。</p>
        </div>
        <button className="primary-action" onClick={() => setCreateOpen((v) => !v)}>
          <Plus size={15} />
          发起申请
        </button>
      </div>
      <div className="quality-toolbar">
        {isPrivileged ? (
          <div className="audit-tabs inline-tabs">
            <button className={scope === "mine" ? "active" : ""} onClick={() => setScope("mine")}>
              我的
            </button>
            <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>
              全部
            </button>
          </div>
        ) : null}
        <select value={typeFilter} aria-label="申请类型" onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">全部类型</option>
          {typeItems.map((i) => (
            <option key={i.key} value={i.key}>
              {i.label}
            </option>
          ))}
        </select>
        <span>{items.length} 单</span>
      </div>
      {createOpen ? (
        <FormDialog title="发起申请单" eyebrow="GENERIC REQUEST · 创建走弹窗" onClose={() => setCreateOpen(false)}>
          <RequestCreateForm onDone={() => setCreateOpen(false)} />
        </FormDialog>
      ) : null}
      <div className="report-list">
        {items.length === 0 ? (
          <div className="empty-state">
            <strong>暂无申请单</strong>
            <p>点击「发起申请」提交请假/采购/用章等申请。</p>
          </div>
        ) : (
          items.map((r) => (
            <Link className="report-row" key={r.id} to={`/requests/${r.id}`}>
              <div>
                <strong>
                  <span className="badge badge-minutes-pending_confirm">{typeLabel(r.requestType)}</span>{" "}
                  {r.title}
                </strong>
                <small>
                  {r.code} · 提交 {r.createdAt.slice(0, 16).replace("T", " ")}
                  {r.amountCents != null ? ` · 金额 ${formatYuan(r.amountCents)} 元` : ""}
                </small>
              </div>
              <span
                className={`badge badge-travel-${
                  r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : "pending_approval"
                }`}
              >
                {STATUS_LABEL[r.status]}
              </span>
              <span className="text-action">
                审批进度
                <ChevronRight size={14} />
              </span>
            </Link>
          ))
        )}
        {items.length >= limit ? (
          <button className="secondary-action" disabled={list.isFetching} onClick={() => setLimit((l) => l + 20)}>
            {list.isFetching ? "加载中…" : "加载更多"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RequestCreateForm({ onDone }: { onDone: () => void }) {
  const mutations = useRequestMutations();
  const types = useRequestTypes();
  const typeItems = types.data?.items ?? [];
  const publicForms = useFormPublicList();
  const [requestType, setRequestType] = useState("leave");
  const [payload, setPayload] = useState<FormPayload>({});
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [startOn, setStartOn] = useState("");
  const [endOn, setEndOn] = useState("");
  const [amountYuan, setAmountYuan] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isCfType = requestType.startsWith("CF-");

  return (
    <div className="grant-apply-form">
      <div className="section-heading">
        <div>
          <span className="section-label">NEW REQUEST</span>
          <h2>发起申请（固定核心字段）</h2>
        </div>
        <button className="icon-button" aria-label="关闭" onClick={onDone}>
          ×
        </button>
      </div>
      <div className="owner-line">
        <label className="form-field">
          <span>申请类型 *</span>
          <select value={requestType} onChange={(e) => { setRequestType(e.target.value); setPayload({}); }}>
            {typeItems.map((i) => (
              <option key={i.key} value={i.key}>
                {i.label}
              </option>
            ))}
            {(publicForms.data ?? []).length > 0 ? (
              <optgroup label="自定义审批">
                {(publicForms.data ?? []).map((f) => (
                  <option key={f.code} value={f.code}>{f.name}</option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        <label className="form-field span-2">
          <span>标题 *</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <label className="form-field">
        <span>申请理由 *</span>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="owner-line">
        <label className="form-field">
          <span>开始日期{requestType === "leave" ? " *" : ""}</span>
          <input type="date" value={startOn} onChange={(e) => setStartOn(e.target.value)} />
        </label>
        <label className="form-field">
          <span>结束日期{requestType === "leave" ? " *" : ""}</span>
          <input type="date" value={endOn} onChange={(e) => setEndOn(e.target.value)} />
        </label>
        <label className="form-field">
          <span>金额（元，{requestType === "procurement" ? "必填" : "选填"}）</span>
          <input type="number" min="0" step="0.01" value={amountYuan} onChange={(e) => setAmountYuan(e.target.value)} />
        </label>
      </div>
      {isCfType ? <CustomFormFields requestType={requestType} payload={payload} onChange={setPayload} /> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onDone}>
          取消
        </button>
        <button
          className="primary-action"
          disabled={!title.trim() || !reason.trim() || mutations.create.isPending}
          onClick={() => {
            setError(null);
            const amountCents = amountYuan ? Math.round(Number(amountYuan) * 100) : null;
            mutations.create.mutate(
              {
                requestType,
                title: title.trim(),
                reason: reason.trim(),
                startOn: startOn || undefined,
                endOn: endOn || undefined,
                amountCents: isCfType ? null : amountCents && amountCents > 0 ? amountCents : null,
                ...(isCfType ? { payload } : {}),
              },
              {
                onSuccess: onDone,
                onError: (err) => setError(rootErrorMessage(err)),
              },
            );
          }}
        >
          保存草稿
          <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

/** 详情：自定义表单 payload 按 form_schema（快照 form_version）只读渲染（20-03-G3：schema 经 getById 读取，非管理角色降级原始键值） */
function RequestPayloadView({ formId, payload }: { formId: string | null; payload: FormPayload }) {
  const form = useForm(formId);
  const schema = (form.data?.formSchema as { fields?: FormFieldDef[] } | null)?.fields ?? null;
  if (!schema) {
    return (
      <div className="context-note" style={{ marginTop: 8 }}>
        自定义表单字段（快照）：
        {Object.entries(payload).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("；")}
        （表单定义读取受限，接口缺口登记 20-03-G3）
      </div>
    );
  }
  return (
    <section style={{ marginTop: 10 }}>
      <span className="section-label">表单内容（快照 v{(form.data as { formVersion?: number } | undefined)?.formVersion ?? "—"}）</span>
      <FormReadonlyView fields={schema} payload={payload} />
    </section>
  );
}

/** 自定义表单项渲染（发起）：schema 经 forms.getById 读取（G3 缺口：member 无 schema 时降级提示） */
function CustomFormFields({ requestType, payload, onChange }: { requestType: string; payload: FormPayload; onChange: (p: FormPayload) => void }) {
  const publicForms = useFormPublicList();
  const meta = (publicForms.data ?? []).find((f) => f.code === requestType);
  const adminForm = useForm(meta?.id ?? null);
  const schema = (adminForm.data?.formSchema as { fields?: FormFieldDef[] } | null)?.fields ?? null;
  if (!meta) return <p className="list-note">表单加载中…</p>;
  if (!schema) {
    return (
      <p className="context-note">
        「{meta.name}」表单定义读取受限（接口缺口登记 20-03-G3：listPublic 未携带 form_schema，非管理角色不可读）——请联系管理员发布修复后重试。
      </p>
    );
  }
  return (
    <div className="fw-ro-form" style={{ marginTop: 8 }}>
      {schema.map((f) => (
        <label key={f.key} className="form-field">
          <span>{f.label}{f.required ? " *" : ""}</span>
          <FormFieldControl
            field={f}
            value={payload[f.key]}
            payload={payload}
            editable
            readonly={false}
            onChange={(v) => onChange({ ...payload, [f.key]: v })}
          />
        </label>
      ))}
    </div>
  );
}

/** 详情：审批进度节点图（flowProgress 真实数据，当前节点高亮+条件轨迹） */
export function RequestDetailPage() {
  const { requestId } = useParams();
  const request = useRequest(requestId ?? null);
  const approval = useApproval(request.data?.approvalInstanceId ?? null);
  const mutations = useRequestMutations();
  const types = useRequestTypes();
  const typeLabel = (key: string) => types.data?.items.find((i) => i.key === key)?.label ?? key;
  const [chosenApproverId, setChosenApproverId] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (request.isPending) return <p className="list-note">正在加载申请单…</p>;
  if (request.isError) throw request.error;
  const r = request.data;

  return (
    <div className="screen requests-screen">
      <div className="project-title-row">
        <div>
          {/* G8 返回按钮 */}
          <BackButton />
          <div className="breadcrumb">
            <Link to="/requests">通用申请</Link>
            <ChevronRight size={13} />
            <span>{r.code}</span>
          </div>
      {r.requestType.startsWith("CF-") && r.payload ? (
        <RequestPayloadView formId={(r as { formId?: string | null }).formId ?? null} payload={r.payload as FormPayload} />
      ) : null}
          <h1>
            <span className="badge badge-minutes-pending_confirm">{typeLabel(r.requestType)}</span>{" "}
            {r.title}
          </h1>
          <p>
            提交 {r.createdAt.slice(0, 16).replace("T", " ")}
            {r.startOn ? ` · ${r.startOn} ~ ${r.endOn}` : ""}
            {r.amountCents != null ? ` · 金额 ${formatYuan(r.amountCents)} 元` : ""}
          </p>
        </div>
        <div className="title-actions">
          <span
            className={`badge badge-travel-${
              r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : "pending_approval"
            }`}
          >
            {STATUS_LABEL[r.status]}
          </span>
          {r.status === "draft" ? (
            <div className="form-field" style={{ minWidth: 240, margin: 0 }}>
              <span>选择审批人 *（流程含发起人指定节点时必选）</span>
              <UserPicker value={chosenApproverId} onChange={setChosenApproverId} placeholder="搜索并选择审批人" />
            </div>
          ) : null}
          {r.status === "draft" ? (
            <button
              className="primary-action"
              disabled={mutations.submit.isPending}
              onClick={() => {
                setError(null);
                if (!chosenApproverId) {
                  setError("请选择审批人：当前流程包含「发起人指定审批人」节点。");
                  return;
                }
                mutations.submit.mutate(
                  { id: r.id, rowVersion: r.rowVersion, idempotencyKey: newIdempotencyKey(), chosenApproverId },
                  {
                    onSuccess: () => toast.success("申请单已提交，进入审批流程"),
                    onError: (err) => {
                      setError(rootErrorMessage(err));
                      toast.error("提交失败", { description: rootErrorMessage(err) });
                    },
                  },
                );
              }}
            >
              提交审批
              <ArrowRight size={15} />
            </button>
          ) : null}
          {r.status === "pending_approval" ? (
            <button
              className="secondary-action"
              disabled={mutations.withdraw.isPending}
              onClick={() => {
                setError(null);
                mutations.withdraw.mutate(
                  { id: r.id, rowVersion: r.rowVersion },
                  {
                    onSuccess: () => toast.success("申请单已撤回，可重新编辑后提交"),
                    onError: (err) => {
                      setError(rootErrorMessage(err));
                      toast.error("撤回失败", { description: rootErrorMessage(err) });
                    },
                  },
                );
              }}
            >
              撤回
            </button>
          ) : null}
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="issue-section">
        <span>申请理由</span>
        <p>{r.reason}</p>
      </div>
      {approval.data?.flowProgress ? (
        <section className="progress-graph-section">
          <span className="section-label">
            APPROVAL PROGRESS · {approval.data.flowProgress.flowName} V{approval.data.flowProgress.flowVersion ?? "—"} · 当前：
            {approval.data.flowProgress.currentNodeLabel ?? "—"}
          </span>
          <FlowProgressGraph
            progress={approval.data.flowProgress}
            policySnapshot={approval.data.policySnapshot}
            stepFlags={stepFlagsFrom(approval.data)}
          />
        </section>
      ) : approval.isPending && r.approvalInstanceId ? (
        <p className="list-note">正在加载审批进度…</p>
      ) : (
        <p className="context-note">尚未提交审批（提交后展示流程节点图）。</p>
      )}
    </div>
  );
}
