import "./env-setup";

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 1 验收套件·业务流（arch/04 §8）：A5 周报 / A6 档案授权（撤销即时）/
 * A7 审批幂等（act 重放）/ A8 统一待办 / A9 通知口径 / A10 审计查阅。
 * 与后端 governance-domains 自测互补：本套件按验收口径独立走链并补撤销/审计/过滤断言。
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

async function projectIdByCode(app: Awaited<ReturnType<typeof getApp>>, cookie: string, code: string) {
  const list = await trpc(app, "project.list", { cookie, method: "GET" });
  const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
    .result.data.items;
  return items.find((p) => p.code === code)!.id;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "requestId")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function uploadPdf(
  app: Awaited<ReturnType<typeof getApp>>,
  cookie: string,
  sourceId: string,
  bytes: Uint8Array,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData();
  form.append("sourceType", "project");
  form.append("sourceId", sourceId);
  form.append("file", new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" }), "A6.pdf");
  const response = await app.request("http://test/files/upload", {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("迭代 1 验收 A5–A10（arch/04 §8）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let viewerCookie: string;
  let archivistCookie: string;
  let sysadminCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    viewerCookie = (await loginAs(app, "viewer@lexflow.demo")).cookie;
    archivistCookie = (await loginAs(app, "archivist@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "sysadmin@lexflow.demo")).cookie;
    projectAId = await projectIdByCode(app, pmCookie, `PRJ-${YEAR}-00001`);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("A5 周报：草稿聚合真实来源 → 确认固定 → 再改产新版本 → 归档只读且入目录 06", async () => {
    const today = new Date();
    const monday = new Date(today);
    monday.setUTCDate(monday.getUTCDate() - ((today.getUTCDay() + 6) % 7) - 7);
    const sunday = new Date(monday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    // 真实来源交叉核验：进行中/待处理任务以编号聚合出现在 tasks 节；
    // 本周完成任务以标题聚合出现在 progress 节
    const openTasks = await query<{ code: string }>(
      `SELECT code FROM tasks WHERE project_id = $1 AND status IN ('pending', 'in_progress')`,
      [projectAId],
    );
    const doneTasks = await query<{ title: string }>(
      `SELECT title FROM tasks WHERE project_id = $1
       AND status = 'done' AND completed_at >= $2::date AND completed_at < ($3::date + 1)`,
      [projectAId, fmt(monday), fmt(sunday)],
    );

    const draft = await trpc(app, "report.generateDraft", {
      cookie: pmCookie,
      input: { projectId: projectAId, periodStart: fmt(monday), periodEnd: fmt(sunday) },
    });
    expect(draft.status).toBe(200);
    const draftData = (draft.json as {
      result: { data: { id: string; versionNo: number; status: string; content: Record<string, string> } };
    }).result.data;
    expect(draftData.status).toBe("draft");
    expect(draftData.versionNo).toBe(2); // 种子同期间 confirmed v1 在位
    const contentText = JSON.stringify(draftData.content);
    for (const task of openTasks) {
      expect(contentText).toContain(task.code);
    }
    for (const task of doneTasks) {
      expect(contentText).toContain(task.title);
    }

    // 确认固定（幂等键重放返回首次结果）
    const row = (
      (await trpc(app, "report.getById", { cookie: pmCookie, input: { id: draftData.id }, method: "GET" })).json as {
        result: { data: { rowVersion: number } };
      }
    ).result.data;
    const key = crypto.randomUUID();
    const confirm1 = await trpc(app, "report.confirm", {
      cookie: pmCookie,
      input: { id: draftData.id, rowVersion: row.rowVersion, idempotencyKey: key },
    });
    expect(confirm1.status).toBe(200);
    const confirm2 = await trpc(app, "report.confirm", {
      cookie: pmCookie,
      input: { id: draftData.id, rowVersion: row.rowVersion, idempotencyKey: key },
    });
    expect(confirm2.status).toBe(200);
    expect((confirm2.json as { result: { data: { status: string } } }).result.data.status).toBe("confirmed");

    // 已确认再改 = 同期间新版本，旧版本不动
    const v3 = await trpc(app, "report.updateDraft", {
      cookie: pmCookie,
      input: {
        id: draftData.id,
        rowVersion: row.rowVersion + 1,
        content: { ...draftData.content, progress: "A5 修订：补充进展" },
      },
    });
    expect(v3.status).toBe(200);
    const v3Data = (v3.json as { result: { data: { id: string; versionNo: number; status: string } } }).result.data;
    expect(v3Data).toMatchObject({ versionNo: 3, status: "draft" });
    expect(v3Data.id).not.toBe(draftData.id);
    const v2Untouched = await query<{ status: string }>(
      `SELECT status FROM weekly_reports WHERE id = $1`,
      [draftData.id],
    );
    expect(v2Untouched[0].status).toBe("confirmed");

    // 归档 → 只读 + 目录 06 登记
    const v3Row = (
      (await trpc(app, "report.getById", { cookie: pmCookie, input: { id: v3Data.id }, method: "GET" })).json as {
        result: { data: { rowVersion: number } };
      }
    ).result.data;
    await trpc(app, "report.confirm", {
      cookie: pmCookie,
      input: { id: v3Data.id, rowVersion: v3Row.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const archived = await trpc(app, "report.archive", { cookie: pmCookie, input: { id: v3Data.id } });
    expect(archived.status).toBe(200);
    const link = await query<{ directory_id: string }>(
      `SELECT directory_id FROM archive_links WHERE source_type = 'report' AND source_id = $1`,
      [v3Data.id],
    );
    expect(link).toHaveLength(1);
    const dirKey = await query<{ dir_key: string }>(
      `SELECT dir_key FROM archive_directories WHERE id = $1`,
      [link[0].directory_id],
    );
    expect(dirKey[0].dir_key).toBe("06_周报与月报");
    const readonly = await trpc(app, "report.updateDraft", {
      cookie: pmCookie,
      input: { id: v3Data.id, rowVersion: 99, content: { progress: "x" } },
    });
    expect(readonly.status).toBe(403);
    expect(trpcError(readonly).businessCode).toBe("ARCHIVED_READONLY");
  });

  it("A6 档案授权：申请→审批→有效可读；撤销即时失效同形 404；全程审计", async () => {
    const viewerId = await meId(app, viewerCookie);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x41, 0x36]);
    const uploaded = await uploadPdf(app, pmCookie, projectAId, bytes);
    expect(uploaded.status).toBe(200);
    const fileVersionId = uploaded.json.fileVersionId as string;

    // 未授权直链同形 404
    const denied = await app.request(`http://test/files/${fileVersionId}/download`, {
      headers: { cookie: viewerCookie },
    });
    expect(denied.status).toBe(404);
    const ghost = await app.request(`http://test/files/00000000-0000-0000-0000-000000000000/download`, {
      headers: { cookie: viewerCookie },
    });
    expect(canonical(await denied.json())).toBe(canonical(await ghost.json()));

    // 申请（幂等键）→ archivist 审批 → 生效
    const applied = await trpc(app, "archive.grantApply", {
      cookie: viewerCookie,
      input: {
        scopeType: "project",
        scopeId: projectAId,
        granteeId: viewerId,
        actions: ["project.read", "archive.read"],
        expiresAt: null,
        reason: "A6 验收查阅",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(applied.status).toBe(200);
    const grantId = (applied.json as { result: { data: { grant: { id: string } } } }).result.data.grant.id;
    const instanceId = (applied.json as {
      result: { data: { instance: { id: string } } };
    }).result.data.instance.id;
    const approved = await trpc(app, "approval.act", {
      cookie: archivistCookie,
      input: { instanceId, stepSeq: 1, action: "approve", comment: "同意" },
    });
    expect(approved.status).toBe(200);

    const allowed = await app.request(`http://test/files/${fileVersionId}/download`, {
      headers: { cookie: viewerCookie },
    });
    expect(allowed.status).toBe(200);
    const hash = createHash("sha256").update(new Uint8Array(await allowed.arrayBuffer())).digest("hex");
    expect(hash).toBe(uploaded.json.sha256 as string);

    // 撤销（申请人本人）→ 即时失效，直链回到同形 404
    const revoked = await trpc(app, "archive.grantRevoke", {
      cookie: viewerCookie,
      input: { id: grantId, reason: "A6 验收撤销" },
    });
    expect(revoked.status).toBe(200);
    const deniedAfter = await app.request(`http://test/files/${fileVersionId}/download`, {
      headers: { cookie: viewerCookie },
    });
    expect(deniedAfter.status).toBe(404);
    const viewerList = await trpc(app, "project.list", { cookie: viewerCookie, method: "GET" });
    expect(
      (viewerList.json as { result: { data: { items: { code: string }[] } } }).result.data.items.map((p) => p.code),
    ).not.toContain(`PRJ-${YEAR}-00001`);

    // 全程审计：申请/审批/撤销均留痕
    const audits = await query<{ action: string }>(
      `SELECT action FROM audit_events
       WHERE action IN ('archive.grantApply', 'approval.act', 'archive.grantRevoke')`,
    );
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("archive.grantApply");
    expect(actions).toContain("approval.act");
    expect(actions).toContain("archive.grantRevoke");
  });

  it("A7 审批幂等：act 同键重放不双生效；实例单一终态", async () => {
    const target = (
      await query<{ id: string }>(`SELECT id FROM tasks WHERE code = $1`, [`TSK-${YEAR}-00006`])
    )[0];
    const created = await trpc(app, "change.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        title: "A7 幂等审批",
        level: "normal",
        targetItems: [
          { ref_id: target.id, item_type: "task", new_start: "2027-04-01", new_end: "2027-04-10" },
        ],
        reason: "A7", impact: "A7",
        recoveryMeasures: [
          { measure: "A7 恢复", owner_id: await meId(app, memberCookie), checkpoint_date: "2027-04-02" },
        ],
      },
    });
    const crId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const cr = (
      (await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })).json as {
        result: { data: { rowVersion: number } };
      }
    ).result.data;
    await trpc(app, "change.submit", {
      cookie: memberCookie,
      input: { id: crId, rowVersion: cr.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const crAfter = (
      (await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })).json as {
        result: { data: { approvalInstanceId: string } };
      }
    ).result.data;

    // 首次审批生效
    const actKey = crypto.randomUUID();
    const act1 = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: crAfter.approvalInstanceId, stepSeq: 1, action: "approve", idempotencyKey: actKey },
    });
    expect(act1.status).toBe(200);
    expect((act1.json as { result: { data: { applied: boolean } } }).result.data.applied).toBe(true);

    // 同键顺序重放（N4 语义，arch/05 §9）：200 + applied=false，不产生副作用；
    // 异键重放终态 409 由后端 carryover-n4 套件覆盖
    const act2 = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: crAfter.approvalInstanceId, stepSeq: 1, action: "approve", idempotencyKey: actKey },
    });
    expect(act2.status).toBe(200);
    expect((act2.json as { result: { data: { applied: boolean } } }).result.data.applied).toBe(false);

    const instance = await query<{ status: string }>(
      `SELECT status FROM approval_instances WHERE id = $1`,
      [crAfter.approvalInstanceId],
    );
    expect(instance[0].status).toBe("approved");
    // 业务单一结果：仅一个生效版本挂链
    const versions = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM plan_versions WHERE project_id = $1`,
      [projectAId],
    );
    expect(versions[0].n).toBe(2); // v1 + 本链 v2（无双写）
  });

  it("A8 统一待办：同源出现，处理后消失", async () => {
    // pm 初始待办含未完成任务（TSK-00005 负责人 pm，pending）
    const before = await trpc(app, "todo.mine", { cookie: pmCookie, method: "GET" });
    const beforeItems = (before.json as { result: { data: { items: { kind: string }[] } } }).result.data.items;
    expect(beforeItems.some((i) => i.kind === "task")).toBe(true);

    // member 提交延期 → pm 待办出现审批项
    const target = (
      await query<{ id: string }>(`SELECT id FROM tasks WHERE code = $1`, [`TSK-${YEAR}-00003`])
    )[0];
    const created = await trpc(app, "change.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        title: "A8 待办口径",
        level: "normal",
        targetItems: [
          { ref_id: target.id, item_type: "task", new_start: "2027-05-01", new_end: "2027-05-09" },
        ],
        reason: "A8", impact: "A8",
        recoveryMeasures: [
          { measure: "A8 恢复", owner_id: await meId(app, memberCookie), checkpoint_date: "2027-05-02" },
        ],
      },
    });
    const crId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const cr = (
      (await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })).json as {
        result: { data: { rowVersion: number } };
      }
    ).result.data;
    await trpc(app, "change.submit", {
      cookie: memberCookie,
      input: { id: crId, rowVersion: cr.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const crAfter = (
      (await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })).json as {
        result: { data: { approvalInstanceId: string } };
      }
    ).result.data;

    const mid = await trpc(app, "todo.mine", { cookie: pmCookie, method: "GET" });
    const midItems = (mid.json as { result: { data: { items: { kind: string; id: string }[] } } }).result.data.items;
    expect(midItems.some((i) => i.kind === "approval" && i.id === crAfter.approvalInstanceId)).toBe(true);

    // 处理后消失
    await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: crAfter.approvalInstanceId, stepSeq: 1, action: "approve" },
    });
    const after = await trpc(app, "todo.mine", { cookie: pmCookie, method: "GET" });
    const afterItems = (after.json as { result: { data: { items: { id: string }[] } } }).result.data.items;
    expect(afterItems.some((i) => i.id === crAfter.approvalInstanceId)).toBe(false);
  });

  it("A9 通知：直达对象、单源单条、处理后同步", async () => {
    // member 再提一件（key 级 → partner 收 approval_pending）
    const target = (
      await query<{ id: string }>(`SELECT id FROM tasks WHERE code = $1`, [`TSK-${YEAR}-00007`])
    )[0];
    const created = await trpc(app, "change.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        title: "A9 通知口径",
        level: "key",
        targetItems: [
          { ref_id: target.id, item_type: "task", new_start: "2027-06-01", new_end: "2027-06-09" },
        ],
        reason: "A9", impact: "A9",
        recoveryMeasures: [
          { measure: "A9 恢复", owner_id: await meId(app, memberCookie), checkpoint_date: "2027-06-02" },
        ],
      },
    });
    const crId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const cr = (
      (await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })).json as {
        result: { data: { rowVersion: number } };
      }
    ).result.data;
    await trpc(app, "change.submit", {
      cookie: memberCookie,
      input: { id: crId, rowVersion: cr.rowVersion, idempotencyKey: crypto.randomUUID() },
    });

    // 单源单条（聚合不轰炸）：同一来源的 approval_pending 仅一条
    const pendingRows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
       WHERE event_type = 'approval_pending' AND source_type = 'change_request' AND source_id = $1`,
      [crId],
    );
    expect(pendingRows[0].n).toBe(1);

    // 直达对象：key 级审批人（partner）收到；申请人（member）不收到 approval_pending
    const partnerCookie = (await loginAs(app, "partner@lexflow.demo")).cookie;
    const partnerList = await trpc(app, "notification.listMine", { cookie: partnerCookie, method: "GET" });
    const partnerItems = (partnerList.json as { result: { data: { items: { id: string; eventType: string; sourceId: string }[] } } })
      .result.data.items;
    expect(partnerItems.some((n) => n.eventType === "approval_pending" && n.sourceId === crId)).toBe(true);
    const memberList = await trpc(app, "notification.listMine", { cookie: memberCookie, method: "GET" });
    const memberItems = (memberList.json as { result: { data: { items: { eventType: string; sourceId: string }[] } } })
      .result.data.items;
    expect(memberItems.some((n) => n.eventType === "approval_pending" && n.sourceId === crId)).toBe(false);

    // 未读数 → 已读同步
    const unreadBefore = await trpc(app, "notification.unreadCount", { cookie: partnerCookie, method: "GET" });
    const countBefore = (unreadBefore.json as { result: { data: { count: number } } }).result.data.count;
    const noticeId = partnerItems.find((n) => n.eventType === "approval_pending" && n.sourceId === crId)!.id
      ?? partnerItems[0].id;
    await trpc(app, "notification.markRead", {
      cookie: partnerCookie,
      input: { ids: [noticeId] },
    });
    const unreadAfter = await trpc(app, "notification.unreadCount", { cookie: partnerCookie, method: "GET" });
    expect((unreadAfter.json as { result: { data: { count: number } } }).result.data.count).toBeLessThanOrEqual(
      Math.max(0, countBefore - 1) + 0,
    );
    expect((unreadAfter.json as { result: { data: { count: number } } }).result.data.count).toBeLessThanOrEqual(countBefore);
  });

  it("A10 审计查阅：未授权同形 404；授权角色可按动作/操作者过滤", async () => {
    // member 被拒且与随机查询同形（无存在性泄露）
    const denied = await trpc(app, "audit.list", { cookie: memberCookie, method: "GET", input: {} });
    expect(denied.status).toBe(404);
    expect(trpcError(denied).businessCode).toBe("ACCESS_DENIED_OR_GONE");
    const pmDenied = await trpc(app, "audit.list", { cookie: pmCookie, method: "GET", input: {} });
    expect(pmDenied.status).toBe(404);
    const ghost = await trpc(app, "project.getById", {
      cookie: memberCookie,
      input: { id: "00000000-0000-0000-0000-000000000000" },
      method: "GET",
    });
    expect(trpcError(denied).businessCode).toBe(trpcError(ghost).businessCode);

    // sysadmin：动作过滤
    const byAction = await trpc(app, "audit.list", {
      cookie: sysadminCookie,
      method: "GET",
      input: { action: "change.submit", limit: 50 },
    });
    expect(byAction.status).toBe(200);
    const actionItems = (byAction.json as { result: { data: { items: { action: string }[] } } }).result.data.items;
    expect(actionItems.length).toBeGreaterThan(0);
    expect(actionItems.every((i) => i.action === "change.submit")).toBe(true);

    // 操作者过滤：只返回该 actor 的行（drizzle 属性为 camelCase actorId）
    const pmId = await meId(app, pmCookie);
    const byActor = await trpc(app, "audit.list", {
      cookie: sysadminCookie,
      method: "GET",
      input: { actorId: pmId, limit: 100 },
    });
    expect(byActor.status).toBe(200);
    const actorItems = (byActor.json as {
      result: { data: { items: { actorId: string | null }[] } };
    }).result.data.items;
    expect(actorItems.length).toBeGreaterThan(0);
    expect(actorItems.every((i) => i.actorId === pmId)).toBe(true);
  });
});
