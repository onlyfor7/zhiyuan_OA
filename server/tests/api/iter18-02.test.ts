import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { TEST_DATABASE_URL } from "../db/helpers";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";

/**
 * 迭代 18 · 工单 02（arch/13 §3–§7/§10/§12）：可见性矩阵 SQL 级解析 + 商机成立即立项（D5）+
 * 终态/合同激活 + 全周期成本分段 + sysadmin 受控纠正 + 节点级甘特。
 */

const YEAR = new Date().getFullYear();
const uuid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n: number) => {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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

describe("18-02 可见性与商机即立项服务端", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let salesACookie: string; // 苏明轩
  let salesBCookie: string; // 林婉清
  let smCookie: string; // 郑浩然（主管）
  let vpCookie: string; // 高峻岭（大区VP）
  let presalesCookie: string; // 何志远
  let operationsCookie: string; // 许文静
  let ceoCookie: string; // 宋启铭
  let sysadminCookie: string;
  let financeCookie: string;
  let pmCookie: string; // 王宝茁（项目负责人）
  let memberCookie: string; // 管晨
  let salesAId: string;
  let smId: string;
  let presalesId: string;
  let pmUserId: string;
  let projectAId: string;
  let oppAId = "";
  let oppAProjectId = "";
  let customerAId = "";

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    salesACookie = (await loginAs(app, "sumingxuan@lexflow.demo")).cookie;
    salesBCookie = (await loginAs(app, "linwanqing@lexflow.demo")).cookie;
    smCookie = (await loginAs(app, "zhenghaoran@lexflow.demo")).cookie;
    vpCookie = (await loginAs(app, "gaojunling@lexflow.demo")).cookie;
    presalesCookie = (await loginAs(app, "hezhiyuan@lexflow.demo")).cookie;
    operationsCookie = (await loginAs(app, "xuwenjing@lexflow.demo")).cookie;
    ceoCookie = (await loginAs(app, "songqiming@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    const ids = await query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE email IN ('sumingxuan@lexflow.demo','zhenghaoran@lexflow.demo','hezhiyuan@lexflow.demo','wangbaozhuo@lexflow.demo')`);
    salesAId = ids.find((u) => u.email.startsWith("sumingxuan"))!.id;
    smId = ids.find((u) => u.email.startsWith("zhenghaoran"))!.id;
    presalesId = ids.find((u) => u.email.startsWith("hezhiyuan"))!.id;
    pmUserId = ids.find((u) => u.email.startsWith("wangbaozhuo"))!.id;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("销售隔离/主管树/售前指派/成环校验 + 商机即立项同事务链", async () => {
    // ① 销售 A 建线索：无 LD 编号（arch/13 §5.2）
    const lead = await trpc(app, "crm.leads.create", {
      cookie: salesACookie,
      input: { name: "18-02 A 线索", source: "展会", contactName: "张三", contactPhone: "13900000001" },
    });
    expect(lead.status).toBe(200);
    const leadData = (lead.json as { result: { data: { id: string; rowVersion: number; code: string | null } } }).result.data;
    expect(leadData.code).toBeNull();
    const leadId = leadData.id;

    // ② 转化新建商机 = D5 同事务立项（项目负责人必填）
    const noPm = await trpc(app, "crm.leads.convert", {
      cookie: salesACookie,
      input: { id: leadId, rowVersion: leadData.rowVersion, customer: { name: "18-02 A 客户" }, opportunity: { name: "18-02 A 商机" } },
    });
    expect(noPm.status).toBe(400); // 缺 projectManagerId
    const conv = await trpc(app, "crm.leads.convert", {
      cookie: salesACookie,
      input: {
        id: leadId, rowVersion: leadData.rowVersion,
        customer: { name: "18-02 A 客户" },
        projectManagerId: pmUserId,
        opportunity: { name: "18-02 A 商机", expectedAmountCents: 500000, winRate: 40 },
      },
    });
    expect(conv.status, JSON.stringify(conv.json).slice(0, 200)).toBe(200);
    const convData = (conv.json as { result: { data: { customerId: string; opportunityId: string; projectId: string | null; replayed: boolean } } }).result.data;
    expect(convData.replayed).toBe(false);
    expect(convData.projectId).toBeTruthy();
    oppAId = convData.opportunityId;
    oppAProjectId = convData.projectId!;
    customerAId = convData.customerId;

    // 同事务链落库核验：商机/事项/项目/成员/售前计划/档案目录
    const chain = await query<{
      opp_code: string; project_id: string | null; source_lead_id: string | null; owner_id: string | null;
      prj_code: string; prj_type: string; lifecycle: string; matter_id: string;
    }>(
      `SELECT o.code AS opp_code, o.project_id, o.source_lead_id, o.owner_id,
              p.code AS prj_code, p.type AS prj_type, p.lifecycle_status AS lifecycle, p.matter_id
       FROM crm_opportunities o JOIN projects p ON p.id = o.project_id WHERE o.id=$1`,
      [oppAId],
    );
    expect(chain[0].opp_code).toMatch(new RegExp(`^OPP-${YEAR}-`));
    expect(chain[0].project_id).toBe(oppAProjectId);
    expect(chain[0].source_lead_id).toBe(leadId);
    expect(chain[0].owner_id).toBe(salesAId); // 商机 owner=线索负责人（销售归属不漂移）
    expect(chain[0].prj_code).toMatch(new RegExp(`^PRJ-${YEAR}-`));
    expect(chain[0].prj_type).toBe("售前");
    expect(chain[0].lifecycle).toBe("preparing");
    const members = await query<{ user_id: string; project_role: string }>(`SELECT user_id, project_role FROM project_members WHERE project_id=$1 ORDER BY project_role`, [oppAProjectId]);
    expect(members.some((m) => m.project_role === "manager" && m.user_id === pmUserId)).toBe(true);
    expect(members.some((m) => m.project_role === "member" && m.user_id === salesAId)).toBe(true);
    const plan = await query<{ n: number }>(`SELECT count(*)::int AS n FROM plan_versions WHERE project_id=$1 AND version_no=1`, [oppAProjectId]);
    expect(plan[0].n).toBe(1);
    const stages = await query<{ name: string }>(`SELECT name FROM stages WHERE project_id=$1 ORDER BY seq`, [oppAProjectId]);
    expect(stages.map((s) => s.name)).toEqual(["需求调研", "方案与报价", "商务签约"]);
    const dirs = await query<{ n: number }>(`SELECT count(*)::int AS n FROM archive_directories WHERE project_id=$1`, [oppAProjectId]);
    expect(dirs[0].n).toBe(11);

    // 重复转化返回现状（线索幂等）
    const replay = await trpc(app, "crm.leads.convert", {
      cookie: salesACookie,
      input: { id: leadId, rowVersion: 99, opportunity: { name: "不应被创建" } },
    });
    expect(replay.status).toBe(200);
    expect((replay.json as { result: { data: { replayed: boolean } } }).result.data.replayed).toBe(true);

    // ③ 直接建商机幂等：同键同载荷重放不重复立项；同键异载荷 409
    const key = uuid();
    const direct = await trpc(app, "crm.opportunities.create", {
      cookie: salesACookie,
      input: { customerId: customerAId, name: "18-02 直建商机", expectedAmountCents: 300000, projectManagerId: pmUserId, idempotencyKey: key },
    });
    expect(direct.status).toBe(200);
    const directData = (direct.json as { result: { data: { id: string; projectId: string; replayed: boolean } } }).result.data;
    expect(directData.replayed).toBe(false);
    const projCountBefore = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`))[0].n;
    const replayDirect = await trpc(app, "crm.opportunities.create", {
      cookie: salesACookie,
      input: { customerId: customerAId, name: "18-02 直建商机", expectedAmountCents: 300000, projectManagerId: pmUserId, idempotencyKey: key },
    });
    expect(replayDirect.status).toBe(200);
    const replayData = (replayDirect.json as { result: { data: { id: string; replayed: boolean } } }).result.data;
    expect(replayData.replayed).toBe(true);
    expect(replayData.id).toBe(directData.id);
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`))[0].n).toBe(projCountBefore);
    const conflict = await trpc(app, "crm.opportunities.create", {
      cookie: salesACookie,
      input: { customerId: customerAId, name: "异载荷", projectManagerId: pmUserId, idempotencyKey: key },
    });
    expect(conflict.status).toBe(409);

    // ④ 销售 B 隔离：列表无 A 数据、详情同形 404、聚合=本人口径
    const bLeads = await trpc(app, "crm.leads.list", { cookie: salesBCookie, method: "GET", input: {} });
    expect(bLeads.status).toBe(200);
    expect((bLeads.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items.some((l) => l.id === leadId)).toBe(false);
    const bOpp = await trpc(app, "crm.opportunities.getById", { cookie: salesBCookie, method: "GET", input: { id: oppAId } });
    expect(bOpp.status).toBe(404);
    const bSummary = await trpc(app, "crm.summary", { cookie: salesBCookie, method: "GET" });
    expect(bSummary.status).toBe(200);
    expect((bSummary.json as { result: { data: { leads: { total: number } } } }).result.data.leads.total).toBe(0);
    const aSummary = await trpc(app, "crm.summary", { cookie: salesACookie, method: "GET" });
    expect((aSummary.json as { result: { data: { leads: { total: number } } } }).result.data.leads.total).toBeGreaterThanOrEqual(1);

    // ⑤ 主管树：主管/大区VP 看下级（递归 SQL），树外不可见
    const smLeads = await trpc(app, "crm.leads.list", { cookie: smCookie, method: "GET", input: {} });
    expect(smLeads.status).toBe(200);
    expect((smLeads.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items.some((l) => l.id === leadId)).toBe(true);
    const vpLeads = await trpc(app, "crm.leads.list", { cookie: vpCookie, method: "GET", input: {} });
    expect((vpLeads.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items.some((l) => l.id === leadId)).toBe(true);
    // 运营/CEO 全局读
    for (const cookie of [operationsCookie, ceoCookie, sysadminCookie]) {
      const res = await trpc(app, "crm.opportunities.list", { cookie, method: "GET", input: {} });
      expect(res.status).toBe(200);
      expect((res.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items.some((o) => o.id === oppAId)).toBe(true);
    }

    // ⑥ 售前指派可见；取消指派即时失效
    const oppDetail = await trpc(app, "crm.opportunities.getById", { cookie: salesACookie, method: "GET", input: { id: oppAId } });
    const oppRv = (oppDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const assigned = await trpc(app, "crm.opportunities.update", {
      cookie: salesACookie,
      input: { id: oppAId, rowVersion: oppRv, presalesId },
    });
    expect(assigned.status).toBe(200);
    const psList = await trpc(app, "crm.opportunities.list", { cookie: presalesCookie, method: "GET", input: {} });
    expect((psList.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items.some((o) => o.id === oppAId)).toBe(true);
    const psLead = await trpc(app, "crm.leads.list", { cookie: presalesCookie, method: "GET", input: {} });
    expect((psLead.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items.some((l) => l.id === leadId)).toBe(true); // 关联线索穿透
    const unassigned = await trpc(app, "crm.opportunities.update", {
      cookie: salesACookie,
      input: { id: oppAId, rowVersion: oppRv + 1, presalesId: null },
    });
    expect(unassigned.status).toBe(200);
    const psGone = await trpc(app, "crm.opportunities.getById", { cookie: presalesCookie, method: "GET", input: { id: oppAId } });
    expect(psGone.status).toBe(404); // 取消指派即时失效

    // ⑦ 多级成环拒绝（主管链 A→B 后禁止 B→A 或更长环）
    // users 无 row_version 列：org.members.update 以 id 条件更新（乐观锁不适用该表），成环校验 400 断言语义
    const cycle = await trpc(app, "org.members.update", {
      cookie: sysadminCookie,
      input: { id: smId, rowVersion: 0, managerId: salesAId },
    });
    expect(cycle.status).toBe(400);
    expect(trpcError(cycle).fieldErrors?.managerId).toBeTruthy();
  });

  it("finance D4 分界：draft 仅汇总，activate 后见该合同链，仍不见无关商机", async () => {
    // 合同前：明细域 404，仅聚合 200
    expect((await trpc(app, "crm.leads.list", { cookie: financeCookie, method: "GET", input: {} })).status).toBe(404);
    expect((await trpc(app, "crm.opportunities.list", { cookie: financeCookie, method: "GET", input: {} })).status).toBe(404);
    const summary = await trpc(app, "crm.summary", { cookie: financeCookie, method: "GET" });
    expect(summary.status).toBe(200);
    const sData = (summary.json as { result: { data: { opportunities: { total: number }; contracts: { active: number } } } }).result.data;
    expect(sData.opportunities.total).toBeGreaterThanOrEqual(1); // 整体汇总（含合同前）
    expect(sData.contracts.active).toBeGreaterThanOrEqual(1);

    // 赢单（draft 不激活）：项目仍 preparing；finance 仍无该客户/合同明细
    const oppDetail = await trpc(app, "crm.opportunities.getById", { cookie: salesACookie, method: "GET", input: { id: oppAId } });
    const oppData = (oppDetail.json as { result: { data: { rowVersion: number } } }).result.data;
    const won = await trpc(app, "crm.opportunities.markWon", {
      cookie: salesACookie,
      input: { id: oppAId, rowVersion: oppData.rowVersion, contract: { title: "18-02 合同", amountCents: 500000, activate: false } },
    });
    expect(won.status, JSON.stringify(won.json).slice(0, 200)).toBe(200);
    const contract = (won.json as { result: { data: { contract: { id: string; status: string } } } }).result.data.contract;
    expect(contract.status).toBe("draft");
    let prj = await query<{ lifecycle_status: string; matter_id: string }>(`SELECT lifecycle_status, matter_id FROM projects WHERE id=$1`, [oppAProjectId]);
    expect(prj[0].lifecycle_status).toBe("preparing"); // draft 不转交付
    const fCustomer = await trpc(app, "crm.customers.getById", { cookie: financeCookie, method: "GET", input: { id: customerAId } });
    expect(fCustomer.status).toBe(404); // draft 不给明细
    const fContracts = await trpc(app, "crm.contracts.list", { cookie: financeCookie, method: "GET", input: {} });
    expect((fContracts.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items.some((c) => c.id === contract.id)).toBe(false);

    // 激活：项目 preparing→in_progress（同一项目 id 不变）+ matter 回填；finance 见该合同链
    const ctrDetail = await trpc(app, "crm.contracts.getById", { cookie: salesACookie, method: "GET", input: { id: contract.id } });
    const ctrRv = (ctrDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const activated = await trpc(app, "crm.contracts.activate", {
      cookie: salesACookie,
      input: { id: contract.id, rowVersion: ctrRv, signedAt: `${today()}T09:00:00.000Z` },
    });
    expect(activated.status).toBe(200);
    prj = await query<{ lifecycle_status: string; matter_id: string }>(`SELECT lifecycle_status, matter_id FROM projects WHERE id=$1`, [oppAProjectId]);
    expect(prj[0].lifecycle_status).toBe("in_progress");
    const ctrRow = await query<{ matter_id: string | null }>(`SELECT matter_id FROM crm_contracts WHERE id=$1`, [contract.id]);
    expect(ctrRow[0].matter_id).toBe(prj[0].matter_id); // matter 回填
    const fCustomer2 = await trpc(app, "crm.customers.getById", { cookie: financeCookie, method: "GET", input: { id: customerAId } });
    expect(fCustomer2.status).toBe(200); // 激活后该合同链客户可见
    const fContracts2 = await trpc(app, "crm.contracts.list", { cookie: financeCookie, method: "GET", input: {} });
    expect((fContracts2.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items.some((c) => c.id === contract.id)).toBe(true);
    const fOppStill = await trpc(app, "crm.opportunities.getById", { cookie: financeCookie, method: "GET", input: { id: oppAId } });
    expect(fOppStill.status).toBe(404); // 仍不见无关商机（财务商机域恒 404）
  });

  it("markLost：同事务关项目 + closed 阻断费用/差旅/经费/任务/终态改/激活", async () => {
    // 销售 B 独立链
    const lead = await trpc(app, "crm.leads.create", { cookie: salesBCookie, input: { name: "18-02 B 线索" } });
    const leadData = (lead.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const conv = await trpc(app, "crm.leads.convert", {
      cookie: salesBCookie,
      input: { id: leadData.id, rowVersion: leadData.rowVersion, customer: { name: "18-02 B 客户" }, projectManagerId: pmUserId, opportunity: { name: "18-02 B 商机" } },
    });
    const convData = (conv.json as { result: { data: { opportunityId: string; projectId: string } } }).result.data;
    const oppBId = convData.opportunityId;
    const projBId = convData.projectId;

    const lost = await trpc(app, "crm.opportunities.markLost", {
      cookie: salesBCookie,
      input: { id: oppBId, rowVersion: 0, reason: "预算冻结" },
    });
    // rowVersion 0 可能不命中：取详情再输（幂等断言以最终落库为准）
    if (lost.status === 409) {
      const det = await trpc(app, "crm.opportunities.getById", { cookie: salesBCookie, method: "GET", input: { id: oppBId } });
      const rv = (det.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
      const retry = await trpc(app, "crm.opportunities.markLost", { cookie: salesBCookie, input: { id: oppBId, rowVersion: rv, reason: "预算冻结" } });
      expect(retry.status).toBe(200);
    } else {
      expect(lost.status).toBe(200);
    }
    const oppRow = await query<{ stage: string; closed_reason: string | null; closed_at: string | null }>(`SELECT stage, closed_reason, closed_at FROM crm_opportunities WHERE id=$1`, [oppBId]);
    expect(oppRow[0].stage).toBe("lost");
    expect(oppRow[0].closed_reason).toBe("预算冻结");
    expect(oppRow[0].closed_at).toBeTruthy();
    const prj = await query<{ lifecycle_status: string }>(`SELECT lifecycle_status FROM projects WHERE id=$1`, [projBId]);
    expect(prj[0].lifecycle_status).toBe("closed");

    // 终态/closed 阻断四路 + 终态修改 + 激活
    const item = { projectId: projBId, date: today(), category: "meals", amountCents: 10000, description: "阻断验证" };
    const exp = await trpc(app, "expense.create", { cookie: salesBCookie, input: { reason: "阻断", items: [item] } });
    expect(exp.status).toBe(409);
    const task = await trpc(app, "task.create", { cookie: salesBCookie, input: { projectId: projBId, title: "阻断任务", plannedStart: today(), plannedEnd: addDays(1) } });
    expect(task.status).toBe(409);
    const travel = await trpc(app, "travel.create", {
      cookie: salesBCookie,
      input: {
        projectId: projBId, reason: "阻断出差", destination: "上海", startOn: today(), endOn: addDays(1), estimatedCostCents: 50000,
        segments: [{ seq: 1, type: "transport", startAt: today(), endAt: addDays(1), fromPlace: "杭州", toPlace: "上海" }],
      },
    });
    expect(travel.status).toBe(409);
    const funding = await trpc(app, "funding.create", { cookie: salesBCookie, input: { projectId: projBId, purpose: "阻断经费", amountCents: 50000 } });
    expect(funding.status).toBe(409);
    const upd = await trpc(app, "crm.opportunities.update", { cookie: salesBCookie, input: { id: oppBId, rowVersion: 1, name: "不应生效" } });
    expect(upd.status).toBe(409);
    const wonAfterLost = await trpc(app, "crm.opportunities.markWon", {
      cookie: salesBCookie,
      input: { id: oppBId, rowVersion: 1, contract: { title: "不应建", amountCents: 100 } },
    });
    expect(wonAfterLost.status).toBe(409);
  });

  it("成本分段：售前/交付/总成本按 §5.5 公式且不重记不双算", async () => {
    // oppA 项目已激活（signedAt=今天）：今日-5 费用=售前，今日费用=交付
    const mkExpense = async (date: string, amount: number) => {
      const created = await trpc(app, "expense.create", {
        cookie: salesACookie,
        input: { reason: `18-02 成本 ${date}`, items: [{ projectId: oppAProjectId, date, category: "meals", amountCents: amount, description: "分段验证" }] },
      });
      expect(created.status).toBe(200);
      const expId = (created.json as { result: { data: { id: string } } }).result.data.id;
      const detail = await trpc(app, "expense.getById", { cookie: salesACookie, method: "GET", input: { id: expId } });
      const rv = (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
      const sub = await trpc(app, "expense.submit", { cookie: salesACookie, input: { id: expId, rowVersion: rv, idempotencyKey: uuid() } });
      expect(sub.status).toBe(200);
      const instId = (sub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
      const a1 = await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: instId, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
      expect(a1.status).toBe(200);
      const a2 = await trpc(app, "approval.act", { cookie: financeCookie, input: { instanceId: instId, stepSeq: 2, action: "approve", idempotencyKey: uuid() } });
      expect(a2.status, JSON.stringify(a2.json).slice(0, 200)).toBe(200);
    };
    await mkExpense(addDays(-5), 60000); // 售前
    await mkExpense(today(), 40000); // 交付

    const costing = await trpc(app, "fin.projectCosting.get", { cookie: financeCookie, method: "GET", input: { projectId: oppAProjectId } });
    expect(costing.status).toBe(200);
    const c = (costing.json as { result: { data: { presalesCostCents: number; deliveryCostCents: number; totalCostCents: number; directCostCents: number } } }).result.data;
    expect(c.presalesCostCents).toBe(60000);
    expect(c.deliveryCostCents).toBe(40000);
    expect(c.totalCostCents).toBe(100000);
    expect(c.totalCostCents).toBe(c.directCostCents); // 总成本只汇总一次
    expect(c.presalesCostCents + c.deliveryCostCents).toBe(c.totalCostCents); // 不重记不双算
  });

  it("sysadmin 全局读 + 受控纠正：白名单成功/非白名单拒绝/成环拒绝/快照审计/乐观锁 409", async () => {
    // D3 全局读
    const oppList = await trpc(app, "crm.opportunities.list", { cookie: sysadminCookie, method: "GET", input: {} });
    expect(oppList.status).toBe(200);
    const proj = await trpc(app, "project.getById", { cookie: sysadminCookie, method: "GET", input: { id: projectAId } });
    expect(proj.status).toBe(200);

    // 白名单纠正：线索联系信息
    const leads = await trpc(app, "crm.leads.list", { cookie: salesACookie, method: "GET", input: {} });
    const leadRow = (leads.json as { result: { data: { items: Array<{ id: string; rowVersion: number; contactName: string }> } } }).result.data.items
      .find((l) => l.contactName === "张三")!;
    const fixed = await trpc(app, "admin.correctRecord", {
      cookie: sysadminCookie,
      input: { object: "lead", id: leadRow.id, rowVersion: leadRow.rowVersion, patch: { contactName: "张三丰" }, reason: "客户更正联系人姓名" },
    });
    expect(fixed.status).toBe(200);
    const audit = await query<{ before_json: Record<string, unknown>; after_json: Record<string, unknown> }>(
      `SELECT before_json, after_json FROM audit_events WHERE action='admin.correctRecord' AND target_id=$1`,
      [leadRow.id],
    );
    expect(audit.length).toBe(1);
    expect(audit[0].before_json.contact_name).toBe("张三"); // 全快照为原始行（DB 列名 snake_case）
    expect(audit[0].after_json.contact_name).toBe("张三丰");
    expect(audit[0].after_json.correctReason).toBe("客户更正联系人姓名");

    // 非白名单字段拒绝
    const bad = await trpc(app, "admin.correctRecord", {
      cookie: sysadminCookie,
      input: { object: "lead", id: leadRow.id, rowVersion: leadRow.rowVersion + 1, patch: { status: "qualified" }, reason: "试图改状态" },
    });
    expect(bad.status).toBe(400);

    // 主管成环拒绝（correctRecord 通道）
    // users 无 row_version 列（登记仲裁）：user 纠正忽略客户端 rowVersion，以服务端快照乐观校验；此处只断言语义拒绝
    const cycle = await trpc(app, "admin.correctRecord", {
      cookie: sysadminCookie,
      input: { object: "user", id: smId, rowVersion: 0, patch: { managerId: salesAId }, reason: "试图成环" },
    });
    expect(cycle.status).toBe(400);

    // 乐观锁冲突 409
    const stale = await trpc(app, "admin.correctRecord", {
      cookie: sysadminCookie,
      input: { object: "lead", id: leadRow.id, rowVersion: 999, patch: { contactName: "不应生效" }, reason: "并发" },
    });
    expect(stale.status).toBe(409);

    // 商机终态不可纠正（状态机）
    const lostOpp = await query<{ id: string; row_version: number }>(`SELECT id, row_version FROM crm_opportunities WHERE stage='lost' LIMIT 1`);
    if (lostOpp[0]) {
      const terminal = await trpc(app, "admin.correctRecord", {
        cookie: sysadminCookie,
        input: { object: "opportunity", id: lostOpp[0].id, rowVersion: lostOpp[0].row_version, patch: { name: "不应生效" }, reason: "终态" },
      });
      expect(terminal.status).toBe(409);
    }
  });

  it("ensureProjectPlan 幂等 + plan.gantt 三态节点输出", async () => {
    // 已有 v1：返回现状
    const ensured = await trpc(app, "crm.opportunities.ensureProjectPlan", {
      cookie: operationsCookie,
      input: { opportunityId: oppAId },
    });
    expect(ensured.status).toBe(200);
    expect((ensured.json as { result: { data: { created: boolean } } }).result.data.created).toBe(false);
    // 无权限（member）404
    const denied = await trpc(app, "crm.opportunities.ensureProjectPlan", { cookie: memberCookie, input: { opportunityId: oppAId } });
    expect(denied.status).toBe(404);

    // 甘特：仅阶段/里程碑条节点 + 任务三态聚合
    const gantt = await trpc(app, "plan.gantt", { cookie: pmCookie, method: "GET", input: { projectId: oppAProjectId } });
    expect(gantt.status).toBe(200);
    const nodes = (gantt.json as { result: { data: { nodes: Array<{ kind: string; tasks: Record<string, number>; plannedStart: string }> } } }).result.data.nodes;
    expect(nodes.length).toBeGreaterThanOrEqual(3);
    expect(nodes.every((n) => n.kind === "stage" || n.kind === "milestone")).toBe(true);
    for (const n of nodes) {
      expect(Object.keys(n.tasks).sort()).toEqual(["delayed", "done", "overdue", "total"]);
      expect(n.tasks.total).toBeGreaterThanOrEqual(n.tasks.done + n.tasks.overdue + n.tasks.delayed);
    }
    const first = nodes.find((n) => n.kind === "stage")!;
    expect(first.plannedStart).toBeTruthy();
    expect(first.tasks.total).toBeGreaterThanOrEqual(1); // 模板任务聚合到节点

    // 项目详情携带商机最小标识（互跳）
    const proj = await trpc(app, "project.getById", { cookie: pmCookie, method: "GET", input: { id: oppAProjectId } });
    const oppRef = (proj.json as { result: { data: { opportunity: { id: string; code: string } | null } } }).result.data.opportunity;
    expect(oppRef?.id).toBe(oppAId);
    expect(oppRef?.code).toMatch(new RegExp(`^OPP-${YEAR}-`));
  });

  it("打回修复 D-18-2-1~4：关联既有商机/异载荷含负责人/并发双 200/组合角色并集", async () => {
    // ===== D-18-2-1：线索关联既有商机（不新建项目；sourceLeadId/converted_*/projectId 勾稽）=====
    const customers = await trpc(app, "crm.customers.list", { cookie: salesACookie, method: "GET", input: {} });
    const anyCustomer = (customers.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items[0];
    const existing = await trpc(app, "crm.opportunities.create", {
      cookie: salesACookie,
      input: { customerId: anyCustomer.id, name: "18-02-关联靶商机", projectManagerId: pmUserId, idempotencyKey: uuid() },
    });
    expect(existing.status).toBe(200);
    const existingData = (existing.json as { result: { data: { id: string; projectId: string } } }).result.data;
    const existingOpp = await query<{ project_id: string | null }>(`SELECT project_id FROM crm_opportunities WHERE id=$1`, [existingData.id]);
    const existingProjectId = existingOpp[0].project_id;
    expect(existingProjectId).toBeTruthy(); // 既有商机本身已立项
    const projCountBefore = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`))[0].n;

    const linkLead = await trpc(app, "crm.leads.create", { cookie: salesACookie, input: { name: "18-02 待关联线索" } });
    const linkLeadData = (linkLead.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const linked = await trpc(app, "crm.leads.convert", {
      cookie: salesACookie,
      input: { id: linkLeadData.id, rowVersion: linkLeadData.rowVersion, opportunityId: existingData.id },
    });
    expect(linked.status, JSON.stringify(linked.json).slice(0, 200)).toBe(200);
    const linkedData = (linked.json as { result: { data: { opportunityId: string; customerId: string; projectId: string | null; replayed: boolean } } }).result.data;
    expect(linkedData.replayed).toBe(false);
    expect(linkedData.opportunityId).toBe(existingData.id);
    expect(linkedData.projectId).toBe(existingProjectId); // 复用原项目，不新建
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`))[0].n).toBe(projCountBefore);
    const linkCheck = await query<{
      source_lead_id: string | null; project_id: string | null;
      lead_cust: string | null; lead_opp: string | null;
    }>(
      `SELECT o.source_lead_id, o.project_id,
              l.converted_customer_id AS lead_cust, l.converted_opportunity_id AS lead_opp
       FROM crm_opportunities o JOIN crm_leads l ON l.id = o.source_lead_id
       WHERE o.id=$1`,
      [existingData.id],
    );
    expect(linkCheck[0].source_lead_id).toBe(linkLeadData.id);
    expect(linkCheck[0].lead_opp).toBe(existingData.id);
    expect(linkCheck[0].lead_cust).toBe(linkedData.customerId);
    expect(linkCheck[0].project_id).toBe(existingProjectId); // 三者勾稽一致

    // ===== D-18-2-2：同键仅换项目负责人 → 409；同键同载荷 → 200 不重复立项 =====
    const key = uuid();
    const first = await trpc(app, "crm.opportunities.create", {
      cookie: salesACookie,
      input: { customerId: anyCustomer.id, name: "18-02 幂等靶", projectManagerId: pmUserId, idempotencyKey: key },
    });
    expect(first.status).toBe(200);
    const financeId = (await query<{ id: string }>(`SELECT id FROM users WHERE email='guojingwen@lexflow.demo'`))[0].id;
    const diffPm = await trpc(app, "crm.opportunities.create", {
      cookie: salesACookie,
      input: { customerId: anyCustomer.id, name: "18-02 幂等靶", projectManagerId: financeId, idempotencyKey: key },
    });
    expect(diffPm.status).toBe(409); // 仅换项目负责人=异载荷
    const sameAgain = await trpc(app, "crm.opportunities.create", {
      cookie: salesACookie,
      input: { customerId: anyCustomer.id, name: "18-02 幂等靶", projectManagerId: pmUserId, idempotencyKey: key },
    });
    expect(sameAgain.status).toBe(200);
    expect((sameAgain.json as { result: { data: { replayed: boolean } } }).result.data.replayed).toBe(true);
    expect((sameAgain.json as { result: { data: { id: string } } }).result.data.id).toBe(
      (first.json as { result: { data: { id: string } } }).result.data.id,
    );

    // ===== D-18-2-3：同键同载荷 Promise.all 真并发 → 双 200 同商机/项目，项目仅 +1 =====
    const cKey = uuid();
    const cPayload = { customerId: anyCustomer.id, name: "18-02 并发靶", projectManagerId: pmUserId, idempotencyKey: cKey };
    const projBefore = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`))[0].n;
    const [r1, r2] = await Promise.all([
      trpc(app, "crm.opportunities.create", { cookie: salesACookie, input: cPayload }),
      trpc(app, "crm.opportunities.create", { cookie: salesACookie, input: cPayload }),
    ]);
    expect(r1.status, `r1=${JSON.stringify(r1.json).slice(0, 200)}`).toBe(200);
    expect(r2.status, `r2=${JSON.stringify(r2.json).slice(0, 200)}`).toBe(200); // 不再 200+500
    const r1id = (r1.json as { result: { data: { id: string } } }).result.data.id;
    const r2id = (r2.json as { result: { data: { id: string } } }).result.data.id;
    expect(r1id).toBe(r2id); // 同一商机
    const r1proj = (r1.json as { result: { data: { projectId: string } } }).result.data.projectId;
    const r2proj = (r2.json as { result: { data: { projectId: string } } }).result.data.projectId;
    expect(r1proj).toBe(r2proj); // 同一项目
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`))[0].n).toBe(projBefore + 1);

    // ===== D-18-2-4：sales+presales 组合角色范围并集（被指派商机不丢）=====
    // 销售 B 建独立商机（owner=B，不在 A 的树下）
    const bLead = await trpc(app, "crm.leads.create", { cookie: salesBCookie, input: { name: "18-02 B 组合线索" } });
    const bLeadData = (bLead.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const bConv = await trpc(app, "crm.leads.convert", {
      cookie: salesBCookie,
      input: { id: bLeadData.id, rowVersion: bLeadData.rowVersion, customer: { name: "18-02 B 组合客户" }, projectManagerId: pmUserId, opportunity: { name: "18-02 B 组合商机" } },
    });
    const bOppId = (bConv.json as { result: { data: { opportunityId: string } } }).result.data.opportunityId;
    // A 看不到（树外+未指派）
    const aBefore = await trpc(app, "crm.opportunities.getById", { cookie: salesACookie, method: "GET", input: { id: bOppId } });
    expect(aBefore.status).toBe(404);
    // sysadmin 给 A 加挂 presales 角色
    const assign = await trpc(app, "admin.assignRole", { cookie: sysadminCookie, input: { userId: salesAId, roleKey: "presales" } });
    expect(assign.status).toBe(200);
    // 指派 A 为售前 → A（sales+presales）必须看到
    const bOppDetail = await trpc(app, "crm.opportunities.getById", { cookie: salesBCookie, method: "GET", input: { id: bOppId } });
    const bOppRv = (bOppDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const assignPs = await trpc(app, "crm.opportunities.update", {
      cookie: salesBCookie,
      input: { id: bOppId, rowVersion: bOppRv, presalesId: salesAId },
    });
    expect(assignPs.status).toBe(200);
    const aAfter = await trpc(app, "crm.opportunities.getById", { cookie: salesACookie, method: "GET", input: { id: bOppId } });
    expect(aAfter.status).toBe(200); // 组合角色并集：presales 来源范围不丢
    const aList = await trpc(app, "crm.opportunities.list", { cookie: salesACookie, method: "GET", input: {} });
    expect((aList.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items.some((o) => o.id === bOppId)).toBe(true);
    // 并集另一侧不丢：A 仍见本人 tree 商机
    const mineIds = (aList.json as { result: { data: { items: Array<{ id: string }> } } }).result.data.items;
    expect(mineIds.length).toBeGreaterThanOrEqual(1);
  });

  it("二次打回 D-18-2-5：关联目标商机记录级权限门（B 越权 404/A 本人 200/主管下级 200/树外主管 404）", async () => {
    const customers = await trpc(app, "crm.customers.list", { cookie: salesACookie, method: "GET", input: {} });
    // D-18-2-4 后 A 已加挂 presales——列表含树外指派客户，必须精确取本人 owner 的客户
    const anyCustomer = (customers.json as { result: { data: { items: Array<{ id: string; ownerId: string | null }> } } }).result.data.items
      .find((c) => c.ownerId === salesAId)!;
    const mkOpp = async (name: string) => {
      const res = await trpc(app, "crm.opportunities.create", {
        cookie: salesACookie,
        input: { customerId: anyCustomer.id, name, projectManagerId: pmUserId, idempotencyKey: uuid() },
      });
      expect(res.status).toBe(200);
      return (res.json as { result: { data: { id: string; projectId: string } } }).result.data;
    };
    const mkLead = async (cookie: string, name: string) => {
      const res = await trpc(app, "crm.leads.create", { cookie, input: { name } });
      expect(res.status).toBe(200);
      return (res.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    };
    const convertWith = (cookie: string, leadId: string, rowVersion: number, opportunityId: string) =>
      trpc(app, "crm.leads.convert", { cookie, input: { id: leadId, rowVersion, opportunityId } });

    // 探针 1：销售 B 关联销售 A 的无来源商机 → 404，且目标商机未被污染
    const opp1 = await mkOpp("D-18-2-5 靶商机-1");
    const bLead = await mkLead(salesBCookie, "D-18-2-5 B 线索-1");
    const denied = await convertWith(salesBCookie, bLead.id, bLead.rowVersion, opp1.id);
    expect(denied.status).toBe(404);
    expect(trpcError(denied).businessCode).toBe("ACCESS_DENIED_OR_GONE");
    const opp1After = await query<{ source_lead_id: string | null }>(`SELECT source_lead_id FROM crm_opportunities WHERE id=$1`, [opp1.id]);
    expect(opp1After[0].source_lead_id).toBeNull(); // 无权关联不得写目标
    const bLeadAfter = await query<{ status: string }>(`SELECT status FROM crm_leads WHERE id=$1`, [bLead.id]);
    expect(bLeadAfter[0].status).toBe("new"); // 回滚零副作用

    // 探针 2：销售 A 关联本人无来源商机 → 200，不新建项目
    const opp2 = await mkOpp("D-18-2-5 靶商机-2");
    const projCountBefore = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`))[0].n;
    const aLead = await mkLead(salesACookie, "D-18-2-5 A 线索-2");
    const own = await convertWith(salesACookie, aLead.id, aLead.rowVersion, opp2.id);
    expect(own.status, JSON.stringify(own.json).slice(0, 200)).toBe(200);
    const ownData = (own.json as { result: { data: { projectId: string | null; opportunityId: string } } }).result.data;
    expect(ownData.opportunityId).toBe(opp2.id);
    expect(ownData.projectId).toBe(opp2.projectId); // 复用原项目
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`))[0].n).toBe(projCountBefore);

    // 探针 3：销售主管（郑浩然，A 在其树下）关联下级商机 → 200
    const opp3 = await mkOpp("D-18-2-5 靶商机-3");
    const smLead = await mkLead(smCookie, "D-18-2-5 主管线索-3");
    const byManager = await convertWith(smCookie, smLead.id, smLead.rowVersion, opp3.id);
    expect(byManager.status, JSON.stringify(byManager.json).slice(0, 200)).toBe(200);

    // 探针 4：树外主管 → 404（sysadmin 给林婉清加挂 sales_manager，其树仅本人，A 不在树内）
    const opp4 = await mkOpp("D-18-2-5 靶商机-4");
    const salesBId = (await query<{ id: string }>(`SELECT id FROM users WHERE email='linwanqing@lexflow.demo'`))[0].id;
    const promote = await trpc(app, "admin.assignRole", { cookie: sysadminCookie, input: { userId: salesBId, roleKey: "sales_manager" } });
    expect(promote.status).toBe(200);
    const bLead4 = await mkLead(salesBCookie, "D-18-2-5 B 线索-4");
    const outOfTree = await convertWith(salesBCookie, bLead4.id, bLead4.rowVersion, opp4.id);
    expect(outOfTree.status).toBe(404); // 树外主管无权
    expect(trpcError(outOfTree).businessCode).toBe("ACCESS_DENIED_OR_GONE");
    const opp4After = await query<{ source_lead_id: string | null }>(`SELECT source_lead_id FROM crm_opportunities WHERE id=$1`, [opp4.id]);
    expect(opp4After[0].source_lead_id).toBeNull();
  });
});
