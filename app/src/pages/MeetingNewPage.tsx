import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ArrowRight, X } from "lucide-react";
import { MEETING_TYPE } from "@lexflow/shared";

import { useMeetingMutations } from "../api/meeting";
import { ProjectSelect } from "../components/DecisionCenter";
import { ParticipantsEditor } from "../components/ParticipantsEditor";
import {
  emptyParticipant,
  toParticipantInput,
  type ParticipantDraft,
} from "../components/participant-utils";
import { UserPicker } from "../components/UserPicker";
import { rootErrorMessage } from "../lib/form";
import { MEETING_TYPE_LABEL } from "../lib/labels";

const AGENDA_HINTS: Record<string, string> = {
  project: "1. 议题与目标\n2. 逐项讨论\n3. 结论与行动项",
  weekly: "1. 本周进展\n2. 风险与阻塞\n3. 下周计划",
  quality_review: "1. 问题清单复核\n2. 复核结论与遗留项",
  decision: "1. 备选方案比较\n2. 决定与条件",
  client: "1. 客户需求同步\n2. 后续安排与责任分工",
};

function fromLocalInput(v: string): string {
  return new Date(v).toISOString();
}

/** 会议创建页（类型驱动默认议程提示；内外部参与人；end>start 服务端校验映射） */
export default function MeetingNewPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const preProjectId = params.get("projectId") ?? "";
  const mutations = useMeetingMutations();
  const [projectId, setProjectId] = useState(preProjectId);
  const [type, setType] = useState<(typeof MEETING_TYPE)[number]>("project");
  const [subject, setSubject] = useState("");
  const [agenda, setAgenda] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [location, setLocation] = useState("");
  const [onlineUrl, setOnlineUrl] = useState("");
  const [recorderId, setRecorderId] = useState("");
  const [minutesRequired, setMinutesRequired] = useState(true);
  const [participants, setParticipants] = useState<ParticipantDraft[]>([emptyParticipant()]);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = projectId && subject.trim() && startAt && endAt;

  return (
    <div className="screen meeting-new-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">NEW MEETING</span>
          <h1>创建会议</h1>
          <p>参会人 ≠ 项目成员不自动获得项目权限；外部参与人仅记录必要信息。</p>
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
            <span>会议类型 *</span>
            <select value={type} onChange={(e) => setType(e.target.value as never)}>
              {MEETING_TYPE.map((t) => (
                <option key={t} value={t}>
                  {MEETING_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>记录人</span>
            <UserPicker value={recorderId} onChange={setRecorderId} placeholder="默认为创建人" />
          </label>
        </div>
        <label className="form-field">
          <span>主题 *</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label className="form-field">
          <span>议程（类型已给出默认提示，可修改）</span>
          <textarea
            rows={5}
            value={agenda}
            placeholder={AGENDA_HINTS[type]}
            onChange={(e) => setAgenda(e.target.value)}
          />
        </label>
        <div className="owner-line">
          <label className="form-field">
            <span>开始时间 *</span>
            <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </label>
          <label className="form-field">
            <span>结束时间 *（须晚于开始）</span>
            <input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
          </label>
        </div>
        <div className="owner-line">
          <label className="form-field">
            <span>地点</span>
            <input value={location} onChange={(e) => setLocation(e.target.value)} />
          </label>
          <label className="form-field">
            <span>线上链接</span>
            <input value={onlineUrl} onChange={(e) => setOnlineUrl(e.target.value)} />
          </label>
          <label className="check-field compact" style={{ alignSelf: "end" }}>
            <input type="checkbox" checked={minutesRequired} onChange={(e) => setMinutesRequired(e.target.checked)} />
            需要会议纪要
          </label>
        </div>
        <div className="form-field">
          <span>参与人 *（至少一名）</span>
          <ParticipantsEditor value={participants} onChange={setParticipants} />
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="primary-action"
          disabled={!canSubmit || mutations.create.isPending}
          onClick={() => {
            setError(null);
            mutations.create.mutate(
              {
                projectId,
                type,
                subject: subject.trim(),
                agenda: agenda.trim() || undefined,
                startAt: fromLocalInput(startAt),
                endAt: fromLocalInput(endAt),
                location: location.trim() || undefined,
                onlineUrl: onlineUrl.trim() || undefined,
                recorderId: recorderId || undefined,
                minutesRequired,
                participants: toParticipantInput(participants),
              },
              {
                onSuccess: (r) => navigate(`/meetings/${r.id}`),
                onError: (err) => setError(rootErrorMessage(err)),
              },
            );
          }}
        >
          {mutations.create.isPending ? "创建中…" : "创建会议"}
          <ArrowRight size={16} />
        </button>
      </section>
    </div>
  );
}

