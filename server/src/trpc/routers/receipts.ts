import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/receipts/receipts";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const receiptsRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          projectId: z.uuid().optional(),
          clientId: z.uuid().optional(),
          from: date.optional(),
          to: date.optional(),
          ...cursorPage,
        })
        .prefault({}),
    )
    .query(({ ctx, input }) => service.listReceipts(ctx.db, ctx.user, input)),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => service.getReceipt(ctx.db, ctx.user, input.id)),

  projectOptions: authedProcedure.query(({ ctx }) => service.projectOptions(ctx.db, ctx.user)),

  create: authedMutation
    .input(
      z.object({
        projectId: z.uuid(),
        amountCents: z.number().int().min(1, "金额须为正整数（分）"),
        receivedOn: date,
        referenceNo: z.string().trim().min(1, "参考号必填").max(200),
        payerName: z.string().max(200).optional(),
        note: z.string().max(1000).optional(),
        attachmentFileVersionId: z.uuid().optional(),
        idempotencyKey: z.uuid(),
      }),
    )
    .mutation(({ ctx, input }) => service.createReceipt(ctx.db, ctx.user, input)),

  void: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        reason: z.string().trim().min(1, "作废必须填写理由").max(1000),
        rowVersion: z.number().int().min(0),
      }),
    )
    .mutation(({ ctx, input }) => service.voidReceipt(ctx.db, ctx.user, input)),

  summary: authedProcedure
    .input(z.object({ by: z.enum(["project", "client", "period"]), from: date.optional(), to: date.optional() }))
    .query(({ ctx, input }) => service.summaryReceipts(ctx.db, ctx.user, input as never)),

  exportCsv: authedProcedure
    .input(z.object({ from: date.optional(), to: date.optional() }).prefault({}))
    .query(({ ctx, input }) => service.exportCsv(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
});
