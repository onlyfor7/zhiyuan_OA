import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router";
import { X } from "lucide-react";
import { useLogout } from "../api/auth";
import { activeGroupKey, NAV_TREE } from "./topnav-config";

/**
 * N3/迭代 9a：≤820px 汉堡抽屉——8 组级联树的平铺呈现（二级分组为小标题）+ 底部系统区。
 * 焦点管理：打开聚焦首项、Esc/遮罩/关闭键退出。
 */
export function MobileNavDrawer({
  open,
  globalRoles,
  onClose,
}: {
  open: boolean;
  globalRoles: string[];
  onClose: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const logout = useLogout();
  const isSysadmin = globalRoles.includes("sysadmin");
  const groups = NAV_TREE
    .map((g) => ({
      ...g,
      sections: g.sections
        .filter((sec) => !sec.roles || sec.roles.some((r) => globalRoles.includes(r)))
        .map((sec) => ({ ...sec, items: sec.items.filter((i) => !i.roles || i.roles.some((r) => globalRoles.includes(r))) }))
        .filter((sec) => sec.items.length > 0),
    }))
    .filter((g) => (!g.roles || g.roles.some((r) => globalRoles.includes(r))) && g.sections.length > 0);
  const activeKey = activeGroupKey(location.pathname);

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
          <span className="section-label">NAVIGATION · 因诺智元</span>
          <button className="icon-button dark" aria-label="关闭导航" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="mobile-nav-list">
          {groups.map((g) => (
            <div className="ux-drawer-group" key={g.key}>
              <span className="section-label">{g.label}</span>
              {g.sections.map((sec) => (
                <div key={sec.name || "_"}>
                  {sec.name ? <small className="mobile-nav-sec">{sec.name}</small> : null}
                  {sec.items.map((item) => {
                    const current =
                      location.pathname.startsWith(item.to.split("?")[0]) &&
                      (item.to.split("?")[0] !== "/projects" || location.pathname === item.to.split("?")[0] || location.pathname.startsWith("/projects/"));
                    return (
                      <Link
                        key={item.to + item.label}
                        to={item.to}
                        className={current && activeKey === g.key ? "active" : ""}
                        onClick={onClose}
                      >
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              ))}
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
