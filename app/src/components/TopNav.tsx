import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { ChevronDown } from "lucide-react";

import { buildNavGroups, activeGroupKey, type TopNavItem } from "./topnav-config";

/**
 * 迭代 7 新 IA 顶栏（arch/10 §1.1）：五组下拉 + 头像菜单收口系统级功能。
 * 键盘可达：Enter/Space 打开、↑↓/Home/End 移动、Esc 关闭并焦点回触发钮；角色过滤不渲染无权限项。
 */

function Dropdown({
  label,
  open,
  onToggle,
  onClose,
  active,
  alignRight,
  children,
}: {
  label: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  active: boolean;
  alignRight?: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>("[role=menuitem]");
    first?.focus();
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
      const idx = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        btnRef.current?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        (items[idx + 1] ?? items[0])?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        (items[idx - 1] ?? items[items.length - 1])?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        items[items.length - 1]?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);

  return (
    <div className="ux-dd topnav-dd" ref={rootRef}>
      <button
        ref={btnRef}
        className={`ux-dd-trigger topnav-trigger ${active ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        {label}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className={`ux-menu ${alignRight ? "right" : ""}`} role="menu" ref={menuRef}>
          {children(onClose)}
        </div>
      ) : null}
    </div>
  );
}

/** 五组下拉导航（桌面顶栏） */
export function GroupNav({ ganttTo, globalRoles }: { ganttTo: string; globalRoles: string[] }) {
  const location = useLocation();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const close = useCallback(() => setOpenMenu(null), []);
  const activeKey = activeGroupKey(location.pathname);
  const groups = buildNavGroups(ganttTo)
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.roles || i.roles.some((r) => globalRoles.includes(r))) }))
    .filter((g) => g.items.length > 0);

  return (
    <nav className="ux-groups topnav-groups" aria-label="系统导航（分组下拉）">
      {groups.map((g) => {
        const menuKey = `grp:${g.key}`;
        const itemActive = (item: TopNavItem) =>
          item.match ? location.pathname.startsWith(item.match.split("?")[0]) : false;
        return (
          <Dropdown
            key={g.key}
            label={g.label}
            open={openMenu === menuKey}
            onToggle={() => setOpenMenu(openMenu === menuKey ? null : menuKey)}
            onClose={close}
            active={activeKey === g.key}
          >
            {(closeMenu) =>
              g.items.map((item) => (
                <Link
                  key={item.label}
                  role="menuitem"
                  to={item.to}
                  className={itemActive(item) ? "current" : ""}
                  onClick={closeMenu}
                >
                  {item.label}
                </Link>
              ))
            }
          </Dropdown>
        );
      })}
    </nav>
  );
}

/** 头像菜单：系统配置中心[仅 sysadmin]/账号设置与改密/退出登录（系统级收口） */
export function AvatarMenu({
  name,
  email,
  globalRoles,
  onLogout,
  logoutPending,
}: {
  name: string;
  email: string;
  globalRoles: string[];
  onLogout: () => void;
  logoutPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isSysadmin = globalRoles.includes("sysadmin");
  return (
    <Dropdown
      label={<span className="topnav-avatar">{name.slice(0, 1)}</span>}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      onClose={() => setOpen(false)}
      active={false}
      alignRight
    >
      {() => (
        <>
          <div className="ux-menu-head">
            {name} · {email}
          </div>
          {isSysadmin ? (
            <Link role="menuitem" to="/admin" onClick={() => setOpen(false)}>
              系统配置中心
            </Link>
          ) : null}
          <Link role="menuitem" to="/settings" onClick={() => setOpen(false)}>
            账号设置与改密
          </Link>
          <button
            role="menuitem"
            className="danger"
            disabled={logoutPending}
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            {logoutPending ? "正在退出…" : "退出登录"}
          </button>
        </>
      )}
    </Dropdown>
  );
}
