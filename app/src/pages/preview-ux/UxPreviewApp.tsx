import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, ChevronDown, Search } from "lucide-react";

import { UxDemoPanels } from "./UxDemoPanels";
import { PERSONA_LABEL, type Persona } from "./ux-types";
import "./ux.css";

/**
 * 迭代 7 · 工单 01 体验优化高保真原型（/preview-ux 隔离路由，静态示意）。
 * 新 IA 壳：顶栏五组下拉（arch/10 §1.1 逐字）+ 头像菜单收口系统级功能；
 * 角色过滤演示（persona 切换）、组内高亮、方向键/Esc 键盘可达、≤820 汉堡抽屉五组分区。
 */

interface NavItem {
  key: string;
  label: string;
  tab: string;
  /** 可见角色白名单；缺省=全角色可见 */
  roles?: Persona[];
}
interface NavGroup {
  key: string;
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  { key: "overview", label: "总览", items: [
    { key: "cockpit", label: "驾驶舱", tab: "grp-overview" },
    { key: "workbench", label: "我的工作台", tab: "grp-overview" },
  ] },
  { key: "project", label: "项目", items: [
    { key: "projects", label: "项目全周期", tab: "grp-project" },
    { key: "gantt", label: "甘特计划", tab: "grp-project" },
  ] },
  { key: "collab", label: "协同", items: [
    { key: "meetings", label: "会议中心", tab: "grp-collab" },
    { key: "travel", label: "出差中心", tab: "grp-collab" },
    { key: "requests", label: "申请单", tab: "dialogs-request" },
  ] },
  { key: "ops", label: "经营", items: [
    { key: "time", label: "工时中心", tab: "grp-ops" },
    { key: "budget", label: "预算管理", tab: "grp-ops" },
    { key: "expenses", label: "费用中心", tab: "grp-ops" },
    { key: "receipts", label: "收款台账", tab: "dialogs-receipt", roles: ["sysadmin", "partner"] },
    { key: "approvals", label: "审批中心", tab: "grp-ops" },
  ] },
  { key: "gov", label: "治理", items: [
    { key: "quality", label: "质量中心", tab: "grp-gov" },
    { key: "decisions", label: "决策中心", tab: "grp-gov" },
    { key: "archive", label: "档案中心", tab: "grp-gov" },
    { key: "audit", label: "权限审计", tab: "grp-gov", roles: ["sysadmin", "partner"] },
  ] },
];

const AVATAR_ITEMS: Array<{ key: string; label: string; tab?: string; roles?: Persona[]; danger?: boolean }> = [
  { key: "admin", label: "系统配置中心", tab: "ghost", roles: ["sysadmin"] },
  { key: "settings", label: "账号设置与改密", tab: "ia" },
  { key: "logout", label: "退出登录", danger: true },
];

function visibleItems(group: NavGroup, persona: Persona): NavItem[] {
  return group.items.filter((i) => !i.roles || i.roles.includes(persona));
}

function Dropdown({
  label,
  open,
  onToggle,
  onClose,
  children,
  active,
  align = "left",
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: (close: () => void) => React.ReactNode;
  active: boolean;
  align?: "left" | "right";
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
    <div className="ux-dd" ref={rootRef}>
      <button
        ref={btnRef}
        className={`ux-dd-trigger ${active ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        {label}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className={`ux-menu ${align === "right" ? "right" : ""}`} role="menu" ref={menuRef}>
          {children(onClose)}
        </div>
      ) : null}
    </div>
  );
}

export default function UxPreviewApp() {
  const [persona, setPersona] = useState<Persona>("sysadmin");
  const [tab, setTab] = useState("ia");
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const closeMenus = useCallback(() => setOpenMenu(null), []);
  const go = useCallback((t: string, groupKey: string | null) => {
    setTab(t);
    setActiveGroup(groupKey);
    setOpenMenu(null);
    setDrawerOpen(false);
  }, []);

  const avatarVisible = AVATAR_ITEMS.filter((i) => !i.roles || i.roles.includes(persona));

  return (
    <div className="ux-app">
      <span className="preview-badge" role="note">
        原型预览 · 静态示意 · 未接入真实数据
      </span>
      {/* 演示工具条：persona 切换（展示角色过滤） */}
      <div className="ux-persona-bar">
        <span>演示角色（角色过滤演示）：</span>
        {(Object.keys(PERSONA_LABEL) as Persona[]).map((p) => (
          <button key={p} className={persona === p ? "active" : ""} onClick={() => setPersona(p)}>
            {PERSONA_LABEL[p]}
          </button>
        ))}
        <em>切换后观察：member 不见「权限审计」「收款台账」与头像菜单「系统配置中心」</em>
      </div>

      <header className="ux-topbar">
        <div className="ux-brand">
          <strong>LEXFLOW</strong>
          <span>律所项目治理平台</span>
        </div>
        <nav className="ux-groups" aria-label="系统导航（分组下拉）">
          {GROUPS.map((g) => {
            const items = visibleItems(g, persona);
            if (items.length === 0) return null;
            const menuKey = `grp:${g.key}`;
            return (
              <Dropdown
                key={g.key}
                label={g.label}
                open={openMenu === menuKey}
                onToggle={() => setOpenMenu(openMenu === menuKey ? null : menuKey)}
                onClose={closeMenus}
                active={activeGroup === g.key}
              >
                {(close) =>
                  items.map((item) => (
                    <button
                      key={item.key}
                      role="menuitem"
                      className={tab === item.tab && activeGroup === g.key ? "current" : ""}
                      onClick={() => {
                        go(item.tab, g.key);
                        close();
                      }}
                    >
                      {item.label}
                    </button>
                  ))
                }
              </Dropdown>
            );
          })}
        </nav>
        <div className="ux-top-actions">
          <button className="ux-search" aria-label="搜索（原型示意）">
            <Search size={15} />
            <span>搜索项目、任务、报销、文件</span>
            <kbd>⌘ K</kbd>
          </button>
          <button className="ux-icon" aria-label="通知（原型示意）">
            <Bell size={17} />
          </button>
          <Dropdown
            label="赵"
            open={openMenu === "avatar"}
            onToggle={() => setOpenMenu(openMenu === "avatar" ? null : "avatar")}
            onClose={closeMenus}
            active={false}
            align="right"
          >
            {(close) => (
              <>
                <div className="ux-menu-head">赵凯 · {PERSONA_LABEL[persona]}</div>
                {avatarVisible.map((item) => (
                  <button
                    key={item.key}
                    role="menuitem"
                    className={item.danger ? "danger" : ""}
                    onClick={() => {
                      if (item.tab) go(item.tab, null);
                      close();
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </>
            )}
          </Dropdown>
          <button
            className="ux-icon ux-burger"
            aria-label="打开导航抽屉"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            ☰
          </button>
        </div>
      </header>

      {/* 系统级 vs 项目级 分区语义带 */}
      <div className="ux-semantics">
        <span className="ux-sem-chip sys">顶栏 = 系统级功能（五组导航 + 头像菜单收口配置/账号/退出）</span>
        <span className="ux-sem-chip proj">左侧「项目索引」与项目空间 = 项目级内容唯一呈现区（不与顶栏混排）</span>
      </div>

      <div className="ux-body">
        <aside className="ux-rail">
          <div className="ux-rail-head">
            <span>项目索引（项目级）</span>
            <strong>02</strong>
          </div>
          <div className="ux-rail-item">
            <span className="ux-dot" />
            <div>
              <strong>华宸贸易合同纠纷代理·一审</strong>
              <small>PRJ-2026-00001</small>
            </div>
          </div>
          <div className="ux-rail-item">
            <span className="ux-dot" />
            <div>
              <strong>星澜科技常年法律顾问服务</strong>
              <small>PRJ-2026-00002</small>
            </div>
          </div>
          <p className="ux-rail-note">示意项目，仅演示分区语义；正式数据在项目空间页签内。</p>
        </aside>
        <main className="ux-main">
          <UxDemoPanels tab={tab} setTab={setTab} persona={persona} />
        </main>
      </div>

      {drawerOpen ? (
        <div className="ux-drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}>
          <nav className="ux-drawer" role="dialog" aria-modal="true" aria-label="主导航（移动）">
            <div className="ux-drawer-head">
              <span>NAVIGATION</span>
              <button className="ux-icon" aria-label="关闭抽屉" onClick={() => setDrawerOpen(false)}>
                ×
              </button>
            </div>
            {GROUPS.map((g) => {
              const items = visibleItems(g, persona);
              if (items.length === 0) return null;
              return (
                <div className="ux-drawer-group" key={g.key}>
                  <span className="section-label">{g.label}</span>
                  {items.map((item) => (
                    <button
                      key={item.key}
                      className={tab === item.tab && activeGroup === g.key ? "current" : ""}
                      onClick={() => go(item.tab, g.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              );
            })}
            <div className="ux-drawer-group">
              <span className="section-label">系统</span>
              {avatarVisible.map((item) => (
                <button
                  key={item.key}
                  className={item.danger ? "danger" : ""}
                  onClick={() => {
                    if (item.tab) go(item.tab, null);
                    setDrawerOpen(false);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </nav>
        </div>
      ) : null}
    </div>
  );
}
