import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { TEST_DATABASE_URL } from "../db/helpers";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";

/**
 * 迭代 18 · 工单 02d（O-18-5-1 / O-18-5-3，只修两项）：
 * ① admin.correctRecord object:"user"——users 无 row_version 列，走 updated_at 服务端快照内部乐观校验（绝不引用 row_version），冲突 409；
 * ② crm.customers.getById / contracts.list / contracts.getById 金额口径与 D4 一致——finance 仅 active 合同放行（外层+累计+计划行），draft/terminated 剥离，plan 行金额同步剥离。
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

describe("18-02d 受控纠正与金额口径修复", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let sysadminCookie: string;
  let financeCookie: string;
  let partnerCookie: string;
  let pmCookie: string;
  let memberCookie: string;
  let pmUserId: string;
  let salesAId: string;
  let smId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    const ids = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email IN ('wangbaozhuo@lexflow.demo','sumingxuan@lexflow.demo','zhenghaoran@lexflow.demo')`,
    );
    pmUserId = ids.find((u) => u.email.startsWith("wangbaozhuo"))!.id;
    salesAId = ids.find((u) => u.email.startsWith("sumingxuan"))!.id;
    smId = ids.find((u) => u.email.startsWith("zhenghaoran"))!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("O-18-5-1：user 纠正成功 200+落库+审计齐全 / 成环 400 / 非白名单 400 / 并发快照冲突 409", async () => {
    // ① user 纠正职位成功：200 + DB 落值 + 审计 before/after/理由/patchedFields
    const fixed = await trpc(app, "admin.correctRecord", {
      cookie: sysadminCookie,
      input: { object: "user", id: salesAId, rowVersion: 0, patch: { position: "高级销售经理" }, reason: "岗位晋升纠正" },
    });
    expect(fixed.status, JSON.stringify(fixed.json).slice(0, 200)).toBe(200);
    const row = await query<{ position: string }>(`SELECT position FROM users WHERE id=$1`, [salesAId]);
    expect(row[0].position).toBe("高级销售经理");
    const audit = await query<{ before_json: Record<string, unknown>; after_json: Record<string, unknown> }>(
      `SELECT before_json, after_json FROM audit_events WHERE action='admin.correctRecord' AND target_id=$1`,
      [salesAId],
    );
    expect(audit.length).toBe(1);
    expect(audit[0].after_json.position).toBe("高级销售经理");
    expect(audit[0].after_json.correctReason).toBe("岗位晋升纠正");
    expect(audit[0].after_json.patchedFields).toEqual(["position"]);
    expect(audit[0].before_json).toHaveProperty("email");

    // ② managerId 成环 400（把郑浩然的主管改为苏明轩——苏→郑→苏 成环；注意苏当前主管本就是郑，属同值 no-op 非环）
    const cycle = await trpc(app, "admin.correctRecord", {
      cookie: sysadminCookie,
      input: { object: "user", id: smId, rowVersion: 0, patch: { managerId: salesAId }, reason: "试图成环" },
    });
    expect(cycle.status).toBe(400);
    expect(trpcError(cycle).fieldErrors?.managerId).toBeTruthy();

    // ③ 非白名单字段 400
    const bad = await trpc(app, "admin.correctRecord", {
      cookie: sysadminCookie,
      input: { object: "user", id: salesAId, rowVersion: 0, patch: { email: "x@y.z" }, reason: "试图改邮箱" },
    });
    expect(bad.status).toBe(400);

    // ④ 并发快照冲突：Promise.all 两个不同补丁并发纠正同一用户——恰一个 200 一个 409（快照锁生效）
    const [c1, c2] = await Promise.all([
      trpc(app, "admin.correctRecord", { cookie: sysadminCookie, input: { object: "user", id: salesAId, rowVersion: 0, patch: { position: "并发甲" }, reason: "并发甲" } }),
      trpc(app, "admin.correctRecord", { cookie: sysadminCookie, input: { object: "user", id: salesAId, rowVersion: 0, patch: { position: "并发乙" }, reason: "并发乙" } }),
    ]);
    const statuses = [c1.status, c2.status].sort();
    expect(statuses, `并发结果 ${JSON.stringify([c1.status, c2.status])}`).toEqual([200, 409]);
    const finalRow = await query<{ position: string }>(`SELECT position FROM users WHERE id=$1`, [salesAId]);
    expect(["并发甲", "并发乙"]).toContain(finalRow[0].position);
  });

  it("O-18-5-3：finance 合同金额按 D4——active 放行（外层+累计+计划行）/draft/terminated 剥离/plan 行同步剥离/各形态口径", async () => {
    // 造客户（partner 线索转化）+ 合同 A（激活）+ 合同 B（草稿→激活→终止）
    const lead = await trpc(app, "crm.leads.create", { cookie: partnerCookie, input: { name: "02d 金额口径线索" } });
    const l1 = (lead.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const conv = await trpc(app, "crm.leads.convert", {
      cookie: partnerCookie,
      input: { id: l1.id, rowVersion: l1.rowVersion, customer: { name: "02d 金额口径客户" }, projectManagerId: pmUserId, opportunity: { name: "02d 商机A" } },
    });
    const customerId = (conv.json as { result: { data: { customerId: string; opportunityId: string } } }).result.data.customerId;
    const oppA = (conv.json as { result: { data: { opportunityId: string } } }).result.data.opportunityId;
    const oppADetail = await trpc(app, "crm.opportunities.getById", { cookie: partnerCookie, method: "GET", input: { id: oppA } });
    const wonA = await trpc(app, "crm.opportunities.markWon", {
      cookie: partnerCookie,
      input: { id: oppA, rowVersion: (oppADetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, contract: { title: "02d 合同A", amountCents: 800000, activate: true } },
    });
    expect(wonA.status).toBe(200);
    const contractA = (wonA.json as { result: { data: { contract: { id: string } } } }).result.data.contract;
    const plansA = await trpc(app, "crm.paymentPlans.upsert", {
      cookie: partnerCookie,
      input: { contractId: contractA.id, rows: [{ seq: 1, dueDate: "2027-01-15", amountCents: 400000 }, { seq: 2, dueDate: "2027-02-15", amountCents: 400000 }] },
    });
    expect(plansA.status).toBe(200);

    // 合同 B：同客户第二商机，draft 带计划行
    const oppB = await trpc(app, "crm.opportunities.create", {
      cookie: partnerCookie,
      input: { customerId, name: "02d 商机B", projectManagerId: pmUserId, idempotencyKey: uuid() },
    });
    const oppBData = (oppB.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const wonB = await trpc(app, "crm.opportunities.markWon", {
      cookie: partnerCookie,
      input: { id: oppBData.id, rowVersion: oppBData.rowVersion, contract: { title: "02d 合同B", amountCents: 300000, activate: false } },
    });
    const contractB = (wonB.json as { result: { data: { contract: { id: string } } } }).result.data.contract;
    const plansB = await trpc(app, "crm.paymentPlans.upsert", {
      cookie: partnerCookie,
      input: { contractId: contractB.id, rows: [{ seq: 1, dueDate: "2027-03-15", amountCents: 300000 }] },
    });
    expect(plansB.status).toBe(200);

    type CtrItem = { id: string; status: string; amountCents?: number; cumulativeReceivedCents?: number; plans: Array<{ amountCents?: number }> };
    const detailAs = async (cookie: string) => {
      const res = await trpc(app, "crm.customers.getById", { cookie, method: "GET", input: { id: customerId } });
      return res;
    };
    const contractsOf = (res: Awaited<ReturnType<typeof detailAs>>) =>
      ((res.json as { result: { data: { contracts: CtrItem[] } } }).result.data.contracts);

    // ① finance 客户详情：active 合同 A 外层金额/累计回款/计划行金额可见；draft 合同 B 整体缺席（D4 过滤）
    const fDetail = await detailAs(financeCookie);
    expect(fDetail.status).toBe(200);
    const fCtr = contractsOf(fDetail);
    const fA = fCtr.find((c) => c.id === contractA.id)!;
    expect(fA).toBeTruthy();
    expect(fA.amountCents).toBe(800000);
    expect(fA.cumulativeReceivedCents).toBe(0);
    expect(fA.plans[0].amountCents).toBe(400000);
    expect(fCtr.some((c) => c.id === contractB.id)).toBe(false); // draft 不给明细（过滤强于剥离）

    // ② pm（project 形态，金额不可见）：A/B 在列但外层与计划行金额全剥离
    const pmDetail = await detailAs(pmCookie);
    expect(pmDetail.status).toBe(200);
    const pmCtr = contractsOf(pmDetail);
    expect(pmCtr.length).toBe(2);
    for (const c of pmCtr) {
      expect(c.amountCents).toBeUndefined();
      expect(c.cumulativeReceivedCents).toBeUndefined();
      for (const p of c.plans) expect(p.amountCents).toBeUndefined();
    }
    // contracts.list/getById 同步剥离（pm 视角）
    const pmList = await trpc(app, "crm.contracts.list", { cookie: pmCookie, method: "GET", input: { customerId } });
    for (const c of (pmList.json as { result: { data: { items: CtrItem[] } } }).result.data.items) {
      expect(c.amountCents).toBeUndefined();
      for (const p of c.plans) expect(p.amountCents).toBeUndefined();
    }
    const pmGet = await trpc(app, "crm.contracts.getById", { cookie: pmCookie, method: "GET", input: { id: contractA.id } });
    const pmGetData = (pmGet.json as { result: { data: CtrItem } }).result.data;
    expect(pmGetData.amountCents).toBeUndefined();
    expect(pmGetData.plans[0].amountCents).toBeUndefined();

    // ③ partner/operations 口径不回归：两合同金额+计划行全可见
    for (const cookie of [partnerCookie, (await loginAs(app, "xuwenjing@lexflow.demo")).cookie]) {
      const pDetail = await detailAs(cookie);
      expect(pDetail.status).toBe(200);
      const pCtr = contractsOf(pDetail);
      expect(pCtr.find((c) => c.id === contractA.id)!.amountCents).toBe(800000);
      expect(pCtr.find((c) => c.id === contractB.id)!.amountCents).toBe(300000);
    }

    // B 激活 → finance 可见；终止 → 缺席
    const bDetail = await trpc(app, "crm.contracts.getById", { cookie: partnerCookie, method: "GET", input: { id: contractB.id } });
    const actB = await trpc(app, "crm.contracts.activate", {
      cookie: partnerCookie,
      input: { id: contractB.id, rowVersion: (bDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion },
    });
    expect(actB.status).toBe(200);
    const fDetail2 = contractsOf(await detailAs(financeCookie));
    expect(fDetail2.find((c) => c.id === contractB.id)!.amountCents).toBe(300000);
    const termB = await trpc(app, "crm.contracts.terminate", {
      cookie: partnerCookie,
      input: { id: contractB.id, rowVersion: (actB.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, reason: "验收终止路径" },
    });
    expect(termB.status).toBe(200);
    const fDetail3 = contractsOf(await detailAs(financeCookie));
    expect(fDetail3.some((c) => c.id === contractB.id)).toBe(false); // terminated 不给明细
    // pm 视角：B（terminated）在列但金额剥离
    const pmCtr3 = contractsOf(await detailAs(pmCookie));
    const pmB3 = pmCtr3.find((c) => c.id === contractB.id)!;
    expect(pmB3.status).toBe("terminated");
    expect(pmB3.amountCents).toBeUndefined();
    expect(pmB3.plans[0].amountCents).toBeUndefined();

    // ④ member 同形 404 不破
    const mDetail = await detailAs(memberCookie);
    expect(mDetail.status).toBe(404);
    expect(trpcError(mDetail).businessCode).toBe("ACCESS_DENIED_OR_GONE");
  });
});
