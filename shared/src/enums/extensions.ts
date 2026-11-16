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

/* ===== 迭代 20 审批流飞书化（arch/14，shared 只增扩展） ===== */

/** v2 流程节点类型（arch/14 §3；提交/结束为首尾固定语义节点不入列） */
export const FLOW_NODE_TYPE_V2 = ["approval", "condition", "cc"] as const;
export type FlowNodeTypeV2 = (typeof FLOW_NODE_TYPE_V2)[number];

/** 审批人 kind 扩展（arch/14 §6）：旧五种保留，新增提交人本人/部门负责人/连续多级上级/表单内联系人 */
export const FLOW_APPROVER_KIND_V2 = [
  "initiator_self",
  "dept_head",
  "manager_chain",
  "form_contact",
] as const;
export type FlowApproverKindV2 = (typeof FLOW_APPROVER_KIND_V2)[number];

/** 各审批人 kind 的展示名与所需参数字段（供前端抽屉渲染；arch/14 §6） */
export const FLOW_APPROVER_KIND_V2_META: Record<
  FlowApproverKindV2,
  { label: string; params: ReadonlyArray<{ key: string; type: "int"; min: number; max: number } | { key: string; type: "string" }> }
> = {
  initiator_self: { label: "提交人本人", params: [] },
  dept_head: { label: "提交人部门负责人", params: [] },
  manager_chain: { label: "连续多级上级", params: [{ key: "levels", type: "int", min: 1, max: 10 }] },
  form_contact: { label: "表单内联系人", params: [{ key: "fieldKey", type: "string" }] },
};

/** 表单控件类型（arch/14 §4.2 P1 冻结清单） */
export const FORM_CONTROL_TYPE = [
  "text",
  "textarea",
  "note",
  "number",
  "money",
  "radio",
  "multi",
  "date",
  "daterange",
  "person",
  "file",
] as const;
export type FormControlType = (typeof FORM_CONTROL_TYPE)[number];

/** 自定义表单字段定义（arch/14 §4.2） */
export interface FormFieldDef {
  key: string;
  label: string;
  control: FormControlType;
  required: boolean;
  placeholder?: string;
  options?: string[];
  min?: number;
  max?: number;
}

/** 自定义表单 schema（arch/14 §4.1：form_schema jsonb 结构） */
export interface CustomFormSchema {
  fields: FormFieldDef[];
}

/** v2 结构强约束（arch/14 §3 validate 强制） */
export const FLOW_V2_LIMITS = { maxConditionDepth: 3, maxNodes: 100 } as const;

/** 自定义表单状态机（arch/14 §4.1：draft→published/disabled） */
export const CUSTOM_FORM_STATUS = ["draft", "published", "disabled"] as const;
export type CustomFormStatus = (typeof CUSTOM_FORM_STATUS)[number];

/** 审批人=提交人时策略（arch/14 §6；默认 skip） */
export const SAME_AS_INITIATOR = ["self", "skip", "to_manager", "to_dept_head"] as const;
export type SameAsInitiator = (typeof SAME_AS_INITIATOR)[number];

/** 节点操作权限（arch/14 §7） */
export interface FlowNodeOps {
  transfer: boolean;
  returnBack: "none" | "prev" | "initiator";
  requireCommentOnReject: boolean;
  requireCommentOnApprove: boolean;
}

/** 节点操作权限默认值（arch/14 §7 默认列） */
export const FLOW_NODE_OPS_DEFAULTS: FlowNodeOps = {
  transfer: true,
  returnBack: "none",
  requireCommentOnReject: true,
  requireCommentOnApprove: false,
};

/**
 * v2 审批人策略引用（kind 为 v1 五种的并集 + v2 四新 kind 的字符串宽类型；
 * 参数：manager_chain 需 levels、form_contact 需 fieldKey、role 需 role、user 需 userId）
 */
export interface FlowApproverRef {
  kind: string;
  role?: string;
  userId?: string;
  levels?: number;
  fieldKey?: string;
}
