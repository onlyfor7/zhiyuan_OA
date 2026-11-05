import { useEffect, useState } from "react";
import { Link } from "react-router";

import { useCustomerList } from "../../api/crm";
import { ListSkeleton } from "../../components/feedback";
import { formatYuan } from "../../api/reference";
import { DomainIconBlock } from "../../lib/DomainIconBlock";

const LEVEL_LABEL: Record<string, string> = { public: "公开", internal: "内部", confidential: "保密", secret: "秘密" };

/** 客户组·客户列表（arch/12 §6.4：T-A——级别徽标/行业/在管项目数/合同额/应收余额；点行进详情六页签） */
export default function CustomersPage() {
  const [level, setLevel] = useState("");
  const [keyword, setKeyword] = useState("");
  const [debounced, setDebounced] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(keyword.trim()), 300);
    return () => window.clearTimeout(t);
  }, [keyword]);
  const list = useCustomerList({ level: level || undefined, keyword: debounced || undefined, cursor });

  if (list.isPending) return <ListSkeleton rows={6} />;
  if (list.isError) throw list.error;

  return (
    <div className="screen crm-customers-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">CRM · CUSTOMERS</span>
          <h1>客户列表</h1>
          <p>既有 clients 被吸收为 CRM 客户；新建客户路径=线索转化（主链 lead→customer）。</p>
        </div>
      </div>
      <div className="quality-toolbar p9a-ta-filter" style={{ borderBottom: "1px solid var(--line)" }}>
        <DomainIconBlock domain="customer" size={24} />
        <select value={level} aria-label="级别筛选" onChange={(e) => { setLevel(e.target.value); setCursor(undefined); }}>
          <option value="">全部级别</option>
          {Object.entries(LEVEL_LABEL).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <input value={keyword} placeholder="搜索客户名称" aria-label="搜索客户" onChange={(e) => { setKeyword(e.target.value); setCursor(undefined); }} />
        <span>{list.data.items.length} 户</span>
      </div>
      <div className="p9a-ta-table" style={{ gridTemplateRows: "40px minmax(0,1fr)" }}>
        <div className="p9a-ta-head p9a-ta-row" style={{ gridTemplateColumns: "1.6fr 90px 1fr 90px 120px 130px 90px" }}>
          <span>客户</span><span>级别</span><span>行业</span><span>在管项目</span><span>合同额</span><span>应收余额</span><span />
        </div>
        <div className="p9a-ta-body">
          {list.data.items.map((c) => (
            <Link className="p9a-ta-row" key={c.id} to={`/crm/customers/${c.id}`} style={{ gridTemplateColumns: "1.6fr 90px 1fr 90px 120px 130px 90px", textDecoration: "none", color: "inherit" }}>
              <div>
                <strong>{c.name}</strong>
                <small className="mono" style={{ color: "var(--muted)", fontSize: 10 }}>{c.code}</small>
              </div>
              <span><span className="p9a-role-badge alt">{LEVEL_LABEL[c.level] ?? c.level}</span></span>
              <span>{c.industry ?? "—"}</span>
              <span className="mono">{c.projectCount}</span>
              <span className="mono">{"contractSum" in c && c.contractSum != null ? `${formatYuan(c.contractSum as number)} 元` : "—"}</span>
              <span className="mono" style={{ color: "var(--muted)" }}>{"receivableCents" in c && c.receivableCents != null ? `${formatYuan(c.receivableCents as number)} 元` : "—"}</span>
              <span className="text-action">详情</span>
            </Link>
          ))}
        </div>
      </div>
      <div className="p9a-ta-pager">
        <span>共 {list.data.items.length} 户 · 每页 20</span>
        <div className="row-ops">
          <button className="secondary-action" disabled={!cursor} onClick={() => setCursor(undefined)}>上一页</button>
          <button className="secondary-action" disabled={!list.data.nextCursor} onClick={() => setCursor(list.data.nextCursor ?? undefined)}>下一页</button>
        </div>
      </div>
    </div>
  );
}
