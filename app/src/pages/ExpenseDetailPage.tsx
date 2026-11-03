import { useState } from "react";
import { BackButton } from "../components/feedback";
import { useParams } from "react-router";
import { ArrowRight, Check, ChevronRight, FileText, X } from "lucide-react";

import { useApproval } from "../api/approval";
import { fileDownloadUrl, filePreviewUrl } from "../api/archive";
import { useExpense, useExpenseMutations } from "../api/finance-expense";
import { formatYuan } from "../api/reference";
import { useMe } from "../api/auth";
import { newIdempotencyKey, rootErrorMessage } from "../lib/form";
import { EXPENSE_CATEGORY_LABEL, EXPENSE_STATUS_LABEL } from "../lib/labels";
import { businessCodeOf, businessDetailsOf, formatDateTime } from "../lib/trpc";

function ApprovalChecks({ instanceId }: { instanceId: string }) {
  const approval = useApproval(instanceId);
  if (approval.isPending) return <p className="list-note">正在加载审批快照…</p>;
  if (approval.isError) throw approval.error;
  const snapshot = approval.data.formSnapshot as { checks?: { name: string; pass: boolean; detail: string }[] } | null;
  const checks = snapshot?.checks ?? [];
  if (checks.length === 0) return null;
  return (
    <div className="checks-panel">
      <span className="section-label">APPROVAL CHECKS · 提交时检查项（随审批快照冻结）</span>
      {checks.map((c) => (
        <div className={`check-line ${c.pass ? "pass" : "fail"}`} key={c.name}>
          <Check size={14} />
          <strong>{c.name}</strong>
          <small>{c.detail}</small>
        </div>
      ))}
    </div>
  );
}

/** 报销详情：明细+票据+检查项+支付登记+调整/冲销（arch/06 §7） */
export default function ExpenseDetailPage() {
  const { expenseId } = useParams();
  const me = useMe();
  const expense = useExpense(expenseId ?? null);
  const mutations = useExpenseMutations();
  const [modal, setModal] = useState<"pay" | "adjust" | null>(null);
  const [paymentRef, setPaymentRef] = useState("");
  const [deltaYuan, setDeltaYuan] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [checksResult, setChecksResult] = useState<{ name: string; pass: boolean; detail: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (expense.isPending || me.isPending) return <p className="list-note">正在加载报销单…</p>;
  if (expense.isError) throw expense.error;
  if (me.isError) throw me.error;
  const r = expense.data;
  const isFinance = me.data.globalRoles.includes("finance");

  return (
    <div className="screen expense-detail-screen">
      <div className="project-title-row">
        <div>
          {/* G8 返回按钮 */}
          <BackButton />
          <div className="breadcrumb">
            <span>费用</span>
            <ChevronRight size={13} />
            <span>{r.code}</span>
          </div>
          <h1>
            {r.reason}
            {r.isCrossProject ? <em className="mark-duesoon">跨项目</em> : null}
          </h1>
          <p>
            申请人 {r.applicantId.slice(0, 8)} · 合计 <strong className="mono">{formatYuan(r.totalCents)} 元</strong>
            （服务端计算）
            {r.paidAt ? ` · 已支付 ${formatDateTime(r.paidAt)}（参考号 ${r.paymentRef}）` : ""}
          </p>
        </div>
        <div className="title-actions">
          <span className={`badge badge-travel-${r.status === "paid" ? "approved" : r.status === "rejected" ? "rejected" : "pending_approval"}`}>
            {EXPENSE_STATUS_LABEL[r.status]}
          </span>
        </div>
      </div>

      <div className="gantt-toolbar">
        <div className="toolbar-group">
          {r.status === "draft" ? (
            <button
              className="primary-action"
              disabled={mutations.submit.isPending}
              onClick={() => {
                setError(null);
                setChecksResult(null);
                mutations.submit.mutate(
                  { id: r.id, rowVersion: r.rowVersion, idempotencyKey: newIdempotencyKey() },
                  {
                    onSuccess: (res) => setChecksResult(res.checks),
                    onError: (err) => {
                      if (businessCodeOf(err) === "DUPLICATE_RECEIPT") {
                        const details = businessDetailsOf<{ originalReportCode?: string }>(err);
                        setError(
                          `重复票据：该票据已存在于报销单 ${details?.originalReportCode ?? "（未知）"}，已阻止提交。`,
                        );
                        return;
                      }
                      setError(rootErrorMessage(err));
                    },
                  },
                );
              }}
            >
              提交审批（五项检查）
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
                  { onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}
            >
              撤回
            </button>
          ) : null}
          {r.status === "approved_pending_payment" && isFinance ? (
            <button className="primary-action" onClick={() => setModal("pay")}>
              登记支付
            </button>
          ) : null}
          {r.status === "paid" ? (
            <button className="secondary-action" onClick={() => setModal("adjust")}>
              发起调整/冲销
            </button>
          ) : null}
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {checksResult ? (
        <div className="checks-panel">
          <span className="section-label">提交检查结果</span>
          {checksResult.map((c) => (
            <div className={`check-line ${c.pass ? "pass" : "fail"}`} key={c.name}>
              <Check size={14} />
              <strong>{c.name}</strong>
              <small>{c.detail}</small>
            </div>
          ))}
        </div>
      ) : null}
      {r.approvalInstanceId ? <ApprovalChecks instanceId={r.approvalInstanceId} /> : null}

      <span className="section-label">ITEMS</span>
      <h2>费用明细（{r.items.length}）</h2>
      <div className="expense-items-table">
        <div className="expense-items-head">
          <span>项目 / 日期</span>
          <span>类别</span>
          <span>金额</span>
          <span>票据</span>
          <span>说明 / 支付对象</span>
        </div>
        {r.items.map((it) => (
          <div className="expense-items-row" key={it.id}>
            <span>
              <strong>{it.projectId.slice(0, 8)}</strong>
              <small>{it.date}</small>
            </span>
            <span>{EXPENSE_CATEGORY_LABEL[it.category] ?? it.category}</span>
            <span className="mono">{formatYuan(it.amountCents)} 元</span>
            <span>
              {it.receiptSatisfied ? <em className="mark-duesoon satisfied">已合规</em> : <em className="mark-overdue">缺票据</em>}
              {it.receiptNo ? <small> {it.receiptNo}</small> : null}
              {it.receiptFileVersionId ? (
                <span className="archive-ops">
                  <a className="text-action" href={filePreviewUrl(it.receiptFileVersionId)} target="_blank" rel="noreferrer">
                    <FileText size={12} />
                    预览
                  </a>
                  <a className="text-action" href={fileDownloadUrl(it.receiptFileVersionId)}>
                    下载
                  </a>
                </span>
              ) : null}
            </span>
            <span>
              {it.description}
              {it.payee ? <small> → {it.payee}</small> : null}
              {it.fundingRequestId ? <small> · 经费 {it.fundingRequestId.slice(0, 8)}</small> : null}
            </span>
          </div>
        ))}
      </div>

      {r.adjustments.length > 0 ? (
        <div style={{ marginTop: 22 }}>
          <span className="section-label">ADJUSTMENTS</span>
          <h2>调整记录（{r.adjustments.length}）</h2>
          {r.adjustments.map((a) => (
            <div className="change-entry as-button" key={a.id}>
              <span>{a.code ?? "ADJ"}</span>
              <div>
                <strong>
                  {formatYuan(a.deltaCents)} 元 · {a.reason}
                </strong>
                <small>{a.status === "approved" ? "已通过（EXPENSE_ADJUSTED 已入账）" : a.status === "rejected" ? "已驳回" : "审批中"}</small>
              </div>
              {a.approvalInstanceId ? <ApprovalMini instanceId={a.approvalInstanceId} /> : null}
            </div>
          ))}
        </div>
      ) : null}

      {modal === "pay" ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setModal(null)}>
          <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="登记支付">
            <div className="drawer-head">
              <div>
                <span className="section-label">MARK PAID</span>
                <h2>支付登记</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setModal(null)}>
                <X size={19} />
              </button>
            </div>
            <p className="context-note">支付日期取服务端当前时间；登记后单据只读，更正只能走调整单。</p>
            <label className="form-field">
              <span>支付参考号 *</span>
              <input value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} placeholder="银行流水号/支票号" />
            </label>
            <button
              className="primary-action full-action"
              disabled={!paymentRef.trim() || mutations.markPaid.isPending}
              onClick={() => {
                setError(null);
                mutations.markPaid.mutate(
                  { id: r.id, paymentRef: paymentRef.trim(), idempotencyKey: newIdempotencyKey() },
                  {
                    onSuccess: () => {
                      setModal(null);
                      setPaymentRef("");
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              确认登记
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
      ) : null}

      {modal === "adjust" ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setModal(null)}>
          <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="发起调整">
            <div className="drawer-head">
              <div>
                <span className="section-label">ADJUSTMENT</span>
                <h2>调整/冲销（已支付单据唯一更正通道）</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setModal(null)}>
                <X size={19} />
              </button>
            </div>
            <div className="owner-line">
              <label className="form-field">
                <span>调整额（元，负数为冲销）*</span>
                <input type="number" step="0.01" value={deltaYuan} onChange={(e) => setDeltaYuan(e.target.value)} />
              </label>
              <label className="form-field span-2">
                <span>调整原因 *</span>
                <textarea rows={2} value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} />
              </label>
            </div>
            <button
              className="primary-action full-action"
              disabled={!deltaYuan || Number(deltaYuan) === 0 || !adjustReason.trim() || mutations.adjustCreate.isPending}
              onClick={() => {
                const deltaCents = Math.round(Number(deltaYuan) * 100);
                if (!deltaCents) return;
                setError(null);
                mutations.adjustCreate.mutate(
                  { expenseId: r.id, deltaCents, reason: adjustReason.trim(), idempotencyKey: newIdempotencyKey() },
                  {
                    onSuccess: () => {
                      setModal(null);
                      setDeltaYuan("");
                      setAdjustReason("");
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              提交调整审批
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function ApprovalMini({ instanceId }: { instanceId: string }) {
  const approval = useApproval(instanceId);
  if (approval.isPending) return <small>审批加载中…</small>;
  if (approval.isError) return null;
  return <time>{approval.data.status === "approved" ? "终审通过" : approval.data.status}</time>;
}

export { ApprovalMini };
