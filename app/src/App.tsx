import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, ArrowRight, Bell, CalendarDays, Check, CheckCircle2, ChevronRight,
  CircleAlert, Clock3, Command, FileCheck2, FileText, Focus, FolderOpen,
  GitBranch, Menu, Network, Search, ShieldCheck,
  Sparkles, X, ZoomIn
} from 'lucide-react'
import './App.css'
import {
  ArchiveContext, ArchiveScreen, AuditContext, AuditScreen, DecisionContext,
  DecisionScreen, QualityContext, QualityScreen, WorkbenchContext, WorkbenchScreen,
  archiveFilesSeed, type ArchiveFile,
} from './sections/ExpandedScreens'

type View = 'cockpit' | 'workbench' | 'project' | 'gantt' | 'quality' | 'decision' | 'archive' | 'audit'
type Toast = { title: string; detail: string } | null

const projects = [
  { id: 'LF-26031', name: '远洲科技并购专项', type: '并购 · 交割准备', health: '风险', progress: 68, client: '远洲科技有限公司', manager: '林岚', milestone: '交割文件定稿' },
  { id: 'LF-26028', name: '衡远资本合规审查', type: '合规 · 整改复核', health: '正常', progress: 82, client: '衡远资本管理有限公司', manager: '周其', milestone: '整改复核报告' },
  { id: 'LF-26019', name: '青岳劳动争议系列案', type: '诉讼 · 证据交换', health: '正常', progress: 54, client: '青岳实业集团', manager: '许言', milestone: '证据交换完成' },
  { id: 'LF-26012', name: '星港数据出境评估', type: '数据合规 · 待决策', health: '受阻', progress: 41, client: '星港数字科技有限公司', manager: '沈宁', milestone: '出境评估定稿' },
]

const navItems: { id: View; label: string; index: string }[] = [
  { id: 'cockpit', label: '驾驶舱', index: '01' },
  { id: 'workbench', label: '我的工作台', index: '02' },
  { id: 'project', label: '项目全周期', index: '03' },
  { id: 'gantt', label: '甘特计划', index: '04' },
  { id: 'quality', label: '质量中心', index: '05' },
  { id: 'decision', label: '决策中心', index: '06' },
  { id: 'archive', label: '档案中心', index: '07' },
  { id: 'audit', label: '权限审计', index: '08' },
]

function BrandMark() {
  return <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
}

function HealthOrb({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'health-orb compact' : 'health-orb'} aria-label="项目组合健康度 86 分">
      <svg viewBox="0 0 260 260" role="img" aria-hidden="true">
        <circle className="orb-track" cx="130" cy="130" r="102" />
        <circle className="orb-value" cx="130" cy="130" r="102" pathLength="100" strokeDasharray="86 100" />
        <circle className="orb-inner" cx="130" cy="130" r="78" />
        <path className="orb-tick" d="M130 14v10M130 236v10M14 130h10M236 130h10" />
      </svg>
      <div className="orb-node node-a" /><div className="orb-node node-b" /><div className="orb-node node-c" />
      <div className="orb-copy"><span>PORTFOLIO HEALTH</span><strong>86</strong><small>较上周 +4</small></div>
    </div>
  )
}

function Cockpit({ onNavigate, onDecision }: { onNavigate: (v: View) => void; onDecision: () => void }) {
  return (
    <div className="screen cockpit-screen">
      <div className="screen-heading">
        <div><span className="eyebrow">MONDAY · 26 OCT 2026</span><h1>早上好，周合伙人。</h1><p>24 个进行中的项目里，有 3 项需要你的判断。</p></div>
        <button className="primary-action" onClick={() => onNavigate('project')}>进入项目空间<ArrowRight size={16} /></button>
      </div>
      <div className="cockpit-hero">
        <div className="hero-notes left-notes">
          <span className="section-label">本周交付</span><strong>17<span>项</span></strong><p>14 项按期完成</p>
          <div className="mini-line"><i style={{ width: '82%' }} /></div>
        </div>
        <HealthOrb />
        <div className="hero-notes right-notes">
          <span className="section-label">重大风险</span><strong className="risk-number">03<span>项</span></strong><p>2 项来自时间—质量冲突</p>
          <button className="text-action" onClick={onDecision}>进入决策中心<ArrowRight size={15} /></button>
        </div>
      </div>
      <div className="metric-strip">
        <div><span>里程碑按期率</span><strong>91.2%</strong><small>目标 ≥ 90%</small></div>
        <div><span>延期恢复中</span><strong>06</strong><small>2 项本周到期</small></div>
        <div><span>待复核质量问题</span><strong>08</strong><small>严重问题 1 项</small></div>
        <div><span>归档完整度</span><strong>96.4%</strong><small>3 份周报待提交</small></div>
      </div>
      <div className="cockpit-lower">
        <section className="project-focus">
          <div className="section-heading"><div><span className="section-label">需要关注</span><h2>项目脉搏</h2></div><button className="text-action" onClick={onDecision}>风险决策<ArrowRight size={14} /></button></div>
          {projects.slice(0, 3).map((project, index) => (
            <button className="focus-row" key={project.id} onClick={() => onNavigate(index === 0 ? 'gantt' : 'project')}>
              <span className={`status-dot ${project.health === '正常' ? 'ok' : 'warn'}`} />
              <span className="focus-name"><strong>{project.name}</strong><small>{project.id} · {project.type}</small></span>
              <span className="focus-progress"><i style={{ width: `${project.progress}%` }} /></span>
              <span className="focus-value">{project.progress}%</span><ChevronRight size={16} />
            </button>
          ))}
        </section>
        <section className="week-signal">
          <span className="section-label">WEEK 43 · 风险信号</span><h2>延期不再只是一个红色日期。</h2>
          <div className="signal-line"><span>原因</span><i /><span>影响</span><i /><span>方案</span><i /><span>决策</span></div>
          <p>每一次变化都有书面原因、责任人和恢复检查点，并自动进入项目档案。</p>
          <button className="text-action" onClick={() => onNavigate('gantt')}>查看延期闭环<ArrowRight size={15} /></button>
        </section>
      </div>
    </div>
  )
}

const stages = ['立项', '计划', '执行', '交付', '归档']

function ProjectScreen({ project, onGantt, onAction }: { project: (typeof projects)[number]; onGantt: () => void; onAction: (kind: 'progress' | 'weekly') => void }) {
  return (
    <div className="screen project-screen">
      <div className="project-title-row">
        <div><div className="breadcrumb"><span>项目</span><ChevronRight size={13} /><span>{project.id}</span></div><h1>{project.name}</h1><p>{project.type} · 项目负责人：{project.manager} · 保密等级：严格</p></div>
        <div className="title-actions"><button className="secondary-action" onClick={() => onAction('weekly')}><FileText size={16} />生成本周周报</button><button className="primary-action" onClick={() => onAction('progress')}>更新进度<ArrowRight size={16} /></button></div>
      </div>
      <div className="lifecycle-rail">
        {stages.map((stage, i) => <div className={`lifecycle-stage ${i < 2 ? 'done' : i === 2 ? 'active' : ''}`} key={stage}><span>{i < 2 ? <Check size={14} /> : `0${i + 1}`}</span><strong>{stage}</strong><small>{['09.14', '09.21', '当前阶段', '11.18', '11.25'][i]}</small></div>)}
      </div>
      <div className="project-overview-grid">
        <section className="next-milestone">
          <div className="section-label">NEXT MILESTONE · M04</div>
          <div className="milestone-date"><span>NOV</span><strong>06</strong></div>
          <h2>{project.milestone}</h2><p>还有 11 天 · 2 项前置任务 · 1 项质量门禁</p>
          <div className="gate-line"><ShieldCheck size={17} /><span>严重问题关闭后方可进入交付</span><strong>1 / 4</strong></div>
          <button className="text-action" onClick={onGantt}>查看计划与依赖<ArrowRight size={15} /></button>
        </section>
        <section className="progress-composition">
          <div className="section-heading"><div><span className="section-label">PROGRESS</span><h2>整体完成度</h2></div><strong className="big-number">{project.progress}<span>%</span></strong></div>
          <div className="segmented-progress"><i className="seg-a" /><i className="seg-b" /><i className="seg-c" /><i className="seg-d" /></div>
          <div className="progress-legend"><span><i className="legend-a" />已完成 34</span><span><i className="legend-b" />进行中 12</span><span><i className="legend-c" />受阻 2</span><span><i className="legend-d" />未开始 18</span></div>
          <div className="baseline-note"><GitBranch size={16} /><span>当前计划 V2</span><strong>较基线 +5 天</strong></div>
        </section>
      </div>
      <div className="workstream-grid">
        <section className="workstream-list">
          <div className="section-heading"><div><span className="section-label">WORKSTREAMS</span><h2>工作流与交付物</h2></div><span className="muted-label">6 个工作流</span></div>
          {[
            ['法律尽调', '100%', '尽调报告 · 已定稿', 'done'],
            ['交易文件', '76%', 'SPA 修订稿 V7 · 复核中', 'active'],
            ['监管审批', '55%', '经营者集中申报 · 进行中', 'active'],
            ['交割准备', '32%', '交割清单 · 2 项受阻', 'risk'],
          ].map(([name, progress, detail, state]) => <div className="workstream-row" key={name}><span className={`workstream-icon ${state}`}><FileCheck2 size={16} /></span><div><strong>{name}</strong><small>{detail}</small></div><span className="workstream-progress">{progress}</span></div>)}
        </section>
        <section className="quality-panel">
          <div className="section-label">QUALITY LOOP</div><h2>质量闭环</h2>
          <div className="quality-ring-row"><div className="quality-ring"><strong>12</strong><span>问题总数</span></div><div className="quality-stats"><span><i className="q-open" />处理中 <strong>3</strong></span><span><i className="q-review" />待复核 <strong>2</strong></span><span><i className="q-closed" />已关闭 <strong>7</strong></span></div></div>
          <div className="quality-insight"><Sparkles size={16} /><p>“附件完整性”已连续两周成为高频根因，建议更新交割清单模板。</p></div>
        </section>
      </div>
    </div>
  )
}

const ganttTasks = [
  { id: 1, name: '尽调问题关闭', owner: '陈澈', start: 4, width: 20, baseStart: 4, baseWidth: 20, state: 'done', milestone: false },
  { id: 2, name: 'SPA 条款复核', owner: '林岚', start: 24, width: 25, baseStart: 24, baseWidth: 25, state: 'active', milestone: false },
  { id: 3, name: '监管申报反馈', owner: '赵一', start: 43, width: 24, baseStart: 40, baseWidth: 22, state: 'delay', milestone: false },
  { id: 4, name: '交割文件定稿', owner: '林岚', start: 71, width: 4, baseStart: 65, baseWidth: 4, state: 'milestone', milestone: true },
  { id: 5, name: '签署与交付', owner: '项目组', start: 79, width: 17, baseStart: 73, baseWidth: 17, state: 'future', milestone: false },
]

function GanttScreen({ onDelay, onToast }: { onDelay: () => void; onToast: (t: Toast) => void }) {
  const [critical, setCritical] = useState(false)
  const [baseline, setBaseline] = useState(true)
  const [scale, setScale] = useState<'周' | '月'>('周')
  const [simulation, setSimulation] = useState(false)
  return (
    <div className="screen gantt-screen">
      <div className="project-title-row gantt-title">
        <div><div className="breadcrumb"><span>远洲科技并购专项</span><ChevronRight size={13} /><span>计划</span></div><h1>让每一次变化，都有迹可循。</h1><p>基线 V1 · 当前计划 V2 · 数据更新于 10:26</p></div>
        <button className={simulation ? 'primary-action' : 'secondary-action'} onClick={() => { setSimulation(!simulation); onToast(simulation ? { title: '已退出模拟', detail: '当前计划未发生变化。' } : { title: '进入模拟调整', detail: '预览影响不会写入正式计划。' }) }}><GitBranch size={16} />{simulation ? '退出模拟' : '模拟调整'}</button>
      </div>
      <div className="gantt-toolbar">
        <div className="toolbar-group"><button className={baseline ? 'tool-toggle active' : 'tool-toggle'} onClick={() => setBaseline(!baseline)}><span className="baseline-sample" />基线对比</button><button className={critical ? 'tool-toggle active' : 'tool-toggle'} onClick={() => setCritical(!critical)}><Focus size={15} />关键路径</button></div>
        <div className="toolbar-group"><button className="icon-button" aria-label="定位今天" onClick={() => onToast({ title: '已定位今天', detail: '时间轴已定位至 2026 年 10 月 26 日。' })}><CalendarDays size={16} /></button><div className="scale-switch"><button className={scale === '周' ? 'active' : ''} onClick={() => setScale('周')}>周</button><button className={scale === '月' ? 'active' : ''} onClick={() => setScale('月')}>月</button></div><button className="icon-button" aria-label="缩放时间轴" onClick={() => { setScale(scale === '周' ? '月' : '周'); onToast({ title: '时间轴比例已切换', detail: '保持当前里程碑位置不变。' }) }}><ZoomIn size={16} /></button></div>
      </div>
      {simulation && <div className="simulation-banner"><Sparkles size={16} /><span>模拟模式：若“监管申报反馈”再延后 3 天，将影响 2 个后续节点。</span><button onClick={onDelay}>查看影响并申请延期<ArrowRight size={15} /></button></div>}
      <div className={`gantt-board ${critical ? 'critical-focus' : ''}`}>
        <div className="gantt-head"><div>工作分解 / 责任人</div><div className="date-grid">{['10.05', '10.12', '10.19', '10.26', '11.02', '11.09', '11.16'].map(d => <span key={d}>{d}</span>)}</div></div>
        <div className="today-line"><span>今天</span></div>
        {ganttTasks.map(task => <div className={`gantt-row ${task.state === 'delay' ? 'delayed-row' : ''}`} key={task.id}>
          <div className="task-label"><span className={`task-state ${task.state}`} /> <div><strong>{task.name}</strong><small>{task.owner} · {task.milestone ? '关键里程碑' : `TASK-0${task.id}`}</small></div>{task.state === 'delay' && <button className="delay-flag" onClick={onDelay}>+5 天</button>}</div>
          <div className="task-track"><div className="track-grid" />
            {baseline && <span className="baseline-bar" style={{ left: `${task.baseStart}%`, width: `${task.baseWidth}%` }} />}
            <button className={`task-bar ${task.state}`} style={{ left: `${task.start}%`, width: `${task.width}%` }} onClick={task.state === 'delay' || task.milestone ? onDelay : () => onToast({ title: task.name, detail: `${task.owner}负责 · 当前任务状态正常。` })} aria-label={`查看${task.name}`}>
              {task.milestone ? <span className="milestone-diamond" /> : <span className="bar-fill" style={{ width: task.state === 'done' ? '100%' : task.state === 'active' ? '58%' : task.state === 'delay' ? '45%' : '0%' }} />}
            </button>
          </div>
        </div>)}
        <div className="gantt-foot"><div><span className="legend-line baseline" />原始基线</div><div><span className="legend-line current" />当前计划</div><div><span className="legend-line delayed" />延期影响</div><span className="gantt-scale-label">{scale === '周' ? '周视图 · 7 个时间节点' : '月视图 · 保持同一数据比例'}</span></div>
      </div>
      <div className="gantt-bottom-grid">
        <section><span className="section-label">CHANGE LOG</span><h2>计划变更记录</h2><div className="change-entry"><span>V2</span><div><strong>监管反馈节点延期 5 天</strong><small>外部反馈延迟 · 恢复方案执行中 · 林岚审批</small></div><time>10.24</time></div><div className="change-entry"><span>V1</span><div><strong>项目计划基线确认</strong><small>6 个里程碑 · 42 项任务 · 周合伙人批准</small></div><time>09.21</time></div></section>
        <section className="impact-summary"><span className="section-label">RECOVERY</span><h2>恢复方案进度</h2><strong>2 / 3</strong><p>复核资源已增加，下一轮检查在 10 月 28 日。</p><div className="mini-line"><i style={{ width: '66%' }} /></div><button className="text-action" onClick={onDelay}>查看书面方案<ArrowRight size={15} /></button></section>
      </div>
    </div>
  )
}

function ContextRail({ view, project, archiveFile, onDecision, onToast }: { view: View; project: (typeof projects)[number]; archiveFile: ArchiveFile | null; onDecision: () => void; onToast: (value: Toast) => void }) {
  if (view === 'workbench') return <WorkbenchContext />
  if (view === 'quality') return <QualityContext />
  if (view === 'decision') return <DecisionContext />
  if (view === 'archive') return <ArchiveContext file={archiveFile} onToast={onToast} />
  if (view === 'audit') return <AuditContext />
  if (view === 'cockpit') return <aside className="context-rail"><div className="context-heading"><span className="section-label">DECISION QUEUE</span><h2>待你决策</h2><span className="count-badge">3</span></div><button className="decision-card urgent" onClick={onDecision}><span>时间 — 质量冲突</span><strong>星港数据出境评估</strong><p>若按原计划交付，2 项严重问题将无法完成复核。</p><small>今天 16:00 前<ChevronRight size={14} /></small></button><button className="decision-card" onClick={onDecision}><span>重大延期审批</span><strong>远洲科技并购专项</strong><p>关键里程碑预计延期 5 天，恢复方案已提交。</p><small>剩余 6 小时<ChevronRight size={14} /></small></button><div className="context-section"><div className="section-label">UPCOMING</div><h2>接下来</h2><div className="agenda-item"><time>14:30</time><span>并购专项质量复核会</span></div><div className="agenda-item"><time>16:00</time><span>项目组合周会</span></div></div><div className="assurance"><ShieldCheck size={17} /><span>仅显示你权限范围内的项目与决策。</span></div></aside>
  if (view === 'project') return <aside className="context-rail"><div className="context-heading"><span className="section-label">PROJECT CONTEXT</span><h2>项目情境</h2></div><div className="client-block"><span>客户</span><strong>{project.client}</strong><small>项目负责人 {project.manager} · 质量负责人 何川</small></div><div className="context-section"><div className="section-label">ATTENTION</div><h2>需要关注</h2><div className="attention-item"><CircleAlert size={16} /><div><strong>1 项严重质量问题</strong><p>交易附件清单与正文版本不一致。</p></div></div><div className="attention-item"><Clock3 size={16} /><div><strong>2 项任务临期</strong><p>均在 48 小时内到期。</p></div></div></div><div className="context-section"><div className="section-label">AUTO ARCHIVE</div><h2>本周归档</h2><div className="archive-progress"><FolderOpen size={22} /><strong>18 / 20</strong><span>份过程文件已归集</span></div><div className="mini-line"><i style={{ width: '90%' }} /></div><p className="context-note">缺：监管反馈会议纪要、周报确认版</p></div><div className="activity-feed"><span>10:18</span><p><strong>何川</strong> 完成 SPA 修订稿 V7 复核</p><span>09:42</span><p><strong>系统</strong> 自动归集 3 份过程文件</p></div></aside>
  return <aside className="context-rail"><div className="context-heading"><span className="section-label">PLAN INSIGHT</span><h2>计划洞察</h2></div><div className="plan-score"><span>计划稳定度</span><strong>74</strong><small>本月发生 2 次关键变更</small></div><div className="context-section"><div className="section-label">DEPENDENCY</div><h2>当前依赖链</h2><div className="dependency-chain"><span>监管申报反馈</span><i /><span>交割文件定稿</span><i /><span>签署与交付</span></div></div><div className="context-section"><div className="section-label">EXCEPTION</div><h2>例外说明</h2><p className="context-note">任何关键节点改期均需书面原因与恢复方案。原始基线不会被覆盖。</p></div><button className="context-link" onClick={onDecision}>查看延期审批标准<ChevronRight size={15} /></button><div className="assurance"><Archive size={17} /><span>变更、审批与解决方案自动归入“02_计划基线与变更”。</span></div></aside>
}

function DelayDrawer({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: () => void }) {
  const [reason, setReason] = useState('监管反馈晚于计划时间返回，需补充两项业务说明。')
  const [solution, setSolution] = useState('增加一名复核律师并行处理；10 月 28 日检查反馈进度。')
  const [error, setError] = useState('')
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (open) setTimeout(() => closeRef.current?.focus(), 50) }, [open])
  useEffect(() => { const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && open) onClose() }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler) }, [open, onClose])
  if (!open) return null
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className="delay-drawer" role="dialog" aria-modal="true" aria-labelledby="delay-title"><div className="drawer-head"><div><span className="section-label">CHANGE REQUEST · CR-004</span><h2 id="delay-title">关键节点延期申请</h2></div><button ref={closeRef} className="icon-button" aria-label="关闭延期申请" onClick={onClose}><X size={19} /></button></div><div className="delay-dates"><div><span>原计划</span><strong>2026.11.01</strong></div><ArrowRight size={20} /><div className="new-date"><span>申请完成</span><strong>2026.11.06</strong></div><span className="days-badge">+5 天</span></div><div className="impact-box"><span className="section-label">IMPACT PREVIEW</span><h3>系统识别到 2 个受影响节点</h3><div><span>交割文件定稿</span><strong>11.03 → 11.08</strong></div><div><span>签署与交付</span><strong>11.10 → 11.15</strong></div><p><ShieldCheck size={15} />质量检查时间保持不变，不自动压缩。</p></div><label className="form-field"><span>延期原因与书面说明 <b>必填</b></span><textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} /></label><label className="form-field"><span>解决方案与恢复检查点 <b>必填</b></span><textarea value={solution} onChange={e => setSolution(e.target.value)} rows={3} /></label><div className="owner-line"><div><span>方案责任人</span><strong>林岚</strong></div><div><span>恢复检查</span><strong>2026.10.28</strong></div></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="drawer-note"><Archive size={16} />提交后将生成变更记录，并自动归档至本项目。</div><div className="drawer-actions"><button className="secondary-action" onClick={onClose}>取消</button><button className="primary-action" onClick={() => { if (!reason.trim() || !solution.trim()) { setError('请完整填写延期原因和解决方案。'); return } onSubmit() }}>提交审批<ArrowRight size={16} /></button></div></section></div>
}

function DecisionModal({ open, onClose, onToast }: { open: boolean; onClose: () => void; onToast: (t: Toast) => void }) {
  if (!open) return null
  return <div className="overlay centered" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className="decision-modal" role="dialog" aria-modal="true" aria-labelledby="decision-title"><div className="drawer-head"><div><span className="section-label">DECISION REQUIRED</span><h2 id="decision-title">时间与质量，如何取舍？</h2></div><button className="icon-button" aria-label="关闭决策" onClick={onClose}><X size={19} /></button></div><p className="modal-intro">星港数据出境评估 · 2 项严重问题尚未完成复核</p><div className="option-grid"><button onClick={() => { onToast({ title: '已选择延期保质量', detail: '系统将生成项目决策单并进入审批。' }); onClose() }}><span>方案 A · 建议</span><strong>延期 5 天，保留完整复核</strong><p>质量风险最低，客户交付日需同步调整。</p></button><button onClick={() => { onToast({ title: '已选择增加资源', detail: '系统将生成资源调整任务和决策记录。' }); onClose() }}><span>方案 B</span><strong>增加 2 名复核人员</strong><p>保持交付日期，增加跨项目资源协调。</p></button></div><div className="drawer-note"><ShieldCheck size={16} />最终决定、理由与附加条件将永久留痕。</div></section></div>
}

function App() {
  const [view, setView] = useState<View>('cockpit')
  const [selectedProject, setSelectedProject] = useState(0)
  const [archiveFiles, setArchiveFiles] = useState<ArchiveFile[]>(archiveFilesSeed)
  const [selectedArchiveFile, setSelectedArchiveFile] = useState<ArchiveFile | null>(archiveFilesSeed[0])
  const [delayOpen, setDelayOpen] = useState(false)
  const [decisionOpen, setDecisionOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState<Toast>(null)
  const [mobileRail, setMobileRail] = useState(false)
  const [actionModal, setActionModal] = useState<'progress' | 'weekly' | null>(null)
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 3600); return () => clearTimeout(t) } }, [toast])
  useEffect(() => { const handler = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCommandOpen(v => !v) } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler) }, [])
  const commandResults = useMemo(() => [
    ...navItems.map(n => ({ label: n.label, detail: '功能视图', action: () => { setView(n.id); setCommandOpen(false) } })),
    ...projects.map((p, i) => ({ label: p.name, detail: p.id, action: () => { setSelectedProject(i); setView('project'); setCommandOpen(false) } })),
    ...archiveFiles.map(f => ({ label: f.name, detail: `${f.id} · ${f.type}`, action: () => { setSelectedArchiveFile(f); setView('archive'); setCommandOpen(false) } })),
  ].filter(item => item.label.includes(query) || item.detail.toLowerCase().includes(query.toLowerCase())), [query, archiveFiles])
  const navigate = (v: View) => { setView(v); setMobileRail(false) }
  return (
    <div className="concept-app">
      <header className="topbar"><div className="brand"><BrandMark /><div><strong>LEXFLOW</strong><span>律所项目治理平台</span></div></div><nav className="concept-nav" aria-label="概念稿导航">{navItems.map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><span>{item.index}</span>{item.label}</button>)}</nav><div className="top-actions"><button className="search-trigger" onClick={() => setCommandOpen(true)}><Search size={16} /><span>搜索项目、任务、档案</span><kbd>⌘ K</kbd></button><div className="notification-wrap"><button className="icon-button dark" aria-label="查看通知" onClick={() => setNotificationsOpen(!notificationsOpen)}><Bell size={18} /><i /></button>{notificationsOpen && <div className="notification-popover"><span className="section-label">NOTIFICATIONS</span><strong>3 条待处理</strong><p>远洲科技并购专项：延期审批剩余 6 小时</p><p>质量复核会将在今天 14:30 开始</p><button onClick={() => { setNotificationsOpen(false); setDecisionOpen(true) }}>查看待办<ArrowRight size={14} /></button></div>}</div><div className="avatar" title="周合伙人">周</div><button className="icon-button dark mobile-menu" aria-label="打开项目索引" onClick={() => setMobileRail(!mobileRail)}><Menu size={18} /></button></div></header>
      <div className="app-body">
        <aside className={`project-rail ${mobileRail ? 'mobile-open' : ''}`}><div className="rail-heading"><span>项目索引</span><strong>24</strong></div><div className="rail-list">{projects.map((p, i) => <button key={p.id} className={selectedProject === i ? 'active' : ''} onClick={() => { setSelectedProject(i); navigate('project') }}><span className={`status-dot ${p.health === '正常' ? 'ok' : 'warn'}`} /><div><strong>{p.name}</strong><small>{p.id}</small></div><span className="rail-progress">{p.progress}</span></button>)}</div><button className="all-projects" onClick={() => navigate('cockpit')}>查看全部项目<ArrowRight size={14} /></button><div className="rail-bottom"><Network size={16} /><span>信息墙已启用</span><small>NEED-TO-KNOW ACCESS</small></div></aside>
        <main className="main-workspace">
          {view === 'cockpit' && <Cockpit onNavigate={navigate} onDecision={() => setDecisionOpen(true)} />}
          {view === 'workbench' && <WorkbenchScreen onNavigate={navigate} onToast={setToast} />}
          {view === 'project' && <ProjectScreen project={projects[selectedProject]} onGantt={() => navigate('gantt')} onAction={setActionModal} />}
          {view === 'gantt' && <GanttScreen onDelay={() => setDelayOpen(true)} onToast={setToast} />}
          {view === 'quality' && <QualityScreen onToast={setToast} />}
          {view === 'decision' && <DecisionScreen onToast={setToast} />}
          {view === 'archive' && <ArchiveScreen files={archiveFiles} setFiles={setArchiveFiles} selectedFile={selectedArchiveFile} onSelectFile={setSelectedArchiveFile} onToast={setToast} />}
          {view === 'audit' && <AuditScreen onToast={setToast} />}
        </main>
        <ContextRail view={view} project={projects[selectedProject]} archiveFile={selectedArchiveFile} onDecision={() => setDecisionOpen(true)} onToast={setToast} />
      </div>
      <DelayDrawer open={delayOpen} onClose={() => setDelayOpen(false)} onSubmit={() => { setDelayOpen(false); setToast({ title: '延期申请已提交', detail: '审批单 CR-004 已生成，并自动归入项目档案。' }) }} />
      <DecisionModal open={decisionOpen} onClose={() => setDecisionOpen(false)} onToast={setToast} />
      {commandOpen && <div className="overlay centered" onMouseDown={e => { if (e.target === e.currentTarget) setCommandOpen(false) }}><section className="command-palette" role="dialog" aria-modal="true" aria-label="全局搜索"><div className="command-input"><Command size={19} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索项目、任务、档案或功能…" /><button className="icon-button" aria-label="关闭搜索" onClick={() => setCommandOpen(false)}><X size={17} /></button></div><div className="command-results">{commandResults.length ? commandResults.map(item => <button key={item.label} onClick={item.action}><span><strong>{item.label}</strong><small>{item.detail}</small></span><ArrowRight size={15} /></button>) : <p>没有匹配结果，试试项目编号或功能名称。</p>}</div></section></div>}
      {actionModal && <div className="overlay centered" onMouseDown={e => { if (e.target === e.currentTarget) setActionModal(null) }}><section className="decision-modal compact-modal" role="dialog" aria-modal="true"><div className="drawer-head"><div><span className="section-label">{actionModal === 'weekly' ? 'WEEKLY REPORT' : 'PROGRESS UPDATE'}</span><h2>{actionModal === 'weekly' ? '本周项目周报已生成草稿' : '更新项目进度'}</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setActionModal(null)}><X size={19} /></button></div>{actionModal === 'weekly' ? <><div className="weekly-preview"><CheckCircle2 size={22} /><p>已汇总 6 项完成任务、1 次计划变更、3 项质量问题和 18 份过程文件。</p></div><button className="primary-action full-action" onClick={() => { setActionModal(null); setToast({ title: '周报已提交归档', detail: '2026 年第 43 周周报已生成固定版本。' }) }}>确认并提交<ArrowRight size={16} /></button></> : <><label className="form-field"><span>整体完成度</span><input type="number" defaultValue="68" min="0" max="100" /></label><label className="form-field"><span>本次进展说明</span><textarea rows={3} defaultValue="交易文件复核持续推进，监管反馈恢复方案按计划执行。" /></label><button className="primary-action full-action" onClick={() => { setActionModal(null); setToast({ title: '进度已更新', detail: '相关视图和周报草稿已同步。' }) }}>保存更新<Check size={16} /></button></>}</section></div>}
      {toast && <div className="toast" role="status"><CheckCircle2 size={19} /><div><strong>{toast.title}</strong><p>{toast.detail}</p></div><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={15} /></button></div>}
    </div>
  )
}

export default App
