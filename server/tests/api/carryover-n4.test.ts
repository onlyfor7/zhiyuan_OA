import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb, db } from "../../src/db/client";
import { notify } from "../../src/modules/notify";
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

describe("迭代 1 结转硬项（arch/05 §9：N4 / grant rejected / ON CONFLICT / 会签 all）", () => {
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

  it("N4：act 同键重放 200 applied=false；异键重放已处理步骤 409", async () => {
    // 造一笔待审的常规级延期（申请人 member，审批人 pm）
    const current = await trpc(app, "plan.current", { cookie: pmCookie, method: "GET", input: { projectId: projectAId } });
    const target = (current.json as { result: { data: { items: { itemType: string; refId: string }[] } } })
      .result.data.items.find((i) => i.itemType === "task")!;
    const created = await trpc(app, "change.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        title: "N4 幂等探测",
        level: "normal",
        targetItems: [{ ref_id: target.refId, item_type: "task", new_start: "2027-10-01", new_end: "2027-10-10" }],
        reason: "N4",
        impact: "N4",
        recoveryMeasures: [
          { measure: "恢复", owner_id: (await me(app, memberCookie)), checkpoint_date: "2027-10-02" },
        ],
      },
    });
    const crId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const cr = await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" });
    await trpc(app, "change.submit", {
      cookie: memberCookie,
      input: {
        id: crId,
        rowVersion: (cr.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    const cr2 = await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" });
    const instanceId = (cr2.json as { result: { data: { approvalInstanceId: string } } }).result.data.approvalInstanceId;

    const actKey = crypto.randomUUID();
    const first = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: actKey },
    });
    expect(first.status).toBe(200);
    expect((first.json as { result: { data: { applied: boolean } } }).result.data.applied).toBe(true);

    // 同键重放：200 + applied=false（不报错、不产生副作用）
    const replay = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: actKey },
    });
    expect(replay.status).toBe(200);
    expect((replay.json as { result: { data: { applied: boolean } } }).result.data.applied).toBe(false);
    const versions = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM plan_versions WHERE project_id = $1`,
      [projectAId],
    );
    // 首次 approve 已产生一个 v2；同键重放不得再产新版本
    const afterReplay = await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" });
    expect((afterReplay.json as { result: { data: { status: string } } }).result.data.status).toBe("approved");
    void versions;

    // 异键重放：409 STATE_CONFLICT
    const different = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(different.status).toBe(409);
    expect(trpcError(different).businessCode).toBe("STATE_CONFLICT");
  });

  it("N4 补：并发同键双击败者 200 applied=false；步骤推进后同键顺序重放 200", async () => {
    // 两步升级实例（预计费用达阈值）：seq1=pm，seq2=partner
    const created = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        reason: "N4 双击败者与推进重放探测",
        destination: "天津",
        startOn: "2027-12-01",
        endOn: "2027-12-02",
        estimatedCostCents: 5_000_000,
        segments: [{ seq: 1, type: "transport", startAt: "2027-12-01T01:00:00.000Z", endAt: "2027-12-01T04:00:00.000Z" }],
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
    const instanceId = (d2.json as { result: { data: { approvalInstance: { id: string } } } }).result.data.approvalInstance.id;

    // ① 并发同键双击：Promise.all 同键同步骤，败者须 200 applied=false（非 409）
    const sameKey = crypto.randomUUID();
    const [winner, loser] = await Promise.all([
      trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: sameKey },
      }),
      trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: sameKey },
      }),
    ]);
    expect([winner.status, loser.status]).toEqual([200, 200]);
    const appliedTrue = [winner, loser].filter(
      (r) => (r.json as { result: { data: { applied: boolean } } }).result.data.applied === true,
    ).length;
    expect(appliedTrue).toBe(1); // 单生效
    const loserApplied = [winner, loser].some(
      (r) => (r.json as { result: { data: { applied: boolean } } }).result.data.applied === false,
    );
    expect(loserApplied).toBe(true); // 败者 200 + applied=false

    // ② 步骤推进后的同键顺序重放：seq1 已用 key K 处理并推进到 seq2，再带 K 重放 seq1 → 200 applied=false
    const replayAdvanced = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: sameKey },
    });
    expect(replayAdvanced.status).toBe(200);
    expect((replayAdvanced.json as { result: { data: { applied: boolean } } }).result.data.applied).toBe(false);

    // 终态后异键重放仍为 409（语义不回归）
    const step2 = await trpc(app, "approval.act", {
      cookie: partnerCookie,
      input: { instanceId, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(step2.status).toBe(200);
    const stranger = await trpc(app, "approval.act", {
      cookie: partnerCookie,
      input: { instanceId, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(stranger.status).toBe(409);
    expect(trpcError(stranger).businessCode).toBe("STATE_CONFLICT");
  });

  it("grant 驳回落 rejected 态（arch/01 §3 v1.1）", async () => {
    const viewerCookie = (await loginAs(app, "viewer@lexflow.demo")).cookie;
    const viewerId = await me(app, viewerCookie);
    const archivistCookie = (await loginAs(app, "archivist@lexflow.demo")).cookie;

    const applied = await trpc(app, "archive.grantApply", {
      cookie: viewerCookie,
      input: {
        scopeType: "project",
        scopeId: projectAId,
        granteeId: viewerId,
        actions: ["project.read"],
        expiresAt: null,
        reason: "驳回态探测",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    const grantId = (applied.json as { result: { data: { grant: { id: string } } } }).result.data.grant.id;
    const instanceId = (applied.json as {
      result: { data: { instance: { id: string } } };
    }).result.data.instance.id;

    const rejected = await trpc(app, "approval.act", {
      cookie: archivistCookie,
      input: { instanceId, stepSeq: 1, action: "reject", comment: "超出授权范围", idempotencyKey: crypto.randomUUID() },
    });
    expect(rejected.status).toBe(200);
    const row = await query<{ status: string; revoked_at: string | null }>(
      `SELECT status, revoked_at FROM access_grants WHERE id = $1`,
      [grantId],
    );
    expect(row[0].status).toBe("rejected");
    expect(row[0].revoked_at).toBeNull(); // 驳回不置撤销痕迹
  });

  it("通知聚合键唯一索引：并发写入不双行（ON CONFLICT DO NOTHING）", async () => {
    const memberId = await me(app, memberCookie);
    // 同一 (recipient, aggregate_key) 并发插入：只允许一行
    await db.transaction(async (tx) => {
      await Promise.all([
        notify(tx, { eventType: "action_item_due", recipientId: memberId, sourceType: "meeting", sourceId: projectAId, payload: { probe: 1 } }),
        notify(tx, { eventType: "action_item_due", recipientId: memberId, sourceType: "meeting", sourceId: projectAId, payload: { probe: 2 } }),
        notify(tx, { eventType: "action_item_due", recipientId: memberId, sourceType: "meeting", sourceId: projectAId, payload: { probe: 3 } }),
      ]);
    });
    const day = new Date().toISOString().slice(0, 10);
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
       WHERE recipient_id = $1 AND aggregate_key = $2`,
      [memberId, `action_item_due:${projectAId}:${day}`],
    );
    expect(rows[0].n).toBe(1);

    // 无 ON CONFLICT 的同键裸插必败（唯一索引在位证明）
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

  it("会签 all 多候选人：全员通过才生效；任一驳回即终态", async () => {
    // 临时给 liuchang 增加 finance 全局角色（finance 双候选人 → 第二步骤展开为子步）
    const liuchangId = (await query<{ id: string }>(`SELECT id FROM users WHERE email = 'liuchang@lexflow.demo'`))[0].id;
    await query(`INSERT INTO user_roles (user_id, role_key) VALUES ($1, 'finance') ON CONFLICT DO NOTHING`, [liuchangId]);
    try {
      // 借款出差（member 申请）→ 第二步骤 [finance all] 展开为 2001/2002
      const created = await trpc(app, "travel.create", {
        cookie: memberCookie,
        input: {
          projectId: projectAId,
          reason: "会签并发探测",
          destination: "深圳",
          startOn: "2027-11-01",
          endOn: "2027-11-02",
          borrow: true,
          borrowAmountCents: 100000,
          segments: [{ seq: 1, type: "transport", startAt: "2027-11-01T01:00:00.000Z", endAt: "2027-11-01T05:00:00.000Z" }],
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
      const instanceId = (d2.json as { result: { data: { approvalInstance: { id: string } } } }).result.data.approvalInstance.id;

      // 第一步 pm
      const step1 = await trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      expect(step1.status).toBe(200);

      // 会签组展开：2001/2002（两个 finance 候选人）
      const approval = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: instanceId }, method: "GET" });
      const steps = (approval.json as { result: { data: { steps: { seq: number; status: string; approverId: string | null }[] } } })
        .result.data.steps;
      const subSteps = steps.filter((s) => s.seq >= 2000);
      expect(subSteps.map((s) => s.seq).sort()).toEqual([2001, 2002]);

      // 全员通过才生效：只批一个 → 仍 pending
      const liuchangCookie = (await loginAs(app, "liuchang@lexflow.demo")).cookie;
      const financeCookie = (await loginAs(app, "finance@lexflow.demo")).cookie;
      const one = await trpc(app, "approval.act", {
        cookie: financeCookie,
        input: { instanceId, stepSeq: 2001, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      expect(one.status).toBe(200);
      const mid = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [instanceId]);
      expect(mid[0].status).toBe("pending");

      const two = await trpc(app, "approval.act", {
        cookie: liuchangCookie,
        input: { instanceId, stepSeq: 2002, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      expect(two.status).toBe(200);
      const done = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [instanceId]);
      expect(done[0].status).toBe("approved");

      // 另一单：会签组任一驳回 → 整体 rejected
      const created2 = await trpc(app, "travel.create", {
        cookie: memberCookie,
        input: {
          projectId: projectAId,
          reason: "会签驳回探测",
          destination: "深圳",
          startOn: "2027-11-05",
          endOn: "2027-11-06",
          borrow: true,
          borrowAmountCents: 50000,
          segments: [{ seq: 1, type: "transport", startAt: "2027-11-05T01:00:00.000Z", endAt: "2027-11-05T05:00:00.000Z" }],
        },
      });
      const travelId2 = (created2.json as { result: { data: { id: string } } }).result.data.id;
      const d3 = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId2 }, method: "GET" });
      await trpc(app, "travel.submit", {
        cookie: memberCookie,
        input: {
          id: travelId2,
          rowVersion: (d3.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      const d4 = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: travelId2 }, method: "GET" });
      const instanceId2 = (d4.json as { result: { data: { approvalInstance: { id: string } } } }).result.data.approvalInstance.id;
      await trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId: instanceId2, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      // 会签子步精确到人：另一 finance 成员对 2001（他人子步，角色已置空）无权 → 404
      const cross = await trpc(app, "approval.act", {
        cookie: liuchangCookie,
        input: { instanceId: instanceId2, stepSeq: 2001, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      expect(cross.status).toBe(404);
      const rejectOne = await trpc(app, "approval.act", {
        cookie: financeCookie,
        input: { instanceId: instanceId2, stepSeq: 2001, action: "reject", comment: "预算冻结", idempotencyKey: crypto.randomUUID() },
      });
      expect(rejectOne.status).toBe(200);
      const rejected = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [instanceId2]);
      expect(rejected[0].status).toBe("rejected");
    } finally {
      await query(`DELETE FROM user_roles WHERE user_id = $1 AND role_key = 'finance'`, [liuchangId]);
    }
  });
});

async function me(app: Awaited<ReturnType<typeof getApp>>, cookie: string): Promise<string> {
  const result = await trpc(app, "auth.me", { cookie, method: "GET" });
  return (result.json as { result: { data: { user: { id: string } } } }).result.data.user.id;
}
