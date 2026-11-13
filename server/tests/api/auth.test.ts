import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import {
  getApp,
  loginAs,
  sessionCookieOf,
  setupDatabase,
  trpc,
  trpcError,
} from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

describe("认证（auth.login / logout / me）", () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("/health 返回 { ok: true }", async () => {
    const app = await getApp();
    const res = await app.request("http://test/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("未登录 me → AUTH_REQUIRED", async () => {
    const app = await getApp();
    const result = await trpc(app, "auth.me", { method: "GET" });
    expect(result.status).toBe(401);
    expect(trpcError(result).businessCode).toBe("AUTH_REQUIRED");
  });

  it("错误口令与不存在账号 → 统一提示，且不区分", async () => {
    const app = await getApp();
    const wrongPassword = await trpc(app, "auth.login", {
      input: { email: "wangbaozhuo@lexflow.demo", password: "WrongPass1" },
    });
    const wrongAccount = await trpc(app, "auth.login", {
      input: { email: "ghost@lexflow.demo", password: "Demo@2026" },
    });
    for (const result of [wrongPassword, wrongAccount]) {
      expect(result.status).toBe(401);
      const error = trpcError(result);
      expect(error.message).toBe("邮箱或密码错误");
      // 统一错误形状：UNAUTHORIZED 统一映射 AUTH_REQUIRED，message 不区分账号存在性
      expect(error.businessCode).toBe("AUTH_REQUIRED");
    }
  });

  it("登录 → Set-Cookie(HttpOnly) → me → 登出 → me 失效（全流程）", async () => {
    const app = await getApp();
    const login = await trpc(app, "auth.login", {
      input: { email: "wangbaozhuo@lexflow.demo", password: "Demo@2026" },
    });
    expect(login.status).toBe(200);
    const setCookie = login.setCookies.find((line) => line.startsWith("lexflow_session="));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie?.toLowerCase()).toContain("samesite=lax");

    const me = await trpc(app, "auth.me", { cookie: sessionCookieOf(login), method: "GET" });
    expect(me.status).toBe(200);
    const meData = (me.json as { result: { data: {
      user: { id: string; email: string; name: string; position: string; orgUnit: { name: string } | null };
      globalRoles: string[];
      projects: { id: string; code: string; name: string; projectRole: string }[];
    } } }).result.data;
    expect(meData.user.email).toBe("wangbaozhuo@lexflow.demo");
    expect(meData.user.name).toBe("王宝茁");
    expect(meData.user.position).toBe("项目负责人"); // 9b-03b：问候卡职位数据源
    expect(meData.user.orgUnit?.name).toBe("诉讼业务部");
    expect(meData.globalRoles).toContain("project_manager");
    expect(meData.projects.map((p) => p.code).sort()).toEqual([
      `PRJ-${new Date().getFullYear()}-00001`,
      `PRJ-${new Date().getFullYear()}-00002`,
      `PRJ-${new Date().getFullYear()}-00006`, // 18-01：商机 OPP-00001 唯一项目（王宝茁任负责人）
    ]);

    const logout = await trpc(app, "auth.logout", { cookie: sessionCookieOf(login) });
    expect(logout.status).toBe(200);
    expect((logout.json as { result: { data: { ok: boolean } } }).result.data.ok).toBe(true);

    const meAfter = await trpc(app, "auth.me", { cookie: sessionCookieOf(login), method: "GET" });
    expect(meAfter.status).toBe(401);
    expect(trpcError(meAfter).businessCode).toBe("AUTH_REQUIRED");
  });

  it("登录/登出与失败登录均写 audit_events", async () => {
    const app = await getApp();
    await trpc(app, "auth.login", { input: { email: "wangbaozhuo@lexflow.demo", password: "bad" } });
    const { cookie } = await loginAs(app, "guanchen@lexflow.demo");
    await trpc(app, "auth.logout", { cookie });

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const actions = await client.query(
        `SELECT action, result, count(*)::int AS n FROM audit_events
         WHERE action IN ('auth.login', 'auth.logout') GROUP BY action, result`,
      );
      const rows = actions.rows as { action: string; result: string; n: number }[];
      const count = (action: string, result: string) =>
        rows.find((r) => r.action === action && r.result === result)?.n ?? 0;
      expect(count("auth.login", "success")).toBeGreaterThanOrEqual(2); // pm + member
      expect(count("auth.login", "failure")).toBeGreaterThanOrEqual(1); // 错误口令
      expect(count("auth.logout", "success")).toBeGreaterThanOrEqual(1);
      // 审计行须带 actor 与 session 溯源
      const actorCheck = await client.query(
        `SELECT count(*)::int AS n FROM audit_events
         WHERE action = 'auth.logout' AND actor_id IS NOT NULL AND session_id IS NOT NULL`,
      );
      expect(actorCheck.rows[0].n).toBeGreaterThanOrEqual(1);
    } finally {
      await client.end();
    }
  });

  it("auth.me 职位字段（9b-03b）：梁奇烽=合伙人、赵凯=系统管理员", async () => {
    const app = await getApp();
    const partner = await trpc(app, "auth.me", { cookie: (await loginAs(app, "liangqifeng@lexflow.demo")).cookie, method: "GET" });
    expect(partner.status).toBe(200);
    const partnerData = (partner.json as { result: { data: { user: { name: string; position: string; orgUnit: { name: string } | null } } } }).result.data;
    expect(partnerData.user.position).toBe("合伙人");
    expect(partnerData.user.orgUnit?.name).toBe("综合管理部");
    const sysadmin = await trpc(app, "auth.me", { cookie: (await loginAs(app, "zhaokai@lexflow.demo")).cookie, method: "GET" });
    expect((sysadmin.json as { result: { data: { user: { position: string } } } }).result.data.user.position).toBe("系统管理员");
    // 登录响应同构（position 一并下发）
    const login = await trpc(app, "auth.login", { input: { email: "liangqifeng@lexflow.demo", password: "Demo@2026" } });
    expect((login.json as { result: { data: { user: { position: string } } } }).result.data.user.position).toBe("合伙人");
  });

  it("停用账号后会话立即失效", async () => {
    const app = await getApp();
    const { cookie } = await loginAs(app, "tianyiming@lexflow.demo");
    const before = await trpc(app, "auth.me", { cookie, method: "GET" });
    expect(before.status).toBe(200);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`UPDATE users SET status = 'disabled' WHERE email = 'tianyiming@lexflow.demo'`);
    } finally {
      await client.end();
    }

    const after = await trpc(app, "auth.me", { cookie, method: "GET" });
    expect(after.status).toBe(401);
    expect(trpcError(after).businessCode).toBe("AUTH_REQUIRED");
  });

  it("zod 校验失败 → VALIDATION_FAILED 字段映射", async () => {
    const app = await getApp();
    const result = await trpc(app, "auth.login", { input: { email: "not-an-email", password: "" } });
    expect(result.status).toBe(400);
    const error = trpcError(result);
    expect(error.businessCode).toBe("VALIDATION_FAILED");
    expect(error.fieldErrors).toHaveProperty("email");
    expect(error.fieldErrors).toHaveProperty("password");
  });
});
