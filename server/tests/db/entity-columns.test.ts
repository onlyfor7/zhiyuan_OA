import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import { clients, flowDefinitions, matters, projects, users } from "../../src/db/schema";
import { migrateFresh, TEST_DATABASE_URL } from "./helpers";

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

/**
 * 与 drizzle/0008_iter6-entity-columns.sql 尾部回填段同文（测试内复刻以验证语义；
 * 迁移本身在 migrateFresh 重放时已对空键幂等无操作）。
 */
const BACKFILL_STATEMENTS = [
  `UPDATE "public"."clients" SET "status" = 'disabled'
   WHERE EXISTS (
     SELECT 1 FROM "public"."system_config"
     WHERE "key" = 'admin.disabled_clients' AND "value_json" @> jsonb_build_array("clients"."id"::text)
   )`,
  `UPDATE "public"."matters" SET "status" = 'disabled'
   WHERE EXISTS (
     SELECT 1 FROM "public"."system_config"
     WHERE "key" = 'admin.disabled_matters' AND "value_json" @> jsonb_build_array("matters"."id"::text)
   )`,
  `UPDATE "public"."users" SET "must_change_password" = true
   WHERE EXISTS (
     SELECT 1 FROM "public"."system_config"
     WHERE "key" = 'auth.must_change_password' AND "value_json" -> "users"."id"::text = 'true'::jsonb
   )`,
  `DELETE FROM "public"."system_config" WHERE "key" IN ('admin.disabled_clients', 'admin.disabled_matters', 'auth.must_change_password')`,
];

describe("02b 实体状态列与流程项目绑定", () => {
  it("重放后四列就位：默认 active/false，临时配置键已不存在，种子幂等", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const { db, pool } = await openDb();
    try {
      const clientStatuses = await db.select({ status: clients.status }).from(clients);
      expect(clientStatuses.every((c) => c.status === "active")).toBe(true);
      const matterStatuses = await db.select({ status: matters.status }).from(matters);
      expect(matterStatuses.every((m) => m.status === "active")).toBe(true);
      const flags = await db.select({ mustChangePassword: users.mustChangePassword }).from(users);
      expect(flags.every((u) => u.mustChangePassword === false)).toBe(true);

      const tempKeys = await db
        .select({ key: schema.systemConfig.key })
        .from(schema.systemConfig)
        .where(
          sql`${schema.systemConfig.key} in ('admin.disabled_clients', 'admin.disabled_matters', 'auth.must_change_password')`,
        );
      expect(tempKeys).toHaveLength(0);

      // 种子二次执行行数与状态集不变
      await runSeed(TEST_DATABASE_URL);
      const after = await db.select({ status: clients.status }).from(clients);
      expect(after.every((c) => c.status === "active")).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("回填等价：临时键 JSON → 行状态，回填后状态集与原 JSON 一致且键被删除", async () => {
    const { db, pool } = await openDb();
    try {
      const pm = await db.select({ id: users.id }).from(users).where(eq(users.email, "pm@lexflow.demo"));
      const client2 = await db.select({ id: clients.id }).from(clients).where(eq(clients.code, `CLT-${YEAR}-00002`));
      const matter2 = await db
        .select({ id: matters.id })
        .from(matters)
        .where(eq(matters.code, `MTR-${YEAR}-00002`));
      const testUser = await db
        .insert(users)
        .values({
          email: "backfill-test@lexflow.demo",
          name: "回填测试",
          passwordHash: "scrypt$1$1$1$aa$bb",
        })
        .returning({ id: users.id });

      // 预置临时键（后端 03 的暂存形态：停用清单=uuid 数组，改密标记={userId:true} 对象）
      await db.insert(schema.systemConfig).values({
        key: "admin.disabled_clients",
        valueJson: [client2[0].id] as unknown as Record<string, unknown>,
      });
      await db.insert(schema.systemConfig).values({
        key: "admin.disabled_matters",
        valueJson: [matter2[0].id] as unknown as Record<string, unknown>,
      });
      await db.insert(schema.systemConfig).values({
        key: "auth.must_change_password",
        valueJson: { [testUser[0].id]: true },
      });

      for (const statement of BACKFILL_STATEMENTS) {
        await db.execute(sql.raw(statement));
      }

      // 状态集与 JSON 一致
      const clientAfter = await db.select({ status: clients.status }).from(clients).where(eq(clients.id, client2[0].id));
      expect(clientAfter[0].status).toBe("disabled");
      const matterAfter = await db.select({ status: matters.status }).from(matters).where(eq(matters.id, matter2[0].id));
      expect(matterAfter[0].status).toBe("disabled");
      const userAfter = await db
        .select({ mustChangePassword: users.mustChangePassword })
        .from(users)
        .where(eq(users.id, testUser[0].id));
      expect(userAfter[0].mustChangePassword).toBe(true);
      // 未在清单内的行保持默认
      const untouched = await db.select({ status: clients.status }).from(clients).where(eq(clients.code, `CLT-${YEAR}-00001`));
      expect(untouched[0].status).toBe("active");
      // 临时键已删除
      const keysAfter = await db
        .select({ key: schema.systemConfig.key })
        .from(schema.systemConfig)
        .where(
          sql`${schema.systemConfig.key} in ('admin.disabled_clients', 'admin.disabled_matters', 'auth.must_change_password')`,
        );
      expect(keysAfter).toHaveLength(0);
    } finally {
      await pool.end();
    }
  });

  it("flow_definitions 项目绑定：每 (biz_binding, 项目) 组合恰一 enabled；FK RESTRICT", async () => {
    const { db, pool } = await openDb();
    try {
      const projectA = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      const emptyDef = { nodes: [{ id: "start", type: "start" }, { id: "end", type: "end" }], edges: [{ from: "start", to: "end" }] };

      // 同 biz_binding 双 enabled（均 null 项目 = 同一组合）→ 23505
      await expectPgViolation(
        db.insert(flowDefinitions).values([
          { name: "f1 流程", scope: "global", bizBinding: "generic_request", versionNo: 1, definitionJson: emptyDef, enabled: true },
          { name: "f2 流程", scope: "global", bizBinding: "generic_request", versionNo: 1, definitionJson: emptyDef, enabled: true },
        ]),
        "23505",
      );
      // 同 biz 不同项目组合（null 与 A）→ 可共存
      await expect(
        db.insert(flowDefinitions).values([
          { name: "f3 流程", scope: "project", bizBinding: "generic_request", projectId: projectA[0].id, versionNo: 1, definitionJson: emptyDef, enabled: true },
          { name: "f4 流程", scope: "global", bizBinding: "generic_request", versionNo: 1, definitionJson: emptyDef, enabled: true },
        ]).returning({ id: flowDefinitions.id }),
      ).resolves.toHaveLength(2);
      // 同 biz 同项目双 enabled → 23505
      await expectPgViolation(
        db.insert(flowDefinitions).values({
          name: "f5 流程",
          scope: "project",
          bizBinding: "generic_request",
          projectId: projectA[0].id,
          versionNo: 1,
          definitionJson: emptyDef,
          enabled: true,
        }),
        "23505",
      );
      // 项目 FK：不存在的项目 → 23503
      await expectPgViolation(
        db.insert(flowDefinitions).values({
          name: "f6 流程",
          scope: "project",
          bizBinding: "generic_request",
          projectId: "00000000-0000-0000-0000-000000000000",
          versionNo: 1,
          definitionJson: emptyDef,
        }),
        "23503",
      );
      // 九条种子默认流程（null 项目）在新索引下互不冲突且仍唯一生效
      const enabledDefaults = await db
        .select({ name: flowDefinitions.name })
        .from(flowDefinitions)
        .where(and(eq(flowDefinitions.enabled, true), sql`${flowDefinitions.projectId} is null`));
      expect(enabledDefaults).toHaveLength(9);
    } finally {
      await pool.end();
    }
  });
});
