import { Link } from "react-router";
import { ArrowRight, CircleAlert, ShieldCheck } from "lucide-react";

import { useProjectOverview } from "../../api/project";
import { useMe } from "../../api/auth";
import { formatYuan } from "../../api/reference";
import { BudgetBar } from "../../components/finance";
import { canViewFinance } from "../../lib/permissions";
import { ChevronRight } from "lucide-react";
import { NotConnected } from "../../components/NotConnected";
import { useSpaceParams } from "./space-context";

/** 项目空间·总览页签：project.overview 真实聚合（arch/04 §5） */
export default function OverviewTab() {
  const { projectId } = useSpaceParams();
  const me = useMe();
  const overview = useProjectOverview(projectId);
  const allowed = canViewFinance(
    (me.data?.projects ?? []).find((p) => p.id === projectId)?.projectRole ?? null,
    me.data?.globalRoles ?? [],
  );

  if (overview.isPending) return <p className="list-note">正在加载总览…</p>;
  if (overview.isError) throw overview.error;
  const o = overview.data;

  return (
    <div className="space-tab-body">
      <div className="metric-strip overview-strip">
        <div>
          <span>任务总数</span>
          <strong>{o.tasks.total}</strong>
          <small>
            待开始 {o.tasks.pending} · 进行中 {o.tasks.inProgress} · 完成 {o.tasks.done}
          </small>
        </div>
        <div>
          <span>逾期任务</span>
          <strong className={o.tasks.overdue > 0 ? "risk-number" : ""}>{o.tasks.overdue}</strong>
          <small>按计划完成日计算</small>
        </div>
        <div>
          <span>开放质量问题</span>
          <strong>{o.quality.open}</strong>
          <small>阻断 {o.quality.blocking} 项</small>
        </div>
        <div>
          <span>待决策</span>
          <strong>{o.decisionsPending}</strong>
          <small>待审批 {o.pendingApprovals} 项</small>
        </div>
        <div>
          <span>项目成员</span>
          <strong>{o.members}</strong>
          <small>周报 {o.reports} 份</small>
        </div>
      </div>
      {o.quality.blocking > 0 ? (
        <div className="blocking-banner">
          <CircleAlert size={18} />
          <div>
            <strong>{o.quality.blocking} 项严重/致命质量问题未关闭</strong>
            <p>质量门禁与结项检查被阻断，请先完成处理与独立复核。</p>
          </div>
          <Link to="quality" className="text-action">
            前往质量页签
            <ArrowRight size={14} />
          </Link>
        </div>
      ) : null}
      <div className="overview-panels">
        <section>
          <div className="section-heading">
            <div>
              <span className="section-label">PROGRESS</span>
              <h2>进度与质量闭环</h2>
            </div>
          </div>
          <NotConnected hint="整体完成度与质量明细见「计划」「质量」页签；统计口径由服务端统一计算" />
        </section>
        {allowed && overview.data?.budgetSummary ? (
          <section>
            <div className="section-heading">
              <div>
                <span className="section-label">BUDGET</span>
                <h2>预算执行摘要</h2>
              </div>
              <Link to="budget" className="text-action">
                下钻台账
                <ChevronRight size={14} />
              </Link>
            </div>
            <BudgetBar aggregate={overview.data.budgetSummary} />
          </section>
        ) : null}
        {allowed && overview.data?.receiptSummary ? (
          <section>
            <div className="section-heading">
              <div>
                <span className="section-label">RECEIPTS</span>
                <h2>收款摘要</h2>
              </div>
              <Link to="/operations/receipts" className="text-action">
                收款台账
                <ChevronRight size={14} />
              </Link>
            </div>
            <div className="metric-strip">
              <div>
                <span>已登记</span>
                <strong>{formatYuan(overview.data.receiptSummary.registeredCents)} 元</strong>
                <small>实收登记（原额）</small>
              </div>
              <div>
                <span>已作废</span>
                <strong>{formatYuan(overview.data.receiptSummary.voidedCents)} 元</strong>
                <small>冲正留痕</small>
              </div>
              <div>
                <span>净额</span>
                <strong>{formatYuan(overview.data.receiptSummary.netCents)} 元</strong>
                <small>登记 − 作废</small>
              </div>
            </div>
          </section>
        ) : null}
        <section>
          <div className="section-heading">
            <div>
              <span className="section-label">GOVERNANCE</span>
              <h2>治理要点</h2>
            </div>
          </div>
          <ul className="governance-notes">
            <li>
              <ShieldCheck size={15} />
              计划基线不可覆盖：任何计划调整须走书面延期申请并通过审批（PLN-I1）。
            </li>
            <li>
              <ShieldCheck size={15} />
              严重及以上问题必须处理人与复核人分离，未关闭将阻断结项检查。
            </li>
            <li>
              <ShieldCheck size={15} />
              决策记录须双意见齐备，检查点自动生成任务并跟踪验证。
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
