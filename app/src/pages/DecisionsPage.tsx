import { History, ShieldCheck } from "lucide-react";

import { useRail } from "../components/shell-rail";
import { NotConnected } from "../components/NotConnected";

function DecisionRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">DECISION RECORD</span>
        <h2>决策留痕</h2>
      </div>
      <div className="decision-principles">
        <div>
          <span>01</span>
          <p>
            <strong>方案可比较</strong>时间、质量、成本和客户影响清晰。
          </p>
        </div>
        <div>
          <span>02</span>
          <p>
            <strong>决定可执行</strong>结果回写任务、计划与检查点。
          </p>
        </div>
        <div>
          <span>03</span>
          <p>
            <strong>执行可验证</strong>附加条件未被检查前，决策不会真正结束。
          </p>
        </div>
      </div>
      <div className="assurance">
        <History size={16} />
        <span>决策意见、最终决定和后续验证将永久保留。</span>
      </div>
    </aside>
  );
}

export default function DecisionsPage() {
  useRail(DecisionRail);

  return (
    <div className="screen decision-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">DECISION CENTER</span>
          <h1>重要取舍，应当被认真记录。</h1>
          <p>比较方案、明确条件、跟踪执行，而不是只留下一句“同意”。</p>
        </div>
      </div>
      <div className="decision-list-region">
        <NotConnected hint="决策队列、方案比较与执行验证随迭代 1 决策域接入" />
      </div>
      <div className="assurance inline-assurance">
        <ShieldCheck size={16} />
        <span>当前页面不含演示数据；待决策事项将在真实决策流上线后出现。</span>
      </div>
    </div>
  );
}
