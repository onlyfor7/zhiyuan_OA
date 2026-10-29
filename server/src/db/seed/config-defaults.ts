import { CONFIG_KEY } from "@lexflow/shared";

/**
 * system_config 默认配置（需求基线 §18 全部 12 项；键名见 shared/constants.ts）。
 * 此处为开发默认值，可配置、非业务真理（§18 末条说明）。
 */
export const SYSTEM_CONFIG_DEFAULTS: ReadonlyArray<{ key: string; value: Record<string, unknown> }> = [
  { key: CONFIG_KEY.DEFAULTS_CURRENCY_TIMEZONE, value: { currency: "CNY", timezone: "Asia/Shanghai" } },
  {
    key: CONFIG_KEY.MEETING_MINUTES_DEADLINE,
    value: { defaultBusinessDays: 2, byProjectType: {} },
  },
  { key: CONFIG_KEY.TRAVEL_EXPENSE_REMINDER, value: { daysAfterCompletion: 3, enabled: true } },
  {
    key: CONFIG_KEY.BUDGET_INSUFFICIENT_POLICY,
    value: { default: "escalate", byProject: {} },
  },
  {
    key: CONFIG_KEY.EXPENSE_RECEIPT_RULES,
    value: { byCategory: {}, duplicateReceipt: "block" },
  },
  { key: CONFIG_KEY.TIMESHEET_PERIOD, value: { type: "weekly", pmApprover: "designated_supervisor" } },
  {
    key: CONFIG_KEY.TIMESHEET_VALIDATION,
    value: {
      dailyMaxMinutes: 1440,
      overDailyMax: "block",
      overlap: "remind",
      regularThresholdMinutes: 600,
      overRegularThreshold: "remind",
    },
  },
  { key: CONFIG_KEY.TIMESHEET_COST_RATE, value: { enabled: false } },
  { key: CONFIG_KEY.TIMESHEET_MEETING_PREFILL, value: { enabled: true, submitMode: "draft" } },
  {
    key: CONFIG_KEY.TIMESHEET_TRAVEL_PREFILL,
    value: { enabled: true, submitMode: "draft", autoFullDay: false },
  },
  {
    key: CONFIG_KEY.PROJECT_CLOSURE_PENDING_CHECK,
    value: {
      remind: ["unconfirmed_minutes", "pending_expense", "unapproved_timesheet"],
      blocking: [],
      blockingByTemplate: {},
    },
  },
  {
    key: CONFIG_KEY.APPROVAL_AMOUNT_THRESHOLDS,
    value: {
      fundingManagementReviewCents: 5000000,
      travelManagementReviewCents: 5000000,
      note: "开发种子值，非业务真理；由管理层和财务确认后可改",
    },
  },
  {
    key: CONFIG_KEY.TIMESHEET_DEFAULT_APPROVER,
    value: {
      approverEmail: "partner@lexflow.demo",
      note: "arch/07 §4.2：无项目明细的工时周期提交时 org 指定默认审批人",
    },
  },
  {
    key: CONFIG_KEY.GENERIC_REQUEST_TYPES,
    value: {
      types: [
        { key: "leave", name: "请假" },
        { key: "procurement", name: "采购" },
        { key: "seal", name: "用章" },
        { key: "other", name: "其他" },
      ],
      note: "arch/09 §3.2：固定核心字段，不做自由表单设计器；system_config 可扩充",
    },
  },
];
