import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import { timeEntries, timesheetPeriods, users } from "../../src/db/schema";
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

async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as { cause?: { code?: string } },
  );
  expect(error).not.toBeNull();
  expect(error?.cause?.code).toBe(code);
}

describe("迭代 5 收口加固与全链种子", () => {
  it("时刻列（arch/07 §4.1 v1.1 收口=加列）：可空、范围与先后 check 生效", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const { db, pool } = await openDb();
    try {
      const member = await db.select({ id: users.id }).from(users).where(eq(users.email, "member@lexflow.demo"));
      const period = await db
        .select({ id: timesheetPeriods.id })
        .from(timesheetPeriods)
        .where(eq(timesheetPeriods.code, `TS-${YEAR}-00001`));
      const base = {
        periodId: period[0].id,
        userId: member[0].id,
        projectId: null,
        workDate: TODAY,
        durationMinutes: 60,
        activityType: "other" as const,
      };
      // 成对时刻可写
      await expect(
        db.insert(timeEntries).values({ ...base, startMinute: 540, endMinute: 600 }).returning({ id: timeEntries.id }),
      ).resolves.toHaveLength(1);
      // 单行可写
      await expect(
        db.insert(timeEntries).values({ ...base, startMinute: 0 }).returning({ id: timeEntries.id }),
      ).resolves.toHaveLength(1);
      // end <= start 必败
      await expectPgError(
        db.insert(timeEntries).values({ ...base, startMinute: 600, endMinute: 600 }),
        "23514",
      );
      // 越界必败
      await expectPgError(db.insert(timeEntries).values({ ...base, startMinute: 1500 }), "23514");
      await expectPgError(db.insert(timeEntries).values({ ...base, endMinute: 0 }), "23514");
    } finally {
      await pool.end();
    }
  });

  it("audit_events/budget_ledger 触发器只追加：UPDATE/DELETE 必败（P0001），INSERT 正常", async () => {
    const { db, pool } = await openDb();
    try {
      const audit = await db.select({ id: schema.auditEvents.id }).from(schema.auditEvents).limit(1);
      if (audit[0]) {
        await expectPgError(
          db.execute(sql`UPDATE audit_events SET action = 'tamper' WHERE id = ${audit[0].id}`),
          "P0001",
        );
        await expectPgError(db.execute(sql`DELETE FROM audit_events WHERE id = ${audit[0].id}`), "P0001");
      }
      // INSERT 仍可用（只追加语义）
      await expect(
        db
          .insert(schema.auditEvents)
          .values({ action: "test.append", targetType: "test", targetId: null, result: "success" })
          .returning({ id: schema.auditEvents.id }),
      ).resolves.toHaveLength(1);

      const ledger = await db.select({ id: schema.budgetLedger.id }).from(schema.budgetLedger).limit(1);
      if (ledger[0]) {
        await expectPgError(
          db.execute(sql`UPDATE budget_ledger SET actual_delta_cents = 1 WHERE id = ${ledger[0].id}`),
          "P0001",
        );
        await expectPgError(db.execute(sql`DELETE FROM budget_ledger WHERE id = ${ledger[0].id}`), "P0001");
      }
    } finally {
      await pool.end();
    }
  });

  it("项目 A 全链闭环可追溯：出差→经费→报销→核销→归档→授权（arch/08 §7）", async () => {
    const { db, pool } = await openDb();
    try {
      const projectA = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.code, `PRJ-${YEAR}-00001`));
      const projectAId = projectA[0].id;

      // 1) 计划基线
      const plan = await db
        .select({ id: schema.planVersions.id })
        .from(schema.planVersions)
        .where(and(eq(schema.planVersions.projectId, projectAId), eq(schema.planVersions.status, "active")));
      expect(plan).toHaveLength(1);

      // 2) 会议→纪要→行动项（其一转任务）
      const meeting3 = await db
        .select({ id: schema.meetings.id })
        .from(schema.meetings)
        .where(eq(schema.meetings.code, `MTG-${YEAR}-00003`));
      const minutes = await db
        .select({ id: schema.meetingMinutes.id })
        .from(schema.meetingMinutes)
        .where(eq(schema.meetingMinutes.meetingId, meeting3[0].id));
      expect(minutes).toHaveLength(1);
      const converted = await db
        .select({ taskId: schema.meetingActionItems.convertedTaskId })
        .from(schema.meetingActionItems)
        .where(eq(schema.meetingActionItems.meetingId, meeting3[0].id));
      expect(converted.filter((c) => c.taskId !== null)).toHaveLength(1);

      // 3) 出差→经费→报销→核销台账
      const travel1 = await db
        .select({ id: schema.travelRequests.id })
        .from(schema.travelRequests)
        .where(eq(schema.travelRequests.code, `TRV-${YEAR}-00001`));
      const fnd3 = await db
        .select({ id: schema.fundingRequests.id, usageStatus: schema.fundingRequests.usageStatus })
        .from(schema.fundingRequests)
        .where(eq(schema.fundingRequests.code, `FND-${YEAR}-00003`));
      expect(fnd3[0].usageStatus).toBe("partially_used");
      const exp2 = await db
        .select({ id: schema.expenseReports.id, status: schema.expenseReports.status })
        .from(schema.expenseReports)
        .where(eq(schema.expenseReports.code, `EXP-${YEAR}-00002`));
      expect(exp2[0].status).toBe("paid");
      const ledger = await db
        .select({ entryType: schema.budgetLedger.entryType, reserved: schema.budgetLedger.reservedDeltaCents, actual: schema.budgetLedger.actualDeltaCents })
        .from(schema.budgetLedger)
        .where(eq(schema.budgetLedger.projectId, projectAId));
      const net = (type: string, field: "reserved" | "actual") =>
        ledger.filter((l) => l.entryType === type).reduce((sum, l) => sum + Number(l[field]), 0);
      expect(net("FUNDING_RESERVED", "reserved")).toBe(3000000); // 2M + 1M
      expect(net("FUNDING_RELEASED", "reserved")).toBe(-800000);
      expect(net("EXPENSE_RECOGNIZED", "actual")).toBe(800000);

      // 4) 归档链：报告/会议/出差/经费/费用 + 票据文件
      const links = await db
        .select({ sourceType: schema.archiveLinks.sourceType })
        .from(schema.archiveLinks)
        .where(eq(schema.archiveLinks.projectId, projectAId));
      const linkTypes = links.map((l) => l.sourceType).sort();
      expect(linkTypes).toEqual(["expense", "expense", "funding", "meeting", "report", "travel"]);

      // 5) 授权：viewer 对 A 目录 06 有效只读授权（未到期）
      const dir06 = await db
        .select({ id: schema.archiveDirectories.id })
        .from(schema.archiveDirectories)
        .where(
          and(eq(schema.archiveDirectories.projectId, projectAId), eq(schema.archiveDirectories.dirKey, "06_周报与月报")),
        );
      const grant = await db
        .select({ status: schema.accessGrants.status, actions: schema.accessGrants.actions })
        .from(schema.accessGrants)
        .where(
          and(eq(schema.accessGrants.scopeType, "directory"), eq(schema.accessGrants.scopeId, dir06[0].id)),
        );
      expect(grant).toHaveLength(1);
      expect(grant[0].status).toBe("active");
      expect(grant[0].actions).toEqual(["read"]);

      // 6) 工时口径：member 本周 draft / 上周 approved（不计 locked——pm 周期 C 归属 pm）
      const memberPeriods = await db
        .select({ status: timesheetPeriods.status })
        .from(timesheetPeriods)
        .innerJoin(users, eq(users.id, timesheetPeriods.userId))
        .where(eq(users.email, "member@lexflow.demo"));
      expect(memberPeriods.map((p) => p.status).sort()).toEqual(["approved", "draft"]);
    } finally {
      await pool.end();
    }
  });
});

