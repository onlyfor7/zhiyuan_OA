import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { X } from "lucide-react";

import { AccessErrorBoundary } from "../AccessErrorBoundary";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { AppRoutes, type RoutesLocation } from "./AppRoutes";
import { tabMeta } from "./tabsMeta";
import { WorkspaceTabsContext, type WsTab, type WorkspaceTabsApi } from "./workspace-tabs-context";

/**
 * 多页签工作区（arch/12 §15 全量接入）：
 * 路由级开签（同路由复用激活不重复开）/驾驶舱固定首签/keep-alive（查询走 react-query 缓存、
 * 滚动位置与表单草稿保留——页签内容不卸载）/sessionStorage 刷新恢复/中键与右键关闭/拖拽排序/溢出横滚。
 * 项目空间=单个全局页签（内部页签嵌套不动）；登录页与弹窗不进签（不经路由）；375 不渲染签条（CSS）。
 * 路由→页签同步用「渲染期派生状态」模式（非 effect setState，满足 react-hooks/set-state-in-effect）。
 */

const STORE_KEY = "lexflow-workspace-tabs-v1";

interface WsState {
  tabs: WsTab[];
  activeKey: string;
  /** 已同步到的路由（渲染期比对，变化即派生更新） */
  full: string;
}

function parsePath(full: string): RoutesLocation {
  const hashIdx = full.indexOf("#");
  const noHash = hashIdx >= 0 ? full.slice(0, hashIdx) : full;
  const qIdx = noHash.indexOf("?");
  return {
    pathname: qIdx >= 0 ? noHash.slice(0, qIdx) : noHash,
    search: qIdx >= 0 ? noHash.slice(qIdx) : "",
    hash: "",
  };
}

function validTab(t: unknown): t is WsTab {
  const o = t as WsTab;
  return !!o && typeof o.key === "string" && typeof o.location === "string" && typeof o.title === "string";
}

function loadStore(): WsState | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "null");
    if (raw && Array.isArray(raw.tabs) && raw.tabs.every(validTab) && typeof raw.activeKey === "string") {
      return { tabs: raw.tabs, activeKey: raw.activeKey, full: "" };
    }
  } catch { /* 坏数据忽略 */ }
  return null;
}

function upsert(tabs: WsTab[], full: string): { tabs: WsTab[]; key: string } {
  const meta = tabMeta(parsePath(full).pathname);
  const existing = tabs.find((t) => t.key === meta.key);
  if (existing) {
    return {
      key: meta.key,
      tabs: tabs.map((t) => {
        if (t.key !== meta.key) return t;
        // dynamicTitle 必须全程携带（新建/恢复/路由同步三处），否则项目空间签标题在重载后被路由默认值覆盖
        const dyn = t.dynamicTitle ?? meta.dynamicTitle;
        return { ...t, location: full, domain: meta.domain, dynamicTitle: dyn, title: dyn ? t.title : meta.title };
      }),
    };
  }
  return {
    key: meta.key,
    tabs: [...tabs, { key: meta.key, title: meta.title, domain: meta.domain, location: full, ...(meta.dynamicTitle ? { dynamicTitle: true } : {}) }],
  };
}

function initialState(full: string): WsState {
  const cockpit: WsTab = { key: "cockpit", title: "驾驶舱", domain: "home", location: "/cockpit", fixed: true };
  const stored = loadStore();
  const base = stored?.tabs ?? [];
  let tabs = [cockpit, ...base.filter((t) => t.key !== "cockpit")];
  const u = upsert(tabs, full);
  tabs = u.tabs;
  // 当前路由即激活页（刷新场景 URL=原激活签；goto 新地址场景新路由胜出生效）
  return { tabs, activeKey: u.key, full };
}

export function WorkspaceShell({ rail, from }: { rail: ReactNode; from: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const full = location.pathname + location.search;
  const [{ tabs, activeKey }, setState] = useState<WsState>(() => initialState(full));
  // 懒挂载：仅本会话激活过的页签才挂载内容（刷新恢复的页签集先占位，点击签再加载）——
  // 防止多次重登/重载后所有历史页签同时挂载造成的加载风暴
  const [visited, setVisited] = useState<Set<string>>(() => new Set([initialState(full).activeKey]));
  const markVisited = useCallback((key: string) => setVisited((v) => (v.has(key) ? v : new Set(v).add(key))), []);
  const [menu, setMenu] = useState<{ x: number; y: number; tabKey: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dragKey = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const scrollMap = useRef(new Map<string, number>());
  const restoring = useRef(false);

  // 路由 → 页签：开签/复用激活。effect 同步（每导航仅一次 setState，依赖 [full] 收敛；
  // 渲染期派生写法在 StrictMode 双渲染下触发级联，实测弃用）。
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 导航驱动的页签同步：markVisited 幂等 + s.full 守卫原样返回，收敛不级联 */
    markVisited(upsert(tabs, full).key); // key 为 full 的纯函数；签集数组走函数式更新防竞态
    setState((s) => {
      if (s.full === full) return s;
      const u = upsert(s.tabs, full);
      return { tabs: u.tabs, activeKey: u.key, full };
    });
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [full, tabs, markVisited]);

  const setTabs = (fn: (prev: WsTab[]) => WsTab[]) => setState((s) => ({ ...s, tabs: fn(s.tabs) }));

  // sessionStorage 恢复集（每次变化落盘）
  useEffect(() => {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ tabs, activeKey }));
  }, [tabs, activeKey]);

  // 滚动位置：切签保存/恢复（main-workspace 为唯一滚动容器）
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!restoring.current) scrollMap.current.set(activeKey, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeKey]);
  useEffect(() => {
    restoring.current = true;
    const raf = requestAnimationFrame(() => {
      const el = mainRef.current;
      if (el) el.scrollTop = scrollMap.current.get(activeKey) ?? 0;
      requestAnimationFrame(() => {
        restoring.current = false;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeKey]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const activate = (key: string) => {
    const t = tabs.find((x) => x.key === key);
    if (!t) return;
    markVisited(key);
    if (key !== activeKey) navigate(t.location);
    setState((s) => ({ ...s, activeKey: key }));
  };

  const closeTab = (key: string) => {
    const t = tabs.find((x) => x.key === key);
    if (!t || t.fixed) return;
    const idx = tabs.findIndex((x) => x.key === key);
    const next = tabs[idx + 1] ?? tabs[idx - 1];
    setTabs((prev) => prev.filter((x) => x.key !== key));
    if (activeKey === key) navigate(next ? next.location : "/cockpit");
  };

  const closeOthers = (key: string) => {
    setTabs((prev) => prev.filter((x) => x.fixed || x.key === key));
    activate(key);
  };

  const closeAll = () => {
    setTabs((prev) => prev.filter((x) => x.fixed));
    navigate("/cockpit");
  };

  const renameTab = (key: string, title: string) => {
    // 标题未变返回同引用——否则 useMemo(api) 身份变化会让消费方 effect 无限级联
    setTabs((prev) => {
      const t = prev.find((x) => x.key === key);
      if (!t || !title || t.title === title) return prev;
      return prev.map((x) => (x.key === key ? { ...x, title } : x));
    });
  };

  const api: WorkspaceTabsApi = useMemo(
    () => ({ tabs, activeKey, activate, closeTab, closeOthers, closeAll, renameTab }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 回调经 useState 函数式更新自愈，仅随 tabs/activeKey 失效
    [tabs, activeKey],
  );

  const onDrop = (targetKey: string) => {
    const fromKey = dragKey.current;
    dragKey.current = null;
    if (!fromKey || fromKey === targetKey) return;
    setTabs((prev) => {
      const fromIdx = prev.findIndex((x) => x.key === fromKey);
      const toIdx = prev.findIndex((x) => x.key === targetKey);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  return (
    <WorkspaceTabsContext.Provider value={api}>
      <div className="ws-bar" role="tablist" aria-label="工作区页签">
        {tabs.map((t) => (
          <div
            key={t.key}
            role="tab"
            aria-selected={activeKey === t.key}
            className={`ws-tab ${activeKey === t.key ? "active" : ""}`}
            draggable
            onDragStart={() => {
              dragKey.current = t.key;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(t.key)}
            onClick={() => activate(t.key)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.key);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, tabKey: t.key });
            }}
            title={`${t.title}（拖拽排序 · 中键/右键关闭）`}
          >
            <DomainIconBlock domain={t.domain} size={20} iconSize={12} />
            <span className="ws-tab-title">{t.title}</span>
            {t.fixed ? (
              <span className="ws-fixed-mark" title="驾驶舱常驻，不可关闭">⌂</span>
            ) : (
              <button
                type="button"
                className="ws-close"
                aria-label={`关闭 ${t.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.key);
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      {menu ? (
        <div
          className="ws-menu"
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button role="menuitem" onClick={() => { activate(menu.tabKey); setMenu(null); }}>激活该页签</button>
          <button role="menuitem" onClick={() => { closeOthers(menu.tabKey); setMenu(null); }}>关闭其他</button>
          <button role="menuitem" onClick={() => { closeAll(); setMenu(null); }}>关闭全部（保留驾驶舱）</button>
        </div>
      ) : null}

      <div className="app-body no-rail">
        <main className="main-workspace" ref={mainRef}>
          {tabs.map((t) => (
            <TabPane key={t.key} tab={t} active={t.key === activeKey} mounted={visited.has(t.key)} from={from} />
          ))}
        </main>
        {rail}
      </div>
    </WorkspaceTabsContext.Provider>
  );
}

/** 单个页签面板：keep-alive——组件不卸载，离屏 visibility 冻结（草稿/滚动/查询缓存全保留）。
 *  懒挂载：未访问过的页签（刷新恢复的签集）先占位，首次激活才加载内容。 */
const TabPane = memo(function TabPane({ tab, active, mounted, from }: { tab: WsTab; active: boolean; mounted: boolean; from: string }) {
  const loc = useMemo(() => parsePath(tab.location), [tab.location]);
  const element = useMemo(() => <AppRoutes location={loc} />, [loc]);
  return (
    <div className={`ws-pane ${active ? "is-active" : "is-hidden"}`} aria-hidden={!active}>
      {mounted ? (
        <AccessErrorBoundary key={loc.pathname} from={from}>{element}</AccessErrorBoundary>
      ) : (
        <div className="ws-pane-placeholder">
          <span className="section-label">WORKSPACE TAB</span>
          <p className="list-note">「{tab.title}」尚未加载——点击该页签加载（刷新后仅恢复页签集，内容随首访加载）。</p>
        </div>
      )}
    </div>
  );
});
