import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb, db } from "../../src/db/client";
import { notify } from "../../src/modules/notify";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 2 验收套件·结转硬项（arch/05 §9，独立验收断言）：
 * N4 act 幂等键（同键 200+applied=false / 推进后重放 / 异键 409）、
 * grant 驳回落 rejected 态、通知聚合键并发不双行、会签 all（全员通过/任一驳回/并发安全）。
 * 与后端 carryover-n4 自测互补：同一裁定口径的验收级独立取证。
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

/** member 提交一件 normal 级延期并返回实例 id */
async function submitChangeFor(
  app: Awaited<ReturnType<typeof getApp>>,
  memberCookie: string,
  projectAId: string,
  taskCode: string,
): Promise<{ crId: string; instanceId: string }> {
  const target = (await query<{ id: string }>(`SELECT id FROM tasks WHERE code = $1`, [taskCode]))[0];
  const created = await trpc(app, "change.create", {
    cookie: memberCookie,
    input: {
      projectId: projectAId,
      title: `结转验收 ${taskCode}`,
      level: "normal",
      targetItems: [{ ref_id: target.id, item_type: "task", new_start: "2027-12-01", new_end: "2027-12-09" }],
      reason: "结转验收", impact: "结转验收",
      recoveryMeasures: [
        { measure: "恢复", owner_id: await meId(app, memberCookie), checkpoint_date: "2027-12-02" },
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
  const after = (
    (await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })).json as {
      result: { data: { approvalInstanceId: string } };
    }
  ).result.data;
  return { crId, instanceId: after.approvalInstanceId };
}

describe("迭代 2 验收·结转硬项（arch/05 §9）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let partnerCookie: string;
  let financeCookie: string;
  let viewerCookie: string;
  let archivistCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    viewerCookie = (await loginAs(app, "hejing@lexflow.demo")).cookie;
    archivistCookie = (await loginAs(app, "wangying@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    projectAId = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("N4 同键重放 200+applied=false（终态后顺序重放）；推进后同键重放 200；异键重放 409", async () => {
    // ① 单步实例：首效 → 同键顺序重放 200 applied=false → 异键重放 409
    const { instanceId } = await submitChangeFor(app, memberCookie, projectAId, `TSK-${YEAR}-00006`);
    const key = crypto.randomUUID();
    const first = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: key },
    });
    expect(first.status).toBe(200);
    expect((first.json as { result: { data: { applied: boolean } } }).result.data.applied).toBe(true);

    const replay = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: key },
    });
    expect(replay.status).toBe(200);
    expect((replay.json as { result: { data: { applied: boolean } } }).result.data.applied).toBe(false);

    const foreign = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(foreign.status).toBe(409);
    expect(trpcError(foreign).businessCode).toBe("STATE_CONFLICT");

    // ② 两步实例：步骤推进后同键重放仍 200 applied=false（N4 修复点）
    const travel = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        reason: "N4 推进后重放",
        destination: "重庆",
        startOn: "2027-12-10",
        endOn: "2027-12-11",
        estimatedCostCents: 5_000_000,
        segments: [{ seq: 1, type: "transport", startAt: "2027-12-10T01:00:00.000Z", endAt: "2027-12-10T05:00:00.000Z" }],
      },
    });
    const travelId = (travel.json as { result: { data: { id: string } } }).result.data.id;
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
    const twoStepInstance = (after.json as { result: { data: { approvalInstanceId: string } } }).result.data
      .approvalInstanceId;
    const stepKey = crypto.randomUUID();
    const step1 = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: twoStepInstance, stepSeq: 1, action: "approve", idempotencyKey: stepKey },
    });
    expect(step1.status).toBe(200);
    const lateReplay = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: twoStepInstance, stepSeq: 1, action: "approve", idempotencyKey: stepKey },
    });
    expect(lateReplay.status).toBe(200);
    expect((lateReplay.json as { result: { data: { applied: boolean } } }).result.data.applied).toBe(false);
  });

  it("grant 驳回落 rejected 终态：不置 revoke 痕迹，授权不可用", async () => {
    const viewerId = await meId(app, viewerCookie);
    const applied = await trpc(app, "archive.grantApply", {
      cookie: viewerCookie,
      input: {
        scopeType: "project",
        scopeId: projectAId,
        granteeId: viewerId,
        actions: ["project.read", "archive.read"],
        expiresAt: null,
        reason: "结转验收：驳回路径",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(applied.status).toBe(200);
    const grantId = (applied.json as { result: { data: { grant: { id: string } } } }).result.data.grant.id;
    const instanceId = (applied.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;

    const rejected = await trpc(app, "approval.act", {
      cookie: archivistCookie,
      input: { instanceId, stepSeq: 1, action: "reject", comment: "范围过大，驳回（验收）", idempotencyKey: crypto.randomUUID() },
    });
    expect(rejected.status).toBe(200);

    const grant = await query<{ status: string; revoked_at: string | null; revoke_reason: string | null }>(
      `SELECT status, revoked_at, revoke_reason FROM access_grants WHERE id = $1`,
      [grantId],
    );
    expect(grant[0].status).toBe("rejected"); // 非 revoked
    expect(grant[0].revoked_at).toBeNull();
    expect(grant[0].revoke_reason).toBeNull();

    // rejected 不可再撤销（终态）
    const revoke = await trpc(app, "archive.grantRevoke", {
      cookie: archivistCookie,
      input: { id: grantId, reason: "尝试撤销已驳回" },
    });
    expect(revoke.status).toBe(409);

    // 授权不可用：viewer 仍不见项目 A
    const viewerList = await trpc(app, "project.list", { cookie: viewerCookie, method: "GET" });
    expect(
      (viewerList.json as { result: { data: { items: { code: string }[] } } }).result.data.items.map((p) => p.code),
    ).not.toContain(`PRJ-${YEAR}-00001`);
  });

  it("通知聚合键唯一索引：并发写入不双行；裸插同键必败（索引在位）", async () => {
    const memberId = await meId(app, memberCookie);
    await db.transaction(async (tx) => {
      await Promise.all([
        notify(tx, { eventType: "action_item_due", recipientId: memberId, sourceType: "meeting", sourceId: projectAId, payload: { probe: "a" } }),
        notify(tx, { eventType: "action_item_due", recipientId: memberId, sourceType: "meeting", sourceId: projectAId, payload: { probe: "b" } }),
        notify(tx, { eventType: "action_item_due", recipientId: memberId, sourceType: "meeting", sourceId: projectAId, payload: { probe: "c" } }),
      ]);
    });
    const day = new Date().toISOString().slice(0, 10);
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1 AND aggregate_key = $2`,
      [memberId, `action_item_due:${projectAId}:${day}`],
    );
    expect(rows[0].n).toBe(1);

    // 裸插同键必败（ON CONFLICT 之外的直接插入被唯一索引拒绝）
    const raw = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await raw.connect();
    let failed = false;
    try {
      await raw.query(
        `INSERT INTO notifications (recipient_id, event_type, source_type, source_id, aggregate_key)
         VALUES ($1, 'action_item_due', 'meeting', $2, $3)`,
        [memberId, projectAId, `action_item_due:${projectAId}:${day}`],
      );
    } catch {
      failed = true;
    } finally {
      await raw.end();
    }
    expect(failed).toBe(true);
  });

  it("会签 all：全员通过才生效；任一驳回即终态；同子步并发双批恰一生效；同角色他人不可代审", async () => {
    const liuchangId = (await query<{ id: string }>(`SELECT id FROM users WHERE email = 'zhangchen@lexflow.demo'`))[0].id;
    await query(`INSERT INTO user_roles (user_id, role_key) VALUES ($1, 'finance') ON CONFLICT DO NOTHING`, [liuchangId]);
    try {
      const liuchangCookie = (await loginAs(app, "zhangchen@lexflow.demo")).cookie;

      // 全员通过才生效
      const created = await trpc(app, "travel.create", {
        cookie: memberCookie,
        input: {
          projectId: projectAId,
          reason: "会签验收·全员通过",
          destination: "深圳",
          startOn: "2027-12-15",
          endOn: "2027-12-16",
          borrow: true,
          borrowAmountCents: 80000,
          segments: [{ seq: 1, type: "transport", startAt: "2027-12-15T01:00:00.000Z", endAt: "2027-12-15T05:00:00.000Z" }],
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
      const d2 = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
      const instanceId = (d2.json as { result: { data: { approvalInstanceId: string } } }).result.data.approvalInstanceId;
      await trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      const approval = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: instanceId }, method: "GET" });
      const steps = (approval.json as {
        result: { data: { steps: { seq: number; approverId: string | null }[] } };
      }).result.data.steps;
      const subSteps = steps.filter((s) => s.seq >= 2000);
      expect(subSteps.map((s) => s.seq).sort()).toEqual([2001, 2002]);
      // 子步按 approverId 匹配（不假设 2001/2002 分配顺序）
      const financeId = (await query<{ id: string }>(`SELECT id FROM users WHERE email = 'guojingwen@lexflow.demo'`))[0].id;
      const zhangchenId = (await query<{ id: string }>(`SELECT id FROM users WHERE email = 'zhangchen@lexflow.demo'`))[0].id;
      const financeStep = subSteps.find((s) => s.approverId === financeId)!.seq;
      const zhangchenStep = subSteps.find((s) => s.approverId === zhangchenId)!.seq;

      // 同子步并发双批恰一生效
      const [x, y] = await Promise.all([
        trpc(app, "approval.act", {
          cookie: financeCookie,
          input: { instanceId, stepSeq: financeStep, action: "approve", idempotencyKey: crypto.randomUUID() },
        }),
        trpc(app, "approval.act", {
          cookie: financeCookie,
          input: { instanceId, stepSeq: financeStep, action: "approve", idempotencyKey: crypto.randomUUID() },
        }),
      ]);
      const appliedCount = [x, y].filter(
        (r) => r.status === 200 && (r.json as { result: { data: { applied: boolean } } }).result.data.applied,
      ).length;
      expect(appliedCount).toBe(1);

      // 另一候选人补齐 → 全员通过生效
      await trpc(app, "approval.act", {
        cookie: liuchangCookie,
        input: { instanceId, stepSeq: zhangchenStep, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      const done = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [instanceId]);
      expect(done[0].status).toBe("approved");
      const travel = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId }, method: "GET" });
      expect((travel.json as { result: { data: { status: string } } }).result.data.status).toBe("approved");

      // 同角色他人不可代审：finance 步对 pm 同形 404
      const created2 = await trpc(app, "travel.create", {
        cookie: memberCookie,
        input: {
          projectId: projectAId,
          reason: "会签验收·防代审",
          destination: "深圳",
          startOn: "2027-12-18",
          endOn: "2027-12-19",
          borrow: true,
          borrowAmountCents: 60000,
          segments: [{ seq: 1, type: "transport", startAt: "2027-12-18T01:00:00.000Z", endAt: "2027-12-18T05:00:00.000Z" }],
        },
      });
      const travelId2 = (created2.json as { result: { data: { id: string } } }).result.data.id;
      const detail2 = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId2 }, method: "GET" });
      await trpc(app, "travel.submit", {
        cookie: memberCookie,
        input: {
          id: travelId2,
          rowVersion: (detail2.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      const d3 = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId2 }, method: "GET" });
      const instanceId2 = (d3.json as { result: { data: { approvalInstanceId: string } } }).result.data.approvalInstanceId;
      await trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId: instanceId2, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      const steps2 = (await query<{ seq: number; approver_id: string }>(
        `SELECT seq, approver_id FROM approval_steps WHERE instance_id = $1 AND seq >= 2000`, [instanceId2],
      ));
      const financeStep2 = steps2.find((st) => st.approver_id === financeId)!.seq;
      const proxy = await trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId: instanceId2, stepSeq: financeStep2, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      expect(proxy.status).toBe(404);

      // 任一驳回即终态
      const rejected = await trpc(app, "approval.act", {
        cookie: financeCookie,
        input: { instanceId: instanceId2, stepSeq: financeStep2, action: "reject", comment: "借款额度不足（验收）", idempotencyKey: crypto.randomUUID() },
      });
      expect(rejected.status).toBe(200);
      const terminal = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [instanceId2]);
      expect(terminal[0].status).toBe("rejected");
      const travel2 = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId2 }, method: "GET" });
      expect((travel2.json as { result: { data: { status: string } } }).result.data.status).toBe("rejected");
      const notices = await trpc(app, "notification.listMine", { cookie: memberCookie, method: "GET" });
      const items = (notices.json as { result: { data: { items: { eventType: string; sourceId: string }[] } } })
        .result.data.items;
      expect(items.some((n) => n.eventType === "travel_approval" && n.sourceId === travelId2)).toBe(true);
    } finally {
      await query(`DELETE FROM user_roles WHERE user_id = $1 AND role_key = 'finance'`, [liuchangId]);
    }
  });
});
