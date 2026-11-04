import { useEffect, useRef, useState } from "react";

/**
 * 迭代 9a 表单四范式样例（arch/12 §5）：F1 线索 Dialog / F2 报销抽屉（明细行编辑）
 * / F3 客户多页签 Dialog（页签校验红点）/ F4 新建项目分步 Stepper。
 */

function Overlay({ onClose, children, wide }: { onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea");
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
  return (
    <div className="ux-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className={`p9a-modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" ref={ref}>
        {children}
      </section>
    </div>
  );
}

/* F1：新建线索 Dialog（≤8 字段单区块） */
function LeadDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  return (
    <Overlay onClose={onClose}>
      <div className="p9a-modal-head"><div><span className="section-label">F1 · DIALOG</span><h2>新建线索</h2></div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>×</button></div>
      <p className="context-note">首字段聚焦；fieldErrors 字段下红字；防重复提交。</p>
      <div className="p9a-field-grid">
        <label className="form-field"><span>线索名称 *</span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} />
          {errors.name ? <em className="ux-err">{errors.name}</em> : null}</label>
        <label className="form-field"><span>来源</span>
          <select defaultValue="referral"><option value="referral">老客推荐</option><option value="web">官网表单</option><option value="phone">来电咨询</option></select></label>
        <label className="form-field"><span>联系人 *</span><input defaultValue="" placeholder="姓名" /></label>
        <label className="form-field"><span>联系电话 *</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!errors.phone} />
          {errors.phone ? <em className="ux-err">{errors.phone}</em> : null}</label>
        <label className="form-field"><span>负责人</span><select defaultValue=""><option>梁奇烽（partner 兼任）</option><option>王宝茁</option></select></label>
      </div>
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onClose}>取消</button>
        <button className="primary-action p9a-ripple" disabled={pending}
          onClick={() => {
            const errs: Record<string, string> = {};
            if (!name.trim()) errs.name = "线索名称必填（fieldErrors.name）";
            if (!phone.trim()) errs.phone = "联系电话必填（fieldErrors.phone）";
            setErrors(errs);
            if (Object.keys(errs).length) return;
            setPending(true);
            window.setTimeout(() => { setPending(false); onClose(); }, 600);
          }}>
          {pending ? "创建中…" : "创建线索"}
        </button>
      </div>
    </Overlay>
  );
}

/* F2：报销抽屉（宽表单 + 明细行编辑器） */
function ExpenseDrawer({ onClose }: { onClose: () => void }) {
  const [lines, setLines] = useState([{ key: 1, category: "差旅费", amount: "1280.00" }]);
  return (
    <Overlay onClose={onClose} wide>
      <div className="p9a-modal-head"><div><span className="section-label">F2 · DRAWER（右侧 560–720px 滑入 · 头尾固定体滚动）</span><h2>新建费用报销</h2></div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>×</button></div>
      <div className="p9a-drawer-body">
        <div className="p9a-field-grid two">
          <label className="form-field"><span>报销人</span><input defaultValue="管晨" /></label>
          <label className="form-field"><span>项目</span><select defaultValue="a"><option value="a">比博思特技术服务项目</option></select></label>
          <label className="form-field"><span>事由 *</span><input defaultValue="客户现场服务差旅" /></label>
        </div>
        <span className="section-label">明细行编辑器</span>
        {lines.map((l, idx) => (
          <div className="p9a-line-row" key={l.key}>
            <select value={l.category} aria-label="费用类别"
              onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, category: e.target.value } : x)))}>
              {["差旅费", "招待费", "办公费", "培训费", "通讯费", "资料费", "会议费", "其他"].map((c) => <option key={c}>{c}</option>)}
            </select>
            <input value={l.amount} aria-label="金额" inputMode="decimal"
              onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, amount: e.target.value } : x)))} />
            <span className="entry-unit">元</span>
            <button className="icon-button" aria-label="删除明细行" disabled={lines.length === 1}
              onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}>×</button>
          </div>
        ))}
        <button className="secondary-action" onClick={() => setLines((ls) => [...ls, { key: Date.now(), category: "办公费", amount: "" }])}>
          ＋ 添加明细行
        </button>
      </div>
      <div className="p9a-modal-foot">
        <span>合计 <strong className="mono">{lines.reduce((s, l) => s + (Number(l.amount) || 0), 0).toFixed(2)}</strong> 元（服务端计算口径为准）</span>
        <div className="row-ops">
          <button className="secondary-action" onClick={onClose}>取消</button>
          <button className="primary-action p9a-ripple" onClick={onClose}>提交报销</button>
        </div>
      </div>
    </Overlay>
  );
}

/* F3：客户新建多页签 Dialog（页签校验红点） */
function CustomerWizardDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState(0);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [dirty, setDirty] = useState<Record<number, boolean>>({});
  const tabs = ["基本信息", "联系人", "备注"];
  const invalid = (i: number) => (i === 0 && !name.trim()) || (i === 1 && !contact.trim());
  return (
    <Overlay onClose={onClose}>
      <div className="p9a-modal-head"><div><span className="section-label">F3 · 多页签 DIALOG（页签校验红点）</span><h2>新建客户</h2></div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>×</button></div>
      <div className="p9a-wizard-tabs" role="tablist">
        {tabs.map((t, i) => (
          <button key={t} role="tab" aria-selected={tab === i} className={tab === i ? "active" : ""}
            onClick={() => { setTab(i); setDirty((d) => ({ ...d, [i]: true })); }}>
            {t}
            {dirty[i] && invalid(i) ? <i className="p9a-badge-dot" aria-label="该页签有未过校验" /> : null}
          </button>
        ))}
      </div>
      <div className="p9a-wizard-body">
        {tab === 0 ? (
          <label className="form-field"><span>客户名称 *</span>
            <input value={name} onChange={(e) => { setName(e.target.value); setDirty((d) => ({ ...d, 0: true })); }} aria-invalid={dirty[0] && !name.trim()} />
            {dirty[0] && !name.trim() ? <em className="ux-err">客户名称必填</em> : null}</label>
        ) : null}
        {tab === 1 ? (
          <label className="form-field"><span>首要联系人 *</span>
            <input value={contact} onChange={(e) => { setContact(e.target.value); setDirty((d) => ({ ...d, 1: true })); }} aria-invalid={dirty[1] && !contact.trim()} />
            {dirty[1] && !contact.trim() ? <em className="ux-err">联系人必填</em> : null}</label>
        ) : null}
        {tab === 2 ? <label className="form-field"><span>备注</span><textarea rows={3} /></label> : null}
      </div>
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onClose}>取消</button>
        <button className="primary-action p9a-ripple" onClick={onClose}>保存客户</button>
      </div>
    </Overlay>
  );
}

/* F4：新建项目分步 Stepper（基本→模板→成员→预算） */
function ProjectStepperDialog({ onClose }: { onClose: () => void }) {
  const steps = ["基本信息", "选择模板", "成员", "预算"];
  const [step, setStep] = useState(0);
  const [pname, setPname] = useState("");
  return (
    <Overlay onClose={onClose} wide>
      <div className="p9a-modal-head"><div><span className="section-label">F4 · 分步 STEPPER（步条固定顶 · 每步独立校验 · 可回退不丢数据）</span><h2>新建项目</h2></div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>×</button></div>
      <div className="p9a-stepper">
        {steps.map((s, i) => (
          <div key={s} className={`p9a-step ${i === step ? "current" : i < step ? "done" : ""}`}>
            <span>{i < step ? "✓" : i + 1}</span>{s}
          </div>
        ))}
      </div>
      <div className="p9a-wizard-body">
        {step === 0 ? (
          <label className="form-field"><span>项目名称 *</span>
            <input value={pname} onChange={(e) => setPname(e.target.value)} aria-invalid={step === 0 && !pname.trim()} />
            {!pname.trim() ? <em className="ux-err">项目名称必填（本步校验）</em> : null}</label>
        ) : null}
        {step === 1 ? <p className="context-note">模板选择（示意）：技术服务标准模板 / 诉讼案件标准模板。</p> : null}
        {step === 2 ? <p className="context-note">成员选择（示意）：负责人 + 项目成员。</p> : null}
        {step === 3 ? <p className="context-note">预算概算（示意）：总额 + 科目拆分。</p> : null}
      </div>
      <div className="drawer-actions">
        <button className="secondary-action" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>上一步</button>
        {step < steps.length - 1 ? (
          <button className="primary-action p9a-ripple" disabled={step === 0 && !pname.trim()} onClick={() => setStep((s) => s + 1)}>下一步</button>
        ) : (
          <button className="primary-action p9a-ripple" onClick={onClose}>创建项目</button>
        )}
      </div>
    </Overlay>
  );
}

/** 表单四范式样例页 */
export function FormsPanel({ title }: { title: string }) {
  const [open, setOpen] = useState<"f1" | "f2" | "f3" | "f4" | null>(null);
  return (
    <div className="p9a-forms">
      <span className="section-label">§5 表单体系四范式 · {title}</span>
      <div className="p9a-forms-grid">
        <button className="p9a-card p9a-form-card" onClick={() => setOpen("f1")}>
          <strong>F1 · 对话框 Dialog</strong><small>≤8 字段单区块：新建线索/客户/联系人/部门/收款登记</small></button>
        <button className="p9a-card p9a-form-card" onClick={() => setOpen("f2")}>
          <strong>F2 · 抽屉 Drawer</strong><small>宽表单带明细行：报销/经费/合同（付款计划）/发票开具</small></button>
        <button className="p9a-card p9a-form-card" onClick={() => setOpen("f3")}>
          <strong>F3 · 多页签 Dialog</strong><small>多区块长表单：客户新建（基本/联系人/备注）页签红点</small></button>
        <button className="p9a-card p9a-form-card" onClick={() => setOpen("f4")}>
          <strong>F4 · 分步 Stepper</strong><small>强流程：新建项目（基本→模板→成员→预算）可回退</small></button>
      </div>
      {open === "f1" ? <LeadDialog onClose={() => setOpen(null)} /> : null}
      {open === "f2" ? <ExpenseDrawer onClose={() => setOpen(null)} /> : null}
      {open === "f3" ? <CustomerWizardDialog onClose={() => setOpen(null)} /> : null}
      {open === "f4" ? <ProjectStepperDialog onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
