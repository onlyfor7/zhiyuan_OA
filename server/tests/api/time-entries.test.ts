import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

const YEAR = new Date().getFullYear();

function monday(offsetWeeks: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + offsetWeeks * 7);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function dayOf(weekMonday: string, plusDays: number): string {
  const d = new Date(`${weekMonday}T00:00:00Z`);
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

async function approveInstance(
  app: Awaited<ReturnType<typeof getApp>>,
  cookie: string,
  instanceId: string,
  approverCookie?: string,
): Promise<void> {
  const detail = await trpc(app, "approval.getById", { cookie, input: { id: instanceId }, method: "GET" });
  const instance = (detail.json as { result: { data: { status: string; currentStepSeq: number } } }).result.data;
  if (instance.status !== "pending") return;
  const acted = await trpc(app, "approval.act", {
    cookie: approverCookie ?? cookie,
    input: { instanceId, stepSeq: instance.currentStepSeq, action: "approve", idempotencyKey: crypto.randomUUID() },
  });
  expect(acted.status).toBe(200);
}

describe("迭代 4 工时域（D1–D6/D10）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let partnerCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "partner@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    projectAId = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("D1 校验：整数分钟>0；单日 >24h 跨周期合并阻止；超阈值/缺说明警告", async () => {
    const week = monday(1); // 下周全新周期
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    expect(mp.status).toBe(200);
    const periodId = (mp.json as { result: { data: { period: { id: string } } } }).result.data.period.id;

    // 整数分钟 >0
    const badMinutes = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: dayOf(week, 0), durationMinutes: 0, description: "x" }],
      },
    });
    expect(badMinutes.status).toBe(400);

    // 跨周期合并 24h：先在周期 X 存 900，再在周期 Y 同日期 600 → 阻止
    const weekX = monday(2);
    const mpX = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: weekX } });
    const periodX = (mpX.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    const d0 = dayOf(weekX, 0);
    const saveX = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId: periodX,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: d0, durationMinutes: 900, description: "周期X 900分钟" }],
      },
    });
    expect(saveX.status).toBe(200);
    const weekY = monday(3);
    const mpY = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: weekY } });
    const periodY = (mpY.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    // 周期 Y 与 X 不同周但同 work_date 不可能（不同周日期不同）——按红线语义：同一 work_date 跨周期合并
    // 构造同日期：把 Y 周期日期也用 d0（允许任意 work_date，校验按日期合并全周期）
    const over24 = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId: periodY,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: d0, durationMinutes: 600, description: "跨周期合并超限" }],
      },
    });
    expect(over24.status).toBe(400);
    expect(trpcError(over24).fieldErrors).toHaveProperty("blockers");

    // 警告：超阈值 + 缺说明（threshold=600 种子配置）
    const warnWeek = monday(4);
    const mpW = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: warnWeek } });
    const periodW = (mpW.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    const saveW = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId: periodW,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: dayOf(warnWeek, 0), durationMinutes: 700, description: "" }],
      },
    });
    expect(saveW.status).toBe(200); // 警告不阻断
    const validate = await trpc(app, "time.validate", { cookie: memberCookie, input: { periodId: periodW }, method: "GET" });
    const checks = (validate.json as { result: { data: { warnings: string[] } } }).result.data;
    expect(checks.warnings.some((w) => w.includes("超过常规阈值"))).toBe(true);
    expect(checks.warnings.some((w) => w.includes("缺说明"))).toBe(true);
  });

  it("D2 提交审批链：draft→pending→approved→明细只读；撤回/退回重提", async () => {
    const week = monday(5);
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const periodId = (mp.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    const d1 = dayOf(week, 1);
    await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: d1, durationMinutes: 420, description: "D2 填报" }],
      },
    });
    const submitted = await trpc(app, "time.submit", {
      cookie: memberCookie,
      input: { periodId, idempotencyKey: crypto.randomUUID() },
    });
    expect(submitted.status).toBe(200);
    // member 非 pm 角色 → approver = 主项目 manager = pm（种子含演示，此处新建周期同口径）
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const inst = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: instanceId }, method: "GET" });
    expect((inst.json as { result: { data: { steps: { approverId: string }[] } } }).result.data.steps[0].approverId).toBeTruthy();

    // 待审批期间只读
    const editPending = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: { periodId, idempotencyKey: crypto.randomUUID(), entries: [] },
    });
    expect(editPending.status).toBe(409);

    // 撤回 → 可编辑
    const pd = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const withdraw = await trpc(app, "time.withdraw", {
      cookie: memberCookie,
      input: { periodId, rowVersion: (pd.json as { result: { data: { period: { rowVersion: number } } } }).result.data.period.rowVersion },
    });
    expect(withdraw.status).toBe(200);
    const reedit = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: d1, durationMinutes: 430, description: "D2 重填" }],
      },
    });
    expect(reedit.status).toBe(200);

    // 重提 → pm 通过 → approved → 明细只读
    const resub = await trpc(app, "time.submit", { cookie: memberCookie, input: { periodId, idempotencyKey: crypto.randomUUID() } });
    const inst2 = (resub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await approveInstance(app, pmCookie, inst2, pmCookie);
    const after = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    expect((after.json as { result: { data: { period: { status: string } } } }).result.data.period.status).toBe("approved");
    const editApproved = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: { periodId, idempotencyKey: crypto.randomUUID(), entries: [] },
    });
    expect(editApproved.status).toBe(409);

    // 退回路径：另建周期提交后驳回必填意见 → returned → 可改重提
    const weekR = monday(6);
    const mpR = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: weekR } });
    const periodR = (mpR.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId: periodR,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: dayOf(weekR, 2), durationMinutes: 60, description: "退回探测" }],
      },
    });
    const subR = await trpc(app, "time.submit", { cookie: memberCookie, input: { periodId: periodR, idempotencyKey: crypto.randomUUID() } });
    const instR = (subR.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const noNote = await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: instR, stepSeq: 1, action: "reject" } });
    expect(noNote.status).toBe(400);
    const rejected = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: instR, stepSeq: 1, action: "reject", comment: "说明不完整", idempotencyKey: crypto.randomUUID() },
    });
    expect(rejected.status).toBe(200);
    const rPeriod = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: weekR } });
    const rData = (rPeriod.json as { result: { data: { period: { status: string; returnedNote: string } } } }).result.data.period;
    expect(rData.status).toBe("returned");
    expect(rData.returnedNote).toBe("说明不完整");
    const reeditReturned = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId: periodR,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: dayOf(weekR, 2), durationMinutes: 90, description: "按意见补充" }],
      },
    });
    expect(reeditReturned.status).toBe(200);
  });

  it("D3 负责人工时上级审批：pm 周期 approver 解析为 partner；自审被拦", async () => {
    const week = monday(0); // pm 本周无周期 → 自动建
    const mp = await trpc(app, "time.myPeriod", { cookie: pmCookie, method: "GET", input: { periodStart: week } });
    const periodId = (mp.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    await trpc(app, "time.saveEntries", {
      cookie: pmCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: dayOf(week, 3), durationMinutes: 300, description: "pm 周期工作" }],
      },
    });
    const submitted = await trpc(app, "time.submit", { cookie: pmCookie, input: { periodId, idempotencyKey: crypto.randomUUID() } });
    expect(submitted.status).toBe(200);
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const detail = await trpc(app, "approval.getById", { cookie: partnerCookie, input: { id: instanceId }, method: "GET" });
    const steps = (detail.json as { result: { data: { steps: { approverRole: string | null }[]; approverId: string } } }).result.data;
    expect(steps.steps[0].approverRole).toBeNull(); // 运行时解析落具体人
    // pm 自审被拦（非当前审批人）
    const selfAct = await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() } });
    expect(selfAct.status).toBe(404);
    // partner 通过
    await approveInstance(app, partnerCookie, instanceId, partnerCookie);
    const after = await trpc(app, "time.myPeriod", { cookie: pmCookie, method: "GET", input: { periodStart: week } });
    expect((after.json as { result: { data: { period: { status: string } } } }).result.data.period.status).toBe("approved");
  });

  it("D4 周期锁定：普通修改 409；unlock 专门权限+理由+审计", async () => {
    // pm 上周 locked 周期（种子 TS-00003）
    const lockedId = (
      await query<{ id: string }>(`SELECT id FROM timesheet_periods WHERE code = $1`, [`TS-${YEAR}-00003`])
    )[0].id;
    // member 无权限解锁
    const denied = await trpc(app, "time.unlock", { cookie: memberCookie, input: { periodId: lockedId, reason: "x" } });
    expect(denied.status).toBe(404);
    // partner 解锁缺理由 → 400
    const noReason = await trpc(app, "time.unlock", { cookie: partnerCookie, input: { periodId: lockedId, reason: "" } });
    expect(noReason.status).toBe(400);
    // 解锁成功 + 审计行
    const unlocked = await trpc(app, "time.unlock", {
      cookie: partnerCookie,
      input: { periodId: lockedId, reason: "补录上月调整" },
    });
    expect(unlocked.status).toBe(200);
    const audit = await query<{ action: string; after_json: { reason?: string } }>(
      `SELECT action, after_json FROM audit_events WHERE action = 'time.unlock' AND target_id = $1`,
      [lockedId],
    );
    expect(audit[0].after_json.reason).toBe("补录上月调整");

    // member 的 approved 周期：member 锁定被拒（非 manager/partner），pm 可锁（项目 A manager）
    const approvedId = (
      await query<{ id: string }>(`SELECT id FROM timesheet_periods WHERE code = $1`, [`TS-${YEAR}-00002`])
    )[0].id;
    const memberLock = await trpc(app, "time.lock", { cookie: memberCookie, input: { periodId: approvedId } });
    expect(memberLock.status).toBe(404);
    const pmLock = await trpc(app, "time.lock", { cookie: pmCookie, input: { periodId: approvedId, reason: "月度归档" } });
    expect(pmLock.status).toBe(200);
    const editLocked = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: { periodId: approvedId, idempotencyKey: crypto.randomUUID(), entries: [] },
    });
    expect(editLocked.status).toBe(403); // PERIOD_LOCKED → FORBIDDEN
    expect(trpcError(editLocked).businessCode).toBe("PERIOD_LOCKED");
  });

  it("D5 会议预填：产草稿、幂等去重、取消会议拒绝、不计有效工时", async () => {
    const meetingId = (
      await query<{ id: string }>(`SELECT id FROM meetings WHERE code = $1`, [`MTG-${YEAR}-00002`])
    )[0].id;
    const before = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET" });
    const entriesBefore = (before.json as { result: { data: { entries: unknown[] } } }).result.data.entries.length;

    const first = await trpc(app, "time.prefillFromMeeting", { cookie: memberCookie, input: { meetingId } });
    expect(first.status).toBe(200);
    expect((first.json as { result: { data: { created: number } } }).result.data.created).toBe(1);
    const again = await trpc(app, "time.prefillFromMeeting", { cookie: memberCookie, input: { meetingId } });
    expect((again.json as { result: { data: { skipped: number } } }).result.data.skipped).toBe(1); // 幂等去重

    // 取消会议拒绝
    const cancelled = await trpc(app, "meeting.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        type: "project",
        subject: "将取消的预填会",
        startAt: "2027-11-01T01:00:00.000Z",
        endAt: "2027-11-01T02:00:00.000Z",
        participants: [{ userId: (await me(app, memberCookie)) }],
      },
    });
    const cmId = (cancelled.json as { result: { data: { id: string } } }).result.data.id;
    await trpc(app, "meeting.transition", { cookie: pmCookie, input: { id: cmId, action: "cancel", reason: "取消" } });
    const prefillCancelled = await trpc(app, "time.prefillFromMeeting", { cookie: memberCookie, input: { meetingId: cmId } });
    expect(prefillCancelled.status).toBe(409);

    // 预填只在 draft 周期产草稿（可编辑、未提交）
    const after = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET" });
    const afterData = (after.json as {
      result: { data: { period: { status: string }; entries: { source: string }[] } };
    }).result.data;
    expect(afterData.period.status).toBe("draft");
    expect(afterData.entries.length).toBe(entriesBefore + 1);
    expect(afterData.entries.some((e) => e.source === "prefill_meeting")).toBe(true);
    // 不计有效工时：mySummary 的 approvedAndLocked 不含 draft 分钟
    const summary = await trpc(app, "time.stats.mySummary", { cookie: memberCookie, method: "GET", input: {} });
    const minutes = (summary.json as { result: { data: { minutes: { draft: number; approvedAndLocked: number } } } }).result.data.minutes;
    expect(minutes.draft).toBeGreaterThan(0);
    expect(minutes.approvedAndLocked).toBe(1860); // 种子 approved 1860，draft 单列
  });

  it("D6 复制草稿：仅产 copy 源草稿，提交前必须确认", async () => {
    const week = monday(7);
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const periodId = (mp.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: dayOf(week, 0), durationMinutes: 120, description: "复制源" }],
      },
    });
    const copied = await trpc(app, "time.copyDay", { cookie: memberCookie, input: { fromDate: dayOf(week, 0), toDate: dayOf(week, 1) } });
    expect(copied.status).toBe(200);
    expect((copied.json as { result: { data: { created: number } } }).result.data.created).toBe(1);
    const after = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const entries = (after.json as { result: { data: { entries: { source: string; workDate: string }[] } } }).result.data.entries;
    const copy = entries.find((e) => e.source === "copy");
    expect(copy?.workDate).toBe(dayOf(week, 1));
    // 草稿态：周期仍 draft，不提交不统计
    expect((after.json as { result: { data: { period: { status: string } } } }).result.data.period.status).toBe("draft");
  });

  it("D10 待办两源 + timesheet_gap 通知", async () => {
    // member 本周 draft 有明细 → 待提交工时
    const memberTodo = await trpc(app, "todo.mine", { cookie: memberCookie, method: "GET" });
    const memberKinds = (memberTodo.json as { result: { data: { items: { kind: string }[] } } }).result.data.items;
    expect(memberKinds.some((i) => i.kind === "time_submit")).toBe(true);

    // pm 作为 member 周期的 approver：先让 member 提交一个本周周期？本周 draft 已存在 → 直接提交
    const week = monday(0);
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const periodData = (mp.json as { result: { data: { period: { id: string; status: string; rowVersion: number } } } }).result.data.period;
    if (periodData.status === "draft" || periodData.status === "returned") {
      await trpc(app, "time.submit", { cookie: memberCookie, input: { periodId: periodData.id, idempotencyKey: crypto.randomUUID() } });
    }
    const pmTodo = await trpc(app, "todo.mine", { cookie: pmCookie, method: "GET" });
    const pmKinds = (pmTodo.json as { result: { data: { items: { kind: string; id: string }[] } } }).result.data.items;
    expect(pmKinds.some((i) => i.kind === "time_approve")).toBe(true);

    // timesheet_gap：把 member 一个 draft 周期的 period_end 拨到明天 → sweep 发通知
    await query(
      `UPDATE timesheet_periods SET period_end = now()::date + 1 WHERE id = (SELECT id FROM timesheet_periods WHERE user_id = (SELECT id FROM users WHERE email='member@lexflow.demo') AND status = 'draft' ORDER BY created_at DESC LIMIT 1)`,
    );
    await trpc(app, "todo.mine", { cookie: memberCookie, method: "GET" });
    const gap = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE event_type = 'timesheet_gap' AND recipient_id = (SELECT id FROM users WHERE email='member@lexflow.demo')`,
    );
    expect(gap[0].n).toBeGreaterThanOrEqual(1);
  });
});

async function me(app: Awaited<ReturnType<typeof getApp>>, cookie: string): Promise<string> {
  const result = await trpc(app, "auth.me", { cookie, method: "GET" });
  return (result.json as { result: { data: { user: { id: string } } } }).result.data.user.id;
}
