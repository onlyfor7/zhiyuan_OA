import { z } from "zod";

import { TASK_STATUS } from "@lexflow/shared";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/governance/task";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

export const taskRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          projectId: z.uuid().optional(),
          mine: z.boolean().optional(),
          status: z.enum(TASK_STATUS).optional(),
          stageId: z.uuid().optional(),
          ...cursorPage,
        })
        .prefault({})
        .refine((v) => v.projectId || v.mine, { message: "projectId 与 mine 至少提供一个" }),
    )
    .query(({ ctx, input }) => service.listTasks(ctx.db, ctx.user, input)),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => service.getTask(ctx.db, ctx.user, input.id)),

  create: authedMutation
    .input(
      z.object({
        projectId: z.uuid(),
        title: z.string().trim().min(1, "标题必填").max(200),
        description: z.string().max(2000).optional(),
        stageId: z.uuid().optional(),
        milestoneId: z.uuid().optional(),
        assigneeId: z.uuid().optional(),
        plannedStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        plannedEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .mutation(({ ctx, input }) => service.createTask(ctx.db, ctx.user, input)),

  update: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        stageId: z.uuid().nullable().optional(),
        milestoneId: z.uuid().nullable().optional(),
        assigneeId: z.uuid().nullable().optional(),
        // 注意：无任何 planned_* 入口（PLN-I1）
      }),
    )
    .mutation(({ ctx, input }) => service.updateTask(ctx.db, ctx.user, input)),

  transition: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        action: z.enum(["start", "complete", "cancel", "reopen"]),
        rowVersion: z.number().int().min(0),
      }),
    )
    .mutation(({ ctx, input }) => service.transitionTask(ctx.db, ctx.user, input)),

  assign: authedMutation
    .input(z.object({ id: z.uuid(), assigneeId: z.uuid() }))
    .mutation(({ ctx, input }) => service.assignTask(ctx.db, ctx.user, input)),
});
