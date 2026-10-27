import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Bell, Check, ChevronRight, Clock3, MailOpen } from "lucide-react";
import { getWeek } from "date-fns";

import { useNotifications, useNotificationMutations, useUnreadCount } from "../api/notification";
import { useTodoMine } from "../api/todo";
import { useRail } from "../components/shell-rail";
import { TODO_KIND_LABEL } from "../lib/labels";
import type { RouterOutputs } from "../lib/trpc";

type TodoItem = RouterOutputs["todo"]["mine"]["items"][number];

function todoLink(item: TodoItem): string {
  switch (item.kind) {
    case "task":
      return `/projects/${item.projectId}/tasks`;
    case "approval":
    case "grant_handle":
      return "/approvals";
    case "quality_review":
      return "/quality";
    case "report_confirm":
      return `/projects/${item.projectId}/reports`;
    default:
      return "/workbench";
  }
}

/** 通知按 sourceType 路由到全局处理页（通知行不含 projectId，无法直达项目页签） */
function notificationLink(sourceType: string | null): string {
  switch (sourceType) {
    case "quality_issue":
      return "/quality";
    case "decision":
      return "/decisions";
    case "change_request":
    case "access_grant":
    case "approval":
      return "/approvals";
    default:
      return "/workbench";
  }
}

function WorkbenchRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">TODAY</span>
        <h2>今日安排</h2>
      </div>
      <div className="context-section">
        <div className="section-label">FOCUS</div>
        <h2>处理顺序</h2>
        <div className="attention-item">
          <Clock3 size={16} />
          <div>
            <strong>逾期优先，其次临期</strong>
            <p>统一待办按逾期/临期与来源聚合；处理后卡片自动消失。</p>
          </div>
        </div>
      </div>
      <div className="assurance">
        <Clock3 size={16} />
        <span>待办来自任务/审批/复核/周报确认/授权五源并集（服务端聚合）。</span>
      </div>
    </aside>
  );
}

function NotificationPanel() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const notifications = useNotifications(unreadOnly);
  const mutations = useNotificationMutations();
  const [error, setError] = useState<string | null>(null);

  if (notifications.isPending) return <p className="list-note">正在加载通知…</p>;
  if (notifications.isError) throw notifications.error;
  const items = notifications.data.items;

  const act = (fn: (ids: string[]) => void, ids: string[]) => {
    setError(null);
    fn(ids);
  };

  return (
    <section className="notification-panel" id="notifications">
      <div className="section-heading">
        <div>
          <span className="section-label">NOTIFICATIONS</span>
          <h2>通知</h2>
        </div>
        <label className="check-field compact">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          仅未读
        </label>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {items.length === 0 ? (
        <div className="empty-state">
          <MailOpen size={22} />
          <strong>{unreadOnly ? "没有未读通知" : "暂无通知"}</strong>
        </div>
      ) : (
        items.map((n) => (
          <div className={`notification-row ${n.readAt ? "" : "unread"}`} key={n.id}>
            <div>
              <strong>{n.eventType}</strong>
              <small>
                {n.createdAt.slice(0, 16).replace("T", " ")}
                {n.sourceType ? ` · ${n.sourceType}` : ""}
                {n.handledAt ? " · 已处理" : ""}
              </small>
            </div>
            <span className="row-ops">
              {!n.readAt ? (
                <button
                  className="text-action"
                  disabled={mutations.markRead.isPending}
                  onClick={() => act((ids) => mutations.markRead.mutate({ ids }), [n.id])}
                >
                  <Check size={13} />
                  已读
                </button>
              ) : null}
              {!n.handledAt && n.sourceType ? (
                <Link className="text-action" to={notificationLink(n.sourceType)}>
                  去处理
                  <ArrowRight size={13} />
                </Link>
              ) : null}
            </span>
          </div>
        ))
      )}
    </section>
  );
}

/** 我的工作台：统一待办 + 通知（工单 03-9/11 入口） */
export default function WorkbenchPage() {
  useRail(WorkbenchRail);
  const todo = useTodoMine();
  const unread = useUnreadCount();
  const week = getWeek(new Date());

  if (todo.isPending) return <p className="list-note">正在加载工作台…</p>;
  if (todo.isError) throw todo.error;
  const items = todo.data.items;

  return (
    <div className="screen workbench-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">MY WORKSPACE · WEEK {week}</span>
          <h1>今天，从最关键的事开始。</h1>
          <p>
            统一待办 {items.length} 项
            {unread.data ? ` · 未读通知 ${unread.data.count} 条` : ""}
          </p>
        </div>
        <Link to="/approvals" className="primary-action">
          审批中心
          <ArrowRight size={16} />
        </Link>
      </div>
      <div className="todo-cards">
        {items.length === 0 ? (
          <div className="empty-state">
            <strong>待办清零</strong>
            <p>任务、审批、复核、周报确认与授权事项均已处理。</p>
          </div>
        ) : (
          items.map((item: TodoItem) => (
            <Link className={`todo-card kind-${item.kind}`} to={todoLink(item)} key={`${item.kind}-${item.id}`}>
              <span className="todo-kind">{TODO_KIND_LABEL[item.kind] ?? item.kind}</span>
              <strong>{item.title}</strong>
              <small>
                {item.code}
                {"dueDate" in item && item.dueDate ? ` · 到期 ${item.dueDate}` : ""}
                {"submittedAt" in item && item.submittedAt ? ` · 提交 ${item.submittedAt.slice(0, 10)}` : ""}
              </small>
              {"overdue" in item && item.overdue ? <em className="mark-overdue">逾期</em> : null}
              {"overdue" in item && item.dueSoon && !item.overdue ? <em className="mark-duesoon">临期</em> : null}
              <ChevronRight size={16} />
            </Link>
          ))
        )}
      </div>
      <div className="workbench-grid">
        <NotificationPanel />
        <section className="quick-actions-panel">
          <span className="section-label">QUICK ACTIONS</span>
          <h2>快捷处理</h2>
          <Link to="/quality">
            <Bell size={18} />
            <div>
              <strong>质量中心</strong>
              <small>复核与问题处理</small>
            </div>
            <ChevronRight size={15} />
          </Link>
          <Link to="/decisions">
            <Bell size={18} />
            <div>
              <strong>决策中心</strong>
              <small>待决策事项</small>
            </div>
            <ChevronRight size={15} />
          </Link>
          <Link to="/approvals">
            <Bell size={18} />
            <div>
              <strong>审批中心</strong>
              <small>待我审批队列</small>
            </div>
            <ChevronRight size={15} />
          </Link>
        </section>
      </div>
    </div>
  );
}
