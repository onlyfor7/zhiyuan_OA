import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { TEST_DATABASE_URL } from "../db/helpers";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";

/**
 * 迭代 20 · 工单 02b（20-03-G3/G4/G5 服务端三缺陷，arch/14 §4.3/§7/§8）：
 * G3 表单 schema 非管理角色可读（getById visibility 放行/listPublic 携 schema/详情附 formSchema）；
 * G4 return prev 再到达重挂（重置 pending + dedupe 豁免）；G5 末端 cc 仅 approved 终态触发。
 */

const uuid = () => crypto.randomUUID();

const v2Def = (nodes: unknown[]) => ({
  schemaVersion: 2,
  settings: { allowWithdrawPending: true, dedupeApprover: "once", titleTemplate: null, summaryFieldKeys: [] },
  nodes,
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

describe("20-02b G3/G4/G5 服务端修复", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let sysadminCookie: string;
  let memberCookie: string;
  let presalesCookie: string;
  let pmCookie: string;
  let presalesId: string;
  let pmId: string;
  let memberId: string;
  let partnerId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    presalesCookie = (await loginAs(app, "hezhiyuan@lexflow.demo")).cookie;
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    const ids = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email IN ('hezhiyuan@lexflow.demo','wangbaozhuo@lexflow.demo','guanchen@lexflow.demo','liangqifeng@lexflow.demo')`,
    );
    presalesId = ids.find((u) => u.email.startsWith("hezhiyuan"))!.id;
    pmId = ids.find((u) => u.email.startsWith("wangbaozhuo"))!.id;
    memberId = ids.find((u) => u.email.startsWith("guanchen"))!.id;
    partnerId = ids.find((u) => u.email.startsWith("liangqifeng"))!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("G3：getById 非管理放行（published+visibility 命中）/未命中 404/draft 404；listPublic 携 formSchema；详情附 formSchema", async () => {
    // visibility=roles:[presales] 的 published 表单
    const created = await trpc(app, "forms.create", {
      cookie: sysadminCookie,
      input: {
        name: "G3 用章申请",
        visibility: { mode: "roles", roleKeys: ["presales"] },
        formSchema: { fields: [{ key: "purpose", label: "用途", control: "text", required: true }] },
      },
    });
    const form = (created.json as { result: { data: { id: string; code: string; flowId: string; rowVersion: number } } }).result.data;
    const fl = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: form.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: { id: form.flowId, rowVersion: (fl.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, definitionJson: v2Def([approvalNode("审", { kind: "user", userId: pmId })]) },
    });
    const pub = await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: form.id, rowVersion: form.rowVersion } });
    expect(pub.status).toBe(200);

    // 命中角色（presales）可读 schema
    const hit = await trpc(app, "forms.getById", { cookie: presalesCookie, method: "GET", input: { id: form.id } });
    expect(hit.status).toBe(200);
    expect((hit.json as { result: { data: { formSchema: { fields: Array<{ key: string }> } } } }).result.data.formSchema.fields[0].key).toBe("purpose");
    // 未命中（member 非 presales）同形 404
    const miss = await trpc(app, "forms.getById", { cookie: memberCookie, method: "GET", input: { id: form.id } });
    expect(miss.status).toBe(404);
    expect(trpcError(miss).businessCode).toBe("ACCESS_DENIED_OR_GONE");
    // draft 表单非管理 404（另建草稿）
    const draft = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "G3 草稿", visibility: { mode: "all" } } });
    const draftId = (draft.json as { result: { data: { id: string } } }).result.data.id;
    const draftRead = await trpc(app, "forms.getById", { cookie: presalesCookie, method: "GET", input: { id: draftId } });
    expect(draftRead.status).toBe(404);
    // listPublic：命中者携 formSchema
    const pubList = await trpc(app, "forms.listPublic", { cookie: presalesCookie, method: "GET" });
    const item = (pubList.json as { result: { data: Array<{ id: string; formSchema?: { fields: unknown[] } }> } }).result.data.find((f) => f.id === form.id)!;
    expect(item.formSchema?.fields).toHaveLength(1);
    // member listPublic 不含该表单（visibility 过滤）
    const memberList = await trpc(app, "forms.listPublic", { cookie: memberCookie, method: "GET" });
    expect((memberList.json as { result: { data: Array<{ id: string }> } }).result.data.some((f) => f.id === form.id)).toBe(false);

    // 提交→审批详情/申请单详情附 formSchema（key→label 渲染数据）
    const r = await trpc(app, "genericRequest.create", { cookie: presalesCookie, input: { requestType: form.code, title: "G3", reason: "x", payload: { purpose: "签约" } } });
    const rid = (r.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const s = await trpc(app, "genericRequest.submit", { cookie: presalesCookie, input: { id: rid.id, rowVersion: rid.rowVersion, idempotencyKey: uuid() } });
    expect(s.status, JSON.stringify(s.json).slice(0, 300)).toBe(200);
    const instId = (s.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const det = await trpc(app, "approval.getById", { cookie: presalesCookie, method: "GET", input: { id: instId } });
    expect(det.status).toBe(200);
    expect((det.json as { result: { data: { formSchema: { fields: Array<{ label: string }> } } } }).result.data.formSchema.fields[0].label).toBe("用途");
    const detail = await trpc(app, "approval.detail", { cookie: presalesCookie, method: "GET", input: { instanceId: instId } });
    expect(detail.status, JSON.stringify(detail.json).slice(0, 250)).toBe(200);
    expect((detail.json as { result: { data: { formSchema: { fields: unknown[] } } } }).result.data.formSchema.fields).toHaveLength(1);
    const reqDet = await trpc(app, "genericRequest.getById", { cookie: presalesCookie, method: "GET", input: { id: rid.id } });
    expect((reqDet.json as { result: { data: { formSchema: { fields: unknown[] }; payload: Record<string, unknown> } } }).result.data.formSchema.fields).toHaveLength(1);
  });

  it("G4：return prev→上一步再批准→returned 步重挂 pending→再批准→实例 approved；重挂步拒绝路径 rejected", async () => {
    const created = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "G4 重挂验证", visibility: { mode: "all" } } });
    const form = (created.json as { result: { data: { id: string; code: string; flowId: string; rowVersion: number } } }).result.data;
    const fl = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: form.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: {
        id: form.flowId,
        rowVersion: (fl.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion,
        definitionJson: v2Def([
          approvalNode("一审", { kind: "user", userId: presalesId }),
          approvalNode("二审", { kind: "user", userId: pmId }, { ops: { transfer: true, returnBack: "prev", requireCommentOnReject: true, requireCommentOnApprove: false } }),
        ]),
      },
    });
    await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: form.id, rowVersion: form.rowVersion } });

    const submit = async () => {
      const r = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: form.code, title: "G4", reason: "x", payload: {} } });
      const rid = (r.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
      const s = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: rid.id, rowVersion: rid.rowVersion, idempotencyKey: uuid() } });
      return (s.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    };
    const stepsOf = async (inst: string) =>
      query<{ seq: number; status: string; comment: string | null }>(`SELECT seq, status, comment FROM approval_steps WHERE instance_id=$1 ORDER BY seq`, [inst]);

    // 批准路径：1 过 → 2 退回 → 1 再批准 → 2 重挂 → 2 批准 → approved
    const inst1 = await submit();
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: inst1, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    const ret = await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: inst1, stepSeq: 2, action: "return", comment: "补材料", idempotencyKey: uuid() } });
    expect(ret.status).toBe(200);
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: inst1, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    let steps = await stepsOf(inst1);
    expect(steps.find((x) => x.seq === 2)).toMatchObject({ status: "pending", comment: null }); // 重挂
    expect(steps.filter((x) => x.status === "pending")).toHaveLength(1);
    const rearmAudit = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action='approval.rearm' AND target_id=$1`, [inst1]);
    expect(rearmAudit[0].n).toBe(1);
    const again = await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: inst1, stepSeq: 2, action: "approve", idempotencyKey: uuid() } });
    expect(again.status).toBe(200);
    const fin1 = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE id=$1`, [inst1]);
    expect(fin1[0].status).toBe("approved"); // 终审在重审之后

    // 拒绝路径：重挂步拒绝 → rejected
    const inst2 = await submit();
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: inst2, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: inst2, stepSeq: 2, action: "return", comment: "退回", idempotencyKey: uuid() } });
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: inst2, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    steps = await stepsOf(inst2);
    expect(steps.find((x) => x.seq === 2)!.status).toBe("pending");
    const rej = await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: inst2, stepSeq: 2, action: "reject", comment: "不通过", idempotencyKey: uuid() } });
    expect(rej.status).toBe(200);
    const fin2 = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE id=$1`, [inst2]);
    expect(fin2[0].status).toBe("rejected");
  });

  it("G5：末端 cc 末步 pending 不发→批准后到达；拒绝路径全程无 cc", async () => {
    const created = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "G5 末端抄送", visibility: { mode: "all" } } });
    const form = (created.json as { result: { data: { id: string; code: string; flowId: string; rowVersion: number } } }).result.data;
    const fl = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: form.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: {
        id: form.flowId,
        rowVersion: (fl.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion,
        definitionJson: v2Def([
          approvalNode("审批", { kind: "user", userId: presalesId }),
          { type: "cc", name: "结束抄送", receivers: [{ kind: "user", userId: partnerId }] },
        ]),
      },
    });
    await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: form.id, rowVersion: form.rowVersion } });
    const ccOf = async (inst: string) =>
      query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action='approval.cc' AND target_id=$1`, [inst]);

    // 批准路径：到达末步（唯一审批步）时末端 cc 不发；批准终态后到达
    const r1 = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: form.code, title: "G5a", reason: "x", payload: {} } });
    const rid1 = (r1.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const s1 = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: rid1.id, rowVersion: rid1.rowVersion, idempotencyKey: uuid() } });
    const inst1 = (s1.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    expect((await ccOf(inst1))[0].n).toBe(0); // pending 不发
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: inst1, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
    expect((await ccOf(inst1))[0].n).toBe(1); // 终态后到达
    const notify = await query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE event_type='approval_cc' AND payload_json->>'approvalInstanceId'=$1`, [inst1]);
    expect(notify[0].n).toBe(1);

    // 拒绝路径：全程无 cc
    const r2 = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: form.code, title: "G5b", reason: "x", payload: {} } });
    const rid2 = (r2.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const s2 = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: rid2.id, rowVersion: rid2.rowVersion, idempotencyKey: uuid() } });
    const inst2 = (s2.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await trpc(app, "approval.act", { cookie: presalesCookie, input: { instanceId: inst2, stepSeq: 1, action: "reject", comment: "拒绝", idempotencyKey: uuid() } });
    expect((await ccOf(inst2))[0].n).toBe(0);
    // 中段 cc 语义不变（到步即发）：cc 插在审批步之前（afterStepIndex=0）提交即发
    const created2 = await trpc(app, "forms.create", { cookie: sysadminCookie, input: { name: "G5 中段抄送", visibility: { mode: "all" } } });
    const form2 = (created2.json as { result: { data: { id: string; code: string; flowId: string; rowVersion: number } } }).result.data;
    const fl2 = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: form2.flowId }, method: "GET" });
    await trpc(app, "flow.updateDraft", {
      cookie: sysadminCookie,
      input: {
        id: form2.flowId,
        rowVersion: (fl2.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion,
        definitionJson: v2Def([
          { type: "cc", name: "提交知会", receivers: [{ kind: "user", userId: partnerId }] },
          approvalNode("审批", { kind: "user", userId: presalesId }),
        ]),
      },
    });
    await trpc(app, "forms.publish", { cookie: sysadminCookie, input: { id: form2.id, rowVersion: form2.rowVersion } });
    const r3 = await trpc(app, "genericRequest.create", { cookie: memberCookie, input: { requestType: form2.code, title: "G5c", reason: "x", payload: {} } });
    const rid3 = (r3.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    const s3 = await trpc(app, "genericRequest.submit", { cookie: memberCookie, input: { id: rid3.id, rowVersion: rid3.rowVersion, idempotencyKey: uuid() } });
    const inst3 = (s3.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    expect((await ccOf(inst3))[0].n).toBe(1); // 提交即触发，不变
  });
});
