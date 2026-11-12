import { and, desc, eq, sql } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { flowDefinitions } from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { disableFlowRow, insertFlowDraftRow, publishFlowRow } from "./designer";
import { validateFlowStructure } from "../../services/approval/flow";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * 项目级流程管理（arch/11 G5）：项目空间「审批流」配置入口的服务端。
 * 门：项目负责人（project_members.project_role='manager'）可见可管，非授权同形 404；
 * scope 固定 project + project_id 绑定（引擎解析优先级 03b 已落地：项目 scope 命中优先于 global）；
 * biz_binding 固定白名单（基础业务表单），不开放任意对象。
 */

/** 项目内流程允许绑定的业务类型（G5：出差/延期/经费/费用/工时） */
export const PROJECT_FLOW_BINDINGS = [
  "travel",
  "travel_change",
  "change_request",
  "funding",
  "expense",
  "expense_adjustment",
  "timesheet",
] as const;

async function requireProjectFlowAdmin(user: SessionUser, projectId: string): Promise<void> {
  if (user.projectRoles.get(projectId) !== "manager") {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权管理其审批流");
  }
}

/** 行须属于本项目（防越权操作他项目流程） */
async function loadProjectFlow(db: DbOrTx, projectId: string, flowId: string) {
  const [row] = await db
    .select()
    .from(flowDefinitions)
    .where(and(eq(flowDefinitions.id, flowId), eq(flowDefinitions.projectId, projectId)))
    .limit(1);
  if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "流程不存在或无权访问");
  return row;
}

export async function listProjectFlows(db: DbOrTx, user: SessionUser, projectId: string) {
  await requireProjectFlowAdmin(user, projectId);
  return db
    .select()
    .from(flowDefinitions)
    .where(eq(flowDefinitions.projectId, projectId))
    .orderBy(flowDefinitions.bizBinding, desc(flowDefinitions.versionNo));
}

export async function createProjectFlowDraft(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId: string; name: string; bizBinding: string; definitionJson: Record<string, unknown> },
) {
  await requireProjectFlowAdmin(user, input.projectId);
  if (!(PROJECT_FLOW_BINDINGS as readonly string[]).includes(input.bizBinding)) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "项目内流程仅支持绑定基础业务类型", {
      bizBinding: [`允许：${PROJECT_FLOW_BINDINGS.join("/")}`],
    });
  }
  return insertFlowDraftRow(db, user.id, {
    name: input.name,
    scope: "project",
    bizBinding: input.bizBinding,
    projectId: input.projectId,
    definitionJson: input.definitionJson,
  });
}

export async function publishProjectFlow(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId: string; id: string; idempotencyKey: string },
) {
  await requireProjectFlowAdmin(user, input.projectId);
  const row = await loadProjectFlow(db, input.projectId, input.id);
  return publishFlowRow(db, user.id, row, input.idempotencyKey);
}

/** 项目流草稿编辑（arch/12 §20.2）：负责人门+行属本项目+仅草稿可改（已发布须先停用产新版本）；
 *  definitionJson 保存即服务端校验（同系统级 FLOW_INVALID）；乐观锁 rowVersion；审计随 authedMutation 同事务。 */
export async function updateProjectFlowDraft(
  db: DbOrTx,
  user: SessionUser,
  input: {
    projectId: string;
    id: string;
    rowVersion: number;
    name?: string;
    definitionJson?: Record<string, unknown>;
  },
) {
  await requireProjectFlowAdmin(user, input.projectId);
  const row = await loadProjectFlow(db, input.projectId, input.id);
  if (row.enabled) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已发布流程不可修改（须先停用再产新版本）");
  }
  if (input.definitionJson) validateFlowStructure(input.definitionJson);
  const [updated] = await db
    .update(flowDefinitions)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.definitionJson !== undefined ? { definitionJson: input.definitionJson } : {}),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${flowDefinitions.rowVersion} + 1`,
    })
    .where(and(eq(flowDefinitions.id, row.id), eq(flowDefinitions.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  return updated;
}

export async function disableProjectFlow(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId: string; id: string; rowVersion: number },
) {
  await requireProjectFlowAdmin(user, input.projectId);
  await loadProjectFlow(db, input.projectId, input.id);
  return disableFlowRow(db, user.id, input.id, input.rowVersion);
}
