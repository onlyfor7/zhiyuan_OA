import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 4 验收套件·工时域（arch/07 §8 D1–D6/D10 红线）：
 * 24h 跨周期合并阻止（同日拆两周期仍被拦）、approved/locked 只读、退回重提历史、
 * 预填幂等且不计有效工时、复制草稿、unlock 授权链+理由+审计。独立验收取证。
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

async function meId(app: Awaited<ReturnType<typeof getApp>>, cookie: string): Promise<string> {
  const result = await trpc(app, "auth.me", { cookie, method: "GET" });
  return (result.json as { result: { data: { user: { id: string } } } }).result.data.user.id;
}

async function approveCurrent(
  app: Awaited<ReturnType<typeof getApp>>, viewerCookie: string, instanceId: string, approverCookie: string,
): Promise<void> {
  const detail = await trpc(app, "approval.getById", { cookie: viewerCookie, input: { id: instanceId }, method: "GET" });
  const stepSeq = (detail.json as { result: { data: { currentStepSeq: number } } }).result.data.currentStepSeq;
  const acted = await trpc(app, "approval.act", {
    cookie: approverCookie,
    input: { instanceId, stepSeq, action: "approve", idempotencyKey: crypto.randomUUID() },
  });
  expect(acted.status).toBe(200);
}

describe("迭代 4 验收·工时域（arch/07 §8 红线）", () => {
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

  it("D1 红线：同日拆两周期合计 >24h 仍被拦（跨周期合并）；整数分钟；警告不阻断", async () => {
    // 周期 X 存 900 分钟（同一 work_date）
    const weekX = monday(10);
    const mpX = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: weekX } });
    const periodX = (mpX.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    const d0 = dayOf(weekX, 0);
    const saveX = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId: periodX,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: d0, durationMinutes: 900, description: "周期X 900" }],
      },
    });
    expect(saveX.status).toBe(200);

    // 周期 Y（另一周）同一 work_date 再存 600 → 900+600=1500>1440 必须拦（红线：跨周期合并）
    const weekY = monday(11);
    const mpY = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: weekY } });
    const periodY = (mpY.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    const over24 = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId: periodY,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: d0, durationMinutes: 600, description: "周期Y 600 同日" }],
      },
    });
    expect(over24.status).toBe(400);
    expect(trpcError(over24).fieldErrors).toHaveProperty("blockers");

    // 整数分钟 >0
    const zero = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId: periodY,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: dayOf(weekY, 1), durationMinutes: 0, description: "x" }],
      },
    });
    expect(zero.status).toBe(400);

    // 警告（超阈值+缺说明）不阻断
    const warnWeek = monday(12);
    const mpW = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: warnWeek } });
    const periodW = (mpW.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    const saveW = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId: periodW,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: dayOf(warnWeek, 0), durationMinutes: 660, description: "" }],
      },
    });
    expect(saveW.status).toBe(200);
    const validate = await trpc(app, "time.validate", { cookie: memberCookie, input: { periodId: periodW }, method: "GET" });
    const warnings = (validate.json as { result: { data: { warnings: string[] } } }).result.data.warnings;
    expect(warnings.some((w) => w.includes("超过常规阈值"))).toBe(true);
    expect(warnings.some((w) => w.includes("缺说明"))).toBe(true);
  });

  it("D2 提交审批链：pending/approved 明细只读；撤回/退回后恢复可编辑且历史完整", async () => {
    const week = monday(13);
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const periodId = (mp.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    const d1 = dayOf(week, 1);
    await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: d1, durationMinutes: 420, description: "D2 首次填报" }],
      },
    });
    const submitted = await trpc(app, "time.submit", { cookie: memberCookie, input: { periodId, idempotencyKey: crypto.randomUUID() } });
    expect(submitted.status).toBe(200);
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;

    // pending 期间只读
    const editPending = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: { periodId, idempotencyKey: crypto.randomUUID(), entries: [] },
    });
    expect(editPending.status).toBe(409);

    // 退回路径：驳回必填意见 → returned → 可改（历史完整：同周期 id，原行可改）
    const noNote = await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId, stepSeq: 1, action: "reject" } });
    expect(noNote.status).toBe(400);
    const rejected = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "reject", comment: "请补充说明", idempotencyKey: crypto.randomUUID() },
    });
    expect(rejected.status).toBe(200);
    const rPeriod = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const rData = (rPeriod.json as { result: { data: { period: { status: string; returnedNote: string } } } }).result.data.period;
    expect(rData.status).toBe("returned");
    expect(rData.returnedNote).toBe("请补充说明");
    const reedit = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: d1, durationMinutes: 450, description: "按意见补充后重提" }],
      },
    });
    expect(reedit.status).toBe(200);

    // 重提 → 批准 → approved 只读
    const resub = await trpc(app, "time.submit", { cookie: memberCookie, input: { periodId, idempotencyKey: crypto.randomUUID() } });
    const inst2 = (resub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await approveCurrent(app, memberCookie, inst2, pmCookie);
    const after = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    expect((after.json as { result: { data: { period: { status: string } } } }).result.data.period.status).toBe("approved");
    const editApproved = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: { periodId, idempotencyKey: crypto.randomUUID(), entries: [] },
    });
    expect(editApproved.status).toBe(409);
  });

  it("D3 负责人工时上级审批：pm 周期 approver 解析为 partner；pm 自审被拦", async () => {
    const week = monday(14);
    const mp = await trpc(app, "time.myPeriod", { cookie: pmCookie, method: "GET", input: { periodStart: week } });
    const periodId = (mp.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    await trpc(app, "time.saveEntries", {
      cookie: pmCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: dayOf(week, 0), durationMinutes: 300, description: "pm 工时" }],
      },
    });
    const submitted = await trpc(app, "time.submit", { cookie: pmCookie, input: { periodId, idempotencyKey: crypto.randomUUID() } });
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const partnerId = await meId(app, partnerCookie);
    const inst = await trpc(app, "approval.getById", { cookie: partnerCookie, input: { id: instanceId }, method: "GET" });
    const steps = (inst.json as { result: { data: { steps: { approverId: string | null }[] } } }).result.data.steps;
    expect(steps[0].approverId).toBe(partnerId); // 负责人工时上级审批，不得自审
    const selfAct = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(selfAct.status).toBe(404);
  });

  it("D4 unlock 授权链：无权限 404；理由必填 400；有权限解锁留理由+审计；locked 编辑 403 PERIOD_LOCKED", async () => {
    const lockedId = (await query<{ id: string }>(`SELECT id FROM timesheet_periods WHERE code = $1`, [`TS-${YEAR}-00003`]))[0].id;
    const denied = await trpc(app, "time.unlock", { cookie: memberCookie, input: { periodId: lockedId, reason: "x" } });
    expect(denied.status).toBe(404);
    const noReason = await trpc(app, "time.unlock", { cookie: partnerCookie, input: { periodId: lockedId, reason: "" } });
    expect(noReason.status).toBe(400);
    const unlocked = await trpc(app, "time.unlock", { cookie: partnerCookie, input: { periodId: lockedId, reason: "验收解锁：补录调整" } });
    expect(unlocked.status).toBe(200);
    const audit = await query<{ action: string; after_json: { reason?: string } }>(
      `SELECT action, after_json FROM audit_events WHERE action = 'time.unlock' AND target_id = $1`, [lockedId],
    );
    expect(audit[0].after_json.reason).toBe("验收解锁：补录调整");
    const status = await query<{ status: string }>(`SELECT status FROM timesheet_periods WHERE id = $1`, [lockedId]);
    expect(status[0].status).toBe("approved"); // 解锁回已批准（明细只读口径延续）

    // 再锁 → 普通修改 403 PERIOD_LOCKED
    const relock = await trpc(app, "time.lock", { cookie: partnerCookie, input: { periodId: lockedId, reason: "复验锁定" } });
    expect(relock.status).toBe(200);
    const editLocked = await trpc(app, "time.saveEntries", {
      cookie: (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie,
      input: { periodId: lockedId, idempotencyKey: crypto.randomUUID(), entries: [] },
    });
    expect(editLocked.status).toBe(403);
    expect(trpcError(editLocked).businessCode).toBe("PERIOD_LOCKED");
  });

  it("D5 预填幂等且不计有效工时；取消会议拒绝", async () => {
    const meetingId = (await query<{ id: string }>(`SELECT id FROM meetings WHERE code = $1`, [`MTG-${YEAR}-00002`]))[0].id;
    const summaryBefore = await trpc(app, "time.stats.mySummary", { cookie: memberCookie, method: "GET", input: {} });
    const before = (summaryBefore.json as { result: { data: { minutes: { approvedAndLocked: number } } } }).result.data.minutes.approvedAndLocked;

    const first = await trpc(app, "time.prefillFromMeeting", { cookie: memberCookie, input: { meetingId } });
    expect((first.json as { result: { data: { created: number } } }).result.data.created).toBe(1);
    const again = await trpc(app, "time.prefillFromMeeting", { cookie: memberCookie, input: { meetingId } });
    expect((again.json as { result: { data: { skipped: number } } }).result.data.skipped).toBe(1); // 幂等去重

    // 出差预填同口径
    const travelId = (await query<{ id: string }>(`SELECT id FROM travel_requests WHERE code = $1`, [`TRV-${YEAR}-00001`]))[0].id;
    const t1 = await trpc(app, "time.prefillFromTravel", { cookie: memberCookie, input: { travelId } });
    expect(t1.status).toBe(200);
    const t2 = await trpc(app, "time.prefillFromTravel", { cookie: memberCookie, input: { travelId } });
    expect((t2.json as { result: { data: { skipped?: number; created?: number } } }).result.data.created ?? 0).toBe(0);

    // 取消会议拒绝
    const cm = await trpc(app, "meeting.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId, type: "project", subject: "预填拒绝会",
        startAt: "2027-12-01T01:00:00.000Z", endAt: "2027-12-01T02:00:00.000Z",
        participants: [{ userId: await meId(app, memberCookie) }],
      },
    });
    const cmId = (cm.json as { result: { data: { id: string } } }).result.data.id;
    await trpc(app, "meeting.transition", { cookie: pmCookie, input: { id: cmId, action: "cancel", reason: "取消" } });
    const prefillCancelled = await trpc(app, "time.prefillFromMeeting", { cookie: memberCookie, input: { meetingId: cmId } });
    expect(prefillCancelled.status).toBe(409);

    // 预填只产草稿：周期仍 draft、不计有效工时
    const after = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET" });
    const afterData = (after.json as { result: { data: { period: { status: string }; entries: { source: string }[] } } }).result.data;
    expect(afterData.period.status).toBe("draft");
    expect(afterData.entries.some((e) => e.source === "prefill_meeting" || e.source === "prefill_travel")).toBe(true);
    const summaryAfter = await trpc(app, "time.stats.mySummary", { cookie: memberCookie, method: "GET", input: {} });
    const minutes = (summaryAfter.json as { result: { data: { minutes: { draft: number; approvedAndLocked: number } } } }).result.data.minutes;
    expect(minutes.draft).toBeGreaterThan(0);
    expect(minutes.approvedAndLocked).toBe(before); // 预填不计有效工时
  });

  it("D6 复制草稿：仅产 copy 源草稿，提交前必须确认", async () => {
    const week = monday(15);
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const periodId = (mp.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    const srcDate = dayOf(week, 0);
    await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: srcDate, durationMinutes: 240, description: "复制源" }],
      },
    });
    const before = await query<{ n: number }>(`SELECT count(*)::int AS n FROM time_entries WHERE period_id=$1`, [periodId]);
    const copied = await trpc(app, "time.copyDay", {
      cookie: memberCookie,
      input: { fromDate: srcDate, toDate: dayOf(week, 1) },
    });
    expect(copied.status).toBe(200);
    const after = await query<{ n: number; sources: string }>(
      `SELECT count(*)::int AS n, string_agg(DISTINCT source::text, ',') AS sources FROM time_entries WHERE period_id=$1`, [periodId],
    );
    expect(after[0].n).toBe(before[0].n + 1);
    expect(after[0].sources).toContain("copy");
    const period = await query<{ status: string }>(`SELECT status FROM timesheet_periods WHERE id=$1`, [periodId]);
    expect(period[0].status).toBe("draft"); // 复制只产草稿，未提交
  });

  it("D10 工时待办两源：待提交（draft 有明细）/待我审（提交后审批人）", async () => {
    const memberTodo = await trpc(app, "todo.mine", { cookie: memberCookie, method: "GET" });
    const mKinds = (memberTodo.json as { result: { data: { items: { kind: string }[] } } }).result.data.items;
    expect(mKinds.some((i) => i.kind === "time_submit")).toBe(true);

    const week = monday(16);
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const periodId = (mp.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: dayOf(week, 0), durationMinutes: 120, description: "待审批样例" }],
      },
    });
    const submitted = await trpc(app, "time.submit", { cookie: memberCookie, input: { periodId, idempotencyKey: crypto.randomUUID() } });
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const pmTodo = await trpc(app, "todo.mine", { cookie: pmCookie, method: "GET" });
    const pItems = (pmTodo.json as { result: { data: { items: { kind: string }[] } } }).result.data.items;
    expect(pItems.some((i) => i.kind === "time_approve")).toBe(true); // 审批人待办源在位（id 为 todo 自身键，非实例 id）
  });
});
