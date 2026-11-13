import { useMemo, useState } from "react";
import { toast } from "sonner";

import { useFinMutations, useProjectCosting, useProjectCostingList } from "../../api/fin";
import { useReceiptList } from "../../api/receipts";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { ListSkeleton } from "../../components/feedback";
import { formatYuan } from "../../api/reference";

const fmt = (cents: number) => `${formatYuan(cents)} 元`;

/** 经营组·项目核算（arch/12 §7.4：T-C——左项目列表内滚动+右核算卡：收入三块/成本三块/毛利双口径横条+月度趋势迷你图） */
export default function ProjectCostingPage() {
  const list = useProjectCostingList();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const costing = useProjectCosting(selectedId ?? list.data?.[0]?.projectId ?? null);
  const gen = useFinMutations();
  const items = list.data ?? [];
  const activeId = selectedId ?? items[0]?.projectId ?? null;

  if (list.isPending) return <ListSkeleton rows={5} />;
  if (list.isError) throw list.error;
  const c = costing.data;

  const blocks = c
    ? [
        ["项目收入（签约）", c.revenueCents],
        ["已回款（净额）", c.receivedCents],
        ["应收余额", c.arBalanceCents],
        ["直接成本", c.directCostCents],
        ["人力成本", c.laborCostCents],
        ["毛利（回款口径）", c.grossMarginCents],
      ]
    : [];
  // arch/13 §5.5 成本分段（加性三指标：售前+交付=总，总额=直接成本不重记）
  const segmented = c
    ? [
        ["售前成本", c.presalesCostCents],
        ["交付成本", c.deliveryCostCents],
        ["总成本", c.totalCostCents],
      ]
    : [];

  return (
    <div className="screen fin-costing-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">FIN · PROJECT COSTING</span>
          <h1>项目核算</h1>
          <p>口径=§7.3 冻结公式（服务端唯一实现 services/fin/costing）；毛利=已回款−直接−人力（另给签约口径）。</p>
        </div>
        <div className="title-actions">
          <button
            className="secondary-action"
            disabled={gen.generateReceivables.isPending}
            onClick={() => gen.generateReceivables.mutate(undefined, { onSuccess: (r) => toast.success(`应收生成完成：新增 ${r.created} 条`), onError: (err) => toast.error(String(err)) })}
          >
            生成应收（幂等）
          </button>
        </div>
      </div>
      <div className="fin-tc">
        <aside className="fin-tc-list">
          <span className="section-label">项目（内滚动）</span>
          <div className="p9a-scroll-list" style={{ marginTop: 6 }}>
            {items.map((p) => (
              <button
                className={`org-tree-label fin-tc-item ${activeId === p.projectId ? "active" : ""}`}
                key={p.projectId}
                onClick={() => setSelectedId(p.projectId)}
              >
                <DomainIconBlock domain="project" size={22} iconSize={13} />
                <span>{p.name}</span>
                <small className="mono" style={{ color: "var(--muted)" }}>{p.code}</small>
              </button>
            ))}
            {items.length === 0 ? <p className="list-note">暂无可核算项目（需 fin.read 或项目负责人）。</p> : null}
          </div>
        </aside>
        <section className="fin-tc-detail">
          {costing.isPending ? (
            <ListSkeleton rows={4} />
          ) : !c ? (
            <p className="list-note">选择左侧项目查看核算卡。</p>
          ) : (
            <>
              <div className="section-heading">
                <div>
                  <span className="section-label">COSTING · {c.code}</span>
                  <h2>{c.name}</h2>
                </div>
              </div>
              <div className="fin-cost-grid">
                {blocks.map(([label, value]) => (
                  <div className="p9a-metric" key={label as string} style={{ gridTemplateColumns: "1fr" }}>
                    <span>{label}</span>
                    <strong className="mono">{fmt(value as number)}</strong>
                  </div>
                ))}
      {segmented.length > 0 ? (
        <div className="metric-strip overview-strip" style={{ marginTop: 10 }} aria-label="成本分段">
          {segmented.map(([label, value]) => (
            <div key={label as string}>
              <span>{label}（§5.5）</span>
              <strong className="mono">{formatYuan(value as number)} 元</strong>
              <small>{label === "总成本" ? "=售前+交付（与直接成本一致，不重记）" : "按费用发生日 vs 合同激活日分段"}</small>
            </div>
          ))}
        </div>
      ) : null}
              </div>
              <span className="section-label" style={{ display: "block", marginTop: 14 }}>毛利横条（双口径）</span>
              <div className="fin-margin-bars">
                <MarginBar label="回款口径" value={c.grossMarginCents} base={c.receivedCents} tone={c.grossMarginCents >= 0 ? "green" : "red"} />
                <MarginBar label="签约口径" value={c.grossMarginOnContractCents} base={c.revenueCents} tone={c.grossMarginOnContractCents >= 0 ? "blue" : "red"} />
              </div>
              <span className="section-label" style={{ display: "block", marginTop: 14 }}>月度回款趋势（近 6 月，registered−voided 净额）</span>
              <MiniTrend projectId={c.projectId} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function MarginBar({ label, value, base, tone }: { label: string; value: number; base: number; tone: "green" | "blue" | "red" }) {
  const pct = base > 0 ? Math.round((value / base) * 100) : 0;
  const width = Math.min(100, Math.max(0, pct));
  const color = tone === "green" ? "#059669" : tone === "blue" ? "#2563eb" : "#dc2626";
  return (
    <div className="fin-margin-bar">
      <span style={{ width: 90 }}>{label}</span>
      <span className="p9a-progress" style={{ flex: 1 }}>
        <i style={{ width: `${width}%`, background: color }} />
        <b>{fmt(value)}（{pct}%）</b>
      </span>
    </div>
  );
}

/** 月度趋势迷你图：receipts.list（本项目）客户端按到账月聚合净额——纯前端组合，零新端点 */
function MiniTrend({ projectId }: { projectId: string }) {
  const list = useReceiptList({ projectId });
  const months = useMemo(() => {
    const out: Array<{ key: string; label: string; net: number }> = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: `${d.getMonth() + 1}月`, net: 0 });
    }
    const rows = list.data?.items ?? [];
    for (const r of rows) {
      const key = (r.receivedOn ?? "").slice(0, 7);
      const m = out.find((x) => x.key === key);
      if (m) m.net += r.status === "voided" ? -r.amountCents : r.amountCents;
    }
    return out;
  }, [list.data]);

  return (
    <div className="fin-trend">
      {months.map((m) => {
        const max = Math.max(1, ...months.map((x) => Math.abs(x.net)));
        const h = Math.round((Math.abs(m.net) / max) * 64);
        return (
          <div className="fin-trend-col" key={m.key}>
            <div
              className="fin-trend-bar"
              style={{ height: Math.max(3, h), background: m.net >= 0 ? "#059669" : "#dc2626" }}
              title={`${m.label}：${formatYuan(m.net)} 元`}
            />
            <span>{m.label}</span>
          </div>
        );
      })}
    </div>
  );
}
