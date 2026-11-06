import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { FileText, Wrench } from "lucide-react";

import { useDashboardSummary } from "../api/dashboard";
import { useProjectPreview } from "../api/project";
import { useMeetingList } from "../api/meeting";
import { useTravelList } from "../api/travel";
import { useApprovalsMine } from "../api/approval";
import { useShell } from "../components/shell-rail";
import { useTRPC } from "../lib/trpc";
import { DOMAIN_ICONS, domainColor, type DomainKey } from "../lib/icons";
import { DomainIconBlock } from "../lib/DomainIconBlock";
import { GLOBAL_ROLE_LABEL, LIFECYCLE_LABEL } from "../lib/labels";

/**
 * 迭代 9a 四象限驾驶舱（arch/12 v1.7 §1.3 全量接入版）。
 * 行 36%/64%、列 3fr/2fr 铺满；日程联动纯前端聚合（既有端点：会议/出差/项目计划任务与阶段），不新开 server 端点。
 */

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const pad = (n: number) => String(n).padStart(2, "0");
  const week = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  const hh = now.getHours();
  const greet = hh < 6 ? "夜深了" : hh < 12 ? "早上好" : hh < 14 ? "中午好" : hh < 18 ? "下午好" : "晚上好";
  return (
    <div className="p9a-clock">
      <strong>{pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}</strong>
      <span>{now.getFullYear()}-{pad(now.getMonth() + 1)}-{pad(now.getDate())} 星期{week} · {greet}</span>
    </div>
  );
}

interface ScheduleItem {
  domain: DomainKey;
  title: string;
  project: string;
  time: string;
}

const fmtDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtHm = (iso: string) => `${iso.slice(11, 16)}`;

/** 问候日程卡右区：月历（语义色圆点 ≤3）+ 点击日期联动当日安排（客户端聚合，默认今天） */
function GreetCalendar({ projectIdList }: { projectIdList: string[] }) {
  const trpc = useTRPC();
  const [now] = useState(() => new Date());
  const [selected, setSelected] = useState<string>(fmtDay(now));
  const meetings = useMeetingList({ mine: true });
  const travels = useTravelList({ mine: true });
  const plans = useQueries({
    queries: projectIdList.slice(0, 3).map((projectId) => ({
      ...trpc.plan.current.queryOptions({ projectId }),
      staleTime: 60_000,
    })),
  });

  const byDay = useMemo(() => {
    const map = new Map<string, ScheduleItem[]>();
    const push = (day: string, item: ScheduleItem) => map.set(day, [...(map.get(day) ?? []), item]);
    for (const m of meetings.data?.items ?? []) {
      if (!m.startAt) continue;
      push(fmtDay(new Date(m.startAt)), { domain: "meeting", title: m.subject, project: m.code, time: `${fmtHm(m.startAt)} 开始` });
    }
    for (const t of travels.data?.items ?? []) {
      const start = (t as { startAt?: string }).startAt;
      if (!start) continue;
      push(fmtDay(new Date(start)), { domain: "travel", title: `出差 · ${t.destination ?? t.code}`, project: t.code, time: `${fmtHm(start)} 起` });
    }
    for (const q of plans) {
      const plan = q.data;
      if (!plan) continue;
      const pname = projectIdList.length > 0 ? "项目计划" : "项目计划";
      for (const item of plan.items ?? []) {
        if (item.itemType === "task" && item.plannedEnd) {
          push(fmtDay(new Date(item.plannedEnd)), { domain: "task", title: item.name ?? "任务截止", project: pname, time: `${fmtHm(item.plannedEnd)} 截止` });
        }
        if (item.itemType === "stage" && item.plannedEnd) {
          push(fmtDay(new Date(item.plannedEnd)), { domain: "risk", title: `阶段节点 · ${item.name ?? ""}`, project: pname, time: "全天" });
        }
      }
    }
    return map;
  }, [meetings.data, travels.data, plans, projectIdList]);

  const year = now.getFullYear();
  const month = now.getMonth();
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  const week = ["一", "二", "三", "四", "五", "六", "日"];
  const todayStr = fmtDay(now);
  const schedule = byDay.get(selected) ?? [];
  const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}`;

  return (
    <div className="p9a-cal" aria-label="日历与当日日程">
      <div className="p9a-cal-head">{year} 年 {month + 1} 月</div>
      <div className="p9a-cal-grid" role="grid">
        {week.map((w) => (
          <span key={w} className="p9a-cal-wd">{w}</span>
        ))}
        {cells.map((d, i) => {
          const dayStr = d !== null ? `${monthPrefix}-${String(d).padStart(2, "0")}` : null;
          const dots = dayStr ? (byDay.get(dayStr) ?? []).slice(0, 3) : [];
          return (
            <button
              key={i}
              className={`p9a-cal-day ${dayStr === todayStr ? "today" : ""} ${dayStr === selected ? "selected" : ""}`}
              disabled={d === null}
              onClick={() => dayStr && setSelected(dayStr)}
            >
              {d ?? ""}
              {dots.length > 0 ? (
                <span className="p9a-cal-dots" aria-hidden="true">
                  {dots.map((it, di) => (
                    <i key={di} className="p9a-cal-dot" style={{ background: domainColor(it.domain) }} />
                  ))}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="p9a-schedule" aria-live="polite">
        <span className="section-label">{selected.slice(5).replace("-", " 月 ")} 日 · 当日安排（{schedule.length}）</span>
        <div className="p9a-schedule-list">
          {schedule.length === 0 ? (
            <p className="p9a-schedule-empty">当日无安排</p>
          ) : (
            schedule.map((it, i) => (
              <div className="p9a-schedule-row" key={i}>
                <DomainIconBlock domain={it.domain} size={22} iconSize={13} />
                <div className="p9a-queue-main">
                  <strong>{it.title}</strong>
                  <small>{it.project} · {it.time}</small>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const QUICK_ALL: Array<{ key: string; label: string; domain: DomainKey; to: string }> = [
  { key: "project", label: "新建项目", domain: "project", to: "/projects/new" },
  { key: "receipt", label: "登记收款", domain: "finance", to: "/operations/receipts" },
  { key: "request", label: "发起申请", domain: "approval", to: "/requests" },
  { key: "lead", label: "新建线索", domain: "lead", to: "/crm/leads" },
  { key: "invoice", label: "开具发票", domain: "finance", to: "/coming-soon?domain=finance&title=开具发票" },
  { key: "report", label: "写周报", domain: "report", to: "/coming-soon?domain=report&title=写周报" },
];
const QUICK_KEY = "lexflow-quick-config";

const BIZ_DOMAIN: Record<string, DomainKey> = {
  generic_request: "approval",
  travel: "travel",
  travel_change: "travel",
  expense: "expense",
  expense_adjustment: "expense",
  funding: "finance",
  budget: "finance",
  timesheet: "time",
  change_request: "risk",
  access_grant: "archive",
};

export default function CockpitPage() {
  const { me } = useShell();
  const dashboard = useDashboardSummary();
  const projects = useProjectPreview();
  const approvals = useApprovalsMine();
  const trpc = useTRPC();
  const [quickCfg, setQuickCfg] = useState<Array<{ key: string; visible: boolean }>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(QUICK_KEY) ?? "null");
      if (Array.isArray(raw) && raw.length === QUICK_ALL.length) return raw;
    } catch { /* 忽略坏数据 */ }
    return QUICK_ALL.map((q) => ({ key: q.key, visible: true }));
  });
  const [cfgOpen, setCfgOpen] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [todoTab, setTodoTab] = useState<"todo" | "delay">("todo");
  const [chip, setChip] = useState<"全部" | DomainKey>("全部");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const previewItems = projects.data?.items ?? [];
  const projectIdList = previewItems.map((p) => p.id);
  const overviews = useQueries({
    queries: previewItems.slice(0, 6).map((p) => ({
      ...trpc.project.overview.queryOptions({ projectId: p.id }),
      staleTime: 60_000,
    })),
  });

  const saveCfg = (next: typeof quickCfg) => {
    setQuickCfg(next);
    localStorage.setItem(QUICK_KEY, JSON.stringify(next));
  };

  const todoGroups = useMemo(() => {
    const map = new Map<DomainKey, Array<{ title: string; project: string; ago: string }>>();
    for (const item of approvals.data?.items ?? []) {
      const domain = BIZ_DOMAIN[item.instance.bizType] ?? "approval";
      const list = map.get(domain) ?? [];
      list.push({
        title: `${item.instance.code} · ${DOMAIN_ICONS[domain].label}`,
        project: item.instance.projectId ? `项目 ${item.instance.projectId.slice(0, 8)}` : "全局",
        ago: item.instance.submittedAt ? item.instance.submittedAt.slice(5, 16).replace("T", " ") : "—",
      });
      map.set(domain, list);
    }
    return [...map.entries()];
  }, [approvals.data]);
  const chips: Array<"全部" | DomainKey> = ["全部", ...todoGroups.map(([d]) => d)];
  const total = todoGroups.reduce((n, [, items]) => n + items.length, 0);
  const visibleGroups = todoGroups.filter(([d]) => chip === "全部" || d === chip);

  const s = dashboard.data;
  const roleBadges = (me.globalRoles ?? []).slice(0, 3);

  return (
    <div className="p9a-tc2 cockpit-real">
      {/* 左上 · 问候日程卡：左 45% 时钟/身份/指标；右 55% 月历+日程联动 */}
      <div className="p9a-q p9a-q-greet">
        <div className="p9a-greet-main">
          <LiveClock />
          <h1>
            {new Date().getHours() < 12 ? "早上好" : new Date().getHours() < 18 ? "下午好" : "晚上好"}，{me.user.name}。
          </h1>
          <p className="p9a-person-line">
            <strong>{me.user.name}</strong>
            {me.user.position ? ` · ${me.user.position}` : ""}
            {me.user.orgUnit ? ` · ${me.user.orgUnit.name}` : ""}
            {roleBadges.map((r) => (
              <span key={r} className="p9a-role-badge">{GLOBAL_ROLE_LABEL[r] ?? r}</span>
            ))}
          </p>
          <p className="context-note">项目组合与待处理事项来自实时聚合。</p>
          <div className="p9a-mini-metrics">
            <span><strong>{s?.projects.total ?? "—"}</strong>项目</span>
            <span><strong>{s?.pendingApprovals ?? "—"}</strong>待批</span>
            <span><strong>{s?.pendingDecisions ?? "—"}</strong>待决策</span>
            <span><strong>{s?.projects.warning ?? "—"}</strong>预警</span>
          </div>
        </div>
        <GreetCalendar projectIdList={projectIdList} />
      </div>

      {/* 右上 · 快捷入口（左上对齐密集流排，可自定义） */}
      <div className="p9a-q p9a-q-quick">
        <div className="p9a-q-head">
          <span className="section-label">QUICK ENTRY · 快捷入口（可自定义）</span>
          <button className="p9a-icon" aria-label="配置快捷入口" onClick={() => setCfgOpen((v) => !v)}>
            <Wrench size={15} />
          </button>
        </div>
        <div className="p9a-quick-icons p9a-quick-fill">
          {quickCfg.filter((c) => c.visible).map((c) => {
            const q = QUICK_ALL.find((x) => x.key === c.key)!;
            return (
              <Link className="p9a-quick-icon" key={q.key} to={q.to}>
                <DomainIconBlock domain={q.domain} size={34} iconSize={18} />
                <span>{q.label}</span>
              </Link>
            );
          })}
        </div>
        {cfgOpen ? (
          <div className="p9a-quick-cfg" role="dialog" aria-label="快捷入口配置">
            <span className="section-label">勾选显隐 · 拖拽排序（存本机）</span>
            {quickCfg.map((c, i) => {
              const q = QUICK_ALL.find((x) => x.key === c.key)!;
              return (
                <div
                  key={c.key}
                  className="p9a-cfg-row"
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIdx === null || dragIdx === i) return;
                    const next = [...quickCfg];
                    const [moved] = next.splice(dragIdx, 1);
                    next.splice(i, 0, moved);
                    saveCfg(next);
                    setDragIdx(null);
                  }}
                >
                  <span className="p9a-drag" aria-hidden="true">⋮⋮</span>
                  <input type="checkbox" checked={c.visible} aria-label={`显示${q.label}`} onChange={() => saveCfg(quickCfg.map((x, xi) => (xi === i ? { ...x, visible: !x.visible } : x)))} />
                  <DomainIconBlock domain={q.domain} size={22} iconSize={14} />
                  <span>{q.label}</span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* 左下 · 项目脉搏：默认 6 张 auto-fill 240px + 显示全部 */}
      <div className="p9a-q p9a-q-pulse">
        <span className="section-label">PROJECT PULSE · 项目脉搏（默认 6 张 · auto-fill 240px）</span>
        <div className="p9a-pulse-4">
          {previewItems.slice(0, 6).map((p, i) => {
            const ov = overviews[i]?.data;
            const pct = ov && ov.tasks.total > 0 ? Math.round((ov.tasks.done / ov.tasks.total) * 100) : 0;
            const warn = p.healthStatus !== "normal";
            return (
              <Link className="p9a-pulse-card compact" key={p.id} to={`/projects/${p.id}`}>
                <span className="p9a-pulse-head">
                  <i className={`p9a-dot ${warn ? "pulse warn" : "ok"}`} />
                  <strong>{p.name}</strong>
                  <em className={warn ? "p9a-badge-orange" : "p9a-badge-green"}>{warn ? "风险" : LIFECYCLE_LABEL[p.lifecycleStatus]}</em>
                </span>
                <small className="p9a-pulse-meta">
                  {p.code} · {LIFECYCLE_LABEL[p.lifecycleStatus]} · 逾期 {ov?.tasks.overdue ?? 0} · 更新 {p.updatedAt.slice(5, 16).replace("T", " ")}
                </small>
                <span className="p9a-progress"><i style={{ width: `${pct}%` }} /><b>{pct}%</b></span>
              </Link>
            );
          })}
          {previewItems.length === 0 ? <p className="list-note">暂无可见项目；加入项目后此处出现项目脉搏。</p> : null}
        </div>
        <Link className="p9a-show-all" to="/projects">··· 显示全部（{previewItems.length}）</Link>
      </div>

      {/* 右下 · 待办清单：页签（待办/延期治理）+ chips + 类型分组折叠 */}
      <div className="p9a-q p9a-q-todo">
        <div className="p9a-q-head">
          <div className="p9a-mini-tabs" role="tablist">
            <button role="tab" aria-selected={todoTab === "todo"} className={todoTab === "todo" ? "active" : ""} onClick={() => setTodoTab("todo")}>
              待办（{total}）
            </button>
            <button role="tab" aria-selected={todoTab === "delay"} className={todoTab === "delay" ? "active" : ""} onClick={() => setTodoTab("delay")}>
              延期治理
            </button>
          </div>
          {todoTab === "todo" ? (
            <div className="p9a-chips">
              {chips.map((c) => (
                <button key={c} className={chip === c ? "active" : ""} onClick={() => setChip(c)}>
                  {c === "全部" ? `全部 ${total}` : `${DOMAIN_ICONS[c].label} ${todoGroups.find(([d]) => d === c)?.[1].length ?? 0}`}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {todoTab === "todo" ? (
          <div className="p9a-scroll-list p9a-todo-scroll">
            {visibleGroups.map(([domain, items]) => {
              const isCollapsed = collapsed[domain] ?? false;
              return (
                <section className="p9a-todo-group" key={domain}>
                  <button
                    className="p9a-todo-group-head"
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((c) => ({ ...c, [domain]: !isCollapsed }))}
                  >
                    <DomainIconBlock domain={domain} size={24} />
                    <strong>{DOMAIN_ICONS[domain].label}</strong>
                    <span className="count-badge neutral">{items.length}</span>
                    <span className="p9a-collapse-arrow">{isCollapsed ? "▸" : "▾"}</span>
                  </button>
                  {!isCollapsed
                    ? items.map((it) => (
                        <div className="p9a-queue-card slim" key={it.title}>
                          <DomainIconBlock domain={domain} size={20} iconSize={12} />
                          <div className="p9a-queue-main">
                            <strong>{it.title}</strong>
                            <small>{it.project} · {it.ago}</small>
                          </div>
                          <Link className="p9a-pill" to="/approvals">去处理</Link>
                        </div>
                      ))
                    : null}
                </section>
              );
            })}
            {total === 0 ? <p className="list-note">没有待办事项。</p> : null}
          </div>
        ) : (
          <div className="p9a-delay-body">
            <div className="p9a-steps">
              {[
                { label: "原因", el: <span className="p9a-iconblock" style={{ width: 36, height: 36, background: "#eff4ff", color: "#2563eb" }}><FileText size={18} /></span> },
                { label: "影响", el: <DomainIconBlock domain="risk" size={36} iconSize={18} /> },
                { label: "方案", el: <span className="p9a-iconblock" style={{ width: 36, height: 36, background: "#f4efff", color: "#7c3aed" }}><Wrench size={18} /></span> },
                { label: "决策", el: <DomainIconBlock domain="decision" size={36} iconSize={18} /> },
              ].map((snode, i, arr) => (
                <div className="p9a-step-node" key={snode.label}>
                  {snode.el}
                  <span>{snode.label}</span>
                  {i < arr.length - 1 ? <i className="p9a-step-line" aria-hidden="true" /> : null}
                </div>
              ))}
            </div>
            <p className="context-note">每一次变化都有书面原因、责任人和恢复检查点，并自动进入项目档案。</p>
          </div>
        )}
      </div>
    </div>
  );
}
