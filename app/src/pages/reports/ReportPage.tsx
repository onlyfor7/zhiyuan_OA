import { useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { useReport, useReportExport, type ReportFilterInput } from "../../api/reports";
import { useMe } from "../../api/auth";
import { useTRPC } from "../../lib/trpc";
import { useQuery } from "@tanstack/react-query";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { ListSkeleton } from "../../components/feedback";
import { formatYuan } from "../../api/reference";
import { REPORT_CATEGORIES, REPORT_META_BY_KEY } from "./meta";

const PAGE_SIZE = 20;
const CRM_READ_ROLES = ["partner", "finance", "project_manager"];
const ORG_READ_ROLES = ["sysadmin", "partner"];

/** 收款账龄分桶色阶（0-30 最浅 → 90+ 最深；逾期红系） */
const AGING_SCALE: Record<string, string> = {
  "0-30": "#fde8e8",
  "31-60": "#fbd0d0",
  "61-90": "#f7b1b1",
  "90+": "#f08a8a",
};

const VIEW_TABS: Array<[string, string]> = [
  ["person", "按人"],
  ["project", "按项目"],
  ["department", "按部门"],
];

/**
 * 单报表页共用骨架（arch/12 §8.1 T-A 变体）：筛选条＋指标卡带＋迷你图＋表格（内滚动+分页）＋导出 CSV。
 * 统一 {columns,rows,summaryCards}；筛选/口径全在 server，前端零公式。
 */
export default function ReportPage() {
  const { key } = useParams();
  const meta = key ? REPORT_META_BY_KEY.get(key as never) : undefined;
  if (!meta) return <Navigate to="/reports" replace />;

  return <ReportSkeleton reportKey={meta.key} />;
}

function ReportSkeleton({ reportKey }: { reportKey: string }) {
  const meta = REPORT_META_BY_KEY.get(reportKey as never)!;
  const me = useMe();
  const trpc = useTRPC();
  const roles = me.data?.globalRoles ?? [];
  const showCustomer = meta.filters.customer && CRM_READ_ROLES.some((r) => roles.includes(r));
  const showOrgUnit = meta.filters.orgUnit && ORG_READ_ROLES.some((r) => roles.includes(r));

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [projectId, setProjectId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [orgUnitId, setOrgUnitId] = useState("");
  const [view, setView] = useState<"person" | "project" | "department">("person");
  const [page, setPage] = useState(0);

  const filter: ReportFilterInput = {
    ...(meta.filters.fromTo && from ? { from } : {}),
    ...(meta.filters.fromTo && to ? { to } : {}),
    ...(meta.filters.project && projectId ? { projectId } : {}),
    ...(showCustomer && customerId ? { customerId } : {}),
    ...(showOrgUnit && orgUnitId ? { orgUnitId } : {}),
    ...(meta.filters.view ? { view } : {}),
  };

  const projects = useQuery(trpc.project.list.queryOptions({ limit: 100, filters: {} }, { enabled: !!meta.filters.project && meta.category !== "finance" }));
  /** §20.4 观察项：finance 类报表项目下拉接 financeOptions 参照端点（project.list 对 finance 同形 404 时下拉只剩"全部项目"） */
  const finProjects = useQuery(trpc.project.financeOptions.queryOptions(undefined, { enabled: !!meta.filters.project && meta.category === "finance" }));
  const customers = useQuery(trpc.crm.customers.list.queryOptions({ limit: 50 }, { enabled: showCustomer }));
  const units = useQuery(trpc.org.units.tree.queryOptions(undefined, { enabled: showOrgUnit }));

  const report = useReport(meta.key, filter);
  const exportCsv = useReportExport();

  const data = report.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cur = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE);

  const cat = REPORT_CATEGORIES.find((c) => c.key === meta.category);

  const doExport = () => {
    exportCsv.mutate(
      { key: meta.key, filter },
      {
        onSuccess: (r) => {
          const a = document.createElement("a");
          a.href = r.downloadPath;
          a.download = `report-${meta.key}.csv`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          toast.success("导出完成，浏览器已开始下载", {
            description: `report-${meta.key} · ${r.rowCount} 行 CSV；生成文件已落 file_objects(source=report)，审计 report.export 同事务留痕。`,
          });
        },
        onError: (err) => toast.error("导出失败", { description: String(err).slice(0, 120) }),
      },
    );
  };

  if (me.isPending || report.isPending) return <ListSkeleton rows={6} />;
  if (report.isError) throw report.error;

  const cols = data?.columns ?? [];
  const colGrid = `minmax(140px, 1.2fr) repeat(${Math.max(0, cols.length - 1)}, minmax(96px, 1fr))`;
  const aging = meta.key === "receivable_aging" ? AGING_SCALE : null;

  return (
    <div className="screen rep-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">{meta.eyebrow}</span>
          <h1 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {cat ? <DomainIconBlock domain={cat.icon} size={26} iconSize={15} /> : null}
            {meta.title}
          </h1>
          <p>
            {meta.desc}
            <Link to="/reports" className="rep-back">← 返回工作台</Link>
          </p>
        </div>
        <div className="title-actions">
          <button className="secondary-action" disabled={exportCsv.isPending || (data?.rows.length ?? 0) === 0} onClick={doExport}>
            <Download size={15} />
            {exportCsv.isPending ? "导出中…" : "导出 CSV"}
          </button>
        </div>
      </div>

      {meta.filters.view ? (
        <div className="p9a-wizard-tabs" role="tablist" aria-label="工时视角">
          {VIEW_TABS.map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "active" : ""} onClick={() => { setView(v as never); setPage(0); }}>
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {(meta.filters.fromTo || meta.filters.project || showCustomer || showOrgUnit) && (
        <div className="quality-toolbar rep-filter">
          {meta.filters.fromTo ? (
            <>
              <input type="date" aria-label="开始日期" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} />
              <span className="toolbar-hint">至</span>
              <input type="date" aria-label="结束日期" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} />
            </>
          ) : null}
          {meta.filters.project ? (
            <select value={projectId} aria-label="项目筛选" onChange={(e) => { setProjectId(e.target.value); setPage(0); }}>
              <option value="">{meta.category === "finance" ? "全部项目（财务参照口径）" : "全部项目"}</option>
              {(meta.category === "finance" ? (finProjects.data ?? []) : (projects.data?.items ?? [])).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          ) : null}
          {showCustomer ? (
            <select value={customerId} aria-label="客户筛选" onChange={(e) => { setCustomerId(e.target.value); setPage(0); }}>
              <option value="">全部客户</option>
              {(customers.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          ) : null}
          {showOrgUnit ? (
            <select value={orgUnitId} aria-label="部门筛选" onChange={(e) => { setOrgUnitId(e.target.value); setPage(0); }}>
              <option value="">全部部门</option>
              {(units.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          ) : null}
          <span className="toolbar-hint rep-filter-note">筛选即时生效 · 口径=server services 唯一实现</span>
        </div>
      )}

      {data && data.summaryCards.length > 0 ? (
        <div className="metric-strip overview-strip rep-cards">
          {data.summaryCards.map((c) => (
            <div key={c.key}>
              <span>{meta.label ? meta.label(c.label) : c.label}</span>
              <strong className="mono">{meta.summary(c.key, c.value)}</strong>
            </div>
          ))}
        </div>
      ) : null}

      {meta.mini !== "none" && pageRows.length > 0 ? <MiniChart kind={meta.mini} meta={meta} rows={pageRows} /> : null}

      {cols.length === 0 ? (
        <div className="pending-box rep-empty">
          <DomainIconBlock domain={cat?.icon ?? "report"} size={30} iconSize={17} />
          <p className="context-note">
            {(data?.summaryCards.find((c) => c.key === "note")?.value as string) ?? "当前口径无可展示数据（空集同形状返回，属预期权限口径）。"}
          </p>
        </div>
      ) : (
        <div className="rep-table-scroll">
          <div className="p9a-ta-table rep-table rep-excel" style={{ minWidth: `${cols.length * 110}px` }}>
            <div className="p9a-ta-head p9a-ta-row" style={{ gridTemplateColumns: colGrid }}>
              {cols.map((c) => <span key={c.key}>{meta.label ? meta.label(c.label) : c.label}</span>)}
            </div>
            <div className="p9a-ta-body">
              {pageRows.map((r, i) => (
                <div className="p9a-ta-row" key={i} style={{ gridTemplateColumns: colGrid }}>
                  {cols.map((c) => (
                    <span
                      key={c.key}
                      className={typeof r[c.key] === "number" ? "mono" : undefined}
                      style={aging && aging[c.key] && typeof r[c.key] === "number" && (r[c.key] as number) > 0 ? { background: aging[c.key] } : undefined}
                      title={meta.cell(c.key, r[c.key])}
                    >
                      {meta.cell(c.key, r[c.key])}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {rows.length > PAGE_SIZE ? (
        <div className="p9a-ta-pager">
          <span>共 {rows.length} 行 · 第 {cur + 1}/{pageCount} 页 · 每页 {PAGE_SIZE}</span>
          <div className="row-ops">
            <button className="secondary-action" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
            <button className="secondary-action" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        </div>
      ) : (
        <div className="p9a-ta-pager"><span>共 {rows.length} 行</span></div>
      )}
    </div>
  );
}

/** 迷你图：月度收支柱 / 横向漏斗条 / 横向条形（均纯渲染 rows，零公式） */
function MiniChart({ kind, meta, rows }: { kind: string; meta: { miniValueKey?: string; cell: (k: string, v: unknown) => string }; rows: Array<Record<string, unknown>> }) {
  if (kind === "cashflow") {
    const max = Math.max(1, ...rows.flatMap((r) => [Math.abs(Number(r.income ?? 0)), Math.abs(Number(r.expense ?? 0))]));
    return (
      <div className="rep-mini rep-mini-cashflow">
        <span className="section-label">月度收支柱（{rows.length} 月 · 收绿 / 支橙）</span>
        <div className="rep-mini-plot">
          {rows.map((r) => (
            <div className="rep-mini-col" key={String(r.month)} title={`${r.month}：收 ${formatYuan(Number(r.income ?? 0))} / 支 ${formatYuan(Number(r.expense ?? 0))}`}>
              <div className="rep-mini-bars">
                <i style={{ height: `${Math.max(3, (Math.abs(Number(r.income ?? 0)) / max) * 72)}px`, background: "#059669" }} />
                <i style={{ height: `${Math.max(3, (Math.abs(Number(r.expense ?? 0)) / max) * 72)}px`, background: "#ea580c" }} />
              </div>
              <small>{String(r.month).slice(5)}月</small>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (kind === "funnel") {
    const max = Math.max(1, ...rows.map((r) => Number(r[meta.miniValueKey ?? "count"] ?? 0)));
    const tones = ["#93c5fd", "#60a5fa", "#3b82f6", "#2563eb", "#059669", "#dc2626"];
    return (
      <div className="rep-mini rep-mini-funnel">
        <span className="section-label">六阶段漏斗（宽度∝数量）</span>
        <div className="rep-funnel-rows">
          {rows.map((r, i) => {
            const v = Number(r[meta.miniValueKey ?? "count"] ?? 0);
            return (
              <div className="rep-funnel-row" key={i}>
                <span className="rep-funnel-label">{meta.cell("stage", r.stage)}</span>
                <span className="rep-funnel-track">
                  <i style={{ width: `${Math.max(2, (v / max) * 100)}%`, background: tones[i % tones.length] }} />
                </span>
                <span className="mono rep-funnel-val">{v}{typeof r.amount === "number" ? ` · ${formatYuan(r.amount)} 元` : ""}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  // hbars
  const vk = meta.miniValueKey ?? "minutes";
  const max = Math.max(1, ...rows.map((r) => Number(r[vk] ?? 0)));
  const top = rows.slice(0, 10);
  return (
    <div className="rep-mini rep-mini-hbars">
      <span className="section-label">Top {Math.min(10, rows.length)} 条形（宽度∝{vk === "utilization" ? "利用率%" : vk === "contractSum" ? "合同额" : "工时"}）</span>
      <div className="rep-hbar-rows">
        {top.map((r, i) => {
          const label = String(r.name ?? r.project ?? r.department ?? r.customer ?? "—");
          const v = Number(r[vk] ?? 0);
          return (
            <div className="rep-hbar-row" key={i}>
              <span className="rep-funnel-label" title={label}>{label}</span>
              <span className="rep-funnel-track">
                <i style={{ width: `${Math.max(2, (v / max) * 100)}%` }} />
              </span>
              <span className="mono rep-funnel-val">{meta.cell(vk, r[vk])}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
