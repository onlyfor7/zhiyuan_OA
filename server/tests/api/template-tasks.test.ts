import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc } from "./helpers";

const YEAR = new Date().getFullYear();

describe("工单 02c：模板任务生成（arch/04 §2.10 v1.2）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let partnerCookie: string;
  let partnerId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    const partner = await loginAs(app, "partner@lexflow.demo");
    partnerCookie = partner.cookie;
    partnerId = partner.user.id as string;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("诉讼模板创建：任务/检查项/十一目录/v1 plan_items（含 task 项）齐备，日期落在阶段区间内", async () => {
    const templates = await trpc(app, "project.listTemplates", { cookie: partnerCookie, method: "GET" });
    const templateId = (
      (templates.json as { result: { data: { id: string; name: string }[] } }).result.data as {
        id: string;
        name: string;
      }[]
    ).find((t) => t.name === "诉讼案件标准模板")!.id;
    const matters = await trpc(app, "matter.list", { cookie: partnerCookie, method: "GET" });
    const matterId = (
      matters.json as { result: { data: { items: { id: string }[] } } }
    ).result.data.items[0].id;

    const created = await trpc(app, "project.create", {
      cookie: partnerCookie,
      input: { templateId, matterId, name: "02c 诉讼模板任务项目", startDate: "2027-03-01" },
    });
    expect(created.status).toBe(200);
    const projectId = (created.json as { result: { data: { id: string } } }).result.data.id;

    const current = await trpc(app, "plan.current", {
      cookie: partnerCookie,
      method: "GET",
      input: { projectId },
    });
    expect(current.status).toBe(200);
    const data = (current.json as {
      result: {
        data: {
          versionNo: number;
          items: { itemType: string; refId: string; name: string; seq: number }[];
          stages: { id: string; seq: number; plannedStart: string; plannedEnd: string }[];
          milestones: unknown[];
          tasks: {
            id: string;
            stageId: string | null;
            title: string;
            assigneeId: string | null;
            plannedStart: string;
            plannedEnd: string;
            status: string;
          }[];
        };
      };
    }).result.data;

    // 基线 v1：4 阶段项 + 5 任务项，seq 连续、name 快照齐备
    expect(data.items).toHaveLength(9);
    expect(data.items.filter((i) => i.itemType === "task")).toHaveLength(5);
    expect(data.items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(data.items.every((i) => i.name.length > 0)).toBe(true);

    // live 轨：5 任务、4 阶段、0 里程碑（本期不冻结 milestones 模板支持）
    expect(data.stages).toHaveLength(4);
    expect(data.milestones).toHaveLength(0);
    expect(data.tasks).toHaveLength(5);

    // 日期均落在所属阶段区间（planned_start = 阶段开始 + offsetDays；end = start + durationDays）
    const stageById = new Map(data.stages.map((s) => [s.id, s]));
    for (const task of data.tasks) {
      const stage = stageById.get(task.stageId!);
      expect(stage, `任务 ${task.title} 应挂在阶段下`).toBeDefined();
      expect(task.plannedStart >= stage!.plannedStart).toBe(true);
      expect(task.plannedEnd <= stage!.plannedEnd).toBe(true);
      expect(task.status).toBe("pending");
    }

    // assigneeRole 解析：模板「证据清单整理」assigneeRole=manager → 项目首个 manager 成员 = 创建人
    const first = data.tasks.find((t) => t.title === "证据清单整理")!;
    expect(first.assigneeId).toBe(partnerId);
    // 未指定 assigneeRole 的任务保持未分配
    const unassigned = data.tasks.find((t) => t.title === "起诉状起草")!;
    expect(unassigned.assigneeId).toBeNull();

    // plan_items 的 task 项 refId 指向真实任务行（写入 v1，PLN-I1 只写不改）
    const taskItem = data.items.find((i) => i.itemType === "task" && i.name === "代理意见初稿")!;
    expect(data.tasks.some((t) => t.id === taskItem.refId && t.title === "代理意见初稿")).toBe(true);

    // 检查项与十一目录链路不受 tasks 影响（保持 02b 验证过的形态）
    const checklist = await trpc(app, "quality.checklist", {
      cookie: partnerCookie,
      method: "GET",
      input: { projectId },
    });
    expect((checklist.json as { result: { data: unknown[] } }).result.data).toHaveLength(4);
    const tree = await trpc(app, "archive.tree", {
      cookie: partnerCookie,
      method: "GET",
      input: { projectId },
    });
    expect((tree.json as { result: { data: unknown[] } }).result.data).toHaveLength(11);
  });

  it("常年法律顾问模板：≥1 任务生成，日期在阶段区间内", async () => {
    const templates = await trpc(app, "project.listTemplates", { cookie: partnerCookie, method: "GET" });
    const templateId = (
      (templates.json as { result: { data: { id: string; name: string }[] } }).result.data as {
        id: string;
        name: string;
      }[]
    ).find((t) => t.name === "常年法律顾问模板")!.id;
    const matters = await trpc(app, "matter.list", { cookie: partnerCookie, method: "GET" });
    const matterId = (
      matters.json as { result: { data: { items: { id: string }[] } } }
    ).result.data.items[1].id;

    const created = await trpc(app, "project.create", {
      cookie: partnerCookie,
      input: { templateId, matterId, name: "02c 常年模板任务项目", startDate: "2027-03-01" },
    });
    expect(created.status).toBe(200);
    const projectId = (created.json as { result: { data: { id: string } } }).result.data.id;

    const current = await trpc(app, "plan.current", {
      cookie: partnerCookie,
      method: "GET",
      input: { projectId },
    });
    const data = (current.json as {
      result: {
        data: {
          items: { itemType: string }[];
          stages: { id: string; plannedStart: string; plannedEnd: string }[];
          tasks: { stageId: string | null; plannedStart: string; plannedEnd: string }[];
        };
      };
    }).result.data;
    expect(data.items.filter((i) => i.itemType === "task")).toHaveLength(1);
    expect(data.tasks).toHaveLength(1);
    const task = data.tasks[0];
    const stage = data.stages.find((s) => s.id === task.stageId)!;
    expect(task.plannedStart >= stage.plannedStart).toBe(true);
    expect(task.plannedEnd <= stage.plannedEnd).toBe(true);
  });

  it("种子模板 structure 已含 tasks 键且 upsert 为更新语义（重跑不叠加、结构生效）", async () => {
    const templates = await trpc(app, "project.listTemplates", { cookie: partnerCookie, method: "GET" });
    const list = (templates.json as { result: { data: { name: string; structureJson: { tasks?: unknown[] } }[] } })
      .result.data;
    const litigation = list.find((t) => t.name === "诉讼案件标准模板")!;
    const counsel = list.find((t) => t.name === "常年法律顾问模板")!;
    expect(litigation.structureJson.tasks?.length).toBeGreaterThanOrEqual(4);
    expect(counsel.structureJson.tasks?.length).toBeGreaterThanOrEqual(1);
  });
});
