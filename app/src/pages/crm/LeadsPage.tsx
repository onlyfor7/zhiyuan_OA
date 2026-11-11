import { useState } from "react";
import { useSearchParams } from "react-router";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { useCrmMutations, useLeadList } from "../../api/crm";
import { useUserNameMap } from "./shared";
import { LEAD_STATUS_LABEL } from "../../lib/labels";
import { LeadConvertDialog, LeadDrawer } from "./lead-drawer";
import { FormDialog } from "../../components/FormDialog";
import { ListSkeleton } from "../../components/feedback";
import { rootErrorMessage } from "../../lib/form";

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

/** 客户组·线索池（arch/12 §6.4 + §18.4：T-A + 新建 F1 + 行点击开详情抽屉（?lead= 深链）+ 转化 F4 + 作废 DangerConfirm） */
export default function LeadsPage() {
  const [status, setStatus] = useState("");
  const [keyword, setKeyword] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const list = useLeadList({ status: status || undefined, keyword: keyword || undefined, cursor });
  const m = useCrmMutations();
  const nameOf = useUserNameMap();
  const [sp, setSp] = useSearchParams();
  const openLeadId = sp.get("lead");
  const [createOpen, setCreateOpen] = useState(false);
  const [convertTarget, setConvertTarget] = useState<{ id: string; rowVersion: number; name: string; contactName: string | null } | null>(null);
  const [disqualifyTarget, setDisqualifyTarget] = useState<{ id: string; rowVersion: number; name: string } | null>(null);
  const [followTarget, setFollowTarget] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (list.isPending) return <ListSkeleton rows={6} />;
  if (list.isError) throw list.error;

  const openLead = openLeadId ? list.data.items.find((l) => l.id === openLeadId) ?? null : null;

  return (
    <div className="screen crm-leads-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">CRM · LEADS</span>
          <h1>线索池</h1>
          <p>状态机 new→contacted→qualified→converted/disqualified；点击行开详情抽屉（查看全字段+编辑+跟进/备注+转化）。</p>
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
            <div
              className="p9a-ta-row is-clickable"
              key={l.id}
              style={{ gridTemplateColumns: "110px 1.3fr 1fr 90px 100px 90px 90px 140px" }}
              title="点击打开详情抽屉"
              onClick={() => setSp({ lead: l.id })}
            >
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
              <span className="p9a-row-actions" onClick={(e) => e.stopPropagation()}>
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
      {openLeadId && openLead ? <LeadDrawer key={openLead.id} lead={openLead} onClose={() => setSp({})} /> : null}
      {openLeadId && !openLead ? (
        <FormDialog title="线索详情" eyebrow="CRM · LEADS" onClose={() => setSp({})}>
          <p className="context-note">未在当前列表页找到该线索（可能不在此筛选/分页内）。请调整筛选或翻页后重试。</p>
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setSp({})}>关闭</button>
          </div>
        </FormDialog>
      ) : null}
      {convertTarget ? <LeadConvertDialog lead={convertTarget} onClose={() => setConvertTarget(null)} /> : null}
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
