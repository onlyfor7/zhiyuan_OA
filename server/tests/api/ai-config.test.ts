import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 13 · 工单 01（arch/12 §17.6 v2.2）：AI 配置统筹与用量——
 * ai_usage_events 每调用必记（Mock 按 chars/4 估算）；ai.config get/set/testConnection（sysadmin 专有、
 * key 脱敏后 4 位、审计不含明文、改后即刻生效）；system_config 四键入白名单+读序优先 env 30s 缓存；
 * ai.enabled=false 拦截 403；ai.myUsage 本人近 30 天日×能力 / ai.usageAdmin 全局 Top。
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

describe("13-01 AI 配置统筹与用量", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let sysadminCookie: string;
  let memberCookie: string;

  const chat = (cookie: string, content: string) =>
    trpc(app, "ai.chat", { cookie, input: { messages: [{ role: "user", content }], context: { route: "/x", pageType: "", summary: "" } } });

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("配置三探针：sysadmin 通（get/set/testConnection）/ member 同形 404；key 脱敏仅后 4 位", async () => {
    const get0 = await trpc(app, "ai.config.get", { cookie: sysadminCookie, method: "GET" });
    expect(get0.status).toBe(200);
    expect((get0.json as { result: { data: { enabled: boolean } } }).result.data.enabled).toBe(true); // 种子默认开

    const secret = "sk-test-1234567890abcd";
    const set = await trpc(app, "ai.config.set", {
      cookie: sysadminCookie,
      input: { providerUrl: null, apiKey: secret, model: "kimi-probe", enabled: true },
    });
    expect(set.status).toBe(200);

    const get1 = await trpc(app, "ai.config.get", { cookie: sysadminCookie, method: "GET" });
    const cfg = (get1.json as { result: { data: { apiKeyMasked: string | null; model: string; source: string } } }).result.data;
    expect(cfg.apiKeyMasked).toBe("****abcd"); // 脱敏仅后 4 位
    expect(cfg.model).toBe("kimi-probe");
    expect(cfg.source).toBe("system_config");
    expect(JSON.stringify(get1.json)).not.toContain(secret); // 响应全文无明文

    // 审计不含明文（before/after 只存脱敏形态）
    const leak = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action='ai.config.set' AND (before_json::text LIKE $1 OR after_json::text LIKE $1)`,
      [`%${secret}%`],
    );
    expect(leak[0].n).toBe(0);

    // testConnection：mock 兜底（未配 URL）→ ok
    const tc = await trpc(app, "ai.config.testConnection", { cookie: sysadminCookie, input: {} });
    expect(tc.status).toBe(200);
    expect((tc.json as { result: { data: { ok: boolean } } }).result.data.ok).toBe(true);

    // member 三端点 404
    expect((await trpc(app, "ai.config.get", { cookie: memberCookie, method: "GET" })).status).toBe(404);
    expect((await trpc(app, "ai.config.testConnection", { cookie: memberCookie, input: {} })).status).toBe(404);
    expect((await trpc(app, "ai.config.set", { cookie: memberCookie, input: { model: "x" } })).status).toBe(404);
    expect((await trpc(app, "ai.usageAdmin", { cookie: memberCookie, method: "GET", input: {} })).status).toBe(404);
  });

  it("改后即刻生效（缓存失效）：ai.chat 用量记账 model 即时用新值；enabled=false 拦截 403、恢复即通", async () => {
    // 前一步已 set model=kimi-probe → 本次 chat 的记账 model 应即 kimi-probe（30s 缓存已被 set 失效）
    const before = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage_events WHERE model='kimi-probe'`);
    await chat(memberCookie, "这个页面是干什么的");
    const after = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage_events WHERE model='kimi-probe'`);
    expect(after[0].n).toBe(before[0].n + 1); // 即刻生效实证（读序命中 system_config 新值）

    // enabled=false 拦截
    await trpc(app, "ai.config.set", { cookie: sysadminCookie, input: { enabled: false } });
    const blocked = await chat(memberCookie, "这个页面是干什么的");
    expect(blocked.status).toBe(403);
    expect(trpcError(blocked).businessCode).toBe("AI_DISABLED");
    // 拦截不计用量
    const blockedRows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage_events WHERE capability='answer'`);
    await chat(memberCookie, "这个页面是干什么的").catch(() => {});
    const blockedRows2 = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage_events WHERE capability='answer'`);
    expect(blockedRows2[0].n).toBe(blockedRows[0].n);

    // 恢复即通
    await trpc(app, "ai.config.set", { cookie: sysadminCookie, input: { enabled: true } });
    expect((await chat(memberCookie, "这个页面是干什么的")).status).toBe(200);
  });

  it("用量记账：Mock 按 chars/4 估算勾稽（tokens_in/out 与输入输出字符数/4 上取整一致）", async () => {
    const content = "帮我预填出差表单：明天去上海两天，交通高铁";
    const r = await chat(memberCookie, content);
    expect(r.status).toBe(200);
    const d = (r.json as { result: { data: { usage: { tokensIn: number; tokensOut: number } } } }).result.data;
    const inputChars = content.length; // messages 1 条 + 空 summary
    expect(d.usage.tokensIn).toBe(Math.ceil(inputChars / 4));
    const row = await query<{ tokens_in: number; tokens_out: number; capability: string; model: string }>(
      `SELECT tokens_in, tokens_out, capability, model FROM ai_usage_events WHERE capability='form_prefill' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(row[0].tokens_in).toBe(d.usage.tokensIn);
    expect(row[0].tokens_out).toBe(d.usage.tokensOut);
    expect(row[0].model).toBe("kimi-probe");
  });

  it("两聚合端点勾稽：ai.myUsage 本人日×能力 / ai.usageAdmin 全局人×日×能力 Top", async () => {
    // 再造一笔 A2 工时调用（member）
    await chat(memberCookie, "工时：今天在比博思特项目干了 4 小时合同审查");

    const mine = await trpc(app, "ai.myUsage", { cookie: memberCookie, method: "GET", input: {} });
    expect(mine.status).toBe(200);
    const myItems = (mine.json as { result: { data: { items: Array<{ day: string; capability: string; calls: number; tokens_in: number }> } } }).result.data.items;
    const caps = new Set(myItems.map((i) => i.capability));
    expect(caps.has("form_prefill")).toBe(true);
    expect(caps.has("time_draft")).toBe(true);
    expect(caps.has("answer")).toBe(true);
    const formRow = myItems.find((i) => i.capability === "form_prefill")!;
    expect(formRow.calls).toBeGreaterThanOrEqual(1);
    expect(formRow.tokens_in).toBeGreaterThan(0);
    for (const i of myItems) expect(i.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 勾稽：myUsage 的 calls 合计 == 该用户 ai_usage_events 行数（本会话 member 全部调用均成功记账）
    const dbCalls = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage_events WHERE user_id=(SELECT id FROM users WHERE email='guanchen@lexflow.demo')`);
    const myCalls = myItems.reduce((s, i) => s + i.calls, 0);
    expect(myCalls).toBe(dbCalls[0].n);

    const admin = await trpc(app, "ai.usageAdmin", { cookie: sysadminCookie, method: "GET", input: {} });
    expect(admin.status).toBe(200);
    const adminItems = (admin.json as { result: { data: { items: Array<{ user_name: string; day: string; capability: string; calls: number; tokens_in: number; tokens_out: number }> } } }).result.data.items;
    expect(adminItems.length).toBeGreaterThanOrEqual(1);
    const guanchenRow = adminItems.find((i) => i.user_name === "管晨" && i.capability === "time_draft");
    expect(guanchenRow).toBeTruthy();
    // Top 排序：按 tokens 降序
    const totals = adminItems.map((i) => i.tokens_in + i.tokens_out);
    for (let i = 1; i < totals.length; i++) expect(totals[i - 1]).toBeGreaterThanOrEqual(totals[i]);
  });
});
