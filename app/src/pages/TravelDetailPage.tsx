import { useState } from "react";
import { BackButton } from "../components/feedback";
import { Link, useParams } from "react-router";
import {
  ArrowRight, Check, ChevronRight, FileText, MapPin, Timer, X,
} from "lucide-react";

import { fileDownloadUrl, filePreviewUrl } from "../api/archive";
import { useTravel, useTravelMutations, useTravelTimePrefill } from "../api/travel";
import { useTimeMutations } from "../api/time";
import { ApprovalSteps } from "../components/ApprovalSteps";
import { newIdempotencyKey, rootErrorMessage } from "../lib/form";
import { formatDateTime } from "../lib/trpc";
import {
  formatHours,
  SEGMENT_TYPE_LABEL,
  TRAVEL_EVENT_LABEL,
  TRAVEL_STATUS_LABEL,
} from "../lib/labels";

/** 出差详情：行程—申请—费用 时间轴（arch/05 §5；complete 前必须先 depart） */
export default function TravelDetailPage() {
  const { travelId } = useParams();
  const travel = useTravel(travelId ?? null);
  const mutations = useTravelMutations();
  const [modal, setModal] = useState<"cancel" | "change" | "complete" | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [changeReason, setChangeReason] = useState("");
  const [changeFields, setChangeFields] = useState({ destination: "", startOn: "", endOn: "", estimatedYuan: "" });
  const [summary, setSummary] = useState("");
  const [costNote, setCostNote] = useState("");
  const [prefillOpen, setPrefillOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefill = useTravelTimePrefill(travelId ?? null, prefillOpen);
  const timeMutations = useTimeMutations();
  const [prefillNotice, setPrefillNotice] = useState<string | null>(null);

  if (travel.isPending) return <p className="list-note">正在加载出差单…</p>;
  if (travel.isError) throw travel.error;
  const t = travel.data;
  const run = (fn: () => void) => {
    setError(null);
    fn();
  };

  return (
    <div className="screen travel-detail-screen">
      <div className="project-title-row">
        <div>
          {/* G8 返回按钮 */}
          <BackButton />
          <div className="breadcrumb">
            <Link to="/travel">出差</Link>
            <ChevronRight size={13} />
            <span>{t.code}</span>
          </div>
          <h1>
            {t.destination}
            {t.borrow ? <em className="mark-duesoon">借款出差</em> : null}
          </h1>
          <p>
            {t.startOn} ~ {t.endOn}
            {t.estimatedCostCents != null ? ` · 预计 ${(t.estimatedCostCents / 100).toFixed(2)} 元` : ""}
            {t.borrow && t.borrowAmountCents != null ? ` · 拟借 ${(t.borrowAmountCents / 100).toFixed(2)} 元` : ""}
          </p>
        </div>
        <div className="title-actions">
          <span className={`badge badge-travel-${t.status}`}>{TRAVEL_STATUS_LABEL[t.status]}</span>
        </div>
      </div>

      <div className="gantt-toolbar">
        <div className="toolbar-group">
          {t.status === "draft" ? (
            <>
              <button
                className="primary-action"
                disabled={mutations.submit.isPending}
                onClick={() =>
                  run(() =>
                    mutations.submit.mutate(
                      { id: t.id, rowVersion: t.rowVersion, idempotencyKey: newIdempotencyKey() },
                      { onError: (err) => setError(rootErrorMessage(err)) },
                    ),
                  )
                }
              >
                提交审批
                <ArrowRight size={15} />
              </button>
            </>
          ) : null}
          {t.status === "pending_approval" ? (
            <button
              className="secondary-action"
              disabled={mutations.withdraw.isPending}
              onClick={() =>
                run(() =>
                  mutations.withdraw.mutate(
                    { id: t.id, rowVersion: t.rowVersion },
                    { onError: (err) => setError(rootErrorMessage(err)) },
                  ),
                )
              }
            >
              撤回申请
            </button>
          ) : null}
          {t.status === "approved" ? (
            <button
              className="primary-action"
              disabled={mutations.transition.isPending}
              onClick={() =>
                run(() =>
                  mutations.transition.mutate(
                    { id: t.id, action: "depart", rowVersion: t.rowVersion },
                    { onError: (err) => setError(rootErrorMessage(err)) },
                  ),
                )
              }
            >
              出发（开始出差）
            </button>
          ) : null}
          {t.status === "in_progress" ? (
            <button className="primary-action" onClick={() => setModal("complete")}>
              <Check size={15} />
              完成登记
            </button>
          ) : null}
          {t.status === "approved" || t.status === "in_progress" ? (
            <>
              <button className="secondary-action" onClick={() => setModal("change")}>
                变更申请
              </button>
              <button className="secondary-action" onClick={() => setModal("cancel")}>
                取消出差
              </button>
            </>
          ) : null}
          {t.status === "completed" ? (
            <>
              <button
                className="secondary-action"
                disabled={mutations.transition.isPending}
                onClick={() =>
                  run(() =>
                    mutations.transition.mutate(
                      { id: t.id, action: "close", rowVersion: t.rowVersion },
                      { onError: (err) => setError(rootErrorMessage(err)) },
                    ),
                  )
                }
              >
                关闭单据
              </button>
              <Link
                className="primary-action"
                to={`/expenses/new?travelId=${t.id}&projectId=${t.projectId}`}
              >
                发起报销
              </Link>
            </>
          ) : null}
          <button className="secondary-action" onClick={() => setPrefillOpen((v) => !v)}>
            <Timer size={15} />
            工时预填建议
          </button>
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {prefillOpen ? (
        <div className="stat-region prefill-panel">
          {prefill.isPending ? (
            <p className="list-note">计算中（只算不存，不按 24h）…</p>
          ) : prefill.data ? (
            <>
              <strong>按分段日期的每日预填建议：</strong>
              <ul>
                {prefill.data.days.map((d) => (
                  <li key={d.date}>
                    {d.date}：{formatHours(d.minutes)}
                  </li>
                ))}
              </ul>
              <p className="context-note">仅为建议预览：不保存、不计入工时统计。</p>
              <button
                className="primary-action"
                disabled={timeMutations.prefillFromTravel.isPending}
                onClick={() => {
                  setPrefillNotice(null);
                  timeMutations.prefillFromTravel.mutate(
                    { travelId: t.id },
                    {
                      onSuccess: (r) =>
                        setPrefillNotice(
                          r.created > 0
                            ? `已预填 ${r.created} 条草稿明细（逐日拆分、默认未提交、不计有效工时）`
                            : "已预填过（幂等跳过）或该出差不可预填",
                        ),
                      onError: (err) => setPrefillNotice(rootErrorMessage(err)),
                    },
                  );
                }}
              >
                一键预填到本周草稿
              </button>
              {prefillNotice ? <p className="context-note">{prefillNotice}</p> : null}
            </>
          ) : (
            <p className="context-note">该出差单无工时预填建议（已取消或已驳回）。</p>
          )}
        </div>
      ) : null}

      <div className="travel-grid">
        <section>
          <span className="section-label">SEGMENTS</span>
          <h2>分段行程（{t.segments.length}）</h2>
          <div className="segment-table">
            <div className="segment-head">
              <span>#</span>
              <span>类型</span>
              <span>区间</span>
              <span>时间</span>
              <span>说明</span>
            </div>
            {t.segments.map((s) => (
              <div className="segment-line" key={s.id}>
                <span>{s.seq}</span>
                <span className="badge">{SEGMENT_TYPE_LABEL[s.type]}</span>
                <span>
                  {s.fromPlace || "—"} → {s.toPlace || "—"}
                </span>
                <span>
                  {formatDateTime(s.startAt)} ~ {formatDateTime(s.endAt).slice(11)}
                </span>
                <span>{s.description ?? ""}</span>
              </div>
            ))}
          </div>
          <span className="section-label" style={{ display: "block", marginTop: 22 }}>
            TIMELINE
          </span>
          <h2>事件流（只追加，关键变更前后值留痕）</h2>
          <div className="resolution-timeline travel-timeline">
            {t.events.map((ev) => {
              const payload = ev.payloadJson as Record<string, unknown> | null;
              return (
                <div className="done" key={ev.id}>
                  <Check size={15} />
                  <span>
                    {TRAVEL_EVENT_LABEL[ev.action] ?? ev.action}
                    {payload?.reason ? `：${String(payload.reason)}` : ""}
                    {payload?.before ? (
                      <small>
                        变更前：
                        {JSON.stringify(payload.before)}
                      </small>
                    ) : null}
                    <small>{formatDateTime(ev.createdAt)}</small>
                  </span>
                </div>
              );
            })}
          </div>
          {t.approvalInstance ? (
            <div style={{ marginTop: 20 }}>
              <ApprovalSteps instanceId={t.approvalInstance.id} />
            </div>
          ) : null}
        </section>
        <aside className="meeting-side">
          <section>
            <span className="section-label">BASIC</span>
            <h2>申请信息</h2>
            <dl className="detail-list">
              <div>
                <dt>申请人</dt>
                <dd>{t.applicantId.slice(0, 8)}</dd>
              </div>
              <div>
                <dt>事由</dt>
                <dd>{t.reason}</dd>
              </div>
              {t.completedAt ? (
                <div>
                  <dt>完成时间</dt>
                  <dd>{formatDateTime(t.completedAt)}</dd>
                </div>
              ) : null}
              {t.completionSummary ? (
                <div>
                  <dt>完成摘要</dt>
                  <dd>{t.completionSummary}</dd>
                </div>
              ) : null}
              {t.actualCostNote ? (
                <div>
                  <dt>实际费用说明</dt>
                  <dd>{t.actualCostNote}</dd>
                </div>
              ) : null}
            </dl>
          </section>
          <section className="materials-panel">
            <span className="section-label">MATERIALS</span>
            <h2>出差材料（{t.materials.length}）</h2>
            {t.materials.length === 0 ? (
              <p className="list-note">完成登记时申请材料自动归集项目档案目录 10。</p>
            ) : (
              t.materials.map((f) => (
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
          <div className="assurance">
            <MapPin size={16} />
            <span>预计/借款金额仅提示展示（整数分存储），不写预算台账、不产生费用记录。</span>
          </div>
        </aside>
      </div>

      {modal === "cancel" ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setModal(null)}>
          <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="取消出差">
            <div className="drawer-head">
              <div>
                <span className="section-label">CANCEL</span>
                <h2>取消出差</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setModal(null)}>
                <X size={19} />
              </button>
            </div>
            <p className="context-note">取消后单据终态（approved → cancelled），事件流留痕。</p>
            <label className="form-field">
              <span>取消原因 *</span>
              <textarea rows={3} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            </label>
            <button
              className="primary-action full-action"
              disabled={!cancelReason.trim() || mutations.transition.isPending}
              onClick={() =>
                run(() =>
                  mutations.transition.mutate(
                    { id: t.id, action: "cancel", rowVersion: t.rowVersion, reason: cancelReason.trim() },
                    {
                      onSuccess: () => {
                        setModal(null);
                        setCancelReason("");
                      },
                      onError: (err) => setError(rootErrorMessage(err)),
                    },
                  ),
                )
              }
            >
              确认取消
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
      ) : null}

      {modal === "change" ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setModal(null)}>
          <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="变更申请">
            <div className="drawer-head">
              <div>
                <span className="section-label">CHANGE REQUEST</span>
                <h2>关键字段变更（重新审批）</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setModal(null)}>
                <X size={19} />
              </button>
            </div>
            <p className="context-note">留空字段表示不变；通过后由审批事务应用新值，事件流记录前后值。</p>
            <div className="owner-line">
              <label className="form-field">
                <span>新目的地</span>
                <input
                  value={changeFields.destination}
                  placeholder={t.destination}
                  onChange={(e) => setChangeFields((p) => ({ ...p, destination: e.target.value }))}
                />
              </label>
              <label className="form-field">
                <span>新预计费用（元）</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={changeFields.estimatedYuan}
                  placeholder={t.estimatedCostCents != null ? (t.estimatedCostCents / 100).toFixed(2) : ""}
                  onChange={(e) => setChangeFields((p) => ({ ...p, estimatedYuan: e.target.value }))}
                />
              </label>
            </div>
            <div className="owner-line">
              <label className="form-field">
                <span>新开始日期</span>
                <input
                  type="date"
                  value={changeFields.startOn}
                  onChange={(e) => setChangeFields((p) => ({ ...p, startOn: e.target.value }))}
                />
              </label>
              <label className="form-field">
                <span>新结束日期</span>
                <input
                  type="date"
                  value={changeFields.endOn}
                  onChange={(e) => setChangeFields((p) => ({ ...p, endOn: e.target.value }))}
                />
              </label>
            </div>
            <label className="form-field">
              <span>变更原因 *</span>
              <textarea rows={3} value={changeReason} onChange={(e) => setChangeReason(e.target.value)} />
            </label>
            <button
              className="primary-action full-action"
              disabled={
                (!changeFields.destination.trim() &&
                  !changeFields.startOn &&
                  !changeFields.endOn &&
                  !changeFields.estimatedYuan) ||
                !changeReason.trim() ||
                mutations.submitChange.isPending
              }
              onClick={() => {
                const changes: Record<string, unknown> = {};
                if (changeFields.destination.trim()) changes.destination = changeFields.destination.trim();
                if (changeFields.startOn) changes.startOn = changeFields.startOn;
                if (changeFields.endOn) changes.endOn = changeFields.endOn;
                if (changeFields.estimatedYuan)
                  changes.estimatedCostCents = Math.round(Number(changeFields.estimatedYuan) * 100);
                run(() =>
                  mutations.submitChange.mutate(
                    { id: t.id, changes: changes as never, reason: changeReason.trim(), idempotencyKey: newIdempotencyKey() },
                    {
                      onSuccess: () => {
                        setModal(null);
                        setChangeReason("");
                        setChangeFields({ destination: "", startOn: "", endOn: "", estimatedYuan: "" });
                      },
                      onError: (err) => setError(rootErrorMessage(err)),
                    },
                  ),
                );
              }}
            >
              提交变更审批
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
      ) : null}

      {modal === "complete" ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setModal(null)}>
          <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="完成登记">
            <div className="drawer-head">
              <div>
                <span className="section-label">COMPLETE</span>
                <h2>完成登记</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setModal(null)}>
                <X size={19} />
              </button>
            </div>
            <p className="context-note">
              完成不产生任何费用记录；系统归档申请材料至目录 10 并发出一次「返回报销」提醒（费用模块迭代 3 承接）。
            </p>
            <label className="form-field">
              <span>实际行程与结果摘要 *</span>
              <textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />
            </label>
            <label className="form-field">
              <span>实际费用说明（选填，仅备注）</span>
              <textarea rows={2} value={costNote} onChange={(e) => setCostNote(e.target.value)} />
            </label>
            <button
              className="primary-action full-action"
              disabled={!summary.trim() || mutations.transition.isPending}
              onClick={() =>
                run(() =>
                  mutations.transition.mutate(
                    {
                      id: t.id,
                      action: "complete",
                      rowVersion: t.rowVersion,
                      completionSummary: summary.trim(),
                      actualCostNote: costNote.trim() || undefined,
                    },
                    {
                      onSuccess: () => {
                        setModal(null);
                        setSummary("");
                        setCostNote("");
                      },
                      onError: (err) => setError(rootErrorMessage(err)),
                    },
                  ),
                )
              }
            >
              确认完成
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
