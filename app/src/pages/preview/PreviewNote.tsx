import type { ReactNode } from "react";

/** 原型页内的纪律提示条（橙边），与 PreviewShell 解耦以便路由懒加载 */
export function PreviewNote({ children }: { children: ReactNode }) {
  return <p className="preview-note">{children}</p>;
}
