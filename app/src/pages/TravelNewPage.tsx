import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ArrowRight, X } from "lucide-react";
import { SEGMENT_TYPE } from "@lexflow/shared";

import { useTravelMutations } from "../api/travel";
import { ProjectSelect } from "../components/DecisionCenter";
import { newClientKey, rootErrorMessage } from "../lib/form";
import { SEGMENT_TYPE_LABEL } from "../lib/labels";

interface SegmentDraft {
  key: string;
  seq: number;
  type: (typeof SEGMENT_TYPE)[number];
  startAt: string;
  endAt: string;
  fromPlace: string;
  toPlace: string;
  description: string;
}

function emptySegment(seq: number): SegmentDraft {
  return {
    key: newClientKey(),
    seq,
    type: "transport",
    startAt: "",
    endAt: "",
    fromPlace: "",
    toPlace: "",
    description: "",
  };
}

function fromLocalInput(v: string): string {
  return new Date(v).toISOString();
}

const TABS = [
  ["basic", "基本"],
  ["segments", "行程段"],
  ["cost", "费用与借款"],
] as const;
type TabKey = (typeof TABS)[number][0];

/**
 * 新建出差申请（iter10 §5：超长表单拆 F3 多页签——基本/行程段/费用与借款，页签带校验角标）。
 * 分段行程按时间顺序填写；提交后按审批策略走引擎（借款触发会签）。
 */
export default function TravelNewPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const preProjectId = params.get("projectId") ?? "";
  const mutations = useTravelMutations();
  const [projectId, setProjectId] = useState(preProjectId);
  const [reason, setReason] = useState("");
  const [destination, setDestination] = useState("");
  const [startOn, setStartOn] = useState("");
  const [endOn, setEndOn] = useState("");
  const [estimatedYuan, setEstimatedYuan] = useState("");
  const [borrow, setBorrow] = useState(false);
  const [borrowYuan, setBorrowYuan] = useState("");
  const [segments, setSegments] = useState<SegmentDraft[]>([emptySegment(1)]);
  const [tab, setTab] = useState<TabKey>("basic");
  const [error, setError] = useState<string | null>(null);

  const updateSegment = (key: string, patch: Partial<SegmentDraft>) =>
    setSegments((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  /** 页签校验角标（v1.9：哪个页签有未过必填显示红点） */
  const basicOk = !!(projectId && reason.trim() && destination.trim() && startOn && endOn);
  const segmentsOk = segments.length > 0 && segments.every((s) => s.startAt && s.endAt);
  const costOk = !borrow || !!(borrowYuan && Number(borrowYuan) > 0);
  const tabOk: Record<TabKey, boolean> = { basic: basicOk, segments: segmentsOk, cost: costOk };
  const canSubmit = basicOk && segmentsOk && costOk;

  return (
    <div className="screen travel-new-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">NEW TRAVEL</span>
          <h1>新建出差申请</h1>
          <p>分段行程按时间顺序填写；提交后按审批策略走引擎（借款触发会签）。</p>
        </div>
        <button className="secondary-action" onClick={() => navigate(-1)}>
          <X size={15} />
          取消
        </button>
      </div>
      <div className="p9a-wizard-tabs" role="tablist" aria-label="出差表单页签">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
            {!tabOk[key] ? <i className="rep-tab-dot" aria-label={`${label}未填完`} /> : null}
          </button>
        ))}
      </div>
      <section className="create-form">
        {tab === "basic" ? (
          <>
            <div className="owner-line">
              <label className="form-field">
                <span>所属项目 *</span>
                {preProjectId ? <input value={projectId} disabled aria-label="所属项目" /> : <ProjectSelect value={projectId} onChange={setProjectId} />}
              </label>
              <label className="form-field">
                <span>目的地 *</span>
                <input value={destination} onChange={(e) => setDestination(e.target.value)} />
              </label>
            </div>
            <label className="form-field">
              <span>出差事由 *</span>
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="owner-line">
              <label className="form-field">
                <span>开始日期 *</span>
                <input type="date" value={startOn} onChange={(e) => setStartOn(e.target.value)} />
              </label>
              <label className="form-field">
                <span>结束日期 *</span>
                <input type="date" value={endOn} onChange={(e) => setEndOn(e.target.value)} />
              </label>
            </div>
            <div className="row-ops">
              <button className="primary-action" onClick={() => setTab("segments")}>
                下一步：行程段
                <ArrowRight size={15} />
              </button>
            </div>
          </>
        ) : null}

        {tab === "segments" ? (
          <>
            <div className="form-field">
              <span>分段行程 *（按时间顺序；段内与段间不得时间倒挂，由服务端校验）</span>
              {segments.map((s, idx) => (
                <div className="segment-row" key={s.key}>
                  <span className="segment-seq">#{idx + 1}</span>
                  <select
                    value={s.type}
                    aria-label="行程类型"
                    onChange={(e) => updateSegment(s.key, { type: e.target.value as never })}
                  >
                    {SEGMENT_TYPE.map((t) => (
                      <option key={t} value={t}>
                        {SEGMENT_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                  <input
                    value={s.fromPlace}
                    placeholder="出发地"
                    aria-label="出发地"
                    onChange={(e) => updateSegment(s.key, { fromPlace: e.target.value })}
                  />
                  <input
                    value={s.toPlace}
                    placeholder="目的地"
                    aria-label="行程目的地"
                    onChange={(e) => updateSegment(s.key, { toPlace: e.target.value })}
                  />
                  <input
                    type="datetime-local"
                    value={s.startAt}
                    aria-label="段开始时间"
                    onChange={(e) => updateSegment(s.key, { startAt: e.target.value })}
                  />
                  <input
                    type="datetime-local"
                    value={s.endAt}
                    aria-label="段结束时间"
                    onChange={(e) => updateSegment(s.key, { endAt: e.target.value })}
                  />
                  <input
                    value={s.description}
                    placeholder="说明（选填）"
                    aria-label="行程说明"
                    onChange={(e) => updateSegment(s.key, { description: e.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="删除行程段"
                    onClick={() =>
                      setSegments((prev) =>
                        prev
                          .filter((x) => x.key !== s.key)
                          .map((x, i) => ({ ...x, seq: i + 1 })),
                      )
                    }
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="secondary-action"
                onClick={() => setSegments((prev) => [...prev, emptySegment(prev.length + 1)])}
              >
                添加行程段
              </button>
            </div>
            <div className="row-ops">
              <button className="secondary-action" onClick={() => setTab("basic")}>上一步：基本</button>
              <button className="primary-action" onClick={() => setTab("cost")}>
                下一步：费用与借款
                <ArrowRight size={15} />
              </button>
            </div>
          </>
        ) : null}

        {tab === "cost" ? (
          <>
            <div className="owner-line">
              <label className="form-field">
                <span>预计费用（元，仅提示）</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={estimatedYuan}
                  onChange={(e) => setEstimatedYuan(e.target.value)}
                />
              </label>
              <label className="check-field compact" style={{ alignSelf: "end" }}>
                <input type="checkbox" checked={borrow} onChange={(e) => setBorrow(e.target.checked)} />
                借款出差
              </label>
            </div>
            {borrow ? (
              <label className="form-field">
                <span>借款金额（元）*</span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={borrowYuan}
                  onChange={(e) => setBorrowYuan(e.target.value)}
                />
              </label>
            ) : null}
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="row-ops">
              <button className="secondary-action" onClick={() => setTab("segments")}>上一步：行程段</button>
              <button
                className="primary-action"
                disabled={!canSubmit || mutations.create.isPending}
                onClick={() => {
                  setError(null);
                  const estimatedCostCents =
                    estimatedYuan && Number(estimatedYuan) > 0 ? Math.round(Number(estimatedYuan) * 100) : null;
                  const borrowAmountCents =
                    borrow && borrowYuan && Number(borrowYuan) > 0 ? Math.round(Number(borrowYuan) * 100) : null;
                  if (borrow && !borrowAmountCents) {
                    setError("借款出差须填写借款金额。");
                    return;
                  }
                  mutations.create.mutate(
                    {
                      projectId,
                      reason: reason.trim(),
                      destination: destination.trim(),
                      startOn,
                      endOn,
                      estimatedCostCents,
                      borrow,
                      borrowAmountCents,
                      segments: segments.map((s, i) => ({
                        seq: i + 1,
                        type: s.type,
                        startAt: fromLocalInput(s.startAt),
                        endAt: fromLocalInput(s.endAt),
                        fromPlace: s.fromPlace.trim() || undefined,
                        toPlace: s.toPlace.trim() || undefined,
                        description: s.description.trim() || undefined,
                      })),
                    },
                    {
                      onSuccess: (r) => navigate(`/travel/${r.id}`),
                      onError: (err) => setError(rootErrorMessage(err)),
                    },
                  );
                }}
              >
                {mutations.create.isPending ? "创建中…" : "创建出差申请"}
                <ArrowRight size={16} />
              </button>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
