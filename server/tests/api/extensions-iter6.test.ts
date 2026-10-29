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

/** 对当前步执行一次 approve（多步链由调用方按角色顺序推进） */
async function approveCurrent(
  app: Awaited<ReturnType<typeof getApp>>,
  actorCookie: string,
  instanceId: string,
): Promise<void> {
  const detail = await trpc(app, "approval.getById", { cookie: actorCookie, input: { id: instanceId }, method: "GET" });
  const instance = (detail.json as { result: { data: { status: string; currentStepSeq: number } } }).result.data;
  if (instance.status !== "pending") return;
  const acted = await trpc(app, "approval.act", {
    cookie: actorCookie,
    input: { instanceId, stepSeq: instance.currentStepSeq, action: "approve", idempotencyKey: crypto.randomUUID() },
  });
  expect(acted.status).toBe(200);
}

describe("迭代 6 扩展域（E1–E8）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let financeCookie: string;
  let partnerCookie: string;
  let sysadminCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "finance@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "partner@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "sysadmin@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    projectAId = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("E1 收款：登记/作废冲正不删行；口径=registered−voided；权限矩阵；导出审计", async () => {
    // 种子口径：A=500k+300k−200k=600k
    const seedSummary = await trpc(app, "receipts.summary", { cookie: financeCookie, method: "GET", input: { by: "project" } });
    const aRow = (seedSummary.json as { result: { data: { items: { key: string; netCents: number; voidedCents: number }[] } } })
      .result.data.items.find((i) => i.key === projectAId);
    expect(aRow).toMatchObject({ netCents: 600_000, voidedCents: 200_000 });

    // 登记（finance）；member 被拒
    const denied = await trpc(app, "receipts.create", {
      cookie: memberCookie,
      input: { projectId: projectAId, amountCents: 100_000, receivedOn: "2027-10-01", referenceNo: "X", idempotencyKey: crypto.randomUUID() },
    });
    expect(denied.status).toBe(404);
    const created = await trpc(app, "receipts.create", {
      cookie: financeCookie,
      input: {
        projectId: projectAId,
        amountCents: 150_000,
        receivedOn: "2027-10-02",
        referenceNo: `BANK-${Date.now()}`,
        payerName: "华宸贸易有限公司",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(created.status).toBe(200);

    // 作废冲正：理由必填；行保留（不删）；金额不可变（无 update 入口，void 后仍 registered 原额口径）
    // 口径：登记后 750k；冲正后 600k−150k=450k（voided 原额计入，冲正即更正口径）
    const midSummary = await trpc(app, "receipts.summary", { cookie: financeCookie, method: "GET", input: { by: "project" } });
    const aMid = (midSummary.json as { result: { data: { items: { key: string; netCents: number }[] } } })
      .result.data.items.find((i) => i.key === projectAId);
    expect(aMid?.netCents).toBe(750_000);

    const receiptId = (created.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;
    const noReason = await trpc(app, "receipts.void", { cookie: financeCookie, input: { id: receiptId, reason: "", rowVersion: 0 } });
    expect(noReason.status).toBe(400);
    const voided = await trpc(app, "receipts.void", { cookie: financeCookie, input: { id: receiptId, reason: "重复登记冲正", rowVersion: 0 } });
    expect(voided.status).toBe(200);
    const stillThere = await query<{ status: string; void_reason: string; amount_cents: number }>(
      `SELECT status, void_reason, amount_cents FROM payment_receipts WHERE id = $1`,
      [receiptId],
    );
    expect(stillThere[0].status).toBe("voided");
    expect(stillThere[0].void_reason).toBe("重复登记冲正");
    expect(Number(stillThere[0].amount_cents)).toBe(150_000);

    const afterSummary = await trpc(app, "receipts.summary", { cookie: financeCookie, method: "GET", input: { by: "project" } });
    const aAfter = (afterSummary.json as { result: { data: { items: { key: string; netCents: number }[] } } })
      .result.data.items.find((i) => i.key === projectAId);
    expect(aAfter?.netCents).toBe(450_000);

    // pm 本项目读 / member 不可见
    const pmList = await trpc(app, "receipts.list", { cookie: pmCookie, method: "GET", input: { projectId: projectAId } });
    expect(pmList.status).toBe(200);
    const memberList = await trpc(app, "receipts.list", { cookie: memberCookie, method: "GET", input: { projectId: projectAId } });
    expect(memberList.status).toBe(404);

    // 总览接入（pm 可见 receiptSummary；member 不见）
    const overview = await trpc(app, "project.overview", { cookie: pmCookie, method: "GET", input: { projectId: projectAId } });
    expect((overview.json as { result: { data: { receiptSummary: { netCents: number } | null } } }).result.data.receiptSummary?.netCents).toBe(450_000);

    // 导出审计
    const exported = await trpc(app, "receipts.exportCsv", { cookie: financeCookie, method: "GET", input: {} });
    expect((exported.json as { result: { data: { rowCount: number } } }).result.data.rowCount).toBeGreaterThanOrEqual(4);
    const audit = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'export.run' AND target_type = 'payment_receipt'`);
    expect(audit[0].n).toBeGreaterThanOrEqual(1);
  });

  it("E2/E5 流程设计器：建流程（条件+会签+角色）→ 发布 → 通用申请单走新流程（节点图进度）", async () => {
    // 建并发布 generic_request 全局流程（两审批节点：pm → partner；金额≥10万 追加 finance）
    const draft = await trpc(app, "flow.createDraft", {
      cookie: sysadminCookie,
      input: {
        name: "通用申请单标准流程",
        scope: "global",
        bizBinding: "generic_request",
        definitionJson: {
          nodes: [
            { id: "s", type: "start" },
            { id: "a1", type: "approval", label: "负责人审批", approver: { kind: "role", role: "project_manager" }, countersign: "any" },
            { id: "c1", type: "condition", label: "金额≥10万", expr: { field: "amount_cents", op: ">=", value: 1000000 } },
            { id: "a2", type: "approval", label: "财务复核", approver: { kind: "role", role: "finance" }, countersign: "all" },
            { id: "a3", type: "approval", label: "终审", approver: { kind: "role", role: "partner" }, countersign: "any" },
            { id: "e", type: "end" },
          ],
          edges: [
            { from: "s", to: "a1" },
            { from: "a1", to: "c1" },
            { from: "c1", to: "a2", when: true },
            { from: "a2", to: "a3" },
            { from: "c1", to: "a3", when: false },
            { from: "a3", to: "e" },
          ],
        },
      },
    });
    expect(draft.status).toBe(200);
    const flowId = (draft.json as { result: { data: { id: string } } }).result.data.id;
    const published = await trpc(app, "flow.publish", { cookie: sysadminCookie, input: { id: flowId, idempotencyKey: crypto.randomUUID() } });
    expect(published.status).toBe(200);
    // 发布幂等
    const republish = await trpc(app, "flow.publish", { cookie: sysadminCookie, input: { id: flowId, idempotencyKey: crypto.randomUUID() } });
    expect((republish.json as { result: { data: { published: boolean } } }).result.data.published).toBe(false);

    // 通用申请单：大额（≥10万）走 a1→a2→a3
    const req = await trpc(app, "genericRequest.create", {
      cookie: memberCookie,
      input: { requestType: "procurement", title: "采购办公设备", reason: "新工位配置", amountCents: 2_000_000 },
    });
    expect(req.status).toBe(200);
    const reqId = (req.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;
    const detail = await trpc(app, "genericRequest.getById", { cookie: memberCookie, input: { id: reqId }, method: "GET" });
    const submitted = await trpc(app, "genericRequest.submit", {
      cookie: memberCookie,
      input: { id: reqId, rowVersion: (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(submitted.status).toBe(200);
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;

    // 节点图进度：当前节点=负责人审批；policy_snapshot 存流程版本
    const inst = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: instanceId }, method: "GET" });
    const instData = (inst.json as {
      result: {
        data: {
          policySnapshot: { flowName?: string; flowVersion?: number };
          flowProgress: { flowName: string; currentNodeLabel: string; nodes: { label: string; status: string }[] } | null;
        };
      };
    }).result.data;
    expect(instData.policySnapshot.flowName).toBe("通用申请单标准流程");
    expect(instData.flowProgress?.currentNodeLabel).toBe("负责人审批");
    expect(instData.flowProgress?.nodes.map((n) => n.label)).toEqual(["负责人审批", "财务复核", "终审"]);

    // 走链：pm → finance → partner → approved
    await approveCurrent(app, pmCookie, instanceId);
    await approveCurrent(app, financeCookie, instanceId);
    await approveCurrent(app, partnerCookie, instanceId);
    const final = await trpc(app, "genericRequest.getById", { cookie: memberCookie, input: { id: reqId }, method: "GET" });
    expect((final.json as { result: { data: { status: string } } }).result.data.status).toBe("approved");
  });

  it("E3 非法形态被拒：环/悬空/条件单边 → FLOW_INVALID；审批人零用户 → FLOW_UNPUBLISHABLE", async () => {
    const cycle = await trpc(app, "flow.createDraft", {
      cookie: sysadminCookie,
      input: {
        name: "环流程",
        scope: "global",
        bizBinding: "generic_request",
        definitionJson: {
          nodes: [
            { id: "s", type: "start" },
            { id: "a", type: "approval", label: "A", approver: { kind: "role", role: "partner" } },
            { id: "e", type: "end" },
          ],
          edges: [
            { from: "s", to: "a" },
            { from: "a", to: "a" },
            { from: "a", to: "e" },
          ],
        },
      },
    });
    expect(cycle.status).toBe(400);
    expect(trpcError(cycle).businessCode).toBe("VALIDATION_FAILED"); // FLOW_INVALID→BAD_REQUEST 字段级

    const dangling = await trpc(app, "flow.createDraft", {
      cookie: sysadminCookie,
      input: {
        name: "悬空流程",
        scope: "global",
        bizBinding: "generic_request",
        definitionJson: {
          nodes: [
            { id: "s", type: "start" },
            { id: "a", type: "approval", label: "A", approver: { kind: "role", role: "partner" } },
            { id: "lost", type: "approval", label: "不可达", approver: { kind: "role", role: "partner" } },
            { id: "e", type: "end" },
          ],
          edges: [
            { from: "s", to: "a" },
            { from: "a", to: "e" },
          ],
        },
      },
    });
    expect(dangling.status).toBe(400);

    const oneSided = await trpc(app, "flow.createDraft", {
      cookie: sysadminCookie,
      input: {
        name: "单边条件流程",
        scope: "global",
        bizBinding: "generic_request",
        definitionJson: {
          nodes: [
            { id: "s", type: "start" },
            { id: "c", type: "condition", label: "C", expr: { field: "amount_cents", op: ">=", value: 1 } },
            { id: "a", type: "approval", label: "A", approver: { kind: "role", role: "partner" } },
            { id: "e", type: "end" },
          ],
          edges: [
            { from: "s", to: "c" },
            { from: "c", to: "a", when: true },
            { from: "a", to: "e" },
          ],
        },
      },
    });
    expect(oneSided.status).toBe(400);

    // 幽灵角色（零用户）→ 发布 FLOW_UNPUBLISHABLE(412)
    const ghost = await trpc(app, "flow.createDraft", {
      cookie: sysadminCookie,
      input: {
        name: "幽灵角色流程",
        scope: "global",
        bizBinding: "budget",
        definitionJson: {
          nodes: [
            { id: "s", type: "start" },
            { id: "a", type: "approval", label: "幽灵审批", approver: { kind: "role", role: "ghost_role" } },
            { id: "e", type: "end" },
          ],
          edges: [
            { from: "s", to: "a" },
            { from: "a", to: "e" },
          ],
        },
      },
    });
    expect(ghost.status).toBe(200); // 草稿可存
    const ghostId = (ghost.json as { result: { data: { id: string } } }).result.data.id;
    const publishGhost = await trpc(app, "flow.publish", { cookie: sysadminCookie, input: { id: ghostId, idempotencyKey: crypto.randomUUID() } });
    expect(publishGhost.status).toBe(412);
    expect(trpcError(publishGhost).businessCode).toBe("FLOW_UNPUBLISHABLE");
  });

  it("E4 既有 biz_type 兼容：延期走默认流程（policy_snapshot 带 flowName）+ 全程通过", async () => {
    const current = await trpc(app, "plan.current", { cookie: pmCookie, method: "GET", input: { projectId: projectAId } });
    const target = (current.json as { result: { data: { items: { itemType: string; refId: string }[] } } })
      .result.data.items.find((i) => i.itemType === "task")!;
    const created = await trpc(app, "change.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        title: "E4 兼容探测",
        level: "normal",
        targetItems: [{ ref_id: target.refId, item_type: "task", new_start: "2027-12-01", new_end: "2027-12-10" }],
        reason: "E4",
        impact: "E4",
        recoveryMeasures: [
          { measure: "恢复", owner_id: (await me(app, memberCookie)), checkpoint_date: "2027-12-02" },
        ],
      },
    });
    const crId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const cr = await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" });
    const submitted = await trpc(app, "change.submit", {
      cookie: memberCookie,
      input: { id: crId, rowVersion: (cr.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(submitted.status).toBe(200);
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const inst = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: instanceId }, method: "GET" });
    const snapshot = (inst.json as { result: { data: { policySnapshot: { flowName?: string } } } }).result.data.policySnapshot;
    expect(snapshot.flowName).toBeTruthy(); // 默认流程（change_request 默认）接管
    await approveCurrent(app, pmCookie, instanceId);
    const after = await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" });
    expect((after.json as { result: { data: { status: string } } }).result.data.status).toBe("approved");
  });

  it("E6/E7 admin 域与自助改密：建客户/事项立即可用；建用户首登强制改密；停用即失效；改密全会话失效", async () => {
    // 建客户+事项 → 立即可用于参照端点
    const client = await trpc(app, "admin.createClient", {
      cookie: sysadminCookie,
      input: { name: "云杉控股集团（虚构）", confidentialityLevel: "internal" },
    });
    expect(client.status).toBe(200);
    const clientId = (client.json as { result: { data: { id: string } } }).result.data.id;
    const matter = await trpc(app, "admin.createMatter", { cookie: sysadminCookie, input: { clientId, name: "云杉常年顾问", type: "非诉" } });
    expect(matter.status).toBe(200);
    const matters = await trpc(app, "matter.list", { cookie: pmCookie, method: "GET" });
    expect(
      (matters.json as { result: { data: { items: { id: string }[] } } }).result.data.items.some((m) => m.id === (matter.json as { result: { data: { id: string } } }).result.data.id),
    ).toBe(true);

    // 建用户：初始口令一次性下发；首登 me.mustChangePassword=true
    const created = await trpc(app, "admin.createUser", {
      cookie: sysadminCookie,
      input: { email: "newhire@lexflow.demo", name: "新员工", roleKey: "member" },
    });
    expect(created.status).toBe(200);
    const { initialPassword } = (created.json as { result: { data: { initialPassword: string } } }).result.data;
    expect(initialPassword.length).toBeGreaterThan(8);
    const first = await loginAs(app, "newhire@lexflow.demo", initialPassword);
    const me1 = await trpc(app, "auth.me", { cookie: first.cookie, method: "GET" });
    expect((me1.json as { result: { data: { mustChangePassword: boolean } } }).result.data.mustChangePassword).toBe(true);

    // 自助改密：验旧 + 全会话失效 + 标记清除
    const wrongOld = await trpc(app, "auth.changePassword", {
      cookie: first.cookie,
      input: { oldPassword: "wrong", newPassword: "NewPass2026!" },
    });
    expect(wrongOld.status).toBe(404);
    const changed = await trpc(app, "auth.changePassword", {
      cookie: first.cookie,
      input: { oldPassword: initialPassword, newPassword: "NewPass2026!" },
    });
    expect(changed.status).toBe(200);
    const afterChange = await trpc(app, "auth.me", { cookie: first.cookie, method: "GET" });
    expect(afterChange.status).toBe(401); // 全会话失效（含本会话）
    const relogin = await loginAs(app, "newhire@lexflow.demo", "NewPass2026!");
    const me2 = await trpc(app, "auth.me", { cookie: relogin.cookie, method: "GET" });
    expect((me2.json as { result: { data: { mustChangePassword: boolean } } }).result.data.mustChangePassword).toBe(false);

    // 停用即时失效
    await trpc(app, "admin.disableUser", { cookie: sysadminCookie, input: { userId: (me2.json as { result: { data: { user: { id: string } } } }).result.data.user.id } });
    const disabled = await trpc(app, "auth.me", { cookie: relogin.cookie, method: "GET" });
    expect(disabled.status).toBe(401);
    await trpc(app, "admin.enableUser", { cookie: sysadminCookie, input: { userId: (me2.json as { result: { data: { user: { id: string } } } }).result.data.user.id } });

    // config 白名单 + 前后值审计
    const badKey = await trpc(app, "admin.setConfig", { cookie: sysadminCookie, input: { key: "evil.key", value: {} } });
    expect(badKey.status).toBe(400);
    const set = await trpc(app, "admin.setConfig", {
      cookie: sysadminCookie,
      input: { key: "timesheet.validation", value: { dailyMaxMinutes: 1440, overDailyMax: "block", overlap: "remind", regularThresholdMinutes: 600, overRegularThreshold: "remind" } },
    });
    expect(set.status).toBe(200);
    const audit = await query<{ before_json: { value?: { regularThresholdMinutes?: number } }; after_json: { value?: { regularThresholdMinutes?: number } } }>(
      `SELECT before_json, after_json FROM audit_events WHERE action = 'admin.setConfig' AND after_json->>'key' = 'timesheet.validation' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit[0].after_json.value?.regularThresholdMinutes).toBe(600);
  });

  it("E8 权限：sysadmin 无业务内容权；member 不见收款与 /admin", async () => {
    const sysProject = await trpc(app, "project.getById", { cookie: sysadminCookie, input: { id: projectAId }, method: "GET" });
    expect(sysProject.status).toBe(404);
    const sysReceipts = await trpc(app, "receipts.summary", { cookie: sysadminCookie, method: "GET", input: { by: "project" } });
    expect(sysReceipts.status).toBe(404); // sysadmin 不在 finance/partner/成员范围
    const memberAdmin = await trpc(app, "admin.userList", { cookie: memberCookie, method: "GET" });
    expect(memberAdmin.status).toBe(404);
    const memberFlow = await trpc(app, "flow.list", { cookie: memberCookie, method: "GET" });
    expect(memberFlow.status).toBe(404);
  });
});

async function me(app: Awaited<ReturnType<typeof getApp>>, cookie: string): Promise<string> {
  const result = await trpc(app, "auth.me", { cookie, method: "GET" });
  return (result.json as { result: { data: { user: { id: string } } } }).result.data.user.id;
}
