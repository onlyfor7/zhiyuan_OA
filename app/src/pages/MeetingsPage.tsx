import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CalendarDays, ChevronRight, Plus } from "lucide-react";

import { useMeetingList } from "../api/meeting";
import { useRail } from "../components/shell-rail";
import { formatDateTime } from "../lib/trpc";
import { ListSkeleton } from "../components/feedback";
import "../lib/trpc";
import { MEETING_STATUS_LABEL, MEETING_TYPE_LABEL, MINUTES_STATUS_LABEL } from "../lib/labels";
import type { RouterOutputs } from "../lib/trpc";

type MeetingItem = RouterOutputs["meeting"]["list"]["items"][number];

function MeetingsRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">MEETINGS</span>
        <h2>会议中心</h2>
      </div>
      <div className="context-section">
        <div className="section-label">CONTINUITY</div>
        <h2>议程 — 结论 — 行动项 — 档案</h2>
        <p className="context-note">
          会议详情按连续关系组织；确认版纪要与材料自动归集项目档案目录 09；行动项可一键转为项目任务。
        </p>
      </div>
      <div className="assurance">
        <CalendarDays size={16} />
        <span>工时预填仅为建议（只算不存），不计入任何统计。</span>
      </div>
    </aside>
  );
}

/** 会议中心：我的日程/全部 + 状态筛选（arch/05 §5） */
export default function MeetingsPage() {
  useRail(MeetingsRail);
  const [params] = useSearchParams();
  const projectId = params.get("projectId") ?? undefined;
  const [mine, setMine] = useState(true);
  const [status, setStatus] = useState("");
  const list = useMeetingList(projectId ? { projectId } : mine ? { mine: true } : {});
  const filtered = list.data?.items.filter((m) => !status || m.status === status);

  if (list.isPending) return <ListSkeleton rows={5} />;
  if (list.isError) throw list.error;

  return (
    <div className="screen meetings-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">MEETING CENTER</span>
          <h1>会议中心</h1>
          <p>{projectId ? "项目内全部会议" : "我参与或我组织的会议"}；列表按项目权限过滤。</p>
        </div>
        <Link to={`/meetings/new${projectId ? `?projectId=${projectId}` : ""}`} className="primary-action">
          <Plus size={15} />
          创建会议
        </Link>
      </div>
      <div className="quality-toolbar">
        <div className="audit-tabs inline-tabs">
          <button className={mine && !projectId ? "active" : ""} onClick={() => setMine(true)}>
            我的日程
          </button>
          <button className={!mine || projectId ? "active" : ""} onClick={() => setMine(false)}>
            全部
          </button>
        </div>
        <select value={status} aria-label="会议状态" onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="planned">已计划</option>
          <option value="completed">已完成</option>
          <option value="cancelled">已取消</option>
        </select>
        <span>{filtered?.length ?? 0} 场会议</span>
      </div>
      <div className="report-list">
        {filtered?.length === 0 ? (
          <div className="empty-state">
            <CalendarDays size={24} />
            <strong>没有匹配的会议</strong>
            <p>调整筛选，或创建一场新会议。</p>
          </div>
        ) : (
          filtered?.map((m: MeetingItem) => (
            <Link className={`report-row meeting-row status-${m.status}`} key={m.id} to={`/meetings/${m.id}`}>
              <div>
                <strong>
                  {m.subject}
                  <span className="badge badge-health-warning">{MEETING_TYPE_LABEL[m.type]}</span>
                  {m.status === "cancelled" ? <em className="mark-overdue">已取消</em> : null}
                </strong>
                <small>
                  {m.code} · {formatDateTime(m.startAt)} ~ {formatDateTime(m.endAt).slice(11)}
                  {m.location ? ` · ${m.location}` : ""} · 组织者 {m.organizerName}
                </small>
              </div>
              <span className="row-side">
                {m.minutesStatus !== "none_required" ? (
                  <span className={`badge badge-minutes-${m.minutesStatus}`}>
                    {MINUTES_STATUS_LABEL[m.minutesStatus]}
                  </span>
                ) : null}
                <span className="text-action">
                  {MEETING_STATUS_LABEL[m.status]}
                  <ChevronRight size={14} />
                </span>
              </span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
