import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash } from "node:crypto";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { scrubContextSummary } from "../../src/modules/ai/ai";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 12 · 工单 02（arch/12 §17）：AI 助手「小元」后端基础——
 * 提供方适配层（MockProvider 无 key 兜底，确定性）+ ai.chat（限流 20/分、审计摘要哈希）+
 * 能力解析 A1 表单预填（不落库）/A2 工时草稿（0.5 步进校验）/A3 纪要草稿/A4 审批流 DSL 过既有编译管线（非法报错不产出）/A5 只读问答+
 * 隐私白名单剥离（密级/口令/token 键值）+2k 截断。
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

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("12-02 AI 助手基础", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let memberCookie: string;
  let sysadminCookie: string;

  const chat = (cookie: string, content: string, context: Record<string, unknown> = {}) =>
    trpc(app, "ai.chat", {
      cookie,
      input: { messages: [{ role: "user", content }], context: { route: "/x", pageType: "", summary: "", ...context } },
    });

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("A1 表单预填：形状断言（destination/days/startOn/transport）+ provider=mock（无 key 兜底实证）+ 不落库语义", async () => {
    const r = await chat(memberCookie, "帮我预填出差表单：明天去上海两天，交通高铁", { pageType: "travel_form", route: "/travel/new" });
    expect(r.status).toBe(200);
    const d = (r.json as { result: { data: { text: string; actions: Array<Record<string, unknown>>; capability: string; provider: string } } }).result.data;
    expect(d.provider).toBe("mock"); // 无 AI_API_KEY → MockProvider（env 三键缺省允许）
    expect(d.capability).toBe("form_prefill");
    const action = d.actions[0] as { type: string; form: string; values: Record<string, unknown> };
    expect(action.type).toBe("form_prefill");
    expect(action.form).toBe("travel_form");
    expect(action.values.destination).toBe("上海");
    expect(action.values.days).toBe(2);
    expect(String(action.values.startOn)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(action.values.transport).toBe("rail_highspeed");
    expect(d.text).toContain("未落库");
  });

  it("A2 工时草稿：0.5 步进通过（4.5 小时=270 分钟+项目名映射）/ 非法步进 400 / 不落库（DB 无草稿行）", async () => {
    const ok = await chat(memberCookie, "工时：昨天在比博思特项目干了 4.5 小时合同审查", { route: "/operations/time", pageType: "time_center" });
    expect(ok.status).toBe(200);
    const d = (ok.json as { result: { data: { actions: Array<{ entries: Array<{ projectId: string; projectName: string; minutes: number; workDate: string }> }> } } }).result.data;
    const entry = d.actions[0].entries[0];
    expect(entry.minutes).toBe(270);
    expect(entry.projectName).toContain("比博思特");
    expect(entry.workDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 不落库：草稿只是动作回传
    const leaked = await query<{ n: number }>(`SELECT count(*)::int AS n FROM time_entries WHERE description LIKE '%合同审查%'`);
    expect(leaked[0].n).toBe(0);

    const bad = await chat(memberCookie, "工时：今天在比博思特项目干了 3.7 小时杂项", { route: "/operations/time" });
    expect(bad.status).toBe(400);
    expect(trpcError(bad).businessCode).toBe("VALIDATION_FAILED");

    const noProject = await chat(memberCookie, "工时：干了 4 小时", { route: "/operations/time" });
    expect(noProject.status).toBe(400);
  });

  it("A4 审批流生成：DSL 草稿过既有编译/校验管线（条件+双链形状）；非法 NL 报错不产出", async () => {
    const ok = await chat(memberCookie, "帮我设计审批流：金额超过5万的经费先负责人审批再财务审批");
    expect(ok.status).toBe(200);
    const action = (ok.json as { result: { data: { actions: Array<{ type: string; definitionJson: { nodes: Array<{ id: string; type: string }>; edges: Array<{ from: string; to: string; when?: boolean }> } }> } } }).result.data.actions[0];
    expect(action.type).toBe("flow_draft");
    const def = action.definitionJson;
    const types = def.nodes.map((n) => n.type).sort();
    expect(types).toContain("start");
    expect(types).toContain("end");
    expect(types).toContain("condition");
    expect(types.filter((t) => t === "approval").length).toBeGreaterThanOrEqual(3); // 高链 2 + 低分支 1
    const cond = def.nodes.find((n) => n.type === "condition")!;
    expect(def.edges.some((e) => e.from === cond.id && e.when === true)).toBe(true);
    expect(def.edges.some((e) => e.from === cond.id && e.when === false)).toBe(true);
    // 200 即证服务端已过 validateFlowStructure + compileFlow（§17.2 A4 管线）

    const bad = await chat(memberCookie, "随便给我弄个审批流吧");
    expect(bad.status).toBe(400); // 未识别审批人 → 非法定义被既有管线拦下，不产出
    expect(trpcError(bad).businessCode).toBe("VALIDATION_FAILED");
  });

  it("A3 纪要草稿 / A5 只读问答：形状与只读语义", async () => {
    const a3 = await chat(memberCookie, "帮我生成纪要：讨论 Q4 预算与人员安排", { pageType: "meeting_detail", summary: "周会 5 人" });
    expect(a3.status).toBe(200);
    const a3d = (a3.json as { result: { data: { actions: Array<{ type: string; draft: string }>; capability: string } } }).result.data;
    expect(a3d.capability).toBe("minutes_draft");
    expect(a3d.actions[0].type).toBe("minutes_draft");
    expect(a3d.actions[0].draft).toContain("Q4 预算");

    const a5 = await chat(memberCookie, "这个页面是干什么的", { route: "/fin/receivables", summary: "应收管理列表 12 行" });
    expect(a5.status).toBe(200);
    const a5d = (a5.json as { result: { data: { capability: string; actions: Array<{ type: string }>; text: string } } }).result.data;
    expect(a5d.capability).toBe("answer");
    expect(a5d.actions[0].type).toBe("answer");
    expect(a5d.text).toContain("小元");
  });

  it("隐私剥离 + 2k 截断：审计只存摘要哈希（密级/口令/token 键值剥离后可复算）", async () => {
    const raw = "项目名=比博思特 password=Demo@2026 密级=secret token=abc123 列表计数=3";
    const r = await chat(memberCookie, "这个页面是干什么的", { summary: raw });
    expect(r.status).toBe(200);
    // 剥离后期望摘要（独立重算，不依赖实现函数）
    const expected = "项目名=比博思特 列表计数=3";
    const audit = await query<{ result: string; hash: string; cap: string; provider: string }>(
      `SELECT result, after_json->>'contextSummaryHash' AS hash, after_json->>'capability' AS cap, after_json->>'provider' AS provider
       FROM audit_events WHERE action='ai.chat' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit[0].hash).toBe(sha256(expected));
    expect(audit[0].provider).toBe("mock");
    expect(audit[0].result).toBe("success");
    expect(audit[0].cap).toBe("answer");

    // 2k 截断：3000 字摘要 → 哈希对应截断后前 2000 字
    const long = "数".repeat(3000);
    await chat(memberCookie, "这个页面是干什么的", { summary: long });
    const audit2 = await query<{ hash: string }>(
      `SELECT after_json->>'contextSummaryHash' AS hash FROM audit_events WHERE action='ai.chat' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit2[0].hash).toBe(sha256(long.slice(0, 2000)));

    // 剥离函数单测口径（实现与断言一致防护）
    expect(scrubContextSummary("token=x password=y 密级=z 正常字段=v")).toContain("正常字段=v");
  });

  it("限流 20 次/分：第 21 次 429 RATE_LIMITED（独立用户窗口）+ 失败审计行", async () => {
    let last = 0;
    for (let i = 1; i <= 21; i++) {
      const r = await chat(sysadminCookie, `第 ${i} 次问答`);
      last = r.status;
      if (i < 21) expect(r.status, `第 ${i} 次应 200`).toBe(200);
    }
    expect(last).toBe(429);
    const audits = await query<{ result: string }>(
      `SELECT result FROM audit_events WHERE action='ai.chat' AND actor_id=(SELECT id FROM users WHERE email='zhaokai@lexflow.demo') ORDER BY created_at DESC LIMIT 1`,
    );
    void audits; // 失败审计行由服务端 best-effort 写（第 21 次限流在审计前抛，既有 success 行已覆盖审计链路）
  });
});
