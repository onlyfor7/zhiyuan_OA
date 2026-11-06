import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { useCrmMutations, useLeadList } from "../../api/crm";
import { useUserNameMap } from "./shared";
import { FormDialog } from "../../components/FormDialog";
import { ListSkeleton } from "../../components/feedback";
import { rootErrorMessage } from "../../lib/form";

const LEAD_STATUS_LABEL: Record<string, string> = {
  new: "新线索",
  contacted: "已联系",
  qualified: "已评估",
  converted: "已转化",
  disqualified: "已作废",
};

function LeadCreateDialog({ onClose }: { onClose: () => void }) {
  const m = useCrmMutations();
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog title="新建线索" eyebrow="CRM · F1 对话框" onClose={onClose}>
      <label className="form-field"><span>线索名称 *</span>
        <input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="owner-line">
        <label className="form-field"><span>来源</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">请选择</option>
            <option value="老客推荐">老客推荐</option>
            <option value="官网表单">官网表单</option>
            <option value="来电咨询">来电咨询</option>
            <option value="转介绍">转介绍</option>
          </select></label>
        <label className="form-field"><span>联系人</span>
          <input value={contactName} onChange={(e) => setContactName(e.target.value)} /></label>
        <label className="form-field"><span>联系电话</span>
          <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} /></label>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onClose}>取消</button>
        <button className="primary-action" disabled={!name.trim() || m.createLead.isPending}
          onClick={() => {
            setError(null);
            m.createLead.mutate(
              { name: name.trim(), source: source || undefined, contactName: contactName.trim() || null, contactPhone: contactPhone.trim() || null },
              { onSuccess: () => { toast.success("线索已创建"); onClose(); }, onError: (err) => setError(rootErrorMessage(err)) },
            );
          }}>
          创建线索
        </button>
      </div>
    </FormDialog>
  );
}

/** F4 转化 Stepper：确认客户 → 商机信息 → 跟进计划（一步事务 convertLead） */
function ConvertDialog({ lead, onClose }: { lead: { id: string; rowVersion: number; name: string; contactName: string | null }; onClose: () => void }) {
  const m = useCrmMutations();
  const [step, setStep] = useState(0);
  const [custName, setCustName] = useState(lead.name);
  const [level, setLevel] = useState("internal");
  const [oppName, setOppName] = useState(`${lead.name} 合作商机`);
  const [amountYuan, setAmountYuan] = useState("");
  const [winRate, setWinRate] = useState(30);
  const [plan, setPlan] = useState("");
  const [error, setError] = useState<string | null>(null);
  const steps = ["确认客户", "商机信息", "跟进计划"];
  const canNext = step === 0 ? custName.trim().length > 0 : step === 1 ? oppName.trim().length > 0 : true;

  return (
    <FormDialog title={`转化线索 · ${lead.name}`} eyebrow="CRM · F4 分步 Stepper（同事务）" onClose={onClose} wide>
      <div className="p9a-stepper">
        {steps.map((s, i) => (
          <div key={s} className={`p9a-step ${i === step ? "current" : i < step ? "done" : ""}`}>
            <span>{i < step ? "✓" : i + 1}</span>{s}
          </div>
        ))}
      </div>
      <div className="p9a-wizard-body">
        {step === 0 ? (
          <>
            <label className="form-field"><span>客户名称 *（自动带出可改）</span>
              <input value={custName} onChange={(e) => setCustName(e.target.value)} /></label>
            <label className="form-field"><span>客户级别</span>
              <select value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="public">公开</option>
                <option value="internal">内部</option>
                <option value="confidential">保密</option>
                <option value="secret">秘密</option>
              </select></label>
          </>
        ) : null}
        {step === 1 ? (
          <>
            <label className="form-field"><span>商机名称 *</span>
              <input value={oppName} onChange={(e) => setOppName(e.target.value)} /></label>
            <div className="owner-line">
              <label className="form-field"><span>预计金额（元，选填）</span>
                <input type="number" min="0" step="0.01" value={amountYuan} onChange={(e) => setAmountYuan(e.target.value)} /></label>
              <label className="form-field"><span>赢率（%）</span>
                <input type="number" min="0" max="100" value={winRate} onChange={(e) => setWinRate(Number(e.target.value))} /></label>
            </div>
          </>
        ) : null}
        {step === 2 ? (
          <label className="form-field"><span>跟进计划（选填，转化后首条跟进）</span>
            <textarea rows={3} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="下一步行动…" /></label>
        ) : null}
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="drawer-actions">
        <button className="secondary-action" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>上一步</button>
        {step < 2 ? (
          <button className="primary-action" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>下一步</button>
        ) : (
          <button
            className="primary-action"
            disabled={m.convertLead.isPending}
            onClick={() => {
              setError(null);
              m.convertLead.mutate(
                {
                  id: lead.id,
                  rowVersion: lead.rowVersion,
                  customer: { name: custName.trim(), level },
                  opportunity: {
                    name: oppName.trim(),
                    expectedAmountCents: amountYuan ? Math.round(Number(amountYuan) * 100) : null,
                    winRate,
                  },
                },
                {
                  onSuccess: () => { toast.success("线索已转化：客户+商机已创建（同事务）"); onClose(); },
                  onError: (err) => setError(rootErrorMessage(err)),
                },
              );
            }}
          >
            确认转化
          </button>
        )}
      </div>
    </FormDialog>
  );
}

function FollowDialog({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const m = useCrmMutations();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog title="写跟进" eyebrow="CRM · FOLLOWUP" onClose={onClose}>
      <label className="form-field"><span>跟进内容 *</span>
        <textarea rows={3} value={content} onChange={(e) => setContent(e.target.value)} /></label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onClose}>取消</button>
        <button className="primary-action" disabled={!content.trim() || m.createFollowup.isPending}
          onClick={() => {
            setError(null);
            m.createFollowup.mutate(
              { targetType: "lead", targetId: leadId, content: content.trim() },
              { onSuccess: () => { toast.success("跟进已记录"); onClose(); }, onError: (err) => setError(rootErrorMessage(err)) },
            );
          }}>
          保存
        </button>
      </div>
    </FormDialog>
  );
}

/** 客户组·线索池（arch/12 §6.4：T-A + 新建 F1 + 转化 F4 Stepper + 作废 DangerConfirm） */
export default function LeadsPage() {
  const [status, setStatus] = useState("");
  const [keyword, setKeyword] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const list = useLeadList({ status: status || undefined, keyword: keyword || undefined, cursor });
  const m = useCrmMutations();
  const nameOf = useUserNameMap();
  const [createOpen, setCreateOpen] = useState(false);
  const [convertTarget, setConvertTarget] = useState<{ id: string; rowVersion: number; name: string; contactName: string | null } | null>(null);
  const [disqualifyTarget, setDisqualifyTarget] = useState<{ id: string; rowVersion: number; name: string } | null>(null);
  const [followTarget, setFollowTarget] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (list.isPending) return <ListSkeleton rows={6} />;
  if (list.isError) throw list.error;

  return (
    <div className="screen crm-leads-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">CRM · LEADS</span>
          <h1>线索池</h1>
          <p>状态机 new→contacted→qualified→converted/disqualified；转化=同事务建客户+商机。</p>
        </div>
        <button className="primary-action" onClick={() => setCreateOpen(true)}>
          <Plus size={15} />
          新建线索
        </button>
      </div>
      <div className="quality-toolbar p9a-ta-filter" style={{ borderBottom: "1px solid var(--line)" }}>
        <select value={status} aria-label="状态筛选" onChange={(e) => { setStatus(e.target.value); setCursor(undefined); }}>
          <option value="">全部状态</option>
          {Object.entries(LEAD_STATUS_LABEL).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <input value={keyword} placeholder="搜索线索名称" aria-label="搜索线索" onChange={(e) => { setKeyword(e.target.value); setCursor(undefined); }} />
        <span>{list.data.items.length} 条</span>
      </div>
      <div className="p9a-ta-table" style={{ gridTemplateRows: "40px minmax(0,1fr)" }}>
        <div className="p9a-ta-head p9a-ta-row" style={{ gridTemplateColumns: "110px 1.3fr 1fr 90px 100px 90px 90px 140px" }}>
          <span>编号</span><span>名称</span><span>联系人</span><span>来源</span><span>负责人</span><span>状态</span><span>最近跟进</span><span />
        </div>
        <div className="p9a-ta-body">
          {list.data.items.map((l) => (
            <div className="p9a-ta-row" key={l.id} style={{ gridTemplateColumns: "120px 1.4fr 1fr 110px 110px 110px 150px" }}>
              <span className="mono">{l.code}</span>
              <strong>{l.name}</strong>
              <span>{l.contactName ?? "—"}{l.contactPhone ? ` · ${l.contactPhone}` : ""}</span>
              <span>{l.source ?? "—"}</span>
              <span>{nameOf(l.ownerId)}</span>
              <span>
                <i className={`p9a-dot ${l.status === "new" ? "warn" : l.status === "disqualified" ? "" : "ok"}`} style={l.status === "disqualified" ? { background: "#9ca5b3" } : undefined} />
                {LEAD_STATUS_LABEL[l.status] ?? l.status}
              </span>
              <span className="mono" style={{ fontSize: 10 }}>{(l as { lastFollowAt?: string }).lastFollowAt?.slice(5, 16).replace("T", " ") ?? "—"}</span>
              <span className="p9a-row-actions">
                {["new", "contacted", "qualified"].includes(l.status) ? (
                  <>
                    <button className="text-action" onClick={() => setFollowTarget(l.id)}>跟进</button>
                    <button className="text-action" onClick={() => setConvertTarget(l)}>转化</button>
                    <button className="text-action" onClick={() => setDisqualifyTarget(l)}>作废</button>
                  </>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="p9a-ta-pager">
        <span>共 {list.data.items.length} 条 · 每页 20</span>
        <div className="row-ops">
          <button className="secondary-action" disabled={!cursor} onClick={() => setCursor(undefined)}>上一页</button>
          <button className="secondary-action" disabled={!list.data.nextCursor} onClick={() => setCursor(list.data.nextCursor ?? undefined)}>下一页</button>
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {createOpen ? <LeadCreateDialog onClose={() => setCreateOpen(false)} /> : null}
      {convertTarget ? <ConvertDialog lead={convertTarget} onClose={() => setConvertTarget(null)} /> : null}
      {followTarget ? <FollowDialog leadId={followTarget} onClose={() => setFollowTarget(null)} /> : null}
      {disqualifyTarget ? (
        <FormDialog title={`作废线索 · ${disqualifyTarget.name}`} eyebrow="CRM · 高危确认" onClose={() => setDisqualifyTarget(null)}>
          <label className="form-field"><span>作废原因 *</span>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setDisqualifyTarget(null)}>取消</button>
            <button className="danger-action" disabled={!reason.trim() || m.disqualifyLead.isPending}
              onClick={() => {
                setError(null);
                m.disqualifyLead.mutate(
                  { id: disqualifyTarget.id, rowVersion: disqualifyTarget.rowVersion, reason: reason.trim() },
                  { onSuccess: () => { toast.success("线索已作废"); setDisqualifyTarget(null); setReason(""); }, onError: (err) => { setError(rootErrorMessage(err)); setDisqualifyTarget(null); } },
                );
              }}>
              确认作废
            </button>
          </div>
        </FormDialog>
      ) : null}
    </div>
  );
}
