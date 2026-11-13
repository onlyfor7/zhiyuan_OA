import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 9b · 工单 02（arch/12 §9/§11）：组织管理服务端——
 * 权限三探针（sysadmin 写通 / partner 只读穿透 / member 同形 404；company.get 登录可读）、
 * 公司信息 get/update（乐观锁+审计）、部门树 create/update/disable（禁删有成员/有子部门）/
 * move（防环+落点同事务排序）、员工 list/create/update（复用用户生命周期：初始口令/首登改密/停用即失效）。
 */

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

interface UnitNode {
  id: string;
  name: string;
  parentId: string | null;
  sort: number;
  memberCount: number;
  children: UnitNode[];
}

function findNode(nodes: UnitNode[], predicate: (n: UnitNode) => boolean): UnitNode | null {
  for (const n of nodes) {
    if (predicate(n)) return n;
    const hit = findNode(n.children, predicate);
    if (hit) return hit;
  }
  return null;
}

describe("9b-02 组织管理服务端", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let sysadminCookie: string;
  let partnerCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("权限三探针：sysadmin 写通 / partner 只读穿透（名录最小字段无敏感列）/ member 同形 404；company.get 登录可读", async () => {
    // company.get 登录可读（member 也可——发票抬头引用）
    const memberCompany = await trpc(app, "org.company.get", { cookie: memberCookie, method: "GET" });
    expect(memberCompany.status).toBe(200);
    expect((memberCompany.json as { result: { data: { name: string } } }).result.data.name).toBe("因诺智元");

    // sysadmin：读+写全通
    expect((await trpc(app, "org.units.tree", { cookie: sysadminCookie, method: "GET" })).status).toBe(200);
    expect((await trpc(app, "org.members.list", { cookie: sysadminCookie, method: "GET", input: {} })).status).toBe(200);
    const companyRow = ((await trpc(app, "org.company.get", { cookie: sysadminCookie, method: "GET" })).json as { result: { data: { rowVersion: number } } }).result.data;
    const sysWrite = await trpc(app, "org.company.update", { cookie: sysadminCookie, input: { rowVersion: companyRow.rowVersion, phone: "010-99999999" } });
    expect(sysWrite.status).toBe(200);

    // partner：只读穿透（get/tree/list 200；写一律 404 同形）
    expect((await trpc(app, "org.units.tree", { cookie: partnerCookie, method: "GET" })).status).toBe(200);
    const partnerList = await trpc(app, "org.members.list", { cookie: partnerCookie, method: "GET", input: { limit: 5 } });
    expect(partnerList.status).toBe(200);
    const firstMember = (partnerList.json as { result: { data: { items: Array<Record<string, unknown>> } } }).result.data.items[0];
    const keys = Object.keys(firstMember).sort();
    // 最小字段：无口令/哈希/改密标记等敏感列；18-02c 增主管读取三字段（managerChain/Id/Name，白名单安全）
    expect(keys).toEqual(["email", "employeeNo", "id", "joinedAt", "managerChain", "managerId", "managerName", "name", "orgUnitId", "orgUnitName", "position", "roles", "status"].sort());
    for (const writePath of [
      trpc(app, "org.company.update", { cookie: partnerCookie, input: { rowVersion: 0, phone: "x" } }),
      trpc(app, "org.units.create", { cookie: partnerCookie, input: { name: "partner 越权" } }),
      trpc(app, "org.units.move", { cookie: partnerCookie, input: { id: crypto.randomUUID(), parentId: null, sort: 0 } }),
      trpc(app, "org.members.create", { cookie: partnerCookie, input: { name: "x", email: `pv-${crypto.randomUUID().slice(0, 8)}@lexflow.demo`, roleKey: "member" } }),
      trpc(app, "org.members.setStatus", { cookie: partnerCookie, input: { id: crypto.randomUUID(), status: "disabled" } }),
    ]) {
      expect((await writePath).status).toBe(404);
    }

    // member：组织读 404（company.get 除外）
    expect((await trpc(app, "org.units.tree", { cookie: memberCookie, method: "GET" })).status).toBe(404);
    expect((await trpc(app, "org.members.list", { cookie: memberCookie, method: "GET", input: {} })).status).toBe(404);
    expect((await trpc(app, "org.company.update", { cookie: memberCookie, input: { rowVersion: 0, phone: "x" } })).status).toBe(404);
  });

  it("公司信息：update 乐观锁 + 审计前后值", async () => {
    const before = await trpc(app, "org.company.get", { cookie: sysadminCookie, method: "GET" });
    const row = (before.json as { result: { data: { id: string; rowVersion: number; bankName: string } } }).result.data;
    expect(row.bankName.length).toBeGreaterThan(0);
    const updated = await trpc(app, "org.company.update", {
      cookie: sysadminCookie,
      input: { rowVersion: row.rowVersion, address: "北京市海淀区中关村大街 1 号", bankName: "中国示例银行北京分行" },
    });
    expect(updated.status).toBe(200);
    const after = (updated.json as { result: { data: { rowVersion: number; address: string } } }).result.data;
    expect(after.rowVersion).toBe(row.rowVersion + 1);
    expect(after.address).toContain("中关村");
    // 乐观锁：旧版本再改 → 409
    const stale = await trpc(app, "org.company.update", { cookie: sysadminCookie, input: { rowVersion: row.rowVersion, phone: "010-1" } });
    expect(stale.status).toBe(409);
    expect(trpcError(stale).businessCode).toBe("STATE_CONFLICT");
    // 审计前后值
    const audit = await query<{ n: number; before_phone: string | null; after_bank: string | null }>(
      `SELECT count(*)::int AS n, before_json->>'bankName' AS before_phone, after_json->>'bankName' AS after_bank
       FROM audit_events WHERE action='org.company.update' AND target_type='company_profile' GROUP BY before_json, after_json`,
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].n).toBeGreaterThanOrEqual(1);
    expect(audit[0].after_bank).toBe("中国示例银行北京分行");
  });

  it("部门树：create/update/move（防环+落点排序同事务）/disable（禁删有成员与有子部门）", async () => {
    const tree0 = (await trpc(app, "org.units.tree", { cookie: sysadminCookie, method: "GET" })).json as { result: { data: UnitNode[] } };
    const roots = tree0.result.data;
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe("因诺智元");
    expect(roots[0].children.length).toBe(3);
    const rootId = roots[0].id;
    const litigation = roots[0].children.find((c) => c.name === "诉讼业务部")!;
    expect(litigation.memberCount).toBeGreaterThan(0);

    // create：根下新部门
    const created = await trpc(app, "org.units.create", { cookie: sysadminCookie, input: { name: "9b验收部", parentId: rootId, sort: 9 } });
    expect(created.status).toBe(200);
    const newUnitId = (created.json as { result: { data: { id: string } } }).result.data.id;
    // update 改名
    const renamed = await trpc(app, "org.units.update", { cookie: sysadminCookie, input: { id: newUnitId, name: "9b验收部（改）" } });
    expect(renamed.status).toBe(200);

    // move：诉讼业务部（有成员）拖入新部门下 → 结构变化
    const moved = await trpc(app, "org.units.move", { cookie: sysadminCookie, input: { id: litigation.id, parentId: newUnitId, sort: 0 } });
    expect(moved.status).toBe(200);
    let tree = ((await trpc(app, "org.units.tree", { cookie: sysadminCookie, method: "GET" })).json as { result: { data: UnitNode[] } }).result.data;
    let newNode = findNode(tree, (n) => n.id === newUnitId)!;
    const litigationChild = newNode.children.find((c) => c.id === litigation.id)!;
    expect(litigationChild).toBeTruthy();
    expect(litigationChild.memberCount).toBe(litigation.memberCount); // 成员随部门走（直属计数）

    // 防环：把新部门拖进自己的子级（诉讼业务部）→ 400
    const cycle = await trpc(app, "org.units.move", { cookie: sysadminCookie, input: { id: newUnitId, parentId: litigation.id, sort: 0 } });
    expect(cycle.status).toBe(400);
    expect(trpcError(cycle).businessCode).toBe("VALIDATION_FAILED");
    // 防环（自身直接父级）→ 400
    const selfCycle = await trpc(app, "org.units.move", { cookie: sysadminCookie, input: { id: newUnitId, parentId: newUnitId, sort: 0 } });
    expect(selfCycle.status).toBe(400);

    // 落点排序同事务：把诉讼业务部移回根 sort=1 → 原 sort>=1 兄弟让位
    const movedBack = await trpc(app, "org.units.move", { cookie: sysadminCookie, input: { id: litigation.id, parentId: rootId, sort: 1 } });
    expect(movedBack.status).toBe(200);
    const sorts = await query<{ name: string; sort: number }>(`SELECT name, sort FROM org_units WHERE parent_id=$1 ORDER BY sort`, [rootId]);
    expect(sorts.find((s) => s.name === "诉讼业务部")?.sort).toBe(1);
    expect(new Set(sorts.map((s) => s.sort)).size).toBe(sorts.length); // 同级 sort 无重复

    // disable：有成员部门 → 409
    const disableBusy = await trpc(app, "org.units.disable", { cookie: sysadminCookie, input: { id: litigation.id } });
    expect(disableBusy.status).toBe(409);
    // disable：有子部门的根 → 409
    const disableRoot = await trpc(app, "org.units.disable", { cookie: sysadminCookie, input: { id: rootId } });
    expect(disableRoot.status).toBe(409);
    // disable：空部门 → 200 且树消失
    const disableOk = await trpc(app, "org.units.disable", { cookie: sysadminCookie, input: { id: newUnitId } });
    expect(disableOk.status).toBe(200);
    tree = ((await trpc(app, "org.units.tree", { cookie: sysadminCookie, method: "GET" })).json as { result: { data: UnitNode[] } }).result.data;
    expect(findNode(tree, (n) => n.id === newUnitId)).toBeNull();
    // 审计
    const audit = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action IN ('org.units.create','org.units.move','org.units.disable')`);
    expect(audit[0].n).toBeGreaterThanOrEqual(3);
  });

  it("员工：list 筛选与最小字段 / create（初始口令可登+工号唯一）/ update（角色同步+乐观锁）/ setStatus 停用即失效", async () => {
    // list：关键字筛选 + 部门筛选 + 角色徽标
    const byKeyword = await trpc(app, "org.members.list", { cookie: sysadminCookie, method: "GET", input: { keyword: "郭静文" } });
    expect(byKeyword.status).toBe(200);
    const kwItems = (byKeyword.json as { result: { data: { items: Array<{ email: string; roles: string[]; orgUnitName: string | null; position: string; employeeNo: string }> } } }).result.data.items;
    expect(kwItems).toHaveLength(1);
    expect(kwItems[0].email).toBe("guojingwen@lexflow.demo");
    expect(kwItems[0].roles).toContain("finance");
    expect(kwItems[0].employeeNo).toMatch(/^YN-\d{3}$/);
    expect(kwItems[0].position).toContain("财务");

    // create：新员工全字段
    const email = `org-${crypto.randomUUID().slice(0, 8)}@lexflow.demo`;
    const created = await trpc(app, "org.members.create", {
      cookie: sysadminCookie,
      input: { name: "组织验收员", email, orgUnitId: null, position: "测试工程师", employeeNo: "YN-901", joinedAt: "2026-11-05", roleKey: "member" },
    });
    expect(created.status).toBe(200);
    const newUser = (created.json as { result: { data: { id: string; initialPassword: string } } }).result.data;
    expect(newUser.initialPassword.length).toBeGreaterThanOrEqual(10);
    // 初始口令可登录（复用既有生命周期）
    const firstLogin = await loginAs(app, email, newUser.initialPassword);
    expect(firstLogin.user.email).toBe(email);

    // 工号唯一 → 400
    const dupNo = await trpc(app, "org.members.create", {
      cookie: sysadminCookie,
      input: { name: "重复工号", email: `org2-${crypto.randomUUID().slice(0, 8)}@lexflow.demo`, employeeNo: "YN-901", roleKey: "member" },
    });
    expect(dupNo.status).toBe(400);
    expect(trpcError(dupNo).fieldErrors?.employeeNo).toBeTruthy();

    // update：岗位/部门/入职 + 角色同步（member→viewer）
    const updated = await trpc(app, "org.members.update", {
      cookie: sysadminCookie,
      input: { id: newUser.id, position: "高级测试工程师", joinedAt: "2026-11-06", roleKeys: ["viewer"] },
    });
    expect(updated.status).toBe(200);
    const after = await trpc(app, "org.members.list", { cookie: sysadminCookie, method: "GET", input: { keyword: "组织验收员" } });
    const afterItem = (after.json as { result: { data: { items: Array<{ position: string; roles: string[]; joinedAt: string }> } } }).result.data.items[0];
    expect(afterItem.position).toBe("高级测试工程师");
    expect(afterItem.roles).toEqual(["viewer"]);
    expect(afterItem.joinedAt).toBe("2026-11-06");
    // 不存在用户 → 404 同形
    const missing = await trpc(app, "org.members.update", { cookie: sysadminCookie, input: { id: crypto.randomUUID(), position: "x" } });
    expect(missing.status).toBe(404);

    // setStatus 停用 → 会话即失效（首登会话刚建）
    const disabled = await trpc(app, "org.members.setStatus", { cookie: sysadminCookie, input: { id: newUser.id, status: "disabled" } });
    expect(disabled.status).toBe(200);
    const me = await trpc(app, "auth.me", { cookie: firstLogin.cookie, method: "GET" });
    expect(me.status).toBe(401);

    // 审计
    const audit = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action IN ('org.members.create','org.members.update','org.members.disable') AND target_id=$1`,
      [newUser.id],
    );
    expect(audit[0].n).toBeGreaterThanOrEqual(3);
  });
});
