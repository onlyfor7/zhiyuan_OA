import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import pg from "pg";

import { closeDb } from "../../src/db/client";
import { TEST_DATABASE_URL } from "../db/helpers";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";

/**
 * 迭代 17 · 工单 02（arch/12 §20.2/20.3/20.4 后端部分）：
 * ① project.flows.updateDraft（负责人门+仅草稿可改+审计同事务）；
 * ② GET /events SSE 底座（会话 cookie 鉴权；事务提交后事件到达实证；失败请求零事件）；
 * ③ project.financeOptions（finance/partner 参照级清单，其余同形 404）；
 * ④ reports.expenseCategory 本人口径翻转（member 仅本人可见=200，finance 全量）。
 */

const YEAR = new Date().getFullYear();
const uuid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);

/** 合法流程骨架（同 iter6/8 用例；archivist 角色种子存在，可发布） */
const flowDef = (role: string) => ({
  nodes: [
    { id: "s", type: "start" },
    { id: "a1", type: "approval", label: "审批节点", approver: { kind: "role", role } },
    { id: "e", type: "end" },
  ],
  edges: [
    { from: "s", to: "a1" },
    { from: "a1", to: "e" },
  ],
});

interface FlowRow {
  id: string;
  name: string;
  rowVersion: number;
  enabled: boolean;
  definitionJson: Record<string, unknown>;
}

describe("17-02 项目流编辑+SSE 底座+参照端点+本人口径", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let pmBEmail: string;
  let memberCookie: string;
  let financeCookie: string;
  let partnerCookie: string;
  let viewerCookie: string;
  let projectAId: string;
  let projectBId: string;
  let pmUserId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    pmUserId = String((await loginAs(app, "wangbaozhuo@lexflow.demo")).user.id);
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    viewerCookie = (await loginAs(app, "hejing@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    projectBId = items.find((p) => p.code === `PRJ-${YEAR}-00002`)!.id;
    // 项目 B 负责人邮箱（跨项目负责人越权探针）
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const r = await client.query(
        `SELECT u.email FROM project_members pm JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = $1 AND pm.project_role = 'manager' LIMIT 1`,
        [projectBId],
      );
      pmBEmail = r.rows[0].email as string;
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("updateDraft：负责人门/仅草稿可改/结构校验/乐观锁/审计同事务", async () => {
    const name = `17-02流-${uuid().slice(0, 8)}`;
    const created = await trpc(app, "project.flows.createDraft", {
      cookie: pmCookie,
      input: { projectId: projectAId, name, bizBinding: "travel", definitionJson: flowDef("archivist") },
    });
    expect(created.status).toBe(200);
    let flow = (created.json as { result: { data: FlowRow } }).result.data;
    expect(flow.enabled).toBe(false);

    // ① 非负责人成员（member）→ 同形 404
    const byMember = await trpc(app, "project.flows.updateDraft", {
      cookie: memberCookie,
      input: { projectId: projectAId, id: flow.id, rowVersion: flow.rowVersion, name: "越权" },
    });
    expect(byMember.status).toBe(404);

    // ② 他项目负责人（项目 B manager）→ 同形 404（行属本项目校验）
    const pmBCookie = (await loginAs(app, pmBEmail)).cookie;
    const byOtherPm = await trpc(app, "project.flows.updateDraft", {
      cookie: pmBCookie,
      input: { projectId: projectAId, id: flow.id, rowVersion: flow.rowVersion, name: "越权" },
    });
    expect(byOtherPm.status).toBe(404);

    // ③ 非法结构 → 400（保存即校验，同系统级 FLOW_INVALID 语义）
    const bad = await trpc(app, "project.flows.updateDraft", {
      cookie: pmCookie,
      input: { projectId: projectAId, id: flow.id, rowVersion: flow.rowVersion, definitionJson: { nodes: [], edges: [] } },
    });
    expect(bad.status).toBe(400);
    expect(trpcError(bad).businessCode).toBe("VALIDATION_FAILED");

    // ④ 乐观锁：错 rowVersion → 409
    const stale = await trpc(app, "project.flows.updateDraft", {
      cookie: pmCookie,
      input: { projectId: projectAId, id: flow.id, rowVersion: flow.rowVersion + 1, name: "并发" },
    });
    expect(stale.status).toBe(409);
    expect(trpcError(stale).businessCode).toBe("STATE_CONFLICT");

    // ⑤ 成功：改名+改 definitionJson → rowVersion+1 且落库
    const newName = `${name}-v2`;
    const ok = await trpc(app, "project.flows.updateDraft", {
      cookie: pmCookie,
      input: { projectId: projectAId, id: flow.id, rowVersion: flow.rowVersion, name: newName, definitionJson: flowDef("finance") },
    });
    expect(ok.status).toBe(200);
    flow = (ok.json as { result: { data: FlowRow } }).result.data;
    expect(flow.name).toBe(newName);
    expect(flow.rowVersion).toBe(1);
    expect(JSON.stringify(flow.definitionJson)).toContain("finance");

    // ⑥ 发布后不可改（状态守卫仅草稿可改）→ 409
    const published = await trpc(app, "project.flows.publish", {
      cookie: pmCookie,
      input: { projectId: projectAId, id: flow.id, idempotencyKey: uuid() },
    });
    expect(published.status).toBe(200);
    const afterPublish = await trpc(app, "project.flows.updateDraft", {
      cookie: pmCookie,
      input: { projectId: projectAId, id: flow.id, rowVersion: flow.rowVersion, name: "改已发布" },
    });
    expect(afterPublish.status).toBe(409);
    expect(trpcError(afterPublish).message).toContain("已发布");

    // ⑦ 审计同事务：authedMutation 自动写 audit_events（成功行）
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const audit = await client.query(
        `SELECT count(*)::int AS n FROM audit_events
         WHERE action = 'project.flows.updateDraft' AND result = 'success'`,
      );
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
    } finally {
      await client.end();
    }
  });

  it("SSE /events：cookie 鉴权 + 事务提交后事件到达 + 失败请求零事件", async () => {
    // 未登录 → 401 同形（与 tRPC AUTH_REQUIRED 一致）
    const anon = await app.request("http://test/events");
    expect(anon.status).toBe(401);
    const anonBody = (await anon.json()) as { error: { data: { businessCode: string } } };
    expect(anonBody.error.data.businessCode).toBe("AUTH_REQUIRED");

    // pm 建流：连接建立（text/event-stream）
    const res = await app.request("http://test/events", { headers: { cookie: pmCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const readWithTimeout = async (ms: number): Promise<string | null> => {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
      const chunk = await Promise.race([reader.read().then((r) => (r.done ? "" : decoder.decode(r.value))), timeout]);
      return chunk;
    };

    // member 提申请单并提交（chosenApproverId=pm）→ 审批引擎同事务发事件
    const req = await trpc(app, "genericRequest.create", {
      cookie: memberCookie,
      input: { requestType: "leave", title: "17-02 SSE 请假", reason: "实时化验证" },
    });
    expect(req.status).toBe(200);
    const reqId = (req.json as { result: { data: { id: string } } }).result.data.id;
    const submitted = await trpc(app, "genericRequest.submit", {
      cookie: memberCookie,
      input: { id: reqId, rowVersion: 0, idempotencyKey: uuid(), chosenApproverId: pmUserId },
    });
    expect(submitted.status).toBe(200);

    // 事件到达：notification.created + approval.todo + assistant.feed
    let text = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(text.includes("approval.todo") && text.includes("assistant.feed") && text.includes("notification.created"))) {
      const chunk = await readWithTimeout(2_000);
      if (chunk === null) continue;
      if (chunk === "") break;
      text += chunk;
    }
    expect(text).toContain("event: notification.created");
    expect(text).toContain("event: approval.todo");
    expect(text).toContain("event: assistant.feed");
    expect(text).toContain(`"instanceId"`); // approval.todo 载荷
    await reader.cancel();

    // 失败请求零事件：重连后打一发 404 mutation → 读超时（无事件）
    const res2 = await app.request("http://test/events", { headers: { cookie: pmCookie } });
    expect(res2.status).toBe(200);
    const reader2 = res2.body!.getReader();
    const failed = await trpc(app, "genericRequest.submit", {
      cookie: memberCookie,
      input: { id: uuid(), rowVersion: 0, idempotencyKey: uuid() },
    });
    expect(failed.status).toBe(404);
    const chunk2 = await Promise.race([
      reader2.read().then((r) => (r.done ? "" : decoder.decode(r.value))),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    expect(chunk2).toBeNull(); // 事务回滚 → 缓冲丢弃 → 无事件
    await reader2.cancel();
  });

  it("project.financeOptions：finance/partner 参照级清单，其余同形 404", async () => {
    for (const cookie of [financeCookie, partnerCookie]) {
      const res = await trpc(app, "project.financeOptions", { cookie, method: "GET" });
      expect(res.status).toBe(200);
      const items = (res.json as { result: { data: { id: string; code: string; name: string }[] } }).result.data;
      expect(items.length).toBe(5);
      expect(Object.keys(items[0]).sort()).toEqual(["code", "id", "name"]); // 最小字段
      const codes = items.map((p) => p.code);
      expect([...codes].sort()).toEqual(codes); // 按 code 排序
    }
    for (const cookie of [memberCookie, viewerCookie, pmCookie]) {
      const res = await trpc(app, "project.financeOptions", { cookie, method: "GET" });
      expect(res.status).toBe(404);
      expect(trpcError(res).businessCode).toBe("ACCESS_DENIED_OR_GONE");
    }
  });

  it("reports.expenseCategory 口径翻转：member 本人口径 200 / finance 全量 / viewer 空集 200", async () => {
    const totalOf = (res: Awaited<ReturnType<typeof trpc>>) => {
      const data = (res.json as { result: { data: { rows: unknown[]; summaryCards: { key: string; value: number }[] } } }).result.data;
      return { rows: data.rows.length, total: data.summaryCards.find((c) => c.key === "total")!.value };
    };

    // 基线：member 本人口径=种子 EXP-00002（本人 paid：meals 500000+travel_other 300000）
    const m0 = await trpc(app, "reports.expenseCategory", { cookie: memberCookie, method: "GET", input: {} });
    expect(m0.status).toBe(200);
    expect(totalOf(m0).total).toBe(800000);

    // zhangchen（项目 A 另一普通成员，≠guanchen）造一单 meals 100000——审批人=项目负责人 wangbaozhuo
    const zcCookie = (await loginAs(app, "zhangchen@lexflow.demo")).cookie;
    const exp = await trpc(app, "expense.create", {
      cookie: zcCookie,
      input: { reason: "17-02 口径翻转", items: [{ projectId: projectAId, date: today(), category: "meals", amountCents: 100000, description: "测试餐费" }] },
    });
    expect(exp.status).toBe(200);
    const expId = (exp.json as { result: { data: { id: string } } }).result.data.id;
    const detail = await trpc(app, "expense.getById", { cookie: zcCookie, input: { id: expId }, method: "GET" });
    const sub = await trpc(app, "expense.submit", {
      cookie: zcCookie,
      input: { id: expId, rowVersion: (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: uuid() },
    });
    expect(sub.status, `expense.submit：${JSON.stringify(sub.json).slice(0, 300)}`).toBe(200);
    const instId = (sub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;

    const acted = await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: instId, stepSeq: 1, action: "approve", idempotencyKey: uuid() },
    });
    expect(acted.status, `approval.act#1：${JSON.stringify(acted.json).slice(0, 300)}`).toBe(200);
    // 默认流程为 pm → finance 两步：财务终审后落 approved_pending_payment（计入类别分析口径）
    const acted2 = await trpc(app, "approval.act", {
      cookie: financeCookie,
      input: { instanceId: instId, stepSeq: 2, action: "approve", idempotencyKey: uuid() },
    });
    expect(acted2.status, `approval.act#2：${JSON.stringify(acted2.json).slice(0, 300)}`).toBe(200);

    // 翻转断言：finance 全量 +100000；member 本人口径不变（看不见他人的）；viewer 空集 200
    const f1 = await trpc(app, "reports.expenseCategory", { cookie: financeCookie, method: "GET", input: {} });
    expect(f1.status).toBe(200);
    expect(totalOf(f1).total).toBe(900000);

    const m1 = await trpc(app, "reports.expenseCategory", { cookie: memberCookie, method: "GET", input: {} });
    expect(m1.status).toBe(200);
    expect(totalOf(m1).total).toBe(800000); // 本人口径不随他人单据放大

    const v1 = await trpc(app, "reports.expenseCategory", { cookie: viewerCookie, method: "GET", input: {} });
    expect(v1.status).toBe(200);
    expect(totalOf(v1).rows).toBe(0); // 空集 200（与 404 归一为同形态）
  });
});
