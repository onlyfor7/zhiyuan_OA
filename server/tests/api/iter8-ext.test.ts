import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 8 · 工单 02（arch/11 G3/G4/G5/G9）：
 * ① initiator_choice 发起人指定审批人（快照 chosenApproverId；缺失/指向自己/不存在 → 400+fieldErrors）；
 * ② 条件节点操作符按字段类型校验（数字 gte/lte/between、文本 eq/contains、request_type in；旧符号归一；非法组合 400）；
 * ③ project.flows.* 项目级流程管理（负责人可管、白名单 biz_binding、引擎项目 scope 优先接管、/admin 列表 byScope 分区）；
 * ④ 工时 duration_minutes 步进校验（timesheet.step_minutes 默认 30，提示按小时显示）。
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

function monday(offsetWeeks: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + offsetWeeks * 7);
  return d.toISOString().slice(0, 10);
}

describe("迭代8-02：initiator_choice / 条件操作符 / 项目级流程 / 工时步进", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let managerCookie: string; // 王宝茁（项目 A 负责人）
  let memberCookie: string; // 管晨（项目 A 成员）
  let sysadminCookie: string; // 赵凯
  let projectAId: string;
  let managerUserId: string;
  let memberUserId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    managerCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: managerCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    const users = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email IN ('wangbaozhuo@lexflow.demo','guanchen@lexflow.demo')`,
    );
    managerUserId = users.find((u) => u.email === "wangbaozhuo@lexflow.demo")!.id;
    memberUserId = users.find((u) => u.email === "guanchen@lexflow.demo")!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("G3 initiator_choice：请假默认流——缺 chosenApproverId/指向自己/不存在 → 400+fieldErrors；指定他人 → 步骤落具体人", async () => {
    const createReq = async () => {
      const req = await trpc(app, "genericRequest.create", {
        cookie: memberCookie,
        input: { requestType: "leave", title: "G3 请假（initiator_choice）", reason: "验收", startOn: "2027-12-01", endOn: "2027-12-02" },
      });
      expect(req.status).toBe(200);
      return (req.json as { result: { data: { id: string; rowVersion: number } } }).result.data;
    };
    const submit = (id: string, rowVersion: number, chosenApproverId?: string) =>
      trpc(app, "genericRequest.submit", {
        cookie: memberCookie,
        input: { id, rowVersion, idempotencyKey: crypto.randomUUID(), ...(chosenApproverId ? { chosenApproverId } : {}) },
      });

    // 缺 chosenApproverId → 400 + fieldErrors（事务回滚，仍草稿）
    const r1 = await createReq();
    const missing = await submit(r1.id, r1.rowVersion);
    expect(missing.status).toBe(400);
    expect(trpcError(missing).businessCode).toBe("VALIDATION_FAILED");
    expect(trpcError(missing).fieldErrors?.chosenApproverId).toBeTruthy();

    // 指向自己 → 400
    const selfChosen = await submit(r1.id, r1.rowVersion, memberUserId);
    expect(selfChosen.status).toBe(400);
    expect(trpcError(selfChosen).fieldErrors?.chosenApproverId).toBeTruthy();

    // 不存在 → 400
    const ghost = await submit(r1.id, r1.rowVersion, crypto.randomUUID());
    expect(ghost.status).toBe(400);
    expect(trpcError(ghost).fieldErrors?.chosenApproverId).toBeTruthy();

    // 指定他人 → 200，审批步骤落具体人
    const ok = await submit(r1.id, r1.rowVersion, managerUserId);
    expect(ok.status).toBe(200);
    const instId = (ok.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const inst = await trpc(app, "approval.getById", { cookie: memberCookie, input: { id: instId }, method: "GET" });
    const steps = (inst.json as { result: { data: { steps: Array<{ approverId: string | null }> } } }).result.data.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].approverId).toBe(managerUserId);
  });

  it("G4 条件操作符类型联动：数字 contains/文本 gte/eq 数组 → 400；request_type in 列表与 amount between 二元组 → 合法", async () => {
    const draft = (definitionJson: Record<string, unknown>) =>
      trpc(app, "flow.createDraft", {
        cookie: sysadminCookie,
        input: { name: `G4探测-${crypto.randomUUID().slice(0, 8)}`, scope: "global", bizBinding: "generic_request", definitionJson },
      });
    const base = (expr: Record<string, unknown>) => ({
      nodes: [
        { id: "s", type: "start" },
        { id: "c1", type: "condition", label: "探测", expr },
        { id: "a1", type: "approval", label: "审批", approver: { kind: "role", role: "partner" } },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "c1" },
        { from: "c1", to: "a1", when: true },
        { from: "c1", to: "e", when: false },
        { from: "a1", to: "e" },
      ],
    });

    // 数字字段用文本操作符 → 400 + definitionJson 字段级
    const bad1 = await draft(base({ field: "amount_cents", op: "contains", value: "x" }));
    expect(bad1.status).toBe(400);
    expect(trpcError(bad1).fieldErrors?.definitionJson).toBeTruthy();
    // 文本字段用数字比较 → 400
    const bad2 = await draft(base({ field: "level", op: "gte", value: 1 }));
    expect(bad2.status).toBe(400);
    expect(trpcError(bad2).fieldErrors?.definitionJson).toBeTruthy();
    // eq 值形态错误（数组） → 400
    const bad3 = await draft(base({ field: "request_type", op: "eq", value: ["leave"] }));
    expect(bad3.status).toBe(400);
    // between 非二元组 → 400
    const bad4 = await draft(base({ field: "amount_cents", op: "between", value: [100] }));
    expect(bad4.status).toBe(400);
    // 合法：request_type in 列表 / amount between 二元组（旧符号 >= 归一继续兼容）
    expect((await draft(base({ field: "request_type", op: "in", value: ["leave", "seal"] }))).status).toBe(200);
    expect((await draft(base({ field: "amount_cents", op: "between", value: [100, 5000000] }))).status).toBe(200);
    expect((await draft(base({ field: "amount_cents", op: ">=", value: 5000000 }))).status).toBe(200);
  });

  it("G5 project.flows：负责人可管（非负责人 404）→ 项目流发布接管 travel → 白名单拦截 → /admin byScope 分区 → disable 回默认", async () => {
    // 非负责人不可见
    const denied = await trpc(app, "project.flows.list", { cookie: memberCookie, method: "GET", input: { projectId: projectAId } });
    expect(denied.status).toBe(404);

    const travelFlowDef = {
      nodes: [
        { id: "s", type: "start" },
        { id: "a1", type: "approval", label: "项目内负责人审批", approver: { kind: "project_manager" } },
        { id: "e", type: "end" },
      ],
      edges: [{ from: "s", to: "a1" }, { from: "a1", to: "e" }],
    };
    const draft = await trpc(app, "project.flows.createDraft", {
      cookie: managerCookie,
      input: { projectId: projectAId, name: "G5项目出差流", bizBinding: "travel", definitionJson: travelFlowDef },
    });
    expect(draft.status).toBe(200);
    const flowId = (draft.json as { result: { data: { id: string } } }).result.data.id;
    // scope=project + project_id 绑定
    const scoped = await query<{ scope: string; project_id: string | null }>(`SELECT scope, project_id FROM flow_definitions WHERE id=$1`, [flowId]);
    expect(scoped[0].scope).toBe("project");
    expect(scoped[0].project_id).toBe(projectAId);

    // 白名单：generic_request 不开放
    const offBinding = await trpc(app, "project.flows.createDraft", {
      cookie: managerCookie,
      input: { projectId: projectAId, name: "G5越界绑定", bizBinding: "generic_request", definitionJson: travelFlowDef },
    });
    expect(offBinding.status).toBe(400);

    // 发布 → 项目 A 的出差提交走项目流（项目 scope 优先于 global）
    const pub = await trpc(app, "project.flows.publish", { cookie: managerCookie, input: { projectId: projectAId, id: flowId, idempotencyKey: crypto.randomUUID() } });
    expect(pub.status).toBe(200);
    const replay = await trpc(app, "project.flows.publish", { cookie: managerCookie, input: { projectId: projectAId, id: flowId, idempotencyKey: crypto.randomUUID() } });
    expect((replay.json as { result: { data: { published: boolean } } }).result.data.published).toBe(false);

    const travel = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId, reason: "G5 项目流接管探测", destination: "深圳",
        startOn: "2027-12-10", endOn: "2027-12-11",
        segments: [{ seq: 1, type: "transport", startAt: "2027-12-10T01:00:00.000Z", endAt: "2027-12-10T03:00:00.000Z" }],
      },
    });
    const tid = (travel.json as { result: { data: { id: string } } }).result.data.id;
    const td = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: tid }, method: "GET" });
    const sub = await trpc(app, "travel.submit", {
      cookie: memberCookie,
      input: { id: tid, rowVersion: (td.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const instId = (sub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const inst = await trpc(app, "approval.getById", { cookie: memberCookie, input: { id: instId }, method: "GET" });
    expect((inst.json as { result: { data: { policySnapshot: { flowName?: string } } } }).result.data.policySnapshot.flowName).toBe("G5项目出差流");

    // /admin 列表分区：项目流入 project 区，系统级流仍在 system 区
    const adminList = await trpc(app, "flow.list", { cookie: sysadminCookie, method: "GET" });
    const byScope = (adminList.json as { result: { data: { byScope: { system: Array<{ id: string }>; project: Array<{ id: string }> } } } }).result.data.byScope;
    expect(byScope.project.some((f) => f.id === flowId)).toBe(true);
    expect(byScope.system.length).toBeGreaterThan(0);

    // disable → 新提交回退 global 默认流
    const flowNow = await trpc(app, "flow.getById", { cookie: sysadminCookie, input: { id: flowId }, method: "GET" });
    const dis = await trpc(app, "project.flows.disable", {
      cookie: managerCookie,
      input: { projectId: projectAId, id: flowId, rowVersion: (flowNow.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion },
    });
    expect(dis.status).toBe(200);
    const travel2 = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId, reason: "G5 disable 回退探测", destination: "广州",
        startOn: "2027-12-15", endOn: "2027-12-16",
        segments: [{ seq: 1, type: "transport", startAt: "2027-12-15T01:00:00.000Z", endAt: "2027-12-15T03:00:00.000Z" }],
      },
    });
    const t2id = (travel2.json as { result: { data: { id: string } } }).result.data.id;
    const t2d = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: t2id }, method: "GET" });
    const sub2 = await trpc(app, "travel.submit", {
      cookie: memberCookie,
      input: { id: t2id, rowVersion: (t2d.json as { result: { data: { rowValue: number; rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const inst2 = (sub2.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const inst2Detail = await trpc(app, "approval.getById", { cookie: memberCookie, input: { id: inst2 }, method: "GET" });
    expect((inst2Detail.json as { result: { data: { policySnapshot: { flowName?: string } } } }).result.data.policySnapshot.flowName).toBe("travel 默认流程");
  });

  it("G9 工时步进：非 30 倍数 → 400（提示按小时）；改 timesheet.step_minutes=60 后 90 分钟被拦、120 放行；还原", async () => {
    const week = monday(16);
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const periodId = (mp.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    const save = (minutes: number) =>
      trpc(app, "time.saveEntries", {
        cookie: memberCookie,
        input: {
          periodId,
          idempotencyKey: crypto.randomUUID(),
          entries: [{ projectId: projectAId, activityType: "professional_work", workDate: week, durationMinutes: minutes, description: `G9 ${minutes}分钟` }],
        },
      });

    const bad = await save(45);
    expect(bad.status).toBe(400);
    expect(trpcError(bad).businessCode).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(trpcError(bad).fieldErrors)).toContain("0.5 小时");
    expect((await save(90)).status).toBe(200); // 30 倍数放行

    // 改步进为 60：90 被拦（提示 1 小时）、120 放行；还原 30
    const setCfg = await trpc(app, "admin.setConfig", {
      cookie: sysadminCookie,
      input: { key: "timesheet.step_minutes", value: { minutes: 60, note: "G9 探测" } },
    });
    expect(setCfg.status).toBe(200);
    const bad60 = await save(90);
    expect(bad60.status).toBe(400);
    expect(JSON.stringify(trpcError(bad60).fieldErrors)).toContain("1 小时");
    expect((await save(120)).status).toBe(200);
    await trpc(app, "admin.setConfig", { cookie: sysadminCookie, input: { key: "timesheet.step_minutes", value: { minutes: 30, note: "arch/11：工时填报步进分钟数，可配置" } } });
  });
});
