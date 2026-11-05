import { and, eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";

import * as schema from "../schema";
import {
  clients,
  crmContracts,
  crmContractPaymentPlans,
  crmFollowups,
  crmLeads,
  crmOpportunities,
  users,
} from "../schema";

export type SeedTx =
  | NodePgDatabase<typeof schema>
  | NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

const YEAR = new Date().getFullYear();

function fmt(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const TODAY = new Date();

async function userIdByEmail(tx: SeedTx, email: string): Promise<string> {
  const row = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!row[0]) throw new Error(`种子依赖用户 ${email} 缺失`);
  return row[0].id;
}

async function idByCode<T extends { id: string }>(tx: SeedTx, select: Promise<T[]>): Promise<string> {
  const row = await select;
  if (!row[0]) throw new Error("种子依赖行缺失");
  return row[0].id;
}

/** 仅 full 档：CRM 演示种子（arch/12 §6.2；minimal 档不调用——枚举/前缀/客户加列随迁移与 foundation 就位） */
export async function seedCrm(tx: SeedTx): Promise<void> {
  const liangqifengId = await userIdByEmail(tx, "liangqifeng@lexflow.demo");
  const wangbaozhuoId = await userIdByEmail(tx, "wangbaozhuo@lexflow.demo");
  const huodaId = await userIdByEmail(tx, "huoda@lexflow.demo");

  /* ===== 五客户补 level/industry/owner（仅既有种子客户码；不覆盖运行期编辑） ===== */

  const clientBackfill: Array<[string, string, string, string]> = [
    [`CLT-${YEAR}-00001`, "战略客户", "智能制造装备", "wangbaozhuo@lexflow.demo"],
    [`CLT-${YEAR}-00002`, "重点客户", "环保技术与装备", "wangjiayu@lexflow.demo"],
    [`CLT-${YEAR}-00003`, "重点客户", "精密机械部件", "sunhaoxiang@lexflow.demo"],
    [`CLT-${YEAR}-00004`, "战略客户", "软件与信息服务", "liaoyimin@lexflow.demo"],
    [`CLT-${YEAR}-00005`, "一般客户", "法律服务", "huoda@lexflow.demo"],
  ];
  for (const [code, level, industry, ownerEmail] of clientBackfill) {
    const row = await tx.select({ id: clients.id, industry: clients.industry }).from(clients).where(eq(clients.code, code));
    if (row[0] && row[0].industry === "") {
      const ownerId = await userIdByEmail(tx, ownerEmail);
      await tx.update(clients).set({ level, industry, ownerId }).where(eq(clients.id, row[0].id));
    }
  }
  const bibositeId = await idByCode(tx, tx.select({ id: clients.id }).from(clients).where(eq(clients.code, `CLT-${YEAR}-00001`)));
  const gdClientId = await idByCode(tx, tx.select({ id: clients.id }).from(clients).where(eq(clients.code, `CLT-${YEAR}-00005`)));
  const gdMatterId = await idByCode(
    tx,
    tx.select({ id: schema.matters.id }).from(schema.matters).where(eq(schema.matters.code, `MTR-${YEAR}-00005`)),
  );

  /* ===== 2 线索（1 new、1 qualified 挂梁奇烽） ===== */

  const ld1 = `LD-${YEAR}-00001`;
  const ld1Existing = await tx.select({ id: crmLeads.id }).from(crmLeads).where(eq(crmLeads.code, ld1));
  if (!ld1Existing[0]) {
    await tx.insert(crmLeads).values({
      code: ld1,
      name: "苏州恒锐智能装备（线索）",
      source: "展会获客",
      contactName: "刘工",
      contactPhone: "138-0000-2601",
      status: "new",
      createdBy: liangqifengId,
      updatedBy: liangqifengId,
    });
  }
  const ld2 = `LD-${YEAR}-00002`;
  const ld2Existing = await tx.select({ id: crmLeads.id }).from(crmLeads).where(eq(crmLeads.code, ld2));
  if (!ld2Existing[0]) {
    await tx.insert(crmLeads).values({
      code: ld2,
      name: "南京云启数据服务（线索）",
      source: "转介绍",
      contactName: "陈经理",
      contactPhone: "139-0000-2602",
      status: "qualified",
      ownerId: liangqifengId,
      createdBy: liangqifengId,
      updatedBy: liangqifengId,
    });
  }
  const ld2Id = await idByCode(tx, tx.select({ id: crmLeads.id }).from(crmLeads).where(eq(crmLeads.code, ld2)));

  /* ===== 2 商机（比博思特 proposal 挂王宝茁；GD won→合同） ===== */

  const opp1 = `OPP-${YEAR}-00001`;
  const opp1Existing = await tx.select({ id: crmOpportunities.id }).from(crmOpportunities).where(eq(crmOpportunities.code, opp1));
  if (!opp1Existing[0]) {
    await tx.insert(crmOpportunities).values({
      code: opp1,
      customerId: bibositeId,
      name: "比博思特运维续约商机",
      stage: "proposal",
      expectedAmountCents: 2000000,
      winRate: 60,
      ownerId: wangbaozhuoId,
      createdBy: wangbaozhuoId,
      updatedBy: wangbaozhuoId,
    });
  }
  const opp1Id = await idByCode(tx, tx.select({ id: crmOpportunities.id }).from(crmOpportunities).where(eq(crmOpportunities.code, opp1)));

  const opp2 = `OPP-${YEAR}-00002`;
  const opp2Existing = await tx.select({ id: crmOpportunities.id }).from(crmOpportunities).where(eq(crmOpportunities.code, opp2));
  let opp2Id = opp2Existing[0]?.id;
  if (!opp2Id) {
    const inserted = await tx
      .insert(crmOpportunities)
      .values({
        code: opp2,
        customerId: gdClientId,
        name: "GD 法律服务年度商机",
        stage: "won",
        expectedAmountCents: 800000,
        winRate: 100,
        ownerId: huodaId,
        createdBy: huodaId,
        updatedBy: huodaId,
      })
      .returning({ id: crmOpportunities.id });
    opp2Id = inserted[0].id;
  }

  /* ===== 1 合同（CTR 激活，GD，挂 OPP-00002）+ 2 行付款计划 ===== */

  const ctr1 = `CTR-${YEAR}-00001`;
  const ctrExisting = await tx.select({ id: crmContracts.id }).from(crmContracts).where(eq(crmContracts.code, ctr1));
  let ctrId = ctrExisting[0]?.id;
  if (!ctrId) {
    const inserted = await tx
      .insert(crmContracts)
      .values({
        code: ctr1,
        opportunityId: opp2Id,
        customerId: gdClientId,
        matterId: gdMatterId,
        title: "GD 法律服务年度合同",
        amountCents: 800000,
        signedAt: addDays(TODAY, -30).toISOString(),
        status: "active",
        createdBy: huodaId,
        updatedBy: huodaId,
      })
      .returning({ id: crmContracts.id });
    ctrId = inserted[0].id;
    await tx.update(crmOpportunities).set({ wonContractId: ctrId }).where(eq(crmOpportunities.id, opp2Id));
  }

  const plans = [
    { seq: 1, dueDate: fmt(addDays(TODAY, -10)), amountCents: 400000 },
    { seq: 2, dueDate: fmt(addDays(TODAY, 60)), amountCents: 400000 },
  ];
  for (const plan of plans) {
    const existing = await tx
      .select({ id: crmContractPaymentPlans.id })
      .from(crmContractPaymentPlans)
      .where(and(eq(crmContractPaymentPlans.contractId, ctrId), eq(crmContractPaymentPlans.seq, plan.seq)));
    if (!existing[0]) {
      await tx.insert(crmContractPaymentPlans).values({
        contractId: ctrId,
        seq: plan.seq,
        dueDate: plan.dueDate,
        amountCents: plan.amountCents,
        status: "unpaid",
        createdBy: huodaId,
        updatedBy: huodaId,
      });
    }
  }

  /* ===== 3 跟进（lead/opportunity/customer 各一） ===== */

  const followups = [
    { targetType: "lead", targetId: ld2Id, content: "电话沟通初步需求，客户关注交付周期", nextAt: addDays(TODAY, 3).toISOString() },
    { targetType: "opportunity", targetId: opp1Id, content: "已提交续约方案，待客户评审", nextAt: addDays(TODAY, 5).toISOString() },
    { targetType: "customer", targetId: bibositeId, content: "季度例行回访，满意度良好", nextAt: null },
  ];
  for (const fu of followups) {
    const existing = await tx
      .select({ id: crmFollowups.id })
      .from(crmFollowups)
      .where(
        and(
          eq(crmFollowups.targetType, fu.targetType as never),
          eq(crmFollowups.targetId, fu.targetId),
          eq(crmFollowups.content, fu.content),
        ),
      );
    if (!existing[0]) {
      await tx.insert(crmFollowups).values({
        targetType: fu.targetType as never,
        targetId: fu.targetId,
        content: fu.content,
        nextAt: fu.nextAt,
        createdBy: wangbaozhuoId,
      });
    }
  }

  // 编号序列水位对齐（LD/OPP/CTR 新前缀）
  for (const [prefix, next] of [["LD", 3], ["OPP", 3], ["CTR", 2]] as const) {
    await tx.execute(
      sql.raw(
        `INSERT INTO code_sequences (prefix, year, next_value) VALUES ('${prefix}', ${YEAR}, ${next}) ` +
          `ON CONFLICT (prefix, year) DO UPDATE SET next_value = GREATEST(code_sequences.next_value, ${next})`,
      ),
    );
  }
}
