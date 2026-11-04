import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 8 · 工单 06（arch/03 §2.2 v1.1）：partner 全局只读可见——
 * project.read / archive.read（文件下载预览）/ 列表 SQL 级 scope 对 partner 全项目放行；
 * 边界：project.manage 仍项目内 manager；写路径经 requireProjectMember 守成员门（看得到 ≠ 管得了）。
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

describe("迭代8-06：partner 全局只读可见 + 写边界不变", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let partnerCookie: string; // 梁奇烽（liangqifeng）
  let memberCookie: string; // 管晨（guanchen，项目 A 成员）
  let viewerCookie: string; // 何静（hejing）
  let managerCookie: string; // 王宝茁（wangbaozhuo）
  let projectAId: string;
  let projectCId: string; // 佳力奇（partner/member 均非成员）
  let managerUserId: string; // 王宝茁
  let memberUserId: string; // 管晨

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    viewerCookie = (await loginAs(app, "hejing@lexflow.demo")).cookie;
    managerCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: managerCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    const c = await query<{ id: string }>(`SELECT id FROM projects WHERE code=$1`, [`PRJ-${YEAR}-00003`]);
    projectCId = c[0].id;
    const users = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email IN ('wangbaozhuo@lexflow.demo','guanchen@lexflow.demo')`,
    );
    managerUserId = users.find((u) => u.email === "wangbaozhuo@lexflow.demo")!.id;
    memberUserId = users.find((u) => u.email === "guanchen@lexflow.demo")!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("partner 项目列表全量可见（5 项目）；viewer 不扩散（0 项目）", async () => {
    const partnerList = await trpc(app, "project.list", { cookie: partnerCookie, method: "GET" });
    expect(partnerList.status).toBe(200);
    const items = (partnerList.json as { result: { data: { items: { code: string }[] } } }).result.data.items;
    expect(items.map((i) => i.code).sort()).toEqual(
      [`PRJ-${YEAR}-00001`, `PRJ-${YEAR}-00002`, `PRJ-${YEAR}-00003`, `PRJ-${YEAR}-00004`, `PRJ-${YEAR}-00005`].sort(),
    );
    const viewerList = await trpc(app, "project.list", { cookie: viewerCookie, method: "GET" });
    expect((viewerList.json as { result: { data: { items: unknown[] } } }).result.data.items).toHaveLength(0);
  });

  it("partner 非成员项目详情 200（佳力奇 C）；member 越权仍同形 404；member 自身可见集不变（1 项目）", async () => {
    const partnerDetail = await trpc(app, "project.getById", { cookie: partnerCookie, input: { id: projectCId }, method: "GET" });
    expect(partnerDetail.status).toBe(200);
    const memberDetail = await trpc(app, "project.getById", { cookie: memberCookie, input: { id: projectCId }, method: "GET" });
    expect(memberDetail.status).toBe(404);
    const memberList = await trpc(app, "project.list", { cookie: memberCookie, method: "GET" });
    const items = (memberList.json as { result: { data: { items: { code: string }[] } } }).result.data.items;
    expect(items).toHaveLength(1);
    expect(items[0].code).toBe(`PRJ-${YEAR}-00001`);
  });

  it("partner 下载非成员项目文件放行；member/viewer 下载同形 404", async () => {
    // 向佳力奇（C）上传一个项目文件（上传路由无成员门，既有行为）
    const form = new FormData();
    form.append("sourceType", "project");
    form.append("sourceId", projectCId);
    form.append("file", new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer as ArrayBuffer], { type: "application/pdf" }), "partner可见性.pdf");
    const up = await app.request("http://test/files/upload", { method: "POST", headers: { cookie: managerCookie }, body: form });
    expect(up.status).toBe(200);
    const saved = (await up.json()) as { fileVersionId: string };
    const dl = (cookie: string) =>
      app.request(`http://test/files/${saved.fileVersionId}/download`, { method: "GET", headers: { cookie } });
    expect((await dl(partnerCookie)).status).toBe(200);
    expect((await dl(memberCookie)).status).toBe(404);
    expect((await dl(viewerCookie)).status).toBe(404);
  });

  it("写边界：partner 看得到 ≠ 管得了——非成员项目建任务/出差/管理/成员变更一律 404", async () => {
    const task = await trpc(app, "task.create", {
      cookie: partnerCookie,
      input: { projectId: projectCId, title: "partner 越权建任务", plannedStart: "2027-01-01", plannedEnd: "2027-01-02" },
    });
    expect(task.status).toBe(404);
    const travel = await trpc(app, "travel.create", {
      cookie: partnerCookie,
      input: {
        projectId: projectCId, reason: "partner 越权出差", destination: "上海",
        startOn: "2027-12-10", endOn: "2027-12-11",
        segments: [{ seq: 1, type: "transport", startAt: "2027-12-10T01:00:00.000Z", endAt: "2027-12-10T03:00:00.000Z" }],
      },
    });
    expect(travel.status).toBe(404);
    const update = await trpc(app, "project.update", {
      cookie: partnerCookie,
      input: { id: projectCId, rowVersion: 0, name: "partner 越权改名" },
    });
    expect(update.status).toBe(404); // project.manage 仍项目内 manager
    const addMember = await trpc(app, "project.addMember", {
      cookie: partnerCookie,
      input: { projectId: projectCId, userId: crypto.randomUUID(), projectRole: "member" },
    });
    expect(addMember.status).toBe(404);
  });

  it("写边界（06 打回扩展）：loader 类写路径逐类 404——任务改/转/派、会议改/转/签到、决策改/意见/决定/核验、质量改/派/处理/复核/重开/checkItem、非成员报销建单；member 写通对照", async () => {
    // ---- 造数（项目 A：王宝茁=manager 建实体，管晨=member 对照写通）----
    const task = await trpc(app, "task.create", {
      cookie: managerCookie,
      input: { projectId: projectAId, title: "06打回任务", plannedStart: "2027-01-01", plannedEnd: "2027-01-05" },
    });
    expect(task.status).toBe(200);
    const taskId = (task.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;

    const meeting = await trpc(app, "meeting.create", {
      cookie: managerCookie,
      input: {
        projectId: projectAId, type: "project", subject: "06打回会议",
        startAt: "2027-02-01T02:00:00.000Z", endAt: "2027-02-01T03:00:00.000Z",
        participants: [{ userId: memberUserId }],
      },
    });
    expect(meeting.status).toBe(200);
    const meetingId = (meeting.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;
    const meetingRow = await query<{ participant_id: string }>(
      `SELECT id AS participant_id FROM meeting_participants WHERE meeting_id=$1 LIMIT 1`,
      [meetingId],
    );

    const decision = await trpc(app, "decision.create", {
      cookie: managerCookie,
      input: {
        projectId: projectAId, title: "06打回决策", context: "背景",
        options: [
          { key: "a", summary: "方案甲", impact: "", risk: "" },
          { key: "b", summary: "方案乙", impact: "", risk: "" },
        ],
      },
    });
    expect(decision.status).toBe(200);
    const decisionId = (decision.json as { result: { data: { id: string } } }).result.data.id;

    const issue = await trpc(app, "quality.create", {
      cookie: managerCookie,
      input: { projectId: projectAId, title: "06打回质量问题", description: "描述", severity: "minor" },
    });
    expect(issue.status).toBe(200);
    const issueId = (issue.json as { result: { data: { id: string } } }).result.data.id;

    const checklist = await trpc(app, "quality.checklist", { cookie: managerCookie, method: "GET", input: { projectId: projectAId } });
    const checkItemId = ((checklist.json as { result: { data: Array<{ id: string }> } }).result.data[0]?.id ?? "");
    expect(checkItemId).toBeTruthy();

    // ---- partner（非成员）：每类写路径一律 404（可见≠可写）----
    const p404: Array<Promise<{ status: number }>> = [
      // 任务 改/转/派
      trpc(app, "task.update", { cookie: partnerCookie, input: { id: taskId, rowVersion: 0, title: "partner 改任务" } }),
      trpc(app, "task.transition", { cookie: partnerCookie, input: { id: taskId, action: "start", rowVersion: 0 } }),
      trpc(app, "task.assign", { cookie: partnerCookie, input: { id: taskId, assigneeId: memberUserId } }),
      // 会议 改/转/签到
      trpc(app, "meeting.update", { cookie: partnerCookie, input: { id: meetingId, rowVersion: 0, subject: "partner 改会议" } }),
      trpc(app, "meeting.transition", { cookie: partnerCookie, input: { id: meetingId, action: "cancel", reason: "partner 越权" } }),
      trpc(app, "meeting.recordAttendance", { cookie: partnerCookie, input: { id: meetingId, entries: [{ participantId: meetingRow[0].participant_id, attendance: "attended" }] } }),
      // 决策 改/意见/决定/核验
      trpc(app, "decision.update", { cookie: partnerCookie, input: { id: decisionId, rowVersion: 0, title: "partner 改决策" } }),
      trpc(app, "decision.submitOpinions", { cookie: partnerCookie, input: { id: decisionId, pmOpinion: "partner 意见" } }),
      trpc(app, "decision.decide", {
        cookie: partnerCookie,
        input: { id: decisionId, finalOption: "a", finalReason: "partner 决定", conditions: "无", checkpoints: [{ point: "检查点", date: "2027-03-01", owner_id: memberUserId }], rowVersion: 0 },
      }),
      trpc(app, "decision.verify", { cookie: partnerCookie, input: { id: decisionId, note: "partner 核验" } }),
      // 质量 改/派/处理/复核/重开/checkItem
      trpc(app, "quality.update", { cookie: partnerCookie, input: { id: issueId, rowVersion: 0, title: "partner 改问题" } }),
      trpc(app, "quality.assign", { cookie: partnerCookie, input: { id: issueId, handlerId: memberUserId, reviewerId: managerUserId } }),
      trpc(app, "quality.submitHandling", { cookie: partnerCookie, input: { id: issueId, note: "partner 处理" } }),
      trpc(app, "quality.review", { cookie: partnerCookie, input: { id: issueId, action: "pass" } }),
      trpc(app, "quality.reopen", { cookie: partnerCookie, input: { id: issueId, note: "partner 重开" } }),
      trpc(app, "quality.checkItem", { cookie: partnerCookie, input: { id: checkItemId, status: "passed" } }),
      // 非成员项目报销建单（insertItems 逐项门）
      trpc(app, "expense.create", {
        cookie: partnerCookie,
        input: {
          reason: "partner 越权报销",
          items: [{ projectId: projectAId, date: "2027-01-02", category: "transport", amountCents: 100, description: "越权明细" }],
        },
      }),
    ];
    const denied = await Promise.all(p404);
    for (let i = 0; i < denied.length; i++) {
      expect(denied[i].status, `partner 写路径 #${i + 1} 应 404`).toBe(404);
    }

    // ---- member 写通对照（管晨=项目 A 成员）----
    expect((await trpc(app, "task.update", { cookie: memberCookie, input: { id: taskId, rowVersion: 0, title: "member 改任务" } })).status).toBe(200);
    expect((await trpc(app, "meeting.update", { cookie: memberCookie, input: { id: meetingId, rowVersion: 0, subject: "member 改会议" } })).status).toBe(200);
    expect((await trpc(app, "decision.update", { cookie: memberCookie, input: { id: decisionId, rowVersion: 0, title: "member 改决策" } })).status).toBe(200);
    expect((await trpc(app, "quality.update", { cookie: memberCookie, input: { id: issueId, rowVersion: 0, title: "member 改问题" } })).status).toBe(200);
    expect((await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "member 正常报销",
        items: [{ projectId: projectAId, date: "2027-01-03", category: "materials", amountCents: 200, description: "正常明细" }],
      },
    })).status).toBe(200);
  });
});
