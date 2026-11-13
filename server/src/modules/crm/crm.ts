import { and, asc, desc, eq, ilike, ne, sql, type SQL } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import {
  clients,
  crmContacts,
  crmContractPaymentPlans,
  crmContracts,
  crmFollowups,
  crmLeads,
  crmOpportunities,
  fileObjects,
  matters,
  paymentReceipts,
  planVersions,
  projectMembers,
  projectTemplates,
  projects,
  users,
} from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { recordAudit } from "../../services/audit";
import { can } from "../../services/access";
import {
  canSeeAmounts,
  contractScopeSql,
  customerScopeSql,
  leadScopeSql,
  opportunityScopeSql,
  resolveCrmScope,
  type CrmScope,
} from "../../services/access/crm-scope";
import { instantiateProjectFromTemplate, instantiateTemplatePlan } from "../governance/project";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor } from "../governance/util";

/**
 * CRM 域（arch/12 §6/§11 + arch/13 §4 可见性矩阵 + §5 全周期）：
 * 统一走 crm-scope 解析器在 SQL 层过滤（列表/详情/搜索/报表/导出同一口径）；
 * 金额：范围内角色可见，finance 合同前只见聚合（crm.summary）。
 * 关键事务：商机成立即立项（D5 同事务：商机/事项/项目/成员/售前计划/编号/审计）、
 * 赢单挂合同+激活转交付、markLost 关项目、回款勾稽（计划行状态+累计，作废回写）。
 */

function notFound(): BusinessError {
  return new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "CRM 记录不存在或无权访问");
}

/* ===== 权限（arch/13 §4：粗门 can() + 行级 crm-scope SQL 双重把关） ===== */

/** 行级可见断言：按范围 SQL 复核主键（null=整域不可见直接 404；同形 404 裁定不破） */
async function assertRowVisible(db: DbOrTx, table: unknown, id: string, cond: SQL | null): Promise<void> {
  if (cond === null) throw notFound();
  const r = await db.execute(sql`SELECT 1 FROM ${table as never} WHERE id = ${id} AND ${cond} LIMIT 1`);
  if (r.rows.length === 0) throw notFound();
}

/** 旧接口兼容（模块外调用点：报表/搜索等） */
export function canReadCrm(user: SessionUser): boolean {
  return (
    user.globalRoles.includes("partner") ||
    user.globalRoles.includes("operations") ||
    user.globalRoles.includes("ceo") ||
    user.globalRoles.includes("sysadmin") ||
    user.globalRoles.includes("sales") ||
    user.globalRoles.includes("sales_manager") ||
    user.globalRoles.includes("regional_vp") ||
    user.globalRoles.includes("presales") ||
    user.globalRoles.includes("finance") ||
    user.globalRoles.includes("project_manager")
  );
}

export async function requireCrmRead(db: DbOrTx, user: SessionUser): Promise<void> {
  const allowed = await can(db, user, "crm.read", { type: "project", projectId: "" });
  if (!allowed) throw notFound();
}

export async function requireCrmManage(db: DbOrTx, user: SessionUser, ownerId: string | null = null): Promise<void> {
  const allowed = await can(db, user, "crm.manage", { type: "project", projectId: "" });
  if (allowed) return;
  // tree 形态：管辖范围内 owner 可 manage（sales 本人/主管/VP）
  const scope = await resolveCrmScope(db, user);
  if (!(scope.kinds.includes("tree") && ownerId !== null && scope.treeIds.includes(ownerId))) throw notFound();
}

/** 金额列可见：范围内角色（global/tree/presales） */
function scopeCanSeeAmounts(scope: CrmScope): boolean {
  return canSeeAmounts(scope);
}

function stripAmounts<T extends Record<string, unknown>>(row: T, see: boolean, keys: string[]): T {
  if (see) return row;
  const copy = { ...row };
  for (const k of keys) delete copy[k];
  return copy;
}

/** 合同金额深度剥离（O-18-5-3）：外层金额不可见时，付款计划行 amountCents 同步剥离 */
function stripContractDeep<T extends { plans?: unknown[] } & Record<string, unknown>>(row: T, see: boolean, keys: string[]): T {
  const outer = stripAmounts(row, see, keys);
  if (see) return outer;
  const plans = (outer.plans ?? []) as Array<Record<string, unknown>>;
  return { ...outer, plans: plans.map((p) => { const { amountCents: _a, ...rest } = p; return rest; }) };
}

/* ===== 线索 ===== */

export async function listLeads(
  db: DbOrTx,
  user: SessionUser,
  input: { cursor?: string; limit: number; status?: string; keyword?: string },
) {
  await requireCrmRead(db, user);
  const scope = await resolveCrmScope(db, user);
  const scopeSql = leadScopeSql(scope);
  if (scopeSql === null) throw notFound(); // finance/project/none：无线索明细权
  const conditions: (SQL | undefined)[] = [scopeSql];
  if (input.status) conditions.push(eq(crmLeads.status, input.status as never));
  if (input.keyword) {
    const kw = `%${input.keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conditions.push(ilike(crmLeads.name, kw));
  }
  conditions.push(cursorCondition(input.cursor, crmLeads.createdAt, crmLeads.id));
  const rows = await db
    .select()
    .from(crmLeads)
    .where(and(...conditions))
    .orderBy(desc(crmLeads.createdAt), desc(crmLeads.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function createLead(
  db: DbOrTx,
  user: SessionUser,
  input: { name: string; source?: string; contactName?: string | null; contactPhone?: string | null; ownerId?: string | null },
  ip: string | null,
  sessionId: string | null,
) {
  await requireCrmManage(db, user, input.ownerId ?? user.id); // tree 形态：销售建本人线索（owner 锚点）
  // arch/13 §5.2：新线索不再取 LD 编号（code 可空，历史值保留仅作迁移存量）
  const [row] = await db
    .insert(crmLeads)
    .values({
      name: input.name.trim(),
      source: input.source?.trim() ?? "",
      contactName: input.contactName?.trim() || null,
      contactPhone: input.contactPhone?.trim() || null,
      status: "new",
      ownerId: input.ownerId ?? user.id,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!row) throw new Error("线索插入失败");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.leads.create", targetType: "crm_lead", targetId: row.id, result: "success", afterJson: { name: row.name }, ip });
  return row;
}

export async function updateLead(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; name?: string; source?: string; contactName?: string | null; contactPhone?: string | null; ownerId?: string | null; status?: "new" | "contacted" | "qualified" },
  ip: string | null,
  sessionId: string | null,
) {
  const [before] = await db.select().from(crmLeads).where(eq(crmLeads.id, input.id)).limit(1);
  if (!before) throw notFound();
  await assertRowVisible(db, crmLeads, input.id, leadScopeSql(await resolveCrmScope(db, user)));
  await requireCrmManage(db, user, before.ownerId);
  if (before.status === "converted" || before.status === "disqualified") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "线索已终态，不可修改");
  }
  if (input.status) {
    const order = ["new", "contacted", "qualified"];
    if (order.indexOf(input.status) < order.indexOf(before.status as string)) {
      throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "线索状态不可回退");
    }
  }
  const [updated] = await db
    .update(crmLeads)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.source !== undefined ? { source: input.source.trim() } : {}),
      ...(input.contactName !== undefined ? { contactName: input.contactName?.trim() || null } : {}),
      ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone?.trim() || null } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${crmLeads.rowVersion} + 1`,
    })
    .where(and(eq(crmLeads.id, input.id), eq(crmLeads.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "线索已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.leads.update", targetType: "crm_lead", targetId: input.id, result: "success", beforeJson: { status: before.status }, afterJson: { status: updated.status }, ip });
  return updated;
}

export async function disqualifyLead(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; reason: string },
  ip: string | null,
  sessionId: string | null,
) {
  const [before] = await db.select().from(crmLeads).where(eq(crmLeads.id, input.id)).limit(1);
  if (!before) throw notFound();
  await assertRowVisible(db, crmLeads, input.id, leadScopeSql(await resolveCrmScope(db, user)));
  await requireCrmManage(db, user, before.ownerId);
  if (before.status === "converted" || before.status === "disqualified") {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "线索已终态");
  }
  if (!input.reason.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "作废原因必填", { reason: ["作废原因必填"] });
  const [updated] = await db
    .update(crmLeads)
    .set({ status: "disqualified", disqualifiedReason: input.reason.trim(), updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${crmLeads.rowVersion} + 1` })
    .where(and(eq(crmLeads.id, input.id), eq(crmLeads.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "线索已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.leads.disqualify", targetType: "crm_lead", targetId: input.id, result: "success", afterJson: { reason: input.reason.trim() }, ip });
  return updated;
}

/**
 * 商机成立即立项（arch/13 §5.3 D5，直接创建与线索转化共用）——同一事务：
 * 商机（OPP+幂等键）→ 客户业务事项（MTR）→ 项目（PRJ/售前/preparing，售前项目模板实例化首版计划）
 * → project_members（负责人=manager，销售=member）→ 商机回写 project_id；任一步失败整体回滚。
 * 幂等：同键同载荷重放返回既有商机+项目（不重复取号/立项）；同键异载荷 409；并发撞唯一索引重查返回。
 */
export async function createOpportunityWithProject(
  db: DbOrTx,
  user: SessionUser,
  input: {
    customerId: string;
    name: string;
    expectedAmountCents?: number | null;
    winRate?: number | null;
    presalesId?: string | null;
    projectManagerId: string;
    sourceLeadId?: string | null;
    idempotencyKey: string;
  },
  ip: string | null,
  sessionId: string | null,
): Promise<{ opportunity: typeof crmOpportunities.$inferSelect; project: { id: string; code: string }; replayed: boolean }> {
  // 幂等（D-18-2-3）：事务级 advisory lock 先串行化同键并发——持锁后查重必见已提交行，
  // 从根上杜绝「已中止事务内重查」500；xact 锁随提交/回滚自动释放
  if (input.idempotencyKey) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`);
  }
  // 幂等重放：同键返回既有（异载荷 409）
  if (input.idempotencyKey) {
    const [dup] = await db.select().from(crmOpportunities).where(eq(crmOpportunities.idempotencyKey, input.idempotencyKey)).limit(1);
    if (dup) {
      // D-18-2-2：载荷一致性必须覆盖项目负责人（经关联项目 manager_id 判定）及所有影响立项结果的字段
      const [dupProj] = dup.projectId
        ? await db.select({ managerId: projects.managerId }).from(projects).where(eq(projects.id, dup.projectId)).limit(1)
        : [];
      const same =
        dup.customerId === input.customerId &&
        dup.name === input.name.trim() &&
        (dup.expectedAmountCents ?? null) === (input.expectedAmountCents ?? null) &&
        (dup.winRate ?? null) === (input.winRate ?? null) &&
        (dup.presalesId ?? null) === (input.presalesId ?? null) &&
        (dup.sourceLeadId ?? null) === (input.sourceLeadId ?? null) &&
        (dupProj?.managerId ?? null) === input.projectManagerId;
      if (!same) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "同幂等键已用于不同商机（载荷不一致）");
      const [proj] = dup.projectId
        ? await db.select({ id: projects.id, code: projects.code }).from(projects).where(eq(projects.id, dup.projectId)).limit(1)
        : [];
      return { opportunity: dup, project: proj ?? { id: "", code: "" }, replayed: true };
    }
  }
  // 项目负责人必填且在职（不得隐式默认给销售）
  const [pm] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, input.projectManagerId), eq(users.status, "active")))
    .limit(1);
  if (!pm) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "项目负责人不存在或已停用", { projectManagerId: ["项目负责人不存在或已停用"] });
  if (input.presalesId) {
    const [ps] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, input.presalesId), eq(users.status, "active"))).limit(1);
    if (!ps) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "售前指派人不存在或已停用", { presalesId: ["售前指派人不存在或已停用"] });
  }
  const [template] = await db
    .select()
    .from(projectTemplates)
    .where(and(eq(projectTemplates.name, "售前项目模板"), eq(projectTemplates.enabled, true)))
    .limit(1);
  if (!template) throw new BusinessError(ERROR_CODE.INTERNAL, "售前项目模板缺失（数据地基异常）");

  const today = () => new Date().toISOString().slice(0, 10);
  // ① 事项（MTR）：系统内部关联，不增加用户填报（arch/13 §5.3）
  const matterCode = await nextCode("MTR", db);
  const [matter] = await db
    .insert(matters)
    .values({ code: matterCode, clientId: input.customerId, name: `${input.name.trim()}（售前事项）`, type: "售前", status: "active", createdBy: user.id, updatedBy: user.id })
    .returning({ id: matters.id });
  if (!matter) throw new Error("事项插入失败");

  // ② 项目（PRJ/售前/preparing）+ 首版售前计划（模板实例化，复用 project.create 同一核心防半成品复制）
  const project = await instantiateProjectFromTemplate(db, user.id, {
    matterId: matter.id,
    name: input.name.trim(),
    type: "售前",
    managerId: input.projectManagerId,
    confidentialityLevel: "internal",
    template,
    startDate: today(),
  });
  // 销售负责人落 member（与负责人不同人时；同人只保留 manager）
  if (input.projectManagerId !== user.id) {
    await db
      .insert(projectMembers)
      .values({ projectId: project.id, userId: user.id, projectRole: "member" })
      .onConflictDoNothing();
  }

  // ③ 商机（OPP）回写 project_id（幂等键并发兜底：撞唯一索引 → 重查返回既有）
  const oppCode = await nextCode("OPP", db);
  let opp: typeof crmOpportunities.$inferSelect | undefined;
  try {
    const [created] = await db
      .insert(crmOpportunities)
      .values({
        code: oppCode,
        customerId: input.customerId,
        name: input.name.trim(),
        stage: "initial",
        expectedAmountCents: input.expectedAmountCents ?? null,
        winRate: input.winRate ?? null,
        ownerId: user.id,
        presalesId: input.presalesId ?? null,
        sourceLeadId: input.sourceLeadId ?? null,
        projectId: project.id,
        idempotencyKey: input.idempotencyKey,
        createdBy: user.id,
        updatedBy: user.id,
      })
      .returning();
    opp = created;
  } catch (e) {
    // D-18-2-3：advisory lock 已串行化同键，理论上不可达；万一撞唯一索引语义化 409（事务可能已中止，禁止在内重查）
    if (String(e).includes("crm_opportunities_idempotency_key_unique")) {
      throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "同幂等键正在并发提交，请重试");
    }
    throw e;
  }
  if (!opp) throw new Error("商机插入失败");

  await recordAudit(db, {
    actorId: user.id, sessionId, action: "crm.opportunities.create", targetType: "crm_opportunity", targetId: opp.id, result: "success",
    afterJson: { code: oppCode, projectId: project.id, projectCode: project.code, matterId: matter.id, source: input.sourceLeadId ? "lead_conversion" : "direct" }, ip,
  });
  return { opportunity: opp, project, replayed: false };
}

/** 直接建商机（arch/13 §5.1/§5.3 D5）：必填项目负责人与幂等键；成立即立项（同事务见 createOpportunityWithProject） */
export async function createOpportunity(
  db: DbOrTx,
  user: SessionUser,
  input: {
    customerId: string;
    name: string;
    expectedAmountCents?: number | null;
    winRate?: number | null;
    presalesId?: string | null;
    projectManagerId: string;
    idempotencyKey: string;
  },
  ip: string | null,
  sessionId: string | null,
) {
  const customer = await loadCustomer(db, input.customerId);
  await requireCrmManage(db, user, customer.ownerId);
  const { opportunity, project, replayed } = await createOpportunityWithProject(db, user, input, ip, sessionId);
  const scope = await resolveCrmScope(db, user);
  return {
    ...stripAmounts(opportunity, scopeCanSeeAmounts(scope), ["expectedAmountCents"]),
    projectId: project.id,
    projectCode: project.code,
    replayed,
  };
}

/**
 * 转化事务（arch/12 §6.3 + arch/13 §5.1/§5.3）：两条路径——
 * A. 关联既有商机（opportunityId）：仅回写 source_lead_id 与 converted_*，不新建项目；
 * B. 新建商机：复用 createOpportunityWithProject（D5 同事务立项，projectManagerId 必填）。
 * 幂等：线索已 converted → 直接返回现状（不产生新行）。
 */
export async function convertLead(
  db: DbOrTx,
  user: SessionUser,
  input: {
    id: string;
    rowVersion: number;
    customerId?: string;
    customer?: { name: string; level?: string; industry?: string; address?: string };
    opportunityId?: string;
    projectManagerId?: string;
    opportunity?: { name: string; expectedAmountCents?: number | null; winRate?: number | null; presalesId?: string | null };
    idempotencyKey?: string;
  },
  ip: string | null,
  sessionId: string | null,
) {
  const scope = await resolveCrmScope(db, user);
  const [lead] = await db.select().from(crmLeads).where(eq(crmLeads.id, input.id)).limit(1);
  if (!lead) throw notFound();
  await assertRowVisible(db, crmLeads, input.id, leadScopeSql(scope));
  await requireCrmManage(db, user, lead.ownerId);
  if (lead.status === "disqualified") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已作废线索不可转化");
  if (lead.status === "converted") {
    // 幂等重放：返回现状（客户/商机在首次转化已建）
    return { lead, customerId: lead.convertedCustomerId, opportunityId: lead.convertedOpportunityId, replayed: true as const };
  }

  let customerId: string;
  let opportunityId: string;
  let projectId: string | null = null;

  if (input.opportunityId) {
    // 路径 A：关联既有商机（不新建项目）
    const [opp] = await db.select().from(crmOpportunities).where(eq(crmOpportunities.id, input.opportunityId)).limit(1);
    if (!opp) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "关联商机不存在", { opportunityId: ["关联商机不存在"] });
    // D-18-2-5：目标商机先做记录级范围+管理校验（本人 owner/主管树下级/partner 既定通道；无权同形 404 不暴露存在性）
    await assertRowVisible(db, crmOpportunities, input.opportunityId, opportunityScopeSql(scope));
    await requireCrmManage(db, user, opp.ownerId);
    if (opp.sourceLeadId && opp.sourceLeadId !== input.id) {
      throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "该商机已关联其他来源线索");
    }
    if (opp.stage === "lost") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已关闭商机不可关联线索");
    await db
      .update(crmOpportunities)
      .set({ sourceLeadId: input.id, updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${crmOpportunities.rowVersion} + 1` })
      .where(eq(crmOpportunities.id, opp.id));
    customerId = opp.customerId;
    opportunityId = opp.id;
    projectId = opp.projectId;
  } else {
    // 路径 B：新建商机（D5 立项）
    if (!input.customerId && !input.customer?.name?.trim()) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "转化须指定既有客户或新客户名称", { customer: ["转化须指定既有客户或新客户名称"] });
    }
    if (!input.opportunity?.name?.trim()) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "商机名称必填", { opportunity: ["商机名称必填"] });
    }
    if (!input.projectManagerId) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "转化新建商机须指定项目负责人", { projectManagerId: ["转化新建商机须指定项目负责人"] });
    }
    if (input.customerId) {
      const [existing] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, input.customerId)).limit(1);
      if (!existing) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "客户不存在", { customerId: ["客户不存在"] });
      customerId = existing.id;
    } else {
      const c = input.customer!;
      const code = await nextCode("CLT", db);
      const [created] = await db
        .insert(clients)
        .values({
          code,
          name: c.name.trim(),
          level: c.level?.trim() || "一般客户",
          industry: c.industry?.trim() ?? "",
          address: c.address?.trim() ?? "",
          ownerId: lead.ownerId ?? user.id,
          sourceLeadId: lead.id,
          createdBy: user.id,
          updatedBy: user.id,
        })
        .returning({ id: clients.id });
      if (!created) throw new Error("客户插入失败");
      customerId = created.id;
    }
    // 商机 owner 沿用线索负责人（销售归属不漂移）；立项事务以操作者为 actor
    const { opportunity, project } = await createOpportunityWithProject(
      db,
      user,
      {
        customerId,
        name: input.opportunity.name,
        expectedAmountCents: input.opportunity.expectedAmountCents ?? null,
        winRate: input.opportunity.winRate ?? null,
        projectManagerId: input.projectManagerId,
        presalesId: input.opportunity.presalesId ?? null,
        sourceLeadId: lead.id,
        idempotencyKey: input.idempotencyKey ?? `${input.id}`,
      },
      ip,
      sessionId,
    );
    // owner 为线索负责人时校正（直接创建默认 owner=操作者）
    if ((lead.ownerId ?? user.id) !== user.id) {
      await db.update(crmOpportunities).set({ ownerId: lead.ownerId }).where(eq(crmOpportunities.id, opportunity.id));
      opportunity.ownerId = lead.ownerId;
    }
    opportunityId = opportunity.id;
    projectId = project.id;
  }

  const [updated] = await db
    .update(crmLeads)
    .set({
      status: "converted",
      convertedCustomerId: customerId,
      convertedOpportunityId: opportunityId,
      convertedAt: new Date().toISOString(),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${crmLeads.rowVersion} + 1`,
    })
    .where(and(eq(crmLeads.id, input.id), eq(crmLeads.rowVersion, input.rowVersion), sql`${crmLeads.status} <> 'converted'`))
    .returning();
  if (!updated) {
    // 并发转化已被他请求提交：回滚本事务（客户/商机/项目不残留），返回对方结果形态
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "线索正在被并发转化，请刷新后重试");
  }
  await recordAudit(db, {
    actorId: user.id, sessionId, action: "crm.leads.convert", targetType: "crm_lead", targetId: input.id, result: "success",
    afterJson: { customerId, opportunityId, projectId }, ip,
  });
  return { lead: updated, customerId, opportunityId, projectId, replayed: false as const };
}

/* ===== 客户（clients 吸收） ===== */

export async function listCustomers(
  db: DbOrTx,
  user: SessionUser,
  input: { cursor?: string; limit: number; level?: string; keyword?: string },
) {
  await requireCrmRead(db, user);
  const scope = await resolveCrmScope(db, user);
  const scopeSql = customerScopeSql(scope);
  if (scopeSql === null) throw notFound(); // none：无客户明细权
  const conditions: (SQL | undefined)[] = [scopeSql];
  if (input.level) conditions.push(eq(clients.level, input.level));
  if (input.keyword) {
    const kw = `%${input.keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conditions.push(ilike(clients.name, kw));
  }
  conditions.push(cursorCondition(input.cursor, clients.createdAt, clients.id));
  const rows = await db
    .select({
      id: clients.id,
      code: clients.code,
      name: clients.name,
      level: clients.level,
      industry: clients.industry,
      address: clients.address,
      ownerId: clients.ownerId,
      createdAt: clients.createdAt,
    })
    .from(clients)
    .where(and(...conditions))
    .orderBy(desc(clients.createdAt), desc(clients.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  // 聚合内存合并（drizzle select 字段表达式内相关子查询不渲染表限定——org tree 同源教训，避免再踩）
  let projectCounts = new Map<string, number>();
  let contractSums = new Map<string, number>();
  if (page.length > 0) {
    const ids = page.map((r) => r.id);
    const pRows = await db
      .select({ clientId: matters.clientId, n: sql<number>`count(*)::int` })
      .from(projects)
      .innerJoin(matters, eq(projects.matterId, matters.id))
      .where(sql`${matters.clientId} IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})`)
      .groupBy(matters.clientId);
    projectCounts = new Map(pRows.map((r) => [r.clientId as string, r.n]));
    const cRows = await db
      .select({ customerId: crmContracts.customerId, s: sql<number>`coalesce(sum(${crmContracts.amountCents}), 0)::float8` })
      .from(crmContracts)
      .where(
        and(
          sql`${crmContracts.customerId} IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})`,
          ne(crmContracts.status, "terminated"),
        ),
      )
      .groupBy(crmContracts.customerId);
    contractSums = new Map(cRows.map((r) => [r.customerId, r.s]));
  }
  return {
    items: page.map((r) =>
      stripAmounts(
        { ...r, projectCount: projectCounts.get(r.id) ?? 0, contractSum: contractSums.get(r.id) ?? 0 },
        scopeCanSeeAmounts(scope),
        ["contractSum"],
      ),
    ),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

async function loadCustomer(db: DbOrTx, id: string) {
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  if (!row) throw notFound();
  return row;
}

/** 客户详情六区聚合：概况/联系人/商机/合同（含付款计划+累计回款）/项目/往来文件/跟进时间线 */
export async function getCustomerById(db: DbOrTx, user: SessionUser, id: string) {
  const scope = await resolveCrmScope(db, user);
  const see = scopeCanSeeAmounts(scope);
  await assertRowVisible(db, clients, id, customerScopeSql(scope));
  const customer = await loadCustomer(db, id);
  // 范围内的商机/合同子表同样按范围过滤（finance 仅 active 合同链；project 仅本项目链）
  const oppCond = opportunityScopeSql(scope);
  const ctrCond = contractScopeSql(scope);

  const contacts = await db.select().from(crmContacts).where(eq(crmContacts.customerId, id)).orderBy(asc(crmContacts.isPrimary), asc(crmContacts.name));
  const opportunities = oppCond
    ? await db
        .select()
        .from(crmOpportunities)
        .where(and(eq(crmOpportunities.customerId, id), oppCond))
        .orderBy(desc(crmOpportunities.createdAt))
    : [];
  const contracts = ctrCond
    ? await db
        .select()
        .from(crmContracts)
        .where(and(eq(crmContracts.customerId, id), ctrCond))
        .orderBy(desc(crmContracts.createdAt))
    : [];
  const planRows = contracts.length
    ? await db
        .select({
          plan: crmContractPaymentPlans,
          receiptStatus: paymentReceipts.status,
          receiptAmount: paymentReceipts.amountCents,
        })
        .from(crmContractPaymentPlans)
        .leftJoin(paymentReceipts, eq(paymentReceipts.id, crmContractPaymentPlans.receiptId))
        .where(sql`${crmContractPaymentPlans.contractId} IN (${sql.join(contracts.map((c) => sql`${c.id}`), sql`, `)})`)
        .orderBy(asc(crmContractPaymentPlans.seq))
    : [];
  const plansByContract = new Map<string, typeof planRows>();
  for (const p of planRows) {
    const list = plansByContract.get(p.plan.contractId) ?? [];
    list.push(p);
    plansByContract.set(p.plan.contractId, list);
  }
  const contractItems = contracts.map((c) => {
    const plans = (plansByContract.get(c.id) ?? []).map((p) => ({
      ...p.plan,
      receiptStatus: p.receiptStatus,
    }));
    const cumulativeReceivedCents = plans
      .filter((p) => p.receiptStatus === "registered")
      .reduce((sum, p) => sum + (planRows.find((x) => x.plan.id === p.id)?.receiptAmount ?? 0), 0);
    // O-18-5-3：与 contracts.list/getById 同口径——范围内可见；finance 仅 active 合同放行（外层+计划行）
    const seeContract = see || (scope.kinds.includes("finance") && c.status === "active");
    return stripContractDeep({ ...c, plans, cumulativeReceivedCents }, seeContract, ["amountCents", "cumulativeReceivedCents", "expectedAmountCents"]);
  });
  // 项目子表：按项目范围（project 形态仅本人负责项目；其余形态按客户链全量可见）
  const customerProjects =
    scope.kinds.includes("project")
      ? await db
          .select({ id: projects.id, code: projects.code, name: projects.name, lifecycleStatus: projects.lifecycleStatus })
          .from(projects)
          .innerJoin(matters, eq(projects.matterId, matters.id))
          .where(and(eq(matters.clientId, id), eq(projects.managerId, user.id)))
      : await db
          .select({ id: projects.id, code: projects.code, name: projects.name, lifecycleStatus: projects.lifecycleStatus })
          .from(projects)
          .innerJoin(matters, eq(projects.matterId, matters.id))
          .where(eq(matters.clientId, id));
  const projectIds = customerProjects.map((p) => p.id);
  const files = projectIds.length
    ? await db
        .select({ id: fileObjects.id, sourceId: fileObjects.sourceId, confidentialityLevel: fileObjects.confidentialityLevel, uploadedAt: fileObjects.createdAt })
        .from(fileObjects)
        .where(and(eq(fileObjects.sourceType, "project"), sql`${fileObjects.sourceId} IN (${sql.join(projectIds.map((x) => sql`${x}`), sql`, `)})`))
        .orderBy(desc(fileObjects.createdAt))
        .limit(50)
    : [];
  const followups = await db
    .select()
    .from(crmFollowups)
    .where(and(eq(crmFollowups.targetType, "customer"), eq(crmFollowups.targetId, id)))
    .orderBy(desc(crmFollowups.createdAt))
    .limit(50);

  return {
    customer: stripAmounts(customer, see, []),
    contacts,
    opportunities: opportunities.map((o) => stripAmounts(o, see, ["expectedAmountCents"])),
    contracts: contractItems,
    projects: customerProjects,
    files,
    followups,
  };
}

export async function updateCustomer(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; name?: string; level?: string; industry?: string; address?: string; ownerId?: string | null },
  ip: string | null,
  sessionId: string | null,
) {
  const before = await loadCustomer(db, input.id);
  await requireCrmManage(db, user, before.ownerId);
  const [updated] = await db
    .update(clients)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.level !== undefined ? { level: input.level.trim() } : {}),
      ...(input.industry !== undefined ? { industry: input.industry.trim() } : {}),
      ...(input.address !== undefined ? { address: input.address.trim() } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${clients.rowVersion} + 1`,
    })
    .where(and(eq(clients.id, input.id), eq(clients.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "客户已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.customers.update", targetType: "client", targetId: input.id, result: "success", afterJson: { level: updated.level, ownerId: updated.ownerId }, ip });
  return updated;
}

/* ===== 联系人 ===== */

export async function createContact(
  db: DbOrTx,
  user: SessionUser,
  input: { customerId: string; name: string; title?: string | null; phone?: string | null; email?: string | null; isPrimary?: boolean },
  ip: string | null,
  sessionId: string | null,
) {
  const customer = await loadCustomer(db, input.customerId);
  await requireCrmManage(db, user, customer.ownerId);
  if (input.isPrimary) {
    await db.update(crmContacts).set({ isPrimary: false }).where(eq(crmContacts.customerId, input.customerId));
  }
  const [row] = await db
    .insert(crmContacts)
    .values({
      customerId: input.customerId,
      name: input.name.trim(),
      title: input.title?.trim() || null,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      isPrimary: input.isPrimary ?? false,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!row) throw new Error("联系人插入失败");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.contacts.create", targetType: "crm_contact", targetId: row.id, result: "success", afterJson: { customerId: input.customerId, name: row.name }, ip });
  return row;
}

export async function updateContact(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; name?: string; title?: string | null; phone?: string | null; email?: string | null; isPrimary?: boolean },
  ip: string | null,
  sessionId: string | null,
) {
  const [before] = await db.select().from(crmContacts).where(eq(crmContacts.id, input.id)).limit(1);
  if (!before) throw notFound();
  const customer = await loadCustomer(db, before.customerId);
  await requireCrmManage(db, user, customer.ownerId);
  if (input.isPrimary) {
    await db.update(crmContacts).set({ isPrimary: false }).where(and(eq(crmContacts.customerId, before.customerId), ne(crmContacts.id, input.id)));
  }
  const [updated] = await db
    .update(crmContacts)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.title !== undefined ? { title: input.title?.trim() || null } : {}),
      ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
      ...(input.email !== undefined ? { email: input.email?.trim() || null } : {}),
      ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${crmContacts.rowVersion} + 1`,
    })
    .where(and(eq(crmContacts.id, input.id), eq(crmContacts.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "联系人已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.contacts.update", targetType: "crm_contact", targetId: input.id, result: "success", afterJson: { isPrimary: updated.isPrimary }, ip });
  return updated;
}

export async function deleteContact(db: DbOrTx, user: SessionUser, input: { id: string }, ip: string | null, sessionId: string | null) {
  const [before] = await db.select().from(crmContacts).where(eq(crmContacts.id, input.id)).limit(1);
  if (!before) throw notFound();
  const customer = await loadCustomer(db, before.customerId);
  await requireCrmManage(db, user, customer.ownerId);
  await db.delete(crmContacts).where(eq(crmContacts.id, input.id));
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.contacts.delete", targetType: "crm_contact", targetId: input.id, result: "success", beforeJson: { name: before.name }, ip });
  return { id: input.id, deleted: true as const };
}

/* ===== 商机 ===== */

async function loadOpportunity(db: DbOrTx, id: string) {
  const [row] = await db.select().from(crmOpportunities).where(eq(crmOpportunities.id, id)).limit(1);
  if (!row) throw notFound();
  return row;
}

export async function listOpportunities(
  db: DbOrTx,
  user: SessionUser,
  input: { cursor?: string; limit: number; stage?: string; customerId?: string },
) {
  await requireCrmRead(db, user);
  const scope = await resolveCrmScope(db, user);
  const scopeSql = opportunityScopeSql(scope);
  if (scopeSql === null) throw notFound(); // finance/project/none：无商机明细权
  const conditions: (SQL | undefined)[] = [scopeSql];
  if (input.stage) conditions.push(eq(crmOpportunities.stage, input.stage as never));
  if (input.customerId) conditions.push(eq(crmOpportunities.customerId, input.customerId));
  conditions.push(cursorCondition(input.cursor, crmOpportunities.createdAt, crmOpportunities.id));
  const rows = await db
    .select()
    .from(crmOpportunities)
    .where(and(...conditions))
    .orderBy(desc(crmOpportunities.createdAt), desc(crmOpportunities.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const see = scopeCanSeeAmounts(scope);
  return {
    items: page.map((o) => stripAmounts(o, see, ["expectedAmountCents"])),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/** 商机详情（含关联项目最小标识，供 18-03 商机↔项目互跳；arch/13 §5.4） */
export async function getOpportunityById(db: DbOrTx, user: SessionUser, id: string) {
  const scope = await resolveCrmScope(db, user);
  await assertRowVisible(db, crmOpportunities, id, opportunityScopeSql(scope));
  const row = await loadOpportunity(db, id);
  let project: { id: string; code: string; name: string; lifecycleStatus: string } | null = null;
  if (row.projectId) {
    const [p] = await db
      .select({ id: projects.id, code: projects.code, name: projects.name, lifecycleStatus: projects.lifecycleStatus })
      .from(projects)
      .where(eq(projects.id, row.projectId))
      .limit(1);
    project = p ?? null;
  }
  return { ...stripAmounts(row, scopeCanSeeAmounts(scope), ["expectedAmountCents"]), project };
}

export async function updateOpportunity(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; name?: string; expectedAmountCents?: number | null; winRate?: number | null; ownerId?: string | null; presalesId?: string | null },
  ip: string | null,
  sessionId: string | null,
) {
  const scope = await resolveCrmScope(db, user);
  await assertRowVisible(db, crmOpportunities, input.id, opportunityScopeSql(scope));
  const before = await loadOpportunity(db, input.id);
  await requireCrmManage(db, user, before.ownerId);
  if (before.stage === "won" || before.stage === "lost") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已终态，不可修改");
  if (input.presalesId) {
    const [ps] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, input.presalesId), eq(users.status, "active"))).limit(1);
    if (!ps) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "售前指派人不存在或已停用", { presalesId: ["售前指派人不存在或已停用"] });
  }
  const [updated] = await db
    .update(crmOpportunities)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.expectedAmountCents !== undefined ? { expectedAmountCents: input.expectedAmountCents } : {}),
      ...(input.winRate !== undefined ? { winRate: input.winRate } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.presalesId !== undefined ? { presalesId: input.presalesId } : {}),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${crmOpportunities.rowVersion} + 1`,
    })
    .where(and(eq(crmOpportunities.id, input.id), eq(crmOpportunities.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.opportunities.update", targetType: "crm_opportunity", targetId: input.id, result: "success", afterJson: { name: updated.name, ownerId: updated.ownerId }, ip });
  return stripAmounts(updated, scopeCanSeeAmounts(scope), ["expectedAmountCents"]);
}

/** 看板拖拽改阶段：条件更新+审计（终态不可再拖） */
export async function setOpportunityStage(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; stage: "initial" | "needs" | "proposal" | "negotiation" | "won" | "lost"; rowVersion: number },
  ip: string | null,
  sessionId: string | null,
) {
  const scope = await resolveCrmScope(db, user);
  await assertRowVisible(db, crmOpportunities, input.id, opportunityScopeSql(scope));
  const before = await loadOpportunity(db, input.id);
  await requireCrmManage(db, user, before.ownerId);
  if (before.stage === "won" || before.stage === "lost") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已终态，不可变更阶段");
  if (input.stage === "won") throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "赢单请走 markWon（须挂合同）", { stage: ["赢单请走 markWon"] });
  if (input.stage === "lost") throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "输单请走 markLost（原因必填）", { stage: ["输单请走 markLost"] });
  const [updated] = await db
    .update(crmOpportunities)
    .set({ stage: input.stage, updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${crmOpportunities.rowVersion} + 1` })
    .where(and(eq(crmOpportunities.id, input.id), eq(crmOpportunities.rowVersion, input.rowVersion), ne(crmOpportunities.stage, "won"), ne(crmOpportunities.stage, "lost")))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机阶段已被他人变更，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.opportunities.setStage", targetType: "crm_opportunity", targetId: input.id, result: "success", beforeJson: { stage: before.stage }, afterJson: { stage: updated.stage }, ip });
  return stripAmounts(updated, scopeCanSeeAmounts(scope), ["expectedAmountCents"]);
}

/** 赢单事务（arch/12 §6.3 + arch/13 §5.4）：won 必挂合同——同事务建合同（draft→active 可选）+商机 won 写回 won_contract_id；
 * activate=true 时同事务把关联项目 preparing→in_progress（同一项目转交付，不新建项目），合同 matter_id 空则回填项目事项。
 * 重放安全：已 won → 返回现状。 */
export async function markOpportunityWon(
  db: DbOrTx,
  user: SessionUser,
  input: {
    id: string;
    rowVersion: number;
    contract: { title: string; amountCents: number; matterId?: string | null; signedAt?: string | null; activate?: boolean };
  },
  ip: string | null,
  sessionId: string | null,
) {
  const scope = await resolveCrmScope(db, user);
  await assertRowVisible(db, crmOpportunities, input.id, opportunityScopeSql(scope));
  const before = await loadOpportunity(db, input.id);
  await requireCrmManage(db, user, before.ownerId);
  if (before.stage === "lost") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已输单商机不可赢单");
  if (before.stage === "won") {
    const [contract] = before.wonContractId
      ? await db.select().from(crmContracts).where(eq(crmContracts.id, before.wonContractId)).limit(1)
      : [];
    return { opportunity: before, contract: contract ?? null, replayed: true as const };
  }
  if (!input.contract.title.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "合同标题必填", { "contract.title": ["合同标题必填"] });
  if (input.contract.amountCents <= 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "合同金额须为正整数（分）", { "contract.amountCents": ["合同金额须为正整数（分）"] });

  // 合同 matter：显式传入优先；否则回填商机关联项目事项（arch/13 §5.3）
  let matterId = input.contract.matterId ?? null;
  if (!matterId && before.projectId) {
    const [proj] = await db.select({ matterId: projects.matterId }).from(projects).where(eq(projects.id, before.projectId)).limit(1);
    matterId = proj?.matterId ?? null;
  }

  const code = await nextCode("CTR", db);
  const [contract] = await db
    .insert(crmContracts)
    .values({
      code,
      opportunityId: before.id,
      customerId: before.customerId,
      matterId,
      title: input.contract.title.trim(),
      amountCents: input.contract.amountCents,
      signedAt: input.contract.signedAt ?? (input.contract.activate ? new Date().toISOString() : null),
      status: input.contract.activate ? "active" : "draft",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!contract) throw new Error("合同插入失败");

  const [updated] = await db
    .update(crmOpportunities)
    .set({ stage: "won", wonContractId: contract.id, updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${crmOpportunities.rowVersion} + 1` })
    .where(and(eq(crmOpportunities.id, input.id), eq(crmOpportunities.rowVersion, input.rowVersion), ne(crmOpportunities.stage, "won")))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机正在被并发赢单，请刷新后重试");

  // 合同激活=交付开始：同一项目 preparing→in_progress（保留售前计划与记录，arch/13 §5.4）
  if (input.contract.activate && before.projectId) {
    await db
      .update(projects)
      .set({ lifecycleStatus: "in_progress", updatedBy: user.id, updatedAt: new Date().toISOString() })
      .where(and(eq(projects.id, before.projectId), eq(projects.lifecycleStatus, "preparing")));
  }
  await recordAudit(db, {
    actorId: user.id, sessionId, action: "crm.opportunities.markWon", targetType: "crm_opportunity", targetId: input.id, result: "success",
    afterJson: { contractId: contract.id, contractCode: contract.code, contractStatus: contract.status, projectTransitioned: Boolean(input.contract.activate && before.projectId) }, ip,
  });
  return { opportunity: updated, contract, replayed: false as const };
}

/** 输单事务（arch/13 §5.4）：原因/时间落库（closedReason/closedAt）；同事务唯一关联项目转 closed 保留历史；终态后阻断新增。 */
export async function markOpportunityLost(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; reason: string },
  ip: string | null,
  sessionId: string | null,
) {
  const scope = await resolveCrmScope(db, user);
  await assertRowVisible(db, crmOpportunities, input.id, opportunityScopeSql(scope));
  const before = await loadOpportunity(db, input.id);
  await requireCrmManage(db, user, before.ownerId);
  if (before.stage === "won" || before.stage === "lost") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已终态");
  if (!input.reason.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "输单原因必填", { reason: ["输单原因必填"] });
  const [updated] = await db
    .update(crmOpportunities)
    .set({
      stage: "lost",
      closedReason: input.reason.trim(),
      closedAt: new Date().toISOString(),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${crmOpportunities.rowVersion} + 1`,
    })
    .where(and(eq(crmOpportunities.id, input.id), eq(crmOpportunities.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已被他人修改，请刷新后重试");
  // 同事务关闭唯一关联项目（既有记录只读保留；新增费用由项目 closed 阻断）
  if (before.projectId) {
    await db
      .update(projects)
      .set({ lifecycleStatus: "closed", updatedBy: user.id, updatedAt: new Date().toISOString() })
      .where(and(eq(projects.id, before.projectId), sql`${projects.lifecycleStatus} <> 'closed'`));
  }
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.opportunities.markLost", targetType: "crm_opportunity", targetId: input.id, result: "success", afterJson: { reason: input.reason.trim(), projectId: before.projectId }, ip });
  return updated;
}

/* ===== 合同与付款计划 ===== */

async function loadContract(db: DbOrTx, id: string) {
  const [row] = await db.select().from(crmContracts).where(eq(crmContracts.id, id)).limit(1);
  if (!row) throw notFound();
  return row;
}

async function contractWithCumulative(db: DbOrTx, contract: typeof crmContracts.$inferSelect) {
  const plans = await db
    .select({ plan: crmContractPaymentPlans, receiptStatus: paymentReceipts.status, receiptAmount: paymentReceipts.amountCents })
    .from(crmContractPaymentPlans)
    .leftJoin(paymentReceipts, eq(paymentReceipts.id, crmContractPaymentPlans.receiptId))
    .where(eq(crmContractPaymentPlans.contractId, contract.id))
    .orderBy(asc(crmContractPaymentPlans.seq));
  const cumulativeReceivedCents = plans
    .filter((p) => p.receiptStatus === "registered")
    .reduce((sum, p) => sum + (p.receiptAmount ?? 0), 0);
  return { ...contract, plans: plans.map((p) => ({ ...p.plan, receiptStatus: p.receiptStatus })), cumulativeReceivedCents };
}

export async function listContracts(db: DbOrTx, user: SessionUser, input: { cursor?: string; limit: number; status?: string; customerId?: string }) {
  await requireCrmRead(db, user);
  const scope = await resolveCrmScope(db, user);
  const scopeSql = contractScopeSql(scope);
  if (scopeSql === null) throw notFound(); // tree/none 等无合同明细权（tree 经商机链可见）
  const conditions: (SQL | undefined)[] = [scopeSql];
  if (input.status) conditions.push(eq(crmContracts.status, input.status as never));
  if (input.customerId) conditions.push(eq(crmContracts.customerId, input.customerId));
  conditions.push(cursorCondition(input.cursor, crmContracts.createdAt, crmContracts.id));
  const rows = await db
    .select()
    .from(crmContracts)
    .where(and(...conditions))
    .orderBy(desc(crmContracts.createdAt), desc(crmContracts.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const items = [];
  for (const c of page) {
    const withCum = await contractWithCumulative(db, c);
    // finance 按 D4 记录级放行：active 合同链可见明细金额，其余剥离
    const see = scopeCanSeeAmounts(scope) || (scope.kinds.includes("finance") && c.status === "active");
    items.push(stripContractDeep(withCum, see, ["amountCents", "cumulativeReceivedCents"]));
  }
  return {
    items,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function getContractById(db: DbOrTx, user: SessionUser, id: string) {
  await requireCrmRead(db, user);
  const scope = await resolveCrmScope(db, user);
  await assertRowVisible(db, crmContracts, id, contractScopeSql(scope));
  const contract = await loadContract(db, id);
  const see = scopeCanSeeAmounts(scope) || (scope.kinds.includes("finance") && contract.status === "active");
  return stripContractDeep(await contractWithCumulative(db, contract), see, ["amountCents", "cumulativeReceivedCents"]);
}

export async function updateContract(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; title?: string; amountCents?: number; matterId?: string | null; signedAt?: string | null },
  ip: string | null,
  sessionId: string | null,
) {
  const before = await loadContract(db, input.id);
  const customer = await loadCustomer(db, before.customerId);
  await requireCrmManage(db, user, customer.ownerId);
  if (before.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿合同可编辑（激活后更正走终止重签）");
  const [opp] = before.opportunityId
    ? await db.select({ stage: crmOpportunities.stage }).from(crmOpportunities).where(eq(crmOpportunities.id, before.opportunityId)).limit(1)
    : [];
  if (opp?.stage === "lost") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已关闭，合同不可修改");
  const [updated] = await db
    .update(crmContracts)
    .set({
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
      ...(input.matterId !== undefined ? { matterId: input.matterId } : {}),
      ...(input.signedAt !== undefined ? { signedAt: input.signedAt } : {}),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${crmContracts.rowVersion} + 1`,
    })
    .where(and(eq(crmContracts.id, input.id), eq(crmContracts.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "合同已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.contracts.update", targetType: "crm_contract", targetId: input.id, result: "success", afterJson: { title: updated.title }, ip });
  return updated;
}

export async function activateContract(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number; signedAt?: string | null }, ip: string | null, sessionId: string | null) {
  const before = await loadContract(db, input.id);
  const customer = await loadCustomer(db, before.customerId);
  await requireCrmManage(db, user, customer.ownerId);
  if (before.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿合同可激活");
  // arch/13 §5.4：商机关闭后合同激活被阻断
  const [opp] = before.opportunityId
    ? await db.select().from(crmOpportunities).where(eq(crmOpportunities.id, before.opportunityId)).limit(1)
    : [];
  if (opp?.stage === "lost") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已关闭，合同不可激活");
  // 合同 matter 回填：空则用商机关联项目事项（arch/13 §5.3）
  let matterId = before.matterId;
  if (!matterId && opp?.projectId) {
    const [proj] = await db.select({ matterId: projects.matterId }).from(projects).where(eq(projects.id, opp.projectId)).limit(1);
    matterId = proj?.matterId ?? null;
  }
  const [updated] = await db
    .update(crmContracts)
    .set({ status: "active", matterId, signedAt: input.signedAt ?? new Date().toISOString(), updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${crmContracts.rowVersion} + 1` })
    .where(and(eq(crmContracts.id, input.id), eq(crmContracts.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "合同已被他人修改，请刷新后重试");
  // 合同激活=财务明细分界+交付开始：关联项目 preparing→in_progress（幂等：仅 preparing 转；重复激活被上方 409 拦截，不重复审计成功）
  if (opp?.projectId) {
    await db
      .update(projects)
      .set({ lifecycleStatus: "in_progress", updatedBy: user.id, updatedAt: new Date().toISOString() })
      .where(and(eq(projects.id, opp.projectId), eq(projects.lifecycleStatus, "preparing")));
  }
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.contracts.activate", targetType: "crm_contract", targetId: input.id, result: "success", afterJson: { signedAt: updated.signedAt, projectId: opp?.projectId ?? null }, ip });
  return updated;
}

export async function terminateContract(db: DbOrTx, user: SessionUser, input: { id: string; rowVersion: number; reason: string }, ip: string | null, sessionId: string | null) {
  const before = await loadContract(db, input.id);
  const customer = await loadCustomer(db, before.customerId);
  await requireCrmManage(db, user, customer.ownerId);
  if (before.status !== "active") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅生效中合同可终止");
  if (!input.reason.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "终止原因必填", { reason: ["终止原因必填"] });
  const [updated] = await db
    .update(crmContracts)
    .set({ status: "terminated", updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${crmContracts.rowVersion} + 1` })
    .where(and(eq(crmContracts.id, input.id), eq(crmContracts.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "合同已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.contracts.terminate", targetType: "crm_contract", targetId: input.id, result: "success", afterJson: { reason: input.reason.trim() }, ip });
  return updated;
}

/** 付款计划行整体 upsert（同事务）：仅 unpaid 行可替换；已回款行存在 → 409 */
export async function upsertPaymentPlans(
  db: DbOrTx,
  user: SessionUser,
  input: { contractId: string; rows: Array<{ seq: number; dueDate: string; amountCents: number }> },
  ip: string | null,
  sessionId: string | null,
) {
  const contract = await loadContract(db, input.contractId);
  const customer = await loadCustomer(db, contract.customerId);
  await requireCrmManage(db, user, customer.ownerId);
  if (contract.status === "terminated") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已终止合同不可改付款计划");
  const [opp] = contract.opportunityId
    ? await db.select({ stage: crmOpportunities.stage }).from(crmOpportunities).where(eq(crmOpportunities.id, contract.opportunityId)).limit(1)
    : [];
  if (opp?.stage === "lost") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已关闭，付款计划不可修改");
  if (input.rows.length === 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "至少一行付款计划", { rows: ["至少一行付款计划"] });
  const seqs = input.rows.map((r) => r.seq);
  if (new Set(seqs).size !== seqs.length) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "计划行 seq 不可重复", { rows: ["seq 不可重复"] });

  const existing = await db.select().from(crmContractPaymentPlans).where(eq(crmContractPaymentPlans.contractId, input.contractId));
  if (existing.some((r) => r.status !== "unpaid")) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "存在已回款计划行，不可整体替换");
  }
  await db.delete(crmContractPaymentPlans).where(eq(crmContractPaymentPlans.contractId, input.contractId));
  const inserted = [];
  for (const row of input.rows) {
    if (row.amountCents <= 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "计划金额须为正整数（分）", { rows: ["金额须为正整数（分）"] });
    const [r] = await db
      .insert(crmContractPaymentPlans)
      .values({ contractId: input.contractId, seq: row.seq, dueDate: row.dueDate, amountCents: row.amountCents })
      .returning();
    if (!r) throw new Error("计划行插入失败");
    inserted.push(r);
  }
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.paymentPlans.upsert", targetType: "crm_contract", targetId: input.contractId, result: "success", afterJson: { rows: inserted.length }, ip });
  return { contractId: input.contractId, rows: inserted };
}

/* ===== 回款勾稽（由 receipts 模块同事务调用） ===== */

/** receipts.create 挂计划行：状态写回（unpaid/partial/paid）+ receipt_id 挂点（同事务，事务由调用方承载） */
export async function linkReceiptToPlan(
  db: DbOrTx,
  user: SessionUser,
  input: { receiptId: string; planId: string; contractId?: string; receiptAmountCents: number },
  ip: string | null,
  sessionId: string | null,
): Promise<void> {
  const [plan] = await db.select().from(crmContractPaymentPlans).where(eq(crmContractPaymentPlans.id, input.planId)).limit(1);
  if (!plan) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "付款计划行不存在", { planId: ["付款计划行不存在"] });
  if (input.contractId && plan.contractId !== input.contractId) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "计划行不属于指定合同", { contractId: ["计划行不属于指定合同"] });
  }
  if (plan.receiptId) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "该计划行已挂回款（更正请先作废原收款）");
  const status = input.receiptAmountCents >= plan.amountCents ? "paid" : "partial";
  await db
    .update(crmContractPaymentPlans)
    .set({ receiptId: input.receiptId, status, updatedBy: user.id, updatedAt: new Date().toISOString() })
    .where(eq(crmContractPaymentPlans.id, input.planId));
  await recordAudit(db, {
    actorId: user.id, sessionId, action: "crm.receipt.planLink", targetType: "crm_contract", targetId: plan.contractId, result: "success",
    afterJson: { planId: input.planId, receiptId: input.receiptId, planStatus: status }, ip,
  });
  // arch/12 §7 回款勾稽应收：与计划行写回同一事务链重算应收 open/partial/settled
  const { recomputeReceivableForPlan } = await import("../fin/fin");
  await recomputeReceivableForPlan(db, input.planId);
}

/** receipts.void 回写：清 receipt_id + 状态复位 unpaid（作废冲正沿用既有 receipts 语义） */
export async function unlinkReceiptFromPlan(
  db: DbOrTx,
  input: { receiptId: string },
  ip: string | null,
  sessionId: string | null,
): Promise<void> {
  const [plan] = await db.select().from(crmContractPaymentPlans).where(eq(crmContractPaymentPlans.receiptId, input.receiptId)).limit(1);
  if (!plan) return;
  await db
    .update(crmContractPaymentPlans)
    .set({ receiptId: null, status: "unpaid", updatedBy: null, updatedAt: new Date().toISOString() })
    .where(eq(crmContractPaymentPlans.id, plan.id));
  await recordAudit(db, {
    actorId: null, sessionId, action: "crm.receipt.planUnlink", targetType: "crm_contract", targetId: plan.contractId, result: "success",
    afterJson: { planId: plan.id, receiptId: input.receiptId }, ip,
  });
  const { recomputeReceivableForPlan } = await import("../fin/fin");
  await recomputeReceivableForPlan(db, plan.id);
}

/* ===== 跟进（多态） ===== */

async function assertFollowupTargetExists(db: DbOrTx, targetType: string, targetId: string): Promise<void> {
  let exists = false;
  if (targetType === "lead") {
    const [r] = await db.select({ id: crmLeads.id }).from(crmLeads).where(eq(crmLeads.id, targetId)).limit(1);
    exists = !!r;
  } else if (targetType === "opportunity") {
    const [r] = await db.select({ id: crmOpportunities.id }).from(crmOpportunities).where(eq(crmOpportunities.id, targetId)).limit(1);
    exists = !!r;
  } else if (targetType === "customer") {
    const [r] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, targetId)).limit(1);
    exists = !!r;
  }
  if (!exists) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "跟进目标不存在", { targetId: ["跟进目标不存在（lead/opportunity/customer）"] });
  }
}

/** 跟进目标归属用户（范围/管理判定的 owner 锚点） */
async function followupTargetOwner(db: DbOrTx, targetType: string, targetId: string): Promise<string | null> {
  if (targetType === "lead") {
    const [r] = await db.select({ ownerId: crmLeads.ownerId }).from(crmLeads).where(eq(crmLeads.id, targetId)).limit(1);
    return r?.ownerId ?? null;
  }
  if (targetType === "opportunity") {
    const [r] = await db.select({ ownerId: crmOpportunities.ownerId }).from(crmOpportunities).where(eq(crmOpportunities.id, targetId)).limit(1);
    return r?.ownerId ?? null;
  }
  const [r] = await db.select({ ownerId: clients.ownerId }).from(clients).where(eq(clients.id, targetId)).limit(1);
  return r?.ownerId ?? null;
}

/** 跟进目标可见性（按目标域范围解析） */
async function assertFollowupTargetVisible(db: DbOrTx, user: SessionUser, targetType: string, targetId: string): Promise<void> {
  const scope = await resolveCrmScope(db, user);
  const cond =
    targetType === "lead"
      ? leadScopeSql(scope)
      : targetType === "opportunity"
        ? opportunityScopeSql(scope)
        : customerScopeSql(scope);
  const table = targetType === "lead" ? crmLeads : targetType === "opportunity" ? crmOpportunities : clients;
  await assertRowVisible(db, table, targetId, cond);
}

export async function createFollowup(
  db: DbOrTx,
  user: SessionUser,
  input: { targetType: "lead" | "opportunity" | "customer"; targetId: string; content: string; nextAt?: string | null },
  ip: string | null,
  sessionId: string | null,
) {
  await assertFollowupTargetExists(db, input.targetType, input.targetId); // 不存在=400（多态校验形状不破）
  await assertFollowupTargetVisible(db, user, input.targetType, input.targetId); // 越权=同形 404
  // 销售/主管在管辖范围内可跟进（owner 锚点）；partner 全局 manage 由粗门放行
  const ownerId = await followupTargetOwner(db, input.targetType, input.targetId);
  await requireCrmManage(db, user, ownerId);
  if (!input.content.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "跟进内容必填", { content: ["跟进内容必填"] });
  const [row] = await db
    .insert(crmFollowups)
    .values({
      targetType: input.targetType,
      targetId: input.targetId,
      content: input.content.trim(),
      nextAt: input.nextAt ?? null,
      createdBy: user.id,
    })
    .returning();
  if (!row) throw new Error("跟进插入失败");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.followups.create", targetType: `crm_${input.targetType}`, targetId: input.targetId, result: "success", afterJson: { content: row.content.slice(0, 50) }, ip });
  return row;
}

export async function listFollowups(
  db: DbOrTx,
  user: SessionUser,
  input: { targetType: "lead" | "opportunity" | "customer"; targetId: string; limit: number },
) {
  await requireCrmRead(db, user);
  await assertFollowupTargetExists(db, input.targetType, input.targetId);
  await assertFollowupTargetVisible(db, user, input.targetType, input.targetId);
  return db
    .select()
    .from(crmFollowups)
    .where(and(eq(crmFollowups.targetType, input.targetType), eq(crmFollowups.targetId, input.targetId)))
    .orderBy(desc(crmFollowups.createdAt))
    .limit(Math.min(input.limit, 100));
}

/* ===== 存量项目售前计划兜底（arch/13 §5.3：18-01 迁移项目可能无售前计划） ===== */

/**
 * 幂等补建关联项目售前模板计划：已有 v1 计划直接返回现状（query 无副作用；写仅经本 mutation）。
 * 门：partner / operations / sysadmin / 关联项目负责人。
 */
export async function ensureOpportunityProjectPlan(
  db: DbOrTx,
  user: SessionUser,
  input: { opportunityId: string },
  ip: string | null,
  sessionId: string | null,
) {
  const [opp] = await db.select().from(crmOpportunities).where(eq(crmOpportunities.id, input.opportunityId)).limit(1);
  if (!opp) throw notFound();
  const allowed =
    user.globalRoles.includes("partner") ||
    user.globalRoles.includes("operations") ||
    user.globalRoles.includes("sysadmin") ||
    (opp.projectId !== null && user.projectRoles.get(opp.projectId) === "manager");
  if (!allowed) throw notFound();
  if (!opp.projectId) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "商机未关联项目，无法补建计划", { opportunityId: ["商机未关联项目"] });
  }
  const [existing] = await db
    .select({ id: planVersions.id })
    .from(planVersions)
    .where(and(eq(planVersions.projectId, opp.projectId), eq(planVersions.versionNo, 1)))
    .limit(1);
  if (existing) return { created: false as const, planVersionId: existing.id, projectId: opp.projectId };
  const [template] = await db
    .select()
    .from(projectTemplates)
    .where(and(eq(projectTemplates.name, "售前项目模板"), eq(projectTemplates.enabled, true)))
    .limit(1);
  if (!template) throw new BusinessError(ERROR_CODE.INTERNAL, "售前项目模板缺失（数据地基异常）");
  const today = new Date().toISOString().slice(0, 10);
  const { planVersionId } = await instantiateTemplatePlan(db, user.id, opp.projectId, template, today, "存量项目售前计划补建（ensureProjectPlan）");
  await recordAudit(db, {
    actorId: user.id, sessionId, action: "crm.opportunities.ensureProjectPlan", targetType: "crm_opportunity", targetId: input.opportunityId,
    result: "success", afterJson: { projectId: opp.projectId, planVersionId }, ip,
  });
  return { created: true as const, planVersionId, projectId: opp.projectId };
}

/* ===== crm.summary 只读聚合（arch/13 §4.1.3：计数与金额汇总，不含名称/uuid 清单/联系人/跟进内容） ===== */

/**
 * 供合同前财务与交付后端等看整体数据：tree/presales 形态按范围聚合（销售=本人口径）；
 * none/finance/project 形态给全公司整体聚合（§4：交付角色整体数量金额；finance 合同前整体汇总）。
 * 任何登录用户可调用（只含聚合，无明细泄露）。
 */
export async function crmSummary(db: DbOrTx, user: SessionUser) {
  const scope = await resolveCrmScope(db, user);
  const scoped =
    (scope.kinds.includes("tree") || scope.kinds.includes("presales")) && !scope.kinds.includes("global");
  const leadCond = scoped ? leadScopeSql(scope) : sql`true`;
  const oppCond = scoped ? opportunityScopeSql(scope) : sql`true`;
  const ctrCond = scoped ? contractScopeSql(scope) : sql`true`;

  const leadRows = leadCond
    ? await db
        .select({ status: crmLeads.status, n: sql<number>`count(*)::int` })
        .from(crmLeads)
        .where(leadCond)
        .groupBy(crmLeads.status)
    : [];
  const oppRows = oppCond
    ? await db
        .select({
          stage: crmOpportunities.stage,
          n: sql<number>`count(*)::int`,
          amount: sql<number>`coalesce(sum(${crmOpportunities.expectedAmountCents}), 0)::float8`,
        })
        .from(crmOpportunities)
        .where(oppCond)
        .groupBy(crmOpportunities.stage)
    : [];
  const ctrRows = ctrCond
    ? await db
        .select({
          status: crmContracts.status,
          n: sql<number>`count(*)::int`,
          amount: sql<number>`coalesce(sum(${crmContracts.amountCents}), 0)::float8`,
        })
        .from(crmContracts)
        .where(ctrCond)
        .groupBy(crmContracts.status)
    : [];
  const [recv] = await db
    .select({ n: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(amount_cents), 0)::float8` })
    .from(sql`fin_receivables`)
    .where(sql`status <> 'settled'`);

  const byStatus = (rows: Array<{ status: string; n: number }>) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const byStage = (rows: typeof oppRows) => Object.fromEntries(rows.map((r) => [r.stage, r.n]));
  const oppBy = byStage(oppRows);
  const ctrBy = byStatus(ctrRows);
  return {
    leads: {
      total: leadRows.reduce((s, r) => s + r.n, 0),
      ...byStatus(leadRows),
    },
    opportunities: {
      total: oppRows.reduce((s, r) => s + r.n, 0),
      ...oppBy,
      expectedAmountCents: oppRows.reduce((s, r) => s + r.amount, 0),
      wonAmountCents: oppRows.filter((r) => r.stage === "won").reduce((s, r) => s + r.amount, 0),
    },
    contracts: {
      total: ctrRows.reduce((s, r) => s + r.n, 0),
      ...ctrBy,
      amountCents: ctrRows.reduce((s, r) => s + r.amount, 0),
      activeAmountCents: ctrRows.filter((r) => r.status === "active").reduce((s, r) => s + r.amount, 0),
    },
    receivables: { open: recv?.n ?? 0, openAmountCents: recv?.amount ?? 0 },
  };
}
