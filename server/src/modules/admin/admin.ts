import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { CONFIG_KEY, ERROR_CODE } from "@lexflow/shared";

import { clients, crmLeads, crmOpportunities, matters, orgUnits, projectTemplates, projects, sessions, systemConfig, userRoles, users } from "../../db/schema";
import { nextCode } from "../../db/code";
import { hashPassword, verifyPassword } from "../../lib/password";
import { BusinessError, pgErrorCode } from "../../lib/errors";
import { can } from "../../services/access";
import { recordAudit } from "../../services/audit";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * B 域 · 基础数据与配置中心（arch/09 §4）：admin.config 门 + 全审计；
 * sysadmin 管配置不因此获得业务内容权（arch/03 §4.5）。
 * 注：users/clients 无 status/改密列（数据棒 0007 未含）——首登改密标记与客户/事项停用
 * 以 system_config JSON 键承载（登记偏差，裁定后可迁列）。
 */

async function requireAdminConfig(db: DbOrTx, user: SessionUser): Promise<void> {
  const allowed = await can(db, user, "admin.config", { type: "project", projectId: "" });
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "无系统管理权限");
}

async function readJsonConfig<T>(db: DbOrTx, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(systemConfig).where(eq(systemConfig.key, key)).limit(1);
  return (row?.valueJson as T | undefined) ?? fallback;
}

async function writeJsonConfig(db: DbOrTx, key: string, value: unknown, userId: string): Promise<void> {
  await db
    .insert(systemConfig)
    .values({ key, valueJson: value as Record<string, unknown>, updatedBy: userId })
    .onConflictDoUpdate({ target: systemConfig.key, set: { valueJson: value as Record<string, unknown>, updatedBy: userId, updatedAt: new Date().toISOString() } });
}

/* ===== 用户管理 ===== */

export async function userList(db: DbOrTx, user: SessionUser) {
  await requireAdminConfig(db, user);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
      orgUnitId: users.orgUnitId,
      orgUnitName: orgUnits.name,
      mustChangePassword: users.mustChangePassword,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(orgUnits, eq(orgUnits.id, users.orgUnitId))
    .orderBy(users.createdAt);
  // roles 聚合（arch 裁定 04b-②）：每用户全局角色数组
  const roleRows = await db.select({ userId: userRoles.userId, roleKey: userRoles.roleKey }).from(userRoles);
  const rolesByUser = new Map<string, string[]>();
  for (const r of roleRows) {
    const list = rolesByUser.get(r.userId) ?? [];
    list.push(r.roleKey);
    rolesByUser.set(r.userId, list);
  }
  return rows.map((r) => ({ ...r, roles: rolesByUser.get(r.id) ?? [] }));
}

export async function createUser(
  db: DbOrTx,
  actor: SessionUser,
  input: { email: string; name: string; orgUnitId?: string; roleKey: string; ip: string | null; sessionId: string | null },
) {
  await requireAdminConfig(db, actor);
  const initialPassword = `Lx${randomBytes(4).toString("hex")}!`;
  let userRow;
  try {
    [userRow] = await db.insert(users).values({
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      passwordHash: hashPassword(initialPassword),
      status: "active",
      mustChangePassword: true, // 02b 列就位：首登强制改密落到行
      orgUnitId: input.orgUnitId ?? null,
    }).returning({ id: users.id, email: users.email, name: users.name });
  } catch (error) {
    // R9：orgUnitId 等 FK 违例映射 4xx，不泄 500
    if (pgErrorCode(error) === "23503") {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "组织单元不存在或不可引用", { orgUnitId: ["组织单元不存在或不可引用"] });
    }
    throw error;
  }
  const row = userRow;
  if (!row) throw new Error("用户插入失败");
  try {
    await db.insert(userRoles).values({ userId: row.id, roleKey: input.roleKey }).onConflictDoNothing();
  } catch (error) {
    // R9 同类入口：FK/约束违例映射 4xx
    if (pgErrorCode(error) === "23503") {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "角色或组织单元不存在", { roleKey: ["角色不存在"] });
    }
    throw error;
  }
  await recordAudit(db, {
    actorId: actor.id,
    sessionId: input.sessionId,
    action: "admin.createUser",
    targetType: "user",
    targetId: row.id,
    result: "success",
    afterJson: { email: row.email, roleKey: input.roleKey, mustChangePassword: true },
    ip: input.ip,
  });
  // 初始口令仅本响应一次下发（不得入库/日志）
  return { ...row, initialPassword };
}

export async function setUserStatus(
  db: DbOrTx,
  actor: SessionUser,
  input: { userId: string; status: "active" | "disabled"; ip: string | null; sessionId: string | null },
) {
  await requireAdminConfig(db, actor);
  const [updated] = await db
    .update(users)
    .set({ status: input.status, updatedAt: new Date().toISOString() })
    .where(eq(users.id, input.userId))
    .returning({ id: users.id, email: users.email });
  if (!updated) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "用户不存在");
  // 停用即时失效（会话过期化，不物理删除——arch/00 §4 v1.1）
  if (input.status === "disabled") {
    await db.update(sessions).set({ expiresAt: new Date().toISOString() }).where(eq(sessions.userId, input.userId));
  }
  await recordAudit(db, {
    actorId: actor.id,
    sessionId: input.sessionId,
    action: input.status === "disabled" ? "admin.disableUser" : "admin.enableUser",
    targetType: "user",
    targetId: input.userId,
    result: "success",
    afterJson: { email: updated.email, status: input.status, sessionsInvalidated: input.status === "disabled" },
    ip: input.ip,
  });
  return updated;
}

export async function assignRole(
  db: DbOrTx,
  actor: SessionUser,
  input: { userId: string; roleKey: string; assign: boolean; ip: string | null; sessionId: string | null },
) {
  await requireAdminConfig(db, actor);
  if (input.assign) {
    await db.insert(userRoles).values({ userId: input.userId, roleKey: input.roleKey }).onConflictDoNothing();
  } else {
    await db.delete(userRoles).where(and(eq(userRoles.userId, input.userId), eq(userRoles.roleKey, input.roleKey)));
  }
  await recordAudit(db, {
    actorId: actor.id,
    sessionId: input.sessionId,
    action: input.assign ? "admin.assignRole" : "admin.unassignRole",
    targetType: "user",
    targetId: input.userId,
    result: "success",
    afterJson: { roleKey: input.roleKey, assign: input.assign },
    ip: input.ip,
  });
  return { ok: true as const };
}

/* ===== 客户/事项（停用非删除；停用清单入配置存储，登记偏差） ===== */

export async function createClient(db: DbOrTx, actor: SessionUser, input: { name: string; confidentialityLevel?: "public" | "internal" | "confidential" | "secret"; ip: string | null; sessionId: string | null }) {
  await requireAdminConfig(db, actor);
  const code = await nextCode("CLT", db);
  const [row] = await db
    .insert(clients)
    .values({ code, name: input.name.trim(), confidentialityLevel: input.confidentialityLevel ?? "internal", createdBy: actor.id, updatedBy: actor.id })
    .returning();
  await recordAudit(db, { actorId: actor.id, sessionId: input.sessionId, action: "admin.createClient", targetType: "client", targetId: row.id, result: "success", afterJson: { code, name: input.name }, ip: input.ip });
  return row;
}

export async function setClientDisabled(db: DbOrTx, actor: SessionUser, input: { clientId: string; disabled: boolean; ip: string | null; sessionId: string | null }) {
  await requireAdminConfig(db, actor);
  // 02b 列就位：停用落到行（status=active/disabled），非删除、不存 system_config
  await db
    .update(clients)
    .set({ status: input.disabled ? "disabled" : "active", updatedBy: actor.id, updatedAt: new Date().toISOString() })
    .where(eq(clients.id, input.clientId));
  await recordAudit(db, { actorId: actor.id, sessionId: input.sessionId, action: "admin.setClientDisabled", targetType: "client", targetId: input.clientId, result: "success", afterJson: { disabled: input.disabled }, ip: input.ip });
  return { disabled: input.disabled };
}

export async function createMatter(db: DbOrTx, actor: SessionUser, input: { clientId: string; name: string; type?: string; ip: string | null; sessionId: string | null }) {
  await requireAdminConfig(db, actor);
  const code = await nextCode("MTR", db);
  let row;
  try {
    [row] = await db
      .insert(matters)
      .values({ code, clientId: input.clientId, name: input.name.trim(), type: input.type ?? "", createdBy: actor.id, updatedBy: actor.id })
      .returning();
  } catch (error) {
    // R9：FK 违例（clientId 不存在）映射 4xx，不泄 500
    if (pgErrorCode(error) === "23503") {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "客户不存在或不可引用", { clientId: ["客户不存在或不可引用"] });
    }
    throw error;
  }
  if (!row) throw new Error("事项插入失败");
  await recordAudit(db, { actorId: actor.id, sessionId: input.sessionId, action: "admin.createMatter", targetType: "matter", targetId: row.id, result: "success", afterJson: { code, name: input.name }, ip: input.ip });
  return row;
}

export async function setMatterDisabled(db: DbOrTx, actor: SessionUser, input: { matterId: string; disabled: boolean; ip: string | null; sessionId: string | null }) {
  await requireAdminConfig(db, actor);
  await db
    .update(matters)
    .set({ status: input.disabled ? "disabled" : "active", updatedBy: actor.id, updatedAt: new Date().toISOString() })
    .where(eq(matters.id, input.matterId));
  await recordAudit(db, { actorId: actor.id, sessionId: input.sessionId, action: "admin.setMatterDisabled", targetType: "matter", targetId: input.matterId, result: "success", afterJson: { disabled: input.disabled }, ip: input.ip });
  return { disabled: input.disabled };
}

/* ===== 模板与配置 ===== */

/** structure_json 校验（updateTemplate 与 createTemplate 共用规则，arch/04 §2.10） */
function assertTemplateStructure(structureJson: Record<string, unknown>): void {
  const structure = structureJson as { stages?: Array<{ name: string; seq: number }> };
  if (!Array.isArray(structure.stages) || structure.stages.some((s) => !s.name || typeof s.seq !== "number")) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "structure_json.stages 须为 [{name,seq}] 数组", { structureJson: ["stages 非法"] });
  }
}

export async function createTemplate(
  db: DbOrTx,
  actor: SessionUser,
  input: { name: string; description?: string; structureJson: Record<string, unknown>; ip: string | null; sessionId: string | null },
) {
  await requireAdminConfig(db, actor);
  const name = input.name.trim();
  if (!name) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "模板名称必填", { name: ["模板名称必填"] });
  assertTemplateStructure(input.structureJson);
  let row;
  try {
    [row] = await db
      .insert(projectTemplates)
      .values({
        name,
        description: input.description?.trim() ?? "",
        structureJson: input.structureJson,
        createdBy: actor.id,
        updatedBy: actor.id,
      })
      .returning();
  } catch (error) {
    // 模板名唯一：重名映射 4xx（同 R9 FK/约束口径）
    if (pgErrorCode(error) === "23505") {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "模板名称已存在", { name: ["模板名称已存在"] });
    }
    throw error;
  }
  if (!row) throw new Error("模板插入失败");
  await recordAudit(db, { actorId: actor.id, sessionId: input.sessionId, action: "admin.createTemplate", targetType: "project_template", targetId: row.id, result: "success", afterJson: { name }, ip: input.ip });
  return row;
}

export async function updateTemplate(db: DbOrTx, actor: SessionUser, input: { id: string; name?: string; description?: string; structureJson: Record<string, unknown>; ip: string | null; sessionId: string | null }) {
  await requireAdminConfig(db, actor);
  assertTemplateStructure(input.structureJson);
  const [updated] = await db
    .update(projectTemplates)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      structureJson: input.structureJson,
      updatedBy: actor.id,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projectTemplates.id, input.id))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "模板不存在");
  await recordAudit(db, { actorId: actor.id, sessionId: input.sessionId, action: "admin.updateTemplate", targetType: "project_template", targetId: input.id, result: "success", afterJson: { name: updated.name }, ip: input.ip });
  return updated;
}

const CONFIG_WHITELIST = new Set<string>([...Object.values(CONFIG_KEY)]);

export async function getConfig(db: DbOrTx, actor: SessionUser, input: { key: string }) {
  await requireAdminConfig(db, actor);
  if (!CONFIG_WHITELIST.has(input.key)) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "配置键不在白名单", { key: ["配置键不在白名单"] });
  }
  const [row] = await db.select().from(systemConfig).where(eq(systemConfig.key, input.key)).limit(1);
  return { key: input.key, valueJson: row?.valueJson ?? null, updatedAt: row?.updatedAt ?? null };
}

export async function setConfig(db: DbOrTx, actor: SessionUser, input: { key: string; value: Record<string, unknown>; ip: string | null; sessionId: string | null }) {
  await requireAdminConfig(db, actor);
  if (!CONFIG_WHITELIST.has(input.key)) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "配置键不在白名单", { key: ["配置键不在白名单"] });
  }
  const before = await readJsonConfig<unknown>(db, input.key, null);
  await writeJsonConfig(db, input.key, input.value, actor.id);
  await recordAudit(db, {
    actorId: actor.id,
    sessionId: input.sessionId,
    action: "admin.setConfig",
    targetType: "system_config",
    targetId: null,
    result: "success",
    beforeJson: { key: input.key, value: before as Record<string, unknown> },
    afterJson: { key: input.key, value: input.value },
    ip: input.ip,
  });
  return { key: input.key, valueJson: input.value };
}

/* ===== 自助改密 ===== */

export async function changePassword(
  db: DbOrTx,
  user: SessionUser,
  input: { oldPassword: string; newPassword: string; ip: string | null; sessionId: string | null },
) {
  const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "用户不存在");
  if (!verifyPassword(input.oldPassword, row.passwordHash)) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "原口令不正确");
  }
  if (input.newPassword.length < 8) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "新口令至少 8 位", { newPassword: ["新口令至少 8 位"] });
  }
  await db.update(users).set({ passwordHash: hashPassword(input.newPassword), updatedAt: new Date().toISOString() }).where(eq(users.id, user.id));
  // 全会话失效（含本会话——改密后须重新登录）
  await db.update(sessions).set({ expiresAt: new Date().toISOString() }).where(eq(sessions.userId, user.id));
  await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, user.id));
  await recordAudit(db, {
    actorId: user.id,
    sessionId: input.sessionId,
    action: "auth.changePassword",
    targetType: "user",
    targetId: user.id,
    result: "success",
    afterJson: { sessionsInvalidated: true },
    ip: input.ip,
  });
  return { ok: true as const };
}

export async function mustChangePasswordFlag(db: DbOrTx, userId: string): Promise<boolean> {
  // 02b 列就位：读 users.must_change_password（system_config 临时键已被迁移删除）
  const [row] = await db.select({ mustChangePassword: users.mustChangePassword }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.mustChangePassword === true;
}

/* ===== 受控数据纠正（arch/13 §7.3 D3：sysadmin 限定·白名单对象/字段·理由+乐观锁·before/after 全快照审计） ===== */

interface CorrectInput {
  object: "lead" | "opportunity" | "client" | "project" | "user";
  id: string;
  rowVersion: number;
  patch: Record<string, unknown>;
  reason: string;
}

const CONFIDENTIALITY = ["public", "internal", "confidential", "secret"] as const;

/** 白名单：本棒最小集（线索联系信息/商机基础字段与售前指派/客户基础字段/项目名称类型密级/员工部门岗位主管） */
const WHITELIST: Record<CorrectInput["object"], string[]> = {
  lead: ["contactName", "contactPhone", "source"],
  opportunity: ["name", "expectedAmountCents", "winRate", "presalesId"],
  client: ["name", "level", "industry", "address"],
  project: ["name", "type", "confidentialityLevel"],
  user: ["orgUnitId", "position", "managerId"],
};

const CORRECT_TABLES = {
  lead: { table: crmLeads, targetType: "crm_lead" },
  opportunity: { table: crmOpportunities, targetType: "crm_opportunity" },
  client: { table: clients, targetType: "client" },
  project: { table: projects, targetType: "project" },
  user: { table: users, targetType: "user" },
} as const;

export async function correctRecord(db: DbOrTx, actor: SessionUser, input: CorrectInput, ip: string | null, sessionId: string | null) {
  await requireAdminConfig(db, actor); // sysadmin 限定（admin.config 门）
  if (!input.reason.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "纠正理由必填", { reason: ["纠正理由必填"] });
  const allowedFields = WHITELIST[input.object];
  const keys = Object.keys(input.patch);
  if (keys.length === 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "纠正补丁为空", { patch: ["纠正补丁为空"] });
  for (const k of keys) {
    if (!allowedFields.includes(k)) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, `字段不在纠正白名单：${input.object}.${k}`, { patch: [`${input.object} 仅允许：${allowedFields.join("/")}`] });
    }
  }

  const now = new Date().toISOString();
  const { table, targetType } = CORRECT_TABLES[input.object];

  // 引用与状态机校验（服务端重鉴权，不轻信补丁）
  if (input.object === "opportunity" && input.patch.presalesId) {
    const [ps] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, String(input.patch.presalesId)), eq(users.status, "active"))).limit(1);
    if (!ps) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "售前指派人不存在或已停用", { presalesId: ["售前指派人不存在或已停用"] });
  }
  if (input.object === "opportunity") {
    const [row] = await db.select({ stage: crmOpportunities.stage }).from(crmOpportunities).where(eq(crmOpportunities.id, input.id)).limit(1);
    if (!row) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "纠正对象不存在或无权访问");
    if (row.stage === "lost" || row.stage === "won") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已终态，不可纠正（走既有业务语义）");
  }
  if (input.object === "user") {
    if (input.patch.orgUnitId) {
      const [ou] = await db.select({ id: orgUnits.id }).from(orgUnits).where(eq(orgUnits.id, String(input.patch.orgUnitId))).limit(1);
      if (!ou) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "部门不存在", { orgUnitId: ["部门不存在"] });
    }
    if (input.patch.managerId) {
      const mid = String(input.patch.managerId);
      const [mgr] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, mid), eq(users.status, "active"))).limit(1);
      if (!mgr) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "主管不存在或已停用", { managerId: ["主管不存在或已停用"] });
      if (mid === input.id) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "主管不可为本人", { managerId: ["主管不可为本人"] });
      const { wouldCreateManagerCycle } = await import("../../services/access/crm-scope");
      if (await wouldCreateManagerCycle(db, input.id, mid)) {
        throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "主管变更将成环（多级汇报链校验拒绝）", { managerId: ["主管链不可成环"] });
      }
    }
  }
  if (input.object === "project" && input.patch.confidentialityLevel) {
    if (!(CONFIDENTIALITY as readonly string[]).includes(String(input.patch.confidentialityLevel))) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "密级非法", { confidentialityLevel: [`允许：${CONFIDENTIALITY.join("/")}`] });
    }
  }

  const before = await db.execute(sql`SELECT * FROM ${table} WHERE id = ${input.id} LIMIT 1`);
  if (!before.rows[0]) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "纠正对象不存在或无权访问");

  const snake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`); // TS 驼峰 → DB snake_case
  const assignments = keys.map((k) => {
    const v = input.patch[k];
    const val = typeof v === "string" ? v.trim() : (v ?? null);
    return sql`${sql.identifier(snake(k))} = ${val as never}`;
  });
  const updated = await db.execute(sql`
    UPDATE ${table}
    SET ${sql.join([...assignments, sql`updated_at = ${now}`, sql`row_version = row_version + 1`], sql`, `)}
    WHERE id = ${input.id} AND row_version = ${input.rowVersion}
    RETURNING *
  `);
  if (!updated.rows[0]) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");

  await recordAudit(db, {
    actorId: actor.id, sessionId, action: "admin.correctRecord", targetType, targetId: input.id, result: "success",
    beforeJson: before.rows[0] as Record<string, unknown>,
    afterJson: { ...(updated.rows[0] as Record<string, unknown>), correctReason: input.reason.trim(), patchedFields: keys },
    ip,
  });
  return { object: input.object, id: input.id, before: before.rows[0], after: updated.rows[0], corrected: keys };
}
