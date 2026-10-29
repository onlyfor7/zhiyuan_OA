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

describe("工单 02b：参照数据端点 / 立项权限门 / plan_items.name / plan 输出补齐", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let partnerCookie: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "partner@lexflow.demo")).cookie;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("user.list：任意登录用户可调，最小字段 + status=active + keyword 过滤", async () => {
    const result = await trpc(app, "user.list", { cookie: pmCookie, method: "GET" });
    expect(result.status).toBe(200);
    const data = (result.json as {
      result: { data: { items: { id: string; name: string; email: string; orgUnitName: string | null }[] } };
    }).result.data;
    expect(data.items.length).toBeGreaterThanOrEqual(12);
    const pm = data.items.find((u) => u.email === "pm@lexflow.demo");
    expect(pm).toMatchObject({ name: "陈立", orgUnitName: "诉讼业务部" });

    const keyword = await trpc(app, "user.list", {
      cookie: pmCookie,
      method: "GET",
      input: { keyword: "林晓" },
    });
    const keywordItems = (keyword.json as { result: { data: { items: { email: string }[] } } }).result.data.items;
    expect(keywordItems).toHaveLength(1);
    expect(keywordItems[0].email).toBe("member@lexflow.demo");

    // 未登录 → 401
    const anonymous = await trpc(app, "user.list", { method: "GET" });
    expect(anonymous.status).toBe(401);
    expect(trpcError(anonymous).businessCode).toBe("AUTH_REQUIRED");
  });

  it("client.list / matter.list：最小字段、keyword 与 clientId 过滤", async () => {
    const clients = await trpc(app, "client.list", { cookie: memberCookie, method: "GET" });
    expect(clients.status).toBe(200);
    const clientItems = (clients.json as { result: { data: { items: { id: string; code: string; name: string }[] } } })
      .result.data.items;
    expect(clientItems.length).toBe(4); // 华宸 / 星澜 / 恒岳 / 佳力奇（虚构）
    expect(clientItems[0]).toHaveProperty("code");
    expect(clientItems[0]).toHaveProperty("name");

    const clientKeyword = await trpc(app, "client.list", {
      cookie: memberCookie,
      method: "GET",
      input: { keyword: "星澜" },
    });
    expect(
      (clientKeyword.json as { result: { data: { items: { name: string }[] } } }).result.data.items.map((c) => c.name),
    ).toEqual(["星澜科技有限公司"]);

    const matters = await trpc(app, "matter.list", { cookie: memberCookie, method: "GET" });
    expect(matters.status).toBe(200);
    const matterItems = (
      matters.json as {
        result: { data: { items: { id: string; code: string; name: string; clientId: string; clientName: string }[] } };
      }
    ).result.data.items;
    expect(matterItems.length).toBe(4); // 华宸 / 星澜 / 恒岳 / 佳力奇咨询
    expect(matterItems.find((m) => m.code === `MTR-${YEAR}-00001`)).toMatchObject({
      clientName: "华宸贸易有限公司",
    });

    const clientId = matterItems.find((m) => m.code === `MTR-${YEAR}-00001`)!.clientId;
    const filtered = await trpc(app, "matter.list", {
      cookie: memberCookie,
      method: "GET",
      input: { clientId },
    });
    expect(
      (filtered.json as { result: { data: { items: { code: string }[] } } }).result.data.items.map((m) => m.code),
    ).toEqual([`MTR-${YEAR}-00001`]);
  });

  it("project.create 权限门：partner/sysadmin 可立项，pm/member 统一同形 403/404", async () => {
    // member / pm（project_manager 全局角色）被拦（arch/02 §4.1 v1.2 冻结：partner/sysadmin）
    const templates = await trpc(app, "project.listTemplates", { cookie: pmCookie, method: "GET" });
    const templateId = (
      (templates.json as { result: { data: { id: string; name: string }[] } }).result.data as {
        id: string;
        name: string;
      }[]
    ).find((t) => t.name === "诉讼案件标准模板")!.id;
    const matters = await trpc(app, "matter.list", { cookie: pmCookie, method: "GET" });
    const matterId = (
      matters.json as { result: { data: { items: { id: string }[] } } }
    ).result.data.items[0].id;
    const startDate = new Date().toISOString().slice(0, 10);

    const deniedMember = await trpc(app, "project.create", {
      cookie: memberCookie,
      input: { templateId, matterId, name: "无权立项", startDate },
    });
    const deniedPm = await trpc(app, "project.create", {
      cookie: pmCookie,
      input: { templateId, matterId, name: "负责人也不能立项", startDate },
    });
    for (const denied of [deniedMember, deniedPm]) {
      expect(denied.status).toBe(404);
      expect(trpcError(denied).businessCode).toBe("ACCESS_DENIED_OR_GONE");
    }
    // 同形核验：与随机 uuid 的未知错误同 businessCode
    const ghost = await trpc(app, "project.getById", {
      cookie: memberCookie,
      input: { id: "00000000-0000-0000-0000-000000000000" },
      method: "GET",
    });
    expect(ghost.status).toBe(404);
    expect(trpcError(ghost).businessCode).toBe(trpcError(deniedMember).businessCode);

    // partner 立项成功：模板事务生成（阶段/检查项/十一目录/基线 v1+items/创建人 manager 成员）
    const created = await trpc(app, "project.create", {
      cookie: partnerCookie,
      input: { templateId, matterId, name: "合伙人立项测试项目", startDate },
    });
    expect(created.status).toBe(200);
    const createdData = (created.json as { result: { data: { id: string; code: string } } }).result.data;
    expect(createdData.code).toMatch(new RegExp(`^PRJ-${YEAR}-`));

    const overview = await trpc(app, "project.overview", {
      cookie: partnerCookie,
      method: "GET",
      input: { projectId: createdData.id },
    });
    expect(overview.status).toBe(200);
    const overviewData = (overview.json as { result: { data: { members: number; myRole: string | null } } })
      .result.data;
    expect(overviewData.members).toBe(1);
    expect(overviewData.myRole).toBe("manager");

    const tree = await trpc(app, "archive.tree", {
      cookie: partnerCookie,
      method: "GET",
      input: { projectId: createdData.id },
    });
    expect((tree.json as { result: { data: unknown[] } }).result.data).toHaveLength(11);

    const checklist = await trpc(app, "quality.checklist", {
      cookie: partnerCookie,
      method: "GET",
      input: { projectId: createdData.id },
    });
    expect((checklist.json as { result: { data: unknown[] } }).result.data).toHaveLength(4);

    const current = await trpc(app, "plan.current", {
      cookie: partnerCookie,
      method: "GET",
      input: { projectId: createdData.id },
    });
    const currentData = (current.json as { result: { data: { versionNo: number; items: { name: string }[] } } })
      .result.data;
    expect(currentData.versionNo).toBe(1);
    expect(currentData.items.length).toBe(9); // 模板四阶段 + 模板任务五（arch/04 §2.10 v1.2，02c 起 tasks 键生效）
    expect(currentData.items.filter((i) => i.name.length > 0)).toHaveLength(9);
  });

  it("plan_items.name：全量非空且与来源行现名一致（迁移回填 + 写入侧快照）", async () => {
    const empties = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM plan_items WHERE name IS NULL OR name = ''`,
    );
    expect(empties[0].n).toBe(0);

    // 快照名与来源行现名一致（种子未改过名）
    const mismatches = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM plan_items pi
       WHERE (pi.item_type = 'stage' AND pi.name <> (SELECT s.name FROM stages s WHERE s.id = pi.ref_id))
          OR (pi.item_type = 'milestone' AND pi.name <> (SELECT m.name FROM milestones m WHERE m.id = pi.ref_id))
          OR (pi.item_type = 'task' AND pi.name <> (SELECT t.title FROM tasks t WHERE t.id = pi.ref_id))`,
    );
    expect(mismatches[0].n).toBe(0);
  });

  it("plan.current 三轨输出：items 带 name，live stages/milestones/tasks 含 actual_*", async () => {
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const projectA = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;

    const current = await trpc(app, "plan.current", {
      cookie: pmCookie,
      method: "GET",
      input: { projectId: projectA },
    });
    expect(current.status).toBe(200);
    const data = (current.json as {
      result: {
        data: {
          items: { name: string }[];
          stages: { code: string; name: string; actualStart: string | null; status: string }[];
          milestones: { code: string; actualDate: string | null; status: string }[];
          tasks: { code: string; title: string; actualStart: string | null; actualEnd: string | null }[];
        };
      };
    }).result.data;
    expect(data.items.every((i) => i.name.length > 0)).toBe(true);
    expect(data.stages.length).toBe(4);
    expect(data.milestones.length).toBe(3);
    // 8 = 迭代 1 种子任务；+1 = 迭代 2 会议行动项转换任务（TSK-00012，无阶段/计划项，arch/05 §4.2）
    expect(data.tasks.length).toBe(9);
    // 实际轨：STG-00001 active 有 actualStart；MLS-00001 reached 有 actualDate；TSK-00001 done 有 actualEnd
    expect(data.stages.find((s) => s.code === `STG-${YEAR}-00001`)?.actualStart).toBeTruthy();
    expect(data.milestones.find((m) => m.code === `MLS-${YEAR}-00001`)?.actualDate).toBeTruthy();
    expect(data.tasks.find((t) => t.code === `TSK-${YEAR}-00001`)?.actualEnd).toBeTruthy();
  });

  it("plan.versionGet / plan.simulate 的 items 带 name（v1.1）", async () => {
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const projectA = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    const versions = await trpc(app, "plan.versions", { cookie: pmCookie, method: "GET", input: { projectId: projectA } });
    const v1 = (versions.json as { result: { data: { id: string; versionNo: number }[] } }).result.data.find(
      (v) => v.versionNo === 1,
    )!;

    const versionGet = await trpc(app, "plan.versionGet", { cookie: pmCookie, method: "GET", input: { id: v1.id } });
    expect(versionGet.status).toBe(200);
    const vgItems = (versionGet.json as { result: { data: { items: { name: string }[] } } }).result.data.items;
    expect(vgItems.length).toBeGreaterThan(0);
    expect(vgItems.every((i) => i.name.length > 0)).toBe(true);

    const current = await trpc(app, "plan.current", { cookie: pmCookie, method: "GET", input: { projectId: projectA } });
    const stageItem = (current.json as { result: { data: { items: { id: string; itemType: string; refId: string }[] } } })
      .result.data.items.find((i) => i.itemType === "stage")!;
    const sim = await trpc(app, "plan.simulate", {
      cookie: pmCookie,
      method: "GET",
      input: {
        projectId: projectA,
        adjustments: [
          {
            ref_id: stageItem.refId,
            item_type: "stage",
            new_start: "2027-06-01",
            new_end: "2027-06-20",
          },
        ],
      },
    });
    expect(sim.status).toBe(200);
    const simItems = (sim.json as { result: { data: { items: { name: string }[] } } }).result.data.items;
    expect(simItems.every((i) => i.name.length > 0)).toBe(true);
  });
});
