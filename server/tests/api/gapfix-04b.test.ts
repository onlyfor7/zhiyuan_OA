import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";

const YEAR = new Date().getFullYear();

describe("迭代 6 · 工单 04b（projectOptions / userList roles / types 公开读）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let financeCookie: string;
  let partnerCookie: string;
  let sysadminCookie: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("receipts.projectOptions：finance/partner 参照级清单（最小字段），其他角色同形 404", async () => {
    for (const cookie of [financeCookie, partnerCookie]) {
      const result = await trpc(app, "receipts.projectOptions", { cookie, method: "GET" });
      expect(result.status).toBe(200);
      const items = (result.json as { result: { data: { id: string; code: string; name: string }[] } }).result.data;
      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(items[0]).toEqual({
        id: expect.any(String),
        code: expect.stringContaining(`PRJ-${YEAR}-`),
        name: expect.any(String),
      });
      // 无业务内容字段泄漏（无 budget/成员/密级等）
      expect(Object.keys(items[0]).sort()).toEqual(["code", "id", "name"]);
    }
    for (const cookie of [memberCookie, pmCookie]) {
      const denied = await trpc(app, "receipts.projectOptions", { cookie, method: "GET" });
      expect(denied.status).toBe(404);
      expect(trpcError(denied).businessCode).toBe("ACCESS_DENIED_OR_GONE");
    }
  });

  it("admin.userList 增 roles 聚合（sysadmin 门不变）", async () => {
    const result = await trpc(app, "admin.userList", { cookie: sysadminCookie, method: "GET" });
    expect(result.status).toBe(200);
    const items = (result.json as { result: { data: { email: string; roles: string[] }[] } }).result.data;
    const pm = items.find((u) => u.email === "wangbaozhuo@lexflow.demo");
    expect(pm?.roles).toContain("project_manager");
    const member = items.find((u) => u.email === "guanchen@lexflow.demo");
    expect(member?.roles).toEqual(["member"]);

    const denied = await trpc(app, "admin.userList", { cookie: memberCookie, method: "GET" });
    expect(denied.status).toBe(404);
  });

  it("genericRequest.types：任意登录可读（key/label 形状，来自 system_config）", async () => {
    for (const cookie of [memberCookie, sysadminCookie]) {
      const result = await trpc(app, "genericRequest.types", { cookie, method: "GET" });
      expect(result.status).toBe(200);
      const items = (result.json as { result: { data: { items: { key: string; label: string }[] } } }).result.data.items;
      expect(items.map((t) => t.key)).toEqual(["leave", "procurement", "seal", "other"]);
      expect(items[0].label).toBe("请假");
    }
    // 未登录 → 401
    const anonymous = await trpc(app, "genericRequest.types", { method: "GET" });
    expect(anonymous.status).toBe(401);
    expect(trpcError(anonymous).businessCode).toBe("AUTH_REQUIRED");
  });
});
