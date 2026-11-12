import { and, desc, eq, ilike, lt, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  CONFIDENTIALITY_LEVEL,
  ERROR_CODE,
  PERMISSION,
  PROJECT_HEALTH_STATUS,
  PROJECT_LIFECYCLE_STATUS,
} from "@lexflow/shared";

import { clients, matters, projectMembers, projects, users } from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { can, projectScopeFilter } from "../../services/access";
import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/governance/project";
import * as projectFlows from "../../modules/flow/project-flows";

const manager = alias(users, "manager");

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAt, i: id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { u: string; i: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      u?: unknown;
      i?: unknown;
    };
    if (typeof parsed.u !== "string" || typeof parsed.i !== "string") throw new Error("bad cursor");
    return { u: parsed.u, i: parsed.i };
  } catch {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "无效的分页游标", {
      cursor: ["无效的分页游标"],
    });
  }
}

const listInput = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    filters: z
      .object({
        lifecycle: z.enum(PROJECT_LIFECYCLE_STATUS).optional(),
        health: z.enum(PROJECT_HEALTH_STATUS).optional(),
        keyword: z.string().trim().max(100).optional(),
      })
      .default({}),
  })
  .prefault({});

/** 项目域（arch/02 §4 冻结契约：project.list / project.getById） */
export const projectRouter = router({
  list: authedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const conditions: (SQL | undefined)[] = [projectScopeFilter(ctx.user)];

    if (input.filters.lifecycle) {
      conditions.push(eq(projects.lifecycleStatus, input.filters.lifecycle));
    }
    if (input.filters.health) {
      conditions.push(eq(projects.healthStatus, input.filters.health));
    }
    if (input.filters.keyword) {
      const keyword = input.filters.keyword.replace(/[\\%_]/g, (m) => `\\${m}`);
      conditions.push(
        or(ilike(projects.name, `%${keyword}%`), ilike(projects.code, `%${keyword}%`)),
      );
    }
    if (input.cursor) {
      const { u, i } = decodeCursor(input.cursor);
      conditions.push(
        or(
          lt(projects.updatedAt, u),
          and(eq(projects.updatedAt, u), lt(projects.id, i)),
        ),
      );
    }

    const rows = await ctx.db
      .select({
        id: projects.id,
        code: projects.code,
        name: projects.name,
        clientName: clients.name,
        matterName: matters.name,
        managerName: manager.name,
        lifecycleStatus: projects.lifecycleStatus,
        healthStatus: projects.healthStatus,
        confidentialityLevel: projects.confidentialityLevel,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .innerJoin(matters, eq(projects.matterId, matters.id))
      .innerJoin(clients, eq(matters.clientId, clients.id))
      .innerJoin(manager, eq(projects.managerId, manager.id))
      .where(and(...conditions))
      .orderBy(desc(projects.updatedAt), desc(projects.id))
      .limit(input.limit + 1);

    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        clientName: row.clientName,
        matterName: row.matterName,
        managerName: row.managerName,
        lifecycleStatus: row.lifecycleStatus,
        healthStatus: row.healthStatus,
        confidentialityLevel: row.confidentialityLevel,
        updatedAt: row.updatedAt,
      })),
      nextCursor: rows.length > input.limit && last ? encodeCursor(last.updatedAt, last.id) : null,
    };
  }),

  getById: authedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    // 无权限与不存在统一 NOT_FOUND 形态（arch/03 §5）
    const allowed = await can(ctx.db, ctx.user, PERMISSION.PROJECT_READ, {
      type: "project",
      projectId: input.id,
    });
    if (!allowed) {
      throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权访问");
    }

    const rows = await ctx.db
      .select({
        id: projects.id,
        code: projects.code,
        name: projects.name,
        clientName: clients.name,
        matterName: matters.name,
        managerName: manager.name,
        lifecycleStatus: projects.lifecycleStatus,
        healthStatus: projects.healthStatus,
        confidentialityLevel: projects.confidentialityLevel,
        updatedAt: projects.updatedAt,
        rowVersion: projects.rowVersion,
      })
      .from(projects)
      .innerJoin(matters, eq(projects.matterId, matters.id))
      .innerJoin(clients, eq(matters.clientId, clients.id))
      .innerJoin(manager, eq(projects.managerId, manager.id))
      .where(eq(projects.id, input.id))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权访问");
    }

    const members = await ctx.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, input.id));

    return {
      ...row,
      memberCount: members.length,
      myRole: ctx.user.projectRoles.get(input.id) ?? null,
    };
  }),

  // ===== 迭代 1 治理域（arch/04 §5 project.*） =====
  create: authedMutation
    .input(
      z.object({
        templateId: z.uuid(),
        matterId: z.uuid(),
        name: z.string().trim().min(1, "项目名称必填").max(200),
        type: z.string().max(50).optional(),
        confidentialityLevel: z.enum(CONFIDENTIALITY_LEVEL).optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "开始日须为 YYYY-MM-DD"),
        /** 指定负责人（缺省=创建人）；指定时成员表同事务对齐（09c 打回修复） */
        managerId: z.uuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.createProject(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),

  update: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        name: z.string().trim().min(1).max(200).optional(),
        type: z.string().max(50).optional(),
        healthStatus: z.enum(PROJECT_HEALTH_STATUS).optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.updateProject(ctx.db, ctx.user, input)),

  overview: authedProcedure
    .input(z.object({ projectId: z.uuid() }))
    .query(({ ctx, input }) => service.projectOverview(ctx.db, ctx.user, input.projectId)),

  listTemplates: authedProcedure.query(({ ctx }) => service.listTemplates(ctx.db)),

  addMember: authedMutation
    .input(
      z.object({
        projectId: z.uuid(),
        userId: z.uuid(),
        projectRole: z.string().min(1).max(50),
      }),
    )
    .mutation(({ ctx, input }) =>
      service.addMember(ctx.db, ctx.user, input.projectId, input.userId, input.projectRole),
    ),

  updateMember: authedMutation
    .input(
      z.object({ projectId: z.uuid(), userId: z.uuid(), projectRole: z.string().min(1).max(50) }),
    )
    .mutation(({ ctx, input }) =>
      service.updateMember(ctx.db, ctx.user, input.projectId, input.userId, input.projectRole),
    ),

  removeMember: authedMutation
    .input(z.object({ projectId: z.uuid(), userId: z.uuid() }))
    .mutation(({ ctx, input }) => service.removeMember(ctx.db, ctx.user, input.projectId, input.userId)),

  transferManager: authedMutation
    .input(
      z.object({
        projectId: z.uuid(),
        newManagerId: z.uuid(),
        reason: z.string().trim().min(1, "变更原因必填").max(500),
      }),
    )
    .mutation(({ ctx, input }) =>
      service.transferManager(ctx.db, ctx.user, input, ctx.ip, ctx.session.id),
    ),

  // ===== 项目级审批流管理（arch/11 G5：项目负责人可见可管，scope=project+project_id） =====
  flows: router({
    list: authedProcedure
      .input(z.object({ projectId: z.uuid() }))
      .query(({ ctx, input }) => projectFlows.listProjectFlows(ctx.db, ctx.user, input.projectId)),
    createDraft: authedMutation
      .input(
        z.object({
          projectId: z.uuid(),
          name: z.string().trim().min(1, "流程名称必填").max(200),
          bizBinding: z.string().min(1).max(50),
          definitionJson: z.record(z.string(), z.unknown()),
        }),
      )
      .mutation(({ ctx, input }) => projectFlows.createProjectFlowDraft(ctx.db, ctx.user, input)),
    publish: authedMutation
      .input(z.object({ projectId: z.uuid(), id: z.uuid(), idempotencyKey: z.uuid() }))
      .mutation(({ ctx, input }) => projectFlows.publishProjectFlow(ctx.db, ctx.user, input)),
    updateDraft: authedMutation
      .input(
        z.object({
          projectId: z.uuid(),
          id: z.uuid(),
          rowVersion: z.number().int().min(0),
          name: z.string().trim().min(1, "流程名称必填").max(200).optional(),
          definitionJson: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .mutation(({ ctx, input }) => projectFlows.updateProjectFlowDraft(ctx.db, ctx.user, input)),
    disable: authedMutation
      .input(z.object({ projectId: z.uuid(), id: z.uuid(), rowVersion: z.number().int().min(0) }))
      .mutation(({ ctx, input }) => projectFlows.disableProjectFlow(ctx.db, ctx.user, input)),
  }),

  /** 财务域项目参照清单（arch/12 §20.4：finance/partner 可见清单，其他角色同形 404） */
  financeOptions: authedProcedure.query(({ ctx }) => service.financeOptions(ctx.db, ctx.user)),

  close: authedMutation
    .input(z.object({ projectId: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => service.closeProject(ctx.db, ctx.user, input.projectId, input.rowVersion)),
  });