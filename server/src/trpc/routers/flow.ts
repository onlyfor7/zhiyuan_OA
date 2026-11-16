import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as designer from "../../modules/flow/designer";
import { validateFlowStructure } from "../../services/approval/flow";

const definition = z.object({}).passthrough(); // 结构服务端强校验（FLOW_INVALID）

export const flowRouter = router({
  list: authedProcedure.query(({ ctx }) => designer.listFlows(ctx.db, ctx.user)),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => designer.getFlowById(ctx.db, ctx.user, input.id)),

  createDraft: authedMutation
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        scope: z.enum(["global", "project"]),
        bizBinding: z.string().min(1).max(50),
        projectId: z.uuid().optional(),
        definitionJson: definition,
      }),
    )
    .mutation(({ ctx, input }) => designer.createFlowDraft(ctx.db, ctx.user, input as never)),

  updateDraft: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        name: z.string().trim().min(1).max(100).optional(),
        definitionJson: definition.optional(),
      }),
    )
    .mutation(({ ctx, input }) => designer.updateFlowDraft(ctx.db, ctx.user, input as never)),

  publish: authedMutation
    .input(z.object({ id: z.uuid(), idempotencyKey: z.uuid() }))
    .mutation(({ ctx, input }) => designer.publishFlow(ctx.db, ctx.user, input)),

  disable: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => designer.disableFlow(ctx.db, ctx.user, input)),

  duplicateAsDraft: authedMutation
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => designer.duplicateFlowAsDraft(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  deleteDraft: authedMutation
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => designer.deleteFlowDraft(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  versions: authedProcedure
    .input(z.object({ name: z.string().min(1).max(100) }))
    .query(({ ctx, input }) => designer.flowVersions(ctx.db, ctx.user, input.name)),

  /** 设计器保存前预检（结构校验结果，不持久化） */
  validate: authedProcedure
    .input(z.object({ definitionJson: definition }))
    .query(({ input }) => {
      try {
        validateFlowStructure(input.definitionJson);
        return { valid: true as const, errors: [] as string[] };
      } catch (error) {
        return {
          valid: false as const,
          errors: [(error as { message?: string }).message ?? "非法定义"],
        };
      }
    }),
});
