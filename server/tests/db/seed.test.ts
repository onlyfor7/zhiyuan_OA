import { describe, expect, it } from "vitest";
import pg from "pg";

import { runSeed } from "../../src/db/seed";
import { verifyPassword } from "../../src/lib/password";
import { ALL_TABLES, migrateFresh, TEST_DATABASE_URL } from "./helpers";

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

describe("种子幂等与验收布局", () => {
  it("干净库上二次执行行数不变，地基数据齐备", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const first = await countRows();
    await runSeed(TEST_DATABASE_URL);
    const second = await countRows();

    expect(second).toEqual(first);
    expect(first.org_units).toBe(4); // 1 律所 + 3 部门
    expect(first.roles).toBe(8); // arch/03 §1
    expect(first.users).toBe(12); // ≥10
    expect(first.user_roles).toBe(12);
    expect(first.clients).toBe(2);
    expect(first.matters).toBe(2);
    expect(first.projects).toBe(3);
    expect(first.project_members).toBe(8); // 4 + 2 + 2
    expect(first.system_config).toBe(12); // 需求基线 §18 全量
    expect(first.code_sequences).toBe(3); // CLT/MTR/PRJ 水位
  });

  it("验收场景布局：pm 负责 A/B、member 仅在 A、C 对二者不可见", async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    const layout = await client.query<{
      code: string;
      manager: string;
      members: string[];
    }>(
      `SELECT p.code, manager.email AS manager, coalesce(array_agg(member.email) FILTER (WHERE member.email IS NOT NULL), '{}') AS members
       FROM projects p
       JOIN users manager ON manager.id = p.manager_id
       LEFT JOIN project_members pm ON pm.project_id = p.id
       LEFT JOIN users member ON member.id = pm.user_id
       GROUP BY p.code, manager.email
       ORDER BY p.code`,
    );
    const byCode = new Map(layout.rows.map((row) => [row.code, row]));
    const year = new Date().getFullYear();

    const projectA = byCode.get(`PRJ-${year}-00001`);
    const projectB = byCode.get(`PRJ-${year}-00002`);
    const projectC = byCode.get(`PRJ-${year}-00003`);
    expect(projectA?.manager).toBe("pm@lexflow.demo");
    expect(projectA?.members).toContain("member@lexflow.demo");
    expect(projectB?.manager).toBe("pm@lexflow.demo");
    expect(projectB?.members).not.toContain("member@lexflow.demo");
    expect(projectC?.manager).toBe("partner@lexflow.demo");
    expect(projectC?.members).not.toContain("pm@lexflow.demo");
    expect(projectC?.members).not.toContain("member@lexflow.demo");

    const pmUser = await client.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE email = 'pm@lexflow.demo'`,
    );
    await client.end();
    expect(verifyPassword("Demo@2026", pmUser.rows[0].password_hash)).toBe(true);
    expect(verifyPassword("wrong-password", pmUser.rows[0].password_hash)).toBe(false);
  });
});
