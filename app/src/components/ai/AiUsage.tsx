import { useMemo } from "react";

import type { AiUsageRow } from "../../api/ai";

/**
 * §17.6 用量视图：本人（设置页「我的 AI 用量」——近 30 天按日柱条+按能力分组）；
 * sysadmin 全局（AI 配置页内——按人 Top+按日趋势）。纯渲染聚合 rows，零公式。
 */

const CAP_LABEL: Record<string, string> = {
  form_prefill: "表单预填",
  time_draft: "工时草稿",
  minutes_draft: "纪要草稿",
  flow_draft: "审批流草稿",
  answer: "只读问答",
};

function DayBars({ rows, by }: { rows: Array<{ day: string; total: number }>; by: string }) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  if (rows.length === 0) return <p className="list-note">近 30 天暂无用量。</p>;
  return (
    <div className="rep-mini-plot ai-usage-bars" role="img" aria-label={`按日用量柱条（${by}）`}>
      {rows.map((r) => (
        <div className="rep-mini-col" key={r.day} title={`${r.day}：${r.total}`}>
          <div className="rep-mini-bars">
            <i style={{ height: `${Math.max(3, (r.total / max) * 72)}px`, background: "#7c3aed" }} />
          </div>
          <small>{r.day.slice(5)}</small>
        </div>
      ))}
    </div>
  );
}

function CapGroups({ rows }: { rows: AiUsageRow[] }) {
  const caps = useMemo(() => {
    const m = new Map<string, { calls: number; tin: number; tout: number }>();
    for (const r of rows) {
      const e = m.get(r.capability) ?? { calls: 0, tin: 0, tout: 0 };
      e.calls += r.calls;
      e.tin += r.tokens_in;
      e.tout += r.tokens_out;
      m.set(r.capability, e);
    }
    return [...m.entries()].sort((a, b) => b[1].calls - a[1].calls);
  }, [rows]);
  if (caps.length === 0) return null;
  return (
    <div className="ai-cap-groups">
      {caps.map(([cap, v]) => (
        <span className="p9a-role-badge alt" key={cap} title={`in ${v.tin} / out ${v.tout} tokens`}>
          {CAP_LABEL[cap] ?? cap} · {v.calls} 次
        </span>
      ))}
    </div>
  );
}

/** 本人视图：日柱条（按 calls 合计）+按能力分组（设置页卡） */
export function MyUsageView({ items }: { items: AiUsageRow[] }) {
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of items) m.set(r.day, (m.get(r.day) ?? 0) + r.calls);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, total]) => ({ day, total }));
  }, [items]);
  const totalCalls = items.reduce((s, r) => s + r.calls, 0);
  return (
    <>
      <p className="context-note">近 30 天共 {totalCalls} 次调用（MockProvider 按字符/4 估算 token，审计全量留痕）。</p>
      <DayBars rows={byDay} by="调用次数" />
      <span className="section-label">按能力分组</span>
      <CapGroups rows={items} />
    </>
  );
}

/** 全局视图：按人 Top（calls 合计降序）+按日趋势（sysadmin） */
export function GlobalUsageView({ items }: { items: AiUsageRow[] }) {
  const byUser = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of items) m.set(r.user_name ?? "—", (m.get(r.user_name ?? "—") ?? 0) + r.calls);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [items]);
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of items) m.set(r.day, (m.get(r.day) ?? 0) + r.calls);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, total]) => ({ day, total }));
  }, [items]);
  const max = Math.max(1, ...byUser.map(([, v]) => v));
  return (
    <>
      <span className="section-label">按人 Top（调用次数）</span>
      {byUser.length === 0 ? (
        <p className="list-note">暂无全局用量。</p>
      ) : (
        <div className="rep-hbar-rows">
          {byUser.map(([name, v]) => (
            <div className="rep-hbar-row" key={name}>
              <span className="rep-funnel-label" title={name}>{name}</span>
              <span className="rep-funnel-track"><i style={{ width: `${Math.max(3, (v / max) * 100)}%`, background: "#7c3aed" }} /></span>
              <span className="mono rep-funnel-val">{v} 次</span>
            </div>
          ))}
        </div>
      )}
      <span className="section-label">按日趋势</span>
      <DayBars rows={byDay} by="调用次数" />
      <span className="section-label">明细（人×日×能力）</span>
      {items.length === 0 ? (
        <p className="list-note">暂无明细。</p>
      ) : (
        <div className="biz-table" role="table" style={{ "--biz-cols": 6 } as never}>
          <div className="biz-tr biz-head" role="row">
            <span>用户</span><span>日期</span><span>能力</span><span>次数</span><span>入 tokens</span><span>出 tokens</span>
          </div>
          {items.slice(0, 15).map((r, i) => (
            <div className="biz-tr" role="row" key={i}>
              <span>{r.user_name}</span>
              <span className="mono">{r.day}</span>
              <span>{CAP_LABEL[r.capability] ?? r.capability}</span>
              <span className="mono">{r.calls}</span>
              <span className="mono">{r.tokens_in}</span>
              <span className="mono">{r.tokens_out}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
