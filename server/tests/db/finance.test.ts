import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import {
  budgetCategories,
  budgetLedger,
  budgets,
  expenseItems,
  expenseReports,
  fundingRequests,
  projects,
  users,
} from "../../src/db/schema";
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

/** drizzle 将 pg 原始错误放在 cause 上：23505 唯一冲突 / 23514 check 违例 */
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

describe("财务域种子与台账口径", () => {
  it("干净库重放后财务种子齐备，二次执行行数不变", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const counts = await countRows();
    expect(counts.budgets).toBe(2); // A 80 万 + B 20 万
    expect(counts.budget_categories).toBe(2); // 仅 A：差旅 30 万 + 资料 10 万
    expect(counts.funding_requests).toBe(3); // approved 2 万 + pending 6 万 + 闭环经费 1 万
    expect(counts.expense_reports).toBe(2); // member draft + paid（核销闭环）
    expect(counts.expense_items).toBe(4);
    expect(counts.budget_ledger).toBe(7); // ACTIVATED×2 + RESERVED×2 + RELEASED×1 + RECOGNIZED×2（arch/08 §7 闭环核销）
    expect(counts.expense_adjustments).toBe(0);
    expect(counts.file_objects).toBe(4); // 四张票据文件
    expect(counts.code_sequences).toBe(17);

    await runSeed(TEST_DATABASE_URL);
    const before = await countRows();
    await runSeed(TEST_DATABASE_URL);
    const after = await countRows();
    expect(after).toEqual(before);
  });

  it("五公式重算自洽：有效预算/有效占用/实际支出/可用额度（arch/01 §4）", async () => {
    const { db, pool } = await openDb();
    try {
      const projectA = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      const projectB = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00002`));

      // 项目 A：有效预算 80,000,000；有效占用 2,200,000（2M+1M−0.8M）；实际支出 800,000；可用 77,000,000
      const aBudget = await db
        .select({ totalCents: budgets.totalCents })
        .from(budgets)
        .where(and(eq(budgets.projectId, projectA[0].id), eq(budgets.status, "active")));
      expect(aBudget[0].totalCents).toBe(80000000);

      const aLedger = await db
        .select({
          reserved: sql<string>`coalesce(sum(${budgetLedger.reservedDeltaCents}), 0)::text`,
          actual: sql<string>`coalesce(sum(${budgetLedger.actualDeltaCents}) filter (where ${budgetLedger.entryType} in ('EXPENSE_RECOGNIZED', 'EXPENSE_ADJUSTED')), 0)::text`,
        })
        .from(budgetLedger)
        .where(eq(budgetLedger.projectId, projectA[0].id));
      const reservedA = Number(aLedger[0].reserved);
      const actualA = Number(aLedger[0].actual);
      expect(reservedA).toBe(2200000); // FND-00001 2M + FND-00003 净 0.2M（1M 已释放 0.8M）
      expect(actualA).toBe(800000); // EXP-2026-00002 核销两笔（draft 报销不产生台账）
      expect(aBudget[0].totalCents - reservedA - actualA).toBe(77000000);

      // 项目 B：20,000,000 / 0 / 0 / 20,000,000（无类别行 ≠ 零预算）
      const bBudget = await db
        .select({ totalCents: budgets.totalCents })
        .from(budgets)
        .where(and(eq(budgets.projectId, projectB[0].id), eq(budgets.status, "active")));
      expect(bBudget[0].totalCents).toBe(20000000);

      // 项目 C：无预算行（hasBudget=false 口径）
      const projectC = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00003`));
      const cBudget = await db.select({ id: budgets.id }).from(budgets).where(eq(budgets.projectId, projectC[0].id));
      expect(cBudget).toHaveLength(0);

      // 报销单合计 = 明细合计（服务端口径种子自洽；EXP-00002 paid 同理）
      for (const expCode of [`EXP-${YEAR}-00001`, `EXP-${YEAR}-00002`]) {
        const report = await db
          .select({ id: expenseReports.id, totalCents: expenseReports.totalCents, status: expenseReports.status })
          .from(expenseReports)
          .where(eq(expenseReports.code, expCode));
        const items = await db
          .select({ amountCents: expenseItems.amountCents })
          .from(expenseItems)
          .where(eq(expenseItems.expenseReportId, report[0].id));
        expect(items.reduce((sum, i) => sum + i.amountCents, 0)).toBe(report[0].totalCents);
      }
      const exp1 = await db
        .select({ totalCents: expenseReports.totalCents })
        .from(expenseReports)
        .where(eq(expenseReports.code, `EXP-${YEAR}-00001`));
      expect(exp1[0].totalCents).toBe(1400000);
      const exp2 = await db
        .select({ totalCents: expenseReports.totalCents, status: expenseReports.status })
        .from(expenseReports)
        .where(eq(expenseReports.code, `EXP-${YEAR}-00002`));
      expect(exp2[0]).toEqual({ totalCents: 800000, status: "paid" });
    } finally {
      await pool.end();
    }
  });

  it("budget_ledger 幂等键唯一冲突被拒（重复记账兜底）", async () => {
    const { db, pool } = await openDb();
    try {
      const projectA = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      const existing = await db
        .select({ key: budgetLedger.idempotencyKey, code: budgetLedger.code })
        .from(budgetLedger)
        .limit(1);
      await expectPgViolation(
        db.insert(budgetLedger).values({
          code: `LED-${YEAR}-99901`,
          projectId: projectA[0].id,
          sourceType: "funding",
          sourceId: null,
          entryType: "FUNDING_RESERVED",
          reservedDeltaCents: 100,
          occurredAt: new Date().toISOString(),
          idempotencyKey: existing[0].key,
        }),
        "23505",
      );
    } finally {
      await pool.end();
    }
  });

  it("金额 >0 check：经费/明细零金额与负金额必败", async () => {
    const { db, pool } = await openDb();
    try {
      const projectA = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      const pm = await db.select({ id: users.id }).from(users).where(eq(users.email, "pm@lexflow.demo"));
      await expectPgViolation(
        db.insert(fundingRequests).values({
          projectId: projectA[0].id,
          code: `FND-${YEAR}-90001`,
          applicantId: pm[0].id,
          purpose: "零金额测试",
          amountCents: 0,
        }),
        "23514",
      );
      const report = await db
        .select({ id: expenseReports.id })
        .from(expenseReports)
        .where(eq(expenseReports.code, `EXP-${YEAR}-00001`));
      await expectPgViolation(
        db.insert(expenseItems).values({
          expenseReportId: report[0].id,
          projectId: projectA[0].id,
          date: "2026-10-27",
          category: "meals",
          amountCents: -100,
          description: "负金额测试",
        }),
        "23514",
      );
    } finally {
      await pool.end();
    }
  });

  it("预算双 active 必败；active 内容唯一约束生效", async () => {
    const { db, pool } = await openDb();
    try {
      const projectA = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      // 同项目双 active → 部分唯一必败
      await expectPgViolation(
        db.insert(budgets).values({
          projectId: projectA[0].id,
          code: `BUD-${YEAR}-90001`,
          versionNo: 2,
          periodStart: "2026-10-27",
          periodEnd: "2027-10-26",
          totalCents: 1000000,
          status: "active",
        }),
        "23505",
      );
      // 同项目同版本号（即使旧状态）→ unique(project_id, version_no) 必败
      await expectPgViolation(
        db.insert(budgets).values({
          projectId: projectA[0].id,
          code: `BUD-${YEAR}-90002`,
          versionNo: 1,
          periodStart: "2026-10-27",
          periodEnd: "2027-10-26",
          totalCents: 1000000,
          status: "draft",
        }),
        "23505",
      );
      // 旧版 superseded 后新 active 版本可建（调整路径）
      await db
        .update(budgets)
        .set({ status: "superseded" })
        .where(and(eq(budgets.projectId, projectA[0].id), eq(budgets.versionNo, 1)));
      await expect(
        db
          .insert(budgets)
          .values({
            projectId: projectA[0].id,
            code: `BUD-${YEAR}-90003`,
            versionNo: 2,
            periodStart: "2026-10-27",
            periodEnd: "2027-10-26",
            totalCents: 81000000,
            status: "active",
          })
          .returning({ id: budgets.id }),
      ).resolves.toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("经费两态分离：审批态 text 与使用态枚举独立可写", async () => {
    const { db, pool } = await openDb();
    try {
      const f1 = await db
        .select({
          id: fundingRequests.id,
          approvalStatus: fundingRequests.approvalStatus,
          usageStatus: fundingRequests.usageStatus,
        })
        .from(fundingRequests)
        .where(eq(fundingRequests.code, `FND-${YEAR}-00001`));
      expect(f1[0]).toEqual({ id: f1[0].id, approvalStatus: "approved", usageStatus: "unused" });

      // 使用态四值可写（unused → partially_used）
      await db
        .update(fundingRequests)
        .set({ usageStatus: "partially_used" })
        .where(eq(fundingRequests.id, f1[0].id));
      const after = await db
        .select({ usageStatus: fundingRequests.usageStatus })
        .from(fundingRequests)
        .where(eq(fundingRequests.id, f1[0].id));
      expect(after[0].usageStatus).toBe("partially_used");
      // 还原（保持种子幂等语义下的初始态）
      await db.update(fundingRequests).set({ usageStatus: "unused" }).where(eq(fundingRequests.id, f1[0].id));

      const f2 = await db
        .select({ approvalStatus: fundingRequests.approvalStatus, usageStatus: fundingRequests.usageStatus })
        .from(fundingRequests)
        .where(eq(fundingRequests.code, `FND-${YEAR}-00002`));
      expect(f2[0]).toEqual({ approvalStatus: "pending_approval", usageStatus: "unused" });
    } finally {
      await pool.end();
    }
  });

  it("报销单头无 project_id（明细级归属 EXP-001）；类别行唯一", async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    const headProject = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'expense_reports' AND column_name = 'project_id'`,
    );
    expect(headProject.rows[0].n).toBe(0);
    const itemProject = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'expense_items' AND column_name = 'project_id'`,
    );
    expect(itemProject.rows[0].n).toBe(1);
    await client.end();

    const { db, pool } = await openDb();
    try {
      const budget = await db
        .select({ id: budgets.id })
        .from(budgets)
        .where(eq(budgets.code, `BUD-${YEAR}-00001`));
      await expectPgViolation(
        db.insert(budgetCategories).values({ budgetId: budget[0].id, category: "transport", amountCents: 1 }),
        "23505",
      );
    } finally {
      await pool.end();
    }
  });
});
