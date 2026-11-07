import { createContext, useContext } from "react";

import type { TabMeta } from "./tabsMeta";

/**
 * 工作区页签上下文与类型（独立文件以满足 react-refresh 单导出口径）。
 * WorkspaceShell 提供实现；页面侧用 useWorkspaceTabs 操作（如项目空间回填签标题）。
 */

export interface WsTab extends TabMeta {
  location: string;
  fixed?: boolean;
}

export interface WorkspaceTabsApi {
  tabs: WsTab[];
  activeKey: string;
  activate: (key: string) => void;
  closeTab: (key: string) => void;
  closeOthers: (key: string) => void;
  closeAll: () => void;
  renameTab: (key: string, title: string) => void;
}

export const WorkspaceTabsContext = createContext<WorkspaceTabsApi | null>(null);

export function useWorkspaceTabs(): WorkspaceTabsApi | null {
  return useContext(WorkspaceTabsContext);
}
