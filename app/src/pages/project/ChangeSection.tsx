import { useMemo, useState } from "react";
import { ArrowRight, ChevronRight, Plus, RotateCcw, X } from "lucide-react";

import { useChange, useChangeList, useChangeMutations } from "../../api/change";
import { useProjectMembers } from "../../api/project";
import type { PlanAdjustment } from "../../api/plan";
import { ApprovalSteps } from "../../components/ApprovalSteps";
import { newIdempotencyKey, rootErrorMessage } from "../../lib/form";
import { CHANGE_LEVEL_LABEL, CHANGE_STATUS_LABEL, PLAN_ITEM_TYPE_LABEL } from "../../lib/labels";
import type { RouterOutputs } from "../../lib/trpc";
import { useSpaceParams } from "./space-context";

type ChangeRow = RouterOutputs["change"]["list"]["items"][number];
type PlanItem = RouterOutputs["plan"]["current"]["items"][number];

interface TargetItemForm {
  refId: string;
  newStart: string;
  newEnd: string;
}

interface MeasureForm {
  measure: string;
  ownerId: string;
  checkpointDate: string;
}

/** 延期申请·创建表单（原/新日期自动取自当前计划；原因/影响/恢复措施/检查点必填，arch/04 §2.4） */
export function ChangeCreateForm({
  projectId,
  planItems,
  initial,
  onDone,
}: {
  projectId: string;
  planItems: PlanItem[];
  initial?: PlanAdjustment[];
  onDone: () => void;
}) {
  const members = useProjectMembers(projectId);
  const mutations = useChangeMutations();
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState<"normal" | "key">("normal");
  const [reason, setReason] = useState("");
  const [impact, setImpact] = useState("");
  const [targets, setTargets] = useState<TargetItemForm[]>(() => {
    if (!initial || initial.length === 0) return [];
    const itemByAdj = new Map(planItems.map((i) => [i.id, i]));
    return initial.map((a) => ({
      refId: itemByAdj.has(a.ref_id) ? a.ref_id : planItems.find((i) => i.refId === a.ref_id)?.id ?? "",
      newStart: a.new_start,
      newEnd: a.new_end,
    }));
  });
  const [measures, setMeasures] = useState<MeasureForm[]>([]);
  const [error, setError] = useState<string | null>(null);

  const itemById = useMemo(() => new Map(planItems.map((i) => [i.id, i])), [planItems]);

  const canSubmit =
    title.trim().length > 0 &&
    reason.trim().length > 0 &&
    impact.trim().length > 0 &&
    targets.length > 0 &&
    targets.every((t) => t.refId && t.newStart && t.newEnd) &&
    measures.length > 0 &&
    measures.every((m) => m.measure.trim() && m.ownerId && m.checkpointDate);

  const submit = () => {
    setError(null);
    mutations.create.mutate(
      {
        projectId,
        title: title.trim(),
        level,
        reason: reason.trim(),
        impact: impact.trim(),
        targetItems: targets.map((t) => {
          const item = itemById.get(t.refId)!;
          return {
            ref_id: item.refId,
            item_type: item.itemType,
            new_start: t.newStart,
            new_end: t.newEnd,
          };
        }),
        recoveryMeasures: measures.map((m) => ({
          measure: m.measure.trim(),
          owner_id: m.ownerId,
          checkpoint_date: m.checkpointDate,
        })),
      },
      {
        onSuccess: onDone,
        onError: (err) => setError(rootErrorMessage(err)),
      },
    );
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <section className="delay-drawer" role="dialog" aria-modal="true" aria-label="发起延期申请">
        <div className="drawer-head">
          <div>
            <span className="section-label">CHANGE REQUEST</span>
            <h2>发起书面延期申请</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onDone}>
            <X size={19} />
          </button>
        </div>
        <label className="form-field">
          <span>标题 *</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说明延期事项" />
        </label>
        <label className="form-field">
          <span>延期级别 *</span>
          <select value={level} onChange={(e) => setLevel(e.target.value as "normal" | "key")}>
            <option value="normal">一般延期（项目负责人审批）</option>
            <option value="key">重大延期（管理层审批）</option>
          </select>
        </label>
        <div className="form-field">
          <span>目标计划项与原日期（自动取自当前计划）*</span>
          {targets.map((t, idx) => {
            const item = itemById.get(t.refId);
            return (
              <div className="target-row" key={idx}>
                <select
                  value={t.refId}
                  aria-label="目标计划项"
                  onChange={(e) => {
                    const next = itemById.get(e.target.value);
                    setTargets((prev) =>
                      prev.map((x, i) =>
                        i === idx
                          ? { refId: e.target.value, newStart: next?.plannedStart ?? "", newEnd: next?.plannedEnd ?? "" }
                          : x,
                      ),
                    );
                  }}
                >
                  <option value="">选择计划项</option>
                  {planItems.map((i) => (
                    <option key={i.id} value={i.id}>
                      {PLAN_ITEM_TYPE_LABEL[i.itemType]} #{i.seq}（原 {i.plannedStart} ~ {i.plannedEnd}）
                    </option>
                  ))}
                </select>
                <input type="date" value={t.newStart} aria-label="新开始日期" onChange={(e) => setTargets((prev) => prev.map((x, i) => (i === idx ? { ...x, newStart: e.target.value } : x)))} />
                <input type="date" value={t.newEnd} aria-label="新完成日期" onChange={(e) => setTargets((prev) => prev.map((x, i) => (i === idx ? { ...x, newEnd: e.target.value } : x)))} />
                <button className="icon-button" aria-label="删除目标项" onClick={() => setTargets((prev) => prev.filter((_, i) => i !== idx))}>
                  <X size={15} />
                </button>
                {item ? <em className="target-origin">原 {item.plannedStart} ~ {item.plannedEnd}</em> : null}
              </div>
            );
          })}
          <button className="secondary-action" onClick={() => setTargets((prev) => [...prev, { refId: "", newStart: "", newEnd: "" }])}>
            添加目标项
          </button>
        </div>
        <label className="form-field">
          <span>延期原因与书面说明 *</span>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label className="form-field">
          <span>影响评估 *</span>
          <textarea rows={3} value={impact} onChange={(e) => setImpact(e.target.value)} />
        </label>
        <div className="form-field">
          <span>恢复措施与检查点 *</span>
          {measures.map((m, idx) => (
            <div className="measure-row" key={idx}>
              <input value={m.measure} placeholder="措施内容" aria-label="恢复措施" onChange={(e) => setMeasures((prev) => prev.map((x, i) => (i === idx ? { ...x, measure: e.target.value } : x)))} />
              <select value={m.ownerId} aria-label="责任人" onChange={(e) => setMeasures((prev) => prev.map((x, i) => (i === idx ? { ...x, ownerId: e.target.value } : x)))}>
                <option value="">责任人</option>
                {(members.data ?? []).map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name}
                  </option>
                ))}
              </select>
              <input type="date" value={m.checkpointDate} aria-label="检查点日期" onChange={(e) => setMeasures((prev) => prev.map((x, i) => (i === idx ? { ...x, checkpointDate: e.target.value } : x)))} />
              <button className="icon-button" aria-label="删除措施" onClick={() => setMeasures((prev) => prev.filter((_, i) => i !== idx))}>
                <X size={15} />
              </button>
            </div>
          ))}
          <button className="secondary-action" onClick={() => setMeasures((prev) => [...prev, { measure: "", ownerId: "", checkpointDate: "" }])}>
            添加恢复措施
          </button>
        </div>
        <div className="drawer-note">提交为草稿；确认无误后在列表中提交审批，通过后自动生成新版本计划并同步调整项。</div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="drawer-actions">
          <button className="secondary-action" onClick={onDone}>
            取消
          </button>
          <button className="primary-action" disabled={!canSubmit || mutations.create.isPending} onClick={submit}>
            {mutations.create.isPending ? "创建中…" : "创建延期申请"}
            <ArrowRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}

function ChangeDetailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const change = useChange(id);
  const mutations = useChangeMutations();
  const [idemKey] = useState(newIdempotencyKey);
  const [error, setError] = useState<string | null>(null);

  if (change.isPending) return <p className="list-note">正在加载…</p>;
  if (change.isError) throw change.error;
  const c = change.data;

  const targets = (c.targetItems ?? []) as {
    ref_id: string;
    item_type: string;
    new_start: string;
    new_end: string;
    original_start?: string;
    original_end?: string;
  }[];
  const measures = (c.recoveryMeasures ?? []) as {
    measure: string;
    owner_id: string;
    checkpoint_date: string;
  }[];

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="delay-drawer" role="dialog" aria-modal="true" aria-label="延期申请详情">
        <div className="drawer-head">
          <div>
            <span className="section-label">
              {c.code} · {CHANGE_LEVEL_LABEL[c.level]} · {CHANGE_STATUS_LABEL[c.status]}
            </span>
            <h2>{c.title}</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <div className="issue-meta-grid">
          <div>
            <span>提交时间</span>
            <strong>{c.submittedAt ? c.submittedAt.slice(0, 16).replace("T", " ") : "—"}</strong>
          </div>
          <div>
            <span>决定时间</span>
            <strong>{c.decidedAt ? c.decidedAt.slice(0, 16).replace("T", " ") : "—"}</strong>
          </div>
        </div>
        <div className="issue-section">
          <span>目标计划项</span>
          {targets.map((t, i) => (
            <p key={i}>
              {PLAN_ITEM_TYPE_LABEL[t.item_type as never] ?? t.item_type}：{t.original_start ?? "?"} ~ {t.original_end ?? "?"}{" "}
              → {t.new_start} ~ {t.new_end}
            </p>
          ))}
        </div>
        <div className="issue-section">
          <span>延期原因</span>
          <p>{c.reason}</p>
        </div>
        <div className="issue-section">
          <span>影响评估</span>
          <p>{c.impact}</p>
        </div>
        <div className="issue-section">
          <span>恢复措施</span>
          {measures.map((m, i) => (
            <p key={i}>
              {m.measure} · 责任人 {m.owner_id.slice(0, 8)} · 检查点 {m.checkpoint_date}
            </p>
          ))}
        </div>
        {c.approvalInstanceId ? <ApprovalSteps instanceId={c.approvalInstanceId} /> : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="drawer-actions">
          {c.status === "draft" ? (
            <>
              <button
                className="secondary-action"
                disabled={mutations.withdraw.isPending}
                onClick={() => {
                  setError(null);
                  mutations.withdraw.mutate(
                    { id: c.id, rowVersion: c.rowVersion },
                    { onError: (err) => setError(rootErrorMessage(err)) },
                  );
                }}
              >
                <RotateCcw size={15} />
                撤回草稿
              </button>
              <button
                className="primary-action"
                disabled={mutations.submit.isPending}
                onClick={() => {
                  setError(null);
                  mutations.submit.mutate(
                    { id: c.id, rowVersion: c.rowVersion, idempotencyKey: idemKey },
                    { onError: (err) => setError(rootErrorMessage(err)) },
                  );
                }}
              >
                {mutations.submit.isPending ? "提交中…" : "提交审批"}
                <ArrowRight size={16} />
              </button>
            </>
          ) : null}
          {c.status === "pending_approval" ? (
            <button
              className="secondary-action"
              disabled={mutations.withdraw.isPending}
              onClick={() => {
                setError(null);
                mutations.withdraw.mutate(
                  { id: c.id, rowVersion: c.rowVersion },
                  { onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}
            >
              <RotateCcw size={15} />
              撤回申请
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** 延期申请区：列表 + 创建入口 + 详情抽屉 */
export function ChangeSection({
  planItems,
  prefill,
  onPrefillConsumed,
}: {
  planItems: PlanItem[];
  prefill: PlanAdjustment[] | null;
  onPrefillConsumed: () => void;
}) {
  const { projectId } = useSpaceParams();
  const changes = useChangeList({ projectId });
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  if (changes.isPending) return <p className="list-note">正在加载延期申请…</p>;
  if (changes.isError) throw changes.error;

  const closeCreate = () => {
    setCreateOpen(false);
    onPrefillConsumed();
  };

  return (
    <section className="change-section">
      <div className="section-heading">
        <div>
          <span className="section-label">CHANGE LOG</span>
          <h2>延期申请（{changes.data.items.length}）</h2>
        </div>
        <button className="secondary-action" onClick={() => setCreateOpen(true)}>
          <Plus size={15} />
          发起延期申请
        </button>
      </div>
      {changes.data.items.length === 0 ? (
        <p className="list-note">暂无延期申请；计划调整必须先提交书面延期并通过审批。</p>
      ) : (
        changes.data.items.map((c: ChangeRow) => (
          <button className="change-entry as-button" key={c.id} onClick={() => setDetailId(c.id)}>
            <span>{CHANGE_LEVEL_LABEL[c.level]}</span>
            <div>
              <strong>{c.title}</strong>
              <small>
                {c.code} · {CHANGE_STATUS_LABEL[c.status]}
                {c.resultingPlanVersionId ? " · 已生成新版本" : ""}
              </small>
            </div>
            <time>{(c.submittedAt ?? c.createdAt).slice(0, 10)}</time>
            <ChevronRight size={15} />
          </button>
        ))
      )}
      {createOpen || (prefill && prefill.length > 0) ? (
        <ChangeCreateForm projectId={projectId} planItems={planItems} initial={prefill ?? undefined} onDone={closeCreate} />
      ) : null}
      {detailId ? <ChangeDetailDrawer id={detailId} onClose={() => setDetailId(null)} /> : null}
    </section>
  );
}
