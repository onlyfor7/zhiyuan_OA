import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import { clients, crmContracts, crmContractPaymentPlans, crmFollowups, crmLeads, crmOpportunities, users } from "../../src/db/schema";
import { ALL_TABLES, migrateFresh, TEST_DATABASE_URL } from "./helpers";

const YEAR = new Date().getFullYear();

type Db = NodePgDatabase<typeof schema>;

interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

async function openDb(): Promise<DbHandle> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  return { pool, db: drizzle(pool, { schema }) };
}

async function expectPgViolation(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as { cause?: { code?: string } },
  );
  expect(error).not.toBeNull();
  expect(error?.cause?.code).toBe(code);
}

async function countRows(): Promise<Record<string, number>> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  const counts: Record<string, number> = {};
  for (const table of ALL_TABLES) {
    const result = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
    counts[table] = result.rows[0].n;
  }
  await client.end();
  return counts;
}

describe("9c-01 CRM 数据建模与种子（arch/12 §6.2）", () => {
  it("干净库重放 60 表齐备：2 线索/五客户级别行业/2 商机/1 合同 2 计划/3 跟进；二次执行幂等", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const counts = await countRows();
    expect(counts.crm_leads).toBe(2);
    expect(counts.crm_contacts).toBe(0);
    expect(counts.crm_opportunities).toBe(2);
    expect(counts.crm_contracts).toBe(1);
    expect(counts.crm_contract_payment_plans).toBe(2);
    expect(counts.crm_followups).toBe(3);
    expect(counts.code_sequences).toBe(22); // 19 + LD/OPP/CTR

    const { db, pool } = await openDb();
    try {
      // 五客户级别行业与负责人
      const rows = await db
        .select({ code: clients.code, level: clients.level, industry: clients.industry, ownerEmail: users.email })
        .from(clients)
        .leftJoin(users, eq(users.id, clients.ownerId));
      const byCode = new Map(rows.map((r) => [r.code, r]));
      expect(byCode.get(`CLT-${YEAR}-00001`)).toMatchObject({ level: "战略客户", industry: "智能制造装备", ownerEmail: "wangbaozhuo@lexflow.demo" });
      expect(byCode.get(`CLT-${YEAR}-00005`)).toMatchObject({ level: "一般客户", industry: "法律服务", ownerEmail: "huoda@lexflow.demo" });
      expect(byCode.get(`CLT-${YEAR}-00004`)?.industry).toBe("软件与信息服务");

      // 线索：1 new + 1 qualified（owner=梁奇烽）
      const leads = await db
        .select({ code: crmLeads.code, status: crmLeads.status, ownerEmail: users.email })
        .from(crmLeads)
        .leftJoin(users, eq(users.id, crmLeads.ownerId));
      expect(leads.find((l) => l.code === `LD-${YEAR}-00001`)).toMatchObject({ status: "new", ownerEmail: null });
      const qualified = leads.find((l) => l.code === `LD-${YEAR}-00002`);
      expect(qualified).toMatchObject({ status: "qualified", ownerEmail: "liangqifeng@lexflow.demo" });

      // 商机：proposal 挂王宝茁；won 挂合同
      const opps = await db
        .select({
          code: crmOpportunities.code,
          stage: crmOpportunities.stage,
          ownerEmail: users.email,
          wonContractId: crmOpportunities.wonContractId,
        })
        .from(crmOpportunities)
        .leftJoin(users, eq(users.id, crmOpportunities.ownerId));
      const proposal = opps.find((o) => o.code === `OPP-${YEAR}-00001`);
      expect(proposal).toMatchObject({ stage: "proposal", ownerEmail: "wangbaozhuo@lexflow.demo" });
      const won = opps.find((o) => o.code === `OPP-${YEAR}-00002`);
      expect(won?.stage).toBe("won");
      expect(won?.wonContractId).toBeTruthy();

      // 合同激活 + 2 行付款计划
      const contract = await db.select().from(crmContracts).where(eq(crmContracts.code, `CTR-${YEAR}-00001`));
      expect(contract[0].status).toBe("active");
      expect(Number(contract[0].amountCents)).toBe(800000);
      const plans = await db
        .select({ seq: crmContractPaymentPlans.seq, status: crmContractPaymentPlans.status, amount: crmContractPaymentPlans.amountCents })
        .from(crmContractPaymentPlans)
        .where(eq(crmContractPaymentPlans.contractId, contract[0].id))
        .orderBy(crmContractPaymentPlans.seq);
      expect(plans.map((p) => [p.seq, p.status, Number(p.amount)])).toEqual([
        [1, "unpaid", 400000],
        [2, "unpaid", 400000],
      ]);

      // 跟进：lead/opportunity/customer 三形态各一
      const fus = await db.select({ targetType: crmFollowups.targetType }).from(crmFollowups);
      expect(fus.map((f) => f.targetType).sort()).toEqual(["customer", "lead", "opportunity"]);
    } finally {
      await pool.end();
    }

    await runSeed(TEST_DATABASE_URL);
    const again = await countRows();
    expect(again).toEqual(counts);
  });

  it("约束：付款计划 unique(contract_id, seq) 必败；多态 target 类型由 pgEnum 强制（非法值 22P02）", async () => {
    const { db, pool } = await openDb();
    try {
      const contract = await db.select({ id: crmContracts.id }).from(crmContracts).where(eq(crmContracts.code, `CTR-${YEAR}-00001`));
      await expectPgViolation(
        db.insert(crmContractPaymentPlans).values({
          contractId: contract[0].id,
          seq: 1,
          dueDate: "2027-01-01",
          amountCents: 1,
        }),
        "23505",
      );
      // 多态 target_type 仅允许 lead/opportunity/customer
      await expectPgViolation(
        db.insert(crmFollowups).values({
          targetType: "contract" as never,
          targetId: contract[0].id,
          content: "非法目标类型测试",
        }),
        "22P02",
      );
      // 合法三形态可写
      for (const [i, targetType] of ["lead", "opportunity", "customer"].entries()) {
        await expect(
          db
            .insert(crmFollowups)
            .values({ targetType: targetType as never, targetId: contract[0].id, content: `合法形态 ${i}` })
            .returning({ id: crmFollowups.id }),
        ).resolves.toHaveLength(1);
      }
    } finally {
      await pool.end();
    }
  });
});
