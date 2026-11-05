/** 迭代 9c CRM 域枚举（arch/12 §6.2，冻结） */

/** 线索状态机：new → contacted → qualified → converted / disqualified（原因必填） */
export const LEAD_STATUS = ["new", "contacted", "qualified", "converted", "disqualified"] as const;
export type LeadStatus = (typeof LEAD_STATUS)[number];

/** 商机阶段机：initial → needs → proposal → negotiation → won / lost */
export const OPPORTUNITY_STAGE = ["initial", "needs", "proposal", "negotiation", "won", "lost"] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGE)[number];

/** 合同状态机：draft → active → completed / terminated */
export const CONTRACT_STATUS = ["draft", "active", "completed", "terminated"] as const;
export type ContractStatus = (typeof CONTRACT_STATUS)[number];

export const PAYMENT_PLAN_STATUS = ["unpaid", "partial", "paid"] as const;
export type PaymentPlanStatus = (typeof PAYMENT_PLAN_STATUS)[number];

/** 跟进目标类型（多态 target，arch/12 §6.2） */
export const FOLLOWUP_TARGET_TYPE = ["lead", "opportunity", "customer"] as const;
export type FollowupTargetType = (typeof FOLLOWUP_TARGET_TYPE)[number];
