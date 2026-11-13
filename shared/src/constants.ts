/** 业务编号前缀注册表（arch/00 §3.5，冻结；新增前缀须架构会话裁定） */
export const CODE_PREFIX = {
  MTG: "MTG", // 会议
  TRV: "TRV", // 出差
  BUD: "BUD", // 预算
  FND: "FND", // 经费申请
  EXP: "EXP", // 费用报销
  TS: "TS", // 工时周期
  APR: "APR", // 审批实例
  LED: "LED", // 台账分录
  PRJ: "PRJ", // 项目
  TSK: "TSK", // 任务
  QLT: "QLT", // 质量问题
  DEC: "DEC", // 决策单
  RPT: "RPT", // 周报
  // CLT 客户 / MTR 事项：2026-10-26 由架构会话正式增补进注册表（arch/00 §3.5 v1.1）。
  CLT: "CLT", // 客户
  MTR: "MTR", // 事项
  // CHG/STG/MLS/DLV：2026-10-27 由架构会话正式增补进注册表（arch/00 §3.5 v1.2，arch/04 §2）。
  CHG: "CHG", // 延期申请
  STG: "STG", // 阶段
  MLS: "MLS", // 里程碑
  DLV: "DLV", // 交付物
  // RCV/REQ：2026-10-29 由架构会话正式增补进注册表（arch/00 §3.5 v1.3，arch/09 §2/§3）。
  RCV: "RCV", // 收款登记
  REQ: "REQ", // 通用申请单
  // LD/OPP/CTR：2026-11-05 由架构会话正式增补进注册表（arch/00 §3.5 v1.4，arch/12 §6.2）。
  // LD：arch/13 §5.2（v1.0）起线索不再编号——保留为历史保留项，仅存量行持有，不再发放新号。
  LD: "LD", // 线索（历史保留，不再发放新号）
  OPP: "OPP", // 商机
  CTR: "CTR", // 合同
  // AR/INV：2026-11-05 由架构会话正式增补进注册表（arch/00 §3.5 v1.5，arch/12 §7.2）。
  AR: "AR", // 应收单
  INV: "INV", // 发票
} as const;
export type CodePrefix = (typeof CODE_PREFIX)[keyof typeof CODE_PREFIX];

/** system_config 配置键名（默认值在 DB 种子；代码引用键名，不散落硬编码。需求基线 §18） */
export const CONFIG_KEY = {
  /** 默认币种与时区 */
  DEFAULTS_CURRENCY_TIMEZONE: "defaults.currency_timezone",
  /** 会议纪要期限（业务日） */
  MEETING_MINUTES_DEADLINE: "meeting.minutes_deadline_business_days",
  /** 出差报销提醒 */
  TRAVEL_EXPENSE_REMINDER: "travel.expense_reminder_days",
  /** 预算不足策略：escalate 升级审批 / block 禁止 */
  BUDGET_INSUFFICIENT_POLICY: "budget.insufficient_policy",
  /** 票据要求与重复票据策略 */
  EXPENSE_RECEIPT_RULES: "expense.receipt_rules",
  /** 工时周期（按周提交；项目负责人工时由指定上级审批） */
  TIMESHEET_PERIOD: "timesheet.period",
  /** 工时校验（单日上限/重叠/常规阈值） */
  TIMESHEET_VALIDATION: "timesheet.validation",
  /** 工时成本费率可见性 */
  TIMESHEET_COST_RATE: "timesheet.cost_rate_visibility",
  /** 会议预填工时 */
  TIMESHEET_MEETING_PREFILL: "timesheet.meeting_prefill",
  /** 出差预填工时 */
  TIMESHEET_TRAVEL_PREFILL: "timesheet.travel_prefill",
  /** 结项未决事项检查 */
  PROJECT_CLOSURE_PENDING_CHECK: "project.closure_pending_check",
  /** 审批金额阈值（开发种子值，非业务真理） */
  APPROVAL_AMOUNT_THRESHOLDS: "approval.amount_thresholds",
  /** 工时默认审批人（arch/07 §4.2：无项目明细周期提交时的 org 指定审批人） */
  TIMESHEET_DEFAULT_APPROVER: "timesheet.default_approver",
  /** 通用申请单类型配置（arch/09 §3.2：种子 leave/procurement/seal/other，可扩充） */
  GENERIC_REQUEST_TYPES: "generic_request.types",
  /** 工时填报步进分钟数（arch/11：默认 30） */
  TIMESHEET_STEP_MINUTES: "timesheet.step_minutes",
  /** 会话保留期天数（arch/12 §14.5：默认 90；清理任务本体入运维手册） */
  SESSION_RETENTION_DAYS: "security.session_retention_days",
  /** 审计保留期天数（arch/12 §14.5：默认 730=2 年） */
  /** 应收逾期宽限天数（arch/12 §7.2） */
  FIN_AR_OVERDUE_GRACE_DAYS: "fin.ar.overdue_grace_days",
  /** 应收自动生成开关（合同激活/付款计划到期，arch/12 §7.2） */
  FIN_AR_AUTO_GENERATE: "fin.ar.auto_generate",
  /** 发票默认税率（百分比整数，arch/12 §7.2） */
  FIN_INVOICE_DEFAULT_TAX_RATE: "fin.invoice.default_tax_rate",
  AUDIT_RETENTION_DAYS: "audit.retention_days",
  /** AI 提供方配置（arch/12 §17.6：管理员统一配置，system_config 优先于 env，30s 缓存） */
  AI_PROVIDER_URL: "ai.provider_url",
  AI_API_KEY: "ai.api_key",
  AI_MODEL: "ai.model",
  AI_ENABLED: "ai.enabled",
} as const;
export type ConfigKey = (typeof CONFIG_KEY)[keyof typeof CONFIG_KEY];

/** 编号格式：前缀-年份-五位序号（arch/00 §3.5） */
export const CODE_SERIAL_PADDING = 5;
