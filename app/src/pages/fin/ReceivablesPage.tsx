import { useState } from "react";
import { Link } from "react-router";

import { useReceivableList } from "../../api/fin";
import { ListSkeleton } from "../../components/feedback";
import { formatYuan } from "../../api/reference";

const BUCKET_STYLE: Record<string, { bg: string; fg: string }> = {
  "0-30": { bg: "#fff4ec", fg: "#ea580c" },
  "31-60": { bg: "#fde8e8", fg: "#dc2626" },
  "61-90": { bg: "#fde8e8", fg: "#b91c1c" },
  "90+": { bg: "#7f1d1d", fg: "#fff" },
};
const AR_STATUS_LABEL: Record<string, string> = { open: "未收", partial: "部分", settled: "已结清" };
const AR_SOURCE_LABEL: Record<string, string> = { payment_plan: "计划到期", contract_active: "合同激活" };

/** 经营组·应收管理（arch/12 §7.4：T-A——账龄分桶徽标+逾期行红条+行内登记收款直跳预填） */
export default function ReceivablesPage() {
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const list = useReceivableList({ status: status || undefined, cursor });

  if (list.isPending) return <ListSkeleton rows={6} />;
  if (list.isError) throw list.error;

  return (
    <div className="screen fin-ar-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">FIN · RECEIVABLES</span>
          <h1>应收管理</h1>
          <p>账龄分桶=到期日+宽限（fin.ar.overdue_grace_days）服务端计算列；行内登记收款直跳收款台账预填合同/计划行。</p>
        </div>
        <select value={status} aria-label="状态筛选" onChange={(e) => { setStatus(e.target.value); setCursor(undefined); }}>
          <option value="">全部状态</option>
          {Object.entries(AR_STATUS_LABEL).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </div>
      <div className="p9a-ta-table" style={{ gridTemplateRows: "40px minmax(0,1fr)" }}>
        <div className="p9a-ta-head p9a-ta-row" style={{ gridTemplateColumns: "110px 1.4fr 130px 110px 100px 90px 110px 130px" }}>
          <span>应收单</span><span>客户</span><span>金额</span><span>到期日</span><span>账龄</span><span>状态</span><span>来源</span><span />
        </div>
        <div className="p9a-ta-body">
          {list.data.items.map((r) => {
            const overdue = r.agingBucket !== null;
            return (
              <div
                className="p9a-ta-row"
                key={r.id}
                style={{
                  gridTemplateColumns: "110px 1.4fr 130px 110px 100px 90px 110px 130px",
                  boxShadow: overdue ? "inset 3px 0 0 #dc2626" : undefined,
                  background: overdue ? "#fffbfb" : undefined,
                }}
              >
                <span className="mono">{r.code}</span>
                <strong>{r.customerName}</strong>
                <span className="mono">{formatYuan(r.amountCents)} 元</span>
                <span className="mono">{r.dueDate}</span>
                <span>
                  {r.agingBucket ? (
                    <span className="p9a-role-badge" style={{ background: BUCKET_STYLE[r.agingBucket].bg, color: BUCKET_STYLE[r.agingBucket].fg }}>
                      {r.agingBucket} 天{r.overdueDays != null ? `（${r.overdueDays}d）` : ""}
                    </span>
                  ) : (
                    <span className="p9a-role-badge alt">未到期</span>
                  )}
                </span>
                <span className="badge badge-health-normal">{AR_STATUS_LABEL[r.status] ?? r.status}</span>
                <span style={{ fontSize: 11 }}>{AR_SOURCE_LABEL[r.source] ?? r.source}</span>
                <span className="p9a-row-actions">
                  {r.status !== "settled" ? (
                    <Link
                      className="p9a-pill"
                      to={`/operations/receipts?prefill=1&contractId=${r.contractId ?? ""}&planId=${r.planId ?? ""}&customerId=${r.customerId}&amountCents=${r.amountCents}`}
                    >
                      登记收款
                    </Link>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="p9a-ta-pager">
        <span>共 {list.data.items.length} 条 · 每页 20</span>
        <div className="row-ops">
          <button className="secondary-action" disabled={!cursor} onClick={() => setCursor(undefined)}>上一页</button>
          <button className="secondary-action" disabled={!list.data.nextCursor} onClick={() => setCursor(list.data.nextCursor ?? undefined)}>下一页</button>
        </div>
      </div>
    </div>
  );
}
