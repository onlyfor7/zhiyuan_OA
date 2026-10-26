/**
 * 未接入数据区域的统一占位（工单 04 / 验收场景 6）：
 * 一律显示「数据未接入」，禁止保留任何演示数字或假成功。
 */
export function NotConnected({ hint }: { hint?: string }) {
  return (
    <div className="not-connected" role="note">
      <span className="nc-label">DATA NOT CONNECTED</span>
      <strong>数据未接入</strong>
      {hint ? <p>{hint}</p> : null}
    </div>
  );
}
