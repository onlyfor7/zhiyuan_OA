import { useState } from "react";
import { toast } from "sonner";

import { useContract, useContractList, useCrmMutations, useCustomer } from "../../api/crm";
import { FormDialog, DangerConfirm } from "../../components/FormDialog";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { ListSkeleton } from "../../components/feedback";
import { formatYuan } from "../../api/reference";
import { rootErrorMessage } from "../../lib/form";

const CONTRACT_STATUS_LABEL: Record<string, string> = { draft: "草稿", active: "履约中", completed: "已完成", terminated: "已终止" };
const PLAN_STATUS_LABEL: Record<string, string> = { unpaid: "未收", partial: "部分", paid: "已收" };

/** F2 Drawer：合同详情（基本信息+付款计划行编辑器+收款记录联动区） */
function ContractDrawer({ contractId, onClose }: { contractId: string; onClose: () => void }) {
  const contract = useContract(contractId);
  const customer = useCustomer(contract.data?.customerId ?? null);
  const m = useCrmMutations();
  const [rows, setRows] = useState<Array<{ seq: number; dueDate: string; amountYuan: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plans = (customer.data?.contracts ?? []).find((c) => c.id === contractId)?.plans ?? [];
  const derived = plans.map((p) => ({
    seq: p.seq,
    dueDate: p.dueDate,
    amountYuan: ((p as { amountCents: number }).amountCents / 100).toFixed(2),
  }));
  const shown = rows ?? derived;
  const setShown = (updater: (rs: Array<{ seq: number; dueDate: string; amountYuan: string }>) => Array<{ seq: number; dueDate: string; amountYuan: string }>) =>
    setRows(updater(shown));

  if (contract.isPending) return <FormDialog title="合同详情" eyebrow="CRM · F2" onClose={onClose} wide><ListSkeleton rows={4} /></FormDialog>;
  if (contract.isError) throw contract.error;
  const c = contract.data;
  const editable = c.status === "draft";

  return (
    <FormDialog title={`${c.title}`} eyebrow={`CRM · F2 抽屉 · ${CONTRACT_STATUS_LABEL[c.status] ?? c.status}`} onClose={onClose} wide>
      <div className="p9a-drawer-body">
        <div className="p9a-field-grid two">
          <label className="form-field"><span>合同编号</span><input defaultValue={c.code} disabled /></label>
          <label className="form-field"><span>金额（元）</span>
            <input defaultValue={"amountCents" in c && c.amountCents != null ? String((c.amountCents as number) / 100) : ""} disabled /></label>
          <label className="form-field"><span>签约日期</span><input defaultValue={c.signedAt ?? "—"} disabled /></label>
          <label className="form-field"><span>累计回款（元）</span>
            <input defaultValue={"cumulativeReceivedCents" in c && c.cumulativeReceivedCents != null ? String(((c.cumulativeReceivedCents as number) / 100).toFixed(2)) : "0.00"} disabled /></label>
        </div>
        <span className="section-label">付款计划行编辑器{!editable ? "（仅草稿可编辑）" : ""}</span>
        {shown.map((r, i) => (
          <div className="p9a-line-row" key={i} style={{ gridTemplateColumns: "70px 1fr 140px 60px 32px" }}>
            <span className="mono" style={{ fontSize: 11 }}>#{r.seq}</span>
            <input type="date" value={r.dueDate} disabled={!editable} aria-label="到期日"
              onChange={(e) => setShown((rs) => rs.map((x, xi) => (xi === i ? { ...x, dueDate: e.target.value } : x)))} />
            <input type="number" min="0.01" step="0.01" value={r.amountYuan} disabled={!editable} aria-label="计划金额"
              onChange={(e) => setShown((rs) => rs.map((x, xi) => (xi === i ? { ...x, amountYuan: e.target.value } : x)))} />
            <span className="entry-unit">元</span>
            <button className="icon-button" aria-label="删除行" disabled={!editable || shown.length === 1}
              onClick={() => setShown((rs) => rs.filter((_, xi) => xi !== i))}>×</button>
          </div>
        ))}
        {editable ? (
          <button className="secondary-action" onClick={() => setShown((rs) => [...rs, { seq: (rs[rs.length - 1]?.seq ?? 0) + 1, dueDate: new Date().toISOString().slice(0, 10), amountYuan: "" }])}>
            ＋ 添加计划行
          </button>
        ) : null}
        <span className="section-label">收款记录联动区（勾稽：登记收款挂计划行→状态写回）</span>
        {plans.length === 0 ? (
          <p className="list-note">暂无付款计划行；登记收款时可选挂计划行。</p>
        ) : (
          plans.map((p) => (
            <div className="p9a-schedule-row" key={p.id}>
              <DomainIconBlock domain="finance" size={22} iconSize={13} />
              <div className="p9a-queue-main">
                <strong>第 {p.seq} 期 · {(p as { amountCents: number }).amountCents != null ? formatYuan((p as { amountCents: number }).amountCents) : "—"} 元</strong>
                <small>到期 {p.dueDate} · {PLAN_STATUS_LABEL[(p as { status: string }).status] ?? (p as { status: string }).status}{(p as { receiptStatus?: string }).receiptStatus ? ` · 收款${(p as { receiptStatus: string }).receiptStatus === "registered" ? "已登记" : "已作废"}` : ""}</small>
              </div>
            </div>
          ))
        )}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <div className="p9a-modal-foot">
        <span>口径：累计回款=registered 原额；红冲=作废+冲正行（9d 台账增强）。</span>
        <div className="row-ops">
          <button className="secondary-action" onClick={onClose}>关闭</button>
          {editable ? (
            <button className="primary-action" disabled={m.upsertPlans.isPending}
              onClick={() => {
                setError(null);
                m.upsertPlans.mutate(
                  {
                    contractId: c.id,
                    rows: shown.map((r) => ({ seq: r.seq, dueDate: r.dueDate, amountCents: Math.round(Number(r.amountYuan) * 100) })),
                  },
                  { onSuccess: () => toast.success("付款计划已保存（守卫：仅草稿）"), onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}>
              保存付款计划
            </button>
          ) : null}
        </div>
      </div>
    </FormDialog>
  );
}

/** 客户组·合同管理（arch/12 §6.4：T-A 行内回款进度条；详情 F2 Drawer 行编辑器+收款联动） */
export default function ContractsPage() {
  const [status, setStatus] = useState("");
  const list = useContractList({ status: status || undefined });
  const m = useCrmMutations();
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [terminateTarget, setTerminateTarget] = useState<{ id: string; rowVersion: number; title: string } | null>(null);
  const [activateTarget, setActivateTarget] = useState<{ id: string; rowVersion: number; title: string } | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (list.isPending) return <ListSkeleton rows={6} />;
  if (list.isError) throw list.error;

  return (
    <div className="screen crm-contracts-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">CRM · CONTRACTS</span>
          <h1>合同管理</h1>
          <p>draft→active→completed/terminated；新建=商机赢单挂合同；详情 F2 抽屉含付款计划行编辑器。</p>
        </div>
        <select value={status} aria-label="状态筛选" onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          {Object.entries(CONTRACT_STATUS_LABEL).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </div>
      <div className="p9a-ta-table" style={{ gridTemplateRows: "40px minmax(0,1fr)" }}>
        <div className="p9a-ta-head p9a-ta-row" style={{ gridTemplateColumns: "120px 1.6fr 130px 1.4fr 110px 120px" }}>
          <span>编号</span><span>合同</span><span>金额</span><span>回款进度</span><span>状态</span><span>更新</span>
        </div>
        <div className="p9a-ta-body">
          {list.data.items.map((c) => {
            const amount = "amountCents" in c && c.amountCents != null ? (c.amountCents as number) : null;
            const received = "cumulativeReceivedCents" in c && c.cumulativeReceivedCents != null ? (c.cumulativeReceivedCents as number) : 0;
            const pct = amount ? Math.min(100, Math.round((received / amount) * 100)) : 0;
            return (
              <div className="p9a-ta-row" key={c.id} style={{ gridTemplateColumns: "120px 1.6fr 130px 1.4fr 110px 120px" }}>
                <span className="mono">{c.code}</span>
                <div>
                  <strong>{c.title}</strong>
                  <span className="p9a-row-actions">
                    <button className="text-action" onClick={() => setDrawerId(c.id)}>详情/付款计划</button>
                    {c.status === "draft" ? (
                      <button className="text-action" onClick={() => setActivateTarget(c)}>激活</button>
                    ) : null}
                    {c.status === "active" ? (
                      <button className="text-action" onClick={() => setTerminateTarget(c)}>终止</button>
                    ) : null}
                  </span>
                </div>
                <span className="mono">{amount != null ? `${formatYuan(amount)} 元` : "—"}</span>
                <span className="p9a-progress" title={`已回款 ${formatYuan(received)} 元`}>
                  <i style={{ width: `${pct}%`, background: pct >= 100 ? "var(--green)" : "var(--blue)" }} />
                  <b>{pct}%（{formatYuan(received)}）</b>
                </span>
                <span className="badge badge-health-normal">{CONTRACT_STATUS_LABEL[c.status] ?? c.status}</span>
                <span className="mono" style={{ fontSize: 10 }}>{c.updatedAt.slice(5, 16).replace("T", " ")}</span>
              </div>
            );
          })}
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {drawerId ? <ContractDrawer contractId={drawerId} onClose={() => setDrawerId(null)} /> : null}
      {activateTarget ? (
        <DangerConfirm
          title={`激活合同 · ${activateTarget.title}`}
          consequence={
            <>
              <strong>激活后该合同全链财务明细开放（arch/13 D4 分界），关联项目同事务转入交付（preparing→in_progress，同一项目）。</strong>
              <p>草稿期可改付款计划；激活后计划只读。此操作写入审计。</p>
            </>
          }
          confirmLabel="确认激活"
          pending={m.activateContract.isPending}
          onCancel={() => setActivateTarget(null)}
          onConfirm={() => {
            setError(null);
            m.activateContract.mutate(
              { id: activateTarget.id, rowVersion: activateTarget.rowVersion },
              {
                onSuccess: () => { toast.success("合同已激活：项目转入交付，财务明细按 D4 开放"); setActivateTarget(null); },
                onError: (err) => { setError(rootErrorMessage(err)); setActivateTarget(null); },
              },
            );
          }}
        />
      ) : null}
      {terminateTarget ? (
        <DangerConfirm
          title={`终止合同 · ${terminateTarget.title}`}
          consequence={
            <>
              <strong>终止后合同不再参与回款勾稽与统计。</strong>
              <p>原因必填并写入审计；更正=终止后重签。</p>
            </>
          }
          confirmLabel="确认终止"
          pending={m.terminateContract.isPending}
          onCancel={() => setTerminateTarget(null)}
          onConfirm={() => {
            if (!reason.trim()) {
              toast.error("请填写终止原因");
              return;
            }
            setError(null);
            m.terminateContract.mutate(
              { id: terminateTarget.id, rowVersion: terminateTarget.rowVersion, reason: reason.trim() },
              {
                onSuccess: () => { toast.success("合同已终止"); setTerminateTarget(null); setReason(""); },
                onError: (err) => { setError(rootErrorMessage(err)); setTerminateTarget(null); },
              },
            );
          }}
        />
      ) : null}
      {terminateTarget ? (
        <label className="form-field" style={{ display: "none" }}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      ) : null}
    </div>
  );
}
