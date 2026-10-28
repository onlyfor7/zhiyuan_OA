import { useMemo, useState } from "react";
import {
  ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, Copy, Download, Lock,
  LockOpen, Plus, Timer, Unlock, X,
} from "lucide-react";
import { TIME_ACTIVITY_TYPE } from "@lexflow/shared";

import { useMeetingList } from "../api/meeting";
import { useTravelList } from "../api/travel";
import { useMe } from "../api/auth";
import {
  useMyPeriod,
  useMyTimeSummary,
  useTimeExportCsv,
  useTimeMutations,
  useTimeStatsByActivity,
  useValidatePeriod,
  type TimeEntryInput,
  type TimeEntryRow,
} from "../api/time";
import { useRail } from "../components/shell-rail";
import { businessDetailsOf } from "../lib/trpc";
import { newIdempotencyKey, rootErrorMessage } from "../lib/form";
import { formatMinutes, TIMESHEET_STATUS_LABEL, TIME_ACTIVITY_LABEL, TIME_SOURCE_LABEL } from "../lib/labels";

function TimeRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">TIMESHEET</span>
        <h2>工时中心</h2>
      </div>
      <div className="context-section">
        <div className="section-label">RULES</div>
        <h2>口径与红线（arch/07 §4）</h2>
        <p className="context-note">
          整数分钟；单日 &gt;24h 跨周期合并阻止；预填/复制仅草稿、默认未提交、不计有效工时；有效工时 =
          已批准 + 已锁定，其余状态单列。
        </p>
      </div>
      <div className="assurance">统计各页面读同一聚合函数，同名指标同数。</div>
    </aside>
  );
}

function mondayOf(date: Date): string {
  const d = new Date(date.getTime());
  const day = d.getDay() || 7;
  d.setDate(d.getDate() + 1 - day);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

interface RowDraft extends TimeEntryInput {
  key: string;
}

function toRows(
  entries: {
    id: string;
    projectId: string | null;
    taskId: string | null;
    meetingId: string | null;
    travelId: string | null;
    activityType: TimeEntryInput["activityType"];
    workDate: string;
    durationMinutes: number;
    description: string | null;
    billable: boolean;
  }[],
): RowDraft[] {
  return entries.map((e) => ({
    key: e.id,
    projectId: e.projectId,
    taskId: e.taskId,
    meetingId: e.meetingId,
    travelId: e.travelId,
    activityType: e.activityType,
    workDate: e.workDate,
    durationMinutes: e.durationMinutes,
    description: e.description ?? undefined,
    billable: e.billable,
  }));
}

export default function TimeCenterPage() {
  useRail(TimeRail);
  const me = useMe();
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const myPeriod = useMyPeriod(weekStart);
  const mutations = useTimeMutations();
  const [view, setView] = useState<"week" | "list">("week");
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [validateOpen, setValidateOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyTo, setCopyTo] = useState("");
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockReason, setUnlockReason] = useState("");
  const [prefillMeetingId, setPrefillMeetingId] = useState("");
  const [prefillTravelId, setPrefillTravelId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const period = myPeriod.data?.period ?? null;
  const entries = useMemo(() => myPeriod.data?.entries ?? [], [myPeriod.data]);
  const validate = useValidatePeriod(period?.id ?? null, validateOpen);
  const mySummary = useMyTimeSummary({ from: weekStart, to: addDays(weekStart, 6) });
  const byActivity = useTimeStatsByActivity({ from: weekStart, to: addDays(weekStart, 6) });
  const exportCsv = useTimeExportCsv({ from: weekStart, to: addDays(weekStart, 6) });
  const meetings = useMeetingList({ mine: true });
  const travels = useTravelList({ mine: true });

  if (myPeriod.isPending || me.isPending) return <p className="list-note">正在加载工时…</p>;
  if (myPeriod.isError) throw myPeriod.error;
  if (me.isError) throw me.error;

  const readOnly = !period || period.status !== "draft" && period.status !== "returned";
  const canUnlock = me.data.globalRoles.includes("partner") || me.data.globalRoles.includes("sysadmin");
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const totalMinutes = entries.reduce((s, e) => s + e.durationMinutes, 0);
  const byDate = new Map<string, number>();
  for (const e of entries) byDate.set(e.workDate, (byDate.get(e.workDate) ?? 0) + e.durationMinutes);

  const run = (fn: () => void) => {
    setError(null);
    setNotice(null);
    fn();
  };

  return (
    <div className="screen time-center-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">TIME TRACKING</span>
          <h1>工时中心</h1>
          <p>
            {weekStart} ~ {addDays(weekStart, 6)} ·{" "}
            {period ? (
              <>
                {period.code} · <span className={`badge badge-minutes-${period.status === "approved" ? "confirmed" : period.status === "locked" ? "none_required" : "pending_draft"}`}>{TIMESHEET_STATUS_LABEL[period.status]}</span> · 本周合计{" "}
                {formatMinutes(totalMinutes)}
              </>
            ) : (
              "本周暂无周期（保存时自动创建草稿）"
            )}
          </p>
        </div>
        <div className="title-actions">
          <button className="secondary-action" onClick={() => setWeekStart((w) => addDays(w, -7))}>
            <ChevronLeft size={15} />
            上一周
          </button>
          <button className="secondary-action" onClick={() => setWeekStart(mondayOf(new Date()))}>
            本周
          </button>
          <button className="secondary-action" onClick={() => setWeekStart((w) => addDays(w, 7))}>
            下一周
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      {period?.status === "returned" && period.returnedNote ? (
        <div className="blocking-banner">
          <X size={18} />
          <div>
            <strong>周期被退回</strong>
            <p>审批意见：{period.returnedNote}（修改明细后可重新提交）</p>
          </div>
        </div>
      ) : null}
      {period?.status === "locked" ? (
        <p className="archive-banner small">该周期已锁定：明细只读。解锁需 time.unlock 专门授权并填写理由（留审计）。</p>
      ) : null}
      {period?.status === "approved" ? (
        <p className="archive-banner small" style={{ background: "#e8f4ef", color: "#2f6b57", borderColor: "#bfe0d2" }}>
          该周期已批准：明细只读，可锁定归档。
        </p>
      ) : null}

      <div className="quality-toolbar">
        <div className="audit-tabs inline-tabs">
          <button className={view === "week" ? "active" : ""} onClick={() => setView("week")}>
            <CalendarDays size={14} />
            周日历
          </button>
          <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>
            列表视图
          </button>
        </div>
        {period && !readOnly ? (
          <button className="secondary-action" onClick={() => run(() => setValidateOpen(true))}>
            校验（阻止/警告）
          </button>
        ) : null}
        {period && !readOnly && entries.length > 0 ? (
          <button
            className="primary-action"
            disabled={mutations.submit.isPending}
            onClick={() =>
              run(() =>
                mutations.submit.mutate(
                  { periodId: period.id, idempotencyKey: newIdempotencyKey() },
                  {
                    onSuccess: (r) => {
                      if (r.warnings.length > 0) setNotice(`已提交（含 ${r.warnings.length} 条警告）：${r.warnings.join("；")}`);
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                ),
              )
            }
          >
            提交审批
            <ArrowRight size={15} />
          </button>
        ) : null}
        {period?.status === "pending_approval" ? (
          <button
            className="secondary-action"
            disabled={mutations.withdraw.isPending}
            onClick={() =>
              run(() =>
                mutations.withdraw.mutate(
                  { periodId: period.id, rowVersion: period.rowVersion },
                  { onError: (err) => setError(rootErrorMessage(err)) },
                ),
              )
            }
          >
            撤回
          </button>
        ) : null}
        {period?.status === "approved" ? (
          <button
            className="secondary-action"
            disabled={mutations.lock.isPending}
            onClick={() =>
              run(() =>
                mutations.lock.mutate({ periodId: period.id }, { onError: (err) => setError(rootErrorMessage(err)) }),
              )
            }
          >
            <Lock size={15} />
            锁定周期
          </button>
        ) : null}
        {period?.status === "locked" && canUnlock ? (
          <button className="secondary-action" onClick={() => setUnlockOpen(true)}>
            <Unlock size={15} />
            解锁（需理由）
          </button>
        ) : null}
        {period && !readOnly ? (
          <button className="secondary-action" onClick={() => setCopyOpen(true)}>
            <Copy size={14} />
            复制当日
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="context-note" role="status">
          {notice}
        </p>
      ) : null}

      {validateOpen && validate.data ? (
        <div className="validation-panel">
          {validate.data.blockers.length === 0 ? (
            <p className="check-line pass">
              <Check size={14} />
              <strong>无阻止项</strong>
              <small>可提交审批</small>
            </p>
          ) : (
            validate.data.blockers.map((b) => (
              <p className="check-line fail" key={b} role="alert">
                <X size={14} />
                <strong>阻止</strong>
                <small>{b}</small>
              </p>
            ))
          )}
          {validate.data.warnings.map((w) => (
            <p className="check-line warn" key={w}>
              <Timer size={14} />
              <strong>警告</strong>
              <small>{w}</small>
            </p>
          ))}
        </div>
      ) : null}

      {view === "week" ? (
        <div className="week-grid" role="grid" aria-label="周日历">
          {days.map((d) => (
            <button
              key={d}
              className={`day-cell ${d === selectedDate ? "selected" : ""} ${d === new Date().toISOString().slice(0, 10) ? "today" : ""}`}
              onClick={() => setSelectedDate(d)}
            >
              <span className="day-name">{["一", "二", "三", "四", "五", "六", "日"][days.indexOf(d)]}</span>
              <strong>{d.slice(5)}</strong>
              <small>{byDate.get(d) ? formatMinutes(byDate.get(d)) : "—"}</small>
            </button>
          ))}
        </div>
      ) : (
        <div className="time-list-table">
          <div className="time-list-head">
            <span>日期</span>
            <span>项目 / 关联</span>
            <span>活动类型</span>
            <span>时长</span>
            <span>来源</span>
            <span>说明</span>
          </div>
          {entries.length === 0 ? (
            <p className="list-note">本周暂无明细。</p>
          ) : (
            entries.map((e) => (
              <div className="time-list-row" key={e.id}>
                <span className="mono">{e.workDate}</span>
                <span>{e.projectId ? e.projectId.slice(0, 8) : "非项目"}</span>
                <span>{TIME_ACTIVITY_LABEL[e.activityType]}</span>
                <span className="mono">{formatMinutes(e.durationMinutes)}</span>
                <span>
                  <span className={`badge ${e.source !== "manual" ? "badge-minutes-pending_confirm" : ""}`}>
                    {TIME_SOURCE_LABEL[e.source]}
                  </span>
                </span>
                <span>{e.description ?? "—"}</span>
              </div>
            ))
          )}
        </div>
      )}

      {period && !readOnly ? (
        <DayEditor
          key={`${period.id}:${entries.length}:${entries.reduce((s, e) => s + e.rowVersion, 0)}`}
          periodId={period.id}
          selectedDate={selectedDate}
          serverEntries={entries}
          meProjects={me.data.projects.map((p) => ({ id: p.id, name: p.name }))}
          meetings={(meetings.data?.items ?? []).map((m) => ({ id: m.id, code: m.code, label: m.subject }))}
          travels={(travels.data?.items ?? []).map((t) => ({ id: t.id, code: t.code, label: `${t.destination}` }))}
          onSaved={() => setNotice("已保存（覆盖式保存本周全量草稿）")}
          onError={(err) => setError(err)}
        />
      ) : period ? (
        <p className="context-note" style={{ marginTop: 16 }}>
          当前周期为「{TIMESHEET_STATUS_LABEL[period.status]}」状态，明细只读。
          {period.status === "pending_approval" && period.approverId ? ` 审批人：${period.approverId.slice(0, 8)}。` : ""}
          {period.status === "locked" && period.lockReason ? ` 锁定原因：${period.lockReason}。` : ""}
        </p>
      ) : null}

      {!readOnly && period ? (
        <section className="prefill-section">
          <span className="section-label">PREFILL</span>
          <h2>从会议 / 出差预填（仅草稿）</h2>
          <div className="owner-line">
            <label className="form-field">
              <span>会议</span>
              <select value={prefillMeetingId} onChange={(e) => setPrefillMeetingId(e.target.value)}>
                <option value="">选择会议</option>
                {(meetings.data?.items ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.code} · {m.subject}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-action"
              disabled={!prefillMeetingId || mutations.prefillFromMeeting.isPending}
              onClick={() =>
                run(() =>
                  mutations.prefillFromMeeting.mutate(
                    { meetingId: prefillMeetingId, periodId: period && period.status === "draft" ? period.id : undefined },
                    {
                      onSuccess: (r) =>
                        setNotice(
                          r.created > 0 ? `已预填 ${r.created} 条草稿明细（默认未提交、不计有效工时）` : "该会议已预填过（幂等跳过）或无需预填",
                        ),
                      onError: (err) => setError(rootErrorMessage(err)),
                    },
                  ),
                )
              }
            >
              预填会议工时
            </button>
            <label className="form-field">
              <span>出差</span>
              <select value={prefillTravelId} onChange={(e) => setPrefillTravelId(e.target.value)}>
                <option value="">选择出差</option>
                {(travels.data?.items ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} · {t.destination}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-action"
              disabled={!prefillTravelId || mutations.prefillFromTravel.isPending}
              onClick={() =>
                run(() =>
                  mutations.prefillFromTravel.mutate(
                    { travelId: prefillTravelId, periodId: period && period.status === "draft" ? period.id : undefined },
                    {
                      onSuccess: (r) =>
                        setNotice(
                          r.created > 0 ? `已预填 ${r.created} 条草稿明细（逐日拆分、不按 24h）` : "该出差已预填过（幂等跳过）或不可预填",
                        ),
                      onError: (err) => setError(rootErrorMessage(err)),
                    },
                  ),
                )
              }
            >
              预填出差工时
            </button>
          </div>
          <p className="context-note">预填只生成草稿：提交前必须本人确认；取消的会议/出差会被拒绝；重复预填幂等去重。</p>
          {(mutations.prefillFromMeeting.data || mutations.prefillFromTravel.data) &&
          (mutations.prefillFromMeeting.data?.skipped || mutations.prefillFromTravel.data?.skipped) ? (
            <p className="context-note">skipped=1：命中（会议/出差 + 用户 + 日期）幂等去重，未重复创建。</p>
          ) : null}
        </section>
      ) : null}

      <section className="stats-section">
        <div className="section-heading">
          <div>
            <span className="section-label">STATS</span>
            <h2>我的统计与缺口</h2>
          </div>
          <button
            className="secondary-action"
            onClick={() => {
              void exportCsv().then((r) => {
                const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `工时导出_${weekStart}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              });
            }}
          >
            <Download size={15} />
            导出 CSV
          </button>
        </div>
        {mySummary.isPending ? (
          <p className="list-note">正在加载…</p>
        ) : mySummary.isError ? (
          <p className="list-note">统计不可用。</p>
        ) : (
          <>
            <div className="metric-strip overview-strip">
              <div>
                <span>有效工时（批准+锁定）</span>
                <strong>{formatMinutes(mySummary.data.minutes.approvedAndLocked)}</strong>
              </div>
              <div>
                <span>待审批</span>
                <strong>{formatMinutes(mySummary.data.minutes.pendingApproval)}</strong>
              </div>
              <div>
                <span>草稿 / 已退回</span>
                <strong>
                  {formatMinutes(mySummary.data.minutes.draft)} / {formatMinutes(mySummary.data.minutes.returned)}
                </strong>
              </div>
            </div>
            <p className="context-note">
              {mySummary.data.statusScope}；asOf {mySummary.data.asOf.slice(0, 16).replace("T", " ")}
            </p>
            {mySummary.data.gapDates.length > 0 ? (
              <p className="context-note">缺口提示：以下工作日尚无明细——{mySummary.data.gapDates.join("、")}</p>
            ) : null}
            {byActivity.data ? (
              <p className="context-note">
                本周按活动：
                {byActivity.data.items
                  .map((i) => `${TIME_ACTIVITY_LABEL[i.key ?? ""] ?? i.key} ${formatMinutes(i.minutes)}`)
                  .join("；")}
              </p>
            ) : null}
          </>
        )}
      </section>

      {copyOpen ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setCopyOpen(false)}>
          <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="复制当日">
            <div className="drawer-head">
              <div>
                <span className="section-label">COPY DAY</span>
                <h2>复制当日明细为草稿</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setCopyOpen(false)}>
                <X size={19} />
              </button>
            </div>
            <p className="context-note">
              将把 {selectedDate} 的明细复制到目标日期（source=复制）；复制后仍为草稿，提交前必须确认。
            </p>
            <label className="form-field">
              <span>目标日期 *</span>
              <input type="date" value={copyTo} onChange={(e) => setCopyTo(e.target.value)} />
            </label>
            <button
              className="primary-action full-action"
              disabled={!copyTo || mutations.copyDay.isPending}
              onClick={() =>
                run(() =>
                  mutations.copyDay.mutate(
                    { fromDate: selectedDate, toDate: copyTo },
                    {
                      onSuccess: () => {
                        setCopyOpen(false);
                        setCopyTo("");
                        setSelectedDate(copyTo);
                      },
                      onError: (err) => setError(rootErrorMessage(err)),
                    },
                  ),
                )
              }
            >
              复制到目标日期
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
      ) : null}

      {unlockOpen && period ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setUnlockOpen(false)}>
          <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="解锁周期">
            <div className="drawer-head">
              <div>
                <span className="section-label">UNLOCK</span>
                <h2>解锁工时周期</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setUnlockOpen(false)}>
                <X size={19} />
              </button>
            </div>
            <p className="context-note">解锁需 time.unlock 专门授权（partner/系统管理员）+ 理由，并写入审计。</p>
            <label className="form-field">
              <span>解锁理由 *</span>
              <textarea rows={2} value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)} />
            </label>
            <button
              className="primary-action full-action"
              disabled={!unlockReason.trim() || mutations.unlock.isPending}
              onClick={() =>
                run(() =>
                  mutations.unlock.mutate(
                    { periodId: period.id, reason: unlockReason.trim() },
                    {
                      onSuccess: () => {
                        setUnlockOpen(false);
                        setUnlockReason("");
                      },
                      onError: (err) => setError(rootErrorMessage(err)),
                    },
                  ),
                )
              }
            >
              <LockOpen size={15} />
              确认解锁
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

/** 按日录入编辑器：行内编辑 + 覆盖式保存全量（draft/returned 可编辑） */
function DayEditor({
  periodId,
  selectedDate,
  serverEntries,
  meProjects,
  meetings,
  travels,
  onSaved,
  onError,
}: {
  periodId: string;
  selectedDate: string;
  serverEntries: TimeEntryRow[];
  meProjects: { id: string; name: string }[];
  meetings: { id: string; code: string; label: string }[];
  travels: { id: string; code: string; label: string }[];
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const mutations = useTimeMutations();
  const dayEntries = serverEntries.filter((e) => e.workDate === selectedDate);
  const otherEntries = serverEntries.filter((e) => e.workDate !== selectedDate);
  const [drafts, setDrafts] = useState<RowDraft[]>(() => toRows(dayEntries));

  const dirty = JSON.stringify(drafts) !== JSON.stringify(toRows(dayEntries));

  const addRow = () =>
    setDrafts((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        projectId: meProjects[0]?.id ?? null,
        activityType: "professional_work",
        workDate: selectedDate,
        durationMinutes: 60,
        billable: true,
      },
    ]);

  const save = () => {
    const all = [
      ...otherEntries.map((e) => toRows([e])[0]),
      ...drafts.map((d) => ({
        projectId: d.projectId,
        taskId: d.taskId,
        meetingId: d.meetingId,
        travelId: d.travelId,
        activityType: d.activityType,
        workDate: d.workDate,
        durationMinutes: d.durationMinutes,
        description: d.description,
        billable: d.billable,
      })),
    ];
    mutations.saveEntries.mutate(
      { periodId, entries: all, idempotencyKey: newIdempotencyKey() },
      {
        onSuccess: () => onSaved(),
        onError: (err) => {
          const blockers = businessDetailsOf<string[]>(err);
          onError(blockers && blockers.length > 0 ? `校验未通过：${blockers.join("；")}` : rootErrorMessage(err));
        },
      },
    );
  };

  return (
    <section className="day-editor">
      <div className="section-heading">
        <div>
          <span className="section-label">DAY · {selectedDate}</span>
          <h2>当日明细（{drafts.length}）</h2>
        </div>
        <div className="row-ops">
          <button className="secondary-action" onClick={addRow}>
            <Plus size={14} />
            添加明细
          </button>
          <button className="primary-action" disabled={!dirty || mutations.saveEntries.isPending} onClick={save}>
            保存本周全量
          </button>
        </div>
      </div>
      <p className="context-note">
        保存为覆盖式（提交本周全部明细）；整数分钟 &gt;0；单日 &gt;24h（跨周期合并）将被阻止。
      </p>
      {drafts.length === 0 ? (
        <p className="list-note">当日暂无明细，点击「添加明细」。</p>
      ) : (
        drafts.map((row, idx) => (
          <div className="time-entry-row" key={row.key}>
            <input
              type="number"
              min="1"
              step="1"
              value={row.durationMinutes}
              aria-label="时长（分钟）"
              onChange={(e) =>
                setDrafts((prev) => prev.map((x, i) => (i === idx ? { ...x, durationMinutes: Number(e.target.value) } : x)))
              }
            />
            <span className="entry-unit">分钟</span>
            <select
              value={row.activityType}
              aria-label="活动类型"
              onChange={(e) =>
                setDrafts((prev) => prev.map((x, i) => (i === idx ? { ...x, activityType: e.target.value as never } : x)))
              }
            >
              {TIME_ACTIVITY_TYPE.map((t) => (
                <option key={t} value={t}>
                  {TIME_ACTIVITY_LABEL[t]}
                </option>
              ))}
            </select>
            <select
              value={row.projectId ?? ""}
              aria-label="项目"
              onChange={(e) =>
                setDrafts((prev) =>
                  prev.map((x, i) => (i === idx ? { ...x, projectId: e.target.value || null } : x)),
                )
              }
            >
              <option value="">非项目工作</option>
              {meProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={row.meetingId ?? ""}
              aria-label="关联会议"
              onChange={(e) =>
                setDrafts((prev) => prev.map((x, i) => (i === idx ? { ...x, meetingId: e.target.value || null } : x)))
              }
            >
              <option value="">不关联会议</option>
              {meetings.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code}
                </option>
              ))}
            </select>
            <select
              value={row.travelId ?? ""}
              aria-label="关联出差"
              onChange={(e) =>
                setDrafts((prev) => prev.map((x, i) => (i === idx ? { ...x, travelId: e.target.value || null } : x)))
              }
            >
              <option value="">不关联出差</option>
              {travels.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code}
                </option>
              ))}
            </select>
            <input
              value={row.description ?? ""}
              placeholder="说明（缺说明将警告）"
              aria-label="说明"
              onChange={(e) =>
                setDrafts((prev) => prev.map((x, i) => (i === idx ? { ...x, description: e.target.value } : x)))
              }
            />
            <label className="check-field compact">
              <input
                type="checkbox"
                checked={row.billable ?? true}
                onChange={(e) =>
                  setDrafts((prev) => prev.map((x, i) => (i === idx ? { ...x, billable: e.target.checked } : x)))
                }
              />
              计件标记
            </label>
            <button
              className="icon-button"
              aria-label="删除明细"
              onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== idx))}
            >
              <X size={15} />
            </button>
          </div>
        ))
      )}
      <p className="context-note">提示：工作日可在「校验」中查看 24h 阻止、超阈值与缺说明警告（文案来自服务端）。</p>
    </section>
  );
}

