import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 11 · 工单 01（arch/12 §16.2）：approval.detail 审批详情聚合——
 * 权限=申请人∪当前审批人（非审批人同形 404）；通用字段名称映射（项目名/申请人名，禁 uuid）；
 * 按 biz_type 业务快照（报销明细行+合计/出差行程段/经费金额用途/申请单字段/工时周期小时/延期/授权/预算/差旅变更/调整单）；
 * 既有审批列表端点补 projectName/applicantName。
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

interface DetailResult {
  id: string;
  code: string;
  bizType: string;
  status: string;
  projectName: string | null;
  applicantName: string | null;
  submittedAt: string;
  currentStepSeq: number;
  snapshot: Record<string, unknown> & { kind: string };
}

describe("11-01 审批详情聚合端点", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let partnerCookie: string;
  let viewerCookie: string;
  let projectAId: string;
  let pmUserId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    viewerCookie = (await loginAs(app, "hejing@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    const users = await query<{ id: string }>(`SELECT id FROM users WHERE email='wangbaozhuo@lexflow.demo'`);
    pmUserId = users[0].id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("expense：明细行+合计快照 + 权限三探针（审批人/申请人 200，非审批人 404）+ 列表名称映射", async () => {
    const created = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "11-01 报销验收",
        items: [
          { projectId: projectAId, date: "2027-03-01", category: "transport", amountCents: 30000, description: "高铁票" },
          { projectId: projectAId, date: "2027-03-02", category: "meals", amountCents: 12000, description: "工作餐" },
        ],
      },
    });
    expect(created.status).toBe(200);
    const expId = (created.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;
    const detail0 = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: expId }, method: "GET" });
    const sub = await trpc(app, "expense.submit", {
      cookie: memberCookie,
      input: { id: expId, rowVersion: (detail0.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const instId = (sub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;

    // 当前审批人（pm=expense 默认流首步）→ 200 + 快照形状
    const detail = await trpc(app, "approval.detail", { cookie: pmCookie, input: { instanceId: instId }, method: "GET" });
    expect(detail.status).toBe(200);
    const d = (detail.json as { result: { data: DetailResult } }).result.data;
    expect(d.bizType).toBe("expense");
    expect(d.applicantName).toBe("管晨");
    expect(d.projectName).toContain("比博思特");
    expect(d.snapshot.kind).toBe("expense");
    expect(d.snapshot.reason).toBe("11-01 报销验收");
    const items = d.snapshot.items as Array<{ category: string; amountCents: number; description: string; projectName: string | null }>;
    expect(items).toHaveLength(2);
    expect(items.reduce((s, i) => s + i.amountCents, 0)).toBe(d.snapshot.totalCents);
    expect(items[0].projectName).toContain("比博思特");
    expect(d.code).toMatch(new RegExp(`^APR-${YEAR}-`));

    // 申请人 → 200
    expect((await trpc(app, "approval.detail", { cookie: memberCookie, input: { instanceId: instId }, method: "GET" })).status).toBe(200);
    // 非审批人非申请人 → 404 同形
    const denied = await trpc(app, "approval.detail", { cookie: viewerCookie, input: { instanceId: instId }, method: "GET" });
    expect(denied.status).toBe(404);

    // 列表名称映射：pm 待办里含该单（expense 首步 pm）
    const mine = await trpc(app, "approval.listMine", { cookie: pmCookie, method: "GET", input: {} });
    const item = (mine.json as { result: { data: { items: Array<{ instance: { id: string; projectName: string | null; applicantName: string | null } }> } } }).result.data.items
      .find((i) => i.instance.id === instId);
    expect(item).toBeTruthy();
    expect(item!.instance.projectName).toContain("比博思特");
    expect(item!.instance.applicantName).toBe("管晨");
    // 申请人已办列表映射
    const applied = await trpc(app, "approval.listMineApplied", { cookie: memberCookie, method: "GET", input: {} });
    const appliedItem = (applied.json as { result: { data: { items: Array<{ id: string; projectName: string | null; applicantName: string | null }> } } }).result.data.items
      .find((i) => i.id === instId);
    expect(appliedItem?.projectName).toContain("比博思特");
    expect(appliedItem?.applicantName).toBe("管晨");
  });

  it("travel/funding/timesheet/generic_request/change_request：五类快照形状", async () => {
    // travel（含行程段）
    const travel = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId, reason: "11-01 出差", destination: "青岛", startOn: "2027-04-01", endOn: "2027-04-03",
        segments: [
          { seq: 1, type: "transport", startAt: "2027-04-01T01:00:00.000Z", endAt: "2027-04-01T05:00:00.000Z", fromPlace: "北京", toPlace: "青岛" },
          { seq: 2, type: "accommodation", startAt: "2027-04-01T12:00:00.000Z", endAt: "2027-04-02T11:00:00.000Z" },
        ],
      },
    });
    const travelId = (travel.json as { result: { data: { id: string } } }).result.data.id;
    const travelDetail = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const travelSub = await trpc(app, "travel.submit", {
      cookie: memberCookie,
      input: { id: travelId, rowVersion: (travelDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const travelInst = (travelSub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const td = (await trpc(app, "approval.detail", { cookie: pmCookie, input: { instanceId: travelInst }, method: "GET" })).json as { result: { data: DetailResult } };
    expect(td.result.data.snapshot.kind).toBe("travel");
    expect(td.result.data.snapshot.destination).toBe("青岛");
    const segs = td.result.data.snapshot.segments as Array<{ seq: number; type: string; fromPlace?: string }>;
    expect(segs).toHaveLength(2);
    expect(segs[0].fromPlace).toBe("北京");

    // travel_change：原出差审批通过 → 发起变更 → 快照含 changes+原出差概要
    const inst = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: travelInst }, method: "GET" });
    const act = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: travelInst, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(act.status).toBe(200);
    const change = await trpc(app, "travel.submitChange", {
      cookie: memberCookie,
      input: { id: travelId, changes: { destination: "济南" }, reason: "客户地点变更", idempotencyKey: crypto.randomUUID() },
    });
    expect(change.status, `changeSubmit：${JSON.stringify(change.json).slice(0, 300)}`).toBe(200);
    const changeInst = (change.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const cd = (await trpc(app, "approval.detail", { cookie: memberCookie, input: { instanceId: changeInst }, method: "GET" })).json as { result: { data: DetailResult } };
    expect(cd.result.data.snapshot.kind).toBe("travel_change");
    expect((cd.result.data.snapshot.changes as { destination: string }).destination).toBe("济南");
    expect((cd.result.data.snapshot.travel as { destination: string }).destination).toBe("青岛");

    // funding
    const funding = await trpc(app, "funding.create", {
      cookie: memberCookie,
      input: { projectId: projectAId, purpose: "11-01 经费", amountCents: 250000, expectedUseDate: "2027-04-10" },
    });
    const fundingId = (funding.json as { result: { data: { id: string } } }).result.data.id;
    const fundingDetail = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fundingId }, method: "GET" });
    const fundingSub = await trpc(app, "funding.submit", {
      cookie: memberCookie,
      input: { id: fundingId, rowVersion: (fundingDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const fundingInst = (fundingSub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const fd = (await trpc(app, "approval.detail", { cookie: pmCookie, input: { instanceId: fundingInst }, method: "GET" })).json as { result: { data: DetailResult } };
    expect(fd.result.data.snapshot.kind).toBe("funding");
    expect(fd.result.data.snapshot.purpose).toBe("11-01 经费");
    expect(fd.result.data.snapshot.amountCents).toBe(250000);

    // timesheet（周期+小时合计+明细摘要）
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: {} });
    const periodId = (mp.json as { result: { data: { period: { id: string; periodStart: string } } } }).result.data.period.id;
    const weekStart = (mp.json as { result: { data: { period: { periodStart: string } } } }).result.data.period.periodStart;
    await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [
          { projectId: projectAId, activityType: "professional_work", workDate: weekStart, durationMinutes: 240, description: "合同审查" },
          { projectId: projectAId, activityType: "meeting", workDate: weekStart, durationMinutes: 120, description: "客户会议" },
        ],
      },
    });
    const timeSub = await trpc(app, "time.submit", { cookie: memberCookie, input: { periodId, idempotencyKey: crypto.randomUUID() } });
    const timeInst = (timeSub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const td2 = (await trpc(app, "approval.detail", { cookie: pmCookie, input: { instanceId: timeInst }, method: "GET" })).json as { result: { data: DetailResult } };
    expect(td2.result.data.snapshot.kind).toBe("timesheet");
    expect(td2.result.data.snapshot.totalMinutes).toBe(360);
    expect(td2.result.data.snapshot.totalHours).toBe(6);
    const entries = td2.result.data.snapshot.entries as Array<{ projectName: string | null; durationMinutes: number }>;
    expect(entries).toHaveLength(2);
    expect(entries[0].projectName).toContain("比博思特");

    // generic_request（initiator_choice 指定 pm）
    const req = await trpc(app, "genericRequest.create", {
      cookie: memberCookie,
      input: { requestType: "leave", title: "11-01 请假", reason: "家中有事", startOn: "2027-05-01", endOn: "2027-05-02" },
    });
    const reqId = (req.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;
    const reqSub = await trpc(app, "genericRequest.submit", {
      cookie: memberCookie,
      input: { id: reqId, rowVersion: 0, idempotencyKey: crypto.randomUUID(), chosenApproverId: pmUserId },
    });
    const reqInst = (reqSub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const rd = (await trpc(app, "approval.detail", { cookie: pmCookie, input: { instanceId: reqInst }, method: "GET" })).json as { result: { data: DetailResult } };
    expect(rd.result.data.snapshot.kind).toBe("generic_request");
    expect(rd.result.data.snapshot.requestType).toBe("leave");
    expect(rd.result.data.snapshot.title).toBe("11-01 请假");

    // change_request（延期申请：原因+影响）
    const plan = await trpc(app, "plan.current", { cookie: memberCookie, input: { projectId: projectAId }, method: "GET" });
    const planItems = (plan.json as { result: { data: { items: Array<{ refId: string; itemType: string; newStart?: string; plannedStart?: string; plannedEnd?: string }> } } }).result.data.items;
    const stageItem = planItems.find((i) => i.itemType === "stage")!;
    const cr = await trpc(app, "change.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        title: "11-01 阶段延期",
        level: "normal",
        targetItems: [{ ref_id: stageItem.refId, item_type: "stage", new_start: "2027-06-01", new_end: "2027-07-15" }],
        reason: "证据补充需时",
        impact: "里程碑顺延 5 天",
        recoveryMeasures: [{ measure: "增派取证人员", owner_id: pmUserId, checkpoint_date: "2027-06-15" }],
      },
    });
    expect(cr.status).toBe(200);
    const crId = (cr.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;
    const crDetail = await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" });
    const crSub = await trpc(app, "change.submit", {
      cookie: memberCookie,
      input: { id: crId, rowVersion: (crDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const crInst = (crSub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const crd = (await trpc(app, "approval.detail", { cookie: pmCookie, input: { instanceId: crInst }, method: "GET" })).json as { result: { data: DetailResult } };
    expect(crd.result.data.snapshot.kind).toBe("change_request");
    expect(crd.result.data.snapshot.reason).toBe("证据补充需时");
    expect(crd.result.data.snapshot.impact).toBe("里程碑顺延 5 天");
    void inst;
  });

  it("expense_adjustment / access_grant / budget：直造实体+实例的快照形状 + budget 真实链", async () => {
    const users = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email IN ('guanchen@lexflow.demo','wangbaozhuo@lexflow.demo')`,
    );
    const memberId = users.find((u) => u.email === "guanchen@lexflow.demo")!.id;
    const codes = [`APR-${YEAR}-9${Math.floor(Math.random() * 900 + 100)}`, `APR-${YEAR}-9${Math.floor(Math.random() * 900 + 100)}`];

    // expense_adjustment 实体 + 实例（approver=pm）
    const [report] = await query<{ id: string }>(`SELECT id FROM expense_reports LIMIT 1`);
    const [adj] = await query<{ id: string }>(
      `INSERT INTO expense_adjustments (expense_report_id, code, delta_cents, reason, status, created_by, updated_by)
       VALUES ($1, 'ADJ-TEST-01', -5000, '冲销多计', 'pending_approval', $2, $2) RETURNING id`,
      [report.id, memberId],
    );
    // access_grant 实体
    const [grant] = await query<{ id: string }>(
      `INSERT INTO access_grants (grantee_id, scope_type, scope_id, actions, granted_by, created_by)
       VALUES ($1, 'project', $2, ARRAY['project.read']::text[], $3, $3) RETURNING id`,
      [memberId, projectAId, memberId],
    );
    // 两个实例（pm 为当前审批人）
    const instRows = await query<{ id: string }>(
      `INSERT INTO approval_instances (code, biz_type, biz_id, project_id, applicant_id, form_snapshot, policy_snapshot, current_step_seq, status, idempotency_key)
       VALUES ($1, 'expense_adjustment', $2, $3, $4, '{}'::jsonb, '{}'::jsonb, 1, 'pending', $5),
              ($6, 'access_grant', $7, $3, $4, '{}'::jsonb, '{}'::jsonb, 1, 'pending', $8) RETURNING id`,
      [codes[0], adj.id, projectAId, memberId, crypto.randomUUID(), codes[1], grant.id, crypto.randomUUID()],
    );
    for (const inst of instRows) {
      await query(
        `INSERT INTO approval_steps (instance_id, seq, approver_id, status) VALUES ($1, 1, $2, 'pending')`,
        [inst.id, pmUserId],
      );
    }

    const adjDetail = (await trpc(app, "approval.detail", { cookie: pmCookie, input: { instanceId: instRows[0].id }, method: "GET" })).json as { result: { data: DetailResult } };
    expect(adjDetail.result.data.snapshot.kind).toBe("expense_adjustment");
    expect(adjDetail.result.data.snapshot.deltaCents).toBe(-5000);
    expect(adjDetail.result.data.snapshot.reason).toBe("冲销多计");
    expect(String(adjDetail.result.data.snapshot.sourceReportCode)).toContain("EXP");

    const grantDetail = (await trpc(app, "approval.detail", { cookie: pmCookie, input: { instanceId: instRows[1].id }, method: "GET" })).json as { result: { data: DetailResult } };
    expect(grantDetail.result.data.snapshot.kind).toBe("access_grant");
    expect(grantDetail.result.data.snapshot.scopeType).toBe("project");
    expect((grantDetail.result.data.snapshot.actions as string[]).join()).toContain("project.read");

    // budget 真实链：pm 创建预算 → partner 审批 → detail
    const budget = await trpc(app, "budget.create", {
      cookie: pmCookie,
      input: { projectId: projectAId, periodStart: "2027-06-01", periodEnd: "2027-12-31", totalCents: 900000 },
    });
    expect(budget.status).toBe(200);
    const budgetId = (budget.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;
    const budgetDetail = await trpc(app, "budget.getById", { cookie: pmCookie, input: { id: budgetId }, method: "GET" });
    const budgetSub = await trpc(app, "budget.submit", {
      cookie: pmCookie,
      input: { id: budgetId, rowVersion: (budgetDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(budgetSub.status).toBe(200);
    const budgetInst = (budgetSub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const bd = (await trpc(app, "approval.detail", { cookie: partnerCookie, input: { instanceId: budgetInst }, method: "GET" })).json as { result: { data: DetailResult } };
    expect(bd.result.data.snapshot.kind).toBe("budget");
    expect(bd.result.data.snapshot.totalCents).toBe(900000);
    expect(bd.result.data.applicantName).toBe("王宝茁");
  });
});
