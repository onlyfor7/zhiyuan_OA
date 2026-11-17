import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { compileFlowV2, validateFlowStructureV2 } from "../../src/services/approval/flow-v2";
import { TEST_DATABASE_URL } from "../db/helpers";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";

/**
 * 迭代 20 · 工单 02：编译器 v2 / 引擎运行时扩展 / 自定义表单服务端（arch/14）。
 */

const uuid = () => crypto.randomUUID();

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

const v2Def = (nodes: unknown[]) => ({
  schemaVersion: 2,
  settings: { allowWithdrawPending: true, dedupeApprover: "once", titleTemplate: null, summaryFieldKeys: [] },
  nodes,
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

describe("20-02 编译器v2/引擎扩展/自定义表单", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let sysadminCookie: string;
  let partnerCookie: string;
  let memberCookie: string;
  let salesACookie: string;
  let presalesCookie: string;
  let pmCookie: string;
  let salesAId: string;
  let presalesId: string;
  let pmId: string;
  let smId: string;
  let vpId: string;
  let ceoId: string;
  let pmUserId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    salesACookie = (await loginAs(app, "sumingxuan@lexflow.demo")).cookie;
    presalesCookie = (await loginAs(app, "hezhiyuan@lexflow.demo")).cookie;
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    const ids = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email IN ('sumingxuan@lexflow.demo','hezhiyuan@lexflow.demo','wangbaozhuo@lexflow.demo','zhenghaoran@lexflow.demo','gaojunling@lexflow.demo','songqiming@lexflow.demo')`,
    );
    salesAId = ids.find((u) => u.email.startsWith("sumingxuan"))!.id;
    presalesId = ids.find((u) => u.email.startsWith("hezhiyuan"))!.id;
    pmUserId = ids.find((u) => u.email.startsWith("wangbaozhuo"))!.id;
    pmId = pmUserId;
    smId = ids.find((u) => u.email.startsWith("zhenghaoran"))!.id;
    vpId = ids.find((u) => u.email.startsWith("gaojunling"))!.id;
    ceoId = ids.find((u) => u.email.startsWith("songqiming"))!.id;
    // 综合管理部负责人=宋启铭（dept_head 链）；苏明轩/郑浩然均属综合管理部
    const dept = await query<{ id: string }>(`SELECT id FROM org_units WHERE name='综合管理部'`);
    await query(`UPDATE org_units SET leader_id=$1 WHERE id=$2`, [ceoId, dept[0].id]);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("编译器 v2：第一命中/else 兜底/嵌套一层/嵌套超深 400/cc 不产步骤/auto 透传/超 100 节点 400", async () => {
    const def = v2Def([
      {
        type: "condition",
        branches: [
          { name: "大额", expr: { field: "amount_cents", op: "gte", value: 100 }, nodes: [approvalNode("A1", { kind: "user", userId: "u1" })] },
          { name: "其他情况", nodes: [approvalNode("A2", { kind: "user", userId: "u2" })] },
        ],
      },
      approvalNode("A3", { kind: "role", role: "partner" }, { approvalType: "auto_pass" }),
      { type: "cc", name: "知会", receivers: [{ kind: "user", userId: "u9" }] },
    ]);
    const hit = compileFlowV2(def, { amount_cents: 200 });
    expect(hit.steps.map((s) => s.label)).toEqual(["A1", "A3"]);
    expect(hit.steps[1].approvalType).toBe("auto_pass");
    expect(hit.ccEvents).toHaveLength(1);
    expect(hit.ccEvents[0].afterStepIndex).toBe(2);
    const fallback = compileFlowV2(def, { amount_cents: 5 });
    expect(fallback.steps.map((s) => s.label)).toEqual(["A2", "A3"]); // else 兜底
    const both = compileFlowV2(def, { amount_cents: 200 }, true);
    expect(both.steps.map((s) => s.label)).toEqual(["A1", "A2", "A3"]); // exploreBoth 全分支

    // 嵌套一层合法 / 超深 400 / 超 100 节点 400 / cc 无 receivers 400 / else 非末 400
    const nested = v2Def([
      {
        type: "condition",
        branches: [
          { name: "外", expr: { field: "borrow", op: "eq", value: true }, nodes: [
            { type: "condition", branches: [
              { name: "内", expr: { field: "borrow", op: "eq", value: true }, nodes: [approvalNode("IN", { kind: "user", userId: "u1" })] },
              { name: "其他情况", nodes: [] },
            ] },
          ] },
          { name: "其他情况", nodes: [] },
        ],
      },
    ]);
    expect(() => validateFlowStructureV2(nested)).not.toThrow();
    const tooDeep = v2Def([
      { type: "condition", branches: [
        { name: "l1", expr: { field: "borrow", op: "eq", value: true }, nodes: [
          { type: "condition", branches: [
            { name: "l2", expr: { field: "borrow", op: "eq", value: true }, nodes: [
              { type: "condition", branches: [
                { name: "l3", expr: { field: "borrow", op: "eq", value: true }, nodes: [
                  { type: "condition", branches: [
                    { name: "l4", expr: { field: "borrow", op: "eq", value: true }, nodes: [] },
                    { name: "其他情况", nodes: [] },
                  ] },
                ] },
                { name: "其他情况", nodes: [] },
              ] },
            ] },
            { name: "其他情况", nodes: [] },
          ] },
        ] },
        { name: "其他情况", nodes: [] },
      ] },
    ]);
    expect(() => validateFlowStructureV2(tooDeep)).toThrowError(/嵌套深度/);
    const many = v2Def(Array.from({ length: 101 }, (_, i) => approvalNode(`n${i}`, { kind: "user", userId: "u1" })));
    expect(() => validateFlowStructureV2(many)).toThrowError(/节点总数/);
    const badCc = v2Def([{ type: "cc", name: "x", receivers: [] }]);
    expect(() => validateFlowStructureV2(badCc)).toThrowError(/receivers/);
    const badElse = v2Def([
      { type: "condition", branches: [
        { name: "其他情况", nodes: [] },
        { name: "有", expr: { field: "borrow", op: "eq", value: true }, nodes: [] },
      ] },
    ]);
    expect(() => validateFlowStructureV2(badElse)).toThrowError(/else/);
  });

  /** 建 v2 自定义流（global 绑定 bizBinding）并发布 */
  const mkFlow = async (name: string, bizBinding: string, nodes: unknown[]) => {
    const created = await trpc(app, "flow.createDraft", {
      cookie: sysadminCookie,
      input: { name, scope: "global", bizBinding, definitionJson: v2Def(nodes) },
    });
    expect(created.status, JSON.stringify(created.json).slice(0, 200)).toBe(200);
    const id = (created.json as { result: { data: { id: string } } }).result.data.id;
    const pub = await trpc(app, "flow.publish", { cookie: sysadminCookie, input: { id, idempotencyKey: uuid() } });
    expect(pub.status, JSON.stringify(pub.json).slice(0, 250)).toBe(200);
    return id;
  };

  /** 管晨提申请单（默认 leave 类型）并提交，返回实例 id */
  const submitLeave = async (chosenApproverId?: string) => {
    const req = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: "leave", title: "20-02 验证", reason: "验证" } });
    const reqId = (req.json as { result: { data: { id: string; rowVersion: number } } }).result.data.id;
    const sub = await trpc(app, "genericRequest.submit", {
      cookie: memberCookie,
      input: { id: reqId, rowVersion: 0, idempotencyKey: uuid(), ...(chosenApproverId ? { chosenApproverId } : {}) },
    });
    return { reqId, sub };
  };

  it("引擎新策略：dept_head / manager_chain(2 级) / initiator_self / form_contact 四链跑通", async () => {
    // dept_head：提交人=管晨（诉讼业务部？查其部门负责人=刚设置的仅综合管理部）——改：苏明轩提交，部门=综合管理部，负责人=宋启铭
    await mkFlow("v2-dept-head", "custom_form:t-dept", [approvalNode("部门负责人审", { kind: "dept_head" })]);
    // 用独立 bizBinding 不走 custom_form 提交链，直接借 generic_request 不行（bizType 固定）——经 CF 提交链走：
    const f1 = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "dept 表单", groupName: "验证组", visibility: { mode: "all" } } });
    expect(f1.status).toBe(200);
    const f1id = (f1.json as { result: { data: { id: string; flowId: string; rowVersion: number } } }).result.data;
    // 绑定流改定义为 dept_head 并发布（覆盖 create 时的空流）
    const flowDetail = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: f1id.flowId }, method: "GET" });
    const flowRv = (flowDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const upd = await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: { id: f1id.flowId, rowVersion: flowRv, definitionJson: v2Def([approvalNode("部门负责人审", { kind: "dept_head" })]) },
    });
    expect(upd.status).toBe(200);
    const pub = await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: f1id.id, rowVersion: f1id.rowVersion } });
    expect(pub.status, JSON.stringify(pub.json).slice(0, 250)).toBe(200);
    const code1 = (f1.json as { result: { data: { code: string } } }).result.data.code;
    const r1 = await trpc(app, "genericRequest.create", { cookie: salesACookie, input: { requestType: code1, title: "dept 提交", reason: "验证", payload: {} } });
    expect(r1.status).toBe(200);
    const r1id = (r1.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const s1 = await trpc(app, "genericRequest.submit", { cookie: salesACookie, input: { id: r1id.id, rowVersion: r1id.rowVersion, idempotencyKey: uuid() } });
    expect(s1.status, JSON.stringify(s1.json).slice(0, 250)).toBe(200);
    const inst1 = (s1.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const steps1 = await query<{ approver_id: string | null; seq: number }>(`SELECT approver_id, seq FROM approval_steps WHERE instance_id=$1 ORDER BY seq`, [inst1]);
    expect(steps1.map((s) => s.approver_id)).toEqual([ceoId]); // dept_head=综合管理部负责人宋启铭

    // manager_chain 2 级：苏明轩 → 郑浩然 → 高峻岭，逐级各成一步
    const f2 = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "chain 表单", visibility: { mode: "all" } } });
    const f2d = (f2.json as { result: { data: { id: string; flowId: string; rowVersion: number; code: string } } }).result.data;
    const f2flow = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: f2d.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: { id: f2d.flowId, rowVersion: (f2flow.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([approvalNode("一级上级", { kind: "manager_chain", levels: 2 })]) },
    });
    const pub2 = await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: f2d.id, rowVersion: f2d.rowVersion } });
    expect(pub2.status).toBe(200);
    const r2 = await trpc(app, "genericRequest.create", { cookie: salesACookie, input: { requestType: f2d.code, title: "chain 提交", reason: "验证", payload: {} } });
    const r2id = (r2.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const s2 = await trpc(app, "genericRequest.submit", { cookie: salesACookie, input: { id: r2id.id, rowVersion: r2id.rowVersion, idempotencyKey: uuid() } });
    expect(s2.status, JSON.stringify(s2.json).slice(0, 250)).toBe(200);
    const inst2 = (s2.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const steps2 = await query<{ approver_id: string | null; seq: number }>(`SELECT approver_id, seq FROM approval_steps WHERE instance_id=$1 ORDER BY seq`, [inst2]);
    expect(steps2.map((s) => s.approver_id)).toEqual([smId, vpId]); // 逐级各成一步

    // initiator_self：sameAsInitiator=self → 提交人本人审批（管晨）
    const f3 = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "self 表单", visibility: { mode: "all" } } });
    const f3d = (f3.json as { result: { data: { id: string; flowId: string; rowVersion: number; code: string } } }).result.data;
    const f3flow = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: f3d.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: { id: f3d.flowId, rowVersion: (f3flow.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([approvalNode("本人确认", { kind: "initiator_self" }, { sameAsInitiator: "self" })]) },
    });
    await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: f3d.id, rowVersion: f3d.rowVersion } });
    const r3 = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: f3d.code, title: "self 提交", reason: "验证", payload: {} } });
    const r3id = (r3.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const s3 = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: r3id.id, rowVersion: r3id.rowVersion, idempotencyKey: uuid() } });
    expect(s3.status).toBe(200);
    const inst3 = (s3.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const memberId = (await query<{ id: string }>(`SELECT id FROM users WHERE email='guanchen@lexflow.demo'`))[0].id;
    const steps3 = await query<{ approver_id: string | null; status: string }>(`SELECT approver_id, status FROM approval_steps WHERE instance_id=$1`, [inst3]);
    expect(steps3[0].approver_id).toBe(memberId);

    // form_contact：人员控件值=何志远 → 该人审批
    const f4 = await trpc(app, "forms.create", {
      cookie: sysadminCookie,
      input: {
        name: "contact 表单",
        visibility: { mode: "all" },
        formSchema: { fields: [{ key: "contact", label: "对接人", control: "person", required: true }] },
      },
    });
    const f4d = (f4.json as { result: { data: { id: string; flowId: string; rowVersion: number; code: string } } }).result.data;
    const f4flow = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: f4d.flowId }, method: "GET" });
    const f4upd = await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: { id: f4d.flowId, rowVersion: (f4flow.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([approvalNode("对接人审", { kind: "form_contact", fieldKey: "contact" })]) },
    });
    expect(f4upd.status, JSON.stringify(f4upd.json).slice(0, 250)).toBe(200);
    const f4pub = await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: f4d.id, rowVersion: f4d.rowVersion } });
    expect(f4pub.status, JSON.stringify(f4pub.json).slice(0, 250)).toBe(200);
    const bad4 = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: f4d.code, title: "x", reason: "x", payload: { contact: uuid() } } });
    expect(bad4.status).toBe(400); // 人员不存在
    const r4 = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: f4d.code, title: "contact 提交", reason: "验证", payload: { contact: presalesId } } });
    expect(r4.status, JSON.stringify(r4.json).slice(0, 250)).toBe(200);
    const r4id = (r4.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const s4 = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: r4id.id, rowVersion: r4id.rowVersion, idempotencyKey: uuid() } });
    expect(s4.status, JSON.stringify(s4.json).slice(0, 250)).toBe(200);
    const inst4 = (s4.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const steps4 = await query<{ approver_id: string | null }>(`SELECT approver_id FROM approval_steps WHERE instance_id=$1`, [inst4]);
    expect(steps4[0].approver_id).toBe(presalesId);
  });

  it("sameAsInitiator 四态 + dedupe once + auto_pass 留痕 + return prev/initiator + requireComment + cc 到达", async () => {
    const memberId = (await query<{ id: string }>(`SELECT id FROM users WHERE email='guanchen@lexflow.demo'`))[0].id;
    // —— sameAsInitiator 四态（initiator_self 节点，提交人=管晨）
    const mkSelfFlow = async (name: string, mode: string) => {
      const f = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name, visibility: { mode: "all" } } });
      const d = (f.json as { result: { data: { id: string; flowId: string; rowVersion: number; code: string } } }).result.data;
      const fl = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: d.flowId }, method: "GET" });
      await trpc(app, "flow.updateDraft", {
        cookie: sysadminCookie,
        input: { id: d.flowId, rowVersion: (fl.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([approvalNode("本人", { kind: "initiator_self" }, { sameAsInitiator: mode as never })]) },
      });
      const p = await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: d.id, rowVersion: d.rowVersion } });
      expect(p.status).toBe(200);
      return d.code;
    };
    const submitAsMember = async (code: string) => {
      const r = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: code, title: "t", reason: "t", payload: {} } });
      const rid = (r.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
      const s = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: rid.id, rowVersion: rid.rowVersion, idempotencyKey: uuid() } });
      expect(s.status).toBe(200);
      return (s.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    };
    // self：本人 pending
    const instSelf = await submitAsMember(await mkSelfFlow("sa-self", "self"));
    let st = await query<{ approver_id: string | null; status: string }>(`SELECT approver_id, status FROM approval_steps WHERE instance_id=$1`, [instSelf]);
    expect(st[0]).toMatchObject({ approver_id: memberId, status: "pending" });
    // skip：与默认一致剔除申请人；全自步按 arch/03 自审禁止红线拒绝（G-20-2-2 登记口径）
    const skipCode = await mkSelfFlow("sa-skip", "skip");
    const rSkip = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: skipCode, title: "t", reason: "t", payload: {} } });
    const rSkipId = (rSkip.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const sSkip = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: rSkipId.id, rowVersion: rSkipId.rowVersion, idempotencyKey: uuid() } });
    expect(sSkip.status).toBe(403);
    expect(trpcError(sSkip).businessCode).toBe("SELF_APPROVAL_BLOCKED");
    // to_manager：替换为直属上级（管晨的上级？查种子——管晨 manager 未配则可能 400；用苏明轩提交验证 manager 替换）
    // —— 管晨无 manager_id 时 to_manager 应如实报错；此处验证报错路径即可：
    const toManagerCode = await mkSelfFlow("sa-tomgr", "to_manager");
    const rt = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: toManagerCode, title: "t", reason: "t", payload: {} } });
    const rtid = (rt.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const stRt = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: rtid.id, rowVersion: rtid.rowVersion, idempotencyKey: uuid() } });
    expect(stRt.status).toBe(400); // 提交人未配置直属上级如实报错

    // —— dedupe once：两步同审批人（user 固定同一人）
    const fd = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "dedupe 表单", visibility: { mode: "all" } } });
    const fdd = (fd.json as { result: { data: { id: string; flowId: string; rowVersion: number; code: string } } }).result.data;
    const fdfl = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: fdd.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: { id: fdd.flowId, rowVersion: (fdfl.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([
        approvalNode("一审", { kind: "user", userId: presalesId }),
        approvalNode("二审", { kind: "user", userId: presalesId }),
      ]) },
    });
    await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: fdd.id, rowVersion: fdd.rowVersion } });
    const rd = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: fdd.code, title: "t", reason: "t", payload: {} } });
    const rdid = (rd.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const sd = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: rdid.id, rowVersion: rdid.rowVersion, idempotencyKey: uuid() } });
    const instD = (sd.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: instD, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    const stD = await query<{ status: string; comment: string | null }>(`SELECT status, comment FROM approval_steps WHERE instance_id=$1 ORDER BY seq`, [instD]);
    expect(stD[1].status).toBe("skipped");
    expect(stD[1].comment).toContain("dedupe");

    // —— auto_pass 留痕：二审自动通过，approval.auto 审计
    const fa = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "auto 表单", visibility: { mode: "all" } } });
    const fad = (fa.json as { result: { data: { id: string; flowId: string; rowVersion: number; code: string } } }).result.data;
    const fafl = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: fad.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: { id: fad.flowId, rowVersion: (fafl.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([
        approvalNode("人审", { kind: "user", userId: presalesId }),
        approvalNode("自动", { kind: "user", userId: pmId }, { approvalType: "auto_pass" }),
      ]) },
    });
    await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: fad.id, rowVersion: fad.rowVersion } });
    const ra = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: fad.code, title: "t", reason: "t", payload: {} } });
    const raid = (ra.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const sa = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: raid.id, rowVersion: raid.rowVersion, idempotencyKey: uuid() } });
    const instA = (sa.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: instA, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    const instArow = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE id=$1`, [instA]);
    expect(instArow[0].status).toBe("approved"); // auto_pass 到步即过
    const autoAudit = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action='approval.auto' AND target_id=$1`, [instA]);
    expect(autoAudit[0].n).toBe(1);

    // —— return prev：一审过→二审退回→二审标 [returned]、一审重置 pending→再审过→终审 approved
    const fr = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "return 表单", visibility: { mode: "all" } } });
    const frd = (fr.json as { result: { data: { id: string; flowId: string; rowVersion: number; code: string } } }).result.data;
    const frfl = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: frd.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: { id: frd.flowId, rowVersion: (frfl.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([
        approvalNode("一审", { kind: "user", userId: presalesId }),
        approvalNode("二审", { kind: "user", userId: pmId }, { ops: { transfer: true, returnBack: "prev", requireCommentOnReject: true, requireCommentOnApprove: false } }),
      ]) },
    });
    await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: frd.id, rowVersion: frd.rowVersion } });
    const rr = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: frd.code, title: "t", reason: "t", payload: {} } });
    const rrid = (rr.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const sr = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: rrid.id, rowVersion: rrid.rowVersion, idempotencyKey: uuid() } });
    const instR = (sr.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: instR, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    const ret = await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: instR, stepSeq: 2, action: "return", comment: "资料不全", idempotencyKey: uuid() } });
    expect(ret.status, JSON.stringify(ret.json).slice(0, 200)).toBe(200);
    let stR = await query<{ seq: number; status: string; comment: string | null }>(`SELECT seq, status, comment FROM approval_steps WHERE instance_id=$1 ORDER BY seq`, [instR]);
    expect(stR.find((x) => x.seq === 2)!.status).toBe("skipped");
    expect(stR.find((x) => x.seq === 2)!.comment).toContain("[returned]");
    expect(stR.find((x) => x.seq === 1)!).toMatchObject({ status: "pending", comment: null });
    const instRrow = await query<{ current_step_seq: number }>(`SELECT current_step_seq FROM approval_instances WHERE id=$1`, [instR]);
    expect(instRrow[0].current_step_seq).toBe(1);
    // 20-02b G4 修复后语义：上一步再批准 → returned 步重挂 pending（不再旁路终审）→ 该步再批准 → approved
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: instR, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    let stR2 = await query<{ seq: number; status: string }>(`SELECT seq, status FROM approval_steps WHERE instance_id=$1 ORDER BY seq`, [instR]);
    expect(stR2.find((x) => x.seq === 2)!.status).toBe("pending"); // 重挂
    await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: instR, stepSeq: 2, action: "approve", idempotencyKey: uuid() } });
    const instR2 = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE id=$1`, [instR]);
    expect(instR2[0].status).toBe("approved");

    // —— return initiator：业务单回草稿（onReturned）
    const fi = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "return-init 表单", visibility: { mode: "all" } } });
    const fid = (fi.json as { result: { data: { id: string; flowId: string; rowVersion: number; code: string } } }).result.data;
    const fifl = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: fid.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: { id: fid.flowId, rowVersion: (fifl.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([
        approvalNode("初审", { kind: "user", userId: presalesId }, { ops: { transfer: true, returnBack: "initiator", requireCommentOnReject: true, requireCommentOnApprove: false } }),
      ]) },
    });
    await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: fid.id, rowVersion: fid.rowVersion } });
    const ri = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: fid.code, title: "t", reason: "t", payload: {} } });
    const riid = (ri.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const si = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: riid.id, rowVersion: riid.rowVersion, idempotencyKey: uuid() } });
    const instI = (si.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const retI = await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: instI, stepSeq: 1, action: "return", comment: "重来", idempotencyKey: uuid() } });
    expect(retI.status).toBe(200);
    const reqI = await query<{ status: string }>(`SELECT status FROM generic_requests WHERE id=$1`, [riid.id]);
    expect(reqI[0].status).toBe("draft"); // 回草稿语义
    const instIrow = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE id=$1`, [instI]);
    expect(instIrow[0].status).toBe("withdrawn"); // 实例留痕 withdrawn（枚举无 returned，audit 区分）

    // —— requireCommentOnApprove 强制
    const fc = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "comment 表单", visibility: { mode: "all" } } });
    const fcd = (fc.json as { result: { data: { id: string; flowId: string; rowVersion: number; code: string } } }).result.data;
    const fcfl = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: fcd.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: { id: fcd.flowId, rowVersion: (fcfl.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([
        approvalNode("严审", { kind: "user", userId: presalesId }, { ops: { transfer: true, returnBack: "none", requireCommentOnReject: true, requireCommentOnApprove: true } }),
      ]) },
    });
    await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: fcd.id, rowVersion: fcd.rowVersion } });
    const rc = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: fcd.code, title: "t", reason: "t", payload: {} } });
    const rcid = (rc.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const sc = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: rcid.id, rowVersion: rcid.rowVersion, idempotencyKey: uuid() } });
    const instC = (sc.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const noComment = await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: instC, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    expect(noComment.status).toBe(400);
    expect(trpcError(noComment).fieldErrors?.comment).toBeTruthy();
    const withComment = await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: instC, stepSeq: 1, action: "approve", comment: "同意", idempotencyKey: uuid() } });
    expect(withComment.status).toBe(200);

    // —— cc 到达：提交时抄送（afterStepIndex=0），partner 获通知且实例只读可见
    const fcc = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "cc 表单", visibility: { mode: "all" } } });
    const fccd = (fcc.json as { result: { data: { id: string; flowId: string; rowVersion: number; code: string } } }).result.data;
    const fccfl = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: fccd.flowId }, method: "GET" });
    const partnerId = (await query<{ id: string }>(`SELECT id FROM users WHERE email='liangqifeng@lexflow.demo'`))[0].id;
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: {
        id: fccd.flowId,
        rowVersion: (fccfl.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion,
        definitionJson: v2Def([
          { type: "cc", name: "提交抄送", receivers: [{ kind: "user", userId: partnerId }] },
          approvalNode("审批", { kind: "user", userId: presalesId }),
        ]),
      },
    });
    await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: fccd.id, rowVersion: fccd.rowVersion } });
    const rcc = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: fccd.code, title: "t", reason: "t", payload: {} } });
    const rccid = (rcc.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const scc = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: rccid.id, rowVersion: rccid.rowVersion, idempotencyKey: uuid() } });
    expect(scc.status).toBe(200);
    const instCc = (scc.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const ccNotify = await query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE event_type='approval_cc' AND source_id=$1`, [rccid.id]);
    expect(ccNotify[0].n).toBeGreaterThanOrEqual(1);
    const ccAudit = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action='approval.cc' AND target_id=$1`, [instCc]);
    expect(ccAudit[0].n).toBe(1);
    const ccView = await trpc(app, "approval.getById", { cookie: partnerCookie, method: "GET", input: { id: instCc } });
    expect(ccView.status).toBe(200); // 抄送人只读可见
    expect((ccView.json as { result: { data: { viewerRole?: string } } }).result.data.viewerRole).toBe("cc");
  });

  it("自定义表单全链：create→updateDraft→publish→member 提交（payload 三类非法 400）→审批完成；published 后改结构 409；visibility 过滤", async () => {
    const created = await trpc(app, "forms.create", {
      cookie: sysadminCookie,
      input: {
        name: "采购申请单",
        groupName: "行政组",
        visibility: { mode: "all" },
        formSchema: {
          fields: [
            { key: "item", label: "物品", control: "text", required: true },
            { key: "qty", label: "数量", control: "number", required: true, min: 1, max: 100 },
            { key: "kind", label: "类别", control: "radio", required: true, options: ["办公", "设备"] },
            { key: "pics", label: "附件", control: "file", required: false },
          ],
        },
      },
    });
    expect(created.status).toBe(200);
    const form = (created.json as { result: { data: { id: string; code: string; flowId: string; rowVersion: number } } }).result.data;
    expect(form.code).toMatch(/^CF-/);
    const badSchema = await trpc(app, "forms.updateDraft", {
      cookie: sysadminCookie,
      input: { id: form.id, rowVersion: form.rowVersion, formSchema: { fields: [
        { key: "item", label: "物品", control: "text", required: true },
        { key: "item", label: "重复", control: "text", required: false },
      ] } },
    });
    expect(badSchema.status).toBe(400);
    const fl = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: form.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: { id: form.flowId, rowVersion: (fl.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([approvalNode("采购审批", { kind: "user", userId: presalesId })]) },
    });
    const pub = await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: form.id, rowVersion: form.rowVersion } });
    expect(pub.status, JSON.stringify(pub.json).slice(0, 250)).toBe(200);
    const pubRow = (pub.json as { result: { data: { rowVersion: number } } }).result.data;
    const frozen = await trpc(app, "forms.updateDraft", { cookie: sysadminCookie, input: { id: form.id, rowVersion: pubRow.rowVersion, name: "改名" } });
    expect(frozen.status).toBe(409);
    const miss = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: form.code, title: "t", reason: "t", payload: { qty: 5, kind: "办公" } } });
    expect(miss.status).toBe(400);
    expect(trpcError(miss).fieldErrors?.["payload.item"]).toBeTruthy();
    const range = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: form.code, title: "t", reason: "t", payload: { item: "纸", qty: 999, kind: "办公" } } });
    expect(range.status).toBe(400);
    expect(trpcError(range).fieldErrors?.["payload.qty"]).toBeTruthy();
    const domain = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: form.code, title: "t", reason: "t", payload: { item: "纸", qty: 5, kind: "不存在" } } });
    expect(domain.status).toBe(400);
    expect(trpcError(domain).fieldErrors?.["payload.kind"]).toBeTruthy();
    const ok = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: form.code, title: "采购", reason: "补货", payload: { item: "A4 纸", qty: 10, kind: "办公" } } });
    expect(ok.status).toBe(200);
    const okRow = (ok.json as { result: { data: { id: string; rowVersion: number; formId: string; formVersion: number } } }).result.data;
    expect(okRow.formId).toBe(form.id);
    expect(okRow.formVersion).toBe(1);
    const okSub = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: okRow.id, rowVersion: okRow.rowVersion, idempotencyKey: uuid() } });
    expect(okSub.status, JSON.stringify(okSub.json).slice(0, 250)).toBe(200);
    const instOk = (okSub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const snapRow = await query<{ form_snapshot: Record<string, unknown> }>(`SELECT form_snapshot FROM approval_instances WHERE id=$1`, [instOk]);
    expect(snapRow[0].form_snapshot["form.item"]).toBe("A4 纸");
    const act = await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: instOk, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    expect(act.status).toBe(200);
    const reqDone = await query<{ status: string }>(`SELECT status FROM generic_requests WHERE id=$1`, [okRow.id]);
    expect(reqDone[0].status).toBe("approved");
    const pubList = await trpc(app, "forms.listPublic", { cookie: memberCookie, method: "GET" });
    expect((pubList.json as { result: { data: Array<{ code: string }> } }).result.data.some((f) => f.code === form.code)).toBe(true);
    const visForm = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "限定表单", visibility: { mode: "users", userIds: [presalesId] } } });
    const visId = (visForm.json as { result: { data: { id: string; code: string } } }).result.data;
    const denied = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: visId.code, title: "t", reason: "t", payload: {} } });
    expect(denied.status).toBe(400);
    expect(trpcError(denied).fieldErrors?.requestType).toBeTruthy();
    const flows = await trpc(app, "flow.list", { cookie: sysadminCookie, method: "GET" });
    const byGroup = (flows.json as { result: { data: { byGroup: Array<{ groupName: string }> } } }).result.data.byGroup;
    expect(byGroup.some((g) => g.groupName === "行政组")).toBe(true);
    expect(byGroup.some((g) => g.groupName === "业务审批")).toBe(true);
  });
});
