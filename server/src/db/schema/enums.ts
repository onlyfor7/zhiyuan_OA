import { pgEnum } from "drizzle-orm/pg-core";

import {
  ACCESS_GRANT_SCOPE_TYPE,
  ACCESS_GRANT_STATUS,
  CONFIDENTIALITY_LEVEL,
  PROJECT_HEALTH_STATUS,
  PROJECT_LIFECYCLE_STATUS,
  USER_STATUS,
} from "@lexflow/shared";

/** 迭代 0 需要的枚举用 pgEnum（arch/01 §2 裁定）；其余状态机枚举随业务迭代落地 */

export const userStatusEnum = pgEnum("user_status", USER_STATUS);

export const confidentialityLevelEnum = pgEnum("confidentiality_level", CONFIDENTIALITY_LEVEL);

export const projectLifecycleStatusEnum = pgEnum("project_lifecycle_status", PROJECT_LIFECYCLE_STATUS);

export const projectHealthStatusEnum = pgEnum("project_health_status", PROJECT_HEALTH_STATUS);

export const accessGrantStatusEnum = pgEnum("access_grant_status", ACCESS_GRANT_STATUS);

export const accessGrantScopeTypeEnum = pgEnum("access_grant_scope_type", ACCESS_GRANT_SCOPE_TYPE);
