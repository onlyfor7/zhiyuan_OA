import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, ChevronDown, Search } from "lucide-react";

import { NAV_TREE, PERSONA_LABEL, type DemoTarget, type NavGroup } from "./nav-tree";
import { DemoPanel } from "./DemoPages";
import { FormsPanel } from "./FormParadigms";
import "./p9a.css";

/**
 * 迭代 9a 平台壳高保真原型（/preview-9a 隔离，静态示意）。
 * 品牌「因诺智元业务管理平台」（arch/12 §1.1）；顶栏 8 组 mega menu（§2.1 功能树逐字、§2.2 交互规范）；
 * 视口锁定：主区 calc(100vh-56px) overflow:hidden（H1/H2 由 T-A/T-C 样例页证明）。
 */

interface DemoState {
  target: DemoTarget;
  label: string;
  groupKey: string;
}

function BrandMark() {
  return (
    <span className="p9a-brandmark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function MegaMenu({
  group,
  open,
  active,
  onToggle,
  onClose,
  onPick,
}: {
  group: NavGroup;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  onClose: () => void;
  onPick: (item: { name: string; route: string; demo: DemoTarget }) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const sections = group.sections.filter((sec) => sec.items.length > 0);

  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>("[role=menuitem]");
    first?.focus();
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      const items = [...(panelRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
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
    <div className="p9a-dd" ref={rootRef}>
      <button
        ref={btnRef}
        className={`p9a-dd-trigger ${active ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        {group.label}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="p9a-mega" role="menu" ref={panelRef} aria-label={`${group.label}菜单`}>
          {sections.map((sec) => (
            <div className="p9a-mega-col" key={sec.name || "_"}>
              {sec.name ? <span className="p9a-mega-head">{sec.name}</span> : null}
              {sec.items.map((item) => (
                <button
                  key={item.route + item.name}
                  role="menuitem"
                  className="p9a-mega-item"
                  onClick={() => {
                    onPick({ name: item.name, route: item.route, demo: item.demo });
                    onClose();
                  }}
                >
                  <strong>{item.name}</strong>
                  <small>{item.desc}</small>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function Shell9a() {
  const [persona, setPersona] = useState("sysadmin");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [demo, setDemo] = useState<DemoState>({ target: { kind: "t-c" }, label: "驾驶舱", groupKey: "overview" });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeMenus = useCallback(() => setOpenMenu(null), []);

  const visibleGroups = NAV_TREE
    .map((g) => ({
      ...g,
      sections: g.sections
        .filter((sec) => !sec.roles || sec.roles.includes(persona))
        .map((sec) => ({ ...sec, items: sec.items.filter((i) => !i.roles || i.roles.includes(persona)) }))
        .filter((sec) => sec.items.length > 0),
    }))
    .filter((g) => !g.roles || g.roles.includes(persona))
    .filter((g) => g.sections.length > 0);

  const pick = (item: { name: string; route: string; demo: DemoTarget }, groupKey: string) => {
    setDemo({ target: item.demo, label: item.name, groupKey });
    setDrawerOpen(false);
  };

  return (
    <div className="p9a-app">
      <span className="preview-badge" role="note">原型预览 · 静态示意 · 未接入真实数据</span>
      <div className="ux-persona-bar p9a-persona">
        <span>演示角色（角色过滤）：</span>
        {Object.keys(PERSONA_LABEL).map((p) => (
          <button key={p} className={persona === p ? "active" : ""} onClick={() => setPersona(p)}>
            {PERSONA_LABEL[p]}
          </button>
        ))}
        <em>member 不见「客户/报表」组；治理-组织管理/系统配置仅 sysadmin</em>
      </div>

      <header className="p9a-topbar">
        <div className="p9a-brand">
          <BrandMark />
          <div>
            <strong>因诺智元</strong>
            <span>业务管理平台</span>
          </div>
        </div>
        <nav className="p9a-groups" aria-label="一级功能组（mega menu）">
          {visibleGroups.map((g) => (
            <MegaMenu
              key={g.key}
              group={g}
              open={openMenu === g.key}
              active={demo.groupKey === g.key}
              onToggle={() => setOpenMenu(openMenu === g.key ? null : g.key)}
              onClose={closeMenus}
              onPick={(item) => pick(item, g.key)}
            />
          ))}
        </nav>
        <div className="p9a-top-actions">
          <button className="p9a-search" aria-label="全局搜索（示意）">
            <Search size={15} />
            <span>搜索项目、客户、合同、报销…</span>
            <kbd>⌘ K</kbd>
          </button>
          <button className="p9a-icon" aria-label="通知（示意）">
            <Bell size={17} />
          </button>
          <button className="p9a-icon" aria-label="打开导航抽屉" onClick={() => setDrawerOpen(true)}>
            ☰
          </button>
        </div>
      </header>

      {/* H1：主区视口锁定，零页面级滚动 */}
      <main className="p9a-main">
        {demo.target.kind === "t-c" ? <DemoPanel kind="t-c" title={demo.label} /> : null}
        {demo.target.kind === "t-a" ? <DemoPanel kind="t-a" title={demo.label} /> : null}
        {demo.target.kind === "token" ? <DemoPanel kind="token" title={demo.label} /> : null}
        {demo.target.kind === "micro" ? <DemoPanel kind="micro" title={demo.label} /> : null}
        {demo.target.kind === "forms" ? <FormsPanel title={demo.label} /> : null}
        {demo.target.kind === "placeholder" ? (
          <section className="p9a-placeholder-card">
            <span className="section-label">即将上线 · {demo.target.domain}</span>
            <h1>{demo.label}</h1>
            <p>{demo.target.note}</p>
            <p className="context-note">所属域：{demo.target.domain}——按 arch/12 迭代切分在对应子迭代（9b/9c/9d/9e）落地；本原型不建空页面。</p>
          </section>
        ) : null}
      </main>

      {drawerOpen ? (
        <div className="ux-drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}>
          <nav className="ux-drawer" role="dialog" aria-modal="true" aria-label="主导航（移动）">
            <div className="ux-drawer-head">
              <span>NAVIGATION · 因诺智元</span>
              <button className="p9a-icon" aria-label="关闭抽屉" onClick={() => setDrawerOpen(false)}>×</button>
            </div>
            {visibleGroups.map((g) => (
              <div className="ux-drawer-group" key={g.key}>
                <span className="section-label">{g.label}</span>
                {g.sections.flatMap((sec) =>
                  sec.items.map((item) => (
                    <button
                      key={item.route + item.name}
                      className={demo.label === item.name ? "current" : ""}
                      onClick={() => pick({ name: item.name, route: item.route, demo: item.demo }, g.key)}
                    >
                      {item.name}
                    </button>
                  )),
                )}
              </div>
            ))}
          </nav>
        </div>
      ) : null}
    </div>
  );
}
