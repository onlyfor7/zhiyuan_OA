import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import {
  archiveDirectories,
  archiveLinks,
  projects,
  timeEntries,
  timesheetPeriods,
  users,
} from "../../src/db/schema";
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

describe("工时域种子与约束", () => {
  it("干净库重放后工时种子齐备（draft/approved/locked 三态），二次执行行数不变", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const counts = await countRows();
    expect(counts.timesheet_periods).toBe(3);
    expect(counts.time_entries).toBe(13); // A×4 + B×6 + C×3
    expect(counts.code_sequences).toBe(25); // 19 + LD/OPP/CTR + AR/INV（9c/9d）+ CF（20）
    expect(counts.system_config).toBe(21); // + timesheet.step_minutes（arch/11）+ generic_request.types + 保留期两键（9a-04 §14.5）

    const { db, pool } = await openDb();
    try {
      const periods = await db
        .select({
          code: timesheetPeriods.code,
          status: timesheetPeriods.status,
          approver: users.email,
          lockReason: timesheetPeriods.lockReason,
        })
        .from(timesheetPeriods)
        .leftJoin(users, eq(users.id, timesheetPeriods.approverId))
        .orderBy(timesheetPeriods.code);
      expect(periods.map((p) => [p.code, p.status])).toEqual([
        [`TS-${YEAR}-00001`, "draft"],
        [`TS-${YEAR}-00002`, "approved"],
        [`TS-${YEAR}-00003`, "locked"],
      ]);
      // D2/D3/D4 演示态：B 审批人=pm（主项目 manager 解析结果），C 审批人=partner（pm→partner 不得自审）
      expect(periods[1].approver).toBe("wangbaozhuo@lexflow.demo");
      expect(periods[2].approver).toBe("liangqifeng@lexflow.demo");
      expect(periods[2].lockReason).toContain("D4");

      // 预填样例：source=prefill_meeting 的草稿明细存在且属于 draft 周期
      const prefill = await db
        .select({ status: timesheetPeriods.status, source: timeEntries.source })
        .from(timeEntries)
        .innerJoin(timesheetPeriods, eq(timesheetPeriods.id, timeEntries.periodId))
        .where(eq(timeEntries.source, "prefill_meeting"));
      expect(prefill).toHaveLength(1);
      expect(prefill[0].status).toBe("draft");

      // timesheet 默认审批人配置（arch/07 §4.2 无项目明细周期用）
      const cfg = await db
        .select({ valueJson: schema.systemConfig.valueJson })
        .from(schema.systemConfig)
        .where(eq(schema.systemConfig.key, "timesheet.default_approver"));
      expect((cfg[0].valueJson as { approverEmail: string }).approverEmail).toBe("liangqifeng@lexflow.demo");
    } finally {
      await pool.end();
    }

    await runSeed(TEST_DATABASE_URL);
    const before = await countRows();
    await runSeed(TEST_DATABASE_URL);
    const after = await countRows();
    expect(after).toEqual(before);
  });

  it("unique(user_id, period_start)：同用户同周期起日双周期必败", async () => {
    const { db, pool } = await openDb();
    try {
      const member = await db.select({ id: users.id }).from(users).where(eq(users.email, "guanchen@lexflow.demo"));
      const period = await db
        .select({ periodStart: timesheetPeriods.periodStart })
        .from(timesheetPeriods)
        .where(eq(timesheetPeriods.code, `TS-${YEAR}-00001`));
      await expectPgViolation(
        db.insert(timesheetPeriods).values({
          code: `TS-${YEAR}-90001`,
          userId: member[0].id,
          periodStart: period[0].periodStart,
          periodEnd: TODAY,
        }),
        "23505",
      );
    } finally {
      await pool.end();
    }
  });

  it("duration_minutes >0：零/负分钟必败；非项目活动类型 check 生效", async () => {
    const { db, pool } = await openDb();
    try {
      const period = await db
        .select({ id: timesheetPeriods.id })
        .from(timesheetPeriods)
        .where(eq(timesheetPeriods.code, `TS-${YEAR}-00001`));
      const member = await db.select({ id: users.id }).from(users).where(eq(users.email, "guanchen@lexflow.demo"));
      const projectA = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      const base = {
        periodId: period[0].id,
        userId: member[0].id,
        workDate: TODAY,
        durationMinutes: 0,
        activityType: "professional_work" as const,
      };
      await expectPgViolation(db.insert(timeEntries).values(base), "23514");
      await expectPgViolation(
        db.insert(timeEntries).values({ ...base, durationMinutes: -30 }),
        "23514",
      );

      // 非项目工作可空 project_id，但活动类型必须为 internal_admin/other
      await expectPgViolation(
        db.insert(timeEntries).values({
          periodId: period[0].id,
          userId: member[0].id,
          projectId: null,
          workDate: TODAY,
          durationMinutes: 60,
          activityType: "professional_work",
        }),
        "23514",
      );
      await expect(
        db
          .insert(timeEntries)
          .values({
            periodId: period[0].id,
            userId: member[0].id,
            projectId: null,
            workDate: TODAY,
            durationMinutes: 60,
            activityType: "other",
          })
          .returning({ id: timeEntries.id }),
      ).resolves.toHaveLength(1);

      // 有 project_id 时任意活动类型可写
      await expect(
        db
          .insert(timeEntries)
          .values({
            periodId: period[0].id,
            userId: member[0].id,
            projectId: projectA[0].id,
            workDate: TODAY,
            durationMinutes: 45,
            activityType: "meeting",
            source: "copy",
          })
          .returning({ id: timeEntries.id }),
      ).resolves.toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("枚举值可写：timesheet_status 五态与 time_entry_source 四态", async () => {
    const { db, pool } = await openDb();
    try {
      const member = await db.select({ id: users.id }).from(users).where(eq(users.email, "guanchen@lexflow.demo"));
      const statuses = ["draft", "pending_approval", "approved", "returned", "locked"] as const;
      for (const [i, status] of statuses.entries()) {
        await expect(
          db
            .insert(timesheetPeriods)
            .values({
              code: `TS-${YEAR}-9001${i}`,
              userId: member[0].id,
              periodStart: `2027-01-0${i + 1}`,
              periodEnd: `2027-01-0${i + 7}`,
              status,
            })
            .returning({ id: timesheetPeriods.id }),
        ).resolves.toHaveLength(1);
      }
      const sources = ["manual", "prefill_meeting", "prefill_travel", "copy"] as const;
      for (const [i, source] of sources.entries()) {
        const period = await db
          .insert(timesheetPeriods)
          .values({
            code: `TS-${YEAR}-9002${i}`,
            userId: member[0].id,
            periodStart: `2027-02-1${i}`,
            periodEnd: `2027-02-2${i}`,
          })
          .returning({ id: timesheetPeriods.id });
        await expect(
          db
            .insert(timeEntries)
            .values({
              periodId: period[0].id,
              userId: member[0].id,
              projectId: null,
              workDate: `2027-02-1${i}`,
              durationMinutes: 30,
              activityType: "other",
              source,
            })
            .returning({ id: timeEntries.id }),
        ).resolves.toHaveLength(1);
      }
    } finally {
      await pool.end();
    }
  });

  it("存量放宽落地：archive_links fv 空允许 funding/expense 纯来源对", async () => {
    const { db, pool } = await openDb();
    try {
      const projectA = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      const dir11 = await db
        .select({ id: archiveDirectories.id })
        .from(archiveDirectories)
        .where(
          and(eq(archiveDirectories.projectId, projectA[0].id), eq(archiveDirectories.dirKey, "11_预算与经费")),
        );
      // 用未归集的经费/目录组合，避免与 closure 种子已建链接撞唯一约束
      const funding = await db
        .select({ id: schema.fundingRequests.id })
        .from(schema.fundingRequests)
        .where(eq(schema.fundingRequests.code, `FND-${YEAR}-00002`));
      const expense = await db
        .select({ id: schema.expenseReports.id })
        .from(schema.expenseReports)
        .where(eq(schema.expenseReports.code, `EXP-${YEAR}-00001`));
      const dir04 = await db
        .select({ id: archiveDirectories.id })
        .from(archiveDirectories)
        .where(
          and(eq(archiveDirectories.projectId, projectA[0].id), eq(archiveDirectories.dirKey, "04_质量检查与问题")),
        );

      await expect(
        db
          .insert(archiveLinks)
          .values({
            projectId: projectA[0].id,
            directoryId: dir11[0].id,
            sourceType: "funding",
            sourceId: funding[0].id,
            businessDate: TODAY,
          })
          .returning({ id: archiveLinks.id }),
      ).resolves.toHaveLength(1);
      await expect(
        db
          .insert(archiveLinks)
          .values({
            projectId: projectA[0].id,
            directoryId: dir04[0].id,
            sourceType: "expense",
            sourceId: expense[0].id,
            businessDate: TODAY,
          })
          .returning({ id: archiveLinks.id }),
      ).resolves.toHaveLength(1);
    } finally {
      await pool.end();
    }
  });
});
