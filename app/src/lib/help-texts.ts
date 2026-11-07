/**
 * §4.5 页面说明全局注册表（arch/12 v1.9 用户裁定：右侧说明栏/页头长说明废止，
 * 口径/规则一律入此注册表，经 HelpIcon（标题旁 ⓘ 气泡）一处维护、全局一致）。
 * key = 页面短键（与 HelpIcon pageKey 对应）。
 */
export interface HelpText {
  title: string;
  body: string;
}

export const HELP_TEXTS: Record<string, HelpText> = {
  "time-center": {
    title: "工时中心 · 口径与红线",
    body: "单日 >24h 跨周期合并阻止；预填/复制仅产草稿、默认未提交、不计有效工时。有效工时 = 已批准 + 已锁定，其余状态单列。填报步进默认 0.5 小时（可配）。统计各页面读同一聚合函数，同名指标同数。",
  },
  "receipts-ledger": {
    title: "收款台账 · 登记与冲正",
    body: "仅登记台账（无计费/开票/在线支付）；金额不可编辑，更正 = 作废 + 新登记；实收口径 = Σregistered − Σvoided 原额。项目清单来自 receipts.projectOptions（参照级，全部项目）。挂合同付款计划行的登记同事务写回计划状态并勾稽应收。",
  },
  workbench: {
    title: "工作台 · 处理顺序",
    body: "逾期优先、其次临期；统一待办按逾期/临期与来源聚合，处理后卡片自动消失。待办来自任务/审批/复核/周报确认/授权五源并集（服务端聚合）。",
  },
  approvals: {
    title: "审批中心 · 口径",
    body: "待我审批 = 当前审批步解析到我；我申请的 = 我发起的实例。审批通过按引擎当前步推进，驳回/撤销留痕可溯。",
  },
  archive: {
    title: "档案中心 · 受控访问",
    body: "项目档案按固定十一目录组织；文件下载与预览经服务端鉴权直链，授权到期或撤销即时失效。预览、导出和授权行为均进入审计日志。",
  },
  audit: {
    title: "审计日志 · 口径",
    body: "审计行为全量留痕（actor/session/ip/前后快照）；支持按动作、对象、结果与日期区间筛选；导出 CSV 与页面同口径。",
  },
  decisions: {
    title: "决策中心 · 三原则",
    body: "① 方案可比较：时间、质量、成本和客户影响清晰；② 决定可执行：检查点自动生成任务并跟踪验证；③ 执行可验证：附加条件未被检查前，决策不会真正结束。决定、理由与后续验证永久保留。",
  },
  meetings: {
    title: "会议 · 口径",
    body: "会议纪要确认后生效；行动项可转任务并回流待办。列表按时间倒序，周会等周期会议由模板预置。",
  },
  projects: {
    title: "项目 · 口径",
    body: "项目全周期列表：生命周期×健康度双维状态；逾期任务数与当前阶段内联展示。新建项目走 F4 Stepper（基本→模板→成员→预算）。",
  },
  quality: {
    title: "质量 · 口径",
    body: "检查项按项目质量计划执行；问题登记-整改-复核闭环，超期升级延期治理。",
  },
  "operations-budget": {
    title: "预算经费 · 口径",
    body: "预算 = 项目维度年度包；经费申请走引擎审批，批准后入预算执行。台账同源 EXPENSE_RECOGNIZED，报销与经费不双计。",
  },
  "operations-expenses": {
    title: "费用报销 · 口径",
    body: "报销单明细行 × 类别 × 月度；approved_pending_payment + paid 计入统计。合计为服务端计算值，只读展示。",
  },
  "funding-detail": {
    title: "经费申请 · 口径",
    body: "经费 = 预算内/外申请链；批准后占用预算额度，支出核销走台账唯一入口。",
  },
  requests: {
    title: "申请单 · 口径",
    body: "通用申请单（类型可配）：发起→引擎审批→办结归档；进度节点图随实例状态点亮。",
  },
  settings: {
    title: "设置 · 口径",
    body: "账户设置：改密走自助流程（原口令校验）；界面自定义（密度/字号档）本地即时生效。",
  },
  travel: {
    title: "出差 · 口径",
    body: "出差单分段行程按时间顺序；借款出差触发会签。状态机：approved → depart（in_progress）→ complete；rowVersion 乐观锁。",
  },
  "admin-center": {
    title: "配置中心 · 口径",
    body: "系统配置中心（sysadmin）：用户/角色/枚举/编码/模板/审批流全功能管理区；partner 只读穿透。",
  },
};
