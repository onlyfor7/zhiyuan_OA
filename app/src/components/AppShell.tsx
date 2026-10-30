import type { ReactNode } from "react";
import { Component, lazy, Suspense, useEffect, useState } from "react";
import {
  Link,
  Navigate,
  Outlet,
  NavLink,
  useLocation,
  useNavigate,
} from "react-router";
import { ArrowRight, Bell, LogOut, Menu, Network, Search, Settings, SlidersHorizontal } from "lucide-react";

import { useLogout, useMe } from "../api/auth";
import { useUnreadCount } from "../api/notification";
import { SearchPalette } from "./SearchPalette";
import { MobileNavDrawer } from "./MobileNavDrawer";
import type { ShellContextValue } from "./shell-rail";
import { isAccessDeniedOrGone, isAuthRequired, queryClient } from "../lib/trpc";
const NotFoundPage = lazy(() => import("../pages/NotFoundPage"));

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

const NAV_ITEMS: { to: string; label: string; index: string }[] = [
  { to: "/cockpit", label: "驾驶舱", index: "01" },
  { to: "/workbench", label: "我的工作台", index: "02" },
  { to: "/projects", label: "项目全周期", index: "03" },
  { to: "__gantt__", label: "甘特计划", index: "04" },
  { to: "/quality", label: "质量中心", index: "05" },
  { to: "/decisions", label: "决策中心", index: "06" },
  { to: "/archive", label: "档案中心", index: "07" },
  { to: "/audit", label: "权限审计", index: "08" },
];

interface BoundaryProps {
  children: ReactNode;
  from: string;
}

interface BoundaryState {
  error: unknown;
}

/**
 * 路由错误边界：ACCESS_DENIED_OR_GONE → 403/404 同形页（不泄露存在性）；
 * AUTH_REQUIRED → 跳登录并保留回跳地址；其余错误 → 可重试的错误态。
 */
class AccessErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  override render() {
    const { error } = this.state;
    if (error !== null && error !== undefined) {
      if (isAccessDeniedOrGone(error)) {
        return (
          <Suspense fallback={null}>
            <NotFoundPage fixedCode="404" />
          </Suspense>
        );
      }
      if (isAuthRequired(error)) {
        return <Navigate to="/login" replace state={{ from: this.props.from }} />;
      }
      return (
        <div className="error-state" role="alert">
          <strong>页面加载失败</strong>
          <p>请求未成功完成，请重试；若持续失败请联系系统管理员。</p>
          <button
            className="secondary-action"
            onClick={() => {
              void queryClient.invalidateQueries();
              this.setState({ error: null });
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function AppShell() {
  const me = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const logout = useLogout();
  const unread = useUnreadCount();
  const [mobileRail, setMobileRail] = useState(false);
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
  const firstProjectId = data.projects[0]?.id;
  const ganttTo = firstProjectId ? `/projects/${firstProjectId}/plan` : "/projects";
  const from = location.pathname + location.search;

  if (data.mustChangePassword && location.pathname !== "/settings") {
    return <Navigate to="/settings" replace />;
  }

  return (
    <div className="concept-app">
      <header className="topbar">
        <Link to="/cockpit" className="brand" aria-label="LEXFLOW 驾驶舱">
          <BrandMark />
          <div>
            <strong>LEXFLOW</strong>
            <span>律所项目治理平台</span>
          </div>
        </Link>
        <nav className="concept-nav" aria-label="主导航">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.index}
              to={item.to === "__gantt__" ? ganttTo : item.to}
              className={({ isActive }) => (isActive ? "active" : "")}
              end={item.to === "/projects"}
            >
              <span>{item.index}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
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
          <div className="avatar" title={`${data.user.name} · ${data.user.email}`}>
            {data.user.name.slice(0, 1)}
          </div>
          {data.globalRoles.includes("sysadmin") ? (
            <Link to="/admin" className="icon-button dark admin-entry" aria-label="系统配置中心">
              <SlidersHorizontal size={17} />
            </Link>
          ) : null}
          <Link to="/settings" className="icon-button dark settings-link" aria-label="账号设置与改密">
            <Settings size={17} />
          </Link>
          <button
            className="icon-button dark"
            aria-label="登出"
            disabled={logout.isPending}
            onClick={() => {
              logout.mutate(undefined, {
                onSettled: () => navigate("/login", { replace: true }),
              });
            }}
          >
            <LogOut size={17} />
          </button>
          <button
            className="icon-button dark nav-menu-trigger"
            aria-label="打开主导航"
            aria-expanded={navOpen}
            aria-controls="mobile-nav-drawer"
            onClick={() => setNavOpen(true)}
          >
            <Menu size={18} />
          </button>
          <button
            className="icon-button dark mobile-menu"
            aria-label="打开项目索引"
            onClick={() => setMobileRail((v) => !v)}
          >
            <Menu size={18} />
          </button>
        </div>
      </header>
      {searchOpen ? <SearchPalette onClose={() => setSearchOpen(false)} /> : null}
      <MobileNavDrawer open={navOpen} ganttTo={ganttTo} globalRoles={data.globalRoles} onClose={() => setNavOpen(false)} />
      <div className="app-body">
        <aside className={`project-rail ${mobileRail ? "mobile-open" : ""}`}>
          <div className="rail-heading">
            <span>项目索引</span>
            <strong>{data.projects.length.toString().padStart(2, "0")}</strong>
          </div>
          <div className="rail-list">
            {data.projects.length === 0 ? (
              <p className="rail-empty">暂无可见项目</p>
            ) : (
              data.projects.map((project) => (
                <Link
                  key={project.id}
                  to={`/projects/${project.id}`}
                  className={location.pathname.includes(`/projects/${project.id}`) ? "active" : ""}
                  onClick={() => setMobileRail(false)}
                >
                  <span className="status-dot ok" />
                  <div>
                    <strong>{project.name}</strong>
                    <small>{project.code}</small>
                  </div>
                </Link>
              ))
            )}
          </div>
          <Link to="/projects" className="all-projects" onClick={() => setMobileRail(false)}>
            查看全部项目
            <ArrowRight size={14} />
          </Link>
          <div className="rail-bottom">
            <Network size={16} />
            <span>仅显示你权限范围内的项目</span>
            <small>NEED-TO-KNOW ACCESS</small>
          </div>
        </aside>
        <main className="main-workspace">
          <AccessErrorBoundary key={location.pathname} from={from}>
            <Outlet context={{ me: data, setRail } satisfies ShellContextValue} />
          </AccessErrorBoundary>
        </main>
        {rail}
      </div>
    </div>
  );
}
