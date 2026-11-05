import "./env-setup";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDb, pool } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";

/**
 * 迭代 9a · 工单 04（arch/12 §14.3/§14.4/§14.5）：
 * 连接池显式化（max/idle/获取超时，env 可调）、statement_timeout 截断、慢查询 warn（含 requestId）、
 * 登录限流（同 IP+账号 5 次失败/分 → 429，不泄账号存在性，成功清零）、安全头四件、保留期配置键入种子。
 */

describe("9a-04 生产加固", () => {
  let app: Awaited<ReturnType<typeof getApp>>;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("连接池显式化：pool.options 生效（max/idleTimeoutMillis/connectionTimeoutMillis）", () => {
    const options = (pool as unknown as { options: Record<string, unknown> }).options;
    expect(options.max).toBe(20);
    expect(options.idleTimeoutMillis).toBe(30000);
    expect(options.connectionTimeoutMillis).toBe(5000);
    // env 覆盖已在 env-setup 验证路径（PG_STATEMENT_TIMEOUT_MS 生效于下条截断探针）
  });

  it("statement_timeout 截断：pg_sleep(3) 在 2s 阈值被取消（env-setup 调低验证 prod 15s 机制）", async () => {
    await expect(pool.query("SELECT pg_sleep(3)")).rejects.toThrow(/canceling statement due to statement timeout|timeout/i);
  });

  it("慢查询 warn：> 阈值记 warn（含 slow_query 标记与 sql）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await pool.query("SELECT pg_sleep(0.3)"); // 300ms > SLOW_QUERY_MS=100
      const slowLog = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes('"type":"slow_query"') && line.includes("pg_sleep"));
      expect(slowLog, "应有 slow_query warn").toBeTruthy();
      const parsed = JSON.parse(slowLog!) as { ms: number; sql: string; requestId: string | null };
      expect(parsed.ms).toBeGreaterThanOrEqual(100);
      expect(parsed.sql).toContain("pg_sleep");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("安全头四件：X-Frame-Options/X-Content-Type-Options/Referrer-Policy/CSP 在响应", async () => {
    const res = await app.request("http://test/health", { method: "GET" });
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    // tRPC 路径同样覆盖（401 响应亦带四件）
    const trpcRes = await app.request("http://test/trpc/auth.me", { method: "GET" });
    expect(trpcRes.status).toBe(401);
    expect(trpcRes.headers.get("x-frame-options")).toBe("DENY");
    expect(trpcRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(trpcRes.headers.get("referrer-policy")).toBe("same-origin");
    expect(trpcRes.headers.get("content-security-policy")).toContain("default-src 'self'");
    // X-Request-Id 贯通（慢日志关联）
    expect(trpcRes.headers.get("x-request-id")).toBeTruthy();
  });

  it("登录限流：同 IP+账号 5 次失败/分，第 6 次 429（RATE_LIMITED），成功登录清零不误伤", async () => {
    const email = `rl-${crypto.randomUUID().slice(0, 8)}@lexflow.demo`;
    // 5 次失败（未知账号同样计数且不泄存在性）：前 5 次统一 401
    for (let i = 1; i <= 5; i++) {
      const r = await trpc(app, "auth.login", { input: { email, password: "WrongPass!2026" } });
      expect(r.status, `第 ${i} 次失败应 401`).toBe(401);
      expect(trpcError(r).message).toBe("邮箱或密码错误"); // 与已知账号口令错误同形
    }
    // 第 6 次（即使口令正确）→ 429 RATE_LIMITED
    const limited = await trpc(app, "auth.login", { input: { email, password: "Demo@2026" } });
    expect(limited.status).toBe(429);
    expect(trpcError(limited).businessCode).toBe("RATE_LIMITED");
    // 其他账号不受影响（键=ip|email）
    const other = await trpc(app, "auth.login", { input: { email: `rl2-${crypto.randomUUID().slice(0, 8)}@lexflow.demo`, password: "x" } });
    expect(other.status).toBe(401);
    // 成功登录清零：用真实账号先失败后成功（独立键）
    const real = "zhaokai@lexflow.demo";
    await trpc(app, "auth.login", { input: { email: real, password: "wrong" } });
    const ok = await loginAs(app, real); // 成功 → 清零
    expect(ok.user.email).toBe(real);
    const after = await trpc(app, "auth.login", { input: { email: real, password: "wrong" } });
    expect(after.status).toBe(401); // 窗口已清零，重新计数而非 429
  });

  it("保留期配置键入白名单与种子：security.session_retention_days=90 / audit.retention_days=730 可读", async () => {
    const sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    const sessionRetention = await trpc(app, "admin.getConfig", { cookie: sysadminCookie, method: "GET", input: { key: "security.session_retention_days" } });
    expect(sessionRetention.status).toBe(200);
    expect((sessionRetention.json as { result: { data: { valueJson: { days: number } } } }).result.data.valueJson.days).toBe(90);
    const auditRetention = await trpc(app, "admin.getConfig", { cookie: sysadminCookie, method: "GET", input: { key: "audit.retention_days" } });
    expect(auditRetention.status).toBe(200);
    expect((auditRetention.json as { result: { data: { valueJson: { days: number } } } }).result.data.valueJson.days).toBe(730);
  });
});
