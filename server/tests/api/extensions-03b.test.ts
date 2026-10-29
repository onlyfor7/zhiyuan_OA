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

async function me(app: Awaited<ReturnType<typeof getApp>>, cookie: string): Promise<string> {
  const result = await trpc(app, "auth.me", { cookie, method: "GET" });
  return (result.json as { result: { data: { user: { id: string } } } }).result.data.user.id;
}

describe("迭代 6 · 工单 03b（R1 修复 / 状态列切换 / 流程项目绑定）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let financeCookie: string;
  let partnerCookie: string;
  let sysadminCookie: string;
  let viewerCookie: string;
  let projectAId: string;
  let projectBId: string;

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
  });

  afterAll(async () => {
    await closeDb();
  });

  it("R1：member/viewer 对 receipts.list/summary/exportCsv 统一同形 404（与 getById 一致）", async () => {
    for (const cookie of [memberCookie, viewerCookie]) {
      const list = await trpc(app, "receipts.list", { cookie, method: "GET", input: {} });
      const summary = await trpc(app, "receipts.summary", { cookie, method: "GET", input: { by: "project" } });
      const csv = await trpc(app, "receipts.exportCsv", { cookie, method: "GET", input: {} });
      for (const res of [list, summary, csv]) {
        expect(res.status).toBe(404);
        expect(trpcError(res).businessCode).toBe("ACCESS_DENIED_OR_GONE");
      }
    }
    // pm（本项目 manager）/finance/partner 正常
    expect((await trpc(app, "receipts.list", { cookie: pmCookie, method: "GET", input: { projectId: projectAId } })).status).toBe(200);
    expect((await trpc(app, "receipts.summary", { cookie: financeCookie, method: "GET", input: { by: "project" } })).status).toBe(200);
    expect((await trpc(app, "receipts.summary", { cookie: partnerCookie, method: "GET", input: { by: "client" } })).status).toBe(200);
  });

  it("状态列切换：客户停用落到行并从参照端点消失（再启用恢复）；mustChangePassword 读新列", async () => {
    const client = await trpc(app, "admin.createClient", { cookie: sysadminCookie, input: { name: "停用切换探测（虚构）" } });
    const clientId = (client.json as { result: { data: { id: string } } }).result.data.id;
    const before = await trpc(app, "client.list", { cookie: pmCookie, method: "GET" });
    expect((before.json as { result: { data: { items: { id: string }[] } } }).result.data.items.some((c) => c.id === clientId)).toBe(true);

    await trpc(app, "admin.setClientDisabled", { cookie: sysadminCookie, input: { clientId, disabled: true } });
    const after = await trpc(app, "client.list", { cookie: pmCookie, method: "GET" });
    expect((after.json as { result: { data: { items: { id: string }[] } } }).result.data.items.some((c) => c.id === clientId)).toBe(false);
    const row = await query<{ status: string }>(`SELECT status FROM clients WHERE id = $1`, [clientId]);
    expect(row[0].status).toBe("disabled"); // 落到行，非 system_config

    await trpc(app, "admin.setClientDisabled", { cookie: sysadminCookie, input: { clientId, disabled: false } });
    const reenabled = await trpc(app, "client.list", { cookie: pmCookie, method: "GET" });
    expect((reenabled.json as { result: { data: { items: { id: string }[] } } }).result.data.items.some((c) => c.id === clientId)).toBe(true);

    // mustChangePassword 走 users 列（行为不变回归）
    const created = await trpc(app, "admin.createUser", {
      cookie: sysadminCookie,
      input: { email: "column-user@lexflow.demo", name: "列切换用户", roleKey: "member" },
    });
    const { initialPassword } = (created.json as { result: { data: { initialPassword: string } } }).result.data;
    const first = await loginAs(app, "column-user@lexflow.demo", initialPassword);
    const me1 = await trpc(app, "auth.me", { cookie: first.cookie, method: "GET" });
    expect((me1.json as { result: { data: { mustChangePassword: boolean } } }).result.data.mustChangePassword).toBe(true);
    await trpc(app, "auth.changePassword", {
      cookie: first.cookie,
      input: { oldPassword: initialPassword, newPassword: "Column2026!!" },
    });
    const flag = await query<{ must_change_password: boolean }>(`SELECT must_change_password FROM users WHERE email = 'column-user@lexflow.demo'`);
    expect(flag[0].must_change_password).toBe(false);
  });

  it("流程项目绑定：project scope 且 project_id 匹配优先于 global", async () => {
    // global：change_request 默认流程（partner/pm 级）已在位；为项目 B 建 project scope 专属流程（单步 archivist）
    const scoped = await trpc(app, "flow.createDraft", {
      cookie: sysadminCookie,
      input: {
        name: "项目B专属延期流程",
        scope: "project",
        bizBinding: "change_request",
        projectId: projectBId,
        definitionJson: {
          nodes: [
            { id: "s", type: "start" },
            { id: "a1", type: "approval", label: "档案管理员审延期", approver: { kind: "role", role: "archivist" } },
            { id: "e", type: "end" },
          ],
          edges: [
            { from: "s", to: "a1" },
            { from: "a1", to: "e" },
          ],
        },
      },
    });
    expect(scoped.status).toBe(200);
    const scopedId = (scoped.json as { result: { data: { id: string } } }).result.data.id;
    const published = await trpc(app, "flow.publish", { cookie: sysadminCookie, input: { id: scopedId, idempotencyKey: crypto.randomUUID() } });
    expect(published.status).toBe(200);

    // pm 在项目 B 上发起延期 → 命中项目绑定流程（archivist 单步），而非 global 默认
    const current = await trpc(app, "plan.current", { cookie: pmCookie, method: "GET", input: { projectId: projectBId } });
    const target = (current.json as { result: { data: { items: { itemType: string; refId: string }[] } } })
      .result.data.items.find((i) => i.itemType === "task")!;
    const archivistCookie = (await loginAs(app, "archivist@lexflow.demo")).cookie;
    const created = await trpc(app, "change.create", {
      cookie: pmCookie,
      input: {
        projectId: projectBId,
        title: "项目B绑定流程探测",
        level: "key",
        targetItems: [{ ref_id: target.refId, item_type: "task", new_start: "2027-12-20", new_end: "2027-12-28" }],
        reason: "绑定探测",
        impact: "绑定探测",
        recoveryMeasures: [{ measure: "恢复", owner_id: (await me(app, pmCookie)), checkpoint_date: "2027-12-21" }],
      },
    });
    const crId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const cr = await trpc(app, "change.getById", { cookie: pmCookie, input: { id: crId }, method: "GET" });
    const submitted = await trpc(app, "change.submit", {
      cookie: pmCookie,
      input: { id: crId, rowVersion: (cr.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(submitted.status).toBe(200);
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const inst = await trpc(app, "approval.getById", { cookie: archivistCookie, input: { id: instanceId }, method: "GET" });
    const data = (inst.json as {
      result: { data: { policySnapshot: { flowName?: string }; steps: { approverRole: string | null }[] } };
    }).result.data;
    expect(data.policySnapshot.flowName).toBe("项目B专属延期流程"); // 项目绑定优先命中
    expect(data.steps.map((s) => s.approverRole)).toEqual(["archivist"]);

    // 项目 A 不受项目 B 绑定影响（global 默认仍生效）
    const flowA = await trpc(app, "plan.current", { cookie: pmCookie, method: "GET", input: { projectId: projectAId } });
    void flowA;
    const changeACreated = await trpc(app, "change.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        title: "项目A默认流程探测",
        level: "normal",
        targetItems: [
          {
            ref_id: (flowA.json as { result: { data: { items: { itemType: string; refId: string }[] } } }).result.data.items.find((i) => i.itemType === "task")!.refId,
            item_type: "task",
            new_start: "2027-12-01",
            new_end: "2027-12-09",
          },
        ],
        reason: "A 探测",
        impact: "A 探测",
        recoveryMeasures: [{ measure: "恢复", owner_id: (await me(app, memberCookie)), checkpoint_date: "2027-12-02" }],
      },
    });
    const aId = (changeACreated.json as { result: { data: { id: string } } }).result.data.id;
    const aDetail = await trpc(app, "change.getById", { cookie: memberCookie, input: { id: aId }, method: "GET" });
    const aSub = await trpc(app, "change.submit", {
      cookie: memberCookie,
      input: { id: aId, rowVersion: (aDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const aInst = (aSub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const aInstDetail = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: aInst }, method: "GET" });
    expect((aInstDetail.json as { result: { data: { policySnapshot: { flowName?: string } } } }).result.data.policySnapshot.flowName).not.toBe("项目B专属延期流程");
  });
});

