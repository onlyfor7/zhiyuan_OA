import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Banknote, Calendar, CheckCircle2, CheckSquare, Clock,
  FileEdit, FileText, FolderPlus, ShieldAlert, TrendingUp, Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * 迭代 9a 演示面板：T-C 驾驶舱三行固定 grid（§1.3）/ T-A 列表工作台（筛选固定+表内滚动+分页固定）
 * / 密度 token 表（§4.1）/ 微交互样例（M1/M2/M3/M4/M5/M7，§4.2）。
 */

/* M4：数字进入视口滚动计数 */
function CountUp({ value, suffix = "" }: { value: number; suffix?: string }) {
  const [display, setDisplay] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / 400);
          setDisplay(Math.round(value * t));
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        io.disconnect();
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [value]);
  return (
    <span ref={ref} className="p9a-count">
      {display}
      {suffix}
    </span>
  );
}

/* v1.3 §1.3/§4.3：摘要面全部卡片图标化（数据密度页 T-A 保持净行表格不动） */

type Tone = "blue" | "green" | "orange" | "purple";
const TONE_BG: Record<Tone, string> = { blue: "#eff4ff", green: "#ecfdf5", orange: "#fff4ec", purple: "#f4efff" };
const TONE_FG: Record<Tone, string> = { blue: "#2563eb", green: "#059669", orange: "#ea580c", purple: "#7c3aed" };

function IconBlock({ icon: Icon, tone, size = 32 }: { icon: LucideIcon; tone: Tone; size?: number }) {
  return (
    <span className="p9a-iconblock" style={{ width: size, height: size, background: TONE_BG[tone], color: TONE_FG[tone] }} aria-hidden="true">
      <Icon size={size >= 40 ? 22 : 18} />
    </span>
  );
}

/* T-C 驾驶舱样例：固定三行 grid（§1.3 v1.3 卡片图标化） */
/* v1.5 §1.3 驾驶舱 2×2 四象限定稿（铺满视口：行 36%/64%、列 3fr/2fr） */
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

const QUICK_ALL: Array<{ key: string; label: string; icon: LucideIcon }> = [
  { key: "project", label: "新建项目", icon: FolderPlus },
  { key: "receipt", label: "登记收款", icon: Banknote },
  { key: "request", label: "发起申请", icon: FileEdit },
  { key: "lead", label: "新建线索", icon: TrendingUp },
  { key: "invoice", label: "开具发票", icon: FileText },
  { key: "report", label: "写周报", icon: Calendar },
];
const QUICK_KEY = "p9a-quick-config";

function CockpitDemo() {
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
  const [chip, setChip] = useState("全部");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const saveCfg = (next: typeof quickCfg) => {
    setQuickCfg(next);
    localStorage.setItem(QUICK_KEY, JSON.stringify(next));
  };
  const toggleVisible = (i: number) => saveCfg(quickCfg.map((c, x) => (x === i ? { ...c, visible: !c.visible } : c)));
  const onDrop = (to: number) => {
    if (dragIdx === null || dragIdx === to) return;
    const next = [...quickCfg];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(to, 0, moved);
    saveCfg(next);
    setDragIdx(null);
  };

  const projects = [
    { name: "比博思特技术服务项目", code: "PRJ-2026-00001", badge: "进行中", tone: "green" as Tone, pct: 62, stage: "执行阶段", overdue: 1, updated: "10 分钟前" },
    { name: "金通灵技术服务项目", code: "PRJ-2026-00002", badge: "进行中", tone: "green" as Tone, pct: 45, stage: "启动阶段", overdue: 0, updated: "1 小时前" },
    { name: "佳力奇技术服务项目", code: "PRJ-2026-00003", badge: "进行中", tone: "green" as Tone, pct: 78, stage: "验收阶段", overdue: 2, updated: "昨天" },
    { name: "合规运作规则引擎上市公司 1.0", code: "PRJ-2026-00004", badge: "风险", tone: "orange" as Tone, pct: 30, stage: "执行阶段", overdue: 5, updated: "3 小时前" },
  ];
  const todoGroups: Array<{ type: string; tone: Tone; icon: LucideIcon; items: Array<{ title: string; project: string; ago: string }> }> = [
    { type: "审批", tone: "blue", icon: CheckSquare, items: [
      { title: "报销单待财务审批", project: "比博思特", ago: "10 分钟前" },
      { title: "差旅借款会签", project: "金通灵", ago: "32 分钟前" },
      { title: "工时周期解锁审批", project: "佳力奇", ago: "2 小时前" },
    ] },
    { type: "会议", tone: "green", icon: Calendar, items: [
      { title: "周会纪要待确认", project: "比博思特", ago: "1 小时前" },
    ] },
    { type: "工时", tone: "purple", icon: Clock, items: [
      { title: "上周工时逾期未交", project: "个人", ago: "昨天" },
    ] },
    { type: "质量", tone: "orange", icon: ShieldAlert, items: [
      { title: "严重质量问题复核", project: "佳力奇", ago: "昨天" },
    ] },
    { type: "财务", tone: "blue", icon: Banknote, items: [
      { title: "合同付款计划核对", project: "比博思特", ago: "3 小时前" },
    ] },
  ];
  const chips = ["全部", "审批", "会议", "工时", "质量", "财务"];
  const countBy = (t: string) => todoGroups.find((g) => g.type === t)?.items.length ?? 0;
  const visibleGroups = todoGroups.filter((g) => chip === "全部" || g.type === chip);
  const steps: Array<{ label: string; icon: LucideIcon; tone: Tone }> = [
    { label: "原因", icon: FileText, tone: "blue" },
    { label: "影响", icon: AlertTriangle, tone: "orange" },
    { label: "方案", icon: Wrench, tone: "purple" },
    { label: "决策", icon: CheckCircle2, tone: "green" },
  ];
  const total = todoGroups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="p9a-tc2">
      {/* 左上 · 问候卡：实时时钟+日期星期+问候+姓名·职位·部门·角色徽标+指标 mini 条 */}
      <div className="p9a-q p9a-q-greet">
        <LiveClock />
        <h1>早上好，梁奇烽。</h1>
        <p className="p9a-person-line">
          <strong>梁奇烽</strong> · 合伙人 · 综合管理部
          <span className="p9a-role-badge">合伙人</span>
          <span className="p9a-role-badge alt">质量负责人</span>
        </p>
        <p className="context-note">项目组合与待处理事项来自实时聚合（§1.3 v1.5 四象限定稿 · 职位为原型静态示意）。</p>
        <div className="p9a-mini-metrics">
          {[["项目", 5], ["待批", 6], ["待决策", 3], ["预警", 1]].map(([l, v]) => (
            <span key={l as string}><strong>{v}</strong>{l}</span>
          ))}
        </div>
      </div>

      {/* 右上 · 快捷入口：可自定义（齿轮配置浮层：勾选显隐+拖拽排序+localStorage） */}
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
              <button className="p9a-quick-icon" key={q.key}>
                <q.icon size={22} />
                <span>{q.label}</span>
              </button>
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
                  onDrop={() => onDrop(i)}
                >
                  <span className="p9a-drag" aria-hidden="true">⋮⋮</span>
                  <input type="checkbox" checked={c.visible} aria-label={`显示${q.label}`} onChange={() => toggleVisible(i)} />
                  <q.icon size={15} />
                  <span>{q.label}</span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* 左下 · 项目脉搏：默认 4 卡 2×2 铺满 + 「···显示全部(N)」 */}
      <div className="p9a-q p9a-q-pulse">
        <span className="section-label">PROJECT PULSE · 项目脉搏（默认 4 卡铺满）</span>
        <div className="p9a-pulse-4">
          {projects.map((p) => (
            <button className="p9a-pulse-card compact" key={p.code}>
              <span className="p9a-pulse-head">
                <i className={`p9a-dot ${p.tone === "orange" ? "pulse warn" : "ok"}`} />
                <strong>{p.name}</strong>
                <em className={`p9a-badge-${p.tone}`}>{p.badge}</em>
              </span>
              <small className="p9a-pulse-meta">{p.code} · 当前阶段 {p.stage} · 逾期任务 {p.overdue} · 更新 {p.updated}</small>
              <span className="p9a-progress"><i style={{ width: `${p.pct}%` }} /><b>{p.pct}%</b></span>
            </button>
          ))}
        </div>
        <button className="p9a-show-all">··· 显示全部（{12}）</button>
      </div>

      {/* 右下 · 待办清单：页签（待办/延期治理）+ chips 快筛 + 类型分组折叠（计数）+ 区内滚动 */}
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
                  {c}{c !== "全部" ? ` ${countBy(c)}` : ` ${total}`}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {todoTab === "todo" ? (
          <div className="p9a-scroll-list p9a-todo-scroll">
            {visibleGroups.map((g) => {
              const isCollapsed = collapsedGroups[g.type] ?? false;
              return (
                <section className="p9a-todo-group" key={g.type}>
                  <button
                    className="p9a-todo-group-head"
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsedGroups((c) => ({ ...c, [g.type]: !isCollapsed }))}
                  >
                    <IconBlock icon={g.icon} tone={g.tone} size={24} />
                    <strong>{g.type}</strong>
                    <span className="count-badge neutral">{g.items.length}</span>
                    <span className="p9a-collapse-arrow">{isCollapsed ? "▸" : "▾"}</span>
                  </button>
                  {!isCollapsed
                    ? g.items.map((it) => (
                        <div className="p9a-queue-card slim" key={it.title}>
                          <div className="p9a-queue-main">
                            <strong>{it.title}</strong>
                            <small>{it.project} · {it.ago}</small>
                          </div>
                          <button className="p9a-pill">去处理</button>
                        </div>
                      ))
                    : null}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="p9a-delay-body">
            <div className="p9a-steps">
              {steps.map((s, i) => (
                <div className="p9a-step-node" key={s.label}>
                  <IconBlock icon={s.icon} tone={s.tone} size={36} />
                  <span>{s.label}</span>
                  {i < steps.length - 1 ? <i className="p9a-step-line" aria-hidden="true" /> : null}
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


/* T-A 列表工作台样例：筛选条固定 + 表格内滚动 + 分页条固定 */
function TableDemo({ title }: { title: string }) {
  const [rows] = useState(() =>
    Array.from({ length: 60 }, (_, i) => ({
      code: `PRJ-2026-${String(i + 1).padStart(5, "0")}`,
      name: `样例项目 ${i + 1}`,
      client: "比博思特技术服务（虚构）",
      manager: "王宝茁",
      health: i % 7 === 3 ? "风险" : "正常",
      updated: "2026-11-08",
    })),
  );
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const pageRows = rows.slice(page * pageSize, page * pageSize + pageSize);
  return (
    <div className="p9a-ta">
      <div className="p9a-ta-filter">
        <span className="section-label">T-A · {title}</span>
        <input placeholder="关键词筛选（示意）" aria-label="关键词筛选" />
        <select aria-label="健康度筛选" defaultValue="">
          <option value="">全部健康度</option>
          <option>正常</option>
          <option>风险</option>
        </select>
        <button className="primary-action p9a-ripple">查询</button>
      </div>
      <div className="p9a-ta-table">
        <div className="p9a-ta-head p9a-ta-row">
          <span>编号</span><span>名称</span><span>客户</span><span>负责人</span><span>健康度</span><span>更新</span><span />
        </div>
        <div className="p9a-ta-body">
          {pageRows.map((r) => (
            <div className="p9a-ta-row" key={r.code}>
              <span className="mono">{r.code}</span>
              <strong>{r.name}</strong>
              <span>{r.client}</span>
              <span>{r.manager}</span>
              <span><i className={`p9a-dot ${r.health === "风险" ? "pulse warn" : "ok"}`} />{r.health}</span>
              <span className="mono">{r.updated}</span>
              <span className="p9a-row-actions">
                <button className="text-action">编辑</button>
                <button className="text-action">归档</button>
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="p9a-ta-pager">
        <span>共 {rows.length} 条 · 每页 {pageSize} 行（H2：单页默认 20 行）</span>
        <div className="row-ops">
          <button className="secondary-action" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>上一页</button>
          <span>{page + 1} / {Math.ceil(rows.length / pageSize)}</span>
          <button className="secondary-action" disabled={(page + 1) * pageSize >= rows.length} onClick={() => setPage((p) => p + 1)}>下一页</button>
        </div>
      </div>
    </div>
  );
}

/* 密度 token 表（§4.1） */
function TokenDemo() {
  const rows = [
    ["正文/表格", "13px", "行高 1.55 + 字重对比增强可读性"],
    ["辅助文字", "12px", "次级说明"],
    ["eyebrow", "11px", "等宽大写标签"],
    ["页标题", "20px", "h1"],
    ["区块标题", "15px", "h2"],
    ["数字指标", "24px / 600", "驾驶舱指标带"],
    ["控件高", "32px", "输入/按钮（舒适 36 / 紧凑 28）"],
    ["表格行高", "40px", "紧凑档 34"],
    ["间距基数", "4", "卡 padding 16 / 区间隔 12 / 圆角 10"],
    ["主区底色", "#f5f6f8", "内容一律白卡浮起（灰底浮白卡）"],
  ] as const;
  return (
    <div className="p9a-token">
      <span className="section-label">§4.1 密度 token（默认档=紧凑现代）</span>
      <table className="p9a-token-table">
        <thead><tr><th>项</th><th>值</th><th>说明</th></tr></thead>
        <tbody>
          {rows.map(([a, b, c]) => (
            <tr key={a}><td>{a}</td><td className="mono">{b}</td><td>{c}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="p9a-card-demo">
        <div className="p9a-card"><span className="section-label">白卡样例</span><p>translateY(-1px) + 阴影加深 120ms（hover 试一下）。</p></div>
        <div className="p9a-card"><span className="section-label">灰底浮白卡</span><p>主区 #f5f6f8，卡片白底圆角 10。</p></div>
      </div>
    </div>
  );
}

/* 微交互样例（§4.2：M1/M2/M3/M4/M5/M7） */
function MicroDemo() {
  const [tab, setTab] = useState(0);
  const [fadeKey, setFadeKey] = useState(0);
  return (
    <div className="p9a-micro">
      <div className="p9a-card">
        <span className="section-label">M1 · 按钮 hover 上浮 + 点击涟漪缩放</span>
        <div className="row-ops">
          <button className="primary-action p9a-ripple">主要按钮（hover 上浮）</button>
          <button className="secondary-action">次要按钮</button>
        </div>
      </div>
      <div className="p9a-card">
        <span className="section-label">M2 · 链接下划线展开 + 箭头位移（hover）</span>
        <p><button className="text-action">去处理 <span aria-hidden>→</span></button> <button className="text-action">查看全部 →</button></p>
      </div>
      <div className="p9a-card">
        <span className="section-label">M3 · 状态点呼吸脉冲（1.6s）</span>
        <p><i className="p9a-dot pulse warn" /> 风险脉冲 <i className="p9a-dot pulse ok" /> 正常脉冲样例</p>
      </div>
      <div className="p9a-card">
        <span className="section-label">M4 · 数字进入视口滚动计数（400ms，仅驾驶舱指标带）</span>
        <p><CountUp value={128600} suffix=" 元" /> <CountUp value={42} /></p>
      </div>
      <div className="p9a-card">
        <span className="section-label">M5 · 表格行 hover 底色 + 行内动作浮现（见 T-A 样例行尾）</span>
      </div>
      <div className="p9a-card">
        <span className="section-label">M7 · 页签切换淡入 120ms + 面板滑下（mega menu 已是滑下）</span>
        <div className="p9a-mini-tabs" role="tablist">
          {["页签 A", "页签 B"].map((t, i) => (
            <button key={t} role="tab" aria-selected={tab === i} className={tab === i ? "active" : ""}
              onClick={() => { setTab(i); setFadeKey((k) => k + 1); }}>
              {t}
            </button>
          ))}
        </div>
        <div className="p9a-tab-fade" key={fadeKey}>页签 {tab === 0 ? "A" : "B"} 内容（淡入 120ms 演示，切换观察）。</div>
      </div>
    </div>
  );
}

export function DemoPanel({ kind, title }: { kind: "t-c" | "t-a" | "token" | "micro"; title: string }) {
  if (kind === "t-c") return <CockpitDemo />;
  if (kind === "t-a") return <TableDemo title={title} />;
  if (kind === "token") return <TokenDemo />;
  return <MicroDemo />;
}
