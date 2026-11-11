import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Bell, Check, ChevronRight, MailOpen } from "lucide-react";
import { getWeek } from "date-fns";

import { useNotifications, useNotificationMutations, useUnreadCount } from "../api/notification";
import { useTodoMine } from "../api/todo";
import { HelpIcon } from "../components/HelpIcon";
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
    case "minutes_draft":
    case "minutes_confirm":
      return `/meetings/${item.id}`;
    case "funding_mine":
      return `/operations/funding/${item.id}`;
    case "expense_mine":
      return `/expenses/${item.id}`;
    case "time_submit":
      return "/operations/time";
    case "time_approve":
      return "/approvals";
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

function NotificationPanel() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE = 8;
  const notifications = useNotifications(unreadOnly);
  const mutations = useNotificationMutations();
  const [error, setError] = useState<string | null>(null);

  if (notifications.isPending) return <p className="list-note">正在加载通知…</p>;
  if (notifications.isError) throw notifications.error;
  const items = notifications.data.items;
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE));
  const cur = Math.min(page, pageCount - 1);
  const pageItems = items.slice(cur * PAGE, (cur + 1) * PAGE);

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
          <input type="checkbox" checked={unreadOnly} onChange={(e) => { setUnreadOnly(e.target.checked); setPage(0); }} />
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
        pageItems.map((n) => (
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
      {items.length > PAGE ? (
        <div className="p9a-ta-pager">
          <span>共 {items.length} 条 · 第 {cur + 1}/{pageCount} 页</span>
          <div className="row-ops">
            <button className="secondary-action" disabled={cur === 0} onClick={() => setPage(cur - 1)}>上一页</button>
            <button className="secondary-action" disabled={cur >= pageCount - 1} onClick={() => setPage(cur + 1)}>下一页</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** 我的工作台：统一待办 + 通知（工单 03-9/11 入口） */
export default function WorkbenchPage() {
  const todo = useTodoMine();
  const unread = useUnreadCount();
  const week = getWeek(new Date());

  const [todoPage, setTodoPage] = useState(0);
  const TODO_PAGE = 12;

  if (todo.isPending) return <p className="list-note">正在加载工作台…</p>;
  if (todo.isError) throw todo.error;
  const items = todo.data.items;
  const todoCount = items.length;
  const todoPageCount = Math.max(1, Math.ceil(todoCount / TODO_PAGE));
  const todoCur = Math.min(todoPage, todoPageCount - 1);
  const todoItems = items.slice(todoCur * TODO_PAGE, (todoCur + 1) * TODO_PAGE);

  return (
    <div className="screen workbench-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">MY WORKSPACE · WEEK {week}</span>
          <h1 aria-label="今天，从最关键的事开始。">
            今天，从最关键的事开始。
            <HelpIcon pageKey="workbench" />
          </h1>
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
          todoItems.map((item: TodoItem) => (
            <Link className={`todo-card kind-${item.kind}`} to={todoLink(item)} key={`${item.kind}-${item.id}`}>
              <span className="todo-kind">{TODO_KIND_LABEL[item.kind] ?? item.kind}</span>
              <strong>{item.title}</strong>
              <small>
                {item.code}
                {"dueDate" in item && item.dueDate ? ` · 到期 ${item.dueDate}` : ""}
                {"submittedAt" in item && item.submittedAt ? ` · 提交 ${item.submittedAt.slice(0, 10)}` : ""}
                {"amountCents" in item && item.amountCents != null
                  ? ` · ${(item.amountCents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2 })} 元`
                  : ""}
              </small>
              {"overdue" in item && item.overdue ? <em className="mark-overdue">逾期</em> : null}
              {"overdue" in item && item.dueSoon && !item.overdue ? <em className="mark-duesoon">临期</em> : null}
              <ChevronRight size={16} />
            </Link>
          ))
        )}
      </div>
      {todoCount > TODO_PAGE ? (
        <div className="p9a-ta-pager">
          <span>待办共 {todoCount} 项 · 第 {todoCur + 1}/{todoPageCount} 页</span>
          <div className="row-ops">
            <button className="secondary-action" disabled={todoCur === 0} onClick={() => setTodoPage(todoCur - 1)}>上一页</button>
            <button className="secondary-action" disabled={todoCur >= todoPageCount - 1} onClick={() => setTodoPage(todoCur + 1)}>下一页</button>
          </div>
        </div>
      ) : null}
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
