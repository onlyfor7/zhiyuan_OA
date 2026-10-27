import { formatYuan } from "../api/reference";
import { formatDateTime } from "../lib/trpc";
import { LEDGER_ENTRY_LABEL } from "../lib/labels";
import type { RouterOutputs } from "../lib/trpc";

interface Aggregate {
  hasBudget: boolean;
  effectiveBudgetCents: number;
  reservedCents: number;
  actualCents: number;
  availableCents: number;
  executionRate: number | null;
}

/**
 * 预算执行横条（基线 §13.4）：实际/占用/可用三段，
 * 数值与文字并列展示，不只依赖颜色；无预算显示「未设预算」。
 */
export function BudgetBar({ aggregate }: { aggregate: Aggregate }) {
  if (!aggregate.hasBudget) {
    return (
      <div className="budget-bar-wrap">
        <p className="no-budget-note">未设预算</p>
        <p className="context-note">该项目尚无生效预算；可用额度与执行率不适用（非余额为零）。</p>
      </div>
    );
  }
  const total = Math.max(aggregate.effectiveBudgetCents, 1);
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / total) * 100)).toFixed(2)}%`;
  const rate =
    aggregate.executionRate === null ? "—" : `${(aggregate.executionRate * 100).toFixed(1)}%`;
  return (
    <div className="budget-bar-wrap">
      <div className="budget-bar" role="img" aria-label={`执行率 ${rate}`}>
        <span className="seg actual" style={{ width: pct(aggregate.actualCents) }} />
        <span className="seg reserved" style={{ width: pct(aggregate.reservedCents) }} />
        <span className="seg available" style={{ width: pct(aggregate.availableCents) }} />
      </div>
      <div className="budget-legend">
        <span>
          <i className="dot actual" />
          实际支出 <strong>{formatYuan(aggregate.actualCents)} 元</strong>
        </span>
        <span>
          <i className="dot reserved" />
          有效占用 <strong>{formatYuan(aggregate.reservedCents)} 元</strong>
        </span>
        <span>
          <i className="dot available" />
          可用额度 <strong>{formatYuan(aggregate.availableCents)} 元</strong>
        </span>
      </div>
      <p className="context-note">
        有效预算 {formatYuan(aggregate.effectiveBudgetCents)} 元 · 预算执行率 {rate}（实际支出 ÷ 有效预算；
        已支付不重复计入）
      </p>
    </div>
  );
}

type LedgerItem = RouterOutputs["budget"]["ledger"]["items"][number];

/** 台账明细表（只追加；下钻视图） */
export function LedgerTable({
  items,
  highlightSourceId,
}: {
  items: LedgerItem[];
  highlightSourceId?: string | null;
}) {
  if (items.length === 0) return <p className="list-note">暂无台账分录。</p>;
  return (
    <div className="ledger-table">
      <div className="ledger-head">
        <span>时间</span>
        <span>编号</span>
        <span>分录类型</span>
        <span>占用变动（分）</span>
        <span>实际变动（分）</span>
        <span>来源</span>
      </div>
      {items.map((e) => (
        <div
          className={`ledger-row ${highlightSourceId && e.sourceId === highlightSourceId ? "highlight" : ""}`}
          key={e.id}
        >
          <time>{formatDateTime(e.occurredAt)}</time>
          <span className="mono">{e.code}</span>
          <span>{LEDGER_ENTRY_LABEL[e.entryType] ?? e.entryType}</span>
          <span className="mono">{e.reservedDeltaCents >= 0 ? `+${e.reservedDeltaCents}` : e.reservedDeltaCents}</span>
          <span className="mono">{e.actualDeltaCents >= 0 ? `+${e.actualDeltaCents}` : e.actualDeltaCents}</span>
          <span className="mono" title={e.idempotencyKey}>
            {e.sourceType} · {e.sourceId?.slice(0, 8) ?? "—"}
          </span>
        </div>
      ))}
    </div>
  );
}
