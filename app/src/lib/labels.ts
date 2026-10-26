import type { ConfidentialityLevel, ProjectHealthStatus, ProjectLifecycleStatus } from "@lexflow/shared";

/** 枚举 → 中文展示标签（展示层映射，键名以 shared 枚举为准） */

export const LIFECYCLE_LABEL: Record<ProjectLifecycleStatus, string> = {
  preparing: "筹备中",
  in_progress: "进行中",
  closed: "已结项",
};

export const HEALTH_LABEL: Record<ProjectHealthStatus, string> = {
  normal: "正常",
  warning: "预警",
  at_risk: "风险",
};

export const CONFIDENTIALITY_LABEL: Record<ConfidentialityLevel, string> = {
  public: "公开",
  internal: "内部",
  confidential: "保密",
  secret: "严格",
};

export const PROJECT_ROLE_LABEL: Record<string, string> = {
  manager: "项目负责人",
  member: "项目成员",
};

export const GLOBAL_ROLE_LABEL: Record<string, string> = {
  partner: "合伙人",
  project_manager: "项目负责人",
  member: "项目成员",
  quality_lead: "质量负责人",
  finance: "财务",
  archivist: "档案管理员",
  sysadmin: "系统管理员",
  viewer: "只读查阅人",
};
