import { useState } from "react";
import { BackButton } from "../components/feedback";
import { HelpIcon } from "../components/HelpIcon";
import { useParams } from "react-router";
import { ArrowRight, ChevronRight, Wallet, X } from "lucide-react";

import { useFunding, useFundingMutations } from "../api/finance-budget";
import { useBudgetLedger } from "../api/finance-budget";
import { formatYuan } from "../api/reference";
import { ApprovalSteps } from "../components/ApprovalSteps";
import { LedgerTable } from "../components/finance";
import { newIdempotencyKey, rootErrorMessage } from "../lib/form";
import { FUNDING_STATUS_LABEL, FUNDING_USAGE_LABEL } from "../lib/labels";

/** 经费详情：四数卡 + 审批进度 + 关闭/释放动作 + 台账下钻（arch/06 §7） */
export default function FundingDetailPage() {
  const { fundingId } = useParams();
  const funding = useFunding(fundingId ?? null);
  const mutations = useFundingMutations();
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeNote, setCloseNote] = useState("");
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (funding.isPending) return <p className="list-note">正在加载经费…</p>;
  if (funding.isError) throw funding.error;
  const f = funding.data;

  return (
    <div className="screen funding-detail-screen">
      <div className="project-title-row">
        <div>
          {/* G8 返回按钮 */}
          <BackButton />
          <div className="breadcrumb">
            <span>经费</span>
            <ChevronRight size={13} />
            <span>{f.code}</span>
          </div>
          <h1>
            {f.purpose}
            <HelpIcon pageKey="funding-detail" />
          </h1>
          <p>
            金额 {formatYuan(f.amountCents)} 元{f.expectedUseDate ? ` · 预计使用 ${f.expectedUseDate}` : ""}
            {f.recipientInfo ? ` · ${f.recipientInfo}` : ""}
          </p>
        </div>
        <div className="title-actions">
          <span className={`badge badge-travel-${f.approvalStatus === "approved" ? "approved" : f.approvalStatus === "pending_approval" ? "pending_approval" : "draft"}`}>
            {FUNDING_STATUS_LABEL[f.approvalStatus]}
          </span>
          <span className="badge">{FUNDING_USAGE_LABEL[f.usageStatus]}</span>
        </div>
      </div>

      <div className="metric-strip overview-strip funding-figures">
        <div>
          <span>已获批</span>
          <strong>{formatYuan(f.figures.approvedCents)}</strong>
          <small>元</small>
        </div>
        <div>
          <span>已关联费用</span>
          <strong>{formatYuan(f.figures.linkedCents)}</strong>
          <small>元（明细合计，不分状态）</small>
        </div>
        <div>
          <span>已释放/核销</span>
          <strong>{formatYuan(f.figures.releasedCents)}</strong>
          <small>元</small>
        </div>
        <div>
          <span>净占用余额</span>
          <strong className={f.figures.remainingCents > 0 ? "" : ""}>{formatYuan(f.figures.remainingCents)}</strong>
          <small>元（台账重算）</small>
        </div>
      </div>

      <div className="gantt-toolbar">
        <div className="toolbar-group">
          {f.approvalStatus === "draft" ? (
            <button
              className="primary-action"
              disabled={mutations.submit.isPending}
              onClick={() => {
                setError(null);
                mutations.submit.mutate(
                  { id: f.id, rowVersion: f.rowVersion, idempotencyKey: newIdempotencyKey() },
                  { onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}
            >
              提交审批
              <ArrowRight size={15} />
            </button>
          ) : null}
          {f.approvalStatus === "pending_approval" ? (
            <button
              className="secondary-action"
              disabled={mutations.withdraw.isPending}
              onClick={() => {
                setError(null);
                mutations.withdraw.mutate(
                  { id: f.id, rowVersion: f.rowVersion },
                  { onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}
            >
              撤回
            </button>
          ) : null}
          {f.approvalStatus === "approved" && f.usageStatus !== "closed" ? (
            <>
              <button
                className="secondary-action"
                disabled={mutations.releaseUnused.isPending || f.figures.remainingCents <= 0}
                onClick={() => {
                  if (!window.confirm(`确认释放未使用额度 ${formatYuan(f.figures.remainingCents)} 元？将写入 FUNDING_RELEASED 台账。`)) return;
                  setError(null);
                  mutations.releaseUnused.mutate(
                    { id: f.id, rowVersion: f.rowVersion },
                    { onError: (err) => setError(rootErrorMessage(err)) },
                  );
                }}
              >
                释放未使用额度
              </button>
              <button className="secondary-action" onClick={() => setCloseOpen(true)}>
                关闭经费
              </button>
            </>
          ) : null}
          <button className="text-action" onClick={() => setLedgerOpen((v) => !v)}>
            {ledgerOpen ? "收起台账" : "台账下钻"}
          </button>
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {f.approvalInstanceId ? <ApprovalSteps instanceId={f.approvalInstanceId} /> : null}
      {ledgerOpen ? (
        <FundingLedger projectId={f.projectId} fundingId={f.id} />
      ) : null}

      {closeOpen ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setCloseOpen(false)}>
          <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="关闭经费">
            <div className="drawer-head">
              <div>
                <span className="section-label">CLOSE FUNDING</span>
                <h2>关闭经费</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setCloseOpen(false)}>
                <X size={19} />
              </button>
            </div>
            <ul className="governance-notes">
              <li>
                <Wallet size={14} />
                存在审批中的报销时不可关闭（服务端阻断并提示）。
              </li>
              <li>
                <Wallet size={14} />
                关闭时未使用额度 {formatYuan(f.figures.remainingCents)} 元将自动释放（FUNDING_RELEASED）。
              </li>
            </ul>
            <label className="form-field">
              <span>关闭说明 *</span>
              <textarea rows={2} value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
            </label>
            <button
              className="primary-action full-action"
              disabled={!closeNote.trim() || mutations.close.isPending}
              onClick={() => {
                setError(null);
                mutations.close.mutate(
                  { id: f.id, rowVersion: f.rowVersion, note: closeNote.trim() },
                  {
                    onSuccess: () => setCloseOpen(false),
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              确认关闭
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function FundingLedger({ projectId, fundingId }: { projectId: string; fundingId: string }) {
  const ledger = useBudgetLedger({ projectId });
  if (ledger.isPending) return <p className="list-note">正在加载台账…</p>;
  if (ledger.isError) throw ledger.error;
  return (
    <div style={{ marginTop: 18 }}>
      <LedgerTable items={ledger.data.items.filter((e) => e.sourceId === fundingId)} highlightSourceId={fundingId} />
      <p className="context-note">仅显示本源单相关分录；全项目台账见预算页「台账下钻」。</p>
    </div>
  );
}

export { FundingLedger };
