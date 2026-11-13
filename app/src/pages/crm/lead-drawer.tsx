import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { useCrmMutations, useCustomerList, useFollowupList, useOpportunityList } from "../../api/crm";
import type { RouterOutputs } from "../../lib/trpc";
import { useUserNameMap } from "./shared";
import { LEAD_STATUS_LABEL } from "../../lib/labels";
import { FormDialog } from "../../components/FormDialog";
import { UserPicker } from "../../components/UserPicker";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { rootErrorMessage } from "../../lib/form";

export type LeadRow = RouterOutputs["crm"]["leads"]["list"]["items"][number];

const LEAD_SOURCE_OPTIONS = ["老客推荐", "官网表单", "来电咨询", "转介绍"];
const EDITABLE_STATUSES = ["new", "contacted", "qualified"];

/** §5.1 转化双路径（arch/13）：新建商机（客户选择/新建+PM 必填+售前可选+幂等键开表单一次生成）或关联既有商机（范围=服务端可见集；成功跳商机抽屉深链） */
export function LeadConvertDialog({ lead, onClose }: { lead: { id: string; rowVersion: number; name: string; contactName: string | null }; onClose: () => void }) {
  const m = useCrmMutations();
  const navigate = useNavigate();
  const [path, setPath] = useState<"new" | "existing">("new");
  // 路径一：新建商机
  const customers = useCustomerList({});
  const [custMode, setCustMode] = useState<"create" | "select">("create");
  const [customerId, setCustomerId] = useState("");
  const [custName, setCustName] = useState(lead.name);
  const [oppName, setOppName] = useState(`${lead.name} 合作商机`);
  const [amountYuan, setAmountYuan] = useState("");
  const [winRate, setWinRate] = useState(30);
  const [pmId, setPmId] = useState("");
  const [presalesId, setPresalesId] = useState("");
  // 路径二：关联既有商机（列表=服务端按可见范围过滤）
  const opps = useOpportunityList({});
  const [oppId, setOppId] = useState("");
  /** 幂等键：打开表单生成一次；校验失败重试沿用同键（同键同载荷重放返回既有商机/项目） */
  const [idemKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);

  const submitNew = () => {
    setError(null);
    m.convertLead.mutate(
      {
        id: lead.id,
        rowVersion: lead.rowVersion,
        ...(custMode === "select" ? { customerId } : { customer: { name: custName.trim(), level: "internal" } }),
        opportunity: {
          name: oppName.trim(),
          expectedAmountCents: amountYuan ? Math.round(Number(amountYuan) * 100) : null,
          winRate,
        },
        projectManagerId: pmId || undefined,
        idempotencyKey: idemKey,
      },
      {
        onSuccess: () => { toast.success("线索已转化：客户+商机+项目已同事务建立"); onClose(); },
        onError: (err) => setError(rootErrorMessage(err)),
      },
    );
  };

  const submitExisting = () => {
    setError(null);
    m.convertLead.mutate(
      { id: lead.id, rowVersion: lead.rowVersion, opportunityId: oppId },
      {
        onSuccess: () => {
          toast.success("线索已关联既有商机（复用原项目，不重复立项）");
          onClose();
          navigate(`/crm/opportunities?opp=${oppId}`);
        },
        onError: (err) => setError(rootErrorMessage(err)),
      },
    );
  };

  return (
    <FormDialog title={`转化线索 · ${lead.name}`} eyebrow="CRM · 转化双路径（同事务/幂等）" onClose={onClose} wide>
      <div className="p9a-wizard-tabs" role="tablist">
        <button role="tab" aria-selected={path === "new"} className={path === "new" ? "active" : ""} onClick={() => setPath("new")}>新建商机</button>
        <button role="tab" aria-selected={path === "existing"} className={path === "existing" ? "active" : ""} onClick={() => setPath("existing")}>关联既有商机</button>
      </div>
      <div className="p9a-wizard-body">
        {path === "new" ? (
          <>
            <div className="owner-line">
              <label className="form-field">
                <span>客户</span>
                <select value={custMode} onChange={(e) => setCustMode(e.target.value as "create" | "select")}>
                  <option value="create">新建客户</option>
                  <option value="select">选择已有客户</option>
                </select>
              </label>
              {custMode === "select" ? (
                <label className="form-field">
                  <span>目标客户 *</span>
                  <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                    <option value="">请选择（仅列当前可见范围）</option>
                    {(customers.data?.items ?? []).map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="form-field">
                  <span>客户名称 *（自动带出可改）</span>
                  <input value={custName} onChange={(e) => setCustName(e.target.value)} />
                </label>
              )}
            </div>
            <label className="form-field"><span>商机名称 *</span>
              <input value={oppName} onChange={(e) => setOppName(e.target.value)} /></label>
            <div className="owner-line">
              <label className="form-field"><span>预计金额（元，选填）</span>
                <input type="number" min="0" step="0.01" value={amountYuan} onChange={(e) => setAmountYuan(e.target.value)} /></label>
              <label className="form-field"><span>赢率（%）</span>
                <input type="number" min="0" max="100" value={winRate} onChange={(e) => setWinRate(Number(e.target.value))} /></label>
            </div>
            <div className="form-field">
              <span>项目负责人 *（不得隐式默认为当前销售）</span>
              <UserPicker value={pmId} onChange={setPmId} placeholder="搜索项目负责人" />
            </div>
            <div className="form-field">
              <span>售前（可选，指派后按矩阵取得项目售前范围）</span>
              <UserPicker value={presalesId} onChange={setPresalesId} placeholder="搜索售前" />
            </div>
            <p className="context-note">商机成立即立项（arch/13 §5.3）：同事务建客户/事项/项目（售前 preparing+首版计划），项目负责人落 manager、销售 owner 落 member。</p>
          </>
        ) : (
          <>
            <label className="form-field">
              <span>目标商机 *（仅列当前可管理范围；无权目标服务端同形 404 不泄露）</span>
              <select value={oppId} onChange={(e) => setOppId(e.target.value)}>
                <option value="">请选择商机</option>
                {(opps.data?.items ?? []).map((o) => (
                  <option key={o.id} value={o.id}>{o.name}{"expectedAmountCents" in o && o.expectedAmountCents != null ? `（${(o.expectedAmountCents as number) / 100} 元）` : ""}</option>
                ))}
              </select>
            </label>
            <p className="context-note">关联既有商机：复用该商机既有项目，不重复立项；提交后跳商机详情抽屉。</p>
          </>
        )}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onClose}>取消</button>
        {path === "new" ? (
          <button
            className="primary-action"
            disabled={!oppName.trim() || !pmId || (custMode === "select" && !customerId) || (custMode === "create" && !custName.trim()) || m.convertLead.isPending}
            onClick={submitNew}
          >
            确认转化（新建商机）
          </button>
        ) : (
          <button className="primary-action" disabled={!oppId || m.convertLead.isPending} onClick={submitExisting}>
            确认关联
          </button>
        )}
      </div>
    </FormDialog>
  );
}

/**
 * 线索详情抽屉（arch/12 §18.4）：查看全字段 + 编辑（名称/联系人/电话/来源/负责人，
 * 走既有 leads.update 审计同事务）+ 跟进/备注记录区（followups 多态）+「转化」F4 入口。
 * 终态（converted/disqualified）整体只读；备注以跟进记录形式留存（表无 remark 列，契约未开）。
 */
export function LeadDrawer({ lead, onClose }: { lead: LeadRow; onClose: () => void }) {
  const m = useCrmMutations();
  const nameOf = useUserNameMap();
  const followups = useFollowupList("lead", lead.id);
  const editable = EDITABLE_STATUSES.includes(lead.status);
  const [form, setForm] = useState(() => ({
    name: lead.name,
    source: lead.source,
    contactName: lead.contactName ?? "",
    contactPhone: lead.contactPhone ?? "",
    ownerId: lead.ownerId ?? "",
  }));
  const [rv, setRv] = useState(lead.rowVersion);
  const [followText, setFollowText] = useState("");
  const [convertOpen, setConvertOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    form.name.trim() !== lead.name ||
    form.source !== lead.source ||
    form.contactName !== (lead.contactName ?? "") ||
    form.contactPhone !== (lead.contactPhone ?? "") ||
    (form.ownerId || null) !== lead.ownerId;

  const addFollow = () => {
    setError(null);
    if (!followText.trim()) return;
    m.createFollowup.mutate(
      { targetType: "lead", targetId: lead.id, content: followText.trim() },
      {
        onSuccess: () => { toast.success("跟进/备注已记录"); setFollowText(""); },
        onError: (err) => setError(rootErrorMessage(err)),
      },
    );
  };

  return (
    <FormDialog title={lead.name} eyebrow="CRM · 线索详情" onClose={onClose} wide>
      <div className="p9a-drawer-body">
        <p className="context-note">
          状态：{LEAD_STATUS_LABEL[lead.status] ?? lead.status}
          {lead.status === "disqualified" && lead.disqualifiedReason ? `（原因：${lead.disqualifiedReason}）` : ""}
          {lead.status === "converted" && lead.convertedAt ? ` · 转化于 ${lead.convertedAt.slice(0, 16).replace("T", " ")}` : ""}
          {!editable ? " · 终态只读" : ""}
        </p>
        <div className="p9a-field-grid two">
          <label className="form-field"><span>创建 / 最近更新</span>
            <input
              value={`${lead.createdAt.slice(0, 16).replace("T", " ")}（${nameOf(lead.createdBy)}）→ ${lead.updatedAt.slice(0, 16).replace("T", " ")}（${nameOf(lead.updatedBy)}）`}
              disabled
            /></label>
          <label className="form-field"><span>线索名称 *</span>
            <input value={form.name} disabled={!editable} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
          <label className="form-field"><span>来源</span>
            <select value={form.source} disabled={!editable} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}>
              <option value="">{lead.source && !LEAD_SOURCE_OPTIONS.includes(lead.source) ? lead.source : "未填写"}</option>
              {LEAD_SOURCE_OPTIONS.filter((s) => s !== form.source).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select></label>
          <label className="form-field"><span>联系人</span>
            <input value={form.contactName} disabled={!editable} onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))} /></label>
          <label className="form-field"><span>联系电话</span>
            <input value={form.contactPhone} disabled={!editable} onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))} /></label>
          <div className="form-field"><span>负责人</span>
            {editable ? (
              <UserPicker value={form.ownerId} onChange={(userId) => setForm((f) => ({ ...f, ownerId: userId }))} placeholder="搜索新负责人" />
            ) : (
              <input value={nameOf(lead.ownerId)} disabled />
            )}
          </div>
          <label className="form-field"><span>转化去向</span>
            <input
              value={lead.convertedCustomerId ? "已转化为客户+商机" : "—"}
              disabled
            /></label>
        </div>
        {lead.convertedCustomerId ? (
          <p className="context-note">
            转化客户：<Link className="text-action" to={`/crm/customers/${lead.convertedCustomerId}`}>查看客户档案 →</Link>
          </p>
        ) : null}

        <span className="section-label">跟进 / 备注记录（{followups.data?.length ?? 0}）</span>
        {followups.isPending ? <p className="list-note">跟进记录加载中…</p> : null}
        {followups.data && followups.data.length === 0 ? <p className="list-note">暂无跟进/备注；备注以跟进记录形式留存（线索表无独立备注列）。</p> : null}
        {(followups.data ?? []).map((f) => (
          <div className="p9a-schedule-row" key={f.id}>
            <DomainIconBlock domain="lead" size={22} iconSize={13} />
            <div className="p9a-queue-main">
              <strong>{f.content}</strong>
              <small>{f.createdAt.slice(0, 16).replace("T", " ")}{f.nextAt ? ` · 下次跟进 ${f.nextAt.slice(0, 16).replace("T", " ")}` : ""} · {nameOf(f.createdBy)}</small>
            </div>
          </div>
        ))}
        <div className="owner-line" style={{ marginTop: 8 }}>
          <input value={followText} placeholder="写跟进/备注…" aria-label="跟进或备注内容" onChange={(e) => setFollowText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addFollow(); }} />
          <button className="secondary-action" onClick={addFollow} disabled={!followText.trim() || m.createFollowup.isPending}>
            记录
          </button>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <div className="p9a-modal-foot">
        <span>口径：编辑走 leads.update（审计同事务）；终态由服务端 STATE_CONFLICT 双保险。</span>
        <div className="row-ops">
          <button className="secondary-action" onClick={onClose}>关闭</button>
          {editable ? (
            <button className="secondary-action" onClick={() => setConvertOpen(true)}>转化…</button>
          ) : null}
          {editable ? (
            <button
              className="primary-action"
              disabled={!dirty || !form.name.trim() || m.updateLead.isPending}
              onClick={() => {
                setError(null);
                m.updateLead.mutate(
                  {
                    id: lead.id,
                    rowVersion: rv,
                    name: form.name.trim(),
                    source: form.source,
                    contactName: form.contactName.trim() || null,
                    contactPhone: form.contactPhone.trim() || null,
                    ownerId: form.ownerId || null,
                  },
                  {
                    onSuccess: (row) => {
                      toast.success("线索已更新");
                      setForm({ name: row.name, source: row.source, contactName: row.contactName ?? "", contactPhone: row.contactPhone ?? "", ownerId: row.ownerId ?? "" });
                      setRv(row.rowVersion);
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              保存修改
            </button>
          ) : null}
        </div>
      </div>
      {convertOpen ? <LeadConvertDialog lead={lead} onClose={() => setConvertOpen(false)} /> : null}
    </FormDialog>
  );
}
