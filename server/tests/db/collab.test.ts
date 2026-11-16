import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import {
  accessGrants,
  approvalPolicies,
  archiveDirectories,
  archiveLinks,
  meetingMinutes,
  meetingParticipants,
  meetingActionItems,
  meetings,
  notifications,
  projects,
  travelEvents,
  travelRequests,
  travelSegments,
  users,
} from "../../src/db/schema";
import { ALL_TABLES, migrateFresh, TEST_DATABASE_URL } from "./helpers";

const YEAR = new Date().getFullYear();
const NOW = new Date().toISOString();
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

describe("会议与出差种子及约束", () => {
  it("干净库重放后会议/出差种子齐备，二次执行行数不变", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const counts = await countRows();
    expect(counts.meetings).toBe(3);
    expect(counts.meeting_participants).toBe(11);
    expect(counts.meeting_minutes).toBe(2);
    expect(counts.meeting_action_items).toBe(2);
    expect(counts.travel_requests).toBe(2);
    expect(counts.travel_segments).toBe(5);
    expect(counts.travel_events).toBe(5);
    expect(counts.approval_policies).toBe(13); // 迭代 1 三条 + 迭代 2 四条 + 迭代 3 五条 + timesheet 占位
    expect(counts.code_sequences).toBe(25); // 19 + LD/OPP/CTR + AR/INV（9c/9d）+ CF（20）

    // 行动项转换双向定位 + 会议状态/纪要状态分离
    const { db, pool } = await openDb();
    try {
      const converted = await db
        .select({
          title: meetingActionItems.title,
          status: meetingActionItems.status,
          taskId: meetingActionItems.convertedTaskId,
          taskSourceType: schema.tasks.sourceType,
        })
        .from(meetingActionItems)
        .innerJoin(schema.tasks, eq(schema.tasks.id, meetingActionItems.convertedTaskId));
      expect(converted).toHaveLength(1);
      expect(converted[0].status).toBe("converted");
      expect(converted[0].taskSourceType).toBe("meeting");

      const m3 = await db
        .select({ status: meetings.status, minutesStatus: meetings.minutesStatus })
        .from(meetings)
        .where(eq(meetings.code, `MTG-${YEAR}-00003`));
      expect(m3[0]).toEqual({ status: "completed", minutesStatus: "confirmed" });

      const trv1 = await db
        .select({ status: travelRequests.status, segmentCount: travelRequests.code })
        .from(travelRequests)
        .where(eq(travelRequests.code, `TRV-${YEAR}-00001`));
      expect(trv1[0].status).toBe("approved");
    } finally {
      await pool.end();
    }

    await runSeed(TEST_DATABASE_URL);
    const before = await countRows();
    await runSeed(TEST_DATABASE_URL);
    const after = await countRows();
    expect(after).toEqual(before);
  });

  it("meetings end_at > start_at（DB check；时间倒挂必败）", async () => {
    const { db, pool } = await openDb();
    try {
      const project = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      const pm = await db.select({ id: users.id }).from(users).where(eq(users.email, "wangbaozhuo@lexflow.demo"));
      const base = {
        projectId: project[0].id,
        code: `MTG-${YEAR}-90001`,
        type: "project" as const,
        subject: "时间倒挂测试会议",
        startAt: NOW,
        endAt: NOW,
        organizerId: pm[0].id,
      };
      await expectPgViolation(db.insert(meetings).values(base), "23514");
      await expectPgViolation(
        db.insert(meetings).values({ ...base, code: `MTG-${YEAR}-90002`, endAt: new Date(Date.now() - 3600_000).toISOString() }),
        "23514",
      );
      await expect(
        db.insert(meetings).values({ ...base, code: `MTG-${YEAR}-90003`, endAt: new Date(Date.now() + 3600_000).toISOString() }).returning({ id: meetings.id }),
      ).resolves.toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("参与人二态 check + 部分唯一索引", async () => {
    const { db, pool } = await openDb();
    try {
      const m1 = await db
        .select({ id: meetings.id })
        .from(meetings)
        .where(eq(meetings.code, `MTG-${YEAR}-00001`));
      const meetingId = m1[0].id;

      // 两空：user_id 与 external_name 都空 → 必败
      await expectPgViolation(db.insert(meetingParticipants).values({ meetingId }), "23514");
      // 两非空：既是内部又是外部 → 必败
      const pm = await db.select({ id: users.id }).from(users).where(eq(users.email, "wangbaozhuo@lexflow.demo"));
      await expectPgViolation(
        db.insert(meetingParticipants).values({ meetingId, userId: pm[0].id, externalName: "张三" }),
        "23514",
      );
      // 同会同人重复 → 部分唯一必败（pm 已是 00001 参与人）
      await expectPgViolation(
        db.insert(meetingParticipants).values({ meetingId, userId: pm[0].id }),
        "23505",
      );
      // 合法外部参与人可插
      await expect(
        db
          .insert(meetingParticipants)
          .values({ meetingId, externalName: "外部参与人甲", externalOrg: "示例单位" })
          .returning({ id: meetingParticipants.id }),
      ).resolves.toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("meeting_minutes unique(meeting_id, version_no)（版本链防重）", async () => {
    const { db, pool } = await openDb();
    try {
      const m2 = await db
        .select({ id: meetings.id })
        .from(meetings)
        .where(eq(meetings.code, `MTG-${YEAR}-00002`));
      const member = await db.select({ id: users.id }).from(users).where(eq(users.email, "guanchen@lexflow.demo"));
      const existing = await db
        .select({ versionNo: meetingMinutes.versionNo })
        .from(meetingMinutes)
        .where(eq(meetingMinutes.meetingId, m2[0].id));
      await expectPgViolation(
        db.insert(meetingMinutes).values({
          meetingId: m2[0].id,
          versionNo: existing[0].versionNo,
          body: "重复版本号",
          recorderId: member[0].id,
        }),
        "23505",
      );
      // 新版本号可插
      await expect(
        db
          .insert(meetingMinutes)
          .values({
            meetingId: m2[0].id,
            versionNo: existing[0].versionNo + 1,
            body: "确认后修改生成的新版本草稿（种子外测试行）",
            recorderId: member[0].id,
          })
          .returning({ id: meetingMinutes.id }),
      ).resolves.toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("存量修订四条逐项生效", async () => {
    const { db, pool } = await openDb();
    try {
      // ① access_grant_status 增 rejected 可写
      const member = await db.select({ id: users.id }).from(users).where(eq(users.email, "guanchen@lexflow.demo"));
      const pm = await db.select({ id: users.id }).from(users).where(eq(users.email, "wangbaozhuo@lexflow.demo"));
      await expect(
        db
          .insert(accessGrants)
          .values({
            granteeId: member[0].id,
            scopeType: "file",
            scopeId: "22222222-2222-2222-2222-222222222222",
            actions: ["read"],
            status: "rejected",
            grantedBy: pm[0].id,
          })
          .returning({ id: accessGrants.id }),
      ).resolves.toHaveLength(1);

      // ② notifications 聚合键部分唯一：同接收人同键必败、null 键可重复
      await expect(
        db
          .insert(notifications)
          .values({ recipientId: member[0].id, eventType: "meeting_starting", sourceType: "meeting", sourceId: null })
          .returning({ id: notifications.id }),
      ).resolves.toHaveLength(1);
      await expectPgViolation(
        db.insert(notifications).values([
          { recipientId: member[0].id, eventType: "task_due_soon", sourceType: "task", sourceId: null, aggregateKey: "agg-test-1" },
          { recipientId: member[0].id, eventType: "task_due_soon", sourceType: "task", sourceId: null, aggregateKey: "agg-test-1" },
        ]),
        "23505",
      );
      await expect(
        db
          .insert(notifications)
          .values([
            { recipientId: member[0].id, eventType: "task_overdue", sourceType: "task", sourceId: null, aggregateKey: null },
            { recipientId: member[0].id, eventType: "task_overdue", sourceType: "task", sourceId: null, aggregateKey: null },
          ])
          .returning({ id: notifications.id }),
      ).resolves.toHaveLength(2);

      // ③ approval_steps.acted_idempotency_key 列存在
      const column = await db.execute(
        `SELECT count(*)::int AS n FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'approval_steps' AND column_name = 'acted_idempotency_key'`,
      );
      expect((column.rows[0] as { n: number }).n).toBe(1);

      // ④ archive_links 二态放宽：meeting/travel 来源可插，task 来源仍拒
      const project = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      const dir = await db
        .select({ id: archiveDirectories.id })
        .from(archiveDirectories)
        .where(
          and(eq(archiveDirectories.projectId, project[0].id), eq(archiveDirectories.dirKey, "09_会议纪要与协同")),
        );
      const base = { projectId: project[0].id, directoryId: dir[0].id, sourceId: "33333333-3333-3333-3333-333333333333" };
      await expect(
        db.insert(archiveLinks).values({ ...base, sourceType: "meeting", businessDate: TODAY }).returning({ id: archiveLinks.id }),
      ).resolves.toHaveLength(1);
      await expect(
        db.insert(archiveLinks).values({ ...base, sourceType: "travel", sourceId: "44444444-4444-4444-4444-444444444444", businessDate: TODAY }).returning({ id: archiveLinks.id }),
      ).resolves.toHaveLength(1);
      await expectPgViolation(
        db.insert(archiveLinks).values({ ...base, sourceType: "task" }),
        "23514",
      );
    } finally {
      await pool.end();
    }
  });

  it("出差策略种子覆盖会签/超阈值/默认/变更（arch/05 §7）", async () => {
    const { db, pool } = await openDb();
    try {
      const policies = await db
        .select({ bizType: approvalPolicies.bizType, priority: approvalPolicies.priority, matchJson: approvalPolicies.matchJson, stepsJson: approvalPolicies.stepsJson })
        .from(approvalPolicies)
        .where(eq(approvalPolicies.bizType, "travel"));
      expect(policies).toHaveLength(3);
      const borrow = policies.find((p) => p.priority === 10);
      expect(borrow?.matchJson).toEqual({ borrow: true });
      expect(borrow?.stepsJson).toEqual([
        { approver_role: "project_manager" },
        { approver_role: "finance", countersign: "all" },
      ]);
      const threshold = policies.find((p) => p.priority === 20);
      expect(threshold?.matchJson).toEqual({ min_estimated_cost_cents: 5000000 });
      expect(threshold?.stepsJson).toEqual([{ approver_role: "project_manager" }, { approver_role: "partner" }]);
      const changePolicy = await db
        .select({ bizType: approvalPolicies.bizType })
        .from(approvalPolicies)
        .where(eq(approvalPolicies.bizType, "travel_change"));
      expect(changePolicy).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });
});
