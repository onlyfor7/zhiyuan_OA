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
    expect(first.org_units).toBe(4); // 1 组织 + 3 部门
    expect(first.roles).toBe(14); // arch/03 §1 八角色 + arch/13 §3.1 销售线六角色（18-01）
    expect(first.users).toBe(29); // arch/11 G1 名单 22 人 + 18-01 六角色演示账号 7 人（梁奇烽双角色）
    expect(first.user_roles).toBe(30); // 23（22 用户+梁奇烽双挂）+ 7 演示账号各单角色
    expect(first.clients).toBe(5); // 比博思特/金通灵/佳力奇/合规引擎/GD（arch/11 G1）
    expect(first.matters).toBe(6); // +18-01 商机 OPP-00001 立项事项（售前）
    expect(first.projects).toBe(6); // +18-01 商机 OPP-00001 唯一项目；OPP-00002 复用 PRJ-00005 不新建
    expect(first.project_members).toBe(17); // 4+3+2+3+4 + 商机项目补 manager（王宝茁）
    expect(first.system_config).toBe(21); // 15 + timesheet.step_minutes（arch/11）+ 保留期两键（9a-04 §14.5）
    expect(first.code_sequences).toBe(24); // 19 + LD/OPP/CTR + AR/INV（9c/9d；full 档）
  });

  it("验收场景布局：王宝茁可见 A（负责）与 B（成员），管晨仅在 A，佳力奇 C 对二者不可见", async () => {
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
    const projectD = byCode.get(`PRJ-${year}-00004`);
    const projectE = byCode.get(`PRJ-${year}-00005`);
    expect(projectA?.manager).toBe("wangbaozhuo@lexflow.demo");
    expect(projectA?.members).toContain("guanchen@lexflow.demo");
    expect(projectB?.manager).toBe("wangjiayu@lexflow.demo");
    expect(projectB?.members).toContain("wangbaozhuo@lexflow.demo"); // 王宝茁为 B 成员 → 可见 A/B 两项目
    expect(projectB?.members).not.toContain("guanchen@lexflow.demo");
    expect(projectC?.manager).toBe("sunhaoxiang@lexflow.demo");
    expect(projectC?.members).not.toContain("wangbaozhuo@lexflow.demo");
    expect(projectC?.members).not.toContain("guanchen@lexflow.demo");
    expect(projectD?.manager).toBe("liaoyimin@lexflow.demo");
    expect(projectE?.manager).toBe("huoda@lexflow.demo");

    const pmUser = await client.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE email = 'wangbaozhuo@lexflow.demo'`,
    );
    await client.end();
    expect(verifyPassword("Demo@2026", pmUser.rows[0].password_hash)).toBe(true);
    expect(verifyPassword("wrong-password", pmUser.rows[0].password_hash)).toBe(false);
  });
});
