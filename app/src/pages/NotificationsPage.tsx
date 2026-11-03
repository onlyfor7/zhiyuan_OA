import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";
import { ListSkeleton } from "../components/feedback";

/** 通知类型中文分组标签（source_type 前缀归并；未知类型归入「其他」） */
function groupOf(sourceType: string): string {
  if (sourceType.startsWith("approval")) return "审批";
  if (sourceType.startsWith("meeting")) return "会议";
  if (sourceType.startsWith("travel")) return "出差";
  if (sourceType.startsWith("manager")) return "项目";
  if (sourceType.startsWith("finance") || sourceType.startsWith("budget") || sourceType.startsWith("expense") || sourceType.startsWith("funding") || sourceType.startsWith("receipt")) return "财务";
  if (sourceType.startsWith("quality")) return "质量";
  return "其他";
}

const GROUP_ORDER = ["审批", "会议", "出差", "项目", "财务", "质量", "其他"];

/** G7 通知中心：按类型分组折叠 + 「展开更多」分页；未读优先标记 */
export default function NotificationsPage() {
  const trpc = useTRPC();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const list = useInfiniteQuery({
    ...trpc.notification.listMine.infiniteQueryOptions({ limit: 20 }, { getNextPageParam: (last) => last.nextCursor }),
  });

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const groups = new Map<string, typeof items>();
  for (const n of items) {
    const g = groupOf(n.sourceType);
    groups.set(g, [...(groups.get(g) ?? []), n]);
  }
  const sorted = [...groups.entries()].sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]));

  if (list.isPending) return <ListSkeleton rows={6} />;
  if (list.isError) throw list.error;

  return (
    <div className="screen notifications-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">NOTIFICATIONS</span>
          <h1>通知中心</h1>
          <p>按类型分组折叠，单屏长度受控（G7）；未读以蓝点标记。</p>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="empty-state">
          <strong>暂无通知</strong>
          <p>审批、会议、出差等事项有进展时会出现在这里。</p>
        </div>
      ) : (
        sorted.map(([group, rows]) => {
          const isCollapsed = collapsed[group] ?? false;
          return (
            <section className="notification-group" key={group}>
              <button
                className="notification-group-head"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((c) => ({ ...c, [group]: !isCollapsed }))}
              >
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <strong>{group}</strong>
                <span className="count-badge neutral">{rows.length}</span>
                <small>
                  未读 {rows.filter((r) => !r.readAt).length}
                </small>
              </button>
              {!isCollapsed
                ? rows.map((n) => {
                    const payload = (n.payloadJson ?? {}) as Record<string, unknown>;
                    const detail = payload.message ?? payload.title ?? payload.reason ?? "";
                    return (
                      <div className={`notification-row ${n.readAt ? "" : "unread"}`} key={n.id}>
                        <span className={`status-dot ${n.readAt ? "" : "ok"}`} />
                        <div>
                          <strong>
                            {n.eventType}
                            {detail ? ` · ${String(detail)}` : ""}
                          </strong>
                          <small>
                            {n.createdAt.slice(0, 16).replace("T", " ")}
                            {n.sourceType ? ` · ${n.sourceType}` : ""}
                            {n.handledAt ? " · 已处理" : ""}
                          </small>
                        </div>
                      </div>
                    );
                  })
                : null}
            </section>
          );
        })
      )}
      {list.hasNextPage ? (
        <button className="secondary-action" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {list.isFetchingNextPage ? "加载中…" : "展开更多"}
        </button>
      ) : null}
    </div>
  );
}
