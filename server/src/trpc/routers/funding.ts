import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/finance/funding";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期须为 YYYY-MM-DD");

export const fundingRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          projectId: z.uuid().optional(),
          mine: z.boolean().optional(),
          status: z.enum(["draft", "pending_approval", "approved", "rejected"]).optional(),
          ...cursorPage,
        })
        .prefault({}),
    )
    .query(({ ctx, input }) => service.listFundings(ctx.db, ctx.user, input)),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => service.getFundingById(ctx.db, ctx.user, input.id)),

  create: authedMutation
    .input(
      z.object({
        projectId: z.uuid(),
        purpose: z.string().trim().min(1, "用途必填").max(2000),
        amountCents: z.number().int().min(1, "金额须为正整数（分）"),
        expectedUseDate: date.optional(),
        recipientInfo: z.string().max(1000).optional(),
        sourceMeetingId: z.uuid().optional(),
        sourceTravelId: z.uuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.createFunding(ctx.db, ctx.user, input)),

  update: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        purpose: z.string().trim().min(1).max(2000).optional(),
        amountCents: z.number().int().min(1).optional(),
        expectedUseDate: date.nullable().optional(),
        recipientInfo: z.string().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.updateFunding(ctx.db, ctx.user, input)),

  submit: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0), idempotencyKey: z.uuid() }))
    .mutation(({ ctx, input }) => service.submitFunding(ctx.db, ctx.user, input)),

  withdraw: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => service.withdrawFunding(ctx.db, ctx.user, input)),

  close: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        note: z.string().trim().min(1, "关闭须填写说明").max(1000),
      }),
    )
    .mutation(({ ctx, input }) => service.closeFunding(ctx.db, ctx.user, input)),

  releaseUnused: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => service.releaseUnusedFunding(ctx.db, ctx.user, input)),
});
