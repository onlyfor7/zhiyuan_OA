import { useMemo, useState } from "react";
import { BackButton } from "../components/feedback";
import { HelpIcon } from "../components/HelpIcon";
import { Link, useParams } from "react-router";
import { ArrowRight, ChevronRight, Plus } from "lucide-react";

import { useApproval } from "../api/approval";
import { useRequest, useRequestList, useRequestMutations, useRequestTypes } from "../api/generic-request";
import { useForm, useFormPublicList } from "../api/forms";
import { useFlow } from "../api/flow";
import { findInitiatorChoice } from "./flows/v2-model";
import type { CustomFormSchema } from "@lexflow/shared";
import { FormFieldControl, FormReadonlyView, type FormPayload } from "./flows/form-render";
import { useMe } from "../api/auth";
import { newIdempotencyKey, rootErrorMessage } from "../lib/form";
import { fieldErrorsOf } from "../lib/trpc";
import { ListSkeleton } from "../components/feedback";
import { toast } from "sonner";
import "../lib/form";
import { formatYuan, useUserNameMap } from "../api/reference";
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

/** 详情：自定义表单 payload 按详情输出 formSchema（快照版本）只读渲染（20-02b G3：schema 随实例 policy 快照回带，草稿取当前结构） */
function RequestPayloadView({ formSchema, formVersion, payload }: { formSchema: unknown; formVersion: number | null; payload: FormPayload }) {
  const userNames = useUserNameMap();
  const fields = (formSchema as CustomFormSchema | null)?.fields ?? null;
  if (!fields) return null;
  return (
    <section style={{ marginTop: 10 }}>
      <span className="section-label">表单内容（快照 v{formVersion ?? "—"}）</span>
      <FormReadonlyView fields={fields} payload={payload} PersonNames={(id) => userNames.get(id) ?? "—"} />
    </section>
  );
}

/** 自定义表单项渲染（发起）：schema 经 listPublic 携带一次取齐（20-02b G3 移除降级） */
function CustomFormFields({ requestType, payload, onChange }: { requestType: string; payload: FormPayload; onChange: (p: FormPayload) => void }) {
  const publicForms = useFormPublicList();
  const meta = (publicForms.data ?? []).find((f) => f.code === requestType);
  if (!meta) return <p className="list-note">表单加载中…</p>;
  const fields = (meta.formSchema as unknown as CustomFormSchema | null)?.fields ?? [];
  return (
    <div className="fw-ro-form" style={{ marginTop: 8 }}>
      {fields.map((f) => (
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
  // O-20-5-1：提交网关自选审批人门控——CF 经 表单→绑定流定义解析；读不到（member/非 CF）由服务端 fieldErrors 揭示
  const cfFormId = (request.data as { formId?: string | null } | undefined)?.formId ?? null;
  const formQ = useForm(cfFormId);
  const flowQ = useFlow(formQ.data?.flowId ?? null);
  const [serverNeedsChoice, setServerNeedsChoice] = useState(false);
  const [choiceFieldErr, setChoiceFieldErr] = useState<string | null>(null);
  const choiceReq = useMemo(() => {
    if (!cfFormId || !flowQ.data) return null; // null=不可解析（unknown，服务端兜底）
    return findInitiatorChoice(flowQ.data.definitionJson);
  }, [cfFormId, flowQ.data]);
  const choiceRequired = serverNeedsChoice || choiceReq?.present === true;
  const choiceVisible = choiceRequired || choiceReq === null;
  const restrictIds = choiceReq?.present === true && choiceReq.scope?.mode === "users" ? choiceReq.scope.userIds : undefined;

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
        <RequestPayloadView
          formSchema={(r as { formSchema?: unknown }).formSchema ?? null}
          formVersion={(r as { formVersion?: number | null }).formVersion ?? null}
          payload={r.payload as FormPayload}
        />
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
          {r.status === "draft" && choiceVisible ? (
            <div className="form-field" style={{ minWidth: 240, margin: 0 }}>
              <span>{choiceRequired ? "选择审批人 *（本流程要求发起人指定）" : "选择审批人（如流程要求指定审批人，不选将无法提交）"}</span>
              <UserPicker value={chosenApproverId} onChange={(v) => { setChosenApproverId(v); setChoiceFieldErr(null); }} placeholder="搜索并选择审批人" restrictToIds={restrictIds} />
              {choiceFieldErr ? <em className="ux-err">{choiceFieldErr}</em> : null}
            </div>
          ) : null}
          {r.status === "draft" ? (
            <button
              className="primary-action"
              disabled={mutations.submit.isPending}
              onClick={() => {
                setError(null);
                setChoiceFieldErr(null);
                if (choiceRequired && !chosenApproverId) {
                  setChoiceFieldErr("请选择审批人：当前流程包含「发起人指定审批人」节点。");
                  return;
                }
                mutations.submit.mutate(
                  { id: r.id, rowVersion: r.rowVersion, idempotencyKey: newIdempotencyKey(), ...(chosenApproverId ? { chosenApproverId } : {}) },
                  {
                    onSuccess: () => toast.success("申请单已提交，进入审批流程"),
                    onError: (err) => {
                      const fe = fieldErrorsOf(err);
                      if (fe?.chosenApproverId) {
                        // O-20-5-1：定义不可读时由服务端揭示选人要求（member 视角 initiator_choice 流）
                        setServerNeedsChoice(true);
                        setChoiceFieldErr(fe.chosenApproverId[0] ?? "请选择审批人");
                        return;
                      }
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
