import { useMemo, useRef, useState } from 'react'
import {
  Archive, ArrowRight, BookOpenCheck, CalendarDays, Check, CheckCircle2,
  ChevronRight, CircleAlert, Clock3, Download, Eye,
  FileText, Filter, Folder, FolderOpen, History, KeyRound, Link2,
  LockKeyhole, Plus, RotateCcw, Search, ShieldAlert,
  ShieldCheck, Upload, UserCheck, UserX, X
} from 'lucide-react'

export type ToastValue = { title: string; detail: string } | null
export type ToastSetter = (value: ToastValue) => void
export type ExpandedView = 'workbench' | 'project' | 'gantt' | 'quality' | 'decision' | 'archive' | 'audit'
export type ArchiveFile = {
  id: string; name: string; folder: string; type: string; date: string;
  version: string; size: string; owner: string; status: string; content: string;
}

export const archiveFilesSeed: ArchiveFile[] = [
  { id: 'DOC-1048', name: '远洲科技并购专项_第43周周报', folder: '周报与月报', type: '周报', date: '2026.10.26', version: 'V1.0', size: '1.8 MB', owner: '林岚', status: '已归档', content: '本周完成交易文件第六轮复核，监管反馈恢复方案按计划推进。关键节点延期 5 天已完成审批，下一检查点为 10 月 28 日。\n\n一、本周进展\n完成 SPA 条款复核、交割清单更新及 3 项质量问题关闭。\n\n二、风险与决策\n监管申报反馈延期 5 天，已增加复核资源，不压缩质量检查时间。\n\n三、下周计划\n完成交割文件定稿复核并确认签署安排。' },
  { id: 'DOC-1042', name: '延期申请_CR-004_监管申报反馈', folder: '计划基线与变更', type: '变更单', date: '2026.10.24', version: 'V2.0', size: '864 KB', owner: '林岚', status: '已审批', content: '变更对象：监管申报反馈及后续关键节点。\n原计划：2026 年 11 月 1 日。\n申请完成：2026 年 11 月 6 日。\n\n原因：监管反馈晚于计划时间返回，需补充两项业务说明。\n方案：增加一名复核律师并行处理，10 月 28 日检查反馈进度。\n审批：周合伙人，同意。质量检查时间不得压缩。' },
  { id: 'DOC-1036', name: 'SPA修订稿_复核意见', folder: '质量检查与问题', type: '复核记录', date: '2026.10.23', version: 'V7.1', size: '2.4 MB', owner: '何川', status: '已复核', content: '复核范围：SPA 修订稿 V7 及交易附件。\n\n发现：附件清单第 4 项与正文引用版本不一致。\n等级：严重。\n处理：已统一附件引用并由第二复核人验证。\n结论：正文复核通过，附件完整性检查纳入交割门禁。' },
  { id: 'DOC-1024', name: '监管反馈会议纪要', folder: '过程文件', type: '会议纪要', date: '2026.10.22', version: 'V1.0', size: '642 KB', owner: '赵一', status: '已归集', content: '会议时间：2026 年 10 月 22 日 14:00。\n参会：项目组、客户法务、财务顾问。\n\n监管反馈集中在两项业务说明及一份补充材料。项目组将在本周内完成答复草案，并与交割计划联动检查。' },
  { id: 'DOC-1011', name: '时间质量冲突决策单_DEC-007', folder: '风险与决策', type: '决策单', date: '2026.10.20', version: 'V1.0', size: '736 KB', owner: '周合伙人', status: '执行中', content: '冲突：按原计划交付将压缩附件完整性复核。\n决定：增加两名复核人员，保持交付日期。\n附加条件：质量负责人每日检查复核进度；若 10 月 28 日仍有一项严重问题未关闭，重新提交决策。\n执行状态：资源已到位，持续验证。' },
]

const initialTasks = [
  { id: 1, title: '确认 SPA 修订稿复核结论', meta: '远洲科技并购专项 · 今天 11:30', type: '质量复核', done: false },
  { id: 2, title: '提交监管反馈延期恢复说明', meta: '远洲科技并购专项 · 今天 16:00', type: '计划变更', done: false },
  { id: 3, title: '补充数据出境评估事实清单', meta: '星港数据出境评估 · 明天 12:00', type: '项目任务', done: false },
  { id: 4, title: '确认本周项目周报', meta: '衡远资本合规审查 · 已完成', type: '周报', done: true },
]

export function WorkbenchScreen({ onNavigate, onToast }: { onNavigate: (view: ExpandedView) => void; onToast: ToastSetter }) {
  const [tasks, setTasks] = useState(initialTasks)
  const done = tasks.filter(t => t.done).length
  return <div className="screen workbench-screen">
    <div className="screen-heading"><div><span className="eyebrow">MY WORKSPACE · WEEK 43</span><h1>今天，从最关键的事开始。</h1><p>林岚，你有 3 项待办、1 项质量复核和 1 份周报待确认。</p></div><button className="primary-action" onClick={() => onNavigate('quality')}><Plus size={16} />登记质量问题</button></div>
    <div className="workbench-summary"><div><span>今日待办</span><strong>{tasks.filter(t => !t.done).length.toString().padStart(2, '0')}</strong><small>1 项将在 4 小时内到期</small></div><div><span>负责项目</span><strong>04</strong><small>2 个处于关键交付阶段</small></div><div><span>本周已完成</span><strong>{12 + done}</strong><small>任务、复核与决策合计</small></div><div className="week-progress-block"><span>本周专注度</span><strong>76%</strong><div className="mini-line"><i style={{ width: '76%' }} /></div></div></div>
    <div className="workbench-grid">
      <section className="today-tasks"><div className="section-heading"><div><span className="section-label">TODAY</span><h2>我的待办</h2></div><span className="muted-label">{done} / {tasks.length} 已完成</span></div>
        {tasks.map(task => <div className={`todo-row ${task.done ? 'completed' : ''}`} key={task.id}><button className="task-check" aria-label={task.done ? `重新打开${task.title}` : `完成${task.title}`} onClick={() => { setTasks(tasks.map(t => t.id === task.id ? { ...t, done: !t.done } : t)); onToast({ title: task.done ? '任务已重新打开' : '任务已完成', detail: task.title }) }}>{task.done && <Check size={14} />}</button><div><strong>{task.title}</strong><small>{task.meta}</small></div><span>{task.type}</span></div>)}
        <button className="text-action" onClick={() => onNavigate('project')}>进入我的项目<ArrowRight size={15} /></button>
      </section>
      <section className="quick-actions-panel"><span className="section-label">QUICK ACTIONS</span><h2>快捷处理</h2><button onClick={() => onNavigate('gantt')}><CalendarDays size={18} /><div><strong>更新项目计划</strong><small>进度、基线与延期</small></div><ChevronRight size={15} /></button><button onClick={() => onNavigate('quality')}><ShieldCheck size={18} /><div><strong>处理质量复核</strong><small>1 项等待你的结论</small></div><ChevronRight size={15} /></button><button onClick={() => onNavigate('archive')}><Archive size={18} /><div><strong>查阅项目档案</strong><small>18 份文件本周已归集</small></div><ChevronRight size={15} /></button></section>
    </div>
    <section className="weekly-story"><div><span className="section-label">WEEKLY NARRATIVE</span><h2>本周工作，自动形成项目叙事。</h2><p>完成的任务、计划变化、质量结论和决策记录已汇总为周报素材，无需重复抄写。</p></div><div className="weekly-numbers"><span><strong>06</strong>完成任务</span><span><strong>01</strong>计划变更</span><span><strong>03</strong>质量闭环</span></div><button className="secondary-action" onClick={() => onNavigate('archive')}>查看周报档案<ArrowRight size={15} /></button></section>
  </div>
}

type QualityIssue = { id: string; title: string; project: string; severity: string; status: string; owner: string; due: string; gate: string; description: string; solution: string; root: string }
const qualitySeed: QualityIssue[] = [
  { id: 'QI-2048', title: '交易附件清单与正文引用版本不一致', project: '远洲科技并购专项', severity: '严重', status: '待复核', owner: '陈澈', due: '今天 14:00', gate: '交割文件定稿', description: '附件清单第 4 项引用 V5，但正文已更新至 V7，存在交付版本不一致风险。', solution: '统一附件引用至 V7，并重新执行附件完整性检查。', root: '版本引用未随正文联动更新' },
  { id: 'QI-2043', title: '数据出境事实清单缺少境外接收方说明', project: '星港数据出境评估', severity: '严重', status: '处理中', owner: '沈宁', due: '今天 18:00', gate: '出境评估定稿', description: '事实清单未完整说明境外接收方角色与后续转移安排。', solution: '补充接收方说明并由客户信息安全负责人确认。', root: '客户事实收集模板缺项' },
  { id: 'QI-2037', title: '经营者集中申报附件命名不统一', project: '远洲科技并购专项', severity: '一般', status: '待复核', owner: '赵一', due: '10 月 27 日', gate: '监管申报反馈', description: '部分附件命名无法对应申报目录编号。', solution: '按申报目录重命名并更新索引。', root: '文件命名规范执行不一致' },
  { id: 'QI-2026', title: '劳动仲裁证据目录页码不连续', project: '青岳劳动争议系列案', severity: '一般', status: '已关闭', owner: '许言', due: '已于 10 月 24 日关闭', gate: '证据交换', description: '证据目录第 18 页后页码跳号。', solution: '重新编号并复核电子卷宗。', root: '合并文件后未更新页码' },
  { id: 'QI-2019', title: '合规整改报告引用旧版制度', project: '衡远资本合规审查', severity: '建议', status: '处理中', owner: '周其', due: '10 月 29 日', gate: '整改复核报告', description: '一处注释仍引用 2025 版内部制度。', solution: '更新为现行制度并保留版本说明。', root: '制度库链接未更新' },
]

export function QualityScreen({ onToast }: { onToast: ToastSetter }) {
  const [issues, setIssues] = useState(qualitySeed)
  const [severity, setSeverity] = useState('全部等级')
  const [status, setStatus] = useState('全部状态')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<QualityIssue | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newSeverity, setNewSeverity] = useState('一般')
  const [newDescription, setNewDescription] = useState('')
  const [error, setError] = useState('')
  const filtered = useMemo(() => issues.filter(i => (severity === '全部等级' || i.severity === severity) && (status === '全部状态' || i.status === status) && (i.title.includes(query) || i.project.includes(query) || i.id.toLowerCase().includes(query.toLowerCase()))), [issues, severity, status, query])
  const updateIssue = (nextStatus: string) => {
    if (!selected) return
    setIssues(issues.map(i => i.id === selected.id ? { ...i, status: nextStatus } : i))
    setSelected({ ...selected, status: nextStatus })
    onToast({ title: nextStatus === '已关闭' ? '复核通过，问题已关闭' : '已退回处理', detail: `${selected.id} 的处理历史已更新。` })
  }
  return <div className="screen quality-screen">
    <div className="screen-heading"><div><span className="eyebrow">QUALITY ASSURANCE</span><h1>质量，是持续发生的闭环。</h1><p>从发现、处理到独立复核，每个结论都有证据与责任人。</p></div><button className="primary-action" onClick={() => setNewOpen(true)}><Plus size={16} />登记质量问题</button></div>
    <div className="quality-metrics"><div><span>开放问题</span><strong>{issues.filter(i => i.status !== '已关闭').length.toString().padStart(2, '0')}</strong><small>严重问题 2 项</small></div><div><span>待我复核</span><strong>{issues.filter(i => i.status === '待复核').length.toString().padStart(2, '0')}</strong><small>1 项影响今日门禁</small></div><div><span>本周闭环</span><strong>07</strong><small>平均复核 1.6 天</small></div><div><span>重开率</span><strong>8.3%</strong><small>较上周下降 2.1%</small></div></div>
    <div className="quality-toolbar"><div className="inline-search"><Search size={15} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索问题、项目或编号" /></div><select value={severity} onChange={e => setSeverity(e.target.value)} aria-label="问题等级"><option>全部等级</option><option>致命</option><option>严重</option><option>一般</option><option>建议</option></select><select value={status} onChange={e => setStatus(e.target.value)} aria-label="问题状态"><option>全部状态</option><option>处理中</option><option>待复核</option><option>已关闭</option></select><span>{filtered.length} 项结果</span></div>
    <div className="quality-table"><div className="quality-table-head"><span>问题与项目</span><span>等级</span><span>状态</span><span>责任人</span><span>期限</span><span /></div>{filtered.length ? filtered.map(issue => <button className="quality-row" key={issue.id} onClick={() => setSelected(issue)}><div><strong>{issue.title}</strong><small>{issue.id} · {issue.project} · 门禁：{issue.gate}</small></div><span className={`severity severity-${issue.severity}`}>{issue.severity}</span><span className={`issue-status status-${issue.status}`}>{issue.status}</span><span>{issue.owner}</span><span className="issue-due">{issue.due}</span><ChevronRight size={16} /></button>) : <div className="empty-state"><Filter size={24} /><strong>没有匹配的问题</strong><p>调整等级、状态或关键词后再试。</p><button className="text-action" onClick={() => { setSeverity('全部等级'); setStatus('全部状态'); setQuery('') }}>清除筛选</button></div>}</div>
    <div className="quality-bottom"><section><span className="section-label">ROOT CAUSE</span><h2>高频根因</h2>{[['版本与引用不一致', 4, 80], ['事实收集不完整', 3, 60], ['命名与目录规范', 2, 40]].map(([name, count, width]) => <div className="cause-row" key={name}><span>{name}</span><div><i style={{ width: `${width}%` }} /></div><strong>{count}</strong></div>)}</section><section className="quality-principle"><BookOpenCheck size={24} /><div><span className="section-label">QUALITY GATE</span><h2>风险接受，不等于问题关闭。</h2><p>例外决策会保留原问题、附加条件和后续检查点，直到风险真正解除。</p></div></section></div>
    {selected && <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setSelected(null) }}><section className="issue-drawer" role="dialog" aria-modal="true" aria-label="质量问题详情"><div className="drawer-head"><div><span className="section-label">{selected.id} · {selected.severity}问题</span><h2>{selected.title}</h2></div><button className="icon-button" aria-label="关闭问题详情" onClick={() => setSelected(null)}><X size={19} /></button></div><div className="issue-meta-grid"><div><span>当前状态</span><strong>{selected.status}</strong></div><div><span>责任人</span><strong>{selected.owner}</strong></div><div><span>关联门禁</span><strong>{selected.gate}</strong></div><div><span>处理期限</span><strong>{selected.due}</strong></div></div><div className="issue-section"><span>问题描述</span><p>{selected.description}</p></div><div className="issue-section"><span>解决方案</span><p>{selected.solution}</p></div><div className="issue-section"><span>根本原因</span><p>{selected.root}</p></div><div className="resolution-timeline"><div className="done"><CheckCircle2 size={16} /><span>问题登记与分级<small>10.23 09:18 · 何川</small></span></div><div className="done"><CheckCircle2 size={16} /><span>解决方案已提交<small>10.24 16:42 · {selected.owner}</small></span></div><div className={selected.status === '已关闭' ? 'done' : 'active'}><CheckCircle2 size={16} /><span>独立复核<small>{selected.status === '已关闭' ? '复核通过，问题关闭' : '等待质量负责人验证'}</small></span></div></div><div className="linked-evidence"><FileText size={17} /><div><strong>SPA修订稿_复核意见 V7.1</strong><small>证据文件 · 已归集到质量目录</small></div><Eye size={16} /></div>{selected.status === '待复核' ? <div className="drawer-actions between"><button className="secondary-action" onClick={() => updateIssue('处理中')}><RotateCcw size={15} />退回处理</button><button className="primary-action" onClick={() => updateIssue('已关闭')}><Check size={16} />复核通过</button></div> : <button className="secondary-action full-action" onClick={() => setSelected(null)}>关闭详情</button>}</section></div>}
    {newOpen && <div className="overlay centered" onMouseDown={e => { if (e.target === e.currentTarget) setNewOpen(false) }}><section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="登记质量问题"><div className="drawer-head"><div><span className="section-label">NEW QUALITY ISSUE</span><h2>登记质量问题</h2></div><button className="icon-button" aria-label="关闭登记" onClick={() => setNewOpen(false)}><X size={19} /></button></div><label className="form-field"><span>问题标题 <b>必填</b></span><input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="清晰描述发现的问题" /></label><label className="form-field"><span>问题等级</span><select value={newSeverity} onChange={e => setNewSeverity(e.target.value)}><option>致命</option><option>严重</option><option>一般</option><option>建议</option></select></label><label className="form-field"><span>问题说明 <b>必填</b></span><textarea rows={4} value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="说明发现环节、影响与定位信息" /></label>{error && <p className="form-error">{error}</p>}<button className="primary-action full-action" onClick={() => { if (!newTitle.trim() || !newDescription.trim()) { setError('请填写问题标题和说明。'); return } const issue: QualityIssue = { id: `QI-${2050 + issues.length}`, title: newTitle, project: '远洲科技并购专项', severity: newSeverity, status: '处理中', owner: '林岚', due: '10 月 30 日', gate: '交割文件定稿', description: newDescription, solution: '待责任人提交解决方案。', root: '待根因分析' }; setIssues([issue, ...issues]); setNewOpen(false); setNewTitle(''); setNewDescription(''); setError(''); onToast({ title: '质量问题已登记', detail: `${issue.id} 已进入分派与处理流程。` }) }}>登记并进入处理<ArrowRight size={16} /></button></section></div>}
  </div>
}

const decisionSeed = [
  { id: 'DEC-012', project: '星港数据出境评估', title: '交付日期与完整复核冲突', type: '时间—质量冲突', deadline: '今天 16:00', status: '待决策', summary: '若维持 10 月 30 日交付，两项严重问题将无法完成独立复核。' },
  { id: 'DEC-011', project: '远洲科技并购专项', title: '监管反馈节点延期 5 天', type: '重大延期', deadline: '剩余 6 小时', status: '待决策', summary: '外部反馈延迟影响两个后续节点，恢复方案已提交。' },
  { id: 'DEC-007', project: '衡远资本合规审查', title: '增加复核资源并保持交付', type: '资源调整', deadline: '10 月 20 日决定', status: '执行中', summary: '两名复核人员已到位，等待下一次执行验证。' },
]

export function DecisionScreen({ onToast }: { onToast: ToastSetter }) {
  const [decisions, setDecisions] = useState(decisionSeed)
  const [selectedId, setSelectedId] = useState('DEC-012')
  const [option, setOption] = useState('A')
  const [condition, setCondition] = useState('质量负责人每日检查复核进度；10 月 28 日再次验证。')
  const selected = decisions.find(d => d.id === selectedId) ?? decisions[0]
  const decide = () => {
    setDecisions(decisions.map(d => d.id === selected.id ? { ...d, status: '执行中' } : d))
    onToast({ title: '决策已确认并进入执行', detail: `${selected.id} · 方案 ${option} 已回写相关任务与检查点。` })
  }
  return <div className="screen decision-screen"><div className="screen-heading"><div><span className="eyebrow">DECISION CENTER</span><h1>重要取舍，应当被认真记录。</h1><p>比较方案、明确条件、跟踪执行，而不是只留下一句“同意”。</p></div><span className="decision-count">{decisions.filter(d => d.status === '待决策').length} 项待决策</span></div>
    <div className="decision-workspace"><section className="decision-queue"><div className="section-label">DECISION QUEUE</div>{decisions.map(d => <button className={selected.id === d.id ? 'selected' : ''} key={d.id} onClick={() => { setSelectedId(d.id); setOption('A') }}><div><span>{d.type}</span><small className={`decision-status ds-${d.status}`}>{d.status}</small></div><strong>{d.title}</strong><p>{d.project}</p><small>{d.id} · {d.deadline}</small></button>)}</section>
      <section className="decision-detail"><div className="decision-detail-head"><div><span className="section-label">{selected.id} · {selected.project}</span><h2>{selected.title}</h2></div><span className={`issue-status ${selected.status === '待决策' ? 'status-待复核' : 'status-已关闭'}`}>{selected.status}</span></div><div className="conflict-summary"><CircleAlert size={20} /><p>{selected.summary}</p></div><div className="decision-facts"><div><span>原计划交付</span><strong>2026.10.30</strong></div><div><span>未关闭严重问题</span><strong>02</strong></div><div><span>必要复核时间</span><strong>5 天</strong></div></div><span className="section-label">OPTIONS</span><h3>选择可执行的方案</h3><div className="decision-options">{[
        { id: 'A', label: '延期保质量', title: '交付延期 5 天', desc: '保留完整复核；同步调整客户交付计划。', impact: '质量风险最低 · 时间 +5 天' },
        { id: 'B', label: '增加资源', title: '增加 2 名复核人员', desc: '保持交付日期；需要跨项目释放资源。', impact: '时间不变 · 资源协调较高' },
        { id: 'C', label: '分阶段交付', title: '先交评估正文，后交附件', desc: '正文按期；附件复核完成后二次交付。', impact: '部分按期 · 客户需接受分批' },
      ].map(item => <button key={item.id} className={option === item.id ? 'selected' : ''} onClick={() => setOption(item.id)} disabled={selected.status !== '待决策'}><div><span>方案 {item.id} · {item.label}</span>{option === item.id && <CheckCircle2 size={17} />}</div><strong>{item.title}</strong><p>{item.desc}</p><small>{item.impact}</small></button>)}</div><label className="form-field"><span>决定理由与附加条件</span><textarea rows={3} value={condition} onChange={e => setCondition(e.target.value)} disabled={selected.status !== '待决策'} /></label>{selected.status === '待决策' ? <div className="decision-submit"><p><ShieldCheck size={15} />决定后将生成计划与质量检查点。</p><button className="primary-action" disabled={!condition.trim()} onClick={decide}>确认方案 {option} 并决策<ArrowRight size={16} /></button></div> : <div className="decision-executing"><CheckCircle2 size={19} /><div><strong>决策执行中</strong><p>方案 {option} 已回写；下一次执行验证：2026 年 10 月 28 日。</p></div></div>}</section></div>
  </div>
}

export function ArchiveScreen({ files, setFiles, selectedFile, onSelectFile, onToast }: { files: ArchiveFile[]; setFiles: (files: ArchiveFile[]) => void; selectedFile: ArchiveFile | null; onSelectFile: (file: ArchiveFile) => void; onToast: ToastSetter }) {
  const [folder, setFolder] = useState('全部文件')
  const [query, setQuery] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)
  const folders = ['全部文件', '立项与授权', '计划基线与变更', '过程文件', '质量检查与问题', '风险与决策', '周报与月报', '交付与验收', '结项与复盘']
  const filtered = files.filter(f => (folder === '全部文件' || f.folder === folder) && (f.name.includes(query) || f.type.includes(query) || f.id.toLowerCase().includes(query.toLowerCase())))
  return <div className="screen archive-screen"><div className="screen-heading"><div><span className="eyebrow">PROJECT ARCHIVE · LF-26031</span><h1>项目结束，记忆仍然清晰。</h1><p>远洲科技并购专项 · 归档完整度 96% · 文件按业务发生自动归集</p></div><button className="primary-action" onClick={() => uploadRef.current?.click()}><Upload size={16} />上传过程文件</button><input ref={uploadRef} type="file" hidden onChange={e => { const file = e.target.files?.[0]; if (!file) return; const added: ArchiveFile = { id: `DOC-${1050 + files.length}`, name: file.name, folder: '过程文件', type: '过程文件', date: '2026.10.26', version: 'V1.0', size: `${Math.max(1, Math.round(file.size / 1024))} KB`, owner: '林岚', status: '已归集', content: `文件“${file.name}”已上传并归集到过程文件目录。\n\n本概念原型仅展示文件元数据与归档流程，不保存实际上传内容。` }; setFiles([added, ...files]); onSelectFile(added); onToast({ title: '文件已归集', detail: `${file.name} · 过程文件 / 2026 / 10 / 26` }); e.target.value = '' }} /></div>
    <div className="archive-integrity"><div><Archive size={22} /><span>归档完整度</span><strong>96%</strong></div><div className="integrity-track"><i style={{ width: '96%' }} /></div><span>必归档项 48 / 50</span><button className="text-action" onClick={() => { setFolder('周报与月报'); setQuery('') }}>查看 2 项缺项<ArrowRight size={14} /></button></div>
    <div className="archive-browser"><aside className="folder-tree"><div className="section-label">DIRECTORY</div>{folders.map(name => <button className={folder === name ? 'active' : ''} key={name} onClick={() => setFolder(name)}>{name === '全部文件' ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{name}</span><small>{name === '全部文件' ? files.length : files.filter(f => f.folder === name).length}</small></button>)}</aside><section className="file-area"><div className="file-toolbar"><div className="inline-search"><Search size={15} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索文件、类型或编号" /></div><span>{filtered.length} 份文件</span></div><div className="file-list-head"><span>文件名称</span><span>业务日期</span><span>版本</span><span>状态</span></div>{filtered.length ? filtered.map(file => <button className={`file-row ${selectedFile?.id === file.id ? 'selected' : ''}`} key={file.id} onClick={() => onSelectFile(file)}><div><FileText size={18} /><span><strong>{file.name}</strong><small>{file.id} · {file.type} · {file.size}</small></span></div><time>{file.date}</time><span>{file.version}</span><span className="file-status">{file.status}</span></button>) : <div className="empty-state"><FolderOpen size={24} /><strong>当前目录没有匹配文件</strong><p>尝试切换目录或清除搜索关键词。</p><button className="text-action" onClick={() => { setFolder('全部文件'); setQuery('') }}>查看全部文件</button></div>}</section></div>
  </div>
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url)
}

export function ArchiveContext({ file, onToast }: { file: ArchiveFile | null; onToast: ToastSetter }) {
  const [shareOpen, setShareOpen] = useState(false)
  const [expiry, setExpiry] = useState('2026-11-02')
  const [allowDownload, setAllowDownload] = useState(false)
  if (!file) return <aside className="context-rail archive-context"><div className="context-heading"><span className="section-label">DOCUMENT PREVIEW</span><h2>文件预览</h2></div><div className="empty-context"><FileText size={28} /><strong>选择一份文件</strong><p>在此查看内容、版本、元数据与授权操作。</p></div></aside>
  return <aside className="context-rail archive-context"><div className="context-heading"><span className="section-label">DOCUMENT PREVIEW</span><h2>文件预览</h2><span className="count-badge neutral">{file.version}</span></div><div className="document-preview"><div className="document-brand">LEXFLOW · PROJECT ARCHIVE</div><h3>{file.name}</h3>{file.content.split('\n').map((line, i) => <p key={i}>{line || ' '}</p>)}</div><div className="file-metadata"><div><span>业务日期</span><strong>{file.date}</strong></div><div><span>上传人</span><strong>{file.owner}</strong></div><div><span>归档状态</span><strong>{file.status}</strong></div><div><span>文件大小</span><strong>{file.size}</strong></div></div><div className="preview-actions"><button className="secondary-action" onClick={() => { downloadText(`${file.name}.txt`, file.content); onToast({ title: '文件已导出', detail: `${file.name} · 下载行为已记录。` }) }}><Download size={15} />导出</button><button className="primary-action" onClick={() => setShareOpen(true)}><Link2 size={15} />授权查阅</button></div><div className="assurance"><History size={16} /><span>预览、导出和授权行为均进入审计日志。</span></div>
    {shareOpen && <div className="overlay centered" onMouseDown={e => { if (e.target === e.currentTarget) setShareOpen(false) }}><section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="授权查阅"><div className="drawer-head"><div><span className="section-label">CONTROLLED SHARE</span><h2>授权查阅</h2></div><button className="icon-button" aria-label="关闭授权" onClick={() => setShareOpen(false)}><X size={19} /></button></div><p className="modal-intro">{file.name}</p><label className="form-field"><span>查阅人</span><input defaultValue="周合伙人" /></label><label className="form-field"><span>授权到期日</span><input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} /></label><label className="check-field"><input type="checkbox" checked={allowDownload} onChange={e => setAllowDownload(e.target.checked)} /><span>允许下载（默认仅在线预览）</span></label><div className="drawer-note"><LockKeyhole size={16} />查阅需登录认证；撤销或到期后立即失效。</div><button className="primary-action full-action" onClick={() => { setShareOpen(false); onToast({ title: '查阅授权已生效', detail: `周合伙人 · ${expiry} 到期 · ${allowDownload ? '可下载' : '仅在线预览'}` }) }}>确认授权<KeyRound size={16} /></button></section></div>}
  </aside>
}

type Grant = { id: string; user: string; scope: string; permission: string; expiry: string; status: string }
type Log = { time: string; user: string; action: string; object: string; result: string }
const grantSeed: Grant[] = [
  { id: 'AUTH-083', user: '周合伙人', scope: '远洲科技并购专项 / 全项目', permission: '只读', expiry: '长期有效', status: '有效' },
  { id: 'AUTH-079', user: '何川', scope: '远洲科技并购专项 / 质量目录', permission: '复核与下载', expiry: '2026.12.31', status: '有效' },
  { id: 'AUTH-074', user: '外部顾问 · 王谨', scope: '监管反馈会议纪要 / 单文件', permission: '仅在线预览', expiry: '2026.10.30', status: '即将到期' },
]
const logSeed: Log[] = [
  { time: '2026.10.26 10:18:32', user: '何川', action: '复核并下载', object: 'SPA修订稿_复核意见 V7.1', result: '成功' },
  { time: '2026.10.26 09:42:11', user: '系统', action: '自动归集', object: '3 份过程文件', result: '成功' },
  { time: '2026.10.26 09:16:48', user: '外部顾问 · 王谨', action: '访问项目首页', object: '远洲科技并购专项', result: '已拒绝' },
  { time: '2026.10.25 17:30:02', user: '林岚', action: '提交延期审批', object: 'CR-004', result: '成功' },
]

export function AuditScreen({ onToast }: { onToast: ToastSetter }) {
  const [tab, setTab] = useState<'授权管理' | '审计日志'>('授权管理')
  const [grants, setGrants] = useState(grantSeed)
  const [logs, setLogs] = useState(logSeed)
  const [query, setQuery] = useState('')
  const [grantOpen, setGrantOpen] = useState(false)
  const [user, setUser] = useState('')
  const [scope, setScope] = useState('远洲科技并购专项 / 周报与月报')
  const [expiry, setExpiry] = useState('2026-11-30')
  const [error, setError] = useState('')
  const filteredLogs = logs.filter(l => `${l.user}${l.action}${l.object}`.includes(query))
  const exportLogs = () => {
    const csv = ['时间,人员,操作,对象,结果', ...filteredLogs.map(l => [l.time, l.user, l.action, l.object, l.result].map(v => `"${v}"`).join(','))].join('\n')
    downloadText('项目审计日志.csv', '\ufeff' + csv)
    onToast({ title: '审计日志已导出', detail: `${filteredLogs.length} 条记录；导出行为已留痕。` })
  }
  return <div className="screen audit-screen"><div className="screen-heading"><div><span className="eyebrow">ACCESS & AUDIT</span><h1>看得见权限，也查得到足迹。</h1><p>项目授权、临时查阅和每一次敏感操作，都在同一套保密边界内。</p></div>{tab === '授权管理' ? <button className="primary-action" onClick={() => setGrantOpen(true)}><Plus size={16} />新增授权</button> : <button className="secondary-action" onClick={exportLogs}><Download size={16} />导出日志</button>}</div>
    <div className="security-banner"><ShieldCheck size={23} /><div><strong>信息墙运行正常</strong><p>今日已拦截 3 次越权访问，未发现跨项目权限泄露。</p></div><span>LAST CHECK · 10:26</span></div>
    <div className="audit-tabs"><button className={tab === '授权管理' ? 'active' : ''} onClick={() => setTab('授权管理')}><KeyRound size={16} />授权管理</button><button className={tab === '审计日志' ? 'active' : ''} onClick={() => setTab('审计日志')}><History size={16} />审计日志</button></div>
    {tab === '授权管理' ? <section className="grant-panel"><div className="grant-summary"><div><span>有效授权</span><strong>{grants.filter(g => g.status !== '已撤销').length}</strong></div><div><span>临时授权</span><strong>02</strong></div><div><span>即将到期</span><strong>01</strong></div></div><div className="grant-table"><div className="grant-head"><span>人员</span><span>授权范围</span><span>权限</span><span>有效期</span><span>状态</span><span /></div>{grants.map(grant => <div className={`grant-row ${grant.status === '已撤销' ? 'revoked' : ''}`} key={grant.id}><div><span className="mini-avatar">{grant.user.slice(0, 1)}</span><span><strong>{grant.user}</strong><small>{grant.id}</small></span></div><span>{grant.scope}</span><span>{grant.permission}</span><span>{grant.expiry}</span><span className="grant-status">{grant.status}</span><button className="icon-button" aria-label={`${grant.status === '已撤销' ? '恢复' : '撤销'}${grant.user}授权`} onClick={() => { const next = grant.status === '已撤销' ? '有效' : '已撤销'; setGrants(grants.map(g => g.id === grant.id ? { ...g, status: next } : g)); setLogs([{ time: '2026.10.26 10:26:18', user: '周合伙人', action: next === '已撤销' ? '撤销授权' : '恢复授权', object: `${grant.user} · ${grant.scope}`, result: '成功' }, ...logs]); onToast({ title: next === '已撤销' ? '授权已撤销' : '授权已恢复', detail: `${grant.user}的访问权限已${next === '已撤销' ? '立即失效' : '恢复'}。` }) }}>{grant.status === '已撤销' ? <UserCheck size={16} /> : <UserX size={16} />}</button></div>)}</div></section> : <section className="log-panel"><div className="log-toolbar"><div className="inline-search"><Search size={15} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索人员、操作或对象" /></div><span>{filteredLogs.length} 条审计记录</span></div><div className="log-table"><div className="log-head"><span>时间</span><span>人员</span><span>操作</span><span>对象</span><span>结果</span></div>{filteredLogs.map((log, i) => <div className="log-row" key={`${log.time}-${i}`}><time>{log.time}</time><span>{log.user}</span><span>{log.action}</span><span>{log.object}</span><span className={log.result === '已拒绝' ? 'log-denied' : 'log-success'}>{log.result}</span></div>)}</div></section>}
    {grantOpen && <div className="overlay centered" onMouseDown={e => { if (e.target === e.currentTarget) setGrantOpen(false) }}><section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="新增授权"><div className="drawer-head"><div><span className="section-label">NEW ACCESS GRANT</span><h2>新增项目授权</h2></div><button className="icon-button" aria-label="关闭新增授权" onClick={() => setGrantOpen(false)}><X size={19} /></button></div><label className="form-field"><span>被授权人 <b>必填</b></span><input value={user} onChange={e => setUser(e.target.value)} placeholder="输入姓名或账号" /></label><label className="form-field"><span>授权范围</span><select value={scope} onChange={e => setScope(e.target.value)}><option>远洲科技并购专项 / 周报与月报</option><option>远洲科技并购专项 / 质量目录</option><option>远洲科技并购专项 / 全项目只读</option></select></label><label className="form-field"><span>授权到期日</span><input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} /></label><div className="drawer-note"><ShieldAlert size={16} />仅授予完成工作所必需的最小范围。</div>{error && <p className="form-error">{error}</p>}<button className="primary-action full-action" onClick={() => { if (!user.trim()) { setError('请输入被授权人。'); return } const grant: Grant = { id: `AUTH-${84 + grants.length}`, user, scope, permission: '仅在线预览', expiry, status: '有效' }; setGrants([grant, ...grants]); setLogs([{ time: '2026.10.26 10:26:30', user: '周合伙人', action: '新增授权', object: `${user} · ${scope}`, result: '成功' }, ...logs]); setGrantOpen(false); setUser(''); setError(''); onToast({ title: '授权已创建', detail: `${user} · ${expiry} 到期 · 仅在线预览` }) }}>创建授权<KeyRound size={16} /></button></section></div>}
  </div>
}

export function WorkbenchContext() {
  return <aside className="context-rail"><div className="context-heading"><span className="section-label">TODAY</span><h2>今日安排</h2></div><div className="agenda-item"><time>11:30</time><span>SPA 修订稿质量复核</span></div><div className="agenda-item"><time>14:30</time><span>并购专项质量复核会</span></div><div className="agenda-item"><time>16:00</time><span>项目组合周会</span></div><div className="context-section"><div className="section-label">FOCUS</div><h2>今日关注</h2><div className="attention-item"><CircleAlert size={16} /><div><strong>监管反馈恢复检查</strong><p>方案执行将在后天进行下一次验证。</p></div></div></div><div className="assurance"><Clock3 size={16} /><span>待办按到期时间与项目风险综合排序。</span></div></aside>
}

export function QualityContext() {
  return <aside className="context-rail"><div className="context-heading"><span className="section-label">QUALITY GATE</span><h2>交付质量门禁</h2></div><div className="gate-score"><span>当前通过率</span><strong>92%</strong><small>12 个活跃门禁 · 1 个受阻</small></div><div className="context-section"><div className="section-label">BLOCKED</div><h2>阻断事项</h2><div className="blocked-gate"><ShieldAlert size={18} /><div><strong>交割文件定稿</strong><p>1 项严重问题待复核</p><span>远洲科技并购专项</span></div></div></div><div className="context-section"><div className="section-label">SEPARATION OF DUTIES</div><h2>独立复核</h2><p className="context-note">严重及以上问题的处理人与最终复核人必须分离。风险接受不会自动关闭原问题。</p></div><div className="assurance"><ShieldCheck size={16} /><span>质量结论与证据文件自动归入项目质量目录。</span></div></aside>
}

export function DecisionContext() {
  return <aside className="context-rail"><div className="context-heading"><span className="section-label">DECISION RECORD</span><h2>决策留痕</h2></div><div className="decision-principles"><div><span>01</span><p><strong>方案可比较</strong>时间、质量、成本和客户影响清晰。</p></div><div><span>02</span><p><strong>决定可执行</strong>结果回写任务、计划与检查点。</p></div><div><span>03</span><p><strong>执行可验证</strong>附加条件未被检查前，决策不会真正结束。</p></div></div><div className="assurance"><History size={16} /><span>决策意见、最终决定和后续验证永久保留。</span></div></aside>
}

export function AuditContext() {
  return <aside className="context-rail"><div className="context-heading"><span className="section-label">SECURITY POSTURE</span><h2>保密边界</h2></div><div className="security-score"><ShieldCheck size={30} /><strong>最小权限</strong><span>默认无权 · 按项目授权</span></div><div className="context-section"><div className="section-label">INFORMATION WALL</div><h2>信息墙</h2><div className="wall-row"><span>严格项目</span><strong>06</strong></div><div className="wall-row"><span>隔离组</span><strong>03</strong></div><div className="wall-row"><span>今日越权拦截</span><strong>03</strong></div></div><div className="context-section"><div className="section-label">ACCESS RULE</div><h2>撤权即时生效</h2><p className="context-note">项目、搜索、报表、预览、下载和分享接口执行同一权限校验，不能通过复制地址绕过。</p></div><div className="assurance"><LockKeyhole size={16} /><span>系统管理员不默认拥有业务文件内容权限。</span></div></aside>
}
