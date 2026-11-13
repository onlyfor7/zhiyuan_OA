import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 9c · 工单 02（arch/12 §6/§11）+ 迭代 18-02 按 arch/13 §4 如实更新：CRM 操作方由 project_manager 改为 partner
 *（§4.1.6 收回 pm 全局 CRM 短路由）；商机 create/convert 按 §5.3 D5 补 projectManagerId+idempotencyKey（成立即立项）；
 * sysadmin 按 D3 提升为全局 CRM 读（探针反转 404→200）。原断言语义不变。
 * 权限三探针（partner 只读穿透 / finance 读 / member·sysadmin 同形 404；金额列口径）、
 * 转化事务（建客户+建商机+converted 写回，幂等重放，失败零部分写入）、赢单事务（won 必挂合同同事务）、
 * 回款勾稽（计划行状态 paid/partial + 作废回写 + 不挂合同兼容存量）、客户详情六区、跟进多态校验。
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

async function count(table: string): Promise<number> {
  const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

describe("9c-02 CRM 服务端", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string; // 王宝茁（项目负责人，种子客户 owner）
  let partnerCookie: string;
  let financeCookie: string; // 郭静文
  let memberCookie: string; // 管晨
  let sysadminCookie: string; // 赵凯（矩阵无 crm 权）
  let projectAId: string;
  let pmUserId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    pmUserId = (await query<{ id: string }>(`SELECT id FROM users WHERE email='wangbaozhuo@lexflow.demo'`))[0].id;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("权限三探针 + 金额列口径：partner 穿透读（金额在场）/finance 读/member·sysadmin 同形 404/manage 门", async () => {
    const partnerLeads = await trpc(app, "crm.leads.list", { cookie: partnerCookie, method: "GET", input: {} });
    expect(partnerLeads.status).toBe(200);
    const partnerOpps = await trpc(app, "crm.opportunities.list", { cookie: partnerCookie, method: "GET", input: {} });
    expect(partnerOpps.status).toBe(200);
    const oppItem = (partnerOpps.json as { result: { data: { items: Array<{ expectedAmountCents?: number }> } } }).result.data.items
      .find((o) => o.expectedAmountCents !== undefined);
    expect(oppItem).toBeTruthy(); // partner=fin.read 口径：金额列在场
    const financeCustomers = await trpc(app, "crm.customers.list", { cookie: financeCookie, method: "GET", input: {} });
    expect(financeCustomers.status).toBe(200);
    // arch/13 D4：finance 客户列表合同额（跨合同聚合）剥离；active 合同链明细金额在 contracts.getById 放行（见回款勾稽用例）
    expect((financeCustomers.json as { result: { data: { items: Array<{ contractSum?: number }> } } }).result.data.items[0]).not.toHaveProperty("contractSum");

    // member（交付角色）无线索明细权 404 不变；sysadmin 按 arch/13 D3 提升为全局 CRM 读（200）
    const memberLeads = await trpc(app, "crm.leads.list", { cookie: memberCookie, method: "GET", input: {} });
    expect(memberLeads.status, "member 线索列表应 404").toBe(404);
    const sysLeads = await trpc(app, "crm.leads.list", { cookie: sysadminCookie, method: "GET", input: {} });
    expect(sysLeads.status, "sysadmin 线索列表应 200（D3 全局读）").toBe(200);
    for (const [name, cookie] of [["member", memberCookie], ["sysadmin", sysadminCookie]] as const) {
      const detail = await trpc(app, "crm.customers.getById", { cookie, method: "GET", input: { id: crypto.randomUUID() } });
      expect(detail.status, `${name} 随机 uuid 客户详情应 404（同形不破）`).toBe(404);
    }
    // manage 门：member 建线索/跟进 404（manage 仍 partner 粗门）
    expect((await trpc(app, "crm.leads.create", { cookie: memberCookie, input: { name: "member 越权线索" } })).status).toBe(404);
    // 金额口径（arch/13 §1）：partner/运营/管理层/范围内销售可见；finance 合同前只见聚合（crm.summary）
  });

  it("转化事务：建客户+建商机+converted 写回；幂等重放零新增；坏客户回滚零部分写入", async () => {
    const lead = await trpc(app, "crm.leads.create", {
      cookie: partnerCookie,
      input: { name: "9c验收线索", source: "展会", contactName: "张总", contactPhone: "13800000000" },
    });
    expect(lead.status).toBe(200);
    const leadId = (lead.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;
    const leadRv = (lead.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const clientsBefore = await count("clients");
    const oppsBefore = await count("crm_opportunities");

    const converted = await trpc(app, "crm.leads.convert", {
      cookie: partnerCookie,
      input: {
        id: leadId,
        rowVersion: leadRv,
        customer: { name: "9c验收客户", level: "重点客户", industry: "验收业" },
        projectManagerId: pmUserId,
        opportunity: { name: "9c验收商机", expectedAmountCents: 666000, winRate: 50 },
      },
    });
    expect(converted.status).toBe(200);
    const conv = (converted.json as { result: { data: { customerId: string; opportunityId: string; replayed: boolean } } }).result.data;
    expect(conv.replayed).toBe(false);
    expect(await count("clients")).toBe(clientsBefore + 1);
    expect(await count("crm_opportunities")).toBe(oppsBefore + 1);
    // 线索 converted 写回两 id
    const leadsAfter = await query<{ status: string; converted_customer_id: string | null; converted_opportunity_id: string | null }>(
      `SELECT status, converted_customer_id, converted_opportunity_id FROM crm_leads WHERE id=$1`,
      [leadId],
    );
    expect(leadsAfter[0].status).toBe("converted");
    expect(leadsAfter[0].converted_customer_id).toBe(conv.customerId);
    expect(leadsAfter[0].converted_opportunity_id).toBe(conv.opportunityId);
    const newClient = await query<{ source_lead_id: string | null; level: string }>(`SELECT source_lead_id, level FROM clients WHERE id=$1`, [conv.customerId]);
    expect(newClient[0].source_lead_id).toBe(leadId);
    expect(newClient[0].level).toBe("重点客户");
    const audit = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action='crm.leads.convert' AND target_id=$1`, [leadId]);
    expect(audit[0].n).toBe(1);

    // 幂等重放：再 convert（同线索任意输入）→ replayed:true 同 ids，计数不再变
    const replay = await trpc(app, "crm.leads.convert", {
      cookie: partnerCookie,
      input: { id: leadId, rowVersion: 99, customer: { name: "不应被创建" }, opportunity: { name: "不应被创建" } },
    });
    expect(replay.status).toBe(200);
    expect((replay.json as { result: { data: { replayed: boolean; customerId: string } } }).result.data.replayed).toBe(true);
    expect((replay.json as { result: { data: { customerId: string } } }).result.data.customerId).toBe(conv.customerId);
    expect(await count("clients")).toBe(clientsBefore + 1);
    expect(await count("crm_opportunities")).toBe(oppsBefore + 1);

    // 回滚零部分写入：新线索 convert 挂不存在客户 → 400，线索保持未转化且客户/商机计数不变
    const lead2 = await trpc(app, "crm.leads.create", { cookie: partnerCookie, input: { name: "9c回滚线索" } });
    const lead2Id = (lead2.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;
    const lead2Rv = (lead2.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const bad = await trpc(app, "crm.leads.convert", {
      cookie: partnerCookie,
      input: { id: lead2Id, rowVersion: lead2Rv, customerId: crypto.randomUUID(), projectManagerId: pmUserId, opportunity: { name: "不应存在" } },
    });
    expect(bad.status).toBe(400);
    const lead2Row = await query<{ status: string }>(`SELECT status FROM crm_leads WHERE id=$1`, [lead2Id]);
    expect(lead2Row[0].status).toBe("new");
    expect(await count("clients")).toBe(clientsBefore + 1);
    expect(await count("crm_opportunities")).toBe(oppsBefore + 1);
  });

  it("商机阶段/赢单/输单：setStage 审计、markWon 同事务建合同（重放零新增）、markLost 原因必填", async () => {
    // 用种子客户（比博思特）直建商机
    const customers = await trpc(app, "crm.customers.list", { cookie: partnerCookie, method: "GET", input: { keyword: "比博思特" } });
    const customerId = (customers.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items[0].id;
    const opp = await trpc(app, "crm.opportunities.create", {
      cookie: partnerCookie,
      input: { customerId, name: "9c赢单商机", expectedAmountCents: 888000, winRate: 70, projectManagerId: pmUserId, idempotencyKey: crypto.randomUUID() },
    });
    expect(opp.status).toBe(200);
    const oppId = (opp.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;
    const oppRv = (opp.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;

    const staged = await trpc(app, "crm.opportunities.setStage", { cookie: partnerCookie, input: { id: oppId, rowVersion: oppRv, stage: "proposal" } });
    expect(staged.status).toBe(200);
    const stageAudit = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action='crm.opportunities.setStage' AND target_id=$1`, [oppId]);
    expect(stageAudit[0].n).toBe(1);

    // markWon：同事务建合同并激活
    const contractsBefore = await count("crm_contracts");
    const won = await trpc(app, "crm.opportunities.markWon", {
      cookie: partnerCookie,
      input: { id: oppId, rowVersion: oppRv + 1, contract: { title: "9c验收合同", amountCents: 888000, activate: true } },
    });
    expect(won.status).toBe(200);
    const wonData = (won.json as { result: { data: { replayed: boolean; contract: { id: string; status: string; code: string } | null } } }).result.data;
    expect(wonData.replayed).toBe(false);
    expect(wonData.contract?.status).toBe("active");
    expect(wonData.contract?.code).toMatch(new RegExp(`^CTR-${YEAR}-`));
    expect(await count("crm_contracts")).toBe(contractsBefore + 1);
    const oppRow = await query<{ stage: string; won_contract_id: string | null }>(`SELECT stage, won_contract_id FROM crm_opportunities WHERE id=$1`, [oppId]);
    expect(oppRow[0].stage).toBe("won");
    expect(oppRow[0].won_contract_id).toBe(wonData.contract!.id);

    // markWon 重放：返回现状，合同零新增
    const wonReplay = await trpc(app, "crm.opportunities.markWon", {
      cookie: partnerCookie,
      input: { id: oppId, rowVersion: 99, contract: { title: "不应被创建", amountCents: 1 } },
    });
    expect(wonReplay.status).toBe(200);
    expect((wonReplay.json as { result: { data: { replayed: boolean } } }).result.data.replayed).toBe(true);
    expect(await count("crm_contracts")).toBe(contractsBefore + 1);

    // markLost 原因必填 + 正常输单
    const opp2 = await trpc(app, "crm.opportunities.create", { cookie: partnerCookie, input: { customerId, name: "9c输单商机", projectManagerId: pmUserId, idempotencyKey: crypto.randomUUID() } });
    const opp2Data = (opp2.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const lostNoReason = await trpc(app, "crm.opportunities.markLost", { cookie: partnerCookie, input: { id: opp2Data.id, rowVersion: opp2Data.rowVersion, reason: " " } });
    expect(lostNoReason.status).toBe(400);
    const lost = await trpc(app, "crm.opportunities.markLost", { cookie: partnerCookie, input: { id: opp2Data.id, rowVersion: opp2Data.rowVersion, reason: "预算冻结" } });
    expect(lost.status).toBe(200);
    // setStage 直拖 won/lost 被拦（须走 markWon/markLost）
    const opp3 = await trpc(app, "crm.opportunities.create", { cookie: partnerCookie, input: { customerId, name: "9c拖拽拦截", projectManagerId: pmUserId, idempotencyKey: crypto.randomUUID() } });
    const opp3Data = (opp3.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const dragWon = await trpc(app, "crm.opportunities.setStage", { cookie: partnerCookie, input: { id: opp3Data.id, rowVersion: opp3Data.rowVersion, stage: "won" as never } });
    expect(dragWon.status).toBe(400);
  });

  it("商机 update：名称/金额/赢率/负责人落库 + rowVersion 冲突 + 审计（14-03 随棒：update 增 ownerId，对齐 leads/customers.update 家族）", async () => {
    const customers = await trpc(app, "crm.customers.list", { cookie: partnerCookie, method: "GET", input: { keyword: "比博思特" } });
    const customerId = (customers.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items[0].id;
    const partnerUserId = (await query<{ id: string }>(`SELECT id FROM users WHERE email='liangqifeng@lexflow.demo'`))[0].id;
    const opp = await trpc(app, "crm.opportunities.create", {
      cookie: partnerCookie,
      input: { customerId, name: "14-03更新商机", expectedAmountCents: 100000, winRate: 10, projectManagerId: pmUserId, idempotencyKey: crypto.randomUUID() },
    });
    expect(opp.status).toBe(200);
    const data = (opp.json as { result: { data: { id: string; rowVersion: number } } }).result.data;

    const updated = await trpc(app, "crm.opportunities.update", {
      cookie: partnerCookie,
      input: { id: data.id, rowVersion: data.rowVersion, name: "14-03更新商机·改", expectedAmountCents: 200000, winRate: 40, ownerId: partnerUserId },
    });
    expect(updated.status).toBe(200);
    const row = await query<{ name: string; expected_amount_cents: number; win_rate: number; owner_id: string; row_version: number }>(
      `SELECT name, expected_amount_cents::int, win_rate, owner_id, row_version FROM crm_opportunities WHERE id=$1`,
      [data.id],
    );
    expect(row[0].name).toBe("14-03更新商机·改");
    expect(row[0].expected_amount_cents).toBe(200000);
    expect(row[0].win_rate).toBe(40);
    expect(row[0].owner_id).toBe(partnerUserId);
    expect(row[0].row_version).toBe(data.rowVersion + 1);
    const audit = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action='crm.opportunities.update' AND target_id=$1`, [data.id]);
    expect(audit[0].n).toBe(1);

    // 旧 rowVersion 再改 → 冲突（409）
    const stale = await trpc(app, "crm.opportunities.update", { cookie: partnerCookie, input: { id: data.id, rowVersion: data.rowVersion, name: "不应生效" } });
    expect(stale.status).toBe(409);
    const nameAfter = await query<{ name: string }>(`SELECT name FROM crm_opportunities WHERE id=$1`, [data.id]);
    expect(nameAfter[0].name).toBe("14-03更新商机·改");
  });

  it("回款勾稽：挂计划行 paid/partial 状态写回、重复挂 409、作废冲正回写、累计回款 registered-only、不挂合同兼容存量", async () => {
    // 种子合同 CTR-00001（GD）：两行计划各 400000 unpaid
    const contracts = await trpc(app, "crm.contracts.list", { cookie: financeCookie, method: "GET", input: {} });
    const gd = (contracts.json as { result: { data: { items: Array<{ id: string; code: string }> } } }).result.data.items
      .find((c) => c.code === `CTR-${YEAR}-00001`)!;
    const detail0 = await trpc(app, "crm.contracts.getById", { cookie: financeCookie, method: "GET", input: { id: gd.id } });
    const plans0 = (detail0.json as { result: { data: { plans: Array<{ id: string; seq: number; amountCents: number; status: string }> } } }).result.data.plans;
    expect(plans0).toHaveLength(2);
    expect(plans0.every((p) => p.status === "unpaid")).toBe(true);

    // 全额挂第一行 → paid
    const r1 = await trpc(app, "receipts.create", {
      cookie: financeCookie,
      input: {
        projectId: projectAId, amountCents: plans0[0].amountCents, receivedOn: "2027-05-01", referenceNo: "CRM-LINK-1",
        idempotencyKey: crypto.randomUUID(), contractId: gd.id, planId: plans0[0].id,
      },
    });
    expect(r1.status).toBe(200);
    // 超额部分挂第二行 → partial
    const r2 = await trpc(app, "receipts.create", {
      cookie: financeCookie,
      input: {
        projectId: projectAId, amountCents: 100000, receivedOn: "2027-05-02", referenceNo: "CRM-LINK-2",
        idempotencyKey: crypto.randomUUID(), contractId: gd.id, planId: plans0[1].id,
      },
    });
    expect(r2.status).toBe(200);

    const detail1 = await trpc(app, "crm.contracts.getById", { cookie: financeCookie, method: "GET", input: { id: gd.id } });
    const detail1Data = (detail1.json as { result: { data: { plans: Array<{ id: string; status: string; receiptId: string | null }>; cumulativeReceivedCents: number } } }).result.data;
    const plan1 = detail1Data.plans.find((p) => p.id === plans0[0].id)!;
    const plan2 = detail1Data.plans.find((p) => p.id === plans0[1].id)!;
    expect(plan1.status).toBe("paid");
    expect(plan1.receiptId).toBeTruthy();
    expect(plan2.status).toBe("partial");
    expect(detail1Data.cumulativeReceivedCents).toBe(plans0[0].amountCents + 100000);

    // 重复挂已挂行 → 409
    const dup = await trpc(app, "receipts.create", {
      cookie: financeCookie,
      input: {
        projectId: projectAId, amountCents: 1000, receivedOn: "2027-05-03", referenceNo: "CRM-LINK-DUP",
        idempotencyKey: crypto.randomUUID(), contractId: gd.id, planId: plans0[0].id,
      },
    });
    expect(dup.status).toBe(409);
    // 合同与计划行不匹配 → 400
    const mismatch = await trpc(app, "receipts.create", {
      cookie: financeCookie,
      input: {
        projectId: projectAId, amountCents: 1000, receivedOn: "2027-05-03", referenceNo: "CRM-LINK-MM",
        idempotencyKey: crypto.randomUUID(), contractId: crypto.randomUUID(), planId: plans0[1].id,
      },
    });
    expect(mismatch.status).toBe(400);
    // 只挂其一 → 400
    const onlyPlan = await trpc(app, "receipts.create", {
      cookie: financeCookie,
      input: {
        projectId: projectAId, amountCents: 1000, receivedOn: "2027-05-03", referenceNo: "CRM-LINK-ONLY",
        idempotencyKey: crypto.randomUUID(), planId: plans0[1].id,
      },
    });
    expect(onlyPlan.status).toBe(400);

    // 作废冲正回写：void r2 → plan2 复位 unpaid + 累计回落
    const r2id = (r2.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const voided = await trpc(app, "receipts.void", { cookie: financeCookie, input: { id: r2id.id, reason: "冲正验收", rowVersion: r2id.rowVersion } });
    expect(voided.status).toBe(200);
    const detail2 = await trpc(app, "crm.contracts.getById", { cookie: financeCookie, method: "GET", input: { id: gd.id } });
    const detail2Data = (detail2.json as { result: { data: { plans: Array<{ id: string; status: string; receiptId: string | null }>; cumulativeReceivedCents: number } } }).result.data;
    const plan2After = detail2Data.plans.find((p) => p.id === plans0[1].id)!;
    expect(plan2After.status).toBe("unpaid");
    expect(plan2After.receiptId).toBeNull();
    expect(detail2Data.cumulativeReceivedCents).toBe(plans0[0].amountCents);

    // 不挂合同维持存量语义
    const plain = await trpc(app, "receipts.create", {
      cookie: financeCookie,
      input: { projectId: projectAId, amountCents: 5000, receivedOn: "2027-05-04", referenceNo: "CRM-PLAIN", idempotencyKey: crypto.randomUUID() },
    });
    expect(plain.status).toBe(200);
  });

  it("客户详情六区 + 付款计划 upsert 守卫 + 跟进多态校验", async () => {
    const customers = await trpc(app, "crm.customers.list", { cookie: partnerCookie, method: "GET", input: { keyword: "比博思特" } });
    const customerId = (customers.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items[0].id;
    const detail = await trpc(app, "crm.customers.getById", { cookie: partnerCookie, method: "GET", input: { id: customerId } });
    expect(detail.status).toBe(200);
    const d = (detail.json as { result: { data: Record<string, unknown> } }).result.data;
    for (const key of ["customer", "contacts", "opportunities", "contracts", "projects", "files", "followups"]) {
      expect(d, `六区缺 ${key}`).toHaveProperty(key);
    }
    const contracts = d.contracts as Array<{ plans: unknown[]; cumulativeReceivedCents: number }>;
    expect(contracts.length).toBeGreaterThanOrEqual(0);

    // 联系人：主联系人互斥 + 删除
    const c1 = await trpc(app, "crm.contacts.create", { cookie: partnerCookie, input: { customerId, name: "甲联系人", isPrimary: true } });
    expect(c1.status).toBe(200);
    const c2 = await trpc(app, "crm.contacts.create", { cookie: partnerCookie, input: { customerId, name: "乙联系人", isPrimary: true } });
    expect(c2.status).toBe(200);
    const primaryCount = await query<{ n: number }>(`SELECT count(*)::int AS n FROM crm_contacts WHERE customer_id=$1 AND is_primary`, [customerId]);
    expect(primaryCount[0].n).toBe(1);
    const c1Id = (c1.json as { result: { data: { id: string } } }).result.data.id;
    const del = await trpc(app, "crm.contacts.delete", { cookie: partnerCookie, input: { id: c1Id } });
    expect(del.status).toBe(200);

    // 跟进多态：三形态可建，目标不存在 400
    const leads = await trpc(app, "crm.leads.list", { cookie: partnerCookie, method: "GET", input: {} });
    const leadId = (leads.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items[0].id;
    for (const [targetType, targetId] of [["lead", leadId], ["customer", customerId]] as const) {
      const f = await trpc(app, "crm.followups.create", { cookie: partnerCookie, input: { targetType, targetId, content: `9c${targetType}跟进` } });
      expect(f.status).toBe(200);
    }
    const badFollowup = await trpc(app, "crm.followups.create", { cookie: partnerCookie, input: { targetType: "customer", targetId: crypto.randomUUID(), content: "目标不存在" } });
    expect(badFollowup.status).toBe(400);
    expect(trpcError(badFollowup).fieldErrors?.targetId).toBeTruthy();

    // 付款计划 upsert：草稿合同可整替；含已回款行的合同被守卫拦截
    const contractsList = await trpc(app, "crm.contracts.list", { cookie: partnerCookie, method: "GET", input: { keyword: "GD" } });
    const gd = (contractsList.json as { result: { data: { items: Array<{ id: string; code: string }> } } }).result.data.items
      .find((c) => c.code === `CTR-${YEAR}-00001`)!;
    const blocked = await trpc(app, "crm.paymentPlans.upsert", {
      cookie: partnerCookie,
      input: { contractId: gd.id, rows: [{ seq: 1, dueDate: "2027-06-01", amountCents: 1000 }] },
    });
    expect(blocked.status).toBe(409); // 存在已回款（paid）行
  });
});
