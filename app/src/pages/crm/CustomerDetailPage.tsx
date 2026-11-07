import { useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";

import { useCrmMutations, useCustomer } from "../../api/crm";
import { useUserNameMap } from "./shared";
import { FormDialog } from "../../components/FormDialog";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { CardSkeleton } from "../../components/feedback";
import { formatYuan } from "../../api/reference";
import { CONFIDENTIALITY_LABEL } from "../../lib/labels";
import { rootErrorMessage } from "../../lib/form";

const TABS = [
  ["overview", "概况"],
  ["contacts", "联系人"],
  ["opportunities", "商机"],
  ["contracts", "合同"],
  ["projects", "项目"],
  ["files", "往来文件"],
] as const;

const OPP_STAGE_LABEL: Record<string, string> = { initial: "初步", needs: "需求", proposal: "方案", negotiation: "谈判", won: "赢单", lost: "输单" };
const CONTRACT_STATUS_LABEL: Record<string, string> = { draft: "草稿", active: "履约中", completed: "已完成", terminated: "已终止" };

function ContactDialog({ customerId, contact, onClose }: { customerId: string; contact: Record<string, unknown> | null; onClose: () => void }) {
  const m = useCrmMutations();
  const [name, setName] = useState((contact?.name as string) ?? "");
  const [title, setTitle] = useState((contact?.title as string) ?? "");
  const [phone, setPhone] = useState((contact?.phone as string) ?? "");
  const [email, setEmail] = useState((contact?.email as string) ?? "");
  const [isPrimary, setIsPrimary] = useState((contact?.isPrimary as boolean) ?? false);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog title={contact ? "编辑联系人" : "新建联系人"} eyebrow="CRM · F1" onClose={onClose}>
      <label className="form-field"><span>姓名 *</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="owner-line">
        <label className="form-field"><span>职务</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="form-field"><span>电话</span><input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        <label className="form-field"><span>邮箱</span><input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      </div>
      <label className="check-field">
        <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
        设为主要联系人（互斥，服务端切换）
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onClose}>取消</button>
        <button className="primary-action" disabled={!name.trim() || m.createContact.isPending || m.updateContact.isPending}
          onClick={() => {
            setError(null);
            if (contact) {
              m.updateContact.mutate(
                { name: name.trim(), title: title.trim() || null, phone: phone.trim() || null, email: email.trim() || null, isPrimary, id: contact.id as string, rowVersion: contact.rowVersion as number } as never,
                {
                  onSuccess: () => { toast.success("联系人已更新"); onClose(); },
                  onError: (err) => setError(rootErrorMessage(err)),
                },
              );
            } else {
              m.createContact.mutate(
                { name: name.trim(), title: title.trim() || null, phone: phone.trim() || null, email: email.trim() || null, isPrimary, customerId } as never,
                {
                  onSuccess: () => { toast.success("联系人已创建"); onClose(); },
                  onError: (err) => setError(rootErrorMessage(err)),
                },
              );
            }
          }}>
          保存
        </button>
      </div>
    </FormDialog>
  );
}

/** 客户组·客户详情（arch/12 §6.4：T-B 六页签 + 跟进时间线） */
/** H2 v1.9：动态列表 ≤cap 折叠 + 显示全部（禁纵向内滚框） */
function ShowAll<T extends { id: string }>({ items, render, cap = 10 }: { items: T[]; render: (it: T) => React.ReactNode; cap?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, cap);
  return (
    <>
      {shown.map(render)}
      {items.length > cap ? (
        <button type="button" className="p9a-show-all" onClick={() => setAll((v) => !v)}>
          {all ? "收起" : `··· 显示全部（${items.length}）`}
        </button>
      ) : null}
    </>
  );
}

export default function CustomerDetailPage() {
  const { customerId } = useParams();
  const customer = useCustomer(customerId ?? null);
  const m = useCrmMutations();
  const nameOf = useUserNameMap();
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("overview");
  const [contactDialog, setContactDialog] = useState<{ open: boolean; contact: Record<string, unknown> | null }>({ open: false, contact: null });
  const [followText, setFollowText] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (customer.isPending)
    return (
      <div className="screen">
        <CardSkeleton />
      </div>
    );
  if (customer.isError) throw customer.error;
  const d = customer.data;

  const addFollow = () => {
    setError(null);
    if (!followText.trim()) return;
    m.createFollowup.mutate(
      { targetType: "customer", targetId: d.customer.id, content: followText.trim() },
      {
        onSuccess: () => {
          toast.success("跟进已记录");
          setFollowText("");
        },
        onError: (err) => setError(rootErrorMessage(err)),
      },
    );
  };

  return (
    <div className="screen crm-customer-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">CRM · CUSTOMER</span>
          <h1>
            <DomainIconBlock domain="customer" size={28} iconSize={16} /> {d.customer.name}
          </h1>
          <p>
            {d.customer.code} · {d.customer.industry ?? "行业未录"} · 负责人 {nameOf(d.customer.ownerId)}
          </p>
        </div>
        <div className="title-actions">
          <span className="badge badge-health-normal">{{ public: "公开", internal: "内部", confidential: "保密", secret: "秘密" }[d.customer.level] ?? d.customer.level}</span>
        </div>
      </div>
      <div className="p9a-wizard-tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="crm-tab-body">
        {tab === "overview" ? (
          <>
            <div className="p9a-field-grid two" style={{ maxWidth: 720 }}>
              <label className="form-field"><span>客户名称</span><input defaultValue={d.customer.name} disabled /></label>
              <label className="form-field"><span>行业</span><input defaultValue={d.customer.industry ?? ""} disabled /></label>
              <label className="form-field"><span>地址</span><input defaultValue={d.customer.address ?? ""} disabled /></label>
              <label className="form-field"><span>来源线索</span><input defaultValue={d.customer.sourceLeadId ? "线索转化" : "—"} disabled /></label>
            </div>
            <span className="section-label">跟进时间线</span>
            <div className="crm-follow-list">
              {d.followups.length === 0 ? <p className="list-note">暂无跟进记录。</p> : null}
              <ShowAll items={d.followups} render={(f) => (
                <div className="p9a-schedule-row" key={f.id}>
                  <DomainIconBlock domain="customer" size={22} iconSize={13} />
                  <div className="p9a-queue-main">
                    <strong>{f.content}</strong>
                    <small>{f.createdAt.slice(0, 16).replace("T", " ")}{f.nextAt ? ` · 下次跟进 ${f.nextAt.slice(0, 16).replace("T", " ")}` : ""}</small>
                  </div>
                </div>
              )} />
              <div className="owner-line" style={{ marginTop: 8 }}>
                <input value={followText} placeholder="写跟进…" aria-label="跟进内容" onChange={(e) => setFollowText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addFollow(); }} />
                <button className="secondary-action" onClick={addFollow} disabled={!followText.trim() || m.createFollowup.isPending}>
                  记录跟进
                </button>
              </div>
              {error ? <p className="form-error" role="alert">{error}</p> : null}
            </div>
          </>
        ) : null}
        {tab === "contacts" ? (
          <>
            <div className="row-ops" style={{ marginBottom: 8 }}>
              <button className="primary-action" onClick={() => setContactDialog({ open: true, contact: null })}>新建联系人</button>
            </div>
            <div className="report-list">
              {d.contacts.length === 0 ? <p className="list-note">暂无联系人。</p> : null}
              {d.contacts.map((c) => (
                <div className="report-row" key={c.id}>
                  <div>
                    <strong>{c.name}{c.isPrimary ? " · 主要" : ""}</strong>
                    <small>{c.title ?? "—"} · {c.phone ?? "—"} · {c.email ?? "—"}</small>
                  </div>
                  <span className="p9a-row-actions">
                    <button className="text-action" onClick={() => setContactDialog({ open: true, contact: c as never })}>编辑</button>
                    <button className="text-action" onClick={() => {
                      m.deleteContact.mutate({ id: c.id }, { onSuccess: () => toast.success("联系人已删除"), onError: (err) => toast.error(rootErrorMessage(err)) });
                    }}>删除</button>
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}
        {tab === "opportunities" ? (
          <div className="report-list">
            {d.opportunities.length === 0 ? <p className="list-note">暂无商机。</p> : null}
            {d.opportunities.map((o) => (
              <div className="report-row" key={o.id}>
                <div>
                  <strong>{o.name}</strong>
                  <small>{o.code} · {"expectedAmountCents" in o && o.expectedAmountCents != null ? `${formatYuan(o.expectedAmountCents as number)} 元` : "金额—"} · 赢率 {o.winRate ?? "—"}%</small>
                </div>
                <span className={`badge ${o.stage === "won" ? "badge-health-normal" : o.stage === "lost" ? "" : "badge-minutes-pending_confirm"}`}>
                  {OPP_STAGE_LABEL[o.stage] ?? o.stage}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {tab === "contracts" ? (
          <div className="report-list">
            {d.contracts.length === 0 ? <p className="list-note">暂无合同。</p> : null}
            <ShowAll items={d.contracts} render={(c) => (
              <div className="report-row" key={c.id}>
                <div>
                  <strong>{c.title}</strong>
                  <small>
                    {c.code} · {"amountCents" in c && c.amountCents != null ? `${formatYuan(c.amountCents as number)} 元` : "金额—"} · 已回款
                    {"cumulativeReceivedCents" in c && c.cumulativeReceivedCents != null ? formatYuan(c.cumulativeReceivedCents as number) : "—"} 元
                  </small>
                </div>
                <span className="badge badge-health-normal">{CONTRACT_STATUS_LABEL[c.status] ?? c.status}</span>
              </div>
            )} />
          </div>
        ) : null}
        {tab === "projects" ? (
          <div className="report-list">
            {d.projects.length === 0 ? <p className="list-note">该客户暂无在管项目。</p> : null}
            {d.projects.map((p) => (
              <Link className="report-row" key={p.id} to={`/projects/${p.id}`}>
                <div>
                  <strong>{p.name}</strong>
                  <small>{p.code}</small>
                </div>
                <span className="text-action">进入项目空间</span>
              </Link>
            ))}
          </div>
        ) : null}
        {tab === "files" ? (
          <div className="report-list">
            {d.files.length === 0 ? <p className="list-note">暂无往来文件（项目档案挂载后此处可见）。</p> : null}
            <ShowAll items={d.files} render={(f) => (
              <div className="report-row" key={f.id}>
                <div>
                  <strong>{f.sourceId ? f.sourceId.slice(0, 8) : "—"}…</strong>
                  <small>{CONFIDENTIALITY_LABEL[f.confidentialityLevel] ?? f.confidentialityLevel} · {f.uploadedAt.slice(0, 16).replace("T", " ")}</small>
                </div>
              </div>
            )} />
          </div>
        ) : null}
      </div>
      {contactDialog.open ? <ContactDialog customerId={d.customer.id} contact={contactDialog.contact} onClose={() => setContactDialog({ open: false, contact: null })} /> : null}
    </div>
  );
}
