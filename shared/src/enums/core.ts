/** 迭代 0 核心枚举（DB pgEnum 与共享层共用同一取值来源） */

export const USER_STATUS = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUS)[number];

/** 密级：public < internal < confidential < secret 逐级升高（arch/01 §2 v1.1 冻结） */
export const CONFIDENTIALITY_LEVEL = ["public", "internal", "confidential", "secret"] as const;
export type ConfidentialityLevel = (typeof CONFIDENTIALITY_LEVEL)[number];

export const PROJECT_LIFECYCLE_STATUS = ["preparing", "in_progress", "closed"] as const;
export type ProjectLifecycleStatus = (typeof PROJECT_LIFECYCLE_STATUS)[number];

export const PROJECT_HEALTH_STATUS = ["normal", "warning", "at_risk"] as const;
export type ProjectHealthStatus = (typeof PROJECT_HEALTH_STATUS)[number];

/** 档案授权状态机：pending_approval → active → expired/revoked；rejected 为审批驳回终态（arch/01 §3 v1.1） */
export const ACCESS_GRANT_STATUS = ["pending_approval", "active", "expired", "revoked", "rejected"] as const;
export type AccessGrantStatus = (typeof ACCESS_GRANT_STATUS)[number];

/** 授权范围类型（arch/01 §1 access_grants） */
export const ACCESS_GRANT_SCOPE_TYPE = ["project", "file", "report", "directory"] as const;
export type AccessGrantScopeType = (typeof ACCESS_GRANT_SCOPE_TYPE)[number];

/** 全局角色 key（arch/03 §1，冻结） */
export const ROLE_KEY = [
  "partner",
  "project_manager",
  "member",
  "quality_lead",
  "finance",
  "archivist",
  "sysadmin",
  "viewer",
] as const;
export type RoleKey = (typeof ROLE_KEY)[number];
