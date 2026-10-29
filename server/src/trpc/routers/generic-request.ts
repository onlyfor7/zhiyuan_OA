import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/requests/generic";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const genericRequestRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          mine: z.boolean().optional(),
          requestType: z.string().max(50).optional(),
          status: z.enum(["draft", "pending_approval", "approved", "rejected", "withdrawn"]).optional(),
          ...cursorPage,
        })
        .prefault({}),
    )
    .query(({ ctx, input }) => service.listRequests(ctx.db, ctx.user, input)),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => service.getRequestById(ctx.db, ctx.user, input.id)),

  create: authedMutation
    .input(
      z.object({
        requestType: z.string().min(1).max(50),
        title: z.string().trim().min(1, "标题必填").max(200),
        reason: z.string().trim().min(1, "事由必填").max(2000),
        startOn: date.optional(),
        endOn: date.optional(),
        amountCents: z.number().int().min(1).nullable().optional(),
        attachmentFileVersionId: z.uuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.createRequest(ctx.db, ctx.user, input)),

  update: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        requestType: z.string().max(50).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        reason: z.string().trim().min(1).max(2000).optional(),
        startOn: date.nullable().optional(),
        endOn: date.nullable().optional(),
        amountCents: z.number().int().min(1).nullable().optional(),
        attachmentFileVersionId: z.uuid().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.updateRequest(ctx.db, ctx.user, input)),

  submit: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0), idempotencyKey: z.uuid() }))
    .mutation(({ ctx, input }) => service.submitRequest(ctx.db, ctx.user, input)),

  withdraw: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => service.withdrawRequest(ctx.db, ctx.user, input)),
});
