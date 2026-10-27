import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ArrowRight, X } from "lucide-react";

import { useFundingMutations } from "../api/finance-budget";
import { useMeetingList } from "../api/meeting";
import { useTravelList } from "../api/travel";
import { parseYuanToCents } from "../api/reference";
import { ProjectSelect } from "../components/DecisionCenter";
import { rootErrorMessage } from "../lib/form";

/** 经费申请表单：金额元→分、用途必填、关联会议/出差可选（arch/06 §7） */
export default function FundingNewPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const preProjectId = params.get("projectId") ?? "";
  const mutations = useFundingMutations();
  const [projectId, setProjectId] = useState(preProjectId);
  const [purpose, setPurpose] = useState("");
  const [amountYuan, setAmountYuan] = useState("");
  const [expectedUseDate, setExpectedUseDate] = useState("");
  const [recipientInfo, setRecipientInfo] = useState("");
  const [sourceMeetingId, setSourceMeetingId] = useState("");
  const [sourceTravelId, setSourceTravelId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const meetings = useMeetingList({ projectId });
  const travels = useTravelList({ projectId });

  return (
    <div className="screen funding-new-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">NEW FUNDING</span>
          <h1>经费申请</h1>
          <p>获批后写入一次预算占用；≥5 万元自动升级管理层两步审批。</p>
        </div>
        <button className="secondary-action" onClick={() => navigate(-1)}>
          <X size={15} />
          取消
        </button>
      </div>
      <section className="create-form">
        <div className="owner-line">
          <label className="form-field">
            <span>所属项目 *</span>
            {preProjectId ? <input value={projectId} disabled aria-label="所属项目" /> : <ProjectSelect value={projectId} onChange={setProjectId} />}
          </label>
          <label className="form-field">
            <span>申请金额（元）*</span>
            <input type="number" min="0.01" step="0.01" value={amountYuan} onChange={(e) => setAmountYuan(e.target.value)} />
          </label>
          <label className="form-field">
            <span>预计使用日期</span>
            <input type="date" value={expectedUseDate} onChange={(e) => setExpectedUseDate(e.target.value)} />
          </label>
        </div>
        <label className="form-field">
          <span>用途 *</span>
          <textarea rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </label>
        <label className="form-field">
          <span>收款/借款说明</span>
          <input value={recipientInfo} onChange={(e) => setRecipientInfo(e.target.value)} />
        </label>
        <div className="owner-line">
          <label className="form-field">
            <span>关联会议（选填）</span>
            <select value={sourceMeetingId} aria-label="关联会议" onChange={(e) => setSourceMeetingId(e.target.value)}>
              <option value="">不关联</option>
              {(meetings.data?.items ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code} · {m.subject}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>关联出差（选填）</span>
            <select value={sourceTravelId} aria-label="关联出差" onChange={(e) => setSourceTravelId(e.target.value)}>
              <option value="">不关联</option>
              {(travels.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} · {t.destination}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="primary-action"
          disabled={!projectId || !purpose.trim() || !amountYuan || mutations.create.isPending}
          onClick={() => {
            const amountCents = parseYuanToCents(amountYuan);
            if (!amountCents) return;
            setError(null);
            mutations.create.mutate(
              {
                projectId,
                purpose: purpose.trim(),
                amountCents,
                expectedUseDate: expectedUseDate || undefined,
                recipientInfo: recipientInfo.trim() || undefined,
                sourceMeetingId: sourceMeetingId || undefined,
                sourceTravelId: sourceTravelId || undefined,
              },
              {
                onSuccess: (r) => navigate(`/operations/funding/${r.id}`),
                onError: (err) => setError(rootErrorMessage(err)),
              },
            );
          }}
        >
          {mutations.create.isPending ? "创建中…" : "创建并查看"}
          <ArrowRight size={16} />
        </button>
      </section>
    </div>
  );
}
