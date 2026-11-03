import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 2 验收套件·出差域（arch/05 §8）：B6 审批策略（借款会签+超阈值两步+自审拦截）/
 * B7 变更重审 / B8 完成与关闭 / B9 取消 / B10 按日预填建议。独立验收链。
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

async function meId(app: Awaited<ReturnType<typeof getApp>>, cookie: string): Promise<string> {
  const result = await trpc(app, "auth.me", { cookie, method: "GET" });
  return (result.json as { result: { data: { user: { id: string } } } }).result.data.user.id;
}

async function travelByCode(code: string): Promise<string> {
  const rows = await query<{ id: string }>(`SELECT id FROM travel_requests WHERE code = $1`, [code]);
  if (!rows[0]) throw new Error(`种子出差 ${code} 缺失`);
  return rows[0].id;
}

describe("迭代 2 验收·出差域（arch/05 §8 B6–B10）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let partnerCookie: string;
  let financeCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    projectAId = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("B6 借款会签全链：pm 单步双批并发恰一生效 → finance 会签通过 → approved；零台账写入、申请人通知单发", async () => {
    const created = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        reason: "验收借款会签",
        destination: "成都",
        startOn: "2027-09-01",
        endOn: "2027-09-03",
        estimatedCostCents: 300000,
        borrow: true,
        borrowAmountCents: 150000,
        segments: [
          { seq: 1, type: "transport", startAt: "2027-09-01T01:00:00.000Z", endAt: "2027-09-01T05:00:00.000Z" },
          { seq: 2, type: "accommodation", startAt: "2027-09-01T14:00:00.000Z", endAt: "2027-09-03T10:00:00.000Z" },
        ],
      },
    });
    expect(created.status).toBe(200);
    const travelId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const detail = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const rv = (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const submitted = await trpc(app, "travel.submit", {
      cookie: memberCookie,
      input: { id: travelId, rowVersion: rv, idempotencyKey: crypto.randomUUID() },
    });
    expect(submitted.status).toBe(200);
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;

    const approval = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: instanceId }, method: "GET" });
    const steps = (approval.json as {
      result: { data: { steps: { seq: number; approverRole: string | null; countersign: string }[] } };
    }).result.data.steps;
    expect(steps.map((s) => s.seq)).toEqual([1, 2]);
    expect(steps[1]).toMatchObject({ approverRole: "finance", countersign: "all" });

    // pm 第一步并发双批：恰一生效（另一 200 applied=false）
    const [a, b] = await Promise.all([
      trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
      }),
      trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
      }),
    ]);
    const appliedCount = [a, b].filter(
      (r) => r.status === 200 && (r.json as { result: { data: { applied: boolean } } }).result.data.applied,
    ).length;
    expect(appliedCount).toBe(1);

    // finance 会签步：pm 不可代审（子步精确到人）
    const proxyAct = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(proxyAct.status).toBe(404);
    const financeAct = await trpc(app, "approval.act", {
      cookie: financeCookie,
      input: { instanceId, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(financeAct.status).toBe(200);
    const after = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    expect((after.json as { result: { data: { status: string } } }).result.data.status).toBe("approved");

    // 申请人终态通知单发（travel_approval；引擎对 travel 域停发通用 approval_result）
    const notices = await trpc(app, "notification.listMine", { cookie: memberCookie, method: "GET" });
    const items = (notices.json as { result: { data: { items: { eventType: string; sourceId: string }[] } } })
      .result.data.items;
    const domain = items.filter((n) => n.eventType === "travel_approval" && n.sourceId === travelId);
    const generic = items.filter((n) => n.eventType === "approval_result" && n.sourceId === travelId);
    expect(domain.length).toBeGreaterThanOrEqual(1);
    expect(generic.length).toBe(0);

    // TRV-004：零费用/台账语义——事件流无费用动作，预计费用保持纯提示字段
    const events = (after.json as { result: { data: { events: { action: string }[] } } }).result.data.events;
    expect(events.map((e) => e.action)).not.toContain("complete");
    expect(events.map((e) => e.action)).not.toContain("expense");
  });

  it("B6 超阈值两步升级与申请人自审拦截", async () => {
    const created = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        reason: "验收超阈值升级",
        destination: "上海",
        startOn: "2027-09-10",
        endOn: "2027-09-11",
        estimatedCostCents: 5_000_000, // ≥ 50000 元
        segments: [{ seq: 1, type: "transport", startAt: "2027-09-10T01:00:00.000Z", endAt: "2027-09-10T05:00:00.000Z" }],
      },
    });
    const travelId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const detail = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const submitted = await trpc(app, "travel.submit", {
      cookie: memberCookie,
      input: {
        id: travelId,
        rowVersion: (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const approval = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: instanceId }, method: "GET" });
    const steps = (approval.json as { result: { data: { steps: { seq: number; approverRole: string | null }[] } } })
      .result.data.steps;
    expect(steps.map((s) => s.seq)).toEqual([1, 2]);
    expect(steps[1].approverRole).toBe("partner");
    // 两步按序审批
    await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() } });
    await trpc(app, "approval.act", { cookie: partnerCookie, input: { instanceId, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() } });
    const after = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    expect((after.json as { result: { data: { status: string } } }).result.data.status).toBe("approved");

    // 申请人自审被拦（默认策略审批人=项目负责人=申请人本人）
    const self = await trpc(app, "travel.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        reason: "负责人自审探测",
        destination: "南京",
        startOn: "2027-09-20",
        endOn: "2027-09-21",
        segments: [{ seq: 1, type: "transport", startAt: "2027-09-20T01:00:00.000Z", endAt: "2027-09-20T04:00:00.000Z" }],
      },
    });
    const selfId = (self.json as { result: { data: { id: string } } }).result.data.id;
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

  it("B7 变更重审：events 前后值留痕，通过生效，驳回原状不动", async () => {
    const travelId = await travelByCode(`TRV-${YEAR}-00001`);
    const before = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const beforeData = (before.json as {
      result: { data: { destination: string; estimatedCostCents: number | null } };
    }).result.data;

    const changed = await trpc(app, "travel.submitChange", {
      cookie: memberCookie,
      input: {
        id: travelId,
        changes: { destination: "武汉", estimatedCostCents: 180000 },
        reason: "客户改址（验收）",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(changed.status).toBe(200);
    const instanceId = (changed.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const submitEvent = await query<{ payload_json: { before?: { destination: string } } | null }>(
      `SELECT payload_json FROM travel_events WHERE travel_request_id = $1 AND action = 'change_submit'`,
      [travelId],
    );
    expect(submitEvent[0].payload_json?.before?.destination).toBe(beforeData.destination);

    const approved = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(approved.status).toBe(200);
    const after = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    expect((after.json as { result: { data: { destination: string } } }).result.data.destination).toBe("武汉");
    const approveEvent = await query<{ payload_json: { before?: { estimatedCostCents: number | null } } | null }>(
      `SELECT payload_json FROM travel_events WHERE travel_request_id = $1 AND action = 'change_approved'`,
      [travelId],
    );
    expect(approveEvent[0].payload_json?.before?.estimatedCostCents).toBe(beforeData.estimatedCostCents);

    // 驳回原状不动
    const second = await trpc(app, "travel.submitChange", {
      cookie: memberCookie,
      input: { id: travelId, changes: { destination: "深圳" }, reason: "再次变更（验收）", idempotencyKey: crypto.randomUUID() },
    });
    const instance2 = (second.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const rejected = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: instance2, stepSeq: 1, action: "reject", comment: "维持原计划（验收）", idempotencyKey: crypto.randomUUID() },
    });
    expect(rejected.status).toBe(200);
    const final = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    expect((final.json as { result: { data: { destination: string } } }).result.data.destination).toBe("武汉");
  });

  it("B8 完成与关闭：摘要必填、归档 10、返回报销提醒一次、零费用记录、关闭留痕", async () => {
    const travelId = await travelByCode(`TRV-${YEAR}-00001`);
    const detail = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const rv = (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const departed = await trpc(app, "travel.transition", {
      cookie: memberCookie,
      input: { id: travelId, action: "depart", rowVersion: rv },
    });
    expect(departed.status).toBe(200);

    const afterDepart = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const rv2 = (afterDepart.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const noSummary = await trpc(app, "travel.transition", {
      cookie: memberCookie,
      input: { id: travelId, action: "complete", rowVersion: rv2 },
    });
    expect(noSummary.status).toBe(400); // 摘要必填
    const completed = await trpc(app, "travel.transition", {
      cookie: memberCookie,
      input: {
        id: travelId,
        action: "complete",
        rowVersion: rv2,
        completionSummary: "完成客户拜访与证据补充（验收）",
        actualCostNote: "高铁二等座",
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

    // 归档 10 + 报销提醒一次
    const link = await query<{ dir_key: string }>(
      `SELECT d.dir_key FROM archive_links l JOIN archive_directories d ON d.id = l.directory_id
       WHERE l.source_type = 'travel' AND l.source_id = $1`,
      [travelId],
    );
    expect(link.some((l) => l.dir_key === "10_出差与费用")).toBe(true);
    await trpc(app, "travel.list", { cookie: memberCookie, method: "GET" }); // 触发 sweep
    const onceRows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
       WHERE event_type = 'travel_return_expense' AND source_id = $1
         AND recipient_id = (SELECT id FROM users WHERE email = 'guanchen@lexflow.demo')`,
      [travelId],
    );
    expect(onceRows[0].n).toBe(1);

    // 关闭留痕
    const rv3 = (after.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const closed = await trpc(app, "travel.transition", {
      cookie: memberCookie,
      input: { id: travelId, action: "close", rowVersion: rv3 },
    });
    expect(closed.status).toBe(200);
    const closeEvents = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM travel_events WHERE travel_request_id = $1 AND action = 'close'`,
      [travelId],
    );
    expect(closeEvents[0].n).toBe(1);
  });

  it("B9 出差取消：approved → cancelled 留痕；终态后不可再取消", async () => {
    const created = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        reason: "验收取消出差",
        destination: "苏州",
        startOn: "2027-09-25",
        endOn: "2027-09-26",
        segments: [{ seq: 1, type: "transport", startAt: "2027-09-25T01:00:00.000Z", endAt: "2027-09-25T03:00:00.000Z" }],
      },
    });
    const travelId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const detail = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    await trpc(app, "travel.submit", {
      cookie: memberCookie,
      input: {
        id: travelId,
        rowVersion: (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    const after = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const instanceId = (after.json as { result: { data: { approvalInstanceId: string | null } } }).result.data
      .approvalInstanceId!;
    await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });

    const d3 = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
    const rv3 = (d3.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const cancelled = await trpc(app, "travel.transition", {
      cookie: memberCookie,
      input: { id: travelId, action: "cancel", rowVersion: rv3, reason: "行程冲突取消（验收）" },
    });
    expect(cancelled.status).toBe(200);
    const events = await query<{ action: string; payload_json: { reason?: string } | null }>(
      `SELECT action, payload_json FROM travel_events WHERE travel_request_id = $1 AND action = 'cancel'`,
      [travelId],
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload_json?.reason).toContain("行程冲突");
    // 终态不可再取消
    const again = await trpc(app, "travel.transition", {
      cookie: memberCookie,
      input: { id: travelId, action: "cancel", rowVersion: rv3 + 1, reason: "再取消" },
    });
    expect(again.status).toBe(409);
  });

  it("B10 出差预填建议：按分段日期给每日分钟数，不按 24h，只算不存", async () => {
    // 自建双日分段出差：首日 540 分钟、次日 180 分钟（绝不按 24h）
    const created = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        reason: "预填建议验收",
        destination: "西安",
        startOn: "2027-12-20",
        endOn: "2027-12-21",
        segments: [
          { seq: 1, type: "transport", startAt: "2027-12-20T01:00:00.000Z", endAt: "2027-12-20T10:00:00.000Z" },
          { seq: 2, type: "client_site", startAt: "2027-12-21T01:00:00.000Z", endAt: "2027-12-21T04:00:00.000Z" },
        ],
      },
    });
    const travelId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const suggestion = await trpc(app, "travel.timePrefillSuggestion", {
      cookie: memberCookie,
      method: "GET",
      input: { travelId },
    });
    const data = (suggestion.json as {
      result: { data: { projectId: string; days: { date: string; minutes: number }[] } };
    }).result.data;
    expect(data.projectId).toBe(projectAId);
    expect(data.days).toHaveLength(2);
    expect(data.days[0].minutes).toBe(540);
    expect(data.days[1].minutes).toBe(180);
    expect(data.days.every((d) => d.minutes < 24 * 60)).toBe(true);
    // 只算不存：无工时表/行产生
    const leaked = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'travel' AND source_id = $1`,
      [travelId],
    );
    expect(leaked[0].n).toBe(0);
  });
});
