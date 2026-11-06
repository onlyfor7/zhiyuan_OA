import { eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";

import * as schema from "../schema";
import {
  clients,
  crmContracts,
  crmContractPaymentPlans,
  finCostRates,
  finInvoices,
  finReceivables,
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

async function idByCode<T extends { id: string }>(tx: SeedTx, select: Promise<T[]>): Promise<string> {
  const row = await select;
  if (!row[0]) throw new Error("种子依赖行缺失");
  return row[0].id;
}

/** 仅 full 档：财务核算演示种子（arch/12 §7.2；minimal 档零业务数据） */
export async function seedFin(tx: SeedTx): Promise<void> {
  const guojingwenId = await idByCode(tx, tx.select({ id: users.id }).from(users).where(eq(users.email, "guojingwen@lexflow.demo")));

  const contractId = await idByCode(
    tx,
    tx.select({ id: crmContracts.id }).from(crmContracts).where(eq(crmContracts.code, `CTR-${YEAR}-00001`)),
  );
  const gdCustomerId = await idByCode(
    tx,
    tx.select({ id: clients.id }).from(clients).where(eq(clients.code, `CLT-${YEAR}-00005`)),
  );
  const plans = await tx
    .select({ id: crmContractPaymentPlans.id, seq: crmContractPaymentPlans.seq, dueDate: crmContractPaymentPlans.dueDate, amount: crmContractPaymentPlans.amountCents })
    .from(crmContractPaymentPlans)
    .where(eq(crmContractPaymentPlans.contractId, contractId))
    .orderBy(crmContractPaymentPlans.seq);
  if (plans.length < 2) throw new Error("种子依赖 GD 合同 2 行付款计划");

  /* ===== GD 合同 2 应收（计划行 1=逾期演示 due 已过；计划行 2=open 未到期） ===== */

  const arSeeds = [
    { code: `AR-${YEAR}-00001`, planSeq: 1, dueOffset: -10, source: "payment_plan" },
    { code: `AR-${YEAR}-00002`, planSeq: 2, dueOffset: 60, source: "payment_plan" },
  ];
  for (const ar of arSeeds) {
    const existing = await tx.select({ id: finReceivables.id }).from(finReceivables).where(eq(finReceivables.code, ar.code));
    if (!existing[0]) {
      const plan = plans.find((p) => p.seq === ar.planSeq)!;
      await tx.insert(finReceivables).values({
        code: ar.code,
        contractId,
        planId: plan.id,
        customerId: gdCustomerId,
        amountCents: plan.amount,
        dueDate: fmt(addDays(TODAY, ar.dueOffset)),
        status: "open",
        source: ar.source,
        createdBy: guojingwenId,
        updatedBy: guojingwenId,
      });
    }
  }
  const ar1Id = await idByCode(tx, tx.select({ id: finReceivables.id }).from(finReceivables).where(eq(finReceivables.code, `AR-${YEAR}-00001`)));

  /* ===== 1 发票（issued，挂 AR-00001，税率取默认 6%） ===== */

  const inv1 = `INV-${YEAR}-00001`;
  const invExisting = await tx.select({ id: finInvoices.id }).from(finInvoices).where(eq(finInvoices.code, inv1));
  if (!invExisting[0]) {
    await tx.insert(finInvoices).values({
      code: inv1,
      customerId: gdCustomerId,
      contractId,
      receivableId: ar1Id,
      amountCents: 400000,
      taxRate: 6,
      status: "issued",
      issuedAt: addDays(TODAY, -5).toISOString(),
      createdBy: guojingwenId,
      updatedBy: guojingwenId,
    });
  }

  /* ===== 成本率 3 档（角色价示例：合伙人/项目负责人/成员级） ===== */

  const rateSeeds = [
    { role: "partner", hourlyRateCents: 50000, effectiveFrom: "2024-01-01" },
    { role: "project_manager", hourlyRateCents: 35000, effectiveFrom: "2024-01-01" },
    { role: "member", hourlyRateCents: 20000, effectiveFrom: "2024-01-01" },
  ];
  for (const rate of rateSeeds) {
    const existing = await tx
      .select({ id: finCostRates.id })
      .from(finCostRates)
      .where(eq(finCostRates.role, rate.role));
    if (!existing[0]) {
      await tx.insert(finCostRates).values({
        role: rate.role,
        hourlyRateCents: rate.hourlyRateCents,
        effectiveFrom: rate.effectiveFrom,
        createdBy: guojingwenId,
        updatedBy: guojingwenId,
      });
    }
  }

  // 编号序列水位对齐（AR/INV 新前缀）
  for (const [prefix, next] of [["AR", 3], ["INV", 2]] as const) {
    await tx.execute(
      sql.raw(
        `INSERT INTO code_sequences (prefix, year, next_value) VALUES ('${prefix}', ${YEAR}, ${next}) ` +
          `ON CONFLICT (prefix, year) DO UPDATE SET next_value = GREATEST(code_sequences.next_value, ${next})`,
      ),
    );
  }
}
