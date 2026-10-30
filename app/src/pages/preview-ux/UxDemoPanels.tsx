import { useEffect, useRef, useState } from "react";

import { PERSONA_LABEL, type Persona } from "./ux-types";

/**
 * 迭代 7 · 工单 01 演示面板：弹窗范式（Dialog/Drawer）+ E1–E7 样例 + 重影修复前后对比。
 * 全部为静态示意，交互仅用于演示交互范式（无真实数据、无业务逻辑）。
 */

const TABS = [
  ["ia", "新 IA 说明"],
  ["grp-overview", "总览组"],
  ["grp-project", "项目组"],
  ["grp-collab", "协同组"],
  ["grp-ops", "经营组"],
  ["grp-gov", "治理组"],
  ["dialogs", "弹窗范式"],
  ["samples", "E1–E7 样例"],
  ["ghost", "重影修复对比"],
] as const;

/* ---------- E3 Toast 示意（正式接入用 sonner，arch/10 §4 E3） ---------- */
interface Toast {
  id: number;
  kind: "success" | "error";
  text: string;
}
let toastSeq = 0;

function ToastStack({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="ux-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`ux-toast ${t.kind}`} role="status">
          <strong>{t.kind === "success" ? "✓ 成功" : "✕ 失败"}</strong>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = (kind: Toast["kind"], text: string) => {
    const id = ++toastSeq;
    setToasts((list) => [...list, { id, kind, text }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 3200);
  };
  return { toasts, push };
}

/* ---------- 弹窗范式：通用 Dialog/Drawer 行为（Esc/遮罩/首字段聚焦/焦点还原/防重复提交） ---------- */
function useOverlay(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-overlay-close])");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      triggerRef.current?.focus();
    };
  }, [onClose]);
  return ref;
}

function DemoDialog({ title, eyebrow, onClose, children, wide }: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useOverlay(onClose);
  return (
    <div className="ux-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className={`ux-modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="ux-modal-head">
          <div>
            <span className="section-label">{eyebrow}</span>
            <h2>{title}</h2>
          </div>
          <button className="ux-icon" aria-label="关闭" data-overlay-close onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

/** 表单校验映射 + 防重复提交（示意） */
function useFakeSubmit(onDone: () => void) {
  const [pending, setPending] = useState(false);
  const submit = (validate: () => string | null) => {
    if (pending) return;
    const err = validate();
    if (err) return;
    setPending(true);
    window.setTimeout(() => {
      setPending(false);
      onDone();
    }, 700);
  };
  return { pending, submit };
}

/* ---------- 弹窗范式三样例 ---------- */
function UserDialog({ onClose, notify }: { onClose: () => void; notify: (k: Toast["kind"], t: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, submit } = useFakeSubmit(() => {
    notify("success", "用户已创建（示意）：初始口令仅展示一次。");
    onClose();
  });
  return (
    <DemoDialog title="创建用户" eyebrow="DIALOG · 小型表单范式" onClose={onClose}>
      <p className="ux-hint">校验映射示意：留空提交 → 服务端 fieldErrors 映射到字段下方（红色）；提交中按钮禁用防重复。</p>
      <label className="ux-field">
        <span>姓名 *</span>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} />
        {errors.name ? <em className="ux-err">{errors.name}</em> : null}
      </label>
      <label className="ux-field">
        <span>邮箱 *</span>
        <input value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email} />
        {errors.email ? <em className="ux-err">{errors.email}</em> : null}
      </label>
      <div className="ux-modal-ops">
        <button className="secondary-action" onClick={onClose}>取消</button>
        <button
          className="primary-action"
          disabled={pending}
          onClick={() =>
            submit(() => {
              const errs: Record<string, string> = {};
              if (!name.trim()) errs.name = "姓名必填（服务端 fieldErrors.name 映射）";
              if (!email.trim()) errs.email = "邮箱必填（服务端 fieldErrors.email 映射）";
              else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errs.email = "邮箱格式不正确";
              setErrors(errs);
              return Object.keys(errs).length ? "invalid" : null;
            })
          }
        >
          {pending ? "创建中…" : "创建（初始随机口令）"}
        </button>
      </div>
    </DemoDialog>
  );
}

function ReceiptDrawer({ onClose, notify }: { onClose: () => void; notify: (k: Toast["kind"], t: string) => void }) {
  const [amount, setAmount] = useState("");
  const [refNo, setRefNo] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, submit } = useFakeSubmit(() => {
    notify("success", "收款已登记（示意）：金额登记后不可编辑，更正=作废+新登记。");
    onClose();
  });
  return (
    <DemoDialog title="登记收款" eyebrow="DRAWER · 长表单/带明细范式" onClose={onClose} wide>
      <p className="ux-hint">Drawer 范式示意：从右侧滑入的长表单；遮罩/Esc 关闭；未保存关闭给出提醒（正式接入实现）。</p>
      <div className="ux-drawer-grid">
        <label className="ux-field">
          <span>项目 *</span>
          <select defaultValue="p1">
            <option value="p1">华宸贸易合同纠纷代理·一审</option>
            <option value="p2">星澜科技常年法律顾问服务</option>
          </select>
        </label>
        <label className="ux-field">
          <span>金额（元）*</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!errors.amount} />
          {errors.amount ? <em className="ux-err">{errors.amount}</em> : null}
        </label>
        <label className="ux-field">
          <span>到账日期 *</span>
          <input type="date" defaultValue="2026-10-30" />
        </label>
        <label className="ux-field">
          <span>银行回单/流水号 *</span>
          <input value={refNo} onChange={(e) => setRefNo(e.target.value)} aria-invalid={!!errors.refNo} />
          {errors.refNo ? <em className="ux-err">{errors.refNo}</em> : null}
        </label>
      </div>
      <div className="ux-modal-ops">
        <button className="secondary-action" onClick={onClose}>取消</button>
        <button
          className="primary-action"
          disabled={pending}
          onClick={() =>
            submit(() => {
              const errs: Record<string, string> = {};
              if (!amount || Number(amount) <= 0) errs.amount = "金额须为正数";
              if (!refNo.trim()) errs.refNo = "参考号必填";
              setErrors(errs);
              return Object.keys(errs).length ? "invalid" : null;
            })
          }
        >
          {pending ? "登记中…" : "登记收款"}
        </button>
      </div>
    </DemoDialog>
  );
}

function RequestDialog({ onClose, notify }: { onClose: () => void; notify: (k: Toast["kind"], t: string) => void }) {
  const [title, setTitle] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, submit } = useFakeSubmit(() => {
    notify("success", "申请单已提交（示意）：引擎按绑定流程展开步骤。");
    onClose();
  });
  return (
    <DemoDialog title="发起申请单" eyebrow="DIALOG · 固定核心字段" onClose={onClose}>
      <p className="ux-hint">创建类操作一律弹窗化（arch/10 §2）：禁止内联面板撑开列表页。</p>
      <label className="ux-field">
        <span>申请类型 *</span>
        <select defaultValue="leave">
          <option value="leave">请假</option>
          <option value="procurement">采购</option>
          <option value="seal">用章</option>
        </select>
      </label>
      <label className="ux-field">
        <span>标题 *</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!errors.title} />
        {errors.title ? <em className="ux-err">{errors.title}</em> : null}
      </label>
      <label className="ux-field">
        <span>申请理由 *</span>
        <textarea rows={3} />
      </label>
      <div className="ux-modal-ops">
        <button className="secondary-action" onClick={onClose}>取消</button>
        <button
          className="primary-action"
          disabled={pending}
          onClick={() =>
            submit(() => {
              const errs: Record<string, string> = {};
              if (!title.trim()) errs.title = "标题必填";
              setErrors(errs);
              return Object.keys(errs).length ? "invalid" : null;
            })
          }
        >
          {pending ? "提交中…" : "提交审批"}
        </button>
      </div>
    </DemoDialog>
  );
}

/* ---------- E7 高危确认 ---------- */
function DangerSample({ notify }: { notify: (k: Toast["kind"], t: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ux-sample">
      <button className="danger-action" onClick={() => setOpen(true)}>变更项目负责人（高危）</button>
      {open ? (
        <DemoDialog title="确认变更负责人（高危）" eyebrow="E7 · 高危确认统一范式" onClose={() => setOpen(false)}>
          <div className="ux-danger-box">
            <strong>将把项目负责人从 刘畅 变更为 林晓。</strong>
            <p>理由：组织调整。该操作立即生效、写入审计且不可一键撤销；双方收到通知。</p>
          </div>
          <div className="ux-modal-ops">
            <button className="secondary-action" onClick={() => setOpen(false)}>取消</button>
            <button
              className="danger-action"
              onClick={() => {
                notify("success", "负责人变更已生效（示意）。");
                setOpen(false);
              }}
            >
              确认变更
            </button>
          </div>
        </DemoDialog>
      ) : null}
    </div>
  );
}

/* ---------- E4 表格密度 ---------- */
type Density = "compact" | "standard" | "loose";
const DENSITY_LABEL: Record<Density, string> = { compact: "紧凑", standard: "标准", loose: "宽松" };

function DensityTable() {
  const [density, setDensity] = useState<Density>(() => (localStorage.getItem("ux-demo-density") as Density) || "standard");
  const change = (d: Density) => {
    setDensity(d);
    localStorage.setItem("ux-demo-density", d);
  };
  const rows = [
    ["TSK-2026-00012", "起诉状证据交换材料核对", "进行中", "2026-11-04"],
    ["TSK-2026-00013", "庭前会议提纲", "待开始", "2026-11-08"],
    ["TSK-2026-00014", "代理意见初稿", "待开始", "2026-11-12"],
  ];
  return (
    <div className="ux-sample">
      <div className="ux-density-ops">
        <span className="section-label">E4 · 表格密度（偏好存 localStorage，界面偏好允许 arch/00 §1.3）</span>
        <div className="ux-seg">
          {(Object.keys(DENSITY_LABEL) as Density[]).map((d) => (
            <button key={d} className={density === d ? "active" : ""} onClick={() => change(d)}>
              {DENSITY_LABEL[d]}
            </button>
          ))}
        </div>
      </div>
      <table className={`ux-table density-${density}`}>
        <thead>
          <tr><th>编号</th><th>任务</th><th>状态</th><th>计划完成</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>{r.map((c, i) => (i === 0 ? <td key={i} className="mono">{c}</td> : <td key={i}>{c}</td>))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- 重影对比（CSS 复刻，真机截图路径见标注） ---------- */
function GhostCompare() {
  return (
    <div className="ux-ghost">
      <div className="ux-ghost-col">
        <span className="section-label">修复前（复刻叠印）</span>
        <div className="ux-ghost-table before">
          <div className="ux-ghost-row">
            <span>陈立</span>
            <span>诉讼业务部</span>
            <span className="chip">项目负责人 ×</span>
            <span className="ops">
              <i className="sel">项目成员 ▾</i>
              <b className="btn">授予</b>
              <b className="btn spill">移除<b className="ghost-text">用</b></b>
            </span>
            <span className="status">在职</span>
          </div>
        </div>
        <p className="ux-hint">根因：用户表六列共用档案授权模板（…90px 65px 34px），「角色操作」列仅 90px，内部 ≈210px 内容溢出可见绘制，压印右侧列文字 →「移除用/授疑」。</p>
      </div>
      <div className="ux-ghost-col">
        <span className="section-label">修复后（独立列模板）</span>
        <div className="ux-ghost-table after">
          <div className="ux-ghost-row">
            <span>陈立</span>
            <span>诉讼业务部</span>
            <span className="chip">项目负责人 ×</span>
            <span className="ops roomy">
              <i className="sel">项目成员 ▾</i>
              <b className="btn">授予</b>
              <b className="btn">移除</b>
            </span>
            <span className="status">在职</span>
            <span className="stop">停用</span>
          </div>
        </div>
        <p className="ux-hint">修复：users-table 独立 grid 列模板（角色操作列 ≥235px）+ .revoke-inline wrap 兜底。真机前后截图：D:\tmp\shots-iter7-proto\ghost-before-broken.png / ghost-after-fixed.png。</p>
      </div>
    </div>
  );
}

/* ---------- 主面板 ---------- */
export function UxDemoPanels({ tab, setTab, persona }: { tab: string; setTab: (t: string) => void; persona: Persona }) {
  const { toasts, push } = useToasts();
  const [openDialog, setOpenDialog] = useState<"user" | "receipt" | "request" | null>(null);

  const closeDialog = () => setOpenDialog(null);
  const notify = (k: Toast["kind"], t: string) => push(k, t);

  return (
    <div className="ux-panels">
      <div className="ux-tabstrip" role="tablist" aria-label="原型样例目录">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "ia" ? (
        <section className="ux-panel">
          <span className="eyebrow">IA REDESIGN</span>
          <h1>新 IA：系统级 vs 项目级</h1>
          <p>顶栏五组下拉（总览/项目/协同/经营/治理）承载全部系统级业务导航；配置中心/账号设置/退出登录收进头像菜单——顶栏超载与退出溢出根治（arch/10 §1.1）。</p>
          <ul className="ux-list">
            <li>角色过滤：无权限的组/项不渲染——当前演示角色 <strong>{PERSONA_LABEL[persona]}</strong>（用顶部演示条切换，member 不见权限审计/收款台账/配置中心）。</li>
            <li>组内高亮：当前组按钮与菜单项高亮（含子路由命中语义示意）。</li>
            <li>键盘可达：Enter/Space 打开菜单，↑↓ 移动，Home/End 跳首末项，Esc 关闭并焦点回触发钮。</li>
            <li>防溢出硬规则（§1.2）：角色化项数 + 分组下拉保证；走查含 1280/1440/1920 三档无溢出断言（截图 w-ia-*）。</li>
            <li>项目级内容只在左侧「项目索引」与项目空间呈现，不与顶栏混排。</li>
            <li>移动 ≤820px：汉堡抽屉按五组分区 + 系统区（配置入口在抽屉底部）。</li>
          </ul>
        </section>
      ) : null}

      {tab === "grp-overview" ? (
        <section className="ux-panel">
          <span className="eyebrow">OVERVIEW GROUP</span>
          <h1>总览（E6 标题规范：eyebrow + 标题 + 一句话说明）</h1>
          <p>驾驶舱与我的工作台；干净系统首 run 的空状态给「下一步做什么」引导（E1）。</p>
          <div className="ux-empty">
            <strong>暂无可见项目</strong>
            <p>下一步：① 请 sysadmin 在「系统配置中心 → 客户与事项」创建客户与事项；② 合伙人立项后你将被加入项目。</p>
            <button className="secondary-action" onClick={() => notify("success", "已打开配置中心（示意）")}>前往配置中心（示意）</button>
          </div>
          <div className="ux-sample">
            <span className="section-label">E2 · 加载骨架（替零散 loading 文案）</span>
            <div className="ux-skeleton-block">
              <div className="ux-skeleton line w40" />
              <div className="ux-skeleton line w80" />
              <div className="ux-skeleton line w60" />
              <div className="ux-skeleton card" />
            </div>
          </div>
        </section>
      ) : null}

      {tab === "grp-project" ? (
        <section className="ux-panel">
          <span className="eyebrow">PROJECT GROUP</span>
          <h1>项目</h1>
          <p>项目全周期与甘特计划为系统级入口；项目内容本体在左索引与项目空间页签（E5 面包屑 + E4 密度）。</p>
          <nav className="ux-breadcrumb" aria-label="面包屑（E5）">
            <button className="text-action" onClick={() => setTab("ia")}>项目全周期</button>
            <span>›</span>
            <span>华宸贸易合同纠纷代理·一审</span>
            <span>›</span>
            <strong>任务</strong>
          </nav>
          <DensityTable />
        </section>
      ) : null}

      {tab === "grp-collab" ? (
        <section className="ux-panel">
          <span className="eyebrow">COLLABORATION GROUP</span>
          <h1>协同</h1>
          <p>会议/出差/申请单；创建类操作弹窗化（§2），样例见「弹窗范式」。</p>
          <div className="ux-sample">
            <button className="primary-action" onClick={() => setOpenDialog("request")}>发起申请单（Dialog 范式）</button>
          </div>
        </section>
      ) : null}

      {tab === "grp-ops" ? (
        <section className="ux-panel">
          <span className="eyebrow">OPERATIONS GROUP</span>
          <h1>经营</h1>
          <p>工时/预算/费用/收款/审批；角色过滤下 member 不见「收款台账」。操作反馈走统一 Toast（E3）。</p>
          <div className="ux-sample row">
            <button className="secondary-action" onClick={() => notify("success", "报销单已提交（示意）：下一步=等待财务审批")}>触发成功 Toast</button>
            <button className="secondary-action" onClick={() => notify("error", "提交失败（示意）：金额超出可用预算")}>触发失败 Toast</button>
            <button className="primary-action" onClick={() => setOpenDialog("receipt")}>登记收款（Drawer 范式）</button>
          </div>
        </section>
      ) : null}

      {tab === "grp-gov" ? (
        <section className="ux-panel">
          <span className="eyebrow">GOVERNANCE GROUP</span>
          <h1>治理</h1>
          <p>质量/决策/档案/权限审计（member 不可见）；高危操作统一红条+后果回显二次确认（E7）。</p>
          <DangerSample notify={notify} />
        </section>
      ) : null}

      {tab === "dialogs" ? (
        <section className="ux-panel">
          <span className="eyebrow">MODAL PARADIGMS</span>
          <h1>弹窗范式（Dialog / Drawer）</h1>
          <p>创建/编辑一律弹窗：标题、字段校验映射、防重复提交、Esc/遮罩关闭、首字段自动聚焦、关闭后焦点还原（§2）。</p>
          <div className="ux-sample row">
            <button className="primary-action" onClick={() => setOpenDialog("user")}>创建用户（Dialog）</button>
            <button className="primary-action" onClick={() => setOpenDialog("receipt")}>登记收款（Drawer）</button>
            <button className="primary-action" onClick={() => setOpenDialog("request")}>发起申请单（Dialog）</button>
          </div>
        </section>
      ) : null}

      {tab === "samples" ? (
        <section className="ux-panel">
          <span className="eyebrow">E1 – E7 SAMPLES</span>
          <h1>发散体验项样例清单</h1>
          <div className="ux-sample"><span className="section-label">E1 空状态引导</span><p className="ux-hint">见「总览组」空状态卡（下一步引导 + 动作入口）。</p></div>
          <div className="ux-sample"><span className="section-label">E2 骨架屏</span><p className="ux-hint">见「总览组」骨架样例（ shimmer 动画）。</p></div>
          <div className="ux-sample"><span className="section-label">E3 操作反馈统一</span><p className="ux-hint">成功/失败 Toast 统一样式含结果与下一步入口；正式接入用 sonner（本原型为等效视觉示意）。</p></div>
          <DensityTable />
          <div className="ux-sample"><span className="section-label">E5 面包屑与返回</span><p className="ux-hint">见「项目组」面包屑样例；浏览器返回恢复筛选/滚动在接入期实现。</p></div>
          <div className="ux-sample"><span className="section-label">E6 页面标题规范</span><p className="ux-hint">每页 eyebrow + 标题 + 一句话说明（本原型所有面板已按此格式）。</p></div>
          <DangerSample notify={notify} />
        </section>
      ) : null}

      {tab === "ghost" ? (
        <section className="ux-panel">
          <span className="eyebrow">GHOSTING FIX</span>
          <h1>按钮重影根因修复与前后对比</h1>
          <p>用户实测「授予/移除/停用」文字叠印（实证）。根因=表格列模板与内容宽度不匹配导致的溢出绘印（非多态文本重复渲染、非阴影叠加）。</p>
          <GhostCompare />
        </section>
      ) : null}

      {openDialog === "user" ? <UserDialog onClose={closeDialog} notify={notify} /> : null}
      {openDialog === "receipt" ? <ReceiptDrawer onClose={closeDialog} notify={notify} /> : null}
      {openDialog === "request" ? <RequestDialog onClose={closeDialog} notify={notify} /> : null}
      <ToastStack toasts={toasts} />
    </div>
  );
}
