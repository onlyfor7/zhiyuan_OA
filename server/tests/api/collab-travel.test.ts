import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

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

async function travelIdByCode(code: string): Promise<string> {
  const rows = await query<{ id: string }>(`SELECT id FROM travel_requests WHERE code = $1`, [code]);
  if (!rows[0]) throw new Error(`种子出差 ${code} 缺失`);
  return rows[0].id;
}

describe("迭代 2 出差域（B5/B6/B7/B8/B9/B10）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let partnerCookie: string;
  let financeCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "partner@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "finance@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    projectAId = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("创建校验：分段内/间时间倒挂与 seq 不连续 → 400 fieldErrors", async () => {
    const base = {
      projectId: projectAId,
      reason: "校验探测出差",
      destination: "北京",
      startOn: "2027-07-01",
      endOn: "2027-07-03",
      segments: [{ seq: 1, type: "transport" as const, startAt: "2027-07-01T01:00:00.000Z", endAt: "2027-07-01T00:00:00.000Z" }],
    };
    const innerInverted = await trpc(app, "travel.create", { cookie: memberCookie, input: base });
    expect(innerInverted.status).toBe(400);
    expect(trpcError(innerInverted).fieldErrors).toHaveProperty("segments");

    const crossInverted = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        ...base,
        segments: [
          { seq: 1, type: "transport", startAt: "2027-07-01T06:00:00.000Z", endAt: "2027-07-01T10:00:00.000Z" },
          { seq: 2, type: "accommodation", startAt: "2027-07-01T09:00:00.000Z", endAt: "2027-07-01T12:00:00.000Z" },
        ],
      },
    });
    expect(crossInverted.status).toBe(400);

    const seqGap = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        ...base,
        segments: [
          { seq: 2, type: "transport", startAt: "2027-07-01T06:00:00.000Z", endAt: "2027-07-01T10:00:00.000Z" },
        ],
      },
    });
    expect(seqGap.status).toBe(400);
    expect(trpcError(seqGap).fieldErrors).toHaveProperty("segments");
  });

  it("B6 审批策略：超阈值两步升级（pm → partner），全程不写台账、完成≠费用批准", async () => {
    const created = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        reason: "超阈值两步升级探测",
        destination: "上海",
        startOn: "2027-07-10",
        endOn: "2027-07-12",
        estimatedCostCents: 5_000_000, // ≥ 50000 元阈值
        segments: [
          { seq: 1, type: "transport", startAt: "2027-07-10T01:00:00.000Z", endAt: "2027-07-10T05:00:00.000Z", fromPlace: "杭州", toPlace: "上海" },
          { seq: 2, type: "client_site", startAt: "2027-07-10T06:00:00.000Z", endAt: "2027-07-10T09:00:00.000Z" },
        ],
      },
    });
    expect(created.status).toBe(200);
    const travelId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const detail = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const rowVersion = (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;

    const submitted = await trpc(app, "travel.submit", {
      cookie: memberCookie,
      input: { id: travelId, rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(submitted.status).toBe(200);
    const instanceId = (submitted.json as {
      result: { data: { instance: { id: string; currentStepSeq: number } } };
    }).result.data.instance.id;
    const approval = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: instanceId }, method: "GET" });
    const steps = (approval.json as { result: { data: { steps: { seq: number; approverRole: string | null }[] } } })
      .result.data.steps;
    expect(steps.map((s) => s.seq)).toEqual([1, 2]); // 两步升级：pm → partner
    expect(steps[1].approverRole).toBe("partner");

    // 第一步 pm 通过
    const step1 = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(step1.status).toBe(200);
    // 第二步 partner 通过 → approved；不写任何预算占用（TRV-004：无台账写入路径）
    const step2 = await trpc(app, "approval.act", {
      cookie: partnerCookie,
      input: { instanceId, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(step2.status).toBe(200);
    const after = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    expect((after.json as { result: { data: { status: string } } }).result.data.status).toBe("approved");
    // 预计费用仅提示字段：无费用/台账记录产生（迭代 3 才有费用表；此处断言事件流无费用动作）
    const events = (after.json as { result: { data: { events: { action: string }[] } } }).result.data.events;
    expect(events.map((e) => e.action)).not.toContain("complete");

    // 申请人自审被拦：pm 是项目 A 负责人，默认策略审批人=本人 → SELF_APPROVAL_BLOCKED
    const selfTravel = await trpc(app, "travel.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        reason: "负责人自审探测",
        destination: "南京",
        startOn: "2027-07-20",
        endOn: "2027-07-21",
        segments: [{ seq: 1, type: "transport", startAt: "2027-07-20T01:00:00.000Z", endAt: "2027-07-20T04:00:00.000Z" }],
      },
    });
    const selfId = (selfTravel.json as { result: { data: { id: string } } }).result.data.id;
    const selfDetail = await trpc(app, "travel.getById", { cookie: pmCookie, input: { id: selfId }, method: "GET" });
    const selfSubmit = await trpc(app, "travel.submit", {
      cookie: pmCookie,
      input: {
        id: selfId,
        rowVersion: (selfDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(selfSubmit.status).toBe(403);
    expect(trpcError(selfSubmit).businessCode).toBe("SELF_APPROVAL_BLOCKED");
  });

  it("B6 借款会签：borrow=true → pm + finance 顺序审批；finance 收到 approval_pending", async () => {
    // 新提借款出差（种子 TRV-00002 为展示态无审批实例；会签链路用真实提交验证）
    const created = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        reason: "借款会签探测",
        destination: "北京",
        startOn: "2027-07-15",
        endOn: "2027-07-17",
        estimatedCostCents: 400000,
        borrow: true,
        borrowAmountCents: 200000,
        segments: [
          { seq: 1, type: "transport", startAt: "2027-07-15T01:00:00.000Z", endAt: "2027-07-15T05:00:00.000Z" },
          { seq: 2, type: "accommodation", startAt: "2027-07-15T14:00:00.000Z", endAt: "2027-07-17T11:00:00.000Z" },
        ],
      },
    });
    const travelId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const detail = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const rv = (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const submitted = await trpc(app, "travel.submit", {
      cookie: memberCookie,
      input: { id: travelId, rowVersion: rv, idempotencyKey: crypto.randomUUID() },
    });
    expect(submitted.status).toBe(200);
    const instanceId = (submitted.json as {
      result: { data: { instance: { id: string } } };
    }).result.data.instance.id;

    // 借款策略命中（borrow=true，p10）：两步 [pm, finance(countersign=all)]
    const approval = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: instanceId }, method: "GET" });
    const steps = (approval.json as { result: { data: { steps: { seq: number; approverRole: string | null; countersign: string }[] } } })
      .result.data.steps;
    expect(steps.map((s) => s.seq)).toEqual([1, 2]);
    expect(steps[1]).toMatchObject({ approverRole: "finance", countersign: "all" });

    // pm（第一步）通过 → 进入第二步时引擎通知 finance
    const step1 = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(step1.status).toBe(200);
    const financeNotices = await trpc(app, "notification.listMine", { cookie: financeCookie, method: "GET" });
    expect(
      ((financeNotices.json as { result: { data: { items: { eventType: string; sourceId: string }[] } } }).result.data.items)
        .some((n) => n.eventType === "approval_pending" && n.sourceId === travelId),
    ).toBe(true);
    const step2 = await trpc(app, "approval.act", {
      cookie: financeCookie,
      input: { instanceId, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(step2.status).toBe(200);
    const after = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    expect((after.json as { result: { data: { status: string } } }).result.data.status).toBe("approved");
    // 申请人收到 travel_approval 终态通知
    const memberNotices = await trpc(app, "notification.listMine", { cookie: memberCookie, method: "GET" });
    expect(
      ((memberNotices.json as { result: { data: { items: { eventType: string }[] } } }).result.data.items)
        .some((n) => n.eventType === "travel_approval"),
    ).toBe(true);
  });

  it("B7 变更重审：关键字段走引擎，events 前后值留痕，驳回原状不动", async () => {
    const travelId = await travelIdByCode(`TRV-${YEAR}-00001`); // member approved 3 段
    const before = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const beforeData = (before.json as {
      result: { data: { destination: string; estimatedCostCents: number | null; rowVersion: number } };
    }).result.data;

    // 变更 destination + estimated
    const changed = await trpc(app, "travel.submitChange", {
      cookie: memberCookie,
      input: {
        id: travelId,
        changes: { destination: "广州", estimatedCostCents: 260000 },
        reason: "客户要求改址",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(changed.status).toBe(200);
    const instanceId = (changed.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;

    // 事件流含 change_submit（前后值）
    const events = await query<{ action: string; payload_json: { before?: { destination: string } } | null }>(
      `SELECT action, payload_json FROM travel_events WHERE travel_request_id = $1 ORDER BY created_at`,
      [travelId],
    );
    const submitEvent = events.find((e) => e.action === "change_submit");
    expect(submitEvent?.payload_json?.before?.destination).toBe(beforeData.destination);

    // pm 通过 → 同事务应用 + change_approved 前后值
    const approved = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(approved.status).toBe(200);
    const after = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const afterData = (after.json as {
      result: { data: { destination: string; estimatedCostCents: number | null } };
    }).result.data;
    expect(afterData.destination).toBe("广州");
    expect(afterData.estimatedCostCents).toBe(260000);
    const approveEvent = await query<{ payload_json: { before?: { estimatedCostCents: number | null } } | null }>(
      `SELECT payload_json FROM travel_events WHERE travel_request_id = $1 AND action = 'change_approved'`,
      [travelId],
    );
    expect(approveEvent[0].payload_json?.before?.estimatedCostCents).toBe(beforeData.estimatedCostCents);

    // 驳回原状不动：再发起变更，pm 驳回
    const second = await trpc(app, "travel.submitChange", {
      cookie: memberCookie,
      input: { id: travelId, changes: { destination: "深圳" }, reason: "再次变更", idempotencyKey: crypto.randomUUID() },
    });
    const instance2 = (second.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const rejected = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: instance2, stepSeq: 1, action: "reject", comment: "维持原计划", idempotencyKey: crypto.randomUUID() },
    });
    expect(rejected.status).toBe(200);
    const final = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    expect((final.json as { result: { data: { destination: string } } }).result.data.destination).toBe("广州");
  });

  it("B8 完成与关闭：摘要+归档 10+返回报销提醒；不产生费用记录；关闭留痕", async () => {
    const travelId = await travelIdByCode(`TRV-${YEAR}-00001`);
    // approved → depart → in_progress
    const detail = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const rv = (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const departed = await trpc(app, "travel.transition", {
      cookie: memberCookie,
      input: { id: travelId, action: "depart", rowVersion: rv },
    });
    expect(departed.status).toBe(200);

    const afterDepart = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const rv2 = (afterDepart.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const completed = await trpc(app, "travel.transition", {
      cookie: memberCookie,
      input: {
        id: travelId,
        action: "complete",
        rowVersion: rv2,
        completionSummary: "拜访客户并完成证据补充，实际行程与计划一致",
        actualCostNote: "高铁二等座往返",
      },
    });
    expect(completed.status).toBe(200);

    const after = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const afterData = (after.json as {
      result: { data: { status: string; completedAt: string | null; events: { action: string }[] } };
    }).result.data;
    expect(afterData.status).toBe("completed");
    expect(afterData.completedAt).toBeTruthy();
    expect(afterData.events.map((e) => e.action)).toContain("complete");

    // 归档 10：来源对已入目录；返回报销提醒通知（一次）
    const link = await query<{ source_type: string }>(
      `SELECT source_type FROM archive_links WHERE source_type = 'travel' AND source_id = $1`,
      [travelId],
    );
    expect(link.length).toBeGreaterThanOrEqual(1);
    const notices = await trpc(app, "notification.listMine", { cookie: memberCookie, method: "GET" });
    expect(
      ((notices.json as { result: { data: { items: { eventType: string; sourceId: string }[] } } }).result.data.items)
        .some((n) => n.eventType === "travel_return_expense" && n.sourceId === travelId),
    ).toBe(true);
    // 只提醒一次：重跑 sweep（再查一次列表触发）仍单行
    await trpc(app, "travel.list", { cookie: memberCookie, method: "GET" });
    const onceRows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE event_type = 'travel_return_expense' AND source_id = $1 AND recipient_id = (SELECT id FROM users WHERE email = 'member@lexflow.demo')`,
      [travelId],
    );
    expect(onceRows[0].n).toBe(1);

    // close
    const rv3 = (after.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const closed = await trpc(app, "travel.transition", {
      cookie: memberCookie,
      input: { id: travelId, action: "close", rowVersion: rv3 },
    });
    expect(closed.status).toBe(200);
    const events = await query<{ action: string }>(
      `SELECT action FROM travel_events WHERE travel_request_id = $1 AND action = 'close'`,
      [travelId],
    );
    expect(events.length).toBe(1);
  });

  it("B9 出差取消：approved → cancelled 留痕（事件+原因）；completed 不可取消", async () => {
    const created = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        reason: "将取消的出差",
        destination: "成都",
        startOn: "2027-08-01",
        endOn: "2027-08-02",
        segments: [{ seq: 1, type: "transport", startAt: "2027-08-01T01:00:00.000Z", endAt: "2027-08-01T04:00:00.000Z" }],
      },
    });
    const id = (created.json as { result: { data: { id: string } } }).result.data.id;
    const d1 = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id }, method: "GET" });
    await trpc(app, "travel.submit", {
      cookie: memberCookie,
      input: { id, rowVersion: (d1.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const d2 = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id }, method: "GET" });
    const instanceId = (d2.json as { result: { data: { approvalInstance: { id: string } | null } } }).result.data.approvalInstance!.id;
    await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });

    const d3 = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id }, method: "GET" });
    const noReason = await trpc(app, "travel.transition", {
      cookie: memberCookie,
      input: { id, action: "cancel", rowVersion: (d3.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, reason: "" },
    });
    expect(noReason.status).toBe(400);

    const cancelled = await trpc(app, "travel.transition", {
      cookie: memberCookie,
      input: { id, action: "cancel", rowVersion: (d3.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, reason: "客户改期" },
    });
    expect(cancelled.status).toBe(200);
    const events = await query<{ action: string; payload_json: { reason?: string } | null }>(
      `SELECT action, payload_json FROM travel_events WHERE travel_request_id = $1 AND action = 'cancel'`,
      [id],
    );
    expect(events[0].payload_json?.reason).toBe("客户改期");

    // completed 不可取消（TRV-00001 已 closed）
    const doneId = await travelIdByCode(`TRV-${YEAR}-00001`);
    const doneDetail = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: doneId }, method: "GET" });
    const bad = await trpc(app, "travel.transition", {
      cookie: memberCookie,
      input: { id: doneId, action: "cancel", rowVersion: (doneDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, reason: "x" },
    });
    expect(bad.status).toBe(409);
  });

  it("B10 出差工时预填建议：按分段日期给每日分钟数，绝不按 24h，只算不存", async () => {
    const created = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        reason: "预填建议探测",
        destination: "西安",
        startOn: "2027-09-01",
        endOn: "2027-09-02",
        segments: [
          // 首日 09:00-18:00（+8）= 540 分钟；次日 09:00-12:00（+8）= 180 分钟
          { seq: 1, type: "transport", startAt: "2027-09-01T01:00:00.000Z", endAt: "2027-09-01T10:00:00.000Z" },
          { seq: 2, type: "client_site", startAt: "2027-09-02T01:00:00.000Z", endAt: "2027-09-02T04:00:00.000Z" },
        ],
      },
    });
    const id = (created.json as { result: { data: { id: string } } }).result.data.id;
    const suggestion = await trpc(app, "travel.timePrefillSuggestion", {
      cookie: memberCookie,
      input: { travelId: id },
      method: "GET",
    });
    const data = (suggestion.json as {
      result: { data: { projectId: string; days: { date: string; minutes: number }[] } };
    }).result.data;
    expect(data.projectId).toBe(projectAId);
    expect(data.days.length).toBe(2);
    expect(data.days[0].minutes).toBe(540);
    expect(data.days[1].minutes).toBe(180);
    expect(data.days.every((d) => d.minutes < 24 * 60)).toBe(true);
  });
});
