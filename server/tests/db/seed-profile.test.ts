import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import { codeSequences, clients, flowDefinitions, matters, projects } from "../../src/db/schema";
import { ALL_TABLES, migrateFresh, TEST_DATABASE_URL } from "./helpers";

type Db = NodePgDatabase<typeof schema>;

interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

async function openDb(): Promise<DbHandle> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  return { pool, db: drizzle(pool, { schema }) };
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

/** minimal 档应为零的业务表 */
const MINIMAL_ZERO_TABLES = [
  "sessions",
  "clients",
  "matters",
  "projects",
  "project_members",
  "access_grants",
  "file_objects",
  "file_versions",
  "audit_events",
  "notifications",
  "stages",
  "milestones",
  "tasks",
  "deliverables",
  "plan_versions",
  "plan_items",
  "change_requests",
  "quality_issues",
  "quality_issue_events",
  "quality_check_items",
  "decisions",
  "weekly_reports",
  "archive_directories",
  "archive_links",
  "approval_instances",
  "approval_steps",
  "approval_policies",
  "meetings",
  "meeting_participants",
  "meeting_minutes",
  "meeting_action_items",
  "travel_requests",
  "travel_segments",
  "travel_events",
  "budgets",
  "budget_categories",
  "funding_requests",
  "expense_reports",
  "expense_items",
  "budget_ledger",
  "expense_adjustments",
  "timesheet_periods",
  "time_entries",
  "payment_receipts",
  "generic_requests",
  "crm_leads",
  "crm_contacts",
  "crm_opportunities",
  "crm_contracts",
  "crm_contract_payment_plans",
  "crm_followups",
  "fin_receivables",
  "fin_invoices",
  "fin_cost_rates",
];

describe("SEED_PROFILE=minimal 清库种子档（工单 07）", () => {
  it("minimal：基础件齐备 + 模板/默认流程/全前缀水位在位，业务表全零；二次执行幂等", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL, "minimal");
    const counts = await countRows();

    // 基础件
    expect(counts.org_units).toBe(4); // 1 律所 + 3 部门
    expect(counts.roles).toBe(8);
    expect(counts.users).toBe(22); // arch/11 G1 名单，口令统一 Demo@2026
    expect(counts.user_roles).toBe(23); // 梁奇烽 partner+quality_lead 双挂
    expect(counts.system_config).toBe(20); // §18 全量 + timesheet.default_approver + generic_request.types + timesheet.step_minutes + 保留期两键（9a-04 §14.5）
    // minimal 清单项：2 模板 + 默认审批流（8 条，无演示流程）+ 编号水位（19 前缀）
    expect(counts.project_templates).toBe(2);
    expect(counts.company_profile).toBe(1); // 公司信息为 foundation（单记录，双档同在）
    expect(counts.flow_definitions).toBe(10); // 10 默认（含 09b 补的 travel_change/generic_request）
    expect(counts.code_sequences).toBe(19); // minimal 仅基础水位（LD/OPP/CTR 为 full 档 seedCrm 所加）
    // 零演示业务数据
    for (const table of MINIMAL_ZERO_TABLES) {
      expect(counts[table], `${table} 应为 0`).toBe(0);
    }

    // 水位正常：PRJ/TSK/LED 等可用且不丢档
    const { db, pool } = await openDb();
    try {
      const prj = await db
        .select({ nextValue: codeSequences.nextValue })
        .from(codeSequences)
        .where(eq(codeSequences.prefix, "PRJ"));
      expect(prj[0].nextValue).toBeGreaterThanOrEqual(6);
      const flows = await db
        .select({ name: flowDefinitions.name, enabled: flowDefinitions.enabled })
        .from(flowDefinitions);
      expect(flows.every((f) => f.enabled)).toBe(true);
      expect(flows).toHaveLength(10);
      const jia = await db.select({ id: clients.id }).from(clients).where(eq(clients.code, `CLT-${new Date().getFullYear()}-00004`));
      expect(jia).toHaveLength(0); // 佳力奇亦属演示数据，minimal 不建
    } finally {
      await pool.end();
    }

    // 二次执行幂等
    await runSeed(TEST_DATABASE_URL, "minimal");
    const again = await countRows();
    expect(again).toEqual(counts);
  });

  it("档位切换：minimal 库上重跑 full 档，演示数据按幂等补齐（不重建不冲突）", async () => {
    await runSeed(TEST_DATABASE_URL, "full");
    const counts = await countRows();
    expect(counts.clients).toBe(5); // arch/11 G1 五配套
    expect(counts.projects).toBe(5);
    expect(counts.flow_definitions).toBe(11); // 10 默认 + 1 演示
    expect(counts.project_templates).toBe(2);
    expect(counts.company_profile).toBe(1); // 公司信息为 foundation（单记录，双档同在） // 模板不重复建行
    expect(counts.code_sequences).toBe(24); // 19 + LD/OPP/CTR + AR/INV（9c/9d）
    expect(counts.system_config).toBe(20);
    // users 不重复
    expect(counts.users).toBe(22);
  });

  it("默认档零回归：不带 profile 参数等价 full（环境变量未设时）", async () => {
    expect(process.env.SEED_PROFILE).toBeUndefined();
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const counts = await countRows();
    expect(counts.projects).toBe(5);
    expect(counts.clients).toBe(5);
    expect(counts.flow_definitions).toBe(11);
    expect(counts.payment_receipts).toBe(3);
  });

  it("env 覆盖：process.env.SEED_PROFILE=minimal 时 runSeed 默认参数也走 minimal", async () => {
    process.env.SEED_PROFILE = "minimal";
    try {
      await migrateFresh();
      await runSeed(TEST_DATABASE_URL); // 不传 profile → 读 env
      const counts = await countRows();
      expect(counts.projects).toBe(0);
      expect(counts.users).toBe(22); // arch/11 G1 名单（minimal 亦建全名单）
    } finally {
      delete process.env.SEED_PROFILE;
    }
  });
});
