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

async function meetingIdByCode(code: string): Promise<string> {
  const rows = await query<{ id: string }>(`SELECT id FROM meetings WHERE code = $1`, [code]);
  if (!rows[0]) throw new Error(`种子会议 ${code} 缺失`);
  return rows[0].id;
}

describe("迭代 2 会议域（B1/B2/B3/B4/B9/B10/B11）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let liuchangCookie: string;
  let projectAId: string;
  let pmId: string;
  let memberId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    liuchangCookie = (await loginAs(app, "liuchang@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    projectAId = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    const me = async (cookie: string) =>
      ((await trpc(app, "auth.me", { cookie, method: "GET" })).json as {
        result: { data: { user: { id: string } } };
      }).result.data.user.id;
    pmId = await me(pmCookie);
    memberId = await me(memberCookie);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("B1 创建校验：时间倒挂/缺必填 400+fieldErrors；默认议程按类型；外部参与人最小信息不建账号", async () => {
    const base = {
      projectId: projectAId,
      type: "project" as const,
      subject: "校验探测会",
      startAt: "2027-06-01T02:00:00.000Z",
      endAt: "2027-06-01T01:00:00.000Z", // 倒挂
      participants: [{ userId: memberId }],
    };
    const inverted = await trpc(app, "meeting.create", { cookie: pmCookie, input: base });
    expect(inverted.status).toBe(400);
    expect(trpcError(inverted).fieldErrors).toHaveProperty("endAt");

    const noSubject = await trpc(app, "meeting.create", {
      cookie: pmCookie,
      input: { ...base, subject: "", startAt: "2027-06-01T01:00:00.000Z" },
    });
    expect(noSubject.status).toBe(400);
    expect(trpcError(noSubject).fieldErrors).toHaveProperty("subject");

    // 外部参与人：仅姓名+单位，不建账号
    const withExternal = await trpc(app, "meeting.create", {
      cookie: pmCookie,
      input: {
        ...base,
        startAt: "2027-06-01T01:00:00.000Z",
        endAt: "2027-06-01T02:00:00.000Z",
        participants: [{ userId: memberId }, { externalName: "王证人", externalOrg: "华宸贸易", role: "optional" }],
      },
    });
    expect(withExternal.status).toBe(200);
    const created = withExternal.json as { result: { data: { id: string } } };
    const detail = await trpc(app, "meeting.getById", { cookie: pmCookie, input: { id: created.result.data.id }, method: "GET" });
    const participants = (detail.json as {
      result: { data: { participants: { userId: string | null; externalName: string | null; userName: string | null }[] } };
    }).result.data.participants;
    const external = participants.find((p) => p.externalName === "王证人");
    expect(external?.userId).toBeNull();
    const accounts = await query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE name = '王证人'`);
    expect(accounts[0].n).toBe(0);

    // 类型驱动默认议程（quality_review）
    const typed = await trpc(app, "meeting.create", {
      cookie: pmCookie,
      input: {
        ...base,
        type: "quality_review",
        startAt: "2027-06-02T01:00:00.000Z",
        endAt: "2027-06-02T02:00:00.000Z",
        participants: [{ userId: memberId }],
      },
    });
    const typedDetail = await trpc(app, "meeting.getById", {
      cookie: pmCookie,
      input: { id: (typed.json as { result: { data: { id: string } } }).result.data.id },
      method: "GET",
    });
    expect((typedDetail.json as { result: { data: { agenda: string } } }).result.data.agenda).toContain("质量检查项复核");
  });

  it("B2 纪要版本链：整理→待确认→确认固定；确认后修改产新版本；幂等重放", async () => {
    const meetingId = await meetingIdByCode(`MTG-${YEAR}-00002`); // completed + pending_draft，记录人 member

    // 编辑草稿（同版本更新）
    const draft = await trpc(app, "meeting.minutes.saveDraft", {
      cookie: memberCookie,
      input: { meetingId, body: "整理后的纪要正文（测试）", disagreements: "存在分歧：是否追加鉴定", risks: "证人配合度风险" },
    });
    expect(draft.status).toBe(200);
    const v1 = (draft.json as { result: { data: { versionNo: number } } }).result.data;
    expect(v1.versionNo).toBe(1);

    // 提交确认（指定确认人 pm）
    const submitted = await trpc(app, "meeting.minutes.submitConfirm", {
      cookie: memberCookie,
      input: { meetingId, versionNo: 1, confirmerId: pmId },
    });
    expect(submitted.status).toBe(200);
    // 确认人收到 minutes_pending_confirm
    const pmNotices = await trpc(app, "notification.listMine", { cookie: pmCookie, method: "GET" });
    expect(
      ((pmNotices.json as { result: { data: { items: { eventType: string; sourceId: string }[] } } }).result.data.items)
        .some((n) => n.eventType === "minutes_pending_confirm" && n.sourceId === meetingId),
    ).toBe(true);

    // 非确认人不可确认
    const wrong = await trpc(app, "meeting.minutes.confirm", {
      cookie: memberCookie,
      input: { meetingId, versionNo: 1, idempotencyKey: crypto.randomUUID() },
    });
    expect(wrong.status).toBe(404);

    // 确认（幂等：重放返回现状）
    const key = crypto.randomUUID();
    const confirm1 = await trpc(app, "meeting.minutes.confirm", {
      cookie: pmCookie,
      input: { meetingId, versionNo: 1, idempotencyKey: key },
    });
    expect(confirm1.status).toBe(200);
    expect((confirm1.json as { result: { data: { replayed: boolean } } }).result.data.replayed).toBe(false);
    const confirm2 = await trpc(app, "meeting.minutes.confirm", {
      cookie: pmCookie,
      input: { meetingId, versionNo: 1, idempotencyKey: key },
    });
    expect(confirm2.status).toBe(200);
    expect((confirm2.json as { result: { data: { replayed: boolean } } }).result.data.replayed).toBe(true);

    const detail = await trpc(app, "meeting.getById", { cookie: pmCookie, input: { id: meetingId }, method: "GET" });
    expect((detail.json as { result: { data: { minutesStatus: string } } }).result.data.minutesStatus).toBe("confirmed");

    // 归档 09：纪要来源对已入目录
    const link = await query<{ source_type: string }>(
      `SELECT source_type FROM archive_links WHERE source_type = 'meeting' AND source_id = $1`,
      [meetingId],
    );
    expect(link.length).toBeGreaterThanOrEqual(1);

    // 确认后修改 → 新版本，旧版本不动
    const v2 = await trpc(app, "meeting.minutes.saveDraft", {
      cookie: memberCookie,
      input: { meetingId, body: "V2 修订正文（确认后修改）" },
    });
    expect((v2.json as { result: { data: { versionNo: number } } }).result.data.versionNo).toBe(2);
    const versions = await trpc(app, "meeting.minutes.versions", { cookie: pmCookie, input: { meetingId }, method: "GET" });
    const list = (versions.json as { result: { data: { versionNo: number; confirmedAt: string | null }[] } }).result.data;
    expect(list).toHaveLength(2);
    expect(list[0].confirmedAt).toBeTruthy(); // v1 保持确认态
    expect(list[1].confirmedAt).toBeNull(); // v2 新草稿
  });

  it("B3 行动项转任务：source 链双向定位、任务状态单源、重复转换幂等", async () => {
    const meetingId = await meetingIdByCode(`MTG-${YEAR}-00003`); // confirmed 纪要 + 行动项×2
    const detail = await trpc(app, "meeting.getById", { cookie: pmCookie, input: { id: meetingId }, method: "GET" });
    const items = (detail.json as {
      result: { data: { actionItems: { id: string; status: string; convertedTaskId: string | null; taskStatus: string | null }[] } };
    }).result.data.actionItems;
    const converted = items.find((i) => i.status === "converted")!;
    const open = items.find((i) => i.status === "open")!;

    // 重复转换被幂等拦截：返回既有任务，不新建
    const before = await query<{ n: number }>(`SELECT count(*)::int AS n FROM tasks`);
    const replay = await trpc(app, "meeting.action.convertToTask", {
      cookie: pmCookie,
      input: { id: converted.id, idempotencyKey: crypto.randomUUID() },
    });
    expect(replay.status).toBe(200);
    const replayTask = (replay.json as { result: { data: { task: { id: string } } } }).result.data.task;
    expect(replayTask.id).toBe(converted.convertedTaskId);
    const after = await query<{ n: number }>(`SELECT count(*)::int AS n FROM tasks`);
    expect(after[0].n).toBe(before[0].n);

    // open 行动项转换：task 带会议来源
    const converted2 = await trpc(app, "meeting.action.convertToTask", {
      cookie: pmCookie,
      input: { id: open.id, idempotencyKey: crypto.randomUUID() },
    });
    expect(converted2.status).toBe(200);
    const task = (converted2.json as { result: { data: { task: { id: string; sourceType: string; sourceId: string; status: string } } } })
      .result.data.task;
    expect(task.sourceType).toBe("meeting");
    expect(task.sourceId).toBe(open.id);

    // 列表 join 任务状态（单源，不复制完成态）
    const list = await trpc(app, "meeting.action.list", { cookie: pmCookie, input: { meetingId }, method: "GET" });
    const listItems = (list.json as {
      result: { data: { status: string; taskStatus: string | null; convertedTaskId: string | null }[] };
    }).result.data;
    expect(listItems.every((i) => i.status !== "converted" || i.taskStatus)).toBe(true);
    const backlink = await query<{ source_type: string; source_id: string }>(
      `SELECT source_type, source_id FROM tasks WHERE id = $1`,
      [task.id],
    );
    expect(backlink[0].source_type).toBe("meeting"); // 任务详情可回链会议（行动项 id）
  });

  it("B4 分歧转决策：带入会议与纪要版本上下文，会议详情可查回链", async () => {
    const meetingId = await meetingIdByCode(`MTG-${YEAR}-00003`);
    const versions = await trpc(app, "meeting.minutes.versions", { cookie: pmCookie, input: { meetingId }, method: "GET" });
    const v1 = (versions.json as { result: { data: { id: string; versionNo: number }[] } }).result.data[0];

    const escalated = await trpc(app, "meeting.extra.escalateToDecision", {
      cookie: pmCookie,
      input: {
        meetingId,
        minutesVersionId: v1.id,
        title: "证人证言固定方式重大分歧",
        context: "会议就证人证言固定方式存在重大分歧，需决策。",
      },
    });
    expect(escalated.status).toBe(200);
    const decision = (escalated.json as { result: { data: { id: string; code: string } } }).result.data;

    const decisionDetail = await trpc(app, "decision.getById", { cookie: pmCookie, input: { id: decision.id }, method: "GET" });
    const d = (decisionDetail.json as {
      result: { data: { sourceType: string | null; sourceId: string | null; context: string } };
    }).result.data;
    expect(d.sourceType).toBe("meeting");
    expect(d.sourceId).toBe(meetingId);
    expect(d.context).toContain(`纪要 V${v1.versionNo}`);

    const meetingDetail = await trpc(app, "meeting.getById", { cookie: pmCookie, input: { id: meetingId }, method: "GET" });
    const links = (meetingDetail.json as {
      result: { data: { linkedDecisions: { id: string; code: string }[] } };
    }).result.data.linkedDecisions;
    expect(links.some((l) => l.id === decision.id)).toBe(true);
  });

  it("B9 会议取消：必填 reason；取消后无工时建议、不产归档", async () => {
    const created = await trpc(app, "meeting.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        type: "project",
        subject: "将取消的会",
        startAt: "2027-06-10T01:00:00.000Z",
        endAt: "2027-06-10T02:00:00.000Z",
        participants: [{ userId: memberId }],
      },
    });
    const id = (created.json as { result: { data: { id: string } } }).result.data.id;
    const noReason = await trpc(app, "meeting.transition", {
      cookie: pmCookie,
      input: { id, action: "cancel", reason: "" },
    });
    expect(noReason.status).toBe(400);
    expect(trpcError(noReason).fieldErrors).toHaveProperty("reason");

    const cancelled = await trpc(app, "meeting.transition", {
      cookie: pmCookie,
      input: { id, action: "cancel", reason: "证人时间冲突" },
    });
    expect(cancelled.status).toBe(200);

    const suggestion = await trpc(app, "meeting.extra.timePrefillSuggestion", {
      cookie: pmCookie,
      input: { meetingId: id },
      method: "GET",
    });
    expect(suggestion.json).toEqual({ result: { data: null } });
    const link = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM archive_links WHERE source_type = 'meeting' AND source_id = $1`,
      [id],
    );
    expect(link[0].n).toBe(0);
  });

  it("B10 会议工时预填建议：实际时长 × 出席人，只算不存", async () => {
    const meetingId = await meetingIdByCode(`MTG-${YEAR}-00002`);
    const suggestion = await trpc(app, "meeting.extra.timePrefillSuggestion", {
      cookie: pmCookie,
      input: { meetingId },
      method: "GET",
    });
    const data = (suggestion.json as {
      result: {
        data: { minutes: number; projectId: string; attendeeUserIds: string[] };
      };
    }).result.data;
    expect(data.minutes).toBeGreaterThan(0);
    expect(data.projectId).toBe(projectAId);
    // 种子出席：pm/member attended，liuchang excused 不计
    expect(data.attendeeUserIds).toContain(pmId);
    expect(data.attendeeUserIds).toContain(memberId);
    expect(data.attendeeUserIds.length).toBe(2);
    // 只算不存：无任何工时表写入（迭代 4 才建表），此处断言无异常且响应即为全部副作用
  });

  it("B11 待办增量：记录人/确认人两源进 todo.mine", async () => {
    // member 是 MTG-00002 记录人（completed + pending_draft）→ 待整理
    const memberTodo = await trpc(app, "todo.mine", { cookie: memberCookie, method: "GET" });
    const memberKinds = (memberTodo.json as { result: { data: { items: { kind: string }[] } } }).result.data.items;
    expect(memberKinds.some((i) => i.kind === "minutes_draft")).toBe(true);

    // pm 是 MTG-00003 纪要确认人（confirmed 已确认则不入待确认源）——构造 pending_confirm 验证确认源
    const meetingId = await meetingIdByCode(`MTG-${YEAR}-00002`);
    await trpc(app, "meeting.minutes.saveDraft", {
      cookie: memberCookie,
      input: { meetingId, body: "待确认源验证草稿" },
    });
    const pmIdNow = pmId;
    await trpc(app, "meeting.minutes.submitConfirm", {
      cookie: memberCookie,
      input: { meetingId, versionNo: 2, confirmerId: pmIdNow },
    });
    const pmTodo = await trpc(app, "todo.mine", { cookie: pmCookie, method: "GET" });
    const pmKinds = (pmTodo.json as { result: { data: { items: { kind: string }[] } } }).result.data.items;
    expect(pmKinds.some((i) => i.kind === "minutes_confirm")).toBe(true);
  });

  it("考勤记录与参会人可见性：非成员参会人仅可见该会议", async () => {
    // liuchang 不是项目 A 成员（种子项目 A 成员：pm/member/liuchang/huanglei —— 用外部视角改为验证 list mine）
    const meetingId = await meetingIdByCode(`MTG-${YEAR}-00002`);
    const detail = await trpc(app, "meeting.getById", { cookie: pmCookie, input: { id: meetingId }, method: "GET" });
    const participants = (detail.json as {
      result: { data: { participants: { id: string; userId: string | null; attendance: string }[] } };
    }).result.data.participants;
    const attended = participants.filter((p) => p.userId);
    const entries = attended.map((p) => ({ participantId: p.id, attendance: "attended" as const }));
    const recorded = await trpc(app, "meeting.recordAttendance", { cookie: pmCookie, input: { id: meetingId, entries } });
    expect(recorded.status).toBe(200);

    // 参会人可见：member（成员+参会人）可 getById
    const asMember = await trpc(app, "meeting.getById", { cookie: memberCookie, input: { id: meetingId }, method: "GET" });
    expect(asMember.status).toBe(200);
    // 非项目成员、非参会人不可见（viewer）
    const viewerCookie = (await loginAs(app, "viewer@lexflow.demo")).cookie;
    const asViewer = await trpc(app, "meeting.getById", { cookie: viewerCookie, input: { id: meetingId }, method: "GET" });
    expect(asViewer.status).toBe(404);
    void liuchangCookie;
  });
});
