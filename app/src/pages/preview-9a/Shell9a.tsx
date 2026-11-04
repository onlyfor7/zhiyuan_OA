import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, Bell, Building2, Calculator, ChevronDown, ChevronRight, Clock, Search, Users } from "lucide-react";

import { NAV_TREE, PERSONA_LABEL, type DemoTarget, type NavGroup } from "./nav-tree";
import { DemoPanel } from "./DemoPages";
import { FormsPanel } from "./FormParadigms";
import "./p9a.css";

/**
 * 迭代 9a 平台壳原型 v2（arch/12 v1.2 用户裁定修订）：
 * §2.2 级联气泡菜单（替代 mega 面板）+ §4.1 视觉折中（白底/去描边/净行/柔影/圆角 8）。
 * 视口锁定 H1/H2、密度 token、微交互 M1–M7 全部保留。
 */

interface DemoState {
  target: DemoTarget;
  label: string;
  groupKey: string;
}

interface OpenState {
  groupKey: string;
  /** 一级面板悬停的二级分组序号（无分组组恒 null） */
  sectionIdx: number | null;
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

/** §2.2：级联气泡——一级面板固定悬浮顶栏下方；二级右侧飞出；指针移出链 200ms 关闭 */
function CascadeGroup({
  group,
  open,
  active,
  onOpen,
  onOpenSection,
  onClose,
  onPick,
}: {
  group: NavGroup;
  open: OpenState | null;
  active: boolean;
  onOpen: (key: string) => void;
  onOpenSection: (key: string, si: number) => void;
  onClose: () => void;
  onPick: (item: { name: string; route: string; demo: DemoTarget }, groupKey: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const l1Ref = useRef<HTMLDivElement>(null);
  const l2Ref = useRef<HTMLDivElement>(null);
  const [l1Pos, setL1Pos] = useState<{ left: number; top: number } | null>(null);
  const [l2Pos, setL2Pos] = useState<{ left: number; top: number } | null>(null);
  const closeTimer = useRef<number | null>(null);
  const isOpen = open?.groupKey === group.key;
  const hoverSection = isOpen ? open.sectionIdx : null;
  const ungrouped = group.sections.length === 1 && group.sections[0].name === "";
  const sections = group.sections;

  const cancelClose = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => onClose(), 200);
  };

  const openGroup = () => {
    cancelClose();
    onOpen(group.key);
  };

  // 一级面板定位：贴顶栏下缘 +4px，不遮顶栏不推内容
  useEffect(() => {
    if (!isOpen || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const barBottom = triggerRef.current.closest(".p9a-topbar")?.getBoundingClientRect().bottom ?? r.bottom;
    setL1Pos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 320)), top: barBottom + 4 });
  }, [isOpen]);

  // 二级面板定位：一级右侧，行顶对齐
  useEffect(() => {
    if (hoverSection === null || !l1Ref.current) {
      setL2Pos(null);
      return;
    }
    const row = l1Ref.current.querySelectorAll<HTMLElement>("[data-section]")[hoverSection];
    if (!row) {
      setL2Pos(null);
      return;
    }
    const r = row.getBoundingClientRect();
    const l1Right = l1Ref.current.getBoundingClientRect().right;
    const left = l1Right + 2;
    setL2Pos({ left: Math.min(left, window.innerWidth - 340), top: r.top });
  }, [hoverSection]);

  // 键盘：Enter/Space 开（触发钮原生）；↑↓ 移动；→ 进子级；← 回父级；Esc 关闭回焦点
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const l1 = l1Ref.current;
      if (!l1) return;
      const items = [...l1.querySelectorAll<HTMLElement>("[data-section], [data-leaf]")];
      const idx = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        triggerRef.current?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        (items[idx + 1] ?? items[0])?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        (items[idx - 1] ?? items[items.length - 1])?.focus();
      } else if (e.key === "ArrowRight") {
        const el = document.activeElement as HTMLElement;
        const sec = el?.dataset.section;
        if (sec !== undefined) {
          e.preventDefault();
          onOpenSection(group.key, Number(sec));
          queueMicrotask(() => {
            requestAnimationFrame(() => {
              l2Ref.current?.querySelector<HTMLElement>("[data-leaf]")?.focus();
            });
          });
        }
      } else if (e.key === "ArrowLeft") {
        if (l2Ref.current?.contains(document.activeElement)) {
          e.preventDefault();
          l1.querySelectorAll<HTMLElement>("[data-section]")[hoverSection ?? 0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isOpen, group.key, hoverSection, onClose, onOpen, onOpenSection]);

  const pickItem = (item: { name: string; route: string; demo: DemoTarget }) => {
    cancelClose();
    onPick(item, group.key);
    onClose();
    triggerRef.current?.focus();
  };

  return (
    <div className="p9a-dd" onMouseLeave={scheduleClose} onMouseEnter={cancelClose}>
      <button
        ref={triggerRef}
        className={`p9a-dd-trigger ${active ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onMouseEnter={() => window.setTimeout(() => { if (!isOpen) openGroup(); }, 120)}
        onFocus={openGroup}
        onClick={openGroup}
      >
        {group.label}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {isOpen && l1Pos ? (
        <div
          className="p9a-bubble p9a-bubble-l1"
          role="menu"
          aria-label={`${group.label}菜单`}
          ref={l1Ref}
          style={{ left: l1Pos.left, top: l1Pos.top }}
        >
          {sections.map((sec, si) =>
            ungrouped ? (
              sec.items.map((item) => (
                <button
                  key={item.route + item.name}
                  role="menuitem"
                  data-leaf
                  className="p9a-bubble-leaf"
                  onClick={() => pickItem(item)}
                >
                  <strong>{item.name}</strong>
                  <small>{item.desc}</small>
                </button>
              ))
            ) : (
              <button
                key={sec.name}
                role="menuitem"
                data-section={si}
                className={`p9a-bubble-section ${hoverSection === si ? "hover" : ""}`}
                aria-haspopup={sec.items.length > 0 ? "menu" : undefined}
                aria-expanded={hoverSection === si}
                onMouseEnter={() => {
                  cancelClose();
                  onOpenWithSection(si);
                }}
                onFocus={() => onOpenWithSection(si)}
              >
                <span>{sec.name}</span>
                <ChevronRight size={13} aria-hidden="true" />
              </button>
            ),
          )}
        </div>
      ) : null}
      {isOpen && l2Pos && hoverSection !== null && sections[hoverSection] ? (
        <div
          className="p9a-bubble p9a-bubble-l2"
          role="menu"
          aria-label={sections[hoverSection].name}
          ref={l2Ref}
          style={{ left: l2Pos.left, top: l2Pos.top }}
          onMouseEnter={cancelClose}
        >
          {sections[hoverSection].items.map((item) => (
            <button
              key={item.route + item.name}
              role="menuitem"
              data-leaf
              className="p9a-bubble-leaf"
              onClick={() => pickItem(item)}
            >
              <strong>{item.name}</strong>
              <small>{item.desc}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );

  function onOpenWithSection(si: number) {
    cancelClose();
    onOpenSection(group.key, si);
  }
}

export default function Shell9a() {
  const [persona, setPersona] = useState("sysadmin");
  const [open, setOpen] = useState<OpenState | null>(null);
  const [demo, setDemo] = useState<DemoState>({ target: { kind: "t-c" }, label: "驾驶舱", groupKey: "overview" });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const appRef = useRef<HTMLDivElement>(null);

  const onOpen = useCallback((key: string) => setOpen((prev) => ({ groupKey: key, sectionIdx: prev?.groupKey === key ? prev.sectionIdx : null })), []);
  const onOpenSection = useCallback((key: string, si: number) => setOpen({ groupKey: key, sectionIdx: si }), []);
  const onClose = useCallback(() => setOpen(null), []);
  const closeChain = onClose;
  const pick = useCallback(
    (item: { name: string; route: string; demo: DemoTarget }, groupKey: string) => {
      setDemo({ target: item.demo, label: item.name, groupKey });
      setDrawerOpen(false);
    },
    [],
  );

  // 点击面板外关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = () => {
      if (!document.querySelector(".p9a-bubble:hover, .p9a-dd:hover")) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);

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

  return (
    <div className="p9a-app" ref={appRef}>
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
        <nav className="p9a-groups" aria-label="一级功能组（级联气泡）">
          {visibleGroups.map((g) => (
            <CascadeGroup
              key={g.key}
              group={g}
              open={open}
              active={demo.groupKey === g.key}
              onOpen={onOpen}
              onOpenSection={onOpenSection}
              onClose={closeChain}
              onPick={pick}
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

      {/* H1：主区视口锁定 */}
      <main className="p9a-main">
        {demo.target.kind === "t-c" ? <DemoPanel kind="t-c" title={demo.label} /> : null}
        {demo.target.kind === "t-a" ? <DemoPanel kind="t-a" title={demo.label} /> : null}
        {demo.target.kind === "token" ? <DemoPanel kind="token" title={demo.label} /> : null}
        {demo.target.kind === "micro" ? <DemoPanel kind="micro" title={demo.label} /> : null}
        {demo.target.kind === "forms" ? <FormsPanel title={demo.label} /> : null}
        {demo.target.kind === "placeholder" ? (
          <section className="p9a-placeholder-card">
            <span className="p9a-iconblock p9a-placeholder-icon" aria-hidden="true">
              {demo.target.domain.includes("CRM") ? <Users size={22} /> :
                demo.target.domain.includes("报表") ? <BarChart3 size={22} /> :
                demo.target.domain.includes("财务") ? <Calculator size={22} /> :
                demo.target.domain.includes("基础信息") ? <Building2 size={22} /> :
                <Clock size={22} />}
            </span>
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
                      onClick={() => pick(item, g.key)}
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
