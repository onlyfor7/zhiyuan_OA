/** E1 空状态引导 / E2 骨架屏 统一组件 */

/** E1：空状态给「下一步做什么」引导（动作入口为可选示意按钮，由调用方渲染） */
export function EmptyGuide({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty-state ux-empty-guide">
      <strong>{title}</strong>
      <div className="ux-empty-steps">{children}</div>
    </div>
  );
}

export function EmptyStep({ index, text }: { index: number; text: string }) {
  return (
    <p className="ux-empty-step">
      <span>{index}</span>
      {text}
    </p>
  );
}

/** E2：列表骨架屏（替零散「正在加载…」文案） */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="ux-skeleton-block" role="status" aria-label="正在加载">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ux-skeleton line" style={{ width: `${88 - (i % 3) * 14}%` }} />
      ))}
    </div>
  );
}

/** E2：详情/卡片骨架 */
export function CardSkeleton() {
  return (
    <div className="ux-skeleton-block" role="status" aria-label="正在加载">
      <div className="ux-skeleton line w40" />
      <div className="ux-skeleton line w80" />
      <div className="ux-skeleton card" />
    </div>
  );
}

/** G8：详情页「← 返回」（浏览器返回显式化） */
export function BackButton({ label = "返回" }: { label?: string }) {
  const back = () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = "/cockpit";
  };
  return (
    <button className="text-action ux-back-btn" onClick={back}>
      ← {label}
    </button>
  );
}
