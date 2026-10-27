import { Link } from "react-router";
import { CalendarDays, ChevronRight } from "lucide-react";

import { useMeetingList } from "../../api/meeting";
import { formatDateTime } from "../../lib/trpc";
import { MEETING_STATUS_LABEL, MEETING_TYPE_LABEL, MINUTES_STATUS_LABEL } from "../../lib/labels";
import { useSpaceParams } from "./space-context";

/** 项目空间·会议页签（迭代 2 接入真实数据） */
export default function MeetingsTab() {
  const { projectId } = useSpaceParams();
  const meetings = useMeetingList({ projectId });

  if (meetings.isPending) return <p className="list-note">正在加载会议…</p>;
  if (meetings.isError) throw meetings.error;

  return (
    <div className="space-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">项目内全部会议；详情含议程—结论—行动项—档案连续关系</span>
        <Link to={`/meetings/new?projectId=${projectId}`} className="primary-action">
          创建会议
        </Link>
        <Link to={`/meetings?projectId=${projectId}`} className="secondary-action">
          会议中心
          <ChevronRight size={14} />
        </Link>
      </div>
      <div className="report-list">
        {meetings.data.items.length === 0 ? (
          <div className="empty-state">
            <CalendarDays size={24} />
            <strong>暂无会议</strong>
            <p>点击「创建会议」发起第一场项目会议。</p>
          </div>
        ) : (
          meetings.data.items.map((m) => (
            <Link className="report-row meeting-row" key={m.id} to={`/meetings/${m.id}`}>
              <div>
                <strong>{m.subject}</strong>
                <small>
                  {m.code} · {MEETING_TYPE_LABEL[m.type]} · {formatDateTime(m.startAt)}
                </small>
              </div>
              <span className="row-side">
                {m.minutesStatus !== "none_required" ? (
                  <span className={`badge badge-minutes-${m.minutesStatus}`}>{MINUTES_STATUS_LABEL[m.minutesStatus]}</span>
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
