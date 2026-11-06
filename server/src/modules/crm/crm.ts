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
  projects,
} from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { recordAudit } from "../../services/audit";
import { can } from "../../services/access";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor } from "../governance/util";

/**
 * CRM 域（arch/12 §6/§11）：线索→客户+商机→合同→回款勾稽。
 * 权限：crm.read=partner 全局只读穿透/finance/项目负责人(project_manager 全局角色)/owner 本人（详情）/有效授权沿用；
 * crm.manage=partner/owner/项目负责人；member 默认同形 404；金额列对无 fin.read 者剔除（R1 沿用）。
 * 关键事务：转化（建/选客户+建商机+线索 converted 写回）、赢单（won 必挂合同）、回款勾稽（计划行状态+累计，作废回写）。
 */

function notFound(): BusinessError {
  return new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "CRM 记录不存在或无权访问");
}

/* ===== 权限 ===== */

export function canReadCrm(user: SessionUser): boolean {
  return (
    user.globalRoles.includes("partner") ||
    user.globalRoles.includes("finance") ||
    user.globalRoles.includes("project_manager")
  );
}

/** 记录级读：全局读角色 ∪ owner 本人（详情/跟进读放行） */
function canReadRecord(user: SessionUser, ownerId: string | null): boolean {
  return canReadCrm(user) || (ownerId !== null && ownerId === user.id);
}

export function canManageCrm(user: SessionUser, ownerId: string | null = null): boolean {
  if (user.globalRoles.includes("partner")) return true;
  if (user.globalRoles.includes("project_manager")) return true;
  return ownerId !== null && ownerId === user.id;
}

/** fin.read 口径（金额列可见）：finance/partner/项目负责人（R1 裁定沿用） */
export function canSeeCrmAmounts(user: SessionUser): boolean {
  return (
    user.globalRoles.includes("finance") ||
    user.globalRoles.includes("partner") ||
    user.globalRoles.includes("project_manager")
  );
}

export async function requireCrmRead(db: DbOrTx, user: SessionUser): Promise<void> {
  const allowed = await can(db, user, "crm.read", { type: "project", projectId: "" });
  if (!allowed) throw notFound();
}

export async function requireCrmManage(db: DbOrTx, user: SessionUser, ownerId: string | null = null): Promise<void> {
  const allowed = await can(db, user, "crm.manage", { type: "project", projectId: "" });
  if (!allowed && !(ownerId !== null && ownerId === user.id)) throw notFound();
}

function stripAmounts<T extends Record<string, unknown>>(row: T, user: SessionUser, keys: string[]): T {
  if (canSeeCrmAmounts(user)) return row;
  const copy = { ...row };
  for (const k of keys) delete copy[k];
  return copy;
}

/* ===== 线索 ===== */

export async function listLeads(
  db: DbOrTx,
  user: SessionUser,
  input: { cursor?: string; limit: number; status?: string; keyword?: string },
) {
  await requireCrmRead(db, user);
  const conditions: (SQL | undefined)[] = [];
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
  await requireCrmManage(db, user);
  const code = await nextCode("LD", db);
  const [row] = await db
    .insert(crmLeads)
    .values({
      code,
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
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.leads.create", targetType: "crm_lead", targetId: row.id, result: "success", afterJson: { code, name: row.name }, ip });
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
  if (!before || !canReadRecord(user, before.ownerId)) throw notFound();
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
  if (!before || !canReadRecord(user, before.ownerId)) throw notFound();
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
 * 转化事务（arch/12 §6.3）：事务内 建/选客户 + 建商机 + 线索置 converted 写回两 id；幂等重放。
 * 幂等语义：线索已 converted → 直接返回现状（200，不产生新行）；并发靠条件更新（仅非终态可转化）串行化。
 */
export async function convertLead(
  db: DbOrTx,
  user: SessionUser,
  input: {
    id: string;
    rowVersion: number;
    customerId?: string;
    customer?: { name: string; level?: string; industry?: string; address?: string };
    opportunity: { name: string; expectedAmountCents?: number | null; winRate?: number | null };
  },
  ip: string | null,
  sessionId: string | null,
) {
  const [lead] = await db.select().from(crmLeads).where(eq(crmLeads.id, input.id)).limit(1);
  if (!lead || !canReadRecord(user, lead.ownerId)) throw notFound();
  await requireCrmManage(db, user, lead.ownerId);
  if (lead.status === "disqualified") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已作废线索不可转化");
  if (lead.status === "converted") {
    // 幂等重放：返回现状（客户/商机在首次转化已建）
    return { lead, customerId: lead.convertedCustomerId, opportunityId: lead.convertedOpportunityId, replayed: true as const };
  }
  if (!input.customerId && !input.customer?.name?.trim()) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "转化须指定既有客户或新客户名称", { customer: ["转化须指定既有客户或新客户名称"] });
  }

  let customerId: string;
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
        ownerId: user.id,
        sourceLeadId: lead.id,
        createdBy: user.id,
        updatedBy: user.id,
      })
      .returning({ id: clients.id });
    if (!created) throw new Error("客户插入失败");
    customerId = created.id;
  }

  const oppCode = await nextCode("OPP", db);
  const [opp] = await db
    .insert(crmOpportunities)
    .values({
      code: oppCode,
      customerId,
      name: input.opportunity.name.trim(),
      stage: "initial",
      expectedAmountCents: input.opportunity.expectedAmountCents ?? null,
      winRate: input.opportunity.winRate ?? null,
      ownerId: lead.ownerId ?? user.id,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: crmOpportunities.id });
  if (!opp) throw new Error("商机插入失败");

  const [updated] = await db
    .update(crmLeads)
    .set({
      status: "converted",
      convertedCustomerId: customerId,
      convertedOpportunityId: opp.id,
      convertedAt: new Date().toISOString(),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${crmLeads.rowVersion} + 1`,
    })
    .where(and(eq(crmLeads.id, input.id), eq(crmLeads.rowVersion, input.rowVersion), sql`${crmLeads.status} <> 'converted'`))
    .returning();
  if (!updated) {
    // 并发转化已被他请求提交：回滚本事务（客户/商机不残留），返回对方结果形态
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "线索正在被并发转化，请刷新后重试");
  }
  await recordAudit(db, {
    actorId: user.id, sessionId, action: "crm.leads.convert", targetType: "crm_lead", targetId: input.id, result: "success",
    afterJson: { customerId, opportunityId: opp.id }, ip,
  });
  return { lead: updated, customerId, opportunityId: opp.id, replayed: false as const };
}

/* ===== 客户（clients 吸收） ===== */

export async function listCustomers(
  db: DbOrTx,
  user: SessionUser,
  input: { cursor?: string; limit: number; level?: string; keyword?: string },
) {
  await requireCrmRead(db, user);
  const conditions: (SQL | undefined)[] = [];
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
        user,
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
  const customer = await loadCustomer(db, id);
  if (!canReadRecord(user, customer.ownerId)) throw notFound();

  const contacts = await db.select().from(crmContacts).where(eq(crmContacts.customerId, id)).orderBy(asc(crmContacts.isPrimary), asc(crmContacts.name));
  const opportunities = await db
    .select()
    .from(crmOpportunities)
    .where(eq(crmOpportunities.customerId, id))
    .orderBy(desc(crmOpportunities.createdAt));
  const contracts = await db
    .select()
    .from(crmContracts)
    .where(eq(crmContracts.customerId, id))
    .orderBy(desc(crmContracts.createdAt));
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
    return stripAmounts({ ...c, plans, cumulativeReceivedCents }, user, ["amountCents", "cumulativeReceivedCents", "expectedAmountCents"]);
  });
  const customerProjects = await db
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
    customer: stripAmounts(customer, user, []),
    contacts,
    opportunities: opportunities.map((o) => stripAmounts(o, user, ["expectedAmountCents"])),
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
  const conditions: (SQL | undefined)[] = [];
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
  return {
    items: page.map((o) => stripAmounts(o, user, ["expectedAmountCents"])),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function createOpportunity(
  db: DbOrTx,
  user: SessionUser,
  input: { customerId: string; name: string; expectedAmountCents?: number | null; winRate?: number | null; stage?: "initial" | "needs" | "proposal" | "negotiation" },
  ip: string | null,
  sessionId: string | null,
) {
  const customer = await loadCustomer(db, input.customerId);
  await requireCrmManage(db, user, customer.ownerId);
  const code = await nextCode("OPP", db);
  const [row] = await db
    .insert(crmOpportunities)
    .values({
      code,
      customerId: input.customerId,
      name: input.name.trim(),
      stage: input.stage ?? "initial",
      expectedAmountCents: input.expectedAmountCents ?? null,
      winRate: input.winRate ?? null,
      ownerId: user.id,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!row) throw new Error("商机插入失败");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.opportunities.create", targetType: "crm_opportunity", targetId: row.id, result: "success", afterJson: { code, name: row.name }, ip });
  return stripAmounts(row, user, ["expectedAmountCents"]);
}

export async function updateOpportunity(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; name?: string; expectedAmountCents?: number | null; winRate?: number | null },
  ip: string | null,
  sessionId: string | null,
) {
  const before = await loadOpportunity(db, input.id);
  await requireCrmManage(db, user, before.ownerId);
  if (before.stage === "won" || before.stage === "lost") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已终态，不可修改");
  const [updated] = await db
    .update(crmOpportunities)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.expectedAmountCents !== undefined ? { expectedAmountCents: input.expectedAmountCents } : {}),
      ...(input.winRate !== undefined ? { winRate: input.winRate } : {}),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${crmOpportunities.rowVersion} + 1`,
    })
    .where(and(eq(crmOpportunities.id, input.id), eq(crmOpportunities.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.opportunities.update", targetType: "crm_opportunity", targetId: input.id, result: "success", afterJson: { name: updated.name }, ip });
  return stripAmounts(updated, user, ["expectedAmountCents"]);
}

/** 看板拖拽改阶段：条件更新+审计（终态不可再拖） */
export async function setOpportunityStage(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; stage: "initial" | "needs" | "proposal" | "negotiation" | "won" | "lost"; rowVersion: number },
  ip: string | null,
  sessionId: string | null,
) {
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
  return stripAmounts(updated, user, ["expectedAmountCents"]);
}

/** 赢单事务（arch/12 §6.3）：won 必挂合同——同事务建合同（draft→active 可选）+商机 won 写回 won_contract_id。重放安全：已 won → 返回现状。 */
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

  const code = await nextCode("CTR", db);
  const [contract] = await db
    .insert(crmContracts)
    .values({
      code,
      opportunityId: before.id,
      customerId: before.customerId,
      matterId: input.contract.matterId ?? null,
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
  await recordAudit(db, {
    actorId: user.id, sessionId, action: "crm.opportunities.markWon", targetType: "crm_opportunity", targetId: input.id, result: "success",
    afterJson: { contractId: contract.id, contractCode: contract.code, contractStatus: contract.status }, ip,
  });
  return { opportunity: updated, contract, replayed: false as const };
}

export async function markOpportunityLost(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; reason: string },
  ip: string | null,
  sessionId: string | null,
) {
  const before = await loadOpportunity(db, input.id);
  await requireCrmManage(db, user, before.ownerId);
  if (before.stage === "won" || before.stage === "lost") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已终态");
  if (!input.reason.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "输单原因必填", { reason: ["输单原因必填"] });
  const [updated] = await db
    .update(crmOpportunities)
    .set({ stage: "lost", updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${crmOpportunities.rowVersion} + 1` })
    .where(and(eq(crmOpportunities.id, input.id), eq(crmOpportunities.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "商机已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.opportunities.markLost", targetType: "crm_opportunity", targetId: input.id, result: "success", afterJson: { reason: input.reason.trim() }, ip });
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
  const conditions: (SQL | undefined)[] = [];
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
    items.push(stripAmounts(withCum, user, ["amountCents", "cumulativeReceivedCents"]));
  }
  return {
    items,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function getContractById(db: DbOrTx, user: SessionUser, id: string) {
  await requireCrmRead(db, user);
  const contract = await loadContract(db, id);
  return stripAmounts(await contractWithCumulative(db, contract), user, ["amountCents", "cumulativeReceivedCents"]);
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
  const [updated] = await db
    .update(crmContracts)
    .set({ status: "active", signedAt: input.signedAt ?? new Date().toISOString(), updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${crmContracts.rowVersion} + 1` })
    .where(and(eq(crmContracts.id, input.id), eq(crmContracts.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "合同已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "crm.contracts.activate", targetType: "crm_contract", targetId: input.id, result: "success", afterJson: { signedAt: updated.signedAt }, ip });
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

export async function createFollowup(
  db: DbOrTx,
  user: SessionUser,
  input: { targetType: "lead" | "opportunity" | "customer"; targetId: string; content: string; nextAt?: string | null },
  ip: string | null,
  sessionId: string | null,
) {
  await requireCrmManage(db, user);
  await assertFollowupTargetExists(db, input.targetType, input.targetId);
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
  return db
    .select()
    .from(crmFollowups)
    .where(and(eq(crmFollowups.targetType, input.targetType), eq(crmFollowups.targetId, input.targetId)))
    .orderBy(desc(crmFollowups.createdAt))
    .limit(Math.min(input.limit, 100));
}
