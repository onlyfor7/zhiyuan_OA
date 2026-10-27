import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 2 验收套件·会议域（arch/05 §8）：B1 创建校验 / B2 纪要版本链 / B3 行动项转任务 /
 * B4 分歧转决策 / B5 归档 09 / B9 取消规则 / B10 工时建议（只算不存）/ B11 待办两源 /
 * 权限边界（非参会非成员同形 404）。与后端 collab-meeting 自测互补的独立验收链。
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

describe("迭代 2 验收·会议域（arch/05 §8 B1–B5/B9–B11 + 权限边界）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let viewerCookie: string;
  let projectAId: string;
  let pmId: string;
  let memberId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    viewerCookie = (await loginAs(app, "viewer@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    projectAId = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    pmId = await meId(app, pmCookie);
    memberId = await meId(app, memberCookie);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("B1+B9 创建校验与取消规则：时间倒挂/缺必填 400+fieldErrors；外部参与人不建账号；取消无建议无归档", async () => {
    const base = {
      projectId: projectAId,
      type: "project" as const,
      subject: "验收校验会",
      startAt: "2027-08-01T02:00:00.000Z",
      endAt: "2027-08-01T01:00:00.000Z",
      participants: [{ userId: memberId }],
    };
    const inverted = await trpc(app, "meeting.create", { cookie: pmCookie, input: base });
    expect(inverted.status).toBe(400);
    expect(trpcError(inverted).fieldErrors).toHaveProperty("endAt");
    const noSubject = await trpc(app, "meeting.create", {
      cookie: pmCookie,
      input: { ...base, subject: "", startAt: "2027-08-01T01:00:00.000Z" },
    });
    expect(noSubject.status).toBe(400);
    expect(trpcError(noSubject).fieldErrors).toHaveProperty("subject");

    // 外部参与人仅最小信息，不建账号
    const created = await trpc(app, "meeting.create", {
      cookie: pmCookie,
      input: {
        ...base,
        startAt: "2027-08-01T01:00:00.000Z",
        endAt: "2027-08-01T02:30:00.000Z",
        participants: [{ userId: memberId }, { externalName: "外部证人甲", externalOrg: "某机构" }],
      },
    });
    expect(created.status).toBe(200);
    const meetingId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const detail = await trpc(app, "meeting.getById", { cookie: pmCookie, input: { id: meetingId }, method: "GET" });
    const participants = (detail.json as {
      result: { data: { participants: { userId: string | null; externalName: string | null }[] } };
    }).result.data.participants;
    expect(participants.find((p) => p.externalName === "外部证人甲")?.userId).toBeNull();
    const accounts = await query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE name = '外部证人甲'`);
    expect(accounts[0].n).toBe(0);

    // 取消规则：planned → cancelled，原因必填；取消后无工时建议、不产归档
    const noReason = await trpc(app, "meeting.transition", {
      cookie: pmCookie,
      input: { id: meetingId, action: "cancel", reason: "" },
    });
    expect(noReason.status).toBe(400);
    expect(trpcError(noReason).fieldErrors).toHaveProperty("reason");
    const cancelled = await trpc(app, "meeting.transition", {
      cookie: pmCookie,
      input: { id: meetingId, action: "cancel", reason: "客户时间冲突，会议取消（验收）" },
    });
    expect(cancelled.status).toBe(200);
    const suggestion = await trpc(app, "meeting.extra.timePrefillSuggestion", {
      cookie: pmCookie,
      method: "GET",
      input: { meetingId },
    });
    expect((suggestion.json as { result: { data: unknown } }).result.data).toBeNull();
    const links = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM archive_links WHERE source_type = 'meeting' AND source_id = $1`,
      [meetingId],
    );
    expect(links[0].n).toBe(0);
  });

  it("B2+B5 纪要版本链与归档 09：整理→待确认→确认固定（幂等）→修改产 V2；自动归档 09 目录", async () => {
    // 自建会议走完链（不依赖种子态）
    const created = await trpc(app, "meeting.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        type: "weekly" as const,
        subject: "验收纪要链周会",
        startAt: "2027-08-03T01:00:00.000Z",
        endAt: "2027-08-03T02:00:00.000Z",
        participants: [{ userId: memberId }],
      },
    });
    const meetingId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const completed = await trpc(app, "meeting.transition", {
      cookie: pmCookie,
      input: { id: meetingId, action: "complete" },
    });
    expect(completed.status).toBe(200);

    const draft = await trpc(app, "meeting.minutes.saveDraft", {
      cookie: pmCookie,
      input: { meetingId, body: "验收纪要正文 V1", disagreements: "无重大分歧", risks: "无" },
    });
    expect((draft.json as { result: { data: { versionNo: number } } }).result.data.versionNo).toBe(1);

    const submitted = await trpc(app, "meeting.minutes.submitConfirm", {
      cookie: pmCookie,
      input: { meetingId, versionNo: 1, confirmerId: memberId },
    });
    expect(submitted.status).toBe(200);

    // 非确认人不可确认
    const wrong = await trpc(app, "meeting.minutes.confirm", {
      cookie: pmCookie,
      input: { meetingId, versionNo: 1, idempotencyKey: crypto.randomUUID() },
    });
    expect(wrong.status).toBe(404);

    const key = crypto.randomUUID();
    const confirm1 = await trpc(app, "meeting.minutes.confirm", {
      cookie: memberCookie,
      input: { meetingId, versionNo: 1, idempotencyKey: key },
    });
    expect(confirm1.status).toBe(200);
    expect((confirm1.json as { result: { data: { replayed: boolean } } }).result.data.replayed).toBe(false);
    const confirm2 = await trpc(app, "meeting.minutes.confirm", {
      cookie: memberCookie,
      input: { meetingId, versionNo: 1, idempotencyKey: key },
    });
    expect((confirm2.json as { result: { data: { replayed: boolean } } }).result.data.replayed).toBe(true);

    // B5：确认即归档 09 目录（来源对）
    const link = await query<{ dir_key: string }>(
      `SELECT d.dir_key FROM archive_links l JOIN archive_directories d ON d.id = l.directory_id
       WHERE l.source_type = 'meeting' AND l.source_id = $1`,
      [meetingId],
    );
    expect(link.some((l) => l.dir_key === "09_会议纪要与协同")).toBe(true);

    // 确认后修改 → V2，V1 固定不动
    const v2 = await trpc(app, "meeting.minutes.saveDraft", {
      cookie: pmCookie,
      input: { meetingId, body: "验收纪要正文 V2（确认后修订）" },
    });
    expect((v2.json as { result: { data: { versionNo: number } } }).result.data.versionNo).toBe(2);
    const versions = await trpc(app, "meeting.minutes.versions", {
      cookie: pmCookie,
      input: { meetingId },
      method: "GET",
    });
    const list = (versions.json as { result: { data: { versionNo: number; confirmedAt: string | null; body: string }[] } })
      .result.data;
    expect(list).toHaveLength(2);
    const v1 = list.find((v) => v.versionNo === 1)!;
    expect(v1.confirmedAt).toBeTruthy();
    expect(v1.body).toContain("V1");
  });

  it("B3 行动项转任务：source 链双向定位、状态单源、重复转换幂等拦截", async () => {
    const created = await trpc(app, "meeting.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        type: "project" as const,
        subject: "验收行动项会",
        startAt: "2027-08-05T01:00:00.000Z",
        endAt: "2027-08-05T02:00:00.000Z",
        participants: [{ userId: memberId }],
      },
    });
    const meetingId = (created.json as { result: { data: { id: string } } }).result.data.id;
    await trpc(app, "meeting.transition", { cookie: pmCookie, input: { id: meetingId, action: "complete" } });

    const added = await trpc(app, "meeting.action.addItem", {
      cookie: pmCookie,
      input: { meetingId, title: "补充证据清单核对", ownerId: memberId, dueDate: "2027-08-12", deliverable: "核对表" },
    });
    expect(added.status).toBe(200);
    const itemId = (added.json as { result: { data: { id: string } } }).result.data.id;

    const before = await query<{ n: number }>(`SELECT count(*)::int AS n FROM tasks`);
    const converted = await trpc(app, "meeting.action.convertToTask", {
      cookie: memberCookie,
      input: { id: itemId, idempotencyKey: crypto.randomUUID() },
    });
    expect(converted.status).toBe(200);
    const task = (converted.json as { result: { data: { task: { id: string; sourceType: string; sourceId: string } } } })
      .result.data.task;
    expect(task.sourceType).toBe("meeting");
    expect(task.sourceId).toBe(itemId);

    // 重复转换幂等：返回同一任务，不新建
    const replay = await trpc(app, "meeting.action.convertToTask", {
      cookie: memberCookie,
      input: { id: itemId, idempotencyKey: crypto.randomUUID() },
    });
    expect((replay.json as { result: { data: { task: { id: string } } } }).result.data.task.id).toBe(task.id);
    const after = await query<{ n: number }>(`SELECT count(*)::int AS n FROM tasks`);
    expect(after[0].n).toBe(before[0].n + 1);

    // 列表 join 任务状态（单源）
    const list = await trpc(app, "meeting.action.list", { cookie: pmCookie, input: { meetingId }, method: "GET" });
    const items = (list.json as { result: { data: { status: string; taskStatus: string | null }[] } }).result.data;
    expect(items.every((i) => i.status !== "converted" || i.taskStatus !== null)).toBe(true);
  });

  it("B4 分歧转决策：带入会议+纪要版本上下文，会议详情回链可查", async () => {
    const rows = await query<{ id: string }>(`SELECT id FROM meetings WHERE code = $1`, [`MTG-${YEAR}-00003`]);
    const meetingId = rows[0].id;
    const versions = await trpc(app, "meeting.minutes.versions", {
      cookie: pmCookie,
      input: { meetingId },
      method: "GET",
    });
    const v1 = (versions.json as { result: { data: { id: string; versionNo: number }[] } }).result.data[0];

    const escalated = await trpc(app, "meeting.extra.escalateToDecision", {
      cookie: pmCookie,
      input: {
        meetingId,
        minutesVersionId: v1.id,
        title: "验收：证言固定方式分歧",
        context: "会议分歧转决策（验收）",
      },
    });
    expect(escalated.status).toBe(200);
    const decision = (escalated.json as { result: { data: { id: string } } }).result.data;
    const detail = await trpc(app, "meeting.getById", { cookie: pmCookie, input: { id: meetingId }, method: "GET" });
    const linked = (detail.json as {
      result: { data: { linkedDecisions: { id: string; code: string }[] } };
    }).result.data.linkedDecisions;
    expect(linked.some((d) => d.id === decision.id)).toBe(true); // 回链可查
    const decisionRow = await query<{ source_type: string; source_id: string }>(
      `SELECT source_type, source_id FROM decisions WHERE id = $1`,
      [decision.id],
    );
    expect(decisionRow[0].source_type).toBe("meeting");
    expect(decisionRow[0].source_id).toBe(meetingId);
  });

  it("B10 会议工时预填建议：实际时长 × 出席人，只算不存（取消会议返回 null）", async () => {
    // 种子 MTG-00002：completed，种子出席 pm/member attended、liuchang excused 不计
    const rows = await query<{ id: string }>(`SELECT id FROM meetings WHERE code = $1`, [`MTG-${YEAR}-00002`]);
    const meetingId = rows[0].id;
    const suggestion = await trpc(app, "meeting.extra.timePrefillSuggestion", {
      cookie: pmCookie,
      method: "GET",
      input: { meetingId },
    });
    const data = (suggestion.json as {
      result: { data: { minutes: number; projectId: string; attendeeUserIds: string[] } };
    }).result.data;
    expect(data.minutes).toBeGreaterThan(0);
    expect(data.projectId).toBe(projectAId);
    expect(data.attendeeUserIds).toContain(pmId);
    expect(data.attendeeUserIds).toContain(memberId);
    expect(data.attendeeUserIds).toHaveLength(2); // liuchang excused 不计
    // 只算不存：无任何持久化（响应即全部输出，DB 无工时表/行）
    const leaked = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'meeting' AND source_id = $1`,
      [meetingId],
    );
    expect(leaked[0].n).toBe(0);
  });

  it("B11 纪要待办两源：记录人 minutes_draft / 确认人 minutes_confirm 进 todo.mine", async () => {
    // 种子 MTG-00002：记录人=member，completed 且纪要 pending_draft → member 待办含 minutes_draft
    const rows = await query<{ id: string }>(`SELECT id FROM meetings WHERE code = $1`, [`MTG-${YEAR}-00002`]);
    const meetingId = rows[0].id;
    const memberTodo = await trpc(app, "todo.mine", { cookie: memberCookie, method: "GET" });
    const memberItems = (memberTodo.json as { result: { data: { items: { kind: string }[] } } })
      .result.data.items;
    expect(memberItems.some((i) => i.kind === "minutes_draft")).toBe(true);

    // 提交确认（确认人=pm，v1 编辑态直接提交）→ pm 待办含 minutes_confirm
    await trpc(app, "meeting.minutes.saveDraft", {
      cookie: memberCookie,
      input: { meetingId, body: "待办两源验收草稿" },
    });
    await trpc(app, "meeting.minutes.submitConfirm", {
      cookie: memberCookie,
      input: { meetingId, versionNo: 1, confirmerId: pmId },
    });
    const pmTodo = await trpc(app, "todo.mine", { cookie: pmCookie, method: "GET" });
    const pmItems = (pmTodo.json as { result: { data: { items: { kind: string }[] } } })
      .result.data.items;
    expect(pmItems.some((i) => i.kind === "minutes_confirm")).toBe(true);
  });

  it("权限边界：非参会非成员访问会议详情 → 与随机 uuid 同形 404（无存在性泄露）", async () => {
    const rows = await query<{ id: string }>(`SELECT id FROM meetings WHERE code = $1`, [`MTG-${YEAR}-00001`]);
    const meetingId = rows[0].id;
    const denied = await trpc(app, "meeting.getById", { cookie: viewerCookie, input: { id: meetingId }, method: "GET" });
    const ghost = await trpc(app, "meeting.getById", {
      cookie: viewerCookie,
      input: { id: "00000000-0000-0000-0000-000000000000" },
      method: "GET",
    });
    expect(denied.status).toBe(404);
    expect(ghost.status).toBe(404);
    const strip = (json: Record<string, unknown>) => {
      const clone = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
      const data = (clone.error as Record<string, unknown>).data as Record<string, unknown>;
      delete data.requestId;
      return JSON.stringify(clone);
    };
    expect(strip(denied.json)).toBe(strip(ghost.json));
    expect(trpcError(denied).businessCode).toBe("ACCESS_DENIED_OR_GONE");
  });
});
