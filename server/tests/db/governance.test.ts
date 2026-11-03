import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import { archiveDirectories, archiveLinks, fileObjects, fileVersions, planVersions, projects } from "../../src/db/schema";
import { ALL_TABLES, migrateFresh, TEST_DATABASE_URL } from "./helpers";

const YEAR = new Date().getFullYear();

type Db = NodePgDatabase<typeof schema>;

interface DbHandle {
  db: Db;
  pool: pg.Pool;
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

describe("治理域种子与约束", () => {
  it("干净库重放后治理种子齐备，二次执行行数不变", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const counts = await countRows();
    expect(counts.project_templates).toBe(2);
    expect(counts.approval_policies).toBe(13); // 迭代 1 三条 + 迭代 2 四条 + 迭代 3 五条 + timesheet 占位（arch/07 §2）
    expect(counts.stages).toBe(6); // A×4 + B×2（C/D/E 最小结构不设阶段）
    expect(counts.milestones).toBe(3);
    expect(counts.tasks).toBe(12); // A×8 + B×3 + 会议行动项转换任务×1
    expect(counts.plan_versions).toBe(2); // A/B 各 v1（C/D/E 最小结构不设计划版本）
    expect(counts.plan_items).toBe(20); // A: 4+3+8；B: 2+3
    expect(counts.deliverables).toBe(3);
    expect(counts.quality_check_items).toBe(4);
    expect(counts.quality_issues).toBe(2);
    expect(counts.quality_issue_events).toBe(7); // severe 3 + minor 4
    expect(counts.decisions).toBe(1);
    expect(counts.weekly_reports).toBe(1);
    expect(counts.archive_directories).toBe(55); // 5 个项目各十一项（index 统一建，§12.1）
    expect(counts.archive_links).toBe(6); // 项目 A 归档链：report/meeting/travel/funding/expense 来源 + 票据文件链接（arch/08 §7）
    expect(counts.change_requests).toBe(0);
    expect(counts.approval_instances).toBe(0);
    expect(counts.approval_steps).toBe(0);

    await runSeed(TEST_DATABASE_URL);
    const before = await countRows();
    await runSeed(TEST_DATABASE_URL);
    const after = await countRows();
    expect(after).toEqual(before);
  });

  it("plan_versions 每项目恰一个 active（部分唯一索引生效）", async () => {
    const { db, pool } = await openDb();
    try {
      const project = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      const projectId = project[0].id;

      // 同项目双 active 必败
      await expectPgViolation(
        db.insert(planVersions).values({
          projectId,
          versionNo: 2,
          kind: "change",
          status: "active",
        }),
        "23505",
      );

      // 旧版本 superseded 后新 active 可建（PLN-I1 变更路径）
      await db
        .update(planVersions)
        .set({ status: "superseded" })
        .where(and(eq(planVersions.projectId, projectId), eq(planVersions.versionNo, 1)));
      await expect(
        db
          .insert(planVersions)
          .values({ projectId, versionNo: 2, kind: "change", status: "active" })
          .returning({ id: planVersions.id }),
      ).resolves.toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("archive_links 二态 check：两空/两非空必败，两种合法形态可通过", async () => {
    const { db, pool } = await openDb();
    try {
      const project = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      const projectId = project[0].id;
      const dir = await db
        .select({ id: archiveDirectories.id })
        .from(archiveDirectories)
        .where(
          and(eq(archiveDirectories.projectId, projectId), eq(archiveDirectories.dirKey, "03_过程文件")),
        );
      const directoryId = dir[0].id;

      // 文件链接需要的文件版本
      const fileObject = await db.insert(fileObjects).values({}).returning({ id: fileObjects.id });
      const fileVersion = await db
        .insert(fileVersions)
        .values({
          fileObjectId: fileObject[0].id,
          versionNo: 1,
          storageKey: `governance-test-${YEAR}-00001`,
          sizeBytes: 1,
          mimeType: "text/plain",
          sha256: "governance-test-sha256",
        })
        .returning({ id: fileVersions.id });
      const fileVersionId = fileVersion[0].id;
      const sourceId = "11111111-1111-1111-1111-111111111111";

      // 两空：既无文件也无来源 → 必败
      await expectPgViolation(db.insert(archiveLinks).values({ projectId, directoryId }), "23514");

      // 结构化来源但 source_type 不在放宽集（report/meeting/travel）内 → 必败
      await expectPgViolation(
        db.insert(archiveLinks).values({ projectId, directoryId, sourceType: "task", sourceId }),
        "23514",
      );

      // 两非空：文件链接叠 report 来源（既是文件又是报告链接）→ 必败
      await expectPgViolation(
        db.insert(archiveLinks).values({
          projectId,
          directoryId,
          fileVersionId,
          sourceType: "report",
          sourceId,
        }),
        "23514",
      );

      // 合法：文件链接（fv + 非 report 来源对）
      await expect(
        db
          .insert(archiveLinks)
          .values({ projectId, directoryId, fileVersionId, sourceType: "task", sourceId })
          .returning({ id: archiveLinks.id }),
      ).resolves.toHaveLength(1);

      // 合法：报告链接（fv 空 + source_type='report'）
      await expect(
        db
          .insert(archiveLinks)
          .values({
            projectId,
            directoryId: (
              await db
                .select({ id: archiveDirectories.id })
                .from(archiveDirectories)
                .where(
                  and(eq(archiveDirectories.projectId, projectId), eq(archiveDirectories.dirKey, "06_周报与月报")),
                )
            )[0].id,
            sourceType: "report",
            sourceId,
          })
          .returning({ id: archiveLinks.id }),
      ).resolves.toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("file_versions.idempotency_key 唯一约束生效（可空，同键必败）", async () => {
    const { db, pool } = await openDb();
    try {
      const fileObject = await db.insert(fileObjects).values({}).returning({ id: fileObjects.id });
      const base = (suffix: string) => ({
        fileObjectId: fileObject[0].id,
        versionNo: 99,
        storageKey: `idem-test-${YEAR}-${suffix}`,
        sizeBytes: 1,
        mimeType: "text/plain",
        sha256: `idem-test-sha256-${suffix}`,
      });
      await expect(
        db.insert(fileVersions).values({ ...base("a"), idempotencyKey: "upload-key-1" }).returning({ id: fileVersions.id }),
      ).resolves.toHaveLength(1);
      await expectPgViolation(
        db.insert(fileVersions).values({ ...base("b"), versionNo: 100, idempotencyKey: "upload-key-1" }),
        "23505",
      );
      // null 幂等键不冲突（D2：可选键）
      await expect(
        db.insert(fileVersions).values({ ...base("c"), versionNo: 101, idempotencyKey: null }).returning({ id: fileVersions.id }),
      ).resolves.toHaveLength(1);
      await expect(
        db.insert(fileVersions).values({ ...base("d"), versionNo: 102, idempotencyKey: null }).returning({ id: fileVersions.id }),
      ).resolves.toHaveLength(1);
    } finally {
      await pool.end();
    }
  });
});
