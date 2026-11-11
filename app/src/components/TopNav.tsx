import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronDown } from "lucide-react";

import { FormDialog } from "./FormDialog";
import { DensitySwitch } from "./density";
import { useTableDensity } from "../lib/tableDensity";
import { useLogout } from "../api/auth";

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

/** 头像菜单（IA v2/G2）：仅 账户信息 / 修改密码 / 界面自定义；配置中心入治理组，退出登录在设置页 */
export function AvatarMenu({ name, email }: { name: string; email: string }) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const { density, setDensity } = useTableDensity();
  const navigate = useNavigate();
  const logout = useLogout();
  return (
    <>
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
            <Link role="menuitem" to="/settings" onClick={() => setOpen(false)}>
              修改密码
            </Link>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setCustomOpen(true);
              }}
            >
              界面自定义
            </button>
            <div className="ux-menu-divider" role="separator" />
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                logout.mutate(undefined, { onSuccess: () => navigate("/login", { replace: true }) });
              }}
            >
              切换账号
            </button>
            <button
              role="menuitem"
              className="ux-menu-danger"
              onClick={() => {
                setOpen(false);
                logout.mutate(undefined, { onSuccess: () => navigate("/login", { replace: true }) });
              }}
            >
              退出登录
            </button>
          </>
        )}
      </Dropdown>
      {customOpen ? (
        <FormDialog title="界面自定义" eyebrow="APPEARANCE" onClose={() => setCustomOpen(false)}>
          <DensitySwitch density={density} onChange={setDensity} />
          <p className="context-note">表格密度即时生效并保存在本机（界面偏好）；更多自定义项随迭代补充。</p>
        </FormDialog>
      ) : null}
    </>
  );
}
