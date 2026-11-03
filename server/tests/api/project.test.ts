import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";

const YEAR = new Date().getFullYear();
const PROJECT_A = `PRJ-${YEAR}-00001`;
const PROJECT_B = `PRJ-${YEAR}-00002`;
const PROJECT_C = `PRJ-${YEAR}-00003`;

interface ProjectSummary {
  id: string;
  code: string;
  name: string;
  clientName: string;
  matterName: string;
  managerName: string;
  lifecycleStatus: string;
  healthStatus: string;
  confidentialityLevel: string;
  updatedAt: string;
}

interface ListPayload {
  items: ProjectSummary[];
  nextCursor: string | null;
}

async function listProjects(
  app: Awaited<ReturnType<typeof getApp>>,
  cookie: string,
  input?: Record<string, unknown>,
): Promise<ListPayload> {
  const result = await trpc(app, "project.list", { input, cookie, method: "GET" });
  expect(result.status).toBe(200);
  return (result.json as { result: { data: ListPayload } }).result.data;
}

describe("项目（project.list / getById / user.listProjectMembers）", () => {
  let pmCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    await setupDatabase();
    const app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("两个账号 project.list 范围不同（验收场景 1）", async () => {
    const app = await getApp();
    const pmList = await listProjects(app, pmCookie);
    const memberList = await listProjects(app, memberCookie);
    expect(pmList.items.map((p) => p.code).sort()).toEqual([PROJECT_A, PROJECT_B]);
    expect(memberList.items.map((p) => p.code)).toEqual([PROJECT_A]);
    // Summary 契约字段（arch/02 §4）
    const a = pmList.items.find((p) => p.code === PROJECT_A);
    expect(a).toMatchObject({
      name: "比博思特技术服务项目",
      clientName: "比博思特（虚构）",
      matterName: "比博思特技术服务",
      managerName: "王宝茁",
      lifecycleStatus: "in_progress",
      healthStatus: "normal",
      confidentialityLevel: "internal",
    });
    expect(typeof a?.updatedAt).toBe("string");
    // 列表静默过滤：对二者都不可见的项目 C 不出现在任何列表
    expect(pmList.items.map((p) => p.code)).not.toContain(PROJECT_C);
  });

  it("过滤与关键字：pm 按 lifecycle / keyword 收窄", async () => {
    const app = await getApp();
    const preparing = await listProjects(app, pmCookie, { filters: { lifecycle: "preparing" } });
    expect(preparing.items).toHaveLength(0); // C 是 preparing 但 pm 不可见
    const warning = await listProjects(app, pmCookie, { filters: { health: "warning" } });
    expect(warning.items.map((p) => p.code)).toEqual([PROJECT_B]);
    const keyword = await listProjects(app, pmCookie, { filters: { keyword: "金通灵" } });
    expect(keyword.items.map((p) => p.code)).toEqual([PROJECT_B]);
  });

  it("游标分页：limit=1 两页并集完整且无重复", async () => {
    const app = await getApp();
    const page1 = await listProjects(app, pmCookie, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listProjects(app, pmCookie, { limit: 1, cursor: page1.nextCursor ?? undefined });
    expect(page2.items).toHaveLength(1);
    const codes = [...page1.items, ...page2.items].map((p) => p.code);
    expect(new Set(codes).size).toBe(2);
    expect(page2.nextCursor ?? codes.length).toBeTruthy();
    expect(page2.nextCursor).toBeNull();
  });

  it("member 直取未授权项目详情 → NOT_FOUND 同形（验收场景 2）", async () => {
    const app = await getApp();
    const pmList = await listProjects(app, pmCookie);
    const projectB = pmList.items.find((p) => p.code === PROJECT_B);
    expect(projectB).toBeDefined();

    const denied = await trpc(app, "project.getById", {
      input: { id: projectB?.id },
      cookie: memberCookie,
      method: "GET",
    });
    const nonexistent = await trpc(app, "project.getById", {
      input: { id: "00000000-0000-0000-0000-000000000000" },
      cookie: memberCookie,
      method: "GET",
    });
    for (const result of [denied, nonexistent]) {
      expect(result.status).toBe(404);
      const error = trpcError(result);
      expect(error.businessCode).toBe("ACCESS_DENIED_OR_GONE");
      expect(error.message).toBe("项目不存在或无权访问");
    }

    const ok = await trpc(app, "project.getById", {
      input: { id: pmList.items.find((p) => p.code === PROJECT_A)?.id },
      cookie: memberCookie,
      method: "GET",
    });
    expect(ok.status).toBe(200);
    const detail = (ok.json as { result: { data: ProjectSummary & { memberCount: number; myRole: string } } })
      .result.data;
    expect(detail.code).toBe(PROJECT_A);
    expect(detail.memberCount).toBe(4);
    expect(detail.myRole).toBe("member");
  });

  it("user.listProjectMembers：成员可见 / 非成员同形 404", async () => {
    const app = await getApp();
    const pmList = await listProjects(app, pmCookie);
    const projectAId = pmList.items.find((p) => p.code === PROJECT_A)?.id;
    const projectBId = pmList.items.find((p) => p.code === PROJECT_B)?.id;
    expect(projectAId && projectBId).toBeTruthy();

    const asMember = await trpc(app, "user.listProjectMembers", {
      input: { projectId: projectAId },
      cookie: memberCookie,
      method: "GET",
    });
    expect(asMember.status).toBe(200);
    const members = (asMember.json as { result: { data: { userId: string; name: string; projectRole: string }[] } })
      .result.data;
    expect(members).toHaveLength(4);
    expect(members.find((m) => m.name === "管晨")?.projectRole).toBe("member");

    const denied = await trpc(app, "user.listProjectMembers", {
      input: { projectId: projectBId },
      cookie: memberCookie,
      method: "GET",
    });
    expect(denied.status).toBe(404);
    expect(trpcError(denied).businessCode).toBe("ACCESS_DENIED_OR_GONE");
  });

  it("未登录访问 project.list → AUTH_REQUIRED", async () => {
    const app = await getApp();
    const result = await trpc(app, "project.list", { method: "GET" });
    expect(result.status).toBe(401);
    expect(trpcError(result).businessCode).toBe("AUTH_REQUIRED");
  });
});
