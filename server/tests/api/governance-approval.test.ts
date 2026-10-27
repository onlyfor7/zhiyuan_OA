import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { registerHandler } from "../../src/services/approval/engine";
import type { ApprovalInstanceRow } from "../../src/services/approval/engine";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

const YEAR = new Date().getFullYear();

interface MeData {
  user: { id: string; email: string };
}

async function me(app: Awaited<ReturnType<typeof getApp>>, cookie: string): Promise<MeData> {
  const result = await trpc(app, "auth.me", { cookie, method: "GET" });
  return (result.json as { result: { data: MeData } }).result.data;
}

/** pg date 列可能是 Date 对象：统一转 YYYY-MM-DD */
function dayOf(value: unknown): string {
  if (value instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  return String(value).slice(0, 10);
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

/** pm 视角的项目 A/B id + 成员 id */
async function projectIds(app: Awaited<ReturnType<typeof getApp>>, pmCookie: string) {
  const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
  const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
    .result.data.items;
  return {
    projectA: items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id,
    projectB: items.find((p) => p.code === `PRJ-${YEAR}-00002`)!.id,
  };
}

async function createAndSubmitChange(
  app: Awaited<ReturnType<typeof getApp>>,
  cookie: string,
  input: { projectId: string; targetRefId: string; level: "normal" | "key"; idempotencyKey: string },
) {
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() + 10);
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + 19);
  const member = await me(app, cookie);
  const created = await trpc(app, "change.create", {
    cookie,
    input: {
      projectId: input.projectId,
      title: "延期取证：任务整体后移",
      level: input.level,
      targetItems: [
        {
          ref_id: input.targetRefId,
          item_type: "task" as const,
          new_start: fmt(start),
          new_end: fmt(end),
        },
      ],
      reason: "证人出差，证据交换延期（测试）",
      impact: "庭前准备整体顺延一周（测试）",
      recoveryMeasures: [
        {
          measure: "每日同步证人行程（测试）",
          owner_id: member.user.id,
          checkpoint_date: fmt(new Date(today.getTime() + 3 * 86_400_000)),
        },
      ],
    },
  });
  if (created.status !== 200) console.log("change.create FAILED:", JSON.stringify(created.json).slice(0, 400));
  expect(created.status).toBe(200);
  const crId = (created.json as { result: { data: { id: string } } }).result.data.id;

  const current = await trpc(app, "change.getById", { cookie, input: { id: crId }, method: "GET" });
  const rowVersion = (current.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
  const submitted = await trpc(app, "change.submit", {
    cookie,
    input: { id: crId, rowVersion, idempotencyKey: input.idempotencyKey },
  });
  return { crId, submitted };
}

describe("审批引擎与延期闭环（arch/04 §4/§2.4）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let projectAId: string;
  let memberId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    const ids = await projectIds(app, pmCookie);
    projectAId = ids.projectA;
    memberId = (await me(app, memberCookie)).user.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("完整链路：提交→审批→通过→新计划版本+live 同步+恢复任务+通知+审计（同事务）", async () => {
    // 目标：种子任务 TSK-00005（负责人 pm，planning 3..12 相对日）
    const taskRow = (
      await query<{ id: string; planned_start: string; planned_end: string }>(
        `SELECT id, planned_start, planned_end FROM tasks WHERE code = $1`,
        [`TSK-${YEAR}-00005`],
      )
    )[0];

    const { crId } = await createAndSubmitChange(app, memberCookie, {
      projectId: projectAId,
      targetRefId: taskRow.id,
      level: "normal",
      idempotencyKey: crypto.randomUUID(),
    });
    const submitted = await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" });
    const cr = (submitted.json as { result: { data: { approvalInstanceId: string; status: string } } }).result.data;
    expect(cr.status).toBe("pending_approval");
    expect(cr.approvalInstanceId).toBeTruthy();

    // 审批人（normal → 项目负责人 pm）收到 approval_pending
    const pmNotices = await trpc(app, "notification.listMine", { cookie: pmCookie, method: "GET" });
    const pendingNotice = (
      (pmNotices.json as { result: { data: { items: { eventType: string; sourceId: string }[] } } }).result.data.items
    ).find((n) => n.eventType === "approval_pending" && n.sourceId === crId);
    expect(pendingNotice).toBeDefined();

    // 引擎终审通过（normal 单步）
    const acted = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: cr.approvalInstanceId, stepSeq: 1, action: "approve" },
    });
    expect(acted.status).toBe(200);

    // 业务落地断言（全部同事务完成）
    const after = (
      await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })
    ).json as {
      result: {
        data: { status: string; resultingPlanVersionId: string | null; decidedAt: string | null };
      };
    };
    expect(after.result.data.status).toBe("approved");
    expect(after.result.data.resultingPlanVersionId).toBeTruthy();

    const versions = await query<{ version_no: number; status: string; kind: string }>(
      `SELECT version_no, status, kind FROM plan_versions WHERE project_id = $1 ORDER BY version_no`,
      [projectAId],
    );
    expect(versions.map((v) => v.version_no)).toEqual([1, 2]);
    expect(versions[0].status).toBe("superseded");
    expect(versions[1]).toMatchObject({ status: "active", kind: "change" });

    const liveTask = (
      await query<{ planned_start: string; planned_end: string }>(
        `SELECT planned_start, planned_end FROM tasks WHERE id = $1`,
        [taskRow.id],
      )
    )[0];
    expect(dayOf(liveTask.planned_start)).not.toBe(dayOf(taskRow.planned_start));

    const recovery = await query<{ code: string; title: string; source_type: string }>(
      `SELECT code, title, source_type FROM tasks WHERE source_type = 'change_request' AND source_id = $1`,
      [crId],
    );
    expect(recovery).toHaveLength(1);
    expect(recovery[0].title).toContain("恢复措施");

    // 新版本 items 齐备（旧 15 条全量复制 + 依赖重映射到本版 id）
    const items = await query<{ depends_on: string[] }>(
      `SELECT depends_on FROM plan_items WHERE plan_version_id = $1`,
      [after.result.data.resultingPlanVersionId!],
    );
    expect(items.length).toBeGreaterThanOrEqual(15);

    // 申请人收到 approval_result；恢复责任人收到任务通知
    const memberNotices = await trpc(app, "notification.listMine", { cookie: memberCookie, method: "GET" });
    const noticeTypes = (
      (memberNotices.json as { result: { data: { items: { eventType: string }[] } } }).result.data.items
    ).map((n) => n.eventType);
    expect(noticeTypes).toContain("approval_result");

    // 审计留痕（变更类中间件）
    const audits = await query<{ action: string; actor_id: string | null }>(
      `SELECT action, actor_id FROM audit_events WHERE action IN ('change.create', 'change.submit')`,
    );
    expect(audits.map((a) => a.action)).toContain("change.submit");
    expect(audits.find((a) => a.action === "change.submit")?.actor_id).toBeTruthy();
  });

  it("并发 approve 同步骤只生效一次", async () => {
    const { crId, submitted } = await createAndSubmitChange(app, memberCookie, {
      projectId: projectAId,
      targetRefId: (
        await query<{ id: string }>(`SELECT id FROM tasks WHERE code = $1`, [`TSK-${YEAR}-00006`])
      )[0].id,
      level: "normal",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(submitted.status).toBe(200);
    const cr = (
      (
        await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })
      ).json as { result: { data: { approvalInstanceId: string } } }
    ).result.data;

    const [first, second] = await Promise.all([
      trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId: cr.approvalInstanceId, stepSeq: 1, action: "approve" },
      }),
      trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId: cr.approvalInstanceId, stepSeq: 1, action: "approve" },
      }),
    ]);
    expect([first.status, second.status]).toContain(200);
    const appliedCount = [first, second].filter(
      (r) => (r.json as { result?: { data?: { applied?: boolean } } }).result?.data?.applied === true,
    ).length;
    expect(appliedCount).toBeLessThanOrEqual(1);

    const instance = await query<{ status: string }>(
      `SELECT status FROM approval_instances WHERE id = $1`,
      [cr.approvalInstanceId],
    );
    expect(instance[0].status).toBe("approved");
  });

  it("同幂等键重复 submit 返回原实例", async () => {
    const key = crypto.randomUUID();
    const target = (
      await query<{ id: string }>(`SELECT id FROM tasks WHERE code = $1`, [`TSK-${YEAR}-00008`])
    )[0].id;
    const first = await createAndSubmitChange(app, memberCookie, {
      projectId: projectAId,
      targetRefId: target,
      level: "normal",
      idempotencyKey: key,
    });
    expect(first.submitted.status).toBe(200);
    const firstInstance = (
      (
        await trpc(app, "change.getById", { cookie: memberCookie, input: { id: first.crId }, method: "GET" })
      ).json as { result: { data: { approvalInstanceId: string } } }
    ).result.data.approvalInstanceId;

    // 撤回（回 draft）后用同键重提 → 引擎返回原实例（幂等键语义）
    const cr = (
      (
        await trpc(app, "change.getById", { cookie: memberCookie, input: { id: first.crId }, method: "GET" })
      ).json as { result: { data: { rowVersion: number } } }
    ).result.data;
    const withdrawn = await trpc(app, "change.withdraw", {
      cookie: memberCookie,
      input: { id: first.crId, rowVersion: cr.rowVersion },
    });
    expect(withdrawn.status).toBe(200);

    const resubmitted = await createAndSubmitChange(app, memberCookie, {
      projectId: projectAId,
      targetRefId: target,
      level: "normal",
      idempotencyKey: key,
    });
    const replay = (
      (
        await trpc(app, "change.getById", { cookie: memberCookie, input: { id: resubmitted.crId }, method: "GET" })
      ).json as { result: { data: { approvalInstanceId: string } } }
    ).result.data;
    expect(replay.approvalInstanceId).toBe(firstInstance);
  });

  it("自审拦截：申请人即审批人 → SELF_APPROVAL_BLOCKED", async () => {
    const target = (
      await query<{ id: string }>(`SELECT id FROM tasks WHERE code = $1`, [`TSK-${YEAR}-00007`])
    )[0].id;
    // pm 是项目 A 负责人（normal 级审批人=项目负责人=申请人本人）
    const created = await trpc(app, "change.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        title: "负责人自审探测",
        level: "normal",
        targetItems: [
          {
            ref_id: target,
            item_type: "task" as const,
            new_start: "2027-01-10",
            new_end: "2027-01-20",
          },
        ],
        reason: "自审拦截测试原因",
        impact: "自审拦截测试影响",
        recoveryMeasures: [
          { measure: "恢复措施", owner_id: memberId, checkpoint_date: "2027-01-12" },
        ],
      },
    });
    expect(created.status).toBe(200);
    const crId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const current = (
      (
        await trpc(app, "change.getById", { cookie: pmCookie, input: { id: crId }, method: "GET" })
      ).json as { result: { data: { rowVersion: number } } }
    ).result.data;
    const submitted = await trpc(app, "change.submit", {
      cookie: pmCookie,
      input: { id: crId, rowVersion: current.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(submitted.status).toBe(403);
    expect(trpcError(submitted).businessCode).toBe("SELF_APPROVAL_BLOCKED");
  });

  it("驳回必填理由；key 级走管理层（partner）", async () => {
    const target = (
      await query<{ id: string }>(`SELECT id FROM tasks WHERE code = $1`, [`TSK-${YEAR}-00008`])
    )[0].id;
    const { crId } = await createAndSubmitChange(app, memberCookie, {
      projectId: projectAId,
      targetRefId: target,
      level: "key",
      idempotencyKey: crypto.randomUUID(),
    });
    const cr = (
      (
        await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })
      ).json as { result: { data: { approvalInstanceId: string } } }
    ).result.data;

    // 普通成员不是 key 级审批人（partner）
    const notApprover = await trpc(app, "approval.act", {
      cookie: memberCookie,
      input: { instanceId: cr.approvalInstanceId, stepSeq: 1, action: "approve" },
    });
    expect(notApprover.status).toBe(404);

    const partnerCookie = (await loginAs(app, "partner@lexflow.demo")).cookie;
    const rejectNoReason = await trpc(app, "approval.act", {
      cookie: partnerCookie,
      input: { instanceId: cr.approvalInstanceId, stepSeq: 1, action: "reject" },
    });
    expect(rejectNoReason.status).toBe(400);
    expect(trpcError(rejectNoReason).businessCode).toBe("VALIDATION_FAILED");

    const rejected = await trpc(app, "approval.act", {
      cookie: partnerCookie,
      input: { instanceId: cr.approvalInstanceId, stepSeq: 1, action: "reject", comment: "材料不足，退回补充" },
    });
    expect(rejected.status).toBe(200);
    const after = (
      (
        await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })
      ).json as { result: { data: { status: string } } }
    ).result.data;
    expect(after.status).toBe("rejected");
  });

  it("事务回滚：handler 异常 → 无部分写入（实例仍 pending、无新版本、live 未动）", async () => {
    const targetRow = (
      await query<{ id: string; planned_start: string }>(`SELECT id, planned_start FROM tasks WHERE code = $1`, [
        `TSK-${YEAR}-00006`,
      ])
    )[0];
    const { crId } = await createAndSubmitChange(app, memberCookie, {
      projectId: projectAId,
      targetRefId: targetRow.id,
      level: "normal",
      idempotencyKey: crypto.randomUUID(),
    });
    const cr = (
      (
        await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })
      ).json as { result: { data: { approvalInstanceId: string } } }
    ).result.data;

    const unregister = registerHandler("change_request", {
      async onApproved(): Promise<void> {
        throw new Error("人为制造：handler 失败（回滚测试）");
      },
      async onRejected(): Promise<void> {
        /* noop */
      },
      async onWithdrawn(): Promise<void> {
        /* noop */
      },
    });
    let instanceId = "";
    try {
      const failed = await trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId: cr.approvalInstanceId, stepSeq: 1, action: "approve" },
      });
      expect(failed.status).toBe(500);
      instanceId = cr.approvalInstanceId;
    } finally {
      unregister();
    }

    // 断言整体回滚：无任何部分写入
    const instance = await query<{ status: string }>(
      `SELECT status FROM approval_instances WHERE id = $1`,
      [instanceId],
    );
    expect(instance[0].status).toBe("pending");
    const crAfter = await query<{ status: string; resulting_plan_version_id: string | null }>(
      `SELECT status, resulting_plan_version_id FROM change_requests WHERE id = $1`,
      [crId],
    );
    expect(crAfter[0].status).toBe("pending_approval");
    expect(crAfter[0].resulting_plan_version_id).toBeNull();
    const liveAfter = await query<{ planned_start: string }>(`SELECT planned_start FROM tasks WHERE id = $1`, [
      targetRow.id,
    ]);
    expect(dayOf(liveAfter[0].planned_start)).toBe(dayOf(targetRow.planned_start));
    const recovery = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'change_request' AND source_id = $1`,
      [crId],
    );
    expect(recovery[0].n).toBe(0);

    // 修复后重放同一审批 → 成功
    const replay = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: instanceId, stepSeq: 1, action: "approve" },
    });
    expect(replay.status).toBe(200);
    const crFinal = await query<{ status: string }>(`SELECT status FROM change_requests WHERE id = $1`, [crId]);
    expect(crFinal[0].status).toBe("approved");
  });

  it("plan.simulate 只算不写：级联顺移 + 项目完成日变化", async () => {
    const stage2 = (
      await query<{ id: string; planned_start: string }>(`SELECT id, planned_start::text FROM stages WHERE code = $1`, [
        `STG-${YEAR}-00002`,
      ])
    )[0];
    const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const futureEnd = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const sim = await trpc(app, "plan.simulate", {
      cookie: pmCookie,
      method: "GET",
      input: {
        projectId: projectAId,
        adjustments: [
          { ref_id: stage2.id, item_type: "stage", new_start: future, new_end: futureEnd },
        ],
      },
    });
    expect(sim.status).toBe(200);
    const data = (sim.json as { result: { data: { items: { cascaded: boolean }[]; projectEndDeltaDays: number } } })
      .result.data;
    expect(data.items.some((i) => i.cascaded)).toBe(true);
    expect(data.projectEndDeltaDays).toBeGreaterThan(0);

    // 只算不写：live 未动
    const liveAfter = await query<{ planned_start: string }>(`SELECT planned_start FROM stages WHERE id = $1`, [
      stage2.id,
    ]);
    expect(dayOf(liveAfter[0].planned_start)).toBe(dayOf(stage2.planned_start));
  });
});
