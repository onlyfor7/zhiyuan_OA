import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import { companyProfile, orgUnits, users } from "../../src/db/schema";
import { migrateFresh, TEST_DATABASE_URL } from "./helpers";

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

/** 与 0010 迁移尾部同文的部门 sort 回填（测试内复刻验证语义） */
const SORT_BACKFILL = `UPDATE "public"."org_units" SET "sort" = CASE "name"
  WHEN '诉讼业务部' THEN 1
  WHEN '非诉业务部' THEN 2
  WHEN '综合管理部' THEN 3
  ELSE 0
END WHERE "sort" = 0`;

describe("9b-01 组织数据建模（arch/12 §9/§10）", () => {
  it("干净库重放：company_profile 单记录（因诺智元）、org 树化、22 用户职位/工号/入职齐备；二次执行幂等", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const { db, pool } = await openDb();
    try {
      // 公司信息：恰一行且为因诺智元默认行
      const profile = await db.select().from(companyProfile);
      expect(profile).toHaveLength(1);
      expect(profile[0].name).toBe("因诺智元");
      expect(profile[0].creditCode.length).toBeGreaterThan(0);

      // org 树：1 根（sort 0）+ 3 部门挂根下 sort 1..3，parent_id 自引用在位
      const root = await db.select().from(orgUnits).where(isNull(orgUnits.parentId));
      expect(root).toHaveLength(1);
      expect(root[0].sort).toBe(0);
      const depts = await db
        .select({ name: orgUnits.name, parentId: orgUnits.parentId, sort: orgUnits.sort })
        .from(orgUnits)
        .where(sql`${orgUnits.parentId} is not null`)
        .orderBy(orgUnits.sort);
      expect(depts.map((d) => [d.name, d.sort])).toEqual([
        ["诉讼业务部", 1],
        ["非诉业务部", 2],
        ["综合管理部", 3],
      ]);
      expect(depts.every((d) => d.parentId === root[0].id)).toBe(true);

      // 员工信息：22 人职位/工号/入职全非空，工号 YN-### 唯一
      const rows = await db
        .select({
          email: users.email,
          position: users.position,
          employeeNo: users.employeeNo,
          joinedAt: users.joinedAt,
        })
        .from(users);
      expect(rows).toHaveLength(22);
      expect(rows.every((r) => r.position.length > 0)).toBe(true);
      expect(rows.every((r) => r.joinedAt !== null)).toBe(true);
      const nos = rows.map((r) => r.employeeNo);
      expect(nos.every((n) => n !== null && /^YN-\d{3}$/.test(n))).toBe(true);
      expect(new Set(nos).size).toBe(22);
      // 代表性岗位
      const byEmail = new Map(rows.map((r) => [r.email, r]));
      expect(byEmail.get("liangqifeng@lexflow.demo")?.position).toBe("合伙人");
      expect(byEmail.get("guojingwen@lexflow.demo")?.position).toBe("财务主管");
      expect(byEmail.get("wangying@lexflow.demo")?.position).toBe("档案管理员");
      expect(byEmail.get("wangbaozhuo@lexflow.demo")?.position).toBe("项目负责人");
      expect(byEmail.get("liangqifeng@lexflow.demo")?.employeeNo).toBe("YN-001");

      // 二次执行幂等（行数与关键字段不变）
      await runSeed(TEST_DATABASE_URL);
      const profile2 = await db.select().from(companyProfile);
      expect(profile2).toHaveLength(1);
      const rows2 = await db.select({ employeeNo: users.employeeNo }).from(users);
      expect(rows2.map((r) => r.employeeNo).sort()).toEqual(nos.slice().sort());
    } finally {
      await pool.end();
    }
  });

  it("约束：company_profile 单记录唯一（第二行必败）；employee_no 唯一冲突必败；org 自引用 FK RESTRICT", async () => {
    const { db, pool } = await openDb();
    try {
      await expectPgViolation(
        db.insert(companyProfile).values({ name: "第二公司" }),
        "23505",
      );
      const anyUser = await db.select({ id: users.id }).from(users).limit(1);
      await expectPgViolation(
        db.insert(users).values({
          email: "dup-no@lexflow.demo",
          name: "工号冲突",
          passwordHash: "x",
          employeeNo: "YN-001",
        }),
        "23505",
      );
      // 自引用 FK：父节点不存在 → 23503
      await expectPgViolation(
        db.insert(orgUnits).values({ name: "幽灵部门", parentId: anyUser[0].id }),
        "23503",
      );
      // sort 回填语义（同迁移 SQL）：新建 sort=0 的同名部门行被回填为 3
      const ghost = await db.insert(orgUnits).values({ name: "综合管理部", sort: 0 }).returning({ id: orgUnits.id });
      await db.execute(sql.raw(SORT_BACKFILL));
      const after = await db.select({ sort: orgUnits.sort }).from(orgUnits).where(eq(orgUnits.id, ghost[0].id));
      expect(after[0].sort).toBe(3);
      await db.execute(sql`DELETE FROM org_units WHERE id = ${ghost[0].id}`);
    } finally {
      await pool.end();
    }
  });
});
