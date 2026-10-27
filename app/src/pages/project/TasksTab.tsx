import { useState } from "react";
import { Check, Play, Plus, RotateCcw, X } from "lucide-react";

import { useProjectMembers } from "../../api/project";
import { useTaskList, useTaskMutations } from "../../api/task";
import { rootErrorMessage } from "../../lib/form";
import { TASK_STATUS_LABEL } from "../../lib/labels";
import type { RouterOutputs } from "../../lib/trpc";
import { useSpaceParams } from "./space-context";

type TaskItem = RouterOutputs["task"]["list"]["items"][number];

/** 项目空间·任务页签：列表/创建/状态流转/分派（服务端鉴权与乐观锁强制） */
export default function TasksTab() {
  const { projectId } = useSpaceParams();
  const tasks = useTaskList({ projectId });
  const members = useProjectMembers(projectId);
  const mutations = useTaskMutations();
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [plannedStart, setPlannedStart] = useState("");
  const [plannedEnd, setPlannedEnd] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (tasks.isPending) return <p className="list-note">正在加载任务…</p>;
  if (tasks.isError) throw tasks.error;

  const canCreate = title.trim() && plannedStart && plannedEnd;

  return (
    <div className="space-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">任务完成/流转会同步项目总览与统一待办</span>
        <button className="primary-action" onClick={() => setCreateOpen((v) => !v)}>
          <Plus size={15} />
          新建任务
        </button>
      </div>
      {createOpen ? (
        <div className="task-create">
          <label className="form-field">
            <span>标题 *</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="owner-line">
            <label className="form-field">
              <span>计划开始 *</span>
              <input type="date" value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} />
            </label>
            <label className="form-field">
              <span>计划完成 *</span>
              <input type="date" value={plannedEnd} onChange={(e) => setPlannedEnd(e.target.value)} />
            </label>
            <label className="form-field">
              <span>负责人</span>
              <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">未指派</option>
                {(members.data ?? []).map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="form-field">
            <span>说明</span>
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button
              className="primary-action"
              disabled={!canCreate || mutations.create.isPending}
              onClick={() => {
                setError(null);
                mutations.create.mutate(
                  {
                    projectId,
                    title: title.trim(),
                    description: description.trim() || undefined,
                    assigneeId: assigneeId || undefined,
                    plannedStart,
                    plannedEnd,
                  },
                  {
                    onSuccess: () => {
                      setCreateOpen(false);
                      setTitle("");
                      setDescription("");
                      setAssigneeId("");
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              创建任务
              <Check size={15} />
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="quality-table task-table">
        <div className="quality-table-head task-head">
          <span>任务</span>
          <span>负责人</span>
          <span>计划区间</span>
          <span>状态</span>
          <span>操作</span>
        </div>
        {tasks.data.items.length === 0 ? (
          <div className="empty-state">
            <strong>暂无任务</strong>
            <p>点击「新建任务」创建第一条任务。</p>
          </div>
        ) : (
          tasks.data.items.map((task: TaskItem) => (
            <div className="quality-row task-row" key={task.id}>
              <div>
                <strong>
                  {task.title}
                  {task.overdue ? <em className="mark-overdue">逾期</em> : null}
                  {task.dueSoon && !task.overdue ? <em className="mark-duesoon">临期</em> : null}
                </strong>
                <small>
                  {task.code}
                  {task.stageName ? ` · ${task.stageName}` : ""}
                  {task.sourceType === "change_request" ? " · 恢复措施" : ""}
                  {task.sourceType === "decision" ? " · 决策检查点" : ""}
                </small>
              </div>
              <span>
                {task.assigneeName ?? "—"}
                <select
                  className="assign-select"
                  aria-label="改派"
                  value=""
                  onChange={(e) => {
                    if (!e.target.value) return;
                    setError(null);
                    mutations.assign.mutate(
                      { id: task.id, assigneeId: e.target.value },
                      { onError: (err) => setError(rootErrorMessage(err)) },
                    );
                  }}
                >
                  <option value="">改派…</option>
                  {(members.data ?? []).map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </span>
              <span className="issue-due">
                {task.plannedStart.slice(5)} ~ {task.plannedEnd.slice(5)}
              </span>
              <span className={`issue-status status-${task.status}`}>{TASK_STATUS_LABEL[task.status]}</span>
              <span className="row-ops">
                {task.status === "pending" ? (
                  <button className="text-action" disabled={mutations.transition.isPending} onClick={() => mutations.transition.mutate({ id: task.id, action: "start", rowVersion: task.rowVersion })}>
                    <Play size={13} />
                    开始
                  </button>
                ) : null}
                {task.status === "in_progress" ? (
                  <button className="text-action" disabled={mutations.transition.isPending} onClick={() => mutations.transition.mutate({ id: task.id, action: "complete", rowVersion: task.rowVersion })}>
                    <Check size={13} />
                    完成
                  </button>
                ) : null}
                {task.status === "done" ? (
                  <button className="text-action" disabled={mutations.transition.isPending} onClick={() => mutations.transition.mutate({ id: task.id, action: "reopen", rowVersion: task.rowVersion })}>
                    <RotateCcw size={13} />
                    重开
                  </button>
                ) : null}
                {task.status === "pending" || task.status === "in_progress" ? (
                  <button className="text-action" disabled={mutations.transition.isPending} onClick={() => mutations.transition.mutate({ id: task.id, action: "cancel", rowVersion: task.rowVersion })}>
                    <X size={13} />
                    取消
                  </button>
                ) : null}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
