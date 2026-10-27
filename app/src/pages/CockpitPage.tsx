import { Link, useNavigate } from "react-router";
import { ArrowRight, ChevronRight, ShieldCheck } from "lucide-react";

import { useDashboardSummary } from "../api/dashboard";
import { useProjectPreview } from "../api/project";
import { useRail, useShell } from "../components/shell-rail";
import { HEALTH_LABEL, LIFECYCLE_LABEL } from "../lib/labels";
import { formatDateTime } from "../lib/trpc";

function CockpitRail() {
  const dashboard = useDashboardSummary();
  const summary = dashboard.data;
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">DECISION QUEUE</span>
        <h2>需要我处理</h2>
      </div>
      <div className="wall-row">
        <span>待我审批</span>
        <strong>{summary?.pendingApprovals ?? 0}</strong>
      </div>
      <div className="wall-row">
        <span>待决策</span>
        <strong>{summary?.pendingDecisions ?? 0}</strong>
      </div>
      <div className="wall-row">
        <span>阻断中质量问题</span>
        <strong>{summary?.blockingQuality ?? 0}</strong>
      </div>
      <Link to="/workbench" className="context-link">
        前往工作台处理
        <ChevronRight size={15} />
      </Link>
      <div className="assurance">
        <ShieldCheck size={17} />
        <span>仅显示你权限范围内的项目与事项。</span>
      </div>
    </aside>
  );
}

/** 驾驶舱：dashboard.summary 真实聚合 + 项目脉搏（工单 03-10） */
export default function CockpitPage() {
  const { me } = useShell();
  const dashboard = useDashboardSummary();
  const projects = useProjectPreview();
  const navigate = useNavigate();
  useRail(CockpitRail);

  const dateLine = new Date()
    .toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();

  if (dashboard.isPending) return <p className="list-note">正在加载驾驶舱…</p>;
  if (dashboard.isError) throw dashboard.error;
  const s = dashboard.data;

  return (
    <div className="screen cockpit-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">{dateLine}</span>
          <h1>早上好，{me.user.name}。</h1>
          <p>项目组合与待处理事项来自实时聚合（截至 {s.asOf.slice(0, 16).replace("T", " ")}）。</p>
        </div>
        <Link to="/projects" className="primary-action">
          进入项目空间
          <ArrowRight size={16} />
        </Link>
      </div>
      <div className="metric-strip overview-strip">
        <div>
          <span>项目总数</span>
          <strong>{s.projects.total}</strong>
          <small>
            进行中 {s.projects.inProgress} · 筹备 {s.projects.preparing} · 已结项 {s.projects.closed}
          </small>
        </div>
        <div>
          <span>健康度预警</span>
          <strong className="risk-number">{s.projects.warning}</strong>
          <small>风险 {s.projects.atRisk} 项</small>
        </div>
        <div>
          <span>待我审批</span>
          <strong>{s.pendingApprovals}</strong>
          <small>
            <Link to="/approvals">去处理</Link>
          </small>
        </div>
        <div>
          <span>待决策</span>
          <strong>{s.pendingDecisions}</strong>
          <small>
            <Link to="/decisions">去决策</Link>
          </small>
        </div>
        <div>
          <span>阻断中质量问题</span>
          <strong className={s.blockingQuality > 0 ? "risk-number" : ""}>{s.blockingQuality}</strong>
          <small>严重/致命未关闭</small>
        </div>
        <div>
          <span>本周会议</span>
          <strong>{s.weeklyMeetings}</strong>
          <small>
            <Link to="/meetings">去查看</Link>
          </small>
        </div>
        <div>
          <span>出差中</span>
          <strong>{s.travelingCount}</strong>
          <small>人（去重申请人）</small>
        </div>
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
