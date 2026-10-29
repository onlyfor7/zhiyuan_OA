import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router";
import { X } from "lucide-react";

const NAV_ITEMS = [
  { to: "/cockpit", label: "驾驶舱", index: "01" },
  { to: "/workbench", label: "我的工作台", index: "02" },
  { to: "/projects", label: "项目全周期", index: "03" },
  { to: "__gantt__", label: "甘特计划", index: "04" },
  { to: "/quality", label: "质量中心", index: "05" },
  { to: "/decisions", label: "决策中心", index: "06" },
  { to: "/archive", label: "档案中心", index: "07" },
  { to: "/audit", label: "权限审计", index: "08" },
] as const;

const OPS_ITEMS: { to: string; label: string; gate?: "receipts" | "sysadmin" }[] = [
  { to: "/operations/time", label: "工时中心" },
  { to: "/operations/budget", label: "预算管理" },
  { to: "/operations/expenses", label: "费用中心" },
  { to: "/operations/receipts", label: "收款台账", gate: "receipts" },
  { to: "/approvals", label: "审批中心" },
  { to: "/requests", label: "通用申请" },
  { to: "/settings", label: "账号设置" },
  { to: "/admin", label: "配置中心", gate: "sysadmin" },
];

function canSee(item: { gate?: "receipts" | "sysadmin" }, globalRoles: string[]): boolean {
  if (item.gate === "sysadmin") return globalRoles.includes("sysadmin");
  if (item.gate === "receipts") {
    // member/viewer 全 404（服务端同形），入口直接隐藏；其余角色（pm/质量/档案/财务/合伙人/管理员）可见
    return globalRoles.some((r) => r !== "member" && r !== "viewer");
  }
  return true;
}

/**
 * N3：375px 汉堡抽屉导航（替代顶导航逐字堆叠）。
 * 焦点管理：打开时聚焦第一个导航项、Esc/遮罩/关闭键退出、退出后焦点回到触发钮。
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
  const firstLinkRef = useRef<HTMLAnchorElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstLinkRef.current?.focus();
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
          <button ref={closeRef} className="icon-button dark" aria-label="关闭导航" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="mobile-nav-list">
          {NAV_ITEMS.map((item, i) => (
            <NavLink
              key={item.index}
              to={item.to === "__gantt__" ? ganttTo : item.to}
              ref={i === 0 ? firstLinkRef : undefined}
              className={({ isActive }) => (isActive ? "active" : "")}
              end={item.to === "/projects"}
              onClick={onClose}
            >
              <span>{item.index}</span>
              {item.label}
            </NavLink>
          ))}
        </div>
        <div className="mobile-nav-ops">
          <span className="section-label">OPERATIONS · 经营中心</span>
          {OPS_ITEMS.filter((item) => canSee(item, globalRoles)).map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")} onClick={onClose}>
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>,
    document.body,
  );
}
