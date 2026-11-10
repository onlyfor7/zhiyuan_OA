import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AI_MINUTES_DRAFT_KEY, consumeAiDraft } from "../components/ai/ai-actions";
import { BackButton } from "../components/feedback";
import { Link, useNavigate, useParams } from "react-router";
import {
  ArrowRight, Check, ChevronRight, FileText, GitBranch, Plus, Timer, X,
} from "lucide-react";

import { useMe } from "../api/auth";
import { fileDownloadUrl, filePreviewUrl } from "../api/archive";
import { useUserNameMap } from "../api/reference";
import { useTimeMutations } from "../api/time";
import {
  useActionItems,
  useActionMutations,
  useEscalateToDecision,
  useMeeting,
  useMeetingMutations,
  useMeetingTimePrefill,
  useMinutesMutations,
  useMinutesVersions,
} from "../api/meeting";
import { UserPicker } from "../components/UserPicker";
import { newIdempotencyKey, rootErrorMessage } from "../lib/form";
import { formatDateTime } from "../lib/trpc";
import {
  ATTENDANCE_LABEL,
  formatHours,
  MEETING_STATUS_LABEL,
  MEETING_TYPE_LABEL,
  MINUTES_STATUS_LABEL,
  TASK_STATUS_LABEL,
} from "../lib/labels";
import type { RouterOutputs } from "../lib/trpc";

type MeetingDetail = RouterOutputs["meeting"]["getById"];

/** 纪要工作区：整理 → 提交确认（指定确认人）→ 确认固定；确认后再改产新版本（arch/05 §3） */
function MinutesWorkspace({ meeting, meId }: { meeting: MeetingDetail; meId: string }) {
  const versions = useMinutesVersions(meeting.id);
  const mutations = useMinutesMutations();
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  // §17.2 A3：小元纪要草稿——进入编辑态预填正文（用户编辑后提交）
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 小元草稿一次性消费：挂载时预填编辑器（用户确认后提交） */
    const draft = consumeAiDraft<string>(AI_MINUTES_DRAFT_KEY);
    if (draft) {
      setBody(draft);
      setEditing(true);
      toast.success("已预填纪要草稿", { description: "正文已生成，请编辑后提交确认。" });
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时消费一次
  }, []);
  const [disagreements, setDisagreements] = useState("");
  const [risks, setRisks] = useState("");
  const [confirmerId, setConfirmerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState(newIdempotencyKey);

  if (versions.isPending) return <p className="list-note">正在加载纪要…</p>;
  if (versions.isError) throw versions.error;
  const list = versions.data;
  const latest = list[list.length - 1];
  const current = list.find((v) => v.versionNo === selected) ?? latest;
  // saveDraft/submitConfirm 服务端仅要求会议可见（记录人=操作人落库）；confirm 要求确认人本人
  const canEdit = meeting.minutesStatus !== "none_required" && meeting.status !== "cancelled";
  const isConfirmer = latest?.confirmerId === meId;

  const startEdit = () => {
    const base = latest;
    setBody(base?.body ?? "");
    setDisagreements(base?.disagreements ?? "");
    setRisks(base?.risks ?? "");
    setEditing(true);
  };

  return (
    <section className="minutes-workspace">
      <div className="section-heading">
        <div>
          <span className="section-label">MINUTES</span>
          <h2>会议纪要</h2>
        </div>
        <div className="version-chips">
          {list.map((v) => (
            <button
              key={v.versionNo}
              className={`version-chip ${current?.versionNo === v.versionNo ? "active" : ""} ${v.confirmedAt ? "confirmed" : "draft"}`}
              onClick={() => setSelected(v.versionNo)}
            >
              V{v.versionNo}
              {v.confirmedAt ? " ✓" : " 未确认"}
            </button>
          ))}
        </div>
      </div>
      {!current && !editing ? (
        <p className="list-note">暂无纪要内容。</p>
      ) : (
        <div className={`minutes-version ${current?.confirmedAt ? "confirmed" : "unconfirmed"}`}>
          {current ? (
            !current.confirmedAt ? (
              <p className="unconfirmed-badge">该版本尚未确认，不作为正式记录</p>
            ) : (
              <p className="confirmed-badge">V{current.versionNo} 已确认（{formatDateTime(current.confirmedAt)}）</p>
            )
          ) : (
            <p className="unconfirmed-badge">整理后将生成 V1 草稿</p>
          )}
          {editing ? (
            <div className="minutes-editor">
              <label className="form-field">
                <span>纪要正文 *</span>
                <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
              </label>
              <label className="form-field">
                <span>分歧（可转决策）</span>
                <textarea rows={2} value={disagreements} onChange={(e) => setDisagreements(e.target.value)} />
              </label>
              <label className="form-field">
                <span>风险</span>
                <textarea rows={2} value={risks} onChange={(e) => setRisks(e.target.value)} />
              </label>
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="drawer-actions" style={{ justifyContent: "flex-start" }}>
                <button
                  className="secondary-action"
                  onClick={() => {
                    setError(null);
                    mutations.saveDraft.mutate(
                      {
                        meetingId: meeting.id,
                        body: body.trim(),
                        disagreements: disagreements.trim() || null,
                        risks: risks.trim() || null,
                      },
                      {
                        onSuccess: () => setEditing(false),
                        onError: (err) => setError(rootErrorMessage(err)),
                      },
                    );
                  }}
                >
                  保存{latest?.confirmedAt ? "为新版本" : "草稿"}
                </button>
                <button className="text-action" onClick={() => setEditing(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="issue-section">
                <span>纪要正文</span>
                <p className="pre-wrap">{current.body}</p>
              </div>
              {current.disagreements ? (
                <div className="issue-section">
                  <span>分歧</span>
                  <p className="pre-wrap">{current.disagreements}</p>
                </div>
              ) : null}
              {current.risks ? (
                <div className="issue-section">
                  <span>风险</span>
                  <p className="pre-wrap">{current.risks}</p>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
      {error && !editing ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="minutes-actions">
        {canEdit && meeting.minutesStatus === "pending_draft" && !editing ? (
          <>
            <button className="secondary-action" onClick={startEdit}>
              {latest?.confirmedAt ? "修改（产新版本）" : "整理纪要"}
            </button>
            {latest && !latest.confirmedAt ? (
              <span className="submit-confirm-row">
                <UserPicker value={confirmerId} onChange={setConfirmerId} placeholder="指定确认人" />
                <button
                  className="primary-action"
                  disabled={!confirmerId || mutations.submitConfirm.isPending}
                  onClick={() => {
                    setError(null);
                    mutations.submitConfirm.mutate(
                      { meetingId: meeting.id, versionNo: latest.versionNo, confirmerId },
                      {
                        onSuccess: () => setConfirmerId(""),
                        onError: (err) => setError(rootErrorMessage(err)),
                      },
                    );
                  }}
                >
                  提交确认
                  <ArrowRight size={15} />
                </button>
              </span>
            ) : null}
          </>
        ) : null}
        {canEdit && meeting.minutesStatus === "confirmed" && !editing ? (
          <button className="secondary-action" onClick={startEdit}>
            修改（产新版本）
          </button>
        ) : null}
        {meeting.minutesStatus === "pending_confirm" && isConfirmer && latest && !latest.confirmedAt ? (
          <button
            className="primary-action"
            disabled={mutations.confirm.isPending}
            onClick={() => {
              setError(null);
              mutations.confirm.mutate(
                { meetingId: meeting.id, versionNo: latest.versionNo, idempotencyKey: confirmKey },
                {
                  onSuccess: () => setConfirmKey(newIdempotencyKey()),
                  onError: (err) => setError(rootErrorMessage(err)),
                },
              );
            }}
          >
            <Check size={15} />
            确认纪要（固定版本）
          </button>
        ) : null}
        {meeting.minutesStatus === "pending_confirm" ? (
          <p className="context-note">等待确认人确认；确认前内容标识为「未确认」。</p>
        ) : null}
      </div>
    </section>
  );
}

/** 行动项：列表 + 新增 + 一键转任务（幂等；任务状态 join 单源） */
function ActionItemsPanel({ meeting }: { meeting: MeetingDetail }) {
  const items = useActionItems(meeting.id);
  const mutations = useActionMutations();
  const userNames = useUserNameMap();
  const [title, setTitle] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [checkpoint, setCheckpoint] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (items.isPending) return <p className="list-note">正在加载行动项…</p>;
  if (items.isError) throw items.error;

  return (
    <section className="action-panel">
      <div className="section-heading">
        <div>
          <span className="section-label">ACTION ITEMS</span>
          <h2>行动项（{items.data.length}）</h2>
        </div>
      </div>
      {items.data.length === 0 ? (
        <p className="list-note">暂无行动项。</p>
      ) : (
        items.data.map(({ item, taskStatus, taskCode }) => (
          <div className="action-row" key={item.id}>
            <div>
              <strong>{item.title}</strong>
              <small>
                负责人 {userNames.get(item.ownerId) ?? "—"} · 期限 {item.dueDate}
                {item.deliverable ? ` · 交付要求：${item.deliverable}` : ""}
                {item.checkpoint ? ` · 检查点：${item.checkpoint}` : ""}
              </small>
            </div>
            {item.status === "converted" ? (
              <Link className="badge badge-health-normal" to={`/projects/${meeting.projectId}/tasks`}>
                任务 {taskCode} · {taskStatus ? TASK_STATUS_LABEL[taskStatus] : "—"}
              </Link>
            ) : (
              <button
                className="secondary-action"
                disabled={mutations.convertToTask.isPending}
                onClick={() => {
                  setError(null);
                  mutations.convertToTask.mutate(
                    { id: item.id, idempotencyKey: newIdempotencyKey() },
                    { onError: (err) => setError(rootErrorMessage(err)) },
                  );
                }}
              >
                转为任务
              </button>
            )}
          </div>
        ))
      )}
      <div className="action-add">
        <input value={title} placeholder="行动项标题 *" aria-label="行动项标题" onChange={(e) => setTitle(e.target.value)} />
        <UserPicker value={ownerId} onChange={setOwnerId} placeholder="负责人" />
        <input type="date" value={dueDate} aria-label="期限" onChange={(e) => setDueDate(e.target.value)} />
        <input value={deliverable} placeholder="交付要求（选填）" aria-label="交付要求" onChange={(e) => setDeliverable(e.target.value)} />
        <input value={checkpoint} placeholder="检查点（选填）" aria-label="检查点" onChange={(e) => setCheckpoint(e.target.value)} />
        <button
          className="primary-action"
          disabled={!title.trim() || !ownerId || !dueDate || mutations.addItem.isPending}
          onClick={() => {
            setError(null);
            mutations.addItem.mutate(
              {
                meetingId: meeting.id,
                title: title.trim(),
                ownerId,
                dueDate,
                deliverable: deliverable.trim() || undefined,
                checkpoint: checkpoint.trim() || undefined,
              },
              {
                onSuccess: () => {
                  setTitle("");
                  setOwnerId("");
                  setDueDate("");
                  setDeliverable("");
                  setCheckpoint("");
                },
                onError: (err) => setError(rootErrorMessage(err)),
              },
            );
          }}
        >
          <Plus size={15} />
          添加
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** 会议详情：议程—结论—行动项—档案 连续关系（基线 §13.3） */
export default function MeetingDetailPage() {
  const { meetingId } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const meeting = useMeeting(meetingId ?? null);
  const mutations = useMeetingMutations();
  const userNames = useUserNameMap();
  const [attendance, setAttendance] = useState<Record<string, string> | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escTitle, setEscTitle] = useState("");
  const [escContext, setEscContext] = useState("");
  const [prefillOpen, setPrefillOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefill = useMeetingTimePrefill(meetingId ?? null, prefillOpen);
  const timeMutations = useTimeMutations();
  const escalate = useEscalateToDecision();
  const [prefillNotice, setPrefillNotice] = useState<string | null>(null);

  if (meeting.isPending || me.isPending) return <p className="list-note">正在加载会议…</p>;
  if (meeting.isError) throw meeting.error;
  if (me.isError) throw me.error;
  const m = meeting.data;

  const saveAttendance = () => {
    if (!attendance) return;
    setError(null);
    mutations.recordAttendance.mutate(
      {
        id: m.id,
        entries: Object.entries(attendance).map(([participantId, a]) => ({
          participantId,
          attendance: a as "planned" | "attended" | "absent" | "excused",
        })),
      },
      { onSuccess: () => setAttendance(null), onError: (err) => setError(rootErrorMessage(err)) },
    );
  };

  return (
    <div className="screen meeting-detail-screen">
      <div className="project-title-row">
        <div>
          {/* G8 返回按钮 */}
          <BackButton />
          <div className="breadcrumb">
            <Link to="/meetings">会议</Link>
            <ChevronRight size={13} />
            <span>{m.code}</span>
          </div>
          <h1>{m.subject}</h1>
          <p>
            {MEETING_TYPE_LABEL[m.type]} · {formatDateTime(m.startAt)} ~ {formatDateTime(m.endAt).slice(11)}
            {m.location ? ` · ${m.location}` : ""}
            {m.onlineUrl ? ` · 线上` : ""} · 组织者 {userNames.get(m.organizerId) ?? "—"}
            {m.recorderId ? ` · 记录人 ${userNames.get(m.recorderId) ?? "—"}` : ""}
          </p>
        </div>
        <div className="title-actions">
          <span className={`badge badge-lifecycle-${m.status === "planned" ? "in_progress" : m.status === "completed" ? "closed" : "preparing"}`}>
            {MEETING_STATUS_LABEL[m.status]}
          </span>
          {m.minutesStatus !== "none_required" ? (
            <span className={`badge badge-minutes-${m.minutesStatus}`}>{MINUTES_STATUS_LABEL[m.minutesStatus]}</span>
          ) : null}
        </div>
      </div>
      {m.status === "planned" ? (
        <div className="gantt-toolbar">
          <div className="toolbar-group">
            <button
              className="primary-action"
              disabled={mutations.transition.isPending}
              onClick={() => {
                setError(null);
                mutations.transition.mutate({ id: m.id, action: "complete" }, { onError: (err) => setError(rootErrorMessage(err)) });
              }}
            >
              <Check size={15} />
              标记完成
            </button>
            <button className="secondary-action" onClick={() => setCancelOpen(true)}>
              <X size={15} />
              取消会议
            </button>
            <button
              className="secondary-action"
              disabled={prefillOpen}
              onClick={() => setPrefillOpen((v) => !v)}
            >
              <Timer size={15} />
              工时预填建议
            </button>
          </div>
        </div>
      ) : null}
      {m.status === "completed" ? (
        <div className="gantt-toolbar">
          <div className="toolbar-group">
            <button className="secondary-action" onClick={() => setPrefillOpen((v) => !v)}>
              <Timer size={15} />
              工时预填建议
            </button>
            <button className="secondary-action" onClick={() => setEscalateOpen(true)}>
              <GitBranch size={15} />
              分歧转决策
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {prefillOpen ? (
        <div className="stat-region prefill-panel">
          {prefill.isPending ? (
            <p className="list-note">计算中（只算不存）…</p>
          ) : prefill.data ? (
            <>
              <strong>
                建议预填 {formatHours(prefill.data.minutes)}/人（{prefill.data.attendeeUserIds.length} 位出席人）
              </strong>
              <p className="context-note">
                出席人：{prefill.data.attendeeUserIds.map((id) => userNames.get(id) ?? "—").join("、")}
                。仅为建议预览：不保存、不计入任何工时统计。
              </p>
              <button
                className="primary-action"
                disabled={timeMutations.prefillFromMeeting.isPending}
                onClick={() => {
                  setPrefillNotice(null);
                  timeMutations.prefillFromMeeting.mutate({ meetingId: m.id }, {
                    onSuccess: (r) =>
                      setPrefillNotice(
                        r.created > 0
                          ? `已预填 ${r.created} 条草稿明细到本周工时（默认未提交、不计有效工时）`
                          : "已预填过（幂等跳过）或无需预填",
                      ),
                    onError: (err) => setPrefillNotice(rootErrorMessage(err)),
                  });
                }}
              >
                一键预填到本周草稿
              </button>
              {prefillNotice ? <p className="context-note">{prefillNotice}</p> : null}
            </>
          ) : (
            <p className="context-note">该会议无工时预填建议（已取消或无需纪要）。</p>
          )}
        </div>
      ) : null}

      <div className="meeting-grid">
        <section>
          <div className="issue-section">
            <span>议程</span>
            <p className="pre-wrap">{m.agenda ?? "（未填写议程）"}</p>
          </div>
          {m.minutesStatus !== "none_required" ? <MinutesWorkspace meeting={m} meId={me.data.user.id} /> : null}
          <ActionItemsPanel meeting={m} />
          {m.linkedDecisions.length > 0 ? (
            <section className="linked-decisions">
              <span className="section-label">LINKED DECISIONS</span>
              <h2>关联决策</h2>
              {m.linkedDecisions.map((d) => (
                <Link className="change-entry as-button" key={d.id} to={`/projects/${m.projectId}/decisions`}>
                  <span>{d.code}</span>
                  <div>
                    <strong>{d.title}</strong>
                  </div>
                  <time>{d.status}</time>
                  <ChevronRight size={15} />
                </Link>
              ))}
            </section>
          ) : null}
        </section>
        <aside className="meeting-side">
          <section className="participant-panel">
            <div className="section-heading">
              <div>
                <span className="section-label">PARTICIPANTS</span>
                <h2>参与人（{m.participants.length}）</h2>
              </div>
              {attendance !== null ? (
                <button className="text-action" onClick={saveAttendance} disabled={mutations.recordAttendance.isPending}>
                  保存考勤
                </button>
              ) : null}
            </div>
            {m.participants.map((p) => (
              <div className="participant-line" key={p.id}>
                <strong>{p.userName ?? p.externalName}</strong>
                <small>
                  {p.userName && p.externalName ? "" : p.externalOrg ? `${p.externalOrg}` : ""}
                  {p.role === "required" ? " · 必需" : " · 可选"}
                </small>
                {m.status !== "cancelled" ? (
                  <select
                    value={attendance?.[p.id] ?? p.attendance}
                    aria-label="考勤"
                    onChange={(e) =>
                      setAttendance((prev) => ({ ...(prev ?? {}), [p.id]: e.target.value }))
                    }
                  >
                    {Object.entries(ATTENDANCE_LABEL).map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="badge">{ATTENDANCE_LABEL[p.attendance]}</span>
                )}
              </div>
            ))}
          </section>
          <section className="materials-panel">
            <span className="section-label">MATERIALS</span>
            <h2>会议材料（{m.materials.length}）</h2>
            {m.materials.length === 0 ? (
              <p className="list-note">暂无材料；确认纪要时同目录 09 自动归集。</p>
            ) : (
              m.materials.map((f) => (
                <div className="file-row archive-item" key={f.fileVersionId}>
                  <div>
                    <FileText size={16} />
                    <span>
                      <strong>{f.name}</strong>
                      <small>{formatDateTime(f.uploadedAt)}</small>
                    </span>
                  </div>
                  <span className="archive-ops">
                    <a className="text-action" href={filePreviewUrl(f.fileVersionId)} target="_blank" rel="noreferrer">
                      预览
                    </a>
                    <a className="text-action" href={fileDownloadUrl(f.fileVersionId)}>
                      下载
                    </a>
                  </span>
                </div>
              ))
            )}
          </section>
        </aside>
      </div>

      {cancelOpen ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setCancelOpen(false)}>
          <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="取消会议">
            <div className="drawer-head">
              <div>
                <span className="section-label">CANCEL MEETING</span>
                <h2>取消会议</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setCancelOpen(false)}>
                <X size={19} />
              </button>
            </div>
            <p className="context-note">取消后不产生工时预填建议，不触发归档；操作留痕。</p>
            <label className="form-field">
              <span>取消原因 *</span>
              <textarea rows={3} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            </label>
            <button
              className="primary-action full-action"
              disabled={!cancelReason.trim() || mutations.transition.isPending}
              onClick={() => {
                setError(null);
                mutations.transition.mutate(
                  { id: m.id, action: "cancel", reason: cancelReason.trim() },
                  {
                    onSuccess: () => setCancelOpen(false),
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              确认取消
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
      ) : null}

      {escalateOpen ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setEscalateOpen(false)}>
          <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="分歧转决策">
            <div className="drawer-head">
              <div>
                <span className="section-label">ESCALATE TO DECISION</span>
                <h2>分歧转决策</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setEscalateOpen(false)}>
                <X size={19} />
              </button>
            </div>
            <label className="form-field">
              <span>决策单标题 *</span>
              <input value={escTitle} onChange={(e) => setEscTitle(e.target.value)} />
            </label>
            <label className="form-field">
              <span>背景与分歧 *（默认带入纪要分歧）</span>
              <textarea rows={5} value={escContext} onChange={(e) => setEscContext(e.target.value)} />
            </label>
            {escalate.error ? (
              <p className="form-error" role="alert">
                {rootErrorMessage(escalate.error)}
              </p>
            ) : null}
            <button
              className="primary-action full-action"
              disabled={!escTitle.trim() || !escContext.trim() || escalate.isPending}
              onClick={() => {
                escalate.mutate(
                  { meetingId: m.id, title: escTitle.trim(), context: escContext.trim() },
                  {
                    onSuccess: () => navigate(`/projects/${m.projectId}/decisions`),
                    onError: () => undefined,
                  },
                );
              }}
            >
              生成决策单
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
