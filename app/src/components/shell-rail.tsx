import type { ComponentType, ReactNode } from "react";
import { useEffect } from "react";
import { useOutletContext } from "react-router";

import type { MeOutput } from "../lib/trpc";

export interface ShellContextValue {
  me: MeOutput;
  setRail: (node: ReactNode | null) => void;
}

/** 页面经 Outlet 上下文向右侧情境栏注入内容 */
export function useShell(): ShellContextValue {
  return useOutletContext<ShellContextValue>();
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
