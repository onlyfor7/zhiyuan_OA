import { Link, NavLink, Outlet } from "react-router";

import { PREVIEW_BADGE } from "./preview-data";

const PREVIEW_NAV = [
  { to: "/preview/admin", label: "配置中心" },
  { to: "/preview/requests", label: "通用申请" },
  { to: "/preview/receipts", label: "收款台账" },
  { to: "/preview/settings", label: "自助改密" },
];

/**
 * 原型隔离壳：/preview/* 专用（不进正式导航/认证壳）。
 * 每页右上角固定徽标「原型预览 · 数据为静态示意」——红线：静态数据必须明示。
 */
export default function PreviewShell() {
  return (
    <div className="preview-app">
      <span className="preview-badge" role="note">
        {PREVIEW_BADGE}
      </span>
      <header className="preview-topbar">
        <Link to="/preview/admin" className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>LEXFLOW</strong>
            <span>扩展域原型 · 迭代 6</span>
          </div>
        </Link>
        <nav className="preview-nav" aria-label="原型导航">
          {PREVIEW_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <Link to="/cockpit" className="preview-back">
          返回正式应用
        </Link>
      </header>
      <main className="preview-main">
        <Outlet />
      </main>
    </div>
  );
}

