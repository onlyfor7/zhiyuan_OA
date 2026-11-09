import { useState } from "react";
import { Link } from "react-router";
import { ChevronRight, Timer } from "lucide-react";

import {
  useTimeStatsByActivity,
  useTimeStatsByTask,
  useTimeStatsByUser,
} from "../../api/time";
import { useUserNameMap } from "../../api/reference";
import { formatHours, TIME_ACTIVITY_LABEL } from "../../lib/labels";
import { useSpaceParams } from "./space-context";
import { useTaskList } from "../../api/task";

/** 项目空间·工时页签：项目维度统计（成员按可见范围；有效=approved+locked 口径标注） */
export default function TimesheetTab() {
  const { projectId } = useSpaceParams();
  const userNames = useUserNameMap();
  const tasks = useTaskList({ projectId });
  const taskNames = new Map((tasks.data?.items ?? []).map((t) => [t.id, t.title]));
  const [statuses, setStatuses] = useState<string[]>([]);
  const input = { projectId, statuses: statuses.length ? statuses : undefined };
  const byUser = useTimeStatsByUser(input);
  const byTask = useTimeStatsByTask(input);
  const byActivity = useTimeStatsByActivity(input);

  if (byUser.isPending || byTask.isPending || byActivity.isPending)
    return <p className="list-note">正在加载工时统计…</p>;
  if (byUser.isError) throw byUser.error;
  if (byTask.isError) throw byTask.error;
  if (byActivity.isError) throw byActivity.error;

  const scope = byUser.data.statusScope;

  return (
    <div className="space-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">{scope}</span>
        <Link to="/operations/time" className="secondary-action">
          我的填报
          <ChevronRight size={14} />
        </Link>
      </div>
      <div className="audit-tabs inline-tabs">
        {[
          ["", "有效工时"],
          ["draft", "含草稿"],
          ["pending_approval", "含待审批"],
          ["returned", "含已退回"],
        ].map(([v, label]) => (
          <button
            key={v}
            className={statuses.join(",") === v ? "active" : ""}
            onClick={() => setStatuses(v ? [v] : [])}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="overview-panels">
        <section>
          <span className="section-label">BY USER</span>
          <h2>按人员</h2>
          {byUser.data.items.length === 0 ? (
            <p className="list-note">暂无工时明细。</p>
          ) : (
            byUser.data.items.map((i) => (
              <div className="cause-row" key={i.key ?? "none"}>
                <span>{i.name ?? (i.key ? (userNames.get(i.key) ?? "—") : "非项目工作")}</span>
                <div>
                  <i style={{ width: "60%" }} />
                </div>
                <strong>
                  {formatHours(i.minutes)} × {i.entryCount}
                </strong>
              </div>
            ))
          )}
        </section>
        <section>
          <span className="section-label">BY ACTIVITY</span>
          <h2>按活动类型</h2>
          {byActivity.data.items.map((i) => (
            <div className="cause-row" key={i.key ?? "none"}>
              <span>{TIME_ACTIVITY_LABEL[i.key ?? ""] ?? i.key ?? "—"}</span>
              <div>
                <i style={{ width: "60%" }} />
              </div>
              <strong>
                {formatHours(i.minutes)} × {i.entryCount}
              </strong>
            </div>
          ))}
        </section>
      </div>
      <section style={{ marginTop: 20 }}>
        <span className="section-label">BY TASK</span>
        <h2>按任务</h2>
        {byTask.data.items.length === 0 ? (
          <p className="list-note">暂无任务关联工时。</p>
        ) : (
          byTask.data.items.map((i) => (
            <div className="cause-row" key={i.key ?? "none"}>
              <span>{i.key ? (taskNames.get(i.key) ?? "任务") : "非任务"}</span>
              <div>
                <i style={{ width: "60%" }} />
              </div>
              <strong>
                {formatHours(i.minutes)} × {i.entryCount}
              </strong>
            </div>
          ))
        )}
        <p className="context-note">
          asOf {byUser.data.asOf.slice(0, 16).replace("T", " ")}；同名指标与工时中心/驾驶舱/周报同数。
          <Timer size={12} style={{ verticalAlign: "-2px", marginLeft: 4 }} />
        </p>
      </section>
    </div>
  );
}
