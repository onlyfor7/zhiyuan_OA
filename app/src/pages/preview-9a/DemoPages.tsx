import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Banknote, Briefcase, Calendar, CheckCircle2, CheckSquare, Clock,
  FileEdit, FileText, Folder, FolderPlus, Play, ShieldAlert, TrendingUp, Wrench,
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
function CockpitDemo() {
  const metrics: Array<{ label: string; value: number; icon: LucideIcon; tone: Tone }> = [
    { label: "项目总数", value: 5, icon: Folder, tone: "blue" },
    { label: "进行中", value: 4, icon: Play, tone: "green" },
    { label: "健康度预警", value: 1, icon: AlertTriangle, tone: "orange" },
    { label: "待我审批", value: 6, icon: CheckSquare, tone: "purple" },
    { label: "待决策", value: 3, icon: TrendingUp, tone: "blue" },
    { label: "本周会议", value: 5, icon: Calendar, tone: "green" },
    { label: "出差中", value: 2, icon: Briefcase, tone: "orange" },
    { label: "本周已批工时", value: 38, icon: Clock, tone: "purple" },
    { label: "收款净额(元)", value: 6000, icon: Banknote, tone: "blue" },
  ];
  const projects = [
    { name: "比博思特技术服务项目", code: "PRJ-2026-00001", badge: "进行中·正常", tone: "green" as Tone, mgr: "王宝茁", pct: 62 },
    { name: "金通灵技术服务项目", code: "PRJ-2026-00002", badge: "进行中·正常", tone: "green" as Tone, mgr: "王家玉", pct: 45 },
    { name: "佳力奇技术服务项目", code: "PRJ-2026-00003", badge: "进行中·正常", tone: "green" as Tone, mgr: "孙浩祥", pct: 78 },
    { name: "合规运作规则引擎上市公司 1.0", code: "PRJ-2026-00004", badge: "进行中·风险", tone: "orange" as Tone, mgr: "廖益敏", pct: 30 },
    { name: "GD 法律服务", code: "PRJ-2026-00005", badge: "进行中·正常", tone: "green" as Tone, mgr: "霍达", pct: 55 },
    { name: "滚动样例项目 6", code: "PRJ-2026-00006", badge: "筹备", tone: "blue" as Tone, mgr: "毛振宇", pct: 10 },
  ];
  const todos: Array<{ title: string; project: string; ago: string; icon: LucideIcon; tone: Tone }> = [
    { title: "报销单待财务审批", project: "比博思特", ago: "10 分钟前", icon: CheckSquare, tone: "blue" },
    { title: "差旅借款会签", project: "金通灵", ago: "32 分钟前", icon: Briefcase, tone: "green" },
    { title: "线索转化确认", project: "CRM", ago: "1 小时前", icon: TrendingUp, tone: "purple" },
    { title: "合同付款计划核对", project: "比博思特", ago: "3 小时前", icon: Banknote, tone: "orange" },
    { title: "严重质量问题复核", project: "佳力奇", ago: "昨天", icon: ShieldAlert, tone: "orange" },
  ];
  const steps: Array<{ label: string; icon: LucideIcon; tone: Tone }> = [
    { label: "原因", icon: FileText, tone: "blue" },
    { label: "影响", icon: AlertTriangle, tone: "orange" },
    { label: "方案", icon: Wrench, tone: "purple" },
    { label: "决策", icon: CheckCircle2, tone: "green" },
  ];
  const quick: Array<{ label: string; icon: LucideIcon }> = [
    { label: "新建项目", icon: FolderPlus },
    { label: "登记收款", icon: Banknote },
    { label: "发起申请", icon: FileEdit },
  ];
  return (
    <div className="p9a-tc">
      <div className="p9a-tc-row1">
        <div className="p9a-greet p9a-greet-card">
          <span className="eyebrow">FRIDAY, 08 NOV 2026</span>
          <h1>早上好，梁奇烽。</h1>
          <p>项目组合与待处理事项来自实时聚合（T-C 样例 · §1.3 v1.4 四区重排）。</p>
        </div>
        <div className="p9a-metrics">
          {metrics.map((m) => (
            <div className="p9a-metric" key={m.label}>
              <IconBlock icon={m.icon} tone={m.tone} />
              <div className="p9a-metric-text">
                <CountUp value={m.value} />
                <span>{m.label}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="p9a-quick-icons p9a-quick-right">
          {quick.map((q) => (
            <button className="p9a-quick-icon" key={q.label}>
              <q.icon size={22} />
              <span>{q.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="p9a-tc-row2">
        <div className="p9a-panel">
          <span className="section-label">PROJECT PULSE · 项目脉搏（auto-fill 300px 卡网格铺满·模块内滚动）</span>
          <div className="p9a-scroll-list p9a-pulse-grid">
            {projects.concat(Array.from({ length: 6 }, (_, i) => ({
              name: `滚动样例项目 ${i + 7}`, code: `PRJ-2026-0000${i + 7}`, badge: "进行中·正常", tone: "green" as Tone, mgr: "负责人", pct: 20 + i * 10,
            }))).map((p) => (
              <button className="p9a-pulse-card" key={p.code}>
                <span className="p9a-pulse-head">
                  <i className={`p9a-dot ${p.tone === "orange" ? "pulse warn" : "ok"}`} />
                  <strong>{p.name}</strong>
                </span>
                <small className="p9a-pulse-meta">{p.code} · <em className={`p9a-badge-${p.tone}`}>{p.badge}</em> · 负责人 {p.mgr}</small>
                <span className="p9a-progress"><i style={{ width: `${p.pct}%` }} /></span>
              </button>
            ))}
          </div>
        </div>
        <div className="p9a-panel aggregated">
          <span className="section-label">TODO QUEUE · 待办卡队列（模块内滚动）</span>
          <div className="p9a-scroll-list">
            {todos.map((t) => (
              <div className="p9a-queue-card" key={t.title}>
                <IconBlock icon={t.icon} tone={t.tone} size={40} />
                <div className="p9a-queue-main">
                  <strong>{t.title}</strong>
                  <small>{t.project} · {t.ago}</small>
                </div>
                <button className="p9a-pill">去处理</button>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="p9a-tc-row3">
        <div className="p9a-panel aggregated p9a-delay-strip">
          <span className="section-label">DELAY GOVERNANCE · 延期治理（步骤条横贯）</span>
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
