import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { TEST_DATABASE_URL } from "../db/helpers";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";

/**
 * 迭代 18 · 工单 02c（18-03 前置接口补齐，只此三项）：
 * ① crm.leads.convert 的 opportunity.presalesId 透传立项 helper（落库/可见性/NULL/非法 400）；
 * ② org.members.list 与 admin.userList 返回 managerId/managerName/managerChain（白名单无敏感字段）；
 * ③ reports.projectCosting 列定义补 presalesCostCents/deliveryCostCents/totalCostCents（右对齐，值与 costing 服务一致）。
 */

const YEAR = new Date().getFullYear();
const uuid = () => crypto.randomUUID();

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

interface MemberItem {
  id: string;
  name: string;
  email: string;
  managerId: string | null;
  managerName: string | null;
  managerChain: Array<{ id: string; name: string }>;
  roles?: string[];
}

describe("18-02c 前端联调接口补齐", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let salesACookie: string;
  let presalesCookie: string;
  let sysadminCookie: string;
  let memberCookie: string;
  let financeCookie: string;
  let pmUserId: string;
  let presalesId: string;
  let salesAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    salesACookie = (await loginAs(app, "sumingxuan@lexflow.demo")).cookie;
    presalesCookie = (await loginAs(app, "hezhiyuan@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    const ids = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email IN ('wangbaozhuo@lexflow.demo','hezhiyuan@lexflow.demo','sumingxuan@lexflow.demo')`,
    );
    pmUserId = ids.find((u) => u.email.startsWith("wangbaozhuo"))!.id;
    presalesId = ids.find((u) => u.email.startsWith("hezhiyuan"))!.id;
    salesAId = ids.find((u) => u.email.startsWith("sumingxuan"))!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("① convert opportunity.presalesId：落库+售前可见+缺省 NULL+不存在/停用 400 fieldErrors", async () => {
    // 带 presalesId 转化 → 落库 + 售前可见
    const lead1 = await trpc(app, "crm.leads.create", { cookie: salesACookie, input: { name: "02c 售前指派线索" } });
    const l1 = (lead1.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const c1 = await trpc(app, "crm.leads.convert", {
      cookie: salesACookie,
      input: {
        id: l1.id,
        rowVersion: l1.rowVersion,
        customer: { name: "02c 售前指派客户" },
        projectManagerId: pmUserId,
        opportunity: { name: "02c 售前指派商机", presalesId },
      },
    });
    expect(c1.status, JSON.stringify(c1.json).slice(0, 200)).toBe(200);
    const opp1Id = (c1.json as { result: { data: { opportunityId: string } } }).result.data.opportunityId;
    const row1 = await query<{ presales_id: string | null }>(`SELECT presales_id FROM crm_opportunities WHERE id=$1`, [opp1Id]);
    expect(row1[0].presales_id).toBe(presalesId);
    const psView = await trpc(app, "crm.opportunities.getById", { cookie: presalesCookie, method: "GET", input: { id: opp1Id } });
    expect(psView.status).toBe(200); // 售前可见该商机

    // 不带 presalesId → NULL
    const lead2 = await trpc(app, "crm.leads.create", { cookie: salesACookie, input: { name: "02c 无售前线索" } });
    const l2 = (lead2.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const c2 = await trpc(app, "crm.leads.convert", {
      cookie: salesACookie,
      input: { id: l2.id, rowVersion: l2.rowVersion, customer: { name: "02c 无售前客户" }, projectManagerId: pmUserId, opportunity: { name: "02c 无售前商机" } },
    });
    expect(c2.status).toBe(200);
    const opp2Id = (c2.json as { result: { data: { opportunityId: string } } }).result.data.opportunityId;
    const row2 = await query<{ presales_id: string | null }>(`SELECT presales_id FROM crm_opportunities WHERE id=$1`, [opp2Id]);
    expect(row2[0].presales_id).toBeNull();

    // 不存在用户 → 400 + fieldErrors
    const lead3 = await trpc(app, "crm.leads.create", { cookie: salesACookie, input: { name: "02c 鬼售前线索" } });
    const l3 = (lead3.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const c3 = await trpc(app, "crm.leads.convert", {
      cookie: salesACookie,
      input: { id: l3.id, rowVersion: l3.rowVersion, customer: { name: "02c 鬼售前客户" }, projectManagerId: pmUserId, opportunity: { name: "02c 鬼售前商机", presalesId: uuid() } },
    });
    expect(c3.status).toBe(400);
    expect(trpcError(c3).fieldErrors?.presalesId).toBeTruthy();

    // 停用用户 → 400 + fieldErrors（admin 建号即停用）
    const mk = await trpc(app, "admin.createUser", {
      cookie: sysadminCookie,
      input: { email: `disabled-ps-${uuid().slice(0, 8)}@lexflow.demo`, name: "停用售前", roleKey: "presales" },
    });
    expect(mk.status).toBe(200);
    const disabledId = (mk.json as { result: { data: { id: string } } }).result.data.id;
    const dis = await trpc(app, "admin.disableUser", { cookie: sysadminCookie, input: { userId: disabledId } });
    expect(dis.status).toBe(200);
    const lead4 = await trpc(app, "crm.leads.create", { cookie: salesACookie, input: { name: "02c 停用售前线索" } });
    const l4 = (lead4.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const c4 = await trpc(app, "crm.leads.convert", {
      cookie: salesACookie,
      input: { id: l4.id, rowVersion: l4.rowVersion, customer: { name: "02c 停用售前客户" }, projectManagerId: pmUserId, opportunity: { name: "02c 停用售前商机", presalesId: disabledId } },
    });
    expect(c4.status).toBe(400);
    expect(trpcError(c4).fieldErrors?.presalesId).toBeTruthy();
  });

  it("② 主管读取：org.members.list/admin.userList 返回 managerId/managerName/managerChain + 白名单无敏感字段", async () => {
    const orgList = await trpc(app, "org.members.list", { cookie: sysadminCookie, method: "GET", input: { limit: 100 } });
    expect(orgList.status).toBe(200);
    const items = (orgList.json as { result: { data: { items: MemberItem[] } } }).result.data.items;
    const su = items.find((m) => m.email === "sumingxuan@lexflow.demo")!;
    expect(su.managerName).toBe("郑浩然");
    expect(su.managerChain.map((m) => m.name)).toEqual(["郑浩然", "高峻岭", "宋启铭"]);
    const ceo = items.find((m) => m.email === "songqiming@lexflow.demo")!;
    expect(ceo.managerId).toBeNull();
    expect(ceo.managerName).toBeNull();
    expect(ceo.managerChain).toEqual([]);

    const adminList = await trpc(app, "admin.userList", { cookie: sysadminCookie, method: "GET" });
    expect(adminList.status).toBe(200);
    const aItems = (adminList.json as { result: { data: MemberItem[] } }).result.data;
    const aSu = aItems.find((m) => m.email === "sumingxuan@lexflow.demo")!;
    expect(aSu.managerId).toBe(su.managerId);
    expect(aSu.managerName).toBe("郑浩然");
    expect(aSu.managerChain.map((m) => m.name)).toEqual(["郑浩然", "高峻岭", "宋启铭"]);
    // 字段白名单：不含口令散列/会话/token 类敏感字段（mustChangePassword 为既有布尔标记非秘密）
    for (const key of Object.keys(aSu)) {
      expect(key.toLowerCase()).not.toMatch(/_hash$|hash$|^password|token|session/);
    }
    expect(typeof (aSu as unknown as { mustChangePassword: boolean }).mustChangePassword).toBe("boolean");
  });

  it("③ reports.projectCosting 列定义补三成本列（右对齐）+ 行值与 costing 服务口径一致 + 无 fin.read 口径不破", async () => {
    const rep = await trpc(app, "reports.projectCosting", { cookie: financeCookie, method: "GET", input: {} });
    expect(rep.status).toBe(200);
    const data = (rep.json as {
      result: {
        data: {
          columns: Array<{ key: string; align?: string }>;
          rows: Array<Record<string, number | string>>;
        };
      };
    }).result.data;
    const keys = data.columns.map((c) => c.key);
    for (const k of ["presalesCostCents", "deliveryCostCents", "totalCostCents"]) {
      expect(keys, `缺列 ${k}`).toContain(k);
      expect(data.columns.find((c) => c.key === k)!.align).toBe("right");
    }
    // 既有列不删
    for (const k of ["code", "name", "revenueCents", "directCostCents", "laborCostCents"]) {
      expect(keys).toContain(k);
    }
    // 行值口径：分段和=总成本=直接成本（不双算），且与服务 get 一致
    const projectA = data.rows.find((r) => String(r.code) === `PRJ-${YEAR}-00001`)!;
    expect(Number(projectA.presalesCostCents) + Number(projectA.deliveryCostCents)).toBe(Number(projectA.totalCostCents));
    expect(Number(projectA.totalCostCents)).toBe(Number(projectA.directCostCents));
    const get = await trpc(app, "fin.projectCosting.get", { cookie: financeCookie, method: "GET", input: { projectId: projectA.projectId as string } });
    expect(get.status, `fin.projectCosting.get：${JSON.stringify(get.json).slice(0, 200)}`).toBe(200);
    const g = (get.json as { result: { data: { presalesCostCents: number; deliveryCostCents: number; totalCostCents: number } } }).result.data;
    expect(Number(projectA.presalesCostCents)).toBe(g.presalesCostCents);
    expect(Number(projectA.deliveryCostCents)).toBe(g.deliveryCostCents);
    expect(Number(projectA.totalCostCents)).toBe(g.totalCostCents);
    // 无 fin.read 口径：member 200（report.read 全员，行按项目可见集收窄）
    const memberRep = await trpc(app, "reports.projectCosting", { cookie: memberCookie, method: "GET", input: {} });
    expect(memberRep.status).toBe(200);
    const mKeys = ((memberRep.json as { result: { data: { columns: Array<{ key: string }> } } }).result.data.columns).map((c) => c.key);
    expect(mKeys).toContain("presalesCostCents");
  });
});
