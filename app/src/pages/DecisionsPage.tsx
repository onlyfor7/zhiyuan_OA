import { useRail } from "../components/shell-rail";
import { DecisionCenter } from "../components/DecisionCenter";
import { History } from "lucide-react";

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
            <strong>决定可执行</strong>检查点自动生成任务并跟踪验证。
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
        <span>决定、理由与后续验证永久保留。</span>
      </div>
    </aside>
  );
}

/** 全局决策中心 */
export default function DecisionsPage() {
  useRail(DecisionRail);
  return <DecisionCenter />;
}
