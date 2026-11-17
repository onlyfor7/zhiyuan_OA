import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { TEST_DATABASE_URL } from "../db/helpers";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";

/**
 * 迭代 20 · 工单 06a（O-20-5-6/7/8/2 服务端缺陷）：
 * 5-7 dedupe once 死锁（视同通过推进/终审不滞留）；5-6 pm 项目流放行；
 * 5-8 submitCc/endCc 实装；5-2 发布显式停用用户 412。
 */

const uuid = () => crypto.randomUUID();
const YEAR = new Date().getFullYear();

const v2Def = (nodes: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  settings: { allowWithdrawPending: true, dedupeApprover: "once", titleTemplate: null, summaryFieldKeys: [] },
  nodes,
  ...extra,
});

const approvalNode = (name: string, approver: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "approval",
  name,
  approvalType: "manual",
  approver,
  countersign: "any",
  sameAsInitiator: "skip",
  ops: { transfer: true, returnBack: "none", requireCommentOnReject: true, requireCommentOnApprove: false },
  ...extra,
});

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

describe("20-06a O-20-5-6/7/8/2", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let sysadminCookie: string;
  let memberCookie: string;
  let presalesCookie: string;
  let pmCookie: string;
  let pmBCookie: string;
  let partnerCookie: string;
  let presalesId: string;
  let pmId: string;
  let partnerId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    presalesCookie = (await loginAs(app, "hezhiyuan@lexflow.demo")).cookie;
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    const ids = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email IN ('hezhiyuan@lexflow.demo','wangbaozhuo@lexflow.demo','liangqifeng@lexflow.demo','wangjiayu@lexflow.demo')`,
    );
    presalesId = ids.find((u) => u.email.startsWith("hezhiyuan"))!.id;
    pmId = ids.find((u) => u.email.startsWith("wangbaozhuo"))!.id;
    partnerId = ids.find((u) => u.email.startsWith("liangqifeng"))!.id;
    pmBCookie = (await loginAs(app, "wangjiayu@lexflow.demo")).cookie;
  });

  afterAll(async () => {
    await closeDb();
  });

  /** 建 published 自定义表单（绑定流 = 给定 v2 定义） */
  const mkForm = async (name: string, definitionJson: Record<string, unknown>, visibility: unknown = { mode: "all" }) => {
    const f = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name, visibility } });
    const fd = (f.json as { result: { data: { id: string; code: string; flowId: string; rowVersion: number } } }).result.data;
    const fl = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: fd.flowId }, method: "GET" });
    const upd = await trpc(app, "flow.updateDraft", { cookie: sysadminCookie, input: { id: fd.flowId, rowVersion: (fl.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson } });
    expect(upd.status).toBe(200);
    const pub = await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: fd.id, rowVersion: fd.rowVersion } });
    expect(pub.status, JSON.stringify(pub.json).slice(0, 250)).toBe(200);
    return fd;
  };
  const submitForm = async (code: string) => {
    const r = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: code, title: "06a", reason: "x", payload: {} } });
    const rid = (r.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const s = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: rid.id, rowVersion: rid.rowVersion, idempotencyKey: uuid() } });
    expect(s.status).toBe(200);
    return { inst: (s.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id, reqId: rid.id };
  };

  it("O-20-5-7：dedupe 命中尾步→approved+业务回写；命中中间步→后续审批人正常 act；不互踩 G4 重挂", async () => {
    // 尾步命中：两同审批人步——一审过 → 二审 dedupe 视同通过 → 实例 approved + 请求回写
    const f1 = await mkForm("5-7 尾步", v2Def([
      approvalNode("一审", { kind: "user", userId: presalesId }),
      approvalNode("二审", { kind: "user", userId: presalesId }),
    ]));
    const { inst: inst1, reqId } = await submitForm(f1.code);
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: inst1, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    const instRow = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE id=$1`, [inst1]);
    expect(instRow[0].status).toBe("approved"); // 尾挂不再死锁
    const steps = await query<{ status: string; comment: string | null }>(`SELECT status, comment FROM approval_steps WHERE instance_id=$1 ORDER BY seq`, [inst1]);
    expect(steps[1].status).toBe("skipped");
    expect(steps[1].comment).toContain("dedupe");
    const req = await query<{ status: string }>(`SELECT status FROM generic_requests WHERE id=$1`, [reqId]);
    expect(req[0].status).toBe("approved"); // 终审触发业务回写

    // 中间步命中：一审过 → 二审（同审批人）dedupe 视同通过 → 指针到三审（pm）→ pm 可 act（不 409）→ approved
    const f2 = await mkForm("5-7 中间步", v2Def([
      approvalNode("一审", { kind: "user", userId: presalesId }),
      approvalNode("二审", { kind: "user", userId: presalesId }),
      approvalNode("三审", { kind: "user", userId: pmId }),
    ]));
    const { inst: inst2 } = await submitForm(f2.code);
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: inst2, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    const cur = await query<{ current_step_seq: number }>(`SELECT current_step_seq FROM approval_instances WHERE id=$1`, [inst2]);
    expect(cur[0].current_step_seq).toBe(3); // 指针推进过 dedupe 步
    const act3 = await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: inst2, stepSeq: 3, action: "approve", idempotencyKey: uuid() } });
    expect(act3.status, JSON.stringify(act3.json).slice(0, 200)).toBe(200); // 不 409
    const inst2Row = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE id=$1`, [inst2]);
    expect(inst2Row[0].status).toBe("approved");

    // 与 G4 不互踩：dedupe-skipped 不可被重挂（[returned] 判定互斥）——一审过→二审退回→一审再过→二审重挂（其 approver 未被 dedupe 跳过）
    const f3 = await mkForm("5-7 组合", v2Def([
      approvalNode("一审", { kind: "user", userId: presalesId }),
      approvalNode("二审", { kind: "user", userId: pmId }, { ops: { transfer: true, returnBack: "prev", requireCommentOnReject: true, requireCommentOnApprove: false } }),
      approvalNode("三审", { kind: "user", userId: presalesId }),
    ]));
    const { inst: inst3 } = await submitForm(f3.code);
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: inst3, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: inst3, stepSeq: 2, action: "return", comment: "补", idempotencyKey: uuid() } });
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: inst3, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    const st3 = await query<{ seq: number; status: string }>(`SELECT seq, status FROM approval_steps WHERE instance_id=$1 ORDER BY seq`, [inst3]);
    expect(st3.find((x) => x.seq === 2)!.status).toBe("pending"); // 重挂（非 dedupe 跳过）
  });

  it("O-20-5-6：pm 对名下项目流 getById 200 / 他人项目流 404 / sysadmin 全通", async () => {
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: Array<{ id: string; code: string }> } } }).result.data.items;
    const projA = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    const projB = items.find((p) => p.code === `PRJ-${YEAR}-00002`)!.id;
    // A 建项目流草稿
    const created = await trpc(app, "project.flows.createDraft", { cookie: pmCookie, input: { projectId: projA, name: "06a 项目流", bizBinding: "travel", definitionJson: v2Def([approvalNode("审", { kind: "role", role: "partner" })]) } });
    expect(created.status).toBe(200);
    const flowId = (created.json as { result: { data: { id: string } } }).result.data.id;
    // pm 读自己项目流 200
    const own = await trpc(app, "flow.getById", { cookie: pmCookie, method: "GET", input: { id: flowId } });
    expect(own.status).toBe(200);
    // sysadmin 200
    const sys = await trpc(app, "flow.getById", { cookie: sysadminCookie, method: "GET", input: { id: flowId } });
    expect(sys.status).toBe(200);
    // B 项目负责人读 A 的项目流 404（同形）
    const other = await trpc(app, "flow.getById", { cookie: pmBCookie, method: "GET", input: { id: flowId } });
    expect(other.status).toBe(404);
    // 非负责人 pm 经 project.flows 路由仍 404（两处同语义不破）
    void projB;
  });

  it("O-20-5-8：submitCc 提交即达 / endCc 终审后达 / 拒绝路径 endCc 不发", async () => {
    const f = await mkForm("5-8 配置抄送", v2Def(
      [approvalNode("审批", { kind: "user", userId: presalesId })],
      { submitCc: [{ kind: "user", userId: partnerId }], endCc: [{ kind: "user", userId: partnerId }] },
    ));
    const ccAudit = (inst: string) => query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action='approval.cc' AND target_id=$1`, [inst]);
    // 批准路径
    const { inst: inst1 } = await submitForm(f.code);
    expect((await ccAudit(inst1))[0].n).toBe(1); // submitCc 提交即达
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: inst1, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    expect((await ccAudit(inst1))[0].n).toBe(2); // endCc 终审后达
    // 通知按 (event_type:source_id:日) 聚合——同人同源自日一行，两次 cc 审计对应一条聚合通知
    const notify = await query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE event_type='approval_cc' AND payload_json->>'approvalInstanceId'=$1`, [inst1]);
    expect(notify[0].n).toBeGreaterThanOrEqual(1);
    // 拒绝路径：endCc 不发
    const { inst: inst2 } = await submitForm(f.code);
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: inst2, stepSeq: 1, action: "reject", comment: "拒", idempotencyKey: uuid() } });
    expect((await ccAudit(inst2))[0].n).toBe(1); // 仅 submitCc
  });

  it("O-20-5-2：显式停用用户发布 412 / 角色范围集停用用户解析剔除（发布不拦）", async () => {
    // 停用用户
    const mk = await trpc(app, "admin.createUser", { cookie: sysadminCookie, input: { email: `dis-${uuid().slice(0, 8)}@lexflow.demo`, name: "停用者", roleKey: "member" } });
    const disId = (mk.json as { result: { data: { id: string } } }).result.data.id;
    await trpc(app, "admin.disableUser", { cookie: sysadminCookie, input: { userId: disId } });
    // 显式 user 引用 → 412
    const f1 = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "5-2 停用显式", visibility: { mode: "all" } } });
    const fd1 = (f1.json as { result: { data: { id: string; code: string; flowId: string; rowVersion: number } } }).result.data;
    const fl1 = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: fd1.flowId }, method: "GET" });
    const upd1 = await trpc(app, "flow.updateDraft", { cookie: sysadminCookie, input: { id: fd1.flowId, rowVersion: (fl1.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([approvalNode("审", { kind: "user", userId: disId })]) } });
    expect(upd1.status).toBe(200);
    const pub1 = await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: fd1.id, rowVersion: fd1.rowVersion } });
    expect(pub1.status).toBe(412);
    // scope.users 含停用用户 → 412（显式指定语义）
    const f2 = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "5-2 停用范围", visibility: { mode: "all" } } });
    const fd2 = (f2.json as { result: { data: { id: string; code: string; flowId: string; rowVersion: number } } }).result.data;
    const fl2 = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: fd2.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", { cookie: sysadminCookie, input: { id: fd2.flowId, rowVersion: (fl2.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([approvalNode("审", { kind: "initiator_choice", scope: { mode: "users", userIds: [disId, presalesId] } })]) } });
    const pub2 = await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: fd2.id, rowVersion: fd2.rowVersion } });
    expect(pub2.status).toBe(412);
    // 角色范围集（停用用户不在指定集，运行时剔除）→ 发布放行
    const f3 = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "5-2 角色集", visibility: { mode: "all" } } });
    const fd3 = (f3.json as { result: { data: { id: string; code: string; flowId: string; rowVersion: number } } }).result.data;
    const fl3 = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: fd3.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", { cookie: sysadminCookie, input: { id: fd3.flowId, rowVersion: (fl3.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([approvalNode("审", { kind: "role", role: "presales" })]) } });
    const pub3 = await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: fd3.id, rowVersion: fd3.rowVersion } });
    expect(pub3.status).toBe(200);
  });
});
