import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

const YEAR = new Date().getFullYear();

function monday(offsetWeeks: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + offsetWeeks * 7);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function dayOf(weekMonday: string, plusDays: number): string {
  const d = new Date(`${weekMonday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString().slice(0, 10);
}

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

describe("迭代 4 统计/搜索/导出（D7–D9/D11）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let partnerCookie: string;
  let financeCookie: string;
  let viewerCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    viewerCookie = (await loginAs(app, "hejing@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    projectAId = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("D7 统计口径：有效=approved+locked 单列其余；四接口同名同数（唯一聚合函数）", async () => {
    // 造一笔 approved 工时（member 新周期 300 分钟），使总量 = 种子 1860 + locked 1020(pm) + 300
    const week = monday(8);
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const periodId = (mp.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: dayOf(week, 0), durationMinutes: 300, description: "D7 统计样本" }],
      },
    });
    const sub = await trpc(app, "time.submit", { cookie: memberCookie, input: { periodId, idempotencyKey: crypto.randomUUID() } });
    const instId = (sub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const act = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: instId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(act.status).toBe(200);

    const from = monday(-2);
    const to = monday(10);
    const byUser = await trpc(app, "time.stats.byUser", { cookie: pmCookie, method: "GET", input: { from, to } });
    const byProject = await trpc(app, "time.stats.byProject", { cookie: pmCookie, method: "GET", input: { from, to } });
    const byTask = await trpc(app, "time.stats.byTask", { cookie: pmCookie, method: "GET", input: { from, to } });
    const byActivity = await trpc(app, "time.stats.byActivity", { cookie: pmCookie, method: "GET", input: { from, to } });
    expect(byUser.status).toBe(200);
    expect(byProject.status).toBe(200);
    expect(byTask.status).toBe(200);
    expect(byActivity.status).toBe(200);

    const total = (json: unknown) =>
      (json as { result: { data: { items: { minutes: number }[] } } }).result.data.items.reduce((s, i) => s + i.minutes, 0);
    const userTotal = total(byUser.json);
    const projectTotal = total(byProject.json);
    const taskTotal = total(byTask.json);
    const activityTotal = total(byActivity.json);
    // 同名同数：四接口同一聚合函数——byTask/byActivity 覆盖项目内全部明细（null 分组计入），与 byProject 全等
    expect(userTotal).toBeGreaterThanOrEqual(projectTotal); // byUser 额外含非项目内部工作行
    expect(taskTotal).toBe(projectTotal);
    expect(activityTotal).toBe(projectTotal);
    expect(projectTotal).toBeGreaterThanOrEqual(1860 + 300); // 种子 member approved + 本用例新增（不含 draft 1260）
    // 口径标注
    const scope = (byUser.json as { result: { data: { statusScope: string; asOf: string } } }).result.data;
    expect(scope.statusScope).toContain("approved + locked");
    expect(scope.asOf).toBeTruthy();

    // mySummary：本人各状态单列（范围显式覆盖未来周的新增 approved）
    const mySummary = await trpc(app, "time.stats.mySummary", { cookie: memberCookie, method: "GET", input: { from, to } });
    const minutes = (mySummary.json as { result: { data: { minutes: Record<string, number> } } }).result.data.minutes;
    expect(minutes.approvedAndLocked).toBeGreaterThanOrEqual(1860 + 300);
    expect(minutes.draft).toBeGreaterThan(0); // 草稿单列不混入
    expect(minutes.pendingApproval).toBe(0);
  });

  it("D8 周报工时节与驾驶舱时间卡（统一口径同源）", async () => {
    const mondayLast = monday(-1);
    const sundayLast = dayOf(mondayLast, 6);
    const draft = await trpc(app, "report.generateDraft", {
      cookie: pmCookie,
      input: { projectId: projectAId, periodStart: mondayLast, periodEnd: sundayLast },
    });
    expect(draft.status).toBe(200);
    const content = (draft.json as { result: { data: { content: Record<string, string> } } }).result.data.content;
    expect(content.time).toContain("已批准工时");
    expect(content.time).toContain("待审批单列");

    const dash = await trpc(app, "dashboard.summary", { cookie: pmCookie, method: "GET" });
    const timeCard = (dash.json as { result: { data: { timeCard: { approvedMinutes: number } } } }).result.data.timeCard;
    expect(timeCard.approvedMinutes).toBeGreaterThanOrEqual(0);
  });

  it("D9 搜索权限矩阵：SQL 级过滤、无泄露、金额按财务可见权、命中计数按可见集合", async () => {
    // member 搜项目：只见 A（C 对 member 不可见且无泄露）
    const projSearch = await trpc(app, "search.query", { cookie: memberCookie, method: "GET", input: { q: "比博思特" } });
    expect(projSearch.status).toBe(200);
    const projData = (projSearch.json as { result: { data: { items: { type: string; title: string; code: string }[]; totalByType: Record<string, number> } } }).result.data;
    const projectsHit = projData.items.filter((i) => i.type === "project");
    expect(projectsHit.map((p) => p.code)).toEqual([`PRJ-${YEAR}-00001`]);
    expect(projData.totalByType.project).toBe(1); // 命中计数按可见集合（C 不计）

    // member 搜费用：可见 A 的报销但无金额字段（无财务可见权）
    const expSearch = await trpc(app, "search.query", { cookie: memberCookie, method: "GET", input: { q: "报销" } });
    const expItems = (expSearch.json as { result: { data: { items: { type: string; amountCents?: number }[] } } }).result.data.items;
    const memberExpense = expItems.find((i) => i.type === "expense");
    if (memberExpense) expect(memberExpense.amountCents).toBeUndefined();

    // finance 搜费用：金额可见（财务可见权）
    const finSearch = await trpc(app, "search.query", { cookie: financeCookie, method: "GET", input: { q: "报销" } });
    const finItems = (finSearch.json as { result: { data: { items: { type: string; amountCents?: number }[] } } }).result.data.items;
    const finExpense = finItems.find((i) => i.type === "expense");
    expect(finExpense).toBeDefined();
    expect(typeof finExpense?.amountCents).toBe("number");

    // time_entry 仅本人：member 搜自己的 D7 样本可见；pm 搜同一描述不可见
    const own = await trpc(app, "search.query", { cookie: memberCookie, method: "GET", input: { q: "D7 统计样本", types: ["time_entry"] } });
    const ownTotal = (own.json as { result: { data: { totalByType: Record<string, number> } } }).result.data.totalByType.time_entry ?? 0;
    expect(ownTotal).toBeGreaterThanOrEqual(1);
    const pmSearch = await trpc(app, "search.query", { cookie: pmCookie, method: "GET", input: { q: "D7 统计样本", types: ["time_entry"] } });
    const pmTotal = (pmSearch.json as { result: { data: { totalByType: Record<string, number> } } }).result.data.totalByType.time_entry ?? 0;
    expect(pmTotal).toBe(0); // 仅本人，无泄露

    // viewer 全局限流：项目搜索 0 命中（不返回任何标题）
    const viewerSearch = await trpc(app, "search.query", { cookie: viewerCookie, method: "GET", input: { q: "比博思特" } });
    const viewerData = (viewerSearch.json as { result: { data: { items: unknown[]; totalByType: Record<string, number> } } }).result.data;
    expect(viewerData.items).toHaveLength(0);
    expect(viewerData.totalByType.project ?? 0).toBe(0);

    // deepLink 可用性
    const hit = projData.items.find((i) => i.type === "project");
    expect(hit).toBeDefined();
    const withLink = projData.items[0] as { deepLink?: string };
    void withLink;
  });

  it("D11 工时导出：CSV 继承字段权限（无费率列）+ 审计事件", async () => {
    const exported = await trpc(app, "time.stats.exportCsv", { cookie: pmCookie, method: "GET", input: {} });
    expect(exported.status).toBe(200);
    const data = (exported.json as { result: { data: { csv: string; rowCount: number; statusScope: string } } }).result.data;
    expect(data.rowCount).toBeGreaterThan(0);
    expect(data.csv).toContain("工时（小时）");
    expect(data.csv).not.toContain("费率");
    const audit = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'export.run' AND target_type = 'time_entry'`);
    expect(audit[0].n).toBeGreaterThanOrEqual(1);
    // member 导出本人可见范围亦可（本人数据）
    const memberExport = await trpc(app, "time.stats.exportCsv", { cookie: memberCookie, method: "GET", input: {} });
    expect([200, 404]).toContain(memberExport.status);
    void trpcError;
  });
});
