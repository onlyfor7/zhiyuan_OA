import type { ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { ChevronRight } from "lucide-react";

import { useProject, useProjectOverview } from "../../api/project";
import { NotConnected } from "../../components/NotConnected";
import { useSpaceParams } from "./space-context";
import {
  CONFIDENTIALITY_LABEL,
  HEALTH_LABEL,
  LIFECYCLE_LABEL,
  PROJECT_ROLE_LABEL,
} from "../../lib/labels";

const REAL_TABS = [
  { key: "overview", label: "总览" },
  { key: "plan", label: "计划" },
  { key: "tasks", label: "任务" },
  { key: "quality", label: "质量" },
  { key: "decisions", label: "决策" },
  { key: "reports", label: "周报" },
  { key: "archive", label: "档案" },
  { key: "members", label: "成员权限" },
] as const;

const FUTURE_TABS = [
  { key: "meetings", label: "会议" },
  { key: "travel", label: "出差" },
  { key: "budget", label: "预算经费" },
  { key: "expenses", label: "费用" },
  { key: "timesheet", label: "工时" },
] as const;

export function FutureTab({ label }: { label: string }) {
  return (
    <section className="future-tab">
      <NotConnected hint={`「${label}」功能将在后续迭代接入真实数据（迭代 2–4）`} />
    </section>
  );
}

function SpaceFallback() {
  return (
    <div className="screen">
      <p className="list-note">正在加载项目…</p>
    </div>
  );
}

/**
 * 项目空间（工单 03-1）：页签式布局 + 项目上下文 Outlet。
 * 数据权限由服务端强制；页签可见性对项目成员一致（不泄露由服务端 404 保证）。
 */
export default function ProjectSpacePage(): ReactNode {
  const { projectId } = useSpaceParams();
  const project = useProject(projectId);
  const overview = useProjectOverview(projectId);

  if (project.isPending) return <SpaceFallback />;
  if (project.isError) throw project.error;
  const p = project.data;

  return (
    <div className="screen project-space">
      <div className="project-title-row">
        <div>
          <div className="breadcrumb">
            <Link to="/projects">项目</Link>
            <ChevronRight size={13} />
            <span>{p.code}</span>
          </div>
          <h1>{p.name}</h1>
          <p>
            {p.matterName} · 负责人 {p.managerName} · 密级 {CONFIDENTIALITY_LABEL[p.confidentialityLevel]}
            {p.myRole ? ` · 我的角色：${PROJECT_ROLE_LABEL[p.myRole] ?? p.myRole}` : ""}
          </p>
        </div>
        <div className="title-actions">
          <span className={`badge badge-lifecycle-${p.lifecycleStatus}`}>
            {LIFECYCLE_LABEL[p.lifecycleStatus]}
          </span>
          <span className={`badge badge-health-${p.healthStatus}`}>{HEALTH_LABEL[p.healthStatus]}</span>
        </div>
      </div>
      <div className="space-tabs" role="tablist" aria-label="项目空间页签">
        {REAL_TABS.map((tab) => (
          <NavLink
            key={tab.key}
            to={tab.key}
            className={({ isActive }) => (isActive ? "active" : "")}
            role="tab"
          >
            {tab.label}
          </NavLink>
        ))}
        {overview.data?.myRole === "manager" ? (
          <NavLink to="flows" className={({ isActive }) => (isActive ? "active" : "")} role="tab">
            审批流
          </NavLink>
        ) : null}
        {FUTURE_TABS.map((tab) => (
          <NavLink
            key={tab.key}
            to={tab.key}
            className={({ isActive }) => (isActive ? "active" : "")}
            role="tab"
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
      {overview.data?.project?.archivedAt ? (
        <p className="archive-banner">该项目已结项归档，内容只读。</p>
      ) : null}
      <Outlet context={{ projectId, project: p }} />
    </div>
  );
}
