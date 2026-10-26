import { BookOpenCheck, ShieldAlert, ShieldCheck } from "lucide-react";

import { useRail } from "../components/shell-rail";
import { NotConnected } from "../components/NotConnected";

function QualityRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">QUALITY GATE</span>
        <h2>交付质量门禁</h2>
      </div>
      <NotConnected hint="门禁通过率与阻断事项将在迭代 1 接入" />
      <div className="context-section">
        <div className="section-label">SEPARATION OF DUTIES</div>
        <h2>独立复核</h2>
        <p className="context-note">
          严重及以上问题的处理人与最终复核人必须分离。风险接受不会自动关闭原问题。
        </p>
      </div>
      <div className="assurance">
        <ShieldCheck size={16} />
        <span>质量结论与证据文件将自动归入项目质量目录。</span>
      </div>
    </aside>
  );
}

export default function QualityPage() {
  useRail(QualityRail);

  return (
    <div className="screen quality-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">QUALITY ASSURANCE</span>
          <h1>质量，是持续发生的闭环。</h1>
          <p>从发现、处理到独立复核，每个结论都有证据与责任人。</p>
        </div>
      </div>
      <div className="stat-region">
        <NotConnected hint="质量统计口径统一后展示（arch/02 §2：同名指标全站同数）" />
      </div>
      <div className="quality-list-region">
        <NotConnected hint="质量问题列表、分级筛选与处理时间线随迭代 1 质量域接入" />
      </div>
      <div className="quality-bottom">
        <section>
          <span className="section-label">ROOT CAUSE</span>
          <h2>高频根因</h2>
          <NotConnected />
        </section>
        <section className="quality-principle">
          <BookOpenCheck size={24} />
          <div>
            <span className="section-label">QUALITY GATE</span>
            <h2>风险接受，不等于问题关闭。</h2>
            <p>例外决策会保留原问题、附加条件和后续检查点，直到风险真正解除。</p>
          </div>
        </section>
      </div>
      <div className="assurance inline-assurance">
        <ShieldAlert size={16} />
        <span>质量域真实数据随迭代 1 接入；当前页面不含演示数据。</span>
      </div>
    </div>
  );
}
