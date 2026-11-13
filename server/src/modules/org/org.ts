import { and, asc, desc, eq, ilike, ne, or, sql, type SQL } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { ERROR_CODE } from "@lexflow/shared";

import { companyProfile, orgUnits, userRoles, users } from "../../db/schema";
import { BusinessError, pgErrorCode } from "../../lib/errors";
import { hashPassword } from "../../lib/password";
import { requireOrgManage, requireOrgRead } from "../../services/access";
import { recordAudit } from "../../services/audit";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor } from "../governance/util";

/**
 * 组织管理域（arch/12 §9/§11）：公司信息（单记录）、部门树（增删改/拖拽调序调父级）、员工名录与维护。
 * 门：org.manage=sysadmin（access.can 注册）；partner 只读穿透（requireOrgRead，名录最小字段不含敏感列）；
 * 其余角色同形 404。全部写操作同事务审计（arch/02 §7）。员工创建复用既有用户生命周期（scrypt 初始口令/首登改密/停用启用沿用 users.status）。
 */

export interface UnitNode {
  id: string;
  name: string;
  parentId: string | null;
  sort: number;
  memberCount: number;
  children: UnitNode[];
}

function notFound(): BusinessError {
  return new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "组织信息不存在或无权访问");
}

/* ===== 公司信息（单记录） ===== */

export async function getCompany(db: DbOrTx, _user: SessionUser) {
  // 登录可读（发票抬头/合同水印引用需要）
  const [row] = await db.select().from(companyProfile).limit(1);
  return row ?? null;
}

export async function updateCompany(
  db: DbOrTx,
  user: SessionUser,
  input: {
    rowVersion: number;
    name?: string;
    creditCode?: string;
    address?: string;
    phone?: string;
    bankName?: string;
    bankAccount?: string;
  },
  ip: string | null,
  sessionId: string | null,
) {
  await requireOrgManage(db, user);
  const [before] = await db.select().from(companyProfile).limit(1);
  if (!before) throw notFound();
  const [updated] = await db
    .update(companyProfile)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.creditCode !== undefined ? { creditCode: input.creditCode.trim() } : {}),
      ...(input.address !== undefined ? { address: input.address.trim() } : {}),
      ...(input.phone !== undefined ? { phone: input.phone.trim() } : {}),
      ...(input.bankName !== undefined ? { bankName: input.bankName.trim() } : {}),
      ...(input.bankAccount !== undefined ? { bankAccount: input.bankAccount.trim() } : {}),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${companyProfile.rowVersion} + 1`,
    })
    .where(and(eq(companyProfile.id, before.id), eq(companyProfile.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "公司信息已被他人修改，请刷新后重试");
  await recordAudit(db, {
    actorId: user.id,
    sessionId,
    action: "org.company.update",
    targetType: "company_profile",
    targetId: updated.id,
    result: "success",
    beforeJson: { name: before.name, creditCode: before.creditCode, address: before.address, phone: before.phone, bankName: before.bankName, bankAccount: before.bankAccount },
    afterJson: { name: updated.name, creditCode: updated.creditCode, address: updated.address, phone: updated.phone, bankName: updated.bankName, bankAccount: updated.bankAccount },
    ip,
  });
  return updated;
}

/* ===== 部门树 ===== */

export async function getUnitTree(db: DbOrTx, user: SessionUser) {
  await requireOrgRead(db, user);
  const countRows = await db
    .select({ orgUnitId: users.orgUnitId, n: sql<number>`count(*)::int` })
    .from(users)
    .groupBy(users.orgUnitId);
  const countByUnit = new Map(countRows.map((r) => [r.orgUnitId, r.n]));
  const rows = await db
    .select({ id: orgUnits.id, name: orgUnits.name, parentId: orgUnits.parentId, sort: orgUnits.sort })
    .from(orgUnits)
    .orderBy(asc(orgUnits.sort), asc(orgUnits.name));
  const byId = new Map<string, UnitNode>();
  for (const r of rows) {
    byId.set(r.id, { ...r, memberCount: countByUnit.get(r.id) ?? 0, children: [] });
  }
  const roots: UnitNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // 按 sort 排序各层
  const sortRec = (list: UnitNode[]) => {
    list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

async function loadUnit(db: DbOrTx, id: string) {
  const [row] = await db.select().from(orgUnits).where(eq(orgUnits.id, id)).limit(1);
  if (!row) throw notFound();
  return row;
}

export async function createUnit(
  db: DbOrTx,
  user: SessionUser,
  input: { name: string; parentId?: string | null; sort?: number },
  ip: string | null,
  sessionId: string | null,
) {
  await requireOrgManage(db, user);
  const name = input.name.trim();
  if (!name) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "部门名称必填", { name: ["部门名称必填"] });
  if (input.parentId) await loadUnit(db, input.parentId);
  const [row] = await db
    .insert(orgUnits)
    .values({ name, parentId: input.parentId ?? null, sort: input.sort ?? 0 })
    .returning();
  if (!row) throw new Error("部门插入失败");
  await recordAudit(db, {
    actorId: user.id, sessionId, action: "org.units.create", targetType: "org_unit", targetId: row.id,
    result: "success", afterJson: { name: row.name, parentId: row.parentId, sort: row.sort }, ip,
  });
  return row;
}

export async function updateUnit(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; name?: string; sort?: number },
  ip: string | null,
  sessionId: string | null,
) {
  await requireOrgManage(db, user);
  const before = await loadUnit(db, input.id);
  const [updated] = await db
    .update(orgUnits)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.sort !== undefined ? { sort: input.sort } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(orgUnits.id, input.id))
    .returning();
  if (!updated) throw notFound();
  await recordAudit(db, {
    actorId: user.id, sessionId, action: "org.units.update", targetType: "org_unit", targetId: updated.id,
    result: "success",
    beforeJson: { name: before.name, sort: before.sort },
    afterJson: { name: updated.name, sort: updated.sort },
    ip,
  });
  return updated;
}

/** disable=停用清理：仅无成员且无子部门可删（前置校验，409 同形业务错误） */
export async function disableUnit(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string },
  ip: string | null,
  sessionId: string | null,
) {
  await requireOrgManage(db, user);
  const before = await loadUnit(db, input.id);
  const [members] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.orgUnitId, input.id));
  if (members.n > 0) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, `部门「${before.name}」仍有 ${members.n} 名成员，不可停用`);
  }
  const [children] = await db.select({ n: sql<number>`count(*)::int` }).from(orgUnits).where(eq(orgUnits.parentId, input.id));
  if (children.n > 0) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, `部门「${before.name}」存在下级部门，不可停用`);
  }
  await db.delete(orgUnits).where(eq(orgUnits.id, input.id));
  await recordAudit(db, {
    actorId: user.id, sessionId, action: "org.units.disable", targetType: "org_unit", targetId: input.id,
    result: "success", beforeJson: { name: before.name, parentId: before.parentId, sort: before.sort }, ip,
  });
  return { id: input.id, disabled: true as const };
}

/**
 * 拖拽落点：换父级 + 落点排序，同事务更新排序。
 * 防环：目标父级位于本部门子树内（含自身）→ 400 拒绝。
 */
export async function moveUnit(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; parentId: string | null; sort: number },
  ip: string | null,
  sessionId: string | null,
) {
  await requireOrgManage(db, user);
  const unit = await loadUnit(db, input.id);
  if (input.parentId) {
    const target = await loadUnit(db, input.parentId);
    // 防环：自 target 沿父链上溯，命中自身即拒绝
    let cursor: string | null = target.id;
    const guard = new Set<string>();
    while (cursor) {
      if (cursor === input.id) {
        throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "不能将部门移动到自身或其下级部门", {
          parentId: ["不能将部门移动到自身或其下级部门"],
        });
      }
      if (guard.has(cursor)) break;
      guard.add(cursor);
      const [row] = await db.select({ parentId: orgUnits.parentId }).from(orgUnits).where(eq(orgUnits.id, cursor)).limit(1);
      cursor = row?.parentId ?? null;
    }
  }
  const sort = Math.max(0, Math.trunc(input.sort));
  // 同事务：落点同级排序让位（sort >= 落点的兄弟 +1，排除被拖部门自身），再更新被拖部门
  await db
    .update(orgUnits)
    .set({ sort: sql`${orgUnits.sort} + 1` })
    .where(
      and(
        input.parentId ? eq(orgUnits.parentId, input.parentId) : sql`${orgUnits.parentId} IS NULL`,
        ne(orgUnits.id, input.id),
        sql`${orgUnits.sort} >= ${sort}`,
      ),
    );
  const [updated] = await db
    .update(orgUnits)
    .set({ parentId: input.parentId ?? null, sort, updatedAt: new Date().toISOString() })
    .where(eq(orgUnits.id, input.id))
    .returning();
  if (!updated) throw notFound();
  await recordAudit(db, {
    actorId: user.id, sessionId, action: "org.units.move", targetType: "org_unit", targetId: input.id,
    result: "success",
    beforeJson: { parentId: unit.parentId, sort: unit.sort },
    afterJson: { parentId: updated.parentId, sort: updated.sort },
    ip,
  });
  return updated;
}

/* ===== 员工名录与维护 ===== */

export async function listMembers(
  db: DbOrTx,
  user: SessionUser,
  input: { cursor?: string; limit: number; orgUnitId?: string; keyword?: string },
) {
  await requireOrgRead(db, user);
  const conditions: (SQL | undefined)[] = [];
  if (input.orgUnitId) conditions.push(eq(users.orgUnitId, input.orgUnitId));
  if (input.keyword) {
    const kw = `%${input.keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conditions.push(or(ilike(users.name, kw), ilike(users.email, kw), ilike(users.employeeNo, kw)));
  }
  conditions.push(cursorCondition(input.cursor, users.createdAt, users.id));
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
      orgUnitId: users.orgUnitId,
      orgUnitName: orgUnits.name,
      position: users.position,
      employeeNo: users.employeeNo,
      joinedAt: users.joinedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(orgUnits, eq(orgUnits.id, users.orgUnitId))
    .where(and(...conditions))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  // 角色聚合（徽标）
  const roleRows = await db.select({ userId: userRoles.userId, roleKey: userRoles.roleKey }).from(userRoles);
  const rolesByUser = new Map<string, string[]>();
  for (const r of roleRows) {
    const list = rolesByUser.get(r.userId) ?? [];
    list.push(r.roleKey);
    rolesByUser.set(r.userId, list);
  }
  return {
    items: page.map(({ createdAt: _at, ...item }) => ({ ...item, roles: rolesByUser.get(item.id) ?? [] })),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function createMember(
  db: DbOrTx,
  user: SessionUser,
  input: {
    name: string;
    email: string;
    orgUnitId?: string | null;
    position?: string;
    employeeNo?: string | null;
    joinedAt?: string | null;
    roleKey: string;
  },
  ip: string | null,
  sessionId: string | null,
) {
  await requireOrgManage(db, user);
  if (input.orgUnitId) await loadUnit(db, input.orgUnitId);
  // 复用既有用户生命周期：scrypt 初始口令 + 首登强制改密（口令仅本响应一次下发，不入审计/日志）
  const initialPassword = `Lx${randomBytes(4).toString("hex")}!`;
  let row;
  try {
    [row] = await db
      .insert(users)
      .values({
        email: input.email.trim().toLowerCase(),
        name: input.name.trim(),
        passwordHash: hashPassword(initialPassword),
        status: "active",
        mustChangePassword: true,
        orgUnitId: input.orgUnitId ?? null,
        position: input.position?.trim() ?? "",
        employeeNo: input.employeeNo?.trim() || null,
        joinedAt: input.joinedAt ?? null,
      })
      .returning({ id: users.id, email: users.email, name: users.name, employeeNo: users.employeeNo, orgUnitId: users.orgUnitId, position: users.position, joinedAt: users.joinedAt });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "邮箱或工号已存在", { employeeNo: ["邮箱或工号已存在"] });
    }
    throw error;
  }
  if (!row) throw new Error("员工插入失败");
  try {
    await db.insert(userRoles).values({ userId: row.id, roleKey: input.roleKey }).onConflictDoNothing();
  } catch (error) {
    if (pgErrorCode(error) === "23503") {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "角色不存在", { roleKey: ["角色不存在"] });
    }
    throw error;
  }
  await recordAudit(db, {
    actorId: user.id, sessionId, action: "org.members.create", targetType: "user", targetId: row.id,
    result: "success", afterJson: { email: row.email, roleKey: input.roleKey, employeeNo: row.employeeNo, mustChangePassword: true }, ip,
  });
  return { ...row, initialPassword };
}

export async function updateMember(
  db: DbOrTx,
  user: SessionUser,
  input: {
    id: string;
    name?: string;
    orgUnitId?: string | null;
    position?: string;
    employeeNo?: string | null;
    joinedAt?: string | null;
    /** 直属主管（arch/13 §3.2：权限数据，sysadmin 维护；多级成环校验） */
    managerId?: string | null;
    roleKeys?: string[];
  },
  ip: string | null,
  sessionId: string | null,
) {
  await requireOrgManage(db, user);
  const [before] = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
  if (!before) throw notFound();
  if (input.orgUnitId) await loadUnit(db, input.orgUnitId);
  // 主管维护：多级成环校验 + 引用校验（arch/13 §3.2）
  if (input.managerId !== undefined && input.managerId !== null) {
    if (input.managerId === input.id) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "主管不可为本人", { managerId: ["主管不可为本人"] });
    const [mgr] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, input.managerId), eq(users.status, "active"))).limit(1);
    if (!mgr) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "主管不存在或已停用", { managerId: ["主管不存在或已停用"] });
    const { wouldCreateManagerCycle } = await import("../../services/access/crm-scope");
    if (await wouldCreateManagerCycle(db, input.id, input.managerId)) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "主管变更将成环（多级汇报链校验拒绝）", { managerId: ["主管链不可成环"] });
    }
  }
  let updated;
  try {
    [updated] = await db
      .update(users)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.orgUnitId !== undefined ? { orgUnitId: input.orgUnitId } : {}),
        ...(input.position !== undefined ? { position: input.position.trim() } : {}),
        ...(input.employeeNo !== undefined ? { employeeNo: input.employeeNo?.trim() || null } : {}),
        ...(input.joinedAt !== undefined ? { joinedAt: input.joinedAt } : {}),
        ...(input.managerId !== undefined ? { managerId: input.managerId } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, input.id))
      .returning({ id: users.id, name: users.name, email: users.email, orgUnitId: users.orgUnitId, position: users.position, employeeNo: users.employeeNo, joinedAt: users.joinedAt });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "工号已存在", { employeeNo: ["工号已存在"] });
    }
    throw error;
  }
  if (!updated) throw notFound();
  let rolesAfter: string[] | undefined;
  if (input.roleKeys) {
    const existing = await db.select({ roleKey: userRoles.roleKey }).from(userRoles).where(eq(userRoles.userId, input.id));
    const existingSet = new Set(existing.map((r) => r.roleKey));
    const targetSet = new Set(input.roleKeys);
    for (const roleKey of existingSet) {
      if (!targetSet.has(roleKey)) await db.delete(userRoles).where(and(eq(userRoles.userId, input.id), eq(userRoles.roleKey, roleKey)));
    }
    for (const roleKey of targetSet) {
      if (!existingSet.has(roleKey)) await db.insert(userRoles).values({ userId: input.id, roleKey }).onConflictDoNothing();
    }
    rolesAfter = input.roleKeys;
  }
  await recordAudit(db, {
    actorId: user.id, sessionId, action: "org.members.update", targetType: "user", targetId: input.id,
    result: "success",
    beforeJson: { name: before.name, orgUnitId: before.orgUnitId, position: before.position, employeeNo: before.employeeNo, joinedAt: before.joinedAt },
    afterJson: { name: updated.name, orgUnitId: updated.orgUnitId, position: updated.position, employeeNo: updated.employeeNo, joinedAt: updated.joinedAt, roles: rolesAfter },
    ip,
  });
  return { ...updated, roles: rolesAfter };
}

/** 停用/启用沿用既有 users.status 生命周期（admin.disableUser 同款语义，此处供前端迁址期复用） */
export async function setMemberStatus(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; status: "active" | "disabled" },
  ip: string | null,
  sessionId: string | null,
) {
  await requireOrgManage(db, user);
  const [updated] = await db
    .update(users)
    .set({ status: input.status, updatedAt: new Date().toISOString() })
    .where(eq(users.id, input.id))
    .returning({ id: users.id, email: users.email, status: users.status });
  if (!updated) throw notFound();
  if (input.status === "disabled") {
    // 停用即时失效（会话过期化，arch/00 §4 v1.1）
    const { sessions } = await import("../../db/schema");
    await db.update(sessions).set({ expiresAt: new Date().toISOString() }).where(eq(sessions.userId, input.id));
  }
  await recordAudit(db, {
    actorId: user.id, sessionId, action: input.status === "disabled" ? "org.members.disable" : "org.members.enable",
    targetType: "user", targetId: input.id, result: "success", afterJson: { email: updated.email, status: input.status }, ip,
  });
  return updated;
}

