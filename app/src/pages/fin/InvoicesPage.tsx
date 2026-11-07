import { useState } from "react";
import { toast } from "sonner";

import { useCompany } from "../../api/org";
import { useCustomerList, useContractList } from "../../api/crm";
import { useReceivableList, useInvoiceList, useFinMutations } from "../../api/fin";
import { FormDialog } from "../../components/FormDialog";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { ListSkeleton } from "../../components/feedback";
import { formatYuan } from "../../api/reference";
import { rootErrorMessage } from "../../lib/form";

const INVOICE_STATUS_LABEL: Record<string, string> = { draft: "草稿", issued: "已开具", sent: "已寄送", voided: "已红冲" };

/** F2 抽屉：开具发票——客户/合同/应收联动带出金额+税率；抬头取公司信息（org.company.get 登录可读） */
function InvoiceDrawer({ onClose }: { onClose: () => void }) {
  const m = useFinMutations();
  const company = useCompany();
  const customers = useCustomerList({});
  const [customerId, setCustomerId] = useState("");
  const [contractId, setContractId] = useState("");
  const [receivableId, setReceivableId] = useState("");
  const [amountYuan, setAmountYuan] = useState("");
  const [taxRate, setTaxRate] = useState(6);
  const [error, setError] = useState<string | null>(null);

  const contracts = useContractList({ customerId: customerId || undefined });
  const receivables = useReceivableList({ customerId: customerId || undefined });

  const linkReceivable = (id: string) => {
    setReceivableId(id);
    const r = (receivables.data?.items ?? []).find((x) => x.id === id);
    if (r) setAmountYuan(String(r.amountCents / 100));
    const c = (contracts.data?.items ?? []).find((x) => x.id === r?.contractId);
    if (c) setContractId(c.id);
  };

  return (
    <FormDialog title="开具发票" eyebrow="FIN · F2 抽屉（应收/合同联动带出）" onClose={onClose} wide>
      <div className="p9a-drawer-body">
        <label className="form-field">
          <span>客户 *</span>
          <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setContractId(""); setReceivableId(""); }}>
            <option value="">选择客户</option>
            {(customers.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <div className="owner-line">
          <label className="form-field">
            <span>关联合同（选填）</span>
            <select value={contractId} onChange={(e) => setContractId(e.target.value)}>
              <option value="">不关联</option>
              {(contracts.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>联动应收（带出金额）</span>
            <select value={receivableId} onChange={(e) => linkReceivable(e.target.value)}>
              <option value="">不联动</option>
              {(receivables.data?.items ?? []).filter((r) => r.status !== "settled").map((r) => (
                <option key={r.id} value={r.id}>{r.code} · {formatYuan(r.amountCents)} 元</option>
              ))}
            </select>
          </label>
        </div>
        <div className="owner-line">
          <label className="form-field">
            <span>价税合计（元）{receivableId ? "（应收带出可改）" : "*"}</span>
            <input type="number" min="0.01" step="0.01" value={amountYuan} onChange={(e) => setAmountYuan(e.target.value)} />
          </label>
          <label className="form-field">
            <span>税率（%）</span>
            <input type="number" min="0" max="100" value={taxRate} onChange={(e) => setTaxRate(Number(e.target.value))} />
          </label>
        </div>
        <span className="section-label">发票抬头（取公司信息）</span>
        <div className="ux-danger-box" style={{ borderLeftColor: "#2563eb", background: "#eff4ff" }}>
          <strong>{company.data?.name ?? "（公司信息未维护）"}</strong>
          <p>税号 {company.data?.creditCode ?? "—"} · 开户行 {company.data?.bankName ?? "—"} · 账号 {company.data?.bankAccount ?? "—"}</p>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <div className="p9a-modal-foot">
        <span>开具后状态 draft→issued；寄送登记→sent；红冲=voided+负数冲正行。</span>
        <div className="row-ops">
          <button className="secondary-action" onClick={onClose}>取消</button>
          <button
            className="primary-action"
            disabled={!customerId || !amountYuan || m.createInvoice.isPending}
            onClick={() => {
              setError(null);
              m.createInvoice.mutate(
                {
                  customerId,
                  contractId: contractId || null,
                  receivableId: receivableId || null,
                  amountCents: Math.round(Number(amountYuan) * 100),
                  taxRate,
                },
                {
                  onSuccess: () => { toast.success("发票已开具（抬头引用公司信息）"); onClose(); },
                  onError: (err) => setError(rootErrorMessage(err)),
                },
              );
            }}
          >
            开具发票
          </button>
        </div>
      </div>
    </FormDialog>
  );
}

/** 经营组·发票管理（arch/12 §7.4：T-A——开具 F2 抽屉联动+状态列含寄送登记+红冲 DangerConfirm） */
export default function InvoicesPage() {
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const list = useInvoiceList({ status: status || undefined, cursor });
  const customers = useCustomerList({});
  const m = useFinMutations();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{ id: string; rowVersion: number; code: string } | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const customerName = (id: string) => (customers.data?.items ?? []).find((x) => x.id === id)?.name ?? "—";

  if (list.isPending) return <ListSkeleton rows={6} />;
  if (list.isError) throw list.error;

  return (
    <div className="screen fin-invoices-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">FIN · INVOICES</span>
          <h1>发票管理</h1>
          <p>draft→issued→sent / voided（红冲=voided+负数冲正行）；抬头取公司信息。</p>
        </div>
        <div className="title-actions">
          <select value={status} aria-label="状态筛选" onChange={(e) => { setStatus(e.target.value); setCursor(undefined); }}>
            <option value="">全部状态</option>
            {Object.entries(INVOICE_STATUS_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <button className="primary-action" onClick={() => setDrawerOpen(true)}>
            开具发票
          </button>
        </div>
      </div>
      <div className="p9a-ta-table" style={{ gridTemplateRows: "40px minmax(0,1fr)" }}>
        <div className="p9a-ta-head p9a-ta-row" style={{ gridTemplateColumns: "110px 1fr 130px 80px 100px 130px 150px" }}>
          <span>发票号</span><span>客户</span><span>价税合计</span><span>税率</span><span>状态</span><span>开具</span><span />
        </div>
        <div className="p9a-ta-body">
          {list.data.items.map((inv) => (
            <div className="p9a-ta-row" key={inv.id} style={{ gridTemplateColumns: "110px 1fr 130px 80px 100px 130px 150px" }}>
              <span className="mono">{inv.code}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <DomainIconBlock domain="finance" size={22} iconSize={13} />
                {customerName(inv.customerId)}
              </span>
              <span className="mono" style={inv.amountCents < 0 ? { color: "#dc2626" } : undefined}>{formatYuan(inv.amountCents)} 元</span>
              <span className="mono">{inv.taxRate ?? "—"}%</span>
              <span className="badge badge-health-normal">{INVOICE_STATUS_LABEL[inv.status] ?? inv.status}</span>
              <span className="mono" style={{ fontSize: 10 }}>
                {inv.issuedAt ? inv.issuedAt.slice(5, 16).replace("T", " ") : "—"}
              </span>
              <span className="p9a-row-actions">
                {inv.status === "draft" ? (
                  <button className="text-action" onClick={() => m.issueInvoice.mutate({ id: inv.id, rowVersion: inv.rowVersion }, { onSuccess: () => toast.success("已开具"), onError: (err) => toast.error(rootErrorMessage(err)) })}>
                    开具
                  </button>
                ) : null}
                {inv.status === "issued" ? (
                  <button className="text-action" onClick={() => m.markInvoiceSent.mutate({ id: inv.id, rowVersion: inv.rowVersion }, { onSuccess: () => toast.success("寄送已登记"), onError: (err) => toast.error(rootErrorMessage(err)) })}>
                    寄送登记
                  </button>
                ) : null}
                {["draft", "issued", "sent"].includes(inv.status) ? (
                  <button className="text-action" onClick={() => setVoidTarget(inv)}>红冲</button>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="p9a-ta-pager">
        <span>本页 {list.data.items.length} 条 · 每页 20</span>
        <div className="row-ops">
          <button className="secondary-action" disabled={!cursor} onClick={() => setCursor(undefined)}>上一页</button>
          <button className="secondary-action" disabled={!list.data.nextCursor} onClick={() => setCursor(list.data.nextCursor ?? undefined)}>下一页</button>
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {drawerOpen ? <InvoiceDrawer onClose={() => setDrawerOpen(false)} /> : null}
      {voidTarget ? (
        <FormDialog title={`红冲发票 · ${voidTarget.code}`} eyebrow="FIN · 高危确认" onClose={() => setVoidTarget(null)}>
          <div className="ux-danger-box" style={{ marginBottom: 12 }}>
            <strong>红冲=voided + 负数冲正行（不删除）。</strong>
            <p>原因必填并写入审计；冲正行与发票勾稽。</p>
          </div>
          <label className="form-field">
            <span>红冲原因 *</span>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setVoidTarget(null)}>取消</button>
            <button
              className="danger-action"
              disabled={!reason.trim() || m.voidInvoice.isPending}
              onClick={() => {
                setError(null);
                m.voidInvoice.mutate(
                  { id: voidTarget.id, rowVersion: voidTarget.rowVersion, reason: reason.trim() },
                  {
                    onSuccess: () => { toast.success("已红冲（含冲正行）"); setVoidTarget(null); setReason(""); },
                    onError: (err) => { setError(rootErrorMessage(err)); setVoidTarget(null); },
                  },
                );
              }}
            >
              确认红冲
            </button>
          </div>
        </FormDialog>
      ) : null}
    </div>
  );
}
