import { Link, useNavigate } from "react-router";
import { ArrowRight, ChevronRight, ShieldCheck } from "lucide-react";

import { useProjectPreview } from "../api/project";
import { useRail, useShell } from "../components/shell-rail";
import { NotConnected } from "../components/NotConnected";
import { formatDateTime } from "../lib/trpc";
import { HEALTH_LABEL, LIFECYCLE_LABEL } from "../lib/labels";

function CockpitRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">DECISION QUEUE</span>
        <h2>待你决策</h2>
      </div>
      <NotConnected hint="决策队列将在迭代 1 接入" />
      <div className="assurance">
        <ShieldCheck size={17} />
        <span>仅显示你权限范围内的项目与决策。</span>
      </div>
    </aside>
  );
}

export default function CockpitPage() {
  const { me } = useShell();
  const projects = useProjectPreview();
  const navigate = useNavigate();
  useRail(CockpitRail);

  const dateLine = new Date()
    .toLocaleDateString("en-GB", {
      weekday: "long",
      day: "2-digit",
      month: "short",
      year: "numeric",
    })
    .toUpperCase();

  return (
    <div className="screen cockpit-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">{dateLine}</span>
          <h1>早上好，{me.user.name}。</h1>
          <p>这里是你的项目组合驾驶舱，项目列表来自实时数据。</p>
        </div>
        <Link to="/projects" className="primary-action">
          进入项目空间
          <ArrowRight size={16} />
        </Link>
      </div>
      <div className="stat-region">
        <NotConnected hint="组合健康度与经营统计将在统一统计口径接入后展示（arch/02 §2）" />
      </div>
      <div className="cockpit-lower">
        <section className="project-focus">
          <div className="section-heading">
            <div>
              <span className="section-label">PROJECT PULSE</span>
              <h2>项目脉搏</h2>
            </div>
            <Link to="/projects" className="text-action">
              全部项目
              <ArrowRight size={14} />
            </Link>
          </div>
          {projects.isPending ? (
            <p className="list-note">正在加载…</p>
          ) : projects.isError ? (
            <p className="list-note">项目列表加载失败，请稍后重试。</p>
          ) : projects.data.items.length === 0 ? (
            <p className="list-note">暂无可见项目；加入项目后即可在此查看。</p>
          ) : (
            projects.data.items.map((project) => (
              <button
                className="focus-row"
                key={project.id}
                onClick={() => navigate(`/projects/${project.id}`)}
              >
                <span className={`status-dot ${project.healthStatus === "normal" ? "ok" : "warn"}`} />
                <span className="focus-name">
                  <strong>{project.name}</strong>
                  <small>
                    {project.code} · {LIFECYCLE_LABEL[project.lifecycleStatus]}
                  </small>
                </span>
                <span className="focus-meta">{HEALTH_LABEL[project.healthStatus]}</span>
                <span className="focus-value">{formatDateTime(project.updatedAt).slice(0, 10)}</span>
                <ChevronRight size={16} />
              </button>
            ))
          )}
        </section>
        <section className="week-signal">
          <span className="section-label">DELAY GOVERNANCE</span>
          <h2>延期不再只是一个红色日期。</h2>
          <div className="signal-line">
            <span>原因</span>
            <i />
            <span>影响</span>
            <i />
            <span>方案</span>
            <i />
            <span>决策</span>
          </div>
          <p>每一次变化都有书面原因、责任人和恢复检查点，并自动进入项目档案。</p>
        </section>
      </div>
    </div>
  );
}
