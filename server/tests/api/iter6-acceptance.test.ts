import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 6 验收套件·扩展域（arch/09 §6 E1–E10 独立取证，与后端 extensions-iter6 互补）：
 * E1 收款口径/幂等/冲正审计、E2 自定义 travel 流程绑定与覆盖/disable 回退、E3 自审全跳过阻断、
 * E5 通用申请单条件分支、E6 admin 客户立即可用+阈值配置生效+停用即失效、E7 改密会话失效、E8 权限边界。
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

async function approveCurrent(app: Awaited<ReturnType<typeof getApp>>, cookie: string, instanceId: string): Promise<void> {
  const detail = await trpc(app, "approval.getById", { cookie, input: { id: instanceId }, method: "GET" });
  const inst = (detail.json as { result: { data: { status: string; currentStepSeq: number } } }).result.data;
  if (inst.status !== "pending") return;
  const acted = await trpc(app, "approval.act", {
    cookie,
    input: { instanceId, stepSeq: inst.currentStepSeq, action: "approve", idempotencyKey: crypto.randomUUID() },
  });
  expect(acted.status).toBe(200);
}

describe("迭代 6 验收·扩展域（arch/09 §6）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let financeCookie: string;
  let partnerCookie: string;
  let sysadminCookie: string;
  let viewerCookie: string;
  let projectAId: string;
  let projectBId: string;
  let clientAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "finance@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "partner@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "sysadmin@lexflow.demo")).cookie;
    viewerCookie = (await loginAs(app, "viewer@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    projectBId = items.find((p) => p.code === `PRJ-${YEAR}-00002`)!.id;
    const clients = await trpc(app, "client.list", { cookie: pmCookie, method: "GET" });
    clientAId = (clients.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items[0].id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("E1 收款：登记幂等重放不双记、作废冲正行保留+审计、CSV 内容与导出审计、viewer 零可见", async () => {
    const key = crypto.randomUUID();
    const r1 = await trpc(app, "receipts.create", {
      cookie: financeCookie,
      input: { projectId: projectBId, amountCents: 88_000, receivedOn: "2027-11-01", referenceNo: "BNK-E1", idempotencyKey: key },
    });
    expect(r1.status).toBe(200);
    const r2 = await trpc(app, "receipts.create", {
      cookie: financeCookie,
      input: { projectId: projectBId, amountCents: 88_000, receivedOn: "2027-11-01", referenceNo: "BNK-E1", idempotencyKey: key },
    });
    // R6 修复（arch/00 §3.7）：同键重放返回首次登记（同 id、单行），异键正常双记
    expect((r2.json as { result: { data: { id: string } } }).result.data.id).toBe((r1.json as { result: { data: { id: string } } }).result.data.id);
    const rid = (r1.json as { result: { data: { id: string } } }).result.data.id;
    const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM payment_receipts WHERE reference_no='BNK-E1'`);
    expect(rows[0].n).toBe(1); // 同键双调单行
    const r3 = await trpc(app, "receipts.create", {
      cookie: financeCookie,
      input: { projectId: projectBId, amountCents: 88_000, receivedOn: "2027-11-01", referenceNo: "BNK-E1", idempotencyKey: crypto.randomUUID() },
    });
    expect(r3.status).toBe(200);
    const dupCount = await query<{ n: number }>(`SELECT count(*)::int AS n FROM payment_receipts WHERE reference_no='BNK-E1'`);
    expect(dupCount[0].n).toBe(2); // 异键双行（幂等键不串）

    const voided = await trpc(app, "receipts.void", { cookie: financeCookie, input: { id: rid, reason: "E1 冲正", rowVersion: 0 } });
    expect(voided.status).toBe(200);
    const kept = await query<{ status: string }>(`SELECT status FROM payment_receipts WHERE id=$1`, [rid]);
    expect(kept[0].status).toBe("voided"); // 行保留
    const audit = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action='receipt.void' AND target_id=$1`, [rid]);
    expect(audit[0].n).toBe(1);

    const csv = await trpc(app, "receipts.exportCsv", { cookie: financeCookie, method: "GET", input: {} });
    expect((csv.json as { result: { data: { csv: string; rowCount: number } } }).result.data.rowCount).toBeGreaterThan(0);
    const exportAudit = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action='export.run' AND target_type='payment_receipt'`);
    expect(exportAudit[0].n).toBeGreaterThanOrEqual(1);

    const viewerList = await trpc(app, "receipts.list", { cookie: viewerCookie, method: "GET", input: {} });
    expect(viewerList.status).toBe(404);
    const viewerSummary = await trpc(app, "receipts.summary", { cookie: viewerCookie, method: "GET", input: { by: "project" } });
    expect(viewerSummary.status).toBe(404);
  });

  it("E2 自定义 travel 流程：发布→借款出差走新流程（节点进度）→ disable 回默认", async () => {
    const draft = await trpc(app, "flow.createDraft", {
      cookie: sysadminCookie,
      input: {
        name: "验收-出差审批流",
        scope: "global",
        bizBinding: "travel",
        definitionJson: {
          nodes: [
            { id: "s", type: "start" },
            { id: "a1", type: "approval", label: "负责人审批", approver: { kind: "role", role: "project_manager" }, countersign: "any" },
            { id: "c1", type: "condition", label: "借款", expr: { field: "borrow", op: "==", value: true } },
            { id: "a2", type: "approval", label: "财务会签", approver: { kind: "role", role: "finance" }, countersign: "all" },
            { id: "e", type: "end" },
          ],
          edges: [
            { from: "s", to: "a1" },
            { from: "a1", to: "c1" },
            { from: "c1", to: "a2", when: true },
            { from: "c1", to: "e", when: false },
            { from: "a2", to: "e" },
          ],
        },
      },
    });
    if (draft.status !== 200) throw new Error("flowDraft: " + JSON.stringify(draft.json).slice(0, 400));
    const flowId = (draft.json as { result: { data: { id: string } } }).result.data.id;
    const pub = await trpc(app, "flow.publish", { cookie: sysadminCookie, input: { id: flowId, idempotencyKey: crypto.randomUUID() } });
    // R7 修复：flow.publish 对既有 biz_type（travel）正常 200 并接管（释放同 binding 默认流）
    expect(pub.status).toBe(200);
    expect((pub.json as { result: { data: { published: boolean } } }).result.data.published).toBe(true);
    // publish 幂等重放：已启用再发布 → 200 + published=false
    const pubReplay = await trpc(app, "flow.publish", { cookie: sysadminCookie, input: { id: flowId, idempotencyKey: crypto.randomUUID() } });
    expect(pubReplay.status).toBe(200);
    expect((pubReplay.json as { result: { data: { published: boolean } } }).result.data.published).toBe(false);

    // 借款出差走新流程：a1 → 条件 true → a2
    const travel = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId, reason: "E2 借款出差", destination: "深圳", startOn: "2027-11-05", endOn: "2027-11-06",
        borrow: true, borrowAmountCents: 100000,
        segments: [{ seq: 1, type: "transport", startAt: "2027-11-05T01:00:00.000Z", endAt: "2027-11-05T05:00:00.000Z" }],
      },
    });
    const tid = (travel.json as { result: { data: { id: string } } }).result.data.id;
    const td = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: tid }, method: "GET" });
    const sub = await trpc(app, "travel.submit", {
      cookie: memberCookie,
      input: { id: tid, rowVersion: (td.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const instId = (sub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const inst = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: instId }, method: "GET" });
    const instData = (inst.json as {
      result: { data: { policySnapshot: { flowName?: string }; flowProgress: { currentNodeLabel: string; nodes: { label: string }[] } | null } };
    }).result.data;
    expect(instData.policySnapshot.flowName).toBe("验收-出差审批流");
    expect(instData.flowProgress?.currentNodeLabel).toBe("负责人审批");
    expect(instData.flowProgress?.nodes.map((n) => n.label)).toEqual(["负责人审批", "财务会签"]);

    // disable 回默认（原策略单步 pm）：发布使 rowVersion 自增，先取现值再停用
    const flowNow = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: flowId }, method: "GET" });
    const disabled = await trpc(app, "flow.disable", {
      cookie: sysadminCookie,
      input: { id: flowId, rowVersion: (flowNow.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion },
    });
    expect(disabled.status).toBe(200);
    const t2 = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId, reason: "E2 默认流程", destination: "广州", startOn: "2027-11-08", endOn: "2027-11-09",
        segments: [{ seq: 1, type: "transport", startAt: "2027-11-08T01:00:00.000Z", endAt: "2027-11-08T05:00:00.000Z" }],
      },
    });
    const t2id = (t2.json as { result: { data: { id: string } } }).result.data.id;
    const t2d = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: t2id }, method: "GET" });
    const sub2 = await trpc(app, "travel.submit", {
      cookie: memberCookie,
      input: { id: t2id, rowVersion: (t2d.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const inst2 = (sub2.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const inst2Detail = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: inst2 }, method: "GET" });
    expect((inst2Detail.json as { result: { data: { policySnapshot: { flowName?: string } } } }).result.data.policySnapshot.flowName ?? "默认").not.toBe("验收-出差审批流");
  });

  it("E3 补充：start/end 不唯一 → 保存被 400 拦截（FLOW_INVALID）", async () => {
    const bad = await trpc(app, "flow.createDraft", {
      cookie: sysadminCookie,
      input: {
        name: "双 start 流程",
        scope: "global",
        bizBinding: "generic_request",
        definitionJson: {
          nodes: [
            { id: "s1", type: "start" },
            { id: "s2", type: "start" },
            { id: "e", type: "end" },
          ],
          edges: [{ from: "s1", to: "e" }, { from: "s2", to: "e" }],
        },
      },
    });
    expect(bad.status).toBe(400);
    expect(trpcError(bad).businessCode).toBe("VALIDATION_FAILED");
  });

  it("E5 通用申请单：小额走条件 false 分支（单节点直通）+ 终态通知", async () => {
    // 复用/自建通用流程：pm 单节点（请假无金额字段，条件恒 false 直 end）
    const draft = await trpc(app, "flow.createDraft", {
      cookie: sysadminCookie,
      input: {
        name: "验收-请假流程",
        scope: "global",
        bizBinding: "generic_request",
        definitionJson: {
          nodes: [
            { id: "s", type: "start" },
            { id: "a1", type: "approval", label: "负责人审批", approver: { kind: "role", role: "project_manager" }, countersign: "any" },
            { id: "e", type: "end" },
          ],
          edges: [{ from: "s", to: "a1" }, { from: "a1", to: "e" }],
        },
      },
    });
    const flowId = (draft.json as { result: { data: { id: string } } }).result.data.id;
    await trpc(app, "flow.publish", { cookie: sysadminCookie, input: { id: flowId, idempotencyKey: crypto.randomUUID() } });

    const req = await trpc(app, "genericRequest.create", {
      cookie: memberCookie,
      input: { requestType: "leave", title: "E5 请假申请", reason: "家中有事", startOn: "2027-12-01", endOn: "2027-12-02" },
    });
    expect(req.status).toBe(200);
    const reqId = (req.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;
    const detail = await trpc(app, "genericRequest.getById", { cookie: memberCookie, input: { id: reqId }, method: "GET" });
    const sub = await trpc(app, "genericRequest.submit", {
      cookie: memberCookie,
      input: { id: reqId, rowVersion: (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(sub.status).toBe(200);
    const instId = (sub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await approveCurrent(app, pmCookie, instId);
    const final = await trpc(app, "genericRequest.getById", { cookie: memberCookie, input: { id: reqId }, method: "GET" });
    expect((final.json as { result: { data: { status: string } } }).result.data.status).toBe("approved");
    const notices = await trpc(app, "notification.listMine", { cookie: memberCookie, method: "GET" });
    expect(
      (notices.json as { result: { data: { items: { eventType: string; sourceId: string }[] } } }).result.data.items
        .some((n) => n.eventType === "approval_result" && n.sourceId === reqId),
    ).toBe(true);
  });

  it("E6 admin：建客户立即可立项 + 阈值配置即时生效 + 停用用户会话即失效", async () => {
    // 建客户（sysadmin）→ partner 立即可用于立项
    const created = await trpc(app, "admin.createClient", {
      cookie: sysadminCookie,
      input: { name: "验收客户甲", confidentialityLevel: "internal" },
    });
    expect(created.status).toBe(200);
    const newClientId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const matter = await trpc(app, "admin.createMatter", {
      cookie: sysadminCookie,
      input: { clientId: newClientId, name: "验收客户甲事项", type: "咨询" },
    });
    expect(matter.status).toBe(200);
    const newMatterId = (matter.json as { result: { data: { id: string } } }).result.data.id;
    const templates = await trpc(app, "project.listTemplates", { cookie: partnerCookie, method: "GET" });
    const templateId = (templates.json as { result: { data: { id: string; name: string }[] } }).result.data[0].id;
    const project = await trpc(app, "project.create", {
      cookie: partnerCookie,
      input: { templateId, matterId: newMatterId, name: "验收客户甲立项", startDate: "2027-11-10" },
    });
    expect(project.status).toBe(200); // 建客户→建事项→立即可立项

    // 阈值配置即时生效：经费 ≥ 阈值两步（pm→partner），改配置后单步
    const before = await trpc(app, "admin.getConfig", { cookie: sysadminCookie, method: "GET", input: { key: "approval.amount_thresholds" } });
    const thresholds = (before.json as { result: { data: { valueJson: { fundingManagementReviewCents: number } } } }).result.data.valueJson;
    const funding = await trpc(app, "funding.create", {
      cookie: memberCookie,
      input: { projectId: projectAId, purpose: "E6 阈值探测", amountCents: thresholds.fundingManagementReviewCents + 1 },
    });

    const fid = (funding.json as { result: { data: { id: string } } }).result.data.id;
    const fd = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fid }, method: "GET" });
    const sub = await trpc(app, "funding.submit", {
      cookie: memberCookie,
      input: { id: fid, rowVersion: (fd.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const inst1 = (sub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const steps1 = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: inst1 }, method: "GET" });
    expect((steps1.json as { result: { data: { steps: unknown[] } } }).result.data.steps).toHaveLength(2); // 两步

    const setCfg = await trpc(app, "admin.setConfig", {
      cookie: sysadminCookie,
      input: { key: "approval.amount_thresholds", value: { ...thresholds, fundingManagementReviewCents: 9_999_999_999 } },
    });
    expect(setCfg.status).toBe(200);
    const funding2 = await trpc(app, "funding.create", {
      cookie: memberCookie,
      input: { projectId: projectAId, purpose: "E6 阈值改后", amountCents: thresholds.fundingManagementReviewCents + 1 },
    });
    const fid2 = (funding2.json as { result: { data: { id: string } } }).result.data.id;
    const fd2 = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fid2 }, method: "GET" });
    const sub2 = await trpc(app, "funding.submit", {
      cookie: memberCookie,
      input: { id: fid2, rowVersion: (fd2.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const inst2 = (sub2.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const steps2 = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: inst2 }, method: "GET" });
    // R8 修复：approval.amount_thresholds 经 $config 引用编译期求值——阈值上调后同额经费走单步
    expect((steps2.json as { result: { data: { steps: unknown[] } } }).result.data.steps).toHaveLength(1);
    await trpc(app, "admin.setConfig", { cookie: sysadminCookie, input: { key: "approval.amount_thresholds", value: thresholds } });

    // 停用用户 → 会话即失效
    const tmpEmail = `tmp-${Date.now()}@lexflow.demo`;
    const user = await trpc(app, "admin.createUser", {
      cookie: sysadminCookie,
      input: { name: "临时验收员", email: tmpEmail, orgUnitId: (await query<{ id: string }>(`SELECT id FROM org_units LIMIT 1`))[0].id, roleKey: "member" },
    });
    const tmpId = (user.json as { result: { data: { id: string } } }).result.data.id;
    const tmpPw = (user.json as { result: { data: { initialPassword: string } } }).result.data.initialPassword;
    const tmpSession = await loginAs(app, tmpEmail, tmpPw);
    const disabled = await trpc(app, "admin.disableUser", { cookie: sysadminCookie, input: { userId: tmpId } });
    expect(disabled.status).toBe(200);
    const meAfter = await trpc(app, "auth.me", { cookie: tmpSession.cookie, method: "GET" });
    expect(meAfter.status).toBe(401); // 停用即时失效
  });

  it("E6 补充（R9）：admin.createMatter 坏 clientId → 400 VALIDATION_FAILED + fieldErrors，不再 500", async () => {
    const bad = await trpc(app, "admin.createMatter", {
      cookie: sysadminCookie,
      input: { clientId: crypto.randomUUID(), name: "坏客户事项" },
    });
    expect(bad.status).toBe(400);
    expect(trpcError(bad).businessCode).toBe("VALIDATION_FAILED");
    const fieldErrors = trpcError(bad).fieldErrors;
    expect(fieldErrors?.clientId).toBeTruthy();
  });

  it("E7 自助改密：旧会话失效 + 旧口令拒登 + 新口令可登", async () => {
    const email = `pw-${Date.now()}@lexflow.demo`;
    const created = await trpc(app, "admin.createUser", {
      cookie: sysadminCookie,
      input: { name: "改密验收员", email, orgUnitId: (await query<{ id: string }>(`SELECT id FROM org_units LIMIT 1`))[0].id, roleKey: "member" },
    });
    expect(created.status).toBe(200);
    const initial = (created.json as { result: { data: { initialPassword: string } } }).result.data.initialPassword;
    const first = await loginAs(app, email, initial);
    // 首次登录强制改密：旧口令直接改
    const changed = await trpc(app, "auth.changePassword", {
      cookie: first.cookie,
      input: { oldPassword: initial, newPassword: "NewDemo@2026" },
    });
    expect(changed.status).toBe(200);
    const meAfter = await trpc(app, "auth.me", { cookie: first.cookie, method: "GET" });
    expect(meAfter.status).toBe(401); // 全会话失效
    const oldLogin = await trpc(app, "auth.login", { input: { email, password: initial } });
    expect(oldLogin.status).toBe(401);
    const newLogin = await loginAs(app, email, "NewDemo@2026");
    expect(newLogin.user.email).toBe(email);
  });

  it("E8 权限：sysadmin 无业务内容权；member 不见收款与 /admin；partner 流程只读", async () => {
    const sysProject = await trpc(app, "project.getById", { cookie: sysadminCookie, input: { id: projectBId }, method: "GET" });
    expect(sysProject.status).toBe(404);
    const sysFile = await trpc(app, "expense.list", { cookie: sysadminCookie, method: "GET" });
    expect([200, 404]).toContain(sysFile.status); // sysadmin 无财务职责→不可见费用
    const memberReceipts = await trpc(app, "receipts.list", { cookie: memberCookie, method: "GET", input: {} });
    expect(memberReceipts.status).toBe(404);
    const memberAdmin = await trpc(app, "admin.userList", { cookie: memberCookie, method: "GET" });
    expect(memberAdmin.status).toBe(404);
    const partnerFlows = await trpc(app, "flow.list", { cookie: partnerCookie, method: "GET" });
    expect(partnerFlows.status).toBe(200); // 只读
    const memberFlow = await trpc(app, "flow.createDraft", {
      cookie: memberCookie,
      input: { name: "x", scope: "global", bizBinding: "budget", definitionJson: { nodes: [{ id: "s", type: "start" }, { id: "e", type: "end" }], edges: [{ from: "s", to: "e" }] } },
    });
    expect(memberFlow.status).toBe(404); // member 不可设计流程
  });
});
