import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 9d · 工单 02（arch/12 §7）：财务核算服务端——
 * 权限三探针（finance/partner 通、member·sysadmin 404、PM 读通无 manage）、
 * 应收账龄分桶（宽限 fin.ar.overdue_grace_days）+ 自动生成幂等、收款勾稽应收同事务写回（与 9c 计划行写回同链）、
 * 发票开具联动（应收带出金额/默认税率/company_profile 抬头）与红冲（voided+冲正行）、成本率 upsert、
 * 项目核算 §7.3 冻结公式聚合（毛利双口径自勾稽）。
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

describe("9d-02 财务核算服务端", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let partnerCookie: string;
  let financeCookie: string;
  let pmCookie: string; // 王宝茁（全局 PM：fin.read 通、fin.manage 无）
  let memberCookie: string;
  let sysadminCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("权限三探针：finance/partner 全通；member·sysadmin 财务域 404 同形；PM 读通但无 fin.manage（成本率写 404）", async () => {
    for (const [name, cookie] of [["partner", partnerCookie], ["finance", financeCookie], ["pm", pmCookie]] as const) {
      expect((await trpc(app, "fin.receivables.list", { cookie, method: "GET", input: {} })).status, `${name} 应收`).toBe(200);
      expect((await trpc(app, "fin.invoices.list", { cookie, method: "GET", input: {} })).status, `${name} 发票`).toBe(200);
      expect((await trpc(app, "fin.projectCosting.list", { cookie, method: "GET" })).status, `${name} 核算`).toBe(200);
    }
    for (const [name, cookie] of [["member", memberCookie], ["sysadmin", sysadminCookie]] as const) {
      expect((await trpc(app, "fin.receivables.list", { cookie, method: "GET", input: {} })).status, `${name} 应收应 404`).toBe(404);
      expect((await trpc(app, "fin.invoices.list", { cookie, method: "GET", input: {} })).status, `${name} 发票应 404`).toBe(404);
      expect((await trpc(app, "fin.costRates.list", { cookie, method: "GET" })).status, `${name} 成本率应 404`).toBe(404);
      expect((await trpc(app, "fin.projectCosting.get", { cookie, method: "GET", input: { projectId: projectAId } })).status, `${name} 核算应 404`).toBe(404);
    }
    // PM 无 fin.manage：成本率写 404；partner 有
    expect((await trpc(app, "fin.costRates.upsert", { cookie: pmCookie, input: { role: "member", hourlyRateCents: 100, effectiveFrom: "2027-01-01" } })).status).toBe(404);
    expect((await trpc(app, "fin.costRates.upsert", { cookie: partnerCookie, input: { role: "qa_role_x", hourlyRateCents: 100, effectiveFrom: "2027-01-01" } })).status).toBe(200);
    // 二态校验：按人价+按角色价同给 → 400
    const both = await trpc(app, "fin.costRates.upsert", { cookie: financeCookie, input: { userId: crypto.randomUUID(), role: "member", hourlyRateCents: 100, effectiveFrom: "2027-01-01" } });
    expect(both.status).toBe(400);
  });

  it("应收账龄分桶（宽限 7 天）+ 自动生成幂等（种子 2 应收跳过，二次生成零新增）", async () => {
    const list = await trpc(app, "fin.receivables.list", { cookie: financeCookie, method: "GET", input: {} });
    expect(list.status).toBe(200);
    const data = (list.json as {
      result: {
        data: {
          graceDays: number;
          items: Array<{ code: string; overdueDays: number | null; agingBucket: string | null; status: string }>;
        };
      };
    }).result.data;
    expect(data.graceDays).toBe(7);
    const overdue = data.items.find((r) => r.code === `AR-${YEAR}-00001`)!;
    expect(overdue.status).toBe("open");
    expect(overdue.overdueDays).not.toBeNull();
    expect(overdue.overdueDays!).toBeGreaterThan(7); // 超宽限 → 逾期
    expect(overdue.agingBucket).toBe("0-30");
    const future = data.items.find((r) => r.code === `AR-${YEAR}-00002`)!;
    expect(future.agingBucket).toBeNull();
    expect(future.overdueDays).toBeNull();

    // 首次：种子 2 计划行应收跳过（幂等），GD 激活合同补 1 条 contract_active 应收（on_contract_active 开关）
    const before = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM fin_receivables`))[0].n;
    const g1 = await trpc(app, "fin.receivables.generate", { cookie: financeCookie, input: {} });
    expect(g1.status).toBe(200);
    expect((g1.json as { result: { data: { created: number } } }).result.data.created).toBe(1);
    // 二次：全部已存在 → 零新增（幂等），总数稳定
    const g2 = await trpc(app, "fin.receivables.generate", { cookie: financeCookie, input: {} });
    expect((g2.json as { result: { data: { created: number } } }).result.data.created).toBe(0);
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM fin_receivables`))[0].n).toBe(before + 1);
  });

  it("回款勾稽应收同事务写回：挂计划行全额 → 应收 settled；作废冲正 → 回 open（与 9c 计划行写回同链）", async () => {
    // 种子 GD 合同计划行已挂应收（AR-00001 挂 seq1 due t-10）
    const plans = await query<{ id: string; receivable_id: string | null; amount_cents: number; seq: number }>(
      `SELECT pp.id, ar.id AS receivable_id, pp.amount_cents, pp.seq
       FROM crm_contract_payment_plans pp JOIN fin_receivables ar ON ar.plan_id = pp.id
       WHERE pp.seq = 1 ORDER BY pp.id LIMIT 1`,
    );
    expect(plans.length).toBe(1);
    const { id: planId, receivable_id: arId, amount_cents: amount } = plans[0];
    const arBefore = await query<{ status: string }>(`SELECT status FROM fin_receivables WHERE id=$1`, [arId]);
    expect(arBefore[0].status).toBe("open");

    const receipt = await trpc(app, "receipts.create", {
      cookie: financeCookie,
      input: {
        projectId: projectAId, amountCents: Number(amount), receivedOn: "2027-06-01", referenceNo: "FIN-AR-LINK",
        idempotencyKey: crypto.randomUUID(), contractId: (await query<{ contract_id: string }>(`SELECT contract_id FROM crm_contract_payment_plans WHERE id=$1`, [planId]))[0].contract_id, planId,
      },
    });
    expect(receipt.status, `receipts.create 响应：${JSON.stringify(receipt.json).slice(0, 300)}`).toBe(200);
    const arAfter = await query<{ status: string }>(`SELECT status FROM fin_receivables WHERE id=$1`, [arId]);
    expect(arAfter[0].status).toBe("settled"); // 同事务写回（与计划行 paid 同链）

    // 作废冲正 → 应收回 open
    const rid = (receipt.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const voided = await trpc(app, "receipts.void", { cookie: financeCookie, input: { id: rid.id, reason: "勾稽冲正验收", rowVersion: rid.rowVersion } });
    expect(voided.status).toBe(200);
    const arFinal = await query<{ status: string }>(`SELECT status FROM fin_receivables WHERE id=$1`, [arId]);
    expect(arFinal[0].status).toBe("open");
  });

  it("发票：开具联动（应收带出金额/默认税率/抬头 company_profile）、状态机与红冲（voided+负数冲正行，重放安全）", async () => {
    // 抬头取 company_profile
    const ar = await query<{ id: string; amount_cents: number; customer_id: string }>(`SELECT id, amount_cents, customer_id FROM fin_receivables WHERE code=$1`, [`AR-${YEAR}-00002`]);
    const created = await trpc(app, "fin.invoices.create", {
      cookie: financeCookie,
      input: { customerId: ar[0].customer_id, receivableId: ar[0].id }, // 金额不带出显式 → 应收额；税率默认 6
    });
    expect(created.status).toBe(200);
    const createdData = (created.json as { result: { data: { invoice: { id: string; rowVersion: number; amountCents: number; taxRate: number; code: string }; company: { name: string; creditCode: string } | null } } }).result.data;
    expect(createdData.invoice.amountCents).toBe(Number(ar[0].amount_cents)); // 联动带出（pg bigint 直查为 string）
    expect(createdData.invoice.taxRate).toBe(6); // fin.invoice.default_tax_rate
    expect(createdData.company?.name).toBe("因诺智元");
    expect(createdData.company?.creditCode.length).toBeGreaterThan(0);

    const issued = await trpc(app, "fin.invoices.issue", { cookie: financeCookie, input: { id: createdData.invoice.id, rowVersion: createdData.invoice.rowVersion } });
    expect(issued.status).toBe(200);
    const sent = await trpc(app, "fin.invoices.markSent", { cookie: financeCookie, input: { id: createdData.invoice.id, rowVersion: createdData.invoice.rowVersion + 1 } });
    expect(sent.status).toBe(200);

    // 红冲：sent → voided + 负数冲正行
    const voided = await trpc(app, "fin.invoices.void", { cookie: financeCookie, input: { id: createdData.invoice.id, rowVersion: createdData.invoice.rowVersion + 2, reason: "开票有误红冲" } });
    expect(voided.status).toBe(200);
    const voidData = (voided.json as { result: { data: { invoice: { status: string }; reversal: { amountCents: number; taxRate: number; status: string; code: string } | null } } }).result.data;
    expect(voidData.invoice.status).toBe("voided");
    expect(voidData.reversal).toBeTruthy();
    expect(voidData.reversal!.amountCents).toBe(-createdData.invoice.amountCents);
    expect(voidData.reversal!.taxRate).toBe(6);
    expect(voidData.reversal!.code).toMatch(new RegExp(`^INV-${YEAR}-`));

    // 红冲重放：已 voided → replayed 零副作用
    const voidReplay = await trpc(app, "fin.invoices.void", { cookie: financeCookie, input: { id: createdData.invoice.id, rowVersion: 99, reason: "x" } });
    expect(voidReplay.status).toBe(200);
    expect((voidReplay.json as { result: { data: { replayed: boolean } } }).result.data.replayed).toBe(true);

    // 原因必填
    const noReason = await trpc(app, "fin.invoices.void", { cookie: financeCookie, input: { id: voidData.reversal!.code ? createdData.invoice.id : createdData.invoice.id, rowVersion: 0, reason: " " } });
    expect([400, 409]).toContain(noReason.status);
  });

  it("项目核算 §7.3 公式：八字段齐 + 毛利双口径自勾稽 + 回款=registered−voided 净额", async () => {
    const costing = await trpc(app, "fin.projectCosting.get", { cookie: financeCookie, method: "GET", input: { projectId: projectAId } });
    expect(costing.status).toBe(200);
    const c = (costing.json as { result: { data: Record<string, number> } }).result.data;
    for (const k of ["revenueCents", "receivedCents", "arBalanceCents", "directCostCents", "laborCostCents", "grossMarginCents", "grossMarginOnContractCents"]) {
      expect(typeof c[k], `字段 ${k}`).toBe("number");
    }
    // 公式自勾稽：回款口径毛利 = 已回款 − 直接 − 人力；签约口径 = 收入 − 直接 − 人力
    expect(c.grossMarginCents).toBe(c.receivedCents - c.directCostCents - c.laborCostCents);
    expect(c.grossMarginOnContractCents).toBe(c.revenueCents - c.directCostCents - c.laborCostCents);
    // 已回款净额与台账一致（独立重算勾稽）
    const net = await query<{ net: number }>(
      `SELECT coalesce(sum(amount_cents) filter (where status='registered'),0)::float8
            - coalesce(sum(amount_cents) filter (where status='voided'),0)::float8 AS net
       FROM payment_receipts WHERE project_id=$1`,
      [projectAId],
    );
    expect(c.receivedCents).toBe(Number(net[0].net));
    // list 同口径
    const all = await trpc(app, "fin.projectCosting.list", { cookie: partnerCookie, method: "GET" });
    expect(all.status).toBe(200);
    expect((all.json as { result: { data: unknown[] } }).result.data.length).toBeGreaterThanOrEqual(5);
  });
});
