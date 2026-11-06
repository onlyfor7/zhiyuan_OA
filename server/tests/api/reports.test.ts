import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { computeAging } from "../../src/modules/fin/fin";
import { getApp, loginAs, setupDatabase, trpc } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 9e · 工单 01（arch/12 §8/§11）：报表聚合与导出——
 * 九报表统一 {columns,rows,summaryCards}、口径复用 services 既有聚合（抽样重算勾稽）、
 * 权限探针（登录全员可读，行级按域口径：member 本人口径/无财务权空集/partner 穿透）、
 * 导出走文件管道（file_objects source=report + HMAC 令牌可下载 + report.export 审计行含筛选快照）。
 */

const YEAR = new Date().getFullYear();

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

interface ReportShape {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
  summaryCards: Array<{ key: string; label: string; value: number | string }>;
}

describe("9e-01 报表聚合与导出", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let partnerCookie: string;
  let financeCookie: string;
  let memberCookie: string; // 管晨（本人口径）
  let pmCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("九报表统一形状全通（{columns,rows,summaryCards}）+ 口径抽样勾稽（costing 与 9d 同数/账龄与 fin 同桶）", async () => {
    const keys: Array<[string, Record<string, unknown>?]> = [
      ["projectHealth", {}],
      ["projectDelay", {}],
      ["projectCosting", {}],
      ["receivableAging", {}],
      ["expenseCategory", {}],
      ["monthlyCashflow", {}],
      ["timeSummary", { view: "person" }],
      ["timeSummary", { view: "department" }],
      ["utilization", {}],
      ["opportunityFunnel", {}],
      ["customerContribution", {}],
    ];
    for (const [proc, extra] of keys) {
      const r = await trpc(app, `reports.${proc}`, { cookie: financeCookie, method: "GET", input: { ...extra } });
      expect(r.status, `reports.${proc}`).toBe(200);
      const d = (r.json as { result: { data: ReportShape } }).result.data;
      expect(Array.isArray(d.columns), `${proc} columns`).toBe(true);
      expect(Array.isArray(d.rows), `${proc} rows`).toBe(true);
      expect(Array.isArray(d.summaryCards), `${proc} summaryCards`).toBe(true);
    }

    // 口径勾稽 1：收支核算表 received 合计 == 全项目 registered−voided 净额（台账独立重算）
    const costing = (await trpc(app, "reports.projectCosting", { cookie: financeCookie, method: "GET", input: {} })).json as { result: { data: ReportShape } };
    const costingReceived = (costing.result.data.summaryCards.find((c) => c.key === "received")?.value ?? 0) as number;
    const net = await query<{ net: number }>(
      `SELECT coalesce(sum(amount_cents) filter (where status='registered'),0)::float8
            - coalesce(sum(amount_cents) filter (where status='voided'),0)::float8 AS net
       FROM payment_receipts`,
    );
    expect(costingReceived).toBe(Number(net[0].net));

    // 口径勾稽 2：账龄分析逾期总额 == fin 应收超宽限行金额和（同 computeAging 口径）
    const aging = (await trpc(app, "reports.receivableAging", { cookie: financeCookie, method: "GET", input: {} })).json as { result: { data: ReportShape } };
    const agingOverdue = (aging.result.data.summaryCards.find((c) => c.key === "overdue")?.value ?? 0) as number;
    const arRows = await query<{ due_date: string; amount_cents: string }>(`SELECT due_date, amount_cents FROM fin_receivables`);
    // 同函数勾稽：对原始行重放 fin.computeAging（宽限 7）求逾期合计
    const expectedOverdue = arRows.reduce(
      (s, r) => s + (computeAging(new Date(r.due_date as string).toISOString().slice(0, 10), 7).agingBucket ? Number(r.amount_cents) : 0),
      0,
    );
    expect(agingOverdue, `AR=${JSON.stringify(arRows)} expected=${expectedOverdue}`).toBe(expectedOverdue);

    // 口径勾稽 3：月度收支「收」合计 == registered 收款总额（区间内）
    const cash = (await trpc(app, "reports.monthlyCashflow", { cookie: financeCookie, method: "GET", input: {} })).json as { result: { data: ReportShape } };
    const cashIn = (cash.result.data.summaryCards.find((c) => c.key === "income")?.value ?? 0) as number;
    const regSum = await query<{ s: number }>(`SELECT coalesce(sum(amount_cents),0)::float8 AS s FROM payment_receipts WHERE status='registered'`);
    expect(cashIn).toBe(Number(regSum[0].s));
  });

  it("权限探针：member 本人口径（费用类别只见本人/收款账龄与商机无权限空集）/partner 全局穿透/无财务权域空集", async () => {
    // partner 穿透：项目健康度可见全部项目（5）
    const partnerHealth = (await trpc(app, "reports.projectHealth", { cookie: partnerCookie, method: "GET", input: {} })).json as { result: { data: ReportShape } };
    const partnerTotal = partnerHealth.result.data.summaryCards.find((c) => c.key === "total")?.value;
    expect(partnerTotal).toBe(5);
    // member 仅见本项目（项目 A）
    const memberHealth = (await trpc(app, "reports.projectHealth", { cookie: memberCookie, method: "GET", input: {} })).json as { result: { data: ReportShape } };
    expect(memberHealth.result.data.summaryCards.find((c) => c.key === "total")?.value).toBe(1);
    // member 收款账龄无财务权 → 空集（200 同形状）
    const memberAging = (await trpc(app, "reports.receivableAging", { cookie: memberCookie, method: "GET", input: {} })).json as { result: { data: ReportShape } };
    expect(memberAging.result.data.rows).toHaveLength(0);
    // member 费用类别 = 本人费用口径：行数≤本人费用类别数（非全量）
    const memberExpense = (await trpc(app, "reports.expenseCategory", { cookie: memberCookie, method: "GET", input: {} })).json as { result: { data: ReportShape } };
    const allExpense = (await trpc(app, "reports.expenseCategory", { cookie: financeCookie, method: "GET", input: {} })).json as { result: { data: ReportShape } };
    expect((memberExpense.result.data.summaryCards.find((c) => c.key === "total")?.value ?? 0) as number)
      .toBeLessThanOrEqual((allExpense.result.data.summaryCards.find((c) => c.key === "total")?.value ?? 0) as number);
    // member 无 CRM 权 → 漏斗/贡献空集；partner 有金额列
    const memberFunnel = (await trpc(app, "reports.opportunityFunnel", { cookie: memberCookie, method: "GET", input: {} })).json as { result: { data: ReportShape } };
    expect(memberFunnel.result.data.rows).toHaveLength(0);
    const partnerFunnel = (await trpc(app, "reports.opportunityFunnel", { cookie: partnerCookie, method: "GET", input: {} })).json as { result: { data: ReportShape } };
    expect(partnerFunnel.result.data.columns.some((c) => c.key === "amount")).toBe(true);
    expect(partnerFunnel.result.data.rows.length).toBeGreaterThanOrEqual(6);
    // member 导出同 read 口径：可导出（本人口径数据）
    const memberExport = await trpc(app, "reports.exportCsv", { cookie: memberCookie, input: { key: "time_summary", filter: { view: "person" } } });
    expect(memberExport.status, `memberExport：${JSON.stringify(memberExport.json).slice(0, 300)}`).toBe(200);
  });

  it("导出走文件管道：file_objects(source=report) 落库 + HMAC 令牌下载 200（无会话）+ report.export 审计行含 key+筛选快照", async () => {
    const filter = { projectId: projectAId, from: "2026-01-01", to: "2026-12-31" };
    const exported = await trpc(app, "reports.exportCsv", {
      cookie: financeCookie,
      input: { key: "project_costing", filter, idempotencyKey: crypto.randomUUID() },
    });
    expect(exported.status, `export 响应：${JSON.stringify(exported.json).slice(0, 300)}`).toBe(200);
    const data = (exported.json as {
      result: {
        data: { rowCount: number; fileObjectId: string; fileVersionId: string; downloadPath: string };
      };
    }).result.data;
    expect(data.rowCount).toBeGreaterThanOrEqual(1);
    expect(data.downloadPath).toContain(`/files/${data.fileVersionId}/download?token=`);

    // 落库形状：file_objects source_type='report'、source_id=报表 key
    const fo = await query<{ source_type: string; source_id: string | null }>(`SELECT source_type, source_id FROM file_objects WHERE id=$1`, [data.fileObjectId]);
    expect(fo[0].source_type).toBe("report");
    expect(fo[0].source_id).toBeNull(); // uuid 列：报表 key 溯源走审计行快照

    // HMAC 令牌无会话下载 200 + CSV 内容含表头
    const download = await app.request(`http://test${data.downloadPath}`, { method: "GET" });
    expect(download.status).toBe(200);
    const body = await download.text();
    expect(body).toContain("项目编号");
    expect(body.length).toBeGreaterThan(data.rowCount * 10);

    // 审计行：report.export 含 key + 筛选快照
    const audit = await query<{ n: number; key: string | null; filter: { projectId?: string } | null }>(
      `SELECT count(*)::int AS n, after_json->>'key' AS key, after_json->'filter' AS filter
       FROM audit_events WHERE action='report.export' GROUP BY after_json`,
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].key).toBe("project_costing");
    expect(audit[0].filter?.projectId).toBe(projectAId);
  });

  it("utilization 与 timeSummary 三视角：工作日×8h 可用口径 + 部门归并数", async () => {
    const from = "2026-01-05";
    const to = "2026-01-11";
    const util = (await trpc(app, "reports.utilization", { cookie: financeCookie, method: "GET", input: { from, to } })).json as { result: { data: ReportShape } };
    // 同算法独立重算工作日×480（2026-01-05~11 恰一周：5 个工作日 → 2400）
    let workdays = 0;
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) workdays++;
    }
    for (const row of util.result.data.rows as Array<{ availableMinutes: number }>) {
      expect(row.availableMinutes).toBe(workdays * 480);
    }

    const dept = (await trpc(app, "reports.timeSummary", { cookie: financeCookie, method: "GET", input: { view: "department" } })).json as { result: { data: ReportShape } };
    const person = (await trpc(app, "reports.timeSummary", { cookie: financeCookie, method: "GET", input: { view: "person" } })).json as { result: { data: ReportShape } };
    // 勾稽：部门归并合计 == 人视角合计（口径一致），且部门数 ≥1
    const deptTotal = (dept.result.data.summaryCards.find((c) => c.key === "total")?.value ?? 0) as number;
    const personTotal = (person.result.data.summaryCards.find((c) => c.key === "total")?.value ?? 0) as number;
    expect(dept.result.data.rows.length, `dept=${JSON.stringify(dept.result.data.rows).slice(0, 200)}`).toBeGreaterThanOrEqual(1);
    expect(deptTotal).toBe(personTotal);
  });
});
