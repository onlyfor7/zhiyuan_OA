import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { ChevronDown, ChevronRight } from "lucide-react";

import { activeGroupKey, NAV_TREE, type NavGroup } from "./topnav-config";

/**
 * 迭代 9a 新 IA：顶栏 8 组级联气泡（arch/12 §2.2）。
 * hover 120ms/点击开一级气泡（fixed 悬浮顶栏下方）；悬停二级分组右侧飞出三级；
 * 移出链 200ms/Esc/外点关闭；键盘 Enter/Space 开、↑↓ 移、→ 进子级、← 回父级。
 */

interface OpenState {
  groupKey: string;
  sectionIdx: number | null;
}

function CascadeGroup({
  group,
  open,
  onOpen,
  onOpenSection,
  onClose,
}: {
  group: NavGroup;
  open: OpenState | null;
  onOpen: (key: string) => void;
  onOpenSection: (key: string, si: number) => void;
  onClose: () => void;
}) {
  const location = useLocation();
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

  useEffect(() => {
    if (!isOpen || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const barBottom = triggerRef.current.closest(".topbar")?.getBoundingClientRect().bottom ?? r.bottom;
    setL1Pos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 320)), top: barBottom + 4 });
  }, [isOpen]);

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
    const left = l1Ref.current.getBoundingClientRect().right + 2;
    setL2Pos({ left: Math.min(left, window.innerWidth - 340), top: r.top });
  }, [hoverSection]);

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
          requestAnimationFrame(() => {
            l2Ref.current?.querySelector<HTMLElement>("[data-leaf]")?.focus();
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
  }, [isOpen, group.key, hoverSection, onClose, onOpenSection]);

  const itemCurrent = (to: string) => {
    const base = to.split("?")[0];
    return location.pathname.startsWith(base);
  };

  return (
    <div className="p9a-dd" onMouseLeave={scheduleClose} onMouseEnter={cancelClose}>
      <button
        ref={triggerRef}
        className={`p9a-dd-trigger ${activeGroupKey(location.pathname) === group.key ? "active" : ""}`}
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
                <Link
                  key={item.to + item.label}
                  role="menuitem"
                  data-leaf
                  to={item.to}
                  className={`p9a-bubble-leaf ${itemCurrent(item.to) ? "current" : ""}`}
                  onClick={onClose}
                >
                  <strong>{item.label}</strong>
                  <small>{item.desc}</small>
                </Link>
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
                  onOpenSection(group.key, si);
                }}
                onFocus={() => onOpenSection(group.key, si)}
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
            <Link
              key={item.to + item.label}
              role="menuitem"
              data-leaf
              to={item.to}
              className={`p9a-bubble-leaf ${itemCurrent(item.to) ? "current" : ""}`}
              onClick={onClose}
            >
              <strong>{item.label}</strong>
              <small>{item.desc}</small>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 顶栏 8 组级联气泡导航（角色过滤：无权限组不渲染） */
export function CascadeNav({ globalRoles }: { globalRoles: string[] }) {
  const [open, setOpen] = useState<OpenState | null>(null);
  const onOpen = (key: string) => setOpen((prev) => ({ groupKey: key, sectionIdx: prev?.groupKey === key ? prev.sectionIdx : null }));
  const onOpenSection = (key: string, si: number) => setOpen({ groupKey: key, sectionIdx: si });
  const onClose = () => setOpen(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = () => {
      if (!document.querySelector(".p9a-bubble:hover, .p9a-dd:hover")) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const groups = NAV_TREE
    .map((g) => ({
      ...g,
      sections: g.sections
        .filter((sec) => !sec.roles || sec.roles.some((r) => globalRoles.includes(r)))
        .map((sec) => ({ ...sec, items: sec.items.filter((i) => !i.roles || i.roles.some((r) => globalRoles.includes(r))) }))
        .filter((sec) => sec.items.length > 0),
    }))
    .filter((g) => (!g.roles || g.roles.some((r) => globalRoles.includes(r))) && g.sections.length > 0);

  return (
    <nav className="p9a-groups topnav-groups" aria-label="一级功能组（级联气泡）">
      {groups.map((g) => (
        <CascadeGroup key={g.key} group={g} open={open} onOpen={onOpen} onOpenSection={onOpenSection} onClose={onClose} />
      ))}
    </nav>
  );
}
