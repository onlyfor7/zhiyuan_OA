import { useState } from "react";
import { toast } from "sonner";

import { useCrmMutations, useCustomerList, useLeadList, useOpportunityList, useFollowupList } from "../../api/crm";
import { FormDialog } from "../../components/FormDialog";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { ListSkeleton } from "../../components/feedback";
import { rootErrorMessage } from "../../lib/form";

const TARGET_LABEL: Record<string, string> = { lead: "线索", opportunity: "商机", customer: "客户" };

/** 客户组·跟进记录（arch/12 §6.4：T-G 变体——按对象分组跟进时间线 + 新建跟进 F1） */
export default function FollowupsPage() {
  const [targetType, setTargetType] = useState<"lead" | "opportunity" | "customer">("customer");
  const [targetId, setTargetId] = useState<string | null>(null);
  const leads = useLeadList({});
  const customers = useCustomerList({});
  const opps = useOpportunityList({});
  const followups = useFollowupList(targetType, targetId);
  const m = useCrmMutations();
  const [createOpen, setCreateOpen] = useState(false);
  const [content, setContent] = useState("");
  const [nextAt, setNextAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const targets =
    targetType === "lead"
      ? (leads.data?.items ?? []).map((t) => ({ id: t.id, label: t.name }))
      : targetType === "customer"
        ? (customers.data?.items ?? []).map((t) => ({ id: t.id, label: t.name }))
        : (opps.data?.items ?? []).map((t) => ({ id: t.id, label: t.name }));

  return (
    <div className="screen crm-followups-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">CRM · FOLLOWUPS</span>
          <h1>跟进记录</h1>
          <p>多态跟进（线索/商机/客户）；选择对象后查看时间线，新建跟进走 F1。</p>
        </div>
        <button className="primary-action" disabled={!targetId} onClick={() => setCreateOpen(true)}>
          新建跟进
        </button>
      </div>
      <div className="quality-toolbar p9a-ta-filter" style={{ borderBottom: "1px solid var(--line)" }}>
        <DomainIconBlock domain={targetType === "lead" ? "lead" : targetType === "customer" ? "customer" : "opportunity"} size={24} />
        <select value={targetType} aria-label="对象类型" onChange={(e) => { setTargetType(e.target.value as never); setTargetId(null); }}>
          {Object.entries(TARGET_LABEL).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <select value={targetId ?? ""} aria-label="跟进对象" onChange={(e) => setTargetId(e.target.value || null)}>
          <option value="">选择{TARGET_LABEL[targetType]}</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </div>
      <div className="crm-tab-body">
        {!targetId ? (
          <p className="list-note">选择跟进对象后展示时间线。</p>
        ) : followups.isPending ? (
          <ListSkeleton rows={4} />
        ) : (followups.data?.length ?? 0) === 0 ? (
          <p className="list-note">该对象暂无跟进记录。</p>
        ) : (
          <div className="crm-follow-list">
            {followups.data!.map((f) => (
              <div className="p9a-schedule-row" key={f.id}>
                <DomainIconBlock domain={targetType === "lead" ? "lead" : targetType === "customer" ? "customer" : "opportunity"} size={24} iconSize={14} />
                <div className="p9a-queue-main">
                  <strong>{f.content}</strong>
                  <small>
                    {f.createdAt.slice(0, 16).replace("T", " ")}
                    {f.nextAt ? ` · 下次跟进 ${f.nextAt.slice(0, 16).replace("T", " ")}` : ""}
                  </small>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {createOpen ? (
        <FormDialog title="新建跟进" eyebrow="CRM · F1" onClose={() => setCreateOpen(false)}>
          <label className="form-field"><span>跟进内容 *</span>
            <textarea rows={3} value={content} onChange={(e) => setContent(e.target.value)} /></label>
          <label className="form-field"><span>下次跟进时间（选填）</span>
            <input type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} /></label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="primary-action" disabled={!content.trim() || m.createFollowup.isPending}
              onClick={() => {
                setError(null);
                m.createFollowup.mutate(
                  {
                    targetType,
                    targetId: targetId!,
                    content: content.trim(),
                    nextAt: nextAt ? new Date(nextAt).toISOString() : null,
                  },
                  {
                    onSuccess: () => { toast.success("跟进已记录"); setCreateOpen(false); setContent(""); setNextAt(""); },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}>
              保存
            </button>
          </div>
        </FormDialog>
      ) : null}
    </div>
  );
}
