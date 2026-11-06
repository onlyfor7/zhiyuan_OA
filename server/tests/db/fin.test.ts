import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import { finCostRates, finInvoices, finReceivables } from "../../src/db/schema";
import { ALL_TABLES, migrateFresh, TEST_DATABASE_URL } from "./helpers";

const YEAR = new Date().getFullYear();
const TODAY = new Date().toISOString().slice(0, 10);

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

describe("9d-01 财务核算数据建模与种子（arch/12 §7.2）", () => {
  it("干净库重放 63 表齐备：GD 2 应收（1 逾期演示）/1 发票 issued/三档成本率；fin.* 配置在位；二次幂等", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const counts = await countRows();
    expect(counts.fin_receivables).toBe(2);
    expect(counts.fin_invoices).toBe(1);
    expect(counts.fin_cost_rates).toBe(3);
    expect(counts.code_sequences).toBe(24);

    const { db, pool } = await openDb();
    try {
      // fin.* 三配置键
      const cfgKeys = await db
        .select({ key: schema.systemConfig.key })
        .from(schema.systemConfig)
        .where(eq(schema.systemConfig.key, "fin.ar.overdue_grace_days"));
      expect(cfgKeys).toHaveLength(1);
      for (const k of ["fin.ar.auto_generate", "fin.invoice.default_tax_rate"]) {
        const row = await db.select({ key: schema.systemConfig.key }).from(schema.systemConfig).where(eq(schema.systemConfig.key, k));
        expect(row).toHaveLength(1);
      }

      // 应收：AR-00001 逾期演示（due < today 且 status open——逾期为查询口径不落库）；AR-00002 未到期
      const ars = await db
        .select({ code: finReceivables.code, dueDate: finReceivables.dueDate, status: finReceivables.status, amount: finReceivables.amountCents, source: finReceivables.source })
        .from(finReceivables)
        .orderBy(finReceivables.code);
      expect(ars).toHaveLength(2);
      const ar1 = ars.find((a) => a.code === `AR-${YEAR}-00001`)!;
      const ar2 = ars.find((a) => a.code === `AR-${YEAR}-00002`)!;
      expect(ar1.dueDate < TODAY && ar1.status === "open").toBe(true); // 逾期演示
      expect(ar2.dueDate > TODAY).toBe(true); // 未到期
      expect(Number(ar1.amount)).toBe(400000);
      expect(ar1.source).toBe("payment_plan");

      // 发票：issued、税率 6、挂 AR-00001 与 GD 合同
      const inv = await db.select().from(finInvoices).where(eq(finInvoices.code, `INV-${YEAR}-00001`));
      expect(inv[0].status).toBe("issued");
      expect(inv[0].taxRate).toBe(6);
      expect(inv[0].issuedAt).toBeTruthy();
      expect(inv[0].receivableId).toBeTruthy();

      // 成本率三档（角色价）
      const rates = await db
        .select({ role: finCostRates.role, hourly: finCostRates.hourlyRateCents, userId: finCostRates.userId })
        .from(finCostRates)
        .orderBy(finCostRates.hourlyRateCents);
      expect(rates.map((r) => [r.role, Number(r.hourly), r.userId])).toEqual([
        ["member", 20000, null],
        ["project_manager", 35000, null],
        ["partner", 50000, null],
      ]);
    } finally {
      await pool.end();
    }

    await runSeed(TEST_DATABASE_URL);
    const again = await countRows();
    expect(again).toEqual(counts);
  });

  it("约束：成本率 user_id/role 二态 check（两空/两非空必败）；枚举非法 22P02", async () => {
    const { db, pool } = await openDb();
    try {
      const anyUser = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
      // 两空 → 23514
      await expectPgViolation(
        db.insert(finCostRates).values({ hourlyRateCents: 100, effectiveFrom: "2027-01-01" }),
        "23514",
      );
      // 两非空 → 23514
      await expectPgViolation(
        db.insert(finCostRates).values({ userId: anyUser[0].id, role: "member", hourlyRateCents: 100, effectiveFrom: "2027-01-01" }),
        "23514",
      );
      // 按人价可写（role 空）
      await expect(
        db
          .insert(finCostRates)
          .values({ userId: anyUser[0].id, hourlyRateCents: 45000, effectiveFrom: "2027-01-01" })
          .returning({ id: finCostRates.id }),
      ).resolves.toHaveLength(1);

      // 枚举非法值 22P02
      await expectPgViolation(
        db.insert(finReceivables).values({
          code: `AR-${YEAR}-90001`,
          contractId: (await db.select({ id: schema.crmContracts.id }).from(schema.crmContracts).limit(1))[0].id,
          customerId: (await db.select({ id: schema.clients.id }).from(schema.clients).limit(1))[0].id,
          amountCents: 1,
          dueDate: "2027-01-01",
          status: "overdue" as never, // 逾期不落库
        }),
        "22P02",
      );
      await expectPgViolation(
        db.insert(finInvoices).values({
          code: `INV-${YEAR}-90001`,
          customerId: (await db.select({ id: schema.clients.id }).from(schema.clients).limit(1))[0].id,
          amountCents: 1,
          status: "cancelled" as never,
        }),
        "22P02",
      );
    } finally {
      await pool.end();
    }
  });
});
