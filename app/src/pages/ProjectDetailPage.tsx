import { useMemo } from "react";
import { Link, useParams } from "react-router";
import { ArrowRight, ChevronRight, CircleAlert, ShieldCheck } from "lucide-react";

import { useProject } from "../api/project";
import { useRail } from "../components/shell-rail";
import { NotConnected } from "../components/NotConnected";
import { formatDateTime, type ProjectDetail } from "../lib/trpc";
import {
  CONFIDENTIALITY_LABEL,
  HEALTH_LABEL,
  LIFECYCLE_LABEL,
  PROJECT_ROLE_LABEL,
} from "../lib/labels";

function DetailRail({ project }: { project: ProjectDetail }) {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">PROJECT CONTEXT</span>
        <h2>项目情境</h2>
      </div>
      <div className="client-block">
        <span>客户</span>
        <strong>{project.clientName}</strong>
        <small>
          项目负责人 {project.managerName} · 事项 {project.matterName}
        </small>
      </div>
      <div className="context-section">
        <div className="section-label">ATTENTION</div>
        <h2>需要关注</h2>
        <div className="attention-item">
          <CircleAlert size={16} />
          <div>
            <strong>风险与延期信号</strong>
            <p>质量、计划与决策信号将在迭代 1 接入。</p>
          </div>
        </div>
      </div>
      <div className="assurance">
        <ShieldCheck size={17} />
        <span>仅项目成员与有效授权可查看此项目（arch/03 §5）。</span>
      </div>
    </aside>
  );
}

function DetailRailLoader() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">PROJECT CONTEXT</span>
        <h2>项目情境</h2>
      </div>
    </aside>
  );
}

export default function ProjectDetailPage() {
  const { projectId } = useParams();
  const project = useProject(projectId ?? "");
  // 栏节点引用必须稳定，否则每次渲染都会触发 setRail 更新（Maximum update depth）
  const rail = useMemo(
    () => (project.data ? <DetailRail project={project.data} /> : <DetailRailLoader />),
    [project.data],
  );
  useRail(rail);

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
    // 无权限与不存在统一 NOT_FOUND 形态 → 路由错误边界渲染 403/404 同形页
    throw project.error;
  }

  const p = project.data;
  return (
    <div className="screen project-screen">
      <div className="project-title-row">
        <div>
          <div className="breadcrumb">
            <span>项目</span>
            <ChevronRight size={13} />
            <span>{p.code}</span>
          </div>
          <h1>{p.name}</h1>
          <p>
            {p.matterName} · 项目负责人：{p.managerName} · 保密等级：
            {CONFIDENTIALITY_LABEL[p.confidentialityLevel]}
          </p>
        </div>
        <div className="title-actions">
          <Link to="/projects" className="secondary-action">
            返回列表
          </Link>
          <Link to={`/projects/${p.id}/plan`} className="primary-action">
            查看计划
            <ArrowRight size={16} />
          </Link>
        </div>
      </div>
      <div className="detail-facts">
        <div>
          <span>生命周期</span>
          <strong className={`badge badge-lifecycle-${p.lifecycleStatus}`}>
            {LIFECYCLE_LABEL[p.lifecycleStatus]}
          </strong>
        </div>
        <div>
          <span>健康度</span>
          <strong className={`badge badge-health-${p.healthStatus}`}>
            {HEALTH_LABEL[p.healthStatus]}
          </strong>
        </div>
        <div>
          <span>项目成员</span>
          <strong>{p.memberCount} 人</strong>
        </div>
        <div>
          <span>我的角色</span>
          <strong>{p.myRole ? (PROJECT_ROLE_LABEL[p.myRole] ?? p.myRole) : "—"}</strong>
        </div>
        <div>
          <span>最近更新</span>
          <strong>{formatDateTime(p.updatedAt)}</strong>
        </div>
      </div>
      <div className="project-overview-grid">
        <section className="next-milestone">
          <div className="section-label">OVERVIEW</div>
          <h2>项目信息</h2>
          <dl className="detail-list">
            <div>
              <dt>项目编号</dt>
              <dd>{p.code}</dd>
            </div>
            <div>
              <dt>客户</dt>
              <dd>{p.clientName}</dd>
            </div>
            <div>
              <dt>事项</dt>
              <dd>{p.matterName}</dd>
            </div>
            <div>
              <dt>负责人</dt>
              <dd>{p.managerName}</dd>
            </div>
          </dl>
        </section>
        <section className="progress-composition">
          <div className="section-heading">
            <div>
              <span className="section-label">PROGRESS & QUALITY</span>
              <h2>进度与质量闭环</h2>
            </div>
          </div>
          <NotConnected hint="整体完成度、里程碑与质量数据随迭代 1 项目治理闭环接入" />
        </section>
      </div>
    </div>
  );
}
