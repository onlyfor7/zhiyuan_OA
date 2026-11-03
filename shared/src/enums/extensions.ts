/** 迭代 6 扩展域枚举（arch/09 §2/§3，冻结） */

/** 收款登记状态（registered 金额不可编辑；更正=作废+新登记，不删行） */
export const RECEIPT_STATUS = ["registered", "voided"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUS)[number];

export const FLOW_SCOPE = ["global", "project"] as const;
export type FlowScope = (typeof FLOW_SCOPE)[number];

/** 通用申请单状态机：draft → pending_approval → approved/rejected；pending → draft（撤回）；withdrawn */
export const GENERIC_REQUEST_STATUS = ["draft", "pending_approval", "approved", "rejected", "withdrawn"] as const;
export type GenericRequestStatus = (typeof GENERIC_REQUEST_STATUS)[number];

/** 流程设计器节点类型（arch/09 §3.1，本期四种） */
export const FLOW_NODE_TYPE = ["start", "end", "approval", "condition"] as const;
export type FlowNodeType = (typeof FLOW_NODE_TYPE)[number];

/** 审批人 kind（arch/09 §3.1；arch/11 G3 增 initiator_choice=发起人指定） */
export const FLOW_APPROVER_KIND = ["role", "user", "initiator_manager", "project_manager", "initiator_choice"] as const;
export type FlowApproverKind = (typeof FLOW_APPROVER_KIND)[number];

/** 条件表达式字段白名单（arch/09 §3.1，服务端强制） */
export const FLOW_CONDITION_FIELDS = ["amount_cents", "confidentiality", "level", "borrow", "request_type"] as const;
export type FlowConditionField = (typeof FLOW_CONDITION_FIELDS)[number];

/** 条件字段类型映射（arch/11 G4：按字段类型驱动操作符；映射表定稿见 STATUS 交接记录） */
export const FLOW_CONDITION_FIELD_TYPES: Record<FlowConditionField, "text" | "number"> = {
  amount_cents: "number",
  confidentiality: "text",
  level: "text",
  borrow: "text",
  request_type: "text",
};

/** 条件操作符按字段类型分组（arch/11 G4；存量流程的 ">="→gte、"=="→eq 由后端编译层归一） */
export const FLOW_CONDITION_OPERATORS = {
  text: ["eq", "contains"] as const,
  number: ["gte", "lte", "between"] as const,
} as const;
export type FlowConditionOperator =
  | (typeof FLOW_CONDITION_OPERATORS)["text"][number]
  | (typeof FLOW_CONDITION_OPERATORS)["number"][number];
