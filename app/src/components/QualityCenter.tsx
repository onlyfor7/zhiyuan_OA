import { useState } from "react";
import { useNavigate } from "react-router";
import { Check, ChevronRight, GitBranch, Plus, RotateCcw, Send, ShieldAlert, X } from "lucide-react";

import { useProjectMembers } from "../api/project";
import {
  useQualityChecklist,
  useQualityIssue,
  useQualityList,
  useQualityMutations,
} from "../api/quality";
import { newIdempotencyKey, rootErrorMessage } from "../lib/form";
import {
  CHECK_ITEM_STATUS_LABEL,
  QUALITY_EVENT_LABEL,
  QUALITY_SEVERITY_LABEL,
  QUALITY_STATUS_LABEL,
} from "../lib/labels";
import type { RouterOutputs } from "../lib/trpc";

type IssueItem = RouterOutputs["quality"]["list"]["items"][number];

function Checklist({ projectId }: { projectId: string }) {
  const checklist = useQualityChecklist(projectId);
  const mutations = useQualityMutations();
  if (checklist.isPending) return <p className="list-note">正在加载检查清单…</p>;
  if (checklist.isError) throw checklist.error;
  return (
    <section className="checklist-panel">
      <div className="section-heading">
        <div>
          <span className="section-label">CHECKLIST</span>
          <h2>质量检查清单</h2>
        </div>
      </div>
      {checklist.data.length === 0 ? (
        <p className="list-note">本项目无检查项。</p>
      ) : (
        checklist.data.map((item) => (
          <div className={`check-row status-${item.status}`} key={item.id}>
            <strong>{item.name}</strong>
            <small>
              {item.required ? "必查" : "选查"} · {CHECK_ITEM_STATUS_LABEL[item.status]}
              {item.checkedAt ? ` · ${item.checkedAt.slice(0, 10)}` : ""}
            </small>
            <span className="check-ops">
              {(["passed", "failed", "waived"] as const).map((s) => (
                <button
                  key={s}
                  className={item.status === s ? "tool-toggle active" : "tool-toggle"}
                  disabled={mutations.checkItem.isPending}
                  onClick={() => mutations.checkItem.mutate({ id: item.id, status: s })}
                >
                  {s === "passed" ? "通过" : s === "failed" ? "未通过" : "豁免"}
                </button>
              ))}
              {item.status !== "pending" ? (
                <button
                  className="tool-toggle"
                  disabled={mutations.checkItem.isPending}
                  onClick={() => mutations.checkItem.mutate({ id: item.id, status: "pending" })}
                >
                  重置
                </button>
              ) : null}
            </span>
          </div>
        ))
      )}
    </section>
  );
}

function IssueDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const issue = useQualityIssue(id);
  const mutations = useQualityMutations();
  const members = useProjectMembers(issue.data?.projectId ?? "");
  const [handlerId, setHandlerId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [note, setNote] = useState("");
  const [returnComment, setReturnComment] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editRoot, setEditRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  if (issue.isPending) return <p className="list-note">正在加载问题详情…</p>;
  if (issue.isError) throw issue.error;
  const q = issue.data;
  const severeUp = q.severity === "severe" || q.severity === "critical";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="issue-drawer" role="dialog" aria-modal="true" aria-label="质量问题详情">
        <div className="drawer-head">
          <div>
            <span className="section-label">
              {q.code} · {QUALITY_SEVERITY_LABEL[q.severity]}问题 · {QUALITY_STATUS_LABEL[q.status]}
              {q.isBlocking ? " · 阻断中" : ""}
            </span>
            <h2>{q.title}</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <div className="issue-meta-grid">
          <div>
            <span>处理人</span>
            <strong>{q.handler?.name ?? "未分派"}</strong>
          </div>
          <div>
            <span>复核人</span>
            <strong>{q.reviewer?.name ?? "未指定"}</strong>
          </div>
          <div>
            <span>登记人</span>
            <strong>{q.reporterId.slice(0, 8)}</strong>
          </div>
          <div>
            <span>关闭时间</span>
            <strong>{q.closedAt ? q.closedAt.slice(0, 10) : "—"}</strong>
          </div>
        </div>
        <div className="issue-section">
          <span>问题描述</span>
          <p>{q.description}</p>
        </div>
        {q.rootCause ? (
          <div className="issue-section">
            <span>根本原因</span>
            <p>{q.rootCause}</p>
          </div>
        ) : null}
        {severeUp ? (
          <div className="drawer-note">
            <ShieldAlert size={16} />
            严重及以上问题：处理人与复核人必须为不同人（服务端强制 SELF_REVIEW_BLOCKED）。
          </div>
        ) : null}
        <div className="issue-section">
          <span>处理时间线（quality_issue_events，只追加）</span>
          <div className="resolution-timeline">
            {q.events.map((ev) => (
              <div className="done" key={ev.id}>
                <Check size={15} />
                <span>
                  {QUALITY_EVENT_LABEL[ev.action] ?? ev.action}
                  {ev.note ? `：${ev.note}` : ""}
                  <small>{ev.createdAt.slice(0, 16).replace("T", " ")}</small>
                </span>
              </div>
            ))}
          </div>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        {q.status === "open" ? (
          <div className="issue-section">
            <span>分派处理人与复核人</span>
            <div className="owner-line">
              <select value={handlerId} aria-label="处理人" onChange={(e) => setHandlerId(e.target.value)}>
                <option value="">处理人</option>
                {(members.data ?? []).map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </select>
              <select value={reviewerId} aria-label="复核人" onChange={(e) => setReviewerId(e.target.value)}>
                <option value="">复核人</option>
                {(members.data ?? []).map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button
                className="primary-action"
                disabled={!handlerId || !reviewerId || mutations.assign.isPending}
                onClick={() => {
                  setError(null);
                  mutations.assign.mutate(
                    { id: q.id, handlerId, reviewerId },
                    { onError: (err) => setError(rootErrorMessage(err)) },
                  );
                }}
              >
                分派
              </button>
              <button
                className="text-action"
                onClick={() => {
                  setEditTitle(q.title);
                  setEditDesc(q.description);
                  setEditRoot(q.rootCause ?? "");
                  setEditOpen((v) => !v);
                }}
              >
                编辑
              </button>
              <button
                className="secondary-action"
                onClick={() =>
                  navigate(
                    `/decisions/new?projectId=${q.projectId}&sourceType=quality_issue&sourceId=${q.id}&context=${encodeURIComponent(`质量问题：${q.title}（${q.code}）`)}`,
                  )
                }
              >
                <GitBranch size={14} />
                提交决策
              </button>
            </div>
            {editOpen ? (
              <div className="edit-block">
                <input value={editTitle} aria-label="标题" onChange={(e) => setEditTitle(e.target.value)} />
                <textarea rows={2} value={editDesc} aria-label="描述" onChange={(e) => setEditDesc(e.target.value)} />
                <input value={editRoot} placeholder="根本原因" aria-label="根本原因" onChange={(e) => setEditRoot(e.target.value)} />
                <button
                  className="secondary-action"
                  disabled={mutations.update.isPending}
                  onClick={() => {
                    setError(null);
                    mutations.update.mutate(
                      {
                        id: q.id,
                        rowVersion: q.rowVersion,
                        title: editTitle.trim(),
                        description: editDesc.trim(),
                        rootCause: editRoot.trim() || null,
                      },
                      { onError: (err) => setError(rootErrorMessage(err)) },
                    );
                  }}
                >
                  保存修改
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {q.status === "handling" ? (
          <div className="issue-section">
            <span>提交处理说明</span>
            <textarea rows={3} value={note} placeholder="处理过程与结论" onChange={(e) => setNote(e.target.value)} />
            <button
              className="primary-action"
              disabled={!note.trim() || mutations.submitHandling.isPending}
              onClick={() => {
                setError(null);
                mutations.submitHandling.mutate(
                  { id: q.id, note: note.trim() },
                  {
                    onSuccess: () => setNote(""),
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              <Send size={15} />
              提交复核
            </button>
          </div>
        ) : null}

        {q.status === "pending_review" ? (
          <div className="issue-section">
            <span>独立复核</span>
            <textarea
              rows={2}
              value={returnComment}
              placeholder="退回时必填理由"
              onChange={(e) => setReturnComment(e.target.value)}
            />
            <div className="drawer-actions between">
              <button
                className="secondary-action"
                disabled={!returnComment.trim() || mutations.review.isPending}
                onClick={() => {
                  setError(null);
                  mutations.review.mutate(
                    { id: q.id, action: "return", comment: returnComment.trim() },
                    {
                      onSuccess: () => setReturnComment(""),
                      onError: (err) => setError(rootErrorMessage(err)),
                    },
                  );
                }}
              >
                <RotateCcw size={15} />
                退回处理
              </button>
              <button
                className="primary-action"
                disabled={mutations.review.isPending}
                onClick={() => {
                  setError(null);
                  mutations.review.mutate(
                    { id: q.id, action: "pass" },
                    { onError: (err) => setError(rootErrorMessage(err)) },
                  );
                }}
              >
                <Check size={16} />
                复核通过
              </button>
            </div>
          </div>
        ) : null}

        {q.status === "closed" ? (
          <div className="issue-section">
            <span>问题已关闭{q.closedAt ? `（${q.closedAt.slice(0, 10)}）` : ""}</span>
            <textarea rows={2} value={note} placeholder="重开说明（必填）" onChange={(e) => setNote(e.target.value)} />
            <button
              className="secondary-action"
              disabled={!note.trim() || mutations.reopen.isPending}
              onClick={() => {
                setError(null);
                mutations.reopen.mutate(
                  { id: q.id, note: note.trim() },
                  {
                    onSuccess: () => setNote(""),
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              <RotateCcw size={15} />
              重开问题
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** 质量中心（项目页签与全局质量中心共用）：列表/筛选/登记/详情/复核闭环/检查清单 */
export function QualityCenter({ projectId }: { projectId?: string }) {
  const list = useQualityList(projectId ? { projectId } : {});
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const filtered = list.data?.items.filter(
    (i) => (!status || i.status === status) && (!severity || i.severity === severity),
  );

  if (list.isPending) return <p className="list-note">正在加载质量问题…</p>;
  if (list.isError) throw list.error;

  return (
    <div className={projectId ? "space-tab-body" : "screen quality-screen"}>
      {!projectId ? (
        <div className="screen-heading">
          <div>
            <span className="eyebrow">QUALITY ASSURANCE</span>
            <h1>质量，是持续发生的闭环。</h1>
            <p>从发现、处理到独立复核，每个结论都有证据与责任人。</p>
          </div>
        </div>
      ) : null}
      <div className="quality-toolbar">
        <div className="inline-search">
          <select value={severity} aria-label="问题等级" onChange={(e) => setSeverity(e.target.value)}>
            <option value="">全部等级</option>
            <option value="critical">致命</option>
            <option value="severe">严重</option>
            <option value="major">一般</option>
            <option value="minor">建议</option>
          </select>
        </div>
        <select value={status} aria-label="问题状态" onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="open">待处理</option>
          <option value="handling">处理中</option>
          <option value="pending_review">待复核</option>
          <option value="closed">已关闭</option>
        </select>
        <span>{filtered?.length ?? 0} 项结果</span>
        {projectId ? (
          <button className="primary-action" onClick={() => setCreateOpen(true)}>
            <Plus size={15} />
            登记质量问题
          </button>
        ) : null}
      </div>
      <div className="quality-table">
        <div className="quality-table-head">
          <span>问题与项目</span>
          <span>等级</span>
          <span>状态</span>
          <span>处理人</span>
          <span>期限/关闭</span>
          <span />
        </div>
        {filtered?.length === 0 ? (
          <div className="empty-state">
            <strong>没有匹配的问题</strong>
            <p>调整等级或状态筛选后再试。</p>
          </div>
        ) : (
          filtered?.map((issue: IssueItem) => (
            <button className="quality-row" key={issue.id} onClick={() => setSelectedId(issue.id)}>
              <div>
                <strong>
                  {issue.title}
                  {issue.isBlocking ? <em className="mark-overdue">阻断</em> : null}
                </strong>
                <small>{issue.code}</small>
              </div>
              <span className={`severity severity-${issue.severity}`}>{QUALITY_SEVERITY_LABEL[issue.severity]}</span>
              <span className={`issue-status status-${issue.status}`}>{QUALITY_STATUS_LABEL[issue.status]}</span>
              <span>{issue.handlerName ?? "—"}</span>
              <span className="issue-due">{issue.closedAt ? issue.closedAt.slice(0, 10) : "—"}</span>
              <ChevronRight size={16} />
            </button>
          ))
        )}
      </div>
      {projectId ? <Checklist projectId={projectId} /> : null}
      {createOpen && projectId ? (
        <QualityCreateForm projectId={projectId} onClose={() => setCreateOpen(false)} />
      ) : null}
      {selectedId ? <IssueDrawer id={selectedId} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}

function QualityCreateForm({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const mutations = useQualityMutations();
  const members = useProjectMembers(projectId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<"major" | "minor" | "severe" | "critical">("major");
  const [handlerId, setHandlerId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [idem] = useState(newIdempotencyKey);
  void idem; // quality.create 无幂等键参数（契约未含），保留表单规范挂载点

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="登记质量问题">
        <div className="drawer-head">
          <div>
            <span className="section-label">NEW QUALITY ISSUE</span>
            <h2>登记质量问题</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <label className="form-field">
          <span>问题标题 *</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="form-field">
          <span>问题等级 *</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as never)}>
            <option value="minor">建议</option>
            <option value="major">一般</option>
            <option value="severe">严重</option>
            <option value="critical">致命</option>
          </select>
        </label>
        <label className="form-field">
          <span>问题说明 *</span>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="owner-line">
          <label className="form-field">
            <span>处理人</span>
            <select value={handlerId} onChange={(e) => setHandlerId(e.target.value)}>
              <option value="">登记后再分派</option>
              {(members.data ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>复核人</span>
            <select value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
              <option value="">登记后再指定</option>
              {(members.data ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {severity === "severe" || severity === "critical" ? (
          <div className="drawer-note">
            <ShieldAlert size={16} />
            严重及以上：处理人与复核人不得为同一人，否则服务端拒绝（SELF_REVIEW_BLOCKED）。
          </div>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="primary-action full-action"
          disabled={!title.trim() || !description.trim() || mutations.create.isPending}
          onClick={() => {
            setError(null);
            mutations.create.mutate(
              {
                projectId,
                title: title.trim(),
                description: description.trim(),
                severity,
                handlerId: handlerId || undefined,
                reviewerId: reviewerId || undefined,
              },
              {
                onSuccess: onClose,
                onError: (err) => setError(rootErrorMessage(err)),
              },
            );
          }}
        >
          {mutations.create.isPending ? "登记中…" : "登记并进入处理"}
          <ChevronRight size={15} />
        </button>
      </section>
    </div>
  );
}
