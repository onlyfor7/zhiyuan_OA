import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowRight, Search } from "lucide-react";

import { useMe } from "../api/auth";
import { useSearch } from "../api/search";
import { formatYuan } from "../api/reference";
import { canViewFinance } from "../lib/permissions";
import { SEARCH_TYPE_LABEL } from "../lib/labels";
import type { RouterOutputs } from "../lib/trpc";

const ALL_TYPES = Object.keys(SEARCH_TYPE_LABEL);

/** 全局搜索结果页：分组 + 类型筛选 + 可见命中计数（arch/07 §5；金额按权限缺席渲染） */
export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [types, setTypes] = useState<string[]>([]);
  const me = useMe();
  const search = useSearch(q, types);
  const canFinance = canViewFinance(null, me.data?.globalRoles ?? []);

  const grouped = new Map<string, RouterOutputs["search"]["query"]["items"]>();
  for (const hit of search.data?.items ?? []) {
    const list = grouped.get(hit.type) ?? [];
    list.push(hit);
    grouped.set(hit.type, list);
  }

  return (
    <div className="screen search-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">GLOBAL SEARCH</span>
          <h1>全局搜索</h1>
          <p>
            {q ? `「${q}」的可见命中：共 ${search.data?.items.length ?? 0} 条` : "输入关键词搜索；未授权对象整体不可见。"}
          </p>
        </div>
      </div>
      <div className="quality-toolbar">
        <div className="inline-search wide">
          <Search size={15} />
          <input
            value={q}
            placeholder="搜索项目、任务、会议、出差、经费、报销、决策、质量、周报、工时、文件…"
            aria-label="搜索"
            onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {})}
          />
        </div>
      </div>
      <div className="quality-toolbar type-chips">
        <button className={types.length === 0 ? "tool-toggle active" : "tool-toggle"} onClick={() => setTypes([])}>
          全部
        </button>
        {ALL_TYPES.map((t) => (
          <button
            key={t}
            className={types.includes(t) ? "tool-toggle active" : "tool-toggle"}
            onClick={() => setTypes((prev) => (prev.includes(t) ? [] : [t]))}
          >
            {SEARCH_TYPE_LABEL[t]}（{search.data?.totalByType?.[t as never] ?? 0}）
          </button>
        ))}
      </div>
      {q && search.isPending ? <p className="list-note">搜索中…</p> : null}
      {q && search.isError ? <p className="form-error">搜索失败，请重试。</p> : null}
      {q && search.data && search.data.items.length === 0 ? (
        <div className="empty-state">
          <strong>没有可见结果</strong>
          <p>未授权的对象不会泄露标题或金额；换个关键词或类型试试。</p>
        </div>
      ) : null}
      {[...grouped.entries()].map(([type, hits]) => (
        <section key={type} className="search-group">
          <span className="section-label">
            {SEARCH_TYPE_LABEL[type] ?? type} · {hits.length} 条
          </span>
          {hits.map((hit) => (
            <Link className="search-hit" key={`${hit.type}-${hit.id}`} to={hit.deepLink}>
              <div>
                <strong>{hit.title}</strong>
                <small>
                  {hit.code ?? ""}
                  {hit.projectId ? ` · 项目 ${hit.projectId.slice(0, 8)}` : ""}
                </small>
              </div>
              {"amountCents" in hit && hit.amountCents != null && canFinance ? (
                <span className="mono">{formatYuan(hit.amountCents)} 元</span>
              ) : (
                <span className="muted-label">{"amountCents" in hit ? "—" : ""}</span>
              )}
              <ArrowRight size={15} />
            </Link>
          ))}
        </section>
      ))}
    </div>
  );
}
