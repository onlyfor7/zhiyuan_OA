import { useState } from "react";
import { Link } from "react-router";

import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { REPORT_CATEGORIES, REPORT_META, type ReportMeta } from "./meta";
import type { ReportKey } from "../../api/reports";

/**
 * /reports 报表工作台（arch/12 §8.1：T-C——左目录树四类〔§4.4 注册表图标〕＋右侧报表说明卡+「打开」）。
 * report.read=登录全员；member 打开单页后由服务端按域口径过滤（同形状 200/空集/note）。
 */
export default function ReportsWorkbenchPage() {
  const [selected, setSelected] = useState<ReportKey>(REPORT_META[0].key);
  const meta = REPORT_META.find((m) => m.key === selected) ?? REPORT_META[0];

  return (
    <div className="screen reports-workbench-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">REPORTS · CATALOG</span>
          <h1>报表工作台</h1>
          <p>一期十张预定义报表（arch/12 §8.2）；口径只在 server services 一处，页内零自写公式；右上导出走文件管道+审计留痕。</p>
        </div>
      </div>
      <div className="fin-tc rep-wb">
        <aside className="fin-tc-list">
          <span className="section-label">报表目录（四类）</span>
          <div className="p9a-scroll-list" style={{ marginTop: 6 }}>
            {REPORT_CATEGORIES.map((cat) => (
              <div key={cat.key} className="rep-wb-group">
                <div className="rep-wb-cat">
                  <DomainIconBlock domain={cat.icon} size={22} iconSize={13} />
                  <strong>{cat.label}</strong>
                  <small className="rep-wb-cat-desc">{cat.desc}</small>
                </div>
                {REPORT_META.filter((m) => m.category === cat.key).map((m) => (
                  <button
                    key={m.key}
                    className={`org-tree-label fin-tc-item ${selected === m.key ? "active" : ""}`}
                    onClick={() => setSelected(m.key)}
                  >
                    <span>{m.title}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>
        <section className="fin-tc-detail rep-wb-detail">
          <ReportCard meta={meta} />
        </section>
      </div>
    </div>
  );
}

function ReportCard({ meta }: { meta: ReportMeta }) {
  const cat = REPORT_CATEGORIES.find((c) => c.key === meta.category);
  return (
    <div className="rep-wb-card">
      <span className="section-label">{meta.eyebrow}</span>
      <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {cat ? <DomainIconBlock domain={cat.icon} size={26} iconSize={15} /> : null}
        {meta.title}
      </h2>
      <p className="context-note">{meta.desc}</p>
      <dl className="rep-wb-facts">
        <div><dt>分类</dt><dd>{cat?.label}</dd></div>
        <div><dt>筛选</dt><dd>{[
          meta.filters.fromTo && "日期区间",
          meta.filters.project && "项目",
          meta.filters.customer && "客户",
          meta.filters.orgUnit && "部门",
          meta.filters.view && "三视角",
        ].filter(Boolean).join(" / ") || "无（累计口径）"}</dd></div>
        <div><dt>迷你图</dt><dd>{meta.mini === "none" ? "无" : meta.mini === "cashflow" ? "月度收支柱" : meta.mini === "funnel" ? "横向漏斗条" : "横向条形"}</dd></div>
      </dl>
      <div className="title-actions">
        <Link className="primary-action rep-open" to={`/reports/${meta.key}`}>
          打开报表
        </Link>
      </div>
    </div>
  );
}
