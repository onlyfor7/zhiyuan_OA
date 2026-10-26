import { Link } from "react-router";
import { Archive, ArrowRight, CalendarDays, ChevronRight, Clock3, ShieldCheck } from "lucide-react";
import { getWeek } from "date-fns";

import { useRail, useShell } from "../components/shell-rail";
import { NotConnected } from "../components/NotConnected";

function WorkbenchRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">TODAY</span>
        <h2>今日安排</h2>
      </div>
      <NotConnected hint="日程与待办将在迭代 1 接入" />
      <div className="assurance">
        <Clock3 size={16} />
        <span>待办按到期时间与项目风险综合排序。</span>
      </div>
    </aside>
  );
}

export default function WorkbenchPage() {
  const { me } = useShell();
  useRail(WorkbenchRail);
  const firstProjectId = me.projects[0]?.id;
  const week = getWeek(new Date());

  return (
    <div className="screen workbench-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">MY WORKSPACE · WEEK {week}</span>
          <h1>今天，从最关键的事开始。</h1>
          <p>{me.user.name}，待办、质量复核与周报确认将在迭代 1 起接入真实数据。</p>
        </div>
      </div>
      <div className="stat-region">
        <NotConnected hint="本周工作与汇总统计将在统一统计口径接入后展示" />
      </div>
      <div className="workbench-grid">
        <section className="today-tasks">
          <div className="section-heading">
            <div>
              <span className="section-label">TODAY</span>
              <h2>我的待办</h2>
            </div>
          </div>
          <NotConnected hint="跨模块待办中心随迭代 1 待办视图接入" />
          {firstProjectId ? (
            <Link to={`/projects/${firstProjectId}`} className="text-action">
              进入我的项目
              <ArrowRight size={15} />
            </Link>
          ) : null}
        </section>
        <section className="quick-actions-panel">
          <span className="section-label">QUICK ACTIONS</span>
          <h2>快捷处理</h2>
          {firstProjectId ? (
            <Link to={`/projects/${firstProjectId}/plan`}>
              <CalendarDays size={18} />
              <div>
                <strong>更新项目计划</strong>
                <small>进度、基线与延期</small>
              </div>
              <ChevronRight size={15} />
            </Link>
          ) : null}
          <Link to="/quality">
            <ShieldCheck size={18} />
            <div>
              <strong>处理质量复核</strong>
              <small>质量中心</small>
            </div>
            <ChevronRight size={15} />
          </Link>
          <Link to="/archive">
            <Archive size={18} />
            <div>
              <strong>查阅项目档案</strong>
              <small>档案中心</small>
            </div>
            <ChevronRight size={15} />
          </Link>
        </section>
      </div>
      <section className="weekly-story">
        <div>
          <span className="section-label">WEEKLY NARRATIVE</span>
          <h2>本周工作，自动形成项目叙事。</h2>
          <p>完成的任务、计划变化、质量结论和决策记录将汇总为周报素材，无需重复抄写。</p>
        </div>
        <Link to="/archive" className="secondary-action">
          查看周报档案
          <ArrowRight size={15} />
        </Link>
      </section>
    </div>
  );
}
