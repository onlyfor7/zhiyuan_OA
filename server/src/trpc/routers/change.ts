import { z } from "zod";

import { CHANGE_LEVEL, CHANGE_REQUEST_STATUS } from "@lexflow/shared";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/governance/change";

const targetItem = z.object({
  ref_id: z.uuid(),
  item_type: z.enum(["stage", "milestone", "task"]),
  new_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  new_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const recoveryMeasure = z.object({
  measure: z.string().trim().min(1, "措施必填").max(500),
  owner_id: z.uuid(),
  checkpoint_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

export const changeRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          projectId: z.uuid().optional(),
          status: z.enum(CHANGE_REQUEST_STATUS).optional(),
          ...cursorPage,
        })
        .prefault({}),
    )
    .query(({ ctx, input }) => service.listChanges(ctx.db, ctx.user, input)),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => service.getChange(ctx.db, ctx.user, input.id)),

  create: authedMutation
    .input(
      z.object({
        projectId: z.uuid(),
        title: z.string().trim().min(1, "标题必填").max(200),
        level: z.enum(CHANGE_LEVEL),
        targetItems: z.array(targetItem).min(1, "至少一个目标计划项"),
        reason: z.string().trim().min(1, "原因必填"),
        impact: z.string().trim().min(1, "影响必填"),
        recoveryMeasures: z.array(recoveryMeasure).min(1, "至少一条恢复措施"),
      }),
    )
    .mutation(({ ctx, input }) => service.createChange(ctx.db, ctx.user, input)),

  update: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        title: z.string().trim().min(1).max(200).optional(),
        level: z.enum(CHANGE_LEVEL).optional(),
        targetItems: z.array(targetItem).min(1).optional(),
        reason: z.string().trim().min(1).optional(),
        impact: z.string().trim().min(1).optional(),
        recoveryMeasures: z.array(recoveryMeasure).min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.updateChange(ctx.db, ctx.user, input)),

  submit: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        idempotencyKey: z.uuid(),
      }),
    )
    .mutation(({ ctx, input }) => service.submitChange(ctx.db, ctx.user, input)),

  withdraw: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => service.withdrawChange(ctx.db, ctx.user, input)),
});
