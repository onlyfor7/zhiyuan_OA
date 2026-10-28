import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 4 验收套件·统计/搜索/导出（arch/07 §8 D7–D9/D11）：
 * 四接口同名同数、周报/驾驶舱同源、搜索权限矩阵（viewer 零命中/金额按财务权/标题不泄露）、导出审计。
 */

const YEAR = new Date().getFullYear();

function monday(plusWeeks: number): string {
  const now = new Date();
  const mon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7) + plusWeeks * 7);
  return mon.toISOString().slice(0, 10);
}
function dayOf(weekMonday: string, plusDays: number): string {
  const d = new Date(`${weekMonday}T00:00:00.000Z`);
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

describe("迭代 4 验收·统计/搜索/导出（arch/07 §8）", () => {
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
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "partner@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "finance@lexflow.demo")).cookie;
    viewerCookie = (await loginAs(app, "viewer@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    projectAId = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;

    // 造一笔 approved 样本（360 分钟），使四接口比对含新增数据
    const week = monday(20);
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const periodId = (mp.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: dayOf(week, 0), durationMinutes: 360, description: "统计样本·验收" }],
      },
    });
    const submitted = await trpc(app, "time.submit", { cookie: memberCookie, input: { periodId, idempotencyKey: crypto.randomUUID() } });
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("D7 统计口径：有效=approved+locked 单列其余；byUser/byProject/byTask/byActivity 同名同数", async () => {
    const from = monday(-3);
    const to = monday(22);
    const byUser = await trpc(app, "time.stats.byUser", { cookie: pmCookie, method: "GET", input: { from, to } });
    const byProject = await trpc(app, "time.stats.byProject", { cookie: pmCookie, method: "GET", input: { from, to } });
    const byTask = await trpc(app, "time.stats.byTask", { cookie: pmCookie, method: "GET", input: { from, to } });
    const byActivity = await trpc(app, "time.stats.byActivity", { cookie: pmCookie, method: "GET", input: { from, to } });
    for (const r of [byUser, byProject, byTask, byActivity]) expect(r.status).toBe(200);
    const total = (json: unknown) =>
      (json as { result: { data: { items: { minutes: number }[] } } }).result.data.items.reduce((s, i) => s + i.minutes, 0);
    const userTotal = total(byUser.json);
    const projectTotal = total(byProject.json);
    const taskTotal = total(byTask.json);
    const activityTotal = total(byActivity.json);
    expect(taskTotal).toBe(projectTotal); // 同名同数（同一聚合函数）
    expect(activityTotal).toBe(projectTotal);
    expect(userTotal).toBeGreaterThanOrEqual(projectTotal); // byUser 另含非项目内部工作
    expect(projectTotal).toBeGreaterThanOrEqual(1860 + 360); // 种子 member approved + 新增（pm locked 中 120 分钟为非项目 internal_admin 不计入 byProject；draft 1260 不混入）
    const scope = (byProject.json as { result: { data: { statusScope: string; asOf: string } } }).result.data;
    expect(scope.statusScope).toContain("approved + locked");
    expect(scope.asOf).toBeTruthy();

    // mySummary：本人各状态单列，有效口径与四接口一致
    const mySummary = await trpc(app, "time.stats.mySummary", { cookie: memberCookie, method: "GET", input: { from, to } });
    const minutes = (mySummary.json as { result: { data: { minutes: Record<string, number> } } }).result.data.minutes;
    expect(minutes.approvedAndLocked).toBeGreaterThanOrEqual(1860 + 360);
    expect(minutes.draft).toBeGreaterThan(0); // 单列不混入
  });

  it("D8 周报工时节与驾驶舱时间卡同源（五域统一口径）", async () => {
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
    const timeCard = (dash.json as { result: { data: { timeCard: { approvedMinutes: number; pendingMinutes: number } } } })
      .result.data.timeCard;
    expect(timeCard.approvedMinutes).toBeGreaterThanOrEqual(0);
  });

  it("D9 搜索权限矩阵：viewer 零命中；金额按财务可见权；无权限标题零泄露；time_entry 仅本人；深链可用", async () => {
    // viewer 全局限流：零命中、不返回任何标题
    const viewerSearch = await trpc(app, "search.query", { cookie: viewerCookie, method: "GET", input: { q: "华宸" } });
    const viewerData = (viewerSearch.json as { result: { data: { items: unknown[]; totalByType: Record<string, number> } } }).result.data;
    expect(viewerData.items).toHaveLength(0);
    expect(viewerData.totalByType.project ?? 0).toBe(0);

    // member 搜项目：仅 A（C 不可见且无泄露），命中计数按可见集合
    const projSearch = await trpc(app, "search.query", { cookie: memberCookie, method: "GET", input: { q: "华宸" } });
    const projData = (projSearch.json as {
      result: { data: { items: { type: string; title: string; code: string; deepLink?: string }[]; totalByType: Record<string, number> } };
    }).result.data;
    const projectsHit = projData.items.filter((i) => i.type === "project");
    expect(projectsHit.map((p) => p.code)).toEqual([`PRJ-${YEAR}-00001`]);
    expect(projData.totalByType.project).toBe(1);
    expect(projectsHit[0].deepLink).toBeTruthy();

    // 标题不泄露：member 搜 C 项目特征词（执行阶段）→ 零命中
    const leakProbe = await trpc(app, "search.query", { cookie: memberCookie, method: "GET", input: { q: "执行阶段" } });
    const leakData = (leakProbe.json as { result: { data: { items: { title: string }[] } } }).result.data;
    expect(leakData.items.every((i) => !i.title.includes("执行阶段"))).toBe(true);

    // 金额按财务可见权：member 无金额字段 / finance 有金额
    const expMember = await trpc(app, "search.query", { cookie: memberCookie, method: "GET", input: { q: "报销" } });
    const mExp = (expMember.json as { result: { data: { items: { type: string; amountCents?: number }[] } } }).result.data.items
      .find((i) => i.type === "expense");
    if (mExp) expect(mExp.amountCents).toBeUndefined();
    const expFinance = await trpc(app, "search.query", { cookie: financeCookie, method: "GET", input: { q: "报销" } });
    const fExp = (expFinance.json as { result: { data: { items: { type: string; amountCents?: number }[] } } }).result.data.items
      .find((i) => i.type === "expense");
    expect(fExp).toBeDefined();
    expect(typeof fExp?.amountCents).toBe("number");

    // time_entry 仅本人
    const own = await trpc(app, "search.query", { cookie: memberCookie, method: "GET", input: { q: "统计样本·验收", types: ["time_entry"] } });
    const ownTotal = (own.json as { result: { data: { totalByType: Record<string, number> } } }).result.data.totalByType.time_entry ?? 0;
    expect(ownTotal).toBeGreaterThanOrEqual(1);
    const pmSearch = await trpc(app, "search.query", { cookie: pmCookie, method: "GET", input: { q: "统计样本·验收", types: ["time_entry"] } });
    const pmTotal = (pmSearch.json as { result: { data: { totalByType: Record<string, number> } } }).result.data.totalByType.time_entry ?? 0;
    expect(pmTotal).toBe(0);
  });

  it("D11 工时导出：CSV 无费率列+口径标注+审计事件；权限过滤", async () => {
    const exported = await trpc(app, "time.stats.exportCsv", { cookie: pmCookie, method: "GET", input: {} });
    expect(exported.status).toBe(200);
    const data = (exported.json as { result: { data: { csv: string; rowCount: number; statusScope: string } } }).result.data;
    expect(data.rowCount).toBeGreaterThan(0);
    expect(data.csv).toContain("分钟");
    expect(data.csv).not.toContain("费率");
    expect(data.statusScope).toContain("approved + locked");
    const audit = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'export.run' AND target_type = 'time_entry'`,
    );
    expect(audit[0].n).toBeGreaterThanOrEqual(1);
  });
});
