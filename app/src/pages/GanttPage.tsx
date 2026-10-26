import { Link, useParams } from "react-router";
import { Archive, ChevronRight } from "lucide-react";

import { useProject } from "../api/project";
import { useRail } from "../components/shell-rail";
import { NotConnected } from "../components/NotConnected";

function PlanRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">PLAN INSIGHT</span>
        <h2>计划洞察</h2>
      </div>
      <NotConnected hint="计划稳定度与依赖链分析将在迭代 1 接入" />
      <div className="context-section">
        <div className="section-label">EXCEPTION</div>
        <h2>例外说明</h2>
        <p className="context-note">任何关键节点改期均需书面原因与恢复方案。原始基线不会被覆盖。</p>
      </div>
      <div className="assurance">
        <Archive size={17} />
        <span>变更、审批与解决方案将自动归入项目档案。</span>
      </div>
    </aside>
  );
}

export default function GanttPage() {
  const { projectId } = useParams();
  const project = useProject(projectId ?? "");
  useRail(PlanRail);

  if (!projectId) {
    throw new Error("缺少项目 ID");
  }
  if (project.isPending) {
    return (
      <div className="screen">
        <p className="list-note">正在加载项目…</p>
      </div>
    );
  }
  if (project.isError) {
    throw project.error;
  }

  const p = project.data;
  return (
    <div className="screen gantt-screen">
      <div className="project-title-row gantt-title">
        <div>
          <div className="breadcrumb">
            <span>{p.name}</span>
            <ChevronRight size={13} />
            <span>计划</span>
          </div>
          <h1>让每一次变化，都有迹可循。</h1>
          <p>
            {p.code} · 计划基线、关键路径与延期闭环将在迭代 1 接入真实计划数据。
          </p>
        </div>
        <div className="title-actions">
          <Link to={`/projects/${p.id}`} className="secondary-action">
            返回项目
          </Link>
        </div>
      </div>
      <div className="stat-region">
        <NotConnected hint="甘特计划、基线对比与延期影响预览随迭代 1 计划域接入" />
      </div>
    </div>
  );
}
