import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 6 · 工单 09c（arch 裁定 迭代6-09 修复链）：
 * D3 project.transferManager（partner/sysadmin，同事务换 manager_id + 成员角色迁移 + 审计前后值 + 通知新旧负责人）；
 * 变更后审批解析按当前 manager_id 运行时读取（travel 提交 → 新负责人审批）；
 * O1 search.query 按类型分组（每类 ≤5 + totalByType 精确计数，消除跨类型挤占）；
 * D1 admin.createTemplate（sysadmin，structure 校验复用 updateTemplate 规则）。
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

describe("迭代6-09c：负责人变更 + 搜索分组 + createTemplate", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let partnerCookie: string;
  let sysadminCookie: string;
  let viewerCookie: string;
  let projectAId: string;
  let pmUserId: string;
  let liuchangUserId: string;
  let viewerUserId: string;
  let partnerUserId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    viewerCookie = (await loginAs(app, "hejing@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    const users = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email IN ('wangbaozhuo@lexflow.demo','zhangchen@lexflow.demo','hejing@lexflow.demo','liangqifeng@lexflow.demo')`,
    );
    pmUserId = users.find((u) => u.email === "wangbaozhuo@lexflow.demo")!.id;
    liuchangUserId = users.find((u) => u.email === "zhangchen@lexflow.demo")!.id;
    viewerUserId = users.find((u) => u.email === "hejing@lexflow.demo")!.id;
    partnerUserId = users.find((u) => u.email === "liangqifeng@lexflow.demo")!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("D3 transferManager：partner 变更负责人——同事务角色迁移 + 审计前后值 + 通知新旧负责人", async () => {
    const res = await trpc(app, "project.transferManager", {
      cookie: partnerCookie,
      input: { projectId: projectAId, newManagerId: liuchangUserId, reason: "原负责人调岗（09c 验收）" },
    });
    expect(res.status).toBe(200);

    const proj = await query<{ manager_id: string }>(`SELECT manager_id FROM projects WHERE id=$1`, [projectAId]);
    expect(proj[0].manager_id).toBe(liuchangUserId);
    const roles = await query<{ user_id: string; project_role: string }>(
      `SELECT user_id, project_role FROM project_members WHERE project_id=$1 AND user_id IN ($2,$3) ORDER BY user_id`,
      [projectAId, pmUserId, liuchangUserId],
    );
    const roleOf = (uid: string) => roles.find((r) => r.user_id === uid)?.project_role;
    expect(roleOf(pmUserId)).toBe("member"); // 旧负责人降级
    expect(roleOf(liuchangUserId)).toBe("manager"); // 新负责人升级

    const audit = await query<{ n: number; before_manager: string; after_manager: string; reason: string }>(
      `SELECT count(*)::int AS n,
              before_json->>'managerId' AS before_manager,
              after_json->>'managerId' AS after_manager,
              after_json->>'reason' AS reason
       FROM audit_events WHERE action='project.transferManager' AND target_id=$1 GROUP BY before_json, after_json`,
      [projectAId],
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].before_manager).toBe(pmUserId);
    expect(audit[0].after_manager).toBe(liuchangUserId);
    expect(audit[0].reason).toContain("09c");

    const notices = await query<{ recipient_id: string; event_type: string }>(
      `SELECT recipient_id, event_type FROM notifications WHERE event_type='manager_transferred' AND source_id=$1`,
      [projectAId],
    );
    const recipients = notices.map((n) => n.recipient_id);
    expect(recipients).toContain(liuchangUserId);
    expect(recipients).toContain(pmUserId);
  });

  it("D3 变更后审批解析到新负责人：member 提交 travel → 首步审批人=liuchang（运行时读 manager_id）", async () => {
    const travel = await trpc(app, "travel.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId, reason: "09c 变更后审批探测", destination: "上海",
        startOn: "2027-12-10", endOn: "2027-12-11",
        segments: [{ seq: 1, type: "transport", startAt: "2027-12-10T01:00:00.000Z", endAt: "2027-12-10T03:00:00.000Z" }],
      },
    });
    expect(travel.status).toBe(200);
    const tid = (travel.json as { result: { data: { id: string } } }).result.data.id;
    const detail = await trpc(app, "travel.getById", { cookie: memberCookie, input: { id: tid }, method: "GET" });
    const sub = await trpc(app, "travel.submit", {
      cookie: memberCookie,
      input: { id: tid, rowVersion: (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(sub.status).toBe(200);
    const instId = (sub.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const inst = await trpc(app, "approval.getById", { cookie: memberCookie, input: { id: instId }, method: "GET" });
    const steps = (inst.json as { result: { data: { steps: Array<{ approverId: string | null; seq: number }> } } }).result.data.steps;
    const first = steps.filter((s) => s.seq === Math.min(...steps.map((s) => s.seq)));
    expect(first.some((s) => s.approverId === liuchangUserId)).toBe(true);
  });

  it("D3 非授权同形 404：member 调 transferManager 被拒", async () => {
    const denied = await trpc(app, "project.transferManager", {
      cookie: memberCookie,
      input: { projectId: projectAId, newManagerId: pmUserId, reason: "无权限试探" },
    });
    expect(denied.status).toBe(404);
  });

  it("D3 新负责人必须是项目成员：viewer 非成员 → 400 VALIDATION_FAILED + fieldErrors", async () => {
    const bad = await trpc(app, "project.transferManager", {
      cookie: partnerCookie,
      input: { projectId: projectAId, newManagerId: viewerUserId, reason: "非成员试探" },
    });
    expect(bad.status).toBe(400);
    expect(trpcError(bad).businessCode).toBe("VALIDATION_FAILED");
    expect(trpcError(bad).fieldErrors?.newManagerId).toBeTruthy();
  });

  it("D3 打回修复：project.create 指定 managerId≠创建人——两表同事务一致（恰一条 manager 行），transfer 双向可还原", async () => {
    // partner 立项、指定 liuchang 为负责人（创建人≠负责人）
    const templates = await trpc(app, "project.listTemplates", { cookie: partnerCookie, method: "GET" });
    const templateId = (templates.json as { result: { data: Array<{ id: string }> } }).result.data[0].id;
    const [matter] = await query<{ id: string }>(`SELECT id FROM matters LIMIT 1`);
    const created = await trpc(app, "project.create", {
      cookie: partnerCookie,
      input: {
        templateId, matterId: matter.id, name: "09c打回修复·指定负责人立项",
        startDate: "2027-12-01", managerId: liuchangUserId,
      },
    });
    expect(created.status).toBe(200);
    const projId = (created.json as { result: { data: { id: string } } }).result.data.id;

    // 两表一致：projects.manager_id=liuchang；成员表恰一条 manager 行=liuchang；创建人 partner 落 member
    const proj = await query<{ manager_id: string }>(`SELECT manager_id FROM projects WHERE id=$1`, [projId]);
    expect(proj[0].manager_id).toBe(liuchangUserId);
    const members = await query<{ user_id: string; project_role: string }>(
      `SELECT user_id, project_role FROM project_members WHERE project_id=$1`,
      [projId],
    );
    const managers = members.filter((m) => m.project_role === "manager");
    expect(managers).toHaveLength(1);
    expect(managers[0].user_id).toBe(liuchangUserId);
    expect(members.find((m) => m.user_id === partnerUserId)?.project_role).toBe("member");

    // transfer 双向可还原：liuchang→partner（partner 是成员，不被「必须是项目成员」拦）→ 再转回 liuchang
    const t1 = await trpc(app, "project.transferManager", {
      cookie: partnerCookie,
      input: { projectId: projId, newManagerId: partnerUserId, reason: "09c 双向还原第一步" },
    });
    expect(t1.status).toBe(200);
    let m1 = await query<{ user_id: string; project_role: string }>(
      `SELECT user_id, project_role FROM project_members WHERE project_id=$1`,
      [projId],
    );
    expect(m1.filter((m) => m.project_role === "manager").map((m) => m.user_id)).toEqual([partnerUserId]);
    expect(m1.find((m) => m.user_id === liuchangUserId)?.project_role).toBe("member");

    const t2 = await trpc(app, "project.transferManager", {
      cookie: partnerCookie,
      input: { projectId: projId, newManagerId: liuchangUserId, reason: "09c 双向还原第二步" },
    });
    expect(t2.status).toBe(200);
    m1 = await query<{ user_id: string; project_role: string }>(
      `SELECT user_id, project_role FROM project_members WHERE project_id=$1`,
      [projId],
    );
    expect(m1.filter((m) => m.project_role === "manager").map((m) => m.user_id)).toEqual([liuchangUserId]);
    expect(m1.find((m) => m.user_id === partnerUserId)?.project_role).toBe("member");
    const projAfter = await query<{ manager_id: string }>(`SELECT manager_id FROM projects WHERE id=$1`, [projId]);
    expect(projAfter[0].manager_id).toBe(liuchangUserId);
  });

  it("D3 打回修复：指定负责人不存在/停用 → 400 VALIDATION_FAILED + fieldErrors（不泄 500）", async () => {
    const templates = await trpc(app, "project.listTemplates", { cookie: partnerCookie, method: "GET" });
    const templateId = (templates.json as { result: { data: Array<{ id: string }> } }).result.data[0].id;
    const [matter] = await query<{ id: string }>(`SELECT id FROM matters LIMIT 1`);
    const bad = await trpc(app, "project.create", {
      cookie: partnerCookie,
      input: {
        templateId, matterId: matter.id, name: "09c坏负责人立项",
        startDate: "2027-12-01", managerId: crypto.randomUUID(),
      },
    });
    expect(bad.status).toBe(400);
    expect(trpcError(bad).businessCode).toBe("VALIDATION_FAILED");
    expect(trpcError(bad).fieldErrors?.managerId).toBeTruthy();
  });

  it("O1 搜索分组：两类各超上限时各自 ≤5 条齐全 + totalByType 精确计数（无跨类型挤占）", async () => {
    // 直接造数：项目 A 7 任务 + 7 决策命中同一关键词（pm 为成员可见）
    for (let i = 1; i <= 7; i++) {
      await query(
        `INSERT INTO tasks (code, project_id, title, planned_start, planned_end, status, created_by, updated_by)
         VALUES ($1, $2, $3, '2027-01-01', '2027-01-10', 'pending', $4, $4)`,
        [`TS9C-${YEAR}-${String(i).padStart(4, "0")}`, projectAId, `分组探测任务-${i}`, pmUserId],
      );
      await query(
        `INSERT INTO decisions (code, project_id, title, context, options, status, created_by, updated_by)
         VALUES ($1, $2, $3, '{}'::jsonb, '[]'::jsonb, 'deciding', $4, $4)`,
        [`DCS9C-${YEAR}-${String(i).padStart(4, "0")}`, projectAId, `分组探测决策-${i}`, pmUserId],
      );
    }
    const search = await trpc(app, "search.query", {
      cookie: pmCookie,
      method: "GET",
      input: { q: "分组探测", types: ["task", "decision"] },
    });
    expect(search.status).toBe(200);
    const data = (search.json as {
      result: {
        data: {
          groups: Array<{ type: string; total: number; items: unknown[] }>;
          items: unknown[];
          totalByType: Record<string, number>;
        };
      };
    }).result.data;
    expect(data.totalByType.task).toBe(7);
    expect(data.totalByType.decision).toBe(7);
    const taskGroup = data.groups.find((g) => g.type === "task");
    const decisionGroup = data.groups.find((g) => g.type === "decision");
    expect(taskGroup?.items).toHaveLength(5); // 每类 ≤5
    expect(decisionGroup?.items).toHaveLength(5);
    expect(taskGroup?.total).toBe(7);
    expect(decisionGroup?.total).toBe(7);
    expect(data.items).toHaveLength(10); // 拍平无全局截断（旧实现会挤占到 8）
  });

  it("D1 admin.createTemplate：sysadmin 建模板入 listTemplates；structure 非法/重名/非授权拦截", async () => {
    const created = await trpc(app, "admin.createTemplate", {
      cookie: sysadminCookie,
      input: { name: "09c验收模板", description: "09c 新建入口验收", structure: { stages: [{ name: "阶段一", seq: 1, days: 14 }] } },
    });
    expect(created.status).toBe(200);
    const templates = await trpc(app, "project.listTemplates", { cookie: sysadminCookie, method: "GET" });
    const names = (templates.json as { result: { data: Array<{ name: string }> } }).result.data.map((t) => t.name);
    expect(names).toContain("09c验收模板");

    const badStructure = await trpc(app, "admin.createTemplate", {
      cookie: sysadminCookie,
      input: { name: "09c非法模板", structure: { stages: "not-an-array" } },
    });
    expect(badStructure.status).toBe(400);
    expect(trpcError(badStructure).businessCode).toBe("VALIDATION_FAILED");

    const dup = await trpc(app, "admin.createTemplate", {
      cookie: sysadminCookie,
      input: { name: "09c验收模板", structure: { stages: [{ name: "x", seq: 1 }] } },
    });
    expect(dup.status).toBe(400);
    expect(trpcError(dup).businessCode).toBe("VALIDATION_FAILED");

    const denied = await trpc(app, "admin.createTemplate", {
      cookie: memberCookie,
      input: { name: "09c越权模板", structure: { stages: [{ name: "x", seq: 1 }] } },
    });
    expect(denied.status).toBe(404);
  });
});
