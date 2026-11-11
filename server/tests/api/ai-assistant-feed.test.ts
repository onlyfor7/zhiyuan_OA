import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc } from "./helpers";

/**
 * 迭代 15 · 工单 02（arch/12 §19.3）：ai.assistant.feed 六类提醒聚合——
 * 待办审批/会议临近（30 分钟内）/任务临期（24h）与逾期/工时未填报（本周）/报销待处理/回款临期逾期（fin.read 口径，无权限不出现）；
 * 条目 {type, icon(§4.4 域), title, sourceLabel, link, urgency(warn/danger)}；danger 优先+计数汇总；只读不审计。
 */

interface FeedItem {
  type: string;
  icon: string;
  title: string;
  sourceLabel: string;
  link: string;
  urgency: "warn" | "danger";
}
interface FeedResult {
  items: FeedItem[];
  counts: { total: number; danger: number; warn: number; byType: Record<string, number> };
}

const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * 60_000).toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n: number) => {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("15-02 小元内置提醒服务 ai.assistant.feed", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let financeCookie: string;
  let projectAId: string;
  let pmUserId: string;

  const feed = (cookie: string) =>
    trpc(app, "ai.assistant.feed", { cookie, method: "GET" }).then(
      (r) => (r.json as { result: { data: FeedResult } }).result.data,
    );

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    // 精确取项目 A（比博思特，guanchen 是成员）——list 按 updatedAt DESC，首项未必是 A（历棒测试同口径）
    projectAId = items.find((p) => p.code === `PRJ-${new Date().getFullYear()}-00001`)!.id;
    const users = await trpc(app, "user.list", { cookie: pmCookie, method: "GET", input: { keyword: "王宝茁" } });
    pmUserId = (users.json as { result: { data: { items: { id: string }[] } } }).result.data.items[0].id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("六类造数断言 + 条目形状（键集/urgency 枚举/icon §4.4 域）+ danger 优先排序 + 计数汇总", async () => {
    // ① 待办审批：member 提请假（initiator_choice→pm）→ pm feed 有 approval 条目
    const req = await trpc(app, "genericRequest.create", {
      cookie: memberCookie,
      input: { requestType: "leave", title: "15-02 请假", reason: "家中有事" },
    });
    const reqId = (req.json as { result: { data: { id: string } } }).result.data.id;
    await trpc(app, "genericRequest.submit", {
      cookie: memberCookie,
      input: { id: reqId, rowVersion: 0, idempotencyKey: crypto.randomUUID(), chosenApproverId: pmUserId },
    });

    // ② 会议临近：15 分钟后（出现）/2 小时后（不出现）
    const near = await trpc(app, "meeting.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId, type: "project", subject: "15-02 临会",
        startAt: iso(15), endAt: iso(45), participants: [{ userId: pmUserId }],
      },
    });
    expect(near.status).toBe(200);
    const meetingId = (near.json as { result: { data: { id: string } } }).result.data.id;
    await trpc(app, "meeting.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId, type: "project", subject: "15-02 远会",
        startAt: iso(120), endAt: iso(150), participants: [{ userId: pmUserId }],
      },
    });

    // ③ 任务临期（明天=warn）与逾期（昨天=danger）
    const soon = await trpc(app, "task.create", {
      cookie: pmCookie,
      input: { projectId: projectAId, title: "15-02 临期任务", plannedStart: today(), plannedEnd: addDays(1), assigneeId: pmUserId },
    });
    expect(soon.status).toBe(200);
    const over = await trpc(app, "task.create", {
      cookie: pmCookie,
      input: { projectId: projectAId, title: "15-02 逾期任务", plannedStart: addDays(-3), plannedEnd: addDays(-1), assigneeId: pmUserId },
    });
    expect(over.status).toBe(200);

    // ④ 工时未填报：pm 本周无周期行 → 有 timesheet 条目
    // ⑤ 报销待处理：member 报销提交→pm 驳回（danger）+ 草稿（warn）
    const exp = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: { reason: "15-02 报销", items: [{ projectId: projectAId, date: today(), category: "transport", amountCents: 5000, description: "出租车" }] },
    });
    expect(exp.status, `expense.create：${JSON.stringify(exp.json).slice(0, 250)}`).toBe(200);
    const expId = (exp.json as { result: { data: { id: string } } }).result.data.id;
    await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: { reason: "15-02 报销草稿", items: [{ projectId: projectAId, date: today(), category: "meals", amountCents: 3000, description: "餐费" }] },
    });
    const expDetail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: expId }, method: "GET" });
    const expSub = await trpc(app, "expense.submit", {
      cookie: memberCookie,
      input: { id: expId, rowVersion: (expDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const expInst = (expSub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: expInst, stepSeq: 1, action: "reject", comment: "补充发票", idempotencyKey: crypto.randomUUID() } });

    // ===== pm feed：approval/meeting/task/timesheet 四类 =====
    const pmFeed = await feed(pmCookie);
    expect(pmFeed.counts.byType.approval).toBeGreaterThanOrEqual(1);
    const approvalItem = pmFeed.items.find((i) => i.type === "approval" && i.sourceLabel === "管晨")!;
    expect(approvalItem.title).toContain("申请单");
    expect(approvalItem.title).toContain("待审批");
    expect(approvalItem.sourceLabel).toBe("管晨");
    expect(approvalItem.icon).toBe("approval");
    expect(approvalItem.link).toContain("/approvals?instance=");

    const meetingItem = pmFeed.items.find((i) => i.type === "meeting" && i.title.includes("15-02 临会"))!;
    expect(meetingItem.title).toContain("15-02 临会");
    expect(meetingItem.urgency).toBe("warn");
    expect(pmFeed.items.some((i) => i.title.includes("15-02 远会"))).toBe(false); // 30 分钟外不出现

    const taskSoon = pmFeed.items.find((i) => i.type === "task" && i.title.includes("临期任务"))!;
    expect(taskSoon.urgency).toBe("warn");
    const taskOver = pmFeed.items.find((i) => i.type === "task" && i.title.includes("逾期任务"))!;
    expect(taskOver.urgency).toBe("danger");
    expect(taskOver.title).toContain("已逾期");

    expect(pmFeed.counts.byType.timesheet).toBe(1); // 本周未填报

    // ===== member feed：expense 两类 + 无 approval（非审批人） =====
    const memberFeed = await feed(memberCookie);
    const expBack = memberFeed.items.find((i) => i.type === "expense" && i.urgency === "danger")!;
    expect(expBack.title).toContain("被退回");
    expect(expBack.icon).toBe("expense");
    expect(memberFeed.items.some((i) => i.type === "expense" && i.urgency === "warn" && i.title.includes("草稿"))).toBe(true);
    expect(memberFeed.counts.byType.approval).toBe(0); // 权限不放大：非审批人无该类

    // ===== 形状：键集精确 + urgency 枚举 + link 非空 =====
    for (const item of [...pmFeed.items, ...memberFeed.items]) {
      expect(Object.keys(item).sort()).toEqual(["icon", "link", "sourceLabel", "title", "type", "urgency"]);
      expect(["warn", "danger"]).toContain(item.urgency);
      expect(item.link.length).toBeGreaterThan(0);
      expect(["approval", "meeting", "task", "time", "expense", "finance"]).toContain(item.icon);
    }

    // ===== 排序：danger 全在 warn 前 + 计数汇总 =====
    const urgencies = pmFeed.items.map((i) => i.urgency);
    const firstWarn = urgencies.indexOf("warn");
    const lastDanger = urgencies.lastIndexOf("danger");
    expect(firstWarn === -1 || lastDanger === -1 || lastDanger < firstWarn).toBe(true);
    expect(pmFeed.counts.total).toBe(pmFeed.items.length);
    expect(pmFeed.counts.danger).toBe(urgencies.filter((u) => u === "danger").length);
    expect(pmFeed.counts.warn).toBe(urgencies.filter((u) => u === "warn").length);
    const sumByType = Object.values(pmFeed.counts.byType).reduce((s, n) => s + n, 0);
    expect(sumByType).toBe(pmFeed.counts.total);
    void meetingId;
  });

  it("回款类 fin.read 两形态 + 工时填报闭环消失 + 只读不审计", async () => {
    // ⑥ 回款：finance（有 fin.read）有 receivable 条目（种子 AR-00001 逾期→danger）；member 无该类
    const financeFeed = await feed(financeCookie);
    expect(financeFeed.counts.byType.receivable).toBeGreaterThanOrEqual(1);
    const arItem = financeFeed.items.find((i) => i.type === "receivable")!;
    expect(arItem.icon).toBe("finance");
    expect(arItem.urgency).toBe("danger"); // 种子逾期应收
    expect(arItem.title).toContain("逾期");
    expect(arItem.link).toBe("/fin/receivables");
    expect(arItem.sourceLabel.length).toBeGreaterThan(0);

    const memberFeed = await feed(memberCookie);
    expect(memberFeed.counts.byType.receivable).toBe(0); // 无 fin.read → 该类不出现（两形态）

    // 工时闭环：pm 建本周周期→填报→提交→（自审问题：pm 是 A 项目负责人，工时审批人=pm 本人 → SELF_APPROVAL 拦）
    // 改用 member 周期（审批人=pm）：member 填报后条目应消失
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: {} });
    const periodId = (mp.json as { result: { data: { period: { id: string; periodStart: string } } } }).result.data.period.id;
    const weekStart = (mp.json as { result: { data: { period: { periodStart: string } } } }).result.data.period.periodStart;
    const before = await feed(memberCookie);
    expect(before.counts.byType.timesheet).toBe(1);
    await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: { periodId, idempotencyKey: crypto.randomUUID(), entries: [{ projectId: projectAId, activityType: "professional_work", workDate: weekStart, durationMinutes: 240, description: "15-02 工时" }] },
    });
    const sub = await trpc(app, "time.submit", { cookie: memberCookie, input: { periodId, idempotencyKey: crypto.randomUUID() } });
    expect(sub.status).toBe(200);
    const instId = (sub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: instId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() } });
    const after = await feed(memberCookie);
    expect(after.counts.byType.timesheet).toBe(0); // 已提交并批准 → 提醒消失

    // 只读不审计：feed 调用不产生 audit_events
    const pg = await import("pg");
    const client = new pg.default.Client({ connectionString: "postgres://lexflow:lexflow_dev@localhost:15432/lexflow_test" });
    await client.connect();
    try {
      const audit = await client.query(`SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'ai.assistant%'`);
      expect(audit.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});
