import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { ArrowRight, Search, X } from "lucide-react";

import { useSearch } from "../api/search";
import { SEARCH_TYPE_LABEL } from "../lib/labels";
import { formatYuan } from "../api/reference";
import { canViewFinance } from "../lib/permissions";
import { useMe } from "../api/auth";

/**
 * 全局搜索（arch/07 §5）：顶栏 ⌘K 唤起命令面板，实时分组结果，
 * Enter 进 /search?q= 全量页；金额仅在有财务可见权时由服务端返回（缺席即不渲染）。
 */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const me = useMe();
  const search = useSearch(q);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const items = search.data?.items ?? [];
  const canFinance = canViewFinance(null, me.data?.globalRoles ?? []);

  return createPortal(
    <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div className="command-input">
          <Search size={19} />
          <input
            ref={inputRef}
            value={q}
            placeholder="搜索项目、任务、会议、报销、文件…（无权限对象不会出现）"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && q.trim()) {
                navigate(`/search?q=${encodeURIComponent(q.trim())}`);
                onClose();
              }
            }}
          />
          <button className="icon-button" aria-label="关闭搜索" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="command-results">
          {q.trim() === "" ? (
            <p className="palette-hint">输入关键词开始搜索；结果按可见权限过滤，金额按财务权限显示。</p>
          ) : search.isPending ? (
            <p className="palette-hint">搜索中…</p>
          ) : items.length === 0 ? (
            <p className="palette-hint">没有可见的匹配结果（未授权对象不会出现在结果中）。</p>
          ) : (
            items.slice(0, 10).map((hit) => (
              <button
                key={`${hit.type}-${hit.id}`}
                onClick={() => {
                  navigate(hit.deepLink);
                  onClose();
                }}
              >
                <span>
                  <span className="badge">{SEARCH_TYPE_LABEL[hit.type] ?? hit.type}</span>{" "}
                  <strong>{hit.title}</strong>
                  {hit.code ? <small> {hit.code}</small> : null}
                  {"amountCents" in hit && hit.amountCents != null && canFinance ? (
                    <small className="mono"> · {formatYuan(hit.amountCents)} 元</small>
                  ) : null}
                </span>
                <ArrowRight size={15} />
              </button>
            ))
          )}
          {q.trim() && search.data ? (
            <button
              className="palette-more"
              onClick={() => {
                navigate(`/search?q=${encodeURIComponent(q.trim())}`);
                onClose();
              }}
            >
              查看全部结果（{items.length} 条可见命中）
              <ArrowRight size={14} />
            </button>
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}
