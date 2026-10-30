import { useEffect, useRef } from "react";

/**
 * 统一弹窗壳（arch/10 §2 范式）：Esc/遮罩关闭、首字段自动聚焦、关闭后焦点还原触发钮。
 * 防重复提交与 fieldErrors 映射由各表单自行接 mutation.isPending / 错误状态。
 */
export function FormDialog({
  title,
  eyebrow,
  onClose,
  children,
  wide,
  testId,
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea");
    (first ?? ref.current?.querySelector<HTMLElement>("[data-autofocus]"))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      triggerRef.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="overlay centered"
      data-testid={testId}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section className={`decision-modal ${wide ? "ux-modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="drawer-head">
          <div>
            <span className="section-label">{eyebrow}</span>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

/** E7 高危确认统一范式：红条 + 后果回显 + 确认/取消 */
export function DangerConfirm({
  title,
  consequence,
  confirmLabel = "确认执行",
  pending,
  onConfirm,
  onCancel,
}: {
  title: string;
  consequence: React.ReactNode;
  confirmLabel?: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <FormDialog title={title} eyebrow="高危操作 · 二次确认" onClose={onCancel}>
      <div className="ux-danger-box" style={{ marginBottom: 16 }}>
        {consequence}
      </div>
      <div className="row-ops" style={{ justifyContent: "flex-end" }}>
        <button className="secondary-action" onClick={onCancel}>
          取消
        </button>
        <button className="danger-action" disabled={pending} onClick={onConfirm}>
          {pending ? "执行中…" : confirmLabel}
        </button>
      </div>
    </FormDialog>
  );
}
