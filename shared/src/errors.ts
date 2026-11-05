/** 统一业务错误码（arch/02 §6，冻结） */
export const ERROR_CODE = {
  /** 未登录/会话失效 */
  AUTH_REQUIRED: "AUTH_REQUIRED",
  /** 详情/直链的无权限统一形态（NOT_FOUND，不泄露存在性） */
  ACCESS_DENIED_OR_GONE: "ACCESS_DENIED_OR_GONE",
  /** zod 字段校验失败 */
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /** row_version 不匹配或状态机不允许的迁移 */
  STATE_CONFLICT: "STATE_CONFLICT",
  /** 幂等键命中但负载不同 */
  DUPLICATE_SUBMIT: "DUPLICATE_SUBMIT",
  /** 申请人不得自审 */
  SELF_APPROVAL_BLOCKED: "SELF_APPROVAL_BLOCKED",
  /** 策略为禁止时的超预算 */
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  /** 重复票据命中 */
  DUPLICATE_RECEIPT: "DUPLICATE_RECEIPT",
  /** 工时周期已锁定 */
  PERIOD_LOCKED: "PERIOD_LOCKED",
  /** 已归档只读 */
  ARCHIVED_READONLY: "ARCHIVED_READONLY",
  /** severe/critical 处理人与复核人为同一人（arch/04 §2.5） */
  SELF_REVIEW_BLOCKED: "SELF_REVIEW_BLOCKED",
  /** 审批策略无命中（arch/04 §2.9/§4） */
  POLICY_NOT_FOUND: "POLICY_NOT_FOUND",
  /** 流程定义结构非法（arch/09 §3.1：环/悬空/start|end 不唯一/条件分支单边） */
  FLOW_INVALID: "FLOW_INVALID",
  /** 流程校验不过不可发布（arch/09 §3.1：解析为空/自审全跳过等阻断发布） */
  FLOW_UNPUBLISHABLE: "FLOW_UNPUBLISHABLE",
  /** 登录限流（arch/12 §14.4：同 IP+账号失败次数超窗，429 同形不泄账号存在性） */
  RATE_LIMITED: "RATE_LIMITED",
  /** 兜底，无堆栈，带 requestId */
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];
