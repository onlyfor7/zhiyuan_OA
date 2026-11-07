import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { type DomainKey } from "../../lib/icons";
import { DomainIconBlock } from "../../lib/DomainIconBlock";

/**
 * /preview-tabs 多页签工作区原型（arch/12 §15，iter10-02 用户确认门）。
 * 静态示意+徽标：36px 页签条（§4.4 图标+标题+关闭×/激活高亮/拖拽排序/中键关/右键菜单/溢出横滚/驾驶舱固定首签）
 * + keep-alive 切换演示（表单草稿/滚动位置保留——离屏 visibility 不卸载）+ sessionStorage 刷新恢复。
 * 确认后全量接入：路由级开签/同路由复用/项目空间单签/登录与弹窗不进签/375 不出签条。
 */

interface DemoTab {
  id: string;
  title: string;
  domain: DomainKey;
  fixed?: boolean;
  pane: "cockpit" | "approvals" | "report" | "customer" | "scroll" | "generic";
}

const DEFAULT_TABS: DemoTab[] = [
  { id: "cockpit", title: "驾驶舱", domain: "home", fixed: true, pane: "cockpit" },
  { id: "approvals", title: "审批中心", domain: "approval", pane: "approvals" },
  { id: "customer", title: "客户 · GD（虚构）", domain: "customer", pane: "customer" },
  { id: "report", title: "报表工作台", domain: "report", pane: "report" },
  { id: "scroll", title: "滚动演示页", domain: "task", pane: "scroll" },
];

const STORE_KEY = "lexflow-preview-tabs";
const GENERIC_DOMAINS: DomainKey[] = ["project", "finance", "meeting", "quality", "contract", "lead", "opportunity", "expense"];

function loadSession(): { tabs: DemoTab[]; active: string } | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "null");
    if (raw && Array.isArray(raw.tabs) && raw.tabs.length > 0 && typeof raw.active === "string") return raw;
  } catch { /* 坏数据忽略 */ }
  return null;
}

export default function PreviewTabsPage() {
  const [restored] = useState(() => loadSession());
  const [tabs, setTabs] = useState<DemoTab[]>(restored?.tabs ?? DEFAULT_TABS);
  const [active, setActive] = useState(restored?.active ?? "cockpit");
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const [genericSeq, setGenericSeq] = useState(1);

  // sessionStorage 恢复（刷新页签集+激活页回当前路由的示意：原型以激活 id 代替）
  useEffect(() => {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ tabs, active }));
  }, [tabs, active]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return; // 菜单内点击不关闭（按钮 click 先行）
      setMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const activate = (id: string) => setActive(id);
  const closeTab = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (!t || t.fixed) return;
    const idx = tabs.findIndex((x) => x.id === id);
    setTabs((prev) => prev.filter((x) => x.id !== id));
    if (active === id) {
      const next = tabs[idx + 1] ?? tabs[idx - 1];
      setActive((next && next.id !== id ? next : tabs[0]).id);
    }
  };
  const closeOthers = (id: string) => {
    setTabs((prev) => prev.filter((x) => x.fixed || x.id === id));
    setActive(id);
  };
  const closeAll = () => {
    setTabs((prev) => prev.filter((x) => x.fixed));
    setActive("cockpit");
  };
  const openGeneric = (n = 1) => {
    const created: DemoTab[] = Array.from({ length: n }, (_, i) => {
      const seq = genericSeq + i;
      return {
        id: `g${Date.now()}_${i}`,
        title: `示例页 ${seq}`,
        domain: GENERIC_DOMAINS[seq % GENERIC_DOMAINS.length],
        pane: "generic" as const,
      };
    });
    setGenericSeq((s) => s + n);
    setTabs((prev) => [...prev, ...created]);
    setActive(created[created.length - 1].id);
  };
  const onDrop = (targetId: string) => {
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === targetId) return;
    setTabs((prev) => {
      const fromIdx = prev.findIndex((x) => x.id === from);
      const toIdx = prev.findIndex((x) => x.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };
  const reset = () => {
    sessionStorage.removeItem(STORE_KEY);
    setTabs(DEFAULT_TABS);
    setActive("cockpit");
    setGenericSeq(1);
  };

  return (
    <div className="ptabs-app">
      {/* 示意顶栏（原型自包含，非真实导航） */}
      <div className="ptabs-topbar">
        <span className="ptabs-brand">因诺智元 · 业务管理平台</span>
        <span className="ptabs-nav">总览 / 客户 / 项目 / 协同 / 经营 / 报表 / 办公 / 治理</span>
        <span className="preview-badge">原型预览</span>
      </div>

      {/* §15 页签条：顶栏下 36px */}
      <div className="ptabs-bar" role="tablist" aria-label="工作区页签">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            className={`ptabs-tab ${active === t.id ? "active" : ""}`}
            draggable
            onDragStart={() => { dragId.current = t.id; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(t.id)}
            onClick={() => activate(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id); // 中键关闭
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, tabId: t.id });
            }}
            title={`${t.title}（右键更多操作）`}
          >
            <DomainIconBlock domain={t.domain} size={20} iconSize={12} />
            <span className="ptabs-tab-title">{t.title}</span>
            {t.fixed ? <span className="ptabs-fixed-mark" title="固定首签：驾驶舱常驻不可关闭">⌂</span> : (
              <button
                type="button"
                className="ptabs-close"
                aria-label={`关闭 ${t.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      {menu ? (
        <div className="ptabs-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }} role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button role="menuitem" onClick={() => { activate(menu.tabId); setMenu(null); }}>激活该页签</button>
          <button role="menuitem" onClick={() => { closeOthers(menu.tabId); setMenu(null); }}>关闭其他</button>
          <button role="menuitem" onClick={() => { closeAll(); setMenu(null); }}>关闭全部（保留驾驶舱）</button>
        </div>
      ) : null}

      {/* 原型工具条（静态示意说明） */}
      <div className="ptabs-toolbar">
        <button className="secondary-action" onClick={() => openGeneric(1)}>打开示例页（开签）</button>
        <button className="secondary-action" onClick={() => openGeneric(8)}>批量开 8 页（溢出横滚演示）</button>
        <button className="secondary-action" onClick={reset}>重置演示</button>
        <span className="toolbar-hint">keep-alive：切走再切回——表单草稿与滚动位置均保留；刷新页面经 sessionStorage 恢复页签集。</span>
      </div>

      {/* keep-alive 面板：全部挂载，离屏 visibility 隐藏（不卸载=草稿/滚动位置保留） */}
      <div className="ptabs-panes">
        {tabs.map((t) => (
          <section key={t.id} className={`ptabs-pane ${active === t.id ? "" : "pane-hidden"}`} aria-hidden={active !== t.id}>
            <PaneContent tab={t} />
          </section>
        ))}
        {tabs.length === 0 ? <p className="list-note">无页签。</p> : null}
      </div>

      <p className="preview-note ptabs-note">
        静态示意：确认门后全量接入——路由级开签（同路由复用激活）/项目空间单签（内部 14 页签嵌套不动）/登录页与弹窗不进签/375 移动端不出页签条（本原型 375 下签条自动隐藏）。驾驶舱为固定首签不可关闭。
      </p>
    </div>
  );
}

/** 面板内容（示意数据） */
function PaneContent({ tab }: { tab: DemoTab }) {
  if (tab.pane === "customer") return <CustomerFormPane />;
  if (tab.pane === "scroll") return <ScrollPane />;
  if (tab.pane === "approvals") return <MockListPane eyebrow="APPROVAL CENTER" title="审批中心（示意）" rows={["出差借款会签 · TRV-2026-00002", "经费申请 · FND-2026-00001", "报销单 · EXP-2026-00003"]} />;
  if (tab.pane === "report") return <MockListPane eyebrow="REPORTS" title="报表工作台（示意）" rows={["项目收支核算表", "收款账龄分析", "工时汇总"]} />;
  if (tab.pane === "cockpit") return <MockListPane eyebrow="COCKPIT" title="驾驶舱（固定首签）" rows={["问候卡 · 快捷入口", "项目脉搏 6 卡", "待办清单（分页承载）"]} />;
  return <MockListPane eyebrow="DEMO" title={`${tab.title}（示意页）`} rows={["同路由不重复开签（全量接入时生效）", "拖拽页签可排序", "中键或右键关闭"]} />;
}

/** keep-alive 演示一：表单草稿（切走再切回不丢） */
function CustomerFormPane() {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  return (
    <div className="ptabs-mock">
      <span className="eyebrow">CRM · CUSTOMER（keep-alive 演示一）</span>
      <h2>客户编辑（草稿保留）</h2>
      <label className="form-field">
        <span>客户名称</span>
        <input value={name} placeholder="在此输入后切到其他页签…" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="form-field">
        <span>备注</span>
        <textarea rows={3} value={note} placeholder="再切回本页，草稿仍在。" onChange={(e) => setNote(e.target.value)} />
      </label>
      <p className="context-note">已输入：名称 {name.length} 字 / 备注 {note.length} 字（组件离屏不卸载）。</p>
    </div>
  );
}

/** keep-alive 演示二：滚动位置保留 */
function ScrollPane() {
  const rows = Array.from({ length: 60 }, (_, i) => `滚动行 ${i + 1} · 滚到中部后切页再切回，位置不变`);
  return (
    <div className="ptabs-mock ptabs-scroll-pane">
      <span className="eyebrow">SCROLL · KEEP-ALIVE（演示二）</span>
      <h2>长列表（滚动位置保留）</h2>
      <div className="ptabs-scroll-list">
        {rows.map((r) => <p className="ptabs-scroll-row" key={r}>{r}</p>)}
      </div>
    </div>
  );
}

function MockListPane({ eyebrow, title, rows }: { eyebrow: string; title: string; rows: string[] }) {
  return (
    <div className="ptabs-mock">
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {rows.map((r) => <p className="ptabs-scroll-row" key={r}>{r}</p>)}
    </div>
  );
}
