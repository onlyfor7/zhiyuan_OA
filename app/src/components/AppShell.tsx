import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { Bell, Menu, Search } from "lucide-react";
import { Toaster } from "sonner";

import { useMe } from "../api/auth";
import { useUnreadCount } from "../api/notification";
import { SearchPalette } from "./SearchPalette";
import { MobileNavDrawer } from "./MobileNavDrawer";
import { AvatarMenu } from "./TopNav";
import { CascadeNav } from "./CascadeNav";
import { ShellContext, type ShellContextValue } from "./shell-rail";
import { WorkspaceShell } from "./workspace/WorkspaceShell";
import { isAuthRequired } from "../lib/trpc";

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

/** 应用壳：迭代 7 新 IA 顶栏（五组下拉+头像菜单收口）+ 迭代 10 多页签工作区（§15，arch/12 v1.9） */
export default function AppShell() {
  const me = useMe();
  const location = useLocation();
  const unread = useUnreadCount();
  const [rail, setRail] = useState<ReactNode>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (me.isPending) {
    return (
      <div className="page-loader" role="status" aria-label="正在加载">
        <BrandMark />
        <span>LEXFLOW</span>
      </div>
    );
  }

  if (me.isError) {
    if (isAuthRequired(me.error)) {
      const from = location.pathname + location.search;
      return <Navigate to="/login" replace state={{ from }} />;
    }
    return (
      <div className="error-state" role="alert">
        <strong>无法恢复会话</strong>
        <p>初始化用户信息失败，请重试。</p>
        <button className="secondary-action" onClick={() => void me.refetch()}>
          重试
        </button>
      </div>
    );
  }

  const data = me.data;
  const from = location.pathname + location.search;

  if (data.mustChangePassword && location.pathname !== "/settings") {
    return <Navigate to="/settings" replace />;
  }

  return (
    <ShellContext.Provider value={{ me: data, setRail } satisfies ShellContextValue}>
      <div className="concept-app">
        <header className="topbar">
          <Link to="/cockpit" className="brand" aria-label="LEXFLOW 驾驶舱">
            <BrandMark />
            <div>
              <strong>因诺智元</strong>
              <span>业务管理平台</span>
            </div>
          </Link>
          <CascadeNav globalRoles={data.globalRoles} />
          <div className="top-actions">
            <button className="search-trigger" onClick={() => setSearchOpen(true)}>
              <Search size={16} />
              <span>搜索项目、任务、报销、文件</span>
              <kbd>⌘ K</kbd>
            </button>
            <Link to="/workbench" className="icon-button dark bell-link" aria-label="通知与待办">
              <Bell size={18} />
              {unread.data && unread.data.count > 0 ? (
                <i className="bell-badge">{unread.data.count > 99 ? "99+" : unread.data.count}</i>
              ) : null}
            </Link>
            <AvatarMenu name={data.user.name} email={data.user.email} />
            <button
              className="icon-button dark nav-menu-trigger"
              aria-label="打开主导航"
              aria-expanded={navOpen}
              aria-controls="mobile-nav-drawer"
              onClick={() => setNavOpen(true)}
            >
              <Menu size={18} />
            </button>
          </div>
        </header>
        {searchOpen ? <SearchPalette onClose={() => setSearchOpen(false)} /> : null}
        <Toaster position="bottom-right" richColors closeButton />
        <MobileNavDrawer open={navOpen} globalRoles={data.globalRoles} onClose={() => setNavOpen(false)} />
        <WorkspaceShell rail={rail} from={from} />
      </div>
    </ShellContext.Provider>
  );
}
