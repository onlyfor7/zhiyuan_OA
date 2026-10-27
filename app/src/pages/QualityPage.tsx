import { useRail } from "../components/shell-rail";
import { QualityCenter } from "../components/QualityCenter";
import { Clock3 } from "lucide-react";

function QualityRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">QUALITY GATE</span>
        <h2>交付质量门禁</h2>
      </div>
      <div className="context-section">
        <div className="section-label">SEPARATION OF DUTIES</div>
        <h2>独立复核</h2>
        <p className="context-note">
          严重及以上问题的处理人与最终复核人必须分离（服务端强制）。风险接受不会自动关闭原问题。
        </p>
      </div>
      <div className="assurance">
        <Clock3 size={16} />
        <span>处理历史以 quality_issue_events 为准，只追加不覆盖。</span>
      </div>
    </aside>
  );
}

/** 全局质量中心：我可见项目下的全部质量问题 */
export default function QualityPage() {
  useRail(QualityRail);
  return <QualityCenter />;
}
