import { z } from "zod";

import { DECISION_STATUS } from "@lexflow/shared";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/governance/decision";

const option = z.object({
  key: z.string().min(1).max(50),
  summary: z.string().min(1).max(500),
  impact: z.string().max(1000),
  risk: z.string().max(1000),
});

const checkpoint = z.object({
  point: z.string().trim().min(1, "检查点必填").max(300),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  owner_id: z.uuid(),
});

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

export const decisionRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          projectId: z.uuid().optional(),
          status: z.enum(DECISION_STATUS).optional(),
          ...cursorPage,
        })
        .prefault({}),
    )
    .query(({ ctx, input }) => service.listDecisions(ctx.db, ctx.user, input)),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => service.getDecision(ctx.db, ctx.user, input.id)),

  create: authedMutation
    .input(
      z.object({
        projectId: z.uuid(),
        title: z.string().trim().min(1, "标题必填").max(200),
        context: z.string().trim().min(1, "背景必填").max(2000),
        options: z.array(option).min(2, "至少两个备选方案"),
      }),
    )
    .mutation(({ ctx, input }) => service.createDecision(ctx.db, ctx.user, input)),

  update: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        title: z.string().trim().min(1).max(200).optional(),
        context: z.string().trim().min(1).max(2000).optional(),
        options: z.array(option).min(2).optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.updateDecision(ctx.db, ctx.user, input)),

  submitOpinions: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        pmOpinion: z.string().max(2000).optional(),
        qualityOpinion: z.string().max(2000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.submitOpinions(ctx.db, ctx.user, input)),

  decide: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        finalOption: z.string().trim().min(1, "最终方案必填").max(50),
        finalReason: z.string().trim().min(1, "决定理由必填").max(2000),
        conditions: z.string().trim().min(1, "附加条件必填").max(2000),
        checkpoints: z.array(checkpoint).min(1, "至少一个检查点"),
        rowVersion: z.number().int().min(0),
      }),
    )
    .mutation(({ ctx, input }) => service.decide(ctx.db, ctx.user, input)),

  verify: authedMutation
    .input(z.object({ id: z.uuid(), note: z.string().trim().min(1, "验证说明必填").max(2000) }))
    .mutation(({ ctx, input }) => service.verifyDecision(ctx.db, ctx.user, input)),
});
