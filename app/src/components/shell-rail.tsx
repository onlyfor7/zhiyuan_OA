import type { ComponentType, ReactNode } from "react";
import { createContext, useContext, useEffect } from "react";

import type { MeOutput } from "../lib/trpc";

export interface ShellContextValue {
  me: MeOutput;
  setRail: (node: ReactNode | null) => void;
}

/**
 * 工作区壳上下文（iter10-02：由 useOutletContext 改为显式 Context——
 * 多页签 keep-alive 后内容不再经 Outlet 渲染；AppShell 以 <ShellContext.Provider> 直接提供）。
 */
export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell 必须在 AppShell 工作区内使用");
  return ctx;
}

/**
 * 页面设置右侧情境栏的标准写法。传入组件类型（引用稳定）或 useMemo 过的节点，
 * 避免每次渲染都触发栏内容更新。
 */
export function useRail(rail: ComponentType | ReactNode) {
  const { setRail } = useShell();
  useEffect(() => {
    if (typeof rail === "function") {
      const RailComponent = rail as ComponentType;
      setRail(<RailComponent />);
    } else {
      setRail(rail);
    }
    return () => setRail(null);
  }, [rail, setRail]);
}
