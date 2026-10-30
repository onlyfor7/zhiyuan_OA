import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { X } from "lucide-react";
import { useLogout } from "../api/auth";
import { activeGroupKey, buildNavGroups } from "./topnav-config";

/**
 * N3/迭代 7：≤820px 汉堡抽屉——五组分区（总览/项目/协同/经营/治理）+ 底部系统区
 * （系统配置中心[仅 sysadmin]/账号设置与改密/退出登录）。焦点管理：打开聚焦首项、Esc/遮罩/关闭键退出。
 */
export function MobileNavDrawer({
  open,
  ganttTo,
  globalRoles,
  onClose,
}: {
  open: boolean;
  ganttTo: string;
  globalRoles: string[];
  onClose: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const logout = useLogout();
  const activeKey = activeGroupKey(location.pathname);
  const groups = buildNavGroups(ganttTo)
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.roles || i.roles.some((r) => globalRoles.includes(r))) }))
    .filter((g) => g.items.length > 0);
  const isSysadmin = globalRoles.includes("sysadmin");

  useEffect(() => {
    if (!open) return;
    document.querySelector<HTMLElement>("#mobile-nav-drawer a, #mobile-nav-drawer button")?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (open) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  if (!open) return null;

  return createPortal(
    <div className="mobile-nav-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <nav
        className="mobile-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="主导航（移动）"
        id="mobile-nav-drawer"
      >
        <div className="mobile-nav-head">
          <span className="section-label">NAVIGATION</span>
          <button className="icon-button dark" aria-label="关闭导航" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="mobile-nav-list">
          {groups.map((g) => (
            <div className="ux-drawer-group" key={g.key}>
              <span className="section-label">{g.label}</span>
              {g.items.map((item) => {
                const isGantt = item.label === "甘特计划";
                return (
                  <NavLink
                    key={item.label}
                    to={item.to}
                    className={() =>
                      (item.match ? location.pathname.startsWith(item.match.split("?")[0]) : false) ||
                      (g.key === activeKey && !isGantt && item.label === "项目全周期" && location.pathname.startsWith("/projects"))
                        ? "active"
                        : ""
                    }
                    onClick={onClose}
                  >
                    {item.label}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </div>
        <div className="ux-drawer-group mobile-nav-system">
          <span className="section-label">系统</span>
          {isSysadmin ? (
            <Link to="/admin" onClick={onClose}>
              系统配置中心
            </Link>
          ) : null}
          <Link to="/settings" onClick={onClose}>
            账号设置与改密
          </Link>
          <button
            className="danger"
            disabled={logout.isPending}
            onClick={() => {
              onClose();
              logout.mutate(undefined, {
                onSettled: () => navigate("/login", { replace: true }),
              });
            }}
          >
            {logout.isPending ? "正在退出…" : "退出登录"}
          </button>
        </div>
      </nav>
    </div>,
    document.body,
  );
}
