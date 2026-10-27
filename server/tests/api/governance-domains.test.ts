import "./env-setup";

import { createHash } from "node:crypto";

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

async function meId(app: Awaited<ReturnType<typeof getApp>>, cookie: string): Promise<string> {
  const result = await trpc(app, "auth.me", { cookie, method: "GET" });
  return (result.json as { result: { data: { user: { id: string } } } }).result.data.user.id;
}

async function projectIdByCode(app: Awaited<ReturnType<typeof getApp>>, cookie: string, code: string) {
  const list = await trpc(app, "project.list", { cookie, method: "GET" });
  const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
    .result.data.items;
  const found = items.find((p) => p.code === code);
  if (!found) throw new Error(`项目 ${code} 不在可见范围`);
  return found.id;
}

async function uploadWithKey(
  app: Awaited<ReturnType<typeof getApp>>,
  cookie: string,
  sourceId: string,
  key: string | null,
  bytes: Uint8Array,
) {
  const form = new FormData();
  form.append("sourceType", "project");
  form.append("sourceId", sourceId);
  if (key) form.append("idempotencyKey", key);
  form.append("file", new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" }), "幂等.pdf");
  const response = await app.request("http://test/files/upload", {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("治理域（质量/决策/周报/档案/授权/D2/N1/查询口径）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let qualityCookie: string;
  let viewerCookie: string;
  let archivistCookie: string;
  let sysadminCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    qualityCookie = (await loginAs(app, "quality@lexflow.demo")).cookie;
    viewerCookie = (await loginAs(app, "viewer@lexflow.demo")).cookie;
    archivistCookie = (await loginAs(app, "archivist@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "sysadmin@lexflow.demo")).cookie;
    projectAId = await projectIdByCode(app, pmCookie, `PRJ-${YEAR}-00001`);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("D2 upload 幂等：同键返回首次结果，只建行一次", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x49, 0x44, 0x45, 0x4d]);
    const key = crypto.randomUUID();
    const first = await uploadWithKey(app, pmCookie, projectAId, key, bytes);
    expect(first.status).toBe(200);
    const second = await uploadWithKey(app, pmCookie, projectAId, key, bytes);
    expect(second.status).toBe(200);
    expect(second.json.fileVersionId).toBe(first.json.fileVersionId);
    expect(second.json.fileObjectId).toBe(first.json.fileObjectId);
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM file_versions WHERE idempotency_key = $1`,
      [key],
    );
    expect(rows[0].n).toBe(1);
  });

  it("N1：登录审计行显式带 actor（arch/04 §7）", async () => {
    const userId = await meId(app, pmCookie);
    const rows = await query<{ actor_id: string | null }>(
      `SELECT actor_id FROM audit_events WHERE action = 'auth.login' AND actor_id = $1`,
      [userId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("质量复核分离：severe 处理人≠复核人（SELF_REVIEW_BLOCKED）；事件流齐备；退回必须 note", async () => {
    const memberId = await meId(app, memberCookie);
    const pmId = await meId(app, pmCookie);
    const created = await trpc(app, "quality.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        title: " severe 分离测试",
        description: "复核分离硬规则测试用例",
        severity: "severe",
        handlerId: memberId,
        reviewerId: memberId, // 同一人：复核时必须被拦
      },
    });
    expect(created.status).toBe(200);
    const issueId = (created.json as { result: { data: { id: string } } }).result.data.id;

    // 指回复核人
    const assigned = await trpc(app, "quality.assign", {
      cookie: pmCookie,
      input: { id: issueId, handlerId: memberId, reviewerId: pmId },
    });
    expect(assigned.status).toBe(200);

    const submitted = await trpc(app, "quality.submitHandling", {
      cookie: memberCookie,
      input: { id: issueId, note: "已处理，提交复核" },
    });
    expect(submitted.status).toBe(200);

    // 退回缺 note → 400
    const noNote = await trpc(app, "quality.review", {
      cookie: pmCookie,
      input: { id: issueId, action: "return" },
    });
    expect(noNote.status).toBe(400);
    expect(trpcError(noNote).businessCode).toBe("VALIDATION_FAILED");

    const returned = await trpc(app, "quality.review", {
      cookie: pmCookie,
      input: { id: issueId, action: "return", comment: "补充根因分析" },
    });
    expect(returned.status).toBe(200);

    // 处理人收到 quality_returned
    const notices = await trpc(app, "notification.listMine", { cookie: memberCookie, method: "GET" });
    const types = (
      (notices.json as { result: { data: { items: { eventType: string }[] } } }).result.data.items
    ).map((n) => n.eventType);
    expect(types).toContain("quality_returned");

    // 再提交 → 复核通过 → closed；事件流（create/assign/handle_submit/review_return/handle_submit/review_pass）
    await trpc(app, "quality.submitHandling", {
      cookie: memberCookie,
      input: { id: issueId, note: "已补充，重新提交" },
    });
    const passed = await trpc(app, "quality.review", {
      cookie: pmCookie,
      input: { id: issueId, action: "pass", comment: "复核通过" },
    });
    expect(passed.status).toBe(200);
    const events = await query<{ action: string }>(
      `SELECT action FROM quality_issue_events WHERE issue_id = $1 ORDER BY created_at`,
      [issueId],
    );
    expect(events.map((e) => e.action)).toEqual([
      "create",
      "assign",
      "handle_submit",
      "review_return",
      "handle_submit",
      "review_pass",
    ]);
    const issue = await query<{ status: string; is_blocking: boolean }>(
      `SELECT status, is_blocking FROM quality_issues WHERE id = $1`,
      [issueId],
    );
    expect(issue[0]).toMatchObject({ status: "closed", is_blocking: false });

    // 同一人复核 severe → 拦截（用另一条 severe 直接构造）
    const seeded = await query<{ id: string; handler_id: string }>(
      `SELECT id, handler_id FROM quality_issues WHERE code = $1`,
      [`QLT-${YEAR}-00001`],
    );
    const badAssign = await trpc(app, "quality.assign", {
      cookie: pmCookie,
      input: { id: seeded[0].id, handlerId: pmId, reviewerId: pmId },
    });
    expect(badAssign.status).toBe(200);
    const blocked = await trpc(app, "quality.review", {
      cookie: pmCookie,
      input: { id: seeded[0].id, action: "pass" },
    });
    expect(blocked.status).toBe(403);
    expect(trpcError(blocked).businessCode).toBe("SELF_REVIEW_BLOCKED");
  });

  it("结项检查：未关闭阻断质量问题 → blocked，清单列明", async () => {
    const project = (
      (
        await trpc(app, "project.getById", { cookie: pmCookie, input: { id: projectAId }, method: "GET" })
      ).json as { result: { data: { rowVersion: number } } }
    ).result.data;
    const closed = await trpc(app, "project.close", {
      cookie: pmCookie,
      input: { projectId: projectAId, rowVersion: project.rowVersion },
    });
    if (closed.status !== 200) console.log("CLOSE FAILED:", JSON.stringify(closed.json).slice(0, 400));
    expect(closed.status).toBe(200);
    const data = (closed.json as {
      result: { data: { closed: boolean; blockers: string[]; warnings: string[]; checklist: { level: string }[] } };
    }).result.data;
    expect(data.closed).toBe(false);
    expect(data.blockers.length).toBeGreaterThan(0);
    expect(data.warnings.length).toBeGreaterThan(0); // 未完成任务/未归档周报
    expect(data.checklist.some((c) => c.level === "blocker")).toBe(true);
  });

  it("决策闭环：四必填+双意见校验 → decide 产检查点任务 → verify 回写", async () => {
    // 质量负责人入项目（成员关系前置）
    const qualityId = await meId(app, qualityCookie);
    await trpc(app, "project.addMember", {
      cookie: pmCookie,
      input: { projectId: projectAId, userId: qualityId, projectRole: "member" },
    });

    const created = await trpc(app, "decision.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        title: "是否追加鉴定申请",
        context: "证据链强度评估后决定是否追加司法鉴定",
        options: [
          { key: "delay", summary: "追加鉴定", impact: "周期延长两周", risk: "鉴定结论不利风险" },
          { key: "risk_accept", summary: "不追加", impact: "维持现有证据链", risk: "举证不足风险" },
        ],
      },
    });
    expect(created.status).toBe(200);
    const decisionId = (created.json as { result: { data: { id: string } } }).result.data.id;

    // 按角色各写各的
    const pmOpinion = await trpc(app, "decision.submitOpinions", {
      cookie: qualityCookie,
      input: { id: decisionId, pmOpinion: "质量角色不可写 pm 意见" },
    });
    expect(pmOpinion.status).toBe(404);
    await trpc(app, "decision.submitOpinions", {
      cookie: pmCookie,
      input: { id: decisionId, pmOpinion: "倾向追加鉴定：证言缺口影响较大。" },
    });
    await trpc(app, "decision.submitOpinions", {
      cookie: qualityCookie,
      input: { id: decisionId, qualityOpinion: "同意追加，注意鉴定机构资质。" },
    });

    // 四必填校验：缺 conditions → fieldErrors
    const memberId = await meId(app, memberCookie);
    const badDecide = await trpc(app, "decision.decide", {
      cookie: pmCookie,
      input: {
        id: decisionId,
        finalOption: "delay",
        finalReason: "证据链补强优先",
        conditions: "",
        checkpoints: [{ point: "提交鉴定申请", date: "2027-02-01", owner_id: memberId }],
        rowVersion: 2,
      },
    });
    expect(badDecide.status).toBe(400);
    expect(trpcError(badDecide).fieldErrors).toHaveProperty("conditions");

    const decided = await trpc(app, "decision.decide", {
      cookie: pmCookie,
      input: {
        id: decisionId,
        finalOption: "delay",
        finalReason: "证据链补强优先",
        conditions: "两周内未取得结论则降级为不追加",
        checkpoints: [{ point: "提交鉴定申请", date: "2027-02-01", owner_id: memberId }],
        rowVersion: 2,
      },
    });
    expect(decided.status).toBe(200);

    // 检查点生成任务（source_type='decision'）
    const cpTasks = await query<{ code: string; source_id: string }>(
      `SELECT code, source_id FROM tasks WHERE source_type = 'decision' AND source_id = $1`,
      [decisionId],
    );
    expect(cpTasks).toHaveLength(1);

    const verify = await trpc(app, "decision.verify", {
      cookie: pmCookie,
      input: { id: decisionId, note: "鉴定申请已提交并受理" },
    });
    expect(verify.status).toBe(200);
    const final = await query<{ status: string; verification_note: string | null }>(
      `SELECT status, verification_note FROM decisions WHERE id = $1`,
      [decisionId],
    );
    expect(final[0].status).toBe("verified");
    expect(final[0].verification_note).toContain("鉴定申请");
  });

  it("周报：草稿真实聚合→确认幂等→再改产新版本→归档只读+入目录 06", async () => {
    const today = new Date();
    const monday = new Date(today);
    monday.setUTCDate(monday.getUTCDate() - ((today.getUTCDay() + 6) % 7) - 7);
    const sunday = new Date(monday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const draft = await trpc(app, "report.generateDraft", {
      cookie: pmCookie,
      input: { projectId: projectAId, periodStart: fmt(monday), periodEnd: fmt(sunday) },
    });
    expect(draft.status).toBe(200);
    const draftData = (draft.json as {
      result: { data: { id: string; versionNo: number; status: string; content: Record<string, string> } };
    }).result.data;
    expect(draftData.status).toBe("draft");
    expect(draftData.versionNo).toBe(2); // 种子同期间已有 confirmed v1
    expect(draftData.content.tasks.length).toBeGreaterThan(0);

    // 确认（幂等：同 rowVersion 重放返回首次结果）
    const current = (
      (
        await trpc(app, "report.getById", { cookie: pmCookie, input: { id: draftData.id }, method: "GET" })
      ).json as { result: { data: { rowVersion: number } } }
    ).result.data;
    const confirm1 = await trpc(app, "report.confirm", {
      cookie: pmCookie,
      input: { id: draftData.id, rowVersion: current.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(confirm1.status).toBe(200);
    const confirm2 = await trpc(app, "report.confirm", {
      cookie: pmCookie,
      input: { id: draftData.id, rowVersion: current.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(confirm2.status).toBe(200);
    expect((confirm2.json as { result: { data: { status: string } } }).result.data.status).toBe("confirmed");

    // 已确认后再改 = 同期间新版本 v3
    const v3 = await trpc(app, "report.updateDraft", {
      cookie: pmCookie,
      input: {
        id: draftData.id,
        rowVersion: current.rowVersion + 1,
        content: { ...draftData.content, progress: "修订：补充本周进展" },
      },
    });
    expect(v3.status).toBe(200);
    const v3Data = (v3.json as { result: { data: { id: string; versionNo: number; status: string } } }).result.data;
    expect(v3Data.versionNo).toBe(3);
    expect(v3Data.status).toBe("draft");
    expect(v3Data.id).not.toBe(draftData.id);

    // 归档：确认 → archived，登记目录 06
    const v3Row = (
      (
        await trpc(app, "report.getById", { cookie: pmCookie, input: { id: v3Data.id }, method: "GET" })
      ).json as { result: { data: { rowVersion: number } } }
    ).result.data;
    await trpc(app, "report.confirm", {
      cookie: pmCookie,
      input: { id: v3Data.id, rowVersion: v3Row.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const archived = await trpc(app, "report.archive", {
      cookie: pmCookie,
      input: { id: v3Data.id },
    });
    expect(archived.status).toBe(200);
    const link = await query<{ source_type: string }>(
      `SELECT source_type FROM archive_links WHERE source_type = 'report' AND source_id = $1`,
      [v3Data.id],
    );
    expect(link).toHaveLength(1);

    // archived 只读
    const readonly = await trpc(app, "report.updateDraft", {
      cookie: pmCookie,
      input: { id: v3Data.id, rowVersion: 99, content: { progress: "x" } },
    });
    expect(readonly.status).toBe(403);
    expect(trpcError(readonly).businessCode).toBe("ARCHIVED_READONLY");
  });

  it("档案：十一目录、文件归集与来源项目校验", async () => {
    const tree = await trpc(app, "archive.tree", {
      cookie: pmCookie,
      method: "GET",
      input: { projectId: projectAId },
    });
    expect(tree.status).toBe(200);
    expect((tree.json as { result: { data: unknown[] } }).result.data).toHaveLength(11);

    // 上传并归集
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x44, 0x4f, 0x43]);
    const uploaded = await uploadWithKey(app, pmCookie, projectAId, null, bytes);
    const fileVersionId = uploaded.json.fileVersionId as string;
    const dir06 = await query<{ id: string }>(
      `SELECT id FROM archive_directories WHERE project_id = $1 AND dir_key = '06_周报与月报'`,
      [projectAId],
    );
    const linked = await trpc(app, "archive.link", {
      cookie: pmCookie,
      input: { directoryId: dir06[0].id, fileVersionId },
    });
    expect(linked.status).toBe(200);

    const items = await trpc(app, "archive.directoryItems", {
      cookie: pmCookie,
      method: "GET",
      input: { directoryId: dir06[0].id },
    });
    const itemList = (items.json as { result: { data: { items: { file: { sha256: string } | null }[] } } })
      .result.data.items;
    expect(itemList.some((i) => i.file?.sha256 === uploaded.json.sha256)).toBe(true);
  });

  it("档案授权：申请→审批→有效；到期即时失效（直链同形 404）", async () => {
    const viewerId = await meId(app, viewerCookie);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x47, 0x52, 0x41, 0x4e, 0x54]);
    const uploaded = await uploadWithKey(app, pmCookie, projectAId, null, bytes);
    const fileVersionId = uploaded.json.fileVersionId as string;

    // viewer 无权限 → 404 同形
    const deniedBefore = await app.request(`http://test/files/${fileVersionId}/download`, {
      headers: { cookie: viewerCookie },
    });
    expect(deniedBefore.status).toBe(404);

    // 申请 project 范围授权（含 archive.read 与 project.read）
    const applied = await trpc(app, "archive.grantApply", {
      cookie: viewerCookie,
      input: {
        scopeType: "project",
        scopeId: projectAId,
        granteeId: viewerId,
        actions: ["project.read", "archive.read"],
        expiresAt: null,
        reason: "查阅项目档案（测试）",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(applied.status).toBe(200);
    const grantId = (applied.json as { result: { data: { grant: { id: string } } } }).result.data.grant.id;
    const instanceId = (applied.json as {
      result: { data: { instance: { id: string; currentStepSeq: number } } };
    }).result.data.instance.id;

    // 档案管理员审批通过 → active；viewer 立即可读
    const approved = await trpc(app, "approval.act", {
      cookie: archivistCookie,
      input: { instanceId, stepSeq: 1, action: "approve" },
    });
    expect(approved.status).toBe(200);

    const allowed = await app.request(`http://test/files/${fileVersionId}/download`, {
      headers: { cookie: viewerCookie },
    });
    expect(allowed.status).toBe(200);
    const bodyHash = createHash("sha256").update(new Uint8Array(await allowed.arrayBuffer())).digest("hex");
    expect(bodyHash).toBe(uploaded.json.sha256 as string);

    // viewer 项目列表现含 A（grant scope 过滤）
    const viewerList = await trpc(app, "project.list", { cookie: viewerCookie, method: "GET" });
    expect(
      (viewerList.json as { result: { data: { items: { code: string }[] } } }).result.data.items.map((p) => p.code),
    ).toContain(`PRJ-${YEAR}-00001`);

    // 到期：expires_at 拨到过去 → 即时失效（查询时判定，arch/03 §7）
    await query(`UPDATE access_grants SET expires_at = now() - interval '1 hour' WHERE id = $1`, [grantId]);
    const deniedAfter = await app.request(`http://test/files/${fileVersionId}/download`, {
      headers: { cookie: viewerCookie },
    });
    expect(deniedAfter.status).toBe(404);
    const viewerListAfter = await trpc(app, "project.list", { cookie: viewerCookie, method: "GET" });
    expect(
      (viewerListAfter.json as { result: { data: { items: { code: string }[] } } }).result.data.items.map(
        (p) => p.code,
      ),
    ).not.toContain(`PRJ-${YEAR}-00001`);
  });

  it("统一待办 / 通知 / 驾驶舱 / 审计查阅 口径", async () => {
    // todo.mine：member 含种子临期/逾期任务
    // member：种子临期任务 TSK-00003（dueSoon）
    const memberTodo = await trpc(app, "todo.mine", { cookie: memberCookie, method: "GET" });
    expect(memberTodo.status).toBe(200);
    const memberItems = (memberTodo.json as {
      result: { data: { items: { kind: string; overdue: boolean; dueSoon: boolean }[] } };
    }).result.data.items;
    expect(memberItems.some((i) => i.kind === "task" && i.dueSoon)).toBe(true);
    // 刘畅：种子逾期任务 TSK-00004（overdue）
    const liuchangCookie = (await loginAs(app, "liuchang@lexflow.demo")).cookie;
    const liuchangTodo = await trpc(app, "todo.mine", { cookie: liuchangCookie, method: "GET" });
    const liuchangItems = (liuchangTodo.json as {
      result: { data: { items: { kind: string; overdue: boolean }[] } };
    }).result.data.items;
    expect(liuchangItems.some((i) => i.kind === "task" && i.overdue)).toBe(true);

    // 提交延期 → pm 待办出现审批项 → 通过后消失
    const target = (
      await query<{ id: string }>(`SELECT id FROM tasks WHERE code = $1`, [`TSK-${YEAR}-00003`])
    )[0];
    const created = await trpc(app, "change.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        title: "待办口径延期",
        level: "normal",
        targetItems: [
          { ref_id: target.id, item_type: "task", new_start: "2027-03-01", new_end: "2027-03-10" },
        ],
        reason: "待办验证",
        impact: "待办验证",
        recoveryMeasures: [
          { measure: "恢复", owner_id: await meId(app, memberCookie), checkpoint_date: "2027-03-02" },
        ],
      },
    });
    const crId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const cr = (
      (
        await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })
      ).json as { result: { data: { rowVersion: number } } }
    ).result.data;
    await trpc(app, "change.submit", {
      cookie: memberCookie,
      input: { id: crId, rowVersion: cr.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const crAfter = (
      (
        await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })
      ).json as { result: { data: { approvalInstanceId: string } } }
    ).result.data;

    const pmTodoBefore = await trpc(app, "todo.mine", { cookie: pmCookie, method: "GET" });
    const beforeKinds = (pmTodoBefore.json as { result: { data: { items: { kind: string; id: string }[] } } })
      .result.data.items;
    expect(beforeKinds.some((i) => i.kind === "approval" && i.id === crAfter.approvalInstanceId)).toBe(true);

    await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: crAfter.approvalInstanceId, stepSeq: 1, action: "approve" },
    });
    const pmTodoAfter = await trpc(app, "todo.mine", { cookie: pmCookie, method: "GET" });
    const afterKinds = (pmTodoAfter.json as { result: { data: { items: { kind: string; id: string }[] } } })
      .result.data.items;
    expect(afterKinds.some((i) => i.id === crAfter.approvalInstanceId)).toBe(false);

    // 通知：unreadCount + markRead
    const unread = await trpc(app, "notification.unreadCount", { cookie: pmCookie, method: "GET" });
    expect((unread.json as { result: { data: { count: number } } }).result.data.count).toBeGreaterThanOrEqual(0);
    const list = await trpc(app, "notification.listMine", { cookie: pmCookie, method: "GET" });
    const noticeId = (list.json as { result: { data: { items: { id: string }[] } } }).result.data.items[0]?.id;
    if (noticeId) {
      const marked = await trpc(app, "notification.markRead", {
        cookie: pmCookie,
        input: { ids: [noticeId] },
      });
      expect(marked.status).toBe(200);
    }

    // 驾驶舱：pm 范围（2 项目）与待审批数
    const summary = await trpc(app, "dashboard.summary", { cookie: pmCookie, method: "GET" });
    const summaryData = (summary.json as {
      result: { data: { projects: { total: number }; pendingApprovals: number } };
    }).result.data;
    expect(summaryData.projects.total).toBe(2);

    // 审计查阅：member 被拦（audit.read 动作授权）；sysadmin 可查
    const denied = await trpc(app, "audit.list", { cookie: memberCookie, method: "GET", input: {} });
    expect(denied.status).toBe(404);
    expect(trpcError(denied).businessCode).toBe("ACCESS_DENIED_OR_GONE");
    const allowed = await trpc(app, "audit.list", {
      cookie: sysadminCookie,
      method: "GET",
      input: { action: "change.submit", limit: 10 },
    });
    expect(allowed.status).toBe(200);
    const auditItems = (allowed.json as { result: { data: { items: { action: string }[] } } }).result.data.items;
    expect(auditItems.length).toBeGreaterThan(0);
    expect(auditItems.every((i) => i.action === "change.submit")).toBe(true);
  });

  it("计划只读与状态机：versions/current；stage/milestone 流转", async () => {
    const versions = await trpc(app, "plan.versions", {
      cookie: pmCookie,
      method: "GET",
      input: { projectId: projectAId },
    });
    expect(versions.status).toBe(200);
    const versionRows = (versions.json as { result: { data: { versionNo: number }[] } }).result.data;
    expect(versionRows.length).toBeGreaterThanOrEqual(1);

    const current = await trpc(app, "plan.current", {
      cookie: pmCookie,
      method: "GET",
      input: { projectId: projectAId },
    });
    expect(current.status).toBe(200);
    const currentData = (current.json as {
      result: { data: { versionNo: number; items: unknown[] } };
    }).result.data;
    expect(currentData.items.length).toBeGreaterThan(0);

    // 里程碑流转
    const milestone = (
      await query<{ id: string }>(`SELECT id FROM milestones WHERE code = $1`, [`MLS-${YEAR}-00002`])
    )[0];
    const reached = await trpc(app, "plan.transitionMilestone", {
      cookie: pmCookie,
      input: { milestoneId: milestone.id, action: "reach" },
    });
    expect(reached.status).toBe(200);
    const again = await trpc(app, "plan.transitionMilestone", {
      cookie: pmCookie,
      input: { milestoneId: milestone.id, action: "reach" },
    });
    expect(again.status).toBe(409);

    // 阶段启动（pending → active）
    const stage = (
      await query<{ id: string }>(`SELECT id FROM stages WHERE code = $1`, [`STG-${YEAR}-00002`])
    )[0];
    const started = await trpc(app, "plan.transitionStage", {
      cookie: pmCookie,
      input: { stageId: stage.id, action: "start" },
    });
    expect(started.status).toBe(200);
  });
});
