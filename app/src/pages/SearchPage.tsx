import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowRight, Search } from "lucide-react";

import { useMe } from "../api/auth";
import { useSearch } from "../api/search";
import { formatYuan } from "../api/reference";
import { canViewFinance } from "../lib/permissions";
import { SEARCH_TYPE_LABEL } from "../lib/labels";

const ALL_TYPES = Object.keys(SEARCH_TYPE_LABEL);

/** 全局搜索结果页：O1 分组返回（每组 ≤5 + totalByType 精确计数徽标 + 查看全部该类型提至每类 20 条） */
export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [types, setTypes] = useState<string[]>([]);
  const me = useMe();
  const singleType = types.length === 1;
  const search = useSearch(q, types, singleType ? 20 : 5);
  const canFinance = canViewFinance(null, me.data?.globalRoles ?? []);

  const groups = search.data?.groups ?? [];
  const totalHits = Object.values(search.data?.totalByType ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);

  return (
    <div className="screen search-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">GLOBAL SEARCH</span>
          <h1>全局搜索</h1>
          <p>
            {q
              ? `「${q}」的可见命中：共 ${totalHits} 条${singleType ? "" : `（${groups.length} 类，每组预览前 5 条）`}`
              : "输入关键词搜索；未授权对象整体不可见。"}
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
      {singleType ? (
        <p className="context-note">
          正在按「{SEARCH_TYPE_LABEL[types[0]] ?? types[0]}」单类型展示（每类至多 20 条）。
          <button className="text-action" onClick={() => setTypes([])}>
            返回全部分组
          </button>
        </p>
      ) : null}
      {q && search.isPending ? <p className="list-note">搜索中…</p> : null}
      {q && search.isError ? <p className="form-error">搜索失败，请重试。</p> : null}
      {q && search.data && totalHits === 0 ? (
        <div className="empty-state">
          <strong>没有可见结果</strong>
          <p>未授权的对象不会泄露标题或金额；换个关键词或类型试试。</p>
        </div>
      ) : null}
      {groups.map((group) => (
        <section key={group.type} className="search-group">
          <div className="search-group-head">
            <span className="section-label">
              {SEARCH_TYPE_LABEL[group.type] ?? group.type} · {group.total} 条
            </span>
            {!singleType && group.total > group.items.length ? (
              <button className="text-action" onClick={() => setTypes([group.type])}>
                查看全部该类型
                <ArrowRight size={13} />
              </button>
            ) : null}
          </div>
          {group.items.map((hit) => (
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
